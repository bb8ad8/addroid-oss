// AdDroid OSS — CLI shared check helpers.
//
// `addroid doctor` と `addroid up` の precheck から共有される。
// 各 check は副作用なし (read-only) で、actionable な hint を必ず返す。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import {
  getCryptoBoundary,
  inspectSecretsFile,
  parseDatabaseUrl,
  resolveAddroidPaths,
  validateEncryptionKey,
  type AddroidPaths,
} from "@addroid/config";

export type CheckState = "ok" | "warn" | "error" | "skipped";

export interface CheckResult {
  name: string;
  state: CheckState;
  message: string;
  hint?: string;
}

export type DoctorOverall = "ok" | "warn" | "error";

export function summarizeOverall(checks: CheckResult[]): DoctorOverall {
  if (checks.some((c) => c.state === "error")) return "error";
  if (checks.some((c) => c.state === "warn")) return "warn";
  return "ok";
}

interface VersionRun {
  found: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runVersion(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): VersionRun {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 5_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: false, stdout: "", stderr: "", status: null };
    }
    return {
      found: true,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
      status: r.status,
    };
  } catch {
    return { found: false, stdout: "", stderr: "", status: null };
  }
}

/**
 * 動作プラットフォームを判定する。
 *
 * AdDroid OSS は macOS / Linux / WSL2 (Windows Subsystem for Linux 2) を公式に
 * サポートする。Windows native (`process.platform === "win32"`) は POSIX 前提
 * (`0600` permission, `pg_dump`/`pg_restore` の dynamic-link、`@addroid/cli` 内の
 * 一部 shell 起動) が成立しないため非対応とし、WSL2 を推奨する。
 *
 * WSL2 は `process.platform === "linux"` を返すため、`/proc/version` に
 * "microsoft" / "wsl" を含むかを副作用なしで確認し、検出できれば message に追記する。
 */
export function checkPlatform(
  platform: NodeJS.Platform = process.platform
): CheckResult {
  if (platform === "darwin") {
    return { name: "platform", state: "ok", message: "macOS (darwin) supported" };
  }
  if (platform === "linux") {
    let detail = "Linux supported";
    try {
      const proc = readFileSync("/proc/version", "utf8").toLowerCase();
      if (proc.includes("microsoft") || proc.includes("wsl")) {
        detail = "Linux (WSL2) supported";
      }
    } catch {
      // /proc/version が無いコンテナ等では Linux 表示のまま (WSL でもない)。
    }
    return { name: "platform", state: "ok", message: detail };
  }
  if (platform === "win32") {
    return {
      name: "platform",
      state: "error",
      message: "Windows native (win32) は非対応です。",
      hint:
        "WSL2 (Windows Subsystem for Linux 2) 内の Ubuntu 等で AdDroid を実行してください。" +
        "詳細は docs/SETUP.md §1 と docs/TROUBLESHOOTING.md §0 を参照。",
    };
  }
  return {
    name: "platform",
    state: "warn",
    message: `${platform} は動作未検証です。`,
    hint:
      "AdDroid OSS は macOS / Linux / WSL2 のみ動作検証済みです。" +
      "上記以外で利用する場合は自己責任で動作確認してください。",
  };
}

export function checkUv(): CheckResult {
  const r = runVersion("uv", ["--version"]);
  if (!r.found) {
    return {
      name: "uv",
      state: "warn",
      message: "uv コマンドが見つかりません (標準の初期設定では任意)。",
      hint: "Meta Ads CLI backend の検証が必要な場合だけ https://docs.astral.sh/uv/getting-started/installation/ を参照してインストールしてください。",
    };
  }
  return {
    name: "uv",
    state: "ok",
    message: r.stdout || r.stderr || "uv detected",
  };
}

