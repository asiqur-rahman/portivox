import crypto from "node:crypto";
import type WebSocket from "ws";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis = require("ioredis");

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
    connect: () => Promise<void>;
    set: (...args: unknown[]) => Promise<string | null>;
    eval: (...args: unknown[]) => Promise<unknown>;
  };
  private readonly keyPrefix: string;

  constructor(redisUrl: string, keyPrefix: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.keyPrefix = keyPrefix;
  }

  async claim(subdomain: string, record: SessionRecord, ttlMs: number): Promise<SessionLease | null> {
    const leaseToken = crypto.randomUUID();
    const key = this.keyFor(subdomain);
    await this.redis.connect();

    const payload = JSON.stringify({ leaseToken, ...record });
    const setResult = await this.redis.set(key, payload, "PX", ttlMs, "NX");
    if (setResult !== "OK") {
      return null;
    }
    return { token: leaseToken, expiresAt: Date.now() + ttlMs };
  }

  async heartbeat(subdomain: string, leaseToken: string, ttlMs: number): Promise<boolean> {
    await this.redis.connect();
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
    await this.redis.connect();
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
};

export class TunnelRegistry {
  private readonly bySubdomain = new Map<string, LocalTunnelEntry>();
  private readonly backend: RegistryBackend;
  private readonly leaseTtlMs: number;
  private readonly nodeId: string;

  constructor(options: TunnelRegistryOptions) {
    this.leaseTtlMs = options.leaseTtlMs;
    this.nodeId = options.nodeId;

    if (options.backend === "redis") {
      if (!options.redisUrl) {
        throw new Error("REGISTRY_BACKEND=redis requires REDIS_URL");
      }
      this.backend = new RedisRegistryBackend(options.redisUrl, options.redisKeyPrefix ?? "tunnelix:registry");
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

  findBySubdomain(subdomain: string): LocalTunnelEntry | undefined {
    return this.bySubdomain.get(subdomain);
  }

  heartbeat(subdomain: string): void {
    const session = this.bySubdomain.get(subdomain);
    if (!session) {
      return;
    }
    session.lastHeartbeatAt = Date.now();

    void this.backend.heartbeat(subdomain, session.leaseToken, this.leaseTtlMs).catch(() => {
      // best-effort heartbeat refresh; request path remains available via local map
    });
  }

  removeBySocket(socket: WebSocket): void {
    for (const [subdomain, entry] of this.bySubdomain.entries()) {
      if (entry.socket === socket) {
        this.bySubdomain.delete(subdomain);
        void this.backend.release(subdomain, entry.leaseToken);
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
        ownerNodeId: this.nodeId,
      },
      this.leaseTtlMs,
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
