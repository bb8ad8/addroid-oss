// AdDroid OSS — operation action → MetaActionExecutor adapter (apps/worker side).
//
// `runExecuteApply` から渡される 1 つの action を Graph API request に翻訳して実行し、
// `ExecuteActionResult` (sanitized) に再構成する。
//
// 動作モード:
//   - graph       : 既定の本番経路。Meta Graph API を正規ルートとして使う。
//   - mock        : `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK=1`
//                   の場合に限り選ばれる、明示的なローカルテストシミュレーション経路。
//                   Meta API には一切リクエストせず即 success を返す (the current implementation の
//                   "mocked equivalent in local tests" 受入要件に対応)。
//   - cli         : 将来 Meta Ads CLI の対応範囲が十分になった場合の内部 backend。
//
// 本ファイルは Prisma を import しない。token は MetaAdapter から都度復号して
// 取得し、メソッドスコープでのみ保持する。

import fs from "node:fs/promises";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { LocalDiskStorage } from "@addroid/config";
import {
  META_GRAPH_API_VERSION,
  MetaAdapterUnauthenticatedError,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliVersionUnverifiedError,
  MetaTokenExpiredError,
  fetchMetaAssetReadiness,
  recommendActionForExit,
  toExecutionLogInput,
  type MetaAdapter,
  type MetaCliExitClass,
  type MetaCliInvocation,
  type MetaCliRunnerOptions,
  type MetaCliVersionVerification,
} from "@addroid/meta-adapter";
import type {
  ApplyAction,
  ExecuteActionInput,
  ExecuteActionResult,
  GraphOperationAction,
  JsonValue,
  MetaActionExecutor,
} from "@addroid/queue";

type CreateCreativeApplyAction = ApplyAction & { kind: "create_creative" };
interface CarouselApplyCard {
  position: number;
  storageKey: string;
  headline: string;
  description?: string;
  linkUrl?: string;
}

// ---------------------------------------------------------------------
// regression fix: canonical pre-spawn payload shape
//
// Spawned MetaCli runs persist a payload with a fixed set of evidence fields
// (stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/throttleHeaders/
// exitClass/recommendedAction). Pre-spawn failures (CLI not configured, version
// not verified, token missing/expired) used to omit those fields entirely, which
// made `execution_logs` rows for failed-before-spawn invocations structurally
// different from spawned invocations and broke uniform consumers (UI panels,
// log analytics).
//
// `prefailedPayloadEnvelope` returns the canonical envelope with
// null/empty/zero values so callers only have to merge their own
// failure-specific fields (mode, stage, errorName, etc.) on top.
// ---------------------------------------------------------------------

interface PreSpawnPayloadEnvelopeInput {
  exitClass: MetaCliExitClass;
  /** Sanitized 1 行説明。stderr スロットに格納される (token を含めないこと)。 */
  stderr: string;
  /** Meta CLI binary path (resolved 時は env、未 resolve 時は null)。 */
  binary: string | null;
  accountKey: string;
  sanitizedCommand: string;
  sanitizedArgs: string[];
  /**
   * regression fix: spawned 経路では `toExecutionLogInput` が
   * `refs.pullRequestNumber` / `refs.approvalRecordId` を payload に焼き付ける。
   * pre-spawn 失敗時もこれらを含めることで、execution_logs を横断するコンシューマ
   * (UI ExecutionLogPanel / 監査トレース) が「失敗パスだけ PR / 承認境界が分からない」
   * 状態に陥らないようにする。`undefined` は payload に含めない。
   */
  pullRequestNumber?: number;
  approvalRecordId?: string;
}

function prefailedPayloadEnvelope(
  input: PreSpawnPayloadEnvelopeInput,
): Record<string, JsonValue> {
  const now = new Date().toISOString();
  const out: Record<string, JsonValue> = {
    accountKey: input.accountKey,
    binary: input.binary,
    sanitizedCommand: input.sanitizedCommand,
    sanitizedArgs: input.sanitizedArgs,
    exitCode: null,
    signal: null,
    exitClass: input.exitClass,
    recommendedAction: recommendActionForExit(
      input.exitClass,
    ) as unknown as JsonValue,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    timedOut: false,
    stdout: "",
    stderr: input.stderr,
    throttleHeaders: null,
  };
  if (input.pullRequestNumber !== undefined) {
    out.pullRequestNumber = input.pullRequestNumber;
  }
  if (input.approvalRecordId !== undefined) {
    out.approvalRecordId = input.approvalRecordId;
  }
  return out;
}

// ---------------------------------------------------------------------
// regression fix: canonical mock-success payload shape
//
// MockApplyExecutor は実 Meta CLI を spawn しないため、`toExecutionLogInput` の
// 出力 (stdout/stderr/exitCode/startedAt/finishedAt/durationMs/timedOut/
// throttleHeaders/exitClass/recommendedAction) を経由しない。`/apply/[id]` の
// ExecutionLogPanel など payload 形状に依存するコンシューマが mock 経路だけ
// 評価分岐しなくて済むよう、success payload にも canonical 形状を込める。
// 値は実 CLI 成功時に対応する確定値 (exitCode=0, exitClass="success",
// throttleHeaders=null) で埋める。
// ---------------------------------------------------------------------

interface MockSuccessPayloadEnvelopeInput {
  accountKey: string;
  sanitizedCommand: string;
  sanitizedArgs: string[];
  /** 表示用の 1 行説明 (token を含めないこと)。 */
  stdout: string;
}

function mockSuccessPayloadEnvelope(
  input: MockSuccessPayloadEnvelopeInput,
): Record<string, JsonValue> {
  const now = new Date().toISOString();
  return {
    accountKey: input.accountKey,
    binary: null,
    sanitizedCommand: input.sanitizedCommand,
    sanitizedArgs: input.sanitizedArgs,
    exitCode: 0,
    signal: null,
    exitClass: "success",
    recommendedAction: recommendActionForExit(
      "success",
    ) as unknown as JsonValue,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    timedOut: false,
    stdout: input.stdout,
    stderr: "",
    throttleHeaders: null,
  };
}

// ---------------------------------------------------------------------
// Operation action → CLI args
// ---------------------------------------------------------------------

/**
 * 1 つの action を公式 `meta ads <resource> <verb> ...` 形式の CLI args に変換する。
 *
 * - resource/verb は `META_CLI_SUPPORTED_OPERATIONS` のマトリクスに含まれるもののみ使う。
 *   experiment 系はマトリクスに無いため、現契約では skipped を返し、別契約での
 *   検証後に追加する (fail closed)。
 * - access token / ad account id は決して args に乗せない。CLI runner 側が公式
 *   CLI 互換 env (`ACCESS_TOKEN` / `AD_ACCOUNT_ID`) として注入する。
 */
function planActionToCliArgs(
  action: ApplyAction,
  accountCurrency = "USD",
): {
  args: string[];
  resource: string;
  verb: string;
} | null {
  switch (action.kind) {
    case "meta_cli_operation":
      return {
        resource: action.resource,
        verb: action.verb,
        args: resolveStorageFlagArgs(action.args),
      };
    case "create_campaign":
      return {
        resource: "campaigns",
        verb: "create",
        args: [
          "ads",
          "campaign",
          "create",
          "--name",
          action.name,
          "--objective",
          cliEnum(action.objective),
          "--status",
          cliEnum(action.initialState),
          ...budgetFlags(action.budget, accountCurrency),
          ...(action.adsetBudgetSharing !== undefined
            ? [
                action.adsetBudgetSharing
                  ? "--adset-budget-sharing"
                  : "--no-adset-budget-sharing",
              ]
            : []),
        ],
      };
    case "update_campaign":
      return {
        resource: "campaigns",
        verb: "update",
        args: [
          "ads",
          "campaign",
          "update",
          action.campaignId,
          ...changeFlags(action.changes, accountCurrency),
        ],
      };
    case "create_adset":
      return {
        resource: "adsets",
        verb: "create",
        args: [
          "ads",
          "adset",
          "create",
          action.campaignId,
          "--name",
          action.name,
          "--status",
          cliEnum(action.initialState),
          ...(action.optimizationGoal
            ? ["--optimization-goal", cliEnum(action.optimizationGoal)]
            : []),
          ...(action.billingEvent
            ? ["--billing-event", cliEnum(action.billingEvent)]
            : []),
          ...(action.budget ? budgetFlags(action.budget, accountCurrency) : []),
          ...(action.bidAmount !== undefined
            ? [
                "--bid-amount",
                amountToMinorUnits(action.bidAmount, accountCurrency),
              ]
            : []),
          ...(action.startTime ? ["--start-time", action.startTime] : []),
          ...(action.endTime ? ["--end-time", action.endTime] : []),
          ...(action.targeting.countries.length > 0
            ? ["--targeting-countries", action.targeting.countries.join(",")]
            : []),
          ...(action.pixelId ? ["--pixel-id", action.pixelId] : []),
          ...(action.customEventType
            ? ["--custom-event-type", cliEnum(action.customEventType)]
            : []),
        ],
      };
    case "update_adset":
      return {
        resource: "adsets",
        verb: "update",
        args: [
          "ads",
          "adset",
          "update",
          action.adsetId,
          ...changeFlags(action.changes, accountCurrency),
        ],
      };
    case "create_ad":
      return {
        resource: "ads",
        verb: "create",
        args: [
          "ads",
          "ad",
          "create",
          action.adsetId,
          "--name",
          action.name,
          "--creative-id",
          action.creativeRef,
          "--status",
          cliEnum(action.initialState),
          ...(action.pixelId ? ["--pixel-id", action.pixelId] : []),
          ...(action.trackingSpecs
            ? ["--tracking-specs", JSON.stringify(action.trackingSpecs)]
            : []),
        ],
      };
    case "update_ad":
      return {
        resource: "ads",
        verb: "update",
        args: [
          "ads",
          "ad",
          "update",
          action.adId,
          ...changeFlags(action.changes, accountCurrency),
        ],
      };
    case "create_creative":
      return {
        resource: "creatives",
        verb: "create",
        args: [
          "ads",
          "creative",
          "create",
          "--name",
          action.name,
          ...(action.pageId ? ["--page-id", action.pageId] : []),
          ...(action.storageKey && action.mediaType === "image"
            ? ["--image", fileArg(action.storageKey)]
            : []),
          ...(action.storageKey && action.mediaType === "video"
            ? ["--video", fileArg(action.storageKey)]
            : []),
          ...((action.body ?? action.primaryText)
            ? ["--body", action.body ?? action.primaryText ?? ""]
            : []),
          ...((action.title ?? action.headline)
            ? ["--title", action.title ?? action.headline ?? ""]
            : []),
          ...(action.linkUrl ? ["--link-url", action.linkUrl] : []),
          ...(action.description ? ["--description", action.description] : []),
          ...(action.callToAction
            ? ["--call-to-action", cliEnum(action.callToAction)]
            : []),
          ...(action.instagramUserId
            ? ["--instagram-actor-id", action.instagramUserId]
            : []),
          ...repeatFlags("--images", action.images?.map(fileArg)),
          ...repeatFlags("--videos", action.videos?.map(fileArg)),
          ...repeatFlags("--titles", action.titles),
          ...repeatFlags("--bodies", action.bodies),
          ...repeatFlags("--descriptions", action.descriptions),
          ...repeatFlags(
            "--call-to-actions",
            action.callToActions?.map(cliEnum),
          ),
        ],
      };
    case "update_creative":
      return {
        resource: "creatives",
        verb: "update",
        args: [
          "ads",
          "creative",
          "update",
          action.creativeId,
          ...changeFlags(action.changes, accountCurrency),
        ],
      };
    case "delete_campaign":
      return {
        resource: "campaigns",
        verb: "delete",
        args: ["ads", "campaign", "delete", action.campaignId, "--force"],
      };
    case "delete_adset":
      return {
        resource: "adsets",
        verb: "delete",
        args: ["ads", "adset", "delete", action.adsetId, "--force"],
      };
    case "delete_ad":
      return {
        resource: "ads",
        verb: "delete",
        args: ["ads", "ad", "delete", action.adId, "--force"],
      };
    case "delete_creative":
      return {
        resource: "creatives",
        verb: "delete",
        args: ["ads", "creative", "delete", action.creativeId, "--force"],
      };
    // experiment_* は META_CLI_SUPPORTED_OPERATIONS に未登録 (fail closed)。
    default:
      return null;
  }
}

