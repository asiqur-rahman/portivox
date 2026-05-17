const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "portivox-audit-replay-"));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      probe.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    probe.on("error", reject);
  });
}

function runNodeScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`script failed code=${code} stderr=${stderr.trim()} stdout=${stdout.trim()}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function testReplaySuccessAndCompaction(tmpDir) {
  const deadLetterPath = path.join(tmpDir, "dead-letter-success.jsonl");
  const reportPath = path.join(tmpDir, "report-success.json");
  const records = [
    JSON.stringify({ at: new Date().toISOString(), reason: "WEBHOOK_DELIVERY_FAILED", event: { at: "2026-01-01T00:00:00.000Z", action: "a1", resource: "r", resourceId: "1" } }),
    JSON.stringify({ at: new Date().toISOString(), reason: "WEBHOOK_DELIVERY_FAILED", event: { at: "2026-01-01T00:00:00.000Z", action: "a2", resource: "r", resourceId: "2" } }),
  ].join("\n") + "\n";
  await fs.writeFile(deadLetterPath, records, "utf8");

  const port = await getFreePort();
  const received = [];
  const server = http.createServer((req, res) => {
    const body = [];
    req.on("data", (chunk) => body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      received.push({
        signature: req.headers["x-portivox-signature"],
        idempotency: req.headers["x-portivox-idempotency-key"],
        body: Buffer.concat(body).toString("utf8"),
      });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", (err) => (err ? reject(err) : resolve())));

  try {
    const script = path.join(process.cwd(), "scripts", "replay-dead-letter-audit.cjs");
    const { stdout } = await runNodeScript(script, [
      "--input", deadLetterPath,
      "--webhook", `http://127.0.0.1:${port}/hook`,
      "--secret", "secret123",
      "--compact-on-success",
      "--report-path", reportPath,
    ]);
    const result = JSON.parse(stdout);
    assert(result.delivered === 2, "expected delivered=2");
    assert(result.failed === 0, "expected failed=0");
    assert(received.length === 2, "expected two webhook deliveries");
    assert(received.every((item) => typeof item.signature === "string" && item.signature.startsWith("sha256=")), "missing webhook signature header");
    assert(received.every((item) => typeof item.idempotency === "string" && item.idempotency.length > 10), "missing idempotency header");
    const remaining = await fs.readFile(deadLetterPath, "utf8");
    assert(remaining.trim() === "", "expected dead-letter compaction to empty file");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert(report.deliveredItems.length === 2, "expected report delivered items");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testReplayFailureRetention(tmpDir) {
  const deadLetterPath = path.join(tmpDir, "dead-letter-fail.jsonl");
  const reportPath = path.join(tmpDir, "report-fail.json");
  const record = JSON.stringify({
    at: new Date().toISOString(),
    reason: "WEBHOOK_DELIVERY_FAILED",
    event: { at: "2026-01-01T00:00:00.000Z", action: "failed", resource: "r", resourceId: "x" },
  }) + "\n";
  await fs.writeFile(deadLetterPath, record, "utf8");

  const script = path.join(process.cwd(), "scripts", "replay-dead-letter-audit.cjs");
  const { stdout } = await runNodeScript(script, [
    "--input", deadLetterPath,
    "--webhook", "http://127.0.0.1:9/unreachable",
    "--max-retries", "1",
    "--retry-base-ms", "10",
    "--compact-on-success",
    "--report-path", reportPath,
  ]);

  const result = JSON.parse(stdout);
  assert(result.delivered === 0, "expected delivered=0 for unreachable webhook");
  assert(result.failed === 1, "expected failed=1 for unreachable webhook");
  const remaining = await fs.readFile(deadLetterPath, "utf8");
  assert(remaining.trim().length > 0, "expected failed record to remain after compaction");
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert(report.failedItems.length === 1, "expected one failed item in report");
}

async function testDryRun(tmpDir) {
  const deadLetterPath = path.join(tmpDir, "dead-letter-dry.jsonl");
  await fs.writeFile(deadLetterPath, `${JSON.stringify({
    at: new Date().toISOString(),
    reason: "WEBHOOK_DELIVERY_FAILED",
    event: { at: "2026-01-01T00:00:00.000Z", action: "dry", resource: "r", resourceId: "d" },
  })}\n`, "utf8");

  const script = path.join(process.cwd(), "scripts", "replay-dead-letter-audit.cjs");
  const { stdout } = await runNodeScript(script, ["--input", deadLetterPath, "--dry-run"]);
  const result = JSON.parse(stdout);
  assert(result.dryRun === true, "expected dryRun true");
  assert(result.delivered === 1, "expected delivered count in dry run");
  const unchanged = await fs.readFile(deadLetterPath, "utf8");
  assert(unchanged.trim().length > 0, "expected dead-letter file unchanged in dry run");
}

async function main() {
  const tmpDir = await mkTmpDir();
  try {
    await testReplaySuccessAndCompaction(tmpDir);
    await testReplayFailureRetention(tmpDir);
    await testDryRun(tmpDir);
    console.log("Audit replay integration test passed");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

