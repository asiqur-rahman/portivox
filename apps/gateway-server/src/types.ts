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
};

export type Registered = {
  type: "registered";
  subdomain: string;
  tunnelType?: "http" | "tcp";
  publicTcpHost?: string;
  publicTcpPort?: number;
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

export type ErrorMessage = {
  type: "error";
  message: string;
  streamId?: string;
};

export type TunnelSession = {
  subdomain: string;
  socketId: string;
  connectedAt: number;
};
