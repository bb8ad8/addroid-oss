// `addroid update` — 既存ユーザー向けのワンコマンド更新。
//
// 想定シナリオ: 非エンジニアの self-host ユーザーが新しいバージョンを `git pull`
// (または zip 再展開) で取り込んだあと、これ 1 つで「依存の再生成 + DB スキーマの反映 +
// 健全性チェック」まで済ませられるようにする。新しいゴールはすべて nullable カラム /
// default 付き / optional フィールドで追加されるため、`prisma db push` は既存データを
// 保持したまま追従できる (additive)。破壊的変更が検出された場合のみ `--force` を要求する。
//
// 安全方針 (00-COMMON の原則に準拠):
//   - 破壊的 (data-loss) な push はデフォルトで実行しない。検出されたら停止し、
//     `addroid backup` → `addroid update --force` を案内する (fail-closed)。
//   - サービスの再起動はこのコマンドからは行わず、最後に案内する (誤操作で本番配信に
//     影響しないように)。
//   - すべて localhost / 既存 DATABASE_URL に対する操作で、outbound-only 契約を侵さない。

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolveAddroidPaths } from "@addroid/config";
import { resolveRepoRoot } from "../lib/paths.js";
import {
  checkConfigFile,
  checkDatabaseUrl,
  checkPrismaConnect,
  checkSchemaDrift,
  type CheckResult,
} from "../lib/checks.js";

interface UpdateOptions {
  force: boolean;
  skipChecks: boolean;
}

function parseArgs(args: string[]): UpdateOptions {
  return {
    force: args.includes("--force"),
    skipChecks: args.includes("--skip-checks"),
  };
}

function run(
  cmd: string,
  cmdArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): SpawnSyncReturns<string> {
  return spawnSync(cmd, cmdArgs, { cwd, env, encoding: "utf8", timeout: timeoutMs });
}

function tail(text: string | null | undefined, lines = 8): string {
  return (text ?? "")
    .trim()
    .split("\n")
    .slice(-lines)
    .join("\n");
}

export async function runUpdate(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const out: string[] = [];
  out.push("[addroid update] 既存環境を最新のコードに合わせて更新します。");
  out.push("");

  // 1) 前提チェック (DATABASE_URL / config)。fail-closed。
  const env = process.env;
  if (!env.DATABASE_URL) {
    process.stderr.write(
      "DATABASE_URL が未設定です。まず `addroid init` を実行してください。\n"
    );
    return 1;
  }
  const paths = resolveAddroidPaths();
  const configCheck = await checkConfigFile(paths);
  if (configCheck.state === "error") {
    process.stderr.write(
      `設定ファイルが見つかりません (${configCheck.message})。まず \`addroid init\` を実行してください。\n`
    );
    return 1;
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot();
  } catch (err) {
    process.stderr.write(`リポジトリルートを特定できません: ${(err as Error).message}\n`);
    return 1;
  }

  // 2) Prisma client 再生成 (新しいカラム/モデルに型を追従させる)。
  out.push("1/3 Prisma クライアントを再生成しています…");
  process.stdout.write(out.join("\n") + "\n");
  out.length = 0;
  const generate = run("npm", ["run", "db:generate"], repoRoot, env, 120_000);
  if (generate.status !== 0) {
    process.stderr.write(
      `Prisma クライアントの再生成に失敗しました:\n${tail(generate.stderr || generate.stdout)}\n`
    );
    return 1;
  }

  // 3) スキーマ反映 (additive を既定、破壊的変更は --force が無ければ停止)。
  process.stdout.write("2/3 データベーススキーマを反映しています…\n");
  const pushArgs = ["run", "db:push"];
  if (opts.force) pushArgs.push("--", "--accept-data-loss");
  const push = run("npm", pushArgs, repoRoot, env, 180_000);
  if (push.status !== 0) {
    const combined = `${push.stdout ?? ""}\n${push.stderr ?? ""}`;
    const looksDestructive = /data loss|accept-data-loss|will be dropped|cannot be executed/i.test(
      combined
    );
    if (looksDestructive && !opts.force) {
      process.stderr.write(
        [
          "",
          "⚠ このバージョンには既存データに影響しうるスキーマ変更が含まれます。",
          "安全のため自動では適用しませんでした。次の手順で進めてください:",
          "",
          "  1) addroid backup           # 念のためバックアップを取得",
          "  2) addroid update --force   # 変更を適用 (data-loss を許可)",
          "",
          tail(combined),
          "",
        ].join("\n")
      );
      return 1;
    }
    process.stderr.write(`スキーマ反映に失敗しました:\n${tail(combined)}\n`);
    return 1;
  }

  // 4) 反映後の健全性チェック (drift が解消したかを含む)。
  process.stdout.write("3/3 健全性をチェックしています…\n\n");
  if (!opts.skipChecks) {
    const checks: CheckResult[] = [];
    checks.push(checkDatabaseUrl());
    checks.push(await checkPrismaConnect());
    checks.push(await checkSchemaDrift());
    for (const c of checks) {
      const tag =
        c.state === "ok" ? "[ ok  ]" : c.state === "warn" ? "[warn ]" : c.state === "error" ? "[error]" : "[skip ]";
      process.stdout.write(`  ${tag}  ${c.name}  ${c.message}\n`);
      if (c.hint && c.state !== "ok") process.stdout.write(`           ↳ ${c.hint}\n`);
    }
    process.stdout.write("\n");
    if (checks.some((c) => c.state === "error")) {
      process.stderr.write(
        "更新は完了しましたが、未解決の問題があります。`addroid doctor` で詳細を確認してください。\n"
      );
      return 1;
    }
  }

  process.stdout.write(
    [
      "✓ 更新が完了しました。",
      "",
      "サービスを再起動して反映してください:",
      "  addroid start      # 常駐サービスを再起動",
      "  (フォアグラウンドで動かしている場合は一度停止して addroid up を再実行)",
      "",
    ].join("\n")
  );
  return 0;
}
