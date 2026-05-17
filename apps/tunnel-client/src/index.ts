import { loadClientConfig } from "portivox-config";
import { TunnelClient } from "./client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const defaultConfig = loadClientConfig();
const CONFIG_PATH = join(homedir(), ".portivox", "client.json");

type SavedClientConfig = {
  apiKey?: string;
  gatewayUrl?: string;
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

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Portivox client commands:",
      "  register <apiKey> [--gateway ws://host:7000/connect]",
      "  open <port> [--gateway ws://host:7000/connect] [--subdomain myname] [--host 127.0.0.1] [--tcp]",
      "",
      "Examples:",
      "  npm run -w apps/tunnel-client dev -- register tk_xxx",
      "  npm run -w apps/tunnel-client dev -- open 3000",
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

  if (command === "open") {
    const rawPort = args[1];
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      // eslint-disable-next-line no-console
      console.error("Missing/invalid port. Usage: open <port>");
      process.exit(1);
    }
    const tcpMode = args.includes("--tcp");
    const saved = readSavedConfig();
    const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
    const host = pickArg(args, "--host") ?? "127.0.0.1";
    const localBase = pickArg(args, "--local") ?? `http://${host}:${port}`;
    const requestedSubdomain = pickArg(args, "--subdomain");
    const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;

    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.error("No API key found. Run register <apiKey> first, or set TUNNEL_API_KEY.");
      process.exit(1);
    }

    // eslint-disable-next-line no-console
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

  const saved = readSavedConfig();
  const gatewayUrl = pickArg(args, "--gateway") ?? saved.gatewayUrl ?? defaultConfig.gatewayUrl;
  const localBase = pickArg(args, "--local") ?? defaultConfig.localUrl;
  const requestedSubdomain = pickArg(args, "--subdomain");
  const apiKey = process.env.TUNNEL_API_KEY ?? saved.apiKey;
  startClient({ gatewayUrl, localBase, requestedSubdomain, apiKey });
}

run();

