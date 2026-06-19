import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureAddroidPaths, resolveAddroidPaths, type AddroidPaths } from "@addroid/config";
import { resolveRepoRoot } from "./paths.js";
import type { UpMode } from "./processes.js";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  opts?: { encoding?: BufferEncoding }
) => Promise<{ stdout: string; stderr: string }>;

export const ADDROID_SERVICE_LABEL = "ai.addroid.service";
export const ADDROID_SYSTEMD_UNIT = "addroid.service";

export type AddroidServicePlatform = "launchd" | "systemd" | "unsupported";

export interface AddroidServiceStatus {
  platform: AddroidServicePlatform;
  installed: boolean;
  running: boolean;
  detail?: string;
  unitPath?: string;
  pid?: number;
  mode?: UpMode;
}

export interface AddroidServiceOptions {
  mode?: UpMode | null;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface LaunchdPrintState {
  state?: string;
  pid?: number;
  lastExitCode?: number;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function plistEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

async function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : e.message,
    };
  }
}

function parseLaunchdPrint(raw: string): LaunchdPrintState {
  const stateMatch = raw.match(/^\s*state\s*=\s*(.+?)\s*$/im);
  const pidMatch = raw.match(/^\s*pid\s*=\s*(\d+)\s*$/im);
  const exitMatch = raw.match(/^\s*last exit code\s*=\s*(-?\d+)\s*$/im);
  return {
    ...(stateMatch?.[1] ? { state: stateMatch[1].trim().toLowerCase() } : {}),
    ...(pidMatch?.[1] ? { pid: Number(pidMatch[1]) } : {}),
    ...(exitMatch?.[1] ? { lastExitCode: Number(exitMatch[1]) } : {}),
  };
}

async function waitForServiceState(timeoutMs = 5_000): Promise<AddroidServiceStatus> {
  const deadline = Date.now() + timeoutMs;
  let last = await getAddroidServiceStatus();
  while (Date.now() < deadline) {
    if (last.running) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await getAddroidServiceStatus();
  }
  return last;
}

function resolveServicePlatform(): AddroidServicePlatform {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return "unsupported";
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  const candidates = ["/proc/sys/kernel/osrelease", "/proc/version"];
  for (const file of candidates) {
    try {
      const raw = fsSync.readFileSync(file, "utf8").toLowerCase();
      if (raw.includes("microsoft") || raw.includes("wsl")) return true;
    } catch {
      // keep checking
    }
  }
  return false;
}

function resolveLaunchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${ADDROID_SERVICE_LABEL}.plist`);
}

function resolveSystemdUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", ADDROID_SYSTEMD_UNIT);
}

function resolveGuiDomain(): string {
  if (typeof process.getuid === "function") return `gui/${process.getuid()}`;
  return "gui/501";
}

async function systemdUserAvailable(): Promise<boolean> {
  const result = await runCommand("systemctl", ["--user", "show-environment"]);
  return result.code === 0;
}

export async function resolveCliProgramArguments(
  repoRoot: string,
  mode: UpMode = "shared"
): Promise<string[]> {
  const withMode = (args: string[]): string[] =>
    mode === "separate-worker" ? [...args, "--separate-worker"] : args;
  const distEntry = path.join(repoRoot, "apps/cli/dist/index.mjs");
  try {
    await fs.access(distEntry);
    return withMode([process.execPath, distEntry, "up"]);
  } catch {
    // source checkout without dist; fall through to tsx source entry
  }

  const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");
  const srcEntry = path.join(repoRoot, "apps/cli/src/index.ts");
  try {
    await fs.access(tsxBin);
    await fs.access(srcEntry);
    return withMode([process.execPath, tsxBin, srcEntry, "up"]);
  } catch {
    // last-resort current entrypoint
  }

  const currentEntry = process.argv[1];
  if (!currentEntry) {
    throw new Error("現在の addroid entrypoint を解決できません。先に CLI を build してください。");
  }
  return withMode([process.execPath, ...process.execArgv, path.resolve(currentEntry), "up"]);
}

export function resolveServiceUpMode(
  opts: AddroidServiceOptions = {},
  env: NodeJS.ProcessEnv = process.env
): UpMode {
  const raw = opts.mode ?? env.ADDROID_SERVICE_UP_MODE ?? "shared";
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "shared") return "shared";
  if (normalized === "separate-worker" || normalized === "separate_worker" || normalized === "separate") {
    return "separate-worker";
  }
  throw new Error("ADDROID_SERVICE_UP_MODE must be 'shared' or 'separate-worker'.");
}

async function readInstalledServiceMode(paths: AddroidPaths): Promise<UpMode | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.serviceEnvFile, "utf8");
  } catch {
    return undefined;
  }
  const match = raw.match(/^export\s+ADDROID_SERVICE_UP_MODE=(['"]?)([^'"\n]+)\1\s*$/m);
  if (!match?.[2]) return undefined;
  try {
    return resolveServiceUpMode({ mode: match[2] as UpMode });
  } catch {
    return undefined;
  }
}

async function writeServiceRunner(
  paths: AddroidPaths,
  repoRoot: string,
  opts: AddroidServiceOptions = {}
): Promise<void> {
  const mode = resolveServiceUpMode(opts);
  const programArgs = await resolveCliProgramArguments(repoRoot, mode);
  const nodeBin = programArgs[0] ?? process.execPath;
  const pidFile = paths.pidFile;
  const envLines = [
    "# Generated by AdDroid. Do not edit while the service is installed.",
    `export ADDROID_HOME=${shellSingleQuote(paths.home)}`,
    `export HOME=${shellSingleQuote(os.homedir())}`,
    `export PATH=${shellSingleQuote(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}`,
    "export ADDROID_SERVICE=1",
    `export ADDROID_SERVICE_UP_MODE=${shellSingleQuote(mode)}`,
    "",
  ].join("\n");
  await fs.writeFile(paths.serviceEnvFile, envLines, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(paths.serviceEnvFile, 0o600).catch(() => undefined);

  const script = [
    "#!/bin/sh",
    "set -eu",
    `if [ -f ${shellSingleQuote(paths.serviceEnvFile)} ]; then`,
    `  . ${shellSingleQuote(paths.serviceEnvFile)}`,
    "fi",
    `cd ${shellSingleQuote(repoRoot)}`,
    `existing_pid=$(${shellSingleQuote(nodeBin)} -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(s&&s.parentPid) process.stdout.write(String(s.parentPid));}catch{}" ${shellSingleQuote(pidFile)})`,
    `if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then`,
    `  echo "[addroid service] addroid up is already running (pid $existing_pid); waiting instead of starting another copy."`,
    `  while kill -0 "$existing_pid" 2>/dev/null; do sleep 30; done`,
    `fi`,
    `exec ${programArgs.map(shellSingleQuote).join(" ")}`,
    "",
  ].join("\n");
  await fs.writeFile(paths.serviceWrapperFile, script, { encoding: "utf8", mode: 0o700 });
  await fs.chmod(paths.serviceWrapperFile, 0o700).catch(() => undefined);
}

