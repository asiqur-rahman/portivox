// "If it's in your list, you can remove it." A port-only tunnel opened with an
// account-minted API key (via x-api-key, like `portivox open`) must be listed to
// and deletable by that account's panel session (JWT) — the exact real-world
// path. Covers IP-protected port-only, plain port-only, and a subdomain tunnel.
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
      const a = probe.address();
      if (!a || typeof a === "string") { reject(new Error("no free port")); return; }
      const port = a.port;
      probe.close((e) => (e ? reject(e) : resolve(port)));
    });
    probe.on("error", reject);
  });
}
function startLocalApp(port) {
  const s = http.createServer((_q, r) => { r.writeHead(200); r.end("ok"); });
  return new Promise((res, rej) => { s.once("error", rej); s.listen(port, "127.0.0.1", () => res(s)); });
}
function requestJson({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const p = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...(p ? { "content-length": p.length } : {}), ...(headers || {}) } }, (x) => {
      const c = []; x.on("data", (d) => c.push(d)); x.on("end", () => { const raw = Buffer.concat(c).toString(); let b = null; if (raw) { try { b = JSON.parse(raw); } catch { b = raw; } } resolve({ s: x.statusCode, b }); });
    });
    req.on("error", reject); if (p) req.write(p); req.end();
  });
}

function openTunnel({ ws, localPort, apiKey, ipProtection, requestedSubdomain }) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("registration timed out")), 10000);
    const client = new TunnelClient({
      gatewayUrl: `ws://127.0.0.1:${ws}/connect`,
      localBase: `http://127.0.0.1:${localPort}`,
      tunnelType: "http", localTcpHost: "127.0.0.1", localTcpPort: localPort,
      localTimeoutMs: 15000, maxResponseBodyBytes: 2097152,
      withDedicatedPort: true, ipProtection, requestedSubdomain,
      wsHeaders: { "x-api-key": apiKey },
      onRegistered: (i) => { clearTimeout(t); resolve({ client, info: i }); },
      onFatalError: (e) => { clearTimeout(t); reject(new Error(e.message)); },
    });
    client.start();
  });
}

async function main() {
  let gateway; let localServer; let client;
  try {
    const localPort = await getFreePort();
    const gatewayPort = await getFreePort();
    const ws = await getFreePort();
    const tcp = await getFreePort();
    const jwtSecret = "delete-ownership-test-secret-0123456789";
    localServer = await startLocalApp(localPort);
    gateway = createGatewayServer({
      gatewayPort, wsPort: ws, rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 15000, wsIdleTimeoutMs: 30000, maxRequestBodyBytes: 1048576,
      authRequired: true, authJwtSecret: jwtSecret,
      tcpTunnelEnabled: true, tcpTunnelBindHost: "127.0.0.1", tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart: tcp, tcpPublicPortEnd: tcp + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "del@example.com", password: "Test-Password-123" } });
    const token = reg.b.accessToken;
    const userId = reg.b.user.id;
    const adminToken = signAccessToken({ sub: "admin-1", role: "admin", scopes: ["key:manage", "admin:read", "admin:write"] }, jwtSecret, "2h");
    const keyRes = await requestJson({ port: gatewayPort, path: "/api/keys", method: "POST", headers: { authorization: `Bearer ${token}` }, body: { name: "cli-key" } });
    const apiKey = keyRes.b.apiKey.token;

    // Each case: open via x-api-key, confirm it's listed for the JWT owner, then
    // delete via the JWT owner. Must be 204 (never 403 "different identity").
    const cases = [
      { name: "port-only, IP protection ON", ipProtection: true, subdomain: undefined, expectSub: false },
      { name: "port-only, IP protection OFF", ipProtection: false, subdomain: undefined, expectSub: false },
    ];
    for (const c of cases) {
      const opened = await openTunnel({ ws, localPort, apiKey, ipProtection: c.ipProtection, requestedSubdomain: c.subdomain });
      client = opened.client;
      await sleep(250);
      const list = await requestJson({ port: gatewayPort, path: "/api/tunnels", method: "GET", headers: { authorization: `Bearer ${token}` } });
      const t = (list.b.tunnels || []).find((x) => x.publicPort === opened.info.dedicatedTcpPort && !x.subdomain);
      if (!t) throw new Error(`[${c.name}] tunnel not listed for its owner: ${JSON.stringify(list.b.tunnels)}`);
      const del = await requestJson({ port: gatewayPort, path: `/api/tunnels/${encodeURIComponent(t.id)}`, method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (del.s !== 204) throw new Error(`[${c.name}] owner could not delete a listed tunnel: ${del.s} ${JSON.stringify(del.b)}`);
      client.stop(); client = undefined;
      await sleep(200);
    }

    // Subdomain tunnel (subscribed): same guarantee.
    await requestJson({ port: gatewayPort, path: `/api/admin/users/${userId}`, method: "PATCH", headers: { authorization: `Bearer ${adminToken}` }, body: { subdomainEnabled: true } });
    {
      const opened = await openTunnel({ ws, localPort, apiKey, ipProtection: false, requestedSubdomain: "delcase" });
      client = opened.client;
      await sleep(250);
      const list = await requestJson({ port: gatewayPort, path: "/api/tunnels", method: "GET", headers: { authorization: `Bearer ${token}` } });
      const t = (list.b.tunnels || []).find((x) => x.subdomain === "delcase");
      if (!t) throw new Error(`subdomain tunnel not listed for its owner`);
      const del = await requestJson({ port: gatewayPort, path: `/api/tunnels/${encodeURIComponent(t.id)}`, method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (del.s !== 204) throw new Error(`owner could not delete a listed subdomain tunnel: ${del.s} ${JSON.stringify(del.b)}`);
      client.stop(); client = undefined;
    }

    console.log("Tunnel delete-ownership test passed");
  } finally {
    if (client) client.stop();
    if (gateway) await gateway.stop();
    if (localServer) await new Promise((r) => localServer.close(r));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
