const http = require("node:http");
const { URL } = require("node:url");

const PORT = 4010;
const VALID_TOKEN = "mock-token";
const FIXED_NOW = Date.parse("2026-06-08T12:00:00.000Z");

function isoFromOffset(offsetMs = 0) {
  return new Date(FIXED_NOW + offsetMs).toISOString();
}

function nowIso() {
  return isoFromOffset();
}

function buildInitialState() {
  const createdNow = isoFromOffset();
  const seenAgo = isoFromOffset(-18 * 60 * 1000);
  return {
    adminState: { draining: false, maintenanceMode: false },
    chunkDiagnostics: {
      chunkFramesReceived: 1824,
      chunkStreamsReassembled: 612,
      chunkIncompleteTimeouts: 4,
    },
    tunnels: [
      {
        id: "tun_live_1",
        userId: "user_1",
        subdomain: "alpha-demo",
        createdAt: createdNow,
        active: true,
        status: "live",
        statusMessage: "Connected and forwarding traffic",
        lastSeenAt: createdNow,
        disconnectedAt: null,
        isCliSession: false,
        redirectUrl: "https://alpha-demo.portivox.local/r/demo",
      },
      {
        id: "tun_offline_1",
        userId: "user_1",
        subdomain: "beta-api",
        createdAt: createdNow,
        active: false,
        status: "offline",
        statusMessage: "Client machine is not reachable",
        lastSeenAt: seenAgo,
        disconnectedAt: seenAgo,
        isCliSession: false,
        redirectUrl: "https://beta-api.portivox.local/r/demo",
      },
      {
        id: "tun_reserved_1",
        userId: "user_1",
        subdomain: "gamma-app",
        createdAt: createdNow,
        active: false,
        status: "reserved",
        statusMessage: "Reserved and waiting for a client connection",
        lastSeenAt: null,
        disconnectedAt: null,
        isCliSession: false,
        redirectUrl: null,
      },
      {
        id: "tun_cli_1",
        userId: "user_1",
        subdomain: "ssh-prod",
        createdAt: createdNow,
        active: true,
        status: "live",
        statusMessage: "Persistent TCP session online",
        lastSeenAt: createdNow,
        disconnectedAt: null,
        isCliSession: true,
        redirectUrl: null,
      },
    ],
    apiKeys: [
      {
        id: "key_1",
        name: "Production CLI",
        createdAt: createdNow,
        revoked: false,
        scopes: ["tunnel:create", "tunnel:read", "tunnel:delete"],
      },
      {
        id: "key_2",
        name: "Read-only automation",
        createdAt: isoFromOffset(-24 * 60 * 60 * 1000),
        revoked: false,
        scopes: ["tunnel:read"],
      },
    ],
    auditItems: [
      {
        id: "audit_1",
        userId: "user_1",
        action: "tunnel_created",
        resource: "tunnel",
        resourceId: "tun_live_1",
        metadata: { subdomain: "alpha-demo", source: "portal" },
        createdAt: createdNow,
      },
      {
        id: "audit_2",
        userId: "user_1",
        action: "user_login",
        resource: "user",
        resourceId: "user_1",
        metadata: { method: "password" },
        createdAt: isoFromOffset(-60 * 60 * 1000),
      },
      {
        id: "audit_3",
        userId: null,
        action: "tcp_mapping_created",
        resource: "tunnel_session",
        resourceId: "map_1",
        metadata: { publicPort: 19022 },
        createdAt: isoFromOffset(-2 * 60 * 60 * 1000),
      },
    ],
    tcpMappings: [
      {
        id: "map_1",
        name: "Production SSH",
        localPort: 22,
        publicPort: 19022,
        description: "Persistent SSH entry point",
        enabled: true,
        createdAt: createdNow,
        updatedAt: createdNow,
      },
      {
        id: "map_2",
        name: "Reporting Postgres",
        localPort: 5432,
        publicPort: 19432,
        description: "Analytics database tunnel",
        enabled: false,
        createdAt: isoFromOffset(-24 * 60 * 60 * 1000),
        updatedAt: isoFromOffset(-24 * 60 * 60 * 1000),
      },
    ],
    inspectorData: {
      "alpha-demo": {
        requests: [
          {
            id: "req_1",
            capturedAt: FIXED_NOW - 30_000,
            durationMs: 128,
            method: "GET",
            path: "/api/health",
            statusCode: 200,
            requestBodyTruncated: false,
            responseBodyTruncated: false,
            error: null,
          },
          {
            id: "req_2",
            capturedAt: FIXED_NOW - 10_000,
            durationMs: 482,
            method: "POST",
            path: "/api/tunnels",
            statusCode: 201,
            requestBodyTruncated: false,
            responseBodyTruncated: false,
            error: null,
          },
        ],
        details: {
          req_1: {
            id: "req_1",
            capturedAt: FIXED_NOW - 30_000,
            durationMs: 128,
            method: "GET",
            path: "/api/health",
            statusCode: 200,
            requestBodyTruncated: false,
            responseBodyTruncated: false,
            error: null,
            requestHeaders: { accept: "application/json" },
            responseHeaders: { "content-type": "application/json" },
            requestBodyBase64: "",
            responseBodyBase64: Buffer.from(JSON.stringify({ ok: true }, null, 2)).toString("base64"),
          },
          req_2: {
            id: "req_2",
            capturedAt: FIXED_NOW - 10_000,
            durationMs: 482,
            method: "POST",
            path: "/api/tunnels",
            statusCode: 201,
            requestBodyTruncated: false,
            responseBodyTruncated: false,
            error: null,
            requestHeaders: { "content-type": "application/json", authorization: "Bearer mock-token" },
            responseHeaders: { "content-type": "application/json" },
            requestBodyBase64: Buffer.from(JSON.stringify({ subdomain: "gamma-app" }, null, 2)).toString("base64"),
            responseBodyBase64: Buffer.from(JSON.stringify({ tunnel: { id: "tun_live_1" } }, null, 2)).toString("base64"),
          },
        },
      },
    },
  };
}

