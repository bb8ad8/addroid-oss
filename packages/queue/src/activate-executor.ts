// AdDroid OSS — Activate オーケストレータ.
//
// Apply とは別経路で `campaign / adset / ad` を PAUSED → ACTIVE に遷移させる。
// 受入基準:
//   - "Activate is separate from Apply and records who triggered it, from CLI or
//      Web UI API, before changing PAUSED to ACTIVE."
//   - "Rate limiting enforces ad_account-level concurrency of 1 and backs off on
//      configured Meta error classes."
//   - "audit_logs link PR merge, Apply, Activate, and failure events to external
//      IDs and local actors."
//
// 本モジュールは Prisma / MetaCliRunner を直接 import せず、
// `ActivateStore` / `ActivateExecutor` を呼び出し側 (apps/cli, apps/web) が注入する。
// テストは __tests__/activate-executor.test.ts で in-memory fake を使う。

import {
  buildAdAccountLockKey,
  computeBackoffDelayMs,
  createInProcessAdAccountLockProvider,
  withAccountLock,
  type AdAccountLockProvider,
  type MetaRateLimitPolicy,
} from "./rate-limit.js";
import type { ExecutionLogInput, JsonValue } from "./store.js";

export type { ExecutionLogInput, JsonValue } from "./store.js";

// `withAccountLock` の単一実装は rate-limit.ts に移行。
// 後方互換のため activate-executor.ts からも re-export し、既存の caller
// (`@addroid/queue` の named export) が破壊されないようにする。
export { withAccountLock };

// ---------------------------------------------------------------------
// 対象ノードと結果
// ---------------------------------------------------------------------

/**
 * Activate 対象 (`ads_hierarchy` の 1 行) のスナップショット。
 * `accountKey` は AdDroid の ad account key で、Meta CLI runner の env 注入に使う。
 * `externalId` は Meta 側で確定済みの campaign/adset/ad ID。null の場合は Activate 不可
 * (Apply によって external_id がまだ確定していない)。
 */
export interface ActivateNodeSnapshot {
  hierarchyId: string;
  workspaceId: string;
  accountId: string;
  accountKey: string;
  metaAccountId: string | null;
  nodeType: "campaign" | "adset" | "ad";
  nodeKey: string;
  displayName: string;
  /** 取得時の status (大文字小文字どちらでも来うる)。 */
  status: string;
  externalId: string | null;
}

/**
 * Activate を起動した経路。actor は audit_logs に出すラベルにそのまま採用する。
 *
 * - `cli` : `addroid activate` (host user, audited as `cli:<host_user>`)
 * - `web` : `/api/campaigns/[id]/activate` (audited as `web:<workspace_user>`)
 * - `slack`: `/adops activate <hierarchy_id>` (audited as `slack:<user_id>`).
 *           Slack 経路は PR 承認の主経路ではなく "explicit audited operation
 *           separate from PR approval" の例外として許可される (UI design plan §0.18)。
 *           Web/CLI と同じ `runActivate` パイプラインを通り、actor + source の
 *           両方で経路が分かるよう metadata に書かれる。
 * - `discord`: `/adops activate <hierarchy_id>` via Discord (audited as
 *           `discord:<user_id>`)。Slack と同じ「PR 承認とは別の明示的 audited
 *           operation」として許可される。
 */
export type ActivateSource = "cli" | "web" | "slack" | "discord";

export interface ActivateRequest {
  hierarchyId: string;
  /** 例: `user:cli`, `user:web-ui:<github_login>`, `user:web-ui` 等。 */
  actor: string;
  source: ActivateSource;
  /** 任意の補足 (UI に表示する短い理由文等)。token を含めないこと。 */
  note?: string;
}

export interface ActivateExecuteInput {
  node: ActivateNodeSnapshot;
  /** 0 オリジン。rate-limit 再試行時にインクリメントされる。 */
  attempt: number;
  request: ActivateRequest;
}

