// AdDroid OSS — Discord notifications (embeds) helpers (optional integration).
//
// `slack-notifications.ts` の通知イベントモデル (SlackNotificationPayload とその data 型)
// は transport 中立な「何が起きたか」の記述なので、本モジュールはそれを **型として再利用**
// し、Discord embed への描画と outbound 送信 (POST /channels/{id}/messages) だけを担う。
//
// 不変条件 (Slack 版と同じ):
//   - 平文トークンを embed に絶対含めない。すべての文字列は描画直前に {@link sanitizeForSlack}
//     を通す (Discord bot トークン用の `Bot <token>` redact も同 sanitizer が担う)。
//   - Discord 連携が未設定 (botToken / channelId 不在) の場合、dispatcher は外部に出ず
//     `skipped_no_discord` を返すだけで、呼び出し側パイプライン (GitOps polling / Apply /
//     Cron) を degrade させない。
//   - dispatcher は **throw しない**。通知失敗を core 実行系に伝播させない契約。

import {
  DISCORD_API_BASE_URL,
  DISCORD_USER_AGENT,
  type DiscordEmbed,
  type DiscordFetch,
} from "./discord-auth.js";
import {
  sanitizeForSlack,
  type SlackNotificationKind,
  type SlackNotificationPayload,
} from "./slack-notifications.js";

// 通知イベントモデルは Slack/Discord 共通。エイリアスで「transport 中立」を表現する。
export type NotificationKind = SlackNotificationKind;
export type NotificationPayload = SlackNotificationPayload;

// =====================================================================
// Embed カラー / タイトル
// =====================================================================

const COLOR_SUCCESS = 0x2ecc71; // green
const COLOR_FAILURE = 0xe74c3c; // red
const COLOR_WARNING = 0xf1c40f; // yellow
const COLOR_INFO = 0x5865f2; // blurple

const KIND_TITLES: Record<NotificationKind, string> = {
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

const KIND_COLORS: Record<NotificationKind, number> = {
  "pr.opened": COLOR_SUCCESS,
  "daily_report.completed": COLOR_SUCCESS,
  "daily_report.failed": COLOR_FAILURE,
  "budget_guard.alert": COLOR_WARNING,
  "budget_guard.auto_paused": COLOR_WARNING,
  "budget_guard.failed": COLOR_FAILURE,
  "improvement_pr.opened": COLOR_SUCCESS,
  "improvement_pr.failed": COLOR_FAILURE,
  "apply.completed": COLOR_SUCCESS,
  "apply.failed": COLOR_FAILURE,
  "cron.failed": COLOR_FAILURE,
  "rate_limit.warning": COLOR_WARNING,
  "auth.revoked": COLOR_WARNING,
};

// =====================================================================
// 描画ヘルパ
// =====================================================================

/** sanitize 済み文字列を embed field 上限 (1024) に丸める。 */
function clean(value: string, max = 1024): string {
  const out = sanitizeForSlack(value);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function isHttpUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url) && !/[<>]/.test(url);
}

/** `[label](url)` の Discord markdown リンク。URL が不正なら label のみ。 */
function mdLink(url: string | undefined, label: string): string {
  const safeLabel = clean(label, 256);
  if (!isHttpUrl(url)) return safeLabel;
  return `[${safeLabel}](${sanitizeForSlack(url)})`;
}

type Field = { name: string; value: string; inline?: boolean };

function field(name: string, value: string, inline = true): Field {
  return { name: clean(name, 256), value: clean(value), inline };
}

export interface DiscordNotificationMessage {
  /** 通知センター用の短い fallback テキスト。 */
  content: string;
  embeds: DiscordEmbed[];
}

/** 1 つの embed を組み立てる小ヘルパ。 */
function makeEmbed(
  kind: NotificationKind,
  parts: {
    description?: string;
    fields?: Field[];
    url?: string;
    footer?: string;
  }
): DiscordEmbed {
  const embed: DiscordEmbed = {
    title: KIND_TITLES[kind],
    color: KIND_COLORS[kind],
  };
  if (parts.description) embed.description = clean(parts.description, 4096);
  if (isHttpUrl(parts.url)) embed.url = sanitizeForSlack(parts.url);
  if (parts.fields && parts.fields.length > 0) embed.fields = parts.fields.slice(0, 25);
  embed.footer = { text: clean(parts.footer ?? "AdDroid OSS", 2048) };
  return embed;
}

