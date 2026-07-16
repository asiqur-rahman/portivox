import http from "http";
import https from "https";
import net from "net";
import { URL } from "url";
import WebSocket from "ws";
import { decodeWireMessage, encodeWireMessage, type WireMessage } from "./protocol";

export type TunnelClientConfig = {
  gatewayUrl: string;
  localBase: string;
  tunnelType?: "http" | "tcp";
  localTcpHost?: string;
  localTcpPort?: number;
  requestedSubdomain?: string;
  localTimeoutMs: number;
  maxResponseBodyBytes: number;
  responseChunkBytes?: number;
  wsHeaders?: Record<string, string>;
  heartbeatIntervalMs?: number;
  /** Whether to request IP link protection for TCP tunnels (default: true). */
  ipProtection?: boolean;
  /** HTTP tunnels: also expose a dedicated raw-TCP passthrough port alongside
   *  the subdomain (opt-in via the CLI `--with-port` flag). */
  withDedicatedPort?: boolean;
  /** Called when tunnel registration fails before the tunnel becomes active. */
  onFatalError?: (error: { message: string; code?: string }) => void;
  /** Called once when the gateway confirms registration — used to persist the
   *  active tunnel to the local session file. */
  onRegistered?: (info: {
    subdomain?: string;
    tunnelType?: "http" | "tcp";
    publicPort?: number;
    publicHost?: string;
    publicTcpPort?: number;
    publicTcpHost?: string;
    accessLink?: string;
    redirectToken?: string;
    redirectUrl?: string;
    dedicatedTcpHost?: string;
    dedicatedTcpPort?: number;
  }) => void;
  /** Called when the gateway revokes this tunnel (owner removed it from the web
   *  panel). The client stops and will NOT reconnect. */
  onRevoked?: (info: { subdomain?: string; reason?: string }) => void;
};

