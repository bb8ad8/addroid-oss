// AdDroid OSS — cron preset definitions.
//
// boot/registration ロジックから分離して保持することで、UI とテストが pg-boss を
// 起動せずにこの定義だけを参照できるようにする。
//
// the current implementation の重要な制約 (再掲):
//   - github_poll は default で enabled。merged PR 検知は本契約で動作する想定。
//   - daily_report / today_report / improvement_pr / auto_creative_generation は
//     「定義のみ存在し未起動」を維持する。
//   - daily_report は前日分を毎朝、today_report は当日分を毎時取得する。
//   - 自然言語カスタム cron と承認済み automation rule は CRON_PRESETS ではなく
//     delayed job として 1 回分ずつ予約する。

export const APPLY_JOB_NAME = "execute_apply" as const;
export const SCHEDULED_TASK_JOB_NAME = "scheduled_task_run" as const;
export const AUTOMATION_RULE_JOB_NAME = "automation_rule_run" as const;

export const CRON_PRESETS = [
  {
    name: "github_poll",
    cron: "*/2 * * * *",
    description: "ops repository の Pull Request を ETag-aware にポーリングする",
    enabledByDefault: true,
  },
  {
    name: "daily_report",
    cron: "0 9 * * *",
    description: "Meta Graph API 経由で前日の日次レポートを毎朝取得する",
    enabledByDefault: false,
  },
  {
    name: "today_report",
    cron: "0 * * * *",
    description: "Meta Graph API 経由で当日の日次レポートを毎時取得する",
    enabledByDefault: false,
  },
  {
    name: "budget_guard",
    cron: "30 9 * * *",
    description: "予算超過、月間ペース、急増、成果なしを毎朝確認する",
    enabledByDefault: false,
  },
  {
    name: "budget_rebalance",
    cron: "0 10 * * 2",
    description:
      "CPA 効率に基づく adset 予算再配分案を毎週火曜10時に計算し、GitOps PR として提案する",
    enabledByDefault: false,
  },
  {
    name: "experiment_evaluate",
    cron: "0 8 * * *",
    description: "登録済みA/Bテストを毎朝評価し、勝敗確定時に敗者PAUSE提案PRを作成する",
    enabledByDefault: false,
  },
  {
    name: "improvement_pr",
    cron: "0 10 * * 1",
    description:
      "前日までの直近 7 日の実績から予算、停止候補、追加入稿などの改善提案を毎週月曜10時に生成し、必要に応じてPR化",
    enabledByDefault: false,
  },
  {
    name: "auto_creative_generation",
    cron: "0 9 * * *",
    description:
      "直近実績と既存クリエイティブをもとに自動クリエイティブ生成を毎朝9時に実行する",
    enabledByDefault: false,
  },
  {
    // Regression fix: performance_snapshots の保持期間
    // (raw=90d / aggregate=1y) を毎日 1 回掃く housekeeping 用 preset。
    // AI ワークフローではないため、運用の安全側として既定で有効化する。
    name: "retention_sweep",
    cron: "15 3 * * *",
    description:
      "performance_snapshots の raw / 粒度 (adset/ad) を 90 日、集計 (account/campaign) を 1 年で掃くリテンション処理",
    enabledByDefault: true,
  },
] as const;

export type CronPreset = (typeof CRON_PRESETS)[number];
export type CronPresetName = CronPreset["name"];
