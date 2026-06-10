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
import net from "node:net";

function normalizeCliArgs(argv: string[]): string[] {
  const normalized = argv.map((arg) => {
    if (arg === "--consistent" || arg === "--always-on" || arg === "--background") return "--persistent";
    if (arg === "--service-name") return "--name";
    return arg;
  });
  const [first, ...rest] = normalized;
  if (!first) {
    return normalized;
  }
  const firstLower = first.toLowerCase();
  const knownCommands = new Set([
    "open",
    "config",
    "register",
    "login",
    "logout",
    "whoami",
    "me",
    "doctor",
    "diag",
    "list",
    "status",
    "tunnels",
    "services",
    "service",
    "logs",
    "start",
    "stop",
    "restart",
    "remove",
    "uninstall",
    "setup",
    "init",
    "http",
    "tcp",
    "expose",
    "share",
    "help",
    "--help",
    "-h",
    "--version",
    "-v",
    "version",
    "--version",
    "-v",
    "version",
  ]);
  if (/^\d+$/.test(first) && !knownCommands.has(first)) {
    return ["open", ...normalized];
  }
  if (firstLower === "login") return ["register", ...rest];
  if (firstLower === "me") return ["whoami", ...rest];
  if (firstLower === "diag") return ["doctor", ...rest];
  if (firstLower === "setup" || firstLower === "init") return ["config", ...rest];
  if (firstLower === "services" || firstLower === "service") {
    return ["config", "service", ...(rest.length > 0 ? rest : ["list"])];
  }
  if (["logs", "start", "stop", "restart", "remove", "uninstall"].includes(firstLower)) {
    return ["config", "service", firstLower === "uninstall" ? "remove" : firstLower, ...rest];
  }
  if (firstLower === "status") return rest.length > 0 ? ["config", "service", "status", ...rest] : ["list", ...rest];
  if (firstLower === "tunnels") return ["list", ...rest];
  if (firstLower === "http" || firstLower === "expose" || firstLower === "share") return ["open", ...rest];
  if (firstLower === "tcp") return rest.includes("--tcp") ? ["open", ...rest] : ["open", ...rest, "--tcp"];
  return normalized;
}

const args = normalizeCliArgs(process.argv.slice(2));
const defaultConfig = loadClientConfig();
const PORTIVOX_DIR = process.env.PORTIVOX_HOME
  ? resolvePath(process.env.PORTIVOX_HOME)
  : join(homedir(), ".portivox");
const CONFIG_PATH = join(PORTIVOX_DIR, "client.json");
const SESSIONS_PATH = join(PORTIVOX_DIR, "sessions.json");
const PACKAGE_VERSION = readPackageVersion();

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

type ValidatedPrincipal = {
  userId: string;
  authType: string;
  role: string;
  scopes: string[];
};

type TunnelRegistrationFailure = {
  message: string;
  code?: string;
};

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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

