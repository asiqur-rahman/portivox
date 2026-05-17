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

function requestJson({ port, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = bodyText ? JSON.parse(bodyText) : null;
          } catch {
            body = bodyText;
          }
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const gatewayHttpPort = await getFreePort();
  const gatewayWsPort = await getFreePort();
  const gateway = createGatewayServer({
    gatewayPort: gatewayHttpPort,
    wsPort: gatewayWsPort,
    rootDomain: "localtest.me",
    tunnelResponseTimeoutMs: 5000,
    wsIdleTimeoutMs: 10000,
    maxRequestBodyBytes: 1048576,
    authRequired: false,
    apiVersion: "1",
    apiDeprecationEnabled: true,
    apiSunsetDate: "Wed, 01 Jan 2027 00:00:00 GMT",
  });

  try {
    await gateway.start();

    const ok = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels" });
    assert(ok.statusCode === 200, `expected 200 for /api/tunnels, got ${ok.statusCode}`);
    assert(ok.headers["x-api-version"] === "1", "missing x-api-version header on success");
    assert(ok.headers.deprecation === "true", "missing deprecation header when enabled");
    assert(ok.headers.sunset === "Wed, 01 Jan 2027 00:00:00 GMT", "missing sunset header");

    const badVersion = await requestJson({
      port: gatewayHttpPort,
      path: "/api/tunnels",
      headers: { "x-api-version": "2" },
    });
    assert(badVersion.statusCode === 400, `expected 400 for unsupported version, got ${badVersion.statusCode}`);
    assert(badVersion.headers["x-api-version"] === "1", "missing x-api-version header on error");
    assert(badVersion.body && badVersion.body.error && badVersion.body.error.code === "UNSUPPORTED_API_VERSION", "unexpected error payload");

    console.log("API contract test passed");
  } finally {
    await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
