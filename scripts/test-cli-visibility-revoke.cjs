// Integration test for the two behaviors reported by the user:
//   1. A tunnel opened by the CLI client (authenticated with a key minted in the
//      web account) MUST appear in GET /api/tunnels for that account's JWT user.
//   2. Removing that tunnel from the web (DELETE /api/tunnels/:id) MUST terminate
//      the live client (tunnel_revoked) and make the tunnel disappear.
process.env.DATABASE_URL = "";

const http = require("node:http");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
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
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(payload.length) } : {}),
          ...(headers || {}),
        },
      },
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

function startLocalApp(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  let localServer;
  let gateway;
  let client;
  try {
    const localAppPort = await getFreePort();
    const gatewayHttpPort = await getFreePort();
    const gatewayWsPort = await getFreePort();

    localServer = await startLocalApp(localAppPort);

    gateway = createGatewayServer({
      gatewayPort: gatewayHttpPort,
      wsPort: gatewayWsPort,
      rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 10000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: true,
      authJwtSecret: "cli-visibility-integration-secret-key",
      // Disable public-port binding so the HTTP tunnel routes purely by subdomain
      // (keeps the test independent of the TCP/HTTP public port pool).
      httpPublicPortMode: false,
    });
    await gateway.start();
    await sleep(150);

    // 1) Register a web-account user → JWT.
    const reg = await requestJson({
      port: gatewayHttpPort,
      path: "/api/auth/register",
      method: "POST",
      body: { email: "cli-user@example.com", password: "password123" },
    });
    if (reg.statusCode !== 201 || !reg.body?.accessToken) {
      throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    }
    const jwt = reg.body.accessToken;
    const auth = { authorization: `Bearer ${jwt}` };

    // 2) Mint an API key from that account (owned by this user).
    const keyRes = await requestJson({
      port: gatewayHttpPort,
      path: "/api/keys",
      method: "POST",
      headers: auth,
      body: { name: "cli-key" },
    });
    if (keyRes.statusCode !== 201 || !keyRes.body?.apiKey?.token) {
      throw new Error(`key create failed: ${keyRes.statusCode} ${JSON.stringify(keyRes.body)}`);
    }
    const apiKey = keyRes.body.apiKey.token;

    // 3) Open a CLI tunnel using that key.
    let revoked = false;
    const registeredInfo = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("tunnel registration timed out")), 10000);
      client = new TunnelClient({
        gatewayUrl: `ws://127.0.0.1:${gatewayWsPort}/connect`,
        localBase: `http://127.0.0.1:${localAppPort}`,
        localTimeoutMs: 10000,
        maxResponseBodyBytes: 2097152,
        wsHeaders: { "x-api-key": apiKey },
        heartbeatIntervalMs: 1000,
        onRegistered: (info) => { clearTimeout(timeout); resolve(info); },
        onRevoked: () => { revoked = true; },
      });
      client.start();
    });
    const subdomain = registeredInfo.subdomain;
    if (!subdomain) {
      throw new Error(`expected a subdomain, got ${JSON.stringify(registeredInfo)}`);
    }
    await sleep(200);

    // 4) The account's JWT user must SEE the CLI tunnel.
    const list1 = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels", method: "GET", headers: auth });
    if (list1.statusCode !== 200 || !Array.isArray(list1.body?.tunnels)) {
      throw new Error(`list tunnels failed: ${list1.statusCode} ${JSON.stringify(list1.body)}`);
    }
    const found = list1.body.tunnels.find((t) => t.subdomain === subdomain);
    if (!found) {
      throw new Error(`CLI tunnel '${subdomain}' not visible to its account user — tunnels: ${JSON.stringify(list1.body.tunnels)}`);
    }
    if (!found.isCliSession || !found.active) {
      throw new Error(`CLI tunnel present but wrong state: ${JSON.stringify(found)}`);
    }

    // 5) Remove it from the web using the CLI id (cli_<subdomain>).
    const del = await requestJson({
      port: gatewayHttpPort,
      path: `/api/tunnels/${encodeURIComponent(found.id)}`,
      method: "DELETE",
      headers: auth,
    });
    if (del.statusCode !== 204) {
      throw new Error(`delete failed: expected 204 got ${del.statusCode} ${JSON.stringify(del.body)}`);
    }

    // 6) The client must be revoked (told to close, no reconnect).
    for (let i = 0; i < 50 && !revoked; i += 1) {
      await sleep(100);
    }
    if (!revoked) {
      throw new Error("client did not receive tunnel_revoked after web deletion");
    }

    // 7) The tunnel must no longer be listed.
    await sleep(200);
    const list2 = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels", method: "GET", headers: auth });
    if (list2.body?.tunnels?.some((t) => t.subdomain === subdomain)) {
      throw new Error(`tunnel '${subdomain}' still listed after revocation`);
    }

    // 8) Ownership guard: a different user must NOT be able to delete someone's tunnel.
    const reg2 = await requestJson({
      port: gatewayHttpPort,
      path: "/api/auth/register",
      method: "POST",
      body: { email: "other-user@example.com", password: "password123" },
    });
    const otherAuth = { authorization: `Bearer ${reg2.body.accessToken}` };
    const crossDelete = await requestJson({
      port: gatewayHttpPort,
      path: `/api/tunnels/${encodeURIComponent("cli_someoneelse")}`,
      method: "DELETE",
      headers: otherAuth,
    });
    if (crossDelete.statusCode !== 403 && crossDelete.statusCode !== 404) {
      throw new Error(`cross-user delete should be denied, got ${crossDelete.statusCode}`);
    }

    console.log("CLI visibility + web revoke integration test passed");
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
