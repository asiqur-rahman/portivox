#!/usr/bin/env node
import { createInterface } from "node:readline";
import { loadClientConfig } from "portivox-config";
import { TunnelClient, type RegisteredInfo } from "./client";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const defaultConfig = loadClientConfig();
const PORTIVOX_DIR = join(homedir(), ".portivox");
const CONFIG_PATH = join(PORTIVOX_DIR, "client.json");
const SESSIONS_PATH = join(PORTIVOX_DIR, "sessions.json");

// ── Types ─────────────────────────────────────────────────────────────────────

type SavedClientConfig = {
  gatewayUrl?: string;
  apiKey?: string;
  defaultPort?: number;
  defaultTunnelType?: "http" | "tcp";
  reconnectMode?: "always" | "once";
  heartbeatIntervalMs?: number;
};

type SessionEntry = {
  id: string;
  tunnelType: string;
  localPort?: number;
  subdomain?: string | null;
  publicPort?: number | null;
  publicHost?: string | null;
  redirectUrl?: string | null;
  accessLink?: string | null;
  startedAt: string;
};

// ── Config helpers ────────────────────────────────────────────────────────────

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

// ── Session helpers ───────────────────────────────────────────────────────────

function readSessions(): SessionEntry[] {
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf8"));
    return Array.isArray(raw) ? (raw as SessionEntry[]) : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: SessionEntry[]): void {
  mkdirSync(PORTIVOX_DIR, { recursive: true });
  writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

function addSession(entry: SessionEntry): void {
  const existing = readSessions().filter((s) => s.id !== entry.id);
  writeSessions([...existing, entry]);
}

function removeSession(id: string): void {
  writeSessions(readSessions().filter((s) => s.id !== id));
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
  // eslint-disable-next-line no-console
  console.log(`\n${question}`);
  options.forEach((o, i) =>
    // eslint-disable-next-line no-console
    console.log(`  ${i + 1}) ${o}${i === defaultIdx ? "  (default)" : ""}`)
  );
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

function pickArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Portivox client commands:",
      "  config                    Interactive setup wizard",
      "  config --show             Print saved configuration",
      "  config <key> <value>      Set a single config field",
      "  config --reset            Delete saved configuration",
      "  register <apiKey> [--gateway url]   (deprecated — use config instead)",
      "  open [port] [--gateway url] [--subdomain name] [--host 127.0.0.1]",
      "       [--tcp] [--http] [--no-ip-protection]",
      "       [--exit-after <seconds>] [--heartbeat <ms>]",
      "  list",
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
      "  portivox open 22 --tcp --no-ip-protection",
      "  portivox open 3000 --exit-after 10",
      "  portivox list",
    ].join("\n"),
  );
}

// ── Config wizard ─────────────────────────────────────────────────────────────

async function runConfigWizard(): Promise<void> {
  const saved = readSavedConfig();
  // eslint-disable-next-line no-console
  console.log("\n┌─────────────────────────────────────────────────┐");
  // eslint-disable-next-line no-console
  console.log("│  Portivox Setup Wizard                          │");
  // eslint-disable-next-line no-console
  console.log("│  Press Enter to keep the [current / default]    │");
  // eslint-disable-next-line no-console
  console.log("└─────────────────────────────────────────────────┘\n");

  // Step 1 — Gateway URL
  // eslint-disable-next-line no-console
  console.log("Step 1/6  Gateway URL");
  let gatewayUrl = await ask(
    "  Gateway URL",
    saved.gatewayUrl ?? defaultConfig.gatewayUrl,
  );
  try {
    gatewayUrl = validateGatewayUrl(gatewayUrl);
  } catch (err) {
    console.warn(`  ⚠  ${err instanceof Error ? err.message : String(err)} — keeping previous value.`);
    gatewayUrl = saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  }

  // Step 2 — API Key
  // eslint-disable-next-line no-console
  console.log("\nStep 2/6  API Key");
  // eslint-disable-next-line no-console
  console.log("  Leave blank to keep current / skip");
  const apiKeyDefault = saved.apiKey ? maskApiKey(saved.apiKey) : "";
  const apiKeyInput = await ask("  API Key", apiKeyDefault);
  // If the user typed what looks like the masked value, keep the original
  const apiKey =
    saved.apiKey && apiKeyInput === maskApiKey(saved.apiKey)
      ? saved.apiKey
      : apiKeyInput || saved.apiKey;

  // Step 3 — Default local port
  // eslint-disable-next-line no-console
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
    ],
    saved.reconnectMode === "once" ? 1 : 0,
  );
  const reconnectMode: "always" | "once" = reconnectChoice.includes("once") ? "once" : "always";

  // Step 6 — Heartbeat interval
  // eslint-disable-next-line no-console
  console.log("\nStep 6/6  Heartbeat Interval");
  const heartbeatRaw = await ask(
    "  Heartbeat interval ms",
    String(saved.heartbeatIntervalMs ?? defaultConfig.heartbeatIntervalMs ?? 5000),
  );
  const heartbeatIntervalMs = Math.max(500, Number(heartbeatRaw) || 5000);

  // Summary
  // eslint-disable-next-line no-console
  console.log("\n──────────────────────────────────────────────────");
  // eslint-disable-next-line no-console
  console.log("  Summary");
  // eslint-disable-next-line no-console
  console.log(`  gateway        ${gatewayUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  apiKey         ${apiKey ? maskApiKey(apiKey) : "(none)"}`);
  // eslint-disable-next-line no-console
  console.log(`  defaultPort    ${Number.isInteger(defaultPort) && defaultPort > 0 ? defaultPort : 3000}`);
  // eslint-disable-next-line no-console
  console.log(`  tunnelType     ${defaultTunnelType}`);
  // eslint-disable-next-line no-console
  console.log(`  reconnect      ${reconnectMode}`);
  // eslint-disable-next-line no-console
  console.log(`  heartbeat      ${heartbeatIntervalMs} ms`);
  // eslint-disable-next-line no-console
  console.log("──────────────────────────────────────────────────");

  const save = await confirm("\nSave configuration?", true);
  if (!save) {
    // eslint-disable-next-line no-console
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
  // eslint-disable-next-line no-console
  console.log(`\n✔ Config saved to ${CONFIG_PATH}`);
}

