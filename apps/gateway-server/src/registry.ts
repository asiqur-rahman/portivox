import crypto from "node:crypto";
import WebSocket from "ws";
import Redis from "ioredis";

type SessionLease = {
  token: string;
  expiresAt: number;
};

type SessionRecord = {
  subdomain: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  ownerNodeId: string;
};

type LocalTunnelEntry = {
  socket: WebSocket;
  subdomain: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  leaseToken: string;
};

type RegistryBackend = {
  claim: (subdomain: string, record: SessionRecord, ttlMs: number) => Promise<SessionLease | null>;
  heartbeat: (subdomain: string, leaseToken: string, ttlMs: number) => Promise<boolean>;
  release: (subdomain: string, leaseToken: string) => Promise<void>;
};

class InMemoryRegistryBackend implements RegistryBackend {
  private readonly sessions = new Map<string, { record: SessionRecord; lease: SessionLease }>();

  async claim(subdomain: string, record: SessionRecord, ttlMs: number): Promise<SessionLease | null> {
    this.cleanupExpired();
    if (this.sessions.has(subdomain)) {
      return null;
    }
    const lease = { token: crypto.randomUUID(), expiresAt: Date.now() + ttlMs };
    this.sessions.set(subdomain, { record, lease });
    return lease;
  }

  async heartbeat(subdomain: string, leaseToken: string, ttlMs: number): Promise<boolean> {
    this.cleanupExpired();
    const current = this.sessions.get(subdomain);
    if (!current || current.lease.token !== leaseToken) {
      return false;
    }
    current.record.lastHeartbeatAt = Date.now();
    current.lease.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(subdomain: string, leaseToken: string): Promise<void> {
    const current = this.sessions.get(subdomain);
    if (current && current.lease.token === leaseToken) {
      this.sessions.delete(subdomain);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [subdomain, value] of this.sessions.entries()) {
      if (value.lease.expiresAt <= now) {
        this.sessions.delete(subdomain);
      }
    }
  }
}

class RedisRegistryBackend implements RegistryBackend {
  private readonly redis: {
    set: (...args: unknown[]) => Promise<string | null>;
    eval: (...args: unknown[]) => Promise<unknown>;
  };

  constructor(redisUrl: string, private readonly keyPrefix: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 }) as unknown as typeof this.redis;
  }

  async claim(subdomain: string, record: SessionRecord, ttlMs: number): Promise<SessionLease | null> {
    const leaseToken = crypto.randomUUID();
    const key = this.keyFor(subdomain);
    const payload = JSON.stringify({ leaseToken, ...record });
    const setResult = await this.redis.set(key, payload, "PX", ttlMs, "NX");
    if (setResult !== "OK") {
      return null;
    }
    return { token: leaseToken, expiresAt: Date.now() + ttlMs };
  }

  async heartbeat(subdomain: string, leaseToken: string, ttlMs: number): Promise<boolean> {
    const key = this.keyFor(subdomain);
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local obj = cjson.decode(raw)
      if obj.leaseToken ~= ARGV[1] then return 0 end
      obj.lastHeartbeatAt = tonumber(ARGV[2])
      redis.call('SET', KEYS[1], cjson.encode(obj), 'PX', ARGV[3])
      return 1
    `;
    const result = await this.redis.eval(script, 1, key, leaseToken, String(Date.now()), String(ttlMs));
    return Number(result) === 1;
  }

  async release(subdomain: string, leaseToken: string): Promise<void> {
    const key = this.keyFor(subdomain);
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local obj = cjson.decode(raw)
      if obj.leaseToken ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[1])
      return 1
    `;
    await this.redis.eval(script, 1, key, leaseToken);
  }

  private keyFor(subdomain: string): string {
    return `${this.keyPrefix}:subdomain:${subdomain}`;
  }
}

export type TunnelRegistryOptions = {
  backend: "memory" | "redis";
  redisUrl?: string;
  redisKeyPrefix?: string;
  leaseTtlMs: number;
  nodeId: string;
  onLeaseLost?: (event: { subdomain: string; leaseToken: string }) => void;
  onStaleSessionEvicted?: (event: { subdomain: string; idleMs: number }) => void;
};

export class TunnelRegistry {
  private readonly bySubdomain = new Map<string, LocalTunnelEntry>();
  private readonly backend: RegistryBackend;

  constructor(private readonly options: TunnelRegistryOptions) {
    if (options.backend === "redis") {
      if (!options.redisUrl) {
        throw new Error("REGISTRY_BACKEND=redis requires REDIS_URL");
      }
      this.backend = new RedisRegistryBackend(options.redisUrl, options.redisKeyPrefix ?? "portivox:registry");
    } else {
      this.backend = new InMemoryRegistryBackend();
    }
  }

  async assign(requestedSubdomain: string | undefined, socket: WebSocket): Promise<string> {
    const now = Date.now();
    const preferred = sanitizeSubdomain(requestedSubdomain);

    if (preferred) {
      const claimed = await this.tryClaim(preferred, socket, now);
      if (claimed) {
        return preferred;
      }
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = crypto.randomBytes(3).toString("hex");
      const claimed = await this.tryClaim(candidate, socket, now);
      if (claimed) {
        return candidate;
      }
    }

    throw new Error("Could not allocate unique tunnel subdomain");
  }

