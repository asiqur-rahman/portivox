const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate free port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function connectAndRegister(wsUrl, requestedSubdomain) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for register response"));
    }, 6000);

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "register_tunnel", requestedSubdomain }));
    });

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "registered" && msg.subdomain) {
          clearTimeout(timeout);
          resolve({ socket, subdomain: msg.subdomain });
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          socket.close();
          reject(new Error(`Gateway error: ${msg.message}`));
        }
      } catch {
        // ignore malformed frames in test harness
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("Skipping redis registry test: set REDIS_URL to run it.");
    return;
  }

  let gatewayA;
  let gatewayB;
  let clientA;
  let clientB;
  let clientB2;

  const keyPrefix = `portivox:test:${randomUUID()}`;

  try {
    const gatewayPortA = await getFreePort();
    const wsPortA = await getFreePort();
    const gatewayPortB = await getFreePort();
    const wsPortB = await getFreePort();

    gatewayA = createGatewayServer({
      gatewayPort: gatewayPortA,
      wsPort: wsPortA,
      rootDomain: "localtest.me",
      tunnelResponseTimeoutMs: 10000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: false,
      registryBackend: "redis",
      redisUrl,
      redisKeyPrefix: keyPrefix,
      registryLeaseTtlMs: 15000,
      nodeId: "gateway-a",
    });

    gatewayB = createGatewayServer({
      gatewayPort: gatewayPortB,
      wsPort: wsPortB,
      rootDomain: "localtest.me",
      tunnelResponseTimeoutMs: 10000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
      authRequired: false,
      registryBackend: "redis",
      redisUrl,
      redisKeyPrefix: keyPrefix,
      registryLeaseTtlMs: 15000,
      nodeId: "gateway-b",
    });

    await gatewayA.start();
    await gatewayB.start();

    clientA = await connectAndRegister(`ws://127.0.0.1:${wsPortA}/connect`, "sharedsub");
    clientB = await connectAndRegister(`ws://127.0.0.1:${wsPortB}/connect`, "sharedsub");

    if (clientA.subdomain !== "sharedsub") {
      throw new Error(`Expected first claimant to keep requested subdomain, got ${clientA.subdomain}`);
    }

    if (clientB.subdomain === "sharedsub") {
      throw new Error("Expected second claimant to be assigned a fallback subdomain");
    }

    clientA.socket.close();
    await sleep(400);

    clientB2 = await connectAndRegister(`ws://127.0.0.1:${wsPortB}/connect`, "sharedsub");
    if (clientB2.subdomain !== "sharedsub") {
      throw new Error(`Expected reassignment after release, got ${clientB2.subdomain}`);
    }

    console.log("Redis registry coordination test passed");
  } finally {
    try { if (clientA) clientA.socket.close(); } catch {}
    try { if (clientB) clientB.socket.close(); } catch {}
    try { if (clientB2) clientB2.socket.close(); } catch {}
    if (gatewayA) await gatewayA.stop();
    if (gatewayB) await gatewayB.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