function gatewayApiBaseUrl(gatewayUrl: string): string {
  const parsed = new URL(gatewayUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function formatGatewayConnectionError(gatewayUrl: string, error: Error): Error {
  const details = `${gatewayApiBaseUrl(gatewayUrl)}/api/auth/validate`;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = error.message.toLowerCase();

  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || message.includes("fetch failed")) {
    return new Error(`Gateway unreachable. Check that ${details} is online and reachable.`);
  }

  if (code === "ECONNRESET" || code === "EPIPE") {
    return new Error(`Gateway connection was interrupted while validating the API key. Please try again.`);
  }

  return error;
}

function isLoopbackGatewayUrl(gatewayUrl: string): boolean {
  try {
    const parsed = new URL(gatewayUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function isGatewayUnreachableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("gateway unreachable") || message.includes("timed out while verifying the api key");
}

function describeLocalTarget(tunnelType: "http" | "tcp", localBase: string, localTcpHost?: string, localTcpPort?: number): { host: string; port: number } {
  if (tunnelType === "tcp") {
    return {
      host: localTcpHost ?? "127.0.0.1",
      port: localTcpPort ?? 0,
    };
  }

  const target = new URL(localBase);
  const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  return { host: target.hostname, port };
}

async function ensureLocalServiceReachable(
  tunnelType: "http" | "tcp",
  localBase: string,
  localTcpHost?: string,
  localTcpPort?: number,
): Promise<void> {
  const target = describeLocalTarget(tunnelType, localBase, localTcpHost, localTcpPort);
  if (!Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) {
    throw new Error(`Local app target is invalid. Check the configured port for ${localBase}.`);
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => fail(new Error("LOCAL_TIMEOUT")));
    socket.once("error", (error) => fail(error));
  }).catch((error: unknown) => {
    const code = error instanceof Error ? ((error as Error & { code?: string }).code ?? error.message) : "";
    if (code === "LOCAL_TIMEOUT" || code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENOTFOUND") {
      throw new Error(`Local app on port ${target.port} is not reachable. Start it first, then try again.`);
    }
    throw new Error(`Could not reach the local app on ${target.host}:${target.port}.`);
  });
}

function formatTunnelOpenFailure(
  failure: TunnelRegistrationFailure,
  context: { requestedSubdomain?: string; tcpMode: boolean },
): Error {
  switch (failure.code) {
    case "SUBDOMAIN_TAKEN":
      return new Error(
        context.requestedSubdomain
          ? `Subdomain "${context.requestedSubdomain}" is already taken. Choose another one or omit --subdomain.`
          : "Requested subdomain is already taken. Choose another one or omit --subdomain.",
      );
    case "TCP_PORT_EXHAUSTED":
      return new Error("TCP port range exhausted. No public TCP ports are currently available.");
    case "TCP_PORT_BUSY":
      return new Error("Requested TCP public port is unavailable. Try again or choose a different mapping.");
    case "TCP_TUNNEL_DISABLED":
      return new Error("TCP tunneling is disabled on this gateway.");
    case "SUBDOMAIN_ALLOCATE_FAILED":
      return new Error("No public subdomains are currently available. Please try again in a moment.");
    case "TCP_PORT_ALLOCATE_FAILED":
      return new Error("Could not allocate a public TCP port right now. Please try again in a moment.");
    case "GATEWAY_MAINTENANCE":
      return new Error("Gateway is in maintenance mode. Try again in a moment.");
    case "GATEWAY_DRAINING":
      return new Error("Gateway is temporarily draining and not accepting new tunnels. Try again shortly.");
    default:
      break;
  }

  const message = failure.message.toLowerCase();
  if (message.includes("maintenance")) {
    return new Error("Gateway is in maintenance mode. Try again in a moment.");
  }
  if (message.includes("draining")) {
    return new Error("Gateway is temporarily draining and not accepting new tunnels. Try again shortly.");
  }
  if (context.tcpMode && message.includes("tcp")) {
    return new Error("Could not open the TCP tunnel. Please try again in a moment.");
  }
  return new Error(failure.message);
}

async function verifyApiKeyWithGateway(gatewayUrl: string, apiKey: string): Promise<void> {
  await fetchValidatedPrincipal(gatewayUrl, apiKey);
}

async function fetchValidatedPrincipal(gatewayUrl: string, apiKey: string): Promise<ValidatedPrincipal> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = `${gatewayApiBaseUrl(gatewayUrl)}/api/auth/validate`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (response.ok) {
      const payload = await response.json() as { principal?: ValidatedPrincipal };
      if (!payload?.principal) {
        throw new Error("Gateway validation response did not include principal details.");
      }
      return payload.principal;
    }

    let message = "Could not verify API key";
    try {
      const payload = await response.json() as { error?: { message?: string } };
      if (payload?.error?.message) {
        message = payload.error.message;
      }
    } catch {
      // ignore JSON parsing errors
    }

    if (response.status === 401) {
      throw new Error("Invalid API key.");
    }
    if (response.status === 503) {
      throw new Error("Gateway responded but auth service is unavailable.");
    }
    throw new Error(`API key verification failed: ${message}`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Gateway timed out while verifying the API key.");
    }
    if (error instanceof Error) {
      throw formatGatewayConnectionError(gatewayUrl, error);
    }
    throw new Error("Failed to verify API key with the gateway.");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGatewayReadyStatus(gatewayUrl: string): Promise<{ ready: boolean; draining: boolean; maintenanceMode: boolean; activeTunnels: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = `${gatewayApiBaseUrl(gatewayUrl)}/readyz`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Gateway readiness check failed (${response.status})`);
    }
    return await response.json() as { ready: boolean; draining: boolean; maintenanceMode: boolean; activeTunnels: number };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Gateway timed out while checking readiness.");
    }
    if (error instanceof Error) {
      throw formatGatewayConnectionError(gatewayUrl, error);
    }
    throw new Error("Failed to check gateway readiness.");
  } finally {
    clearTimeout(timeout);
  }
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Portivox client commands:",
      "",
      "Quick start:",
      "  register <apiKey>            Save your API key",
      "  login <apiKey>               Friendly alias for register",
      "  logout                       Remove your saved API key",
      "  whoami                       Show the identity behind the current API key",
      "  doctor                       Check gateway, auth, and service readiness",
      "  3000                         Expose local port 3000 over HTTP",
      "  expose 3000                  First-class public alias for open 3000",
      "  http 3000                    Same as above",
      "  tcp 22                       Expose local port 22 as a TCP tunnel",
      "  3000 --always-on             Keep the tunnel alive across reboots",
      "",
      "Common commands:",
      "  open [port]                  Open an HTTP tunnel",
      "  open [port] --tcp            Open a raw TCP tunnel",
      "  list                         Show active tunnels",
      "  status                       Friendly alias for list",
      "  tunnels                      Friendly alias for list",
      "  services                     Show installed background services",
      "  status <name>                Show one background tunnel",
      "  logs <name>                  Tail background tunnel logs",
      "  stop <name>                  Stop a background tunnel",
      "  start <name>                 Start a background tunnel",
      "  restart <name>               Restart a background tunnel",
      "  remove <name>                Remove a background tunnel",
      "  setup                        Open the setup wizard",
      "",
      "Advanced setup:",
      "  config                        Interactive setup (gateway URL + API key)",
      "  config --show                 Print saved configuration",
      "  config <key> <value>          Set a single config field",
      "  config --reset                Delete saved configuration",
      "",
      "  services install              Prepare background service support",
      "  services uninstall            Remove ALL background tunnels",
      "  services list                 Same as services",
      "  services status [name]        Detailed status",
      "  services logs <name>          Same as logs <name>",
      "",
      "Tunnel options:",
      "  open [port] [--subdomain name] [--host 127.0.0.1]",
      "       [--tcp] [--no-ip-protection] [--exit-after <seconds>] [--heartbeat <ms>]",
      "       [--persistent|--consistent|--always-on|--background] [--name <service-name>]",
      "",
      "  <port> [same flags as open]",
      "",
      "       --persistent   Register + start as an OS background service (survives reboots).",
      "       --consistent   Friendly alias for --persistent.",
      "       --always-on    Friendly alias for --persistent.",
      "       --background   Friendly alias for --persistent.",
      "                      Returns immediately. Manage with 'status', 'logs', 'stop', 'restart'.",
      "                      Without --persistent: runs in the foreground (default behaviour).",
      "",
      "Developer option:",
      "  --gateway <url>                Override the saved gateway for advanced setups.",
      "",
      "Config keys: gatewayUrl, apiKey",
      "",
      "Examples:",
      "  portivox register tk_abc123",
      "  portivox login tk_abc123",
      "  portivox whoami",
      "  portivox doctor",
      "  portivox logout",
      "  portivox setup",
      "  portivox expose 3000",
      "  portivox http 3000",
      "  portivox tcp 22 --always-on",
      "  portivox config",
      "  portivox config --show",
      "  portivox config apiKey tk_abc123",
      "  portivox open 3000",
      "  portivox 3000",
      "  portivox open 3000 --persistent",
      "  portivox 3000 --consistent",
      "  portivox 3000 --always-on",
      "  portivox open 3000 --persistent --name myapp",
      "  portivox open 22 --tcp --persistent",
      "  portivox services",
      "  portivox status myapp",
      "  portivox logs myapp",
      "  portivox restart myapp",
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

  if (apiKey) {
    await verifyApiKeyWithGateway(gatewayUrl, apiKey);
    const ready = await fetchGatewayReadyStatus(gatewayUrl);
    if (ready.maintenanceMode) {
      throw new Error("Gateway is in maintenance mode. Try again in a moment.");
    }
    if (ready.draining) {
      throw new Error("Gateway is temporarily draining and not accepting new tunnels. Try again shortly.");
    }
  }

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

function runLogout(): void {
  const saved = readSavedConfig();
  if (!saved.apiKey) {
    // eslint-disable-next-line no-console
    console.log("No saved API key found. You are already logged out.");
    return;
  }

  const next: SavedClientConfig = { ...saved };
  delete next.apiKey;
  writeSavedConfig(next);
  // eslint-disable-next-line no-console
  console.log("✔ Logged out locally. Saved API key removed.");
  // eslint-disable-next-line no-console
  console.log("Next: portivox register <apiKey>");
}

async function runWhoAmI(): Promise<void> {
  const saved = readSavedConfig();
  const gatewayUrl = saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

  if (!apiKey) {
    throw new Error("No API key found. Run `portivox register <apiKey>` first.");
  }

  const principal = await fetchValidatedPrincipal(gatewayUrl, apiKey);
  // eslint-disable-next-line no-console
  console.log("Portivox identity:\n");
  // eslint-disable-next-line no-console
  console.log(`  Gateway   ${gatewayUrl}`);
  // eslint-disable-next-line no-console
  console.log(`  User ID   ${principal.userId}`);
  // eslint-disable-next-line no-console
  console.log(`  Auth      ${principal.authType}`);
  // eslint-disable-next-line no-console
  console.log(`  Role      ${principal.role}`);
  // eslint-disable-next-line no-console
  console.log(`  Scopes    ${principal.scopes.join(", ") || "(none)"}`);
}

async function runDoctor(): Promise<void> {
  const saved = readSavedConfig();
  const gatewayUrl = saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

  try {
    validateGatewayUrl(gatewayUrl);
    checks.push({ label: "Gateway URL", ok: true, detail: gatewayUrl });
  } catch (error) {
    checks.push({ label: "Gateway URL", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const ready = await fetchGatewayReadyStatus(gatewayUrl);
    checks.push({
      label: "Gateway reachability",
      ok: true,
      detail: `ready=${ready.ready} draining=${ready.draining} maintenance=${ready.maintenanceMode} activeTunnels=${ready.activeTunnels}`,
    });
  } catch (error) {
    checks.push({ label: "Gateway reachability", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  if (apiKey) {
    try {
      const principal = await fetchValidatedPrincipal(gatewayUrl, apiKey);
      checks.push({ label: "API key", ok: true, detail: `${maskApiKey(apiKey)} (${principal.role}, ${principal.authType})` });
    } catch (error) {
      checks.push({ label: "API key", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    checks.push({ label: "API key", ok: false, detail: "No saved API key. Run `portivox register <apiKey>`." });
  }

  checks.push({
    label: "Background service",
    ok: isServiceInfrastructureReady(),
    detail: isServiceInfrastructureReady()
      ? "Background service integration is installed."
      : "Not installed yet. It will be prepared automatically for --persistent / --always-on.",
  });

  const activeSessions = readSessions().length;
  checks.push({
    label: "Local session cache",
    ok: true,
    detail: `${activeSessions} tracked tunnel${activeSessions === 1 ? "" : "s"}`,
  });

  // eslint-disable-next-line no-console
  console.log("Portivox doctor:\n");
  for (const check of checks) {
    // eslint-disable-next-line no-console
    console.log(`  ${check.ok ? "✔" : "✖"} ${check.label.padEnd(20)} ${check.detail}`);
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

const CONFIG_KEY_ALIASES: Record<string, keyof typeof CONFIG_KEY_VALIDATORS> = {
  gateway: "gatewayUrl",
  gatewayurl: "gatewayUrl",
  "gateway-url": "gatewayUrl",
  apikey: "apiKey",
  "api-key": "apiKey",
  key: "apiKey",
};

function resolveConfigKey(rawKey: string): keyof typeof CONFIG_KEY_VALIDATORS | undefined {
  if (rawKey in CONFIG_KEY_VALIDATORS) {
    return rawKey as keyof typeof CONFIG_KEY_VALIDATORS;
  }

  const lowered = rawKey.trim().toLowerCase();
  return CONFIG_KEY_ALIASES[lowered];
}

function runConfigSet(key: string, value: string): void {
  const resolvedKey = resolveConfigKey(key);
  const validator = resolvedKey ? CONFIG_KEY_VALIDATORS[resolvedKey] : undefined;
  if (!validator) {
    // eslint-disable-next-line no-console
    console.error(`Unknown config key: ${key}`);
    // eslint-disable-next-line no-console
    console.error(`Valid keys: ${Object.keys(CONFIG_KEY_VALIDATORS).join(", ")}`);
    // eslint-disable-next-line no-console
    console.error("Tip: `apikey`, `api-key`, and `gateway` also work as friendly aliases.");
    process.exit(1);
  }
  const canonicalKey = resolvedKey as keyof typeof CONFIG_KEY_VALIDATORS;
  let parsed: unknown;
  try {
    parsed = validator(value);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Invalid value: ${(err as Error).message}`);
    process.exit(1);
  }
  const saved = readSavedConfig();
  writeSavedConfig({ ...saved, [canonicalKey]: parsed });
  // eslint-disable-next-line no-console
  console.log(`✔ Set ${canonicalKey} = ${String(parsed)}`);
}

