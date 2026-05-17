const http = require("node:http");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");

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

function requestJson({ port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const gatewayHttpPort = await getFreePort();
  const gatewayWsPort = await getFreePort();
  const gateway = createGatewayServer({
    gatewayPort: gatewayHttpPort,
    wsPort: gatewayWsPort,
    rootDomain: "portivox.braintechsolution.com",
    tunnelResponseTimeoutMs: 5000,
    wsIdleTimeoutMs: 10000,
    maxRequestBodyBytes: 1048576,
    authRequired: false,
  });

  try {
    await gateway.start();

    const invalidTunnel = await requestJson({
      port: gatewayHttpPort,
      method: "POST",
      path: "/api/tunnels",
      body: { subdomain: "validname", extra: "nope" },
    });
    assert(invalidTunnel.statusCode === 400, `expected 400 invalid tunnel body, got ${invalidTunnel.statusCode}`);

    const invalidKey = await requestJson({
      port: gatewayHttpPort,
      method: "POST",
      path: "/api/keys",
      body: { name: "goodname", bad: true },
    });
    assert(invalidKey.statusCode === 400 || invalidKey.statusCode === 403, `expected 400/403 for /api/keys invalid body got ${invalidKey.statusCode}`);

    const invalidAdmin = await requestJson({
      port: gatewayHttpPort,
      method: "POST",
      path: "/api/admin/state",
      body: { maintenanceMode: true, bad: true },
    });
    assert(invalidAdmin.statusCode === 400, `expected 400 invalid admin body, got ${invalidAdmin.statusCode}`);
    assert(invalidAdmin.body?.error?.code === "INVALID_ADMIN_STATE", "expected INVALID_ADMIN_STATE error code");

    console.log("Payload validation contract test passed");
  } finally {
    await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

