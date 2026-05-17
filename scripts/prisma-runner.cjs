#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const rawArgs = process.argv.slice(2);
const providerArgPrefix = "--provider=";
const providerArg = rawArgs.find((arg) => arg.startsWith(providerArgPrefix));
const providerFromArg = providerArg ? providerArg.slice(providerArgPrefix.length) : "";
const providerRaw = (providerFromArg || process.env.DB_PROVIDER || "postgresql").toLowerCase();
const provider = providerRaw === "mysql" ? "mysql" : "postgresql";
const schemaPath = `prisma/${provider}/schema.prisma`;
const args = rawArgs.filter((arg) => !arg.startsWith(providerArgPrefix));

const result = spawnSync("npx", ["prisma", ...args, "--schema", schemaPath], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