export type ActivateExecuteStatus =
  | "success"
  | "auth_error"
  | "rate_limit_error"
  | "api_error"
  | "unknown_error"
  | "skipped";

export interface ActivateExecuteResult {
  status: ActivateExecuteStatus;
  /** UI/ログ用の 1 行サマリ (sanitized)。 */
  message: string;
  /** sanitized payload (UI ExecutionLogPanel が展開する想定)。 */
  logPayload: JsonValue;
  /** rate_limit_error のときに backoff を伝えるヒント。 */
  retry?: {
    delayMs: number;
    maxAttempts: number;
  };
  /** notify 系 exit (auth/api/unknown) で audit_logs に書く action 名。 */
  notify?: {
    auditAction: ActivateAuditAction;
    detail: string;
  };
  /** Meta 側で活性化された external_id。Activate は通常この値を ack に返す。 */
  externalId?: string;
  /**
   * regression fix: 実 Meta API への成功した spawn を経由したことを示す
   * defensive marker。`runActivate` は status="success" + appliedRemotely=true
   * のときだけ markHierarchyActive を呼んで activate.committed を audit する。
   * Mock 経路 / テスト等で marker が無い success は fail-closed
   * (unknown_error + meta.cli_unknown_error notify) として扱う — Activate は
   * PAUSED→ACTIVE で課金を開始する最終操作のため、CLI 由来の確証なしには
   * ローカル状態を ACTIVE に進めてはならない。
   */
  appliedRemotely?: boolean;
}

export interface ActivateExecutor {
  /**
   * 1 ノード分の Activate 操作を実行する。
   *
   * 制約:
   *   - argv に access token を載せない (実装は MetaCliRunner 等の sanitize 済み runner)。
   *   - ノードが既に ACTIVE であることはオーケストレータが事前判定するので
   *     executor 側では仮定しない (mock は no-op success を返してよい)。
   */
  executeActivate(input: ActivateExecuteInput): Promise<ActivateExecuteResult>;
}

// ---------------------------------------------------------------------
// Audit chain
// ---------------------------------------------------------------------

/**
 * Activate 起点で audit_logs に書きうる action 名。
 *
 * - `activate.requested` : ConfirmDialog / CLI 引数を経て user が要求した瞬間に 1 行。
 *                          副作用 (Meta CLI 実行 / DB 状態遷移) より前に書く。
 * - `activate.committed` : Meta 側で ACTIVE 化に成功し、ads_hierarchy.status を更新した直後。
 * - `activate.rejected`  : 境界条件 (PAUSED でない / external_id 未確定 / 等) で拒否、
 *                          または executor が auth/api/unknown_error を返したとき。
 * - `oauth.meta.reauth_required` / `meta.api_error` / `meta.cli_unknown_error`:
 *                          executor が `notify` で要求した補助 audit を `activate.rejected`
 *                          と並べて記録する (apply の regression fix と同じ思想)。
 */
export type ActivateAuditAction =
  | "activate.requested"
  | "activate.committed"
  | "activate.rejected"
  | "oauth.meta.reauth_required"
  | "meta.api_error"
  | "meta.cli_unknown_error";

export interface ActivateAuditInput {
  /**
   * Activate 対象が属する workspace の id。`node_not_found` のように
   * 対象ノードが存在しない時点での audit (regression fix) では特定できないため
   * null を許容する。Prisma 側の `audit_logs.workspaceId` も nullable。
   */
  workspaceId: string | null;
  action: ActivateAuditAction;
  hierarchyId: string;
  externalId: string | null;
  metaAccountId: string | null;
  /**
   * ad_account の YAML 上のキー。`node_not_found` audit (regression fix) のみ
   * null を許容する (対象ノードが取れない以上どの account か特定できないため)。
   */
  accountKey: string | null;
  actor: string;
  source: ActivateSource;
  /** ref 列に書く識別子。既定は `ads_hierarchy:<id>`。 */
  ref?: string;
  metadata?: JsonValue;
}

