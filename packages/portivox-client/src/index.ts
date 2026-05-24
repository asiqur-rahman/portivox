#!/usr/bin/env node
import { createInterface } from "readline";
import { TunnelClient } from "./client";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const defaultConfig = loadClientConfig();
const CONFIG_PATH = join(homedir(), ".portivox", "client.json");

// ── Types ─────────────────────────────────────────────────────────────────────

type SavedClientConfig = {
  gatewayUrl?: string;
  apiKey?: string;
};

type ClientConfig = {
  gatewayUrl: string;
  localUrl: string;
  localTimeoutMs: number;
  maxLocalResponseBodyBytes: number;
  responseChunkBytes: number;
  heartbeatIntervalMs: number;
};

function loadClientConfig(): ClientConfig {
  return {
    gatewayUrl: process.env.TUNNEL_GATEWAY_URL?.trim() || "wss://portivox.braintechsolution.com/connect",
    localUrl: process.env.TUNNEL_LOCAL_URL?.trim() || "http://localhost:3000",
    localTimeoutMs: parseIntSafe(process.env.LOCAL_REQUEST_TIMEOUT_MS, 15000),
    maxLocalResponseBodyBytes: parseIntSafe(process.env.MAX_LOCAL_RESPONSE_BODY_BYTES, 2_097_152),
    responseChunkBytes: parseNonNegIntSafe(process.env.RESPONSE_CHUNK_BYTES, 0),
    heartbeatIntervalMs: parseIntSafe(process.env.HEARTBEAT_INTERVAL_MS, 5000),
  };
}

function parseIntSafe(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegIntSafe(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// ── Config helpers ────────────────────────────────────────────────────────────

function pickArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

function readSavedConfig(): SavedClientConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as SavedClientConfig;
  } catch {
    return {};
  }
}

function writeSavedConfig(next: SavedClientConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  // mode 0o600 = owner read/write only — prevents other users on shared machines
  // from reading the API key stored in this file.
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

// ── Prompter helpers ──────────────────────────────────────────────────────────

async function ask(question: string, defaultVal = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}


async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${question} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    [
      "Portivox client commands:",
      "  config                    Interactive setup (gateway URL + API key)",
      "  config --show             Print saved configuration",
      "  config <key> <value>      Set a single config field",
      "  config --reset            Delete saved configuration",
      "  open [port] [--gateway url] [--subdomain name] [--host 127.0.0.1]",
      "       [--tcp] [--no-ip-protection]",
      "",
      "Config keys: gatewayUrl, apiKey",
      "",
      "Examples:",
      "  portivox config",
      "  portivox config --show",
      "  portivox config apiKey tk_abc123",
      "  portivox open",
      "  portivox open 3000",
      "  portivox open 22 --tcp",
    ].join("\n"),
  );
}

// ── Config wizard ─────────────────────────────────────────────────────────────

async function runConfigWizard(): Promise<void> {
  const saved = readSavedConfig();
  console.log("\n┌─────────────────────────────────────────────────┐");
  console.log("│  Portivox Setup Wizard                          │");
  console.log("│  Press Enter to keep the [current / default]    │");
  console.log("└─────────────────────────────────────────────────┘\n");

  // Step 1 — Gateway URL
  console.log("Step 1/2  Gateway URL");
  let gatewayUrl = await ask("  Gateway URL", saved.gatewayUrl ?? defaultConfig.gatewayUrl);
  try {
    gatewayUrl = validateGatewayUrl(gatewayUrl);
  } catch (err) {
    console.warn(`  ⚠  ${err instanceof Error ? err.message : String(err)} — keeping previous value.`);
    gatewayUrl = saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  }

  // Step 2 — API Key
  console.log("\nStep 2/2  API Key");
  console.log("  Leave blank to keep current / skip");
  const apiKeyDefault = saved.apiKey ? maskApiKey(saved.apiKey) : "";
  const apiKeyInput = await ask("  API Key", apiKeyDefault);
  const apiKey =
    saved.apiKey && apiKeyInput === maskApiKey(saved.apiKey)
      ? saved.apiKey
      : apiKeyInput || saved.apiKey;

  // Summary
  console.log("\n──────────────────────────────────────────────────");
  console.log(`  gateway   ${gatewayUrl}`);
  console.log(`  apiKey    ${apiKey ? maskApiKey(apiKey) : "(none)"}`);
  console.log("──────────────────────────────────────────────────");

  const save = await confirm("\nSave configuration?", true);
  if (!save) {
    console.log("Aborted — no changes saved.");
    return;
  }

  const next: SavedClientConfig = {
    gatewayUrl,
    ...(apiKey ? { apiKey } : {}),
  };
  writeSavedConfig(next);
  console.log(`\n✔ Config saved to ${CONFIG_PATH}`);
}

// ── Config sub-commands ───────────────────────────────────────────────────────

function runConfigShow(): void {
  const saved = readSavedConfig();
  if (Object.keys(saved).length === 0) {
    console.log("No saved config. Run `portivox config` to set up.");
    return;
  }
  console.log(`\nSaved config (${CONFIG_PATH}):\n`);
  const display: Record<string, unknown> = { ...saved };
  if (typeof saved.apiKey === "string" && saved.apiKey) {
    display.apiKey = maskApiKey(saved.apiKey);
  }
  for (const [k, v] of Object.entries(display)) {
    console.log(`  ${k.padEnd(20)} ${String(v)}`);
  }
  console.log();
}