export function checkPython312(): CheckResult {
  const r = runVersion("python3", ["--version"]);
  if (!r.found) {
    const uvPython = findUvPython312();
    if (uvPython) {
      return {
        name: "python3.12",
        state: "ok",
        message: `uv-managed Python 3.12+ available (${uvPython})`,
      };
    }
    return {
      name: "python3.12",
      state: "error",
      message: "python3 コマンドが見つかりません。",
      hint: "標準の Meta 連携は Graph API 経路のため Python は不要です。任意の Meta Ads CLI 検証を行う場合だけ Python 3.12+ を用意してください (例: uv python install 3.13)。",
    };
  }
  const out = r.stdout || r.stderr;
  const match = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return {
      name: "python3.12",
      state: "error",
      message: `python3 のバージョンを判別できませんでした: "${out}"`,
      hint: "python3 --version の出力形式が想定外。Python 3.12 以上をインストールし直してください (例: uv python install 3.13)。",
    };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 12)) {
    const uvPython = findUvPython312();
    if (uvPython) {
      return {
        name: "python3.12",
        state: "ok",
        message: `python3 is ${major}.${minor}; uv-managed Python 3.12+ available (${uvPython})`,
      };
    }
    return {
      name: "python3.12",
      state: "error",
      message: `Python ${major}.${minor} を検出 (3.12+ 必須)。`,
      hint: "任意の Meta Ads CLI 検証を行う場合だけ Python 3.12+ が必要です。uv 等で 3.12 以上を有効化してください (例: uv python install 3.13)。",
    };
  }
  return { name: "python3.12", state: "ok", message: out };
}

function findUvPython312(): string | null {
  const r = runVersion("uv", ["python", "find", ">=3.12"]);
  if (!r.found || r.status !== 0) return null;
  const out = (r.stdout || r.stderr).trim();
  return out || "uv python 3.12";
}

export function checkMetaAdsCli(env: NodeJS.ProcessEnv = process.env): CheckResult {
  if (env.ADDROID_META_ADS_CLI_MOCK === "1") {
    return {
      name: "meta-ads-cli",
      state: "ok",
      message: "ADDROID_META_ADS_CLI_MOCK=1 (mock 経由)",
    };
  }
  const configured = env.ADDROID_META_CLI_BIN?.trim();
  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [
    ...(configured
      ? [
          { cmd: configured, args: ["ads", "--help"], label: "ADDROID_META_CLI_BIN meta ads" },
          { cmd: configured, args: ["--version"], label: "ADDROID_META_CLI_BIN" },
        ]
      : []),
    { cmd: "meta", args: ["ads", "--help"], label: "meta ads" },
    { cmd: "meta", args: ["--version"], label: "meta" },
    { cmd: "meta-ads", args: ["--version"], label: "meta-ads" },
    { cmd: "meta_ads", args: ["--version"], label: "meta_ads" },
    { cmd: "metaads", args: ["--version"], label: "metaads" },
  ];
  for (const c of candidates) {
    const r = runVersion(c.cmd, c.args, env);
    if (r.found && r.status === 0) {
      return {
        name: "meta-ads-cli",
        state: "ok",
        message: `${c.label}: ${r.stdout || r.stderr || "detected"}`,
      };
    }
  }
  return {
    name: "meta-ads-cli",
    state: "warn",
    message: "Meta Ads CLI が見つかりません (標準の Meta 操作は Graph API 経路を使うため任意)。",
    hint: "CLI backend の検証が必要な場合だけ `uv tool install meta-ads --python 3.13` 後に ADDROID_META_CLI_BIN を設定してください。通常の初期設定では不要です。",
  };
}

export function checkGithubCli(): CheckResult {
  const r = runVersion("gh", ["--version"]);
  if (!r.found) {
    return {
      name: "github-cli",
      state: "error",
      message: "GitHub CLI (`gh`) が見つかりません。",
      hint:
        "`addroid init --install-deps` を実行してください。手動の場合は macOS: `brew install gh`、Linux: `sudo apt-get install gh` または GitHub CLI 公式手順を参照してください。",
    };
  }
  if (r.status !== 0) {
    return {
      name: "github-cli",
      state: "error",
      message: `GitHub CLI の実行に失敗しました: ${r.stderr || r.stdout || `exit ${r.status}`}`,
      hint: "GitHub CLI (`gh`) を再インストールしてください。",
    };
  }
  return {
    name: "github-cli",
    state: "ok",
    message: r.stdout || r.stderr || "gh detected",
  };
}

export function checkCodexCli(): CheckResult {
  const r = runVersion("codex", ["--version"]);
  if (!r.found) {
    return {
      name: "codex-cli",
      state: "error",
      message: "Codex CLI (`codex`) が見つかりません。",
      hint:
        "Codex app-server を使う場合は `npm install -g @openai/codex` を実行してください。",
    };
  }
  if (r.status !== 0) {
    return {
      name: "codex-cli",
      state: "error",
      message: `Codex CLI の実行に失敗しました: ${r.stderr || r.stdout || `exit ${r.status}`}`,
      hint: "Codex CLI (`codex`) を再インストールしてください。",
    };
  }
  return {
    name: "codex-cli",
    state: "ok",
    message: r.stdout || r.stderr || "codex detected",
  };
}

