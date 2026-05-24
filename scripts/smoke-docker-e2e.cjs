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

// Extract the LAST "Tunnel active: <subdomain>" from client logs.
// Using the last match (not the first) means we follow reconnects:
// if the client disconnects and gets a new subdomain we pick it up
// on the next poll cycle instead of being stuck on the stale one.
function latestSubdomainFromLogs(logs) {
  const re = /\[client\]\s+INFO\s+Tunnel active:\s+(\S+)/g;
  let lastMatch = null;
  let m;
  while ((m = re.exec(logs)) !== null) {
    lastMatch = m[1];
  }
  return lastMatch;
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

// Combined wait: reads the latest registered subdomain from the client
// container logs and immediately probes the gateway with it. This loop
// handles client reconnects gracefully — on each tick we use whatever
// subdomain the client most recently logged, so a stale first-registration
// subdomain can never permanently block the test.
async function waitForTunnelReady(timeoutMs = 75_000) {
  const started = Date.now();
  let lastSubdomain = null;
  let lastStatus = 0;
  let lastBody = "";

  while (Date.now() - started < timeoutMs) {
    const logs = await containerLogs(CLIENT_CONTAINER);
    const subdomain = latestSubdomainFromLogs(logs);

    if (subdomain) {
      lastSubdomain = subdomain;
      try {
        const result = await requestGateway(subdomain);
        lastStatus = result.statusCode;
        lastBody = result.body;
        if (result.statusCode === 200 && result.body.includes("hello-from-docker-local-app")) {
          console.log(`Tunnel verified: ${subdomain}.${ROOT_DOMAIN}`);
          return;
        }
      } catch {
        // network error — retry
      }
    }

    await new Promise((r) => setTimeout(r, 1200));
  }

  const snippet = (lastBody || "").slice(0, 400);
  throw new Error(
    `Timed out waiting for docker tunnel ingress response` +
    ` (lastSubdomain=${lastSubdomain ?? "none"}, lastStatus=${lastStatus},` +
    ` lastBody=${JSON.stringify(snippet)})`,
  );
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

// Print the smoke client container's own logs (not the compose service logs).
async function printClientContainerLogs() {
  const logs = await containerLogs(CLIENT_CONTAINER);
  if (logs.trim()) {
    console.error(`=== ${CLIENT_CONTAINER} logs ===\n${logs}\n=== end ===`);
  } else {
    console.error(`=== ${CLIENT_CONTAINER} logs: (empty) ===`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    // Remove any stale smoke-client container from a previous interrupted run
    // before compose down so the named container doesn't linger.
    try { await run("docker", ["rm", "-f", CLIENT_CONTAINER]); } catch { /* ignore */ }
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
        // If the container name is already taken (stale from a failed attempt),
        // remove it and retry.
        try { await run("docker", ["rm", "-f", CLIENT_CONTAINER]); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (!launched) {
      await printClientContainerLogs();
      await printLogsFor("gateway");
      throw lastError instanceof Error ? lastError : new Error("Failed to launch client smoke container");
    }

    // Wait for the tunnel to become active AND successfully proxy a request.
    // Re-reads the latest assigned subdomain on every tick so reconnects are
    // handled transparently.
    try {
      await waitForTunnelReady();
    } catch (error) {
      await printClientContainerLogs();
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
