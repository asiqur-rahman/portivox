import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
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
  private readonly memory = new Map<string, TunnelRecord>();

  constructor() {
    this.prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
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

  async findById(id: string): Promise<TunnelRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.tunnel.findUnique({ where: { id } });
      return row ? { id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() } : null;
    }

    return this.memory.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    if (this.prisma) {
      await this.prisma.tunnel.delete({ where: { id } });
      return;
    }

    this.memory.delete(id);
  }

  async close(): Promise<void> {
    if (this.prisma) {
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
  private readonly memory = new Map<string, ApiKeyRecord[]>();

  constructor() {
    this.prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
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
      const rows = await this.prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
      return rows.map((row: { id: string; name: string; createdAt: Date; revoked: boolean; keyHash: string; scopes?: string }) => ({ id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), revoked: row.revoked, keyHash: row.keyHash, scopes: parseScopes((row as unknown as { scopes?: string }).scopes, []) }));
    }
    return [...(this.memory.get(userId) ?? [])];
  }

  async revokeApiKey(userId: string, id: string): Promise<boolean> {
    if (this.prisma) {
      const existing = await this.prisma.apiKey.findUnique({ where: { id } });
      if (!existing || existing.userId !== userId) {
        return false;
      }
      await this.prisma.apiKey.update({ where: { id }, data: { revoked: true, revokedAt: new Date() } });
      return true;
    }
    const keys = this.memory.get(userId) ?? [];
    const target = keys.find((item) => item.id === id);
    if (!target) {
      return false;
    }
    target.revoked = true;
    return true;
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
    if (this.prisma) {
      await this.prisma.$disconnect();
    }
  }
}

type UserAuthRecord = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
};

class UserAuthStore {
  private readonly prisma: PrismaClient | null;
  private readonly memory = new Map<string, UserAuthRecord>();

  constructor() {
    this.prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
  }

  async register(email: string, passwordHash: string): Promise<UserAuthRecord> {
    if (this.prisma) {
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new Error("USER_EXISTS");
      }
      const row = await this.prisma.user.create({ data: { email, passwordHash } });
      return { id: row.id, email: row.email, passwordHash: row.passwordHash ?? "", createdAt: row.createdAt.toISOString() };
    }

    const found = [...this.memory.values()].find((item) => item.email === email);
    if (found) {
      throw new Error("USER_EXISTS");
    }
    const created: UserAuthRecord = { id: randomUUID(), email, passwordHash, createdAt: new Date().toISOString() };
    this.memory.set(created.id, created);
    return created;
  }

  async findByEmail(email: string): Promise<UserAuthRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.user.findUnique({ where: { email } });
      if (!row || !row.passwordHash) {
        return null;
      }
      return { id: row.id, email: row.email, passwordHash: row.passwordHash, createdAt: row.createdAt.toISOString() };
    }

    return [...this.memory.values()].find((item) => item.email === email) ?? null;
  }

  async findById(id: string): Promise<UserAuthRecord | null> {
    if (this.prisma) {
      const row = await this.prisma.user.findUnique({ where: { id } });
      if (!row || !row.passwordHash) return null;
      return { id: row.id, email: row.email, passwordHash: row.passwordHash, createdAt: row.createdAt.toISOString() };
    }
    return this.memory.get(id) ?? null;
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
    if (this.prisma) {
      await this.prisma.$disconnect();
    }
  }
}

class AuditStore {
  private readonly prisma: PrismaClient | null;
  private readonly sink: AuditSink;
  private readonly memory: Array<AuditEvent & { id: string }> = [];

