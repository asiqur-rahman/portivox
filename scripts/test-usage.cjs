// Usage metering: bytes relayed and HTTP request latency are attributed to the
// tunnel owner and surfaced by GET /api/usage.
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
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("hello-usage"); });
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

function requestSubdomain(gatewayPort, subdomain, rootDomain) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: gatewayPort, path: "/", method: "GET", headers: { Host: `${subdomain}.${rootDomain}` } },
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

async function main() {
  let localServer;
  let gateway;
  let client;

  try {
    const localAppPort = await getFreePort();
    const gatewayPort = await getFreePort();
    const wsPort = await getFreePort();
    const tcpPublicPortStart = await getFreePort();
    const jwtSecret = "usage-test-secret-0123456789-abcdef00";
    const rootDomain = "portivox.braintechsolution.com";
    const adminToken = signAccessToken({ sub: "admin-1", role: "admin", scopes: ["key:manage", "admin:read", "admin:write"] }, jwtSecret, "2h");

    localServer = await startLocalApp(localAppPort);
    gateway = createGatewayServer({
      gatewayPort, wsPort, rootDomain,
      tunnelResponseTimeoutMs: 15000, wsIdleTimeoutMs: 30000, maxRequestBodyBytes: 1048576,
      authRequired: true, authJwtSecret: jwtSecret,
      tcpTunnelEnabled: true, tcpTunnelBindHost: "127.0.0.1", tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart, tcpPublicPortEnd: tcpPublicPortStart + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "usage@example.com", password: "Test-Password-123" } });
    if (!reg.body?.accessToken || !reg.body?.user?.id) throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    const token = reg.body.accessToken;

    // Grant subdomain access so we get an HTTP subdomain tunnel (metered per request).
    await requestJson({ port: gatewayPort, path: `/api/admin/users/${reg.body.user.id}`, method: "PATCH", headers: { authorization: `Bearer ${adminToken}` }, body: { subdomainEnabled: true } });

    const info = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("registration timed out")), 10000);
      client = new TunnelClient({
        gatewayUrl: `ws://127.0.0.1:${wsPort}/connect`,
        localBase: `http://127.0.0.1:${localAppPort}`,
        tunnelType: "http",
        localTcpHost: "127.0.0.1",
        localTcpPort: localAppPort,
        requestedSubdomain: "usagetest",
        localTimeoutMs: 15000,
        maxResponseBodyBytes: 2097152,
        withDedicatedPort: false,
        ipProtection: false,
        wsHeaders: { authorization: `Bearer ${token}` },
        onRegistered: (i) => { clearTimeout(timeout); resolve(i); },
        onFatalError: (err) => { clearTimeout(timeout); reject(new Error(`fatal: ${err.message}`)); },
      });
      client.start();
    });
    if (info.subdomain !== "usagetest") throw new Error(`expected subdomain usagetest, got ${JSON.stringify(info)}`);
    await sleep(200);

    // Baseline: no traffic yet.
    const before = await requestJson({ port: gatewayPort, path: "/api/usage", method: "GET", headers: { authorization: `Bearer ${token}` } });
    if (before.statusCode !== 200) throw new Error(`usage endpoint failed: ${before.statusCode} ${JSON.stringify(before.body)}`);
    if (before.body.requests !== 0 || before.body.totalBytes !== 0) throw new Error(`expected zero baseline, got ${JSON.stringify(before.body)}`);

    // Drive 3 requests through the tunnel.
    const N = 3;
    for (let i = 0; i < N; i += 1) {
      const r = await requestSubdomain(gatewayPort, "usagetest", rootDomain);
      if (r.statusCode !== 200 || r.body !== "hello-usage") throw new Error(`tunneled request failed: ${r.statusCode} ${r.body}`);
    }
    await sleep(150);

    const after = await requestJson({ port: gatewayPort, path: "/api/usage", method: "GET", headers: { authorization: `Bearer ${token}` } });
    if (after.statusCode !== 200) throw new Error(`usage endpoint failed: ${after.statusCode}`);
    if (after.body.requests !== N) throw new Error(`expected ${N} requests, got ${after.body.requests} (${JSON.stringify(after.body)})`);
    if (!(after.body.totalBytes > 0) || !(after.body.bytesOut > 0)) throw new Error(`expected bytes transferred, got ${JSON.stringify(after.body)}`);
    if (typeof after.body.avgLatencyMs !== "number" || after.body.avgLatencyMs < 0) throw new Error(`bad avgLatencyMs: ${JSON.stringify(after.body)}`);
    if (typeof after.body.since !== "string") throw new Error("usage should report a 'since' timestamp");

    console.log("Usage metering test passed");
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