function budgetFlags(
  b: { dailyBudget?: number; lifetimeBudget?: number },
  accountCurrency: string,
): string[] {
  const out: string[] = [];
  if (b.dailyBudget !== undefined) {
    out.push(
      "--daily-budget",
      amountToMinorUnits(b.dailyBudget, accountCurrency),
    );
  }
  if (b.lifetimeBudget !== undefined) {
    out.push(
      "--lifetime-budget",
      amountToMinorUnits(b.lifetimeBudget, accountCurrency),
    );
  }
  return out;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function amountToMinorUnits(value: number, accountCurrency: string): string {
  const currency = accountCurrency.trim().toUpperCase();
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return String(Math.round(value * multiplier));
}

function cliEnum(value: string): string {
  return value.trim().toLowerCase();
}

function fileArg(value: string): string {
  try {
    return new LocalDiskStorage().resolve(value);
  } catch (err) {
    throw new MetaGraphApplyError({
      message:
        "storageKey must be a managed AdDroid storage key; local file paths must be imported before creating an ops PR",
      exitClass: "api_error",
      payload: {
        reason: "invalid_storage_key",
        errorName: (err as Error).name,
      },
    });
  }
}

function resolveStorageFlagArgs(args: readonly string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i += 1) {
    if (
      out[i] === "--image" ||
      out[i] === "--video" ||
      out[i] === "--images" ||
      out[i] === "--videos"
    ) {
      out[i + 1] = fileArg(out[i + 1]!);
    }
  }
  return out;
}

function repeatFlags(
  flag: string,
  values: readonly string[] | undefined,
): string[] {
  return (values ?? []).flatMap((value) => [flag, value]);
}

function changeFlags(
  changes: Record<string, { to?: unknown }>,
  accountCurrency: string,
): string[] {
  const out: string[] = [];
  for (const [key, change] of Object.entries(changes)) {
    const value = change?.to;
    if (value === undefined || value === null) continue;
    switch (key) {
      case "name":
        out.push("--name", String(value));
        break;
      case "initialState":
        out.push("--status", cliEnum(String(value)));
        break;
      case "budget":
        if (isRecord(value)) {
          out.push(
            ...budgetFlags(
              value as { dailyBudget?: number; lifetimeBudget?: number },
              accountCurrency,
            ),
          );
        }
        break;
      case "bidAmount":
        if (typeof value === "number")
          out.push("--bid-amount", amountToMinorUnits(value, accountCurrency));
        break;
      case "endTime":
        out.push("--end-time", String(value));
        break;
      case "creativeRef":
        out.push("--creative-id", String(value));
        break;
      case "pixelId":
        out.push("--pixel-id", String(value));
        break;
      case "trackingSpecs":
        out.push("--tracking-specs", JSON.stringify(value));
        break;
      case "headline":
      case "title":
        out.push("--title", String(value));
        break;
      case "primaryText":
      case "body":
        out.push("--body", String(value));
        break;
      case "linkUrl":
        out.push("--link-url", String(value));
        break;
      case "description":
        out.push("--description", String(value));
        break;
      case "callToAction":
        out.push("--call-to-action", cliEnum(String(value)));
        break;
      case "instagramUserId":
        out.push("--instagram-actor-id", String(value));
        break;
      case "storageKey":
        out.push("--image", fileArg(String(value)));
        break;
      default:
        break;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface GraphApplyRefs {
  refType: "apply_job";
  refId: string;
  pullRequestNumber?: number;
  approvalRecordId?: string;
}

class MetaGraphApplyError extends Error {
  readonly exitClass: MetaCliExitClass;
  readonly status: number | null;
  readonly payload: JsonValue;

  constructor(input: {
    message: string;
    exitClass: MetaCliExitClass;
    status?: number | null;
    payload?: JsonValue;
  }) {
    super(input.message);
    this.name = "MetaGraphApplyError";
    this.exitClass = input.exitClass;
    this.status = input.status ?? null;
    this.payload = input.payload ?? null;
  }
}

function statusForExitClass(
  exitClass: MetaCliExitClass,
): ExecuteActionResult["status"] {
  return exitClass === "auth_error"
    ? "auth_error"
    : exitClass === "rate_limit_error"
      ? "rate_limit_error"
      : exitClass === "api_error"
        ? "api_error"
        : exitClass === "success"
          ? "success"
          : "unknown_error";
}

function applyInputErrorResult(input: {
  action: ApplyAction;
  context: ExecuteActionInput["context"];
  error: MetaGraphApplyError;
  mode: string;
}): ExecuteActionResult {
  const ctxApprovalRecordId = input.context.approvalRecordId;
  const payload = isRecord(input.error.payload) ? input.error.payload : {};
  const reason =
    typeof payload.reason === "string" ? payload.reason : "invalid_apply_input";
  const envelope = prefailedPayloadEnvelope({
    exitClass: input.error.exitClass,
    stderr: input.error.message,
    binary: null,
    accountKey: input.action.account,
    sanitizedCommand: "meta-ads-cli",
    sanitizedArgs: [],
    pullRequestNumber: input.context.prNumber,
    ...(typeof ctxApprovalRecordId === "string" &&
    ctxApprovalRecordId.length > 0
      ? { approvalRecordId: ctxApprovalRecordId }
      : {}),
  });
  const out: ExecuteActionResult = {
    status: statusForExitClass(input.error.exitClass),
    message: `apply aborted before spawn: ${input.error.message}`,
    logPayload: {
      ...envelope,
      mode: input.mode,
      stage: "plan_args",
      reason,
      actionKind: input.action.kind,
      response: input.error.payload,
    } satisfies JsonValue,
  };
  const rec = recommendActionForExit(input.error.exitClass);
  if (
    rec.kind === "notify_reauth" ||
    rec.kind === "notify_api_error" ||
    rec.kind === "fail_fast_notify"
  ) {
    out.notify = { auditAction: rec.auditAction, detail: rec.reason };
  }
  return out;
}

function graphEndpoint(pathname: string): string {
  const cleaned = pathname.replace(/^\/+/, "");
  return `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${cleaned}`;
}

async function postGraphJson(
  pathname: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") form.set(key, JSON.stringify(value));
    else if (typeof value === "boolean")
      form.set(key, value ? "true" : "false");
    else form.set(key, String(value));
  }
  const res = await fetch(graphEndpoint(pathname), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw graphError(res.status, json);
  return { status: res.status, json };
}

async function postGraphMultipart(
  pathname: string,
  accessToken: string,
  fields: Record<string, string>,
  file: { field: string; path: string },
): Promise<{ status: number; json: unknown }> {
  const bytes = await fs.readFile(file.path);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(file.field, new Blob([bytes]), path.basename(file.path));
  const res = await fetch(graphEndpoint(pathname), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw graphError(res.status, json);
  return { status: res.status, json };
}

function graphError(status: number, json: unknown): MetaGraphApplyError {
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  const code = typeof error?.code === "number" ? error.code : null;
  const message =
    typeof error?.message === "string"
      ? error.message
      : `Meta Graph API returned HTTP ${status}`;
  return new MetaGraphApplyError({
    message,
    exitClass: classifyGraphError(status, code),
    status,
    payload: json as JsonValue,
  });
}

function classifyGraphError(
  status: number,
  code: number | null,
): MetaCliExitClass {
  if (
    status === 401 ||
    code === 190 ||
    code === 102 ||
    code === 104 ||
    code === 463 ||
    code === 467
  ) {
    return "auth_error";
  }
  if (
    status === 429 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613
  ) {
    return "rate_limit_error";
  }
  if (status >= 400 && status < 500) return "api_error";
  return "unknown_error";
}

function extractId(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const id = json.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function extractImageHash(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const direct = json.hash;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const images = json.images;
  if (!isRecord(images)) return null;
  for (const value of Object.values(images)) {
    if (
      isRecord(value) &&
      typeof value.hash === "string" &&
      value.hash.length > 0
    ) {
      return value.hash;
    }
  }
  return null;
}

function graphLogPayload(input: {
  accountKey: string;
  action: ApplyAction;
  resource: string;
  verb: string;
  sanitizedCommand: string;
  sanitizedArgs: string[];
  refs: GraphApplyRefs;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitClass: MetaCliExitClass;
  stdout?: string;
  stderr?: string;
  statusCode?: number | null;
  response?: JsonValue;
  preflight?: JsonValue;
}): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {
    accountKey: input.accountKey,
    binary: "meta-graph-api",
    sanitizedCommand: input.sanitizedCommand,
    sanitizedArgs: input.sanitizedArgs,
    exitCode: input.exitClass === "success" ? 0 : (input.statusCode ?? null),
    signal: null,
    exitClass: input.exitClass,
    recommendedAction: recommendActionForExit(
      input.exitClass,
    ) as unknown as JsonValue,
    durationMs: input.durationMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    timedOut: false,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    throttleHeaders: null,
    mode: "graph",
    resource: input.resource,
    verb: input.verb,
    action: JSON.parse(JSON.stringify(input.action)) as JsonValue,
    response: input.response ?? null,
    preflight: input.preflight ?? null,
    refType: input.refs.refType,
    refId: input.refs.refId,
  };
  if (input.refs.pullRequestNumber !== undefined) {
    out.pullRequestNumber = input.refs.pullRequestNumber;
  }
  if (input.refs.approvalRecordId !== undefined) {
    out.approvalRecordId = input.refs.approvalRecordId;
  }
  return out;
}

function buildImageCreativeObjectStorySpec(
  action: CreateCreativeApplyAction,
  imageHash: string,
): Record<string, unknown> {
  if (!action.pageId)
    throw new Error("create_creative requires pageId for Meta Graph apply");
  if (!action.linkUrl)
    throw new Error(
      "create_creative image link ad requires linkUrl for Meta Graph apply",
    );
  const linkData: Record<string, unknown> = {
    image_hash: imageHash,
    link: action.linkUrl,
    message: action.body ?? action.primaryText ?? "",
  };
  const title = action.title ?? action.headline;
  if (title) linkData.name = title;
  if (action.description) linkData.description = action.description;
  if (action.callToAction && action.callToAction !== "NO_BUTTON") {
    const ctaValue: Record<string, unknown> = { link: action.linkUrl };
    if (action.instagramAppLink) ctaValue.app_link = action.instagramAppLink;
    linkData.call_to_action = {
      type: action.callToAction,
      value: ctaValue,
    };
  }
  return {
    page_id: action.pageId,
    ...(action.instagramUserId
      ? { instagram_user_id: action.instagramUserId }
      : {}),
    link_data: linkData,
  };
}

function buildCarouselCreativeObjectStorySpec(
  action: CreateCreativeApplyAction,
  cards: readonly CarouselApplyCard[],
  imageHashes: readonly string[],
): Record<string, unknown> {
  if (!action.pageId)
    throw new MetaGraphApplyError({
      message: "create_creative carousel requires pageId",
      exitClass: "api_error",
    });
  if (!action.linkUrl)
    throw new MetaGraphApplyError({
      message: "create_creative carousel requires linkUrl",
      exitClass: "api_error",
    });
  if (cards.length !== imageHashes.length) {
    throw new MetaGraphApplyError({
      message: "carousel card count does not match uploaded image hashes",
      exitClass: "api_error",
    });
  }
  const childAttachments = cards.map((card, index) => {
    const link = card.linkUrl ?? action.linkUrl;
    if (!link)
      throw new MetaGraphApplyError({
        message: `carousel card ${index + 1} requires linkUrl`,
        exitClass: "api_error",
      });
    return removeUndefinedGraph({
      image_hash: imageHashes[index],
      name: card.headline,
      description: card.description,
      link,
    });
  });
  const cta = action.callToAction;
  const linkData: Record<string, unknown> = removeUndefinedGraph({
    link: action.linkUrl,
    message: action.body ?? action.primaryText ?? "",
    child_attachments: childAttachments,
    call_to_action:
      cta && cta !== "NO_BUTTON"
        ? {
            type: cta,
            value: removeUndefinedGraph({
              link: action.linkUrl,
              app_link: action.instagramAppLink,
            }),
          }
        : undefined,
  });
  return removeUndefinedGraph({
    page_id: action.pageId,
    ...(action.instagramUserId
      ? { instagram_user_id: action.instagramUserId }
      : {}),
    link_data: linkData,
  });
}

// ---------------------------------------------------------------------
// regression fix: external_id surfacing on Apply success
// ---------------------------------------------------------------------

/**
 * Apply success が ads_hierarchy 永続化のために external_id を必須とする
 * action kinds (= Activate 経路がこの行を読むため)。
 *
 * - `create_campaign` / `create_adset` / `create_ad` は新規 row を生成するため
 *   external_id 無しで永続化すると Activate が「external_id 未確定」で永久に
 *   拒否される。
 * - `create_creative` は ads_hierarchy 対象外 (creatives テーブル管轄)。
 * - `update_*` は既存 row 上書きで external_id を保持できるため対象外。
 */
function isCreateRequiringExternalId(kind: ApplyAction["kind"]): boolean {
  return (
    kind === "create_campaign" ||
    kind === "create_adset" ||
    kind === "create_ad" ||
    kind === "campaign.create" ||
    kind === "adset.create" ||
    kind === "ad.create" ||
    kind === "creative.create" ||
    kind === "meta_cli_operation"
  );
}

function actionRequiresExternalId(action: ApplyAction): boolean {
  if (action.kind === "meta_cli_operation")
    return action.externalIdRequired === true;
  return isCreateRequiringExternalId(action.kind);
}

/**
 * Meta CLI の sanitized stdout から作成された Meta オブジェクトの external_id を
 * best-effort で抽出する。CLI は通常 `{"id":"<numeric>"}` 系の JSON を返す
 * (Meta Graph API の create response をそのまま吐く実装が多い) ため、まず
 * stdout 全体 → 各行の順で JSON 解析を試み、`externalId` / `external_id` /
 * `id` のいずれかが string/number で見つかればそれを採用する。JSON で取れない
 * ときは regex で `"id":"…"` 等のパターンを拾う。token は redact 済みの
 * stdout を入力に取る前提なので、この関数自体は redaction を行わない。
 *
 * 抽出できなかった場合は undefined。呼び出し側 (CliApplyExecutor) は
 * undefined のまま ExecuteActionResult を返し、queue 側 runExecuteApply が
 * create_* かつ external_id 欠落のケースを fail-closed する。
 */
export function extractExternalIdFromCliStdout(
  stdout: string,
): string | undefined {
  if (!stdout) return undefined;
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;

  const fromWhole = tryExtractIdFromJsonText(trimmed);
  if (fromWhole) return fromWhole;

  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const fromLine = tryExtractIdFromJsonText(t);
    if (fromLine) return fromLine;
  }

  // 最後の砦: 自由形式テキストに `"id":"..."` 等が紛れているケース。
  const m = stdout.match(/"(externalId|external_id|id)"\s*:\s*"([^"\\]+)"/);
  if (m && m[2]) return m[2];
  const numeric = stdout.match(/"(externalId|external_id|id)"\s*:\s*(\d+)/);
  if (numeric && numeric[2]) return numeric[2];

  const tableId = extractIdFromCliTable(stdout);
  if (tableId) return tableId;

  return undefined;
}

function extractIdFromCliTable(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^id\b/i.test(lines[i]!)) continue;
    const separator = lines[i + 1] ?? "";
    const value = lines[i + 2] ?? "";
    if (!/^-{3,}$/.test(separator)) continue;
    if (/^[A-Za-z0-9_/-]{6,}$/.test(value)) return value;
  }
  return undefined;
}

