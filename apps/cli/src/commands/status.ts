// `addroid status` — ローカル AdDroid プロセス + 直近 doctor 結果のスナップショット。
//
// pid file (~/.addroid/run/up.json) と DoctorResult 直近 1 行を読み出し、
// 「いま web/worker は動いているのか」「直近の依存診断結果は何か」を 1 画面で示す。

import { resolveAddroidLanguage, resolveAddroidPaths, readAddroidConfig } from "@addroid/config";
import net from "node:net";
import { formatRss, isProcessAlive, readProcessRssKb, readUpState } from "../lib/processes.js";
import { formatServiceStatus, getAddroidServiceStatus } from "../lib/service.js";
import { findApplyExecutionLogs, findLatestApplyJob, findLatestErrorLog } from "../lib/apply-db.js";
import { extractMetaErrorSummary, formatMetaErrorLine } from "../lib/apply-errors.js";

interface DoctorRow {
  ranAt: Date;
  overall: string;
  checks: unknown;
}

export async function runStatus(args: string[]): Promise<number> {
  const language = resolveAddroidLanguage();
  if (args.includes("--help") || args.includes("-h")) {
    if (language === "en") {
      process.stdout.write(
        [
          "addroid status — check connection and runtime status",
          "",
          "Usage:",
          "  addroid status",
          "",
        ].join("\n")
      );
      return 0;
    }
    process.stdout.write(
      [
        "addroid status — 接続・起動状態を確認",
        "",
        "Usage:",
        "  addroid status",
        "",
      ].join("\n")
    );
    return 0;
  }
  const paths = resolveAddroidPaths();
  const lines: string[] = [];
  lines.push("[addroid status]");
  lines.push("");

  const config = await readAddroidConfig().catch(() => null);
  lines.push(`  config        : ${config ? `${paths.configFile} (loaded)` : `${paths.configFile} (not found — \`addroid init\`)`}`);
  if (config) {
    lines.push(`  workspace     : ${config.workspace.slug} — ${config.workspace.displayName}`);
    lines.push(`  language      : ${config.ui.language}`);
    lines.push(`  database ref  : ${config.database.urlRef}`);
    lines.push(
      `  web bind      : ${config.web?.hostname ?? "127.0.0.1"}:${config.web?.port ?? 3000}`
    );
  }
  lines.push("");

  const service = await getAddroidServiceStatus().catch((err) => ({
    platform: "unsupported" as const,
    installed: false,
    running: false,
    detail: (err as Error).message,
  }));
  lines.push(...formatServiceStatus(service));
  lines.push("");

  const state = await readUpState(paths);
  if (!state) {
    lines.push(`  processes     : ${language === "en" ? "(not running — no pid file)" : "(not running — pid file 無し)"}`);
  } else {
    const parentAlive = isProcessAlive(state.parentPid);
    const webFailed = state.webStatus === "failed";
    const webReachable = parentAlive && !webFailed
      ? await canConnectToWeb(state.webUrl)
      : false;
    const webUnreachable = parentAlive && !webFailed && !webReachable;
    lines.push(`  mode          : ${state.mode}`);
    lines.push(`  started at    : ${state.startedAt}`);
    lines.push(
      `  web URL       : ${state.webUrl}${
        webFailed
          ? "  [web-failed — worker のみ稼働中]"
          : webUnreachable
            ? "  [web-unreachable]"
            : ""
      }`
    );
    lines.push(
      `  parent pid    : ${state.parentPid} ${parentAlive ? "[ ok  ]" : "[stopped]"}`
    );
    const parentRss = parentAlive ? formatRss(await readProcessRssKb(state.parentPid)) : null;
    if (parentRss) lines.push(`  parent RSS    : ${parentRss}`);
    if (state.mode === "shared") {
      const webLabel = webFailed
        ? `worker only (web-failed) ${parentAlive ? "[degraded]" : "[stopped]"}`
        : webUnreachable
          ? `in parent process [web-unreachable]`
          : `in parent process ${parentAlive ? "[ ok  ]" : "[stopped]"}`;
      lines.push(`  web/worker    : ${webLabel}`);
    } else {
      const workerAlive = isProcessAlive(state.workerPid);
      const webLabel = webFailed
        ? `not running (web-failed) ${parentAlive ? "[degraded]" : "[stopped]"}`
        : webUnreachable
          ? `in parent process [web-unreachable]`
          : `in parent process ${parentAlive ? "[ ok  ]" : "[stopped]"}`;
      lines.push(`  web           : ${webLabel}`);
      lines.push(
        `  worker pid    : ${state.workerPid ?? "(none)"} ${
          state.workerPid ? (workerAlive ? "[ ok  ]" : "[stopped]") : "[absent]"
        }`
      );
      const workerRss = workerAlive ? formatRss(await readProcessRssKb(state.workerPid)) : null;
      if (workerRss) lines.push(`  worker RSS    : ${workerRss}`);
    }
  }
  lines.push("");

  const doctor = await readLatestDoctor();
  if (doctor) {
    lines.push(`  last doctor   : ${doctor.ranAt.toISOString()}  overall=${doctor.overall}`);
  } else {
    lines.push(`  last doctor   : ${language === "en" ? "(no record — run `addroid doctor` to create one)" : "(記録なし — `addroid doctor` を実行すると残ります)"}`);
  }
  lines.push("");

  lines.push(...(await formatLastApplyLines(language)));
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return 0;
}

/**
 * regression fix (#3844): apply_job 失敗時に Meta エラー詳細 (code /
 * error_subcode / message) を DB 直読なしで確認できるようにする。最新の
 * apply_job 1 件のサマリと、失敗時は execution_logs から拾った 1 行サマリを表示する。
 * 詳細な JSON 全文は `addroid logs --apply-job <id>` を案内する。
 */
async function formatLastApplyLines(language: "en" | "ja"): Promise<string[]> {
  const job = await findLatestApplyJob();
  if (!job) {
    return [
      `  last apply    : ${
        language === "en"
          ? "(no record — apply_jobs table empty or DB unreachable)"
          : "(記録なし — apply_jobs 未生成 or DB 未接続)"
      }`,
    ];
  }
  const lines: string[] = [];
  const when = (job.finishedAt ?? job.startedAt ?? job.enqueuedAt).toISOString();
  lines.push(`  last apply    : ${job.id}  state=${job.state}  (${when})`);
  if (job.state === "failed") {
    const logs = await findApplyExecutionLogs(job.id);
    const errorLog = logs ? findLatestErrorLog(logs) : null;
    const summary = errorLog ? extractMetaErrorSummary(errorLog.payload) : null;
    if (summary) {
      lines.push(`                  ${formatMetaErrorLine(summary)}`);
    } else if (job.errorMessage) {
      lines.push(`                  ${job.errorMessage}`);
    }
    lines.push(
      `                  ${
        language === "en"
          ? `(full detail: \`addroid logs --apply-job ${job.id}\`)`
          : `(全文: \`addroid logs --apply-job ${job.id}\`)`
      }`
    );
  }
  return lines;
}

async function canConnectToWeb(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) return false;
  const host = url.hostname;
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readLatestDoctor(): Promise<DoctorRow | null> {
  if (!process.env.DATABASE_URL) return null;
  let mod: typeof import("@addroid/db");
  try {
    mod = await import("@addroid/db");
  } catch {
    return null;
  }
  const { prisma } = mod;
  try {
    const row = await prisma.doctorResult.findFirst({ orderBy: { ranAt: "desc" } });
    return row
      ? { ranAt: row.ranAt, overall: row.overall, checks: row.checks }
      : null;
  } catch {
    return null;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
