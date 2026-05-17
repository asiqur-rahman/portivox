import crypto from "node:crypto";
import type WebSocket from "ws";

type TunnelEntry = {
  socket: WebSocket;
  subdomain: string;
  connectedAt: number;
  lastHeartbeatAt: number;
};

export class TunnelRegistry {
  private readonly bySubdomain = new Map<string, TunnelEntry>();

  assign(requestedSubdomain: string | undefined, socket: WebSocket): string {
    const chosen = this.uniqueSubdomain(requestedSubdomain);
    this.bySubdomain.set(chosen, {
      socket,
      subdomain: chosen,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
    return chosen;
  }

  findBySubdomain(subdomain: string): TunnelEntry | undefined {
    return this.bySubdomain.get(subdomain);
  }

  heartbeat(subdomain: string): void {
    const session = this.bySubdomain.get(subdomain);
    if (session) {
      session.lastHeartbeatAt = Date.now();
    }
  }

  removeBySocket(socket: WebSocket): void {
    for (const [subdomain, entry] of this.bySubdomain.entries()) {
      if (entry.socket === socket) {
        this.bySubdomain.delete(subdomain);
      }
    }
  }

  listSessions(): Array<{ subdomain: string; connectedAt: number; lastHeartbeatAt: number }> {
    return [...this.bySubdomain.values()].map((entry) => ({
      subdomain: entry.subdomain,
      connectedAt: entry.connectedAt,
      lastHeartbeatAt: entry.lastHeartbeatAt,
    }));
  }

  count(): number {
    return this.bySubdomain.size;
  }

  private uniqueSubdomain(requestedSubdomain: string | undefined): string {
    const base = sanitizeSubdomain(requestedSubdomain);
    if (base && !this.bySubdomain.has(base)) {
      return base;
    }

    while (true) {
      const candidate = crypto.randomBytes(3).toString("hex");
      if (!this.bySubdomain.has(candidate)) {
        return candidate;
      }
    }
  }
}

function sanitizeSubdomain(input: string | undefined): string {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) {
    return "";
  }

  if (!/^[a-z0-9-]{3,32}$/.test(raw)) {
    return "";
  }

  if (raw.startsWith("-") || raw.endsWith("-")) {
    return "";
  }

  return raw;
}