export class TunnelClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private registered = false;
  /** Stable redirect token from the gateway — replayed on reconnect so the
   *  /r/:token status URL stays the same across disconnects. */
  private redirectToken: string | null = null;
  private readonly tcpConnections = new Map<string, net.Socket>();
  private readonly logger = createConsoleLogger("client");
  // Keep-alive agents reuse the loopback TCP connection across requests,
  // eliminating the ~1–5 ms handshake overhead on every proxied request.
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
  // rejectUnauthorized: false — local backends use self-signed certs in dev.
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000, rejectUnauthorized: false });

  constructor(private readonly config: TunnelClientConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const connectionId of this.tcpConnections.keys()) {
      this.closeTcpConnection(connectionId, "client_stop");
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "client_stop");
    }
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private connect(): void {
    this.registered = false;
    // Detach the previous socket's listeners before opening a new one so a
    // late/stale event from the old connection can't fire against the new
    // session or leak the old socket via its closures.
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket = null;
    }
    this.logger.info(`Connecting to gateway ${this.config.gatewayUrl}`, {
      requestedSubdomain: this.config.requestedSubdomain ?? null,
      tunnelType: this.config.tunnelType ?? "http",
      // localBase intentionally omitted — it may contain internal hostnames
    });
    this.socket = new WebSocket(this.config.gatewayUrl, {
      headers: this.config.wsHeaders,
      // Always enforce TLS certificate verification.
      rejectUnauthorized: true,
      // Enable per-message deflate to match the gateway's setting.
      perMessageDeflate: {
        threshold: 512,
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
      },
    });

    this.socket.on("open", () => {
      this.reconnectAttempt = 0;
      const isTcp = this.config.tunnelType === "tcp";
      this.send({
        type: "register_tunnel",
        requestedSubdomain: this.config.requestedSubdomain,
        tunnelType: this.config.tunnelType ?? "http",
        // Tell the gateway which local port we're forwarding so it can apply
        // any admin-configured fixed public port mapping for this port.
        localPort: this.config.localTcpPort,
        // IP-link protection intent. Sent for HTTP too: the gateway applies it to
        // port-only tunnels (users without subdomain access) and ignores it for
        // subdomain-routed tunnels. Default on; --no-ip-protection turns it off.
        ipProtection: this.config.ipProtection !== false,
        // HTTP tunnels only: ask the gateway to also expose a dedicated raw-TCP
        // passthrough port alongside the subdomain.
        withDedicatedPort: !isTcp ? (this.config.withDedicatedPort === true) : false,
        // Replay the stable redirect token on reconnect to keep the /r/ URL.
        redirectToken: this.redirectToken ?? undefined,
      });
      this.startHeartbeat();
    });

    this.socket.on("message", async (raw) => {
      let msg: WireMessage;
      try {
        msg = decodeWireMessage(String(raw));
      } catch (err) {
        this.logger.warn(`Received unparseable gateway frame: ${String(err)}`);
        return;
      }

      if (msg.type === "registered") {
        this.registered = true;
        if (msg.redirectToken) {
          this.redirectToken = msg.redirectToken;
        }
        if (msg.subdomain) {
          this.logger.info(`Tunnel active: ${msg.subdomain}`);
          if (msg.tunnelType === "http" && msg.publicHost && msg.publicPort) {
            this.logger.info(`Public tunnel URL: http://${msg.publicHost}:${msg.publicPort}`);
          } else if (msg.redirectUrl) {
            try {
              const u = new URL(msg.redirectUrl);
              this.logger.info(`Public tunnel URL: ${u.protocol}//${msg.subdomain}.${u.hostname}`);
            } catch {
              // non-fatal
            }
          }
        }
        if (msg.tunnelType === "tcp" && msg.publicTcpPort) {
          if (!msg.subdomain) {
            this.logger.info(`Tunnel active (TCP)`);
          }
          this.logger.info(`TCP endpoint: ${msg.publicTcpHost ?? "localhost"}:${msg.publicTcpPort}`);
        }
        // HTTP tunnels: report the dedicated raw-TCP passthrough port. When there
        // is no subdomain, this is a "port-only" tunnel (the user's account does
        // not have the subdomain subscription) and the port is the primary URL.
        if (msg.dedicatedTcpPort) {
          if (!msg.subdomain) {
            this.logger.info("Tunnel active (port only — subdomain access requires a subscription)");
          }
          const label = msg.subdomain ? "Dedicated TCP port" : "Public port";
          this.logger.info(`${label}: ${msg.dedicatedTcpHost ?? msg.publicHost ?? "localhost"}:${msg.dedicatedTcpPort}`);
        } else if (this.config.withDedicatedPort && msg.tunnelType !== "tcp") {
          this.logger.warn("Dedicated port was requested but is unavailable on this gateway (TCP disabled or port pool exhausted).");
        }
        if (msg.accessLink) {
          this.logger.info(`Secret access link (open in a browser to unlock the port for your network): ${msg.accessLink}`);
          this.logger.info("The public port stays closed until this link is opened. Share it only with people who should reach the service.");
        }
        if (msg.redirectUrl) {
          this.logger.info(`Status page (stable): ${msg.redirectUrl}`);
        }
        this.config.onRegistered?.({
          subdomain: msg.subdomain,
          tunnelType: msg.tunnelType,
          publicPort: msg.publicPort,
          publicHost: msg.publicHost,
          publicTcpPort: msg.publicTcpPort,
          publicTcpHost: msg.publicTcpHost,
          accessLink: msg.accessLink,
          redirectToken: msg.redirectToken,
          redirectUrl: msg.redirectUrl,
          dedicatedTcpHost: msg.dedicatedTcpHost,
          dedicatedTcpPort: msg.dedicatedTcpPort,
        });
        return;
      }

      if (msg.type === "error") {
        if (!this.registered) {
          this.config.onFatalError?.({ message: msg.message, code: msg.code });
          this.stop();
          return;
        }
        this.logger.error(`Gateway error: ${msg.message}`);
        return;
      }

      if (msg.type === "tunnel_revoked") {
        // Owner removed this tunnel from the web panel. Close and do NOT
        // reconnect (stop() sets the flag scheduleReconnect() checks).
        this.logger.warn("Tunnel removed from the control panel — closing this tunnel.", {
          subdomain: msg.subdomain ?? null,
          reason: msg.reason ?? null,
        });
        this.config.onRevoked?.({ subdomain: msg.subdomain, reason: msg.reason });
        this.stop();
        return;
      }

      if (msg.type === "http_request") {
        this.logger.info("Forwarding tunneled request", {
          streamId: msg.streamId,
          tunnelRequestId: typeof msg.headers["x-tunnel-request-id"] === "string" ? msg.headers["x-tunnel-request-id"] : null,
          method: msg.method,
          path: msg.path,
        });
        const responses = await this.proxyLocalRequest(msg);
        for (const response of responses) {
          this.send(response);
        }
        return;
      }

      if (msg.type === "tcp_open") {
        this.openTcpConnection(msg.connectionId);
        return;
      }

      if (msg.type === "tcp_data") {
        const conn = this.tcpConnections.get(msg.connectionId);
        if (conn) {
          conn.write(Buffer.from(msg.dataBase64, "base64"));
        }
        return;
      }

      if (msg.type === "tcp_close") {
        this.closeTcpConnection(msg.connectionId, msg.reason);
      }
    });

    this.socket.on("close", (code: number) => {
      this.stopHeartbeat();
      for (const connectionId of this.tcpConnections.keys()) {
        this.closeTcpConnection(connectionId, "gateway_disconnected");
      }
      // 4401 = the gateway rejected our credentials (API key revoked or invalid).
      // Reconnecting would just fail again, so stop instead of looping.
      if (code === 4401) {
        this.logger.error("API key was revoked or is invalid — the gateway rejected this device. Stopping (will not reconnect).");
        this.config.onFatalError?.({ message: "API key was revoked or is invalid", code: "UNAUTHORIZED" });
        this.stop();
        return;
      }
      this.scheduleReconnect();
    });

    this.socket.on("error", (err) => {
      this.logger.warn(`WebSocket error: ${err.message}`);
      this.stopHeartbeat();
    });
  }

  private send(msg: WireMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(encodeWireMessage(msg));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", at: Date.now() });
    }, this.config.heartbeatIntervalMs ?? 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    this.logger.warn(`Disconnected from gateway. Reconnecting in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private async proxyLocalRequest(msg: Extract<WireMessage, { type: "http_request" }>): Promise<Extract<WireMessage, { type: "http_response" }>[] > {
    // SSRF guard: absolute URLs in msg.path bypass localBase — reject them.
    const target = new URL(msg.path, this.config.localBase);
    const localOrigin = new URL(this.config.localBase).origin;
    if (target.origin !== localOrigin) {
      this.logger.warn("Rejected gateway request — path resolves outside localBase", {
        path: msg.path,
        resolvedOrigin: target.origin,
        localOrigin,
      });
      return [{
        type: "http_response",
        streamId: msg.streamId,
        statusCode: 400,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ error: "Bad request" })).toString("base64"),
        meta: msg.meta,
      }];
    }
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const outboundHeaders = filterHopByHopHeaders(msg.headers);
    outboundHeaders.host = target.host;

    return new Promise((resolve) => {
      const req = transport.request(
        target,
        {
          method: msg.method,
          headers: outboundHeaders,
          timeout: this.config.localTimeoutMs,
          agent: isHttps ? this.httpsAgent : this.httpAgent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on("data", (chunk) => {
            const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += normalized.length;
            if (totalBytes > this.config.maxResponseBodyBytes) {
              req.destroy(new Error(`Local response exceeds limit of ${this.config.maxResponseBodyBytes} bytes`));
              return;
            }
            chunks.push(normalized);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve(buildResponseFrames({
              streamId: msg.streamId,
              statusCode: res.statusCode ?? 502,
              headers: filterHopByHopHeaders(res.headers),
              body,
              requestMeta: msg.meta,
              chunkBytes: this.config.responseChunkBytes ?? 0,
            }));
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Local request timeout after ${this.config.localTimeoutMs}ms`));
      });

      req.on("error", (error) => {
        // Log locally but return a generic error — don't leak internal topology.
        this.logger.warn("Local upstream request failed", { streamId: msg.streamId, error: error.message });
        resolve([{
          type: "http_response",
          streamId: msg.streamId,
          statusCode: 502,
          headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from(JSON.stringify({ error: "Upstream connection failed" })).toString("base64"),
          meta: msg.meta,
        }]);
      });

      const body = Buffer.from(msg.bodyBase64, "base64");
      if (body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }

  private openTcpConnection(connectionId: string): void {
    // Cap concurrent TCP connections to prevent gateway-driven resource exhaustion.
    const MAX_TCP_CONNECTIONS = 256;
    if (this.tcpConnections.size >= MAX_TCP_CONNECTIONS) {
      this.logger.warn("TCP connection limit reached — rejecting new connection", { connectionId, limit: MAX_TCP_CONNECTIONS });
      this.send({ type: "tcp_close", connectionId, reason: "connection_limit_exceeded" });
      return;
    }

    const host = this.config.localTcpHost ?? "127.0.0.1";
    const port = this.config.localTcpPort ?? Number(new URL(this.config.localBase).port || "0");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.send({ type: "tcp_close", connectionId, reason: "invalid_local_tcp_port" });
      return;
    }

    const conn = net.createConnection({ host, port }, () => {
      // Disable Nagle's algorithm — flush every write immediately so
      // interactive protocols (SSH, RDP) don't stutter.
      conn.setNoDelay(true);
      this.logger.info("TCP tunnel connected", { connectionId, host, port });
    });
    this.tcpConnections.set(connectionId, conn);

    conn.on("data", (chunk) => {
      this.send({
        type: "tcp_data",
        connectionId,
        dataBase64: Buffer.from(chunk).toString("base64"),
      });
    });

    conn.on("error", (error) => {
      this.send({ type: "tcp_close", connectionId, reason: error.message });
      this.closeTcpConnection(connectionId, error.message);
    });

    conn.on("close", () => {
      if (this.tcpConnections.has(connectionId)) {
        this.send({ type: "tcp_close", connectionId, reason: "closed" });
        this.tcpConnections.delete(connectionId);
      }
    });
  }

  private closeTcpConnection(connectionId: string, reason?: string): void {
    const conn = this.tcpConnections.get(connectionId);
    if (!conn) {
      return;
    }
    this.tcpConnections.delete(connectionId);
    conn.destroy();
    if (reason) {
      this.logger.warn("TCP tunnel closed", { connectionId, reason });
    }
  }
}

