process.env.DATABASE_URL = "";

const http = require("node:http");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");


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

function startLocalApp(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("smoke-ok");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function requestTunnel(gatewayHttpPort, subdomain, rootDomain) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gatewayHttpPort,
        path: "/",
        method: "GET",
        headers: { Host: `${subdomain}.${rootDomain}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );

    req.on("error", reject);
    req.end();
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

    const gatewayConfig = {
      gatewayPort: gatewayHttpPort,
      wsPort: gatewayWsPort,
      rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 20000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
    };

    localServer = await startLocalApp(localAppPort);

    gateway = createGatewayServer(gatewayConfig);
    await gateway.start();

    // Wait for the gateway to confirm registration and return the actual subdomain.
    const registeredSubdomain = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Tunnel registration timed out after 10s")),
        10000,
      );

      client = new TunnelClient({
        gatewayUrl: `ws://127.0.0.1:${gatewayWsPort}/connect`,
        localBase: `http://127.0.0.1:${localAppPort}`,
        requestedSubdomain: "smokehttp",
        localTimeoutMs: 15000,
        maxResponseBodyBytes: 2097152,
        onRegistered: (info) => {
          clearTimeout(timeout);
          resolve(info.subdomain);
        },
      });
      client.start();
    });

    const result = await requestTunnel(gatewayHttpPort, registeredSubdomain, gatewayConfig.rootDomain);
    if (result.statusCode !== 200 || result.body !== "smoke-ok") {
      throw new Error(`Smoke failed: status=${result.statusCode} body=${result.body}`);
    }

    console.log("Smoke tunnel test passed");
  } finally {
    if (client) {
      client.stop();
    }
    if (gateway) {
      await gateway.stop();
    }
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
