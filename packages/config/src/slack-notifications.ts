// AdDroid OSS — Slack notifications (Block Kit) helpers (the current implementation, optional integration).
//
// 本モジュールは worker / cli から呼ばれる Slack 通知の「Block Kit メッセージ生成」と
// 「outbound 送信 (chat.postMessage)」を担当します。Slack 連携が未設定の場合、
// dispatcher は外部に出ずに `skipped_no_slack` 状態を返すだけで、呼び出し側の
// パイプライン (GitOps polling / Apply / Cron) を degrade させない契約です。
//
// サポートする通知種別 (UI design plan / NotificationKindBadge と一致):
//   - pr.opened
//   - daily_report.completed
//   - daily_report.failed         (Regression fix)
//   - budget_guard.alert
//   - budget_guard.auto_paused
//   - budget_guard.failed         (Regression fix)
//   - improvement_pr.opened
//   - improvement_pr.failed       (Regression fix)
//   - apply.completed
//   - apply.failed
//   - cron.failed                 (Regression fix: 未分類の cron handler crash)
//   - rate_limit.warning
//   - auth.revoked
//
// 不変条件:
//   - 平文トークン (xoxb-* / xapp-* / xoxp-* / signing_secret) を Block Kit に絶対に
//     含めない。すべての文字列は render 直前に {@link sanitizeForSlack} を通す。
//     呼び出し側が既に sanitize 済みでも防御的に再度 walk する (defense in depth)。
//   - Slack Web API への HTTP 呼び出しは fetch (Node 22+ 内蔵) を使い、テストでは
//     {@link SlackFetch} を注入してオフラインで検証する。
//   - Block Kit のテキストはユーザ向け平易な日本語 + Slack mrkdwn (太字 `*..*`、
//     リンク `<url|label>`) を使う。HTML は使わない。
//   - 各 `<button>` action は `url` フィールドのみを持ち、Slack 内のインタラクティブ
//     応答 (action_id) を期待しない。本タスクでは Web UI / GitHub への deep-link が
//     主目的のため、bot 受信側のハンドラを必要としない。
//   - dispatcher は **副作用を持たない** (DB 永続化や監査記録は呼び出し側の責務)。
//     これは notification_dispatches テーブルや audit_logs への書き込み配線が後続
//     タスクで行われる前提の最小スコープを保つため。

import {
  SLACK_API_BASE_URL,
  SlackApiError,
  type SlackFetch,
} from "./slack-auth.js";

// =====================================================================
// 1) 通知種別と入力データ
// =====================================================================

/** UI design plan の NotificationKindBadge と 1:1 で対応。
 *  Regression fix: producer 側の AI / PR / cron handler 失敗を Slack に
 *  通知するため `daily_report.failed`, `budget_guard.failed`,
 *  `improvement_pr.failed`, `cron.failed` を追加 (acceptance:
 *  "Slack notifications are sent for ..., and failures.")。 */
export type SlackNotificationKind =
  | "pr.opened"
  | "daily_report.completed"
  | "daily_report.failed"
  | "budget_guard.alert"
  | "budget_guard.auto_paused"
  | "budget_guard.failed"
  | "improvement_pr.opened"
  | "improvement_pr.failed"
  | "apply.completed"
  | "apply.failed"
  | "cron.failed"
  | "rate_limit.warning"
  | "auth.revoked";

export type ImprovementRiskLabel = "safe" | "requires_approval" | "dangerous";
export type ExecutionModeLabel = "report_only" | "proposal" | "auto_apply";
export type RateLimitState = "approaching" | "throttled" | "backoff";

export interface PrOpenedData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  /** "owner/repo" 形式。Block Kit の context 行で使う。 */
  repoFullName: string;
  workflow?: string;
  adAccountKey?: string;
  riskLabel?: ImprovementRiskLabel;
  /** Web UI 側 `/approvals/<n>` の URL。CTA ボタンに使う。未指定なら省略。 */
  webApprovalsUrl?: string;
}

export interface DailyReportCompletedData {
  reportId: string;
  adAccountKey: string;
  /** ISO yyyy-mm-dd。 */
  metricDate: string;
  spend?: number | null;
  /** Meta ad account currency (JPY, USD, EUR, ...). */
  currency?: string | null;
  impressions?: number | null;
  clicks?: number | null;
  conversions?: number | null;
  /** analyst 出力の上位 3 件等。各文字列は sanitize 対象。 */
  topImprovements?: string[];
  /** Web UI 側 `/reports/<id>` の URL。 */
  reportUrl?: string;
  mode?: ExecutionModeLabel | string;
}

export interface BudgetGuardAlertData {
  adAccountKey: string;
  /** 評価ルール名 (例: "daily_spend_limit")。 */
  rule: string;
  /** 閾値の人間可読表現。 */
  threshold?: string;
  /** 観測値の人間可読表現。 */
  observedValue?: string;
  /** 評価時刻 (ISO)。 */
  evaluationTime: string;
  /** Web UI 側 `/budget-guard` の URL。 */
  budgetUrl?: string;
  mode?: ExecutionModeLabel | string;
}

export interface BudgetGuardAutoPausedData extends BudgetGuardAlertData {
  /** auto_pause された hierarchy ノード (campaign / adset / ad キー)。 */
  pausedTargets: string[];
}

export interface ImprovementPrOpenedData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  repoFullName: string;
  adAccountKey: string;
  riskLabel: ImprovementRiskLabel;
  /** dangerous 分類が 1 件でも含まれる場合に列挙。 */
  dangerousCategories?: string[];
  webApprovalsUrl?: string;
  /** ai_runs.id。Web UI 側 `/ai/runs/<id>` の deep link 用に渡す。 */
  aiRunId?: string;
  mode?: ExecutionModeLabel | string;
}

