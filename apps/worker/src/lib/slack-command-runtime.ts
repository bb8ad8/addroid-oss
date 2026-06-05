// AdDroid OSS — apps/worker `/adops` slash command handlers (Regression fix).
//
// `runSlackCommandJob` (queue) は SlashCommandHandlers 6 種を要求するが、
// その production 実装はこれまで worker runtime に存在しなかった。本ファイルは
// 各 subcommand を Prisma + 既存ワークフロー (daily_report / budget_guard /
// improvement_pr / activate) に橋渡しし、結果を Slack response_url 用の
// `SlashHandlerOutcome` に正規化する。
//
// 設計原則:
//   - 各ハンドラは throw しない契約 (Slack 失敗が GitOps polling / Apply / Cron
//     に伝播しないため)。下位 API が throw した場合は本ファイルで catch して
//     `state="failed"` の outcome に倒す。runSlackCommandJob の orchestrator も
//     最後の砦として throw を catch するが、ここでメッセージを sanitize した
//     上で `errorCode` 付きで返したほうが Slack 上の文言が読みやすい。
//   - `report` / `budget` / `improve` は cron handler と同じ per-account ループを
//     走らせる。`runtime.ts` の cron 分岐と完全重複を避けるため、ここでは
//     cron_run / cron_schedules には書き込まず、`runDailyReportOnce` /
//     `runBudgetGuardOnce` / `runImprovementPrOnce` の戻り値だけを集約して
//     Slack 用サマリに翻訳する (これらは `performance_snapshots` / `ai_runs` /
//     `audit_logs` を内部で永続化する)。
//   - `activate` は Web/CLI と同じ `executeActivate` を呼び、`source: "slack"` /
//     `actor: slack:<user_id>` を渡す。`runActivate` は `audit_logs` に
//     `activate.requested` / `.committed` / `.rejected` を残し、
//     `runSlackCommandJob` の audit writer は別に `activate.via_slack` を
//     1 行残す (UI design plan §0.20: actor 帰属の二系統表示)。
//   - sanitize: 下位 API が返す message / errorMessage は token 漏洩経路として
//     最も短い。本ファイルでは `sanitizeText` を Slack 出力前に必ず通す。

