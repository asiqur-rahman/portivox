import { loadGatewayConfig } from "portivox-config";
import { createLogger } from "portivox-logger";
import { createGatewayServer } from "./server";

const logger = createLogger("gateway");
const gatewayConfig = loadGatewayConfig();
const server = createGatewayServer(gatewayConfig);

// Redact secret-bearing fields before logging config. Logging the raw config
// would leak the JWT signing secret, API keys, Redis credentials, the audit
// webhook secret and the metrics token into stdout/log shippers.
function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const SECRET_KEY = /(secret|token|password|api[_-]?keys?)$/i;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value && (SECRET_KEY.test(key) || key === "redisUrl")) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received; shutting down`);
  try {
    await server.stop();
    process.exit(exitCode);
  } catch (error) {
    logger.error("Error during shutdown", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

async function boot(): Promise<void> {
  await server.start();
  logger.info("Gateway runtime config loaded", redactConfig(gatewayConfig as unknown as Record<string, unknown>));
  // Signal readiness to a process manager (PM2 wait_ready, systemd) that waits
  // for the app to be up before considering the (re)start complete.
  if (typeof process.send === "function") {
    process.send("ready");
  }
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

// Last-resort guards: an unhandled rejection or uncaught exception would
// otherwise terminate the process abruptly (killing every live tunnel) with no
// diagnostic. Log loudly and drain before exiting so orchestrators can restart.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception; shutting down", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  // Exit non-zero so process managers (PM2/systemd/k8s) treat this as a crash
  // and restart, rather than a clean shutdown they leave down.
  void shutdown("uncaughtException", 1);
});

boot().catch((error) => {
  logger.error("Gateway failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
