// IP-link protection for port-only tunnels:
//   - The exposed public port is DARK until the secret access link (/l/:token)
//     is opened; connections from a non-whitelisted IP are dropped.
//   - After opening the link (whitelisting the caller IP), the port is reachable.
process.env.DATABASE_URL = "";

const http = require("node:http");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

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

// Returns { ok: true, body } on a 200, or { ok: false } if the connection is
// blocked/reset/timed out (i.e. the port is dark for this IP).
function tryReachPort(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => resolve({ ok: res.statusCode === 200, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.on("error", () => resolve({ ok: false }));
    req.end();
  });
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
    const jwtSecret = "ip-link-protection-test-secret-0123456789";

    localServer = await startLocalApp(localAppPort);
    gateway = createGatewayServer({
      gatewayPort,
      wsPort,
      rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 15000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: true,
      authJwtSecret: jwtSecret,
      tcpTunnelEnabled: true,
      tcpTunnelBindHost: "127.0.0.1",
      tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart,
      tcpPublicPortEnd: tcpPublicPortStart + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "gate-user@example.com", password: "Test-Password-123" } });
    if ((reg.statusCode !== 200 && reg.statusCode !== 201) || !reg.body?.accessToken) {
      throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    }
    const userToken = reg.body.accessToken;

    const info = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("registration timed out")), 10000);
      client = new TunnelClient({
        gatewayUrl: `ws://127.0.0.1:${wsPort}/connect`,
        localBase: `http://127.0.0.1:${localAppPort}`,
        tunnelType: "http",
        localTcpHost: "127.0.0.1",
        localTcpPort: localAppPort,
        localTimeoutMs: 15000,
        maxResponseBodyBytes: 2097152,
        withDedicatedPort: true,
        ipProtection: true,
        wsHeaders: { authorization: `Bearer ${userToken}` },
        onRegistered: (i) => { clearTimeout(timeout); resolve(i); },
        onFatalError: (err) => { clearTimeout(timeout); reject(new Error(`fatal: ${err.message}`)); },
      });
      client.start();
    });

    if (!info.dedicatedTcpPort) throw new Error(`expected a port (${JSON.stringify(info)})`);
    if (!info.accessLink) throw new Error(`expected an access link for the IP-protected tunnel (${JSON.stringify(info)})`);
    await sleep(200);

    // 1) Before opening the link, the port is dark for our IP.
    const before = await tryReachPort(info.dedicatedTcpPort);
    if (before.ok) {
      throw new Error("port was reachable BEFORE the access link was opened (IP protection not enforced)");
    }

    // 2) Open the access link (whitelists 127.0.0.1). Hit the gateway directly.
    const token = String(info.accessLink).split("/l/")[1];
    if (!token) throw new Error(`could not extract token from access link: ${info.accessLink}`);
    const grant = await requestJson({ port: gatewayPort, path: `/l/${token}`, method: "GET" });
    if (grant.statusCode !== 200 || grant.body?.whitelisted !== true) {
      throw new Error(`access link did not whitelist: ${grant.statusCode} ${JSON.stringify(grant.body)}`);
    }

    // 3) Now the port is reachable.
    const after = await tryReachPort(info.dedicatedTcpPort);
    if (!after.ok || after.body !== "ok") {
      throw new Error(`port not reachable AFTER opening the access link: ${JSON.stringify(after)}`);
    }

    // 4) A browser (Accept: text/html) gets the friendly landing page.
    const htmlPage = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: gatewayPort, path: `/l/${token}`, method: "GET", headers: { accept: "text/html" } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, contentType: String(res.headers["content-type"] || ""), body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    if (htmlPage.statusCode !== 200 || !htmlPage.contentType.includes("text/html")) {
      throw new Error(`access link did not return an HTML page: ${htmlPage.statusCode} ${htmlPage.contentType}`);
    }
    if (!htmlPage.body.includes("Access granted") || !htmlPage.body.includes(String(info.dedicatedTcpPort))) {
      throw new Error("access-link HTML page missing expected content (confirmation or endpoint)");
    }

    console.log("IP-link protection test passed");
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