export function checkPostgresVersion(): CheckResult {
  const server = runVersion("psql", [
    "-d",
    "postgres",
    "-Atc",
    "select current_setting('server_version_num'), version()",
  ]);
  if (server.found && server.status === 0) {
    const out = server.stdout || server.stderr;
    const parts = out.split("|");
    const rawNum = parts[0] ?? "";
    const full = parts[1] ?? "";
    const num = Number(rawNum);
    const major = Math.floor(num / 10000);
    if (Number.isFinite(major) && major > 0) {
      if (major < 16) {
        return {
          name: "postgres-16",
          state: "error",
          message: `接続中の PostgreSQL server は ${major} (16+ 必須)。`,
          hint: "PostgreSQL 16 以上にアップグレードしてください。",
        };
      }
      return {
        name: "postgres-16",
        state: "ok",
        message: full ? full.split(" on ")[0] ?? `PostgreSQL server ${major}` : `PostgreSQL server ${major}`,
      };
    }
  }

  const r = runVersion("psql", ["--version"]);
  if (!r.found) {
    return {
      name: "postgres-16",
      state: "warn",
      message: "psql が見つかりません (PostgreSQL クライアントなしでも動作可)。",
      hint: "DB 接続が後続の prisma-connect で確認できれば問題ありません。",
    };
  }
  const out = r.stdout || r.stderr;
  const match = out.match(/psql.*?(\d+)\.(\d+)/);
  if (!match) {
    return {
      name: "postgres-16",
      state: "warn",
      message: `psql のバージョンを判別できませんでした: "${out}"`,
    };
  }
  const major = Number(match[1]);
  if (major < 16) {
    return {
      name: "postgres-16",
      state: "error",
      message: `psql client ${major} を検出。PostgreSQL server 16+ への接続確認はまだできていません。`,
      hint: "PostgreSQL 16 以上を起動してください。macOS では `addroid init --install-deps` が Homebrew 経由でセットアップできます。",
    };
  }
  return { name: "postgres-16", state: "ok", message: out };
}

export function checkDatabaseUrl(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const v = parseDatabaseUrl(env);
  if (!v.ok) {
    return { name: "DATABASE_URL", state: "error", message: v.reason, hint: v.hint };
  }
  const note = v.isLocal ? "localhost" : `${v.hostname}:${v.port}`;
  return { name: "DATABASE_URL", state: "ok", message: `set (postgres @ ${note}/${v.database})` };
}

export function checkEncryptionKey(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const v = validateEncryptionKey(env);
  if (!v.ok) {
    return { name: "ENCRYPTION_KEY", state: "error", message: v.reason, hint: v.hint };
  }
  return {
    name: "ENCRYPTION_KEY",
    state: "ok",
    message: `set (${v.bytes} bytes, encoding=${v.encoding})`,
  };
}