import {
  buildAdAccountLockKey,
  resolveExecutionMode,
  runBudgetGuardOnce,
  runDailyReportOnce,
  runImprovementPrOnce,
  sanitizeText,
  type AdAccountLockProvider,
  type BudgetGuardSummary,
  type DailyReportSnapshotStore,
  type DailyReportInsightsProvider,
  type DailyReportAnalystRunner,
  type DailyReportSummary,
  type ImprovementPrAuditWriter,
  type ImprovementPrGithubPublisher,
  type ImprovementPrPipelineRunner,
  type ImprovementPrPlanValidator,
  type ImprovementPrStore,
  type ImprovementPrSummary,
  type BudgetGuardAuditRunner,
  type BudgetGuardStore,
  type SlashCommandHandlers,
  type SlashHandlerInput,
  type SlashHandlerOutcome,
} from "@addroid/queue";
import type {
  CreativeQaPolicy,
  CreativeStorageAdapter,
  ImageProvider,
  LLMProvider,
} from "@addroid/llm-provider";
import type { PrismaClient } from "@addroid/db";
import {
  fetchMetaAssetReadiness,
  formatMetaAssetReadinessSummary,
  type MetaAdapter,
  type MetaAssetReadinessReport,
} from "@addroid/meta-adapter";
import { executeActivate } from "./activate-runtime.js";
import { type LoadedBudgetGuardPolicy, buildBudgetGuardSpendContext } from "./budget-guard-runtime.js";
import { loadRecentPerformanceSnapshotContext } from "./improvement-pr-performance-context.js";
import { enrichCreativeGenerationContext } from "./creative-generation-context.js";
import { refreshLatestInsightsForManualImprovementPr } from "./improvement-pr-insights-refresh.js";
import { formatImprovementReportForUser } from "./improvement-report-format.js";

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export interface SlackCommandHandlersDeps {
  prisma: PrismaClient;
  workspaceId: string;

  // ad_account 単位の cross-process 直列化境界 (Apply / Activate / cron と共有)。
  adAccountLockProvider: AdAccountLockProvider;

  // daily_report ワークフロー境界。
  dailyReportStore: DailyReportSnapshotStore;
  dailyReportInsights: DailyReportInsightsProvider;
  dailyReportAnalyst: DailyReportAnalystRunner;
  /** account timezone が無い場合のユーザー/実行環境 timezone。 */
  userTimeZone?: string | null;

  // budget_guard ワークフロー境界。
  budgetGuardStore: BudgetGuardStore;
  budgetGuardAuditRunner: BudgetGuardAuditRunner;
  /**
   * `loadBudgetGuardPolicy(env)` を都度呼び直すローダ。cron handler と同じく
   * 1 ティックごとに ops repo の `workflows/budget-guard.yaml` を読み直す
   * ことで、運用者が CLI / web 経由でファイルを差し替えた場合も次の
   * `/adops budget` で反映される。`null` を返すと fail-closed
   * (`policy_missing`) で抜ける。
   */
  loadBudgetGuardPolicy: () => LoadedBudgetGuardPolicy | null;

  // improvement_pr ワークフロー境界。
  improvementPrStore: ImprovementPrStore;
  improvementPrPipeline: ImprovementPrPipelineRunner;
  improvementPrPublisher: ImprovementPrGithubPublisher;
  improvementPrPlanValidator: ImprovementPrPlanValidator;
  improvementPrAudit: ImprovementPrAuditWriter;
  /**
   * regression fix: image-Provider hop。`/adops improve` 経由で起動された
   * improvement_pr も、cron 経路と同じ image_prompt → 実画像生成 → Creative QA
   * → LocalDisk Storage Adapter 永続化のパスを通る。Provider 未設定 / 失敗時は
   * prompt-only fallback (UI design plan principle 27)。
  */
  improvementPrImageProvider?: ImageProvider | null;
  improvementPrLlmProvider?: LLMProvider | null;
  improvementPrCreativeStorage?: CreativeStorageAdapter | null;
  /**
   * regression fix: cron 経路と同じ非空 Creative QA policy を `/adops improve`
   * からも適用する。未指定なら `runImprovementPrOnce` 内のデフォルト
   * (`DEFAULT_CREATIVE_QA_POLICY`) が効く。
   */
  improvementPrCreativeQaPolicy?: CreativeQaPolicy | null;
  /**
   * 実行時に `improvement_pr` 用の ops repo 仕様 (`owner/name` + base ref) を
   * 読み出すローダ。cron handler と同じく `workspace.opsRepoId` →
   * `github_repos` の lookup を /adops invocation のたびに実行することで、
   * 連携先 repo の変更が即座に反映される。`repoSpec === ""` のときは ops repo
   * 未連携と扱われ、handler は `ops_repo_not_configured` で抜ける。
   */
  loadImprovementPrRepo: () => Promise<{ repoSpec: string; baseRef: string }>;

  // activate (executeActivate) 用。
  metaAdapter: MetaAdapter;

  // 任意: Web UI への deep link 用 base URL (例 "http://127.0.0.1:3000")。
  // 未設定なら detailUrl は付けない (Slack UI は plain text fallback だけ表示)。
  webBaseUrl?: string | null;

  /** test seam: 現在時刻 (主に slack copy のタイムゾーン整形には使わないが残す)。 */
  now?: () => Date;

  /** test seam: process.env (executeActivate に渡す)。 */
  env?: NodeJS.ProcessEnv;

  /**
   * このハンドラ群を駆動した対話チャネル。activate の actor 帰属 / `source` /
   * note 文言に使う。既定は "slack" で従来挙動を完全維持する。Discord 経路は
   * "discord" を渡し、actor=`discord:<id>` / source="discord" で audit される。
   */
  commandSource?: "slack" | "discord";
}

