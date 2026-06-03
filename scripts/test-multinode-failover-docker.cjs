const { spawn } = require("node:child_process");
const http = require("node:http");

const COMPOSE_FILE = "docker-compose.multinode-test.yml";
const ROOT_DOMAIN = "app.localtest.me";
const REQUESTED_SUBDOMAIN = "failovertest";
const LEASE_TTL_MS = 6000;

const GATEWAY_A_HTTP_PORT = 18080;
const GATEWAY_B_HTTP_PORT = 18081;

const GATEWAY_A_CONTAINER = "portivox-failover-gateway-a";
const GATEWAY_B_CONTAINER = "portivox-failover-gateway-b";
const CLIENT_A_CONTAINER = "portivox-failover-client-a";
const CLIENT_B_CONTAINER = "portivox-failover-client-b";
const DRAIN_PROBE_CONTAINER = "portivox-failover-drain-probe";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function compose(args, options = {}) {
  return run("docker", ["compose", "-f", COMPOSE_FILE, ...args], options);
}

function composeCapture(args, options = {}) {
  return capture("docker", ["compose", "-f", COMPOSE_FILE, ...args], options);
}

async function ensureDockerAvailable() {
  try {
    const result = await capture("docker", ["version", "--format", "{{.Server.Version}}"]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "docker version failed");
    }
  } catch {
    throw new Error(
      "Docker CLI is required for test:multinode:docker. Install/start Docker Desktop and ensure `docker` is available in PATH before running this harness.",
    );
  }
}

async function containerLogs(name) {
  const result = await capture("docker", ["logs", name]);
  return `${result.stdout}${result.stderr}`;
}

function latestSubdomainFromLogs(logs) {
  const re = /\[client\]\s+INFO\s+Tunnel active:\s+(\S+)/g;
  let lastMatch = null;
  let match;
  while ((match = re.exec(logs)) !== null) {
    lastMatch = match[1];
  }
  return lastMatch;
}

function hasGatewayError(logs) {
  return logs.includes("[client] ERROR Gateway error:");
}

