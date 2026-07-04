import type { IncomingHttpHeaders } from "node:http";

export type WireMessage =
  | RegisterTunnel
  | Registered
  | HttpRequest
  | HttpResponse
  | TcpOpen
  | TcpData
  | TcpClose
  | Heartbeat
  | HeartbeatAck
  | TunnelRevoked
  | ErrorMessage;

export type StreamTransportMeta = {
  flags?: string[];
  chunk?: {
    index: number;
    total?: number;
    final?: boolean;
  };
  window?: {
    credit?: number;
    ackedBytes?: number;
  };
};

export type RegisterTunnel = {
  type: "register_tunnel";
  requestedSubdomain?: string;
  tunnelType?: "http" | "tcp";
  /** The local port the client is forwarding (e.g. 22 for SSH). Used by the
   *  gateway to look up admin-configured fixed public port mappings. */
  localPort?: number;
  /** Whether to enable IP link protection for this TCP tunnel. When true (the
   *  default for TCP), the public TCP port is dark until a caller clicks the
   *  access link to whitelist their IP for 24 hours. Set to false to disable. */
  ipProtection?: boolean;
  /** Stable redirect token from a previous session. The gateway reuses the
   *  same /r/:token URL on reconnect instead of minting a fresh one. */
  redirectToken?: string;
};

export type Registered = {
  type: "registered";
  /** Subdomain assigned to this tunnel. Omitted for fixed-port TCP tunnels
   *  that are reachable via domain:publicPort rather than a subdomain. */
  subdomain?: string;
  tunnelType?: "http" | "tcp";
  publicHost?: string;
  publicPort?: number;
  publicTcpHost?: string;
  publicTcpPort?: number;
  /** Click-to-whitelist URL (TCP tunnels with IP protection enabled). Visiting
   *  this link adds the caller's IP to the 24-hour allowlist. */
  accessLink?: string;
  /** Opaque token the client should send back in register_tunnel on reconnect
   *  so the same /r/:token stable URL is preserved. */
  redirectToken?: string;
  /** Full stable status URL (/r/:token) — survives reconnects, suitable for
   *  bookmarks and automation scripts. */
  redirectUrl?: string;
};

export type HttpRequest = {
  type: "http_request";
  streamId: string;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  bodyBase64: string;
  meta?: StreamTransportMeta;
};

export type HttpResponse = {
  type: "http_response";
  streamId: string;
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  bodyBase64: string;
  meta?: StreamTransportMeta;
};

export type TcpOpen = {
  type: "tcp_open";
  connectionId: string;
};

export type TcpData = {
  type: "tcp_data";
  connectionId: string;
  dataBase64: string;
};

export type TcpClose = {
  type: "tcp_close";
  connectionId: string;
  reason?: string;
};

export type Heartbeat = {
  type: "heartbeat";
  at: number;
};

export type HeartbeatAck = {
  type: "heartbeat_ack";
};

// Gateway → client: this tunnel was removed by its owner from the web panel (or
// by an admin). The client must close the tunnel and NOT reconnect it.
export type TunnelRevoked = {
  type: "tunnel_revoked";
  subdomain?: string;
  reason?: string;
};

export type ErrorMessage = {
  type: "error";
  message: string;
  code?: string;
  streamId?: string;
};

export type TunnelSession = {
  subdomain: string;
  socketId: string;
  connectedAt: number;
};