export function createSlackCommandHandlers(
  deps: SlackCommandHandlersDeps
): SlashCommandHandlers {
  return {
    report: (input) => handleReport(deps, input),
    budget: (input) => handleBudget(deps, input),
    improve: (input) => handleImprove(deps, input),
    status: (_input) => handleStatus(deps),
    accounts: (_input) => handleAccounts(deps),
    activate: (input) => handleActivate(deps, input),
  };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

async function loadActiveAdAccounts(
  prisma: PrismaClient,
  workspaceId: string
): Promise<
  Array<{
    id: string;
    key: string;
    displayName: string;
    metaAccountId: string | null;
    currency: string | null;
    timezoneName: string | null;
    modeOverride: string | null;
  }>
> {
  return prisma.adAccount.findMany({
    where: { workspaceId, active: true },
    select: {
      id: true,
      key: true,
      displayName: true,
      metaAccountId: true,
      currency: true,
      timezoneName: true,
      modeOverride: true,
    },
    orderBy: { key: "asc" },
  });
}

async function loadWorkspaceMode(
  prisma: PrismaClient,
  workspaceId: string
): Promise<string | null> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { executionMode: true },
  });
  return row?.executionMode ?? null;
}

function deepLink(deps: SlackCommandHandlersDeps, path: string): string | undefined {
  const base = (deps.webBaseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(base)) return undefined;
  return base.replace(/\/+$/, "") + path;
}

function buildImprovementRefreshFailedSummary(input: {
  workspaceId: string;
  accountId: string;
  accountKey: string;
  currency: string;
  mode: ImprovementPrSummary["mode"];
  refresh: Awaited<ReturnType<typeof refreshLatestInsightsForManualImprovementPr>>;
}): ImprovementPrSummary {
  return {
    status: "ai_failed",
    workspaceId: input.workspaceId,
    accountKey: input.accountKey,
    accountId: input.accountId,
    mode: input.mode,
    aiRunId: null,
    aiRunIds: [],
    creativeIds: [],
    decision: null,
    proposalCount: 0,
    currency: input.currency,
    pullRequest: null,
    classification: null,
    auditDecision: null,
    dangerousCategories: [],
    errorMessage:
      "最新レポートを取得できなかったため、古い実績を使った改善提案は作成しませんでした。" +
      (input.refresh.errors.length > 0
        ? ` ${input.refresh.errors.join("; ")}`
        : ""),
  };
}

function summarizeMessage(text: string): string {
  // Slack 通知の text 欄は 1 行サマリに使うため、末尾の空白と過剰な改行を畳む。
  // sanitize は postSlackResponse でもう一度かかるが、本層でも実施する (二重防御)。
  return sanitizeText(text.trim().replace(/\s+/g, " ")).slice(0, 600);
}

function isReadableCreativeStorage(
  value: CreativeStorageAdapter | null | undefined
): value is CreativeStorageAdapter & {
  read(key: string): Promise<Buffer>;
  readText(key: string): Promise<string>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { read?: unknown }).read === "function" &&
    typeof (value as { readText?: unknown }).readText === "function"
  );
}

// ---------------------------------------------------------------------
// status
// ---------------------------------------------------------------------

