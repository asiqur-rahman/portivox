#!/usr/bin/env node
import { createInterface } from "readline";
import { TunnelClient } from "./client";
import {
  installInfrastructure,
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
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import { homedir, hostname } from "os";
import { randomUUID } from "crypto";
import net from "net";

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
    "list",
    "tunnels",
    "config",
    "register",
    "login",
    "logout",
    "whoami",
    "me",
    "doctor",
    "diag",
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
  if (firstLower === "tunnels") return ["list", ...rest];
  if (firstLower === "status") return ["config", "service", "status", ...rest];
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

// ── Session tracking ──────────────────────────────────────────────────────────
// Records active tunnels to ~/.portivox/sessions.json so `portivox list` can
// report them and revoke can drop them. Mirrors apps/tunnel-client.
type SessionEntry = {
  id: string;
  tunnelType: string;
  localPort?: number;
  subdomain?: string | null;
  publicPort?: number | null;
  publicHost?: string | null;
  dedicatedTcpPort?: number | null;
  dedicatedTcpHost?: string | null;
  redirectUrl?: string | null;
  accessLink?: string | null;
  startedAt: string;
};

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
  // Atomic write (temp + rename) so a torn write can't wipe the session list.
  const tmp = `${SESSIONS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  renameSync(tmp, SESSIONS_PATH);
}

function addSession(entry: SessionEntry): void {
  const existing = readSessions().filter((s) => s.id !== entry.id);
  writeSessions([...existing, entry]);
}

function removeSession(id: string): void {
  writeSessions(readSessions().filter((s) => s.id !== id));
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SavedClientConfig = {
  gatewayUrl?: string;
  apiKey?: string;
  /** Stable per-machine identifier so the gateway shows this machine as one
   *  device across restarts/reconnects. */
  deviceId?: string;
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

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
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
  // Don't consume the next token if it's itself a flag (e.g. `--subdomain --tcp`).
  const next = argv[idx + 1];
  if (next.startsWith("--")) {
    return undefined;
  }
  return next;
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
    return new Error("Gateway connection was interrupted while validating the API key. Please try again.");
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

/** Register this machine as a device (best-effort) so it shows in the console
 *  roster right after `portivox register`, before any tunnel is opened. */
async function registerDeviceWithGateway(gatewayUrl: string, apiKey: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${gatewayApiBaseUrl(gatewayUrl)}/api/devices/register`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ deviceId: getOrCreateDeviceId(), name: hostname(), platform: process.platform, clientVersion: PACKAGE_VERSION }),
      signal: controller.signal,
    });
  } catch {
    // Non-fatal: older gateways lack this endpoint; recorded on first tunnel.
  } finally {
    clearTimeout(timeout);
  }
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