function buildResponseFrames(args: {
  streamId: string;
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: Buffer;
  requestMeta?: Extract<WireMessage, { type: "http_request" }>["meta"];
  chunkBytes: number;
}): Extract<WireMessage, { type: "http_response" }>[] {
  const { streamId, statusCode, headers, body, requestMeta, chunkBytes } = args;
  if (chunkBytes <= 0 || body.length <= chunkBytes) {
    const meta = requestMeta ? { ...requestMeta } : undefined;
    if (meta && "chunk" in meta) {
      delete meta.chunk;
    }
    return [{
      type: "http_response",
      streamId,
      statusCode,
      headers,
      bodyBase64: body.toString("base64"),
      meta,
    }];
  }

  const chunks: Extract<WireMessage, { type: "http_response" }>[] = [];
  const total = Math.ceil(body.length / chunkBytes);
  for (let index = 0; index < total; index += 1) {
    const offset = index * chunkBytes;
    const segment = body.subarray(offset, offset + chunkBytes);
    chunks.push({
      type: "http_response",
      streamId,
      statusCode,
      headers,
      bodyBase64: segment.toString("base64"),
      meta: {
        ...(requestMeta ?? {}),
        chunk: {
          index,
          total,
          final: index === total - 1,
        },
      },
    });
  }
  return chunks;
}

function filterHopByHopHeaders<T extends Record<string, string | string[] | number | undefined>>(headers: T): T {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const next: Record<string, string | string[] | number | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) {
      next[key] = value;
    }
  }
  return next as T;
}

function createConsoleLogger(scope: string) {
  return {
    info: (msg: string, meta?: unknown) => console.log(`[${scope}] INFO ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
    warn: (msg: string, meta?: unknown) => console.warn(`[${scope}] WARN ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
    error: (msg: string, meta?: unknown) => console.error(`[${scope}] ERROR ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
  };
}
