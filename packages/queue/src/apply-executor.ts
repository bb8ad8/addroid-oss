// AdDroid OSS — execute_apply ハンドラ本体。
//
// merged PR から enqueue された `apply_jobs` 行を取り、承認済み PR 差分内の
// operations/*.json を `AdsLoader` 経由で取得し、Meta CLI へ 1 件ずつ送って
// `apply_jobs` を `succeeded` / `failed` / `simulated` に遷移させる。
//
// the current implementation 受入基準:
//   - PR merge を人間の承認境界として、operation manifest の内容をそのまま実行する。
//   - loader / approval / execution-mode / account lock の境界で fail-closed する。
//
// 本モジュールは Prisma を直接 import しない。`ApplyJobStore` /
// `MetaActionExecutor` / `AdsLoader` はすべて呼び出し側 (apps/worker) が注入する。
// テストは `__tests__/fakes.ts` の in-memory fake で置換する。

import {
  buildAdAccountLockKey,
  computeBackoffDelayMs,
  createInProcessAdAccountLockProvider,
  type AdAccountLockProvider,
  type MetaRateLimitPolicy,
} from "./rate-limit.js";
import { resolveExecutionMode, type ExecutionMode } from "./execution-mode.js";
import type {
  AccountExecutionModes,
  ApplyApprovalSnapshot,
  ApplyAuditAction,
  ApplyJobContext,
  ApplyJobStore,
  ApplyTerminalState,
  ExecutionLogInput,
  JsonValue,
  UpsertAppliedAdsNodeInput,
} from "./store.js";

export interface MetaCliOperationAction {
  kind: "meta_cli_operation";
  account: string;
  resource: string;
  verb: string;
  args: string[];
  entity?: {
    nodeType?: "campaign" | "adset" | "ad" | "creative" | string;
    nodeKey?: string;
    displayName?: string;
    parentNodeType?: "campaign" | "adset" | string;
    parentNodeKey?: string;
    status?: string;
  };
  externalIdRequired?: boolean;
}

export type GraphOperationKind =
  | "campaign.create"
  | "campaign.update"
  | "campaign.delete"
  | "campaign.status"
  | "adset.create"
  | "adset.update"
  | "adset.delete"
  | "adset.status"
  | "creative.create"
  | "creative.update"
  | "creative.delete"
  | "ad.create"
  | "ad.update"
  | "ad.delete"
  | "ad.status";

export interface GraphOperationAction {
  kind: GraphOperationKind;
  account: string;
  /** Manifest-local reference, e.g. "campaign:spring_sale". */
  ref?: string;
  dependsOn?: string[];
  payload: Record<string, unknown>;
  entity?: MetaCliOperationAction["entity"];
  externalIdRequired?: boolean;
}

type LegacyApplyActionKind =
  | "create_campaign"
  | "update_campaign"
  | "delete_campaign"
  | "create_adset"
  | "update_adset"
  | "delete_adset"
  | "create_ad"
  | "update_ad"
  | "delete_ad"
  | "create_creative"
  | "update_creative"
  | "delete_creative"
  | "create_experiment"
  | "update_experiment"
  | "delete_experiment";

export interface LegacyApplyAction {
  kind: LegacyApplyActionKind;
  account: string;
  campaignId?: any;
  adsetId?: any;
  adId?: any;
  creativeId?: any;
  creativeRef?: any;
  name?: any;
  objective?: any;
  initialState?: any;
  budget?: any;
  adsetBudgetSharing?: any;
  optimizationGoal?: any;
  billingEvent?: any;
  bidAmount?: any;
  startTime?: any;
  endTime?: any;
  targeting?: any;
  pixelId?: any;
  customEventType?: any;
  trackingSpecs?: any;
  changes?: any;
  pageId?: any;
  storageKey?: any;
  mediaType?: any;
  body?: any;
  primaryText?: any;
  title?: any;
  headline?: any;
  linkUrl?: any;
  description?: any;
  callToAction?: any;
  instagramAppLink?: any;
  instagramUserId?: any;
  images?: any;
  videos?: any;
  titles?: any;
  bodies?: any;
  descriptions?: any;
  callToActions?: any;
  cards?: any;
}

export type ApplyAction =
  | GraphOperationAction
  | MetaCliOperationAction
  | LegacyApplyAction;

// ---------------------------------------------------------------------
// AdsLoader — apply_job が指す PR から operation manifest を返す境界。
// ---------------------------------------------------------------------

/**
 * 旧 loader 互換の型。新経路では使わず、`directActions` のみを実行する。
 */
export interface AccountAdsState {
  accountKey: string;
  next: any;
  previous: any | null;
}

export interface AdsLoaderInput {
  context: ApplyJobContext;
}

export interface AdsLoadResult {
  /** ロード元の identifier (実装が決める; ログに `source` として出る)。 */
  source: "local_dir" | "fixture" | "mock" | "unavailable";
  /** ロード時の備考。UI/ログに表示される (token を含めないこと)。 */
  detail?: string;
  /** 影響を受けたアカウント分の状態。空配列なら "no source" 扱い → simulated。 */
  accounts: AccountAdsState[];
  /**
   * Operation Manifest から直接構築した実行アクション。
   */
  directActions?: Array<{ accountKey: string; actions: ApplyAction[] }>;
}

export interface AdsLoader {
  loadForApply(input: AdsLoaderInput): Promise<AdsLoadResult>;
}

// ---------------------------------------------------------------------
// MetaActionExecutor — 1 件の apply action を Meta 側に反映する境界。
//   real 実装は Meta CLI runner を、テスト/ローカルは in-memory mock を使う。
// ---------------------------------------------------------------------

export interface ExecuteActionInput {
  action: ApplyAction;
  context: ApplyJobContext;
  /** リトライ回数 (初回 = 0)。executor は基本この値を意識しない。 */
  attempt: number;
}

export type ExecuteActionStatus =
  | "success"
  | "auth_error"
  | "rate_limit_error"
  | "api_error"
  | "unknown_error"
  | "skipped";

export interface ExecuteActionResult {
  status: ExecuteActionStatus;
  /** UI/ログ用の 1 行サマリ。token を含めないこと。 */
  message: string;
  /** sanitized payload (UI の ExecutionLogPanel が展開表示する想定)。 */
  logPayload: JsonValue;
  /**
   * `rate_limit_error` のときは backoff/retry のヒントを返す。
   * 未指定なら orchestrator が既定 (5s × 指数, 最大 3 回) を使う。
   */
  retry?: {
    /** 次回試行までのディレイ ms。 */
    delayMs: number;
    /** トータル試行回数 (この値を超えると諦める)。 */
    maxAttempts: number;
  };
  /**
   * 通知系 exit (auth_error / api_error / unknown_error) で executor が
   * オーケストレータに渡す audit 情報。`MetaCliRecommendedAction.auditAction`
   * から組み立てられ、`runExecuteApply` がそのまま `audit_logs` に書く
   * (regression fix: production 経路で recommendedAction を実際に実行する)。
   *
   * 未指定なら orchestrator は legacy fallback (auth_error の場合のみ
   * `oauth.meta.reauth_required`) を選ぶ。
   */
  notify?: {
    auditAction: ApplyAuditAction;
    /** sanitized 1 行説明 (token を含めない)。 */
    detail: string;
  };
  /** 成功時に Meta 側で確定した external id (campaignId / adsetId / adId / creativeId)。 */
  externalId?: string;
}

export interface MetaActionExecutor {
  /**
   * 1 件の apply action を Meta API/CLI に反映する。
   *
   * orchestrator は PR 承認済み operation manifest から作った action を渡す。
   * executor 側で承認済み status を再書き換えしないこと。
   */
  executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult>;
}

// ---------------------------------------------------------------------
// Approval boundary normalization (pure helper)
// ---------------------------------------------------------------------