// ---------------------------------------------------------------------
// Approval record boundary (implementation item)
// ---------------------------------------------------------------------

/**
 * Activate operation を `approval_records` に 1 行残すための入力。
 *
 * this implementation: Activate は GitHub PR を持たないが、Apply / Web UI
 * Merge / GitHub Merge と同じ承認境界として `approval_records` に記録する
 * 必要がある (UI design plan §0.20)。
 *
 * - `pullRequestId` は常に null で、`targetType="ads_hierarchy"` /
 *   `targetId=<hierarchyId>` を polymorphic 列に書く。
 * - `decision` は activate.committed のとき `"approved"`、`activate.rejected`
 *   のとき `"rejected"`。auto_approved / auto_blocked は PR merge 専用で、
 *   Activate からは出ない (Activate は常に明示操作)。
 * - `decisionSource` は呼び出し元の `ActivateSource` から導出する:
 *     `web`   → `web_activate`
 *     `slack` → `slack_activate`
 *     `cli`   → `cli_activate`
 *   UI / `/cron/audit` / `/approvals` の actor 帰属表示に使う。
 */
export type ActivateApprovalDecision = "approved" | "rejected";

export type ActivateDecisionSource =
  | "web_activate"
  | "slack_activate"
  | "cli_activate"
  | "discord_activate";

export interface ActivateApprovalInput {
  /** Activate 対象の workspace。runActivate は workspace 不明な経路では呼ばない。 */
  workspaceId: string;
  /** ads_hierarchy.id。`targetId` 列にそのまま入る。 */
  hierarchyId: string;
  /** "user:web-ui" / "slack:<user_id>" / "user:cli" 等。`audit_logs.actor` と一致させる。 */
  approvedBy: string;
  /** approved (activate.committed) / rejected (activate.rejected) のいずれか。 */
  decision: ActivateApprovalDecision;
  /** `metadata.decisionSource` に書く。actor 経路の正規ラベル。 */
  decisionSource: ActivateDecisionSource;
  /** sanitized 1 行コメント (Activate ノード名 / 拒否理由など)。 */
  comment?: string;
  /** sanitized 補助 metadata。decisionSource は recordApprovalRecord 実装側で必ずマージする。 */
  metadata?: JsonValue;
}

// ---------------------------------------------------------------------
// Store boundary
// ---------------------------------------------------------------------

export interface ActivateStore {
  /** ads_hierarchy + 関連 ad_account から Snapshot を返す。見つからなければ null。 */
  findHierarchyNode(hierarchyId: string): Promise<ActivateNodeSnapshot | null>;
  /** ads_hierarchy.status を "active" に更新する (Meta 側成功後にのみ呼ぶ)。 */
  markHierarchyActive(hierarchyId: string): Promise<void>;
  /** kind="activate" の execution_logs を 1 行書く。 */
  recordExecutionLog(input: ExecutionLogInput): Promise<void>;
  /** audit_logs を 1 行書く。 */
  recordAudit(input: ActivateAuditInput): Promise<void>;
  /**
   * Activate の承認境界を `approval_records` に 1 行残す (implementation item)。
   *
   * - 実装は throw しないことが望ましいが、throw した場合 runActivate は
   *   それを伝播する (audit / execution_logs と同じ扱い)。
   * - `pullRequestId` は常に null。`targetType="ads_hierarchy"`、
   *   `targetId=<hierarchyId>` を書き、`metadata.decisionSource` に
   *   `web_activate | slack_activate | cli_activate` を必ず含める。
   */
  recordApprovalRecord(input: ActivateApprovalInput): Promise<void>;
}

// ---------------------------------------------------------------------
// runActivate orchestrator
// ---------------------------------------------------------------------

