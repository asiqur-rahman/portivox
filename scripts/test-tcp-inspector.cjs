// TCP inspector: connecting to a raw/port tunnel produces a connection record
// (source IP, bytes in/out, status) exposed via GET /api/inspect-tcp/:key.
process.env.DATABASE_URL = "";

const http = require("node:http");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

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
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("hello-tcp-inspect"); });
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

function hitPort(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
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
    const jwtSecret = "tcp-inspector-test-secret-0123456789";

    localServer = await startLocalApp(localAppPort);
    gateway = createGatewayServer({
      gatewayPort, wsPort, rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 15000, wsIdleTimeoutMs: 30000, maxRequestBodyBytes: 1048576,
      authRequired: true, authJwtSecret: jwtSecret,
      tcpTunnelEnabled: true, tcpTunnelBindHost: "127.0.0.1", tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart, tcpPublicPortEnd: tcpPublicPortStart + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "tcpi@example.com", password: "Test-Password-123" } });
    if (!reg.body?.accessToken) throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    const token = reg.body.accessToken;

    // Port-only tunnel with the IP gate off so we can connect directly.
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
        ipProtection: false,
        wsHeaders: { authorization: `Bearer ${token}` },
        onRegistered: (i) => { clearTimeout(timeout); resolve(i); },
        onFatalError: (err) => { clearTimeout(timeout); reject(new Error(`fatal: ${err.message}`)); },
      });
      client.start();
    });
    if (!info.dedicatedTcpPort) throw new Error(`expected a port (${JSON.stringify(info)})`);
    await sleep(200);

    // The tunnel list should carry an inspectKey for the port tunnel.
    const list = await requestJson({ port: gatewayPort, path: "/api/tunnels", method: "GET", headers: { authorization: `Bearer ${token}` } });
    const tun = list.body.tunnels.find((t) => t.publicPort === info.dedicatedTcpPort && t.tunnelType === "tcp");
    if (!tun || !tun.inspectKey) throw new Error(`tunnel has no inspectKey: ${JSON.stringify(list.body.tunnels)}`);
    const inspectKey = tun.inspectKey;

    // Drive a connection through the port.
    const r = await hitPort(info.dedicatedTcpPort);
    if (r.statusCode !== 200 || r.body !== "hello-tcp-inspect") throw new Error(`port request failed: ${r.statusCode} ${r.body}`);
    await sleep(300);

    const insp = await requestJson({ port: gatewayPort, path: `/api/inspect-tcp/${encodeURIComponent(inspectKey)}`, method: "GET", headers: { authorization: `Bearer ${token}` } });
    if (insp.statusCode !== 200 || !Array.isArray(insp.body?.connections)) throw new Error(`inspect-tcp failed: ${insp.statusCode} ${JSON.stringify(insp.body)}`);
    if (insp.body.connections.length < 1) throw new Error("expected at least one captured connection");
    const conn = insp.body.connections[0];
    if (!conn.remoteIp) throw new Error(`connection missing remoteIp: ${JSON.stringify(conn)}`);
    if (!(conn.bytesOut > 0)) throw new Error(`expected bytesOut > 0 (response relayed): ${JSON.stringify(conn)}`);

    // Clear works.
    const del = await requestJson({ port: gatewayPort, path: `/api/inspect-tcp/${encodeURIComponent(inspectKey)}`, method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    if (del.statusCode !== 204) throw new Error(`clear failed: ${del.statusCode}`);
    const after = await requestJson({ port: gatewayPort, path: `/api/inspect-tcp/${encodeURIComponent(inspectKey)}`, method: "GET", headers: { authorization: `Bearer ${token}` } });
    if (after.body.connections.length !== 0) throw new Error("connections not cleared");

    console.log("TCP inspector test passed");
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
