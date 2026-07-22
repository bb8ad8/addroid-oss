// apply_jobs / execution_logs (kind=apply) への読み取り専用アクセス。
//
// `@addroid/db` は apps/cli の runtime dependency に入れていない (npm 配布物を
// 軽量に保つため — `../commands/status.ts` の `readLatestDoctor` と同じ理由)。
// そのため本モジュールも dynamic import + try/catch で「DB 未接続 / Prisma
// 未生成の環境では機能を黙って無効化する」既存パターンに合わせる。

export interface ApplyJobRow {
  id: string;
  state: string;
  enqueuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  result: unknown;
  pullRequestId: string;
}

export interface ExecutionLogRow {
  id: string;
  level: string;
  message: string;
  payload: unknown;
  createdAt: Date;
}

/** 最新の apply_job 1 件 (state 問わず、enqueue 順で最新)。DB 不通なら null。 */
export async function findLatestApplyJob(): Promise<ApplyJobRow | null> {
  if (!process.env.DATABASE_URL) return null;
  let mod: typeof import("@addroid/db");
  try {
    mod = await import("@addroid/db");
  } catch {
    return null;
  }
  const { prisma } = mod;
  try {
    const row = await prisma.applyJob.findFirst({ orderBy: { enqueuedAt: "desc" } });
    return row ?? null;
  } catch {
    return null;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

/** apply_job id で execution_logs (kind=apply) を古い順に返す。DB 不通なら null。 */
export async function findApplyExecutionLogs(applyJobId: string): Promise<ExecutionLogRow[] | null> {
  if (!process.env.DATABASE_URL) return null;
  let mod: typeof import("@addroid/db");
  try {
    mod = await import("@addroid/db");
  } catch {
    return null;
  }
  const { prisma } = mod;
  try {
    const rows = await prisma.executionLog.findMany({
      where: { kind: "apply", refType: "apply_job", refId: applyJobId },
      orderBy: { createdAt: "asc" },
    });
    return rows;
  } catch {
    return null;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

/**
 * 与えられた execution_logs 行の中から、Meta エラー詳細を含む最新の
 * warn/error 行を 1 つ返す (無ければ null)。`addroid status` の 1 行サマリ用。
 */
export function findLatestErrorLog(rows: ExecutionLogRow[]): ExecutionLogRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row && (row.level === "warn" || row.level === "error")) return row;
  }
  return null;
}
