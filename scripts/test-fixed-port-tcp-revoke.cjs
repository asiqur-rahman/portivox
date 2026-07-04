// Verifies that an admin-configured FIXED-PORT TCP tunnel (synthetic key, no
// subdomain) is:
//   1. visible in GET /api/tunnels for the account that opened it, and
//   2. removable from the web (DELETE cli_tcpport_<port>) — which revokes the
//      live client and frees the public port.
process.env.DATABASE_URL = "";

const http = require("node:http");
const net = require("node:net");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

function requestJson({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request(
      { host: "127.0.0.1", port, path, method,
        headers: { "content-type": "application/json", ...(payload ? { "content-length": String(payload.length) } : {}), ...(headers || {}) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null; if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startEcho(port) {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(Buffer.from(chunk.toString("utf8").toUpperCase())));
    socket.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  let echo, gateway, client;
  try {
    const localPort = await getFreePort();
    const gatewayHttpPort = await getFreePort();
    const gatewayWsPort = await getFreePort();
    const fixedPublicPort = await getFreePort();

    echo = await startEcho(localPort);

    gateway = createGatewayServer({
      gatewayPort: gatewayHttpPort,
      wsPort: gatewayWsPort,
      rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 10000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: true,
      authJwtSecret: "fixed-port-tcp-integration-secret-value",
      adminEmails: "admin@example.com",
      tcpTunnelEnabled: true,
      tcpTunnelBindHost: "127.0.0.1",
      tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart: await getFreePort(),
      tcpPublicPortEnd: 65000,
      ipProtectionDefault: false, // allow direct TCP connect in the test
    });
    await gateway.start();
    await sleep(150);

    // Admin provisions a fixed-port mapping localPort → fixedPublicPort.
    const adminReg = await requestJson({ port: gatewayHttpPort, path: "/api/auth/register", method: "POST", body: { email: "admin@example.com", password: "password123" } });
    if (adminReg.statusCode !== 201) throw new Error(`admin register failed: ${adminReg.statusCode}`);
    const adminAuth = { authorization: `Bearer ${adminReg.body.accessToken}` };
    const mapRes = await requestJson({ port: gatewayHttpPort, path: "/api/admin/tcp-port-mappings", method: "POST", headers: adminAuth,
      body: { name: "ssh", localPort, publicPort: fixedPublicPort } });
    if (mapRes.statusCode !== 201) throw new Error(`mapping create failed: ${mapRes.statusCode} ${JSON.stringify(mapRes.body)}`);

    // Account user mints a key and opens the fixed-port TCP tunnel.
    const userReg = await requestJson({ port: gatewayHttpPort, path: "/api/auth/register", method: "POST", body: { email: "user@example.com", password: "password123" } });
    const userAuth = { authorization: `Bearer ${userReg.body.accessToken}` };
    const keyRes = await requestJson({ port: gatewayHttpPort, path: "/api/keys", method: "POST", headers: userAuth, body: { name: "k" } });
    const apiKey = keyRes.body.apiKey.token;

    let revoked = false;
    const info = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tcp tunnel registration timed out")), 10000);
      client = new TunnelClient({
        gatewayUrl: `ws://127.0.0.1:${gatewayWsPort}/connect`,
        localBase: `http://127.0.0.1:${localPort}`,
        tunnelType: "tcp",
        localTcpHost: "127.0.0.1",
        localTcpPort: localPort,
        ipProtection: false,
        localTimeoutMs: 10000,
        maxResponseBodyBytes: 2097152,
        wsHeaders: { "x-api-key": apiKey },
        heartbeatIntervalMs: 1000,
        onRegistered: (i) => { clearTimeout(timeout); resolve(i); },
        onRevoked: () => { revoked = true; },
      });
      client.start();
    });
    if (info.publicTcpPort !== fixedPublicPort) {
      throw new Error(`expected fixed public port ${fixedPublicPort}, got ${info.publicTcpPort}`);
    }
    await sleep(200);

    // Visible to the account user as a fixed-port TCP session.
    const list1 = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels", method: "GET", headers: userAuth });
    const tcp = list1.body.tunnels.find((t) => t.publicPort === fixedPublicPort && t.tunnelType === "tcp");
    if (!tcp) throw new Error(`fixed-port TCP tunnel not visible: ${JSON.stringify(list1.body.tunnels)}`);
    if (tcp.id !== `cli_tcpport_${fixedPublicPort}`) throw new Error(`unexpected id: ${tcp.id}`);

    // Remove it from the web → client revoked and public port freed.
    const del = await requestJson({ port: gatewayHttpPort, path: `/api/tunnels/${encodeURIComponent(tcp.id)}`, method: "DELETE", headers: userAuth });
    if (del.statusCode !== 204) throw new Error(`delete failed: ${del.statusCode} ${JSON.stringify(del.body)}`);

    for (let i = 0; i < 50 && !revoked; i += 1) await sleep(100);
    if (!revoked) throw new Error("client was not revoked after fixed-port TCP deletion");

    await sleep(200);
    const list2 = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels", method: "GET", headers: userAuth });
    if (list2.body.tunnels.some((t) => t.publicPort === fixedPublicPort)) {
      throw new Error("fixed-port TCP tunnel still listed after revocation");
    }

    console.log("Fixed-port TCP visibility + revoke test passed");
  } finally {
    if (client) client.stop();
    if (gateway) await gateway.stop();
    if (echo) await new Promise((r) => echo.close(r));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