// =====================================================================
// 種別ごとの embed ビルダー (入口で振り分け)
// =====================================================================

export function buildDiscordNotificationMessage(
  payload: NotificationPayload
): DiscordNotificationMessage {
  const embed = buildEmbed(payload);
  return { content: clean(embed.title ?? KIND_TITLES[payload.kind], 2000), embeds: [embed] };
}

function buildEmbed(payload: NotificationPayload): DiscordEmbed {
  switch (payload.kind) {
    case "pr.opened": {
      const d = payload.data;
      const fields: Field[] = [
        field("PR", `#${d.prNumber}`),
        field("Repo", d.repoFullName),
      ];
      if (d.workflow) fields.push(field("Workflow", d.workflow));
      if (d.adAccountKey) fields.push(field("Ad Account", d.adAccountKey));
      if (d.riskLabel) fields.push(field("Risk", d.riskLabel));
      const links = [mdLink(d.prUrl, `#${d.prNumber} を GitHub で開く`)];
      if (d.webApprovalsUrl) links.push(mdLink(d.webApprovalsUrl, "/approvals で確認"));
      return makeEmbed("pr.opened", {
        description: `**${clean(d.prTitle, 1000)}**\n${links.join("  ·  ")}`,
        fields,
        url: d.prUrl,
        footer: "承認は GitHub merge または Web UI /approvals から行います",
      });
    }
    case "daily_report.completed": {
      const d = payload.data;
      const fields: Field[] = [
        field("Ad Account", d.adAccountKey),
        field("Metric Date", d.metricDate),
      ];
      if (typeof d.spend === "number" && Number.isFinite(d.spend)) {
        const currency = (d.currency ?? "").trim().toUpperCase();
        fields.push(field(currency ? `Spend (${currency})` : "Spend", formatSpend(d.spend, currency)));
      }
      if (typeof d.impressions === "number") fields.push(field("Impressions", String(d.impressions)));
      if (typeof d.clicks === "number") fields.push(field("Clicks", String(d.clicks)));
      if (typeof d.conversions === "number") fields.push(field("Conversions", String(d.conversions)));
      if (d.mode) fields.push(field("Mode", String(d.mode)));
      let description: string | undefined;
      if (d.topImprovements && d.topImprovements.length > 0) {
        description =
          "**Top improvements**\n" +
          d.topImprovements.slice(0, 5).map((s, i) => `${i + 1}. ${clean(s, 200)}`).join("\n");
      }
      if (d.reportUrl) {
        description = `${description ? description + "\n\n" : ""}${mdLink(d.reportUrl, "/reports で詳細を見る")}`;
      }
      return makeEmbed("daily_report.completed", {
        ...(description ? { description } : {}),
        fields,
        footer: `report_id: ${d.reportId} · Daily report は観測のみで Meta を変更しません`,
      });
    }
    case "daily_report.failed": {
      const d = payload.data;
      const fields: Field[] = [field("Ad Account", d.adAccountKey)];
      if (d.metricDate) fields.push(field("Metric Date", d.metricDate));
      if (d.mode) fields.push(field("Mode", String(d.mode)));
      if (d.aiRunId) fields.push(field("ai_run", d.aiRunId));
      return makeEmbed("daily_report.failed", {
        description: `**Error**\n${clean(d.errorMessage, 2000)}${d.runsUrl ? `\n\n${mdLink(d.runsUrl, "/cron/runs で詳細")}` : ""}`,
        fields,
        footer: "GitOps polling / Apply / Cron は通常通り稼働しています",
      });
    }
    case "budget_guard.alert": {
      const d = payload.data;
      return makeEmbed("budget_guard.alert", {
        fields: budgetFields(d),
        ...(d.budgetUrl ? { description: mdLink(d.budgetUrl, "/budget-guard で確認") } : {}),
        footer: "閾値を超過しましたが auto_pause は未実行です",
      });
    }
    case "budget_guard.auto_paused": {
      const d = payload.data;
      const targets = d.pausedTargets.slice(0, 15).map((k) => `• ${clean(k, 100)}`).join("\n");
      const tail = d.pausedTargets.length > 15 ? `\n+${d.pausedTargets.length - 15} more` : "";
      return makeEmbed("budget_guard.auto_paused", {
        description: `**PAUSED 対象**\n${targets}${tail}${d.budgetUrl ? `\n\n${mdLink(d.budgetUrl, "/budget-guard で確認")}` : ""}`,
        fields: budgetFields(d),
        footer: "再開は手動で /campaigns から行ってください",
      });
    }
    case "budget_guard.failed": {
      const d = payload.data;
      const fields: Field[] = [field("Ad Account", d.adAccountKey)];
      if (d.mode) fields.push(field("Mode", String(d.mode)));
      if (d.aiRunId) fields.push(field("ai_run", d.aiRunId));
      return makeEmbed("budget_guard.failed", {
        description: `**Error**\n${clean(d.errorMessage, 2000)}${d.runsUrl ? `\n\n${mdLink(d.runsUrl, "/cron/runs で詳細")}` : ""}`,
        fields,
        footer: "policy 評価が走っていないため次回 cron まで auto_pause は発火しません",
      });
    }
    case "improvement_pr.opened": {
      const d = payload.data;
      const fields: Field[] = [
        field("PR", `#${d.prNumber}`),
        field("Repo", d.repoFullName),
        field("Ad Account", d.adAccountKey),
        field("Risk", d.riskLabel),
      ];
      if (d.mode) fields.push(field("Mode", String(d.mode)));
      if (d.aiRunId) fields.push(field("ai_run", d.aiRunId));
      let description = `**${clean(d.prTitle, 1000)}**\n${mdLink(d.prUrl, `#${d.prNumber} を GitHub で開く`)}`;
      if (d.webApprovalsUrl) description += `  ·  ${mdLink(d.webApprovalsUrl, "/approvals で確認")}`;
      if (d.dangerousCategories && d.dangerousCategories.length > 0) {
        description += `\n\n**Dangerous categories**\n${d.dangerousCategories.map((c) => `• ${clean(c, 100)}`).join("\n")}`;
      }
      return makeEmbed("improvement_pr.opened", {
        description,
        fields,
        url: d.prUrl,
        footer: "AI は Meta を直接変更しません — 承認は GitHub merge / Web UI /approvals から",
      });
    }
    case "improvement_pr.failed": {
      const d = payload.data;
      const fields: Field[] = [
        field("Ad Account", d.adAccountKey),
        field("Stage", d.failureStage === "pr" ? "pr_failed" : "ai_failed"),
      ];
      if (d.mode) fields.push(field("Mode", String(d.mode)));
      if (d.aiRunId) fields.push(field("ai_run", d.aiRunId));
      return makeEmbed("improvement_pr.failed", {
        description: `**Error**\n${clean(d.errorMessage, 2000)}${d.runsUrl ? `\n\n${mdLink(d.runsUrl, "/cron/runs で詳細")}` : ""}`,
        fields,
        footer: "AI は Meta を直接変更しません — 失敗時は何も起きません",
      });
    }
    case "apply.completed": {
      const d = payload.data;
      const fields: Field[] = [
        field("Ad Account", d.adAccountKey),
        field("Apply Job", d.applyJobId),
      ];
      if (typeof d.prNumber === "number") fields.push(field("PR", `#${d.prNumber}`));
      if (d.repoFullName) fields.push(field("Repo", d.repoFullName));
      if (typeof d.filesTouched === "number") fields.push(field("Files", String(d.filesTouched)));
      if (typeof d.metaObjectsAffected === "number") fields.push(field("Meta Objects", String(d.metaObjectsAffected)));
      if (typeof d.durationMs === "number") fields.push(field("Duration", `${d.durationMs} ms`));
      let description = d.resultSummary ? `**Summary**\n${clean(d.resultSummary, 2000)}` : undefined;
      if (d.applyUrl) description = `${description ? description + "\n\n" : ""}${mdLink(d.applyUrl, "/apply で詳細を見る")}`;
      return makeEmbed("apply.completed", {
        ...(description ? { description } : {}),
        fields,
        footer: "Apply 直後の Meta オブジェクトは PAUSED です。Activate は別操作で実施してください",
      });
    }
    case "apply.failed": {
      const d = payload.data;
      const fields: Field[] = [
        field("Ad Account", d.adAccountKey),
        field("Apply Job", d.applyJobId),
      ];
      if (typeof d.prNumber === "number") fields.push(field("PR", `#${d.prNumber}`));
      if (d.repoFullName) fields.push(field("Repo", d.repoFullName));
      if (d.errorCode) fields.push(field("Error Code", d.errorCode));
      return makeEmbed("apply.failed", {
        description: `**Error**\n${clean(d.errorMessage, 2000)}${d.applyUrl ? `\n\n${mdLink(d.applyUrl, "/apply で詳細を見る")}` : ""}`,
        fields,
        footer: "Apply は失敗しましたが GitOps polling / Cron は通常通り稼働しています",
      });
    }
    case "cron.failed": {
      const d = payload.data;
      const fields: Field[] = [field("Cron", d.cronName)];
      if (d.cronRunId) fields.push(field("cron_run", d.cronRunId));
      return makeEmbed("cron.failed", {
        description: `**Error**\n${clean(d.errorMessage, 2000)}${d.runsUrl ? `\n\n${mdLink(d.runsUrl, "/cron/runs で詳細")}` : ""}`,
        fields,
        footer: "他の GitOps polling / Apply / Cron は通常通り稼働しています",
      });
    }
    case "rate_limit.warning": {
      const d = payload.data;
      const fields: Field[] = [field("State", d.state)];
      if (d.adAccountKey) fields.push(field("Ad Account", d.adAccountKey));
      if (d.endpoint) fields.push(field("Endpoint", d.endpoint));
      if (typeof d.retryAfterSeconds === "number") fields.push(field("Retry After", `${d.retryAfterSeconds}s`));
      fields.push(field("Observed", d.observedAt));
      return makeEmbed("rate_limit.warning", {
        ...(d.webDashboardUrl ? { description: mdLink(d.webDashboardUrl, "ダッシュボードで確認") } : {}),
        fields,
        footer: "GitOps polling / Apply / Cron は rate limit 復帰まで自動 backoff します",
      });
    }
    case "auth.revoked": {
      const d = payload.data;
      const fields: Field[] = [field("Provider", d.provider)];
      if (d.accountIdentifier) fields.push(field("Account", d.accountIdentifier));
      fields.push(field("Observed", d.observedAt));
      let description = d.detail ? `**Detail**\n${clean(d.detail, 2000)}` : undefined;
      if (d.setupUrl) description = `${description ? description + "\n\n" : ""}${mdLink(d.setupUrl, "再認証ページを開く")}`;
      return makeEmbed("auth.revoked", {
        ...(description ? { description } : {}),
        fields,
        footer: "再認証は /setup または /ai から行ってください",
      });
    }
    default: {
      const _exhaustive: never = payload;
      void _exhaustive;
      throw new Error(
        `[discord-notifications] 未対応の通知種別: ${(payload as { kind?: string }).kind ?? "<unknown>"}`
      );
    }
  }
}