async function handleStatus(
  deps: SlackCommandHandlersDeps
): Promise<SlashHandlerOutcome> {
  try {
    const ws = await deps.prisma.workspace.findUnique({
      where: { id: deps.workspaceId },
      select: { slug: true, executionMode: true, opsRepoId: true },
    });
    const accountCount = await deps.prisma.adAccount.count({
      where: { workspaceId: deps.workspaceId, active: true },
    });
    const pendingPrCount = ws?.opsRepoId
      ? await deps.prisma.githubPullRequest.count({
          where: { repoId: ws.opsRepoId, state: "open" },
        })
      : 0;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentAiRunCount = await deps.prisma.aiRun.count({
      where: { workspaceId: deps.workspaceId, startedAt: { gte: since } },
    });
    const lastApply = await deps.prisma.applyJob.findFirst({
      where: { pullRequest: { repoId: ws?.opsRepoId ?? "" } },
      orderBy: { enqueuedAt: "desc" },
      select: { state: true, finishedAt: true, enqueuedAt: true },
    });
    const lastApplyText = lastApply
      ? `${lastApply.state} (${(lastApply.finishedAt ?? lastApply.enqueuedAt).toISOString()})`
      : "no apply jobs yet";
    const text = summarizeMessage(
      `workspace=${ws?.slug ?? deps.workspaceId} mode=${ws?.executionMode ?? "unknown"} ` +
        `active_accounts=${accountCount} pending_prs=${pendingPrCount} ` +
        `ai_runs_24h=${recentAiRunCount} last_apply=${lastApplyText}`
    );
    const url = deepLink(deps, "/");
    return {
      state: "succeeded",
      text,
      ...(url ? { detailUrl: url } : {}),
      metadata: {
        executionMode: ws?.executionMode ?? null,
        activeAccounts: accountCount,
        pendingPrs: pendingPrCount,
        recentAiRuns24h: recentAiRunCount,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "failed",
      text: summarizeMessage(`status の取得に失敗しました: ${message}`),
      errorCode: "status_query_failed",
    };
  }
}

// ---------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------

async function handleAccounts(
  deps: SlackCommandHandlersDeps
): Promise<SlashHandlerOutcome> {
  try {
    const accounts = await loadActiveAdAccounts(deps.prisma, deps.workspaceId);
    if (accounts.length === 0) {
      return {
        state: "succeeded",
        text: "登録された ad_account がありません。/setup から追加してください。",
        ...(deepLink(deps, "/accounts")
          ? { detailUrl: deepLink(deps, "/accounts")! }
          : {}),
      };
    }
    const readiness = await loadSlackMetaReadiness(deps, accounts);
    const lines = accounts
      .slice(0, 20)
      .map(
        (a) =>
          `- ${a.key} (${a.displayName})` +
          (a.metaAccountId ? ` meta=${a.metaAccountId}` : " meta=unconfigured") +
          (a.modeOverride ? ` mode_override=${a.modeOverride}` : "")
      );
    const more = accounts.length > 20 ? ` (+${accounts.length - 20} more)` : "";
    const readinessLine = summarizeSlackReadiness(readiness);
    const text = summarizeMessage(
      `Active ad_accounts (${accounts.length})${more}${readinessLine ? `\n${readinessLine}` : ""}\n` +
        lines.join("\n")
    );
    const url = deepLink(deps, "/accounts");
    return {
      state: "succeeded",
      text,
      ...(url ? { detailUrl: url } : {}),
      metadata: { count: accounts.length, assetReadiness: readiness },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "failed",
      text: summarizeMessage(`accounts の取得に失敗しました: ${message}`),
      errorCode: "accounts_query_failed",
    };
  }
}

async function loadSlackMetaReadiness(
  deps: SlackCommandHandlersDeps,
  accounts: readonly { key: string; metaAccountId: string | null }[]
): Promise<MetaAssetReadinessReport[]> {
  if (typeof deps.metaAdapter.loadAccessTokenPlaintext !== "function") return [];
  const lease = await deps.metaAdapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease) return [];
  return await Promise.all(
    accounts.slice(0, 10).map((account) =>
      fetchMetaAssetReadiness({
        accessToken: lease.accessToken,
        adAccountId: account.metaAccountId ?? account.key,
        limit: 50,
      })
    )
  );
}

function summarizeSlackReadiness(readiness: readonly MetaAssetReadinessReport[]): string {
  if (readiness.length === 0) return "";
  const blocked = readiness.filter((report) => !report.ok);
  if (blocked.length > 0) {
    return `meta_asset_check=attention ${blocked.length}/${readiness.length} ${blocked[0]!.messages[0] ?? formatMetaAssetReadinessSummary(blocked[0]!)}`;
  }
  return `meta_asset_check=ok ${readiness.length}/${readiness.length}`;
}

// ---------------------------------------------------------------------
// report (daily_report across active ad_accounts)
// ---------------------------------------------------------------------

