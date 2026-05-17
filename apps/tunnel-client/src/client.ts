import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import WebSocket from "ws";
import { createLogger } from "tunnelix-logger";

type WireMessage =
  | { type: "register_tunnel"; requestedSubdomain?: string }
  | { type: "registered"; subdomain: string }
  | {
      type: "http_request";
      streamId: string;
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
      bodyBase64: string;
    }
  | {
      type: "http_response";
      streamId: string;
      statusCode: number;
      headers: Record<string, string | string[] | number | undefined>;
      bodyBase64: string;
    }
  | { type: "heartbeat"; at: number }
  | { type: "error"; message: string; streamId?: string };

export type TunnelClientConfig = {
  gatewayUrl: string;
  localBase: string;
  requestedSubdomain?: string;
  localTimeoutMs: number;
  maxResponseBodyBytes: number;
  wsHeaders?: Record<string, string>;
};

export class TunnelClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private readonly logger = createLogger("client");

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
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "client_stop");
    }
  }

  private connect(): void {
    this.logger.info(`Connecting to gateway ${this.config.gatewayUrl}`, {
      localBase: this.config.localBase,
      requestedSubdomain: this.config.requestedSubdomain ?? null,
    });
    this.socket = new WebSocket(this.config.gatewayUrl, { headers: this.config.wsHeaders });

    this.socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.send({ type: "register_tunnel", requestedSubdomain: this.config.requestedSubdomain });
      this.startHeartbeat();
    });

    this.socket.on("message", async (raw) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "registered") {
        this.logger.info(`Tunnel active: ${msg.subdomain}`);
        return;
      }

      if (msg.type === "error") {
        this.logger.error(`Gateway error: ${msg.message}`);
        return;
      }

      if (msg.type === "http_request") {
        const response = await this.proxyLocalRequest(msg);
        this.send(response);
      }
    });

    this.socket.on("close", () => {
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.socket.on("error", () => {
      this.stopHeartbeat();
    });
  }

  private send(msg: WireMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(msg));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", at: Date.now() });
    }, 5000);
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

  private async proxyLocalRequest(msg: Extract<WireMessage, { type: "http_request" }>): Promise<Extract<WireMessage, { type: "http_response" }>> {
    const target = new URL(msg.path, this.config.localBase);
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
            resolve({
              type: "http_response",
              streamId: msg.streamId,
              statusCode: res.statusCode ?? 502,
              headers: filterHopByHopHeaders(res.headers),
              bodyBase64: Buffer.concat(chunks).toString("base64"),
            });
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Local request timeout after ${this.config.localTimeoutMs}ms`));
      });

      req.on("error", (error) => {
        resolve({
          type: "http_response",
          streamId: msg.streamId,
          statusCode: 502,
          headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from(JSON.stringify({ error: error.message })).toString("base64"),
        });
      });

      const body = Buffer.from(msg.bodyBase64, "base64");
      if (body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }
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