export interface RunActivateOptions {
  request: ActivateRequest;
  store: ActivateStore;
  executor: ActivateExecutor;
  /** test seam: backoff sleep 関数。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * test seam: per-account lock の registry。テストで独立 Map を渡せる。
   *
   * `lockProvider` を渡したときは無視される (provider 側で in-process 段を
   * 内蔵するため)。
   */
  lockRegistry?: Map<string, Promise<unknown>>;
  /**
   * Cross-process ad_account ロック境界。
   *
   * Activate は Web (`/api/campaigns/[id]/activate`) / CLI (`addroid activate`)
   * から起動する。Apply は worker process で動くため、provider 注入が無いと
   * 別プロセスの Apply と同じ ad_account に対して同時に Meta CLI を叩きうる。
   * Production 経路 (apps/web, apps/cli, apps/worker) は必ず Postgres
   * advisory lock を背に持つ provider を渡すこと。
   *
   * 省略時は in-process フォールバック (`createInProcessAdAccountLockProvider`)
   * を使う。テストはこのフォールバックで動作する。
   */
  lockProvider?: AdAccountLockProvider;
  /** rate-limit 再試行のデフォルト最大回数。executor が retry を返さないとき適用。 */
  defaultRateLimitMaxAttempts?: number;
  /** 再試行のデフォルト初期 backoff (ms)。 */
  defaultRateLimitInitialBackoffMs?: number;
  /** 再試行のデフォルト上限 backoff (ms)。 */
  defaultRateLimitMaxBackoffMs?: number;
}

/** runActivate の終端状態。Web/CLI が ack に詰めて返す。 */
export type ActivateOutcomeStatus =
  | "activated"
  | "already_active"
  | "node_not_found"
  | "not_paused"
  | "no_external_id"
  | "auth_error"
  | "rate_limit_exhausted"
  | "api_error"
  | "unknown_error"
  | "skipped_unsupported";

export interface ActivateSummary {
  status: ActivateOutcomeStatus;
  hierarchyId: string;
  externalId: string | null;
  attempts: number;
  message: string;
  /** 終端時に書いた最終 audit の action 名。 */
  finalAuditAction: ActivateAuditAction;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `ActivateSource` → `approval_records.metadata.decisionSource` ラベル。
 *
 * UI design plan §0.20: Activate の `decisionSource` は経路ごとに
 * `web_activate | slack_activate | cli_activate` を必ず持つ。`audit_logs.actor`
 * (`user:web-ui` / `slack:<id>` / `user:cli`) と一対一で対応し、
 * `/cron/audit` / `/approvals` で actor 帰属を可視化するために使う。
 */
export function deriveActivateDecisionSource(
  source: ActivateSource
): ActivateDecisionSource {
  switch (source) {
    case "web":
      return "web_activate";
    case "slack":
      return "slack_activate";
    case "cli":
      return "cli_activate";
    case "discord":
      return "discord_activate";
  }
}

/**
 * Activate オーケストレータ本体。Web API / CLI 双方から呼ばれる。
 *
 * 流れ:
 *   1. ノード取得 / 境界判定 (PAUSED でない、external_id 未確定 等) → reject + audit 1 行で終了。
 *   2. `activate.requested` を audit_logs に記録 (副作用前)。
 *   3. ad_account level の mutex を取得。
 *   4. executor.executeActivate を試行。rate_limit_error は再試行、それ以外は break。
 *   5. success → `markHierarchyActive` + `activate.committed` audit。
 *      失敗 → executor の notify があれば補助 audit、続けて `activate.rejected` audit。
 *   6. 各試行ごとに kind="activate" の execution_logs に sanitized payload を 1 行書く。
 */
export async function runActivate(opts: RunActivateOptions): Promise<ActivateSummary> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttemptsDefault = opts.defaultRateLimitMaxAttempts ?? 3;
  const initialBackoffDefault = opts.defaultRateLimitInitialBackoffMs ?? 5_000;
  const maxBackoffDefault = opts.defaultRateLimitMaxBackoffMs ?? 60_000;
  // regression fix: cross-process ad_account ロック provider。production の
  // web/cli は Postgres advisory lock 実装を必ず注入する。テスト / standalone
  // は省略でき、その場合は in-process フォールバックを使う。
  // `opts.lockRegistry` は legacy seam として in-process フォールバックの
  // registry にだけ反映する (provider 注入時は意味を持たない)。
  const lockProvider: AdAccountLockProvider =
    opts.lockProvider ??
    createInProcessAdAccountLockProvider(opts.lockRegistry ?? new Map());
  const { request, store, executor } = opts;

