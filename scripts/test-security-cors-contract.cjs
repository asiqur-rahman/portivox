process.env.DATABASE_URL = "";

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

function request({ port, method = "GET", path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
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
  const allowedOrigin = "https://console.portivox.local";
  const gateway = createGatewayServer({
    gatewayPort: gatewayHttpPort,
    wsPort: gatewayWsPort,
    rootDomain: "portivox.braintechsolution.com",
    tunnelResponseTimeoutMs: 5000,
    wsIdleTimeoutMs: 10000,
    maxRequestBodyBytes: 1048576,
    authRequired: false,
    corsAllowedOrigins: allowedOrigin,
    corsAllowCredentials: true,
    securityHeadersEnabled: true,
  });

  try {
    await gateway.start();

    const apiRes = await request({
      port: gatewayHttpPort,
      path: "/api/tunnels",
      headers: { origin: allowedOrigin },
    });
    assert(apiRes.statusCode === 200, `expected 200 on /api/tunnels got ${apiRes.statusCode}`);
    assert(apiRes.headers["x-content-type-options"] === "nosniff", "missing x-content-type-options");
    assert(apiRes.headers["x-frame-options"] === "DENY", "missing x-frame-options");
    assert(apiRes.headers["content-security-policy"], "missing content-security-policy");
    assert(apiRes.headers["access-control-allow-origin"] === allowedOrigin, "missing allowed origin header");
    assert(apiRes.headers["access-control-allow-credentials"] === "true", "missing credentials header");

    const preflight = await request({
      port: gatewayHttpPort,
      method: "OPTIONS",
      path: "/api/tunnels",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "GET",
      },
    });
    assert(preflight.statusCode === 204, `expected 204 preflight, got ${preflight.statusCode}`);
    assert(preflight.headers["access-control-allow-methods"], "missing allow-methods header");
    assert(preflight.headers["access-control-allow-headers"], "missing allow-headers header");

    console.log("Security/CORS contract test passed");
  } finally {
    await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});


