// Unused API key sweep: a key with no registered device, older than the TTL, is
// auto-revoked; a key that a device uses is kept. Uses short env overrides so
// the test doesn't wait 24h.
process.env.DATABASE_URL = "";
process.env.UNUSED_API_KEY_TTL_MS = "400";
process.env.UNUSED_API_KEY_SWEEP_INTERVAL_MS = "300";

const http = require("node:http");
const { createGatewayServer } = require("../apps/gateway-server/dist/server.js");

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

async function main() {
  let gateway;
  try {
    const gatewayPort = await getFreePort();
    const wsPort = await getFreePort();
    const jwtSecret = "unused-key-sweep-test-secret-0123456789";

    gateway = createGatewayServer({
      gatewayPort, wsPort, rootDomain: "portivox.braintechsolution.com",
      tunnelResponseTimeoutMs: 15000, wsIdleTimeoutMs: 30000, maxRequestBodyBytes: 1048576,
      authRequired: true, authJwtSecret: jwtSecret,
    });
    await gateway.start();

    const reg = await requestJson({ port: gatewayPort, path: "/api/auth/register", method: "POST", body: { email: "sweep@example.com", password: "Test-Password-123" } });
    if (!reg.body?.accessToken) throw new Error(`register failed: ${reg.statusCode} ${JSON.stringify(reg.body)}`);
    const token = reg.body.accessToken;
    const auth = { authorization: `Bearer ${token}` };

    // Key A — never used by any device.
    const keyA = await requestJson({ port: gatewayPort, path: "/api/keys", method: "POST", headers: auth, body: { name: "unused-key" } });
    const idA = keyA.body?.apiKey?.id;
    // Key B — a device registers with it, so it should survive.
    const keyB = await requestJson({ port: gatewayPort, path: "/api/keys", method: "POST", headers: auth, body: { name: "used-key" } });
    const idB = keyB.body?.apiKey?.id;
    const tokenB = keyB.body?.apiKey?.token;
    if (!idA || !idB || !tokenB) throw new Error(`key create failed: ${JSON.stringify({ keyA: keyA.body, keyB: keyB.body })}`);

    await requestJson({ port: gatewayPort, path: "/api/devices/register", method: "POST", headers: { "x-api-key": tokenB }, body: { deviceId: "sweep-device-1", name: "sd", platform: "linux" } });

    // Wait past the TTL + a couple of sweep cycles.
    await sleep(1600);

    const keys = await requestJson({ port: gatewayPort, path: "/api/keys", method: "GET", headers: auth });
    const ids = (keys.body.keys || []).map((k) => k.id);
    if (ids.includes(idA)) throw new Error("unused key was NOT auto-revoked after the TTL");
    if (!ids.includes(idB)) throw new Error("a key with a registered device was wrongly revoked");

    console.log("Unused API key sweep test passed");
  } finally {
    if (gateway) await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
