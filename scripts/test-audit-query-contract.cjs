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

function requestJson({ port, method = "GET", path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
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
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
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
  });

  try {
    await gateway.start();

    await requestJson({ port: gatewayHttpPort, method: "POST", path: "/api/admin/state", body: { maintenanceMode: false } });
    await requestJson({ port: gatewayHttpPort, method: "POST", path: "/api/admin/state", body: { draining: false } });
    await requestJson({ port: gatewayHttpPort, method: "POST", path: "/api/tunnels", body: { subdomain: "auditcheck123" } });

    const list1 = await requestJson({ port: gatewayHttpPort, path: "/api/audit?limit=2" });
    assert(list1.statusCode === 200, `expected 200 from /api/audit got ${list1.statusCode}`);
    assert(Array.isArray(list1.body?.items), "expected items array");
    assert(list1.body.items.length <= 2, "expected pagination limit enforced");
    assert(typeof list1.body.nextCursor === "string" || list1.body.nextCursor === null, "expected nextCursor field");

    const cursor = list1.body.nextCursor;
    if (cursor) {
      const list2 = await requestJson({ port: gatewayHttpPort, path: `/api/audit?limit=2&cursor=${encodeURIComponent(cursor)}` });
      assert(list2.statusCode === 200, `expected 200 on cursor page got ${list2.statusCode}`);
    }

    const filtered = await requestJson({ port: gatewayHttpPort, path: "/api/audit?action=tunnel_created" });
    assert(filtered.statusCode === 200, `expected 200 filtered query got ${filtered.statusCode}`);
    assert(filtered.body.items.every((item) => item.action === "tunnel_created"), "expected action filter to match");

    console.log("Audit query contract test passed");
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