export interface ApplyCompletedData {
  applyJobId: string;
  prNumber?: number;
  repoFullName?: string;
  adAccountKey: string;
  filesTouched?: number;
  durationMs?: number;
  /** Web UI 側 `/apply/<id>` の URL。 */
  applyUrl?: string;
  metaObjectsAffected?: number;
  /** 1 行サマリ。長文は sanitize + truncate される。 */
  resultSummary?: string;
}

export interface ApplyFailedData {
  applyJobId: string;
  prNumber?: number;
  repoFullName?: string;
  adAccountKey: string;
  errorMessage: string;
  errorCode?: string;
  applyUrl?: string;
}

/**
 * Regression fix: daily_report の AI 失敗を通知するためのデータ。
 * cron handler が `failCronRun` に倒す前に producer 側で 1 件 dispatch する。
 */
export interface DailyReportFailedData {
  adAccountKey: string;
  /** ISO yyyy-mm-dd。集計対象日。 */
  metricDate?: string;
  /** failCronRun に渡す sanitize 済みエラー文字列の短縮版。 */
  errorMessage: string;
  /** 該当 ai_run.id (analyst step 失敗時のみ)。 */
  aiRunId?: string;
  mode?: ExecutionModeLabel | string;
  /** Web UI `/cron/runs` の URL。 */
  runsUrl?: string;
}

/**
 * Regression fix: budget_guard の AI 失敗を通知するためのデータ。
 */
export interface BudgetGuardFailedData {
  adAccountKey: string;
  errorMessage: string;
  aiRunId?: string;
  mode?: ExecutionModeLabel | string;
  runsUrl?: string;
}

/**
 * Regression fix: improvement_pr の AI / PR 失敗を通知するためのデータ。
 * `failureStage` で AI ステージ失敗 (`ai`) と PR 作成失敗 (`pr`) を区別する。
 */
export interface ImprovementPrFailedData {
  adAccountKey: string;
  /** "ai_failed" | "pr_failed" の意味付け。 */
  failureStage: "ai" | "pr";
  errorMessage: string;
  aiRunId?: string;
  mode?: ExecutionModeLabel | string;
  /** Web UI `/improvements` または `/cron/runs` の URL。 */
  runsUrl?: string;
}

/**
 * Regression fix: 未分類の cron handler crash (= preset 内 if/else
 * 分岐のいずれかで予期しない throw が起きたケース) を通知するためのデータ。
 * 個別 producer 失敗 (daily_report.failed 等) より粒度が大きく、`failCronRun`
 * のメッセージそのものを乗せる。
 */
export interface CronFailedData {
  /** preset 名 (例: "daily_report" / "budget_guard" / "improvement_pr" /
   *  "github_poll" / "retention_sweep")。 */
  cronName: string;
  errorMessage: string;
  /** cron_runs.id。Web UI deep link 用。 */
  cronRunId?: string;
  /** Web UI `/cron/runs` の URL。 */
  runsUrl?: string;
}

export interface RateLimitWarningData {
  adAccountKey?: string;
  state: RateLimitState;
  retryAfterSeconds?: number;
  /** Meta Graph API のエンドポイント (例: "/act_xxx/insights")。 */
  endpoint?: string;
  /** ISO timestamp。 */
  observedAt: string;
  /** Web UI 側 dashboard へのリンク。 */
  webDashboardUrl?: string;
}

export interface AuthRevokedData {
  /** "meta" | "github" | "codex" | "openai" | "anthropic" | "slack" 等。 */
  provider: string;
  /** GitHub login や Meta act_id 等の非機微識別子。 */
  accountIdentifier?: string;
  /** Slack 側に出して安全な短い理由 (sanitize される)。 */
  detail?: string;
  observedAt: string;
  /** Web UI 側 `/setup` または `/ai` の URL。 */
  setupUrl?: string;
}

export type SlackNotificationPayload =
  | { kind: "pr.opened"; data: PrOpenedData }
  | { kind: "daily_report.completed"; data: DailyReportCompletedData }
  | { kind: "daily_report.failed"; data: DailyReportFailedData }
  | { kind: "budget_guard.alert"; data: BudgetGuardAlertData }
  | { kind: "budget_guard.auto_paused"; data: BudgetGuardAutoPausedData }
  | { kind: "budget_guard.failed"; data: BudgetGuardFailedData }
  | { kind: "improvement_pr.opened"; data: ImprovementPrOpenedData }
  | { kind: "improvement_pr.failed"; data: ImprovementPrFailedData }
  | { kind: "apply.completed"; data: ApplyCompletedData }
  | { kind: "apply.failed"; data: ApplyFailedData }
  | { kind: "cron.failed"; data: CronFailedData }
  | { kind: "rate_limit.warning"; data: RateLimitWarningData }
  | { kind: "auth.revoked"; data: AuthRevokedData };

// =====================================================================
// 2) Block Kit 型 (Slack API が受け付ける最小サブセット)
// =====================================================================

export interface SlackPlainText {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}
export interface SlackMrkdwnText {
  type: "mrkdwn";
  text: string;
}
export type SlackTextObject = SlackPlainText | SlackMrkdwnText;

