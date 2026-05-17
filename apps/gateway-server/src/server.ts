import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import WebSocket, { WebSocketServer } from "ws";
import { PrismaClient } from "@prisma/client";
import { badRequest, gatewayTimeout, notFound, toErrorPayload } from "portivox-errors";
import { hasScope, parseApiKeys, parseScopes, readBearerToken, validateApiKey, verifyAccessToken } from "portivox-auth";
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
    this.webhookUrl = config.webhookUrl && config.webhookUrl.trim() ? config.webhookUrl.trim() : null;
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
      const signature = createHash("sha256").update(`${this.webhookSecret}.${payload}`).digest("hex");
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

export type GatewayServer = {
  app: FastifyInstance;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createGatewayServer(config: GatewayRuntimeConfig): GatewayServer {
  const app = Fastify({ logger: true });
  void app.register(swagger, {
    openapi: buildOpenApiDocument("http://localhost:8080"),
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

  function serializeWireMessage(message: WireMessage): string {
    return encodeWireMessage(message);
  }

  function createGatewayError(message: string): string {
    return serializeWireMessage({ type: "error", message });
  }

  function hashApiKey(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async function resolvePrincipal(headers: Record<string, unknown>): Promise<Principal | null> {
    if (!config.authRequired) {
      return { userId: "anonymous", authType: "anonymous", scopes: ["*"], role: "admin" };
    }

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
              : ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"];
          const role = payload.role === "viewer" || payload.role === "owner" || payload.role === "admin" ? payload.role : "owner";
          return { userId: payload.sub, authType: "jwt", scopes: tokenScopes, role };
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  async function requirePrincipal(headers: Record<string, unknown>): Promise<Principal | null> {
    return resolvePrincipal(headers);
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

  async function bindTcpTunnel(subdomain: string, socket: WebSocket): Promise<{ publicPort: number; publicHost: string }> {
    if (!(config.tcpTunnelEnabled ?? true)) {
      throw new Error("TCP_TUNNEL_DISABLED");
    }
    if (tcpBindingsBySubdomain.has(subdomain)) {
      const existing = tcpBindingsBySubdomain.get(subdomain)!;
      return { publicPort: existing.publicPort, publicHost: resolveTcpPublicHost() };
    }

    const port = allocateTcpPort();
    if (!port || !isPortInRange(port)) {
      throw new Error("TCP_PORT_EXHAUSTED");
    }

    const connectionIds = new Set<string>();
    tcpConnectionsBySocket.set(socket, connectionIds);

    const server = net.createServer((conn) => {
      const connectionId = randomUUID();
      tcpConnectionsById.set(connectionId, conn);
      connectionIds.add(connectionId);

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serializeWireMessage({ type: "tcp_open", connectionId }));
      } else {
        conn.destroy();
        return;
      }

      conn.on("data", (chunk) => {
        if (socket.readyState !== WebSocket.OPEN) {
          conn.destroy();
          return;
        }
        socket.send(serializeWireMessage({
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
          socket.send(serializeWireMessage({ type: "tcp_close", connectionId, reason }));
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

    tcpBindingsBySubdomain.set(subdomain, { server, publicPort: port });
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
          try {
            const subdomain = await registry.assign(requestMessage.requestedSubdomain, socket);
            socketSubdomain.set(socket, subdomain);
            ownershipBySubdomain.set(subdomain, principal.userId);
            metrics.setGauge("gateway_active_tunnels", registry.count());
            registered = true;
            void auditStore.log(principal.userId, "ws_tunnel_registered", "tunnel_session", subdomain, { authType: principal.authType });
            if (requestMessage.tunnelType === "tcp") {
              try {
                const tcpBinding = await bindTcpTunnel(subdomain, socket);
                socket.send(serializeWireMessage({
                  type: "registered",
                  subdomain,
                  tunnelType: "tcp",
                  publicTcpHost: tcpBinding.publicHost,
                  publicTcpPort: tcpBinding.publicPort,
                }));
              } catch {
                socket.send(createGatewayError("Failed to allocate TCP tunnel port"));
                registry.removeBySocket(socket);
                metrics.setGauge("gateway_active_tunnels", registry.count());
                registered = false;
              }
            } else {
              socket.send(serializeWireMessage({ type: "registered", subdomain, tunnelType: "http" }));
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
          const conn = tcpConnectionsById.get(msg.connectionId);
          if (conn) {
            conn.write(Buffer.from(msg.dataBase64, "base64"));
          }
          return;
        }

        if (msg.type === "tcp_close") {
          const conn = tcpConnectionsById.get(msg.connectionId);
          if (conn) {
            tcpConnectionsById.delete(msg.connectionId);
            conn.destroy();
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
        registry.removeBySocket(socket);
        metrics.setGauge("gateway_active_tunnels", registry.count());
      });
    }).catch(() => {
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
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return reply.status(200).send(metrics.renderPrometheus());
  });
  app.get("/openapi.json", async (req, reply) => {
    const host = typeof req.headers.host === "string" ? req.headers.host : `localhost:${config.gatewayPort}`;
    const scheme = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return reply.status(200).send(buildOpenApiDocument(`${scheme}://${host}`));
  });

  app.get("/api/tunnels", async (req, reply) => {
    const endpoint = "/api/tunnels";
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    metrics.incrementLabeled("gateway_requests_labeled_total", { endpoint, method: "GET", status_class: "2xx" });
    return reply.status(200).send({ count: tunnels.length, tunnels });
  });

  app.post("/api/tunnels", async (req, reply) => {
    const endpoint = "/api/tunnels";
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    if (principal.authType !== "jwt") {
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
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

    const outbound: HttpRequest = {
      type: "http_request",
      streamId,
      method: req.method,
      path: req.url,
      headers: {
        ...filterHopByHopHeaders(req.headers),
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

    tunnel.socket.send(serializeWireMessage(outbound));

    try {
      const tunnelResponse = await responsePromise;
      const timeout = streamTimeouts.get(streamId);
      if (timeout) {
        clearTimeout(timeout);
        streamTimeouts.delete(streamId);
      }
      metrics.observeRequestLatency(Date.now() - startedAt);
      reply.code(tunnelResponse.statusCode);
      const responseHeaders = filterHopByHopHeaders(tunnelResponse.headers);
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (typeof value !== "undefined") {
          reply.header(key, value as string | string[] | number);
        }
      }
      reply.send(Buffer.from(tunnelResponse.bodyBase64, "base64"));
    } catch (error) {
      const timeout = streamTimeouts.get(streamId);
      if (timeout) {
        clearTimeout(timeout);
        streamTimeouts.delete(streamId);
      }
      const code = error instanceof Error ? error.message : "UNKNOWN_STREAM_ERROR";
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
      await app.close();
      wsServer.close();
      await store.close();
      await authStore.close();
      await auditStore.close();
    },
  };
}