/** Stable device identity for this machine (persisted, reused across restarts). */
function getOrCreateDeviceId(): string {
  const saved = readSavedConfig();
  if (saved.deviceId && /^[a-z0-9-]{8,}$/i.test(saved.deviceId)) {
    return saved.deviceId;
  }
  const deviceId = randomUUID();
  try {
    writeSavedConfig({ ...saved, deviceId });
  } catch {
    // non-fatal — ephemeral id for this run
  }
  return deviceId;
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
      "Portivox - expose a local port to the internet through your gateway.",
      "",
      "USAGE",
      "  portivox <command> [options]",
      "  portivox <port> [options]            Shorthand for: open <port>",
      "",
      "1) CONNECT YOUR ACCOUNT (one time)",
      "  register <apiKey>                    Save your API key (~/.portivox/client.json)",
      "  login <apiKey>                       Alias for register",
      "  whoami                               Show who the saved key belongs to",
      "  logout                               Forget the saved API key",
      "",
      "2) OPEN A TUNNEL",
      "  open <port>                          Expose local <port> over HTTP.",
      "                                         - You always get a public port:  HOST:PORT",
      "                                         - Plus a subdomain if your account has",
      "                                           subdomain access (a subscription a platform",
      "                                           admin enables). Otherwise: port only.",
      "  open <port> --tcp                    Expose a raw TCP port (SSH, RDP, databases)",
      "  open <port> --subdomain <name>       Request a specific subdomain (needs access)",
      "  open <port> --no-port                With subdomain access: subdomain only, no port",
      "  open <port> --host 0.0.0.0           Forward to a non-localhost address",
      "  <port>                               Same as 'open <port>'  (e.g. `portivox 3000`)",
      "  expose / http / share <port>         Friendly aliases for open",
      "  tcp <port>                           Friendly alias for open <port> --tcp",
      "",
      "  A foreground tunnel prints its public URL/port and keeps running.",
      "",
      "3) CLOSE A TUNNEL",
      "  Foreground tunnel   ->  press Ctrl+C in that terminal.",
      "  Background service  ->  portivox stop <name>     (see section 5)",
      "  From the web panel  ->  removing the tunnel closes the client immediately;",
      "                          it will NOT reconnect.",
      "",
      "4) SEE WHAT'S RUNNING",
      "  list                                 List tunnels opened from this machine",
      "  status / tunnels                     Aliases for list",
      "",
      "5) AUTO-START ON REBOOT (background service)",
      "  open <port> --always-on              Install an OS service that starts on boot and",
      "                                         restarts on crash. Returns immediately.",
      "                                         (aliases: --persistent, --background)",
      "  open <port> --always-on --name web   Name the service (default: portivox-<port>)",
      "  services                             List installed background services",
      "  status <name>                        Status of one background service",
      "  logs <name>                          Tail a background service's logs",
      "  start <name>                         Start it",
      "  stop <name>                          Stop it now (until next boot/start)",
      "  restart <name>                       Restart it",
      "  remove <name>                        Stop and uninstall it (no longer autostarts)",
      "",
      "6) CONFIG & DIAGNOSTICS",
      "  config                               Interactive setup (gateway URL + API key)",
      "  config --show                        Print saved configuration",
      "  config <key> <value>                 Set one field (keys: gatewayUrl, apiKey)",
      "  config --reset                       Delete saved configuration",
      "  setup / init                         Alias for config",
      "  doctor                               Check gateway reachability, auth, services",
      "",
      "OPTIONS (for `open` / `<port>`)",
      "  --tcp                    Raw TCP tunnel instead of HTTP",
      "  --subdomain <name>       Request a custom subdomain (requires subdomain access)",
      "  --no-port                With subdomain access: expose only the subdomain",
      "  --no-ip-protection       TCP only: open the port immediately (skip the access link)",
      "  --host <addr>            Local address to forward to (default 127.0.0.1)",
      "  --always-on              Run as a background service that survives reboots",
      "  --name <name>            Name for the background service",
      "  --gateway <url>          Override the saved gateway URL",
      "",
      "EXAMPLES",
      "  portivox register tk_abc123            # save your key",
      "  portivox 3000                          # expose port 3000 over HTTP",
      "  portivox open 3000 --subdomain myapp   # request myapp.<domain> (needs access)",
      "  portivox tcp 22                        # expose SSH over a public TCP port",
      "  portivox 3000 --always-on              # auto-start on reboot",
      "  portivox open 3000 --always-on --name web",
      "  portivox list                          # what's running here",
      "  portivox restart web                   # restart the 'web' service",
      "  portivox remove web                    # stop autostart & uninstall",
      "  # Close a foreground tunnel with Ctrl+C.",
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

  if (apiKey) {
    await verifyApiKeyWithGateway(gatewayUrl, apiKey);
  }

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

function runLogout(): void {
  const saved = readSavedConfig();
  if (!saved.apiKey) {
    console.log("No saved API key found. You are already logged out.");
    return;
  }

  const next: SavedClientConfig = { ...saved };
  delete next.apiKey;
  writeSavedConfig(next);
  console.log("✔ Logged out locally. Saved API key removed.");
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
  console.log("Portivox identity:\n");
  console.log(`  Gateway   ${gatewayUrl}`);
  console.log(`  User ID   ${principal.userId}`);
  console.log(`  Auth      ${principal.authType}`);
  console.log(`  Role      ${principal.role}`);
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

  console.log("Portivox doctor:\n");
  for (const check of checks) {
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
    console.error(`Unknown config key: ${key}`);
    console.error(`Valid keys: ${Object.keys(CONFIG_KEY_VALIDATORS).join(", ")}`);
    console.error("Tip: `apikey`, `api-key`, and `gateway` also work as friendly aliases.");
    process.exit(1);
  }
  const canonicalKey = resolvedKey as keyof typeof CONFIG_KEY_VALIDATORS;
  let parsed: unknown;
  try {
    parsed = validator(value);
  } catch (err) {
    console.error(`Invalid value: ${(err as Error).message}`);
    process.exit(1);
  }
  const saved = readSavedConfig();
  writeSavedConfig({ ...saved, [canonicalKey]: parsed });
  console.log(`✔ Set ${canonicalKey} = ${String(parsed)}`);
}

async function runRegister(apiKey: string, gatewayOverride?: string): Promise<void> {
  const saved = readSavedConfig();
  const gatewayUrl = gatewayOverride ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  await verifyApiKeyWithGateway(gatewayUrl, apiKey);
  writeSavedConfig({ ...saved, apiKey, gatewayUrl });
  await registerDeviceWithGateway(gatewayUrl, apiKey);
  console.log(`✔ API key verified and saved to ${CONFIG_PATH}`);
  console.log(`This device (${hostname()}) is now registered — see it under Devices.`);
  console.log("Next: portivox 3000");
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
  withDedicatedPort,
  ipProtection,
  onFatalError,
  onRevoked,
}: {
  gatewayUrl: string;
  localBase: string;
  requestedSubdomain?: string;
  tunnelType?: "http" | "tcp";
  localTcpHost?: string;
  localTcpPort?: number;
  apiKey?: string;
  withDedicatedPort?: boolean;
  ipProtection?: boolean;
  onFatalError?: (error: TunnelRegistrationFailure) => void;
  onRevoked?: (info: { subdomain?: string; reason?: string }) => void;
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
    withDedicatedPort,
    ipProtection,
    deviceId: getOrCreateDeviceId(),
    deviceName: hostname(),
    platform: process.platform,
    clientVersion: PACKAGE_VERSION,
    onFatalError,
    onRegistered: (info) => {
      addSession({
        id: sessionId,
        tunnelType: info.tunnelType ?? tunnelType ?? "http",
        localPort: localTcpPort,
        subdomain: info.subdomain ?? null,
        publicPort: info.publicPort ?? info.publicTcpPort ?? null,
        publicHost: info.publicHost ?? info.publicTcpHost ?? null,
        dedicatedTcpPort: info.dedicatedTcpPort ?? null,
        dedicatedTcpHost: info.dedicatedTcpHost ?? null,
        redirectUrl: info.redirectUrl ?? null,
        accessLink: info.accessLink ?? null,
        startedAt: new Date().toISOString(),
      });
    },
    onRevoked: (info) => {
      removeSession(sessionId);
      onRevoked?.(info);
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

  // ── list active tunnels ────────────────────────────────────────────────────
  if (command === "list") {
    const sessions = readSessions();
    if (sessions.length === 0) {
      console.log("No active tunnels.");
      return;
    }
    console.log(`Active tunnels (${sessions.length}):\n`);
    for (const s of sessions) {
      const publicUrl = (() => {
        if (s.redirectUrl) {
          try {
            const u = new URL(s.redirectUrl);
            if (s.subdomain) return `${u.protocol}//${s.subdomain}.${u.hostname}`;
          } catch { /* fall through */ }
        }
        if (s.subdomain) return `(subdomain: ${s.subdomain})`;
        if (s.publicHost && s.publicPort) return `${s.publicHost}:${s.publicPort}`;
        if (s.dedicatedTcpPort) return `${s.dedicatedTcpHost ?? s.publicHost ?? "localhost"}:${s.dedicatedTcpPort}`;
        return "(unknown)";
      })();
      console.log(`  [${s.tunnelType.toUpperCase()}] ${publicUrl}`);
      if (s.localPort) console.log(`    Local port : ${s.localPort}`);
      if (s.dedicatedTcpPort) console.log(`    TCP port   : ${s.dedicatedTcpHost ?? s.publicHost ?? "localhost"}:${s.dedicatedTcpPort}`);
      if (s.redirectUrl) console.log(`    Status URL : ${s.redirectUrl}`);
      if (s.accessLink) console.log(`    Access link: ${s.accessLink}`);
      console.log(`    Started    : ${s.startedAt}`);
      console.log();
    }
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

  // ── register ────────────────────────────────────────────────────────────
  if (command === "register") {
    const apiKey = args[1]?.trim();
    if (!apiKey) {
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
    // HTTP tunnels also expose a dedicated raw-TCP passthrough port alongside the
    // subdomain BY DEFAULT. Pass --no-port to opt out. Ignored for --tcp tunnels.
    const withDedicatedPort = !tcpMode && !args.includes("--no-port");
    // IP-link protection keeps the exposed public port dark until the secret
    // access link is opened. On by default; --no-ip-protection turns it off.
    const ipProtection = !args.includes("--no-ip-protection");

    const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
    const host = pickArg(args, "--host") ?? "127.0.0.1";
    const localBase = pickArg(args, "--local") ?? `http://${host}:${port}`;
    const requestedSubdomain = pickArg(args, "--subdomain");
    const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

    if (!apiKey) {
      console.error("No API key found. Run `portivox register <apiKey>` first.");
      process.exit(1);
    }
    await verifyApiKeyWithGateway(gatewayUrl, apiKey);
    const ready = await fetchGatewayReadyStatus(gatewayUrl);
    if (ready.maintenanceMode) {
      throw new Error("Gateway is in maintenance mode. Try again in a moment.");
    }
    if (ready.draining) {
      throw new Error("Gateway is temporarily draining and not accepting new tunnels. Try again shortly.");
    }
    await ensureLocalServiceReachable(tcpMode ? "tcp" : "http", localBase, host, port);

    // ── persistent service mode ────────────────────────────────────────────
    const persistent  = args.includes("--persistent");
    const serviceName = pickArg(args, "--name") ?? `portivox-${port}`;

    if (persistent) {
      installService({
        name:        serviceName,
        port,
        tunnelType:  tcpMode ? "tcp" : "http",
        gatewayUrl:  gatewayUrl,
        apiKey,
        subdomain:   requestedSubdomain,
        host,
        withDedicatedPort,
        ipProtection,
      });
      return;
    }

    // ── one-shot foreground mode (default) ────────────────────────────────
    console.log(`Connecting to gateway : ${gatewayUrl}`);
    console.log(`Local service         : ${localBase}  [${tcpMode ? "TCP" : "HTTP"}]`);
    if (withDedicatedPort) {
      console.log("A dedicated raw TCP port will be exposed alongside the subdomain (pass --no-port to disable).");
    }
    startClient({
      gatewayUrl,
      localBase,
      requestedSubdomain,
      tunnelType: tcpMode ? "tcp" : "http",
      localTcpHost: host,
      localTcpPort: port,
      apiKey,
      withDedicatedPort,
      ipProtection,
      onFatalError: (failure) => {
        const formatted = formatTunnelOpenFailure(failure, { requestedSubdomain, tcpMode });
        console.error(formatted.message);
        process.exit(1);
      },
      onRevoked: (info) => {
        console.log(
          `\nTunnel${info.subdomain ? ` '${info.subdomain}'` : ""} was removed from the web control panel. Closing.`,
        );
        process.exit(0);
      },
    });
    return;
  }

  // ── legacy env-driven mode ───────────────────────────────────────────────
  if (!command.startsWith("--")) {
    console.error(`Unknown command: ${command}`);
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
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});