function tryExtractIdFromJsonText(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return extractIdField(parsed);
}

function extractIdField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["externalId", "external_id", "id"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * MockApplyExecutor が create_* / update_* に対して返す決定的な mocked external_id。
 *
 * Activate (PAUSED → ACTIVE) は ads_hierarchy.externalId を読んで Meta CLI を
 * 叩くため、`ADDROID_META_ADS_CLI_MOCK=1` の local-test simulation 経路でも
 * external_id が空だと Activate が永久に拒否される。Mock は実 Meta API を
 * 叩かないため、accountKey と YAML 上の id を組み合わせた決定的な値を返す。
 *
 * `creative` は ads_hierarchy 対象外だが、payload の可観測性のため同じ規則で
 * 値を返す。
 */
function deterministicMockExternalId(action: ApplyAction): string | undefined {
  switch (action.kind) {
    case "create_campaign":
    case "update_campaign":
      return `mock-${action.account}-cmp-${action.campaignId}`;
    case "create_adset":
    case "update_adset":
      return `mock-${action.account}-as-${action.adsetId}`;
    case "create_ad":
    case "update_ad":
      return `mock-${action.account}-ad-${action.adId}`;
    case "create_creative":
    case "update_creative":
      return `mock-${action.account}-cr-${action.creativeId}`;
    case "meta_cli_operation":
      return action.entity?.nodeKey
        ? `mock-${action.account}-${action.entity.nodeType ?? "op"}-${action.entity.nodeKey}`
        : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------
// MockApplyExecutor — explicit local-test simulation only
// ---------------------------------------------------------------------

/**
 * Meta API には一切触れず即 success を返す executor。
 * `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK=1` の組み合わせで
 * 明示的にローカルテストシミュレーションを要求された場合のみ選ばれる
 * (the current implementation 「mocked equivalent in local tests」受入要件)。
 *
 * regression fix: 環境変数 1 本だけで暗黙に有効にしてはならない。CLI 未設定で
 * MOCK フラグも立っていない既定状態は `FailClosedApplyExecutor` 経路に倒す。
 */
export class MockApplyExecutor implements MetaActionExecutor {
  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    let args: ReturnType<typeof planActionToCliArgs>;
    try {
      args = planActionToCliArgs(input.action);
    } catch (err) {
      if (err instanceof MetaGraphApplyError) {
        return applyInputErrorResult({
          action: input.action,
          context: input.context,
          error: err,
          mode: "mock",
        });
      }
      throw err;
    }
    if (!args) {
      return {
        status: "skipped",
        message: `unsupported action kind ${input.action.kind} skipped (verified ops matrix)`,
        logPayload: {
          reason: "unsupported_action",
          actionKind: input.action.kind,
        },
      };
    }
    // regression fix: local-test simulation でも create_* の external_id を
    // 確定させないと、後続の Activate が ads_hierarchy.externalId 未設定で
    // 永久に拒否され、mocked equivalent としての受入要件を満たさなくなる。
    const mockedExternalId = deterministicMockExternalId(input.action);
    const sanitizedCommand = `meta-ads-cli ${args.args.join(" ")}`;
    // regression fix: mock 経路でも spawned 実行と同じ canonical command-evidence
    // shape (stdout/stderr/exitCode/timestamps/durationMs/timedOut/throttleHeaders/
    // exitClass/recommendedAction) を logPayload に含める。値は実 CLI 成功時の確定値
    // (exitCode=0, exitClass="success", throttleHeaders=null) で埋める。
    const envelope = mockSuccessPayloadEnvelope({
      accountKey: input.action.account,
      sanitizedCommand,
      sanitizedArgs: args.args,
      stdout: `mock-applied ${args.resource} ${args.verb} (PAUSED-by-default)`,
    });
    const approvalRecordId = input.context.approvalRecordId;
    if (typeof approvalRecordId === "string" && approvalRecordId.length > 0) {
      envelope.approvalRecordId = approvalRecordId;
    }
    if (typeof input.context.prNumber === "number") {
      envelope.pullRequestNumber = input.context.prNumber;
    }
    const out: ExecuteActionResult = {
      status: "success",
      message: `mock-applied ${args.resource} ${args.verb} (PAUSED-by-default)`,
      logPayload: {
        ...envelope,
        mode: "mock",
        resource: args.resource,
        verb: args.verb,
        action: JSON.parse(JSON.stringify(input.action)) as JsonValue,
        externalId: mockedExternalId ?? null,
      } satisfies JsonValue,
    };
    if (mockedExternalId) out.externalId = mockedExternalId;
    return out;
  }
}

// ---------------------------------------------------------------------
// FailClosedApplyExecutor — default when Meta CLI is not configured
// ---------------------------------------------------------------------

/**
 * regression fix: `ADDROID_META_CLI_BIN` が未設定で、`ADDROID_META_ADS_CLI_MOCK=1`
 * による明示的なローカルテストシミュレーションも要求されていないときの既定経路。
 *
 * Apply は PAUSED-by-default で Meta オブジェクトを作成する操作のため、CLI が
 * 未設定の状態で `MockApplyExecutor` 経由で success を返すと、PR がマージされた
 * だけで `apply.executed` が audit に積まれ、外部観察上は「Meta 側に PAUSED
 * リソースが作られた」ように見えてしまう (実際には何も作られていない)。
 *
 * よって本 executor は常に `unknown_error` + `meta.cli_unknown_error` notify を
 * 返し、`runExecuteApply` 側は `apply_jobs.state=failed` + `apply.failed` audit
 * を記録する。アクション単位の `execution_logs` には sanitized command/args と
 * 失敗理由が残る。
 */
export class FailClosedApplyExecutor implements MetaActionExecutor {
  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    let args: ReturnType<typeof planActionToCliArgs>;
    try {
      args = planActionToCliArgs(input.action);
    } catch (err) {
      if (err instanceof MetaGraphApplyError) {
        return applyInputErrorResult({
          action: input.action,
          context: input.context,
          error: err,
          mode: "fail_closed",
        });
      }
      throw err;
    }
    if (!args) {
      return {
        status: "skipped",
        message: `unsupported action kind ${input.action.kind} skipped (verified ops matrix)`,
        logPayload: {
          reason: "unsupported_action",
          actionKind: input.action.kind,
        },
      };
    }
    const detail =
      "ADDROID_META_CLI_BIN is not configured and ADDROID_META_ADS_CLI_MOCK is not set; apply refuses to fall back to mock success outside explicit local-test simulation";
    // regression fix: pre-spawn failure でも spawned 実行と同じ canonical
    // command-evidence shape (stdout/stderr/exitCode/timestamps/throttleHeaders)
    // を logPayload に含める。null/sanitized 値で埋めることで、execution_logs を
    // 横断するコンシューマ (UI panel / log 解析) が失敗パスを特別扱いせずに済む。
    // regression fix: Cli pre-spawn 失敗と同じく refs.pullRequestNumber /
    // refs.approvalRecordId を payload に焼き付け、失敗パスでも PR / 承認境界の
    // 紐付けを保つ。
    const ctxApprovalRecordId = input.context.approvalRecordId;
    const envelope = prefailedPayloadEnvelope({
      exitClass: "unknown_error",
      stderr: detail,
      binary: null,
      accountKey: input.action.account,
      sanitizedCommand: `meta-ads-cli ${args.args.join(" ")}`,
      sanitizedArgs: args.args,
      pullRequestNumber: input.context.prNumber,
      ...(typeof ctxApprovalRecordId === "string" &&
      ctxApprovalRecordId.length > 0
        ? { approvalRecordId: ctxApprovalRecordId }
        : {}),
    });
    return {
      status: "unknown_error",
      message: `apply ${args.resource} ${args.verb} aborted: Meta Ads CLI is not configured`,
      logPayload: {
        ...envelope,
        mode: "fail_closed",
        stage: "resolve_executor",
        reason: "cli_not_configured",
        resource: args.resource,
        verb: args.verb,
      } satisfies JsonValue,
      notify: {
        auditAction: "meta.cli_unknown_error",
        detail,
      },
    };
  }
}

// ---------------------------------------------------------------------
// CliApplyExecutor — Meta Ads CLI 経由
// ---------------------------------------------------------------------

export interface CliApplyExecutorOptions {
  runner: MetaCliRunner;
  metaAdapter: MetaAdapter;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null>;
  resolveAdAccountCurrency?: (accountKey: string) => Promise<string | null>;
}

export class CliApplyExecutor implements MetaActionExecutor {
  private readonly runner: MetaCliRunner;
  private readonly metaAdapter: MetaAdapter;
  private readonly resolveAdAccountId?: (
    accountKey: string,
  ) => Promise<string | null>;
  private readonly resolveAdAccountCurrency?: (
    accountKey: string,
  ) => Promise<string | null>;
  private readonly createdCreativeExternalIds = new Map<string, string>();
  private readonly createdOperationExternalIds = new Map<string, string>();
  constructor(opts: CliApplyExecutorOptions) {
    this.runner = opts.runner;
    this.metaAdapter = opts.metaAdapter;
    this.resolveAdAccountId = opts.resolveAdAccountId;
    this.resolveAdAccountCurrency = opts.resolveAdAccountCurrency;
  }

  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const accountCurrency =
      (this.resolveAdAccountCurrency
        ? await this.resolveAdAccountCurrency(input.action.account)
        : null) ?? "USD";
    const action = this.rewriteActionRefs(input.action);
    let args: ReturnType<typeof planActionToCliArgs>;
    try {
      args = planActionToCliArgs(action, accountCurrency);
    } catch (err) {
      if (err instanceof MetaGraphApplyError) {
        return applyInputErrorResult({
          action,
          context: input.context,
          error: err,
          mode: "cli",
        });
      }
      throw err;
    }
    if (!args) {
      return {
        status: "skipped",
        message: `unsupported action kind ${action.kind} (not in META_CLI_SUPPORTED_OPERATIONS)`,
        logPayload: { reason: "unsupported_action", actionKind: action.kind },
      };
    }
    // regression fix: Apply 経路の MetaCli invocation refs に approvalRecordId を
    // 載せる。runExecuteApply は revalidation 成功時に
    // `ApplyJobContext.approvalRecordId` を `loadApplyApprovalSnapshot` から
    // 焼き付けており、この値が `toExecutionLogInput` 経由で execution_logs の
    // payload に保存され、Apply の各 CLI 実行を承認境界 (approval_records) と
    // 結び付ける。snapshot から取れなかった場合 (型上 null/undefined) は refs に
    // 載せない (toExecutionLogInput が undefined を skip する)。
    const refs: NonNullable<MetaCliInvocation["refs"]> = {
      refType: "apply_job",
      refId: input.context.applyJobId,
      pullRequestNumber: input.context.prNumber,
    };
    const approvalRecordId = input.context.approvalRecordId;
    if (typeof approvalRecordId === "string" && approvalRecordId.length > 0) {
      refs.approvalRecordId = approvalRecordId;
    }
    const graphRefs: GraphApplyRefs = {
      refType: "apply_job",
      refId: input.context.applyJobId,
      pullRequestNumber: input.context.prNumber,
      ...(typeof approvalRecordId === "string" && approvalRecordId.length > 0
        ? { approvalRecordId }
        : {}),
    };
    const invocation: MetaCliInvocation = {
      accountKey: action.account,
      adAccountId: this.resolveAdAccountId
        ? await this.resolveAdAccountId(action.account)
        : action.account,
      args: args.args,
      refs,
    };
    // regression fix: pre-spawn failure paths (version_unverified / load_token /
    // unsupported_op など) は spawned 実行と同じ canonical command-evidence shape
    // (stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/throttleHeaders/
    // exitClass/recommendedAction) を logPayload に含める。null/sanitized 値で埋め、
    // 失敗ステージ固有のフィールド (mode/stage/errorName/verification 等) を envelope の
    // 上にマージする。
    const sanitizedCommand = `meta-ads-cli ${args.args.join(" ")}`;

    if (action.kind === "create_creative") {
      return this.executeGraphCreateCreative({
        action: action as CreateCreativeApplyAction,
        invocation,
        refs: graphRefs,
        args,
        sanitizedCommand,
      });
    }

    // regression fix: Meta token が無い / 期限切れ / 復号失敗 の場合、
    // runner.run() は loadTokenForAccount から MetaCliMissingTokenError /
    // MetaTokenExpiredError / MetaAdapterUnauthenticatedError を伝播させる。
    // これは「mock fallback」ではなく auth_error / reauth として扱う必要があるため、
    // ExecuteActionResult に直接マップして runExecuteApply の reauth audit 経路を駆動する。
    //
    // regression fix: CLI binary/version が未検証の場合、runner.run() は
    // MetaCliVersionUnverifiedError を投げて spawn を拒否する。auth と同様に
    // mock fallback ではなく unknown_error + meta.cli_unknown_error notify として
    // 扱い、運用者に CLI のインストール / アップグレードを促す。
    let result;
    try {
      result = await this.runner.run(invocation);
    } catch (err) {
      if (err instanceof MetaCliVersionUnverifiedError) {
        const detail = err.message;
        const verification = err.verification;
        // regression fix: pre-spawn 失敗でも spawned 実行 (toExecutionLogInput) と
        // 同じく refs.pullRequestNumber / refs.approvalRecordId を payload に焼き付け、
        // 失敗パスだけ承認境界 / PR 紐付けが欠落しないようにする。
        const envelope = prefailedPayloadEnvelope({
          exitClass: "unknown_error",
          stderr: detail,
          binary: null,
          accountKey: action.account,
          sanitizedCommand,
          sanitizedArgs: args.args,
          pullRequestNumber: input.context.prNumber,
          ...(typeof approvalRecordId === "string" &&
          approvalRecordId.length > 0
            ? { approvalRecordId }
            : {}),
        });
        return {
          status: "unknown_error",
          message: `meta-ads-cli ${args.resource} ${args.verb} aborted before spawn: CLI version not verified`,
          logPayload: {
            ...envelope,
            mode: "cli",
            stage: "verify_version",
            errorName: err.name,
            errorMessage: detail,
            resource: args.resource,
            verb: args.verb,
            verification: verification
              ? {
                  ok: verification.ok,
                  actualVersion: verification.actualVersion,
                  minVersion: verification.minVersion,
                  detail: verification.detail,
                }
              : null,
          } satisfies JsonValue,
          notify: {
            auditAction: "meta.cli_unknown_error",
            detail,
          },
        };
      }
      if (
        err instanceof MetaCliMissingTokenError ||
        err instanceof MetaTokenExpiredError ||
        err instanceof MetaAdapterUnauthenticatedError
      ) {
        const detail = err.message;
        // regression fix: 同上。auth_error 経路でも refs を payload に焼き付ける。
        const envelope = prefailedPayloadEnvelope({
          exitClass: "auth_error",
          stderr: detail,
          binary: null,
          accountKey: action.account,
          sanitizedCommand,
          sanitizedArgs: args.args,
          pullRequestNumber: input.context.prNumber,
          ...(typeof approvalRecordId === "string" &&
          approvalRecordId.length > 0
            ? { approvalRecordId }
            : {}),
        });
        return {
          status: "auth_error",
          message: `meta-ads-cli ${args.resource} ${args.verb} aborted before spawn: ${detail}`,
          logPayload: {
            ...envelope,
            mode: "cli",
            stage: "load_token",
            errorName: err.name,
            errorMessage: detail,
            resource: args.resource,
            verb: args.verb,
          } satisfies JsonValue,
          notify: {
            auditAction: "oauth.meta.reauth_required",
            detail,
          },
        };
      }
      throw err;
    }
    const logInput = toExecutionLogInput(result, invocation.refs);

    // regression fix: status mapping は MetaCliExitClass を 1:1 で射影する。
    // exit class は cli-runner の `classifyExit` が auth/rate/api/unknown に
    // 区別済みなので、ここで再分類しない (recommendedAction が retry/notify を
    // 駆動する単一情報源になる)。
    const status: ExecuteActionResult["status"] =
      result.exitClass === "success"
        ? "success"
        : result.exitClass === "auth_error"
          ? "auth_error"
          : result.exitClass === "rate_limit_error"
            ? "rate_limit_error"
            : result.exitClass === "api_error"
              ? "api_error"
              : "unknown_error";

    const out: ExecuteActionResult = {
      status,
      message: logInput.message,
      logPayload: logInput.payload as unknown as JsonValue,
    };

    // regression fix: success かつ create_* のときは Meta CLI stdout から
    // external_id を抽出して result に乗せる。queue 側 runExecuteApply は
    // ここで externalId が undefined のままだと create_* を fail-closed して
    // ads_hierarchy に null externalId 行を作らないため、抽出可否がそのまま
    // Activate 経路の可用性を決める。
    if (status === "success" && actionRequiresExternalId(action)) {
      const ext = extractExternalIdFromCliStdout(result.stdout);
      if (ext) out.externalId = ext;
    }
    if (
      status === "success" &&
      action.kind === "meta_cli_operation" &&
      out.externalId &&
      action.entity?.nodeType &&
      action.entity.nodeKey
    ) {
      this.createdOperationExternalIds.set(
        `${action.account}:${action.entity.nodeType}:${action.entity.nodeKey}`,
        out.externalId,
      );
    }

    // regression fix: production 経路は recommendedAction を読み、
    //   - retry_with_backoff → ExecuteActionResult.retry を埋める
    //   - notify_reauth / notify_api_error / fail_fast_notify → notify を埋める
    // ことでオーケストレータに「何を再試行し、何を通知するか」を伝える。
    // exit class を switch する従来の経路を廃止し、recommendedAction を
    // 単一情報源にする。
    const rec = result.recommendedAction;
    if (rec.kind === "retry_with_backoff") {
      const attempt = input.attempt;
      const delay = Math.min(
        rec.maxBackoffMs,
        rec.initialBackoffMs * Math.pow(2, attempt),
      );
      out.retry = {
        delayMs: delay,
        maxAttempts: rec.maxAttempts,
      };
    } else if (
      rec.kind === "notify_reauth" ||
      rec.kind === "notify_api_error" ||
      rec.kind === "fail_fast_notify"
    ) {
      out.notify = {
        auditAction: rec.auditAction,
        detail: rec.reason,
      };
    }
    return out;
  }

  private rewriteActionRefs(action: ApplyAction): ApplyAction {
    if (action.kind === "meta_cli_operation")
      return this.rewriteOperationRefs(action);
    if (action.kind !== "create_ad") return action;
    const resolved = this.createdCreativeExternalIds.get(
      `${action.account}:${action.creativeRef}`,
    );
    return resolved ? { ...action, creativeRef: resolved } : action;
  }

  private rewriteOperationRefs(
    action: Extract<ApplyAction, { kind: "meta_cli_operation" }>,
  ): ApplyAction {
    const args = action.args.map((arg) =>
      arg.replace(
        /\{\{([A-Za-z0-9_-]+):([^}]+)\}\}/g,
        (match, nodeType: string, nodeKey: string) =>
          this.createdOperationExternalIds.get(
            `${action.account}:${nodeType}:${nodeKey}`,
          ) ?? match,
      ),
    );
    return args.some((arg, index) => arg !== action.args[index])
      ? { ...action, args }
      : action;
  }

  private async executeGraphCreateCreative(input: {
    action: CreateCreativeApplyAction;
    invocation: MetaCliInvocation;
    refs: GraphApplyRefs;
    args: { args: string[]; resource: string; verb: string };
    sanitizedCommand: string;
  }): Promise<ExecuteActionResult> {
    const startedAt = new Date();
    const accountKey = input.action.account;
    const adAccountId = input.invocation.adAccountId ?? accountKey;
    const finish = () => new Date();
    const duration = (finishedAt: Date) =>
      finishedAt.getTime() - startedAt.getTime();
    try {
      const lease = await this.metaAdapter.loadAccessTokenPlaintext();
      if (!lease) throw new MetaCliMissingTokenError(accountKey);
      const actionRecord = input.action as unknown as Record<string, unknown>;
      if (isCarouselCreative(actionRecord)) {
        const cards = requireCarouselCards(actionRecord);
        const preflight = await this.validateCreativeIdentity({
          accessToken: lease.accessToken,
          adAccountId,
          pageId: input.action.pageId ?? null,
          instagramUserId: input.action.instagramUserId ?? null,
        });
        const imageHashes: string[] = [];
        for (const card of cards) {
          const uploaded = await postGraphMultipart(
            `${adAccountId}/adimages`,
            lease.accessToken,
            {},
            { field: "source", path: fileArg(card.storageKey) },
          );
          const imageHash = extractImageHash(uploaded.json);
          if (!imageHash) {
            throw new MetaGraphApplyError({
              message: `Meta Graph adimages response did not include an image hash for carousel card ${card.position}`,
              exitClass: "unknown_error",
              status: uploaded.status,
              payload: uploaded.json as JsonValue,
            });
          }
          imageHashes.push(imageHash);
        }
        const objectStorySpec = buildCarouselCreativeObjectStorySpec(
          input.action,
          cards,
          imageHashes,
        );
        const created = await postGraphJson(
          `${adAccountId}/adcreatives`,
          lease.accessToken,
          {
            name: input.action.name,
            object_story_spec: JSON.stringify(objectStorySpec),
          },
        );
        const externalId = extractId(created.json);
        if (!externalId) {
          throw new MetaGraphApplyError({
            message: "Meta Graph adcreatives response did not include id",
            exitClass: "unknown_error",
            status: created.status,
            payload: created.json as JsonValue,
          });
        }
        this.createdCreativeExternalIds.set(
          `${accountKey}:${input.action.creativeId}`,
          externalId,
        );
        const finishedAt = finish();
        return {
          status: "success",
          message: `meta graph creatives create succeeded (${externalId})`,
          externalId,
          logPayload: graphLogPayload({
            accountKey,
            action: input.action,
            resource: input.args.resource,
            verb: input.args.verb,
            sanitizedCommand: input.sanitizedCommand.replace(
              /^meta-ads-cli /,
              "meta-graph-api ",
            ),
            sanitizedArgs: input.args.args,
            refs: input.refs,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: duration(finishedAt),
            exitClass: "success",
            stdout: JSON.stringify({ id: externalId }),
            response: created.json as JsonValue,
            preflight: preflight as JsonValue,
          }),
        };
      }
      if (input.action.mediaType !== "image" || !input.action.storageKey) {
        throw new MetaGraphApplyError({
          message:
            "Meta Graph creative apply currently requires image media with storageKey",
          exitClass: "api_error",
          payload: {
            mediaType: input.action.mediaType,
            hasStorageKey: Boolean(input.action.storageKey),
          },
        });
      }
      const preflight = await this.validateCreativeIdentity({
        accessToken: lease.accessToken,
        adAccountId,
        pageId: input.action.pageId ?? null,
        instagramUserId: input.action.instagramUserId ?? null,
      });
      const imagePath = fileArg(input.action.storageKey);
      const uploaded = await postGraphMultipart(
        `${adAccountId}/adimages`,
        lease.accessToken,
        {},
        { field: "source", path: imagePath },
      );
      const imageHash = extractImageHash(uploaded.json);
      if (!imageHash) {
        throw new MetaGraphApplyError({
          message: "Meta Graph adimages response did not include an image hash",
          exitClass: "unknown_error",
          status: uploaded.status,
          payload: uploaded.json as JsonValue,
        });
      }
      const objectStorySpec = buildImageCreativeObjectStorySpec(
        input.action,
        imageHash,
      );
      const created = await postGraphJson(
        `${adAccountId}/adcreatives`,
        lease.accessToken,
        {
          name: input.action.name,
          object_story_spec: JSON.stringify(objectStorySpec),
        },
      );
      const externalId = extractId(created.json);
      if (!externalId) {
        throw new MetaGraphApplyError({
          message: "Meta Graph adcreatives response did not include id",
          exitClass: "unknown_error",
          status: created.status,
          payload: created.json as JsonValue,
        });
      }
      this.createdCreativeExternalIds.set(
        `${accountKey}:${input.action.creativeId}`,
        externalId,
      );
      const finishedAt = finish();
      return {
        status: "success",
        message: `meta graph creatives create succeeded (${externalId})`,
        externalId,
        logPayload: graphLogPayload({
          accountKey,
          action: input.action,
          resource: input.args.resource,
          verb: input.args.verb,
          sanitizedCommand: input.sanitizedCommand.replace(
            /^meta-ads-cli /,
            "meta-graph-api ",
          ),
          sanitizedArgs: input.args.args,
          refs: input.refs,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: duration(finishedAt),
          exitClass: "success",
          stdout: JSON.stringify({ id: externalId }),
          response: created.json as JsonValue,
          preflight: preflight as JsonValue,
        }),
      };
    } catch (err) {
      const finishedAt = finish();
      if (
        err instanceof MetaCliMissingTokenError ||
        err instanceof MetaTokenExpiredError ||
        err instanceof MetaAdapterUnauthenticatedError
      ) {
        const detail = err.message;
        return {
          status: "auth_error",
          message: `meta graph creatives create aborted before request: ${detail}`,
          logPayload: graphLogPayload({
            accountKey,
            action: input.action,
            resource: input.args.resource,
            verb: input.args.verb,
            sanitizedCommand: input.sanitizedCommand.replace(
              /^meta-ads-cli /,
              "meta-graph-api ",
            ),
            sanitizedArgs: input.args.args,
            refs: input.refs,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: duration(finishedAt),
            exitClass: "auth_error",
            stderr: detail,
          }),
          notify: { auditAction: "oauth.meta.reauth_required", detail },
        };
      }
      if (err instanceof MetaGraphApplyError) {
        const rec = recommendActionForExit(err.exitClass);
        const status: ExecuteActionResult["status"] =
          err.exitClass === "auth_error"
            ? "auth_error"
            : err.exitClass === "rate_limit_error"
              ? "rate_limit_error"
              : err.exitClass === "api_error"
                ? "api_error"
                : "unknown_error";
        const out: ExecuteActionResult = {
          status,
          message: `meta graph creatives create failed: ${err.message}`,
          logPayload: graphLogPayload({
            accountKey,
            action: input.action,
            resource: input.args.resource,
            verb: input.args.verb,
            sanitizedCommand: input.sanitizedCommand.replace(
              /^meta-ads-cli /,
              "meta-graph-api ",
            ),
            sanitizedArgs: input.args.args,
            refs: input.refs,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: duration(finishedAt),
            exitClass: err.exitClass,
            stderr: err.message,
            statusCode: err.status,
            response: err.payload,
          }),
        };
        if (rec.kind === "retry_with_backoff") {
          const attempt = 0;
          out.retry = {
            delayMs: Math.min(
              rec.maxBackoffMs,
              rec.initialBackoffMs * Math.pow(2, attempt),
            ),
            maxAttempts: rec.maxAttempts,
          };
        } else if (
          rec.kind === "notify_reauth" ||
          rec.kind === "notify_api_error" ||
          rec.kind === "fail_fast_notify"
        ) {
          out.notify = { auditAction: rec.auditAction, detail: rec.reason };
        }
        return out;
      }
      throw err;
    }
  }

  private async validateCreativeIdentity(input: {
    accessToken: string;
    adAccountId: string;
    pageId: string | null;
    instagramUserId: string | null;
  }): Promise<Record<string, JsonValue>> {
    const report = await fetchMetaAssetReadiness({
      accessToken: input.accessToken,
      adAccountId: input.adAccountId,
      pageId: input.pageId,
      instagramUserId: input.instagramUserId,
      limit: 100,
    });
    return report as unknown as Record<string, JsonValue>;
  }
}

