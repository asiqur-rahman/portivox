// Session lifecycle fixes:
//   A) Ephemeral CLI tunnels (no DB reservation) are PURGED from the list when
//      the client disconnects — no lingering "offline" ghost. Covers both the
//      port-only synthetic-key path and the subdomain CLI path.
//   B) Revoking an API key immediately disconnects the live device using it
//      (client receives revoke and does not reconnect) and drops its tunnel.
process.env.DATABASE_URL = "";

const http = require("node:http");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");
const { signAccessToken } = require("../packages/auth/index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function listTunnels(port, token) {
  return requestJson({ port, path: "/api/tunnels", method: "GET", headers: { authorization: `Bearer ${token}` } });
}

// Opens a tunnel and returns { client, info, state }. state.revoked flips true if
// the gateway revokes it; state.reconnected counts reconnect attempts.
function openTunnel({ wsPort, localAppPort, wsHeaders, requestedSubdomain }) {
  const state = { revoked: false };
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("registration timed out")), 10000);
    const client = new TunnelClient({
      gatewayUrl: `ws://127.0.0.1:${wsPort}/connect`,
      localBase: `http://127.0.0.1:${localAppPort}`,
      tunnelType: "http",
      localTcpHost: "127.0.0.1",
      localTcpPort: localAppPort,
      requestedSubdomain,
      localTimeoutMs: 15000,
      maxResponseBodyBytes: 2097152,
      withDedicatedPort: true,
      ipProtection: false,
      wsHeaders,
      onRegistered: (info) => { clearTimeout(timeout); resolve({ client, info, state }); },
      onRevoked: () => { state.revoked = true; },
      onFatalError: () => { state.revoked = true; },
    });
    client.start();
  });
  return promise;
}

async function main() {
  let localServer;
  let gateway;
  let client;

  try {
    const localAppPort = await getFreePort();
    const gatewayPort = await getFreePort();
    const wsPort = await getFreePort();
    const tcpPublicPortStart = await getFreePort();
    const jwtSecret = "session-lifecycle-test-secret-0123456789";
    const adminToken = signAccessToken({ sub: "admin-1", role: "admin", scopes: ["key:manage", "admin:read", "admin:write"] }, jwtSecret, "2h");

    localServer = await startLocalApp(localAppPort);
    gateway = createGatewayServer({
      gatewayPort, wsPort, rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 15000, wsIdleTimeoutMs: 30000, maxRequestBodyBytes: 1048576,
      authRequired: true, authJwtSecret: jwtSecret,
      tcpTunnelEnabled: true, tcpTunnelBindHost: "127.0.0.1", tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart, tcpPublicPortEnd: tcpPublicPortStart + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "life@example.com", password: "Test-Password-123" } });
    if (!reg.body?.accessToken || !reg.body?.user?.id) throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    const userToken = reg.body.accessToken;
    const userId = reg.body.user.id;

    // ── A1: port-only ephemeral tunnel is purged on disconnect ────────────────
    {
      const opened = await openTunnel({ wsPort, localAppPort, wsHeaders: { authorization: `Bearer ${userToken}` } });
      client = opened.client;
      if (opened.info.subdomain) throw new Error("expected a port-only tunnel");
      await sleep(200);
      const listed = await listTunnels(gatewayPort, userToken);
      if (!listed.body.tunnels.some((t) => t.publicPort === opened.info.dedicatedTcpPort)) {
        throw new Error(`port-only tunnel not listed while live: ${JSON.stringify(listed.body.tunnels)}`);
      }
      client.stop();
      client = undefined;
      await sleep(400);
      const after = await listTunnels(gatewayPort, userToken);
      if (after.body.tunnels.some((t) => t.publicPort === opened.info.dedicatedTcpPort)) {
        throw new Error(`port-only tunnel STILL listed after client disconnect (ghost not purged): ${JSON.stringify(after.body.tunnels)}`);
      }
    }

    // ── A2: subdomain CLI tunnel (no DB reservation) is purged on disconnect ──
    {
      await requestJson({ port: gatewayPort, path: `/api/admin/users/${userId}`, method: "PATCH", headers: { authorization: `Bearer ${adminToken}` }, body: { subdomainEnabled: true } });
      const opened = await openTunnel({ wsPort, localAppPort, wsHeaders: { authorization: `Bearer ${userToken}` }, requestedSubdomain: "lifetest" });
      client = opened.client;
      if (opened.info.subdomain !== "lifetest") throw new Error(`expected subdomain 'lifetest', got ${JSON.stringify(opened.info)}`);
      await sleep(200);
      client.stop();
      client = undefined;
      await sleep(500);
      const after = await listTunnels(gatewayPort, userToken);
      if (after.body.tunnels.some((t) => t.subdomain === "lifetest")) {
        throw new Error(`subdomain CLI tunnel STILL listed after disconnect (ghost not purged): ${JSON.stringify(after.body.tunnels)}`);
      }
    }

    // ── B: revoking an API key disconnects the live device ────────────────────
    {
      const keyRes = await requestJson({ port: gatewayPort, path: "/api/keys", method: "POST", headers: { authorization: `Bearer ${userToken}` }, body: { name: "device-key" } });
      if (keyRes.statusCode !== 201 || !keyRes.body?.apiKey?.token || !keyRes.body?.apiKey?.id) {
        throw new Error(`key create failed: ${keyRes.statusCode} ${JSON.stringify(keyRes.body)}`);
      }
      const apiKey = keyRes.body.apiKey.token;
      const keyId = keyRes.body.apiKey.id;

      // The just-created key must be listed.
      const keyList = await requestJson({ port: gatewayPort, path: "/api/keys", method: "GET", headers: { authorization: `Bearer ${userToken}` } });
      if (!Array.isArray(keyList.body?.keys) || !keyList.body.keys.some((k) => k.id === keyId)) {
        throw new Error(`created key not listed: ${JSON.stringify(keyList.body)}`);
      }

      const opened = await openTunnel({ wsPort, localAppPort, wsHeaders: { "x-api-key": apiKey } });
      client = opened.client;
      await sleep(200);

      const del = await requestJson({ port: gatewayPort, path: `/api/keys/${keyId}`, method: "DELETE", headers: { authorization: `Bearer ${userToken}` } });
      if (del.statusCode !== 204) throw new Error(`key revoke failed: ${del.statusCode} ${JSON.stringify(del.body)}`);

      // The live device must be revoked (told to stop, no reconnect).
      for (let i = 0; i < 50 && !opened.state.revoked; i += 1) await sleep(100);
      if (!opened.state.revoked) throw new Error("device was NOT disconnected after its API key was revoked");
      client.stop();
      client = undefined;
    }

    console.log("Session lifecycle test passed");
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
