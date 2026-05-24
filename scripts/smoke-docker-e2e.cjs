const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");

// ── CI environment defaults ───────────────────────────────────────────────────
// AUTH_REQUIRED=true (compose default) requires AUTH_JWT_SECRET — not set in CI.
// Disable auth; correctness is covered by test:auth.
if (!process.env.AUTH_REQUIRED) {
  process.env.AUTH_REQUIRED = "false";
}
if (!process.env.AUTH_JWT_SECRET) {
  process.env.AUTH_JWT_SECRET = crypto.randomBytes(32).toString("hex");
}
// Disable IP-link protection so the CI runner can reach the tunnel without
// first hitting the access-link whitelist endpoint.
if (!process.env.IP_PROTECTION_DEFAULT) {
  process.env.IP_PROTECTION_DEFAULT = "false";
}

const ROOT_DOMAIN = process.env.ROOT_DOMAIN || "portivox.braintechsolution.com";
const CLIENT_CONTAINER = "portivox-client-smoke";

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
      }
    });
  });
}

// Read stdout+stderr of a container into a string (non-fatal on error).
function containerLogs(name) {
  return new Promise((resolve) => {
    const child = spawn("docker", ["logs", name], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c) => { out += c.toString("utf8"); });
    child.on("error", () => resolve(""));
    child.on("exit", () => resolve(out));
  });
}

// Poll the client container logs until "Tunnel active: <subdomain>" appears.
// The gateway may assign a different subdomain than requested (e.g. if the
// requested one is reserved), so we always use the one the gateway confirms.
async function waitForClientSubdomain(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const logs = await containerLogs(CLIENT_CONTAINER);
    const match = logs.match(/\[client\]\s+INFO\s+Tunnel active:\s+(\S+)/);
    if (match) {
      return match[1];
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`Client container never registered — no "Tunnel active" in logs after ${timeoutMs}ms`);
}

function requestGateway(subdomain) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 80,
        path: "/",
        method: "GET",
        headers: { Host: `${subdomain}.${ROOT_DOMAIN}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

async function waitForTunnel(subdomain, timeoutMs = 45_000) {
  const started = Date.now();
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await requestGateway(subdomain);
      lastStatus = result.statusCode;
      lastBody = result.body;
      if (result.statusCode === 200 && result.body.includes("hello-from-docker-local-app")) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  const snippet = (lastBody || "").slice(0, 300);
  throw new Error(`Timed out waiting for docker tunnel ingress response (lastStatus=${lastStatus}, lastBody=${JSON.stringify(snippet)})`);
}

async function waitForGatewayHealthy(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await new Promise((resolve, reject) => {
        const child = spawn("docker", ["inspect", "-f", "{{.State.Health.Status}}", "portivox-gateway"], {
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve(out.trim());
          else reject(new Error("docker inspect failed"));
        });
      });
      if (status === "healthy") return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for gateway to become healthy");
}

async function cleanup() {
  try { await run("docker", ["rm", "-f", CLIENT_CONTAINER]); } catch { /* ignore */ }
  try { await run("docker", ["compose", "down", "--remove-orphans"]); } catch { /* ignore */ }
}

async function printLogsFor(service) {
  try { await run("docker", ["compose", "logs", "--no-color", service]); } catch { /* ignore */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await run("docker", ["compose", "down", "--remove-orphans"]);

    try {
      await run("docker", ["compose", "up", "-d", "--build", "redis", "gateway", "sample-local-app", "nginx"]);
    } catch (error) {
      await printLogsFor("gateway");
      await printLogsFor("nginx");
      throw error;
    }
    await waitForGatewayHealthy();

    // Launch the tunnel client.
    // • No --subdomain flag — let the gateway assign freely so reserved words
    //   like "demo" don't cause a silent reassignment we can't predict.
    // • --no-ip-protection — the CI runner's IP is not whitelisted; without
    //   this flag every request gets blocked by the link-protection gate.
    let launched = false;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await run("docker", [
          "compose", "run", "-d",
          "-e", `TUNNEL_API_KEY=ci_smoke_key`,
          "--name", CLIENT_CONTAINER,
          "client",
          "node", "apps/tunnel-client/dist/index.js",
          "open", "3000",
          "--gateway", "ws://gateway:7000/connect",
          "--host", "sample-local-app",
          "--no-ip-protection",
        ]);
        launched = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (!launched) {
      await printLogsFor("client");
      await printLogsFor("gateway");
      throw lastError instanceof Error ? lastError : new Error("Failed to launch client smoke container");
    }

    // Wait until the client logs "Tunnel active: <subdomain>" and grab
    // the actual assigned subdomain (may differ from any requested value).
    let registeredSubdomain;
    try {
      registeredSubdomain = await waitForClientSubdomain();
    } catch (error) {
      const logs = await containerLogs(CLIENT_CONTAINER);
      console.error("Client logs:\n", logs);
      await printLogsFor("gateway");
      throw error;
    }

    console.log(`Client registered subdomain: ${registeredSubdomain}`);

    try {
      await waitForTunnel(registeredSubdomain);
    } catch (error) {
      await printLogsFor("client");
      await printLogsFor("gateway");
      await printLogsFor("nginx");
      throw error;
    }

    console.log("Docker smoke tunnel test passed");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
