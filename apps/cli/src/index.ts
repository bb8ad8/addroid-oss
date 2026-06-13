// AdDroid OSS — CLI entry.
//
// `addroid <command>` のディスパッチ。各コマンドの実装は ./commands/* に分離している。
// すべての outbound interaction は AdDroid 自身が起点となり、CLI からは public な inbound
// ポートを開かない (Web UI は 127.0.0.1 のみ)。
//
// 起動直後にリポジトリ root の `.env` / `.env.local` を読み込み、DATABASE_URL 等が
// shell に export されていなくても addroid CLI から見えるようにする。Prisma CLI と
// Next.js は独自の dotenv 統合を持っているが、`addroid` 経路は素の Node プロセス
// なので明示ロードが必要 (詳細は packages/config/src/env-files.ts のコメント参照)。

import { loadEnvFilesFromRepoRoot, resolveAddroidLanguage } from "@addroid/config";
import { resolveRepoRoot } from "./lib/paths.js";

try {
  loadEnvFilesFromRepoRoot(resolveRepoRoot());
} catch {
  /* repo root を解決できない実行形態では env auto-load を skip。後段で明示エラー */
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      return 0;
    case "init":
      return (await import("./commands/init.js")).runInit(rest);
    case "update":
      return (await import("./commands/update.js")).runUpdate(rest);
    case "start":
      return (await import("./commands/service-public.js")).runStartCommand(rest);
    case "stop":
      return (await import("./commands/service-public.js")).runStopCommand(rest);
    case "open":
      return (await import("./commands/public.js")).runOpenCommand(rest);
    case "status":
      return (await import("./commands/status.js")).runStatus(rest);
    case "connect":
      return (await import("./commands/public.js")).runConnectCommand(rest);
    case "account":
      return (await import("./commands/public.js")).runAccountCommand(rest);
    case "report":
      return (await import("./commands/public.js")).runReportCommand(rest);
    case "submit":
      return (await import("./commands/public.js")).runSubmitCommand(rest);
    case "schedule":
      return (await import("./commands/public.js")).runScheduleCommand(rest);
    case "chat":
      return (await import("./commands/chat.js")).runChatCommand(rest);
    case "backup":
      return (await import("./commands/backup.js")).runBackupCommand(rest);

    // Detailed / CI-oriented commands. They intentionally stay out of the top help.
    case "doctor":
      return (await import("./commands/doctor.js")).runDoctor(rest);
    case "logs":
      return (await import("./commands/logs.js")).runLogs(rest);
    case "service":
      return (await import("./commands/service.js")).runServiceCommand(rest);
    case "restore":
      return (await import("./commands/backup.js")).runRestoreCommand(rest);
    case "validate":
      return (await import("./commands/validate.js")).runValidate(rest);
    case "up":
      return (await import("./commands/up.js")).runUp(rest);
    case "down":
      return (await import("./commands/down.js")).runDown(rest);
    case "plan":
      return (await import("./commands/plan.js")).runPlan(rest);
    case "activate":
      return (await import("./commands/activate.js")).runActivateCommand(rest);
    case "cron":
      return (await import("./commands/cron.js")).runCronCommand(rest);
    case "auth":
      return (await import("./commands/auth.js")).runAuthCommand(rest);
    case "accounts":
      return (await import("./commands/accounts.js")).runAccountsCommand(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      printHelp();
      return 2;
  }
}

function printHelp() {
  const language = resolveAddroidLanguage();
  if (language === "en") {
    process.stdout.write(
      [
        "addroid — AdDroid OSS local CLI",
        "",
        "Usage:",
        "  addroid <command> [...args]",
        "",
        "Commands:",
        "  chat      Interactive natural-language agent chat",
        "  init      First-run setup and missing configuration guide",
        "  update    Update an existing install (regenerate client, apply DB schema)",
        "  start     Start or repair resident services",
        "  stop      Stop resident services",
        "  open      Open the Web UI or print its URL",
        "  status    Check connection and runtime status",
        "  connect   Connect or reconnect Meta / GitHub / AI / Slack",
        "  account   Review and select the Meta ad account",
        "  report    Run reports and improvement checks now",
        "  submit    Check submissions and preview planned changes",
        "  schedule  Review and update scheduled tasks",
        "  backup    Back up the database",
        "  version   CLI version",
        "  help      Show this help",
        "",
        "Detailed commands for CI / troubleshooting: doctor, logs, validate, plan, activate, cron, auth, accounts, restore, service, up, down.",
        "All operations are localhost-bound and outbound-only.",
        "",
      ].join("\n")
    );
    return;
  }
  process.stdout.write(
    [
      "addroid — AdDroid OSS local CLI",
      "",
      "Usage:",
      "  addroid <command> [...args]",
      "",
      "Commands:",
      "  chat      自然文で操作する対話型 agent chat",
      "  init      初期設定・不足設定の案内",
      "  update    既存環境の更新 (クライアント再生成・DB スキーマ反映)",
      "  start     常駐サービスを起動・修復",
      "  stop      常駐サービスを停止",
      "  open      Web UI を開く / URL を表示",
      "  status    接続・起動状態を確認",
      "  connect   Meta / GitHub / AI / Slack を接続・再接続",
      "  account   利用する広告アカウントを確認・選択",
      "  report    レポート・改善チェックを今すぐ実行",
      "  submit    入稿前チェックと変更予定の確認",
      "  schedule  自動実行の確認・変更",
      "  backup    データベースをバックアップ",
      "  version   CLI バージョン",
      "  help      このヘルプ",
      "",
      "Detailed commands for CI / troubleshooting: doctor, logs, validate, plan, activate, cron, auth, accounts, restore, service, up, down.",
      "All operations are localhost-bound and outbound-only.",
      "",
    ].join("\n")
  );
}

function printVersion() {
  process.stdout.write(`addroid ${process.env.npm_package_version ?? "0.0.0"}\n`);
}

const argv = process.argv.slice(2);
main(argv).then(
  (code) => {
    if (code !== 0) process.exit(code);
    // 0 のときは明示的に process.exit を呼ばない (up が永続 listen するため)。
    // 各コマンドが終わるべきタイミングは Promise の resolve 時で OK。
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
