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

function postJson({ port, path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "content-type": "application/json", ...headers },
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
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: parsed });
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
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
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
    idempotencyEnabled: true,
    idempotencyTtlMs: 300000,
  });

  try {
    await gateway.start();

    const key = "idem-abc-123";
    const first = await postJson({
      port: gatewayHttpPort,
      path: "/api/tunnels",
      body: { subdomain: "idem-test-1" },
      headers: { "idempotency-key": key },
    });
    assert(first.statusCode === 201, `expected first 201 got ${first.statusCode}`);
    const firstId = first.body?.tunnel?.id;
    assert(typeof firstId === "string" && firstId.length > 0, "missing tunnel id in first response");

    const second = await postJson({
      port: gatewayHttpPort,
      path: "/api/tunnels",
      body: { subdomain: "idem-test-1" },
      headers: { "idempotency-key": key },
    });
    assert(second.statusCode === 201, `expected replay 201 got ${second.statusCode}`);
    const secondId = second.body?.tunnel?.id;
    assert(secondId === firstId, "expected same tunnel id for replayed request");
    assert(second.headers["x-idempotent-replay"] === "true", "expected x-idempotent-replay=true");

    const third = await postJson({
      port: gatewayHttpPort,
      path: "/api/tunnels",
      body: { subdomain: "idem-test-2" },
      headers: { "idempotency-key": "another-key" },
    });
    assert(third.statusCode === 201, `expected third 201 got ${third.statusCode}`);
    const thirdId = third.body?.tunnel?.id;
    assert(thirdId && thirdId !== firstId, "expected different tunnel id for different idempotency key");

    console.log("Idempotency contract test passed");
  } finally {
    await gateway.stop();
    if (typeof originalDatabaseUrl === "string") {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

