const { TunnelixClient } = require("../packages/sdk/index.js");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const http = require("node:http");
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

async function main() {
  const gatewayHttpPort = await getFreePort();
  const gatewayWsPort = await getFreePort();
  const gateway = createGatewayServer({
    gatewayPort: gatewayHttpPort,
    wsPort: gatewayWsPort,
    rootDomain: "localtest.me",
    tunnelResponseTimeoutMs: 8000,
    wsIdleTimeoutMs: 30000,
    maxRequestBodyBytes: 1048576,
    authRequired: false,
  });

  try {
    await gateway.start();
    const client = new TunnelixClient({ baseUrl: `http://127.0.0.1:${gatewayHttpPort}` });

    const health = await client.health();
    if (!health || health.status !== "ok") {
      throw new Error("SDK health() failed");
    }

    const ready = await client.ready();
    if (!ready || ready.ready !== true) {
      throw new Error("SDK ready() failed");
    }

    const openApi = await client.openApi();
    if (!openApi || openApi.openapi !== "3.0.3") {
      throw new Error("SDK openApi() failed");
    }

    const metrics = await client.metrics();
    if (typeof metrics !== "string" || !metrics.includes("gateway_requests_total")) {
      throw new Error("SDK metrics() failed");
    }

    console.log("SDK integration test passed");
  } finally {
    await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
