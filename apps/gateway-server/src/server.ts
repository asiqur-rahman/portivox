import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import WebSocket, { WebSocketServer } from "ws";
import { PrismaClient } from "@prisma/client";
import { badRequest, gatewayTimeout, notFound, toErrorPayload } from "portivox-errors";
import { hasScope, parseApiKeys, parseScopes, readBearerToken, signAccessToken, validateApiKey, verifyAccessToken } from "portivox-auth";
import { GatewayMetrics } from "./metrics";
import { buildOpenApiDocument } from "./openapi";
import { RateLimiter } from "./rate-limit";
import { decodeWireMessage, encodeWireMessage } from "./protocol";
import { TunnelRegistry } from "./registry";
import { extractSubdomain, readRequestBody } from "./router";
import type { HttpRequest, HttpResponse, RegisterTunnel, WireMessage } from "./types";

export type GatewayRuntimeConfig = {
  gatewayPort: number;
  wsPort: number;
  rootDomain: string;
  tunnelResponseTimeoutMs: number;
  wsIdleTimeoutMs: number;
  maxRequestBodyBytes: number;
  authRequired?: boolean;
  authApiKeys?: string;
  authApiKeyScopes?: string;
  authJwtSecret?: string;
  adminEmails?: string;
  registryBackend?: "memory" | "redis";
  redisUrl?: string;
  redisKeyPrefix?: string;
  registryLeaseTtlMs?: number;
  nodeId?: string;
  maxConcurrentStreamsPerTunnel?: number;
  streamIdleTimeoutMs?: number;
  maintenanceMode?: boolean;
  startupGraceMs?: number;
  auditExportJsonlPath?: string;
  auditExportWebhookUrl?: string;
  auditExportWebhookTimeoutMs?: number;
  auditExportWebhookSecret?: string;
  auditExportWebhookMaxRetries?: number;
  auditExportWebhookRetryBaseMs?: number;
  auditExportDeadLetterJsonlPath?: string;
  apiVersion?: string;
  apiDeprecationEnabled?: boolean;
  apiSunsetDate?: string;
  apiRateLimitReadPerMin?: number;
  apiRateLimitWritePerMin?: number;
  apiRateLimitAdminPerMin?: number;
  ingressRateLimitPerMin?: number;
  corsAllowedOrigins?: string;
  corsAllowCredentials?: boolean;
  securityHeadersEnabled?: boolean;
  idempotencyEnabled?: boolean;
  idempotencyTtlMs?: number;
  tcpTunnelEnabled?: boolean;
  tcpTunnelBindHost?: string;
  tcpPublicHost?: string;
  tcpPublicPortStart?: number;
  tcpPublicPortEnd?: number;
  httpPublicPortMode?: boolean;
  /** Default IP protection mode for TCP tunnels (default: true). */
  ipProtectionDefault?: boolean;
  /** Max new TCP connections per IP per minute before the connection is dropped (default: 10). */
  tcpConnectionRateLimit?: number;
  /** Public-facing base URL used to build access links and redirect URLs (e.g. https://portivox.example.com). */
  gatewayPublicBaseUrl?: string;
  /** Optional static bearer token required to access /metrics. Leave unset to keep metrics open (e.g. for internal scraping). */
  metricsToken?: string;
};

type Principal = {
  userId: string;
  authType: "api_key" | "jwt" | "anonymous";
  apiKey?: string;
  scopes: string[];
  role: "owner" | "admin" | "viewer";
};

type LiveEventKind =
  | "connected"
  | "tunnels_changed"
  | "gateway_status_changed"
  | "audit_changed"
  | "api_keys_changed"
  | "tcp_mappings_changed"
  | "users_changed"
  | "devices_changed"
  | "inspector_changed";

type LiveEvent = {
  kind: LiveEventKind;
  at: string;
  userId?: string | null;
  subdomain?: string | null;
};

type LiveSubscriber = {
  id: string;
  principal: Principal;
  write: (event: LiveEvent) => void;
  close: () => void;
};

type TunnelRecord = { id: string; userId: string; subdomain: string; createdAt: string };

type IdempotencyReplay = {
  statusCode: number;
  body: unknown;
  contentType: string;
  storedAt: number;
};

/** Per-token IP allowlist for TCP link protection. */
type IpAccessEntry = {
  tunnelKey: string;
  /** ip → expiresAt timestamp (ms). */
  allowedIps: Map<string, number>;
  tokenCreatedAt: number;
};

/** Stable tunnel status record keyed by the /r/:token URL. */
type RedirectEntry = {
  tunnelKey: string;
  /** userId of the principal who originally created this redirect entry.
   *  Used to prevent redirect token takeover by other authenticated users. */
  userId?: string;
  tunnelType: "http" | "tcp";
  subdomain?: string;
  publicHost?: string;
  publicPort?: number;
  publicTcpPort?: number;
  publicTcpHost?: string;
  accessLink?: string;
  connected: boolean;
  createdAt: number;
  lastSeenAt: number;
  disconnectedAt?: number;
};

/** Captured HTTP request/response pair stored in the per-tunnel ring buffer. */
type CapturedRequest = {
  id: string;
  capturedAt: number;
  durationMs: number | null;
  method: string;
  path: string;
  statusCode: number | null;
  requestHeaders: Record<string, string | string[] | undefined>;
  responseHeaders: Record<string, string | string[] | undefined>;
  requestBodyBase64: string;
  requestBodyTruncated: boolean;
  responseBodyBase64: string;
  responseBodyTruncated: boolean;
  error: string | null;
};

class TunnelStore {
  private readonly prisma: PrismaClient | null;
  private readonly ownsPrisma: boolean;
  private readonly memory = new Map<string, TunnelRecord>();

  constructor(prisma?: PrismaClient | null) {
    this.prisma = prisma ?? (process.env.DATABASE_URL ? new PrismaClient() : null);
    this.ownsPrisma = !prisma && this.prisma !== null;
  }

  async create(userId: string, subdomain: string): Promise<TunnelRecord> {
    if (this.prisma) {
      const row = await this.prisma.tunnel.create({
        data: { userId, subdomain },
      });
      return { id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() };
    }

    const id = randomUUID();
    const row = { id, userId, subdomain, createdAt: new Date().toISOString() };
    this.memory.set(id, row);
    return row;
  }

  async list(userId: string): Promise<TunnelRecord[]> {
    if (this.prisma) {
      const rows = await this.prisma.tunnel.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
      return rows.map((row: { id: string; userId: string; subdomain: string; createdAt: Date }) => ({ id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() }));
    }

    return [...this.memory.values()].filter((item) => item.userId === userId);
  }

  async listAll(): Promise<TunnelRecord[]> {
    if (this.prisma) {
      const rows = await this.prisma.tunnel.findMany({ orderBy: { createdAt: "desc" } });
      return rows.map((row: { id: string; userId: string; subdomain: string; createdAt: Date }) => ({ id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() }));
    }

    return [...this.memory.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findById(id: string): Promise<TunnelRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.tunnel.findUnique({ where: { id } });
      return row ? { id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() } : null;
    }

    return this.memory.get(id) ?? null;
  }

  /** Look up a reserved tunnel by its subdomain. Used to tell a DB-reserved
   *  tunnel (keep its offline ghost for reconnect) from an ephemeral CLI
   *  session (purge on disconnect). */
  async findBySubdomain(subdomain: string): Promise<TunnelRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.tunnel.findUnique({ where: { subdomain } });
      return row ? { id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() } : null;
    }
    return [...this.memory.values()].find((item) => item.subdomain === subdomain) ?? null;
  }

  async delete(id: string): Promise<void> {
    if (this.prisma) {
      await this.prisma.tunnel.delete({ where: { id } });
      return;
    }

    this.memory.delete(id);
  }

  async close(): Promise<void> {
    if (this.prisma && this.ownsPrisma) {
      await this.prisma.$disconnect();
    }
  }
}

type ApiKeyRecord = {
  id: string;
  name: string;
  createdAt: string;
  revoked: boolean;
  keyHash: string;
  scopes: string[];
};

class AuthStore {
  private readonly prisma: PrismaClient | null;
  private readonly ownsPrisma: boolean;
  private readonly memory = new Map<string, ApiKeyRecord[]>();

  constructor(prisma?: PrismaClient | null) {
    this.prisma = prisma ?? (process.env.DATABASE_URL ? new PrismaClient() : null);
    this.ownsPrisma = !prisma && this.prisma !== null;
  }

  async createApiKey(userId: string, name: string, keyHash: string, scopes: string[]): Promise<ApiKeyRecord> {
    if (this.prisma) {
      const existingUser = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!existingUser) {
        await this.prisma.user.create({
          data: {
            id: userId,
            email: `${userId}@local.portivox`,
          },
        });
      }
      const row = await this.prisma.apiKey.create({
        data: { userId, keyHash, name, scopes: scopes.join(",") },
      });
      return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), revoked: row.revoked, keyHash: row.keyHash, scopes: parseScopes((row as unknown as { scopes?: string }).scopes, []) };
    }

    const row = { id: randomUUID(), name, createdAt: new Date().toISOString(), revoked: false, keyHash, scopes };
    const keys = this.memory.get(userId) ?? [];
    keys.push(row);
    this.memory.set(userId, keys);
    return row;
  }

  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    if (this.prisma) {
      const rows = await this.prisma.apiKey.findMany({ where: { userId, revoked: false }, orderBy: { createdAt: "desc" } });
      return rows.map((row: { id: string; name: string; createdAt: Date; revoked: boolean; keyHash: string; scopes?: string }) => ({ id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), revoked: row.revoked, keyHash: row.keyHash, scopes: parseScopes((row as unknown as { scopes?: string }).scopes, []) }));
    }
    return [...(this.memory.get(userId) ?? [])].filter((item) => !item.revoked);
  }

  /** Revoke (delete) a key. Returns the deleted key's hash so callers can
   *  disconnect live devices using it, or null when no such key existed. */
  async revokeApiKey(userId: string, id: string): Promise<string | null> {
    if (this.prisma) {
      const existing = await this.prisma.apiKey.findFirst({ where: { id, userId }, select: { keyHash: true } });
      if (!existing) {
        return null;
      }
      await this.prisma.apiKey.deleteMany({ where: { id, userId } });
      return existing.keyHash;
    }
    const keys = this.memory.get(userId) ?? [];
    const targetIndex = keys.findIndex((item) => item.id === id);
    if (targetIndex < 0) {
      return null;
    }
    const [removed] = keys.splice(targetIndex, 1);
    return removed.keyHash;
  }

  async validateApiKey(keyHash: string): Promise<{ userId: string; scopes: string[] } | null> {
    if (this.prisma) {
      const row = await this.prisma.apiKey.findFirst({
        where: { keyHash, revoked: false },
        select: { userId: true, scopes: true },
      });
      return row ? { userId: row.userId, scopes: parseScopes((row as unknown as { scopes?: string }).scopes, []) } : null;
    }
    for (const [userId, keys] of this.memory.entries()) {
      const match = keys.find((item) => item.keyHash === keyHash && !item.revoked);
      if (match) {
        return { userId, scopes: match.scopes };
      }
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.prisma && this.ownsPrisma) {
      await this.prisma.$disconnect();
    }
  }
}

type UserAuthRecord = {
  id: string;
  email: string;
  passwordHash: string;
  /** Subscription entitlement: may this user open subdomain (HTTP) tunnels? */
  subdomainEnabled: boolean;
  createdAt: string;
};

type UserSummary = {
  id: string;
  email: string;
  subdomainEnabled: boolean;
  createdAt: string;
};

class UserAuthStore {
  private readonly prisma: PrismaClient | null;
  private readonly ownsPrisma: boolean;
  private readonly memory = new Map<string, UserAuthRecord>();

  constructor(prisma?: PrismaClient | null) {
    this.prisma = prisma ?? (process.env.DATABASE_URL ? new PrismaClient() : null);
    this.ownsPrisma = !prisma && this.prisma !== null;
  }

  async register(email: string, passwordHash: string): Promise<UserAuthRecord> {
    if (this.prisma) {
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new Error("USER_EXISTS");
      }
      const row = await this.prisma.user.create({ data: { email, passwordHash } });
      return { id: row.id, email: row.email, passwordHash: row.passwordHash ?? "", subdomainEnabled: row.subdomainEnabled, createdAt: row.createdAt.toISOString() };
    }

    const found = [...this.memory.values()].find((item) => item.email === email);
    if (found) {
      throw new Error("USER_EXISTS");
    }
    const created: UserAuthRecord = { id: randomUUID(), email, passwordHash, subdomainEnabled: false, createdAt: new Date().toISOString() };
    this.memory.set(created.id, created);
    return created;
  }

  async findByEmail(email: string): Promise<UserAuthRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.user.findUnique({ where: { email } });
      if (!row || !row.passwordHash) {
        return null;
      }
      return { id: row.id, email: row.email, passwordHash: row.passwordHash, subdomainEnabled: row.subdomainEnabled, createdAt: row.createdAt.toISOString() };
    }

    return [...this.memory.values()].find((item) => item.email === email) ?? null;
  }

  async findById(id: string): Promise<UserAuthRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.user.findUnique({ where: { id } });
      if (!row || !row.passwordHash) return null;
      return { id: row.id, email: row.email, passwordHash: row.passwordHash, subdomainEnabled: row.subdomainEnabled, createdAt: row.createdAt.toISOString() };
    }
    return this.memory.get(id) ?? null;
  }

  /** List all registered users (admin use). Includes users with no password
   *  (e.g. provisioned via API key only). */
  async listUsers(): Promise<UserSummary[]> {
    if (this.prisma) {
      const rows = await this.prisma.user.findMany({ orderBy: { createdAt: "desc" } });
      return rows.map((r) => ({ id: r.id, email: r.email, subdomainEnabled: r.subdomainEnabled, createdAt: r.createdAt.toISOString() }));
    }
    return [...this.memory.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((u) => ({ id: u.id, email: u.email, subdomainEnabled: u.subdomainEnabled, createdAt: u.createdAt }));
  }

  /** Toggle the subdomain subscription entitlement for a user. Returns the
   *  updated summary, or null when the user does not exist. */
  async setSubdomainEnabled(id: string, enabled: boolean): Promise<UserSummary | null> {
    if (this.prisma) {
      try {
        const row = await this.prisma.user.update({ where: { id }, data: { subdomainEnabled: enabled } });
        return { id: row.id, email: row.email, subdomainEnabled: row.subdomainEnabled, createdAt: row.createdAt.toISOString() };
      } catch {
        return null;
      }
    }
    const existing = this.memory.get(id);
    if (!existing) return null;
    const next: UserAuthRecord = { ...existing, subdomainEnabled: enabled };
    this.memory.set(id, next);
    return { id: next.id, email: next.email, subdomainEnabled: next.subdomainEnabled, createdAt: next.createdAt };
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    if (this.prisma) {
      await this.prisma.user.update({ where: { id }, data: { passwordHash } });
      return;
    }
    const existing = this.memory.get(id);
    if (existing) {
      this.memory.set(id, { ...existing, passwordHash });
    }
  }

  async close(): Promise<void> {
    if (this.prisma && this.ownsPrisma) {
      await this.prisma.$disconnect();
    }
  }
}

type DeviceRecord = {
  id: string;
  deviceId: string;
  name: string;
  platform: string | null;
  clientVersion: string | null;
  lastKeyHash: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** Roster of machines that have connected a Portivox client, keyed by a stable
 *  client-generated deviceId. Persisted (dual-mode); online status is layered on
 *  top from live sockets by the server. */
class DeviceStore {
  private readonly prisma: PrismaClient | null;
  private readonly ownsPrisma: boolean;
  private readonly memory = new Map<string, DeviceRecord[]>();

  constructor(prisma?: PrismaClient | null) {
    this.prisma = prisma ?? (process.env.DATABASE_URL ? new PrismaClient() : null);
    this.ownsPrisma = !prisma && this.prisma !== null;
  }

  /** Insert or refresh a device for a user. Returns the stored record. */
  async upsert(userId: string, input: { deviceId: string; name: string; platform?: string | null; clientVersion?: string | null; lastKeyHash?: string | null }): Promise<DeviceRecord> {
    const now = new Date();
    if (this.prisma) {
      const row = await this.prisma.device.upsert({
        where: { userId_deviceId: { userId, deviceId: input.deviceId } },
        create: { userId, deviceId: input.deviceId, name: input.name, platform: input.platform ?? null, clientVersion: input.clientVersion ?? null, lastKeyHash: input.lastKeyHash ?? null },
        update: { name: input.name, platform: input.platform ?? null, clientVersion: input.clientVersion ?? null, lastKeyHash: input.lastKeyHash ?? null, lastSeenAt: now },
      });
      return this.toRecord(row);
    }
    const list = this.memory.get(userId) ?? [];
    const existing = list.find((d) => d.deviceId === input.deviceId);
    if (existing) {
      existing.name = input.name;
      existing.platform = input.platform ?? null;
      existing.clientVersion = input.clientVersion ?? null;
      existing.lastKeyHash = input.lastKeyHash ?? null;
      existing.lastSeenAt = now.toISOString();
      return existing;
    }
    const created: DeviceRecord = {
      id: randomUUID(), deviceId: input.deviceId, name: input.name,
      platform: input.platform ?? null, clientVersion: input.clientVersion ?? null,
      lastKeyHash: input.lastKeyHash ?? null, firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(),
    };
    list.push(created);
    this.memory.set(userId, list);
    return created;
  }

  /** Stamp lastSeenAt for a device (e.g. on disconnect). Best-effort. */
  async touch(userId: string, deviceId: string): Promise<void> {
    if (this.prisma) {
      try {
        await this.prisma.device.update({ where: { userId_deviceId: { userId, deviceId } }, data: { lastSeenAt: new Date() } });
      } catch { /* device may have been forgotten */ }
      return;
    }
    const existing = (this.memory.get(userId) ?? []).find((d) => d.deviceId === deviceId);
    if (existing) existing.lastSeenAt = new Date().toISOString();
  }

  async list(userId: string): Promise<DeviceRecord[]> {
    if (this.prisma) {
      const rows = await this.prisma.device.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" } });
      return rows.map((row) => this.toRecord(row));
    }
    return [...(this.memory.get(userId) ?? [])].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async findById(userId: string, id: string): Promise<DeviceRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.device.findFirst({ where: { id, userId } });
      return row ? this.toRecord(row) : null;
    }
    return (this.memory.get(userId) ?? []).find((d) => d.id === id) ?? null;
  }

  /** Forget a device. Returns its deviceId (to disconnect live sockets) or null. */
  async remove(userId: string, id: string): Promise<string | null> {
    if (this.prisma) {
      const row = await this.prisma.device.findFirst({ where: { id, userId }, select: { deviceId: true } });
      if (!row) return null;
      await this.prisma.device.deleteMany({ where: { id, userId } });
      return row.deviceId;
    }
    const list = this.memory.get(userId) ?? [];
    const idx = list.findIndex((d) => d.id === id);
    if (idx < 0) return null;
    const [removed] = list.splice(idx, 1);
    return removed.deviceId;
  }

  private toRecord(row: { id: string; deviceId: string; name: string; platform: string | null; clientVersion: string | null; lastKeyHash: string | null; firstSeenAt: Date; lastSeenAt: Date }): DeviceRecord {
    return {
      id: row.id, deviceId: row.deviceId, name: row.name, platform: row.platform,
      clientVersion: row.clientVersion, lastKeyHash: row.lastKeyHash,
      firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.prisma && this.ownsPrisma) {
      await this.prisma.$disconnect();
    }
  }
}

type UsageStats = { bytesIn: number; bytesOut: number; totalBytes: number; requests: number; avgLatencyMs: number };

/** In-memory per-user usage meter: bytes relayed (HTTP + TCP) and HTTP request
 *  latency, aggregated since gateway start. "Meter & show" only — no quota
 *  enforcement and no persistence (counters reset on restart). */
class UsageMeter {
  private readonly byUser = new Map<string, { bytesIn: number; bytesOut: number; requests: number; latencySumMs: number }>();

  private entry(userId: string): { bytesIn: number; bytesOut: number; requests: number; latencySumMs: number } {
    let e = this.byUser.get(userId);
    if (!e) {
      e = { bytesIn: 0, bytesOut: 0, requests: 0, latencySumMs: 0 };
      this.byUser.set(userId, e);
    }
    return e;
  }

  recordBytes(userId: string | null, bytesIn: number, bytesOut: number): void {
    if (!userId) return;
    const e = this.entry(userId);
    if (bytesIn > 0) e.bytesIn += bytesIn;
    if (bytesOut > 0) e.bytesOut += bytesOut;
  }

  recordRequest(userId: string | null, latencyMs: number, bytesIn: number, bytesOut: number): void {
    if (!userId) return;
    const e = this.entry(userId);
    e.requests += 1;
    if (latencyMs > 0) e.latencySumMs += latencyMs;
    if (bytesIn > 0) e.bytesIn += bytesIn;
    if (bytesOut > 0) e.bytesOut += bytesOut;
  }

  get(userId: string): UsageStats {
    const e = this.byUser.get(userId);
    if (!e) return { bytesIn: 0, bytesOut: 0, totalBytes: 0, requests: 0, avgLatencyMs: 0 };
    return {
      bytesIn: e.bytesIn,
      bytesOut: e.bytesOut,
      totalBytes: e.bytesIn + e.bytesOut,
      requests: e.requests,
      avgLatencyMs: e.requests > 0 ? Math.round(e.latencySumMs / e.requests) : 0,
    };
  }
}

class AuditStore {
  private readonly prisma: PrismaClient | null;
  private readonly ownsPrisma: boolean;
  private readonly sink: AuditSink;
  private readonly memory: Array<AuditEvent & { id: string }> = [];
  // Cap the DB-less in-memory audit log so a long-running gateway without a
  // database doesn't grow the heap unbounded (oldest events are dropped).
  private static readonly MAX_MEMORY_EVENTS = 5000;
  private readonly onLogged?: (event: AuditEvent & { id?: string }) => void;

  private pushMemory(event: AuditEvent & { id: string }): void {
    this.memory.push(event);
    const overflow = this.memory.length - AuditStore.MAX_MEMORY_EVENTS;
    if (overflow > 0) {
      this.memory.splice(0, overflow);
    }
  }

