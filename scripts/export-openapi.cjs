const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const { buildOpenApiDocument } = require("../apps/gateway-server/dist/openapi.js");
  const outputPath = path.resolve(process.cwd(), "docs", "openapi.v1.json");
  const document = buildOpenApiDocument("http://localhost:8080");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`OpenAPI exported to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
