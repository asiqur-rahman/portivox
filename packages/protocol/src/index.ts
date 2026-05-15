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

export interface TunnelErrorMessage extends BaseTunnelMessage {
  type: 'error';
  message: string;
}

export type TunnelMessage =
  | RegisterTunnelMessage
  | TunnelRegisteredMessage
  | HeartbeatMessage
  | TunnelErrorMessage
  | BaseTunnelMessage;

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