export interface SlackBlockHeader {
  type: "header";
  text: SlackPlainText;
}
export interface SlackBlockSection {
  type: "section";
  text?: SlackTextObject;
  fields?: SlackTextObject[];
}
export interface SlackBlockContext {
  type: "context";
  elements: SlackTextObject[];
}
export interface SlackBlockDivider {
  type: "divider";
}
export interface SlackButtonElement {
  type: "button";
  text: SlackPlainText;
  url?: string;
  style?: "primary" | "danger";
  action_id?: string;
}
export interface SlackBlockActions {
  type: "actions";
  elements: SlackButtonElement[];
}
export type SlackBlockKitBlock =
  | SlackBlockHeader
  | SlackBlockSection
  | SlackBlockContext
  | SlackBlockDivider
  | SlackBlockActions;

export interface SlackBlockKitMessage {
  /** 通知センター / 古い Slack クライアント向けの fallback テキスト。 */
  text: string;
  blocks: SlackBlockKitBlock[];
}

// =====================================================================
// 3) Sanitizer
// =====================================================================

/**
 * Slack に出す前の最終 redactor。Slack 用に xoxb-* / xapp-* / xoxp-* と
 * Slack signing secret を含む env 代入を追加で潰す。`@addroid/llm-provider`
 * 側の sanitizer に依存しないよう自前実装にし、`@addroid/config` から循環
 * 参照が発生しないようにする。
 */
export const SLACK_NOTIFICATION_MAX_TEXT_BYTES = 2900;

export function sanitizeForSlack(value: string): string {
  if (typeof value !== "string") return "";
  let out = value;
  // Slack tokens
  out = out.replace(/xoxb-[A-Za-z0-9-]{8,}/g, "xoxb-[REDACTED]");
  out = out.replace(/xapp-[A-Za-z0-9-]{8,}/g, "xapp-[REDACTED]");
  out = out.replace(/xoxp-[A-Za-z0-9-]{8,}/g, "xoxp-[REDACTED]");
  // OpenAI-style secrets
  out = out.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-[REDACTED]");
  // Meta long-lived access tokens
  out = out.replace(/EAA[A-Za-z0-9]{20,}/g, "EAA[REDACTED]");
  // Bearer headers
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  // Discord bot authorization headers + bare bot tokens (base64.base64.hmac)
  out = out.replace(/Bot\s+[A-Za-z0-9._\-]+/g, "Bot [REDACTED]");
  out = out.replace(
    /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/g,
    "[REDACTED]"
  );
  // env var assignments (Meta / OpenAI / Codex / Anthropic / GitHub / Slack)
  out = out.replace(
    /(META_[A-Z0-9_]*TOKEN|OPENAI_[A-Z0-9_]*KEY|CODEX_[A-Z0-9_]*TOKEN|ANTHROPIC_[A-Z0-9_]*KEY|GITHUB_[A-Z0-9_]*TOKEN|SLACK_[A-Z0-9_]*TOKEN|SLACK_[A-Z0-9_]*SECRET)\s*=\s*\S+/g,
    "$1=[REDACTED]"
  );
  // JSON-shaped secret pairs
  out = out.replace(
    /"(access_token|refresh_token|id_token|api_key|client_secret|signing_secret)"\s*:\s*"[^"]+"/gi,
    '"$1":"[REDACTED]"'
  );
  if (out.length > SLACK_NOTIFICATION_MAX_TEXT_BYTES) {
    out = out.slice(0, SLACK_NOTIFICATION_MAX_TEXT_BYTES) + "…[truncated]";
  }
  return out;
}

/** Slack mrkdwn の特殊文字をエスケープ (`<` `>` `&`)。リンク構築は呼び出し側の責務。 */
function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** sanitize → mrkdwn エスケープを 1 度に行うショートカット。 */
function clean(value: string): string {
  return escapeMrkdwn(sanitizeForSlack(value));
}

/** mrkdwn のリンクを構築。URL は `<>` で囲まないリンク文法 `<url|label>`。
 *  URL は http(s) のみ許可し、それ以外は plain text にフォールバック (XSS 的な
 *  href 注入を Slack で受け入れない設計)。 */
