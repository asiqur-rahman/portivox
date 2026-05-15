export type TunnelMessageType =
  | 'register_tunnel'
  | 'tunnel_registered'
  | 'heartbeat'
  | 'http_request'
  | 'http_response'
  | 'stream_chunk'
  | 'stream_end'
  | 'error';

export interface BaseTunnelMessage {
  type: TunnelMessageType;
  streamId?: string;
}

export interface RegisterTunnelMessage extends BaseTunnelMessage {
  type: 'register_tunnel';
  desiredSubdomain?: string;
}

export interface TunnelRegisteredMessage extends BaseTunnelMessage {
  type: 'tunnel_registered';
  subdomain: string;
  publicUrl: string;
}

export interface HeartbeatMessage extends BaseTunnelMessage {
  type: 'heartbeat';
  timestamp: number;
}

export interface HttpRequestMessage extends BaseTunnelMessage {
  type: 'http_request';
  streamId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface HttpResponseMessage extends BaseTunnelMessage {
  type: 'http_response';
  streamId: string;
  statusCode: number;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface TunnelErrorMessage extends BaseTunnelMessage {
  type: 'error';
  streamId?: string;
  message: string;
}

export type TunnelMessage =
  | RegisterTunnelMessage
  | TunnelRegisteredMessage
  | HeartbeatMessage
  | HttpRequestMessage
  | HttpResponseMessage
  | TunnelErrorMessage;

export function encodeMessage(message: TunnelMessage): string {
  return JSON.stringify(message);
}

export function decodeMessage(payload: string): TunnelMessage {
  const parsed = JSON.parse(payload) as TunnelMessage;

  if (!parsed || typeof parsed.type !== 'string') {
    throw new Error('Invalid tunnel message');
  }

  return parsed;
}

export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value.join(', ');
    }
  }

  return normalized;
}