// ── Config sub-commands (--show, --reset, key value) ─────────────────────────

function runConfigShow(): void {
  const saved = readSavedConfig();
  if (Object.keys(saved).length === 0) {
    // eslint-disable-next-line no-console
    console.log("No saved config. Run `portivox config` to set up.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`\nSaved config (${CONFIG_PATH}):\n`);
  const display: Record<string, unknown> = { ...saved };
  if (typeof saved.apiKey === "string" && saved.apiKey) {
    display.apiKey = maskApiKey(saved.apiKey);
  }
  for (const [k, v] of Object.entries(display)) {
    // eslint-disable-next-line no-console
    console.log(`  ${k.padEnd(20)} ${String(v)}`);
  }
  // eslint-disable-next-line no-console
  console.log();
}

function runConfigReset(): void {
  if (existsSync(CONFIG_PATH)) {
    rmSync(CONFIG_PATH);
    // eslint-disable-next-line no-console
    console.log(`Config deleted: ${CONFIG_PATH}`);
  } else {
    // eslint-disable-next-line no-console
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
  // Warn when a non-loopback plaintext ws:// URL is saved — credentials travel in cleartext.
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
    if (v !== "always" && v !== "once")
      throw new Error("reconnectMode must be 'always' or 'once'");
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
    // eslint-disable-next-line no-console
    console.error(`Unknown config key: ${key}`);
    // eslint-disable-next-line no-console
    console.error(`Valid keys: ${Object.keys(CONFIG_KEY_VALIDATORS).join(", ")}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = validator(value);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Invalid value: ${(err as Error).message}`);
    process.exit(1);
  }
  const saved = readSavedConfig();
  writeSavedConfig({ ...saved, [key]: parsed });
  // eslint-disable-next-line no-console
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
  ipProtection,
  exitAfterMs,
  heartbeatIntervalMs,
  noReconnect,
}: {
  gatewayUrl: string;
  localBase: string;
  requestedSubdomain?: string;
  tunnelType?: "http" | "tcp";
  localTcpHost?: string;
  localTcpPort?: number;
  apiKey?: string;
  ipProtection?: boolean;
  exitAfterMs?: number;
  heartbeatIntervalMs?: number;
  noReconnect?: boolean;
}): void {
  const sessionId = randomUUID();

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
    ipProtection,
    exitAfterMs,
    heartbeatIntervalMs: heartbeatIntervalMs ?? defaultConfig.heartbeatIntervalMs,
    noReconnect,
    onRegistered: (info: RegisteredInfo) => {
      addSession({
        id: sessionId,
        tunnelType: info.tunnelType ?? tunnelType ?? "http",
        localPort: localTcpPort,
        subdomain: info.subdomain ?? null,
        publicPort: info.publicTcpPort ?? null,
        publicHost: info.publicTcpHost ?? null,
        redirectUrl: info.redirectUrl ?? null,
        accessLink: info.accessLink ?? null,
        startedAt: new Date().toISOString(),
      });
    },
  });

  client.start();

  const cleanup = (): void => {
    removeSession(sessionId);
    client.stop();
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
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

    // config <key> <value>
    if (sub && !sub.startsWith("--")) {
      const value = args[2];
      if (!value) {
        // eslint-disable-next-line no-console
        console.error(`Usage: portivox config <key> <value>`);
        process.exit(1);
      }
      runConfigSet(sub, value);
      return;
    }

    // interactive wizard
    await runConfigWizard();
    return;
  }

  // ── register (deprecated) ───────────────────────────────────────────────
  if (command === "register") {
    // eslint-disable-next-line no-console
    console.warn("⚠  `register` is deprecated. Use `portivox config` instead.");
    const apiKey = args[1]?.trim();
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error("Missing API key. Usage: register <apiKey>");
      process.exit(1);
    }
    const gatewayUrl = pickArg(args, "--gateway") ?? readSavedConfig().gatewayUrl ?? defaultConfig.gatewayUrl;
    writeSavedConfig({ ...readSavedConfig(), apiKey, gatewayUrl });
    // eslint-disable-next-line no-console
    console.log(`Registered API key locally at ${CONFIG_PATH}`);
    return;
  }

  // ── list ─────────────────────────────────────────────────────────────────
  if (command === "list") {
    const sessions = readSessions();
    if (sessions.length === 0) {
      // eslint-disable-next-line no-console
      console.log("No active tunnels.");
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`Active tunnels (${sessions.length}):\n`);
    for (const s of sessions) {
      const endpoint = s.subdomain
        ? `https://${s.subdomain}`
        : s.publicHost && s.publicPort
          ? `${s.publicHost}:${s.publicPort}`
          : "(unknown)";
      // eslint-disable-next-line no-console
      console.log(`  [${s.tunnelType.toUpperCase()}] ${endpoint}`);
      if (s.localPort) {
        // eslint-disable-next-line no-console
        console.log(`    Local port : ${s.localPort}`);
      }
      if (s.redirectUrl) {
        // eslint-disable-next-line no-console
        console.log(`    Status URL : ${s.redirectUrl}`);
      }
      if (s.accessLink) {
        // eslint-disable-next-line no-console
        console.log(`    Access link: ${s.accessLink}`);
      }
      // eslint-disable-next-line no-console
      console.log(`    Started    : ${s.startedAt}`);
      // eslint-disable-next-line no-console
      console.log();
    }
    return;
  }

  // ── open ──────────────────────────────────────────────────────────────────
  if (command === "open") {
    const saved = readSavedConfig();
    const rawPort = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const port = rawPort ? Number(rawPort) : (saved.defaultPort ?? 0);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      // eslint-disable-next-line no-console
      console.error(
        rawPort
          ? `Invalid port "${rawPort}". Usage: open <port>`
          : "No port specified and no defaultPort saved. Run `portivox config` or pass a port.",
      );
      process.exit(1);
    }

    // --tcp flag overrides saved type; --http flag forces http
    const tcpMode =
      args.includes("--tcp") || (!args.includes("--http") && saved.defaultTunnelType === "tcp");
    const noIpProtection = args.includes("--no-ip-protection");

    const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
    const host = pickArg(args, "--host") ?? "127.0.0.1";
    const localBase = pickArg(args, "--local") ?? `http://${host}:${port}`;
    const requestedSubdomain = pickArg(args, "--subdomain");
    const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

    const exitAfterRaw = pickArg(args, "--exit-after");
    const exitAfterMs = exitAfterRaw ? Number(exitAfterRaw) * 1000 : undefined;

    const heartbeatRaw = pickArg(args, "--heartbeat");
    const heartbeatIntervalMs = heartbeatRaw
      ? Number(heartbeatRaw)
      : (saved.heartbeatIntervalMs ?? defaultConfig.heartbeatIntervalMs);

    const reconnectMode = saved.reconnectMode ?? "always";
    const noReconnect = reconnectMode === "once";

    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error(
        "No API key found. Run `portivox config` to set one, or set TUNNEL_API_KEY env var.",
      );
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log(`Opening ${tcpMode ? "TCP" : "HTTP"} tunnel: ${gatewayUrl} => ${localBase}`);
    if (tcpMode && !noIpProtection) {
      // eslint-disable-next-line no-console
      console.log("IP link protection is ON — TCP port is dark until you click the access link.");
    }
    if (reconnectMode === "once") {
      // eslint-disable-next-line no-console
      console.log("Reconnect mode: once — will exit on disconnect.");
    }

    startClient({
      gatewayUrl,
      localBase,
      requestedSubdomain,
      tunnelType: tcpMode ? "tcp" : "http",
      localTcpHost: host,
      localTcpPort: port,
      apiKey,
      ipProtection: tcpMode ? !noIpProtection : false,
      exitAfterMs,
      heartbeatIntervalMs,
      noReconnect,
    });
    return;
  }

  // ── legacy: no subcommand (env-driven mode) ───────────────────────────────
  const saved = readSavedConfig();
  const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  const localBase = pickArg(args, "--local") ?? defaultConfig.localUrl;
  const requestedSubdomain = pickArg(args, "--subdomain");
  const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;
  startClient({ gatewayUrl, localBase, requestedSubdomain, apiKey });
}

run().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
