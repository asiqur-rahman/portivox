import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import WebSocket from "ws";
import { createLogger } from "portivox-logger";
import { decodeWireMessage, encodeWireMessage, type WireMessage } from "./protocol";

export type RegisteredInfo = {
  subdomain?: string;
  tunnelType?: "http" | "tcp";
  publicTcpPort?: number;
  publicTcpHost?: string;
  accessLink?: string;
  redirectToken?: string;
  redirectUrl?: string;
};

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
  /** Whether to request IP link protection (default: true for TCP tunnels). */
  ipProtection?: boolean;
  /** Heartbeat interval in ms (default: 5000). */
  heartbeatIntervalMs?: number;
  /** Exit the process with code 1 if the tunnel has not connected within this many ms. */
  exitAfterMs?: number;
  /** Called once when the gateway confirms tunnel registration. Used by the CLI
   *  to write session info to ~/.portivox/sessions.json. */
  onRegistered?: (info: RegisteredInfo) => void;
  /** When true, the client exits instead of reconnecting after a disconnect.
   *  Used by the CLI when reconnectMode is "once". */
  noReconnect?: boolean;
};

export class TunnelClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  /** Timestamp of the last frame received from the gateway (used for liveness check). */
  private lastActivityAt = 0;
  private readonly tcpConnections = new Map<string, net.Socket>();
  private readonly logger = createLogger("client");
  /** Stable redirect token from the gateway — sent back on reconnect to reuse the same /r/:token URL. */
  private redirectToken: string | null = null;
  /** Exit-on-failure timer — cleared when the tunnel successfully registers. */
  private exitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: TunnelClientConfig) {}

  start(): void {
    this.stopped = false;
    if (this.config.exitAfterMs && this.config.exitAfterMs > 0) {
      this.exitTimer = setTimeout(() => {
        this.logger.error(`Tunnel failed to connect within ${this.config.exitAfterMs}ms — exiting`);
        process.exit(1);
      }, this.config.exitAfterMs);
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
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
  }

  private connect(): void {
    this.logger.info(`Connecting to gateway ${this.config.gatewayUrl}`, {
      requestedSubdomain: this.config.requestedSubdomain ?? null,
      tunnelType: this.config.tunnelType ?? "http",
      // localBase intentionally omitted — it may contain internal hostnames
    });
    this.socket = new WebSocket(this.config.gatewayUrl, {
      headers: this.config.wsHeaders,
      // Always enforce TLS certificate verification. Do NOT allow
      // NODE_TLS_REJECT_UNAUTHORIZED=0 to silently disable cert checks.
      rejectUnauthorized: true,
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
        // Request IP link protection (TCP only; default true unless opted out).
        ipProtection: isTcp ? (this.config.ipProtection !== false) : false,
        // Send back the stable redirect token on reconnect so the gateway can
        // reuse the same /r/:token URL.
        redirectToken: this.redirectToken ?? undefined,
      });
      this.startHeartbeat();
    });

    this.socket.on("message", async (raw) => {
      // Update liveness timestamp on every frame received from the gateway
      this.lastActivityAt = Date.now();

      let msg: WireMessage;
      try {
        msg = decodeWireMessage(String(raw));
      } catch (err) {
        this.logger.warn("Received unparseable gateway frame", { err: String(err) });
        return;
      }

      if (msg.type === "registered") {
        // Clear the exit-on-failure timer — we're connected.
        if (this.exitTimer) {
          clearTimeout(this.exitTimer);
          this.exitTimer = null;
        }
        // Persist the stable redirect token so it can be sent back on reconnect.
        if (msg.redirectToken) {
          this.redirectToken = msg.redirectToken;
        }
        if (msg.subdomain) {
          const requested = this.config.requestedSubdomain;
          if (requested && requested !== msg.subdomain) {
            this.logger.warn(
              `Requested subdomain '${requested}' was unavailable or reserved — assigned: ${msg.subdomain}`,
            );
          }
          this.logger.info(`Tunnel active: ${msg.subdomain}`);
          // Derive the full public tunnel URL from the redirect URL's origin.
          if (msg.redirectUrl) {
            try {
              const u = new URL(msg.redirectUrl);
              this.logger.info(`Public tunnel URL: ${u.protocol}//${msg.subdomain}.${u.hostname}`);
            } catch {
              // non-fatal — redirectUrl may not be a valid URL in edge cases
            }
          }
        }
        if (msg.tunnelType === "tcp" && msg.publicTcpPort) {
          // For fixed-port TCP tunnels the gateway omits subdomain — log active here.
          if (!msg.subdomain) {
            this.logger.info(`Tunnel active (TCP)`);
          }
          this.logger.info(`TCP endpoint: ${msg.publicTcpHost ?? "localhost"}:${msg.publicTcpPort}`);
        }
        if (msg.accessLink) {
          this.logger.info(`Access link (click to whitelist your IP): ${msg.accessLink}`);
        }
        if (msg.redirectUrl) {
          this.logger.info(`Status page (stable): ${msg.redirectUrl}`);
        }
        // Notify the CLI so it can write session info to ~/.portivox/sessions.json.
        this.config.onRegistered?.({
          subdomain: msg.subdomain,
          tunnelType: msg.tunnelType,
          publicTcpPort: msg.publicTcpPort,
          publicTcpHost: msg.publicTcpHost,
          accessLink: msg.accessLink,
          redirectToken: msg.redirectToken,
          redirectUrl: msg.redirectUrl,
        });
        return;
      }

      if (msg.type === "error") {
        this.logger.error(`Gateway error: ${msg.message}`);
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

    this.socket.on("close", () => {
      this.stopHeartbeat();
      for (const connectionId of this.tcpConnections.keys()) {
        this.closeTcpConnection(connectionId, "gateway_disconnected");
      }
      this.scheduleReconnect();
    });

    this.socket.on("error", (err) => {
      this.logger.warn("WebSocket error", { error: err.message });
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
    this.lastActivityAt = Date.now(); // reset on each new connection
    const intervalMs = this.config.heartbeatIntervalMs ?? 5000;
    const livenessThresholdMs = intervalMs * 2;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      // Liveness check: if no frame has been received for 2× the heartbeat interval
      // the gateway is likely unreachable (network partition). Trigger reconnect.
      if (this.lastActivityAt > 0 && now - this.lastActivityAt > livenessThresholdMs) {
        this.logger.warn(`Gateway silent for ${livenessThresholdMs}ms — reconnecting`);
        this.stopHeartbeat();
        this.socket?.terminate();
        this.scheduleReconnect();
        return;
      }
      this.send({ type: "heartbeat", at: now });
    }, intervalMs);
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
    if (this.config.noReconnect) {
      this.logger.info("Tunnel disconnected — exiting (reconnect mode is 'once').");
      process.exit(0);
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
    // SSRF guard: if msg.path is an absolute URL (e.g. http://169.254.169.254/...)
    // new URL(absolute, base) ignores the base entirely. Verify the resolved origin
    // matches localBase before making any outbound request.
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
    const transport = target.protocol === "https:" ? https : http;
    const outboundHeaders = filterHopByHopHeaders(msg.headers);
    outboundHeaders.host = target.host;

    return new Promise((resolve) => {
      const req = transport.request(
        target,
        {
          method: msg.method,
          headers: outboundHeaders,
          timeout: this.config.localTimeoutMs,
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
        // Log the real error locally but return a generic message to the gateway
        // so that internal hostnames, ports, and topology are not leaked to the
        // remote caller.
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
    // Enforce a per-client maximum to prevent a rogue/compromised gateway from
    // flooding the client with tcp_open frames and exhausting local ports/fds.
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