async function handleReport(
  deps: SlackCommandHandlersDeps,
  _input: SlashHandlerInput
): Promise<SlashHandlerOutcome> {
  try {
    const accounts = await loadActiveAdAccounts(deps.prisma, deps.workspaceId);
    if (accounts.length === 0) {
      return {
        state: "succeeded",
        text: "アクティブな ad_account がないため daily_report をスキップしました。/setup から追加してください。",
        metadata: { accountsProcessed: 0 },
      };
    }
    const wsMode = await loadWorkspaceMode(deps.prisma, deps.workspaceId);
    const summaries: DailyReportSummary[] = [];
    for (const acc of accounts) {
      const effectiveMode = resolveExecutionMode(wsMode, acc.modeOverride);
      const summary = await deps.adAccountLockProvider.withLock(
        buildAdAccountLockKey({
          workspaceId: deps.workspaceId,
          accountKey: acc.key,
        }),
        () =>
          runDailyReportOnce({
            workspaceId: deps.workspaceId,
            mode: effectiveMode,
            accountKey: acc.key,
            fallbackTimeZone: deps.userTimeZone,
            insightsProvider: deps.dailyReportInsights,
            store: deps.dailyReportStore,
            analyst: deps.dailyReportAnalyst,
          })
      );
      summaries.push(summary);
    }
    const succeeded = summaries.filter((s) => s.status === "succeeded").length;
    const aiFailed = summaries.filter((s) => s.status === "ai_failed").length;
    const noInsights = summaries.filter((s) => s.status === "no_insights").length;
    const state: SlashHandlerOutcome["state"] = aiFailed > 0 ? "failed" : "succeeded";
    const lines = [
      `daily_report: processed ${summaries.length} ad_accounts`,
      `succeeded=${succeeded} ai_failed=${aiFailed} no_insights=${noInsights}`,
    ];
    const headlines = summaries
      .filter((s) => s.status === "succeeded" && s.aiCommentary)
      .slice(0, 3)
      .map((s) => `• ${s.accountKey}: ${(s.aiCommentary ?? "").slice(0, 200)}`);
    if (headlines.length > 0) {
      lines.push("highlights:");
      lines.push(...headlines);
    }
    const url = deepLink(deps, "/reports");
    const out: SlashHandlerOutcome = {
      state,
      text: summarizeMessage(lines.join("\n")),
      metadata: {
        accountsProcessed: summaries.length,
        succeeded,
        ai_failed: aiFailed,
        no_insights: noInsights,
      },
    };
    if (url) out.detailUrl = url;
    if (state === "failed") out.errorCode = "ai_failed";
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "failed",
      text: summarizeMessage(`daily_report の実行に失敗しました: ${message}`),
      errorCode: "daily_report_failed",
    };
  }
}

// ---------------------------------------------------------------------
// budget (budget_guard across active ad_accounts)
// ---------------------------------------------------------------------

async function handleBudget(
  deps: SlackCommandHandlersDeps,
  _input: SlashHandlerInput
): Promise<SlashHandlerOutcome> {
  try {
    const accounts = await loadActiveAdAccounts(deps.prisma, deps.workspaceId);
    if (accounts.length === 0) {
      return {
        state: "succeeded",
        text: "アクティブな ad_account がないため budget_guard をスキップしました。",
        metadata: { accountsProcessed: 0 },
      };
    }
    const wsMode = await loadWorkspaceMode(deps.prisma, deps.workspaceId);
    const loaded = deps.loadBudgetGuardPolicy();
    const summaries: BudgetGuardSummary[] = [];
    for (const acc of accounts) {
      const effectiveMode = resolveExecutionMode(wsMode, acc.modeOverride);
      const accountBudget = loaded?.accountBudgets[acc.key];
      const summary = await deps.adAccountLockProvider.withLock(
        buildAdAccountLockKey({
          workspaceId: deps.workspaceId,
          accountKey: acc.key,
        }),
        async () =>
          loaded
            ? runBudgetGuardOnce({
                workspaceId: deps.workspaceId,
                mode: effectiveMode,
                accountKey: acc.key,
                policy: loaded.policy,
                spendContext: await buildBudgetGuardSpendContext({
                  prisma: deps.prisma,
                  accountId: acc.id,
                  dailyBudget: accountBudget?.dailyBudget ?? 0,
                  monthlyBudget: accountBudget?.monthlyBudget ?? 0,
                  ...(accountBudget?.currency
                    ? { currency: accountBudget.currency }
                    : {}),
                }),
                store: deps.budgetGuardStore,
                runner: deps.budgetGuardAuditRunner,
              })
            : runBudgetGuardOnce({
                workspaceId: deps.workspaceId,
                mode: effectiveMode,
                accountKey: acc.key,
                policy: null,
                store: deps.budgetGuardStore,
                runner: deps.budgetGuardAuditRunner,
              })
      );
      summaries.push(summary);
    }
    const succeeded = summaries.filter((s) => s.status === "succeeded").length;
    const aiFailed = summaries.filter((s) => s.status === "ai_failed").length;
    const policyMissing = summaries.filter(
      (s) => s.status === "policy_missing"
    ).length;
    const triggeredAlerts = summaries
      .flatMap((s) => s.alerts)
      .filter((a) => a.severity === "warn" || a.severity === "trigger");
    const state: SlashHandlerOutcome["state"] =
      aiFailed > 0 ? "failed" : "succeeded";
    const lines = [
      `budget_guard: processed ${summaries.length} ad_accounts`,
      `succeeded=${succeeded} ai_failed=${aiFailed} policy_missing=${policyMissing}`,
    ];
    if (triggeredAlerts.length > 0) {
      lines.push(`alerts=${triggeredAlerts.length}`);
      const top = triggeredAlerts
        .slice(0, 3)
        .map((a) => `• ${a.severity}: ${a.rule} — ${a.message}`);
      lines.push(...top);
    }
    const url = deepLink(deps, "/budget-guard");
    const out: SlashHandlerOutcome = {
      state,
      text: summarizeMessage(lines.join("\n")),
      metadata: {
        accountsProcessed: summaries.length,
        succeeded,
        ai_failed: aiFailed,
        policy_missing: policyMissing,
        alerts: triggeredAlerts.length,
      },
    };
    if (url) out.detailUrl = url;
    if (state === "failed") out.errorCode = "ai_failed";
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "failed",
      text: summarizeMessage(`budget_guard の実行に失敗しました: ${message}`),
      errorCode: "budget_guard_failed",
    };
  }
}