let state = buildInitialState();
const sseClients = new Set();

function resetState() {
  state = buildInitialState();
}

function writeCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, x-api-key");
}

function sendJson(res, status, payload) {
  writeCorsHeaders(res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendNoContent(res) {
  writeCorsHeaders(res);
  res.writeHead(204);
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${VALID_TOKEN}`) {
    return true;
  }
  sendJson(res, 401, { error: { message: "Unauthorized" } });
  return false;
}

function broadcast(event) {
  const frame = `data: ${JSON.stringify({ at: nowIso(), ...event })}\n\n`;
  for (const client of sseClients) {
    client.write(frame);
  }
}

function activeTunnelCount() {
  return state.tunnels.filter((tunnel) => tunnel.active).length;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    writeCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/readyz" && req.method === "GET") {
    sendJson(res, 200, {
      ready: !state.adminState.maintenanceMode,
      draining: state.adminState.draining,
      maintenanceMode: state.adminState.maintenanceMode,
      activeTunnels: activeTunnelCount(),
    });
    return;
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    sendJson(res, 200, {
      user: { id: "user_1", email: body.email || "qa@braintechsolution.com", role: "admin" },
      accessToken: VALID_TOKEN,
      tokenType: "Bearer",
    });
    return;
  }

  if (path === "/api/auth/register" && req.method === "POST") {
    const body = await readJson(req);
    state.auditItems.unshift({
      id: `audit_${Date.now()}`,
      userId: "user_1",
      action: "user_registered",
      resource: "user",
      resourceId: "user_1",
      metadata: { email: body.email || "qa@braintechsolution.com" },
      createdAt: nowIso(),
    });
    broadcast({ kind: "audit_changed" });
    sendJson(res, 200, {
      user: { id: "user_1", email: body.email || "qa@braintechsolution.com", role: "admin" },
      accessToken: VALID_TOKEN,
      tokenType: "Bearer",
    });
    return;
  }

  if (path === "/api/auth/change-password" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    sendNoContent(res);
    return;
  }

  if (path === "/api/events" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    writeCorsHeaders(res);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ kind: "connected", at: nowIso() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (path === "/api/tunnels" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { tunnels: state.tunnels });
    return;
  }

  if (path === "/api/admin/tunnels" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { tunnels: state.tunnels });
    return;
  }

  if (path === "/api/tunnels" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    const tunnel = {
      id: `tun_${Date.now()}`,
      userId: "user_1",
      subdomain: body.subdomain || `demo-${Date.now()}`,
      createdAt: nowIso(),
      active: false,
      status: "reserved",
      statusMessage: "Reserved and waiting for a client connection",
      lastSeenAt: null,
      disconnectedAt: null,
      isCliSession: false,
      redirectUrl: null,
    };
    state.tunnels.unshift(tunnel);
    state.auditItems.unshift({
      id: `audit_${Date.now()}`,
      userId: "user_1",
      action: "tunnel_created",
      resource: "tunnel",
      resourceId: tunnel.id,
      metadata: { subdomain: tunnel.subdomain },
      createdAt: nowIso(),
    });
    broadcast({ kind: "tunnels_changed", subdomain: tunnel.subdomain });
    broadcast({ kind: "audit_changed" });
    sendJson(res, 200, { tunnel });
    return;
  }

  if (path.startsWith("/api/tunnels/") && req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    const id = decodeURIComponent(path.split("/").pop() || "");
    state.tunnels = state.tunnels.filter((tunnel) => tunnel.id !== id);
    broadcast({ kind: "tunnels_changed" });
    sendNoContent(res);
    return;
  }

  if (path === "/api/keys" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { keys: state.apiKeys });
    return;
  }

  if (path === "/api/keys" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    const key = {
      id: `key_${Date.now()}`,
      name: body.name || "New key",
      createdAt: nowIso(),
      revoked: false,
      scopes: typeof body.scopes === "string"
        ? body.scopes.split(",").map((item) => item.trim()).filter(Boolean)
        : ["tunnel:create"],
    };
    state.apiKeys.unshift(key);
    broadcast({ kind: "api_keys_changed" });
    sendJson(res, 200, {
      apiKey: {
        id: key.id,
        name: key.name,
        token: `tk_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`,
        scopes: key.scopes,
      },
    });
    return;
  }

  if (path.startsWith("/api/keys/") && req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    const id = decodeURIComponent(path.split("/").pop() || "");
    state.apiKeys = state.apiKeys.filter((key) => key.id !== id);
    broadcast({ kind: "api_keys_changed" });
    sendNoContent(res);
    return;
  }

  if (path === "/api/admin/state" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    state.adminState = { ...state.adminState, ...body };
    broadcast({ kind: "gateway_status_changed" });
    sendJson(res, 200, {
      ready: !state.adminState.maintenanceMode,
      draining: state.adminState.draining,
      maintenanceMode: state.adminState.maintenanceMode,
      activeTunnels: activeTunnelCount(),
    });
    return;
  }

  if (path === "/api/admin/chunk-diagnostics" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, state.chunkDiagnostics);
    return;
  }

  if (path === "/api/audit" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    const limit = Number(url.searchParams.get("limit") || "20");
    const action = url.searchParams.get("action");
    const resource = url.searchParams.get("resource");
    const items = state.auditItems
      .filter((item) => (!action || item.action === action) && (!resource || item.resource === resource))
      .slice(0, limit);
    sendJson(res, 200, { items, count: items.length });
    return;
  }

  if (path === "/api/admin/tcp-port-mappings" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { mappings: state.tcpMappings });
    return;
  }

  if (path === "/api/admin/tcp-port-mappings" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    const mapping = {
      id: `map_${Date.now()}`,
      name: body.name || "New mapping",
      localPort: Number(body.localPort || 0),
      publicPort: Number(body.publicPort || 0),
      description: body.description || null,
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.tcpMappings.unshift(mapping);
    broadcast({ kind: "tcp_mappings_changed" });
    sendJson(res, 200, { mapping });
    return;
  }

  if (path.startsWith("/api/admin/tcp-port-mappings/") && req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    const id = decodeURIComponent(path.split("/").pop() || "");
    state.tcpMappings = state.tcpMappings.filter((mapping) => mapping.id !== id);
    broadcast({ kind: "tcp_mappings_changed" });
    sendNoContent(res);
    return;
  }

  if (path.startsWith("/api/inspect/") && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    const parts = path.split("/").filter(Boolean);
    const subdomain = decodeURIComponent(parts[2] || "");
    const inspector = state.inspectorData[subdomain] || { requests: [], details: {} };
    if (parts.length === 3) {
      sendJson(res, 200, { subdomain, count: inspector.requests.length, requests: inspector.requests });
      return;
    }
    const reqId = decodeURIComponent(parts[3] || "");
    const request = inspector.details[reqId];
    if (!request) {
      sendJson(res, 404, { error: { message: "Request not found" } });
      return;
    }
    sendJson(res, 200, { request });
    return;
  }

  if (path.startsWith("/api/inspect/") && req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    const parts = path.split("/").filter(Boolean);
    const subdomain = decodeURIComponent(parts[2] || "");
    if (state.inspectorData[subdomain]) {
      state.inspectorData[subdomain] = { requests: [], details: {} };
    }
    broadcast({ kind: "inspector_changed", subdomain });
    sendNoContent(res);
    return;
  }

  if (path === "/__test/reset" && req.method === "POST") {
    resetState();
    broadcast({ kind: "tunnels_changed" });
    broadcast({ kind: "api_keys_changed" });
    broadcast({ kind: "gateway_status_changed" });
    sendNoContent(res);
    return;
  }

  if (path === "/__test/tunnels/state" && req.method === "POST") {
    const body = await readJson(req);
    const tunnel = state.tunnels.find((item) => item.subdomain === body.subdomain || item.id === body.id);
    if (!tunnel) {
      sendJson(res, 404, { error: { message: "Tunnel not found" } });
      return;
    }
    if (typeof body.active === "boolean") {
      tunnel.active = body.active;
    }
    if (typeof body.status === "string") {
      tunnel.status = body.status;
    }
    if (typeof body.statusMessage === "string") {
      tunnel.statusMessage = body.statusMessage;
    }
    if (body.lastSeenAt !== undefined) {
      tunnel.lastSeenAt = body.lastSeenAt;
    }
    if (body.disconnectedAt !== undefined) {
      tunnel.disconnectedAt = body.disconnectedAt;
    }
    broadcast({ kind: "tunnels_changed", subdomain: tunnel.subdomain });
    sendJson(res, 200, { tunnel });
    return;
  }

  if (path === "/__test/admin/state" && req.method === "POST") {
    const body = await readJson(req);
    state.adminState = { ...state.adminState, ...body };
    broadcast({ kind: "gateway_status_changed" });
    sendJson(res, 200, {
      ready: !state.adminState.maintenanceMode,
      draining: state.adminState.draining,
      maintenanceMode: state.adminState.maintenanceMode,
      activeTunnels: activeTunnelCount(),
    });
    return;
  }

  if (path === "/__test/inspect/request" && req.method === "POST") {
    const body = await readJson(req);
    const subdomain = body.subdomain || "alpha-demo";
    const reqId = body.id || `req_${Date.now()}`;
    const inspector = state.inspectorData[subdomain] || { requests: [], details: {} };
    const summary = {
      id: reqId,
      capturedAt: body.capturedAt || Date.now(),
      durationMs: body.durationMs ?? 205,
      method: body.method || "GET",
      path: body.path || "/healthz",
      statusCode: body.statusCode ?? 200,
      requestBodyTruncated: false,
      responseBodyTruncated: false,
      error: body.error ?? null,
    };
    const detail = {
      ...summary,
      requestHeaders: body.requestHeaders || { accept: "application/json" },
      responseHeaders: body.responseHeaders || { "content-type": "application/json" },
      requestBodyBase64: body.requestBodyBase64 || "",
      responseBodyBase64: body.responseBodyBase64 || Buffer.from(JSON.stringify({ ok: true }, null, 2)).toString("base64"),
    };
    inspector.requests.unshift(summary);
    inspector.details[reqId] = detail;
    state.inspectorData[subdomain] = inspector;
    broadcast({ kind: "inspector_changed", subdomain });
    sendJson(res, 200, { request: detail });
    return;
  }

  sendJson(res, 404, { error: { message: `Not found: ${path}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock gateway listening on http://127.0.0.1:${PORT}`);
});