  constructor(sink: AuditSink) {
    this.prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
    this.sink = sink;
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
      this.memory.push({ id: randomUUID(), ...auditEvent });
      await this.sink.emit(auditEvent);
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
        return;
      }
      throw error;
    }
    await this.sink.emit(auditEvent);
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
    if (this.prisma) {
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
  /** id → record (in-memory fallback when DATABASE_URL is absent) */
  private readonly memory = new Map<string, TcpPortMappingRecord>();

  constructor() {
    this.prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
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
    if (this.prisma) await this.prisma.$disconnect();
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

export function createGatewayServer(config: GatewayRuntimeConfig): GatewayServer {
  const app = Fastify({ logger: true });
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
  const registry = new TunnelRegistry({
    backend: config.registryBackend ?? "memory",
    redisUrl: config.redisUrl,
    redisKeyPrefix: config.redisKeyPrefix,
    leaseTtlMs: config.registryLeaseTtlMs ?? 30_000,
    nodeId: config.nodeId ?? `gateway-${randomUUID()}`,
  });
  const store = new TunnelStore();
  const authStore = new AuthStore();
  const userAuthStore = new UserAuthStore();
  const tcpPortMappingStore = new TcpPortMappingStore();
  const auditStore = new AuditStore(new AuditSink({
    jsonlPath: config.auditExportJsonlPath,
    webhookUrl: config.auditExportWebhookUrl,
    webhookTimeoutMs: config.auditExportWebhookTimeoutMs ?? 3000,
    webhookSecret: config.auditExportWebhookSecret,
    webhookMaxRetries: config.auditExportWebhookMaxRetries ?? 3,
    webhookRetryBaseMs: config.auditExportWebhookRetryBaseMs ?? 250,
    deadLetterJsonlPath: config.auditExportDeadLetterJsonlPath,
  }));
  const parsedApiKeys = parseApiKeys(config.authApiKeys);
  const staticApiKeyScopes = parseScopes(config.authApiKeyScopes, ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"]);

  const wsServer = new WebSocketServer({ port: config.wsPort, path: "/connect" });
  const apiReadLimiter = new RateLimiter(config.apiRateLimitReadPerMin ?? 600, 60_000);
  const apiWriteLimiter = new RateLimiter(config.apiRateLimitWritePerMin ?? 300, 60_000);
  const apiAdminLimiter = new RateLimiter(config.apiRateLimitAdminPerMin ?? 120, 60_000);
  const tunnelIngressLimiter = new RateLimiter(config.ingressRateLimitPerMin ?? 1200, 60_000);
  const responseWaiters = new Map<string, (value: HttpResponse) => void>();
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
  const socketSubdomain = new WeakMap<object, string>();
  const activeStreamsBySocket = new WeakMap<object, Set<string>>();
  const tcpBindingsBySubdomain = new Map<string, { server: net.Server; publicPort: number }>();
  const tcpConnectionsById = new Map<string, net.Socket>();
  const tcpConnectionsBySocket = new WeakMap<object, Set<string>>();
  const usedTcpPorts = new Set<number>();

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
  let isReady = false;
  let isDraining = false;
  let maintenanceMode = config.maintenanceMode ?? false;
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
    if (securityHeadersEnabled) {
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

  // Constant header blocklist defined once — used in tunnel ingress to prevent
  // tunnel operators from overriding gateway-level security headers.
  const BLOCKED_RESPONSE_HEADERS = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "strict-transport-security",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
    "set-cookie",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "access-control-max-age",
  ]);

  // Default scopes granted to newly registered users and JWT fallback.
  const DEFAULT_USER_SCOPES = ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"] as const;

  function createGatewayError(message: string): string {
    return encodeWireMessage({ type: "error", message });
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
        return { userId: owned.userId, authType: "api_key", apiKey, scopes: owned.scopes, role: "admin" };
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

  function isAdminRole(role: Principal["role"]): boolean {
    return role === "admin" || role === "owner";
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
   *  http://<rootDomain>. Used for access links and redirect URLs. */
  function buildPublicUrl(path: string): string {
    const base = (config.gatewayPublicBaseUrl ?? "").trim() || `http://${config.rootDomain}`;
    return `${base}${path}`;
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
      if (!usedTcpPorts.has(port)) {
        return port;
      }
    }
    return null;
  }

  function resolveTcpPublicHost(): string {
    const host = (config.tcpPublicHost ?? "").trim();
    return host || config.rootDomain;
  }

  async function bindTcpTunnel(
    key: string,
    socket: WebSocket,
    /** When provided, binds to this exact port instead of allocating from the pool. */
    fixedPort?: number,
    /** When provided, incoming TCP connections must have their IP whitelisted in
     *  ipAccessByToken[accessToken] before being forwarded to the tunnel client. */
    accessToken?: string,
  ): Promise<{ publicPort: number; publicHost: string }> {
    if (!(config.tcpTunnelEnabled ?? true)) {
      throw new Error("TCP_TUNNEL_DISABLED");
    }
    if (tcpBindingsBySubdomain.has(key)) {
      const existing = tcpBindingsBySubdomain.get(key)!;
      return { publicPort: existing.publicPort, publicHost: resolveTcpPublicHost() };
    }

    // Fixed-port tunnels bypass the random pool; dynamic tunnels must be in range.
    const port = fixedPort ?? allocateTcpPort();
    if (port === null) {
      throw new Error("TCP_PORT_EXHAUSTED");
    }

    const connectionIds = new Set<string>();
    tcpConnectionsBySocket.set(socket, connectionIds);

    const server = net.createServer((conn) => {
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
      });

      const closeConnection = (reason?: string): void => {
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
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, config.tcpTunnelBindHost ?? "0.0.0.0", () => {
        server.off("error", onError);
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
      socket.close(1013, "service_unavailable");
      return;
    }

    metrics.increment("gateway_ws_connections_total");
    resolvePrincipal(request.headers as Record<string, unknown>).then((principal) => {
      if (!principal) {
        void auditStore.log(null, "ws_auth_failed", "tunnel_session", null);
        metrics.increment("gateway_ws_auth_failures_total");
        socket.close(4401, "unauthorized");
        return;
      }

      let registered = false;
      let socketIdleTimer: NodeJS.Timeout | null = null;
      activeStreamsBySocket.set(socket, new Set());

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

      socket.on("message", async (raw) => {
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
            !usedTcpPorts.has(fixedMapping.publicPort);

          if (isTcp && useFixedPort && fixedMapping) {
            // ── FIXED-PORT PATH ──────────────────────────────────────────────
            // The tunnel is reachable via domain:publicPort — no subdomain needed.
            // We store a synthetic key so the close handler can clean up the TCP
            // server binding without any changes to that logic.
            const syntheticKey = `__tcp_port_${fixedMapping.publicPort}__`;
            socketSubdomain.set(socket, syntheticKey);
            // NOTE: do NOT add to registry (no HTTP subdomain routing required)
            // NOTE: do NOT set ownershipBySubdomain (synthetic key, not a real subdomain)
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
              const tcpBinding = await bindTcpTunnel(syntheticKey, socket, fixedMapping.publicPort, accessToken);

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
              socket.send(createGatewayError("Failed to bind fixed TCP port"));
              // Clean up partially-created tokens on failure
              if (accessToken) { ipAccessByToken.delete(accessToken); ipTokenByTunnelKey.delete(syntheticKey); }
              registered = false;
            }
            return;
          }

          // ── NORMAL PATH (HTTP tunnel, or TCP with no/busy mapping) ─────────
          try {
            const subdomain = await registry.assign(requestMessage.requestedSubdomain, socket);
            socketSubdomain.set(socket, subdomain);
            ownershipBySubdomain.set(subdomain, principal.userId);
            metrics.setGauge("gateway_active_tunnels", registry.count());
            registered = true;
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
                const tcpBinding = await bindTcpTunnel(subdomain, socket, undefined, accessToken);

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
              } catch {
                socket.send(createGatewayError("Failed to allocate TCP tunnel port"));
                if (accessToken) { ipAccessByToken.delete(accessToken); ipTokenByTunnelKey.delete(subdomain); }
                registry.removeBySocket(socket);
                metrics.setGauge("gateway_active_tunnels", registry.count());
                registered = false;
              }
            } else {
              // HTTP tunnel — redirect URL only, no IP protection
              const rEntry: RedirectEntry = redirectByToken.get(redirectToken) ?? {
                tunnelKey: subdomain,
                userId: principal.userId,
                tunnelType: "http",
                createdAt: Date.now(),
                connected: false,
                lastSeenAt: Date.now(),
              };
              rEntry.subdomain = subdomain;
              rEntry.connected = true;
              rEntry.lastSeenAt = Date.now();
              redirectByToken.set(redirectToken, rEntry);
              redirectTokenByTunnelKey.set(subdomain, redirectToken);

              socket.send(encodeWireMessage({ type: "registered", subdomain, tunnelType: "http", redirectToken, redirectUrl }));
            }
          } catch {
            socket.send(createGatewayError("Failed to allocate tunnel subdomain"));
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
              activeStreamsBySocket.get(socket)?.delete(msg.streamId);
              responseChunksByStream.delete(msg.streamId);
              return;
            }

            existing.chunks.set(chunkMeta.index, Buffer.from(msg.bodyBase64, "base64"));
            responseChunksByStream.set(msg.streamId, existing);

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
                conn.write(Buffer.from(msg.dataBase64, "base64"));
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
      });

      socket.on("close", () => {
        if (socketIdleTimer) {
          clearTimeout(socketIdleTimer);
        }

        const subdomain = socketSubdomain.get(socket);
        if (subdomain) {
          ownershipBySubdomain.delete(subdomain);
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
              responseChunksByStream.delete(streamId);
              waiter({ type: "http_response", streamId, statusCode: 502, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ error: "Tunnel disconnected" })).toString("base64") });
            }
          }
        }

        if (subdomain) {
          void releaseTcpTunnelBySubdomain(subdomain);
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
        // ── Stable redirect URL: mark as disconnected (do NOT delete the entry
        //    so the /r/:token URL stays valid during reconnect windows).
        if (subdomain) {
          const rToken = redirectTokenByTunnelKey.get(subdomain);
          if (rToken) {
            const rEntry = redirectByToken.get(rToken);
            if (rEntry) {
              rEntry.connected = false;
              rEntry.lastSeenAt = Date.now();
              rEntry.disconnectedAt = Date.now();
            }
          }
          // ── IP access cleanup: remove whitelist on disconnect.
          const aToken = ipTokenByTunnelKey.get(subdomain);
          if (aToken) {
            ipAccessByToken.delete(aToken);
            ipTokenByTunnelKey.delete(subdomain);
          }
        }

        registry.removeBySocket(socket);
        metrics.setGauge("gateway_active_tunnels", registry.count());
      });
    }).catch((err) => {
      app.log.error({ err }, "ws auth resolution error");
      socket.close(1011, "auth_resolution_error");
    });
  });

  app.get("/healthz", async () => ({ status: "ok", tunnels: registry.count() }));
  app.get("/readyz", async (_req, reply) => {
    const ready = isReady && !isDraining && !maintenanceMode;
    return reply.status(ready ? 200 : 503).send({
      ready,
      draining: isDraining,
      maintenanceMode,
      activeTunnels: registry.count(),
    });
  });
  app.get("/metrics", async (req, reply) => {
    // If METRICS_TOKEN is configured, require a matching Bearer token so that
    // Prometheus metrics are not publicly accessible on the internet.
    if (config.metricsToken) {
      const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
      const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!provided || provided !== config.metricsToken) {
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
      const scopes = [...DEFAULT_USER_SCOPES];
      const role: Principal["role"] = "owner";
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
      return reply.status(500).send({ error: { code: "REGISTER_FAILED", message: "Registration failed" } });
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
    const user = await userAuthStore.findByEmail(body.email);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return reply.status(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
    }
    const scopes = [...DEFAULT_USER_SCOPES];
    const role: Principal["role"] = "owner";
    const token = signAccessToken({ sub: user.id, role, scopes }, config.authJwtSecret, "7d");
    await auditStore.log(user.id, "user_login", "user", user.id, { email: user.email });
    return reply.status(200).send({
      user: { id: user.id, email: user.email, role },
      accessToken: token,
      tokenType: "Bearer",
    });
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
    // Enrich each record with a live `active` flag so the UI can distinguish
    // DB-reserved subdomains from ones with an actual connected client.
    const enriched = tunnels.map((t) => ({ ...t, active: !!registry.findBySubdomain(t.subdomain) }));
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ count: enriched.length, tunnels: enriched });
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
    const existing = await store.findById(params.id);
    if (!existing) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "TUNNEL_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(404).send({ error: { code: "TUNNEL_NOT_FOUND", message: "Tunnel not found" } });
    }

    if (existing.userId !== principal.userId) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "FORBIDDEN" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Tunnel does not belong to this principal" } });
    }

    await store.delete(params.id);
    await auditStore.log(principal.userId, "tunnel_deleted", "tunnel", params.id);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "2xx" });
    if (idempotencyStoreKey) {
      writeIdempotencyReplay(idempotencyStoreKey, { statusCode: 204, body: null, contentType: "application/json" });
    }
    return reply.status(204).send();
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
    const scopes = parseScopes(body.scopesRaw, ["tunnel:create", "tunnel:read", "tunnel:delete"]);
    const created = await authStore.createApiKey(principal.userId, name, hashApiKey(plaintext), scopes);
    await auditStore.log(principal.userId, "api_key_created", "api_key", created.id, { name: created.name });
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
    const deleted = await authStore.revokeApiKey(principal.userId, params.id);
    if (!deleted) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "API_KEY_NOT_FOUND" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "4xx" });
      return reply.status(404).send({ error: { code: "API_KEY_NOT_FOUND", message: "API key not found" } });
    }
    await auditStore.log(principal.userId, "api_key_revoked", "api_key", params.id);
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

    const body = parseAdminStateBody(req.body);
    if (!body) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "INVALID_ADMIN_STATE" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "4xx" });
      return reply.status(400).send({
        error: { code: "INVALID_ADMIN_STATE", message: "Body must include at least one of { maintenanceMode:boolean, draining:boolean } with no extra fields" },
      });
    }
    if (typeof body.maintenanceMode === "boolean") {
      maintenanceMode = body.maintenanceMode;
      if (!maintenanceMode && !isDraining) {
        isReady = true;
      }
      if (maintenanceMode) {
        isReady = false;
      }
    }
    if (typeof body.draining === "boolean") {
      isDraining = body.draining;
      if (isDraining) {
        isReady = false;
      } else if (!maintenanceMode) {
        isReady = true;
      }
    }

    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "POST", status_class: "2xx" });
    const responseBody = {
      ready: isReady,
      draining: isDraining,
      maintenanceMode,
      activeTunnels: registry.count(),
    };
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
    if (!isAdminRole(principal.role)) {
      metrics.incrementLabeled("gateway_errors_labeled_total", { endpoint, error_code: "ROLE_REQUIRED" });
      metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "PATCH", status_class: "4xx" });
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Admin or owner role required" } });
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

    const { id } = req.params as { id: string };
    const deleted = await tcpPortMappingStore.delete(id);
    if (!deleted) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "TCP port mapping not found" } });
    }
    void auditStore.log(principal.userId, "tcp_port_mapping_deleted", "tcp_port_mapping", id);
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "DELETE", status_class: "2xx" });
    return reply.status(204).send();
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
    if (!isAdminRole(principal.role) && !hasScope(principal.scopes, "tunnel:delete")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Admin role or tunnel:delete scope required" } });
    }
    const { subdomain } = req.params as { subdomain: string };
    capturedRequests.delete(subdomain);
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
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;  // 24 hours
    entry.allowedIps.set(ip, expiresAt);

    return reply.status(200).send({
      whitelisted: true,
      ip,
      expiresAt: new Date(expiresAt).toISOString(),
      message: `IP ${ip} has been whitelisted for 24 hours. You may now connect.`,
    });
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

    const responsePromise = new Promise<HttpResponse>((resolve, reject) => {
      const inflightForSocket = activeStreamsBySocket.get(tunnel.socket);
      const maxConcurrent = config.maxConcurrentStreamsPerTunnel ?? 200;
      if (inflightForSocket && inflightForSocket.size >= maxConcurrent) {
        metrics.increment("gateway_request_errors_total");
        reject(new Error("TUNNEL_STREAM_LIMIT_EXCEEDED"));
        return;
      }

      responseWaiters.set(streamId, resolve);
      activeStreamsBySocket.get(tunnel.socket)?.add(streamId);
      const timeout = setTimeout(() => {
        if (responseWaiters.has(streamId)) {
          if (responseChunksByStream.has(streamId)) {
            chunkDiagnostics.chunkIncompleteTimeouts += 1;
            metrics.increment("gateway_chunk_incomplete_timeouts_total");
            void auditStore.log(null, "chunk_stream_timeout", "tunnel_stream", streamId, {
              errorCode: "TUNNEL_STREAM_IDLE_TIMEOUT",
            });
          }
          responseWaiters.delete(streamId);
          activeStreamsBySocket.get(tunnel.socket)?.delete(streamId);
          streamTimeouts.delete(streamId);
          responseChunksByStream.delete(streamId);
          reject(new Error("TUNNEL_STREAM_IDLE_TIMEOUT"));
        }
      }, config.streamIdleTimeoutMs ?? config.tunnelResponseTimeoutMs);
      streamTimeouts.set(streamId, timeout);
    });

    tunnel.socket.send(encodeWireMessage(outbound));

    try {
      const tunnelResponse = await responsePromise;
      const timeout = streamTimeouts.get(streamId);
      if (timeout) {
        clearTimeout(timeout);
        streamTimeouts.delete(streamId);
      }
      metrics.observeRequestLatency(Date.now() - startedAt);
      reply.code(tunnelResponse.statusCode);
      // Strip hop-by-hop headers first, then additionally block headers that
      // tunnel operators must not be allowed to override on the gateway domain —
      // otherwise a rogue tunnel could poison browser state across the root domain.
      const responseHeaders = filterHopByHopHeaders(tunnelResponse.headers);
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (typeof value !== "undefined" && !BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
          reply.header(key, value as string | string[] | number);
        }
      }
      const respBody = Buffer.from(tunnelResponse.bodyBase64, "base64");
      captured.durationMs = Date.now() - startedAt;
      captured.statusCode = tunnelResponse.statusCode;
      captured.responseHeaders = responseHeaders as Record<string, string | string[] | undefined>;
      captured.responseBodyBase64 = respBody.byteLength > MAX_INSPECT_BODY_BYTES
        ? respBody.slice(0, MAX_INSPECT_BODY_BYTES).toString("base64")
        : tunnelResponse.bodyBase64;
      captured.responseBodyTruncated = respBody.byteLength > MAX_INSPECT_BODY_BYTES;
      reply.send(respBody);
    } catch (error) {
      const timeout = streamTimeouts.get(streamId);
      if (timeout) {
        clearTimeout(timeout);
        streamTimeouts.delete(streamId);
      }
      const code = error instanceof Error ? error.message : "UNKNOWN_STREAM_ERROR";
      captured.durationMs = Date.now() - startedAt;
      captured.error = code;
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
      if ((config.startupGraceMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.startupGraceMs));
      }
      isReady = true;
    },
    async stop(): Promise<void> {
      isDraining = true;
      isReady = false;
      clearInterval(idempotencySweep);
      clearInterval(redirectSweep);
      await app.close();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await store.close();
      await authStore.close();
      await userAuthStore.close();
      await auditStore.close();
      await tcpPortMappingStore.close();
    },
  };
}