function budgetFields(d: {
  adAccountKey: string;
  rule: string;
  threshold?: string;
  observedValue?: string;
  evaluationTime: string;
  mode?: string;
}): Field[] {
  const fields: Field[] = [
    field("Ad Account", d.adAccountKey),
    field("Rule", d.rule),
  ];
  if (d.threshold) fields.push(field("Threshold", d.threshold));
  if (d.observedValue) fields.push(field("Observed", d.observedValue));
  fields.push(field("Evaluated", d.evaluationTime));
  if (d.mode) fields.push(field("Mode", String(d.mode)));
  return fields;
}

function formatSpend(value: number, currency: string): string {
  if (currency === "JPY") return Math.round(value).toLocaleString("ja-JP");
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// =====================================================================
// Audit writer (Slack 版と対称、Discord 固有命名)
// =====================================================================

export type DiscordDispatchState = "sent" | "failed" | "skipped_no_discord";

export interface DiscordNotificationAuditInput {
  kind: NotificationKind;
  state: DiscordDispatchState;
  /** Discord 応答の message id (`sent` 時のみ)。 */
  discordMessageId?: string;
  channelId?: string;
  errorCode?: string;
  errorMessage?: string;
  preparedAt: string;
  sentAt?: string;
}

export interface DiscordNotificationAuditWriter {
  recordNotificationDispatch(input: DiscordNotificationAuditInput): Promise<void>;
}

// =====================================================================
// Dispatcher
// =====================================================================

export interface DiscordDispatchResult {
  kind: NotificationKind;
  state: DiscordDispatchState;
  /** Discord 側の message id。`sent` 時のみ。 */
  messageId?: string;
  channel?: string;
  errorCode?: string;
  errorMessage?: string;
  preparedAt: string;
  sentAt?: string;
}

export interface DiscordDispatchOptions {
  /** oauth_tokens から復号済みの平文 bot トークン。未指定 / 空は `skipped_no_discord`。 */
  botToken?: string | null;
  /** 通知先チャンネル ID。未指定なら `skipped_no_discord`。 */
  channelId?: string | null;
  fetchImpl?: DiscordFetch;
  now?: () => Date;
  audit?: DiscordNotificationAuditWriter;
}

/**
 * Discord 通知を dispatch する。未設定時は `skipped_no_discord` を返し外部に出ない。
 * 失敗時は `failed` で errorCode/errorMessage を埋めて返す。**throw しない**。
 */
export async function dispatchDiscordNotification(
  payload: NotificationPayload,
  options: DiscordDispatchOptions = {}
): Promise<DiscordDispatchResult> {
  const result = await computeDiscordDispatch(payload, options);
  if (options.audit) {
    const auditInput: DiscordNotificationAuditInput = {
      kind: result.kind,
      state: result.state,
      preparedAt: result.preparedAt,
    };
    if (result.messageId) auditInput.discordMessageId = result.messageId;
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

async function computeDiscordDispatch(
  payload: NotificationPayload,
  options: DiscordDispatchOptions
): Promise<DiscordDispatchResult> {
  const now = options.now ?? (() => new Date());
  const preparedAt = now().toISOString();

  const botToken = (options.botToken ?? "").trim();
  const channelId = (options.channelId ?? "").trim();

  if (!botToken || !channelId) {
    return { kind: payload.kind, state: "skipped_no_discord", preparedAt };
  }

  const fetchImpl =
    options.fetchImpl ??
    ((globalThis as { fetch?: DiscordFetch }).fetch as DiscordFetch | undefined);
  if (typeof fetchImpl !== "function") {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "fetch_unavailable",
      errorMessage: "fetch が利用できません (Node 22+ で実行してください)",
      preparedAt,
    };
  }

  let message: DiscordNotificationMessage;
  try {
    message = buildDiscordNotificationMessage(payload);
  } catch (err) {
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: "build_error",
      errorMessage: sanitizeForSlack((err as Error).message ?? String(err)),
      preparedAt,
    };
  }

  const url = `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages`;
  const body = JSON.stringify({ content: message.content, embeds: message.embeds });

  let res: Awaited<ReturnType<DiscordFetch>>;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
        "User-Agent": DISCORD_USER_AGENT,
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
    let discordCode: string | null = null;
    try {
      const errBody = (await res.json()) as { code?: unknown };
      if (typeof errBody?.code === "number") discordCode = String(errBody.code);
    } catch {
      /* ignore */
    }
    return {
      kind: payload.kind,
      state: "failed",
      errorCode: discordCode ? `discord_${discordCode}` : `http_${res.status}`,
      errorMessage: `Discord メッセージ送信が HTTP ${res.status} を返しました`,
      preparedAt,
    };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    // 送信自体は 2xx 成功。id 取得に失敗しても sent 扱い。
    return {
      kind: payload.kind,
      state: "sent",
      channel: channelId,
      preparedAt,
      sentAt: now().toISOString(),
      errorMessage: sanitizeForSlack(`応答 JSON parse 失敗 (送信は成功): ${(err as Error).message}`),
    };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return {
    kind: payload.kind,
    state: "sent",
    messageId: typeof obj["id"] === "string" ? (obj["id"] as string) : undefined,
    channel: typeof obj["channel_id"] === "string" ? (obj["channel_id"] as string) : channelId,
    preparedAt,
    sentAt: now().toISOString(),
  };
}
