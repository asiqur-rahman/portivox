const http = require("node:http");
const WebSocket = require("ws");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function startLocalApp(port, payload) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(payload);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function requestTunnel({ gatewayHttpPort, hostHeader = "demo.localtest.me", path = "/" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gatewayHttpPort,
        path,
        method: "GET",
        headers: { Host: hostHeader },
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

async function runChunkReassemblyHappyPath() {
  let localServer;
  let gateway;
  let client;
  try {
    const localAppPort = await getFreePort();
    const gatewayHttpPort = await getFreePort();
    const gatewayWsPort = await getFreePort();
    const expectedBody = "chunk-ok-".repeat(4000);

    localServer = await startLocalApp(localAppPort, expectedBody);
    gateway = createGatewayServer({
      gatewayPort: gatewayHttpPort,
      wsPort: gatewayWsPort,
      rootDomain: "localtest.me",
      tunnelResponseTimeoutMs: 8000,
      streamIdleTimeoutMs: 5000,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
    });
    await gateway.start();

    client = new TunnelClient({
      gatewayUrl: `ws://127.0.0.1:${gatewayWsPort}/connect`,
      localBase: `http://127.0.0.1:${localAppPort}`,
      requestedSubdomain: "demo",
      localTimeoutMs: 15000,
      maxResponseBodyBytes: 2097152,
      responseChunkBytes: 1024,
    });
    client.start();
    await sleep(2000);

    const result = await requestTunnel({ gatewayHttpPort });
    if (result.statusCode !== 200 || result.body !== expectedBody) {
      throw new Error(`Chunk happy-path failed: status=${result.statusCode} bodyLen=${result.body.length}`);
    }
  } finally {
    if (client) client.stop();
    if (gateway) await gateway.stop();
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  }
}

async function runChunkIncompleteTimeoutPath() {
  let gateway;
  let socket;
  try {
    const gatewayHttpPort = await getFreePort();
    const gatewayWsPort = await getFreePort();

    gateway = createGatewayServer({
      gatewayPort: gatewayHttpPort,
      wsPort: gatewayWsPort,
      rootDomain: "localtest.me",
      tunnelResponseTimeoutMs: 3000,
      streamIdleTimeoutMs: 1200,
      wsIdleTimeoutMs: 30000,
      maxRequestBodyBytes: 1048576,
    });
    await gateway.start();

    socket = new WebSocket(`ws://127.0.0.1:${gatewayWsPort}/connect`);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out registering raw tunnel client")), 4000);
      socket.on("open", () => {
        socket.send(JSON.stringify({ v: 2, type: "register_tunnel", requestedSubdomain: "demo" }));
      });
      socket.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "registered") {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (msg.type === "http_request") {
          socket.send(JSON.stringify({
            v: 2,
            type: "http_response",
            streamId: msg.streamId,
            statusCode: 200,
            headers: { "content-type": "text/plain" },
            bodyBase64: Buffer.from("partial-").toString("base64"),
            meta: { chunk: { index: 0, total: 2, final: false } },
          }));
        }
      });
    });

    const result = await requestTunnel({ gatewayHttpPort });
    if (result.statusCode !== 504 || !result.body.includes("TUNNEL_STREAM_IDLE_TIMEOUT")) {
      throw new Error(`Chunk timeout-path failed: status=${result.statusCode} body=${result.body}`);
    }
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "done");
    }
    if (gateway) await gateway.stop();
  }
}

async function main() {
  await runChunkReassemblyHappyPath();
  await runChunkIncompleteTimeoutPath();
  console.log("Chunk integration tests passed");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