  async assignExact(requestedSubdomain: string, socket: WebSocket): Promise<string | null> {
    const preferred = sanitizeSubdomain(requestedSubdomain);
    if (!preferred) {
      return null;
    }
    const claimed = await this.tryClaim(preferred, socket, Date.now());
    return claimed ? preferred : null;
  }

  findBySubdomain(subdomain: string): LocalTunnelEntry | undefined {
    const entry = this.bySubdomain.get(subdomain);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.lastHeartbeatAt > this.options.leaseTtlMs * 2) {
      this.options.onStaleSessionEvicted?.({
        subdomain,
        idleMs: Date.now() - entry.lastHeartbeatAt,
      });
      this.forceCloseLocalEntry(subdomain, entry, "stale_session");
      return undefined;
    }
    return entry;
  }

  heartbeat(subdomain: string): void {
    const session = this.bySubdomain.get(subdomain);
    if (!session) {
      return;
    }
    session.lastHeartbeatAt = Date.now();

    void this.backend.heartbeat(subdomain, session.leaseToken, this.options.leaseTtlMs)
      .then((alive) => {
        if (!alive) {
          process.stderr.write(`[registry] lease lost: subdomain=${subdomain}\n`);
          this.options.onLeaseLost?.({ subdomain, leaseToken: session.leaseToken });
          this.forceCloseIfLeaseMatches(subdomain, session.leaseToken, "lease_lost");
        }
      })
      .catch((err) => {
        process.stderr.write(`[registry] backend heartbeat failed: subdomain=${subdomain} err=${String(err)}\n`);
      });
  }

  removeBySocket(socket: WebSocket): void {
    for (const [subdomain, entry] of this.bySubdomain.entries()) {
      if (entry.socket === socket) {
        this.bySubdomain.delete(subdomain);
        void this.backend.release(subdomain, entry.leaseToken).catch((err) => {
          process.stderr.write(`[registry] backend release failed: subdomain=${subdomain} err=${String(err)}\n`);
        });
      }
    }
  }

  sweepStaleSockets(maxIdleMs = this.options.leaseTtlMs * 2): number {
    let removed = 0;
    const now = Date.now();
    for (const [subdomain, entry] of this.bySubdomain.entries()) {
      if (now - entry.lastHeartbeatAt > maxIdleMs) {
        removed += 1;
        this.options.onStaleSessionEvicted?.({ subdomain, idleMs: now - entry.lastHeartbeatAt });
        this.forceCloseLocalEntry(subdomain, entry, "stale_session");
      }
    }
    return removed;
  }

  /** The live WebSocket for a subdomain, if a client is currently connected.
   *  Used to push control frames (e.g. tunnel_revoked) to the owning client. */
  getSocketBySubdomain(subdomain: string): WebSocket | undefined {
    return this.bySubdomain.get(subdomain)?.socket;
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

  private async tryClaim(subdomain: string, socket: WebSocket, now: number): Promise<boolean> {
    if (this.bySubdomain.has(subdomain)) {
      return false;
    }

    const lease = await this.backend.claim(
      subdomain,
      {
        subdomain,
        connectedAt: now,
        lastHeartbeatAt: now,
        ownerNodeId: this.options.nodeId,
      },
      this.options.leaseTtlMs,
    );

    if (!lease) {
      return false;
    }

    this.bySubdomain.set(subdomain, {
      socket,
      subdomain,
      connectedAt: now,
      lastHeartbeatAt: now,
      leaseToken: lease.token,
    });
    return true;
  }

  private forceCloseIfLeaseMatches(subdomain: string, leaseToken: string, reason: string): void {
    const current = this.bySubdomain.get(subdomain);
    if (!current || current.leaseToken !== leaseToken) {
      return;
    }
    this.forceCloseLocalEntry(subdomain, current, reason);
  }

  private forceCloseLocalEntry(subdomain: string, entry: LocalTunnelEntry, reason: string): void {
    this.bySubdomain.delete(subdomain);
    void this.backend.release(subdomain, entry.leaseToken).catch((err) => {
      process.stderr.write(`[registry] backend release failed: subdomain=${subdomain} err=${String(err)}\n`);
    });
    try {
      if (entry.socket.readyState === WebSocket.OPEN || entry.socket.readyState === WebSocket.CONNECTING) {
        entry.socket.close(1012, reason);
      }
      entry.socket.terminate();
    } catch {
      // best-effort cleanup only
    }
  }
}

const RESERVED_SUBDOMAINS = new Set([
  "www", "api", "app", "mail", "email", "smtp", "pop", "imap", "ftp", "sftp",
  "ssh", "rdp", "vpn", "dns", "ns", "ns1", "ns2", "mx", "mx1", "mx2",
  "admin", "administrator", "portal", "dashboard", "console", "panel",
  "gateway", "proxy", "tunnel", "relay", "hub",
  "status", "health", "monitor", "metrics", "logs", "log",
  "dev", "stg", "staging", "prod", "production", "test", "demo", "sandbox",
  "cdn", "static", "assets", "media", "files", "storage", "s3",
  "login", "auth", "sso", "oauth", "register", "signup", "account",
  "blog", "shop", "store", "pay", "payment", "checkout", "billing",
  "help", "docs", "support", "forum", "community", "chat",
  "portivox", "localhost",
]);

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
  if (raw.includes("--")) {
    return "";
  }
  if (RESERVED_SUBDOMAINS.has(raw)) {
    return "";
  }
  return raw;
}
