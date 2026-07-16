// Bidirectional real-time control test:
//   - A port-only tunnel opened by a client (no subdomain subscription) must be
//     VISIBLE in the admin tunnel list (GET /api/admin/tunnels).
//   - Destroying it from the admin side (DELETE /api/tunnels/:id) must REVOKE the
//     live client (tunnel_revoked) and remove it from the list.
//   - The owner must also be able to destroy their own port-only tunnel.
process.env.DATABASE_URL = "";

const http = require("node:http");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");
const { signAccessToken } = require("../packages/auth/index.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") { reject(new Error("no free port")); return; }
      const port = address.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

function startLocalApp(port) {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function requestJson({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...(payload ? { "content-length": String(payload.length) } : {}), ...(headers || {}) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openPortOnly({ wsPort, localAppPort, token }) {
  const state = { revoked: false };
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("registration timed out")), 10000);
    const client = new TunnelClient({
      gatewayUrl: `ws://127.0.0.1:${wsPort}/connect`,
      localBase: `http://127.0.0.1:${localAppPort}`,
      tunnelType: "http",
      localTcpHost: "127.0.0.1",
      localTcpPort: localAppPort,
      localTimeoutMs: 15000,
      maxResponseBodyBytes: 2097152,
      withDedicatedPort: true,
      wsHeaders: { authorization: `Bearer ${token}` },
      onRegistered: (info) => { clearTimeout(timeout); resolve({ client, info }); },
      onRevoked: () => { state.revoked = true; },
      onFatalError: (err) => { clearTimeout(timeout); reject(new Error(`fatal: ${err.message}`)); },
    });
    client.start();
  });
  return { promise, state };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let localServer;
  let gateway;
  let client;

  try {
    const localAppPort = await getFreePort();
    const gatewayPort = await getFreePort();
    const wsPort = await getFreePort();
    const tcpPublicPortStart = await getFreePort();
    const jwtSecret = "admin-tunnel-control-test-secret-0123456789";
    const rootDomain = "portivox.braintechsolution.com";

    localServer = await startLocalApp(localAppPort);
    gateway = createGatewayServer({
      gatewayPort,
      wsPort,
      rootDomain,
      tunnelResponseTimeoutMs: 15000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: true,
      authJwtSecret: jwtSecret,
      httpPublicPortMode: true,
      tcpTunnelEnabled: true,
      tcpTunnelBindHost: "127.0.0.1",
      tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart,
      tcpPublicPortEnd: tcpPublicPortStart + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "port-user@example.com", password: "Test-Password-123" } });
    if ((reg.statusCode !== 200 && reg.statusCode !== 201) || !reg.body?.accessToken) {
      throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    }
    const userToken = reg.body.accessToken;
    const adminToken = signAccessToken({ sub: "admin-1", role: "admin", scopes: ["key:manage", "admin:read", "admin:write", "tunnel:read", "tunnel:delete"] }, jwtSecret, "2h");

    // ── Part A: admin sees the port-only tunnel and destroys it → client revoked.
    {
      const opened = openPortOnly({ wsPort, localAppPort, token: userToken });
      const { client: c1, info } = await opened.promise;
      client = c1;
      if (info.subdomain || !info.dedicatedTcpPort) {
        throw new Error(`expected port-only tunnel, got ${JSON.stringify(info)}`);
      }
      await sleep(200);

      const list = await requestJson({ port: gatewayPort, path: "/api/admin/tunnels", method: "GET", headers: { authorization: `Bearer ${adminToken}` } });
      if (list.statusCode !== 200 || !Array.isArray(list.body?.tunnels)) {
        throw new Error(`admin list failed: ${list.statusCode} ${JSON.stringify(list.body)}`);
      }
      const found = list.body.tunnels.find((t) => t.tunnelType === "tcp" && !t.subdomain && t.publicPort === info.dedicatedTcpPort);
      if (!found) {
        throw new Error(`port-only tunnel not visible to admin — tunnels: ${JSON.stringify(list.body.tunnels)}`);
      }
      if (!found.active) {
        throw new Error(`port-only tunnel should be active/live in admin list: ${JSON.stringify(found)}`);
      }

      const del = await requestJson({ port: gatewayPort, path: `/api/tunnels/${encodeURIComponent(found.id)}`, method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } });
      if (del.statusCode !== 204) {
        throw new Error(`admin destroy failed: ${del.statusCode} ${JSON.stringify(del.body)}`);
      }

      for (let i = 0; i < 50 && !opened.state.revoked; i += 1) await sleep(100);
      if (!opened.state.revoked) {
        throw new Error("client did not receive tunnel_revoked after admin destroy");
      }
      await sleep(200);
      const list2 = await requestJson({ port: gatewayPort, path: "/api/admin/tunnels", method: "GET", headers: { authorization: `Bearer ${adminToken}` } });
      if (list2.body?.tunnels?.some((t) => t.publicPort === info.dedicatedTcpPort && !t.subdomain)) {
        throw new Error("port-only tunnel still listed after admin destroy");
      }
      client.stop();
      client = undefined;
      await sleep(200);
    }

    // ── Part B: the owner can destroy their own port-only tunnel.
    {
      const opened = openPortOnly({ wsPort, localAppPort, token: userToken });
      const { client: c2, info } = await opened.promise;
      client = c2;
      await sleep(200);
      // The owner lists their own tunnels and deletes by id.
      const mine = await requestJson({ port: gatewayPort, path: "/api/tunnels", method: "GET", headers: { authorization: `Bearer ${userToken}` } });
      const own = mine.body?.tunnels?.find((t) => t.publicPort === info.dedicatedTcpPort && !t.subdomain);
      if (!own) {
        throw new Error(`owner cannot see their own port-only tunnel: ${JSON.stringify(mine.body)}`);
      }
      const del = await requestJson({ port: gatewayPort, path: `/api/tunnels/${encodeURIComponent(own.id)}`, method: "DELETE", headers: { authorization: `Bearer ${userToken}` } });
      if (del.statusCode !== 204) {
        throw new Error(`owner destroy failed (was 403 before the fix?): ${del.statusCode} ${JSON.stringify(del.body)}`);
      }
      for (let i = 0; i < 50 && !opened.state.revoked; i += 1) await sleep(100);
      if (!opened.state.revoked) {
        throw new Error("client did not receive tunnel_revoked after owner destroy");
      }
      client.stop();
      client = undefined;
    }

    console.log("Admin/owner tunnel control (real-time bidirectional) test passed");
  } finally {
    if (client) client.stop();
    if (gateway) await gateway.stop();
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
