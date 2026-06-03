#!/usr/bin/env node
import { createInterface } from "node:readline";
import { loadClientConfig } from "portivox-config";
import { TunnelClient, type RegisteredInfo } from "./client";
import {
  installInfrastructure,
  isServiceInfrastructureReady,
  uninstallAllServices,
  installService,
  uninstallService,
  startService,
  stopService,
  restartService,
  statusService,
  listServices,
  logsService,
} from "./service";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

function normalizeCliArgs(argv: string[]): string[] {
  const normalized = argv.map((arg) => (arg === "--consistent" ? "--persistent" : arg));
  const first = normalized[0];
  const knownCommands = new Set(["open", "config", "register", "list", "help", "--help", "-h"]);
  if (first && /^\d+$/.test(first) && !knownCommands.has(first)) {
    return ["open", ...normalized];
  }
  return normalized;
}

const args = normalizeCliArgs(process.argv.slice(2));
const defaultConfig = loadClientConfig();
const PORTIVOX_DIR = process.env.PORTIVOX_HOME
  ? resolvePath(process.env.PORTIVOX_HOME)
  : join(homedir(), ".portivox");
const CONFIG_PATH = join(PORTIVOX_DIR, "client.json");
const SESSIONS_PATH = join(PORTIVOX_DIR, "sessions.json");

// ── Types ─────────────────────────────────────────────────────────────────────