function runConfigReset(): void {
  if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
    console.log(`Config deleted: ${CONFIG_PATH}`);
  } else {
    console.log("No config file found — nothing to reset.");
  }
}

function validateGatewayUrl(v: string): string {
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error("gatewayUrl must be a valid URL (e.g. wss://host:7000/connect)");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`gatewayUrl scheme must be ws:// or wss:// (got ${parsed.protocol})`);
  }
  if (parsed.protocol === "ws:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLoopback) {
      console.warn("⚠  WARNING: ws:// transmits your API key and all tunnel traffic in plaintext.");
      console.warn("   Use wss:// for any non-localhost gateway to protect your credentials.");
    }
  }
  return v;
}

const CONFIG_KEY_VALIDATORS: Record<string, (v: string) => unknown> = {
  gatewayUrl: (v) => validateGatewayUrl(v),
  apiKey: (v) => v,
};

function runConfigSet(key: string, value: string): void {
  const validator = CONFIG_KEY_VALIDATORS[key];
  if (!validator) {
    console.error(`Unknown config key: ${key}`);
    console.error(`Valid keys: ${Object.keys(CONFIG_KEY_VALIDATORS).join(", ")}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = validator(value);
  } catch (err) {
    console.error(`Invalid value: ${(err as Error).message}`);
    process.exit(1);
  }
  const saved = readSavedConfig();
  writeSavedConfig({ ...saved, [key]: parsed });
  console.log(`✔ Set ${key} = ${String(parsed)}`);
}

// ── Client runner ─────────────────────────────────────────────────────────────

function startClient({
  gatewayUrl,
  localBase,
  requestedSubdomain,
  tunnelType,
  localTcpHost,
  localTcpPort,
  apiKey,
}: {
  gatewayUrl: string;
  localBase: string;
  requestedSubdomain?: string;
  tunnelType?: "http" | "tcp";
  localTcpHost?: string;
  localTcpPort?: number;
  apiKey?: string;
}): void {
  const client = new TunnelClient({
    gatewayUrl,
    localBase,
    tunnelType,
    localTcpHost,
    localTcpPort,
    requestedSubdomain,
    localTimeoutMs: defaultConfig.localTimeoutMs,
    maxResponseBodyBytes: defaultConfig.maxLocalResponseBodyBytes,
    responseChunkBytes: defaultConfig.responseChunkBytes,
    wsHeaders: apiKey ? { "x-api-key": apiKey } : undefined,
  });

  client.start();

  process.on("SIGINT", () => {
    client.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    client.stop();
    process.exit(0);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  // ── config ───────────────────────────────────────────────────────────────
  if (command === "config") {
    const sub = args[1];

    if (sub === "--show") {
      runConfigShow();
      return;
    }

    if (sub === "--reset") {
      runConfigReset();
      return;
    }

    if (sub && !sub.startsWith("--")) {
      const value = args[2];
      if (!value) {
        console.error("Usage: portivox config <key> <value>");
        process.exit(1);
      }
      runConfigSet(sub, value);
      return;
    }

    await runConfigWizard();
    return;
  }

  // ── register (deprecated) ───────────────────────────────────────────────
  if (command === "register") {
    console.warn("⚠  `register` is deprecated. Use `portivox config` instead.");
    const apiKey = args[1]?.trim();
    if (!apiKey) {
      console.error("Missing API key. Usage: register <apiKey>");
      process.exit(1);
    }
    const gatewayUrl = pickArg(args, "--gateway") ?? readSavedConfig().gatewayUrl ?? defaultConfig.gatewayUrl;
    writeSavedConfig({ ...readSavedConfig(), apiKey, gatewayUrl });
    console.log(`Registered API key locally at ${CONFIG_PATH}`);
    return;
  }

  // ── open ──────────────────────────────────────────────────────────────────
  if (command === "open") {
    const saved = readSavedConfig();
    const rawPort = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const port = rawPort ? Number(rawPort) : 3000;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`Invalid port "${rawPort}". Usage: open [port]`);
      process.exit(1);
    }

    // --tcp flag → TCP tunnel; default is HTTP
    const tcpMode = args.includes("--tcp");

    const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
    const host = pickArg(args, "--host") ?? "127.0.0.1";
    const localBase = pickArg(args, "--local") ?? `http://${host}:${port}`;
    const requestedSubdomain = pickArg(args, "--subdomain");
    const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

    if (!apiKey) {
      console.error(
        "No API key found. Run `portivox config` to set one, or set TUNNEL_API_KEY env var.",
      );
      process.exit(1);
    }

    console.log(`Connecting to gateway : ${gatewayUrl}`);
    console.log(`Local service         : ${localBase}  [${tcpMode ? "TCP" : "HTTP"}]`);
    startClient({
      gatewayUrl,
      localBase,
      requestedSubdomain,
      tunnelType: tcpMode ? "tcp" : "http",
      localTcpHost: host,
      localTcpPort: port,
      apiKey,
    });
    return;
  }

  // ── legacy env-driven mode ───────────────────────────────────────────────
  const saved = readSavedConfig();
  const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  const localBase = pickArg(args, "--local") ?? defaultConfig.localUrl;
  const requestedSubdomain = pickArg(args, "--subdomain");
  const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;
  startClient({ gatewayUrl, localBase, requestedSubdomain, apiKey });
}

run().catch((err: unknown) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