/**
 * PR merge / in-app approval を人間の承認境界として扱い、承認済み action を
 * そのまま Meta CLI に渡す。将来ここで audit 用の正規化を加える場合も、
 * status の強制変更は行わない。
 */
export function prepareApprovedApplyAction(action: ApplyAction): {
  action: ApplyAction;
  rewritten: boolean;
} {
  return { action, rewritten: false };
}

/** 中身のない update_* (changes={}) は実行不要としてスキップ判定する。 */
export function isNoopAction(action: ApplyAction): boolean {
  if (action.kind === "meta_cli_operation") return action.args.length === 0;
  if (action.kind.includes(".")) return false;
  return false;
}

// ---------------------------------------------------------------------
// runExecuteApply — orchestrator
// ---------------------------------------------------------------------

export interface RunExecuteApplyOptions {
  applyJobId: string;
  workspaceId: string;
  store: ApplyJobStore;
  loader: AdsLoader;
  executor: MetaActionExecutor;
  /**
   * test seam: backoff sleep 関数。既定は `setTimeout` を使う実装。
   * テストでは値を観測 + 即解決する fake を渡す。
   */
  sleep?: (ms: number) => Promise<void>;
  /** 既定: 3 回。rate-limit 時の最大試行回数 (executor が retry を返さない場合の上限)。 */
  defaultRateLimitMaxAttempts?: number;
  /** 既定: 5_000ms (= 5s)。同上。 */
  defaultRateLimitInitialBackoffMs?: number;
  /** 既定: 60_000ms (= 60s)。指数バックオフの上限。 */
  defaultRateLimitMaxBackoffMs?: number;
  /**
   * test seam: per-account concurrency lock の registry を共有する。
   * `runActivate` と同じ既定 registry (in-process map) を共有するため、
   * 通常は省略し、テストでのみ独立 Map を渡す。
   *
   * `lockProvider` を渡したときは無視される (provider 側で in-process
   * 段を内蔵するため)。
   */
  lockRegistry?: Map<string, Promise<unknown>>;
  /**
   * Cross-process ad_account ロック境界。
   *
   * 旧実装は `withAccountLock` の module-local Map で同一プロセス内のみ
   * 直列化していたが、Apply は `apps/worker` で、Activate は `apps/web` /
   * `apps/cli` で動くため、Apply×Activate の race を直列化できなかった。
   * 本オプションには `createCrossProcessAdAccountLockProvider` 等で
   * 組み立てた cross-process provider を渡す。
   *
   * 省略時は `createInProcessAdAccountLockProvider()` (テスト / standalone
   * 向けの in-process フォールバック) を使う。production 経路 (apps/worker)
   * は必ず明示的に provider を渡すこと。
   */
  lockProvider?: AdAccountLockProvider;
}

export interface ApplyActionOutcome {
  action: ApplyAction;
  status: ExecuteActionStatus;
  message: string;
  attempts: number;
  rewrittenForPaused: boolean;
}

export interface RunExecuteApplySummary {
  applyJobId: string;
  state: ApplyTerminalState;
  source: AdsLoadResult["source"];
  accountsTouched: number;
  totalActions: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pausedRewrites: number;
  outcomes: ApplyActionOutcome[];
  errorMessage?: string;
  /** 処理を中断した理由 (auth_error / api_error / unknown_error / plan_error / rate_limit_exhausted / unapproved_state / report_only_mode) */
  abortReason?:
    | "auth_error"
    | "api_error"
    | "unknown_error"
    | "plan_error"
    | "rate_limit_exhausted"
    | "unapproved_state"
    | "report_only_mode";
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * pg-boss `execute_apply` ハンドラの本体。
 *
 * 流れ:
 *   1. ApplyJobContext を取得。見つからなければ "failed (no_context)"。
 *   2. apply_jobs を `running` に遷移。
 *   3. AdsLoader でアカウント別 operation manifest を取得。
 *      - ロード結果が空 (= local checkout 不在 / mocked source none) なら
 *        `simulated` に倒し audit に `apply.simulated` を記録して終了。
 *   4. 各アカウントの action を検証し、実行対象を確定する。
 *   5. 各 action を MetaActionExecutor に渡す。
 *      - rate_limit_error は backoff + 再試行。
 *      - auth_error / unknown_error は中断。残り action は skip 扱い。
 *      - 個別実行ごとに `execution_logs (kind=apply)` に sanitized payload を記録。
 *   6. apply_jobs を確定 (succeeded / failed)、audit_logs に終端イベントを 1 行。
 */
export async function runExecuteApply(
  opts: RunExecuteApplyOptions,
): Promise<RunExecuteApplySummary> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttemptsDefault = opts.defaultRateLimitMaxAttempts ?? 3;
  const initialBackoffDefault = opts.defaultRateLimitInitialBackoffMs ?? 5_000;
  const maxBackoffDefault = opts.defaultRateLimitMaxBackoffMs ?? 60_000;
  // regression fix: cross-process ad_account ロック provider。production の
  // apps/worker は Postgres advisory lock 実装を必ず注入する。テスト /
  // standalone は省略でき、その場合は in-process フォールバックを使う。
  // `opts.lockRegistry` は legacy seam として in-process フォールバックの
  // registry にだけ反映する (provider 注入時は意味を持たない)。
  const lockProvider: AdAccountLockProvider =
    opts.lockProvider ??
    createInProcessAdAccountLockProvider(opts.lockRegistry ?? new Map());

  const baseSummary = (
    state: ApplyTerminalState,
    extra: Partial<RunExecuteApplySummary> = {},
  ): RunExecuteApplySummary => ({
    applyJobId: opts.applyJobId,
    state,
    source: extra.source ?? "unavailable",
    accountsTouched: extra.accountsTouched ?? 0,
    totalActions: extra.totalActions ?? 0,
    succeeded: extra.succeeded ?? 0,
    failed: extra.failed ?? 0,
    skipped: extra.skipped ?? 0,
    pausedRewrites: extra.pausedRewrites ?? 0,
    outcomes: extra.outcomes ?? [],
    ...(extra.errorMessage !== undefined
      ? { errorMessage: extra.errorMessage }
      : {}),
    ...(extra.abortReason !== undefined
      ? { abortReason: extra.abortReason }
      : {}),
  });

  // 1) PR メタ取得
  const contextRaw = await opts.store.findApplyJobContext(opts.applyJobId);
  if (!contextRaw) {
    await opts.store.markApplyFinished({
      applyJobId: opts.applyJobId,
      state: "failed",
      errorMessage: "apply_job context not found (deleted PR or stale row)",
      result: { reason: "no_context" },
    });
    return baseSummary("failed", {
      errorMessage: "apply_job context not found",
    });
  }
  // closure 内 (runPlanForAccount) でも non-null narrowing を維持するため
  // 別変数に固定する (runActivate の fixedNode と同パターン)。
  // regression fix: revalidation 成功後に snapshot.approvalRecordId を焼き付けて
  // 上書きできるよう `let` で宣言する (executor 経由で MetaCliInvocation.refs に
  // 伝播し、Apply 経路の Meta CLI execution_log を承認境界に紐付ける)。
  let context: ApplyJobContext = contextRaw;