type SavedClientConfig = {
  gatewayUrl?: string;
  apiKey?: string;
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

async function ensurePersistentModeReady(): Promise<void> {
  if (isServiceInfrastructureReady()) {
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // eslint-disable-next-line no-console
  console.log("\nPersistent mode needs one-time background service setup on this machine.");

  if (interactive) {
    const approved = await confirm("Install the background service integration now?", true);
    if (!approved) {
      // eslint-disable-next-line no-console
      console.log("Cancelled — persistent mode was not installed.");
      process.exit(0);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("Preparing background service integration automatically...");
  }

  installInfrastructure();
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
      "",
      "  config                        Interactive setup (gateway URL + API key)",
      "  config --show                 Print saved configuration",
      "  config <key> <value>          Set a single config field",
      "  config --reset                Delete saved configuration",
      "",
      "  config service install        Set up OS service infrastructure (run once)",
      "  config service uninstall      Remove ALL persistent services",
      "  config service list           List installed persistent services + status",
      "  config service status [name]  Detailed status for one or all services",
      "  config service stop    <name> Stop a running service",
      "  config service start   <name> Start a stopped service",
      "  config service restart <name> Restart a service",
      "  config service remove  <name> Stop + permanently uninstall a service",
      "  config service logs    <name> [--lines 50]  Tail the service log",
      "",
      "  open [port] [--gateway url] [--subdomain name] [--host 127.0.0.1]",
      "       [--tcp] [--no-ip-protection] [--exit-after <seconds>] [--heartbeat <ms>]",
      "       [--persistent|--consistent] [--name <service-name>]",
      "",
      "  <port> [same flags as open]",
      "",
      "       --persistent   Register + start as an OS background service (survives reboots).",
      "       --consistent   Friendly alias for --persistent.",
      "                      Returns immediately.  Use 'config service *' to manage it.",
      "                      Without --persistent: runs in the foreground (default behaviour).",
      "",
      "  list",
      "",
      "Config keys: gatewayUrl, apiKey",
      "",
      "Examples:",
      "  portivox config",
      "  portivox config --show",
      "  portivox config apiKey tk_abc123",
      "  portivox config service install",
      "  portivox open 3000",
      "  portivox 3000",
      "  portivox open 3000 --persistent",
      "  portivox 3000 --consistent",
      "  portivox open 3000 --persistent --name myapp",
      "  portivox open 22 --tcp --persistent",
      "  portivox config service list",
      "  portivox config service logs myapp",
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
  console.log("Step 1/2  Gateway URL");
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
  console.log("\nStep 2/2  API Key");
  // eslint-disable-next-line no-console
  console.log("  Leave blank to keep current / skip");
  const apiKeyDefault = saved.apiKey ? maskApiKey(saved.apiKey) : "";
  const apiKeyInput = await ask("  API Key", apiKeyDefault);
  // If the user typed what looks like the masked value, keep the original
  const apiKey =
    saved.apiKey && apiKeyInput === maskApiKey(saved.apiKey)
      ? saved.apiKey
      : apiKeyInput || saved.apiKey;

  // Summary
  // eslint-disable-next-line no-console
  console.log("\n──────────────────────────────────────────────────");
  // eslint-disable-next-line no-console
  console.log(`  gateway   ${gatewayUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  apiKey    ${apiKey ? maskApiKey(apiKey) : "(none)"}`);
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

    // ── config service <sub-sub-command> ───────────────────────────────────
    if (sub === "service") {
      const sub2 = args[2];
      if (!sub2 || sub2 === "install") {
        installInfrastructure();
        return;
      }
      if (sub2 === "uninstall") {
        uninstallAllServices();
        return;
      }
      if (sub2 === "list") {
        listServices();
        return;
      }
      if (sub2 === "status") {
        statusService(args[3]);
        return;
      }
      if (sub2 === "stop") {
        stopService(args[3]);
        return;
      }
      if (sub2 === "start") {
        startService(args[3]);
        return;
      }
      if (sub2 === "restart") {
        restartService(args[3]);
        return;
      }
      if (sub2 === "remove") {
        uninstallService(args[3]);
        return;
      }
      if (sub2 === "logs") {
        const svcName = args[3];
        const lines = Number(pickArg(args, "--lines") ?? "50");
        logsService(svcName, Number.isFinite(lines) && lines > 0 ? lines : 50);
        return;
      }
      printUsage();
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
      // Derive the public tunnel URL from the redirect URL's origin if available.
      const publicUrl = (() => {
        if (s.redirectUrl) {
          try {
            const u = new URL(s.redirectUrl);
            if (s.subdomain) return `${u.protocol}//${s.subdomain}.${u.hostname}`;
          } catch { /* fall through */ }
        }
        if (s.subdomain) return `(subdomain: ${s.subdomain})`;
        if (s.publicHost && s.publicPort) return `${s.publicHost}:${s.publicPort}`;
        return "(unknown)";
      })();
      // eslint-disable-next-line no-console
      console.log(`  [${s.tunnelType.toUpperCase()}] ${publicUrl}`);
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
    const port = rawPort ? Number(rawPort) : 3000;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      // eslint-disable-next-line no-console
      console.error(`Invalid port "${rawPort}". Usage: open [port]`);
      process.exit(1);
    }

    // --tcp flag → TCP tunnel; default is HTTP
    const tcpMode = args.includes("--tcp");
    const noIpProtection = args.includes("--no-ip-protection");

    const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
    const host = pickArg(args, "--host") ?? "127.0.0.1";
    const localBase = pickArg(args, "--local") ?? `http://${host}:${port}`;
    const requestedSubdomain = pickArg(args, "--subdomain");
    const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

    const exitAfterRaw = pickArg(args, "--exit-after");
    const exitAfterMs = exitAfterRaw ? Number(exitAfterRaw) * 1000 : undefined;

    const heartbeatRaw = pickArg(args, "--heartbeat");
    const heartbeatIntervalMs = heartbeatRaw ? Number(heartbeatRaw) : defaultConfig.heartbeatIntervalMs;

    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error(
        "No API key found. Run `portivox config` to set one, or set TUNNEL_API_KEY env var.",
      );
      process.exit(1);
    }

    // ── persistent service mode ────────────────────────────────────────────
    const persistent   = args.includes("--persistent");
    const serviceName  = pickArg(args, "--name") ?? `portivox-${port}`;

    if (persistent) {
      await ensurePersistentModeReady();
      installService({
        name:         serviceName,
        port,
        tunnelType:   tcpMode ? "tcp" : "http",
        gatewayUrl:   gatewayUrl,
        apiKey,
        subdomain:    requestedSubdomain,
        host,
        ipProtection: tcpMode ? !noIpProtection : undefined,
      });
      return;
    }

    // ── one-shot foreground mode (default) ────────────────────────────────
    // eslint-disable-next-line no-console
    console.log(`Connecting to gateway : ${gatewayUrl}`);
    // eslint-disable-next-line no-console
    console.log(`Local service         : ${localBase}  [${tcpMode ? "TCP" : "HTTP"}]`);
    if (tcpMode && !noIpProtection) {
      // eslint-disable-next-line no-console
      console.log("IP link protection is ON — TCP port is dark until you click the access link.");
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
      noReconnect: false,
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
