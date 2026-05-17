import { createHash, randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket, { WebSocketServer } from "ws";
import { PrismaClient } from "@prisma/client";
import { badRequest, gatewayTimeout, notFound, toErrorPayload } from "tunnelix-errors";
import { hasScope, parseApiKeys, parseScopes, readBearerToken, validateApiKey, verifyAccessToken } from "tunnelix-auth";
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
};

type Principal = { userId: string; authType: "api_key" | "jwt" | "anonymous"; apiKey?: string; scopes: string[] };

type TunnelRecord = { id: string; userId: string; subdomain: string; createdAt: string };

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
      return rows.map((row) => ({ id: row.id, userId: row.userId, subdomain: row.subdomain, createdAt: row.createdAt.toISOString() }));
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
            email: `${userId}@local.tunnelix`,
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
      return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), revoked: row.revoked, keyHash: row.keyHash, scopes: parseScopes((row as unknown as { scopes?: string }).scopes, []) }));
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

  constructor() {
    this.prisma = process.env.DATABASE_URL ? new PrismaClient() : null;
  }

  async log(userId: string | null, action: string, resource: string, resourceId: string | null, metadata?: unknown): Promise<void> {
    if (!this.prisma) {
      return;
    }
    await this.prisma.auditEvent.create({
      data: {
        userId,
        action,
        resource,
        resourceId,
        metadata: metadata as object | undefined,
      },
    });
  }

  async close(): Promise<void> {
    if (this.prisma) {
      await this.prisma.$disconnect();
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
  const registry = new TunnelRegistry();
  const store = new TunnelStore();
  const authStore = new AuthStore();
  const auditStore = new AuditStore();
  const parsedApiKeys = parseApiKeys(config.authApiKeys);
  const staticApiKeyScopes = parseScopes(config.authApiKeyScopes, ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"]);

  const wsServer = new WebSocketServer({ port: config.wsPort, path: "/connect" });
  const responseWaiters = new Map<string, (value: HttpResponse) => void>();
  const socketSubdomain = new WeakMap<object, string>();
  const activeStreamsBySocket = new WeakMap<object, Set<string>>();

  const ownershipBySubdomain = new Map<string, string>();

  function serializeWireMessage(message: WireMessage): string {
    return JSON.stringify(message);
  }

  function createGatewayError(message: string): string {
    return serializeWireMessage({ type: "error", message });
  }

  function hashApiKey(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async function resolvePrincipal(headers: Record<string, unknown>): Promise<Principal | null> {
    if (!config.authRequired) {
      return { userId: "anonymous", authType: "anonymous", scopes: ["*"] };
    }

    const apiKeyHeader = headers["x-api-key"];
    const apiKey = Array.isArray(apiKeyHeader) ? String(apiKeyHeader[0]) : apiKeyHeader ? String(apiKeyHeader) : undefined;
    if (validateApiKey(parsedApiKeys, apiKey)) {
      return { userId: `apikey_${hashApiKey(apiKey!).slice(0, 12)}`, authType: "api_key", apiKey, scopes: staticApiKeyScopes };
    }
    if (apiKey) {
      const owned = await authStore.validateApiKey(hashApiKey(apiKey));
      if (owned) {
        return { userId: owned.userId, authType: "api_key", apiKey, scopes: owned.scopes };
      }
    }

    const authHeader = headers.authorization;
    const token = readBearerToken(Array.isArray(authHeader) ? String(authHeader[0]) : authHeader ? String(authHeader) : undefined);
    if (token && config.authJwtSecret) {
      try {
        const payload = verifyAccessToken(token, config.authJwtSecret) as { sub?: string; scopes?: string[] | string };
        if (payload && typeof payload.sub === "string" && payload.sub.trim()) {
          const tokenScopes = Array.isArray(payload.scopes)
            ? payload.scopes
            : typeof payload.scopes === "string"
              ? parseScopes(payload.scopes, [])
              : ["tunnel:create", "tunnel:read", "tunnel:delete", "key:manage"];
          return { userId: payload.sub, authType: "jwt", scopes: tokenScopes };
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

  wsServer.on("connection", (socket, request) => {
    resolvePrincipal(request.headers as Record<string, unknown>).then((principal) => {
      if (!principal) {
        void auditStore.log(null, "ws_auth_failed", "tunnel_session", null);
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

      socket.on("message", (raw) => {
      refreshIdleTimer();

      let msg: WireMessage;
      try {
        msg = JSON.parse(String(raw));
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
          const subdomain = registry.assign(requestMessage.requestedSubdomain, socket);
          socketSubdomain.set(socket, subdomain);
          ownershipBySubdomain.set(subdomain, principal.userId);
          registered = true;
          void auditStore.log(principal.userId, "ws_tunnel_registered", "tunnel_session", subdomain, { authType: principal.authType });
          socket.send(serializeWireMessage({ type: "registered", subdomain }));
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
            responseWaiters.delete(msg.streamId);
            activeStreamsBySocket.get(socket)?.delete(msg.streamId);
            waiter(msg);
          }
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
          const waiter = responseWaiters.get(streamId);
          if (waiter) {
            responseWaiters.delete(streamId);
            waiter({ type: "http_response", streamId, statusCode: 502, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ error: "Tunnel disconnected" })).toString("base64") });
          }
        }
      }

        registry.removeBySocket(socket);
      });
    }).catch(() => {
      socket.close(1011, "auth_resolution_error");
    });
  });

  app.get("/healthz", async () => ({ status: "ok", tunnels: registry.count() }));

  app.get("/api/tunnels", async (req, reply) => {
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "tunnel", null, { path: "/api/tunnels", method: "GET" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "tunnel:read")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:read" } });
    }
    const tunnels = await store.list(principal.userId);
    return reply.status(200).send({ count: tunnels.length, tunnels });
  });

  app.post("/api/tunnels", async (req, reply) => {
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "tunnel", null, { path: "/api/tunnels", method: "POST" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "tunnel:create")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:create" } });
    }

    const body = (req.body ?? {}) as { subdomain?: string };
    const subdomain = (body.subdomain ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{3,32}$/.test(subdomain) || subdomain.startsWith("-") || subdomain.endsWith("-")) {
      return reply.status(400).send({ error: { code: "INVALID_SUBDOMAIN", message: "Subdomain must be 3-32 chars (a-z, 0-9, -)" } });
    }

    const created = await store.create(principal.userId, subdomain);
    await auditStore.log(principal.userId, "tunnel_created", "tunnel", created.id, { subdomain: created.subdomain });
    return reply.status(201).send({ tunnel: created });
  });

  app.delete("/api/tunnels/:id", async (req, reply) => {
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "tunnel", null, { path: "/api/tunnels/:id", method: "DELETE" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "tunnel:delete")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope tunnel:delete" } });
    }

    const params = req.params as { id: string };
    const existing = await store.findById(params.id);
    if (!existing) {
      return reply.status(404).send({ error: { code: "TUNNEL_NOT_FOUND", message: "Tunnel not found" } });
    }

    if (existing.userId !== principal.userId) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Tunnel does not belong to this principal" } });
    }

    await store.delete(params.id);
    await auditStore.log(principal.userId, "tunnel_deleted", "tunnel", params.id);
    return reply.status(204).send();
  });

  app.post("/api/keys", async (req, reply) => {
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "api_key", null, { path: "/api/keys", method: "POST" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (principal.authType !== "jwt") {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "JWT principal required for API key issuance" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? "default").trim();
    if (!name || name.length > 64) {
      return reply.status(400).send({ error: { code: "INVALID_NAME", message: "API key name must be 1-64 characters" } });
    }
    const plaintext = `tk_${randomBytes(24).toString("hex")}`;
    const scopes = parseScopes((body as { scopes?: string }).scopes, ["tunnel:create", "tunnel:read", "tunnel:delete"]);
    const created = await authStore.createApiKey(principal.userId, name, hashApiKey(plaintext), scopes);
    await auditStore.log(principal.userId, "api_key_created", "api_key", created.id, { name: created.name });
    return reply.status(201).send({ apiKey: { id: created.id, name: created.name, createdAt: created.createdAt, scopes: created.scopes, token: plaintext } });
  });

  app.get("/api/keys", async (req, reply) => {
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "api_key", null, { path: "/api/keys", method: "GET" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const keys = await authStore.listApiKeys(principal.userId);
    return reply.status(200).send({
      count: keys.length,
      keys: keys.map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, revoked: item.revoked, scopes: item.scopes })),
    });
  });

  app.delete("/api/keys/:id", async (req, reply) => {
    const principal = await requirePrincipal(req.headers as Record<string, unknown>);
    if (!principal) {
      await auditStore.log(null, "http_auth_failed", "api_key", null, { path: "/api/keys/:id", method: "DELETE" });
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Valid API key or bearer token is required" } });
    }
    if (!hasScope(principal.scopes, "key:manage")) {
      return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Missing scope key:manage" } });
    }
    const params = req.params as { id: string };
    const deleted = await authStore.revokeApiKey(principal.userId, params.id);
    if (!deleted) {
      return reply.status(404).send({ error: { code: "API_KEY_NOT_FOUND", message: "API key not found" } });
    }
    await auditStore.log(principal.userId, "api_key_revoked", "api_key", params.id);
    return reply.status(204).send();
  });

  app.all("/*", async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/healthz" || req.url.startsWith("/healthz/")) {
      return reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } });
    }

    const subdomain = extractSubdomain(req.headers.host, config.rootDomain);
    if (!subdomain) {
      const errorPayload = toErrorPayload(badRequest("INVALID_HOST", "Invalid host or missing subdomain"), "BAD_REQUEST", "Invalid request");
      return reply.status(errorPayload.statusCode).send(errorPayload.body);
    }

    const tunnel = registry.findBySubdomain(subdomain);
    if (!tunnel) {
      const errorPayload = toErrorPayload(notFound("TUNNEL_NOT_FOUND", "No active tunnel for subdomain"), "NOT_FOUND", "Resource not found");
      return reply.status(errorPayload.statusCode).send(errorPayload.body);
    }

    const streamId = randomUUID();
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readRequestBody(req.raw, config.maxRequestBodyBytes);
    } catch (error) {
      app.log.warn({ error }, "Rejected request body");
      const errorPayload = toErrorPayload(badRequest("REQUEST_BODY_TOO_LARGE", "Request body too large"), "BAD_REQUEST", "Invalid request");
      return reply.status(413).send(errorPayload.body);
    }

    const outbound: HttpRequest = {
      type: "http_request",
      streamId,
      method: req.method,
      path: req.url,
      headers: filterHopByHopHeaders(req.headers),
      bodyBase64: bodyBuffer.toString("base64"),
    };

    const responsePromise = new Promise<HttpResponse>((resolve, reject) => {
      responseWaiters.set(streamId, resolve);
      activeStreamsBySocket.get(tunnel.socket)?.add(streamId);
      setTimeout(() => {
        if (responseWaiters.has(streamId)) {
          responseWaiters.delete(streamId);
          activeStreamsBySocket.get(tunnel.socket)?.delete(streamId);
          reject(new Error("Tunnel response timeout"));
        }
      }, config.tunnelResponseTimeoutMs);
    });

    tunnel.socket.send(serializeWireMessage(outbound));

    try {
      const tunnelResponse = await responsePromise;
      reply.code(tunnelResponse.statusCode);
      const responseHeaders = filterHopByHopHeaders(tunnelResponse.headers);
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (typeof value !== "undefined") {
          reply.header(key, value as string | string[] | number);
        }
      }
      reply.send(Buffer.from(tunnelResponse.bodyBase64, "base64"));
    } catch {
      const errorPayload = toErrorPayload(gatewayTimeout("TUNNEL_RESPONSE_TIMEOUT", "No response from tunnel client"), "GATEWAY_TIMEOUT", "Gateway timeout");
      reply.status(errorPayload.statusCode).send(errorPayload.body);
    }
  });

  return {
    app,
    async start(): Promise<void> {
      await app.listen({ port: config.gatewayPort, host: "0.0.0.0" });
    },
    async stop(): Promise<void> {
      await app.close();
      wsServer.close();
      await store.close();
      await authStore.close();
      await auditStore.close();
    },
  };
}