  const node = await store.findHierarchyNode(request.hierarchyId);
  if (!node) {
    // regression fix: ノード未存在でも Activate 失敗事象として audit_logs に
    // 1 行残す。workspaceId / accountKey / metaAccountId / externalId は
    // 特定できないため null で記録するが、actor / source / 要求された
    // hierarchyId / 失敗理由は保持され、誰がどの経路でどのノードを
    // Activate しようとしたかが監査可能になる。Prisma 側の audit_logs は
    // workspaceId nullable なのでそのまま受けられる。
    await store.recordAudit({
      workspaceId: null,
      action: "activate.rejected",
      hierarchyId: request.hierarchyId,
      externalId: null,
      metaAccountId: null,
      accountKey: null,
      actor: request.actor,
      source: request.source,
      ref: `ads_hierarchy:${request.hierarchyId}`,
      metadata: {
        reason: "node_not_found",
        requestedHierarchyId: request.hierarchyId,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    return {
      status: "node_not_found",
      hierarchyId: request.hierarchyId,
      externalId: null,
      attempts: 0,
      message: `ads_hierarchy node not found: ${request.hierarchyId}`,
      finalAuditAction: "activate.rejected",
    };
  }

  const nodeStatus = (node.status ?? "").toLowerCase();
  const baseAuditFields = {
    workspaceId: node.workspaceId,
    hierarchyId: node.hierarchyId,
    externalId: node.externalId,
    metaAccountId: node.metaAccountId,
    accountKey: node.accountKey,
    actor: request.actor,
    source: request.source,
    ref: `ads_hierarchy:${node.hierarchyId}`,
  } as const;

  const decisionSource = deriveActivateDecisionSource(request.source);

  // 境界: 既に ACTIVE
  if (nodeStatus === "active") {
    await store.recordAudit({
      ...baseAuditFields,
      action: "activate.rejected",
      metadata: {
        reason: "already_active",
        nodeType: node.nodeType,
        displayName: node.displayName,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    await store.recordApprovalRecord({
      workspaceId: node.workspaceId,
      hierarchyId: node.hierarchyId,
      approvedBy: request.actor,
      decision: "rejected",
      decisionSource,
      comment: `activate ${node.nodeType} ${node.displayName} rejected: already_active`,
      metadata: {
        reason: "already_active",
        nodeType: node.nodeType,
        displayName: node.displayName,
        externalId: node.externalId,
        accountKey: node.accountKey,
        source: request.source,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    return {
      status: "already_active",
      hierarchyId: node.hierarchyId,
      externalId: node.externalId,
      attempts: 0,
      message: `${node.nodeType} ${node.displayName} は既に ACTIVE です`,
      finalAuditAction: "activate.rejected",
    };
  }

  // 境界: PAUSED 以外 (archived / deleted 等)
  if (nodeStatus !== "paused") {
    await store.recordAudit({
      ...baseAuditFields,
      action: "activate.rejected",
      metadata: {
        reason: "not_paused",
        currentStatus: node.status,
        nodeType: node.nodeType,
        displayName: node.displayName,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    await store.recordApprovalRecord({
      workspaceId: node.workspaceId,
      hierarchyId: node.hierarchyId,
      approvedBy: request.actor,
      decision: "rejected",
      decisionSource,
      comment: `activate ${node.nodeType} ${node.displayName} rejected: not_paused (${node.status})`,
      metadata: {
        reason: "not_paused",
        currentStatus: node.status,
        nodeType: node.nodeType,
        displayName: node.displayName,
        externalId: node.externalId,
        accountKey: node.accountKey,
        source: request.source,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    return {
      status: "not_paused",
      hierarchyId: node.hierarchyId,
      externalId: node.externalId,
      attempts: 0,
      message: `${node.nodeType} ${node.displayName} は ${node.status} のため Activate 対象外です`,
      finalAuditAction: "activate.rejected",
    };
  }

  // 境界: external_id 未確定 (Apply 未完了のためまだ Meta に存在しない)
  if (!node.externalId) {
    await store.recordAudit({
      ...baseAuditFields,
      action: "activate.rejected",
      metadata: {
        reason: "no_external_id",
        nodeType: node.nodeType,
        displayName: node.displayName,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    await store.recordApprovalRecord({
      workspaceId: node.workspaceId,
      hierarchyId: node.hierarchyId,
      approvedBy: request.actor,
      decision: "rejected",
      decisionSource,
      comment: `activate ${node.nodeType} ${node.displayName} rejected: no_external_id (Apply 未完了)`,
      metadata: {
        reason: "no_external_id",
        nodeType: node.nodeType,
        displayName: node.displayName,
        accountKey: node.accountKey,
        source: request.source,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
    return {
      status: "no_external_id",
      hierarchyId: node.hierarchyId,
      externalId: null,
      attempts: 0,
      message: `${node.nodeType} ${node.displayName} は Meta 側 external_id が未確定です (Apply 待機中)`,
      finalAuditAction: "activate.rejected",
    };
  }

  // 副作用前に「要求された」事実を残す
  await store.recordAudit({
    ...baseAuditFields,
    action: "activate.requested",
    metadata: {
      nodeType: node.nodeType,
      displayName: node.displayName,
      ...(request.note !== undefined ? { note: request.note } : {}),
    },
  });

  // closure 内の narrowing が消えないよう非 null の node を const で固定する。
  const fixedNode = node;
  // regression fix: lock 識別子は `buildAdAccountLockKey({ workspaceId,
  // accountKey })` の canonical 形を使い、Apply (`runExecuteApply`) と同じ
  // 識別子に解決する。旧実装は accountId (UUID) を渡しており、Apply 経路
  // (accountKey 文字列) と識別子が一致しなかったため Apply×Activate の race
  // を直列化できていなかった。
  // regression fix: 旧実装は `withAccountLock` の module-local Map を直接呼んで
  // いたため、Activate 経路 (apps/web, apps/cli) と Apply 経路 (apps/worker)
  // が別プロセスから同じ ad_account を触る race を直列化できなかった。
  // `lockProvider` (production では Postgres advisory lock を背に持つ実装) を
  // 経由することで cross-process でも 1 並行を強制する。
  return lockProvider.withLock(
    buildAdAccountLockKey({
      workspaceId: fixedNode.workspaceId,
      accountKey: fixedNode.accountKey,
    }),
    () =>
      runActivateUnderLock({
        node: fixedNode,
        request,
        executor,
        store,
        sleep,
        maxAttemptsDefault,
        initialBackoffDefault,
        maxBackoffDefault,
        baseAuditFields,
      })
  );
}

interface RunActivateUnderLockOptions {
  node: ActivateNodeSnapshot;
  request: ActivateRequest;
  executor: ActivateExecutor;
  store: ActivateStore;
  sleep: (ms: number) => Promise<void>;
  maxAttemptsDefault: number;
  initialBackoffDefault: number;
  maxBackoffDefault: number;
  baseAuditFields: BaseAuditFields;
}

async function runActivateUnderLock(
  opts: RunActivateUnderLockOptions
): Promise<ActivateSummary> {
  const {
    node,
    request,
    executor,
    store,
    sleep,
    maxAttemptsDefault,
    initialBackoffDefault,
    maxBackoffDefault,
    baseAuditFields,
  } = opts;

  let attempt = 0;
  let lastResult: ActivateExecuteResult | null = null;

  while (true) {
    attempt += 1;
    let result: ActivateExecuteResult;
    try {
      result = await executor.executeActivate({
        node,
        attempt: attempt - 1,
        request,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        status: "unknown_error",
        message: `activate executor threw: ${message}`,
        logPayload: { errorMessage: message } satisfies JsonValue,
      };
    }
    lastResult = result;

    await store.recordExecutionLog({
      workspaceId: node.workspaceId,
      kind: "activate",
      refType: "ads_hierarchy",
      refId: node.hierarchyId,
      level: result.status === "success" ? "info" : "warn",
      message: `activate ${node.nodeType} ${node.displayName} (${node.accountKey}) → ${result.status} [attempt ${attempt}]`,
      payload: buildExecutionPayload({
        executor: result.logPayload,
        attempt,
        actor: request.actor,
        source: request.source,
        node,
        ...(request.note !== undefined ? { note: request.note } : {}),
      }),
    });

    if (result.status === "success") {
      // regression fix: defensive guard. Only commit (markHierarchyActive +
      // activate.committed) when the executor proves the success came from
      // a real Meta CLI invocation (CliActivateExecutor sets appliedRemotely
      // on actual exit-class=success). Anything else (mock, misconfigured
      // executor, future regressions) is reclassified as a fail-closed
      // unknown_error so the local hierarchy never advances to ACTIVE
      // without confirmation from Meta.
      if (result.appliedRemotely === true) {
        await store.markHierarchyActive(node.hierarchyId);
        const committedExternalId = result.externalId ?? node.externalId;
        await store.recordAudit({
          ...baseAuditFields,
          externalId: committedExternalId,
          action: "activate.committed",
          metadata: {
            nodeType: node.nodeType,
            displayName: node.displayName,
            attempts: attempt,
            ...(request.note !== undefined ? { note: request.note } : {}),
          },
        });
        // implementation item: 成功時は `approval_records.decision="approved"` を 1 行残し、
        // PR merge と同じ承認境界として `/approvals` / `/cron/audit` から actor
        // 帰属を辿れるようにする。
        await store.recordApprovalRecord({
          workspaceId: node.workspaceId,
          hierarchyId: node.hierarchyId,
          approvedBy: request.actor,
          decision: "approved",
          decisionSource: deriveActivateDecisionSource(request.source),
          comment: `activate ${node.nodeType} ${node.displayName} committed (attempts=${attempt})`,
          metadata: {
            outcome: "activated",
            nodeType: node.nodeType,
            displayName: node.displayName,
            externalId: committedExternalId,
            accountKey: node.accountKey,
            attempts: attempt,
            source: request.source,
            ...(request.note !== undefined ? { note: request.note } : {}),
          },
        });
        return {
          status: "activated",
          hierarchyId: node.hierarchyId,
          externalId: committedExternalId,
          attempts: attempt,
          message: result.message,
          finalAuditAction: "activate.committed",
        };
      }
      // success without appliedRemotely → rewrite to unknown_error and let the
      // shared rejection path (notify + activate.rejected) record the failure.
      const detail =
        "executor reported success without appliedRemotely=true; refusing to commit ACTIVE without verified Meta CLI success";
      lastResult = {
        status: "unknown_error",
        message: `activate ${node.nodeType} ${node.displayName} aborted: ${detail}`,
        logPayload: {
          ...(typeof result.logPayload === "object" && result.logPayload !== null && !Array.isArray(result.logPayload)
            ? (result.logPayload as { [k: string]: JsonValue })
            : { executor: result.logPayload }),
          guard: "missing_applied_remotely",
          originalStatus: "success",
        } satisfies JsonValue,
        notify: {
          auditAction: "meta.cli_unknown_error",
          detail,
        },
      };
      break;
    }

    if (result.status === "rate_limit_error") {
      const max = result.retry?.maxAttempts ?? maxAttemptsDefault;
      if (attempt >= max) break;
      const delay =
        result.retry?.delayMs ??
        computeBackoffDelayMs(attempt, {
          maxAttempts: maxAttemptsDefault,
          initialBackoffMs: initialBackoffDefault,
          maxBackoffMs: maxBackoffDefault,
          factor: 2,
        } satisfies MetaRateLimitPolicy);
      await sleep(delay);
      continue;
    }

    // auth_error / api_error / unknown_error / skipped: 再試行せず break
    break;
  }

  const finalResult = lastResult!;
  if (finalResult.notify) {
    await store.recordAudit({
      ...baseAuditFields,
      action: finalResult.notify.auditAction,
      metadata: {
        nodeType: node.nodeType,
        displayName: node.displayName,
        attempts: attempt,
        status: finalResult.status,
        detail: finalResult.notify.detail,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    });
  }

  const outcome = mapOutcome(finalResult.status);

  await store.recordAudit({
    ...baseAuditFields,
    action: "activate.rejected",
    metadata: {
      reason: outcome,
      nodeType: node.nodeType,
      displayName: node.displayName,
      attempts: attempt,
      ...(request.note !== undefined ? { note: request.note } : {}),
    },
  });

  // implementation item: executor 失敗 (auth_error / api_error / rate_limit_exhausted /
  // unknown_error / skipped_unsupported) も `approval_records.decision="rejected"`
  // として 1 行残す。承認境界は merge / activate どちらの経路でも統一される。
  await store.recordApprovalRecord({
    workspaceId: node.workspaceId,
    hierarchyId: node.hierarchyId,
    approvedBy: request.actor,
    decision: "rejected",
    decisionSource: deriveActivateDecisionSource(request.source),
    comment: `activate ${node.nodeType} ${node.displayName} rejected: ${outcome} (attempts=${attempt})`,
    metadata: {
      outcome,
      reason: outcome,
      nodeType: node.nodeType,
      displayName: node.displayName,
      externalId: node.externalId,
      accountKey: node.accountKey,
      attempts: attempt,
      source: request.source,
      ...(finalResult.notify ? { notify: finalResult.notify.auditAction } : {}),
      ...(request.note !== undefined ? { note: request.note } : {}),
    },
  });

  return {
    status: outcome,
    hierarchyId: node.hierarchyId,
    externalId: node.externalId,
    attempts: attempt,
    message: finalResult.message,
    finalAuditAction: "activate.rejected",
  };
}

interface BaseAuditFields {
  workspaceId: string;
  hierarchyId: string;
  externalId: string | null;
  metaAccountId: string | null;
  accountKey: string;
  actor: string;
  source: ActivateSource;
  ref: string;
}

/**
 * ActivateExecuteStatus → ActivateOutcomeStatus の射影。
 * "success" は呼び出し側で先に処理されている前提なので、ここでは到達しない。
 */
function mapOutcome(status: ActivateExecuteResult["status"]): ActivateOutcomeStatus {
  switch (status) {
    case "rate_limit_error":
      return "rate_limit_exhausted";
    case "skipped":
      return "skipped_unsupported";
    case "auth_error":
      return "auth_error";
    case "api_error":
      return "api_error";
    case "unknown_error":
      return "unknown_error";
    case "success":
    default:
      // success は本来呼ばれないが、防御的に unknown_error に倒す
      return "unknown_error";
  }
}

function buildExecutionPayload(input: {
  executor: JsonValue;
  attempt: number;
  actor: string;
  source: ActivateSource;
  node: ActivateNodeSnapshot;
  note?: string;
}): JsonValue {
  const out: { [key: string]: JsonValue } = {
    attempt: input.attempt,
    actor: input.actor,
    source: input.source,
    nodeType: input.node.nodeType,
    accountKey: input.node.accountKey,
    metaAccountId: input.node.metaAccountId ?? null,
    externalId: input.node.externalId ?? null,
    displayName: input.node.displayName,
    executor: input.executor,
  };
  if (input.note !== undefined) out.note = input.note;
  return out;
}
