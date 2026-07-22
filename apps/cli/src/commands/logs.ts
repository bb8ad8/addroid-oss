// `addroid logs [target] [--lines N]` — `addroid up` が書き出したログを末尾から表示する。

import fs from "node:fs/promises";
import { resolveAddroidPaths } from "@addroid/config";
import { findApplyExecutionLogs } from "../lib/apply-db.js";
import { extractMetaErrorSummary, formatMetaErrorLine, maskSecretsDeep } from "../lib/apply-errors.js";

const DEFAULT_LINES = 200;

export async function runLogs(args: string[]): Promise<number> {
  const paths = resolveAddroidPaths();
  const { target, lines, applyJobId } = parseArgs(args);
  if (target === "__help__") {
    printUsage();
    return 0;
  }

  if (applyJobId) {
    return runApplyJobLogs(applyJobId);
  }

  const sources: Array<{
    label: string;
    file: string;
    missingMessage?: string;
  }> = [];
  if (target === "all" || target === "debug" || target === "up") {
    sources.push({ label: "up (shared mode)", file: paths.upLogFile });
  }
  if (target === "all" || target === "debug" || target === "web") {
    sources.push({
      label: "web",
      file: paths.webLogFile,
      missingMessage:
        "web.log は `addroid up --separate-worker` モードでのみ生成されます。通常の `addroid up` は up.log にまとまります。",
    });
  }
  if (target === "all" || target === "debug" || target === "worker") {
    sources.push({
      label: "worker",
      file: paths.workerLogFile,
      missingMessage:
        "worker.log は `addroid up --separate-worker` モードでのみ生成されます。通常の `addroid up` は up.log にまとまります。",
    });
  }
  if (target === "debug" || target === "service") {
    sources.push({ label: "service", file: paths.serviceLogFile });
  }
  if (target === "debug" || target === "service-err") {
    sources.push({ label: "service stderr", file: paths.serviceErrLogFile });
  }

  let printed = 0;
  for (const src of sources) {
    const tail = await readTail(src.file, lines);
    process.stdout.write(`==> ${src.label}: ${src.file} (last ${lines} lines) <==\n`);
    if (tail === null) {
      process.stdout.write(
        `  (${src.missingMessage ?? "ログファイル未生成 — まだ `addroid up` が走っていない可能性"})\n`
      );
    } else if (tail.length === 0) {
      process.stdout.write("  (空)\n");
    } else {
      process.stdout.write(tail);
      if (!tail.endsWith("\n")) process.stdout.write("\n");
    }
    process.stdout.write("\n");
    printed += 1;
  }
  return printed > 0 ? 0 : 1;
}

interface ParsedArgs {
  target:
    | "web"
    | "worker"
    | "up"
    | "all"
    | "service"
    | "service-err"
    | "debug"
    | "__help__";
  lines: number;
  /** #3844: `--apply-job <id>` 指定時は execution_logs (kind=apply) を表示する。 */
  applyJobId: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
  let target: ParsedArgs["target"] = "all";
  let lines = DEFAULT_LINES;
  let applyJobId: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      target = "__help__";
      continue;
    }
    if (a === "--lines" || a === "-n") {
      const v = args[i + 1];
      i += 1;
      const n = Number.parseInt(v ?? "", 10);
      if (Number.isFinite(n) && n > 0) lines = n;
      continue;
    }
    if (a === "--apply-job") {
      const v = args[i + 1];
      i += 1;
      if (v && !v.startsWith("-")) applyJobId = v;
      continue;
    }
    if (
      a === "web" ||
      a === "worker" ||
      a === "up" ||
      a === "all" ||
      a === "debug" ||
      a === "service" ||
      a === "service-err"
    ) {
      target = a;
      continue;
    }
  }
  return { target, lines, applyJobId };
}

/**
 * #3844 (G6): `addroid logs --apply-job <id>` — DB 直読 (psql) なしで
 * execution_logs (kind=apply, refType=apply_job) の該当行を整形表示する。
 * Meta エラー詳細 (code / error_subcode / message) を先頭に要約し、続けて
 * 生 payload を pretty-print する。秘密値 (token/secret/DATABASE_URL 等) は
 * `maskSecretsDeep` で必ずマスクする。
 */
async function runApplyJobLogs(applyJobId: string): Promise<number> {
  const rows = await findApplyExecutionLogs(applyJobId);
  process.stdout.write(`==> apply job ${applyJobId}: execution_logs (kind=apply) <==\n`);
  if (rows === null) {
    process.stdout.write(
      "  (DATABASE_URL 未設定、または DB に接続できません — `addroid doctor` で prisma-connect を確認してください)\n"
    );
    return 1;
  }
  if (rows.length === 0) {
    process.stdout.write("  (該当する execution_logs 行が見つかりません — apply_job id を確認してください)\n");
    return 1;
  }
  for (const row of rows) {
    process.stdout.write(`\n[${row.createdAt.toISOString()}] level=${row.level}\n`);
    process.stdout.write(`  ${row.message}\n`);
    const summary = extractMetaErrorSummary(row.payload);
    if (summary) {
      process.stdout.write(`  meta error: ${formatMetaErrorLine(summary)}\n`);
    }
    const masked = maskSecretsDeep(row.payload);
    if (masked !== null && masked !== undefined) {
      const pretty = JSON.stringify(masked, null, 2)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      process.stdout.write(`${pretty}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: addroid logs [up|web|worker|all|service|service-err|debug] [--lines N]",
      "       addroid logs --apply-job <id>",
      "",
      "  up        shared モード (`addroid up` 既定) の up.log のみ表示",
      "  web       apps/web のログのみ表示 (`--separate-worker` モードで生成)",
      "  worker    apps/worker のログのみ表示 (`--separate-worker` モードで生成)",
      "  all       3 つすべて表示 (default)",
      "  service   background service の stdout ログを表示",
      "  service-err background service の stderr ログを表示",
      "  debug     up/web/worker/service/service-err をまとめて表示",
      "  --lines N 末尾 N 行を表示 (default 200)",
      "  --apply-job <id>  execution_logs (kind=apply) の該当 apply_job を整形表示",
      "                    (DB 直読なしで Meta エラー code/error_subcode/message に到達)",
      "",
    ].join("\n")
  );
}

async function readTail(file: string, lines: number): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const split = raw.split("\n");
  // 末尾要素が空文字なら除外 (ファイルが \n で終わっている場合)
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  const slice = split.slice(-lines);
  return slice.join("\n");
}
