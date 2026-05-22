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

function requestJson({ port, path }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path },
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
    rootDomain: "portivox.braintechsolution.com",
    tunnelResponseTimeoutMs: 5000,
    wsIdleTimeoutMs: 10000,
    maxRequestBodyBytes: 1048576,
    authRequired: false,
    apiRateLimitReadPerMin: 2,
  });

  try {
    await gateway.start();

    const first = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels" });
    assert(first.statusCode === 200, `expected first request 200, got ${first.statusCode}`);
    assert(String(first.headers["ratelimit-limit"]) === "2", "expected ratelimit-limit=2");
    assert(String(first.headers["ratelimit-remaining"]) === "1", "expected ratelimit-remaining=1 after first call");

    const second = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels" });
    assert(second.statusCode === 200, `expected second request 200, got ${second.statusCode}`);
    assert(String(second.headers["ratelimit-remaining"]) === "0", "expected ratelimit-remaining=0 after second call");

    const third = await requestJson({ port: gatewayHttpPort, path: "/api/tunnels" });
    assert(third.statusCode === 429, `expected third request 429, got ${third.statusCode}`);
    assert(typeof third.headers["retry-after"] !== "undefined", "expected retry-after header on 429");
    assert(String(third.headers["ratelimit-limit"]) === "2", "expected ratelimit-limit on 429");
    assert(String(third.headers["ratelimit-remaining"]) === "0", "expected ratelimit-remaining=0 on 429");
    assert(third.body && third.body.error && third.body.error.code === "RATE_LIMITED", "expected RATE_LIMITED error code");

    console.log("Rate limit contract test passed");
  } finally {
    await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

