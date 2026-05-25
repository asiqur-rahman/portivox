/**
 * Persistent-tunnel service management.
 *
 * Supports Linux (systemd user units), macOS (launchd LaunchAgents), and
 * Windows (Task Scheduler + .cmd restart-loop wrapper).
 *
 * Each `portivox open <port> --persistent` creates ONE dedicated OS service
 * for that specific tunnel.  No shared daemon.
 *
 * Registry: ~/.portivox/services.json — maps service name → ServiceEntry.
 * Logs:     ~/.portivox/logs/<name>.log
 */

import { execSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Paths ──────────────────────────────────────────────────────────────────────

const PORTIVOX_DIR  = join(homedir(), ".portivox");
const SERVICES_DIR  = join(PORTIVOX_DIR, "services");
const SERVICES_PATH = join(PORTIVOX_DIR, "services.json");
const LOGS_DIR      = join(PORTIVOX_DIR, "logs");

// ── Types ──────────────────────────────────────────────────────────────────────

export type ServiceEntry = {
  name: string;
  port: number;
  tunnelType: "http" | "tcp";
  /** undefined = read from ~/.portivox/client.json at runtime */
  gatewayUrl?: string;
  subdomain?: string;
  host: string;
  /** TCP only; false = pass --no-ip-protection; undefined = default (true) */
  ipProtection?: boolean;
  /** Absolute path to the Node.js binary recorded at install time */
  nodeBin: string;
  /** Absolute path to the portivox entry-point JS file */
  scriptPath: string;
  installedAt: string;
  platform: "linux" | "darwin" | "win32";
};

type ServiceRegistry = Record<string, ServiceEntry>;

export type InstallOpts = {
  name: string;
  port: number;
  tunnelType: "http" | "tcp";
  gatewayUrl?: string;
  subdomain?: string;
  host: string;
  ipProtection?: boolean;
};

// ── Registry I/O ──────────────────────────────────────────────────────────────

function readRegistry(): ServiceRegistry {
  try {
    const raw = JSON.parse(readFileSync(SERVICES_PATH, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as ServiceRegistry) : {};
  } catch {
    return {};
  }
}

function writeRegistry(reg: ServiceRegistry): void {
  mkdirSync(PORTIVOX_DIR, { recursive: true });
  writeFileSync(SERVICES_PATH, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

// ── Shared: build "portivox open" argument list ───────────────────────────────

function buildOpenArgs(entry: ServiceEntry): string[] {
  const { scriptPath, port, tunnelType, gatewayUrl, subdomain, host, ipProtection } = entry;
  const argv: string[] = [scriptPath, "open", String(port), "--host", host];
  if (tunnelType === "tcp") {
    argv.push("--tcp");
    if (ipProtection === false) argv.push("--no-ip-protection");
  }
  if (gatewayUrl) argv.push("--gateway", gatewayUrl);
  if (subdomain)  argv.push("--subdomain", subdomain);
  return argv;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function resolvePortivoxPaths(): { nodeBin: string; scriptPath: string } {
  return { nodeBin: process.execPath, scriptPath: process.argv[1] };
}

export function validateServiceName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,47}$/.test(name)) {
    throw new Error(
      `Invalid service name "${name}". ` +
      `Must start with a letter or digit, contain only letters/digits/hyphens, and be 1–48 chars.`,
    );
  }
}

function getPlatform(): "linux" | "darwin" | "win32" {
  const p = process.platform;
  if (p === "linux")  return "linux";
  if (p === "darwin") return "darwin";
  if (p === "win32")  return "win32";
  throw new Error(
    `Unsupported platform "${p}". Persistent services work on Linux (systemd), macOS (launchd), and Windows (Task Scheduler).`,
  );
}

function execQuiet(cmd: string): void {
  execSync(cmd, { stdio: "pipe" });
}

function execOrFail(cmd: string, label: string): void {
  try {
    execSync(cmd, { stdio: "pipe" });
  } catch (err) {
    const detail =
      err instanceof Error
        ? ((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString().trim() || err.message)
        : String(err);
    throw new Error(`${label}: ${detail}`);
  }
}

// ── Platform: systemd (Linux) ─────────────────────────────────────────────────

function systemdUnitPath(name: string): string {
  return join(homedir(), ".config", "systemd", "user", `portivox-${name}.service`);
}

/**
 * Quote a token for systemd ExecStart.
 * systemd has its own C-string escaping — wrap tokens that contain spaces,
 * backslashes, or double-quotes in double-quotes.
 */
function sdQuote(s: string): string {
  if (/[\s"\\]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function buildSystemdUnit(entry: ServiceEntry): string {
  const openArgs = buildOpenArgs(entry);
  const exec = [entry.nodeBin, ...openArgs].map(sdQuote).join(" ");
  const logFile = join(LOGS_DIR, `${entry.name}.log`);
  return [
    "[Unit]",
    `Description=Portivox tunnel: ${entry.name} (port ${entry.port})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function installSystemd(entry: ServiceEntry): void {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(systemdUnitPath(entry.name), buildSystemdUnit(entry));
  execOrFail("systemctl --user daemon-reload", "daemon-reload");
  execOrFail(`systemctl --user enable portivox-${entry.name}.service`, "enable");
  execOrFail(`systemctl --user start portivox-${entry.name}.service`, "start");

  // Suggest linger if not already enabled (needed to run when not logged in)
  try {
    const user = process.env.USER ?? process.env.LOGNAME ?? "";
    if (user) {
      const r = spawnSync("loginctl", ["show-user", user], { encoding: "utf8" });
      if (r.status === 0 && !r.stdout.includes("Linger=yes")) {
        console.log(`\nTip: keep tunnel alive when not logged in → loginctl enable-linger ${user}\n`);
      }
    }
  } catch { /* non-fatal */ }
}

function removeSystemd(name: string): void {
  try { execQuiet(`systemctl --user stop portivox-${name}.service`); } catch { /* already stopped */ }
  try { execQuiet(`systemctl --user disable portivox-${name}.service`); } catch { /* already disabled */ }
  const unitPath = systemdUnitPath(name);
  if (existsSync(unitPath)) rmSync(unitPath);
  try { execQuiet("systemctl --user daemon-reload"); } catch { /* non-fatal */ }
}

function startSystemd(name: string): void   { execOrFail(`systemctl --user start portivox-${name}.service`,   `start ${name}`); }
function stopSystemd(name: string): void    { execOrFail(`systemctl --user stop portivox-${name}.service`,    `stop ${name}`); }
function restartSystemd(name: string): void { execOrFail(`systemctl --user restart portivox-${name}.service`, `restart ${name}`); }

function statusTextSystemd(name: string): string {
  const r = spawnSync("systemctl", ["--user", "status", `portivox-${name}.service`], { encoding: "utf8" });
  return r.stdout || r.stderr || "(no output)";
}

function isRunningSystemd(name: string): boolean {
  const r = spawnSync("systemctl", ["--user", "is-active", `portivox-${name}.service`], { encoding: "utf8" });
  return r.stdout.trim() === "active";
}

// ── Platform: launchd (macOS) ─────────────────────────────────────────────────

function launchdLabel(name: string): string { return `com.portivox.${name}`; }

function launchdPlistPath(name: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${launchdLabel(name)}.plist`);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildLaunchdPlist(entry: ServiceEntry): string {
  const openArgs  = buildOpenArgs(entry);
  const allArgs   = [entry.nodeBin, ...openArgs];
  const argXml    = allArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const logFile   = join(LOGS_DIR, `${entry.name}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel(entry.name)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

function installLaunchd(entry: ServiceEntry): void {
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  const plistPath = launchdPlistPath(entry.name);
  writeFileSync(plistPath, buildLaunchdPlist(entry));
  execOrFail(`launchctl load -w "${plistPath}"`, "launchctl load");
}

function removeLaunchd(name: string): void {
  const plistPath = launchdPlistPath(name);
  if (existsSync(plistPath)) {
    try { execQuiet(`launchctl unload "${plistPath}"`); } catch { /* already unloaded */ }
    rmSync(plistPath);
  }
}

function startLaunchd(name: string): void   { execOrFail(`launchctl start ${launchdLabel(name)}`, `start ${name}`); }
function stopLaunchd(name: string): void    { execOrFail(`launchctl stop ${launchdLabel(name)}`,  `stop ${name}`); }
function restartLaunchd(name: string): void {
  try { execQuiet(`launchctl stop ${launchdLabel(name)}`); } catch { /* already stopped */ }
  execOrFail(`launchctl start ${launchdLabel(name)}`, `restart ${name}`);
}

function statusTextLaunchd(name: string): string {
  const r = spawnSync("launchctl", ["list", launchdLabel(name)], { encoding: "utf8" });
  return r.stdout || r.stderr || "(not loaded)";
}

function isRunningLaunchd(name: string): boolean {
  const r = spawnSync("launchctl", ["list", launchdLabel(name)], { encoding: "utf8" });
  // launchd returns JSON-like output; a non-zero PID means it's running
  return r.status === 0 && /^\{/.test(r.stdout.trim()) && !/"PID"\s*=\s*0\s*;/.test(r.stdout);
}

// ── Platform: Task Scheduler (Windows) ───────────────────────────────────────

function taskName(name: string): string       { return `Portivox_${name}`; }
function cmdWrapperPath(name: string): string { return join(SERVICES_DIR, `${name}.cmd`); }

/**
 * Build a .cmd wrapper with an auto-restart loop.
 * If portivox exits (crash / network drop), it waits 5 s and restarts.
 * `schtasks /End` terminates the cmd.exe process tree, stopping the loop.
 */
function buildCmdWrapper(entry: ServiceEntry): string {
  const openArgs = buildOpenArgs(entry);
  // Quote tokens that contain spaces or cmd-special chars.
  // Windows file paths cannot contain `"`, so no inner-quote escaping is needed.
  const quotedArgs = openArgs.map((a) =>
    /[\s&^|<>]/.test(a) ? `"${a}"` : a,
  );
  const logFile = join(LOGS_DIR, `${entry.name}.log`);
  return [
    "@echo off",
    ":restart",
    `"${entry.nodeBin}" ${quotedArgs.join(" ")} >> "${logFile}" 2>&1`,
    "timeout /t 5 /nobreak > nul",
    "goto restart",
    "",
  ].join("\r\n");
}

/**
 * Run schtasks.exe via spawnSync (bypasses cmd.exe entirely).
 * This avoids the quote-escaping minefield when cmd.exe parses a command
 * string that itself contains quoted sub-strings (e.g. the /TR value).
 */
function spawnSchtasks(schArgs: string[]): { ok: boolean; detail: string } {
  const r = spawnSync("schtasks", schArgs, { encoding: "utf8", windowsHide: true });
  const detail = (r.stderr?.trim() || r.stdout?.trim() || "").replace(/\r\n/g, " ");
  return { ok: r.status === 0, detail };
}

function spawnSchtasksOrFail(schArgs: string[], label: string): void {
  const { ok, detail } = spawnSchtasks(schArgs);
  if (!ok) throw new Error(`${label}: ${detail || "unknown error"}`);
}

function installWindows(entry: ServiceEntry): void {
  mkdirSync(SERVICES_DIR, { recursive: true });
  const cmdPath = cmdWrapperPath(entry.name);
  writeFileSync(cmdPath, buildCmdWrapper(entry), { encoding: "utf8" });
  const tn = taskName(entry.name);

  // Pass /TR as a plain string in the argument array — spawnSync sends it
  // directly to schtasks.exe without any shell processing, so paths with
  // spaces reach Task Scheduler verbatim.
  //
  // /TR value: `cmd /c "<cmdPath>"`
  // When the task fires, cmd.exe's /c rule preserves the outer quotes when
  // the path contains whitespace (condition-1 of cmd's quote algorithm),
  // so the .cmd file is invoked correctly even with spaces in the username.
  spawnSchtasksOrFail(
    ["/Create", "/TN", tn, "/TR", `cmd /c "${cmdPath}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"],
    "schtasks create",
  );

  // Start immediately — non-fatal (will run at next logon if this fails)
  spawnSchtasks(["/Run", "/TN", tn]);
}

function removeWindows(name: string): void {
  const tn = taskName(name);
  spawnSchtasks(["/End",    "/TN", tn]);        // ignore result — may already be stopped
  spawnSchtasks(["/Delete", "/TN", tn, "/F"]);  // ignore result — may already be gone
  const cmdPath = cmdWrapperPath(name);
  if (existsSync(cmdPath)) rmSync(cmdPath);
}

function startWindows(name: string): void {
  spawnSchtasksOrFail(["/Run", "/TN", taskName(name)], `start ${name}`);
}

function stopWindows(name: string): void {
  spawnSchtasksOrFail(["/End", "/TN", taskName(name)], `stop ${name}`);
}

function restartWindows(name: string): void {
  spawnSchtasks(["/End", "/TN", taskName(name)]); // ignore result
  spawnSchtasksOrFail(["/Run", "/TN", taskName(name)], `restart ${name}`);
}

function statusTextWindows(name: string): string {
  const r = spawnSync("schtasks", ["/Query", "/TN", taskName(name), "/FO", "LIST", "/V"], {
    encoding: "utf8", windowsHide: true,
  });
  return r.stdout || r.stderr || "(not found)";
}

function isRunningWindows(name: string): boolean {
  const r = spawnSync("schtasks", ["/Query", "/TN", taskName(name), "/FO", "CSV"], {
    encoding: "utf8", windowsHide: true,
  });
  return r.status === 0 && r.stdout.includes('"Running"');
}

// ── Platform dispatch helpers ─────────────────────────────────────────────────

function removePlatformService(entry: ServiceEntry): void {
  if (entry.platform === "linux")  removeSystemd(entry.name);
  else if (entry.platform === "darwin") removeLaunchd(entry.name);
  else removeWindows(entry.name);
}

function requireEntry(name: string): ServiceEntry {
  if (!name) {
    console.error("Service name is required.");
    process.exit(1);
  }
  const reg = readRegistry();
  const entry = reg[name];
  if (!entry) {
    console.error(
      `No service named "${name}". Run 'portivox config service list' to see installed services.`,
    );
    process.exit(1);
  }
  return entry;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check and print the status of service infrastructure on this machine.
 * Run by `portivox config service install` as a pre-flight check.
 */
export function installInfrastructure(): void {
  const p = process.platform;
  if (p !== "linux" && p !== "darwin" && p !== "win32") {
    console.error(
      `Persistent services are not supported on "${p}". ` +
      `Supported: Linux (systemd), macOS (launchd), Windows (Task Scheduler).`,
    );
    process.exit(1);
  }

  mkdirSync(PORTIVOX_DIR, { recursive: true });
  mkdirSync(SERVICES_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  if (p === "linux") {
    const r = spawnSync("systemctl", ["--version"], { encoding: "utf8" });
    if (r.status !== 0 && !r.stdout) {
      console.error(
        "systemd is not available on this system (Alpine/OpenRC distributions are not supported).",
      );
      process.exit(1);
    }
    const unitDir = join(homedir(), ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    console.log("✔ portivox service infrastructure ready (linux / systemd user)");
    console.log(`  Unit dir     : ${unitDir}`);
  } else if (p === "darwin") {
    const agentsDir = join(homedir(), "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    console.log("✔ portivox service infrastructure ready (macOS / launchd)");
    console.log(`  LaunchAgents : ${agentsDir}`);
  } else {
    console.log("✔ portivox service infrastructure ready (windows / Task Scheduler)");
    console.log(`  Services dir : ${SERVICES_DIR}`);
  }

  console.log(`  Logs dir     : ${LOGS_DIR}`);
  console.log("\nRun 'portivox open <port> --persistent' to create a persistent tunnel.");
}

/** Remove ALL persistent services and their OS registrations. */
export function uninstallAllServices(): void {
  const reg = readRegistry();
  const names = Object.keys(reg);
  if (names.length === 0) {
    console.log("No persistent services installed.");
    return;
  }
  console.log(`Removing ${names.length} persistent service(s)…`);
  for (const name of names) {
    try {
      removePlatformService(reg[name]);
      console.log(`  ✔ removed ${name}`);
    } catch (err) {
      console.warn(`  ⚠ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  writeRegistry({});
  console.log("\nDone. All portivox services removed.");
}

/** Register + start an OS service for one tunnel. Called by `portivox open <port> --persistent`. */
export function installService(opts: InstallOpts): void {
  validateServiceName(opts.name);

  const reg = readRegistry();
  if (reg[opts.name]) {
    console.error(
      `Service "${opts.name}" already exists. ` +
      `Remove it first: portivox config service remove ${opts.name}`,
    );
    process.exit(1);
  }

  const platform = getPlatform();
  const { nodeBin, scriptPath } = resolvePortivoxPaths();
  mkdirSync(LOGS_DIR, { recursive: true });

  const entry: ServiceEntry = {
    name:        opts.name,
    port:        opts.port,
    tunnelType:  opts.tunnelType,
    gatewayUrl:  opts.gatewayUrl,
    subdomain:   opts.subdomain,
    host:        opts.host,
    ipProtection: opts.ipProtection,
    nodeBin,
    scriptPath,
    installedAt: new Date().toISOString(),
    platform,
  };

  if (platform === "linux")       installSystemd(entry);
  else if (platform === "darwin") installLaunchd(entry);
  else                            installWindows(entry);

  reg[opts.name] = entry;
  writeRegistry(reg);

  const logFile = join(LOGS_DIR, `${opts.name}.log`);
  console.log(`\n✔ Persistent tunnel installed: ${opts.name}`);
  console.log(`  Port         : ${opts.port}  [${opts.tunnelType.toUpperCase()}]`);
  if (opts.subdomain)  console.log(`  Subdomain    : ${opts.subdomain}`);
  if (opts.gatewayUrl) console.log(`  Gateway      : ${opts.gatewayUrl}`);
  console.log(`  Log file     : ${logFile}`);
  console.log("\nManage it:");
  console.log(`  portivox config service status  ${opts.name}`);
  console.log(`  portivox config service logs    ${opts.name}`);
  console.log(`  portivox config service stop    ${opts.name}`);
  console.log(`  portivox config service restart ${opts.name}`);
  console.log(`  portivox config service remove  ${opts.name}`);
}

/** Stop + permanently uninstall one service. */
export function uninstallService(name: string): void {
  const entry = requireEntry(name);
  try { removePlatformService(entry); }
  catch (err) {
    console.warn(`OS unregistration warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  const reg = readRegistry();
  delete reg[name];
  writeRegistry(reg);
  console.log(`✔ Service "${name}" removed.`);
}

export function startService(name: string): void {
  const entry = requireEntry(name);
  if (entry.platform === "linux")       startSystemd(name);
  else if (entry.platform === "darwin") startLaunchd(name);
  else                                  startWindows(name);
  console.log(`✔ Started: ${name}`);
}

export function stopService(name: string): void {
  const entry = requireEntry(name);
  if (entry.platform === "linux")       stopSystemd(name);
  else if (entry.platform === "darwin") stopLaunchd(name);
  else                                  stopWindows(name);
  console.log(`✔ Stopped: ${name}`);
}

export function restartService(name: string): void {
  const entry = requireEntry(name);
  if (entry.platform === "linux")       restartSystemd(name);
  else if (entry.platform === "darwin") restartLaunchd(name);
  else                                  restartWindows(name);
  console.log(`✔ Restarted: ${name}`);
}

/** Print a table of all installed services with live status. */
export function listServices(): void {
  const reg     = readRegistry();
  const entries = Object.values(reg);
  if (entries.length === 0) {
    console.log(
      "No persistent services installed. " +
      "Run 'portivox open <port> --persistent' to create one.",
    );
    return;
  }

  console.log(`\nPersistent services (${entries.length}):\n`);
  const w = { name: 24, port: 7, type: 5, status: 9 };
  console.log(`  ${"NAME".padEnd(w.name)} ${"PORT".padEnd(w.port)} ${"TYPE".padEnd(w.type)} ${"STATUS".padEnd(w.status)} INSTALLED`);
  console.log(`  ${"─".repeat(w.name)} ${"─".repeat(w.port)} ${"─".repeat(w.type)} ${"─".repeat(w.status)} ${"─".repeat(10)}`);

  for (const e of entries) {
    let running = false;
    try {
      if (e.platform === "linux")       running = isRunningSystemd(e.name);
      else if (e.platform === "darwin") running = isRunningLaunchd(e.name);
      else                              running = isRunningWindows(e.name);
    } catch { /* non-fatal — status check may fail if OS tools unavailable */ }

    console.log(
      `  ${e.name.padEnd(w.name)} ${String(e.port).padEnd(w.port)} ${e.tunnelType.padEnd(w.type)} ${(running ? "Running" : "Stopped").padEnd(w.status)} ${e.installedAt.slice(0, 10)}`,
    );
  }
  console.log();
}

/** Print detailed status for one service (or all if name is omitted). */
export function statusService(name?: string): void {
  if (!name) {
    listServices();
    return;
  }
  const entry = requireEntry(name);

  let osOutput: string;
  if (entry.platform === "linux")       osOutput = statusTextSystemd(name);
  else if (entry.platform === "darwin") osOutput = statusTextLaunchd(name);
  else                                  osOutput = statusTextWindows(name);

  console.log(`\nService: ${entry.name}`);
  console.log(`  Type       : ${entry.tunnelType.toUpperCase()}  port ${entry.port}`);
  console.log(`  Platform   : ${entry.platform}`);
  if (entry.subdomain)  console.log(`  Subdomain  : ${entry.subdomain}`);
  if (entry.gatewayUrl) console.log(`  Gateway    : ${entry.gatewayUrl}`);
  console.log(`  Installed  : ${entry.installedAt}`);
  console.log(`  Log file   : ${join(LOGS_DIR, `${entry.name}.log`)}`);
  console.log(`\nOS status:\n${osOutput}`);
}

/** Tail the log file for a service. */
export function logsService(name: string, lines: number): void {
  if (!name) {
    console.error("Usage: portivox config service logs <name> [--lines 50]");
    process.exit(1);
  }
  requireEntry(name); // validates existence

  const logFile = join(LOGS_DIR, `${name}.log`);
  if (!existsSync(logFile)) {
    console.log(`No log file yet for "${name}".`);
    console.log(`Expected at: ${logFile}`);
    console.log("The service may not have started or produced output yet.");
    return;
  }

  try {
    const content = readFileSync(logFile, "utf8");
    const all  = content.split("\n");
    const tail = all.slice(Math.max(0, all.length - lines));
    console.log(`\n── ${name}.log  (last ${lines} lines) ──\n`);
    process.stdout.write(tail.join("\n") + "\n");
  } catch (err) {
    console.error(`Failed to read log: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
