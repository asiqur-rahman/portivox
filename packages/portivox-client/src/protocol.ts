type WireMessage =
  | { type: "register_tunnel"; requestedSubdomain?: string; tunnelType?: "http" | "tcp"; localPort?: number; ipProtection?: boolean }
  | { type: "registered"; subdomain?: string; tunnelType?: "http" | "tcp"; publicTcpHost?: string; publicTcpPort?: number; accessLink?: string; redirectToken?: string; redirectUrl?: string }
  | {
      type: "http_request";
      streamId: string;
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
      bodyBase64: string;
      meta?: StreamTransportMeta;
    }
  | {
      type: "http_response";
      streamId: string;
      statusCode: number;
      headers: Record<string, string | string[] | number | undefined>;
      bodyBase64: string;
      meta?: StreamTransportMeta;
    }
  | {
      type: "tcp_open";
      connectionId: string;
    }
  | {
      type: "tcp_data";
      connectionId: string;
      dataBase64: string;
    }
  | {
      type: "tcp_close";
      connectionId: string;
      reason?: string;
    }
  | { type: "heartbeat"; at: number }
  | { type: "error"; message: string; code?: string; streamId?: string };

type StreamTransportMeta = {
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

type WireEnvelope = {
  v?: number;
  payload?: unknown;
  [key: string]: unknown;
};

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify({ v: 2, ...message });
}

export function decodeWireMessage(raw: string): WireMessage {
  const parsed = JSON.parse(raw) as WireEnvelope;

  if (parsed && typeof parsed.type === "string") {
    return parsed as WireMessage;
  }

  if (parsed && typeof parsed.v === "number" && parsed.payload && typeof parsed.payload === "object") {
    const payload = parsed.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return payload as WireMessage;
    }
  }

  throw new Error("Invalid wire message envelope");
}

export type { WireMessage };
