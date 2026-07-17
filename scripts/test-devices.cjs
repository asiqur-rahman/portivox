// Device roster:
//   - A client that connects with a deviceId appears in GET /api/devices, online.
//   - The same deviceId reconnecting is the SAME device (not duplicated).
//   - On disconnect the device is marked offline (still listed).
//   - Forgetting an online device disconnects it and removes it from the list.
process.env.DATABASE_URL = "";

const http = require("node:http");

const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");
const { TunnelClient } = require("../apps/tunnel-client/dist/client.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") { reject(new Error("no free port")); return; }
      const port = address.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

function startLocalApp(port) {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function requestJson({ port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...(payload ? { "content-length": String(payload.length) } : {}), ...(headers || {}) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openDevice({ wsPort, localAppPort, token, deviceId }) {
  const state = { revoked: false };
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("registration timed out")), 10000);
    const client = new TunnelClient({
      gatewayUrl: `ws://127.0.0.1:${wsPort}/connect`,
      localBase: `http://127.0.0.1:${localAppPort}`,
      tunnelType: "http",
      localTcpHost: "127.0.0.1",
      localTcpPort: localAppPort,
      localTimeoutMs: 15000,
      maxResponseBodyBytes: 2097152,
      withDedicatedPort: true,
      ipProtection: false,
      deviceId,
      deviceName: "test-machine",
      platform: "linux",
      clientVersion: "9.9.9",
      wsHeaders: { authorization: `Bearer ${token}` },
      onRegistered: () => { clearTimeout(timeout); resolve({ client, state }); },
      onRevoked: () => { state.revoked = true; },
      onFatalError: () => { state.revoked = true; },
    });
    client.start();
  });
  return promise;
}

function listDevices(port, token) {
  return requestJson({ port, path: "/api/devices", method: "GET", headers: { authorization: `Bearer ${token}` } });
}

async function main() {
  let localServer;
  let gateway;
  let client;

  try {
    const localAppPort = await getFreePort();
    const gatewayPort = await getFreePort();
    const wsPort = await getFreePort();
    const tcpPublicPortStart = await getFreePort();
    const jwtSecret = "devices-test-secret-0123456789-abcdef";
    const deviceId = "test-device-0001";

    localServer = await startLocalApp(localAppPort);
    gateway = createGatewayServer({
      gatewayPort, wsPort, rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 15000, wsIdleTimeoutMs: 30000, maxRequestBodyBytes: 1048576,
      authRequired: true, authJwtSecret: jwtSecret,
      tcpTunnelEnabled: true, tcpTunnelBindHost: "127.0.0.1", tcpPublicHost: "127.0.0.1",
      tcpPublicPortStart, tcpPublicPortEnd: tcpPublicPortStart + 8,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "dev@example.com", password: "Test-Password-123" } });
    if (!reg.body?.accessToken) throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    const token = reg.body.accessToken;

    // 0) Registering a device (no tunnel yet) records it, offline.
    {
      const preId = "pre-reg-device-0001";
      const regDev = await requestJson({ port: gatewayPort, path: "/api/devices/register", method: "POST", headers: { authorization: `Bearer ${token}` }, body: { deviceId: preId, name: "pre-machine", platform: "linux", clientVersion: "1.0.0" } });
      if (regDev.statusCode !== 200 || !regDev.body?.device) throw new Error(`device register failed: ${regDev.statusCode} ${JSON.stringify(regDev.body)}`);
      const pre = await listDevices(gatewayPort, token);
      const preDev = pre.body.devices?.find((d) => d.deviceId === preId);
      if (!preDev) throw new Error("registered device not listed before opening a tunnel");
      if (preDev.online !== false) throw new Error("registered-but-not-connected device should be offline");
    }

    // 1) Connect → device appears online.
    {
      const opened = await openDevice({ wsPort, localAppPort, token, deviceId });
      client = opened.client;
      await sleep(250);
      const list = await listDevices(gatewayPort, token);
      const dev = list.body.devices?.find((d) => d.deviceId === deviceId);
      if (!dev) throw new Error(`device not listed: ${JSON.stringify(list.body)}`);
      if (!dev.online) throw new Error("device should be online while connected");
      if (dev.name !== "test-machine" || dev.platform !== "linux" || dev.clientVersion !== "9.9.9") {
        throw new Error(`device metadata wrong: ${JSON.stringify(dev)}`);
      }
      client.stop();
      client = undefined;
      await sleep(400);
    }

    // 2) After disconnect → still listed, but offline.
    {
      const list = await listDevices(gatewayPort, token);
      const dev = list.body.devices?.find((d) => d.deviceId === deviceId);
      if (!dev) throw new Error("device should remain listed after disconnect");
      if (dev.online) throw new Error("device should be offline after disconnect");
    }

    // 3) Reconnect with the same deviceId → same device, not duplicated.
    {
      const opened = await openDevice({ wsPort, localAppPort, token, deviceId });
      client = opened.client;
      await sleep(250);
      const list = await listDevices(gatewayPort, token);
      const matches = list.body.devices.filter((d) => d.deviceId === deviceId);
      if (matches.length !== 1) throw new Error(`expected exactly one device record, got ${matches.length}`);
      if (!matches[0].online) throw new Error("reconnected device should be online");

      // 4) Forget the online device → it is disconnected and removed.
      const del = await requestJson({ port: gatewayPort, path: `/api/devices/${matches[0].id}`, method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (del.statusCode !== 204) throw new Error(`forget device failed: ${del.statusCode} ${JSON.stringify(del.body)}`);

      for (let i = 0; i < 50 && !opened.state.revoked; i += 1) await sleep(100);
      if (!opened.state.revoked) throw new Error("forgetting an online device did not disconnect its client");

      const after = await listDevices(gatewayPort, token);
      if (after.body.devices.some((d) => d.deviceId === deviceId)) throw new Error("device still listed after forget");
      client.stop();
      client = undefined;
    }

    // 5) A key's registered-device count is surfaced in GET /api/keys.
    {
      const keyRes = await requestJson({ port: gatewayPort, path: "/api/keys", method: "POST", headers: { authorization: `Bearer ${token}` }, body: { name: "count-key" } });
      if (keyRes.statusCode !== 201 || !keyRes.body?.apiKey?.token) throw new Error(`key create failed: ${keyRes.statusCode}`);
      const apiKey = keyRes.body.apiKey.token;
      const keyId = keyRes.body.apiKey.id;
      // Fresh key: no device yet.
      let keys = await requestJson({ port: gatewayPort, path: "/api/keys", method: "GET", headers: { authorization: `Bearer ${token}` } });
      let k = keys.body.keys.find((x) => x.id === keyId);
      if (!k || k.deviceCount !== 0) throw new Error(`new key should have deviceCount 0, got ${JSON.stringify(k)}`);
      // Register a device WITH that key → count becomes 1.
      await requestJson({ port: gatewayPort, path: "/api/devices/register", method: "POST", headers: { "x-api-key": apiKey }, body: { deviceId: "count-device-1", name: "cd", platform: "linux" } });
      keys = await requestJson({ port: gatewayPort, path: "/api/keys", method: "GET", headers: { authorization: `Bearer ${token}` } });
      k = keys.body.keys.find((x) => x.id === keyId);
      if (!k || k.deviceCount !== 1) throw new Error(`key should have deviceCount 1 after device registers, got ${JSON.stringify(k)}`);
    }

    console.log("Devices test passed");
  } finally {
    if (client) client.stop();
    if (gateway) await gateway.stop();
    if (localServer) await new Promise((resolve) => localServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
