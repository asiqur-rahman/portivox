const http = require("node:http");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { signAccessToken } = require("../packages/auth/index.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
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
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw) {
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  let server;
  try {
    const gatewayPort = await getFreePort();
    const wsPort = await getFreePort();
    const jwtSecret = "integration-secret";
    const userToken = signAccessToken({ sub: "user-alpha", scopes: ["key:manage", "tunnel:read", "tunnel:create", "tunnel:delete"] }, jwtSecret, "2h");
    const otherToken = signAccessToken({ sub: "user-beta" }, jwtSecret, "2h");
    const viewerToken = signAccessToken({ sub: "user-viewer", role: "viewer", scopes: ["key:manage", "tunnel:read"] }, jwtSecret, "2h");

    server = createGatewayServer({
      gatewayPort,
      wsPort,
      rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 10000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: true,
      authApiKeys: "bootstrap-static-key",
      authJwtSecret: jwtSecret,
    });

    await server.start();
    await sleep(200);

    const createKeyRes = await requestJson({
      port: gatewayPort,
      path: "/api/keys",
      method: "POST",
      headers: { authorization: `Bearer ${userToken}` },
      body: { name: "ci-key" },
    });
    if (createKeyRes.statusCode !== 201 || !createKeyRes.body?.apiKey?.token) {
      throw new Error(`api key create failed: ${createKeyRes.statusCode} ${JSON.stringify(createKeyRes.body)}`);
    }
    const issuedApiKey = createKeyRes.body.apiKey.token;

    const viewerDeniedKeyCreate = await requestJson({
      port: gatewayPort,
      path: "/api/keys",
      method: "POST",
      headers: { authorization: `Bearer ${viewerToken}` },
      body: { name: "viewer-should-fail" },
    });
    if (viewerDeniedKeyCreate.statusCode !== 403) {
      throw new Error(`role check failed: expected 403 got ${viewerDeniedKeyCreate.statusCode}`);
    }

    const viewerDeniedAdminState = await requestJson({
      port: gatewayPort,
      path: "/api/admin/state",
      method: "POST",
      headers: { authorization: `Bearer ${viewerToken}` },
      body: { maintenanceMode: true },
    });
    if (viewerDeniedAdminState.statusCode !== 403) {
      throw new Error(`admin state role check failed: expected 403 got ${viewerDeniedAdminState.statusCode}`);
    }

    const ownerAdminState = await requestJson({
      port: gatewayPort,
      path: "/api/admin/state",
      method: "POST",
      headers: { authorization: `Bearer ${userToken}` },
      body: { maintenanceMode: false, draining: false },
    });
    if (ownerAdminState.statusCode !== 200) {
      throw new Error(`admin state update failed: ${ownerAdminState.statusCode}`);
    }

    const readOnlyKeyRes = await requestJson({
      port: gatewayPort,
      path: "/api/keys",
      method: "POST",
      headers: { authorization: `Bearer ${userToken}` },
      body: { name: "read-only", scopes: "tunnel:read" },
    });
    if (readOnlyKeyRes.statusCode !== 201 || !readOnlyKeyRes.body?.apiKey?.token) {
      throw new Error(`read-only key create failed: ${readOnlyKeyRes.statusCode} ${JSON.stringify(readOnlyKeyRes.body)}`);
    }
    const readOnlyKey = readOnlyKeyRes.body.apiKey.token;

    const scopeDeniedCreate = await requestJson({
      port: gatewayPort,
      path: "/api/tunnels",
      method: "POST",
      headers: { "x-api-key": readOnlyKey },
      body: { subdomain: "should-deny" },
    });
    if (scopeDeniedCreate.statusCode !== 403) {
      throw new Error(`scope check failed: expected 403 got ${scopeDeniedCreate.statusCode}`);
    }

    const createTunnelRes = await requestJson({
      port: gatewayPort,
      path: "/api/tunnels",
      method: "POST",
      headers: { "x-api-key": issuedApiKey },
      body: { subdomain: "owned-alpha" },
    });
    if (createTunnelRes.statusCode !== 201 || !createTunnelRes.body?.tunnel?.id) {
      throw new Error(`tunnel create failed: ${createTunnelRes.statusCode} ${JSON.stringify(createTunnelRes.body)}`);
    }
    const tunnelId = createTunnelRes.body.tunnel.id;

    const forbiddenDelete = await requestJson({
      port: gatewayPort,
      path: `/api/tunnels/${tunnelId}`,
      method: "DELETE",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    if (forbiddenDelete.statusCode !== 403) {
      throw new Error(`ownership check failed: expected 403 got ${forbiddenDelete.statusCode}`);
    }

    const ownerDelete = await requestJson({
      port: gatewayPort,
      path: `/api/tunnels/${tunnelId}`,
      method: "DELETE",
      headers: { "x-api-key": issuedApiKey },
    });
    if (ownerDelete.statusCode !== 204) {
      throw new Error(`owner delete failed: ${ownerDelete.statusCode} ${JSON.stringify(ownerDelete.body)}`);
    }

    console.log("Auth integration test passed");
  } finally {
    if (server) {
      await server.stop();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