// ---------------------------------------------------------------------
// GraphApplyExecutor — canonical Meta Graph API route
// ---------------------------------------------------------------------

export interface GraphApplyExecutorOptions {
  metaAdapter: MetaAdapter;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null>;
  resolveAdAccountCurrency?: (accountKey: string) => Promise<string | null>;
}

export class GraphApplyExecutor implements MetaActionExecutor {
  private readonly metaAdapter: MetaAdapter;
  private readonly resolveAdAccountId?: (
    accountKey: string,
  ) => Promise<string | null>;
  private readonly resolveAdAccountCurrency?: (
    accountKey: string,
  ) => Promise<string | null>;
  private readonly refs = new Map<string, string>();

  constructor(opts: GraphApplyExecutorOptions) {
    this.metaAdapter = opts.metaAdapter;
    this.resolveAdAccountId = opts.resolveAdAccountId;
    this.resolveAdAccountCurrency = opts.resolveAdAccountCurrency;
  }

  async executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const action = this.toGraphAction(input.action);
    if (!action) {
      return {
        status: "skipped",
        message: `unsupported action kind ${input.action.kind} skipped by Graph executor`,
        logPayload: {
          reason: "unsupported_action",
          actionKind: input.action.kind,
        },
      };
    }
    const startedAt = new Date();
    const accountKey = action.account;
    const [resource, verb] = action.kind.split(".") as [string, string];
    const refs: GraphApplyRefs = {
      refType: "apply_job",
      refId: input.context.applyJobId,
      pullRequestNumber: input.context.prNumber,
      ...(typeof input.context.approvalRecordId === "string" &&
      input.context.approvalRecordId.length > 0
        ? { approvalRecordId: input.context.approvalRecordId }
        : {}),
    };
    const sanitizedCommand = `meta-graph-api ${action.kind}`;
    const finish = () => new Date();
    const duration = (finishedAt: Date) =>
      finishedAt.getTime() - startedAt.getTime();
    try {
      const lease = await this.metaAdapter.loadAccessTokenPlaintext();
      if (!lease) throw new MetaCliMissingTokenError(accountKey);
      const adAccountId =
        (this.resolveAdAccountId
          ? await this.resolveAdAccountId(accountKey)
          : null) ?? accountKey;
      const currency =
        (this.resolveAdAccountCurrency
          ? await this.resolveAdAccountCurrency(accountKey)
          : null) ?? "USD";
      const result = await this.executeGraphAction({
        action,
        accessToken: lease.accessToken,
        adAccountId,
        accountCurrency: currency,
      });
      if (result.externalId) this.rememberRef(action, result.externalId);
      const finishedAt = finish();
      return {
        status: "success",
        message: `meta graph ${action.kind} succeeded${result.externalId ? ` (${result.externalId})` : ""}`,
        ...(result.externalId ? { externalId: result.externalId } : {}),
        logPayload: graphLogPayload({
          accountKey,
          action,
          resource,
          verb,
          sanitizedCommand,
          sanitizedArgs: [action.kind],
          refs,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: duration(finishedAt),
          exitClass: "success",
          stdout: result.externalId
            ? JSON.stringify({ id: result.externalId })
            : "",
          response: result.response,
          preflight: result.preflight,
        }),
      };
    } catch (err) {
      const finishedAt = finish();
      if (
        err instanceof MetaCliMissingTokenError ||
        err instanceof MetaTokenExpiredError ||
        err instanceof MetaAdapterUnauthenticatedError
      ) {
        const detail = err.message;
        return {
          status: "auth_error",
          message: `meta graph ${action.kind} aborted before request: ${detail}`,
          logPayload: graphLogPayload({
            accountKey,
            action,
            resource,
            verb,
            sanitizedCommand,
            sanitizedArgs: [action.kind],
            refs,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: duration(finishedAt),
            exitClass: "auth_error",
            stderr: detail,
          }),
          notify: { auditAction: "oauth.meta.reauth_required", detail },
        };
      }
      if (err instanceof MetaGraphApplyError) {
        const rec = recommendActionForExit(err.exitClass);
        const status: ExecuteActionResult["status"] =
          err.exitClass === "auth_error"
            ? "auth_error"
            : err.exitClass === "rate_limit_error"
              ? "rate_limit_error"
              : err.exitClass === "api_error"
                ? "api_error"
                : "unknown_error";
        const out: ExecuteActionResult = {
          status,
          message: `meta graph ${action.kind} failed: ${err.message}`,
          logPayload: graphLogPayload({
            accountKey,
            action,
            resource,
            verb,
            sanitizedCommand,
            sanitizedArgs: [action.kind],
            refs,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: duration(finishedAt),
            exitClass: err.exitClass,
            stderr: err.message,
            statusCode: err.status,
            response: err.payload,
          }),
        };
        if (rec.kind === "retry_with_backoff") {
          out.retry = {
            delayMs: Math.min(
              rec.maxBackoffMs,
              rec.initialBackoffMs * Math.pow(2, input.attempt),
            ),
            maxAttempts: rec.maxAttempts,
          };
        } else if (
          rec.kind === "notify_reauth" ||
          rec.kind === "notify_api_error" ||
          rec.kind === "fail_fast_notify"
        ) {
          out.notify = { auditAction: rec.auditAction, detail: rec.reason };
        }
        return out;
      }
      throw err;
    }
  }

  private async executeGraphAction(input: {
    action: GraphOperationAction;
    accessToken: string;
    adAccountId: string;
    accountCurrency: string;
  }): Promise<{
    externalId?: string;
    response: JsonValue;
    preflight?: JsonValue;
  }> {
    const { action, accessToken, adAccountId, accountCurrency } = input;
    const payload = resolvePayloadRefs(action.payload, this.refs);
    switch (action.kind) {
      case "campaign.create": {
        const created = await postGraphJson(
          `${adAccountId}/campaigns`,
          accessToken,
          graphCampaignCreatePayload(payload, accountCurrency),
        );
        return requireGraphId(created.json, "campaign.create");
      }
      case "campaign.update":
      case "campaign.status": {
        const id = requireTargetId(payload, "campaignId", action);
        const updated = await postGraphJson(
          id,
          accessToken,
          graphUpdatePayload(payload, accountCurrency),
        );
        return { externalId: id, response: updated.json as JsonValue };
      }
      case "campaign.delete": {
        const id = requireTargetId(payload, "campaignId", action);
        const deleted = await postGraphJson(id, accessToken, {
          status: "DELETED",
        });
        return { externalId: id, response: deleted.json as JsonValue };
      }
      case "adset.create": {
        const created = await postGraphJson(
          `${adAccountId}/adsets`,
          accessToken,
          graphAdsetCreatePayload(payload, accountCurrency),
        );
        return requireGraphId(created.json, "adset.create");
      }
      case "adset.update":
      case "adset.status": {
        const id = requireTargetId(payload, "adsetId", action);
        const updated = await postGraphJson(
          id,
          accessToken,
          graphUpdatePayload(payload, accountCurrency),
        );
        return { externalId: id, response: updated.json as JsonValue };
      }
      case "adset.delete": {
        const id = requireTargetId(payload, "adsetId", action);
        const deleted = await postGraphJson(id, accessToken, {
          status: "DELETED",
        });
        return { externalId: id, response: deleted.json as JsonValue };
      }
      case "creative.create":
        return this.executeCreativeCreate({
          action,
          payload,
          accessToken,
          adAccountId,
        });
      case "creative.update": {
        const id = requireTargetId(payload, "creativeId", action);
        const updated = await postGraphJson(
          id,
          accessToken,
          graphCreativeUpdatePayload(payload),
        );
        return { externalId: id, response: updated.json as JsonValue };
      }
      case "creative.delete": {
        const id = requireTargetId(payload, "creativeId", action);
        const deleted = await postGraphJson(id, accessToken, {
          status: "DELETED",
        });
        return { externalId: id, response: deleted.json as JsonValue };
      }
      case "ad.create": {
        const created = await postGraphJson(
          `${adAccountId}/ads`,
          accessToken,
          graphAdCreatePayload(payload),
        );
        return requireGraphId(created.json, "ad.create");
      }
      case "ad.update":
      case "ad.status": {
        const id = requireTargetId(payload, "adId", action);
        const updated = await postGraphJson(
          id,
          accessToken,
          graphUpdatePayload(payload, accountCurrency),
        );
        return { externalId: id, response: updated.json as JsonValue };
      }
      case "ad.delete": {
        const id = requireTargetId(payload, "adId", action);
        const deleted = await postGraphJson(id, accessToken, {
          status: "DELETED",
        });
        return { externalId: id, response: deleted.json as JsonValue };
      }
      default:
        throw new MetaGraphApplyError({
          message: `unsupported Graph operation kind: ${action.kind}`,
          exitClass: "api_error",
        });
    }
  }

  private async executeCreativeCreate(input: {
    action: GraphOperationAction;
    payload: Record<string, unknown>;
    accessToken: string;
    adAccountId: string;
  }): Promise<{
    externalId?: string;
    response: JsonValue;
    preflight?: JsonValue;
  }> {
    const { action, payload, accessToken, adAccountId } = input;
    const pageId = readGraphString(payload, "pageId");
    const instagramUserId = readGraphString(payload, "instagramUserId");
    if (isCarouselCreative(payload)) {
      const cards = requireCarouselCards(payload);
      const preflight = await fetchMetaAssetReadiness({
        accessToken,
        adAccountId,
        pageId: pageId ?? undefined,
        instagramUserId: instagramUserId ?? undefined,
        limit: 100,
      });
      const imageHashes: string[] = [];
      for (const card of cards) {
        const uploaded = await postGraphMultipart(
          `${adAccountId}/adimages`,
          accessToken,
          {},
          { field: "source", path: fileArg(card.storageKey) },
        );
        const imageHash = extractImageHash(uploaded.json);
        if (!imageHash) {
          throw new MetaGraphApplyError({
            message: `Meta Graph adimages response did not include an image hash for carousel card ${card.position}`,
            exitClass: "unknown_error",
            status: uploaded.status,
            payload: uploaded.json as JsonValue,
          });
        }
        imageHashes.push(imageHash);
      }
      const objectStorySpec = buildGraphCarouselObjectStorySpec(
        payload,
        cards,
        imageHashes,
      );
      const created = await postGraphJson(
        `${adAccountId}/adcreatives`,
        accessToken,
        graphCreativeCreatePayload(payload, {
          name:
            readGraphString(payload, "name") ??
            action.entity?.nodeKey ??
            action.ref ??
            "AdDroid Carousel Creative",
          object_story_spec: objectStorySpec,
        }),
      );
      return {
        ...requireGraphId(created.json, "creative.create"),
        preflight: preflight as unknown as JsonValue,
      };
    }
    let imageHash = readGraphString(payload, "imageHash");
    const storageKey = readGraphString(payload, "storageKey");
    const storagePath =
      !imageHash && storageKey ? fileArg(storageKey) : undefined;
    const preflight = await fetchMetaAssetReadiness({
      accessToken,
      adAccountId,
      pageId: pageId ?? undefined,
      instagramUserId: instagramUserId ?? undefined,
      limit: 100,
    });
    if (!imageHash && storagePath) {
      const uploaded = await postGraphMultipart(
        `${adAccountId}/adimages`,
        accessToken,
        {},
        { field: "source", path: storagePath },
      );
      imageHash = extractImageHash(uploaded.json) ?? undefined;
    }
    const graphPayload = sanitizeGraphPayload(payload.graphPayload);
    const hasExplicitCreativeGraphShape =
      isRecord(payload.objectStorySpec) ||
      isRecord(graphPayload.object_story_spec) ||
      isRecord(payload.assetFeedSpec) ||
      isRecord(graphPayload.asset_feed_spec) ||
      Boolean(
        readGraphString(payload, "videoId") ??
        (typeof graphPayload.video_id === "string"
          ? graphPayload.video_id
          : null),
      );
    const objectStorySpec = isRecord(payload.objectStorySpec)
      ? payload.objectStorySpec
      : isRecord(graphPayload.object_story_spec)
        ? undefined
        : hasExplicitCreativeGraphShape
          ? removeUndefinedGraph({
              page_id: readGraphString(payload, "pageId"),
            })
          : buildGraphImageObjectStorySpec(payload, imageHash);
    const created = await postGraphJson(
      `${adAccountId}/adcreatives`,
      accessToken,
      graphCreativeCreatePayload(payload, {
        name:
          readGraphString(payload, "name") ??
          action.entity?.nodeKey ??
          action.ref ??
          "AdDroid Creative",
        object_story_spec: objectStorySpec,
      }),
    );
    return {
      ...requireGraphId(created.json, "creative.create"),
      preflight: preflight as unknown as JsonValue,
    };
  }

  private toGraphAction(action: ApplyAction): GraphOperationAction | null {
    if (action.kind.includes(".")) return action as GraphOperationAction;
    return legacyActionToGraph(action);
  }

  private rememberRef(action: GraphOperationAction, externalId: string): void {
    if (action.ref) this.refs.set(action.ref, externalId);
    if (action.entity?.nodeType && action.entity.nodeKey) {
      this.refs.set(
        `${action.entity.nodeType}:${action.entity.nodeKey}`,
        externalId,
      );
      this.refs.set(
        `{{${action.entity.nodeType}:${action.entity.nodeKey}}}`,
        externalId,
      );
    }
  }
}