export async function checkConfigFile(
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<CheckResult> {
  try {
    await fs.access(paths.configFile);
    return {
      name: "config",
      state: "ok",
      message: `${paths.configFile} 存在`,
    };
  } catch {
    return {
      name: "config",
      state: "warn",
      message: `${paths.configFile} が見つかりません。`,
      hint: "`addroid init` を実行して config.yaml を生成してください。",
    };
  }
}

export async function checkSecretsLocal(
  paths: AddroidPaths = resolveAddroidPaths()
): Promise<CheckResult> {
  // Use the shared inspector so doctor and the secrets module agree on permission semantics.
  void paths; // path is resolved internally; parameter kept for back-compat with callers.
  const status = await inspectSecretsFile();
  if (!status.exists) {
    return {
      name: "secrets.local.yaml",
      state: "ok",
      message: "未生成 (任意。git 追跡対象外なので存在しなくても OK)。",
    };
  }
  if (status.worldReadable) {
    return {
      name: "secrets.local.yaml",
      state: "warn",
      message: `${status.path} のパーミッションが緩い (${status.mode!.toString(8)})。`,
      hint: `chmod 600 ${status.path} を実行してください。`,
    };
  }
  return {
    name: "secrets.local.yaml",
    state: "ok",
    message: `${status.path} 存在 (mode ${status.mode!.toString(8)})`,
  };
}

/**
 * Prisma 経由で DB に SELECT 1 を投げ、PostgreSQL の major version を確認する。
 * @prisma/client が未生成だったり接続失敗の場合は actionable な error / warn を返す。
 */
export async function checkPrismaConnect(
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult> {
  if (!env.DATABASE_URL) {
    return {
      name: "prisma-connect",
      state: "skipped",
      message: "DATABASE_URL 未設定のためスキップ。",
    };
  }
  let prisma: { $queryRawUnsafe: (q: string) => Promise<unknown>; $disconnect: () => Promise<void> };
  try {
    const mod = await import("@addroid/db");
    prisma = mod.prisma as unknown as typeof prisma;
  } catch (err) {
    return {
      name: "prisma-connect",
      state: "error",
      message: `Prisma client を読み込めません: ${(err as Error).message}`,
      hint: "`npm install` の後 `npm run db:generate` を実行してください。",
    };
  }
  try {
    const rows = (await prisma.$queryRawUnsafe(
      "select current_setting('server_version_num') as v, version() as full"
    )) as Array<{ v: string; full: string }>;
    const num = Number(rows?.[0]?.v ?? 0);
    const major = Math.floor(num / 10000);
    if (!Number.isFinite(major) || major === 0) {
      return {
        name: "prisma-connect",
        state: "warn",
        message: "PostgreSQL のバージョンを判別できませんでした。",
      };
    }
    if (major < 16) {
      return {
        name: "prisma-connect",
        state: "error",
        message: `接続中の PostgreSQL は ${major} (16+ 必須)。`,
        hint: "PostgreSQL 16 以上のインスタンスに接続してください。",
      };
    }
    return {
      name: "prisma-connect",
      state: "ok",
      message: `connected · ${rows?.[0]?.full?.split(" on ")[0] ?? "PostgreSQL " + major}`,
    };
  } catch (err) {
    return {
      name: "prisma-connect",
      state: "error",
      message: `DB 接続に失敗: ${(err as Error).message}`,
      hint: "`pg_isready -h localhost -p 5432` で起動を確認し、`npm run db:push` を実行してください。",
    };
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Discord 連携のヘルスチェック (read-only, ネットワーク非依存)。
 * Discord は完全に任意なので、未接続は `skipped` (error にしない)。
 * 接続済みの場合は ENCRYPTION_KEY で bot トークンを復号でき、metadata に
 * guild/channel が揃っているかを確認する。
 */
export async function checkDiscord(
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult> {
  if (!env.DATABASE_URL) {
    return {
      name: "discord",
      state: "skipped",
      message: "DATABASE_URL 未設定のためスキップ。",
    };
  }
  let prisma: {
    oAuthToken: {
      findFirst: (args: unknown) => Promise<{
        accessTokenCiphertext: string;
        metadata: unknown;
      } | null>;
    };
    $disconnect: () => Promise<void>;
  };
  try {
    const mod = await import("@addroid/db");
    prisma = mod.prisma as unknown as typeof prisma;
  } catch {
    return {
      name: "discord",
      state: "skipped",
      message: "Prisma client 未生成のためスキップ。",
    };
  }
  try {
    const row = await prisma.oAuthToken.findFirst({
      where: { provider: "discord" },
      orderBy: { connectedAt: "desc" },
      select: { accessTokenCiphertext: true, metadata: true },
    });
    if (!row) {
      return {
        name: "discord",
        state: "skipped",
        message: "Discord 未接続 (任意)。",
        hint: "`addroid connect discord --bot-token <token> --guild <id> --channel <id>` で設定できます。",
      };
    }
    try {
      getCryptoBoundary(env).decrypt(row.accessTokenCiphertext);
    } catch (err) {
      return {
        name: "discord",
        state: "error",
        message: `Discord bot トークンを復号できません: ${(err as Error).message}`,
        hint: "ENCRYPTION_KEY を確認し、`addroid connect discord` を再実行してください。",
      };
    }
    const meta = (row.metadata ?? {}) as { guildId?: unknown; channelId?: unknown };
    const guildId = typeof meta.guildId === "string" ? meta.guildId : "";
    const channelId = typeof meta.channelId === "string" ? meta.channelId : "";
    if (!guildId || !channelId) {
      return {
        name: "discord",
        state: "warn",
        message: "Discord 接続済みですが guild/channel が未設定です。",
        hint: "`addroid connect discord --guild <id> --channel <id>` を再実行してください。",
      };
    }
    return {
      name: "discord",
      state: "ok",
      message: `connected · guild=${guildId} channel=${channelId}`,
    };
  } catch (err) {
    return {
      name: "discord",
      state: "warn",
      message: `Discord 接続状態を確認できませんでした: ${(err as Error).message}`,
    };
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  }
}
