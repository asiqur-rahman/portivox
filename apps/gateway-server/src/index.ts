import { loadGatewayConfig } from "portivox-config";
import { createLogger } from "portivox-logger";
import { createGatewayServer } from "./server";

const logger = createLogger("gateway");
const gatewayConfig = loadGatewayConfig();
const server = createGatewayServer(gatewayConfig);

async function boot(): Promise<void> {
  await server.start();
  logger.info("Gateway runtime config loaded", gatewayConfig);
}

process.on("SIGINT", async () => {
  logger.info("SIGINT received; shutting down");
  await server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received; shutting down");
  await server.stop();
  process.exit(0);
});

boot().catch((error) => {
  logger.error("Gateway failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
