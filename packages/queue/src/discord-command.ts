// AdDroid OSS — Discord slash command boundary (transport-parallel to slack-command.ts).
//
// 本モジュールは Discord Gateway から流入した `/adops <subcommand> [target]` を
// pg-boss にキュー → interaction webhook (PATCH @original) で結果返信、する純粋な層。
// Slack 版同様 Prisma / pg-boss / Discord SDK / fetch を直接 import せず、入口の
// 構造化コマンドと出口の interaction webhook POST だけを取り扱う。
//
// コマンドハンドラ (`SlashCommandHandlers`) は Slack と完全共通: slack-command.ts の
// 6 ハンドラ契約をそのまま再利用し、本モジュールは Discord payload を `SlashHandlerInput`
// に適合させるアダプタと、Discord への返信描画のみを担う。
//
// 設計原則 (Slack 版と同じ):
//   - runDiscordCommandJob は throw せず `DiscordCommandJobResult` を返す
//     (Discord 失敗が GitOps polling / Apply / Cron に伝播しない契約)。
//   - sanitize-on-render: 返信テキストは {@link sanitizeText} を 1 度通す。

import {
  SLACK_SLASH_COMMAND,
  sanitizeText,
  type SlackCommandJobPayload,
  type SlashCommandHandlers,
  type SlashHandlerInput,
  type SlashHandlerOutcome,
  type SlashSubcommand,
} from "./slack-command.js";

// ---------------------------------------------------------------------
// 1) 定数
// ---------------------------------------------------------------------

/** pg-boss queue 名。slack_command と並ぶ単独 work キュー。 */
export const DISCORD_COMMAND_JOB_NAME = "discord_command" as const;

/** AdDroid が Discord に登録する root slash command 名 (先頭の `/` は付けない)。 */
export const DISCORD_SLASH_COMMAND = "adops" as const;

/** `/adops` 配下のサブコマンド (Slack と同集合)。 */
export const DISCORD_SLASH_SUBCOMMANDS = [
  "report",
  "budget",
  "improve",
  "status",
  "accounts",
  "activate",
] as const;

/**
 * Discord REST のベース URL。`@addroid/queue` → `@addroid/config` への依存を
 * 作らないため、slack-command.ts が SLACK_SLASH_COMMAND を持つのと同様にローカル定義する。
 */
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const DISCORD_CONTENT_MAX = 1900;