  constructor(sink: AuditSink, prisma?: PrismaClient | null, options?: { onLogged?: (event: AuditEvent & { id?: string }) => void }) {
    this.prisma = prisma ?? (process.env.DATABASE_URL ? new PrismaClient() : null);
    this.ownsPrisma = !prisma && this.prisma !== null;
    this.sink = sink;
    this.onLogged = options?.onLogged;
  }

  async log(userId: string | null, action: string, resource: string, resourceId: string | null, metadata?: unknown): Promise<void> {
    const auditEvent = {
      at: new Date().toISOString(),
      userId,
      action,
      resource,
      resourceId,
      metadata: metadata ?? null,
    };
    if (!this.prisma) {
      const storedEvent = { id: randomUUID(), ...auditEvent };
      this.pushMemory(storedEvent);
      await this.sink.emit(auditEvent);
      this.onLogged?.(storedEvent);
      return;
    }
    const normalizedUserId = userId && userId !== "anonymous" ? userId : null;
    try {
      if (normalizedUserId) {
        await this.ensureUser(normalizedUserId);
      }
      await this.prisma.auditEvent.create({
        data: {
          userId: normalizedUserId,
          action,
          resource,
          resourceId,
          metadata: metadata as object | undefined,
        },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2003") {
        // Foreign-key violation: user row missing — retry without userId so the
        // audit event is never lost.
        try {
          await this.prisma.auditEvent.create({
            data: {
              userId: null,
              action,
              resource,
              resourceId,
              metadata: {
                ...(metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}),
                fallbackUserId: normalizedUserId,
              },
            },
          });
        } catch {
          // Prisma still failing after retry — fall back to in-memory.
          const storedEvent = { id: randomUUID(), ...auditEvent };
          this.pushMemory(storedEvent);
          this.onLogged?.(storedEvent);
        }
      } else {
        // Engine not yet connected, DB offline, transient error, etc.
        // Never propagate — audit failures must not crash callers that use
        // `void auditStore.log(...)` (fire-and-forget), which would turn a
        // thrown error into an unhandled rejection and exit the process.
        const storedEvent = { id: randomUUID(), ...auditEvent };
        this.pushMemory(storedEvent);
        this.onLogged?.(storedEvent);
      }
      // Emit to configured sinks (JSONL file, webhook) regardless of DB state.
      await this.sink.emit(auditEvent);
      return;
    }
    await this.sink.emit(auditEvent);
    this.onLogged?.(auditEvent);
  }

  async query(options: {
    userId?: string;
    action?: string;
    resource?: string;
    from?: Date;
    to?: Date;
    limit: number;
    cursor?: string;
  }): Promise<{ items: Array<AuditEvent & { id: string }>; nextCursor: string | null }> {
    const { userId, action, resource, from, to, limit, cursor } = options;
    if (this.prisma) {
      const where: {
        userId?: string;
        action?: string;
        resource?: string;
        createdAt?: { gte?: Date; lte?: Date };
      } = {};
      if (userId) where.userId = userId;
      if (action) where.action = action;
      if (resource) where.resource = resource;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = from;
        if (to) where.createdAt.lte = to;
      }

      const rows = await this.prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((row: { id: string; createdAt: Date; userId: string | null; action: string; resource: string; resourceId: string | null; metadata: unknown }) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        userId: row.userId,
        action: row.action,
        resource: row.resource,
        resourceId: row.resourceId,
        metadata: row.metadata,
      }));
      return {
        items,
        nextCursor: hasMore && sliced.length > 0 ? sliced[sliced.length - 1]!.id : null,
      };
    }

    const filtered = this.memory
      .filter((item) => (userId ? item.userId === userId : true))
      .filter((item) => (action ? item.action === action : true))
      .filter((item) => (resource ? item.resource === resource : true))
      .filter((item) => (from ? new Date(item.at) >= from : true))
      .filter((item) => (to ? new Date(item.at) <= to : true))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id)));

    let startIndex = 0;
    if (cursor) {
      const idx = filtered.findIndex((item) => item.id === cursor);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    const page = filtered.slice(startIndex, startIndex + limit + 1);
    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? items[items.length - 1]!.id : null,
    };
  }

  private async ensureUser(userId: string): Promise<void> {
    const existing = await this.prisma!.user.findUnique({ where: { id: userId } });
    if (existing) {
      return;
    }
    await this.prisma!.user.create({
      data: {
        id: userId,
        email: `${userId}@local.portivox`,
      },
    });
  }

  async close(): Promise<void> {
    if (this.prisma && this.ownsPrisma) {
      await this.prisma.$disconnect();
    }
    await this.sink.close();
  }
}

type AuditSinkConfig = {
  jsonlPath?: string;
  webhookUrl?: string;
  webhookTimeoutMs: number;
  webhookSecret?: string;
  webhookMaxRetries: number;
  webhookRetryBaseMs: number;
  deadLetterJsonlPath?: string;
};

type AuditEvent = {
  at: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  metadata: unknown;
};

class AuditSink {
  private readonly jsonlPath: string | null;
  private readonly webhookUrl: string | null;
  private readonly webhookTimeoutMs: number;
  private readonly webhookSecret: string | null;
  private readonly webhookMaxRetries: number;
  private readonly webhookRetryBaseMs: number;
  private readonly deadLetterJsonlPath: string | null;
  private jsonlReady = false;
  private deadLetterJsonlReady = false;

  constructor(config: AuditSinkConfig) {
    this.jsonlPath = config.jsonlPath && config.jsonlPath.trim() ? config.jsonlPath.trim() : null;
    // Validate webhook URL: only https:// scheme allowed, and the target must
    // not resolve to a loopback, link-local, or RFC-1918 private address.
    const rawWebhookUrl = config.webhookUrl && config.webhookUrl.trim() ? config.webhookUrl.trim() : null;
    let validatedWebhookUrl: string | null = rawWebhookUrl;
    if (rawWebhookUrl) {
      try {
        const parsed = new URL(rawWebhookUrl);
        if (parsed.protocol !== "https:") {
          throw new Error(`Webhook URL must use https:// scheme (got ${parsed.protocol})`);
        }
        const blockedPatterns = [/^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^::1$/, /^0\.0\.0\.0$/];
        if (blockedPatterns.some((re) => re.test(parsed.hostname))) {
          throw new Error(`Webhook URL must not target a private/loopback address (${parsed.hostname})`);
        }
      } catch (err) {
        // Log to stderr without a Fastify logger (constructed before app is ready)
        process.stderr.write(`[audit-sink] Invalid AUDIT_EXPORT_WEBHOOK_URL — webhook delivery disabled: ${err instanceof Error ? err.message : String(err)}\n`);
        validatedWebhookUrl = null;
      }
    }
    this.webhookUrl = validatedWebhookUrl;
    this.webhookTimeoutMs = config.webhookTimeoutMs;
    this.webhookSecret = config.webhookSecret && config.webhookSecret.trim() ? config.webhookSecret.trim() : null;
    this.webhookMaxRetries = config.webhookMaxRetries;
    this.webhookRetryBaseMs = config.webhookRetryBaseMs;
    this.deadLetterJsonlPath = config.deadLetterJsonlPath && config.deadLetterJsonlPath.trim() ? config.deadLetterJsonlPath.trim() : null;
  }

