const net = require("node:net");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
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

function startLocalTcpEchoServer(port) {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(Buffer.from(chunk.toString("utf8").toUpperCase(), "utf8"));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function requestTcpEcho(host, port, text, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP echo timeout"));
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(text);
    });

    socket.on("data", (chunk) => {
      clearTimeout(timer);
      socket.end();
      resolve(chunk.toString("utf8"));
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  let localTcpServer;
  let gateway;
  let client;

  try {
    const localTcpPort = await getFreePort();
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
      tcpTunnelEnabled: true,
      tcpTunnelBindHost: "127.0.0.1",
      tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart,
      tcpPublicPortEnd: tcpPublicPortStart + 3,
    };

    localTcpServer = await startLocalTcpEchoServer(localTcpPort);

    gateway = createGatewayServer(gatewayConfig);
    await gateway.start();

    client = new TunnelClient({
      gatewayUrl: `ws://127.0.0.1:${gatewayWsPort}/connect`,
      localBase: `http://127.0.0.1:${localTcpPort}`,
      tunnelType: "tcp",
      localTcpHost: "127.0.0.1",
      localTcpPort,
      requestedSubdomain: "demotcp",
      localTimeoutMs: 15000,
      maxResponseBodyBytes: 2097152,
    });
    client.start();

    await sleep(1500);
    const publicTcpPort = tcpPublicPortStart;

    const input = "hello-portivox";
    const response = await requestTcpEcho("127.0.0.1", publicTcpPort, input);
    if (response !== input.toUpperCase()) {
      throw new Error(`TCP smoke failed: expected ${input.toUpperCase()} got ${response}`);
    }

    console.log("TCP smoke tunnel test passed");
  } finally {
    if (client) {
      client.stop();
    }
    if (gateway) {
      await gateway.stop();
    }
    if (localTcpServer) {
      await new Promise((resolve) => localTcpServer.close(resolve));
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