// ---------------------------------------------------------------------
// improve (improvement_pr across active ad_accounts)
// ---------------------------------------------------------------------

async function handleImprove(
  deps: SlackCommandHandlersDeps,
  _input: SlashHandlerInput
): Promise<SlashHandlerOutcome> {
  try {
    const repo = await deps.loadImprovementPrRepo();
    if (!repo.repoSpec) {
      return {
        state: "failed",
        text: "improvement_pr: ops repository が未連携のため PR を作成できません。/setup から GitHub OAuth を完了してください。",
        errorCode: "ops_repo_not_configured",
      };
    }
    const accounts = await loadActiveAdAccounts(deps.prisma, deps.workspaceId);
    if (accounts.length === 0) {
      return {
        state: "succeeded",
        text: "アクティブな ad_account がないため improvement_pr をスキップしました。",
        metadata: { accountsProcessed: 0 },
      };
    }
    const wsMode = await loadWorkspaceMode(deps.prisma, deps.workspaceId);
    const summaries: ImprovementPrSummary[] = [];
    for (const acc of accounts) {
      const effectiveMode = resolveExecutionMode(wsMode, acc.modeOverride);
      const summary = await deps.adAccountLockProvider.withLock(
        buildAdAccountLockKey({
          workspaceId: deps.workspaceId,
          accountKey: acc.key,
        }),
        async () => {
          const refresh = await refreshLatestInsightsForManualImprovementPr({
            accountId: acc.id,
            accountKey: acc.key,
            timeZone: acc.timezoneName ?? deps.userTimeZone ?? "UTC",
            insightsProvider: deps.dailyReportInsights,
            store: deps.dailyReportStore,
          });
          if (refresh.status === "failed") {
            await deps.improvementPrAudit.recordImprovementPrAudit({
              workspaceId: deps.workspaceId,
              accountKey: acc.key,
              accountId: acc.id,
              cronRunId: null,
              action: "improvement_pr.failed",
              pullRequest: null,
              aiRunIds: [],
              auditDecision: null,
              classification: null,
              dangerousCategories: [],
              metadata: {
                failedAt: "refresh_insights",
                refresh,
                requestedBy: "slack",
              },
              summary: "improvement_pr refresh_insights failed; PR not opened",
            });
            return buildImprovementRefreshFailedSummary({
              workspaceId: deps.workspaceId,
              accountId: acc.id,
              accountKey: acc.key,
              currency: acc.currency ?? "JPY",
              mode: effectiveMode,
              refresh,
            });
          }
          const performanceContext = await loadRecentPerformanceSnapshotContext(
            deps.prisma,
            {
              accountId: acc.id,
              timeZone: acc.timezoneName ?? deps.userTimeZone ?? "UTC",
              includeToday: true,
            }
          );
          const enrichedContext = await enrichCreativeGenerationContext({
            provider: deps.improvementPrLlmProvider ?? null,
            storage: isReadableCreativeStorage(deps.improvementPrCreativeStorage)
              ? deps.improvementPrCreativeStorage
              : null,
            creativeContext: performanceContext.creativeContext,
          });
          return runImprovementPrOnce({
            workspaceId: deps.workspaceId,
            mode: effectiveMode,
            accountKey: acc.key,
            repo: repo.repoSpec,
            baseRef: repo.baseRef,
            snapshotIds: performanceContext.snapshotIds,
            analysisWindow: performanceContext.analysisWindow,
            creativeContext: enrichedContext.creativeContext,
            referenceImages: enrichedContext.referenceImages,
            store: deps.improvementPrStore,
            pipeline: deps.improvementPrPipeline,
            publisher: deps.improvementPrPublisher,
            planValidator: deps.improvementPrPlanValidator,
            audit: deps.improvementPrAudit,
            imageProvider: deps.improvementPrImageProvider ?? null,
            creativeStorage: deps.improvementPrCreativeStorage ?? null,
            // regression fix: cron 経路と同じ非空の Creative QA policy を
            // `/adops improve` でも明示的に渡す。未指定なら queue 側の
            // `DEFAULT_CREATIVE_QA_POLICY` がフォールバックとして効く。
            ...(deps.improvementPrCreativeQaPolicy
              ? { creativeQaPolicy: deps.improvementPrCreativeQaPolicy }
              : {}),
          });
        }
      );
      summaries.push(summary);
    }
    const succeeded = summaries.filter((s) => s.status === "succeeded").length;
    const skipped = summaries.filter(
      (s) => s.status === "skipped_no_proposal"
    ).length;
    const autoBlocked = summaries.filter(
      (s) => s.status === "auto_blocked"
    ).length;
    const aiFailed = summaries.filter((s) => s.status === "ai_failed").length;
    const prFailed = summaries.filter((s) => s.status === "pr_failed").length;
    const failedTotal = aiFailed + prFailed;
    const state: SlashHandlerOutcome["state"] =
      failedTotal > 0 ? "failed" : "succeeded";
    const url = deepLink(deps, "/improvements");
    const text = formatImprovementReportForUser(
      {
        state,
        startedAt: new Date(),
        durationMs: null,
        errorMessage: null,
        output: {
          accountsProcessed: summaries.length,
          succeeded,
          skipped_no_proposal: skipped,
          auto_blocked: autoBlocked,
          ai_failed: aiFailed,
          pr_failed: prFailed,
        },
      },
      summaries.map((s) => ({
        level: s.status.endsWith("_failed") ? "error" : "info",
        message: `improvement_pr account ${s.accountKey}`,
        payload: {
          accountKey: s.accountKey,
          status: s.status,
          decision: s.decision,
          proposalCount: s.proposalCount,
          errorMessage: s.errorMessage,
        },
      })),
      summaries.map((s) => ({
        action: s.pullRequest
          ? "improvement_pr.opened"
          : s.status.endsWith("_failed")
            ? "improvement_pr.failed"
            : "improvement_pr.skipped",
        ref: s.pullRequest?.htmlUrl ?? null,
        metadata: {
          accountKey: s.accountKey,
          summary: s.errorMessage ?? null,
          classification: s.classification,
          auditDecision: s.auditDecision,
          prNumber: s.pullRequest?.prNumber ?? null,
          htmlUrl: s.pullRequest?.htmlUrl ?? null,
          proposals: [],
        },
      })),
      deepLink(deps, "") ?? deps.webBaseUrl ?? ""
    );
    const out: SlashHandlerOutcome = {
      state,
      text: sanitizeText(text).slice(0, 3000),
      metadata: {
        accountsProcessed: summaries.length,
        succeeded,
        skipped_no_proposal: skipped,
        auto_blocked: autoBlocked,
        ai_failed: aiFailed,
        pr_failed: prFailed,
      },
    };
    if (url) out.detailUrl = url;
    if (state === "failed") {
      out.errorCode = aiFailed > 0 ? "ai_failed" : "pr_failed";
    }
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "failed",
      text: summarizeMessage(`improvement_pr の実行に失敗しました: ${message}`),
      errorCode: "improvement_pr_failed",
    };
  }
}