  // 1.5) 実行時 GitOps 再検証
  // enqueue 後でも、実行段階で:
  //   - PR が closed 等 merged ではなくなっている
  //   - approval_records が 1 行も無い (= 手で apply_jobs を挿入した)
  //   - 最新 approval が rejected / auto_blocked / headSha 不一致
  // のいずれかであれば Meta mutation 経路に到達させない。
  // markApplyRunning より前で fail-closed させるため、Meta CLI / executor は呼ばない。
  const snapshot = await opts.store.loadApplyApprovalSnapshot(opts.applyJobId);
  const revalidation = evaluateApprovalSnapshot(snapshot);
  if (!revalidation.ok) {
    const errorMessage = `apply blocked at execution time: ${revalidation.reason}`;
    await opts.store.recordApplyExecutionLog({
      workspaceId: opts.workspaceId,
      kind: "apply",
      refType: "apply_job",
      refId: opts.applyJobId,
      level: "error",
      message: `apply_job ${opts.applyJobId}: blocked — ${revalidation.reason}`,
      payload: {
        stage: "revalidation",
        reason: revalidation.reason,
        detail: revalidation.detail,
        snapshot: snapshotForLog(snapshot),
        prNumber: context.prNumber,
        headSha: context.headSha,
        pullRequestId: context.pullRequestId,
      },
    });
    await opts.store.markApplyFinished({
      applyJobId: opts.applyJobId,
      state: "failed",
      errorMessage,
      result: {
        reason: "unapproved_state",
        revalidation: revalidation.reason,
        detail: revalidation.detail,
      },
    });
    await opts.store.recordApplyAudit({
      workspaceId: opts.workspaceId,
      action: "apply.blocked_unapproved",
      applyJobId: opts.applyJobId,
      pullRequestId: context.pullRequestId,
      prNumber: context.prNumber,
      headSha: context.headSha,
      ref: `pr#${context.prNumber}@${context.headSha}`,
      metadata: {
        reason: revalidation.reason,
        detail: revalidation.detail,
        snapshot: snapshotForLog(snapshot),
      },
    });
    return baseSummary("failed", {
      errorMessage,
      abortReason: "unapproved_state",
    });
  }

  // regression fix: revalidation を通過した snapshot から approvalRecordId を
  // ApplyJobContext に焼き付ける。これは MetaActionExecutor 経由で Meta CLI
  // invocation の `refs.approvalRecordId` に伝播し、Apply の各 CLI 実行を
  // `execution_logs` 上で承認境界 (approval_records) に紐付けるための情報源。
  // snapshot は revalidation 成功時点で必ず存在し、latestApprovalDecision が
  // approved なので approvalRecordId は通常 string。
  // ただし型上は null も許容するため、フォールバックを残す。
  context = {
    ...context,
    approvalRecordId: snapshot?.approvalRecordId ?? null,
    mergeSha: snapshot?.approvalRecordMergeSha ?? null,
  };

  // 2) running 遷移
  await opts.store.markApplyRunning({ applyJobId: opts.applyJobId });
  await opts.store.recordApplyExecutionLog({
    workspaceId: opts.workspaceId,
    kind: "apply",
    refType: "apply_job",
    refId: opts.applyJobId,
    level: "info",
    message: `apply_job ${opts.applyJobId}: starting (pr#${context.prNumber})`,
    payload: {
      prNumber: context.prNumber,
      headSha: context.headSha,
      pullRequestId: context.pullRequestId,
    },
  });

  // 3) Operation manifest 取得
  let load: AdsLoadResult;
  try {
    load = await opts.loader.loadForApply({ context });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await opts.store.recordApplyExecutionLog({
      workspaceId: opts.workspaceId,
      kind: "apply",
      refType: "apply_job",
      refId: opts.applyJobId,
      level: "error",
      message: `apply_job ${opts.applyJobId}: ads loader threw — ${message}`,
      payload: { errorMessage: message, stage: "load" },
    });
    await opts.store.markApplyFinished({
      applyJobId: opts.applyJobId,
      state: "failed",
      errorMessage: `ads loader failed: ${message}`,
      result: { reason: "loader_error", detail: message },
    });
    await opts.store.recordApplyAudit({
      workspaceId: opts.workspaceId,
      action: "apply.failed",
      applyJobId: opts.applyJobId,
      pullRequestId: context.pullRequestId,
      prNumber: context.prNumber,
      headSha: context.headSha,
      ref: `pr#${context.prNumber}@${context.headSha}`,
      metadata: { reason: "loader_error", detail: message },
    });
    return baseSummary("failed", {
      errorMessage: message,
      abortReason: "unknown_error",
    });
  }

  const loadedAccountCount =
    load.accounts.length > 0
      ? load.accounts.length
      : new Set((load.directActions ?? []).map((a) => a.accountKey)).size;

  if (
    load.accounts.length === 0 &&
    (!load.directActions || load.directActions.length === 0)
  ) {
    // mocked equivalent path: ローダがソースを提供できない場合は simulated。
    await opts.store.recordApplyExecutionLog({
      workspaceId: opts.workspaceId,
      kind: "apply",
      refType: "apply_job",
      refId: opts.applyJobId,
      level: "info",
      message: `apply_job ${opts.applyJobId}: no ads source available, recording as simulated`,
      payload: {
        source: load.source,
        detail: load.detail ?? null,
      },
    });
    await opts.store.markApplyFinished({
      applyJobId: opts.applyJobId,
      state: "simulated",
      result: {
        reason: "no_source",
        source: load.source,
        detail: load.detail ?? null,
      },
    });
    await opts.store.recordApplyAudit({
      workspaceId: opts.workspaceId,
      action: "apply.simulated",
      applyJobId: opts.applyJobId,
      pullRequestId: context.pullRequestId,
      prNumber: context.prNumber,
      headSha: context.headSha,
      ref: `pr#${context.prNumber}@${context.headSha}`,
      metadata: {
        reason: "no_source",
        source: load.source,
        detail: load.detail ?? null,
      },
    });
    return baseSummary("simulated", { source: load.source });
  }

  // 3.5) execute-time per-account execution mode revalidation (regression fix)
  //
  // enqueue 時 (`runGithubPollOnce`) では PR が触る accountKey が分からない
  // ため workspace mode の hard-lock のみで判定している。ここで AdsLoader が
  // 返した `load.accounts` の accountKey 集合を使い、`workspaces.executionMode`
  // と `ad_accounts.modeOverride` を再取得して `resolveExecutionMode` で
  // per-account に評価する。`report_only` に倒れる accountKey が 1 つでも
  // あれば Meta executor を呼ばず fail-closed する。受入基準:
  //   - "report_only never mutates Meta"
  //   - "auto_apply only executes pre-approved safe operations"
  // を Meta CLI 直前で強制する境界。
  const accountKeys =
    load.accounts.length > 0
      ? load.accounts.map((a) => a.accountKey)
      : [...new Set((load.directActions ?? []).map((a) => a.accountKey))];
  const modeContext = await opts.store.loadAccountExecutionModes({
    workspaceId: opts.workspaceId,
    accountKeys,
  });
  const reportOnlyAccounts = collectReportOnlyAccounts(
    accountKeys,
    modeContext,
  );
  if (reportOnlyAccounts.length > 0) {
    const errorMessage =
      `apply blocked at execution time: report_only mode is in effect for ` +
      `account(s) ${reportOnlyAccounts.map((r) => r.accountKey).join(", ")}`;
    await opts.store.recordApplyExecutionLog({
      workspaceId: opts.workspaceId,
      kind: "apply",
      refType: "apply_job",
      refId: opts.applyJobId,
      level: "error",
      message: `apply_job ${opts.applyJobId}: blocked — report_only_mode`,
      payload: {
        stage: "mode_revalidation",
        reason: "report_only_mode",
        workspaceMode: modeContext.workspaceMode,
        reportOnlyAccounts: reportOnlyAccounts.map((r) => ({
          accountKey: r.accountKey,
          override: r.override,
          effectiveMode: r.effectiveMode,
        })),
        prNumber: context.prNumber,
        headSha: context.headSha,
        pullRequestId: context.pullRequestId,
      },
    });
    await opts.store.markApplyFinished({
      applyJobId: opts.applyJobId,
      state: "failed",
      errorMessage,
      result: {
        reason: "report_only_mode",
        workspaceMode: modeContext.workspaceMode,
        reportOnlyAccounts: reportOnlyAccounts.map((r) => ({
          accountKey: r.accountKey,
          override: r.override,
          effectiveMode: r.effectiveMode,
        })),
      },
    });
    await opts.store.recordApplyAudit({
      workspaceId: opts.workspaceId,
      action: "apply.blocked_unapproved",
      applyJobId: opts.applyJobId,
      pullRequestId: context.pullRequestId,
      prNumber: context.prNumber,
      headSha: context.headSha,
      ref: `pr#${context.prNumber}@${context.headSha}`,
      metadata: {
        reason: "report_only_mode",
        workspaceMode: modeContext.workspaceMode,
        reportOnlyAccounts: reportOnlyAccounts.map((r) => ({
          accountKey: r.accountKey,
          override: r.override,
          effectiveMode: r.effectiveMode,
        })),
      },
    });
    return baseSummary("failed", {
      source: load.source,
      accountsTouched: loadedAccountCount,
      errorMessage,
      abortReason: "report_only_mode",
    });
  }

