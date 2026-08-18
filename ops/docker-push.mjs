#!/usr/bin/env node
/**
 * ops/docker-push.mjs
 *
 * Fetch the latest semver tag from Docker Hub, offer the next patch / minor /
 * major, then build and push portivox-gateway and portivox-nginx.
 *
 * Usage:
 *   make push
 *   node ops/docker-push.mjs
 *   node ops/docker-push.mjs --version 1.2.3
 *   VERSION=1.2.3 make push
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DOCKER_USER = process.env.DOCKER_USER ?? "asiqurrahman";
const GATEWAY_IMAGE = `${DOCKER_USER}/portivox-gateway`;
const NGINX_IMAGE = `${DOCKER_USER}/portivox-nginx`;
const HUB_REPO = GATEWAY_IMAGE;
const DB_PROVIDER = process.env.DB_PROVIDER ?? "mysql";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function die(msg) {
  process.stderr.write(`${RED}${BOLD}✗ ${msg}${RESET}\n`);
  process.exit(1);
}
function ok(msg) {
  process.stdout.write(`${GREEN}✓ ${msg}${RESET}\n`);
}
function info(msg) {
  process.stdout.write(`${CYAN}  ${msg}${RESET}\n`);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseSemver(tag) {
  const m = String(tag).trim().match(SEMVER);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    version: `${m[1]}.${m[2]}.${m[3]}`,
  };
}

function compareSemver(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function bump(last) {
  if (!last) {
    return { patch: "1.0.0", minor: "1.0.0", major: "1.0.0" };
  }
  return {
    patch: `${last.major}.${last.minor}.${last.patch + 1}`,
    minor: `${last.major}.${last.minor + 1}.0`,
    major: `${last.major + 1}.0.0`,
  };
}

function gitSha() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function toWslPath(winPath) {
  return winPath
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

function detectDocker() {
  const native = spawnSync("docker", ["version"], { stdio: "ignore" });
  if (native.status === 0) return { mode: "native" };
  const wsl = spawnSync("wsl", ["-e", "docker", "version"], { stdio: "ignore" });
  if (wsl.status === 0) return { mode: "wsl" };
  die("docker is not available. Start Docker / WSL and retry.");
}

const docker = detectDocker();

function runDocker(args) {
  let result;
  if (docker.mode === "wsl") {
    const quoted = args
      .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
      .join(" ");
    result = spawnSync(
      "wsl",
      ["-e", "bash", "-lc", `cd '${toWslPath(ROOT)}' && docker ${quoted}`],
      { stdio: "inherit" },
    );
  } else {
    result = spawnSync("docker", args, { stdio: "inherit", cwd: ROOT });
  }
  if (result.status !== 0) die(`docker ${args[0]} failed.`);
}

async function fetchHubTags(repo) {
  const tags = [];
  let url = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`;
  while (url) {
    const res = await fetch(url);
    if (res.status === 404) return [];
    if (!res.ok) die(`Docker Hub lookup failed (${res.status}) for ${repo}.`);
    const body = await res.json();
    for (const row of body.results ?? []) tags.push(row.name);
    url = body.next ?? null;
  }
  return tags;
}

async function promptVersion(next, last) {
  const preset = arg("version") || process.env.VERSION || "";
  if (preset) {
    const parsed = parseSemver(preset);
    if (!parsed) die(`Invalid VERSION '${preset}'. Use semver like 1.2.3`);
    return parsed.version;
  }

  const autoVersion = last ? next.patch : "1.0.0";

  if (!stdin.isTTY) {
    ok(`Auto-increment → ${autoVersion}`);
    return autoVersion;
  }

  process.stdout.write(`\n${BOLD}Possible versions${RESET}  ${DIM}(default: auto-increment patch)${RESET}\n`);
  if (!last) {
    info(`[Enter] 1.0.0   auto  ← default`);
    info("[1] custom");
  } else {
    info(`[Enter] ${next.patch}   patch (auto-increment)  ← default`);
    info(`[1] ${next.minor}   minor`);
    info(`[2] ${next.major}   major`);
    info("[3] custom");
  }
  process.stdout.write("\n");

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${BOLD}Choose or press Enter for ${autoVersion}:${RESET} `)).trim();
  rl.close();

  if (!answer) return autoVersion;

  if (!last) {
    if (answer === "1") return await promptCustom();
  } else {
    if (answer === "1") return next.minor;
    if (answer === "2") return next.major;
    if (answer === "3") return await promptCustom();
  }

  const parsed = parseSemver(answer);
  if (!parsed) die(`Invalid choice '${answer}'.`);
  return parsed.version;
}

async function promptCustom() {
  const rl = createInterface({ input: stdin, output: stdout });
  const custom = (await rl.question(`${BOLD}Enter version (x.y.z):${RESET} `)).trim();
  rl.close();
  const parsed = parseSemver(custom);
  if (!parsed) die(`Invalid version '${custom}'. Use semver like 1.2.3`);
  return parsed.version;
}

function buildAndPush(image, dockerfile, tags, extraBuildArgs = []) {
  const tagArgs = tags.flatMap((t) => ["-t", `${image}:${t}`]);
  process.stdout.write(`\n${BOLD}Building ${image}${RESET}\n`);
  runDocker(["build", "-f", dockerfile, ...extraBuildArgs, ...tagArgs, "."]);
  if (hasFlag("skip-push")) {
    ok(`Built locally (skipped push) ${image}`);
    return;
  }
  process.stdout.write(`\n${BOLD}Pushing ${image}${RESET}\n`);
  for (const t of tags) runDocker(["push", `${image}:${t}`]);
}

const sha = gitSha();

process.stdout.write(`\n${BOLD}Portivox — Docker Hub push${RESET}\n\n`);
info(`Registry : docker.io/${DOCKER_USER}`);
info(`Images   : ${GATEWAY_IMAGE}  ${NGINX_IMAGE}`);
info(`DB       : ${DB_PROVIDER} (gateway build-arg)`);
info(`Git SHA  : ${sha}`);
info(`Docker   : ${docker.mode}`);
if (hasFlag("skip-push")) info("Mode     : build only (--skip-push)");

const names = await fetchHubTags(HUB_REPO);
const versions = names.map(parseSemver).filter(Boolean).sort(compareSemver);
const last = versions.at(-1) ?? null;
const other = names.filter((n) => !parseSemver(n));

process.stdout.write(`\n${YELLOW}${BOLD}Docker Hub: ${HUB_REPO}${RESET}\n`);
info(`Last version : ${last ? last.version : "none"}`);
if (other.length) info(`Other tags   : ${other.join(", ")}`);
if (!names.length) info(`${DIM}No tags on Hub yet — first publish will be 1.0.0 unless you pick another.${RESET}`);

const next = bump(last);
const version = await promptVersion(next, last);
const tags = [version, "latest", "production", sha];

process.stdout.write(`\n${BOLD}Will tag${hasFlag("skip-push") ? "" : " and push"} as:${RESET}\n`);
for (const t of tags) info(`${GATEWAY_IMAGE}:${t}`);
for (const t of tags) info(`${NGINX_IMAGE}:${t}`);

if (stdin.isTTY && !arg("version") && !process.env.VERSION) {
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = (await rl.question(`\n${BOLD}Proceed? [Y/n]:${RESET} `)).trim().toLowerCase();
  rl.close();
  if (confirm === "n" || confirm === "no") {
    process.stdout.write("Cancelled.\n");
    process.exit(0);
  }
}

buildAndPush(GATEWAY_IMAGE, "apps/gateway-server/Dockerfile", tags, [
  "--build-arg",
  `DB_PROVIDER=${DB_PROVIDER}`,
]);
buildAndPush(NGINX_IMAGE, "infra/nginx/Dockerfile", tags);

process.stdout.write("\n");
ok(hasFlag("skip-push") ? "Images built locally" : "Pushed to Docker Hub");
info(`${GATEWAY_IMAGE}:${version}`);
info(`${NGINX_IMAGE}:${version}`);
info(`https://hub.docker.com/r/${GATEWAY_IMAGE}/tags`);
info(`https://hub.docker.com/r/${NGINX_IMAGE}/tags`);
