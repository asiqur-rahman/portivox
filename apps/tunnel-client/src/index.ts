import { loadClientConfig } from "tunnelix-config";
import { TunnelClient } from "./client";

const args = process.argv.slice(2);
const defaultConfig = loadClientConfig();

function pickArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) {
    return undefined;
  }
  return argv[idx + 1];
}

const client = new TunnelClient({
  gatewayUrl: pickArg(args, "--gateway") ?? defaultConfig.gatewayUrl,
  localBase: pickArg(args, "--local") ?? defaultConfig.localUrl,
  requestedSubdomain: pickArg(args, "--subdomain"),
  localTimeoutMs: defaultConfig.localTimeoutMs,
  maxResponseBodyBytes: defaultConfig.maxLocalResponseBodyBytes,
  responseChunkBytes: defaultConfig.responseChunkBytes,
  wsHeaders: process.env.TUNNEL_API_KEY ? { "x-api-key": process.env.TUNNEL_API_KEY } : undefined,
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