async function runRegister(apiKey: string, gatewayOverride?: string): Promise<void> {
  const saved = readSavedConfig();
  const gatewayUrl = gatewayOverride ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  await verifyApiKeyWithGateway(gatewayUrl, apiKey);
  writeSavedConfig({ ...saved, apiKey, gatewayUrl });
  // eslint-disable-next-line no-console
  console.log(`✔ API key verified and saved to ${CONFIG_PATH}`);
  // eslint-disable-next-line no-console
  console.log(`Next: portivox 3000`);
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
  onFatalError,
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
  onFatalError?: (error: TunnelRegistrationFailure) => void;
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
    onFatalError,
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

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(PACKAGE_VERSION);
    return;
  }

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

  // ── register ────────────────────────────────────────────────────────────
  if (command === "register") {
    const apiKey = args[1]?.trim();
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error("Missing API key. Usage: portivox register <apiKey>");
      process.exit(1);
    }
    await runRegister(apiKey, pickArg(args, "--gateway"));
    return;
  }

  if (command === "logout") {
    runLogout();
    return;
  }

  if (command === "whoami") {
    await runWhoAmI();
    return;
  }

  if (command === "doctor") {
    await runDoctor();
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
      console.error("No API key found. Run `portivox register <apiKey>` first.");
      process.exit(1);
    }
    await verifyApiKeyWithGateway(gatewayUrl, apiKey);


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
      onFatalError: (failure) => {
        const formatted = formatTunnelOpenFailure(failure, { requestedSubdomain, tcpMode });
        // eslint-disable-next-line no-console
        console.error(formatted.message);
        process.exit(1);
      },
    });
    return;
  }

  // ── legacy: no subcommand (env-driven mode) ───────────────────────────────
  if (!command.startsWith("--")) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${command}`);
    // eslint-disable-next-line no-console
    console.error("Run `portivox --help` to see available commands.");
    process.exit(1);
  }
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

