const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function parseArgs(argv) {
  const args = {
    input: process.env.AUDIT_EXPORT_DEAD_LETTER_JSONL_PATH || "",
    webhookUrl: process.env.AUDIT_EXPORT_WEBHOOK_URL || "",
    webhookSecret: process.env.AUDIT_EXPORT_WEBHOOK_SECRET || "",
    timeoutMs: Number(process.env.AUDIT_EXPORT_WEBHOOK_TIMEOUT_MS || 3000),
    maxRetries: Number(process.env.AUDIT_EXPORT_WEBHOOK_MAX_RETRIES || 3),
    retryBaseMs: Number(process.env.AUDIT_EXPORT_WEBHOOK_RETRY_BASE_MS || 250),
    dryRun: false,
    compactOnSuccess: false,
    reportPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input" && argv[index + 1]) args.input = argv[++index];
    else if (token === "--webhook" && argv[index + 1]) args.webhookUrl = argv[++index];
    else if (token === "--secret" && argv[index + 1]) args.webhookSecret = argv[++index];
    else if (token === "--timeout-ms" && argv[index + 1]) args.timeoutMs = Number(argv[++index]);
    else if (token === "--max-retries" && argv[index + 1]) args.maxRetries = Number(argv[++index]);
    else if (token === "--retry-base-ms" && argv[index + 1]) args.retryBaseMs = Number(argv[++index]);
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--compact-on-success") args.compactOnSuccess = true;
    else if (token === "--report-path" && argv[index + 1]) args.reportPath = argv[++index];
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signPayload(secret, payload) {
  if (!secret) return null;
  const signature = crypto.createHash("sha256").update(`${secret}.${payload}`).digest("hex");
  return `sha256=${signature}`;
}

function createIdempotencyKey(event, index) {
  return crypto
    .createHash("sha256")
    .update(`${event.at || ""}|${event.action || ""}|${event.resource || ""}|${event.resourceId || ""}|${index}`)
    .digest("hex");
}

async function deliverWithRetry({ webhookUrl, webhookSecret, timeoutMs, maxRetries, retryBaseMs, event, idempotencyKey }) {
  const payload = JSON.stringify(event);
  const headers = { "content-type": "application/json" };
  const signature = signPayload(webhookSecret, payload);
  if (signature) headers["x-portivox-signature"] = signature;
  headers["x-portivox-idempotency-key"] = idempotencyKey;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return true;
    } catch {}

    if (attempt < maxRetries) {
      await sleep(retryBaseMs * (2 ** attempt));
    }
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("Missing dead-letter input path. Use --input or AUDIT_EXPORT_DEAD_LETTER_JSONL_PATH.");
  if (!args.webhookUrl && !args.dryRun) throw new Error("Missing webhook URL. Use --webhook or AUDIT_EXPORT_WEBHOOK_URL.");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("Invalid timeout");
  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 0) throw new Error("Invalid max-retries");
  if (!Number.isFinite(args.retryBaseMs) || args.retryBaseMs <= 0) throw new Error("Invalid retry-base-ms");

  const resolvedInput = path.resolve(args.input);
  const raw = await fs.readFile(resolvedInput, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const records = lines.map((line, index) => {
    try {
      return { parsed: JSON.parse(line), raw: line, index };
    } catch {
      return { parsed: null, raw: line, index };
    }
  });

  let delivered = 0;
  let failed = 0;
  let invalid = 0;
  const remaining = [];
  const failedItems = [];
  const deliveredItems = [];

  for (const record of records) {
    if (!record.parsed || !record.parsed.event) {
      invalid += 1;
      remaining.push(record.raw);
      continue;
    }

    if (args.dryRun) {
      delivered += 1;
      deliveredItems.push({ index: record.index, mode: "dry-run" });
      continue;
    }

    const idempotencyKey = createIdempotencyKey(record.parsed.event, record.index);
    const ok = await deliverWithRetry({
      webhookUrl: args.webhookUrl,
      webhookSecret: args.webhookSecret,
      timeoutMs: args.timeoutMs,
      maxRetries: args.maxRetries,
      retryBaseMs: args.retryBaseMs,
      event: record.parsed.event,
      idempotencyKey,
    });

    if (ok) {
      delivered += 1;
      deliveredItems.push({ index: record.index, idempotencyKey });
    } else {
      failed += 1;
      remaining.push(record.raw);
      failedItems.push({ index: record.index, idempotencyKey, reason: "WEBHOOK_DELIVERY_FAILED" });
    }
  }

  if (!args.dryRun && args.compactOnSuccess) {
    await fs.writeFile(resolvedInput, remaining.length > 0 ? `${remaining.join("\n")}\n` : "", "utf8");
  }

  const report = {
    at: new Date().toISOString(),
    input: resolvedInput,
    dryRun: args.dryRun,
    compactOnSuccess: args.compactOnSuccess,
    total: records.length,
    delivered,
    failed,
    invalid,
    remaining: remaining.length,
    deliveredItems,
    failedItems,
  };

  if (args.reportPath) {
    const resolvedReportPath = path.resolve(args.reportPath);
    await fs.mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await fs.writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

