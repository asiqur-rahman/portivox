#!/usr/bin/env node
import { loadClientConfig } from "portivox-config";
import { TunnelClient, type RegisteredInfo } from "./client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const defaultConfig = loadClientConfig();
const PORTIVOX_DIR = join(homedir(), ".portivox");
const CONFIG_PATH = join(PORTIVOX_DIR, "client.json");
const SESSIONS_PATH = join(PORTIVOX_DIR, "sessions.json");

type SavedClientConfig = {
  apiKey?: string;
  gatewayUrl?: string;
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
  writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

function addSession(entry: SessionEntry): void {
  const existing = readSessions().filter((s) => s.id !== entry.id);
  writeSessions([...existing, entry]);
}

function removeSession(id: string): void {
  writeSessions(readSessions().filter((s) => s.id !== id));
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Portivox client commands:",
      "  register <apiKey> [--gateway ws://host:7000/connect]",
      "  open <port> [--gateway url] [--subdomain name] [--host 127.0.0.1] [--tcp]",
      "              [--no-ip-protection] [--exit-after <seconds>] [--heartbeat <ms>]",
      "  list",
      "",
      "Examples:",
      "  portivox register tk_xxx",
      "  portivox open 3000",
      "  portivox open 22 --tcp",
      "  portivox open 22 --tcp --no-ip-protection",
      "  portivox open 3000 --exit-after 10",
      "  portivox list",
    ].join("\n"),
  );
}

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

function run(): void {
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "register") {
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

  if (command === "open") {
    const rawPort = args[1];
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      // eslint-disable-next-line no-console
      console.error("Missing/invalid port. Usage: open <port>");
      process.exit(1);
    }
    const tcpMode = args.includes("--tcp");
    const noIpProtection = args.includes("--no-ip-protection");
    const saved = readSavedConfig();
    const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
    const host = pickArg(args, "--host") ?? "127.0.0.1";
    const localBase = pickArg(args, "--local") ?? `http://${host}:${port}`;
    const requestedSubdomain = pickArg(args, "--subdomain");
    const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

    const exitAfterRaw = pickArg(args, "--exit-after");
    const exitAfterMs = exitAfterRaw ? Number(exitAfterRaw) * 1000 : undefined;

    const heartbeatRaw = pickArg(args, "--heartbeat");
    const heartbeatIntervalMs = heartbeatRaw ? Number(heartbeatRaw) : undefined;

    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error("No API key found. Run register <apiKey> first, or set TUNNEL_API_KEY.");
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log(`Opening ${tcpMode ? "TCP" : "HTTP"} tunnel: ${gatewayUrl} => ${localBase}`);
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
    });
    return;
  }

  const saved = readSavedConfig();
  const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  const localBase = pickArg(args, "--local") ?? defaultConfig.localUrl;
  const requestedSubdomain = pickArg(args, "--subdomain");
  const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;
  startClient({ gatewayUrl, localBase, requestedSubdomain, apiKey });
}

run();

