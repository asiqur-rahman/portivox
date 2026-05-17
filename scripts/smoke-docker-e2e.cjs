const { spawn } = require("node:child_process");
const http = require("node:http");

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

function requestGateway() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 80,
        path: "/",
        method: "GET",
        headers: { Host: "demo.app.localtest.me" },
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

async function waitForTunnel(timeoutMs = 45_000) {
  const started = Date.now();
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await requestGateway();
      lastStatus = result.statusCode;
      lastBody = result.body;
      if (result.statusCode === 200 && result.body.includes("hello-from-docker-local-app")) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
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
        child.stdout.on("data", (chunk) => {
          out += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve(out.trim());
          } else {
            reject(new Error("docker inspect failed"));
          }
        });
      });
      if (status === "healthy") {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Timed out waiting for gateway to become healthy");
}

async function cleanup() {
  try {
    await run("docker", ["rm", "-f", "portivox-client-smoke"]);
  } catch {
    // ignore
  }
  try {
    await run("docker", ["compose", "down", "--remove-orphans"]);
  } catch {
    // ignore
  }
}

async function printLogsFor(service) {
  try {
    await run("docker", ["compose", "logs", "--no-color", service]);
  } catch {
    // ignore
  }
}

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

    let launched = false;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await run("docker", [
        "compose",
        "run",
        "-d",
        "-e",
        "TUNNEL_API_KEY=ci_smoke_key",
        "--name",
        "portivox-client-smoke",
        "client",
        "node",
        "apps/tunnel-client/dist/index.js",
        "open",
        "3000",
        "--host",
          "sample-local-app",
          "--subdomain",
          "demo",
        ]);
        launched = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
    if (!launched) {
      await printLogsFor("client");
      await printLogsFor("gateway");
      throw lastError instanceof Error ? lastError : new Error("Failed to launch client smoke container");
    }

    try {
      await waitForTunnel();
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