function legacyActionToGraph(action: ApplyAction): GraphOperationAction | null {
  if (action.kind === "meta_cli_operation") return null;
  const account = action.account;
  switch (action.kind) {
    case "create_campaign":
      return {
        kind: "campaign.create",
        account,
        ref: `campaign:${action.campaignId}`,
        payload: {
          campaignId: action.campaignId,
          name: action.name,
          objective: action.objective,
          status: action.initialState ?? "PAUSED",
          specialAdCategories: ["NONE"],
          ...(action.budget ?? {}),
        },
        entity: {
          nodeType: "campaign",
          nodeKey: String(action.campaignId),
          displayName: String(action.name ?? action.campaignId),
          status: normalizeGraphEntityStatus(action.initialState),
        },
        externalIdRequired: true,
      };
    case "update_campaign":
      return {
        kind: "campaign.update",
        account,
        payload: {
          campaignId: action.campaignId,
          ...changesToPayload(action.changes),
        },
        entity: { nodeType: "campaign", nodeKey: String(action.campaignId) },
      };
    case "delete_campaign":
      return {
        kind: "campaign.delete",
        account,
        payload: { campaignId: action.campaignId },
        entity: {
          nodeType: "campaign",
          nodeKey: String(action.campaignId),
          status: "archived",
        },
      };
    case "create_adset":
      return {
        kind: "adset.create",
        account,
        ref: `adset:${action.adsetId}`,
        payload: {
          adsetId: action.adsetId,
          campaignId: action.campaignId,
          name: action.name,
          status: action.initialState ?? "PAUSED",
          optimizationGoal: action.optimizationGoal,
          billingEvent: action.billingEvent,
          ...(action.budget ?? {}),
          bidAmount: action.bidAmount,
          startTime: action.startTime,
          endTime: action.endTime,
          targeting: action.targeting,
          pixelId: action.pixelId,
          customEventType: action.customEventType,
        },
        entity: {
          nodeType: "adset",
          nodeKey: String(action.adsetId),
          displayName: String(action.name ?? action.adsetId),
          parentNodeType: "campaign",
          parentNodeKey: String(action.campaignId),
          status: normalizeGraphEntityStatus(action.initialState),
        },
        externalIdRequired: true,
      };
    case "update_adset":
      return {
        kind: "adset.update",
        account,
        payload: {
          adsetId: action.adsetId,
          ...changesToPayload(action.changes),
        },
        entity: {
          nodeType: "adset",
          nodeKey: String(action.adsetId),
          parentNodeType: "campaign",
          parentNodeKey: String(action.campaignId),
        },
      };
    case "delete_adset":
      return {
        kind: "adset.delete",
        account,
        payload: { adsetId: action.adsetId },
        entity: {
          nodeType: "adset",
          nodeKey: String(action.adsetId),
          status: "archived",
        },
      };
    case "create_creative":
      return {
        kind: "creative.create",
        account,
        ref: `creative:${action.creativeId}`,
        payload: { ...action, creativeId: action.creativeId },
        entity: {
          nodeType: "creative",
          nodeKey: String(action.creativeId),
          displayName: String(action.name ?? action.creativeId),
        },
        externalIdRequired: true,
      };
    case "update_creative":
      return {
        kind: "creative.update",
        account,
        payload: {
          creativeId: action.creativeId,
          ...changesToPayload(action.changes),
        },
        entity: { nodeType: "creative", nodeKey: String(action.creativeId) },
      };
    case "delete_creative":
      return {
        kind: "creative.delete",
        account,
        payload: { creativeId: action.creativeId },
        entity: { nodeType: "creative", nodeKey: String(action.creativeId) },
      };
    case "create_ad":
      return {
        kind: "ad.create",
        account,
        ref: `ad:${action.adId}`,
        payload: {
          adId: action.adId,
          adsetId: action.adsetId,
          name: action.name,
          creativeRef: action.creativeRef,
          status: action.initialState ?? "PAUSED",
          trackingSpecs: action.trackingSpecs,
          pixelId: action.pixelId,
        },
        entity: {
          nodeType: "ad",
          nodeKey: String(action.adId),
          displayName: String(action.name ?? action.adId),
          parentNodeType: "adset",
          parentNodeKey: String(action.adsetId),
          status: normalizeGraphEntityStatus(action.initialState),
        },
        externalIdRequired: true,
      };
    case "update_ad":
      return {
        kind: "ad.update",
        account,
        payload: { adId: action.adId, ...changesToPayload(action.changes) },
        entity: {
          nodeType: "ad",
          nodeKey: String(action.adId),
          parentNodeType: "adset",
          parentNodeKey: String(action.adsetId),
        },
      };
    case "delete_ad":
      return {
        kind: "ad.delete",
        account,
        payload: { adId: action.adId },
        entity: {
          nodeType: "ad",
          nodeKey: String(action.adId),
          status: "archived",
        },
      };
    default:
      return null;
  }
}