// ---------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------

async function handleActivate(
  deps: SlackCommandHandlersDeps,
  input: SlashHandlerInput
): Promise<SlashHandlerOutcome> {
  const { payload } = input;
  const target = (payload.target ?? "").trim();
  if (!target) {
    return {
      state: "failed",
      text: "/adops activate <ads_hierarchy_id> の形式で対象を指定してください。",
      errorCode: "missing_target",
    };
  }
  try {
    const hierarchyId = await resolveActivateTarget(
      deps.prisma,
      deps.workspaceId,
      target
    );
    if (!hierarchyId) {
      return {
        state: "failed",
        text: summarizeMessage(
          `対象が見つかりません: ${target}。/campaigns で hierarchy id を確認してください。`
        ),
        errorCode: "node_not_found",
      };
    }
    const channel = deps.commandSource ?? "slack";
    const userId = (payload.slackUserId ?? "").trim();
    const userName = (payload.slackUserName ?? "").trim();
    const actor = `${channel}:${userId.length > 0 ? userId : "_"}`;
    const note = userName
      ? `${channel} /adops activate by ${userName} (${userId})`
      : `${channel} /adops activate by ${userId || "unknown"}`;
    const { summary } = await executeActivate({
      prisma: deps.prisma,
      metaAdapter: deps.metaAdapter,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      lockProvider: deps.adAccountLockProvider,
      request: {
        hierarchyId,
        actor,
        source: channel,
        note,
      },
    });
    const url = deepLink(deps, "/campaigns");
    const succeeded =
      summary.status === "activated" || summary.status === "already_active";
    if (succeeded) {
      const out: SlashHandlerOutcome = {
        state: "succeeded",
        text: summarizeMessage(
          `${summary.status}: ${summary.message} (attempts=${summary.attempts})`
        ),
        metadata: {
          status: summary.status,
          hierarchyId: summary.hierarchyId,
          externalId: summary.externalId,
          attempts: summary.attempts,
        },
      };
      if (url) out.detailUrl = url;
      return out;
    }
    return {
      state: "failed",
      text: summarizeMessage(
        `${summary.status}: ${summary.message} (attempts=${summary.attempts})`
      ),
      errorCode: summary.status,
      metadata: {
        status: summary.status,
        hierarchyId: summary.hierarchyId,
        externalId: summary.externalId,
        attempts: summary.attempts,
      },
      ...(url ? { detailUrl: url } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "failed",
      text: summarizeMessage(`activate の実行に失敗しました: ${message}`),
      errorCode: "activate_failed",
    };
  }
}

/**
 * `/adops activate <target>` の target を `ads_hierarchy.id` に解決する。
 *
 * 1. UUID 形式かつ workspace 配下に存在する → そのまま使う。
 * 2. それ以外 (Meta external_id / nodeKey) → workspace 配下の `external_id`
 *    完全一致で検索 → 見つかればその id を返す。
 * 3. 最後に `nodeKey` の完全一致 (campaign/adset/ad の YAML キー) を試す。
 *
 * 該当なしのときは `null` を返し、handler 側が `node_not_found` で抜ける。
 */
async function resolveActivateTarget(
  prisma: PrismaClient,
  workspaceId: string,
  target: string
): Promise<string | null> {
  // 1) ads_hierarchy.id 完全一致 (workspace 配下)。
  const byId = await prisma.adsHierarchyNode.findFirst({
    where: { id: target, account: { workspaceId } },
    select: { id: true },
  });
  if (byId) return byId.id;
  // 2) Meta external_id 完全一致 (workspace 配下)。
  const byExternal = await prisma.adsHierarchyNode.findFirst({
    where: { externalId: target, account: { workspaceId } },
    select: { id: true },
  });
  if (byExternal) return byExternal.id;
  // 3) nodeKey 完全一致 (workspace 配下)。
  const byNodeKey = await prisma.adsHierarchyNode.findFirst({
    where: { nodeKey: target, account: { workspaceId } },
    select: { id: true },
  });
  if (byNodeKey) return byNodeKey.id;
  return null;
}