function isKnownSubcommand(s: string): s is SlashSubcommand {
  return (DISCORD_SLASH_SUBCOMMANDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------
// 2) Payload
// ---------------------------------------------------------------------

/**
 * pg-boss に保存される job payload。`interactionToken` は 15 分有効な Discord 提供
 * トークンで、これと `applicationId` だけで interaction webhook へステートレスに返信
 * できる (Slack の response_url と同型)。bot トークンは含めない。
 */
export interface DiscordCommandJobPayload {
  subcommand: SlashSubcommand;
  /** activate 時の対象 (ads_hierarchy.id 等)。それ以外は空文字。 */
  target: string;
  rest: string[];
  rawText: string;
  discordUserId: string;
  discordUserName: string;
  channelId: string;
  guildId: string;
  applicationId: string;
  interactionToken: string;
  enqueuedAt: string;
}

export interface DiscordCommandSendOptions {
  singletonKey?: string;
}

export interface DiscordCommandBoss {
  send(
    name: string,
    data: unknown,
    options?: DiscordCommandSendOptions
  ): Promise<string | null>;
}

/** Discord gateway が interaction から組む構造化リクエスト。 */
export interface RawDiscordCommandRequest {
  subcommand: string;
  target?: string;
  rest?: string[];
  discordUserId: string;
  discordUserName?: string;
  channelId: string;
  guildId: string;
  applicationId: string;
  interactionToken: string;
}

export type DiscordCommandParseError =
  | "unknown_subcommand"
  | "activate_missing_target";

export interface DiscordCommandParseFailure {
  ok: false;
  reason: DiscordCommandParseError;
  message: string;
}

export interface ParsedDiscordCommand {
  ok: true;
  subcommand: SlashSubcommand;
  target: string;
  rest: string[];
  rawText: string;
}

export type DiscordCommandParseResult =
  | ParsedDiscordCommand
  | DiscordCommandParseFailure;

/**
 * Discord の構造化コマンドを正規化・検証する。Discord はスラッシュコマンドを
 * subcommand + option として届けるため自由文パースは不要だが、未対応 subcommand と
 * activate の target 欠落だけは弾く (Slack の parseSlashCommand と対称)。
 */
export function parseDiscordCommand(
  request: RawDiscordCommandRequest
): DiscordCommandParseResult {
  const sub = (request.subcommand ?? "").trim().toLowerCase();
  if (!isKnownSubcommand(sub)) {
    return {
      ok: false,
      reason: "unknown_subcommand",
      message: `/${DISCORD_SLASH_COMMAND} ${sub || "<empty>"} は未対応です。`,
    };
  }
  const target = (request.target ?? "").trim();
  if (sub === "activate" && target.length === 0) {
    return {
      ok: false,
      reason: "activate_missing_target",
      message: `/${DISCORD_SLASH_COMMAND} activate <ads_hierarchy_id> の形式で対象を指定してください。`,
    };
  }
  const rawText = `${sub}${target ? ` ${target}` : ""}`;
  return { ok: true, subcommand: sub, target, rest: request.rest ?? [], rawText };
}

// ---------------------------------------------------------------------
// 3) Singleton key + enqueue
// ---------------------------------------------------------------------

export function buildDiscordCommandSingletonKey(input: {
  subcommand: SlashSubcommand;
  discordUserId: string;
  target?: string;
}): string {
  const sub = sanitizeKeySegment(input.subcommand);
  const user = sanitizeKeySegment(input.discordUserId || "_");
  if (input.subcommand === "activate") {
    const tgt = sanitizeKeySegment(input.target ?? "_");
    return `discord_command:activate:${user}:${tgt}`;
  }
  return `discord_command:${sub}:${user}`;
}

function sanitizeKeySegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-");
  return cleaned.length > 0 ? cleaned.slice(0, 96) : "_";
}

export interface EnqueueDiscordCommandOptions {
  boss: DiscordCommandBoss;
  parsed: ParsedDiscordCommand;
  request: RawDiscordCommandRequest;
  singletonKey?: string;
  now?: () => Date;
}

export interface EnqueueDiscordCommandResult {
  jobId: string | null;
  payload: DiscordCommandJobPayload;
  singletonKey: string;
}

export async function enqueueDiscordCommandJob(
  opts: EnqueueDiscordCommandOptions
): Promise<EnqueueDiscordCommandResult> {
  const now = opts.now ?? (() => new Date());
  const payload: DiscordCommandJobPayload = {
    subcommand: opts.parsed.subcommand,
    target: opts.parsed.target,
    rest: opts.parsed.rest,
    rawText: opts.parsed.rawText,
    discordUserId: opts.request.discordUserId ?? "",
    discordUserName: opts.request.discordUserName ?? "",
    channelId: opts.request.channelId ?? "",
    guildId: opts.request.guildId ?? "",
    applicationId: opts.request.applicationId ?? "",
    interactionToken: opts.request.interactionToken ?? "",
    enqueuedAt: now().toISOString(),
  };
  const singletonKey =
    opts.singletonKey ??
    buildDiscordCommandSingletonKey({
      subcommand: payload.subcommand,
      discordUserId: payload.discordUserId,
      target: payload.target,
    });
  const jobId = await opts.boss.send(DISCORD_COMMAND_JOB_NAME, payload, {
    singletonKey,
  });
  return { jobId, payload, singletonKey };
}

// ---------------------------------------------------------------------
// 4) Interaction webhook poster
// ---------------------------------------------------------------------

/** Discord interaction webhook へ流す fetch 互換シグネチャ (テストで注入)。 */
export type DiscordResponseFetch = (
  url: string,
  init: { method: "PATCH" | "POST"; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

/**
 * deferred reply を編集して最終結果を返す。
 * `PATCH /webhooks/{applicationId}/{interactionToken}/messages/@original`。
 * interaction token 自体が認証なので bot トークンは不要。**throw しない**。
 */
export async function postDiscordInteractionResponse(opts: {
  applicationId: string;
  interactionToken: string;
  content: string;
  fetchImpl?: DiscordResponseFetch;
}): Promise<{ ok: boolean; status: number; errorCode?: string; errorMessage?: string }> {
  const fetchImpl =
    opts.fetchImpl ??
    ((globalThis as { fetch?: DiscordResponseFetch }).fetch as
      | DiscordResponseFetch
      | undefined);
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      status: 0,
      errorCode: "fetch_unavailable",
      errorMessage: "fetch が利用できません (Node 22+ で実行してください)",
    };
  }
  const appId = (opts.applicationId ?? "").trim();
  const token = (opts.interactionToken ?? "").trim();
  if (!appId || !token) {
    return {
      ok: false,
      status: 0,
      errorCode: "invalid_interaction",
      errorMessage: "applicationId / interactionToken が空です",
    };
  }
  const url = `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(appId)}/${encodeURIComponent(token)}/messages/@original`;
  const body = JSON.stringify({ content: sanitizeText(opts.content).slice(0, DISCORD_CONTENT_MAX) });
  let res: Awaited<ReturnType<DiscordResponseFetch>>;
  try {
    res = await fetchImpl(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AdDroid (https://github.com/addroid/addroid-oss, 0.1.0)",
      },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorCode: "network_error",
      errorMessage: sanitizeText((err as Error).message ?? String(err)),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      errorCode: `http_${res.status}`,
      errorMessage: `Discord interaction webhook が HTTP ${res.status} を返しました`,
    };
  }
  return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------
// 5) Audit writer
// ---------------------------------------------------------------------

export type DiscordCommandJobState = "succeeded" | "failed";

export interface DiscordCommandAuditInput {
  action:
    | "slash_command.completed"
    | "slash_command.failed"
    | "activate.via_discord";
  /** `discord:<user_id>`。空は `discord:_`。 */
  actor: string;
  ref: string;
  target: string;
  subcommand: SlashSubcommand;
  subcommandTarget: string;
  discordUserId: string;
  discordUserName: string;
  channelId: string;
  guildId: string;
  state: DiscordCommandJobState;
  postedToResponseUrl: boolean;
  postError?: string;
  handlerError?: string;
  handlerState: "succeeded" | "failed" | null;
  errorCode?: string;
  durationMs: number;
  finishedAt: string;
}

export interface DiscordCommandAuditWriter {
  recordSlashCommandExecution(input: DiscordCommandAuditInput): Promise<void>;
}

// ---------------------------------------------------------------------
// 6) Orchestrator
// ---------------------------------------------------------------------

export interface DiscordCommandJobResult {
  subcommand: SlashSubcommand;
  state: DiscordCommandJobState;
  postedToResponseUrl: boolean;
  postError?: string;
  handlerOutcome: SlashHandlerOutcome | null;
  handlerError?: string;
  durationMs: number;
}

export interface RunDiscordCommandJobOptions {
  payload: DiscordCommandJobPayload;
  handlers: SlashCommandHandlers;
  fetchImpl?: DiscordResponseFetch;
  now?: () => Date;
  audit?: DiscordCommandAuditWriter;
}

/**
 * pg-boss handler 本体。subcommand に応じてハンドラを 1 つ呼び、結果を interaction
 * webhook に PATCH する。Slack の runSlackCommandJob と対称で **throw しない**。
 */
export async function runDiscordCommandJob(
  opts: RunDiscordCommandJobOptions
): Promise<DiscordCommandJobResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().getTime();
  const { payload, handlers } = opts;

  let outcome: SlashHandlerOutcome | null = null;
  let handlerError: string | undefined;
  try {
    outcome = await dispatchHandler(payload, handlers);
  } catch (err) {
    handlerError = sanitizeText((err as Error).message ?? String(err));
  }

  const content = buildFinalResponseContent({ payload, outcome, handlerError });
  const post = await postDiscordInteractionResponse({
    applicationId: payload.applicationId,
    interactionToken: payload.interactionToken,
    content,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const finishedAtDate = now();
  const durationMs = Math.max(0, finishedAtDate.getTime() - startedAt);
  const state: DiscordCommandJobState =
    !handlerError && outcome?.state === "succeeded" ? "succeeded" : "failed";

  const result: DiscordCommandJobResult = {
    subcommand: payload.subcommand,
    state,
    postedToResponseUrl: post.ok,
    handlerOutcome: outcome,
    durationMs,
  };
  if (post.errorMessage) result.postError = post.errorMessage;
  if (handlerError) result.handlerError = handlerError;

  if (opts.audit) {
    const auditInput = buildDiscordCommandAuditInput({
      payload,
      result,
      finishedAtIso: finishedAtDate.toISOString(),
      outcome,
    });
    try {
      await opts.audit.recordSlashCommandExecution(auditInput);
    } catch {
      /* swallow — audit failure must not poison job result */
    }
  }

  return result;
}

/**
 * Discord payload を Slack 形状の `SlashHandlerInput` に適合させて共通ハンドラを呼ぶ。
 * ハンドラは `payload.target` / `payload.slackUserId` / `payload.slackUserName` のみ参照する
 * ため、Discord の値をそれらのフィールドに載せ替える (フィールド名は slack 由来だが中身は
 * Discord の値。actor 帰属は worker 側 commandSource:"discord" が `discord:<id>` に直す)。
 */
function toHandlerInput(payload: DiscordCommandJobPayload): SlashHandlerInput {
  const adapted: SlackCommandJobPayload = {
    subcommand: payload.subcommand,
    target: payload.target,
    rest: payload.rest,
    rawText: payload.rawText,
    slackUserId: payload.discordUserId,
    slackUserName: payload.discordUserName,
    slackChannelId: payload.channelId,
    slackTeamId: payload.guildId,
    responseUrl: "",
    enqueuedAt: payload.enqueuedAt,
  };
  return { payload: adapted };
}

async function dispatchHandler(
  payload: DiscordCommandJobPayload,
  handlers: SlashCommandHandlers
): Promise<SlashHandlerOutcome> {
  const input = toHandlerInput(payload);
  switch (payload.subcommand) {
    case "report":
      return handlers.report(input);
    case "budget":
      return handlers.budget(input);
    case "improve":
      return handlers.improve(input);
    case "status":
      return handlers.status(input);
    case "accounts":
      return handlers.accounts(input);
    case "activate":
      return handlers.activate(input);
    default: {
      const _exhaustive: never = payload.subcommand;
      void _exhaustive;
      throw new Error(
        `[discord-command] 未対応の subcommand: ${(payload as { subcommand?: string }).subcommand ?? "<unknown>"}`
      );
    }
  }
}

function buildFinalResponseContent(input: {
  payload: DiscordCommandJobPayload;
  outcome: SlashHandlerOutcome | null;
  handlerError?: string;
}): string {
  const { payload, outcome, handlerError } = input;
  const headLine = `${SLACK_SLASH_COMMAND} ${payload.subcommand}${payload.target ? ` ${payload.target}` : ""}`;
  if (handlerError || !outcome) {
    const detail = handlerError ?? "ハンドラが結果を返しませんでした";
    return `**${headLine}**: 失敗しました\n\`\`\`${detail}\`\`\`\nGitOps polling / Apply / Cron は通常通り稼働しています。`;
  }
  const success = outcome.state === "succeeded";
  const lead = success ? "完了しました" : "失敗しました";
  const lines = [`**${headLine}**: ${lead}`, outcome.text];
  if (!success && outcome.errorCode) lines.push(`error_code: ${outcome.errorCode}`);
  if (outcome.detailUrl && /^https?:\/\//i.test(outcome.detailUrl)) {
    lines.push(`[Web UI で確認](${outcome.detailUrl})`);
  }
  return lines.join("\n");
}

function buildDiscordCommandAuditInput(args: {
  payload: DiscordCommandJobPayload;
  result: DiscordCommandJobResult;
  finishedAtIso: string;
  outcome: SlashHandlerOutcome | null;
}): DiscordCommandAuditInput {
  const { payload, result, finishedAtIso, outcome } = args;
  const discordUserId = (payload.discordUserId ?? "").trim();
  const actor = discordUserId.length > 0 ? `discord:${discordUserId}` : "discord:_";
  const action: DiscordCommandAuditInput["action"] =
    payload.subcommand === "activate" && result.state === "succeeded"
      ? "activate.via_discord"
      : result.state === "succeeded"
        ? "slash_command.completed"
        : "slash_command.failed";
  const ref =
    payload.target.length > 0
      ? `${payload.subcommand} ${payload.target}`
      : payload.subcommand;
  const out: DiscordCommandAuditInput = {
    action,
    actor,
    ref,
    target: `discord_command:${payload.subcommand}`,
    subcommand: payload.subcommand,
    subcommandTarget: payload.target,
    discordUserId,
    discordUserName: payload.discordUserName ?? "",
    channelId: payload.channelId ?? "",
    guildId: payload.guildId ?? "",
    state: result.state,
    postedToResponseUrl: result.postedToResponseUrl,
    handlerState: outcome ? outcome.state : null,
    durationMs: result.durationMs,
    finishedAt: finishedAtIso,
  };
  if (result.postError) out.postError = result.postError;
  if (result.handlerError) out.handlerError = result.handlerError;
  if (outcome?.errorCode) out.errorCode = outcome.errorCode;
  return out;
}