function changesToPayload(changes: unknown): Record<string, unknown> {
  if (!isRecord(changes)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (isRecord(value) && "to" in value) out[key] = value.to;
    else out[key] = value;
  }
  return out;
}

function resolvePayloadRefs(
  payload: Record<string, unknown>,
  refs: Map<string, string>,
): Record<string, unknown> {
  return resolveGraphRefsDeep(payload, refs) as Record<string, unknown>;
}

function resolveGraphRefsDeep(
  value: unknown,
  refs: Map<string, string>,
): unknown {
  if (typeof value === "string") {
    return refs.get(value) ?? refs.get(stripOperationRef(value)) ?? value;
  }
  if (Array.isArray(value))
    return value.map((item) => resolveGraphRefsDeep(item, refs));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = resolveGraphRefsDeep(item, refs);
    return out;
  }
  return value;
}

function stripOperationRef(value: string): string {
  const match = /^\{\{([^}]+)\}\}$/.exec(value);
  return match?.[1] ?? value;
}

function graphCampaignCreatePayload(
  payload: Record<string, unknown>,
  accountCurrency: string,
): Record<string, unknown> {
  return mergeGraphPayload(payload, {
    name: readGraphString(payload, "name"),
    objective: readGraphString(payload, "objective"),
    status: readGraphString(payload, "status") ?? "PAUSED",
    buying_type: readGraphString(payload, "buyingType"),
    special_ad_categories: payload.specialAdCategories,
    special_ad_category_country:
      payload.specialAdCategoryCountry ?? payload.specialAdCategoryCountries,
    daily_budget: moneyField(payload.dailyBudget, accountCurrency),
    lifetime_budget: moneyField(payload.lifetimeBudget, accountCurrency),
    bid_strategy: readGraphString(payload, "bidStrategy"),
    spend_cap: moneyField(payload.spendCap, accountCurrency),
    start_time: readGraphString(payload, "startTime"),
    stop_time: readGraphString(payload, "stopTime"),
    is_adset_budget_sharing_enabled:
      payload.isAdsetBudgetSharingEnabled ?? payload.adsetBudgetSharing,
    pacing_type: payload.pacingType,
    smart_promotion_type: readGraphString(payload, "smartPromotionType"),
    promoted_object: payload.promotedObject,
  });
}

