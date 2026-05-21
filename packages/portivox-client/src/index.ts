#!/usr/bin/env node
import { createInterface } from "node:readline";
import { TunnelClient } from "./client";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const defaultConfig = loadClientConfig();
const CONFIG_PATH = join(homedir(), ".portivox", "client.json");

// ── Types ─────────────────────────────────────────────────────────────────────

type SavedClientConfig = {
  gatewayUrl?: string;
  apiKey?: string;
  defaultPort?: number;
  defaultTunnelType?: "http" | "tcp";
  reconnectMode?: "always" | "once" | "ask";
  heartbeatIntervalMs?: number;
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
    gatewayUrl: process.env.TUNNEL_GATEWAY_URL?.trim() || "ws://localhost:7000/connect",
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
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
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

async function choose(question: string, options: string[], defaultIdx = 0): Promise<string> {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}${i === defaultIdx ? "  (default)" : ""}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`Select [1-${options.length}]: `, (answer) => {
      rl.close();
      const n = Number(answer.trim());
      resolve(options[Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defaultIdx]);
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
      "  config                    Interactive setup wizard",
      "  config --show             Print saved configuration",
      "  config <key> <value>      Set a single config field",
      "  config --reset            Delete saved configuration",
      "  register <apiKey> [--gateway url]   (deprecated — use config instead)",
      "  open [port] [--gateway url] [--subdomain name] [--host 127.0.0.1]",
      "       [--tcp] [--http]",
      "",
      "Config keys: gatewayUrl, apiKey, defaultPort, defaultTunnelType,",
      "             reconnectMode, heartbeatIntervalMs",
      "",
      "Examples:",
      "  portivox config",
      "  portivox config --show",
      "  portivox config defaultPort 8080",
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
  console.log("Step 1/6  Gateway URL");
  const gatewayUrl = await ask("  Gateway URL", saved.gatewayUrl ?? defaultConfig.gatewayUrl);

  // Step 2 — API Key
  console.log("\nStep 2/6  API Key");
  console.log("  Leave blank to keep current / skip");
  const apiKeyDefault = saved.apiKey ? maskApiKey(saved.apiKey) : "";
  const apiKeyInput = await ask("  API Key", apiKeyDefault);
  const apiKey =
    saved.apiKey && apiKeyInput === maskApiKey(saved.apiKey)
      ? saved.apiKey
      : apiKeyInput || saved.apiKey;

  // Step 3 — Default local port
  console.log("\nStep 3/6  Default Local Port");
  const defaultPortRaw = await ask("  Default local port", String(saved.defaultPort ?? 3000));
  const defaultPort = Number(defaultPortRaw);

  // Step 4 — Default tunnel type
  const typeChoice = await choose(
    "Step 4/6  Default Tunnel Type",
    ["HTTP (expose a web server)", "TCP (raw socket, SSH, etc.)"],
    saved.defaultTunnelType === "tcp" ? 1 : 0,
  );
  const defaultTunnelType: "http" | "tcp" = typeChoice.startsWith("TCP") ? "tcp" : "http";

  // Step 5 — Reconnect mode
  const reconnectChoice = await choose(
    "Step 5/6  Reconnect Behaviour",
    [
      "Always reconnect on disconnect",
      "Connect once, exit on disconnect",
      "Ask before each reconnect",
    ],
    saved.reconnectMode === "once" ? 1 : saved.reconnectMode === "ask" ? 2 : 0,
  );
  const reconnectMode: "always" | "once" | "ask" = reconnectChoice.includes("once")
    ? "once"
    : reconnectChoice.includes("Ask")
      ? "ask"
      : "always";

  // Step 6 — Heartbeat interval
  console.log("\nStep 6/6  Heartbeat Interval");
  const heartbeatRaw = await ask(
    "  Heartbeat interval ms",
    String(saved.heartbeatIntervalMs ?? defaultConfig.heartbeatIntervalMs),
  );
  const heartbeatIntervalMs = Math.max(500, Number(heartbeatRaw) || 5000);

  // Summary
  console.log("\n──────────────────────────────────────────────────");
  console.log("  Summary");
  console.log(`  gateway        ${gatewayUrl}`);
  console.log(`  apiKey         ${apiKey ? maskApiKey(apiKey) : "(none)"}`);
  console.log(`  defaultPort    ${Number.isInteger(defaultPort) && defaultPort > 0 ? defaultPort : 3000}`);
  console.log(`  tunnelType     ${defaultTunnelType}`);
  console.log(`  reconnect      ${reconnectMode}`);
  console.log(`  heartbeat      ${heartbeatIntervalMs} ms`);
  console.log("──────────────────────────────────────────────────");

  const save = await confirm("\nSave configuration?", true);
  if (!save) {
    console.log("Aborted — no changes saved.");
    return;
  }

  const next: SavedClientConfig = {
    gatewayUrl,
    ...(apiKey ? { apiKey } : {}),
    defaultPort: Number.isInteger(defaultPort) && defaultPort > 0 ? defaultPort : 3000,
    defaultTunnelType,
    reconnectMode,
    heartbeatIntervalMs,
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
    rmSync(CONFIG_PATH);
    console.log(`Config deleted: ${CONFIG_PATH}`);
  } else {
    console.log("No config file found — nothing to reset.");
  }
}

const CONFIG_KEY_VALIDATORS: Record<string, (v: string) => unknown> = {
  gatewayUrl: (v) => v,
  apiKey: (v) => v,
  defaultPort: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error("defaultPort must be 1–65535");
    return n;
  },
  defaultTunnelType: (v) => {
    if (v !== "http" && v !== "tcp") throw new Error("defaultTunnelType must be 'http' or 'tcp'");
    return v;
  },
  reconnectMode: (v) => {
    if (v !== "always" && v !== "once" && v !== "ask")
      throw new Error("reconnectMode must be 'always', 'once', or 'ask'");
    return v;
  },
  heartbeatIntervalMs: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 500) throw new Error("heartbeatIntervalMs must be >= 500");
    return n;
  },
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
    const port = rawPort ? Number(rawPort) : (saved.defaultPort ?? 0);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(
        rawPort
          ? `Invalid port "${rawPort}". Usage: open <port>`
          : "No port specified and no defaultPort saved. Run `portivox config` or pass a port.",
      );
      process.exit(1);
    }

    const tcpMode =
      args.includes("--tcp") || (!args.includes("--http") && saved.defaultTunnelType === "tcp");

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

    console.log(`Opening ${tcpMode ? "TCP" : "HTTP"} tunnel: ${gatewayUrl} => ${localBase}`);
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
