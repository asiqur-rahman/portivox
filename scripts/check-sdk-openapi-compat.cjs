const fs = require("node:fs/promises");
const path = require("node:path");

function parseSemver(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

async function main() {
  const sdkPkgPath = path.resolve(process.cwd(), "packages", "sdk", "package.json");
  const openApiPath = path.resolve(process.cwd(), "docs", "openapi.v1.json");

  const sdkPkg = JSON.parse(await fs.readFile(sdkPkgPath, "utf8"));
  const openApiDoc = JSON.parse(await fs.readFile(openApiPath, "utf8"));

  const sdkVersion = parseSemver(sdkPkg.version);
  const apiVersion = parseSemver(openApiDoc?.info?.version ?? "");

  if (sdkVersion.major !== apiVersion.major) {
    throw new Error(`SDK/OpenAPI major mismatch: sdk=${sdkPkg.version} api=${openApiDoc?.info?.version}`);
  }

  if (sdkVersion.minor < apiVersion.minor) {
    throw new Error(`SDK minor is behind OpenAPI: sdk=${sdkPkg.version} api=${openApiDoc?.info?.version}`);
  }

  console.log(`SDK/OpenAPI semver compatibility passed: sdk=${sdkPkg.version} api=${openApiDoc?.info?.version}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