function mrkdwnLink(url: string | undefined, label: string): string {
  const cleanedLabel = clean(label);
  if (!url) return cleanedLabel;
  if (!/^https?:\/\//i.test(url)) return cleanedLabel;
  // URL 内の `<` `>` `|` `&` は Slack 仕様で壊れるので除外したリンクのみ受理。
  if (/[<>|]/.test(url)) return cleanedLabel;
  // URL 自体に出すべきトークンが残っていないか sanitize する (二重防御)。
  const safeUrl = sanitizeForSlack(url);
  return `<${safeUrl}|${cleanedLabel}>`;
}

// =====================================================================
// 4) 各通知種別の Block Kit ビルダー
// =====================================================================

const KIND_TITLES: Record<SlackNotificationKind, string> = {
  "pr.opened": "GitHub PR を作成しました",
  "daily_report.completed": "Daily report が完了しました",
  "daily_report.failed": "Daily report が失敗しました",
  "budget_guard.alert": "Budget guard が閾値に達しました",
  "budget_guard.auto_paused": "Budget guard が自動 PAUSED を実行しました",
  "budget_guard.failed": "Budget guard が失敗しました",
  "improvement_pr.opened": "Improvement PR を作成しました",
  "improvement_pr.failed": "Improvement PR が失敗しました",
  "apply.completed": "Apply が完了しました (PAUSED)",
  "apply.failed": "Apply が失敗しました",
  "cron.failed": "Cron handler が失敗しました",
  "rate_limit.warning": "Meta API rate limit 警告",
  "auth.revoked": "認証が失効しました",
};

/** 入口: 種別ごとのビルダーへ振り分ける。 */
export function buildSlackNotificationMessage(
  payload: SlackNotificationPayload
): SlackBlockKitMessage {
  switch (payload.kind) {
    case "pr.opened":
      return buildPrOpened(payload.data);
    case "daily_report.completed":
      return buildDailyReportCompleted(payload.data);
    case "daily_report.failed":
      return buildDailyReportFailed(payload.data);
    case "budget_guard.alert":
      return buildBudgetGuardAlert(payload.data);
    case "budget_guard.auto_paused":
      return buildBudgetGuardAutoPaused(payload.data);
    case "budget_guard.failed":
      return buildBudgetGuardFailed(payload.data);
    case "improvement_pr.opened":
      return buildImprovementPrOpened(payload.data);
    case "improvement_pr.failed":
      return buildImprovementPrFailed(payload.data);
    case "apply.completed":
      return buildApplyCompleted(payload.data);
    case "apply.failed":
      return buildApplyFailed(payload.data);
    case "cron.failed":
      return buildCronFailed(payload.data);
    case "rate_limit.warning":
      return buildRateLimitWarning(payload.data);
    case "auth.revoked":
      return buildAuthRevoked(payload.data);
    default: {
      // 網羅性チェック (ビルド時に未対応 kind を検出)。
      const _exhaustive: never = payload;
      void _exhaustive;
      throw new Error(
        `[slack-notifications] 未対応の通知種別: ${(payload as { kind?: string }).kind ?? "<unknown>"}`
      );
    }
  }
}

function header(kind: SlackNotificationKind): SlackBlockHeader {
  return {
    type: "header",
    text: { type: "plain_text", text: KIND_TITLES[kind], emoji: false },
  };
}

function context(parts: string[]): SlackBlockContext {
  const elements: SlackTextObject[] = parts
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((p) => ({ type: "mrkdwn", text: clean(p) }));
  if (elements.length === 0) {
    elements.push({ type: "mrkdwn", text: "AdDroid OSS" });
  }
  return { type: "context", elements };
}

function fieldsSection(pairs: { label: string; value: string }[]): SlackBlockSection {
  return {
    type: "section",
    fields: pairs.map((p) => ({
      type: "mrkdwn",
      text: `*${clean(p.label)}*\n${clean(p.value)}`,
    })),
  };
}

function actionsBlock(buttons: { label: string; url: string; style?: "primary" | "danger" }[]): SlackBlockActions {
  const elements: SlackButtonElement[] = buttons
    .filter((b) => /^https?:\/\//i.test(b.url) && !/[<>|]/.test(b.url))
    .map((b) => ({
      type: "button",
      text: { type: "plain_text", text: b.label, emoji: false },
      url: sanitizeForSlack(b.url),
      ...(b.style ? { style: b.style } : {}),
    }));
  return { type: "actions", elements };
}

// ---- pr.opened -----------------------------------------------------------
function buildPrOpened(d: PrOpenedData): SlackBlockKitMessage {
  const summary = `GitHub PR #${d.prNumber} を作成しました: ${d.prTitle}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "PR", value: `#${d.prNumber}` },
    { label: "Repo", value: d.repoFullName },
  ];
  if (d.workflow) fields.push({ label: "Workflow", value: d.workflow });
  if (d.adAccountKey) fields.push({ label: "Ad Account", value: d.adAccountKey });
  if (d.riskLabel) fields.push({ label: "Risk", value: d.riskLabel });

  const buttons: { label: string; url: string }[] = [];
  if (/^https?:\/\//i.test(d.prUrl)) buttons.push({ label: "GitHub で開く", url: d.prUrl });
  if (d.webApprovalsUrl) buttons.push({ label: "/approvals で確認", url: d.webApprovalsUrl });

  const blocks: SlackBlockKitBlock[] = [
    header("pr.opened"),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${clean(d.prTitle)}*\n${mrkdwnLink(d.prUrl, `#${d.prNumber}`)}  ·  ${clean(d.repoFullName)}`,
      },
    },
    fieldsSection(fields),
    context([
      "PR の承認は GitHub merge または Web UI `/approvals` から行います",
      "Slack では PR の承認操作は提供されません",
    ]),
  ];
  if (buttons.length > 0) blocks.push(actionsBlock(buttons));

  return { text: fallback, blocks };
}

// ---- daily_report.completed ---------------------------------------------
function buildDailyReportCompleted(d: DailyReportCompletedData): SlackBlockKitMessage {
  const summary = `Daily report (${d.adAccountKey} / ${d.metricDate}) が完了しました`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Metric Date", value: d.metricDate },
  ];
  if (typeof d.spend === "number" && Number.isFinite(d.spend)) {
    const currency = clean((d.currency ?? "").trim().toUpperCase());
    fields.push({
      label: currency ? `Spend (${currency})` : "Spend",
      value: formatSpend(d.spend, currency),
    });
  }
  if (typeof d.impressions === "number")
    fields.push({ label: "Impressions", value: String(d.impressions) });
  if (typeof d.clicks === "number")
    fields.push({ label: "Clicks", value: String(d.clicks) });
  if (typeof d.conversions === "number")
    fields.push({ label: "Conversions", value: String(d.conversions) });
  if (d.mode) fields.push({ label: "Mode", value: d.mode });

  const blocks: SlackBlockKitBlock[] = [header("daily_report.completed"), fieldsSection(fields)];

  if (d.topImprovements && d.topImprovements.length > 0) {
    const top = d.topImprovements.slice(0, 5).map((s, i) => `${i + 1}. ${clean(s)}`).join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Top improvements*\n${top}` },
    });
  }

  blocks.push(
    context([
      `report_id: ${d.reportId}`,
      "Daily report は観測のみで Meta を変更しません",
    ])
  );

  if (d.reportUrl) {
    blocks.push(actionsBlock([{ label: "/reports で詳細を見る", url: d.reportUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- budget_guard.alert -------------------------------------------------
function buildBudgetGuardAlert(d: BudgetGuardAlertData): SlackBlockKitMessage {
  const summary = `Budget guard alert: ${d.adAccountKey} / ${d.rule}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Rule", value: d.rule },
  ];
  if (d.threshold) fields.push({ label: "Threshold", value: d.threshold });
  if (d.observedValue) fields.push({ label: "Observed", value: d.observedValue });
  fields.push({ label: "Evaluated", value: d.evaluationTime });
  if (d.mode) fields.push({ label: "Mode", value: d.mode });

  const blocks: SlackBlockKitBlock[] = [
    header("budget_guard.alert"),
    fieldsSection(fields),
    context([
      "閾値を超過しましたが auto_pause は未実行です",
      "対応の必要性は `/budget-guard` で確認してください",
    ]),
  ];
  if (d.budgetUrl) {
    blocks.push(actionsBlock([{ label: "/budget-guard で確認", url: d.budgetUrl }]));
  }
  return { text: fallback, blocks };
}

// ---- budget_guard.auto_paused -------------------------------------------
function buildBudgetGuardAutoPaused(d: BudgetGuardAutoPausedData): SlackBlockKitMessage {
  const summary = `Budget guard auto_pause: ${d.adAccountKey} / ${d.rule}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Rule", value: d.rule },
  ];
  if (d.threshold) fields.push({ label: "Threshold", value: d.threshold });
  if (d.observedValue) fields.push({ label: "Observed", value: d.observedValue });
  fields.push({ label: "Evaluated", value: d.evaluationTime });
  if (d.mode) fields.push({ label: "Mode", value: d.mode });

  const targets = d.pausedTargets.slice(0, 10).map((k) => `• ${clean(k)}`).join("\n");
  const tail = d.pausedTargets.length > 10 ? `\n+${d.pausedTargets.length - 10} more` : "";

  const blocks: SlackBlockKitBlock[] = [
    header("budget_guard.auto_paused"),
    fieldsSection(fields),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*PAUSED 対象*\n${targets}${tail}` },
    },
    context([
      "auto_pause は budget_guard policy の safe operation のみを対象に実行されました",
      "再開は手動で /campaigns から行ってください",
    ]),
  ];
  if (d.budgetUrl) {
    blocks.push(actionsBlock([{ label: "/budget-guard で確認", url: d.budgetUrl }]));
  }
  return { text: fallback, blocks };
}

// ---- improvement_pr.opened ----------------------------------------------
function buildImprovementPrOpened(d: ImprovementPrOpenedData): SlackBlockKitMessage {
  const summary = `Improvement PR #${d.prNumber} を作成しました: ${d.prTitle}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "PR", value: `#${d.prNumber}` },
    { label: "Repo", value: d.repoFullName },
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Risk", value: d.riskLabel },
  ];
  if (d.mode) fields.push({ label: "Mode", value: d.mode });
  if (d.aiRunId) fields.push({ label: "ai_run", value: d.aiRunId });

  const blocks: SlackBlockKitBlock[] = [
    header("improvement_pr.opened"),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${clean(d.prTitle)}*\n${mrkdwnLink(d.prUrl, `#${d.prNumber}`)}  ·  ${clean(d.repoFullName)}`,
      },
    },
    fieldsSection(fields),
  ];

  if (d.dangerousCategories && d.dangerousCategories.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Dangerous categories*\n${d.dangerousCategories.map((c) => `• ${clean(c)}`).join("\n")}`,
      },
    });
  }

  blocks.push(
    context([
      "AI は Meta を直接変更しません — 改善は PR としてのみ提示されます",
      "承認は GitHub merge または Web UI `/approvals` から行います",
    ])
  );

  const buttons: { label: string; url: string }[] = [];
  if (/^https?:\/\//i.test(d.prUrl)) buttons.push({ label: "GitHub で開く", url: d.prUrl });
  if (d.webApprovalsUrl) buttons.push({ label: "/approvals で確認", url: d.webApprovalsUrl });
  if (buttons.length > 0) blocks.push(actionsBlock(buttons));

  return { text: fallback, blocks };
}

// ---- apply.completed ----------------------------------------------------
function buildApplyCompleted(d: ApplyCompletedData): SlackBlockKitMessage {
  const summary = `Apply 完了 (PAUSED): ${d.adAccountKey} / ${d.applyJobId}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Apply Job", value: d.applyJobId },
  ];
  if (typeof d.prNumber === "number") fields.push({ label: "PR", value: `#${d.prNumber}` });
  if (d.repoFullName) fields.push({ label: "Repo", value: d.repoFullName });
  if (typeof d.filesTouched === "number")
    fields.push({ label: "Files", value: String(d.filesTouched) });
  if (typeof d.metaObjectsAffected === "number")
    fields.push({ label: "Meta Objects", value: String(d.metaObjectsAffected) });
  if (typeof d.durationMs === "number")
    fields.push({ label: "Duration", value: `${d.durationMs} ms` });

  const blocks: SlackBlockKitBlock[] = [header("apply.completed"), fieldsSection(fields)];

  if (d.resultSummary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Summary*\n${clean(d.resultSummary)}` },
    });
  }

  blocks.push(
    context([
      "Apply 直後の Meta オブジェクトは PAUSED で生成されています",
      "Activate は `/campaigns` の確認ダイアログから別操作で実施してください",
    ])
  );

  if (d.applyUrl) {
    blocks.push(actionsBlock([{ label: "/apply で詳細を見る", url: d.applyUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- apply.failed -------------------------------------------------------
function buildApplyFailed(d: ApplyFailedData): SlackBlockKitMessage {
  const summary = `Apply 失敗: ${d.adAccountKey} / ${d.applyJobId}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Apply Job", value: d.applyJobId },
  ];
  if (typeof d.prNumber === "number") fields.push({ label: "PR", value: `#${d.prNumber}` });
  if (d.repoFullName) fields.push({ label: "Repo", value: d.repoFullName });
  if (d.errorCode) fields.push({ label: "Error Code", value: d.errorCode });

  const blocks: SlackBlockKitBlock[] = [
    header("apply.failed"),
    fieldsSection(fields),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${clean(d.errorMessage)}` },
    },
    context([
      "Apply は失敗しましたが GitOps polling / Cron は通常通り稼働しています",
      "詳細は `/apply` または `/logs` から確認してください",
    ]),
  ];

  if (d.applyUrl) {
    blocks.push(actionsBlock([{ label: "/apply で詳細を見る", url: d.applyUrl }]));
  }

  return { text: fallback, blocks };
}

function formatSpend(value: number, currency: string): string {
  if (currency === "JPY") return Math.round(value).toLocaleString("ja-JP");
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---- daily_report.failed ------------------------------------------------
function buildDailyReportFailed(d: DailyReportFailedData): SlackBlockKitMessage {
  const summary = `Daily report 失敗: ${d.adAccountKey}${d.metricDate ? ` / ${d.metricDate}` : ""}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
  ];
  if (d.metricDate) fields.push({ label: "Metric Date", value: d.metricDate });
  if (d.mode) fields.push({ label: "Mode", value: d.mode });
  if (d.aiRunId) fields.push({ label: "ai_run", value: d.aiRunId });

  const blocks: SlackBlockKitBlock[] = [
    header("daily_report.failed"),
    fieldsSection(fields),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${clean(d.errorMessage)}` },
    },
    context([
      "Daily report は失敗しましたが GitOps polling / Apply / Cron は通常通り稼働しています",
      "詳細は `/cron/runs` または `/logs` から確認してください",
    ]),
  ];

  if (d.runsUrl) {
    blocks.push(actionsBlock([{ label: "/cron/runs で詳細を見る", url: d.runsUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- budget_guard.failed ------------------------------------------------
function buildBudgetGuardFailed(d: BudgetGuardFailedData): SlackBlockKitMessage {
  const summary = `Budget guard 失敗: ${d.adAccountKey}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
  ];
  if (d.mode) fields.push({ label: "Mode", value: d.mode });
  if (d.aiRunId) fields.push({ label: "ai_run", value: d.aiRunId });

  const blocks: SlackBlockKitBlock[] = [
    header("budget_guard.failed"),
    fieldsSection(fields),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${clean(d.errorMessage)}` },
    },
    context([
      "Budget guard は失敗しましたが GitOps polling / Apply / Cron は通常通り稼働しています",
      "policy 評価が走っていないため、次回 cron まで auto_pause は発火しません",
      "詳細は `/cron/runs` または `/budget-guard` から確認してください",
    ]),
  ];

  if (d.runsUrl) {
    blocks.push(actionsBlock([{ label: "/cron/runs で詳細を見る", url: d.runsUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- improvement_pr.failed ----------------------------------------------
function buildImprovementPrFailed(d: ImprovementPrFailedData): SlackBlockKitMessage {
  const stageLabel = d.failureStage === "pr" ? "PR 作成失敗" : "AI 失敗";
  const summary = `Improvement PR 失敗 (${stageLabel}): ${d.adAccountKey}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Ad Account", value: d.adAccountKey },
    { label: "Stage", value: d.failureStage === "pr" ? "pr_failed" : "ai_failed" },
  ];
  if (d.mode) fields.push({ label: "Mode", value: d.mode });
  if (d.aiRunId) fields.push({ label: "ai_run", value: d.aiRunId });

  const blocks: SlackBlockKitBlock[] = [
    header("improvement_pr.failed"),
    fieldsSection(fields),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${clean(d.errorMessage)}` },
    },
    context([
      "Improvement PR は作成されませんでしたが GitOps polling / Apply / Cron は通常通り稼働しています",
      "AI は Meta を直接変更しません — 失敗時は何も起きません",
      "詳細は `/cron/runs` または `/improvements` から確認してください",
    ]),
  ];

  if (d.runsUrl) {
    blocks.push(actionsBlock([{ label: "/cron/runs で詳細を見る", url: d.runsUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- cron.failed --------------------------------------------------------
function buildCronFailed(d: CronFailedData): SlackBlockKitMessage {
  const summary = `Cron handler 失敗: ${d.cronName}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [
    { label: "Cron", value: d.cronName },
  ];
  if (d.cronRunId) fields.push({ label: "cron_run", value: d.cronRunId });

  const blocks: SlackBlockKitBlock[] = [
    header("cron.failed"),
    fieldsSection(fields),
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${clean(d.errorMessage)}` },
    },
    context([
      "1 件の cron handler が失敗しましたが他の GitOps polling / Apply / Cron は通常通り稼働しています",
      "詳細は `/cron/runs` または `/logs` から確認してください",
    ]),
  ];

  if (d.runsUrl) {
    blocks.push(actionsBlock([{ label: "/cron/runs で詳細を見る", url: d.runsUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- rate_limit.warning -------------------------------------------------
function buildRateLimitWarning(d: RateLimitWarningData): SlackBlockKitMessage {
  const summary = `Meta API rate limit (${d.state})${d.adAccountKey ? `: ${d.adAccountKey}` : ""}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [{ label: "State", value: d.state }];
  if (d.adAccountKey) fields.push({ label: "Ad Account", value: d.adAccountKey });
  if (d.endpoint) fields.push({ label: "Endpoint", value: d.endpoint });
  if (typeof d.retryAfterSeconds === "number")
    fields.push({ label: "Retry After", value: `${d.retryAfterSeconds}s` });
  fields.push({ label: "Observed", value: d.observedAt });

  const blocks: SlackBlockKitBlock[] = [
    header("rate_limit.warning"),
    fieldsSection(fields),
    context([
      "GitOps polling / Apply / Cron は rate limit 復帰まで自動 backoff します",
      "Slack 通知は重複抑制のため一定間隔でのみ送信されます",
    ]),
  ];

  if (d.webDashboardUrl) {
    blocks.push(actionsBlock([{ label: "ダッシュボードで確認", url: d.webDashboardUrl }]));
  }

  return { text: fallback, blocks };
}

// ---- auth.revoked -------------------------------------------------------
function buildAuthRevoked(d: AuthRevokedData): SlackBlockKitMessage {
  const summary = `認証失効: ${d.provider}${d.accountIdentifier ? ` (${d.accountIdentifier})` : ""}`;
  const fallback = sanitizeForSlack(summary);

  const fields: { label: string; value: string }[] = [{ label: "Provider", value: d.provider }];
  if (d.accountIdentifier) fields.push({ label: "Account", value: d.accountIdentifier });
  fields.push({ label: "Observed", value: d.observedAt });

  const blocks: SlackBlockKitBlock[] = [header("auth.revoked"), fieldsSection(fields)];

  if (d.detail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Detail*\n${clean(d.detail)}` },
    });
  }

  blocks.push(
    context([
      "依存する AI ワークフロー / Apply / GitHub polling は影響を受ける可能性があります",
      "再認証は `/setup` または `/ai` から行ってください",
    ])
  );

  if (d.setupUrl) {
    blocks.push(actionsBlock([{ label: "再認証ページを開く", url: d.setupUrl }]));
  }

  return { text: fallback, blocks };
}

// =====================================================================
// 5) Audit writer (implementation item)
//
// Slack 通知の dispatch 終了時に audit_logs に 1 行残す境界。実装は worker /
// caller 側 Prisma が担い、`@addroid/config` 側は prisma を import しない
// (本パッケージは UI / CLI / worker / web から共有されるため)。
//
// implementation item: "Slash Command と通知の実行を audit_logs へ記録し、slack_message_ts、
//           slack_user_id、response_url 利用結果を紐づける"
// 通知側は slack_message_ts (= chat.postMessage 応答の `ts`) を必ず記録する。
// =====================================================================

export interface NotificationAuditInput {
  kind: SlackNotificationKind;
  state: SlackDispatchState;
  /**
   * Slack chat.postMessage 応答の `ts` (slack_message_ts)。`sent` 時のみ存在。
   * implementation item 受入: notification 実行を audit_logs に紐付けるためのキー。
   */
  slackMessageTs?: string;
  /** 解決済みチャンネル ID。`sent` 時は API 応答、それ以外は dispatcher 入力値。 */
  channelId?: string;
  /** 失敗時の Slack エラーコード or 内部エラーラベル (sanitize 済み)。 */
  errorCode?: string;
  /** 失敗時の人間可読メッセージ (sanitize 済み)。 */
  errorMessage?: string;
  /** dispatcher 入口で記録された ISO timestamp。 */
  preparedAt: string;
  /** `sent` 時の ISO timestamp。 */
  sentAt?: string;
}

/**
 * Slack 通知 dispatch 1 回につき audit_logs に 1 行残す境界。
 *
 * - 実装は throw しない契約。Slack 通知失敗は GitOps / Apply / Cron に伝播
 *   してはいけない (acceptance: "Slack and Web UI failures do not block core
 *   GitOps polling, Apply, or Cron execution.")。
 *   仮に throw されても dispatchSlackNotification は飲み込んで dispatch 結果を
 *   呼び出し側に返す。
 */
export interface NotificationAuditWriter {
  recordNotificationDispatch(input: NotificationAuditInput): Promise<void>;
}

// =====================================================================
// 6) Dispatcher
// =====================================================================

export type SlackDispatchState = "sent" | "failed" | "skipped_no_slack";

export interface SlackDispatchResult {
  kind: SlackNotificationKind;
  state: SlackDispatchState;
  /** Slack 側のメッセージ ts。`sent` 時のみ。 */
  ts?: string;
  /** Slack 側で確定したチャンネル ID。`sent` 時のみ。 */
  channel?: string;
  /** `failed` 時の Slack エラーコード (例: "channel_not_found") または HTTP/network エラーラベル。 */
  errorCode?: string;
  /** `failed` 時の人間可読メッセージ (sanitize 済み)。 */
  errorMessage?: string;
  /** ISO timestamp。dispatcher 入口で記録。 */
  preparedAt: string;
  /** ISO timestamp。`sent` 時のみ。 */
  sentAt?: string;
}

export interface SlackDispatchOptions {
  /** 既に oauth_tokens から復号した平文 Bot User OAuth Token (xoxb-*)。
   *  未指定 / 空文字 / 不正形式は即時 `skipped_no_slack` になる。 */
  botToken?: string | null;
  /** 通知先チャンネル ID。未指定なら `skipped_no_slack`。 */
  channelId?: string | null;
  /** Slack Web API への fetch 注入。未指定なら globalThis.fetch を使う。 */
  fetchImpl?: SlackFetch;
  /** 決定的時刻注入 (テスト用)。 */
  now?: () => Date;
  /**
   * implementation item: dispatch 終了時に呼ばれる audit_logs 書き込み境界。
   * 未指定時は audit を書かない (= 単体テストや audit が要らない経路)。
   */
  audit?: NotificationAuditWriter;
}

/**
 * Slack 通知を dispatch する。Slack 未設定時は `skipped_no_slack` を返し
 * 外部に出ないことを保証する (Slack は任意であり、未設定は失敗ではない)。
 *
 * 失敗時 (Slack API エラー / HTTP / network) は `failed` で `errorCode`
 * `errorMessage` を埋めて返す。**throw しない**。これは notification の
 * 失敗が GitOps / Apply / Cron に伝播してはいけない契約のため。
 */
export async function dispatchSlackNotification(
  payload: SlackNotificationPayload,
  options: SlackDispatchOptions = {}
): Promise<SlackDispatchResult> {
  const result = await computeSlackDispatch(payload, options);
  // implementation item: dispatch 終了時に audit_logs へ 1 行残す。Slack 通知失敗を
  // GitOps / Apply / Cron に伝播させない契約のため、audit writer が throw
  // した場合も飲み込む。result は変更しない。
  if (options.audit) {
    const auditInput: NotificationAuditInput = {
      kind: result.kind,
      state: result.state,
      preparedAt: result.preparedAt,
    };
    if (result.ts) auditInput.slackMessageTs = result.ts;
    // チャンネル ID は `sent` 時は API 応答、それ以外は dispatcher 入力値を残す。
    const inputChannel = (options.channelId ?? "").trim();
    const resolvedChannel = result.channel ?? (inputChannel || undefined);
    if (resolvedChannel) auditInput.channelId = resolvedChannel;
    if (result.errorCode) auditInput.errorCode = result.errorCode;
    if (result.errorMessage) auditInput.errorMessage = result.errorMessage;
    if (result.sentAt) auditInput.sentAt = result.sentAt;
    try {
      await options.audit.recordNotificationDispatch(auditInput);
    } catch {
      /* swallow — audit failure must not poison dispatch result */
    }
  }
  return result;
}

async function computeSlackDispatch(
  payload: SlackNotificationPayload,
  options: SlackDispatchOptions
): Promise<SlackDispatchResult> {
  const now = options.now ?? (() => new Date());
  const preparedAt = now().toISOString();

  const botToken = (options.botToken ?? "").trim();
  const channelId = (options.channelId ?? "").trim();

  // Slack 未設定 → skipped (failed ではない)。
  if (!botToken || !channelId || !botToken.startsWith("xoxb-")) {
    return {
      kind: payload.kind,
      state: "skipped_no_slack",
      preparedAt,
    };
  }

  const fetchImpl =
    options.fetchImpl ??
    ((globalThis as { fetch?: SlackFetch }).fetch as SlackFetch | undefined);
  if (typeof fetchImpl !== "function") {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "fetch_unavailable",
      errorMessage: "fetch が利用できません (Node 22+ で実行してください)",
      preparedAt,
    };
  }

  let message: SlackBlockKitMessage;
  try {
    message = buildSlackNotificationMessage(payload);
  } catch (err) {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "build_error",
      errorMessage: sanitizeForSlack((err as Error).message ?? String(err)),
      preparedAt,
    };
  }

  const url = `${SLACK_API_BASE_URL}/chat.postMessage`;
  const body = JSON.stringify({
    channel: channelId,
    text: message.text,
    blocks: message.blocks,
  });

  let res: Awaited<ReturnType<SlackFetch>>;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body,
    });
  } catch (err) {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "network_error",
      errorMessage: sanitizeForSlack((err as Error).message ?? String(err)),
      preparedAt,
    };
  }

  if (!res.ok) {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: `http_${res.status}`,
      errorMessage: `Slack chat.postMessage が HTTP ${res.status} を返しました`,
      preparedAt,
    };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "invalid_json",
      errorMessage: sanitizeForSlack(
        `Slack 応答の JSON parse に失敗: ${(err as Error).message ?? String(err)}`
      ),
      preparedAt,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "invalid_response",
      errorMessage: "Slack 応答が object ではありません",
      preparedAt,
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["ok"] !== true) {
    const slackError = typeof obj["error"] === "string" ? (obj["error"] as string) : "ok_false";
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: slackError,
      errorMessage: `Slack chat.postMessage が ok=false を返しました (${slackError})`,
      preparedAt,
    };
  }

  return {
    kind: payload.kind,
    state: "sent",
    ts: typeof obj["ts"] === "string" ? (obj["ts"] as string) : undefined,
    channel: typeof obj["channel"] === "string" ? (obj["channel"] as string) : channelId,
    preparedAt,
    sentAt: now().toISOString(),
  };
}

/**
 * 失敗 result から `SlackApiError` を再構築する補助 (audit_logs / execution_logs に
 * 失敗内容を記録したいケース用)。dispatcher 自体は throw しないため、呼び出し側で
 * ログ出力に使う場合のみ任意で利用する。
 */
export function dispatchResultToError(
  result: SlackDispatchResult
): SlackApiError | null {
  if (result.state !== "failed") return null;
  return new SlackApiError(
    "chat.postMessage",
    0,
    result.errorCode ?? null,
    result.errorMessage ?? "Slack 通知の送信に失敗しました"
  );
}
