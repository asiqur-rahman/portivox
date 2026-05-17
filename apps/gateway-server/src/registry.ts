import type WebSocket from 'ws';

export interface TunnelSession {
  id: string;
  subdomain: string;
  connectedAt: number;
  socket?: WebSocket;
}

export class TunnelRegistry {
  private sessions = new Map<string, TunnelSession>();

  register(session: TunnelSession): void {
    this.sessions.set(session.subdomain, session);
  }

  remove(subdomain: string): void {
    this.sessions.delete(subdomain);
  }

  get(subdomain: string): TunnelSession | undefined {
    return this.sessions.get(subdomain);
  }

  list(): TunnelSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      subdomain: session.subdomain,
      connectedAt: session.connectedAt
    }));
  }
}