function graphAdsetCreatePayload(
  payload: Record<string, unknown>,
  accountCurrency: string,
): Record<string, unknown> {
  const countries = readCountriesFromPayload(payload);
  const targeting = isRecord(payload.targeting)
    ? payload.targeting
    : countries.length > 0
      ? { geo_locations: { countries } }
      : undefined;
  const promotedObject = isRecord(payload.promotedObject)
    ? payload.promotedObject
    : buildPromotedObject(payload);
  return mergeGraphPayload(payload, {
    campaign_id:
      readGraphString(payload, "campaignId") ??
      readGraphString(payload, "campaignRef"),
    name: readGraphString(payload, "name"),
    status: readGraphString(payload, "status") ?? "PAUSED",
    optimization_goal: readGraphString(payload, "optimizationGoal"),
    optimization_sub_event: readGraphString(payload, "optimizationSubEvent"),
    billing_event: readGraphString(payload, "billingEvent"),
    daily_budget: moneyField(payload.dailyBudget, accountCurrency),
    lifetime_budget: moneyField(payload.lifetimeBudget, accountCurrency),
    bid_amount: moneyField(payload.bidAmount, accountCurrency),
    bid_strategy: readGraphString(payload, "bidStrategy"),
    bid_constraints: payload.bidConstraints,
    start_time: readGraphString(payload, "startTime"),
    end_time: readGraphString(payload, "endTime"),
    targeting,
    promoted_object:
      Object.keys(promotedObject).length > 0 ? promotedObject : undefined,
    destination_type: readGraphString(payload, "destinationType"),
    attribution_spec: payload.attributionSpec,
    frequency_control_specs: payload.frequencyControlSpecs,
    adset_schedule: payload.adsetSchedule,
    pacing_type: payload.pacingType,
    daily_spend_cap: moneyField(payload.dailySpendCap, accountCurrency),
    lifetime_spend_cap: moneyField(payload.lifetimeSpendCap, accountCurrency),
    daily_min_spend_target: moneyField(
      payload.dailyMinSpendTarget,
      accountCurrency,
    ),
    lifetime_min_spend_target: moneyField(
      payload.lifetimeMinSpendTarget,
      accountCurrency,
    ),
    is_dynamic_creative: payload.isDynamicCreative,
    asset_feed_id: readGraphString(payload, "assetFeedId"),
    dsa_beneficiary: readGraphString(payload, "dsaBeneficiary"),
    dsa_payor: readGraphString(payload, "dsaPayor"),
    regional_regulated_categories: payload.regionalRegulatedCategories,
  });
}

function graphAdCreatePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const creativeId =
    readGraphString(payload, "creativeId") ??
    readGraphString(payload, "creativeRef");
  return mergeGraphPayload(payload, {
    adset_id:
      readGraphString(payload, "adsetId") ??
      readGraphString(payload, "adsetRef"),
    name: readGraphString(payload, "name"),
    creative: creativeId ? { creative_id: creativeId } : undefined,
    status: readGraphString(payload, "status") ?? "PAUSED",
    tracking_specs: payload.trackingSpecs,
    conversion_specs: payload.conversionSpecs,
    conversion_domain: readGraphString(payload, "conversionDomain"),
    creative_asset_groups_spec: payload.creativeAssetGroupsSpec,
    engagement_audience: payload.engagementAudience,
    priority: payload.priority,
    display_sequence: payload.displaySequence,
    ad_schedule_start_time: readGraphString(payload, "adScheduleStartTime"),
    ad_schedule_end_time: readGraphString(payload, "adScheduleEndTime"),
  });
}

function graphUpdatePayload(
  payload: Record<string, unknown>,
  accountCurrency: string,
): Record<string, unknown> {
  return mergeGraphPayload(payload, {
    name: readGraphString(payload, "name"),
    status: readGraphString(payload, "status"),
    daily_budget: moneyField(payload.dailyBudget, accountCurrency),
    lifetime_budget: moneyField(payload.lifetimeBudget, accountCurrency),
    bid_amount: moneyField(payload.bidAmount, accountCurrency),
    bid_strategy: readGraphString(payload, "bidStrategy"),
    end_time: readGraphString(payload, "endTime"),
    tracking_specs: payload.trackingSpecs,
    conversion_specs: payload.conversionSpecs,
    conversion_domain: readGraphString(payload, "conversionDomain"),
    targeting: payload.targeting,
    promoted_object: payload.promotedObject,
    attribution_spec: payload.attributionSpec,
    optimization_sub_event: readGraphString(payload, "optimizationSubEvent"),
    destination_type: readGraphString(payload, "destinationType"),
  });
}

function graphCreativeUpdatePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return mergeGraphPayload(payload, {
    name: readGraphString(payload, "name"),
    title: readGraphString(payload, "title"),
    body:
      readGraphString(payload, "body") ??
      readGraphString(payload, "primaryText"),
    url_tags: readGraphString(payload, "urlTags"),
  });
}

function graphCreativeCreatePayload(
  payload: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  return mergeGraphPayload(payload, {
    ...base,
    object_story_spec: payload.objectStorySpec ?? base.object_story_spec,
    asset_feed_spec: payload.assetFeedSpec,
    degrees_of_freedom_spec: payload.degreesOfFreedomSpec,
    url_tags: readGraphString(payload, "urlTags"),
    image_crops: payload.imageCrops,
    platform_customizations: payload.platformCustomizations,
    video_id: readGraphString(payload, "videoId"),
    thumbnail_id: readGraphString(payload, "thumbnailId"),
    template_url_spec: payload.templateUrlSpec,
    product_set_id: readGraphString(payload, "productSetId"),
    destination_set_id: readGraphString(payload, "destinationSetId"),
    authorization_category: readGraphString(payload, "authorizationCategory"),
    ad_disclaimer_spec: payload.adDisclaimerSpec,
    branded_content_sponsor_page_id: readGraphString(
      payload,
      "brandedContentSponsorPageId",
    ),
  });
}

const TOP_LEVEL_GRAPH_PAYLOAD_DENYLIST = new Set([
  "access_token",
  "account_id",
  "id",
  "created_time",
  "updated_time",
  "effective_status",
  "configured_status",
  "issues_info",
  "recommendations",
]);

function mergeGraphPayload(
  payload: Record<string, unknown>,
  typedPayload: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefinedGraph({
    ...typedPayload,
    ...sanitizeGraphPayload(payload.graphPayload),
  });
}

function sanitizeGraphPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (TOP_LEVEL_GRAPH_PAYLOAD_DENYLIST.has(key)) continue;
    out[key] = sanitizeGraphPayloadValue(raw, key);
  }
  return out;
}

function sanitizeGraphPayloadValue(value: unknown, key: string): unknown {
  if (key === "access_token") return undefined;
  if (Array.isArray(value))
    return value.map((item) => sanitizeGraphPayloadValue(item, ""));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeGraphPayloadValue(childValue, childKey);
      if (sanitized !== undefined) out[childKey] = sanitized;
    }
    return out;
  }
  return value;
}

function buildPromotedObject(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefinedGraph({
    pixel_id: readGraphString(payload, "pixelId"),
    custom_event_type: readGraphString(payload, "customEventType"),
    page_id: readGraphString(payload, "pageId"),
  });
}

function readCountriesFromPayload(payload: Record<string, unknown>): string[] {
  const targeting = payload.targeting;
  if (
    isRecord(targeting) &&
    isRecord(targeting.geo_locations) &&
    Array.isArray(targeting.geo_locations.countries)
  ) {
    return targeting.geo_locations.countries.filter(
      (v): v is string => typeof v === "string",
    );
  }
  const countries = payload.countries;
  return Array.isArray(countries)
    ? countries.filter((v): v is string => typeof v === "string")
    : [];
}

function buildGraphCarouselObjectStorySpec(
  payload: Record<string, unknown>,
  cards: readonly CarouselApplyCard[],
  imageHashes: readonly string[],
): Record<string, unknown> {
  const pageId = readGraphString(payload, "pageId");
  const linkUrl =
    readGraphString(payload, "linkUrl") ?? readGraphString(payload, "link_url");
  if (!pageId)
    throw new MetaGraphApplyError({
      message: "creative.create carousel requires pageId",
      exitClass: "api_error",
    });
  if (!linkUrl)
    throw new MetaGraphApplyError({
      message: "creative.create carousel requires linkUrl",
      exitClass: "api_error",
    });
  if (cards.length !== imageHashes.length) {
    throw new MetaGraphApplyError({
      message: "carousel card count does not match uploaded image hashes",
      exitClass: "api_error",
    });
  }
  const childAttachments = cards.map((card, index) =>
    removeUndefinedGraph({
      image_hash: imageHashes[index],
      name: card.headline,
      description: card.description,
      link: card.linkUrl ?? linkUrl,
    }),
  );
  const cta = readGraphString(payload, "callToAction");
  const linkData = removeUndefinedGraph({
    link: linkUrl,
    message:
      readGraphString(payload, "body") ??
      readGraphString(payload, "primaryText") ??
      readGraphString(payload, "message") ??
      "",
    child_attachments: childAttachments,
    call_to_action:
      cta && cta !== "NO_BUTTON"
        ? {
            type: cta,
            value: removeUndefinedGraph({
              link: linkUrl,
              app_link: readGraphString(payload, "instagramAppLink"),
            }),
          }
        : undefined,
  });
  return removeUndefinedGraph({
    page_id: pageId,
    instagram_user_id:
      readGraphString(payload, "instagramUserId") ??
      readGraphString(payload, "instagramActorId"),
    link_data: linkData,
  });
}

