// `addroid doctor` — 環境診断 (read-only)。
//
// 検証対象 (acceptance):
//   GitHub CLI / PostgreSQL 16+ / DATABASE_URL / config / secrets / ENCRYPTION_KEY
// 結果は stdout に並べると同時に、DB が利用可能であれば doctor_results テーブルに 1 行追記する
// (UI の /setup ページから直近結果を読むため)。
// DB 未到達でも CLI 自体は失敗扱いにしないが、いずれかの check が error なら exit code 1。

import { resolveAddroidPaths } from "@addroid/config";
import {
  checkConfigFile,
  checkDatabaseUrl,
  checkEncryptionKey,
  checkGithubCli,
  checkPlatform,
  checkPostgresVersion,
  checkPrismaConnect,
  checkSchemaDrift,
  checkSecretsLocal,
  summarizeOverall,
  type CheckResult,
} from "../lib/checks.js";

export async function runDoctor(_args: string[]): Promise<number> {
  const paths = resolveAddroidPaths();
  const checks: CheckResult[] = [];
  checks.push(checkPlatform());
  checks.push(checkGithubCli());
  checks.push(checkPostgresVersion());
  checks.push(checkDatabaseUrl());
  checks.push(checkEncryptionKey());
  checks.push(await checkConfigFile(paths));
  checks.push(await checkSecretsLocal(paths));
  checks.push(await checkPrismaConnect());
  checks.push(await checkSchemaDrift());

  const overall = summarizeOverall(checks);
  printChecks(checks, overall);

  // 直近結果を doctor_results に永続化 (DB 到達時のみ)。失敗しても doctor 自体は成立。
  await persistDoctorResult(checks, overall).catch((err) => {
    process.stderr.write(
      `[doctor] 結果を DB に記録できませんでした (UI での直近結果表示に影響します): ${
        (err as Error).message
      }\n`
    );
  });

  return overall === "error" ? 1 : 0;
}

function printChecks(checks: CheckResult[], overall: string) {
  const widthName = Math.max(...checks.map((c) => c.name.length), 8);
  const widthState = 7;
  const lines: string[] = [];
  lines.push("[addroid doctor]");
  lines.push("");
  for (const c of checks) {
    const tag = stateTag(c.state).padEnd(widthState);
    const name = c.name.padEnd(widthName);
    lines.push(`  ${tag}  ${name}  ${c.message}`);
    if (c.hint) lines.push(`  ${" ".repeat(widthState)}  ${" ".repeat(widthName)}  ↳ ${c.hint}`);
  }
  lines.push("");
  lines.push(`overall: ${stateTag(overall as CheckResult["state"])}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function stateTag(state: CheckResult["state"]): string {
  switch (state) {
    case "ok":
      return "[ ok  ]";
    case "warn":
      return "[warn ]";
    case "error":
      return "[error]";
    case "skipped":
      return "[skip ]";
  }
}

async function persistDoctorResult(
  checks: CheckResult[],
  overall: string
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  let mod: typeof import("@addroid/db");
  try {
    mod = await import("@addroid/db");
  } catch {
    return; // prisma client 未生成 — checkPrismaConnect が既に error 報告済み
  }
  const { prisma } = mod;
  try {
    await prisma.doctorResult.create({
      data: {
        overall,
        checks: checks.map((c) => ({
          name: c.name,
          state: c.state,
          message: c.message,
          hint: c.hint ?? null,
        })),
      },
    });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
