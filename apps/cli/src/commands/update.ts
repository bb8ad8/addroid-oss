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
  skipInstall: boolean;
}

function parseArgs(args: string[]): UpdateOptions {
  return {
    force: args.includes("--force"),
    skipChecks: args.includes("--skip-checks"),
    skipInstall: args.includes("--skip-install"),
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

  // 2) 依存関係を更新 (`git pull` で増減した npm 依存を node_modules に反映)。
  //
  // これを `addroid update` に含めることで、更新フローは `git pull` → `addroid update` の
  // 2 手で完結する。新しいコードが新しい依存を必要とする場合に備え、CLI 再ビルドや Prisma
  // 生成より前に実行する。`--skip-install` で省略できる (依存が変わっていないと分かっている時)。
  if (!opts.skipInstall) {
    out.push("1/5 依存関係を更新しています (npm install)…");
    process.stdout.write(out.join("\n") + "\n");
    out.length = 0;
    const install = run("npm", ["install"], repoRoot, env, 600_000);
    if (install.status !== 0) {
      process.stderr.write(
        `依存関係の更新 (npm install) に失敗しました:\n${tail(install.stderr || install.stdout)}\n`
      );
      return 1;
    }
  } else {
    out.push("1/5 依存関係の更新をスキップしました (--skip-install)。");
    process.stdout.write(out.join("\n") + "\n");
    out.length = 0;
  }

  // 3) CLI バンドルを再ビルド (グローバル `addroid` を最新コードに追従させる)。
  //
  // グローバル `addroid` は事前ビルド済みの dist バンドルを実行するため、`git pull` で
  // 新しいソースを取り込んでも再ビルドするまで反映されない (新コマンド・新挙動が見えない)。
  // ここで再ビルドしておくことで、update を 1 回走らせれば以降は `addroid <command>` が
  // 常に最新になる。ビルドは repo checkout (dev 依存あり) 前提のため、失敗しても致命とは
  // 扱わず警告に留め、スキーマ反映を優先する (純粋な global-only install への配慮)。
  process.stdout.write("2/5 CLI を再ビルドしています…\n");
  const buildCli = run("npm", ["run", "build", "--workspace", "apps/cli"], repoRoot, env, 180_000);
  if (buildCli.status !== 0) {
    process.stdout.write(
      `  ⚠ CLI の再ビルドに失敗しました (スキーマ反映は続行します):\n${tail(buildCli.stderr || buildCli.stdout, 4)}\n`
    );
  }

  // 4) Prisma client 再生成 (新しいカラム/モデルに型を追従させる)。
  process.stdout.write("3/5 Prisma クライアントを再生成しています…\n");
  const generate = run("npm", ["run", "db:generate"], repoRoot, env, 120_000);
  if (generate.status !== 0) {
    process.stderr.write(
      `Prisma クライアントの再生成に失敗しました:\n${tail(generate.stderr || generate.stdout)}\n`
    );
    return 1;
  }

  // 5) スキーマ反映 (additive を既定、破壊的変更は --force が無ければ停止)。
  process.stdout.write("4/5 データベーススキーマを反映しています…\n");
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

  // 6) 反映後の健全性チェック (drift が解消したかを含む)。
  process.stdout.write("5/5 健全性をチェックしています…\n\n");
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
