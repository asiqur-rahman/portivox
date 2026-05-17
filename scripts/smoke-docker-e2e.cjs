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
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await requestGateway();
      if (result.statusCode === 200 && result.body.includes("hello-from-docker-local-app")) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error("Timed out waiting for docker tunnel ingress response");
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
      await run("docker", ["compose", "up", "-d", "--build", "redis", "gateway", "sample-local-app"]);
    } catch (error) {
      await printLogsFor("gateway");
      throw error;
    }
    try {
      await run("docker", [
        "compose",
        "run",
        "-d",
        "--name",
        "portivox-client-smoke",
        "client",
        "open",
        "3000",
        "--host",
        "sample-local-app",
        "--subdomain",
        "demo",
      ]);
    } catch (error) {
      await printLogsFor("client");
      await printLogsFor("gateway");
      throw error;
    }

    await waitForTunnel();
    console.log("Docker smoke tunnel test passed");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
