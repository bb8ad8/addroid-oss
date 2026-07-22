// AdDroid OSS — pid file 管理 + プロセス生存確認。
//
// `addroid up` がリポジトリルートから web/worker を spawn するときに pid を記録し、
// `addroid down` / `addroid status` から再利用する。pid file 自体は ~/.addroid/run/up.json。

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAddroidPaths, type AddroidPaths } from "@addroid/config";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  opts?: { encoding?: BufferEncoding; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

export type UpMode = "shared" | "separate-worker";

export interface UpState {
  startedAt: string;
  parentPid: number;
  webPid?: number;
  workerPid?: number;
  webUrl: string;
  cwd: string;
  /**
   * "shared": web と worker を CLI と同じプロセスで併走 (the current implementation の既定).
   * "separate-worker": worker のみ別プロセスで spawn (将来の scale-out 経路).
   */
  mode: UpMode;
  /**
   * Web UI の起動状態。"failed" は Next.js prepare/listen が失敗し worker のみで
   * 稼働している degraded mode を示す (GitOps polling / Apply / Cron は継続)。
   */
  webStatus?: "running" | "failed";
}

export async function readUpState(
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<UpState | null> {
  try {
    const raw = await fs.readFile(paths.pidFile, "utf8");
    return JSON.parse(raw) as UpState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeUpState(
  state: UpState,
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<void> {
  await fs.mkdir(path.dirname(paths.pidFile), { recursive: true });
  await fs.writeFile(paths.pidFile, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearUpState(
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<void> {
  try {
    await fs.unlink(paths.pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function isProcessAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // 別ユーザー起動だが存在はしている
    return false;
  }
}

export async function readProcessRssKb(
  pid: number | undefined | null
): Promise<number | null> {
  if (!isProcessAlive(pid)) return null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "rss=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1_000 }
    );
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function formatRss(kb: number | null): string | null {
  if (kb === null) return null;
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * pid に SIGTERM を送る。生存していなければ noop。
 */
export function terminateProcess(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  if (!isProcessAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