  const plans: { accountKey: string; actions: ApplyAction[] }[] = [];
  if (load.directActions && load.directActions.length > 0) {
    for (const direct of load.directActions) {
      plans.push({ accountKey: direct.accountKey, actions: direct.actions });
    }
  }

  // 5) Operation action を executor に渡す。
  const outcomes: ApplyActionOutcome[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let pausedRewrites = 0;
  let totalActions = 0;

  let abortReason: RunExecuteApplySummary["abortReason"] | undefined;
  let abortMessage: string | undefined;

  // regression fix: 終端 audit (`apply.executed` / `apply.failed`) に external_id /
  // ads_hierarchy.id を載せるための evidence collector。Meta 側で確定した
  // external_id と、`upsertAppliedAdsNode` が返した local 行 id を action ごとに
  // 保持し、最後の `recordApplyAudit` メタデータに焼き付ける。
  const affectedNodes: AffectedNodeRecord[] = [];
  let failingAction: FailingActionRecord | undefined;

  // 受入要件 "Rate limiting enforces ad_account-level concurrency of 1": 同一
  // `runExecuteApply` 内では accounts は順次処理 (for-loop) されるが、複数の
  // `runExecuteApply` が同時に走ったとき (= 別 PR の apply_job が並行) に同じ
  // ad_account を触る race を防ぐため、per-account の inner block を
  // `lockProvider.withLock` で直列化する。
  //
  // regression fix: lock 識別子は `buildAdAccountLockKey({ workspaceId,
  // accountKey })` の canonical 形を使い、Activate (`runActivate`) と同じ
  // 識別子に解決する。これにより同一 ad_account に対する Apply と Activate
  // の並行実行も直列化される (旧実装では Apply=accountKey, Activate=accountId
  // の異なる識別子を使っていたため Apply×Activate の race が起きていた)。
  //
  // regression fix: 旧実装は `withAccountLock` の module-local Map を直接呼んで
  // いたため、同一 Node.js プロセス内の race しか直列化できなかった。本番では
  // Apply は apps/worker で、Activate は apps/web / apps/cli で動くため、
  // worker の Apply と web/CLI の Activate は別プロセスから同時に Meta CLI を
  // 叩きうる。`lockProvider` (production では Postgres advisory lock を背に
  // 持つ実装) を経由することで cross-process でも 1 並行を強制する。
  //
  // abort 中は Meta API 接触なしで残 action を skipped に倒すため、ロックを
  // 取らずに進める。
  for (const plan of plans) {
    if (abortReason) {
      for (const rawAction of plan.actions) {
        totalActions += 1;
        const { action, rewritten } = prepareApprovedApplyAction(rawAction);
        if (rewritten) pausedRewrites += 1;
        skipped += 1;
        outcomes.push({
          action,
          status: "skipped",
          message: `skipped due to earlier ${abortReason}`,
          attempts: 0,
          rewrittenForPaused: rewritten,
        });
        await opts.store.recordApplyExecutionLog({
          workspaceId: opts.workspaceId,
          kind: "apply",
          refType: "apply_job",
          refId: opts.applyJobId,
          level: "info",
          message: `apply_job ${opts.applyJobId}: skipped ${action.kind}`,
          payload: {
            account: plan.accountKey,
            action: actionForLog(action),
            reason: abortReason,
          },
        });
      }
      continue;
    }

    await lockProvider.withLock(
      buildAdAccountLockKey({
        workspaceId: opts.workspaceId,
        accountKey: plan.accountKey,
      }),
      async () => {
        await runPlanForAccount(plan);
      },
    );
  }

  // ----- end accounts loop -----

  // 6) 終端 (このスコープでは abortReason / outcomes / 集計値が確定済み)
  // 以降の処理は元の終端ブロックへ続く。

  // ----- 内部関数: 1 アカウント分の plan を実行する -----
  async function runPlanForAccount(plan: {
    accountKey: string;
    actions: ApplyAction[];
  }): Promise<void> {
    for (const rawAction of plan.actions) {
      totalActions += 1;
      const { action, rewritten } = prepareApprovedApplyAction(rawAction);
      if (rewritten) pausedRewrites += 1;

      if (abortReason) {
        // ロック取得後に別 account で abort になったケースに備え、内側でも検査。
        skipped += 1;
        outcomes.push({
          action,
          status: "skipped",
          message: `skipped due to earlier ${abortReason}`,
          attempts: 0,
          rewrittenForPaused: rewritten,
        });
        await opts.store.recordApplyExecutionLog({
          workspaceId: opts.workspaceId,
          kind: "apply",
          refType: "apply_job",
          refId: opts.applyJobId,
          level: "info",
          message: `apply_job ${opts.applyJobId}: skipped ${action.kind}`,
          payload: {
            account: plan.accountKey,
            action: actionForLog(action),
            reason: abortReason,
          },
        });
        continue;
      }

      if (isNoopAction(action)) {
        skipped += 1;
        outcomes.push({
          action,
          status: "skipped",
          message: "noop after paused enforcement (changes empty)",
          attempts: 0,
          rewrittenForPaused: rewritten,
        });
        await opts.store.recordApplyExecutionLog({
          workspaceId: opts.workspaceId,
          kind: "apply",
          refType: "apply_job",
          refId: opts.applyJobId,
          level: "info",
          message: `apply_job ${opts.applyJobId}: noop ${action.kind}`,
          payload: {
            account: plan.accountKey,
            action: actionForLog(action),
            reason: "noop",
            rewrittenForPaused: rewritten,
          },
        });
        continue;
      }

      // 試行ループ (rate-limit 時のみ繰り返す)
      let attempt = 0;
      let lastResult: ExecuteActionResult | null = null;
      while (true) {
        attempt += 1;
        let result: ExecuteActionResult;
        try {
          result = await opts.executor.executeAction({
            action,
            context,
            attempt: attempt - 1,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            status: "unknown_error",
            message: `executor threw: ${message}`,
            logPayload: { errorMessage: message },
          };
        }
        lastResult = result;

        await opts.store.recordApplyExecutionLog({
          workspaceId: opts.workspaceId,
          kind: "apply",
          refType: "apply_job",
          refId: opts.applyJobId,
          level: result.status === "success" ? "info" : "warn",
          message: `apply_job ${opts.applyJobId}: ${action.kind} (${plan.accountKey}) → ${result.status} [attempt ${attempt}]`,
          payload: {
            account: plan.accountKey,
            action: actionForLog(action),
            attempt,
            executor: result.logPayload,
            rewrittenForPaused: rewritten,
          },
        });

        if (result.status === "success") break;
        if (result.status === "rate_limit_error") {
          const maxAttempts = result.retry?.maxAttempts ?? maxAttemptsDefault;
          if (attempt >= maxAttempts) {
            // exhausted
            break;
          }
          const baseDelay =
            result.retry?.delayMs ??
            computeBackoffDelayMs(attempt, {
              maxAttempts: maxAttemptsDefault,
              initialBackoffMs: initialBackoffDefault,
              maxBackoffMs: maxBackoffDefault,
              factor: 2,
            } satisfies MetaRateLimitPolicy);
          await sleep(baseDelay);
          continue;
        }
        // auth_error / unknown_error / skipped: break and let outer loop decide.
        break;
      }

      const finalResult = lastResult!;
      if (finalResult.status === "success") {
        // regression fix: create_* (campaign/adset/ad) は ads_hierarchy に
        // 新規行を作るため、Meta 側で確定した external_id 無しに success を
        // 受け入れると、後続 Activate が `ads_hierarchy.externalId` 未確定で
        // 永久に拒否される。executor が externalId を返さなかった場合は
        // 「Meta 側に作成されたかも知れないが追跡不能」状態として fail-closed
        // し、null externalId の PAUSED 行は決して作らない。
        if (
          actionRequiresExternalId(action) &&
          !nonEmptyString(finalResult.externalId)
        ) {
          failed += 1;
          const message =
            `${action.kind} reported success but the Meta executor returned no externalId; ` +
            `refusing to persist ads_hierarchy row without an activatable identifier`;
          outcomes.push({
            action,
            status: "unknown_error",
            message,
            attempts: attempt,
            rewrittenForPaused: rewritten,
          });
          await opts.store.recordApplyExecutionLog({
            workspaceId: opts.workspaceId,
            kind: "apply",
            refType: "apply_job",
            refId: opts.applyJobId,
            level: "error",
            message: `apply_job ${opts.applyJobId}: ${action.kind} (${plan.accountKey}) → fail-closed missing_external_id`,
            payload: {
              stage: "persist_hierarchy",
              reason: "missing_external_id",
              account: plan.accountKey,
              action: actionForLog(action),
              executor: finalResult.logPayload,
              rewrittenForPaused: rewritten,
            },
          });
          abortReason = "unknown_error";
          abortMessage = message;
          failingAction = buildFailingActionRecord({
            action,
            accountKey: plan.accountKey,
            attemptedExternalId: finalResult.externalId,
          });
          await opts.store.recordApplyAudit({
            workspaceId: opts.workspaceId,
            action: "meta.cli_unknown_error",
            applyJobId: opts.applyJobId,
            pullRequestId: context.pullRequestId,
            prNumber: context.prNumber,
            headSha: context.headSha,
            ref: `pr#${context.prNumber}@${context.headSha}`,
            metadata: {
              reason: "missing_external_id",
              account: plan.accountKey,
              actionKind: action.kind,
              detail: message,
              failingAction: failingActionForLog(failingAction),
            },
          });
          continue;
        }
        succeeded += 1;
        outcomes.push({
          action,
          status: "success",
          message: finalResult.message,
          attempts: attempt,
          rewrittenForPaused: rewritten,
        });
        // regression fix: PAUSED ads_hierarchy 行を upsert して externalId と
        // PR の commit sha を local 状態に焼き付ける。Activate 経路はこの行を
        // 読んで Meta を叩くため、ここで永続化しないと apply 後の Activate が
        // 「external_id 未確定」で永久に拒否される。
        // regression fix: 戻り値の hierarchy.id を affectedNodes に取り込み、
        // 終端 audit metadata の `affectedNodes[]` に external_id と一緒に出す。
        const hierarchyId = await persistAppliedHierarchyNode({
          action,
          plan,
          finalResult,
          context,
          opts,
        });
        const ident = nodeIdentForAction(action);
        affectedNodes.push({
          accountKey: plan.accountKey,
          actionKind: action.kind,
          nodeType: ident.nodeType,
          nodeKey: ident.nodeKey,
          externalId: nonEmptyString(finalResult.externalId)
            ? finalResult.externalId
            : null,
          hierarchyId: hierarchyId ?? null,
        });
        continue;
      }

      // 失敗パスの分岐
      failed += 1;
      outcomes.push({
        action,
        status: finalResult.status,
        message: finalResult.message,
        attempts: attempt,
        rewrittenForPaused: rewritten,
      });

      // regression fix: 失敗 action は account / actionKind / nodeKey /
      // attemptedExternalId をまとめて failingAction に保持する。終端
      // `apply.failed` audit metadata と通知系 audit metadata の双方に出す
      // (どの Meta オブジェクトを触ろうとしていたかを監査ログから追跡可能にする)。
      const recordedFailingAction = buildFailingActionRecord({
        action,
        accountKey: plan.accountKey,
        attemptedExternalId: finalResult.externalId,
      });
      if (finalResult.status === "auth_error") {
        abortReason = "auth_error";
        abortMessage = finalResult.message;
        failingAction = recordedFailingAction;
        // regression fix: notification audit は executor の `notify` (=
        // MetaCliRecommendedAction.auditAction) を優先する。FakeMetaActionExecutor
        // 等の旧 caller が notify を立てない場合は legacy 値にフォールバック。
        await opts.store.recordApplyAudit({
          workspaceId: opts.workspaceId,
          action:
            finalResult.notify?.auditAction ?? "oauth.meta.reauth_required",
          applyJobId: opts.applyJobId,
          pullRequestId: context.pullRequestId,
          prNumber: context.prNumber,
          headSha: context.headSha,
          ref: `pr#${context.prNumber}@${context.headSha}`,
          metadata: {
            reason: "auth_error",
            account: plan.accountKey,
            actionKind: action.kind,
            detail: finalResult.notify?.detail ?? finalResult.message,
            failingAction: failingActionForLog(recordedFailingAction),
          },
        });
      } else if (finalResult.status === "api_error") {
        abortReason = "api_error";
        abortMessage = finalResult.message;
        failingAction = recordedFailingAction;
        // regression fix: api_error は notify が立っているはず。立っていなければ
        // 既定の `meta.api_error` を使う (recommendedAction が api_error 由来である
        // 限りこのフォールバックには到達しない)。
        await opts.store.recordApplyAudit({
          workspaceId: opts.workspaceId,
          action: finalResult.notify?.auditAction ?? "meta.api_error",
          applyJobId: opts.applyJobId,
          pullRequestId: context.pullRequestId,
          prNumber: context.prNumber,
          headSha: context.headSha,
          ref: `pr#${context.prNumber}@${context.headSha}`,
          metadata: {
            reason: "api_error",
            account: plan.accountKey,
            actionKind: action.kind,
            detail: finalResult.notify?.detail ?? finalResult.message,
            failingAction: failingActionForLog(recordedFailingAction),
          },
        });
      } else if (finalResult.status === "rate_limit_error") {
        abortReason = "rate_limit_exhausted";
        abortMessage = `rate-limit retries exhausted after ${attempt} attempts: ${finalResult.message}`;
        failingAction = recordedFailingAction;
      } else {
        abortReason = "unknown_error";
        abortMessage = finalResult.message;
        failingAction = recordedFailingAction;
        // regression fix: unknown_error は recommendedAction.fail_fast_notify が
        // 紐付く想定。executor が notify を立てている場合のみ追加 audit を残す。
        if (finalResult.notify) {
          await opts.store.recordApplyAudit({
            workspaceId: opts.workspaceId,
            action: finalResult.notify.auditAction,
            applyJobId: opts.applyJobId,
            pullRequestId: context.pullRequestId,
            prNumber: context.prNumber,
            headSha: context.headSha,
            ref: `pr#${context.prNumber}@${context.headSha}`,
            metadata: {
              reason: "unknown_error",
              account: plan.accountKey,
              actionKind: action.kind,
              detail: finalResult.notify.detail,
              failingAction: failingActionForLog(recordedFailingAction),
            },
          });
        }
      }
    }
  }

  // 6) 終端
  if (abortReason) {
    const errorMessage = abortMessage ?? `apply aborted: ${abortReason}`;
    await opts.store.markApplyFinished({
      applyJobId: opts.applyJobId,
      state: "failed",
      errorMessage,
      result: {
        reason: abortReason,
        succeeded,
        failed,
        skipped,
        pausedRewrites,
        accountsTouched: loadedAccountCount,
      },
    });
    // regression fix: abort 前に Meta 反映 + ads_hierarchy 永続化が完了した
    // action の external_id / hierarchy.id を `affectedNodes` に乗せ、abort を
    // 引き起こした action の identification を `failingAction` に乗せる。
    // これにより `apply.failed` 監査行から「何が反映済みで、何で詰まったか」
    // を external_id 単位で追跡できる。
    await opts.store.recordApplyAudit({
      workspaceId: opts.workspaceId,
      action: "apply.failed",
      applyJobId: opts.applyJobId,
      pullRequestId: context.pullRequestId,
      prNumber: context.prNumber,
      headSha: context.headSha,
      ref: `pr#${context.prNumber}@${context.headSha}`,
      metadata: {
        reason: abortReason,
        succeeded,
        failed,
        skipped,
        pausedRewrites,
        accountsTouched: loadedAccountCount,
        affectedNodes: affectedNodesForLog(affectedNodes),
        failingAction: failingAction
          ? failingActionForLog(failingAction)
          : null,
      },
    });
    return baseSummary("failed", {
      source: load.source,
      accountsTouched: loadedAccountCount,
      totalActions,
      succeeded,
      failed,
      skipped,
      pausedRewrites,
      outcomes,
      errorMessage,
      abortReason,
    });
  }

  // すべて成功 (no actions の場合も succeeded に倒す — plan は通っているため)
  await opts.store.markApplyFinished({
    applyJobId: opts.applyJobId,
    state: "succeeded",
    result: {
      succeeded,
      failed,
      skipped,
      pausedRewrites,
      accountsTouched: loadedAccountCount,
    },
  });
  // regression fix: `apply.executed` audit metadata に成功 action ごとの
  // external_id (Meta 側) と ads_hierarchy.id (local) を含める。Activate /
  // 後段 audit 連携が「どの Meta 物体が、どの hierarchy 行と紐付いたか」を
  // 集計値だけではなく ID で辿れるようにする。
  await opts.store.recordApplyAudit({
    workspaceId: opts.workspaceId,
    action: "apply.executed",
    applyJobId: opts.applyJobId,
    pullRequestId: context.pullRequestId,
    prNumber: context.prNumber,
    headSha: context.headSha,
    ref: `pr#${context.prNumber}@${context.headSha}`,
    metadata: {
      succeeded,
      failed,
      skipped,
      pausedRewrites,
      accountsTouched: loadedAccountCount,
      totalActions,
      affectedNodes: affectedNodesForLog(affectedNodes),
    },
  });
  return baseSummary("succeeded", {
    source: load.source,
    accountsTouched: loadedAccountCount,
    totalActions,
    succeeded,
    failed,
    skipped,
    pausedRewrites,
    outcomes,
  });
}

// ---------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------

/**
 * Apply action を execution_logs.payload に乗せられる形にする。
 *
 * - field 名は operation manifest 由来 (id 等) のみ。token は含まれない。
 * - 大きい構造 (variants 等) はそのまま JSON シリアライズして OK。
 * - `account` は plan.account として既に乗っているため重複させない。
 */
function actionForLog(action: ApplyAction): JsonValue {
  // structuredClone を使わず JSON 経由で「JSON-friendly」値に正規化する。
  const cloned = JSON.parse(JSON.stringify(action)) as JsonValue;
  return cloned;
}

// ---------------------------------------------------------------------
// regression fix: ads_hierarchy persistence on Apply success
//
// 1 つの apply action を `UpsertAppliedAdsNodeInput` に翻訳する純粋関数と、
// それを呼び出して `execution_logs` にエラー痕跡を残しつつ apply を継続させる
// ラッパを定義する。
//
// 対象は campaign / adset / ad のみ (creative は別テーブル `creatives` に
// 永続化される — 本契約のスコープ外)。delete_* / product_* などは
// operation manifest 経由で実行できるが、ads_hierarchy 永続化対象ではない。
// ---------------------------------------------------------------------

/**
 * regression fix: Apply success が ads_hierarchy 永続化のために external_id を
 * 必須とする action kinds。runPlanForAccount の success 分岐で fail-closed
 * 判定に使われ、`deriveAppliedAdsNodeInput` の create_* 分岐でも防御的に
 * 同じルールを適用する (executor 側で漏れた場合の二重防御)。
 */
export function isCreateActionRequiringExternalId(
  kind: ApplyAction["kind"],
): boolean {
  return (
    kind === "create_campaign" ||
    kind === "create_adset" ||
    kind === "create_ad" ||
    kind === "campaign.create" ||
    kind === "adset.create" ||
    kind === "ad.create"
  );
}

function actionRequiresExternalId(action: ApplyAction): boolean {
  if (action.kind === "meta_cli_operation")
    return action.externalIdRequired === true;
  return isCreateActionRequiringExternalId(action.kind);
}

function nonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function deriveAppliedAdsNodeInput(args: {
  action: ApplyAction;
  workspaceId: string;
  externalId: string | undefined;
  lastCommitSha: string;
}): UpsertAppliedAdsNodeInput | null {
  const { action, workspaceId, externalId, lastCommitSha } = args;
  // regression fix: create_* で external_id が空のまま落ちてきたら、ここでも
  // null を返して永続化を拒否する (runPlanForAccount の fail-closed と同じ
  // 不変条件を二重防御する)。
  if (actionRequiresExternalId(action) && !nonEmptyString(externalId)) {
    return null;
  }
  const externalIdMaybe = nonEmptyString(externalId) ? { externalId } : {};
  const spec = actionForLog(action);
  if (isGraphOperationAction(action)) {
    const entity = action.entity ?? graphEntityForAction(action);
    if (!entity?.nodeType || !entity.nodeKey) return null;
    const nodeType =
      entity.nodeType === "campaign" ||
      entity.nodeType === "adset" ||
      entity.nodeType === "ad"
        ? entity.nodeType
        : null;
    if (!nodeType) return null;
    const parentNodeType =
      entity.parentNodeType === "campaign" || entity.parentNodeType === "adset"
        ? entity.parentNodeType
        : undefined;
    const status =
      entity.status === "active" ||
      entity.status === "paused" ||
      entity.status === "archived"
        ? entity.status
        : statusFromGraphPayload(action.payload);
    return {
      workspaceId,
      accountKey: action.account,
      nodeType,
      nodeKey: entity.nodeKey,
      ...(entity.displayName
        ? { displayName: entity.displayName }
        : displayNameFromGraphPayload(action.payload)),
      ...(parentNodeType ? { parentNodeType } : {}),
      ...(entity.parentNodeKey
        ? { parentNodeKey: entity.parentNodeKey }
        : parentNodeFromGraphPayload(action)),
      ...externalIdMaybe,
      lastCommitSha,
      spec,
      ...(status ? { status } : {}),
    };
  }
  if (action.kind === "meta_cli_operation") {
    const entity = action.entity;
    if (!entity?.nodeType || !entity.nodeKey) return null;
    const nodeType =
      entity.nodeType === "campaign" ||
      entity.nodeType === "adset" ||
      entity.nodeType === "ad"
        ? entity.nodeType
        : null;
    if (!nodeType) return null;
    const parentNodeType =
      entity.parentNodeType === "campaign" || entity.parentNodeType === "adset"
        ? entity.parentNodeType
        : undefined;
    const status =
      entity.status === "active" ||
      entity.status === "paused" ||
      entity.status === "archived"
        ? entity.status
        : undefined;
    return {
      workspaceId,
      accountKey: action.account,
      nodeType,
      nodeKey: entity.nodeKey,
      ...(entity.displayName ? { displayName: entity.displayName } : {}),
      ...(parentNodeType ? { parentNodeType } : {}),
      ...(entity.parentNodeKey ? { parentNodeKey: entity.parentNodeKey } : {}),
      ...externalIdMaybe,
      lastCommitSha,
      spec,
      ...(status ? { status } : {}),
    };
  }
  if (action.kind === "create_campaign" || action.kind === "update_campaign") {
    return {
      workspaceId,
      accountKey: action.account,
      nodeType: "campaign",
      nodeKey: String(action.campaignId),
      ...(typeof action.name === "string" ? { displayName: action.name } : {}),
      ...externalIdMaybe,
      lastCommitSha,
      spec,
      ...(typeof action.initialState === "string"
        ? { status: normalizeNodeStatus(action.initialState) }
        : {}),
    };
  }
  if (action.kind === "create_adset" || action.kind === "update_adset") {
    return {
      workspaceId,
      accountKey: action.account,
      nodeType: "adset",
      nodeKey: String(action.adsetId),
      ...(typeof action.name === "string" ? { displayName: action.name } : {}),
      parentNodeType: "campaign",
      parentNodeKey: String(action.campaignId),
      ...externalIdMaybe,
      lastCommitSha,
      spec,
      ...(typeof action.initialState === "string"
        ? { status: normalizeNodeStatus(action.initialState) }
        : {}),
    };
  }
  if (action.kind === "create_ad" || action.kind === "update_ad") {
    return {
      workspaceId,
      accountKey: action.account,
      nodeType: "ad",
      nodeKey: String(action.adId),
      ...(typeof action.name === "string" ? { displayName: action.name } : {}),
      parentNodeType: "adset",
      parentNodeKey: String(action.adsetId),
      ...externalIdMaybe,
      lastCommitSha,
      spec,
      ...(typeof action.initialState === "string"
        ? { status: normalizeNodeStatus(action.initialState) }
        : {}),
    };
  }
  return null;
}

function graphEntityForAction(
  action: GraphOperationAction,
): NonNullable<GraphOperationAction["entity"]> | null {
  const [nodeType, verb] = action.kind.split(".") as [string, string];
  if (
    nodeType !== "campaign" &&
    nodeType !== "adset" &&
    nodeType !== "ad" &&
    nodeType !== "creative"
  )
    return null;
  const key =
    readPayloadString(action.payload, `${nodeType}Id`) ??
    readPayloadString(action.payload, "id") ??
    action.ref?.split(":").slice(1).join(":") ??
    null;
  if (!key) return null;
  return {
    nodeType,
    nodeKey: key,
    displayName: readPayloadString(action.payload, "name") ?? undefined,
    ...(nodeType === "adset"
      ? {
          parentNodeType: "campaign",
          parentNodeKey:
            readPayloadString(action.payload, "campaignRef") ??
            readPayloadString(action.payload, "campaignId") ??
            undefined,
        }
      : {}),
    ...(nodeType === "ad"
      ? {
          parentNodeType: "adset",
          parentNodeKey:
            readPayloadString(action.payload, "adsetRef") ??
            readPayloadString(action.payload, "adsetId") ??
            undefined,
        }
      : {}),
    status: statusFromGraphPayload(action.payload),
  };
}

function readPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function displayNameFromGraphPayload(
  payload: Record<string, unknown>,
): { displayName: string } | {} {
  const name = readPayloadString(payload, "name");
  return name ? { displayName: name } : {};
}

function parentNodeFromGraphPayload(
  action: GraphOperationAction,
): { parentNodeType: "campaign" | "adset"; parentNodeKey: string } | {} {
  if (action.kind.startsWith("adset.")) {
    const parent =
      readPayloadString(action.payload, "campaignRef") ??
      readPayloadString(action.payload, "campaignId");
    return parent ? { parentNodeType: "campaign", parentNodeKey: parent } : {};
  }
  if (action.kind.startsWith("ad.")) {
    const parent =
      readPayloadString(action.payload, "adsetRef") ??
      readPayloadString(action.payload, "adsetId");
    return parent ? { parentNodeType: "adset", parentNodeKey: parent } : {};
  }
  return {};
}

function statusFromGraphPayload(
  payload: Record<string, unknown>,
): "active" | "paused" | "archived" | undefined {
  const status = readPayloadString(payload, "status");
  return status ? normalizeNodeStatus(status) : undefined;
}

function isGraphOperationAction(
  action: ApplyAction,
): action is GraphOperationAction {
  return (
    "payload" in action &&
    typeof action.kind === "string" &&
    action.kind.includes(".")
  );
}

function normalizeNodeStatus(
  value: string,
): "active" | "paused" | "archived" | undefined {
  const v = value.toLowerCase();
  if (v === "active" || v === "paused" || v === "archived") return v;
  return undefined;
}

async function persistAppliedHierarchyNode(args: {
  action: ApplyAction;
  plan: { accountKey: string; actions: ApplyAction[] };
  finalResult: ExecuteActionResult;
  context: ApplyJobContext;
  opts: RunExecuteApplyOptions;
}): Promise<string | null> {
  const { action, plan, finalResult, context, opts } = args;
  const input = deriveAppliedAdsNodeInput({
    action,
    workspaceId: opts.workspaceId,
    externalId: finalResult.externalId,
    lastCommitSha: context.headSha,
  });
  if (!input) return null;
  try {
    // regression fix: 戻り値の hierarchy.id を呼び出し側に返し、終端 audit の
    // `affectedNodes[].hierarchyId` evidence として焼き付ける。
    const { id } = await opts.store.upsertAppliedAdsNode(input);
    return id;
  } catch (err) {
    // Meta 側は反映済みのため apply 全体を fail にしない。Activate のための
    // ads_hierarchy 行が欠落している事実だけを execution_logs (warn) に残し、
    // 後続 action の処理は継続する。
    const message = err instanceof Error ? err.message : String(err);
    await opts.store.recordApplyExecutionLog({
      workspaceId: opts.workspaceId,
      kind: "apply",
      refType: "apply_job",
      refId: opts.applyJobId,
      level: "warn",
      message: `apply_job ${opts.applyJobId}: ads_hierarchy upsert failed for ${action.kind} (${input.nodeKey})`,
      payload: {
        stage: "persist_hierarchy",
        account: plan.accountKey,
        accountKey: input.accountKey,
        nodeType: input.nodeType,
        nodeKey: input.nodeKey,
        externalId: input.externalId ?? null,
        errorMessage: message,
      },
    });
    return null;
  }
}

// ---------------------------------------------------------------------
// regression fix: terminal audit evidence helpers
//
// `apply.executed` / `apply.failed` の audit_logs.metadata に external_id /
// ads_hierarchy.id / 失敗 action 情報を載せるためだけの小さい純粋関数群。
// 監査で「どの Meta オブジェクトが、どの local hierarchy 行と紐付いたか」と
// 「abort はどの action の何で起きたか」を集計値ではなく ID で追跡する。
// ---------------------------------------------------------------------

type NodeIdent = {
  nodeType: "campaign" | "adset" | "ad" | "creative" | "experiment";
  nodeKey: string;
};

interface AffectedNodeRecord extends NodeIdent {
  accountKey: string;
  actionKind: ApplyAction["kind"];
  /** Meta 側で確定した external_id (例: act_xxx/cmp_yyy)。executor が返さなければ null。 */
  externalId: string | null;
  /** `upsertAppliedAdsNode` が返した local 行 id。creative や upsert 失敗時は null。 */
  hierarchyId: string | null;
}

interface FailingActionRecord extends NodeIdent {
  accountKey: string;
  actionKind: ApplyAction["kind"];
  /**
   * 失敗 action が触ろうとしていた Meta external_id。executor が
   * `update_x` で対象オブジェクトの id を返している場合等の externalId を
   * 立てていればそれを使う。立っていなければ null (= 真の失敗で id 取得不能)。
   */
  attemptedExternalId: string | null;
}

function nodeIdentForAction(action: ApplyAction): NodeIdent {
  if (isGraphOperationAction(action)) {
    const [nodeType] = action.kind.split(".");
    const entity = action.entity ?? graphEntityForAction(action);
    return {
      nodeType:
        (entity?.nodeType as NodeIdent["nodeType"] | undefined) ??
        (nodeType as NodeIdent["nodeType"]) ??
        "campaign",
      nodeKey: entity?.nodeKey ?? action.ref ?? action.kind,
    };
  }
  if (action.kind === "meta_cli_operation") {
    return {
      nodeType:
        (action.entity?.nodeType as NodeIdent["nodeType"] | undefined) ??
        "campaign",
      nodeKey: action.entity?.nodeKey ?? `${action.resource}:${action.verb}`,
    };
  }
  const legacy = action as LegacyApplyAction;
  if (action.kind.endsWith("_campaign"))
    return { nodeType: "campaign", nodeKey: String(legacy.campaignId) };
  if (action.kind.endsWith("_adset"))
    return { nodeType: "adset", nodeKey: String(legacy.adsetId) };
  if (action.kind.endsWith("_ad"))
    return { nodeType: "ad", nodeKey: String(legacy.adId) };
  if (action.kind.endsWith("_creative"))
    return { nodeType: "creative", nodeKey: String(legacy.creativeId) };
  return { nodeType: "campaign", nodeKey: action.kind };
}

function buildFailingActionRecord(args: {
  action: ApplyAction;
  accountKey: string;
  attemptedExternalId: string | undefined;
}): FailingActionRecord {
  const ident = nodeIdentForAction(args.action);
  return {
    accountKey: args.accountKey,
    actionKind: args.action.kind,
    nodeType: ident.nodeType,
    nodeKey: ident.nodeKey,
    attemptedExternalId: nonEmptyString(args.attemptedExternalId)
      ? args.attemptedExternalId
      : null,
  };
}

function affectedNodesForLog(records: AffectedNodeRecord[]): JsonValue {
  return records.map((r) => ({
    accountKey: r.accountKey,
    actionKind: r.actionKind,
    nodeType: r.nodeType,
    nodeKey: r.nodeKey,
    externalId: r.externalId,
    hierarchyId: r.hierarchyId,
  })) as JsonValue;
}

function failingActionForLog(record: FailingActionRecord): JsonValue {
  return {
    accountKey: record.accountKey,
    actionKind: record.actionKind,
    nodeType: record.nodeType,
    nodeKey: record.nodeKey,
    attemptedExternalId: record.attemptedExternalId,
  };
}

// ---------------------------------------------------------------------
// execute-time approval revalidation
//
// runExecuteApply は 1.5) ステップで `loadApplyApprovalSnapshot` の結果を
// この関数に通し、Meta mutation 経路に進めるかを判定する。stale な apply_job /
// 手で挿入された apply_job / headSha がズレた承認を 1 か所で fail-closed する境界。
//
// すべての revalidation 失敗は audit_logs に `apply.blocked_unapproved` として
// 残され、execution_logs (kind=apply, level=error) と apply_jobs.state=failed
// と合わせて 3 段で監査証跡を残す。
// ---------------------------------------------------------------------

type RevalidationFailureReason =
  | "snapshot_unavailable"
  | "pr_not_merged"
  | "no_approval_record"
  | "approval_rejected"
  | "approval_head_sha_mismatch"
  | "invalid_approval_source";

type RevalidationResult =
  | { ok: true }
  | { ok: false; reason: RevalidationFailureReason; detail: string };

export function evaluateApprovalSnapshot(
  snapshot: ApplyApprovalSnapshot | null,
): RevalidationResult {
  if (!snapshot) {
    return {
      ok: false,
      reason: "snapshot_unavailable",
      detail:
        "apply_job に紐付く PR / ops repo が見つからないため実行を拒否しました (手挿入または PR 削除の可能性)。",
    };
  }
  if (snapshot.pullRequestState !== "merged") {
    return {
      ok: false,
      reason: "pr_not_merged",
      detail: `現在の PR state="${snapshot.pullRequestState}" は merged ではないため Meta mutation を実行しません。`,
    };
  }
  if (snapshot.latestApprovalDecision === null) {
    return {
      ok: false,
      reason: "no_approval_record",
      detail:
        "approval_records に 1 行も無いため、GitOps 経由で承認された apply_job として認識できません (手で apply_jobs を挿入した可能性)。",
    };
  }
  if (snapshot.latestApprovalDecision !== "approved") {
    return {
      ok: false,
      reason: "approval_rejected",
      detail: `最新の approval_records.decision="${snapshot.latestApprovalDecision}" は承認状態ではありません。`,
    };
  }
  if (snapshot.approvalRecordHeadSha !== snapshot.pullRequestHeadSha) {
    return {
      ok: false,
      reason: "approval_head_sha_mismatch",
      detail:
        "承認された変更IDと現在の PR 変更IDが一致しないため Meta mutation を実行しません。",
    };
  }
  if (!isAcceptedApprovalSource(snapshot.approvalDecisionSource)) {
    return {
      ok: false,
      reason: "invalid_approval_source",
      detail:
        "最新の承認記録が Web UI / CLI / Slack / GitHub の承認由来ではないため Meta mutation を実行しません。",
    };
  }
  return { ok: true };
}

function snapshotForLog(snapshot: ApplyApprovalSnapshot | null): JsonValue {
  if (!snapshot) return null;
  return {
    pullRequestState: snapshot.pullRequestState,
    pullRequestHeadSha: snapshot.pullRequestHeadSha,
    latestApprovalDecision: snapshot.latestApprovalDecision,
    approvalRecordId: snapshot.approvalRecordId,
    approvalRecordHeadSha: snapshot.approvalRecordHeadSha,
    approvalRecordMergeSha: snapshot.approvalRecordMergeSha ?? null,
    approvalDecisionSource: snapshot.approvalDecisionSource,
    mergedAt: snapshot.mergedAt ? snapshot.mergedAt.toISOString() : null,
  };
}

function isAcceptedApprovalSource(source: string | null): boolean {
  return (
    source === "web_merge" ||
    source === "cli_merge" ||
    source === "slack_merge" ||
    source === "github_merge"
  );
}

// ---------------------------------------------------------------------
// regression fix: per-account execution mode fail-closed helper
//
// AdsLoader が返した accountKey 集合に対して `resolveExecutionMode` を 1 件
// ずつ通し、`report_only` に倒れる account を抽出する。`runExecuteApply` は
// 1 件でも該当があれば Meta executor を呼ばずに `apply.blocked_unapproved`
// audit と `failed` 状態に倒す。
// ---------------------------------------------------------------------

interface ReportOnlyAccountRecord {
  accountKey: string;
  /** raw な ad_accounts.modeOverride 値 (UI 表示用)。 */
  override: string | null;
  effectiveMode: ExecutionMode;
}

function collectReportOnlyAccounts(
  accountKeys: readonly string[],
  context: AccountExecutionModes,
): ReportOnlyAccountRecord[] {
  const out: ReportOnlyAccountRecord[] = [];
  for (const key of accountKeys) {
    const override = context.overrideByAccountKey[key] ?? null;
    const effective = resolveExecutionMode(context.workspaceMode, override);
    if (effective === "report_only") {
      out.push({ accountKey: key, override, effectiveMode: effective });
    }
  }
  return out;
}

// re-export for convenience; orchestrator caller がこの型を再宣言しなくて済む。
export type { ApplyJobContext, ApplyJobStore, ExecutionLogInput };