  async emit(event: AuditEvent): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.jsonlPath) {
      tasks.push(this.writeJsonl(event));
    }
    if (this.webhookUrl) {
      tasks.push(this.postWebhookWithRetry(event));
    }
    if (tasks.length === 0) {
      return;
    }
    await Promise.allSettled(tasks);
  }

  async close(): Promise<void> {
    return;
  }

  private async ensureJsonlReady(): Promise<void> {
    if (this.jsonlReady || !this.jsonlPath) {
      return;
    }
    await mkdir(dirname(this.jsonlPath), { recursive: true });
    this.jsonlReady = true;
  }

  private async writeJsonl(event: AuditEvent): Promise<void> {
    if (!this.jsonlPath) {
      return;
    }
    await this.ensureJsonlReady();
    await appendFile(this.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async ensureDeadLetterReady(): Promise<void> {
    if (this.deadLetterJsonlReady || !this.deadLetterJsonlPath) {
      return;
    }
    await mkdir(dirname(this.deadLetterJsonlPath), { recursive: true });
    this.deadLetterJsonlReady = true;
  }

  private async writeDeadLetter(event: AuditEvent, reason: string): Promise<void> {
    if (!this.deadLetterJsonlPath) {
      return;
    }
    await this.ensureDeadLetterReady();
    await appendFile(this.deadLetterJsonlPath, `${JSON.stringify({ at: new Date().toISOString(), reason, event })}\n`, "utf8");
  }

  private async postWebhookWithRetry(event: AuditEvent): Promise<void> {
    let attempt = 0;
    while (attempt <= this.webhookMaxRetries) {
      const ok = await this.postWebhook(event);
      if (ok) {
        return;
      }
      attempt += 1;
      if (attempt > this.webhookMaxRetries) {
        await this.writeDeadLetter(event, "WEBHOOK_DELIVERY_FAILED");
        return;
      }
      const backoffMs = this.webhookRetryBaseMs * (2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  private async postWebhook(event: AuditEvent): Promise<boolean> {
    if (!this.webhookUrl) {
      return true;
    }
    const payload = JSON.stringify(event);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.webhookSecret) {
      // Use HMAC-SHA256 (not plain SHA-256) so the signature is keyed and not
      // vulnerable to length-extension attacks.
      const signature = createHmac("sha256", this.webhookSecret).update(payload).digest("hex");
      headers["x-portivox-signature"] = `sha256=${signature}`;
    }
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.webhookTimeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// TcpPortMappingStore — admin-managed local→public port mappings
// ---------------------------------------------------------------------------

type TcpPortMappingRecord = {
  id: string;
  name: string;
  localPort: number;
  publicPort: number;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

class TcpPortMappingStore {
  private readonly prisma: PrismaClient | null;
  private readonly ownsPrisma: boolean;
  /** id → record (in-memory fallback when DATABASE_URL is absent) */
  private readonly memory = new Map<string, TcpPortMappingRecord>();

  constructor(prisma?: PrismaClient | null) {
    this.prisma = prisma ?? (process.env.DATABASE_URL ? new PrismaClient() : null);
    this.ownsPrisma = !prisma && this.prisma !== null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): any { return this.prisma; }

  async findByLocalPort(localPort: number): Promise<TcpPortMappingRecord | null> {
    if (this.prisma) {
      const row = await this.db.tcpPortMapping.findFirst({ where: { localPort } });
      return row ? this.toRecord(row) : null;
    }
    for (const rec of this.memory.values()) {
      if (rec.localPort === localPort) return rec;
    }
    return null;
  }

  async list(): Promise<TcpPortMappingRecord[]> {
    if (this.prisma) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = await this.db.tcpPortMapping.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((r) => this.toRecord(r));
    }
    return [...this.memory.values()];
  }

  async create(input: Omit<TcpPortMappingRecord, "id" | "createdAt" | "updatedAt">): Promise<TcpPortMappingRecord> {
    if (this.prisma) {
      const row = await this.db.tcpPortMapping.create({ data: { ...input } });
      return this.toRecord(row);
    }
    const now = new Date().toISOString();
    const rec: TcpPortMappingRecord = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.memory.set(rec.id, rec);
    return rec;
  }

  async update(
    id: string,
    patch: { enabled?: boolean; name?: string; description?: string },
  ): Promise<TcpPortMappingRecord | null> {
    if (this.prisma) {
      try {
        const row = await this.db.tcpPortMapping.update({ where: { id }, data: { ...patch, updatedAt: new Date() } });
        return this.toRecord(row);
      } catch {
        return null;
      }
    }
    const rec = this.memory.get(id);
    if (!rec) return null;
    const updated = { ...rec, ...patch, updatedAt: new Date().toISOString() };
    this.memory.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    if (this.prisma) {
      try {
        await this.db.tcpPortMapping.delete({ where: { id } });
        return true;
      } catch {
        return false;
      }
    }
    return this.memory.delete(id);
  }

  async close(): Promise<void> {
    if (this.prisma && this.ownsPrisma) await this.prisma.$disconnect();
  }

  private toRecord(row: {
    id: string; name: string; localPort: number; publicPort: number;
    description: string | null; enabled: boolean; createdAt: Date; updatedAt: Date;
  }): TcpPortMappingRecord {
    return {
      id: row.id, name: row.name, localPort: row.localPort, publicPort: row.publicPort,
      description: row.description, enabled: row.enabled,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export type GatewayServer = {
  app: FastifyInstance;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Self-contained, theme-aware confirmation page shown when a visitor opens a
 *  tunnel access link (/l/:token). Their IP is now whitelisted, so the exposed
 *  port is reachable from their network for 24h. All values are pre-escaped. */
function renderAccessGrantedPage(args: {
  endpoint: string | null;
  openHref: string | null;
  ip: string;
  online: boolean;
  expiresLabel: string;
}): string {
  const { endpoint, openHref, ip, online, expiresLabel } = args;
  const openButton = openHref
    ? `<a class="btn" href="${openHref}" target="_blank" rel="noreferrer">Open exposed service &rarr;</a>`
    : "";
  const endpointBlock = endpoint
    ? `<div class="row"><span class="lbl">Endpoint</span><code id="ep">${endpoint}</code>
         <button class="copy" onclick="navigator.clipboard&amp;&amp;navigator.clipboard.writeText('${endpoint}')">Copy</button></div>`
    : "";
  const offlineNote = online
    ? ""
    : `<p class="warn">The tunnel client is not currently connected. The endpoint will respond once the client reconnects.</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Tunnel access granted &middot; Portivox</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#f4f5f7;color:#1c2024}
  .card{width:100%;max-width:460px;background:#fff;border:1px solid #e6e8eb;border-radius:16px;
    padding:32px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
  .check{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px;
    background:#e7f7ee;color:#12864a;font-size:30px}
  h1{font-size:20px;margin:0 0 6px;text-align:center}
  .sub{margin:0 0 22px;text-align:center;color:#60646c}
  .row{display:flex;align-items:center;gap:10px;background:#f4f5f7;border:1px solid #e6e8eb;
    border-radius:10px;padding:10px 12px;margin:10px 0}
  .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8b8d98;min-width:64px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;flex:1;word-break:break-all;color:#1c2024}
  .copy{border:1px solid #d7dbdf;background:#fff;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;color:#1c2024}
  .btn{display:block;text-align:center;margin-top:18px;background:#5b5bd6;color:#fff;text-decoration:none;
    padding:12px 16px;border-radius:10px;font-weight:600}
  .btn:hover{background:#5151cd}
  .meta{margin-top:18px;font-size:12.5px;color:#8b8d98;text-align:center}
  .warn{margin:14px 0 0;font-size:13px;color:#9a6700;background:#fff8e6;border:1px solid #ffe8a3;
    border-radius:10px;padding:10px 12px}
  @media(prefers-color-scheme:dark){
    body{background:#0f1012;color:#eceef0}
    .card{background:#17181a;border-color:#2a2c30;box-shadow:none}
    .row{background:#1f2023;border-color:#2a2c30}code{color:#eceef0}
    .copy{background:#1f2023;border-color:#3a3d42;color:#eceef0}
    .check{background:#0f2e1f;color:#3dd68c}
    .warn{color:#f5d78a;background:#2a2410;border-color:#4a3f16}
  }
</style></head><body>
  <main class="card">
    <div class="check">&#10003;</div>
    <h1>Access granted</h1>
    <p class="sub">This device can now reach the tunnel. The connection is open for the next 24 hours.</p>
    ${endpointBlock}
    ${openButton}
    ${offlineNote}
    <p class="meta">Whitelisted IP: <code style="font-size:12px">${ip}</code><br>Expires: ${expiresLabel}</p>
  </main>
</body></html>`;
}

export function createGatewayServer(config: GatewayRuntimeConfig): GatewayServer {
  // trustProxy: true tells Fastify to read req.ip from the X-Forwarded-For /
  // X-Real-IP headers set by nginx.  Without this, req.ip resolves to the
  // nginx container's internal Docker IP (172.22.x.x) instead of the real
  // client IP — which breaks TCP IP-protection whitelist comparisons because
  // the whitelisted IP never matches the actual conn.remoteAddress.
  // trustProxy: 1 — trust exactly ONE upstream proxy hop (nginx).
  // This correctly resolves req.ip from X-Forwarded-For while preventing
  // IP spoofing by clients who send a fake X-Forwarded-For header.
  // (trustProxy: true would trust ALL hops and allow spoofing.)
  const app = Fastify({ logger: true, trustProxy: 1 });
  void app.register(swagger, {
    openapi: buildOpenApiDocument((config.gatewayPublicBaseUrl ?? "").trim() || `http://${config.rootDomain}:${config.gatewayPort}`),
  });
  void app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });
  const metrics = new GatewayMetrics();
  const sharedPrisma = process.env.DATABASE_URL ? new PrismaClient() : null;
  const gatewayNodeId = config.nodeId ?? `gateway-${randomUUID()}`;
  const registry = new TunnelRegistry({
    backend: config.registryBackend ?? "memory",
    redisUrl: config.redisUrl,
    redisKeyPrefix: config.redisKeyPrefix,
    leaseTtlMs: config.registryLeaseTtlMs ?? 30_000,
    nodeId: gatewayNodeId,
    onLeaseLost: ({ subdomain }) => {
      metrics.increment("gateway_registry_lease_lost_total");
      app.log.warn({ subdomain, nodeId: gatewayNodeId }, "tunnel lease lost; closing local session");
      metrics.setGauge("gateway_active_tunnels", registry.count());
      publishLiveEvent("tunnels_changed", ownershipBySubdomain.get(subdomain) ?? null);
      publishLiveEvent("gateway_status_changed");
    },
    onStaleSessionEvicted: ({ subdomain, idleMs }) => {
      metrics.increment("gateway_registry_stale_evictions_total");
      app.log.warn({ subdomain, idleMs, nodeId: gatewayNodeId }, "stale tunnel session evicted");
      metrics.setGauge("gateway_active_tunnels", registry.count());
      publishLiveEvent("tunnels_changed", ownershipBySubdomain.get(subdomain) ?? null);
      publishLiveEvent("gateway_status_changed");
    },
  });
  const store = new TunnelStore(sharedPrisma);
  const authStore = new AuthStore(sharedPrisma);
  const userAuthStore = new UserAuthStore(sharedPrisma);
  const tcpPortMappingStore = new TcpPortMappingStore(sharedPrisma);
  const auditStore = new AuditStore(new AuditSink({
    jsonlPath: config.auditExportJsonlPath,
    webhookUrl: config.auditExportWebhookUrl,
    webhookTimeoutMs: config.auditExportWebhookTimeoutMs ?? 3000,
    webhookSecret: config.auditExportWebhookSecret,
    webhookMaxRetries: config.auditExportWebhookMaxRetries ?? 3,
    webhookRetryBaseMs: config.auditExportWebhookRetryBaseMs ?? 250,
    deadLetterJsonlPath: config.auditExportDeadLetterJsonlPath,
  }), sharedPrisma, {
    onLogged: () => publishLiveEvent("audit_changed"),
  });
  const deviceStore = new DeviceStore(sharedPrisma);
  const usage = new UsageMeter();
  const meteringSince = Date.now();
  const parsedApiKeys = parseApiKeys(config.authApiKeys);
  const staticApiKeyScopes = parseScopes(config.authApiKeyScopes, ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"]);
  // Emails provisioned as platform admins (case-insensitive). See ADMIN_EMAILS.
  const adminEmailSet = new Set(
    (config.adminEmails ?? "")
      .split(",")
      .map((email: string) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const isAdminEmail = (email: string): boolean => adminEmailSet.has(email.trim().toLowerCase());
  // Platform admins are granted admin scopes in addition to the default user scopes.
  const ADMIN_SCOPES = ["admin:read", "admin:write"] as const;

  // WebSocket send-buffer watermarks for TCP relay backpressure. When a tunnel
  // client drains slower than the public peer produces, ws.bufferedAmount grows
  // in gateway heap; pause the source socket above HIGH and resume below LOW.
  const WS_BACKPRESSURE_HIGH_WATER_BYTES = 8 * 1024 * 1024;
  const WS_BACKPRESSURE_LOW_WATER_BYTES = 1 * 1024 * 1024;

  const wsHttpServer = createServer();
  const wsServer = new WebSocketServer({
    noServer: true,
    // Cap individual frame size at 64 MiB — prevents a single malformed frame
    // from allocating the full ws-library default of 100 MiB per connection.
    maxPayload: 64 * 1024 * 1024,
    // Enable per-message deflate (zlib) compression.
    // Tunnel wire messages are JSON wrappers around base64 bodies — they compress
    // well for text content (HTML, JS, CSS, API JSON). Threshold of 512 bytes
    // avoids overhead on small heartbeat/control frames.
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6 },   // balanced CPU vs ratio (zlib default)
      zlibInflateOptions: { chunkSize: 16 * 1024 },
      clientNoContextTakeover: true,       // memory-efficient: reset context per message
      serverNoContextTakeover: true,
      threshold: 512,                      // only compress frames > 512 bytes
    },
  });
  const apiReadLimiter = new RateLimiter(config.apiRateLimitReadPerMin ?? 600, 60_000);
  const apiWriteLimiter = new RateLimiter(config.apiRateLimitWritePerMin ?? 300, 60_000);
  const apiAdminLimiter = new RateLimiter(config.apiRateLimitAdminPerMin ?? 120, 60_000);
  const tunnelIngressLimiter = new RateLimiter(config.ingressRateLimitPerMin ?? 1200, 60_000);
  const responseWaiters = new Map<string, (value: HttpResponse) => void>();
  // Parallel to responseWaiters: lets the (re-armable) idle timer reject a stream
  // from outside the promise executor. Always deleted alongside its waiter.
  const streamRejecters = new Map<string, (error: Error) => void>();
  const streamTimeouts = new Map<string, NodeJS.Timeout>();
  const responseChunksByStream = new Map<string, {
    statusCode: number;
    headers: HttpResponse["headers"];
    chunks: Map<number, Buffer>;
    total?: number;
    finalIndex?: number;
    meta?: HttpResponse["meta"];
  }>();
  const chunkDiagnostics = {
    chunkFramesReceived: 0,
    chunkStreamsReassembled: 0,
    chunkIncompleteTimeouts: 0,
  };

  // (Re)arm the per-stream idle timeout. Called when the request is dispatched
  // and again on every chunk received, so a healthy but slow chunked response
  // is not killed mid-transfer — the timer fires only after genuine inactivity.
  const armStreamIdleTimeout = (streamId: string, socket: WebSocket): void => {
    const prev = streamTimeouts.get(streamId);
    if (prev) {
      clearTimeout(prev);
    }
    const timeout = setTimeout(() => {
      if (!responseWaiters.has(streamId)) {
        return;
      }
      if (responseChunksByStream.has(streamId)) {
        chunkDiagnostics.chunkIncompleteTimeouts += 1;
        metrics.increment("gateway_chunk_incomplete_timeouts_total");
        void auditStore.log(null, "chunk_stream_timeout", "tunnel_stream", streamId, {
          errorCode: "TUNNEL_STREAM_IDLE_TIMEOUT",
        });
      }
      const reject = streamRejecters.get(streamId);
      responseWaiters.delete(streamId);
      streamRejecters.delete(streamId);
      activeStreamsBySocket.get(socket)?.delete(streamId);
      streamTimeouts.delete(streamId);
      responseChunksByStream.delete(streamId);
      reject?.(new Error("TUNNEL_STREAM_IDLE_TIMEOUT"));
    }, config.streamIdleTimeoutMs ?? config.tunnelResponseTimeoutMs);
    streamTimeouts.set(streamId, timeout);
  };
  const socketSubdomain = new WeakMap<object, string>();
  const activeStreamsBySocket = new WeakMap<object, Set<string>>();
  // tunnelKey → live control socket. Unlike the registry (which only tracks
  // subdomain-routed HTTP/random-TCP tunnels), this also covers fixed-port TCP
  // tunnels keyed by their synthetic `__tcp_port_<n>__` key, so they can be
  // revoked from the web panel.
  const socketByTunnelKey = new Map<string, WebSocket>();
  // Live control sockets grouped by the (hashed) API key that authenticated
  // them, so revoking a key can immediately disconnect its devices.
  const socketsByApiKeyHash = new Map<string, Set<WebSocket>>();
  // Live control sockets grouped by client-reported deviceId, so the console can
  // show device online status and disconnect a device on demand.
  const socketsByDeviceId = new Map<string, Set<WebSocket>>();
  const tcpBindingsBySubdomain = new Map<string, { server: net.Server; publicPort: number }>();
  const tcpConnectionsById = new Map<string, net.Socket>();
  const tcpConnectionsBySocket = new WeakMap<object, Set<string>>();
  const usedTcpPorts = new Set<number>();
  const reservedTcpPorts = new Set<number>();

  // ── Traffic Inspector ─────────────────────────────────────────────────────
  // Keyed by subdomain → ring buffer of the most recent captured requests.
  const capturedRequests = new Map<string, CapturedRequest[]>();
  const MAX_INSPECT_PER_TUNNEL = 200;
  const MAX_INSPECT_BODY_BYTES = 64 * 1024; // 64 KB body capture limit

  // ── IP Link Protection ──────────────────────────────────────────────────────
  // Keyed by the random accessToken. Each entry tracks which IPs have been
  // whitelisted via a /l/:token click (with 24-hour per-IP TTL).
  const ipAccessByToken = new Map<string, IpAccessEntry>();
  // Reverse map: tunnelKey → accessToken (used during cleanup on disconnect).
  const ipTokenByTunnelKey = new Map<string, string>();

  // ── Stable Redirect URLs ─────────────────────────────────────────────────────
  // Keyed by the redirectToken. Entries persist across reconnects so that the
  // /r/:token URL remains stable even while the tunnel is briefly offline.
  const redirectByToken = new Map<string, RedirectEntry>();
  // Reverse map: tunnelKey → redirectToken (used during cleanup and reconnect).
  const redirectTokenByTunnelKey = new Map<string, string>();

  // Per-IP rate limiter for new TCP connections — defends fixed public ports
  // against brute-force scanners.
  const tcpConnLimiter = new RateLimiter(config.tcpConnectionRateLimit ?? 10, 60_000);

  const ownershipBySubdomain = new Map<string, string>();
  const liveSubscribers = new Map<string, LiveSubscriber>();
  let isReady = false;
  let isDraining = false;
  let maintenanceMode = config.maintenanceMode ?? false;
  metrics.setGauge("gateway_active_tunnels", registry.count());
  metrics.setGauge("gateway_draining_state", 0);
  metrics.setGauge("gateway_maintenance_mode_state", maintenanceMode ? 1 : 0);
  const apiVersion = (config.apiVersion ?? "1").trim() || "1";
  const apiDeprecationEnabled = config.apiDeprecationEnabled ?? false;
  const apiSunsetDate = (config.apiSunsetDate ?? "").trim();
  const corsAllowedOrigins = (config.corsAllowedOrigins ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const corsAllowCredentials = config.corsAllowCredentials ?? false;
  const securityHeadersEnabled = config.securityHeadersEnabled ?? true;
  const idempotencyEnabled = config.idempotencyEnabled ?? true;
  const idempotencyTtlMs = config.idempotencyTtlMs ?? 300_000;
  const idempotencyStore = new Map<string, IdempotencyReplay>();

  // Periodically evict expired idempotency entries to prevent unbounded memory growth.
  // Lazy deletion inside readIdempotencyReplay only removes entries that are actually
  // looked up; this sweep catches entries that are never retried.
  const idempotencySweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of idempotencyStore) {
      if (now - v.storedAt > idempotencyTtlMs) idempotencyStore.delete(k);
    }
  }, idempotencyTtlMs);
  idempotencySweep.unref();

  // Periodically evict redirect entries that have been disconnected for > 24h
  // so stale stable-URL records don't accumulate unboundedly.
  const redirectSweep = setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [token, entry] of redirectByToken) {
      if (!entry.connected && (entry.disconnectedAt ?? 0) < cutoff) {
        redirectByToken.delete(token);
        redirectTokenByTunnelKey.delete(entry.tunnelKey);
      }
    }
  }, 60 * 60 * 1000);  // run every hour
  redirectSweep.unref();

  const registrySweep = setInterval(() => {
    const evicted = registry.sweepStaleSockets();
    if (evicted > 0) {
      app.log.warn({ evicted }, "evicted stale tunnel session(s)");
      metrics.setGauge("gateway_active_tunnels", registry.count());
    }
  }, Math.max(5_000, (config.registryLeaseTtlMs ?? 30_000)));
  registrySweep.unref();

  function gatewayState(): {
    nodeId: string;
    registryBackend: "memory" | "redis";
    ready: boolean;
    draining: boolean;
    maintenanceMode: boolean;
    drainComplete: boolean;
    canAcceptConnections: boolean;
    activeTunnels: number;
  } {
    const activeTunnels = registry.count();
    return {
      nodeId: gatewayNodeId,
      registryBackend: config.registryBackend ?? "memory",
      ready: isReady && !isDraining && !maintenanceMode,
      draining: isDraining,
      maintenanceMode,
      drainComplete: isDraining && activeTunnels === 0,
      canAcceptConnections: !isDraining && !maintenanceMode,
      activeTunnels,
    };
  }

  function sendJsonResponse(
    res: ServerResponse<IncomingMessage>,
    statusCode: number,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    if (res.writableEnded) {
      return;
    }
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        res.setHeader(key, value);
      }
    }
    res.end(JSON.stringify(body));
  }

  async function handleAuthValidateHttp(headers: IncomingHttpHeaders): Promise<{
    statusCode: number;
    body: unknown;
    responseHeaders?: Record<string, string>;
  }> {
    const endpoint = "/api/auth/validate";
    const apiKeyHeader = headers["x-api-key"];
    const bearerHeader = headers.authorization;
    const hasPresentedCredential =
      (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) ||
      (Array.isArray(apiKeyHeader) && apiKeyHeader.some((value) => typeof value === "string" && value.trim().length > 0)) ||
      (typeof bearerHeader === "string" && bearerHeader.trim().length > 0);

    const principal = await resolvePrincipal(headers as Record<string, unknown>);
    if (!principal || (!hasPresentedCredential && config.authRequired) || (principal.authType === "anonymous" && config.authRequired)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return {
        statusCode: 401,
        body: { error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } },
      };
    }

    const apiLimit = apiReadLimiter.take(`api:read:auth_validate:${principal.userId}`);
    const resetSeconds = Math.max(1, Math.ceil(apiLimit.retryAfterMs / 1000));
    const responseHeaders: Record<string, string> = {
      "ratelimit-limit": String(apiLimit.limit),
      "ratelimit-remaining": String(apiLimit.remaining),
      "ratelimit-reset": String(resetSeconds),
      "x-ratelimit-limit": String(apiLimit.limit),
      "x-ratelimit-remaining": String(apiLimit.remaining),
      "x-ratelimit-reset": String(resetSeconds),
    };
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      responseHeaders["retry-after"] = String(Math.ceil(apiLimit.retryAfterMs / 1000));
      return {
        statusCode: 429,
        responseHeaders,
        body: { error: { code: "RATE_LIMITED", message: "API request limit exceeded" } },
      };
    }

    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return {
      statusCode: 200,
      responseHeaders,
      body: {
        ok: true,
        principal: {
          userId: principal.userId,
          authType: principal.authType,
          role: principal.role,
          scopes: principal.scopes,
        },
      },
    };
  }

  if (wsHttpServer) {
    wsHttpServer.on("request", (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
          if (req.method === "GET" && url.pathname === "/readyz") {
            const state = gatewayState();
            sendJsonResponse(res, state.ready ? 200 : 503, state);
            return;
          }
          if (req.method === "GET" && url.pathname === "/api/auth/validate") {
            const result = await handleAuthValidateHttp(req.headers);
            sendJsonResponse(res, result.statusCode, result.body, result.responseHeaders);
            return;
          }
          if (url.pathname !== "/connect") {
            sendJsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
          }
        } catch (error) {
          app.log.error({ err: error }, "ws http sidecar request failed");
          sendJsonResponse(res, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
        }
      })();
    });
    wsHttpServer.on("upgrade", (req, socket, head) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        if (url.pathname !== "/connect") {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wsServer.handleUpgrade(req, socket, head, (client) => {
          wsServer.emit("connection", client, req);
        });
      } catch {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
  }

  function canReceiveLiveEvent(principal: Principal, event: LiveEvent): boolean {
    if (event.kind === "connected") {
      return true;
    }
    if (event.kind === "gateway_status_changed") {
      return true;
    }
    if (event.kind === "tunnels_changed") {
      if (!hasScope(principal.scopes, "tunnel:read")) {
        return false;
      }
      if (!event.userId) {
        return true;
      }
      return principal.userId === event.userId || isAdminRole(principal.role);
    }
    if (event.kind === "api_keys_changed" || event.kind === "devices_changed") {
      if (!isAdminRole(principal.role) || !hasScope(principal.scopes, "key:manage")) {
        return false;
      }
      if (!event.userId) {
        return true;
      }
      return principal.userId === event.userId || principal.authType === "anonymous";
    }
    if (event.kind === "audit_changed" || event.kind === "tcp_mappings_changed" || event.kind === "users_changed") {
      return isPlatformAdmin(principal.role) && hasScope(principal.scopes, "key:manage");
    }
    if (event.kind === "inspector_changed") {
      if (!hasScope(principal.scopes, "tunnel:read")) {
        return false;
      }
      if (!event.userId) {
        return true;
      }
      return principal.userId === event.userId || isAdminRole(principal.role);
    }
    return false;
  }

  function publishLiveEvent(kind: LiveEventKind, userId?: string | null, subdomain?: string | null): void {
    const event: LiveEvent = {
      kind,
      at: new Date().toISOString(),
      userId: userId ?? null,
      subdomain: subdomain ?? null,
    };
    for (const subscriber of liveSubscribers.values()) {
      if (!canReceiveLiveEvent(subscriber.principal, event)) {
        continue;
      }
      try {
        subscriber.write(event);
      } catch {
        subscriber.close();
      }
    }
  }

  function applyOperationalState(next: { draining?: boolean; maintenanceMode?: boolean }, source: string): void {
    let changed = false;
    if (typeof next.maintenanceMode === "boolean" && next.maintenanceMode !== maintenanceMode) {
      maintenanceMode = next.maintenanceMode;
      metrics.setGauge("gateway_maintenance_mode_state", maintenanceMode ? 1 : 0);
      metrics.increment("gateway_drain_state_transitions_total");
      changed = true;
    }
    if (typeof next.draining === "boolean" && next.draining !== isDraining) {
      isDraining = next.draining;
      metrics.setGauge("gateway_draining_state", isDraining ? 1 : 0);
      metrics.increment("gateway_drain_state_transitions_total");
      changed = true;
    }
    isReady = !maintenanceMode && !isDraining;
    if (changed) {
      const state = gatewayState();
      app.log.info({ source, ...state }, "gateway operational state changed");
      publishLiveEvent("gateway_status_changed");
    }
  }

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS" && req.url.startsWith("/api/")) {
      const originHeader = req.headers.origin ? String(req.headers.origin) : "";
      if (corsAllowedOrigins.length > 0 && originHeader && corsAllowedOrigins.includes(originHeader)) {
        reply.header("access-control-allow-origin", originHeader);
        if (corsAllowCredentials) {
          reply.header("access-control-allow-credentials", "true");
        }
      } else if (corsAllowedOrigins.length === 0) {
        reply.header("access-control-allow-origin", "*");
      }
      reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "content-type,authorization,x-api-key,x-api-version");
      return reply.status(204).send();
    }
    if (!req.url.startsWith("/api/")) {
      return;
    }
    const requestedVersionHeader = req.headers["x-api-version"];
    const requestedVersion = Array.isArray(requestedVersionHeader)
      ? String(requestedVersionHeader[0])
      : requestedVersionHeader
        ? String(requestedVersionHeader)
        : "";
    if (requestedVersion && requestedVersion !== apiVersion) {
      return reply.status(400).send({
        error: {
          code: "UNSUPPORTED_API_VERSION",
          message: `Requested API version '${requestedVersion}' is not supported; supported version is '${apiVersion}'`,
        },
      });
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    // Tunnel proxy responses are served on subdomains (demo.portivox.example.com).
    // The gateway's own routes live on the root domain (no subdomain).
    // We must NOT inject gateway-level security headers onto tunnel responses:
    //   - CSP "default-src 'none'" would block every JS/CSS/image/font in the tunneled app
    //   - x-frame-options DENY would prevent the app from using iframes
    // The tunneled app's own headers (its own CSP, framing policy) are passed through instead.
    const isTunnelProxy = extractSubdomain(req.headers.host as string | undefined, config.rootDomain) !== null;
    if (securityHeadersEnabled && !isTunnelProxy) {
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-xss-protection", "0");
      reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    }

    if (req.url.startsWith("/api/")) {
      const originHeader = req.headers.origin ? String(req.headers.origin) : "";
      if (corsAllowedOrigins.length > 0 && originHeader && corsAllowedOrigins.includes(originHeader)) {
        reply.header("access-control-allow-origin", originHeader);
        reply.header("vary", "Origin");
        if (corsAllowCredentials) {
          reply.header("access-control-allow-credentials", "true");
        }
      } else if (corsAllowedOrigins.length === 0) {
        reply.header("access-control-allow-origin", "*");
      }
    }

    if (req.url.startsWith("/api/")) {
      reply.header("x-api-version", apiVersion);
      if (apiDeprecationEnabled) {
        reply.header("deprecation", "true");
        if (apiSunsetDate) {
          reply.header("sunset", apiSunsetDate);
        }
      }
    }
    return payload;
  });

  // Headers that tunnel operators must never override on gateway subdomain responses.
  //
  // HSTS is the only header blocked unconditionally: a tunnel returning
  // "Strict-Transport-Security: max-age=…; includeSubDomains" would pin HTTPS for
  // the ENTIRE root-domain tree for all future visitors — a cross-tenant attack vector.
  //
  // Everything else (CORS, CSP, set-cookie, framing, referrer…) is intentionally
  // passed through so that tunneled apps work correctly in the browser:
  //   - CORS headers are per-origin and do not bleed across subdomains.
  //   - set-cookie without an explicit Domain= attribute is scoped to the subdomain.
  //   - The app's own CSP/framing headers should reach the browser unchanged.
  const BLOCKED_RESPONSE_HEADERS = new Set([
    "strict-transport-security",
  ]);

  // Default scopes granted to newly registered users and JWT fallback.
  const DEFAULT_USER_SCOPES = ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"] as const;

  function createGatewayError(message: string, code?: string): string {
    return encodeWireMessage({ type: "error", message, code });
  }

  function hashApiKey(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  function hashPassword(plaintext: string): string {
    const salt = randomBytes(16).toString("hex");
    const digest = scryptSync(plaintext, salt, 64).toString("hex");
    return `${salt}:${digest}`;
  }

  function verifyPassword(plaintext: string, passwordHash: string): boolean {
    const [salt, digest] = passwordHash.split(":");
    if (!salt || !digest) {
      return false;
    }
    const expected = Buffer.from(digest, "hex");
    const actual = scryptSync(plaintext, salt, expected.length);
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  async function resolvePrincipal(headers: Record<string, unknown>): Promise<Principal | null> {
    // Always try explicit credentials first, regardless of AUTH_REQUIRED.
    // This allows registered users to authenticate (e.g. change-password) even in dev mode.

    const apiKeyHeader = headers["x-api-key"];
    const apiKey = Array.isArray(apiKeyHeader) ? String(apiKeyHeader[0]) : apiKeyHeader ? String(apiKeyHeader) : undefined;
    if (validateApiKey(parsedApiKeys, apiKey)) {
      return { userId: `apikey_${hashApiKey(apiKey!).slice(0, 12)}`, authType: "api_key", apiKey, scopes: staticApiKeyScopes, role: "admin" };
    }
    if (apiKey) {
      const owned = await authStore.validateApiKey(hashApiKey(apiKey));
      if (owned) {
        // User-minted API keys carry the "owner" role, never "admin". Platform
        // administration is intentionally unreachable via a self-service key —
        // otherwise any user with key:manage could mint themselves admin access.
        // Operators who need admin-over-API use a static AUTH_API_KEYS key above.
        return { userId: owned.userId, authType: "api_key", apiKey, scopes: owned.scopes, role: "owner" };
      }
    }

    const authHeader = headers.authorization;
    const token = readBearerToken(Array.isArray(authHeader) ? String(authHeader[0]) : authHeader ? String(authHeader) : undefined);
    if (token && config.authJwtSecret) {
      try {
        const payload = verifyAccessToken(token, config.authJwtSecret) as { sub?: string; scopes?: string[] | string; role?: string };
        if (payload && typeof payload.sub === "string" && payload.sub.trim()) {
          const tokenScopes = Array.isArray(payload.scopes)
            ? payload.scopes
            : typeof payload.scopes === "string"
              ? parseScopes(payload.scopes, [])
              : [...DEFAULT_USER_SCOPES];
          const role = payload.role === "viewer" || payload.role === "owner" || payload.role === "admin" ? payload.role : "owner";
          return { userId: payload.sub, authType: "jwt", scopes: tokenScopes, role };
        }
      } catch {
        // Invalid/expired token — when auth is required this is a hard failure;
        // in dev mode fall through to anonymous.
        if (config.authRequired) return null;
      }
    }

    // Fall back to anonymous when auth is not required and no valid credentials were provided.
    // In dev mode (authRequired === false) the anonymous principal is a full superuser so all
    // endpoints are accessible without credentials.  This code path is never reached in production
    // because authRequired is always true there and the function returns null above instead.
    if (!config.authRequired) {
      return {
        userId: "anonymous",
        authType: "anonymous",
        scopes: ["tunnel:create", "tunnel:read", "tunnel:delete", "tunnel:tcp", "key:manage", "admin:read", "admin:write"],
        role: "admin",
      };
    }

    return null;
  }

  // Owner-level authority: the principal may act on *their own* resources
  // (their API keys, their tunnels' inspector data). Both "owner" and "admin"
  // qualify. This is NOT sufficient for platform-wide administration.
  function isAdminRole(role: Principal["role"]): boolean {
    return role === "admin" || role === "owner";
  }

  // Platform-admin authority: cross-tenant / gateway-wide operations
  // (maintenance & drain state, listing every tenant's tunnels, reading the
  // full audit log, TCP port mappings). ONLY the dedicated "admin" role
  // qualifies — a self-registered "owner" must never reach these. Admins are
  // provisioned out-of-band via ADMIN_EMAILS or a static AUTH_API_KEYS key.
  function isPlatformAdmin(role: Principal["role"]): boolean {
    return role === "admin";
  }

  // Subdomain access is a per-user subscription entitlement. Resolved LIVE from
  // the user record (not from the JWT, whose scopes are frozen for 7 days) so an
  // admin toggle takes effect on the next tunnel open. Platform admins always
  // qualify; in dev mode (authRequired === false) everyone qualifies.
  async function isSubdomainAllowed(principal: Principal): Promise<boolean> {
    if (config.authRequired === false) return true;
    if (isPlatformAdmin(principal.role)) return true;
    try {
      const user = await userAuthStore.findById(principal.userId);
      return user?.subdomainEnabled === true;
    } catch {
      return false;
    }
  }

  function filterHopByHopHeaders<T extends Record<string, unknown>>(headers: T): T {
    const blocked = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!blocked.has(key.toLowerCase())) {
        next[key] = value;
      }
    }
    return next as T;
  }

  function applyRateLimitHeaders(
    reply: { header: (name: string, value: string | number) => unknown },
    limitState: { limit: number; remaining: number; retryAfterMs: number },
  ): void {
    const resetSeconds = Math.max(1, Math.ceil(limitState.retryAfterMs / 1000));
    reply.header("ratelimit-limit", limitState.limit);
    reply.header("ratelimit-remaining", limitState.remaining);
    reply.header("ratelimit-reset", resetSeconds);
    reply.header("x-ratelimit-limit", limitState.limit);
    reply.header("x-ratelimit-remaining", limitState.remaining);
    reply.header("x-ratelimit-reset", resetSeconds);
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function hasOnlyAllowedKeys(body: Record<string, unknown>, allowedKeys: string[]): boolean {
    const allowed = new Set(allowedKeys);
    return Object.keys(body).every((key) => allowed.has(key));
  }

  /** Builds a public-facing URL using GATEWAY_PUBLIC_BASE_URL or falls back to
   *  https://<rootDomain> for non-local domains, http:// for localhost/loopback.
   *  Used for access links and redirect URLs. */
  function buildPublicUrl(path: string): string {
    const base = (config.gatewayPublicBaseUrl ?? "").trim();
    if (base) return `${base}${path}`;
    // Auto-detect scheme: use http only for local/loopback/private-range addresses.
    const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|::1)(:\d+)?$/.test(config.rootDomain);
    return `${isLocal ? "http" : "https"}://${config.rootDomain}${path}`;
  }

  function isPortInRange(port: number): boolean {
    const start = config.tcpPublicPortStart ?? 19000;
    const end = config.tcpPublicPortEnd ?? 19999;
    return Number.isInteger(port) && port >= start && port <= end;
  }

  function allocateTcpPort(): number | null {
    const start = config.tcpPublicPortStart ?? 19000;
    const end = config.tcpPublicPortEnd ?? 19999;
    for (let port = start; port <= end; port += 1) {
      if (!usedTcpPorts.has(port) && !reservedTcpPorts.has(port)) {
        return port;
      }
    }
    return null;
  }

  function resolveTcpPublicHost(): string {
    const host = (config.tcpPublicHost ?? "").trim();
    return host || config.rootDomain;
  }

  async function bindHttpPortTunnel(key: string): Promise<{ publicPort: number; publicHost: string }> {
    if (tcpBindingsBySubdomain.has(key)) {
      const existing = tcpBindingsBySubdomain.get(key)!;
      return { publicPort: existing.publicPort, publicHost: resolveTcpPublicHost() };
    }

    const port = allocateTcpPort();
    if (port === null) {
      throw new Error("HTTP_PORT_EXHAUSTED");
    }
    if (usedTcpPorts.has(port) || reservedTcpPorts.has(port)) {
      throw new Error("HTTP_PORT_BUSY");
    }
    reservedTcpPorts.add(port);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const payload = await readRequestBody(req, config.maxRequestBodyBytes);
        const injected = await app.inject({
          method: (req.method ?? "GET") as "GET",
          url: req.url ?? "/",
          headers: {
            ...req.headers,
            host: `${key}.${config.rootDomain}`,
            "x-forwarded-host": `${resolveTcpPublicHost()}:${port}`,
            "x-forwarded-proto": "http",
          },
          payload,
        });
        res.statusCode = injected.statusCode;
        for (const [header, value] of Object.entries(injected.headers)) {
          if (typeof value !== "undefined" && !BLOCKED_RESPONSE_HEADERS.has(header.toLowerCase())) {
            res.setHeader(header, value as string | string[] | number);
          }
        }
        res.end(injected.payload);
      } catch {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "HTTP_PORT_TUNNEL_FAILED", message: "Failed to proxy public port tunnel" } }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reservedTcpPorts.delete(port);
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, config.tcpTunnelBindHost ?? "0.0.0.0", () => {
        server.off("error", onError);
        reservedTcpPorts.delete(port);
        resolve();
      });
    });

    tcpBindingsBySubdomain.set(key, { server: server as unknown as net.Server, publicPort: port });
    usedTcpPorts.add(port);
    return { publicPort: port, publicHost: resolveTcpPublicHost() };
  }

  async function bindTcpTunnel(
    key: string,
    socket: WebSocket,
    /** When provided, binds to this exact port instead of allocating from the pool. */
    fixedPort?: number,
    /** When provided, incoming TCP connections must have their IP whitelisted in
     *  ipAccessByToken[accessToken] before being forwarded to the tunnel client. */
    accessToken?: string,
    /** Owning user id for usage metering (falls back to ownershipBySubdomain). */
    ownerUserId?: string | null,
  ): Promise<{ publicPort: number; publicHost: string }> {
    if (!(config.tcpTunnelEnabled ?? true)) {
      throw new Error("TCP_TUNNEL_DISABLED");
    }
    const usageOwnerId = ownerUserId ?? ownershipBySubdomain.get(key) ?? null;
    if (tcpBindingsBySubdomain.has(key)) {
      const existing = tcpBindingsBySubdomain.get(key)!;
      return { publicPort: existing.publicPort, publicHost: resolveTcpPublicHost() };
    }

    // Fixed-port tunnels bypass the random pool; dynamic tunnels must be in range.
    const port = fixedPort ?? allocateTcpPort();
    if (port === null) {
      throw new Error("TCP_PORT_EXHAUSTED");
    }
    if (usedTcpPorts.has(port) || reservedTcpPorts.has(port)) {
      throw new Error("TCP_PORT_BUSY");
    }
    reservedTcpPorts.add(port);

    // Reuse the socket's existing connection set if it already owns TCP tunnels.
    // Overwriting with a fresh Set would orphan connections from an earlier
    // binding on the same socket (their tcp_data would be dropped and their
    // sockets leaked, since close-cleanup only iterates the surviving set).
    const connectionIds = tcpConnectionsBySocket.get(socket) ?? new Set<string>();
    tcpConnectionsBySocket.set(socket, connectionIds);

    const server = net.createServer((conn) => {
      // Disable Nagle's algorithm so each TCP segment is flushed immediately.
      // Critical for interactive protocols (SSH, RDP): without this, tiny
      // writes are buffered waiting for an ACK, adding ~200 ms latency per
      // keystroke.
      conn.setNoDelay(true);

      // Normalize IPv4-mapped IPv6 addresses (::ffff:1.2.3.4 → 1.2.3.4)
      const remoteIp = (conn.remoteAddress ?? "").replace(/^::ffff:/, "");

      // Brute-force protection: rate-limit new connections per source IP.
      if (!tcpConnLimiter.take(`tcp_conn:${remoteIp}`).allowed) {
        conn.destroy();
        return;
      }

      // IP link protection: reject unless the caller's IP has been whitelisted
      // by a recent click on the access link (/l/:token).
      if (accessToken) {
        const ipEntry = ipAccessByToken.get(accessToken);
        const allowedUntil = ipEntry?.allowedIps.get(remoteIp) ?? 0;
        if (Date.now() > allowedUntil) {
          conn.destroy();
          return;
        }
      }

      const connectionId = randomUUID();
      tcpConnectionsById.set(connectionId, conn);
      connectionIds.add(connectionId);
      // Single backpressure resume timer per connection (guards against
      // spawning overlapping intervals when multiple buffered data events fire
      // after conn.pause()).
      let resumeTimer: NodeJS.Timeout | null = null;

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeWireMessage({ type: "tcp_open", connectionId }));
      } else {
        conn.destroy();
        return;
      }

      conn.on("data", (chunk) => {
        if (socket.readyState !== WebSocket.OPEN) {
          conn.destroy();
          return;
        }
        socket.send(encodeWireMessage({
          type: "tcp_data",
          connectionId,
          dataBase64: Buffer.from(chunk).toString("base64"),
        }));
        // Usage metering: bytes flowing out to the public peer.
        usage.recordBytes(usageOwnerId, 0, chunk.length);
        // Backpressure: if the tunnel client is draining slower than this public
        // peer produces, ws.bufferedAmount backs up in gateway heap. Pause the
        // source until the buffer drains, then resume — bounding memory use.
        // Only one resume timer runs at a time (resumeTimer guard).
        if (socket.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER_BYTES && !resumeTimer) {
          conn.pause();
          resumeTimer = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN || conn.destroyed) {
              if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
              if (!conn.destroyed) conn.destroy();
              return;
            }
            if (socket.bufferedAmount <= WS_BACKPRESSURE_LOW_WATER_BYTES) {
              if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
              conn.resume();
            }
          }, 25);
          if (typeof resumeTimer.unref === "function") resumeTimer.unref();
        }
      });

      const closeConnection = (reason?: string): void => {
        if (resumeTimer) {
          clearInterval(resumeTimer);
          resumeTimer = null;
        }
        if (!tcpConnectionsById.has(connectionId)) {
          return;
        }
        tcpConnectionsById.delete(connectionId);
        connectionIds.delete(connectionId);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeWireMessage({ type: "tcp_close", connectionId, reason }));
        }
      };

      conn.on("error", (error) => {
        closeConnection(error.message);
      });
      conn.on("close", () => {
        closeConnection("closed");
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reservedTcpPorts.delete(port);
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, config.tcpTunnelBindHost ?? "0.0.0.0", () => {
        server.off("error", onError);
        reservedTcpPorts.delete(port);
        resolve();
      });
    });

    tcpBindingsBySubdomain.set(key, { server, publicPort: port });
    usedTcpPorts.add(port);
    return { publicPort: port, publicHost: resolveTcpPublicHost() };
  }

  async function releaseTcpTunnelBySubdomain(subdomain: string): Promise<void> {
    const binding = tcpBindingsBySubdomain.get(subdomain);
    if (!binding) {
      return;
    }
    tcpBindingsBySubdomain.delete(subdomain);
    usedTcpPorts.delete(binding.publicPort);
    await new Promise<void>((resolve) => {
      binding.server.close(() => resolve());
    });
  }

  /** Delete the stable redirect (/r/:token) entry for a tunnel key so a revoked
   *  tunnel does not linger in the panel as an "offline" session. */
  function purgeRedirectForKey(tunnelKey: string): void {
    const rToken = redirectTokenByTunnelKey.get(tunnelKey);
    if (rToken) {
      redirectByToken.delete(rToken);
      redirectTokenByTunnelKey.delete(tunnelKey);
    }
  }

  /** Terminate a currently-connected tunnel: tell the client to close the port
   *  and NOT reconnect, then close the control socket (its close handler tears
   *  down TCP bindings, registry lease, inspector buffers and IP tokens).
   *  Returns true if a live client socket was found and signalled. */
  function isDeviceOnline(deviceId: string): boolean {
    const set = socketsByDeviceId.get(deviceId);
    return !!set && set.size > 0;
  }

  /** Disconnect every live socket for a device (used when the device is
   *  forgotten from the console). Sends tunnel_revoked then closes 4401. */
  function disconnectSocketsForDevice(deviceId: string, reason: string): number {
    const sockets = socketsByDeviceId.get(deviceId);
    if (!sockets || sockets.size === 0) {
      return 0;
    }
    let closed = 0;
    for (const socket of [...sockets]) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeWireMessage({ type: "tunnel_revoked", reason }));
          socket.close(4401, reason);
        }
        closed += 1;
      } catch {
        // best effort
      }
    }
    return closed;
  }

  /** Disconnect every live client that authenticated with the given API key
   *  hash. Sends tunnel_revoked (so the client stops without reconnecting) then
   *  closes 4401. Used when a key is revoked so the device is logged out now. */
  function disconnectSocketsForApiKey(keyHash: string, reason: string): number {
    const sockets = socketsByApiKeyHash.get(keyHash);
    if (!sockets || sockets.size === 0) {
      return 0;
    }
    let closed = 0;
    for (const socket of [...sockets]) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeWireMessage({ type: "tunnel_revoked", reason }));
          socket.close(4401, reason);
        }
        closed += 1;
      } catch {
        // best effort — the socket close handler still runs on teardown
      }
    }
    return closed;
  }

  function revokeLiveTunnel(tunnelKey: string, reason: string): boolean {
    // socketByTunnelKey covers both subdomain-routed and fixed-port TCP tunnels;
    // fall back to the registry for safety.
    const socket = socketByTunnelKey.get(tunnelKey) ?? registry.getSocketBySubdomain(tunnelKey);
    if (!socket) {
      return false;
    }
    try {
      if (socket.readyState === WebSocket.OPEN) {
        // Queue the revoke frame, then close — ws flushes buffered data before
        // sending the close frame, so the client receives the revoke first.
        socket.send(encodeWireMessage({ type: "tunnel_revoked", subdomain: tunnelKey, reason }));
        socket.close(4403, "revoked");
      }
    } catch {
      // best effort — the close handler still runs on any socket teardown
    }
    return true;
  }

  function parseCreateTunnelBody(rawBody: unknown): { subdomain: string } | null {
    if (!isPlainObject(rawBody) || !hasOnlyAllowedKeys(rawBody, ["subdomain"])) {
      return null;
    }
    if (typeof rawBody.subdomain !== "string") {
      return null;
    }
    return { subdomain: rawBody.subdomain.trim().toLowerCase() };
  }

  function parseAuthRegisterBody(rawBody: unknown): { email: string; password: string } | null {
    if (!isPlainObject(rawBody) || !hasOnlyAllowedKeys(rawBody, ["email", "password"])) {
      return null;
    }
    if (typeof rawBody.email !== "string" || typeof rawBody.password !== "string") {
      return null;
    }
    const email = rawBody.email.trim().toLowerCase();
    const password = rawBody.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
      return null;
    }
    return { email, password };
  }

  function parseAuthLoginBody(rawBody: unknown): { email: string; password: string } | null {
    return parseAuthRegisterBody(rawBody);
  }

  function parseCreateApiKeyBody(rawBody: unknown): { name: string; scopesRaw?: string } | null {
    if (!isPlainObject(rawBody) || !hasOnlyAllowedKeys(rawBody, ["name", "scopes"])) {
      return null;
    }
    if (typeof rawBody.name !== "string") {
      return null;
    }
    const name = rawBody.name.trim();
    if (!name || name.length > 64) {
      return null;
    }
    return {
      name,
      scopesRaw: typeof rawBody.scopes === "string" ? rawBody.scopes : undefined,
    };
  }

  function parseAdminStateBody(rawBody: unknown): { maintenanceMode?: boolean; draining?: boolean } | null {
    if (!isPlainObject(rawBody) || !hasOnlyAllowedKeys(rawBody, ["maintenanceMode", "draining"])) {
      return null;
    }
    const hasMaintenance = Object.prototype.hasOwnProperty.call(rawBody, "maintenanceMode");
    const hasDraining = Object.prototype.hasOwnProperty.call(rawBody, "draining");
    if (!hasMaintenance && !hasDraining) {
      return null;
    }
    if (hasMaintenance && typeof rawBody.maintenanceMode !== "boolean") {
      return null;
    }
    if (hasDraining && typeof rawBody.draining !== "boolean") {
      return null;
    }
    return {
      maintenanceMode: hasMaintenance ? (rawBody.maintenanceMode as boolean) : undefined,
      draining: hasDraining ? (rawBody.draining as boolean) : undefined,
    };
  }

  function makeIdempotencyStoreKey(principalUserId: string, endpoint: string, idempotencyKey: string): string {
    return `${principalUserId}|${endpoint}|${idempotencyKey}`;
  }

  function readIdempotencyKey(headers: Record<string, unknown>): string {
    const raw = headers["idempotency-key"];
    const value = Array.isArray(raw) ? String(raw[0] ?? "") : raw ? String(raw) : "";
    return value.trim();
  }

  function readIdempotencyReplay(storeKey: string): IdempotencyReplay | null {
    const cached = idempotencyStore.get(storeKey);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.storedAt > idempotencyTtlMs) {
      idempotencyStore.delete(storeKey);
      return null;
    }
    return cached;
  }

  function writeIdempotencyReplay(storeKey: string, replay: Omit<IdempotencyReplay, "storedAt">): void {
    idempotencyStore.set(storeKey, { ...replay, storedAt: Date.now() });
  }

  wsServer.on("connection", (socket, request) => {
    if (isDraining || maintenanceMode) {
      metrics.increment("gateway_ws_rejected_draining_total");
      app.log.info({
        nodeId: gatewayNodeId,
        draining: isDraining,
        maintenanceMode,
        remoteAddress: request.socket.remoteAddress,
      }, "rejected websocket connection while draining or in maintenance");
      socket.send(createGatewayError(
        maintenanceMode ? "Gateway is in maintenance mode" : "Gateway is temporarily draining and not accepting new tunnels",
        maintenanceMode ? "GATEWAY_MAINTENANCE" : "GATEWAY_DRAINING",
      ));
      socket.close(1013, "service_unavailable");
      return;
    }

    metrics.increment("gateway_ws_connections_total");

    // A tunnel socket that emits 'error' with no listener is re-thrown by the
    // 'ws' library as an uncaught exception, which would crash the whole node
    // and drop every live tunnel. Attach the handler immediately (before the
    // async auth resolves) so errors during the auth window are caught too.
    socket.on("error", (err: Error) => {
      metrics.increment("gateway_ws_socket_errors_total");
      app.log.warn({ err, remoteAddress: request.socket.remoteAddress }, "tunnel websocket error");
    });

    // Buffer any frames that arrive while resolvePrincipal is awaiting the DB.
    // Without this, register_tunnel is silently lost in the race window between
    // the WebSocket upgrade and the async auth completing, causing the gateway
    // to see the first heartbeat (5 s later) as the "first message".
    const pendingFrames: WebSocket.RawData[] = [];
    const earlyCollector = (raw: WebSocket.RawData): void => { pendingFrames.push(raw); };
    socket.on("message", earlyCollector);

    resolvePrincipal(request.headers as Record<string, unknown>).then((principal) => {
      socket.off("message", earlyCollector);

      if (!principal) {
        void auditStore.log(null, "ws_auth_failed", "tunnel_session", null);
        metrics.increment("gateway_ws_auth_failures_total");
        socket.close(4401, "unauthorized");
        return;
      }

      let registered = false;
      let socketIdleTimer: NodeJS.Timeout | null = null;
      activeStreamsBySocket.set(socket, new Set());

      // Track this socket under its API key so revoking the key disconnects it.
      const principalKeyHash = principal.apiKey ? hashApiKey(principal.apiKey) : null;
      if (principalKeyHash) {
        const set = socketsByApiKeyHash.get(principalKeyHash) ?? new Set<WebSocket>();
        set.add(socket);
        socketsByApiKeyHash.set(principalKeyHash, set);
      }
      // Set once the client reports a device identity in register_tunnel.
      let socketDeviceId: string | null = null;

      const refreshIdleTimer = (): void => {
        if (socketIdleTimer) {
          clearTimeout(socketIdleTimer);
        }
        socketIdleTimer = setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(4000, "heartbeat_timeout");
          }
        }, config.wsIdleTimeoutMs);
      };

      refreshIdleTimer();

      const handleMessage = async (raw: WebSocket.RawData): Promise<void> => {
      refreshIdleTimer();

      let msg: WireMessage;
      try {
        msg = decodeWireMessage(String(raw));
      } catch {
        socket.send(createGatewayError("Invalid JSON"));
        return;
      }

        if (!registered && msg.type !== "register_tunnel") {
          socket.send(createGatewayError("First message must be register_tunnel"));
          return;
        }

        if (msg.type === "register_tunnel") {
          const requestMessage = msg as RegisterTunnel;
          const isTcp = requestMessage.tunnelType === "tcp";
          const requestedPremiumSubdomain = !!requestMessage.requestedSubdomain;

          // ── Device roster ─────────────────────────────────────────────────
          // Record/refresh this machine as a device and mark it online. Only
          // for real (non-anonymous) users with a client-reported deviceId.
          if (requestMessage.deviceId && principal.authType !== "anonymous" && !socketDeviceId) {
            socketDeviceId = requestMessage.deviceId;
            const set = socketsByDeviceId.get(socketDeviceId) ?? new Set<WebSocket>();
            set.add(socket);
            socketsByDeviceId.set(socketDeviceId, set);
            void deviceStore.upsert(principal.userId, {
              deviceId: requestMessage.deviceId,
              name: requestMessage.deviceName || requestMessage.deviceId,
              platform: requestMessage.platform ?? null,
              clientVersion: requestMessage.clientVersion ?? null,
              lastKeyHash: principalKeyHash,
            }).then(() => publishLiveEvent("devices_changed", principal.userId)).catch(() => { /* non-fatal */ });
          }

          // Subdomain access is a per-user subscription entitlement, resolved live
          // from the user record. Users without it get a dedicated public port only.
          const subdomainAllowed = await isSubdomainAllowed(principal);

          // Requesting a specific/vanity subdomain requires the entitlement.
          if (!isTcp && requestedPremiumSubdomain && !subdomainAllowed) {
            socket.send(createGatewayError(
              "Subdomain access requires a subscription. Ask a platform admin to enable it for your account.",
              "SUBDOMAIN_NOT_ALLOWED",
            ));
            return;
          }

          // Check whether admin has configured a fixed public port for this local port.
          let fixedMapping: TcpPortMappingRecord | null = null;
          if (isTcp && requestMessage.localPort && requestMessage.localPort > 0) {
            try {
              fixedMapping = await tcpPortMappingStore.findByLocalPort(requestMessage.localPort);
            } catch {
              // non-fatal — fall through to normal allocation
            }
          }

          const useFixedPort =
            fixedMapping !== null &&
            fixedMapping.enabled &&
            !usedTcpPorts.has(fixedMapping.publicPort) &&
            !reservedTcpPorts.has(fixedMapping.publicPort);

          if (isTcp && useFixedPort && fixedMapping) {
            // ── FIXED-PORT PATH ──────────────────────────────────────────────
            // The tunnel is reachable via domain:publicPort — no subdomain needed.
            // We store a synthetic key so the close handler can clean up the TCP
            // server binding without any changes to that logic.
            const syntheticKey = `__tcp_port_${fixedMapping.publicPort}__`;
            socketSubdomain.set(socket, syntheticKey);
            socketByTunnelKey.set(syntheticKey, socket);
            // NOTE: do NOT add to registry (no HTTP subdomain routing required).
            // Record ownership under the synthetic key so the tunnel is listable
            // and revocable by its owner from the web panel.
            ownershipBySubdomain.set(syntheticKey, principal.userId);
            registered = true;
            metrics.setGauge("gateway_active_tunnels", registry.count());

            // ── IP link protection ───────────────────────────────────────────
            const ipProtection =
              requestMessage.ipProtection !== false &&
              (config.ipProtectionDefault !== false);
            let accessToken: string | undefined;
            let accessLink: string | undefined;
            if (ipProtection) {
              accessToken = randomBytes(24).toString("base64url");
              accessLink = buildPublicUrl(`/l/${accessToken}`);
              ipAccessByToken.set(accessToken, {
                tunnelKey: syntheticKey,
                allowedIps: new Map(),
                tokenCreatedAt: Date.now(),
              });
              ipTokenByTunnelKey.set(syntheticKey, accessToken);
            }

            // ── Stable redirect URL ──────────────────────────────────────────
            // If the client is reconnecting and sends back its previous token, reuse
            // the same /r/:token entry so bookmarks/scripts stay valid.
            let redirectToken: string;
            const incomingRToken = requestMessage.redirectToken;
            const existingREntry = incomingRToken ? redirectByToken.get(incomingRToken) : undefined;
            // Only reuse the redirect token if the same user owns it — prevents
            // one authenticated user from hijacking another's stable redirect URL.
            if (incomingRToken && existingREntry && (!existingREntry.userId || existingREntry.userId === principal.userId)) {
              redirectToken = incomingRToken;
              existingREntry.connected = false;  // will be marked true after bind
              existingREntry.disconnectedAt = undefined;
              existingREntry.accessLink = accessLink;
            } else if (redirectTokenByTunnelKey.has(syntheticKey)) {
              // A prior binding for this exact fixed port exists but the client
              // didn't (or couldn't) replay its token — purge the stale entry so
              // the panel doesn't show a duplicate "offline" ghost that, if
              // removed, would revoke this live tunnel (same synthetic key).
              purgeRedirectForKey(syntheticKey);
              redirectToken = randomBytes(16).toString("base64url");
            } else {
              redirectToken = randomBytes(16).toString("base64url");
            }
            const redirectUrl = buildPublicUrl(`/r/${redirectToken}`);

            void auditStore.log(principal.userId, "ws_tunnel_registered_fixed_port", "tcp_port_session",
              String(fixedMapping.publicPort), {
                authType: principal.authType,
                localPort: requestMessage.localPort,
                publicPort: fixedMapping.publicPort,
                ipProtection,
              });
            try {
              const tcpBinding = await bindTcpTunnel(syntheticKey, socket, fixedMapping.publicPort, accessToken, principal.userId);

              // Store/update the redirect entry after we have the public host.
              const rEntry: RedirectEntry = redirectByToken.get(redirectToken) ?? {
                tunnelKey: syntheticKey,
                userId: principal.userId,
                tunnelType: "tcp",
                createdAt: Date.now(),
                connected: false,
                lastSeenAt: Date.now(),
              };
              rEntry.publicTcpPort = tcpBinding.publicPort;
              rEntry.publicTcpHost = tcpBinding.publicHost;
              rEntry.accessLink = accessLink;
              rEntry.connected = true;
              rEntry.lastSeenAt = Date.now();
              redirectByToken.set(redirectToken, rEntry);
              redirectTokenByTunnelKey.set(syntheticKey, redirectToken);
              publishLiveEvent("tunnels_changed", principal.userId);
              publishLiveEvent("gateway_status_changed");

              socket.send(encodeWireMessage({
                type: "registered",
                tunnelType: "tcp",
                publicTcpHost: tcpBinding.publicHost,
                publicTcpPort: tcpBinding.publicPort,
                // subdomain intentionally omitted — access is via domain:port
                accessLink,
                redirectToken,
                redirectUrl,
              }));
              } catch {
                socket.send(createGatewayError("Requested TCP public port is unavailable", "TCP_PORT_BUSY"));
                // Clean up partially-created tokens on failure
                if (accessToken) { ipAccessByToken.delete(accessToken); ipTokenByTunnelKey.delete(syntheticKey); }
                registered = false;
            }
            return;
          }

          // ── PORT-ONLY PATH ────────────────────────────────────────────────
          // An HTTP tunnel from a user WITHOUT the subdomain subscription. No
          // subdomain is registered (so there is no HTTP subdomain routing); the
          // tunnel is reachable only via a dedicated public port that raw-TCP
          // passthrough-forwards to the local service. It registers under the
          // SAME `__tcp_port_<port>__` synthetic-key scheme as TCP tunnels so the
          // listing, revocation and DELETE machinery treats it identically —
          // visible in every panel and revocable by both the owner and admins.
          if (!isTcp && !subdomainAllowed) {
            if (!(config.tcpTunnelEnabled ?? true)) {
              socket.send(createGatewayError(
                "This gateway cannot expose a public port (TCP disabled), and subdomain access requires a subscription.",
                "TCP_TUNNEL_DISABLED",
              ));
              return;
            }
            // Allocate the public port up-front so the synthetic key embeds it.
            // allocateTcpPort()..bindTcpTunnel() run with no intervening await, so
            // no other registration can claim the same port in between.
            const allocatedPort = allocateTcpPort();
            if (allocatedPort === null) {
              socket.send(createGatewayError("No public ports are currently available", "TCP_PORT_EXHAUSTED"));
              return;
            }
            const syntheticKey = `__tcp_port_${allocatedPort}__`;
            socketSubdomain.set(socket, syntheticKey);
            socketByTunnelKey.set(syntheticKey, socket);
            ownershipBySubdomain.set(syntheticKey, principal.userId);
            registered = true;
            metrics.setGauge("gateway_active_tunnels", registry.count());

            // IP-link protection: keep the public port DARK until a caller opens
            // the secret access link (/l/:token), which whitelists their IP for
            // 24h. On by default so the exposed port is not world-open; the client
            // disables it with --no-ip-protection.
            const ipProtection =
              requestMessage.ipProtection !== false &&
              (config.ipProtectionDefault !== false);
            let accessToken: string | undefined;
            let accessLink: string | undefined;
            if (ipProtection) {
              accessToken = randomBytes(24).toString("base64url");
              accessLink = buildPublicUrl(`/l/${accessToken}`);
              ipAccessByToken.set(accessToken, {
                tunnelKey: syntheticKey,
                allowedIps: new Map(),
                tokenCreatedAt: Date.now(),
              });
              ipTokenByTunnelKey.set(syntheticKey, accessToken);
            }

            // Stable redirect URL (reused by the same owner on reconnect).
            let redirectToken: string;
            const incomingRToken = requestMessage.redirectToken;
            const existingREntry = incomingRToken ? redirectByToken.get(incomingRToken) : undefined;
            if (incomingRToken && existingREntry && (!existingREntry.userId || existingREntry.userId === principal.userId)) {
              redirectToken = incomingRToken;
              existingREntry.connected = false;
              existingREntry.disconnectedAt = undefined;
            } else {
              redirectToken = randomBytes(16).toString("base64url");
            }
            const redirectUrl = buildPublicUrl(`/r/${redirectToken}`);

            void auditStore.log(principal.userId, "ws_tunnel_registered_port_only", "tcp_port_session", syntheticKey, { authType: principal.authType, ipProtection });

            try {
              const binding = await bindTcpTunnel(syntheticKey, socket, allocatedPort, accessToken, principal.userId);
              const rEntry: RedirectEntry = redirectByToken.get(redirectToken) ?? {
                tunnelKey: syntheticKey,
                userId: principal.userId,
                tunnelType: "tcp",
                createdAt: Date.now(),
                connected: false,
                lastSeenAt: Date.now(),
              };
              rEntry.publicTcpPort = binding.publicPort;
              rEntry.publicTcpHost = binding.publicHost;
              rEntry.accessLink = accessLink;
              rEntry.connected = true;
              rEntry.lastSeenAt = Date.now();
              redirectByToken.set(redirectToken, rEntry);
              redirectTokenByTunnelKey.set(syntheticKey, redirectToken);
              publishLiveEvent("tunnels_changed", principal.userId);
              publishLiveEvent("gateway_status_changed");

              socket.send(encodeWireMessage({
                type: "registered",
                tunnelType: "http",
                dedicatedTcpHost: binding.publicHost,
                dedicatedTcpPort: binding.publicPort,
                accessLink,
                redirectToken,
                redirectUrl,
              }));
            } catch (error) {
              const code = error instanceof Error ? error.message : "";
              socket.send(createGatewayError(
                code === "TCP_PORT_EXHAUSTED" || code === "TCP_PORT_BUSY"
                  ? "No public ports are currently available"
                  : "Failed to allocate a public port",
                code === "TCP_PORT_EXHAUSTED" || code === "TCP_PORT_BUSY" ? "TCP_PORT_EXHAUSTED" : "TCP_PORT_ALLOCATE_FAILED",
              ));
              if (accessToken) { ipAccessByToken.delete(accessToken); ipTokenByTunnelKey.delete(syntheticKey); }
              socketSubdomain.delete(socket);
              socketByTunnelKey.delete(syntheticKey);
              ownershipBySubdomain.delete(syntheticKey);
              purgeRedirectForKey(syntheticKey);
              metrics.setGauge("gateway_active_tunnels", registry.count());
              registered = false;
            }
            return;
          }

          // ── NORMAL PATH (HTTP tunnel, or TCP with no/busy mapping) ─────────
          try {
            let subdomain: string;
            if (requestMessage.requestedSubdomain) {
              const exactSubdomain = await registry.assignExact(requestMessage.requestedSubdomain, socket);
              if (!exactSubdomain) {
                socket.send(createGatewayError("Requested subdomain is already taken", "SUBDOMAIN_TAKEN"));
                return;
              }
              subdomain = exactSubdomain;
            } else {
              subdomain = await registry.assign(undefined, socket);
            }
            socketSubdomain.set(socket, subdomain);
            socketByTunnelKey.set(subdomain, socket);
            ownershipBySubdomain.set(subdomain, principal.userId);
            metrics.setGauge("gateway_active_tunnels", registry.count());
            registered = true;
            publishLiveEvent("tunnels_changed", principal.userId);
            publishLiveEvent("gateway_status_changed");
            void auditStore.log(principal.userId, "ws_tunnel_registered", "tunnel_session", subdomain, { authType: principal.authType });

            // ── Stable redirect URL (all tunnel types) ──────────────────────
            let redirectToken: string;
            const incomingRToken = requestMessage.redirectToken;
            const existingNormalREntry = incomingRToken ? redirectByToken.get(incomingRToken) : undefined;
            // Only reuse the redirect token if the same user owns it.
            if (incomingRToken && existingNormalREntry && (!existingNormalREntry.userId || existingNormalREntry.userId === principal.userId)) {
              redirectToken = incomingRToken;
              existingNormalREntry.connected = false;
              existingNormalREntry.disconnectedAt = undefined;
            } else {
              redirectToken = randomBytes(16).toString("base64url");
            }
            const redirectUrl = buildPublicUrl(`/r/${redirectToken}`);

            if (isTcp) {
              // IP link protection for random-port TCP tunnels
              const ipProtection =
                requestMessage.ipProtection !== false &&
                (config.ipProtectionDefault !== false);
              let accessToken: string | undefined;
              let accessLink: string | undefined;
              if (ipProtection) {
                accessToken = randomBytes(24).toString("base64url");
                accessLink = buildPublicUrl(`/l/${accessToken}`);
                ipAccessByToken.set(accessToken, {
                  tunnelKey: subdomain,
                  allowedIps: new Map(),
                  tokenCreatedAt: Date.now(),
                });
                ipTokenByTunnelKey.set(subdomain, accessToken);
              }
              try {
                const tcpBinding = await bindTcpTunnel(subdomain, socket, undefined, accessToken, principal.userId);

                const rEntry: RedirectEntry = redirectByToken.get(redirectToken) ?? {
                  tunnelKey: subdomain,
                  userId: principal.userId,
                  tunnelType: "tcp",
                  createdAt: Date.now(),
                  connected: false,
                  lastSeenAt: Date.now(),
                };
                rEntry.subdomain = subdomain;
                rEntry.publicTcpPort = tcpBinding.publicPort;
                rEntry.publicTcpHost = tcpBinding.publicHost;
                rEntry.accessLink = accessLink;
                rEntry.connected = true;
                rEntry.lastSeenAt = Date.now();
                redirectByToken.set(redirectToken, rEntry);
                redirectTokenByTunnelKey.set(subdomain, redirectToken);

                socket.send(encodeWireMessage({
                  type: "registered",
                  subdomain,
                  tunnelType: "tcp",
                  publicTcpHost: tcpBinding.publicHost,
                  publicTcpPort: tcpBinding.publicPort,
                  accessLink,
                  redirectToken,
                  redirectUrl,
                }));
              } catch (error) {
                const code = error instanceof Error ? error.message : "";
                if (code === "TCP_TUNNEL_DISABLED") {
                  socket.send(createGatewayError("TCP tunneling is disabled on this gateway", "TCP_TUNNEL_DISABLED"));
                } else if (code === "TCP_PORT_EXHAUSTED") {
                  socket.send(createGatewayError("No public TCP ports are currently available", "TCP_PORT_EXHAUSTED"));
                } else if (code === "TCP_PORT_BUSY") {
                  socket.send(createGatewayError("Requested TCP public port is unavailable", "TCP_PORT_BUSY"));
                } else {
                  socket.send(createGatewayError("Failed to allocate TCP tunnel port", "TCP_PORT_ALLOCATE_FAILED"));
                }
                if (accessToken) { ipAccessByToken.delete(accessToken); ipTokenByTunnelKey.delete(subdomain); }
                registry.removeBySocket(socket);
                metrics.setGauge("gateway_active_tunnels", registry.count());
                registered = false;
              }
            } else {
              let publicBinding: { publicPort: number; publicHost: string } | null = null;
              if (!requestMessage.requestedSubdomain && (config.httpPublicPortMode ?? true)) {
                try {
                  publicBinding = await bindHttpPortTunnel(subdomain);
                } catch (error) {
                  const code = error instanceof Error ? error.message : "";
                  socket.send(createGatewayError(
                    code === "HTTP_PORT_EXHAUSTED" ? "No public HTTP ports are currently available" : "Failed to allocate public HTTP port",
                    code === "HTTP_PORT_EXHAUSTED" ? "HTTP_PORT_EXHAUSTED" : "HTTP_PORT_ALLOCATE_FAILED",
                  ));
                  registry.removeBySocket(socket);
                  metrics.setGauge("gateway_active_tunnels", registry.count());
                  registered = false;
                  return;
                }
              }

              // Optionally expose a dedicated raw-TCP passthrough port alongside
              // the subdomain (opt-in via the client's --with-port flag). The
              // client already services tcp_open/tcp_data/tcp_close on this same
              // socket and pipes them to the local port, so no relay changes are
              // needed — we just add a second listener. Bind it under a distinct
              // key so it coexists with any httpPublicPortMode HTTP-port binding
              // for the same subdomain. Failure is NON-FATAL: the subdomain tunnel
              // still works; we just omit the dedicated endpoint (never send an
              // error frame here — the client treats pre-registration errors as
              // fatal).
              let dedicatedBinding: { publicPort: number; publicHost: string } | null = null;
              if (requestMessage.withDedicatedPort && (config.tcpTunnelEnabled ?? true)) {
                try {
                  dedicatedBinding = await bindTcpTunnel(`dedicated:${subdomain}`, socket, undefined, undefined, principal.userId);
                } catch (error) {
                  const code = error instanceof Error ? error.message : "";
                  app.log.warn(
                    { subdomain, code },
                    "failed to bind dedicated tcp port for http tunnel — continuing without it",
                  );
                }
              }

              const rEntry: RedirectEntry = redirectByToken.get(redirectToken) ?? {
                tunnelKey: subdomain,
                userId: principal.userId,
                tunnelType: "http",
                createdAt: Date.now(),
                connected: false,
                lastSeenAt: Date.now(),
              };
              rEntry.subdomain = subdomain;
              rEntry.publicHost = publicBinding?.publicHost;
              rEntry.publicPort = publicBinding?.publicPort;
              // Reuse the RedirectEntry TCP fields to carry the dedicated raw-TCP
              // port so the stable /r/:token page and the console can surface it.
              rEntry.publicTcpHost = dedicatedBinding?.publicHost;
              rEntry.publicTcpPort = dedicatedBinding?.publicPort;
              rEntry.connected = true;
              rEntry.lastSeenAt = Date.now();
              redirectByToken.set(redirectToken, rEntry);
              redirectTokenByTunnelKey.set(subdomain, redirectToken);

              socket.send(encodeWireMessage({
                type: "registered",
                subdomain,
                tunnelType: "http",
                publicHost: publicBinding?.publicHost,
                publicPort: publicBinding?.publicPort,
                dedicatedTcpHost: dedicatedBinding?.publicHost,
                dedicatedTcpPort: dedicatedBinding?.publicPort,
                redirectToken,
                redirectUrl,
              }));
            }
          } catch {
            socket.send(createGatewayError("Failed to allocate tunnel subdomain", "SUBDOMAIN_ALLOCATE_FAILED"));
          }
          return;
        }

        if (msg.type === "heartbeat") {
          const subdomain = socketSubdomain.get(socket);
          if (subdomain) {
            registry.heartbeat(subdomain);
          }
          // Acknowledge so the client's liveness timer doesn't trigger on idle tunnels
          socket.send(encodeWireMessage({ type: "heartbeat_ack" }));
          return;
        }

        if (msg.type === "http_response") {
          const waiter = responseWaiters.get(msg.streamId);
          if (waiter) {
            const chunkMeta = msg.meta?.chunk;
            if (!chunkMeta) {
              const timeout = streamTimeouts.get(msg.streamId);
              if (timeout) {
                clearTimeout(timeout);
                streamTimeouts.delete(msg.streamId);
              }
              responseWaiters.delete(msg.streamId);
              streamRejecters.delete(msg.streamId);
              activeStreamsBySocket.get(socket)?.delete(msg.streamId);
              responseChunksByStream.delete(msg.streamId);
              waiter(msg);
              return;
            }

            const existing = responseChunksByStream.get(msg.streamId) ?? {
              statusCode: msg.statusCode,
              headers: msg.headers,
              chunks: new Map<number, Buffer>(),
              total: chunkMeta.total,
              finalIndex: chunkMeta.final ? chunkMeta.index : undefined,
              meta: msg.meta,
            };
            // Guard: validate chunk index is a safe non-negative integer to
            // prevent a malicious client from sending index = Number.MAX_SAFE_INTEGER
            // which would prevent assembly from completing.
            const chunkIndex = chunkMeta.index;
            const MAX_CHUNKS = Math.ceil(config.maxRequestBodyBytes / 1024) + 1;
            if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_CHUNKS) {
              app.log.warn({ streamId: msg.streamId, chunkIndex }, "chunk index out of valid range — dropping stream");
              const timeoutBad = streamTimeouts.get(msg.streamId);
              if (timeoutBad) { clearTimeout(timeoutBad); streamTimeouts.delete(msg.streamId); }
              responseWaiters.delete(msg.streamId);
              streamRejecters.delete(msg.streamId);
              activeStreamsBySocket.get(socket)?.delete(msg.streamId);
              responseChunksByStream.delete(msg.streamId);
              return;
            }

            chunkDiagnostics.chunkFramesReceived += 1;
            metrics.increment("gateway_chunk_frames_total");
            existing.statusCode = msg.statusCode;
            existing.headers = msg.headers;
            existing.meta = msg.meta;
            if (typeof chunkMeta.total === "number") {
              existing.total = chunkMeta.total;
            }
            if (chunkMeta.final) {
              existing.finalIndex = chunkMeta.index;
            }

            const newChunkBytes = Math.ceil(msg.bodyBase64.length * 3 / 4);
            let totalAccumulated = newChunkBytes;
            for (const buf of existing.chunks.values()) { totalAccumulated += buf.length; }
            if (totalAccumulated > config.maxRequestBodyBytes) {
              app.log.warn({ streamId: msg.streamId, totalAccumulated }, "chunk stream exceeds maxRequestBodyBytes — dropping stream");
              const timeoutOversized = streamTimeouts.get(msg.streamId);
              if (timeoutOversized) { clearTimeout(timeoutOversized); streamTimeouts.delete(msg.streamId); }
              responseWaiters.delete(msg.streamId);
              streamRejecters.delete(msg.streamId);
              activeStreamsBySocket.get(socket)?.delete(msg.streamId);
              responseChunksByStream.delete(msg.streamId);
              return;
            }

            existing.chunks.set(chunkMeta.index, Buffer.from(msg.bodyBase64, "base64"));
            responseChunksByStream.set(msg.streamId, existing);
            // Progress was made — reset the idle timer so an actively-streaming
            // large response isn't killed by the idle deadline.
            if (responseWaiters.has(msg.streamId)) {
              armStreamIdleTimeout(msg.streamId, socket);
            }

            const expectedChunks = typeof existing.total === "number"
              ? existing.total
              : typeof existing.finalIndex === "number"
                ? existing.finalIndex + 1
                : undefined;

            if (typeof expectedChunks === "number" && existing.chunks.size >= expectedChunks) {
              const ordered: Buffer[] = [];
              let complete = true;
              for (let index = 0; index < expectedChunks; index += 1) {
                const part = existing.chunks.get(index);
                if (!part) {
                  complete = false;
                  break;
                }
                ordered.push(part);
              }
              if (!complete) {
                return;
              }

              const timeout = streamTimeouts.get(msg.streamId);
              if (timeout) {
                clearTimeout(timeout);
                streamTimeouts.delete(msg.streamId);
              }
              responseWaiters.delete(msg.streamId);
              streamRejecters.delete(msg.streamId);
              activeStreamsBySocket.get(socket)?.delete(msg.streamId);
              responseChunksByStream.delete(msg.streamId);
              chunkDiagnostics.chunkStreamsReassembled += 1;
              metrics.increment("gateway_chunk_reassembled_streams_total");
              waiter({
                type: "http_response",
                streamId: msg.streamId,
                statusCode: existing.statusCode,
                headers: existing.headers,
                bodyBase64: Buffer.concat(ordered).toString("base64"),
                meta: existing.meta,
              });
            }
          }
          return;
        }

        if (msg.type === "tcp_data") {
          // Ownership check: only allow the socket that owns this connectionId
          // to write to it — prevents cross-tenant TCP connection injection.
          const ownedConnections = tcpConnectionsBySocket.get(socket);
          if (ownedConnections && ownedConnections.has(msg.connectionId)) {
            const conn = tcpConnectionsById.get(msg.connectionId);
            if (conn) {
              // Size guard: reject oversized data frames to prevent memory-exhaustion DoS.
              const maxChunkBytes = config.maxRequestBodyBytes * 2;
              if (msg.dataBase64.length > maxChunkBytes) {
                app.log.warn({ connectionId: msg.connectionId }, "tcp_data frame exceeds size limit — dropped");
              } else {
                const inbound = Buffer.from(msg.dataBase64, "base64");
                conn.write(inbound);
                // Usage metering: bytes flowing in from the client to the peer.
                usage.recordBytes(principal.userId, inbound.length, 0);
              }
            }
          }
          return;
        }

        if (msg.type === "tcp_close") {
          // Ownership check: only allow the socket that owns this connectionId to close it.
          const ownedConnections = tcpConnectionsBySocket.get(socket);
          if (ownedConnections && ownedConnections.has(msg.connectionId)) {
            const conn = tcpConnectionsById.get(msg.connectionId);
            if (conn) {
              ownedConnections.delete(msg.connectionId);
              tcpConnectionsById.delete(msg.connectionId);
              conn.destroy();
            }
          }
          return;
        }
      };

      // Wrap the async handler so a rejected message never becomes an unhandled
      // rejection (which would otherwise be caught only by the process-level
      // guard). Errors are logged and the connection stays alive.
      const safeHandleMessage = (raw: WebSocket.RawData): void => {
        handleMessage(raw).catch((err) => {
          app.log.error({ err }, "ws message handler error");
        });
      };

      socket.on("message", safeHandleMessage);

      // Replay any frames that arrived during the async auth window so that
      // register_tunnel is never silently dropped.
      for (const raw of pendingFrames) {
        safeHandleMessage(raw);
      }

      socket.on("close", () => {
        if (socketIdleTimer) {
          clearTimeout(socketIdleTimer);
        }

        const subdomain = socketSubdomain.get(socket);
        if (subdomain) {
          ownershipBySubdomain.delete(subdomain);
          socketByTunnelKey.delete(subdomain);
          // Free the inspector ring buffer for this tunnel. Without this the
          // captured request/response bodies (up to ~25 MB per subdomain) are
          // pinned forever and accumulate with tunnel churn → unbounded heap.
          capturedRequests.delete(subdomain);
        }

        const activeStreamIds = activeStreamsBySocket.get(socket);
        if (activeStreamIds) {
          for (const streamId of activeStreamIds) {
            const timer = streamTimeouts.get(streamId);
            if (timer) {
              clearTimeout(timer);
              streamTimeouts.delete(streamId);
            }
            const waiter = responseWaiters.get(streamId);
            if (waiter) {
              responseWaiters.delete(streamId);
              streamRejecters.delete(streamId);
              responseChunksByStream.delete(streamId);
              waiter({ type: "http_response", streamId, statusCode: 502, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ error: "Tunnel disconnected" })).toString("base64") });
            }
          }
        }

        if (subdomain) {
          void releaseTcpTunnelBySubdomain(subdomain);
          // Also release any dedicated raw-TCP passthrough port bound alongside an
          // HTTP subdomain tunnel (--with-port). No-op when none was bound.
          void releaseTcpTunnelBySubdomain(`dedicated:${subdomain}`);
        }
        const connectionIds = tcpConnectionsBySocket.get(socket);
        if (connectionIds) {
          for (const connectionId of connectionIds) {
            const conn = tcpConnectionsById.get(connectionId);
            if (conn) {
              conn.destroy();
            }
            tcpConnectionsById.delete(connectionId);
          }
        }
        // ── Stable redirect URL handling on disconnect.
        //    DB-reserved tunnels keep an offline "ghost" so the /r/:token URL
        //    stays valid across reconnect windows. Ephemeral CLI sessions
        //    (port-only/TCP synthetic keys, or a random subdomain with no DB
        //    reservation) are PURGED immediately so they don't linger in the
        //    panel after the client is closed.
        if (subdomain) {
          const rToken = redirectTokenByTunnelKey.get(subdomain);
          const rEntry = rToken ? redirectByToken.get(rToken) : undefined;
          if (rEntry) {
            const ownerId = rEntry.userId ?? ownershipBySubdomain.get(subdomain) ?? null;
            const syntheticKey = subdomain.startsWith("__tcp_port_") || subdomain.startsWith("__http_port_");
            if (syntheticKey) {
              // Never DB-reserved — purge now.
              purgeRedirectForKey(subdomain);
            } else {
              // Provisionally mark offline, then purge unless a DB reservation
              // exists (async lookup; keep the ghost on lookup error).
              rEntry.connected = false;
              rEntry.lastSeenAt = Date.now();
              rEntry.disconnectedAt = Date.now();
              void store.findBySubdomain(subdomain)
                .then((reserved) => {
                  if (!reserved) {
                    purgeRedirectForKey(subdomain);
                    publishLiveEvent("tunnels_changed", ownerId);
                    publishLiveEvent("gateway_status_changed");
                  }
                })
                .catch(() => { /* keep the offline ghost if the store lookup fails */ });
            }
          }
          // ── IP access cleanup: remove whitelist on disconnect.
          const aToken = ipTokenByTunnelKey.get(subdomain);
          if (aToken) {
            ipAccessByToken.delete(aToken);
            ipTokenByTunnelKey.delete(subdomain);
          }
        }

        // Stop tracking this socket under its API key.
        if (principalKeyHash) {
          const set = socketsByApiKeyHash.get(principalKeyHash);
          if (set) {
            set.delete(socket);
            if (set.size === 0) socketsByApiKeyHash.delete(principalKeyHash);
          }
        }
        // Mark the device offline (once its last socket closes) + stamp lastSeen.
        if (socketDeviceId) {
          const set = socketsByDeviceId.get(socketDeviceId);
          if (set) {
            set.delete(socket);
            if (set.size === 0) socketsByDeviceId.delete(socketDeviceId);
          }
          void deviceStore.touch(principal.userId, socketDeviceId)
            .then(() => publishLiveEvent("devices_changed", principal.userId))
            .catch(() => { /* non-fatal */ });
        }

        registry.removeBySocket(socket);
        metrics.setGauge("gateway_active_tunnels", registry.count());
        if (subdomain) {
          publishLiveEvent("tunnels_changed", ownershipBySubdomain.get(subdomain) ?? null);
        } else {
          publishLiveEvent("tunnels_changed");
        }
        publishLiveEvent("gateway_status_changed");
      });
    }).catch((err) => {
      app.log.error({ err }, "ws auth resolution error");
      socket.close(1011, "auth_resolution_error");
    });
  });

  app.get("/healthz", async () => ({
    status: "ok",
    nodeId: gatewayNodeId,
    registryBackend: config.registryBackend ?? "memory",
    tunnels: registry.count(),
  }));
  app.get("/readyz", async (_req, reply) => {
    const state = gatewayState();
    return reply.status(state.ready ? 200 : 503).send(state);
  });
  app.get("/api/events", async (req, reply) => {
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    raw.setHeader("cache-control", "no-cache, no-transform");
    raw.setHeader("connection", "keep-alive");
    raw.setHeader("x-accel-buffering", "no");
    raw.flushHeaders?.();

    const id = randomUUID();
    let closed = false;
    const heartbeat = setInterval(() => {
      if (closed) {
        return;
      }
      try {
        raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, 15_000);
    heartbeat.unref();

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      liveSubscribers.delete(id);
      try {
        raw.end();
      } catch {
        // ignore
      }
    };

    const write = (event: LiveEvent) => {
      if (closed) {
        return;
      }
      raw.write(`event: ${event.kind}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    liveSubscribers.set(id, { id, principal, write, close: cleanup });
    write({ kind: "connected", at: new Date().toISOString(), userId: principal.userId });

    req.raw.on("close", cleanup);
    req.raw.on("aborted", cleanup);
  });
  app.get("/metrics", async (req, reply) => {
    // If METRICS_TOKEN is configured, require a matching Bearer token so that
    // Prometheus metrics are not publicly accessible on the internet.
    if (config.metricsToken) {
      const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
      const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      // Constant-time comparison to avoid leaking the token via timing.
      const expectedBuf = Buffer.from(config.metricsToken);
      const providedBuf = Buffer.from(provided);
      const tokenOk = provided.length > 0
        && expectedBuf.length === providedBuf.length
        && timingSafeEqual(expectedBuf, providedBuf);
      if (!tokenOk) {
        reply.header("www-authenticate", "Bearer");
        return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid Bearer token required for /metrics" } });
      }
    }
    reply.header("content-type", "text/plain; version=0.0.4");
    return reply.status(200).send(metrics.renderPrometheus());
  });
  app.get("/openapi.json", async (_req, reply) => {
    // Use the configured public base URL instead of reflecting the inbound Host
    // header — reflecting Host verbatim enables host-header injection attacks.
    const base = (config.gatewayPublicBaseUrl ?? "").trim() || `http://${config.rootDomain}:${config.gatewayPort}`;
    return reply.status(200).send(buildOpenApiDocument(base));
  });

  app.post("/api/auth/register", async (req, reply) => {
    const endpoint = "/api/auth/register";
    const apiLimit = apiWriteLimiter.take(`api:write:auth_register:${req.ip}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    const body = parseAuthRegisterBody(req.body);
    if (!body) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "Body must include valid { email, password(min 8 chars) }" } });
    }
    if (!config.authJwtSecret) {
      return reply.status(503).send({ error: { code: "JWT_NOT_CONFIGURED", message: "AUTH_JWT_SECRET is required for registration/login" } });
    }
    try {
      const created = await userAuthStore.register(body.email, hashPassword(body.password));
      const admin = isAdminEmail(created.email);
      const role: Principal["role"] = admin ? "admin" : "owner";
      const scopes = admin ? [...DEFAULT_USER_SCOPES, ...ADMIN_SCOPES] : [...DEFAULT_USER_SCOPES];
      const token = signAccessToken({ sub: created.id, role, scopes }, config.authJwtSecret, "7d");
      await auditStore.log(created.id, "user_registered", "user", created.id, { email: created.email });
      return reply.status(201).send({
        user: { id: created.id, email: created.email, role },
        accessToken: token,
        tokenType: "Bearer",
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNKNOWN";
      if (code === "USER_EXISTS") {
        return reply.status(409).send({ error: { code: "USER_EXISTS", message: "User already exists" } });
      }
      // Log the real error so it shows in gateway console — helps diagnose DB issues
      app.log.error({ err: error }, "Registration failed");
      const detail = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({
        error: {
          code: "REGISTER_FAILED",
          message: process.env.NODE_ENV === "production"
            ? "Registration failed — check gateway logs"
            : `Registration failed: ${detail}`,
        },
      });
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    const endpoint = "/api/auth/login";
    const apiLimit = apiWriteLimiter.take(`api:write:auth_login:${req.ip}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    const body = parseAuthLoginBody(req.body);
    if (!body) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "Body must include valid { email, password }" } });
    }
    if (!config.authJwtSecret) {
      return reply.status(503).send({ error: { code: "JWT_NOT_CONFIGURED", message: "AUTH_JWT_SECRET is required for registration/login" } });
    }
    try {
      const user = await userAuthStore.findByEmail(body.email);
      if (!user || !verifyPassword(body.password, user.passwordHash)) {
        return reply.status(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
      }
      const admin = isAdminEmail(user.email);
      const role: Principal["role"] = admin ? "admin" : "owner";
      const scopes = admin ? [...DEFAULT_USER_SCOPES, ...ADMIN_SCOPES] : [...DEFAULT_USER_SCOPES];
      const token = signAccessToken({ sub: user.id, role, scopes }, config.authJwtSecret, "7d");
      await auditStore.log(user.id, "user_login", "user", user.id, { email: user.email });
      return reply.status(200).send({
        user: { id: user.id, email: user.email, role },
        accessToken: token,
        tokenType: "Bearer",
      });
    } catch (error) {
      app.log.error({ err: error }, "Login failed");
      const detail = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({
        error: {
          code: "LOGIN_FAILED",
          message: process.env.NODE_ENV === "production"
            ? "Login failed — check gateway logs"
            : `Login failed: ${detail}`,
        },
      });
    }
  });

  app.get("/api/auth/validate", async (req, reply) => {
    const result = await handleAuthValidateHttp(req.headers as IncomingHttpHeaders);
    if (result.responseHeaders) {
      for (const [key, value] of Object.entries(result.responseHeaders)) {
        reply.header(key, value);
      }
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/api/auth/change-password", async (req, reply) => {
    const endpoint = "/api/auth/change-password";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }
    if (principal.authType !== "jwt") {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "JWT authentication required to change password" } });
    }
    const limit = apiWriteLimiter.take(`api:write:${principal.userId}`);
    applyRateLimitHeaders(reply, limit);
    if (!limit.allowed) {
      return reply.header("retry-after", Math.ceil(limit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    }
    const body = req.body as { currentPassword?: unknown; newPassword?: unknown };
    if (!body || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "currentPassword and newPassword are required" } });
    }
    if (body.newPassword.length < 8 || body.newPassword.length > 128) {
      return reply.status(400).send({ error: { code: "PASSWORD_INVALID_LENGTH", message: "New password must be between 8 and 128 characters" } });
    }
    const user = await userAuthStore.findById(principal.userId);
    if (!user) {
      return reply.status(404).send({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    }
    if (!verifyPassword(body.currentPassword, user.passwordHash)) {
      return reply.status(401).send({ error: { code: "INVALID_PASSWORD", message: "Current password is incorrect" } });
    }
    await userAuthStore.updatePassword(principal.userId, hashPassword(body.newPassword));
    await auditStore.log(principal.userId, "password_changed", "user", principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "2xx" });
    return reply.status(200).send({ ok: true });
  });

  app.get("/api/tunnels", async (req, reply) => {
    const endpoint = "/api/tunnels";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "tunnel", null, { path: "/api/tunnels", method: "GET" });
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiReadLimiter.take(`api:read:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!hasScope(principal.scopes, "tunnel:read")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:read" } });
    }
    const tunnels = await store.list(principal.userId);
    const toIso = (value?: number | null): string | null => (typeof value === "number" ? new Date(value).toISOString() : null);
    const describeTunnelState = (subdomain: string): {
      active: boolean;
      status: "live" | "reserved" | "offline";
      statusMessage: string;
      lastSeenAt: string | null;
      disconnectedAt: string | null;
      redirectUrl: string | null;
      publicHost: string | null;
      publicPort: number | null;
    } => {
      const liveSession = registry.findBySubdomain(subdomain);
      const redirectToken = redirectTokenByTunnelKey.get(subdomain);
      const redirectEntry = redirectToken ? redirectByToken.get(redirectToken) : undefined;
      const redirectUrl = redirectToken ? buildPublicUrl(`/r/${redirectToken}`) : null;
      const lastSeenAt = toIso(liveSession?.lastHeartbeatAt ?? redirectEntry?.lastSeenAt);
      const disconnectedAt = toIso(redirectEntry?.disconnectedAt);

      if (liveSession) {
        return {
          active: true,
          status: "live",
          statusMessage: "Client connected and forwarding traffic",
          lastSeenAt,
          disconnectedAt: null,
          redirectUrl,
          publicHost: redirectEntry?.publicHost ?? null,
          publicPort: redirectEntry?.publicPort ?? null,
        };
      }

      if (redirectEntry && redirectEntry.connected === false) {
        return {
          active: false,
          status: "offline",
          statusMessage: "Client machine is not reachable",
          lastSeenAt,
          disconnectedAt,
          redirectUrl,
          publicHost: redirectEntry.publicHost ?? null,
          publicPort: redirectEntry.publicPort ?? null,
        };
      }

      return {
        active: false,
        status: "reserved",
        statusMessage: "Reserved subdomain waiting for a client connection",
        lastSeenAt,
        disconnectedAt: null,
        redirectUrl,
        publicHost: redirectEntry?.publicHost ?? null,
        publicPort: redirectEntry?.publicPort ?? null,
      };
    };
    // Enrich each record with a live `active` flag so the UI can distinguish
    // DB-reserved subdomains from ones with an actual connected client.
    const dbSubdomains = new Set(tunnels.map((t) => t.subdomain));
    const enriched = tunnels.map((t) => {
      const state = describeTunnelState(t.subdomain);
      return {
        ...t,
        active: state.active,
        status: state.status,
        statusMessage: state.statusMessage,
        lastSeenAt: state.lastSeenAt,
        disconnectedAt: state.disconnectedAt,
        redirectUrl: state.redirectUrl,
        publicHost: state.publicHost,
        publicPort: state.publicPort,
      };
    });

    // Append live CLI sessions: tunnels registered via `portivox open` that have
    // no DB record (the client never called POST /api/tunnels to reserve a subdomain).
    // We identify these by cross-referencing ownershipBySubdomain (populated at
    // WebSocket registration time) against the registry's active sessions.
    // Subdomains whose redirect entry is a TCP tunnel — rendered by the tcp
    // block below (with publicTcpPort), so exclude them from the HTTP live list.
    const tcpSubdomains = new Set(
      [...redirectByToken.values()]
        .filter((e) => e.userId === principal.userId && e.tunnelType === "tcp" && !!e.subdomain)
        .map((e) => e.subdomain as string),
    );
    const liveSessions = registry.listSessions()
      .filter((s) => ownershipBySubdomain.get(s.subdomain) === principal.userId && !dbSubdomains.has(s.subdomain) && !tcpSubdomains.has(s.subdomain))
      .map((s) => {
        const redirectToken = redirectTokenByTunnelKey.get(s.subdomain);
        const redirectEntry = redirectToken ? redirectByToken.get(redirectToken) : undefined;
        const redirectUrl = redirectToken ? buildPublicUrl(`/r/${redirectToken}`) : null;
        return {
          id: `cli_${s.subdomain}`,
          userId: principal.userId,
          subdomain: s.subdomain,
          createdAt: new Date(s.connectedAt).toISOString(),
          active: true,
          status: "live",
          statusMessage: "Client connected and forwarding traffic",
          isCliSession: true,
          lastSeenAt: new Date(s.lastHeartbeatAt).toISOString(),
          disconnectedAt: null,
          redirectUrl,
          publicHost: redirectEntry?.publicHost ?? null,
          publicPort: redirectEntry?.publicPort ?? null,
        };
      });

    const seenOfflineCliSubdomains = new Set<string>();
    const offlineCliSessions = [...redirectByToken.entries()]
      .filter(([, entry]) =>
        entry.userId === principal.userId &&
        entry.tunnelType === "http" &&
        !!entry.subdomain &&
        !entry.connected &&
        !dbSubdomains.has(entry.subdomain))
      .flatMap(([token, entry]) => {
        if (!entry.subdomain || seenOfflineCliSubdomains.has(entry.subdomain)) {
          return [];
        }
        seenOfflineCliSubdomains.add(entry.subdomain);
        return [{
          id: `cli_offline_${entry.subdomain}`,
          userId: principal.userId,
          subdomain: entry.subdomain,
          createdAt: new Date(entry.createdAt).toISOString(),
          active: false,
          status: "offline" as const,
          statusMessage: "Client machine is not reachable",
          isCliSession: true,
          lastSeenAt: toIso(entry.lastSeenAt),
          disconnectedAt: toIso(entry.disconnectedAt),
          redirectUrl: buildPublicUrl(`/r/${token}`),
          publicHost: entry.publicHost ?? null,
          publicPort: entry.publicPort ?? null,
        }];
      });

    // ── TCP tunnels (random-port and admin fixed-port) ─────────────────────
    // Sourced from redirect entries so both live and offline TCP tunnels are
    // listed with their public host:port. Fixed-port tunnels have no subdomain
    // and are keyed by `tcpport_<port>` so the panel can remove them.
    const tcpSessions = [...redirectByToken.entries()]
      .filter(([, e]) => e.userId === principal.userId && e.tunnelType === "tcp" && !dbSubdomains.has(e.subdomain ?? ""))
      .flatMap(([token, e]) => {
        const isLive = e.subdomain ? !!registry.findBySubdomain(e.subdomain) : e.connected === true;
        const idBase = e.subdomain ? e.subdomain : `tcpport_${e.publicTcpPort}`;
        return [{
          id: isLive ? `cli_${idBase}` : `cli_offline_${idBase}`,
          userId: principal.userId,
          subdomain: e.subdomain ?? null,
          createdAt: new Date(e.createdAt).toISOString(),
          active: isLive,
          status: (isLive ? "live" : "offline") as "live" | "offline",
          statusMessage: isLive ? "Client connected and forwarding traffic" : "Client machine is not reachable",
          isCliSession: true,
          tunnelType: "tcp" as const,
          lastSeenAt: toIso(e.lastSeenAt),
          disconnectedAt: isLive ? null : toIso(e.disconnectedAt),
          redirectUrl: buildPublicUrl(`/r/${token}`),
          publicHost: e.publicTcpHost ?? null,
          publicPort: e.publicTcpPort ?? null,
          accessLink: e.accessLink ?? null,
        }];
      });

    const allTunnels = [...enriched, ...liveSessions, ...offlineCliSessions, ...tcpSessions];
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ count: allTunnels.length, tunnels: allTunnels });
  });

  app.get("/api/admin/tunnels", async (req, reply) => {
    const endpoint = "/api/admin/tunnels";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiReadLimiter.take(`api:read:admin_tunnels:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "tunnel:read")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:read" } });
    }

    const tunnels = await store.listAll();
    const toIso = (value?: number | null): string | null => (typeof value === "number" ? new Date(value).toISOString() : null);
    const describeTunnelState = (subdomain: string): {
      active: boolean;
      status: "live" | "reserved" | "offline";
      statusMessage: string;
      lastSeenAt: string | null;
      disconnectedAt: string | null;
      redirectUrl: string | null;
      publicHost: string | null;
      publicPort: number | null;
    } => {
      const liveSession = registry.findBySubdomain(subdomain);
      const redirectToken = redirectTokenByTunnelKey.get(subdomain);
      const redirectEntry = redirectToken ? redirectByToken.get(redirectToken) : undefined;
      const redirectUrl = redirectToken ? buildPublicUrl(`/r/${redirectToken}`) : null;
      const lastSeenAt = toIso(liveSession?.lastHeartbeatAt ?? redirectEntry?.lastSeenAt);
      const disconnectedAt = toIso(redirectEntry?.disconnectedAt);

      if (liveSession) {
        return {
          active: true,
          status: "live",
          statusMessage: "Client connected and forwarding traffic",
          lastSeenAt,
          disconnectedAt: null,
          redirectUrl,
          publicHost: redirectEntry?.publicHost ?? null,
          publicPort: redirectEntry?.publicPort ?? null,
        };
      }

      if (redirectEntry && redirectEntry.connected === false) {
        return {
          active: false,
          status: "offline",
          statusMessage: "Client machine is not reachable",
          lastSeenAt,
          disconnectedAt,
          redirectUrl,
          publicHost: redirectEntry.publicHost ?? null,
          publicPort: redirectEntry.publicPort ?? null,
        };
      }

      return {
        active: false,
        status: "reserved",
        statusMessage: "Reserved subdomain waiting for a client connection",
        lastSeenAt,
        disconnectedAt: null,
        redirectUrl,
        publicHost: redirectEntry?.publicHost ?? null,
        publicPort: redirectEntry?.publicPort ?? null,
      };
    };

    const dbSubdomains = new Set(tunnels.map((t) => t.subdomain));
    const enriched = tunnels.map((t) => {
      const state = describeTunnelState(t.subdomain);
      return {
        ...t,
        active: state.active,
        status: state.status,
        statusMessage: state.statusMessage,
        lastSeenAt: state.lastSeenAt,
        disconnectedAt: state.disconnectedAt,
        redirectUrl: state.redirectUrl,
        publicHost: state.publicHost,
        publicPort: state.publicPort,
      };
    });

    // TCP subdomains are rendered by the tcp block below (with publicTcpPort), so
    // exclude them from the HTTP live list to avoid duplicate rows.
    const tcpSubdomains = new Set(
      [...redirectByToken.values()]
        .filter((e) => e.tunnelType === "tcp" && !!e.subdomain)
        .map((e) => e.subdomain as string),
    );
    const liveSessions = registry.listSessions()
      .filter((s) => !dbSubdomains.has(s.subdomain) && !tcpSubdomains.has(s.subdomain))
      .map((s) => {
        const redirectToken = redirectTokenByTunnelKey.get(s.subdomain);
        const redirectEntry = redirectToken ? redirectByToken.get(redirectToken) : undefined;
        const redirectUrl = redirectToken ? buildPublicUrl(`/r/${redirectToken}`) : null;
        return {
          id: `cli_${s.subdomain}`,
          userId: ownershipBySubdomain.get(s.subdomain) ?? null,
          subdomain: s.subdomain,
          createdAt: new Date(s.connectedAt).toISOString(),
          active: true,
          status: "live" as const,
          statusMessage: "Client connected and forwarding traffic",
          isCliSession: true,
          lastSeenAt: new Date(s.lastHeartbeatAt).toISOString(),
          disconnectedAt: null,
          redirectUrl,
          publicHost: redirectEntry?.publicHost ?? null,
          publicPort: redirectEntry?.publicPort ?? null,
        };
      });

    const seenOfflineCliSubdomains = new Set<string>();
    const offlineCliSessions = [...redirectByToken.entries()]
      .filter(([, entry]) =>
        entry.tunnelType === "http" &&
        !!entry.subdomain &&
        !entry.connected &&
        !dbSubdomains.has(entry.subdomain))
      .flatMap(([token, entry]) => {
        if (!entry.subdomain || seenOfflineCliSubdomains.has(entry.subdomain)) {
          return [];
        }
        seenOfflineCliSubdomains.add(entry.subdomain);
        return [{
          id: `cli_offline_${entry.subdomain}`,
          userId: entry.userId ?? null,
          subdomain: entry.subdomain,
          createdAt: new Date(entry.createdAt).toISOString(),
          active: false,
          status: "offline" as const,
          statusMessage: "Client machine is not reachable",
          isCliSession: true,
          lastSeenAt: toIso(entry.lastSeenAt),
          disconnectedAt: toIso(entry.disconnectedAt),
          redirectUrl: buildPublicUrl(`/r/${token}`),
          publicHost: entry.publicHost ?? null,
          publicPort: entry.publicPort ?? null,
        }];
      });

    // TCP + port-only sessions (fixed-port TCP, random-port TCP, and port-only
    // HTTP tunnels for users without the subdomain subscription). These live in
    // redirectByToken as tunnelType "tcp" and — for the portless variants — are
    // not in the registry, so without this block they are invisible to admins.
    const tcpSessions = [...redirectByToken.entries()]
      .filter(([, e]) => e.tunnelType === "tcp" && !dbSubdomains.has(e.subdomain ?? ""))
      .flatMap(([token, e]) => {
        const isLive = e.subdomain ? !!registry.findBySubdomain(e.subdomain) : e.connected === true;
        const idBase = e.subdomain ? e.subdomain : `tcpport_${e.publicTcpPort}`;
        return [{
          id: isLive ? `cli_${idBase}` : `cli_offline_${idBase}`,
          userId: e.userId ?? (e.subdomain ? ownershipBySubdomain.get(e.subdomain) ?? null : null),
          subdomain: e.subdomain ?? null,
          createdAt: new Date(e.createdAt).toISOString(),
          active: isLive,
          status: (isLive ? "live" : "offline") as "live" | "offline",
          statusMessage: isLive ? "Client connected and forwarding traffic" : "Client machine is not reachable",
          isCliSession: true,
          tunnelType: "tcp" as const,
          lastSeenAt: toIso(e.lastSeenAt),
          disconnectedAt: isLive ? null : toIso(e.disconnectedAt),
          redirectUrl: buildPublicUrl(`/r/${token}`),
          publicHost: e.publicTcpHost ?? null,
          publicPort: e.publicTcpPort ?? null,
          accessLink: e.accessLink ?? null,
        }];
      });

    const allTunnels = [...enriched, ...liveSessions, ...offlineCliSessions, ...tcpSessions];
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ count: allTunnels.length, tunnels: allTunnels });
  });

  app.post("/api/tunnels", async (req, reply) => {
    const endpoint = "/api/tunnels";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "tunnel", null, { path: "/api/tunnels", method: "POST" });
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiWriteLimiter.take(`api:write:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!hasScope(principal.scopes, "tunnel:create")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:create" } });
    }

    const idempotencyKey = idempotencyEnabled ? readIdempotencyKey(req.headers as Record<string, unknown>) : "";
    const idempotencyStoreKey = idempotencyKey ? makeIdempotencyStoreKey(principal.userId, endpoint, idempotencyKey) : "";
    if (idempotencyStoreKey) {
      const replay = readIdempotencyReplay(idempotencyStoreKey);
      if (replay) {
        reply.header("x-idempotent-replay", "true");
        reply.header("content-type", replay.contentType);
        return reply.status(replay.statusCode).send(replay.body);
      }
    }

    const body = parseCreateTunnelBody(req.body);
    if (!body) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "INVALID_SUBDOMAIN" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(400).send({ error: { code: "INVALID_SUBDOMAIN", message: "Body must include only { subdomain: string }" } });
    }
    const subdomain = body.subdomain;
    if (!/^[a-z0-9-]{3,32}$/.test(subdomain) || subdomain.startsWith("-") || subdomain.endsWith("-")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "INVALID_SUBDOMAIN" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(400).send({ error: { code: "INVALID_SUBDOMAIN", message: "Subdomain must be 3-32 chars (a-z, 0-9, -)" } });
    }

    const created = await store.create(principal.userId, subdomain);
    await auditStore.log(principal.userId, "tunnel_created", "tunnel", created.id, { subdomain: created.subdomain });
    publishLiveEvent("tunnels_changed", principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "2xx" });
    const responseBody = { tunnel: created };
    if (idempotencyStoreKey) {
      writeIdempotencyReplay(idempotencyStoreKey, { statusCode: 201, body: responseBody, contentType: "application/json" });
    }
    return reply.status(201).send(responseBody);
  });

  app.delete("/api/tunnels/:id", async (req, reply) => {
    const endpoint = "/api/tunnels/:id";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "tunnel", null, { path: "/api/tunnels/:id", method: "DELETE" });
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiWriteLimiter.take(`api:write:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!hasScope(principal.scopes, "tunnel:delete")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:delete" } });
    }

    const idempotencyKey = idempotencyEnabled ? readIdempotencyKey(req.headers as Record<string, unknown>) : "";
    const idempotencyStoreKey = idempotencyKey ? makeIdempotencyStoreKey(principal.userId, endpoint, idempotencyKey) : "";
    if (idempotencyStoreKey) {
      const replay = readIdempotencyReplay(idempotencyStoreKey);
      if (replay) {
        reply.header("x-idempotent-replay", "true");
        reply.header("content-type", replay.contentType);
        return reply.status(replay.statusCode).send(replay.body);
      }
    }

    const params = req.params as { id: string };
    const id = params.id;
    const ownsSubdomain = (subdomain: string): boolean => {
      if (isPlatformAdmin(principal.role)) return true;
      if (ownershipBySubdomain.get(subdomain) === principal.userId) return true;
      const rToken = redirectTokenByTunnelKey.get(subdomain);
      const rEntry = rToken ? redirectByToken.get(rToken) : undefined;
      return rEntry?.userId === principal.userId;
    };
    const finish = (): void => {
      publishLiveEvent("tunnels_changed", principal.userId);
      publishLiveEvent("gateway_status_changed");
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "2xx" });
      if (idempotencyStoreKey) {
        writeIdempotencyReplay(idempotencyStoreKey, { statusCode: 204, body: null, contentType: "application/json" });
      }
    };

    // ── CLI session (live/offline, no DB record) ────────────────────────────
    // These are tunnels opened via `portivox open` that never reserved a DB
    // subdomain. The id is `cli_<raw>` / `cli_offline_<raw>` where <raw> is a
    // subdomain, or `tcpport_<port>` for admin fixed-port TCP tunnels (which use
    // a synthetic key instead of a subdomain). Removing one terminates the
    // connected client's tunnel.
    if (id.startsWith("cli_offline_") || id.startsWith("cli_")) {
      const raw = id.startsWith("cli_offline_")
        ? id.slice("cli_offline_".length)
        : id.slice("cli_".length);
      const tunnelKey = raw.startsWith("tcpport_")
        ? `__tcp_port_${raw.slice("tcpport_".length)}__`
        : raw;
      if (!tunnelKey) {
        return reply.status(404).send({ error: { code: "TUNNEL_NOT_FOUND", message: "Tunnel not found" } });
      }
      if (!ownsSubdomain(tunnelKey)) {
        metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "FORBIDDEN" });
        metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Tunnel does not belong to this principal" } });
      }
      const wasLive = revokeLiveTunnel(tunnelKey, "removed_by_owner");
      purgeRedirectForKey(tunnelKey);
      await releaseTcpTunnelBySubdomain(tunnelKey);
      ownershipBySubdomain.delete(tunnelKey);
      await auditStore.log(principal.userId, "tunnel_revoked", "tunnel_session", tunnelKey, { wasLive });
      finish();
      return reply.status(204).send();
    }

    // ── DB-reserved tunnel: id is a stored record ───────────────────────────
    const existing = await store.findById(id);
    if (!existing) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "TUNNEL_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(404).send({ error: { code: "TUNNEL_NOT_FOUND", message: "Tunnel not found" } });
    }

    if (existing.userId !== principal.userId && !isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "FORBIDDEN" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Tunnel does not belong to this principal" } });
    }

    await store.delete(id);
    // Also terminate any live client currently connected on this subdomain, so
    // deleting the reservation actually stops traffic instead of leaving a
    // ghost tunnel running until the client happens to disconnect.
    revokeLiveTunnel(existing.subdomain, "removed_by_owner");
    purgeRedirectForKey(existing.subdomain);
    await releaseTcpTunnelBySubdomain(existing.subdomain);
    await auditStore.log(principal.userId, "tunnel_deleted", "tunnel", id);
    finish();
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Devices: the roster of machines that have connected a client for this user.
  // ---------------------------------------------------------------------------

  app.get("/api/devices", async (req, reply) => {
    const endpoint = "/api/devices";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiReadLimiter.take(`api:read:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429).send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isAdminRole(principal.role) || !hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "FORBIDDEN" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing role or scope key:manage" } });
    }
    const devices = (await deviceStore.list(principal.userId)).map((d) => ({ ...d, online: isDeviceOnline(d.deviceId) }));
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ count: devices.length, devices });
  });

  app.delete("/api/devices/:id", async (req, reply) => {
    const endpoint = "/api/devices/:id";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiWriteLimiter.take(`api:write:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429).send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isAdminRole(principal.role) || !hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "FORBIDDEN" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing role or scope key:manage" } });
    }
    const { id } = req.params as { id: string };
    const deviceId = await deviceStore.remove(principal.userId, id);
    if (!deviceId) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "DEVICE_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(404).send({ error: { code: "DEVICE_NOT_FOUND", message: "Device not found" } });
    }
    // Disconnect any live sockets from that device (it is being forgotten).
    const disconnected = disconnectSocketsForDevice(deviceId, "device_forgotten");
    await auditStore.log(principal.userId, "device_forgotten", "device", id, { deviceId, disconnected });
    publishLiveEvent("devices_changed", principal.userId);
    if (disconnected > 0) publishLiveEvent("tunnels_changed", principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "2xx" });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Usage: bytes relayed + request latency for the current user (since gateway
  // start; in-memory, no quota enforcement).
  // ---------------------------------------------------------------------------

  app.get("/api/usage", async (req, reply) => {
    const endpoint = "/api/usage";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiReadLimiter.take(`api:read:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429).send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    const stats = usage.get(principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ ...stats, since: new Date(meteringSince).toISOString() });
  });

  app.post("/api/keys", async (req, reply) => {
    const endpoint = "/api/keys";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "api_key", null, { path: "/api/keys", method: "POST" });
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiWriteLimiter.take(`api:write:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    // Allow JWT principals (normal auth) and anonymous principal (AUTH_REQUIRED=false dev mode).
    // API-key principals are intentionally blocked: using a key to mint more keys is a privilege escalation risk.
    if (principal.authType !== "jwt" && principal.authType !== "anonymous") {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "JWT_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "JWT principal required for API key issuance" } });
    }
    if (!isAdminRole(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Admin or owner role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    const idempotencyKey = idempotencyEnabled ? readIdempotencyKey(req.headers as Record<string, unknown>) : "";
    const idempotencyStoreKey = idempotencyKey ? makeIdempotencyStoreKey(principal.userId, endpoint, idempotencyKey) : "";
    if (idempotencyStoreKey) {
      const replay = readIdempotencyReplay(idempotencyStoreKey);
      if (replay) {
        reply.header("x-idempotent-replay", "true");
        reply.header("content-type", replay.contentType);
        return reply.status(replay.statusCode).send(replay.body);
      }
    }
    const body = parseCreateApiKeyBody(req.body);
    if (!body) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "INVALID_NAME" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(400).send({ error: { code: "INVALID_NAME", message: "Body must include { name: string(1-64) } and optional scopes string" } });
    }
    const name = body.name;
    const plaintext = `tk_${randomBytes(24).toString("hex")}`;
    // Prevent privilege amplification: a principal may only grant scopes it
    // already holds. Without this, any caller with key:manage could mint a key
    // carrying admin:* or "*" and escalate. Platform admins (wildcard scope)
    // may grant anything. Non-admins get the intersection of requested and held.
    const requestedScopes = parseScopes(body.scopesRaw, ["tunnel:create", "tunnel:read", "tunnel:delete"]);
    const canGrantAnyScope = isPlatformAdmin(principal.role) || principal.scopes.includes("*");
    const scopes = canGrantAnyScope
      ? requestedScopes
      : requestedScopes.filter((scope) => hasScope(principal.scopes, scope));
    if (scopes.length === 0) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "NO_GRANTABLE_SCOPES" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "None of the requested scopes may be granted by this principal" } });
    }
    const created = await authStore.createApiKey(principal.userId, name, hashApiKey(plaintext), scopes);
    await auditStore.log(principal.userId, "api_key_created", "api_key", created.id, { name: created.name });
    publishLiveEvent("api_keys_changed", principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "2xx" });
    const responseBody = { apiKey: { id: created.id, name: created.name, createdAt: created.createdAt, scopes: created.scopes, token: plaintext } };
    if (idempotencyStoreKey) {
      writeIdempotencyReplay(idempotencyStoreKey, { statusCode: 201, body: responseBody, contentType: "application/json" });
    }
    return reply.status(201).send(responseBody);
  });

  app.get("/api/keys", async (req, reply) => {
    const endpoint = "/api/keys";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "api_key", null, { path: "/api/keys", method: "GET" });
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiReadLimiter.take(`api:read:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isAdminRole(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Admin or owner role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const keys = await authStore.listApiKeys(principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({
      count: keys.length,
      keys: keys.map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, revoked: item.revoked, scopes: item.scopes })),
    });
  });

  app.delete("/api/keys/:id", async (req, reply) => {
    const endpoint = "/api/keys/:id";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "api_key", null, { path: "/api/keys/:id", method: "DELETE" });
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiWriteLimiter.take(`api:write:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isAdminRole(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Admin or owner role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const idempotencyKey = idempotencyEnabled ? readIdempotencyKey(req.headers as Record<string, unknown>) : "";
    const idempotencyStoreKey = idempotencyKey ? makeIdempotencyStoreKey(principal.userId, endpoint, idempotencyKey) : "";
    if (idempotencyStoreKey) {
      const replay = readIdempotencyReplay(idempotencyStoreKey);
      if (replay) {
        reply.header("x-idempotent-replay", "true");
        reply.header("content-type", replay.contentType);
        return reply.status(replay.statusCode).send(replay.body);
      }
    }
    const params = req.params as { id: string };
    const revokedHash = await authStore.revokeApiKey(principal.userId, params.id);
    if (!revokedHash) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "API_KEY_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(404).send({ error: { code: "API_KEY_NOT_FOUND", message: "API key not found" } });
    }
    // Immediately disconnect any live device authenticated with this key.
    const disconnectedDevices = disconnectSocketsForApiKey(revokedHash, "key_revoked");
    await auditStore.log(principal.userId, "api_key_deleted", "api_key", params.id, { disconnectedDevices });
    publishLiveEvent("api_keys_changed", principal.userId);
    publishLiveEvent("tunnels_changed", principal.userId);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "2xx" });
    if (idempotencyStoreKey) {
      writeIdempotencyReplay(idempotencyStoreKey, { statusCode: 204, body: null, contentType: "application/json" });
    }
    return reply.status(204).send();
  });

  app.post("/api/admin/state", async (req, reply) => {
    const endpoint = "/api/admin/state";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const idempotencyKey = idempotencyEnabled ? readIdempotencyKey(req.headers as Record<string, unknown>) : "";
    const idempotencyStoreKey = idempotencyKey ? makeIdempotencyStoreKey(principal.userId, endpoint, idempotencyKey) : "";
    if (idempotencyStoreKey) {
      const replay = readIdempotencyReplay(idempotencyStoreKey);
      if (replay) {
        reply.header("x-idempotent-replay", "true");
        reply.header("content-type", replay.contentType);
        return reply.status(replay.statusCode).send(replay.body);
      }
    }

    const body = parseAdminStateBody(req.body);
    if (!body) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "INVALID_ADMIN_STATE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(400).send({
        error: { code: "INVALID_ADMIN_STATE", message: "Body must include at least one of { maintenanceMode:boolean, draining:boolean } with no extra fields" },
      });
    }
    applyOperationalState({
      maintenanceMode: body.maintenanceMode,
      draining: body.draining,
    }, "admin_api");

    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "2xx" });
    const responseBody = gatewayState();
    if (idempotencyStoreKey) {
      writeIdempotencyReplay(idempotencyStoreKey, { statusCode: 200, body: responseBody, contentType: "application/json" });
    }
    return reply.status(200).send(responseBody);
  });

  app.get("/api/admin/chunk-diagnostics", async (req, reply) => {
    const endpoint = "/api/admin/chunk-diagnostics";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({
      chunkFramesReceived: chunkDiagnostics.chunkFramesReceived,
      chunkStreamsReassembled: chunkDiagnostics.chunkStreamsReassembled,
      chunkIncompleteTimeouts: chunkDiagnostics.chunkIncompleteTimeouts,
      activeChunkAssemblies: responseChunksByStream.size,
    });
  });

  app.get("/api/audit", async (req, reply) => {
    const endpoint = "/api/audit";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply
        .header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000))
        .status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    const query = req.query as Record<string, string | undefined>;
    const limitRaw = Number(query.limit ?? "50");
    const limit = Number.isInteger(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;
    const parseDate = (value?: string): Date | undefined => {
      if (!value) return undefined;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    };
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    const result = await auditStore.query({
      userId: query.userId,
      action: query.action,
      resource: query.resource,
      from,
      to,
      cursor: query.cursor,
      limit,
    });

    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({
      count: result.items.length,
      nextCursor: result.nextCursor,
      items: result.items,
    });
  });

  // ---------------------------------------------------------------------------
  // Admin: TCP port mapping CRUD
  // ---------------------------------------------------------------------------

  app.get("/api/admin/tcp-port-mappings", async (req, reply) => {
    const endpoint = "/api/admin/tcp-port-mappings";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const mappings = await tcpPortMappingStore.list();
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ mappings });
  });

  app.post("/api/admin/tcp-port-mappings", async (req, reply) => {
    const endpoint = "/api/admin/tcp-port-mappings";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    // Validate body
    const body = req.body as Record<string, unknown> | null;
    if (!isPlainObject(body)) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "Request body must be a JSON object" } });
    }
    const { name, localPort, publicPort, description } = body as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "name is required (non-empty string)" } });
    }
    const lp = Number(localPort);
    const pp = Number(publicPort);
    if (!Number.isInteger(lp) || lp < 1 || lp > 65535) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "localPort must be an integer 1–65535" } });
    }
    if (!Number.isInteger(pp) || pp < 1 || pp > 65535) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "publicPort must be an integer 1–65535" } });
    }

    // Conflict check — publicPort must be globally unique across all mappings
    const existing = await tcpPortMappingStore.list();
    if (existing.some((m) => m.publicPort === pp)) {
      return reply.status(409).send({ error: { code: "CONFLICT", message: `publicPort ${pp} is already reserved by another mapping` } });
    }
    if (existing.some((m) => m.localPort === lp)) {
      return reply.status(409).send({ error: { code: "CONFLICT", message: `A mapping for localPort ${lp} already exists` } });
    }

    const mapping = await tcpPortMappingStore.create({
      name: String(name).trim(),
      localPort: lp,
      publicPort: pp,
      description: typeof description === "string" && description.trim() ? description.trim() : null,
      enabled: true,
    });
    void auditStore.log(principal.userId, "tcp_port_mapping_created", "tcp_port_mapping", mapping.id, {
      localPort: lp, publicPort: pp,
    });
    publishLiveEvent("tcp_mappings_changed");
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "2xx" });
    return reply.status(201).send({ mapping });
  });

  app.patch("/api/admin/tcp-port-mappings/:id", async (req, reply) => {
    const endpoint = "/api/admin/tcp-port-mappings/:id";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | null;
    if (!isPlainObject(body)) {
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "Request body must be a JSON object" } });
    }
    const patch: { enabled?: boolean; name?: string; description?: string } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.description === "string") patch.description = body.description.trim() || "";

    const updated = await tcpPortMappingStore.update(id, patch);
    if (!updated) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "TCP port mapping not found" } });
    }
    void auditStore.log(principal.userId, "tcp_port_mapping_updated", "tcp_port_mapping", id, patch);
    publishLiveEvent("tcp_mappings_changed");
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "2xx" });
    return reply.status(200).send({ mapping: updated });
  });

  app.delete("/api/admin/tcp-port-mappings/:id", async (req, reply) => {
    const endpoint = "/api/admin/tcp-port-mappings/:id";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    const { id } = req.params as { id: string };
    const deleted = await tcpPortMappingStore.delete(id);
    if (!deleted) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "TCP port mapping not found" } });
    }
    void auditStore.log(principal.userId, "tcp_port_mapping_deleted", "tcp_port_mapping", id);
    publishLiveEvent("tcp_mappings_changed");
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "2xx" });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Admin: user subscription entitlements (subdomain feature toggle).
  // ---------------------------------------------------------------------------

  app.get("/api/admin/users", async (req, reply) => {
    const endpoint = "/api/admin/users";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    const users = await userAuthStore.listUsers();
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ users });
  });

  app.patch("/api/admin/users/:id", async (req, reply) => {
    const endpoint = "/api/admin/users/:id";
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "UNAUTHORIZED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    const apiLimit = apiAdminLimiter.take(`api:admin:${principal.userId}`);
    applyRateLimitHeaders(reply, apiLimit);
    if (!apiLimit.allowed) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.header("retry-after", Math.ceil(apiLimit.retryAfterMs / 1000)).status(429)
        .send({ error: { code: "RATE_LIMITED", message: "API request limit exceeded" } });
    }
    if (!isPlatformAdmin(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Platform admin role required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "MISSING_SCOPE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }

    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | null;
    if (!isPlainObject(body) || !hasOnlyAllowedKeys(body, ["subdomainEnabled"]) || typeof body.subdomainEnabled !== "boolean") {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "INVALID_BODY" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(400).send({ error: { code: "INVALID_BODY", message: "Body must be { subdomainEnabled: boolean }" } });
    }

    const updated = await userAuthStore.setSubdomainEnabled(id, body.subdomainEnabled);
    if (!updated) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "User not found" } });
    }
    void auditStore.log(principal.userId, "user_subdomain_entitlement_changed", "user", id, { subdomainEnabled: body.subdomainEnabled });
    publishLiveEvent("users_changed");
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "2xx" });
    return reply.status(200).send({ user: updated });
  });

  // ---------------------------------------------------------------------------
  // Traffic Inspector: per-subdomain ring buffer of captured HTTP exchanges.
  // ---------------------------------------------------------------------------

  /** GET /api/inspect/:subdomain — list captured requests (no bodies, summary view) */
  app.get("/api/inspect/:subdomain", async (req, reply) => {
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "tunnel:read")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:read" } });
    }
    const { subdomain } = req.params as { subdomain: string };
    // Ownership check: non-admin users may only inspect their own tunnels.
    const tunnelOwner = ownershipBySubdomain.get(subdomain);
    // Deny unless the caller owns this tunnel or is a platform admin. Note this
    // is fail-CLOSED: when tunnelOwner is undefined (e.g. the tunnel already
    // disconnected) a non-admin caller is rejected rather than allowed, so a
    // disconnected tunnel's captured traffic can never leak cross-tenant.
    if (!isPlatformAdmin(principal.role) && tunnelOwner !== principal.userId) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Not your tunnel" } });
    }
    const ring = capturedRequests.get(subdomain) ?? [];
    return reply.status(200).send({
      subdomain,
      count: ring.length,
      requests: ring.map(({ requestBodyBase64: _rb, responseBodyBase64: _sb, requestHeaders: _rh, responseHeaders: _sh, ...summary }) => summary),
    });
  });

  /** GET /api/inspect/:subdomain/:reqId — full request detail including bodies */
  app.get("/api/inspect/:subdomain/:reqId", async (req, reply) => {
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "tunnel:read")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:read" } });
    }
    const { subdomain, reqId } = req.params as { subdomain: string; reqId: string };
    // Ownership check: non-admin users may only inspect their own tunnels.
    const tunnelOwner = ownershipBySubdomain.get(subdomain);
    // Deny unless the caller owns this tunnel or is a platform admin. Note this
    // is fail-CLOSED: when tunnelOwner is undefined (e.g. the tunnel already
    // disconnected) a non-admin caller is rejected rather than allowed, so a
    // disconnected tunnel's captured traffic can never leak cross-tenant.
    if (!isPlatformAdmin(principal.role) && tunnelOwner !== principal.userId) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Not your tunnel" } });
    }
    const ring = capturedRequests.get(subdomain) ?? [];
    const entry = ring.find((r) => r.id === reqId);
    if (!entry) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Captured request not found" } });
    }
    return reply.status(200).send({ request: entry });
  });

  /** DELETE /api/inspect/:subdomain — clear the ring buffer for a tunnel */
  app.delete("/api/inspect/:subdomain", async (req, reply) => {
    const principal = await resolvePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!isPlatformAdmin(principal.role) && !hasScope(principal.scopes, "tunnel:delete")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Admin role or tunnel:delete scope required" } });
    }
    const { subdomain } = req.params as { subdomain: string };
    // Ownership check: non-admin users may only clear their own tunnel's buffer.
    const tunnelOwner = ownershipBySubdomain.get(subdomain);
    // Deny unless the caller owns this tunnel or is a platform admin. Note this
    // is fail-CLOSED: when tunnelOwner is undefined (e.g. the tunnel already
    // disconnected) a non-admin caller is rejected rather than allowed, so a
    // disconnected tunnel's captured traffic can never leak cross-tenant.
    if (!isPlatformAdmin(principal.role) && tunnelOwner !== principal.userId) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Not your tunnel" } });
    }
    capturedRequests.delete(subdomain);
    publishLiveEvent("inspector_changed", tunnelOwner ?? principal.userId, subdomain);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // IP Link Protection: whitelist caller's IP via one-time access link.
  // Unauthenticated — the token itself is the credential. Rate-limited via the
  // public ingress limiter to prevent token-scanning brute force.
  // ---------------------------------------------------------------------------
  app.get("/l/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const ipLimit = tunnelIngressLimiter.take(`access_link:${req.ip}`);
    applyRateLimitHeaders(reply, ipLimit);
    if (!ipLimit.allowed) {
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    }

    const entry = ipAccessByToken.get(token);
    if (!entry) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Invalid or expired access token" } });
    }

    // Normalize IPv4-mapped IPv6 addresses.
    const ip = req.ip.replace(/^::ffff:/, "");
    const now = Date.now();
    // Evict expired IPs before inserting so a long-lived tunnel hit by many
    // distinct source IPs doesn't accumulate them unbounded (they're only
    // lazily checked at connect time otherwise, never removed).
    for (const [seenIp, seenExpiry] of entry.allowedIps) {
      if (now > seenExpiry) {
        entry.allowedIps.delete(seenIp);
      }
    }
    const expiresAt = now + 24 * 60 * 60 * 1000;  // 24 hours
    entry.allowedIps.set(ip, expiresAt);

    // Resolve the public endpoint (host:port) this token guards, for display.
    const binding = tcpBindingsBySubdomain.get(entry.tunnelKey);
    const publicHost = resolveTcpPublicHost();
    const publicPort = binding?.publicPort ?? null;
    const endpoint = publicPort ? `${publicHost}:${publicPort}` : null;
    const online = !!binding;

    // Human visitors get a friendly confirmation page; API clients (Accept
    // without text/html) get the JSON payload unchanged.
    const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
    if (!acceptsHtml) {
      return reply.status(200).send({
        whitelisted: true,
        ip,
        endpoint,
        online,
        expiresAt: new Date(expiresAt).toISOString(),
        message: `IP ${ip} has been whitelisted for 24 hours. You may now connect${endpoint ? ` to ${endpoint}` : ""}.`,
      });
    }

    const esc = (value: string): string =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const openHref = endpoint ? `http://${esc(endpoint)}` : null;
    const html = renderAccessGrantedPage({
      endpoint: endpoint ? esc(endpoint) : null,
      openHref,
      ip: esc(ip),
      online,
      expiresLabel: new Date(expiresAt).toUTCString(),
    });
    return reply
      .status(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(html);
  });

  // ---------------------------------------------------------------------------
  // Stable Redirect URL: returns current tunnel status as JSON.
  // Survives reconnects — the token is stable for the lifetime of the tunnel.
  // ---------------------------------------------------------------------------
  app.get("/r/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const ipLimit = tunnelIngressLimiter.take(`redirect:${req.ip}`);
    applyRateLimitHeaders(reply, ipLimit);
    if (!ipLimit.allowed) {
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    }

    const entry = redirectByToken.get(token);
    if (!entry) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Unknown redirect token" } });
    }

    return reply.status(200).send({
      connected: entry.connected,
      tunnelType: entry.tunnelType,
      subdomain: entry.subdomain ?? null,
      publicHost: entry.publicHost ?? null,
      publicPort: entry.publicPort ?? null,
      publicTcpPort: entry.publicTcpPort ?? null,
      publicTcpHost: entry.publicTcpHost ?? null,
      accessLink: entry.accessLink ?? null,
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
      disconnectedAt: entry.disconnectedAt ? new Date(entry.disconnectedAt).toISOString() : null,
    });
  });

  app.all("/*", async (req, reply) => {
    if (!isReady || isDraining || maintenanceMode) {
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "gateway", error_code: "SERVICE_UNAVAILABLE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "gateway", method: req.method, status_class: "5xx" });
      return reply.status(503).send({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Gateway is not ready to accept traffic",
        },
      });
    }

    const startedAt = Date.now();
    metrics.increment("gateway_requests_total");

    if (req.url.startsWith("/api/") || req.url === "/healthz" || req.url.startsWith("/healthz/")) {
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "ROUTE_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "4xx" });
      return reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } });
    }

    const subdomain = extractSubdomain(req.headers.host, config.rootDomain);
    if (!subdomain) {
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "INVALID_HOST" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "4xx" });
      const errorPayload = toErrorPayload(badRequest("INVALID_HOST", "Invalid host or missing subdomain"), "BAD_REQUEST", "Invalid request");
      return reply.status(errorPayload.statusCode).send(errorPayload.body);
    }

    const tunnel = registry.findBySubdomain(subdomain);
    if (!tunnel) {
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "TUNNEL_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "4xx" });
      const errorPayload = toErrorPayload(notFound("TUNNEL_NOT_FOUND", "No active tunnel for subdomain"), "NOT_FOUND", "Resource not found");
      return reply.status(errorPayload.statusCode).send(errorPayload.body);
    }

    const ingressLimit = tunnelIngressLimiter.take(`ingress:${subdomain}`);
    applyRateLimitHeaders(reply, ingressLimit);
    if (!ingressLimit.allowed) {
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "RATE_LIMITED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "4xx" });
      const errorPayload = toErrorPayload(
        badRequest("INGRESS_RATE_LIMITED", "Tunnel ingress rate limit exceeded"),
        "RATE_LIMITED",
        "Ingress rate limited",
      );
      return reply.header("retry-after", Math.ceil(ingressLimit.retryAfterMs / 1000)).status(429).send(errorPayload.body);
    }

    const streamId = randomUUID();
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readRequestBody(req.raw, config.maxRequestBodyBytes);
    } catch (error) {
      app.log.warn({ error }, "Rejected request body");
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "REQUEST_BODY_TOO_LARGE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "4xx" });
      const errorPayload = toErrorPayload(badRequest("REQUEST_BODY_TOO_LARGE", "Request body too large"), "BAD_REQUEST", "Invalid request");
      return reply.status(413).send(errorPayload.body);
    }

    // ── Inspector capture ──────────────────────────────────────────────────
    const reqBodyB64 = bodyBuffer.byteLength > MAX_INSPECT_BODY_BYTES
      ? bodyBuffer.slice(0, MAX_INSPECT_BODY_BYTES).toString("base64")
      : bodyBuffer.toString("base64");
    const captured: CapturedRequest = {
      id: streamId,
      capturedAt: startedAt,
      durationMs: null,
      method: req.method,
      path: req.url,
      statusCode: null,
      requestHeaders: req.headers as Record<string, string | string[] | undefined>,
      responseHeaders: {},
      requestBodyBase64: reqBodyB64,
      requestBodyTruncated: bodyBuffer.byteLength > MAX_INSPECT_BODY_BYTES,
      responseBodyBase64: "",
      responseBodyTruncated: false,
      error: null,
    };
    {
      const ring = capturedRequests.get(subdomain) ?? [];
      ring.unshift(captured);
      if (ring.length > MAX_INSPECT_PER_TUNNEL) ring.length = MAX_INSPECT_PER_TUNNEL;
      capturedRequests.set(subdomain, ring);
    }
    publishLiveEvent("inspector_changed", ownershipBySubdomain.get(subdomain) ?? null, subdomain);

    // Strip proxy/forwarded headers supplied by the external caller before
    // forwarding — the gateway sets these itself from verified request metadata,
    // preventing clients from spoofing their IP or host to backend apps.
    const inboundHeaders = filterHopByHopHeaders(req.headers);
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"]) {
      delete (inboundHeaders as Record<string, unknown>)[h];
    }

    const outbound: HttpRequest = {
      type: "http_request",
      streamId,
      method: req.method,
      path: req.url,
      headers: {
        ...inboundHeaders,
        "x-forwarded-for": req.ip,
        "x-forwarded-proto": req.headers["x-forwarded-proto"] === "https" ? "https" : "http",
        "x-tunnel-request-id": String(req.id),
      },
      bodyBase64: bodyBuffer.toString("base64"),
    };

    // Set inside the (synchronous) promise executor when the stream is admitted.
    // Guards the send below so an over-limit request is NOT forwarded to an
    // already-saturated client (which would drop the response and double load).
    let accepted = false;
    const responsePromise = new Promise<HttpResponse>((resolve, reject) => {
      const inflightForSocket = activeStreamsBySocket.get(tunnel.socket);
      const maxConcurrent = config.maxConcurrentStreamsPerTunnel ?? 200;
      if (inflightForSocket && inflightForSocket.size >= maxConcurrent) {
        metrics.increment("gateway_request_errors_total");
        reject(new Error("TUNNEL_STREAM_LIMIT_EXCEEDED"));
        return;
      }

      accepted = true;
      responseWaiters.set(streamId, resolve);
      streamRejecters.set(streamId, reject);
      activeStreamsBySocket.get(tunnel.socket)?.add(streamId);
      armStreamIdleTimeout(streamId, tunnel.socket);
    });

    if (accepted) {
      tunnel.socket.send(encodeWireMessage(outbound));
    }

    try {
      const tunnelResponse = await responsePromise;
      const timeout = streamTimeouts.get(streamId);
      if (timeout) {
        clearTimeout(timeout);
        streamTimeouts.delete(streamId);
      }
      streamRejecters.delete(streamId);
      metrics.observeRequestLatency(Date.now() - startedAt);
      reply.code(tunnelResponse.statusCode);
      // Strip hop-by-hop headers, then pass everything else through to the browser.
      const responseHeaders = filterHopByHopHeaders(tunnelResponse.headers);

      // Rewrite absolute Location headers that point to localhost so that
      // server-side redirects (301/302/307/308) keep the browser on the public
      // tunnel URL instead of sending it to an unreachable localhost address.
      const rawLocation = (responseHeaders as Record<string, unknown>)["location"];
      if (typeof rawLocation === "string" && rawLocation.length > 0) {
        try {
          const loc = new URL(rawLocation);
          if (
            loc.hostname === "localhost" ||
            loc.hostname === "127.0.0.1" ||
            /^127\./.test(loc.hostname) ||
            loc.hostname === "::1" ||
            loc.hostname.endsWith(".localhost")
          ) {
            loc.protocol = "https:";
            loc.host = `${subdomain}.${config.rootDomain}`;
            (responseHeaders as Record<string, unknown>)["location"] = loc.toString();
          }
        } catch {
          // Relative redirect (e.g. "/login") — already correct, leave as-is.
        }
      }

      for (const [key, value] of Object.entries(responseHeaders)) {
        if (typeof value !== "undefined" && !BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
          reply.header(key, value as string | string[] | number);
        }
      }
      const respBody = Buffer.from(tunnelResponse.bodyBase64, "base64");
      // Usage metering: attribute request/response bytes + latency to the owner.
      usage.recordRequest(ownershipBySubdomain.get(subdomain) ?? null, Date.now() - startedAt, bodyBuffer.byteLength, respBody.byteLength);
      captured.durationMs = Date.now() - startedAt;
      captured.statusCode = tunnelResponse.statusCode;
      captured.responseHeaders = responseHeaders as Record<string, string | string[] | undefined>;
      captured.responseBodyBase64 = respBody.byteLength > MAX_INSPECT_BODY_BYTES
        ? respBody.slice(0, MAX_INSPECT_BODY_BYTES).toString("base64")
        : tunnelResponse.bodyBase64;
      captured.responseBodyTruncated = respBody.byteLength > MAX_INSPECT_BODY_BYTES;
      publishLiveEvent("inspector_changed", ownershipBySubdomain.get(subdomain) ?? null, subdomain);
      reply.send(respBody);
    } catch (error) {
      const timeout = streamTimeouts.get(streamId);
      if (timeout) {
        clearTimeout(timeout);
        streamTimeouts.delete(streamId);
      }
      streamRejecters.delete(streamId);
      const code = error instanceof Error ? error.message : "UNKNOWN_STREAM_ERROR";
      captured.durationMs = Date.now() - startedAt;
      captured.error = code;
      publishLiveEvent("inspector_changed", ownershipBySubdomain.get(subdomain) ?? null, subdomain);
      if (code === "TUNNEL_STREAM_LIMIT_EXCEEDED") {
        metrics.increment("gateway_request_errors_total");
        metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "TUNNEL_STREAM_LIMIT_EXCEEDED" });
        metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "4xx" });
        const errorPayload = toErrorPayload(
          badRequest("TUNNEL_STREAM_LIMIT_EXCEEDED", "Tunnel has reached concurrent stream limit"),
          "TOO_MANY_STREAMS",
          "Tunnel stream limit exceeded",
        );
        reply.status(429).send(errorPayload.body);
        return;
      }
      if (code === "TUNNEL_STREAM_IDLE_TIMEOUT") {
        metrics.increment("gateway_request_errors_total");
        metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "TUNNEL_STREAM_IDLE_TIMEOUT" });
        metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "5xx" });
        const errorPayload = toErrorPayload(
          gatewayTimeout("TUNNEL_STREAM_IDLE_TIMEOUT", "No response from tunnel client within idle timeout"),
          "GATEWAY_TIMEOUT",
          "Gateway timeout",
        );
        reply.status(errorPayload.statusCode).send(errorPayload.body);
        return;
      }
      metrics.increment("gateway_request_errors_total");
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint: "tunnel_ingress", error_code: "TUNNEL_RESPONSE_TIMEOUT" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint: "tunnel_ingress", method: req.method, status_class: "5xx" });
      const errorPayload = toErrorPayload(gatewayTimeout("TUNNEL_RESPONSE_TIMEOUT", "No response from tunnel client"), "GATEWAY_TIMEOUT", "Gateway timeout");
      reply.status(errorPayload.statusCode).send(errorPayload.body);
    }
  });

  return {
    app,
    async start(): Promise<void> {
      await app.listen({ port: config.gatewayPort, host: "0.0.0.0" });
      await new Promise<void>((resolve, reject) => {
        wsHttpServer.listen(config.wsPort, "0.0.0.0", () => resolve());
        wsHttpServer.once("error", reject);
      });
      if (!config.authRequired) {
        // Loud warning — anonymous principal has full admin access in this mode.
        console.warn(
          "\n⚠  WARNING: authRequired is false — all requests are treated as full admin.\n" +
          "   Do NOT expose this gateway publicly without enabling authentication.\n",
        );
      }
      if ((config.startupGraceMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.startupGraceMs));
      }
      applyOperationalState({}, "startup");
      isReady = !maintenanceMode && !isDraining;
    },
    async stop(): Promise<void> {
      applyOperationalState({ draining: true }, "shutdown");
      isReady = false;
      clearInterval(idempotencySweep);
      clearInterval(redirectSweep);
      clearInterval(registrySweep);
      for (const socket of wsServer.clients) {
        socket.close(1012, "server_shutdown");
      }
      for (const conn of tcpConnectionsById.values()) {
        conn.destroy();
      }
      tcpConnectionsById.clear();
      const tcpCloseTasks = [...tcpBindingsBySubdomain.values()].map((binding) => new Promise<void>((resolve) => {
        binding.server.close(() => resolve());
      }));
      tcpBindingsBySubdomain.clear();
      usedTcpPorts.clear();
      reservedTcpPorts.clear();
      await Promise.allSettled(tcpCloseTasks);
      await app.close();
      await new Promise<void>((resolve) => wsHttpServer.close(() => resolve()));
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await store.close();
      await authStore.close();
      await userAuthStore.close();
      await auditStore.close();
      await tcpPortMappingStore.close();
      await deviceStore.close();
      if (sharedPrisma) {
        await sharedPrisma.$disconnect();
      }
    },
  };
}