function requestJson(port, path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode || 0, text, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function requestTunnel(gatewayHttpPort, subdomain) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gatewayHttpPort,
        path: "/",
        method: "GET",
        headers: { Host: `${subdomain}.${ROOT_DOMAIN}` },
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

async function waitForHealthy(containerName, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await capture("docker", ["inspect", "-f", "{{.State.Health.Status}}", containerName]);
    if (result.code === 0 && result.stdout.trim() === "healthy") {
      return;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for ${containerName} to become healthy`);
}

async function waitForSubdomain(containerName, timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const logs = await containerLogs(containerName);
    const subdomain = latestSubdomainFromLogs(logs);
    if (subdomain) {
      return subdomain;
    }
    await sleep(1200);
  }
  throw new Error(`Timed out waiting for ${containerName} to register a tunnel`);
}

async function waitForContainerExitCode(containerName, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await capture("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", containerName]);
    if (result.code === 0) {
      const [status, exitCodeRaw] = result.stdout.trim().split(/\s+/);
      if (status === "exited") {
        return Number(exitCodeRaw);
      }
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${containerName} to exit`);
}

async function assertTunnelResponse(port, subdomain, expectedBody) {
  const result = await requestTunnel(port, subdomain);
  if (result.statusCode !== 200 || result.body !== expectedBody) {
    throw new Error(`Unexpected tunnel response from port ${port}: status=${result.statusCode} body=${result.body}`);
  }
}

async function launchClient(containerName, gatewayHost, requestedSubdomain, exitAfterSeconds = 15) {
  await compose([
    "run",
    "--build",
    "-d",
    "--name",
    containerName,
    "client",
    "node",
    "apps/tunnel-client/dist/index.js",
    "open",
    "3000",
    "--gateway",
    `ws://${gatewayHost}:7000/connect`,
    "--host",
    "sample-local-app",
    "--subdomain",
    requestedSubdomain,
    "--exit-after",
    String(exitAfterSeconds),
    "--no-ip-protection",
  ]);
}

async function printContainerLogs(name) {
  const logs = await containerLogs(name);
  if (logs.trim()) {
    console.error(`=== ${name} logs ===\n${logs}\n=== end ${name} logs ===`);
  }
}

async function cleanup() {
  for (const name of [CLIENT_A_CONTAINER, CLIENT_B_CONTAINER, DRAIN_PROBE_CONTAINER]) {
    try {
      await run("docker", ["rm", "-f", name]);
    } catch {}
  }
  try {
    await compose(["down", "--remove-orphans", "--volumes"]);
  } catch {}
}

async function main() {
  await ensureDockerAvailable();

  try {
    await cleanup();

    await compose(["up", "-d", "--build", "redis", "gateway-a", "gateway-b", "sample-local-app"]);
    await waitForHealthy(GATEWAY_A_CONTAINER);
    await waitForHealthy(GATEWAY_B_CONTAINER);

    await launchClient(CLIENT_A_CONTAINER, "gateway-a", REQUESTED_SUBDOMAIN, 18);
    const firstAssigned = await waitForSubdomain(CLIENT_A_CONTAINER);
    if (firstAssigned !== REQUESTED_SUBDOMAIN) {
      throw new Error(`Expected gateway-a to claim ${REQUESTED_SUBDOMAIN}, got ${firstAssigned}`);
    }

    await assertTunnelResponse(GATEWAY_A_HTTP_PORT, REQUESTED_SUBDOMAIN, "hello-from-failover-app");

    const drainResponse = await requestJson(GATEWAY_A_HTTP_PORT, "/api/admin/state", "POST", { draining: true });
    if (drainResponse.statusCode !== 200 || !drainResponse.json?.draining) {
      throw new Error(`Failed to enable draining on gateway-a: ${drainResponse.text}`);
    }

    const readyA = await requestJson(GATEWAY_A_HTTP_PORT, "/readyz");
    if (readyA.statusCode !== 503 || !readyA.json?.draining || readyA.json?.canAcceptConnections !== false || readyA.json?.activeTunnels < 1) {
      throw new Error(`Unexpected gateway-a readiness while draining: ${readyA.text}`);
    }

    await assertTunnelResponse(GATEWAY_A_HTTP_PORT, REQUESTED_SUBDOMAIN, "hello-from-failover-app");

    await launchClient(DRAIN_PROBE_CONTAINER, "gateway-a", "drainprobe", 8);
    const probeExitCode = await waitForContainerExitCode(DRAIN_PROBE_CONTAINER, 20_000);
    const probeLogs = await containerLogs(DRAIN_PROBE_CONTAINER);
    if (probeExitCode === 0) {
      throw new Error("Expected drain probe client to fail while gateway-a is draining");
    }
    if (latestSubdomainFromLogs(probeLogs)) {
      throw new Error("Drain probe unexpectedly registered a tunnel while gateway-a was draining");
    }
    if (!hasGatewayError(probeLogs) && !probeLogs.includes("Tunnel failed to connect within")) {
      throw new Error(`Drain probe did not show an expected drain failure. Logs:\n${probeLogs}`);
    }

    await run("docker", ["stop", GATEWAY_A_CONTAINER]);
    await sleep(LEASE_TTL_MS + 3000);

    await launchClient(CLIENT_B_CONTAINER, "gateway-b", REQUESTED_SUBDOMAIN, 18);
    const secondAssigned = await waitForSubdomain(CLIENT_B_CONTAINER);
    if (secondAssigned !== REQUESTED_SUBDOMAIN) {
      throw new Error(`Expected gateway-b to reclaim ${REQUESTED_SUBDOMAIN}, got ${secondAssigned}`);
    }

    await assertTunnelResponse(GATEWAY_B_HTTP_PORT, REQUESTED_SUBDOMAIN, "hello-from-failover-app");

    const readyB = await requestJson(GATEWAY_B_HTTP_PORT, "/readyz");
    if (readyB.statusCode !== 200 || readyB.json?.activeTunnels < 1 || readyB.json?.draining) {
      throw new Error(`Unexpected gateway-b readiness after failover: ${readyB.text}`);
    }

    console.log("Docker multi-node failover test passed");
  } catch (error) {
    await printContainerLogs(CLIENT_A_CONTAINER);
    await printContainerLogs(DRAIN_PROBE_CONTAINER);
    await printContainerLogs(CLIENT_B_CONTAINER);
    await printContainerLogs(GATEWAY_A_CONTAINER);
    await printContainerLogs(GATEWAY_B_CONTAINER);
    throw error;
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