function buildLaunchAgentPlist(paths: AddroidPaths, repoRoot: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${ADDROID_SERVICE_LABEL}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>2</integer>
    <key>ProgramArguments</key>
    <array>
      <string>${plistEscape(paths.serviceWrapperFile)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${plistEscape(repoRoot)}</string>
    <key>StandardOutPath</key>
    <string>${plistEscape(paths.serviceLogFile)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(paths.serviceErrLogFile)}</string>
  </dict>
</plist>
`;
}

function buildSystemdUnit(paths: AddroidPaths, repoRoot: string): string {
  return [
    "[Unit]",
    "Description=AdDroid local operator service",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(repoRoot)}`,
    `ExecStart=${systemdQuote(paths.serviceWrapperFile)}`,
    "Restart=always",
    "RestartSec=2",
    `StandardOutput=append:${paths.serviceLogFile}`,
    `StandardError=append:${paths.serviceErrLogFile}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export async function installAddroidService(
  opts: AddroidServiceOptions = {}
): Promise<AddroidServiceStatus> {
  const platform = resolveServicePlatform();
  const paths = await ensureAddroidPaths();
  const repoRoot = resolveRepoRoot();
  await writeServiceRunner(paths, repoRoot, opts);

  if (platform === "launchd") {
    const plistPath = resolveLaunchAgentPath();
    await fs.mkdir(path.dirname(plistPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(plistPath, buildLaunchAgentPlist(paths, repoRoot), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(plistPath, 0o600).catch(() => undefined);
    const domain = resolveGuiDomain();
    await runCommand("launchctl", ["bootout", domain, plistPath]);
    const boot = await runCommand("launchctl", ["bootstrap", domain, plistPath]);
    if (boot.code !== 0) {
      throw new Error((boot.stderr || boot.stdout || "launchctl bootstrap failed").trim());
    }
    return await waitForServiceState();
  }

  if (platform === "systemd") {
    if (!(await systemdUserAvailable())) {
      const wsl = isWsl() ? " WSL2 では systemd を有効化してから再実行してください。" : "";
      throw new Error(`systemd user service が利用できません。${wsl}`.trim());
    }
    const unitPath = resolveSystemdUnitPath();
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(unitPath, buildSystemdUnit(paths, repoRoot), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(unitPath, 0o600).catch(() => undefined);
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    const enable = await runCommand("systemctl", ["--user", "enable", "--now", ADDROID_SYSTEMD_UNIT]);
    if (enable.code !== 0) {
      throw new Error((enable.stderr || enable.stdout || "systemctl enable failed").trim());
    }
    return await waitForServiceState();
  }

  return {
    platform,
    installed: false,
    running: false,
    detail: `unsupported platform: ${process.platform}`,
  };
}

export async function startAddroidService(
  opts: AddroidServiceOptions = {}
): Promise<AddroidServiceStatus> {
  const status = await getAddroidServiceStatus();
  if (!status.installed) return await installAddroidService(opts);
  if (status.platform === "launchd") {
    const plistPath = resolveLaunchAgentPath();
    const domain = resolveGuiDomain();
    const boot = await runCommand("launchctl", ["bootstrap", domain, plistPath]);
    if (boot.code !== 0 && !(boot.stderr || boot.stdout).toLowerCase().includes("already")) {
      throw new Error((boot.stderr || boot.stdout || "launchctl bootstrap failed").trim());
    }
    await runCommand("launchctl", ["kickstart", "-k", `${domain}/${ADDROID_SERVICE_LABEL}`]);
  } else if (status.platform === "systemd") {
    const start = await runCommand("systemctl", ["--user", "restart", ADDROID_SYSTEMD_UNIT]);
    if (start.code !== 0) {
      throw new Error((start.stderr || start.stdout || "systemctl restart failed").trim());
    }
  }
  return await waitForServiceState();
}

export async function stopAddroidService(): Promise<AddroidServiceStatus> {
  const status = await getAddroidServiceStatus();
  if (!status.installed) return status;
  if (status.platform === "launchd") {
    await runCommand("launchctl", ["bootout", resolveGuiDomain(), resolveLaunchAgentPath()]);
  } else if (status.platform === "systemd") {
    await runCommand("systemctl", ["--user", "stop", ADDROID_SYSTEMD_UNIT]);
  }
  return await getAddroidServiceStatus();
}

export async function uninstallAddroidService(): Promise<AddroidServiceStatus> {
  const status = await stopAddroidService();
  if (status.platform === "launchd") {
    await fs.rm(resolveLaunchAgentPath(), { force: true });
  } else if (status.platform === "systemd") {
    await runCommand("systemctl", ["--user", "disable", ADDROID_SYSTEMD_UNIT]);
    await fs.rm(resolveSystemdUnitPath(), { force: true });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  }
  return await getAddroidServiceStatus();
}

export async function getAddroidServiceStatus(): Promise<AddroidServiceStatus> {
  const platform = resolveServicePlatform();
  if (platform === "launchd") {
    const unitPath = resolveLaunchAgentPath();
    const installed = await fs.access(unitPath).then(() => true, () => false);
    const paths = resolveAddroidPaths();
    const mode = installed ? await readInstalledServiceMode(paths) : undefined;
    const result = await runCommand("launchctl", ["print", `${resolveGuiDomain()}/${ADDROID_SERVICE_LABEL}`]);
    const printed = parseLaunchdPrint(result.stdout);
    const running = result.code === 0 && printed.state === "running";
    const details: string[] = [];
    if (result.code !== 0 && installed) details.push((result.stderr || result.stdout).trim());
    if (result.code === 0 && installed && !running && printed.state) details.push(`launchd state=${printed.state}`);
    if (result.code === 0 && installed && !running && printed.lastExitCode !== undefined) {
      details.push(`last exit code=${printed.lastExitCode}`);
    }
    return {
      platform,
      installed,
      running,
      unitPath,
      ...(mode ? { mode } : {}),
      ...(running && printed.pid ? { pid: printed.pid } : {}),
      ...(details.length > 0 ? { detail: details.join("; ") } : {}),
    };
  }
  if (platform === "systemd") {
    const unitPath = resolveSystemdUnitPath();
    const installed = await fs.access(unitPath).then(() => true, () => false);
    const paths = resolveAddroidPaths();
    const mode = installed ? await readInstalledServiceMode(paths) : undefined;
    if (!(await systemdUserAvailable())) {
      return {
        platform,
        installed,
        running: false,
        unitPath,
        ...(mode ? { mode } : {}),
        detail: isWsl()
          ? "systemd user service が利用できません。WSL2 の systemd 設定を確認してください。"
          : "systemd user service が利用できません。",
      };
    }
    const active = await runCommand("systemctl", ["--user", "is-active", ADDROID_SYSTEMD_UNIT]);
    const show = await runCommand("systemctl", ["--user", "show", ADDROID_SYSTEMD_UNIT, "--property=MainPID", "--value"]);
    const pid = Number.parseInt(show.stdout.trim(), 10);
    return {
      platform,
      installed,
      running: active.stdout.trim() === "active",
      unitPath,
      ...(mode ? { mode } : {}),
      ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
      ...(active.code !== 0 && installed ? { detail: active.stdout.trim() || active.stderr.trim() } : {}),
    };
  }
  return {
    platform,
    installed: false,
    running: false,
    detail: `unsupported platform: ${process.platform}`,
  };
}

export function formatServiceStatus(status: AddroidServiceStatus): string[] {
  return [
    `  service       : ${status.installed ? "installed" : "not installed"} (${status.platform})`,
    `  running       : ${status.running ? "yes" : "no"}`,
    ...(status.mode ? [`  up mode       : ${status.mode}`] : []),
    ...(status.pid ? [`  pid           : ${status.pid}`] : []),
    ...(status.unitPath ? [`  unit          : ${status.unitPath}`] : []),
    ...(status.detail ? [`  detail        : ${status.detail}`] : []),
  ];
}
