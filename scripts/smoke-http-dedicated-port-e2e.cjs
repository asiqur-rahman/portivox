process.env.DATABASE_URL = "";

const http = require("node:http");
const net = require("node:net");

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

// Fetch over the gateway's HTTP data-plane using a subdomain Host header.
function requestSubdomain(gatewayHttpPort, subdomain, rootDomain) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: gatewayHttpPort, path: "/", method: "GET", headers: { Host: `${subdomain}.${rootDomain}` } },
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

// Fetch directly against the dedicated raw-TCP passthrough port. Because it is a
// raw byte relay to the local HTTP server, a plain HTTP request over it must work.
function requestPort(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET" },
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

// Poll until a raw TCP connection to the port is refused (listener closed), or
// time out. Used to assert the dedicated port is released after disconnect.
async function waitForPortClosed(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const refused = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { resolve(true); });
    });
    if (refused) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  let localServer;
  let gateway;
  let client;

  try {
    const localAppPort = await getFreePort();
    const gatewayHttpPort = await getFreePort();
    const gatewayWsPort = await getFreePort();
    const tcpPublicPortStart = await getFreePort();

    const gatewayConfig = {
      gatewayPort: gatewayHttpPort,
      wsPort: gatewayWsPort,
      rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 20000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      httpPublicPortMode: true,
      tcpTunnelEnabled: true,
      tcpTunnelBindHost: "127.0.0.1",
      tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart,
      tcpPublicPortEnd: tcpPublicPortStart + 6,
    };

    localServer = await startLocalApp(localAppPort);

    gateway = createGatewayServer(gatewayConfig);
    await gateway.start();

    const registeredInfo = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Tunnel registration timed out after 10s")), 10000);
      client = new TunnelClient({
        gatewayUrl: `ws://127.0.0.1:${gatewayWsPort}/connect`,
        localBase: `http://127.0.0.1:${localAppPort}`,
        tunnelType: "http",
        localTcpHost: "127.0.0.1",
        localTcpPort: localAppPort,
        localTimeoutMs: 15000,
        maxResponseBodyBytes: 2097152,
        withDedicatedPort: true,
        onRegistered: (info) => { clearTimeout(timeout); resolve(info); },
      });
      client.start();
    });

    if (!registeredInfo.subdomain) {
      throw new Error(`Dedicated-port smoke failed: no subdomain assigned (${JSON.stringify(registeredInfo)})`);
    }
    if (!registeredInfo.dedicatedTcpPort) {
      throw new Error(`Dedicated-port smoke failed: gateway did not return a dedicated TCP port (${JSON.stringify(registeredInfo)})`);
    }

    // 1) The subdomain (HTTP data plane) reaches the local app.
    const viaSubdomain = await requestSubdomain(gatewayHttpPort, registeredInfo.subdomain, gatewayConfig.rootDomain);
    if (viaSubdomain.statusCode !== 200 || viaSubdomain.body !== "smoke-ok") {
      throw new Error(`Subdomain path failed: status=${viaSubdomain.statusCode} body=${viaSubdomain.body}`);
    }

    // 2) The dedicated raw-TCP port also reaches the same local app.
    const viaPort = await requestPort(registeredInfo.dedicatedTcpPort);
    if (viaPort.statusCode !== 200 || viaPort.body !== "smoke-ok") {
      throw new Error(`Dedicated port path failed: status=${viaPort.statusCode} body=${viaPort.body}`);
    }

    // 3) Disconnecting the client releases the dedicated port.
    const dedicatedPort = registeredInfo.dedicatedTcpPort;
    client.stop();
    client = undefined;
    const closed = await waitForPortClosed(dedicatedPort);
    if (!closed) {
      throw new Error(`Dedicated port ${dedicatedPort} was not released after client disconnect`);
    }

    console.log("HTTP dedicated-port smoke test passed");
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