function buildGraphImageObjectStorySpec(
  payload: Record<string, unknown>,
  imageHash: string | undefined,
): Record<string, unknown> {
  const pageId = readGraphString(payload, "pageId");
  const linkUrl = readGraphString(payload, "linkUrl");
  if (!pageId)
    throw new MetaGraphApplyError({
      message: "creative.create requires pageId",
      exitClass: "api_error",
    });
  if (!linkUrl)
    throw new MetaGraphApplyError({
      message: "creative.create image link ad requires linkUrl",
      exitClass: "api_error",
    });
  if (!imageHash)
    throw new MetaGraphApplyError({
      message: "creative.create requires imageHash or storageKey",
      exitClass: "api_error",
    });
  const cta = readGraphString(payload, "callToAction");
  const linkData: Record<string, unknown> = removeUndefinedGraph({
    image_hash: imageHash,
    link: linkUrl,
    message:
      readGraphString(payload, "body") ??
      readGraphString(payload, "primaryText") ??
      "",
    name:
      readGraphString(payload, "title") ?? readGraphString(payload, "headline"),
    description: readGraphString(payload, "description"),
    call_to_action:
      cta && cta !== "NO_BUTTON"
        ? {
            type: cta,
            value: removeUndefinedGraph({
              link: linkUrl,
              app_link: readGraphString(payload, "instagramAppLink"),
            }),
          }
        : undefined,
  });
  return removeUndefinedGraph({
    page_id: pageId,
    instagram_user_id:
      readGraphString(payload, "instagramUserId") ??
      readGraphString(payload, "instagramActorId"),
    link_data: linkData,
  });
}

function requireTargetId(
  payload: Record<string, unknown>,
  key: string,
  action: GraphOperationAction,
): string {
  const id =
    readGraphString(payload, key) ??
    readGraphString(payload, "id") ??
    action.entity?.nodeKey ??
    null;
  if (!id) {
    throw new MetaGraphApplyError({
      message: `${action.kind} requires ${key}`,
      exitClass: "api_error",
    });
  }
  return id;
}

function requireGraphId(
  json: unknown,
  origin: string,
): { externalId: string; response: JsonValue } {
  const id = extractId(json);
  if (!id) {
    throw new MetaGraphApplyError({
      message: `${origin} response did not include id`,
      exitClass: "unknown_error",
      payload: json as JsonValue,
    });
  }
  return { externalId: id, response: json as JsonValue };
}

function isCarouselCreative(value: Record<string, unknown>): boolean {
  return (
    readGraphString(value, "mediaType")?.toLowerCase() === "carousel" ||
    readGraphString(value, "type")?.toLowerCase() === "carousel"
  );
}

function requireCarouselCards(
  value: Record<string, unknown>,
): CarouselApplyCard[] {
  const cards = Array.isArray(value.cards) ? value.cards : [];
  if (cards.length < 2 || cards.length > 10) {
    throw new MetaGraphApplyError({
      message: "carousel creative requires 2-10 cards",
      exitClass: "api_error",
    });
  }
  return cards
    .map((card, index) => normalizeCarouselApplyCard(card, index))
    .sort((a, b) => a.position - b.position);
}

function normalizeCarouselApplyCard(
  card: unknown,
  index: number,
): CarouselApplyCard {
  if (!isRecord(card)) {
    throw new MetaGraphApplyError({
      message: `carousel card ${index + 1} must be an object`,
      exitClass: "api_error",
    });
  }
  const storageKey =
    readGraphString(card, "storageKey") ??
    readGraphString(card, "storage_key") ??
    storageKeyFromRef(
      readGraphString(card, "storageRef") ??
        readGraphString(card, "storage_ref"),
    );
  if (!storageKey) {
    throw new MetaGraphApplyError({
      message: `carousel card ${index + 1} requires storage_ref or storageKey`,
      exitClass: "api_error",
    });
  }
  const headline = readGraphString(card, "headline");
  if (!headline) {
    throw new MetaGraphApplyError({
      message: `carousel card ${index + 1} requires headline`,
      exitClass: "api_error",
    });
  }
  return {
    position:
      typeof card.position === "number" && Number.isFinite(card.position)
        ? card.position
        : index + 1,
    storageKey,
    headline,
    ...(readGraphString(card, "description")
      ? { description: readGraphString(card, "description") }
      : {}),
    ...((readGraphString(card, "linkUrl") ?? readGraphString(card, "link_url"))
      ? {
          linkUrl:
            readGraphString(card, "linkUrl") ??
            readGraphString(card, "link_url"),
        }
      : {}),
  };
}

function storageKeyFromRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const prefix = "storage://";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function readGraphString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function moneyField(
  value: unknown,
  accountCurrency: string,
): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? amountToMinorUnits(value, accountCurrency)
    : typeof value === "string" && value.trim()
      ? value.trim()
      : undefined;
}

function removeUndefinedGraph(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function normalizeGraphEntityStatus(value: unknown): string | undefined {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "active" || status === "paused" || status === "archived")
    return status;
  if (status === "deleted") return "archived";
  return undefined;
}

// ---------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------

/**
 * regression fix: Apply 経路で要求する Meta Ads CLI の最低バージョン。
 * `META_CLI_SUPPORTED_OPERATIONS` の `verifiedAt` で
 * 動作確認した CLI のフロアと整合させる。`verifyVersion()` がこの値より
 * 古い CLI を返した場合、production は spawn を fail-closed にする。
 */
export const META_CLI_MIN_VERSION = "0.5.0";

export interface ResolveApplyExecutorOptions {
  env?: NodeJS.ProcessEnv;
  metaAdapter: MetaAdapter;
  /**
   * accountKey から Meta 公式 CLI が要求する
   * `AD_ACCOUNT_ID` (`act_<digits>`) を解決する。未指定時は accountKey を fallback。
   */
  resolveAdAccountId?: (accountKey: string) => Promise<string | null>;
  /** accountKey から Meta ad account currency (JPY/USD 等) を解決する。 */
  resolveAdAccountCurrency?: (accountKey: string) => Promise<string | null>;
  /** test seam: 子プロセス起動関数。production は nodeSpawn。 */
  spawnImpl?: typeof nodeSpawn;
  /**
   * test seam: `verifyVersion()` が呼ぶ `--version` の出力を直接返す。
   * production では使わず、real CLI を spawn して検証する。
   */
  versionResolver?: () => Promise<string>;
}

export interface ApplyExecutorSelection {
  executor: MetaActionExecutor;
  mode: "graph" | "cli" | "mock" | "fail_closed";
  reason: string;
  /**
   * regression fix: cli モードで実施した version verification の結果。
   * mock / fail_closed モードでは undefined。`ok=false` のときも mode は "cli"
   * のままで、executeAction が MetaCliVersionUnverifiedError → unknown_error
   * として fail-closed する (mock fallback は許可しない)。
   */
  versionVerification?: MetaCliVersionVerification;
}

/**
 * env と Meta token 状態から、apply に使う executor を決定する。
 *
 * - 既定 → GraphApplyExecutor。Meta Ads CLI の有無やバージョンでは分岐しない。
 *   token は per-invocation で `metaAdapter.loadAccessTokenPlaintext()` から再取得する。
 * - `ADDROID_META_CLI_BIN` 未設定 + `ADDROID_META_ADS_CLI_MOCK=1` → MockApplyExecutor
 *   (the current implementation 「mocked equivalent in local tests」経路。ローカル / browser
 *    test を成立させるための明示的シミュレーション)。
 * - Meta Ads CLI backend は将来復帰用の内部コードとして残すが、この factory からは
 *   現時点では選択しない。
 */
export async function resolveApplyExecutor(
  opts: ResolveApplyExecutorOptions,
): Promise<ApplyExecutorSelection> {
  const env = opts.env ?? process.env;
  if (env.ADDROID_META_ADS_CLI_MOCK === "1") {
    return {
      executor: new MockApplyExecutor(),
      mode: "mock",
      reason:
        "ADDROID_META_ADS_CLI_MOCK=1 selects the explicit local-test mock executor",
    };
  }
  const graphExecutor = new GraphApplyExecutor({
    metaAdapter: opts.metaAdapter,
    ...(opts.resolveAdAccountId
      ? { resolveAdAccountId: opts.resolveAdAccountId }
      : {}),
    ...(opts.resolveAdAccountCurrency
      ? { resolveAdAccountCurrency: opts.resolveAdAccountCurrency }
      : {}),
  });
  return {
    executor: graphExecutor,
    mode: "graph",
    reason:
      "using Meta Graph API as canonical apply route; Meta Ads CLI is optional diagnostic/future backend only",
  };

  /*
   * Internal future path:
   * Keep the CLI backend code below as a verified capability candidate, but do
   * not expose an environment variable switch. When the CLI catches up, wire it
   * through a code-owned capability registry and tests, not operator config.
   */
  const binaryPath = env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) {
    // regression fix: CLI 未設定時に明示的な local-test simulation を要求された
    // ときだけ MockApplyExecutor を選ぶ。フラグ無しで暗黙に mock success を
    // 返すと、CLI 未設定の本番ワーカが `apply.executed` を audit に積んで
    // しまい、Meta に何も反映していないのに反映済みのように見える事故を招く。
    if (env.ADDROID_META_ADS_CLI_MOCK === "1") {
      return {
        executor: new MockApplyExecutor(),
        mode: "mock",
        reason:
          "ADDROID_META_CLI_BIN is not set; ADDROID_META_ADS_CLI_MOCK=1 selects the local-test mock executor",
      };
    }
    return {
      executor: new FailClosedApplyExecutor(),
      mode: "fail_closed",
      reason:
        "ADDROID_META_CLI_BIN is not set and ADDROID_META_ADS_CLI_MOCK is not '1'; apply will fail closed (Meta Ads CLI not configured)",
    };
  }
  const adapter = opts.metaAdapter;
  const runnerOpts: MetaCliRunnerOptions = {
    binaryPath: binaryPath!,
    spawnImpl: opts.spawnImpl ?? nodeSpawn,
    minVersion: META_CLI_MIN_VERSION,
    requireVerifiedVersion: true,
    // regression fix: per-invocation token load. 例外 (MetaTokenExpiredError 等) は
    // catch せず runner.run() 経由で CliApplyExecutor.executeAction に伝播させ、
    // そこで auth_error/reauth path に変換する。
    loadTokenForAccount: async () => {
      const lease = await adapter.loadAccessTokenPlaintext();
      if (!lease) return null;
      return { accessToken: lease.accessToken };
    },
    ...(opts.versionResolver ? { versionResolver: opts.versionResolver } : {}),
  };
  const runner = new MetaCliRunner(runnerOpts);
  // regression fix: verify the CLI binary/version once at factory time.
  // 結果は runner にキャッシュされ、後続の `run()` がそれを参照して spawn を
  // 許可/拒否する (cli-runner.ts のフェイルクローズドゲート)。
  const verification = await runner.verifyVersion();
  const reason = verification.ok
    ? `using meta-ads-cli at ${binaryPath} (${verification.detail}; token loaded per invocation from MetaAdapter)`
    : `meta-ads-cli at ${binaryPath} failed version verification (${verification.detail}); apply will fail closed until the CLI is installed/upgraded`;
  return {
    executor: new CliApplyExecutor({
      runner,
      metaAdapter: adapter,
      ...(opts.resolveAdAccountId
        ? { resolveAdAccountId: opts.resolveAdAccountId }
        : {}),
      ...(opts.resolveAdAccountCurrency
        ? { resolveAdAccountCurrency: opts.resolveAdAccountCurrency }
        : {}),
    }),
    mode: "cli",
    reason,
    versionVerification: verification,
  };
}
