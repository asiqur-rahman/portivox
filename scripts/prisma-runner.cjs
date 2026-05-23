#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

// ---------------------------------------------------------------------------
// Load .env manually so DB_PROVIDER is available before Prisma CLI runs.
// Prisma CLI loads .env internally, but this script reads DB_PROVIDER BEFORE
// spawning Prisma, so it would miss the value without this step.
// ---------------------------------------------------------------------------
const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already in environment (allow shell overrides)
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

const rawArgs = process.argv.slice(2);
const providerArgPrefix = "--provider=";
const providerArg = rawArgs.find((arg) => arg.startsWith(providerArgPrefix));
const providerFromArg = providerArg ? providerArg.slice(providerArgPrefix.length) : "";
// Default to mysql — it is the project's primary DB engine.
const providerRaw = (providerFromArg || process.env.DB_PROVIDER || "mysql").toLowerCase();
const provider = providerRaw === "mysql" ? "mysql" : "postgresql";
const schemaPath = `prisma/${provider}/schema.prisma`;
const args = rawArgs.filter((arg) => !arg.startsWith(providerArgPrefix));

console.log(`[prisma-runner] provider=${provider}  schema=${schemaPath}`);

const result = spawnSync("npx", ["prisma", ...args, "--schema", schemaPath], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
