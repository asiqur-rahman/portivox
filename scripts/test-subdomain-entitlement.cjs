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
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("entitlement-ok");
  });
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

function requestHttp(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers: hostHeader ? { Host: hostHeader } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function openTunnel({ wsPort, localAppPort, token }) {
  return new Promise((resolve, reject) => {
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
      onFatalError: (err) => { clearTimeout(timeout); reject(new Error(`fatal: ${err.message}`)); },
    });
    client.start();
  });
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
    const jwtSecret = "subdomain-entitlement-test-secret-0123456789";
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

    // Register a normal user (subdomainEnabled defaults to false).
    const reg = await requestJson({
      port: gatewayPort,
      path: "/api/auth/register",
      method: "POST",
      body: { email: "user@example.com", password: "Test-Password-123" },
    });
    if ((reg.statusCode !== 200 && reg.statusCode !== 201) || !reg.body?.user?.id || !reg.body?.accessToken) {
      throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    }
    const userId = reg.body.user.id;
    const userToken = reg.body.accessToken;

    // 1) Without the entitlement → PORT-ONLY (no subdomain), reachable over the port.
    {
      const opened = await openTunnel({ wsPort, localAppPort, token: userToken });
      client = opened.client;
      if (opened.info.subdomain) {
        throw new Error(`expected port-only, but got subdomain "${opened.info.subdomain}"`);
      }
      if (!opened.info.dedicatedTcpPort) {
        throw new Error(`expected a dedicated port for the port-only tunnel (${JSON.stringify(opened.info)})`);
      }
      const viaPort = await requestHttp(opened.info.dedicatedTcpPort);
      if (viaPort.statusCode !== 200 || viaPort.body !== "entitlement-ok") {
        throw new Error(`port path failed: ${viaPort.statusCode} ${viaPort.body}`);
      }
      client.stop();
      client = undefined;
      await new Promise((r) => setTimeout(r, 300));
    }

    // 2) Admin grants the subdomain entitlement.
    const adminToken = signAccessToken({ sub: "admin-1", role: "admin", scopes: ["key:manage", "admin:read", "admin:write"] }, jwtSecret, "2h");

    const listRes = await requestJson({ port: gatewayPort, path: "/api/admin/users", method: "GET", headers: { authorization: `Bearer ${adminToken}` } });
    if (listRes.statusCode !== 200 || !Array.isArray(listRes.body?.users) || !listRes.body.users.some((u) => u.id === userId)) {
      throw new Error(`admin list users failed: ${listRes.statusCode} ${JSON.stringify(listRes.body)}`);
    }

    const patchRes = await requestJson({
      port: gatewayPort,
      path: `/api/admin/users/${userId}`,
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: { subdomainEnabled: true },
    });
    if (patchRes.statusCode !== 200 || patchRes.body?.user?.subdomainEnabled !== true) {
      throw new Error(`admin toggle failed: ${patchRes.statusCode} ${JSON.stringify(patchRes.body)}`);
    }

    // An owner must NOT be able to call the admin endpoint.
    const ownerDenied = await requestJson({
      port: gatewayPort,
      path: `/api/admin/users/${userId}`,
      method: "PATCH",
      headers: { authorization: `Bearer ${userToken}` },
      body: { subdomainEnabled: false },
    });
    if (ownerDenied.statusCode !== 403) {
      throw new Error(`owner should be denied admin toggle: expected 403 got ${ownerDenied.statusCode}`);
    }

    // 3) With the entitlement → a subdomain is assigned (and the port too).
    {
      const opened = await openTunnel({ wsPort, localAppPort, token: userToken });
      client = opened.client;
      if (!opened.info.subdomain) {
        throw new Error(`expected a subdomain after entitlement granted (${JSON.stringify(opened.info)})`);
      }
      const viaSubdomain = await requestHttp(gatewayPort, `${opened.info.subdomain}.${rootDomain}`);
      if (viaSubdomain.statusCode !== 200 || viaSubdomain.body !== "entitlement-ok") {
        throw new Error(`subdomain path failed: ${viaSubdomain.statusCode} ${viaSubdomain.body}`);
      }
      client.stop();
      client = undefined;
    }

    console.log("Subdomain entitlement test passed");
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
