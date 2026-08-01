// AdDroid OSS — pg-boss worker runtime.
//
// 起動シーケンスを `startWorker()` 関数として切り出し、`addroid up` の既定モード
// (web + worker を 1 プロセスで併走) からも、`apps/worker` 単独実行 (= `--separate-worker`
// or デバッグ用) からも同じロジックを共有できるようにしている。

import {
  APPLY_JOB_NAME,
  AUTOMATION_RULE_JOB_NAME,
  CRON_PRESETS,
  SCHEDULED_TASK_JOB_NAME,
  SLACK_AGENT_JOB_NAME,
  SLACK_COMMAND_JOB_NAME,
  bootPgBoss,
  buildAdAccountLockKey,
  failCronRun,
  finishCronRun,
  mirrorPresetsToCronSchedules,
  registerCronPresets,
  resolveCronScheduleTimeZone,
  runDailyReportOnce,
  runBudgetGuardOnce,
  runBudgetRebalanceOnce,
  runExecuteApply,
  runExperimentEvaluateOnce,
  runGithubPollOnce,
  runImprovementPrOnce,
  runPerformanceSnapshotRetentionOnce,
  scheduleCron,
  runSlackCommandJob,
  startCronRun,
  type DailyReportSummary,
  type DailyReportInsightsProvider,
  type DailyReportSnapshotStore,
  type BudgetGuardSummary,
  type BudgetRebalanceSummary,
  type ExperimentEvaluateSummary,
  type ImprovementPrAuditWriter,
  type ImprovementPrExecutionMode,
  type ImprovementPrSummary,
  type AdsLoader,
  type JsonValue,
  type RetentionSweepSummary,
  type SlackCommandJobPayload,
  type SlackAgentJobPayload,
} from "@addroid/queue";
import type PgBoss from "pg-boss";
import { prisma, type PrismaClient } from "@addroid/db";
import {
  LocalDiskStorage,
  defaultAddroidConfig,
  ensureAddroidPaths,
  readAddroidConfig,
} from "@addroid/config";
import {
  DEFAULT_CREATIVE_QA_POLICY,
} from "@addroid/llm-provider";
import { getGithubAdapter, injectGithubAdapter } from "@addroid/github-adapter";
import {
  createApplyJobStore,
  createCronOpsStore,
  createGithubPollStore,
  createNotificationAuditStore,
  createSlackCommandAuditStore,
  ensureWorkspace,
} from "./lib/prisma-stores.js";
import { createSlackCommandHandlers } from "./lib/slack-command-runtime.js";
import {
  createWorkerSlackNotifier,
  type WorkerSlackNotifier,
} from "./lib/slack-notifier-runtime.js";
import type { SlackNotificationPayload } from "@addroid/config";
import { resolveGithubAdapter } from "./lib/github-adapter-wiring.js";
import { resolveExecutionMode } from "./lib/execution-mode-resolution.js";
import { createLocalDirAdsLoaderFromEnv } from "./lib/apply-source.js";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "./lib/ops-repo-local.js";
import { resolveApplyExecutor } from "./lib/apply-meta-executor.js";
import { runMetaMirrorSync } from "./lib/meta-mirror-runtime.js";
import { resolveAutomationMutationExecutor } from "./lib/automation-action-executor.js";
import {
  buildPrismaMetaAdapterSelection,
  createPrismaMetaTokenRefResolver,
} from "./lib/meta-runtime.js";
import { createPostgresAdAccountLockProvider } from "./lib/account-lock.js";
import {
  MockDailyReportInsightsProvider,
  createAnalystRunner,
  createPrismaDailyReportSnapshotStore,
} from "./lib/daily-report-runtime.js";
import { resolveMetaCliInsightsProvider } from "./lib/meta-cli-insights-runtime.js";
import {
  buildBudgetGuardSpendContext,
  createBudgetGuardAuditRunner,
  createPrismaBudgetGuardStore,
  loadBudgetGuardPolicyForRoot,
  resolveBudgetGuardPolicyForAccount,
} from "./lib/budget-guard-runtime.js";
import {
  createBudgetRebalanceAuditWriter,
  createBudgetRebalanceGithubPublisher,
  createPrismaBudgetRebalanceStore,
  loadBudgetRebalancePolicyForRoot,
} from "./lib/budget-rebalance-runtime.js";
import {
  createExperimentGithubPublisher,
  createPrismaExperimentEvaluateStore,
} from "./lib/experiments-runtime.js";
import {
  createImprovementPrAuditWriter,
  createImprovementPrGithubPublisher,
  createImprovementPrPipelineRunner,
  createImprovementPrPlanValidator,
  createPrismaImprovementPrStore,
} from "./lib/improvement-pr-runtime.js";
import { loadRecentPerformanceSnapshotContext } from "./lib/improvement-pr-performance-context.js";
import { enrichCreativeGenerationContext } from "./lib/creative-generation-context.js";
import { refreshLatestInsightsForManualImprovementPr } from "./lib/improvement-pr-insights-refresh.js";
import { createPrismaPerformanceSnapshotRetentionStore } from "./lib/retention-runtime.js";
import { selectLLMProviderForWorker } from "./lib/llm-runtime.js";
import { selectImageProviderForWorker } from "./lib/image-runtime.js";
import {
  loadSlackInstallation,
  startSlackSocketRuntime,
} from "./lib/slack-socket-runtime.js";
import { runSlackAgentJob } from "./lib/slack-agent-runtime.js";
import type { SlackSocketReceiverHandle } from "@addroid/queue";
import {
  rescheduleEnabledAgentTasks,
  runScheduledAgentTaskJob,
  type ScheduledAgentTaskPayload,
} from "./lib/agent-task-runtime.js";
import {
  runScheduledAutomationRuleJob,
  syncAndScheduleAutomationRules,
  type ScheduledAutomationRulePayload,
} from "./lib/automation-rules-runtime.js";

export interface StartWorkerOptions {
  /**
   * Override the DATABASE_URL precheck. Default: read `process.env.DATABASE_URL`.
   * 共有プロセスモードでは CLI 側が事前検査済みのため、明示注入も可能。
   */
  databaseUrl?: string;
  /**
   * Logger. 共有モードでは CLI 側で `[worker]` プレフィックス付きの logger を渡す想定。
   */
  logger?: WorkerLogger;
  /**
   * `true` のとき、startWorker 自身が SIGINT/SIGTERM を購読して shutdown する。
   * 共有モードでは CLI 側がシグナルを管理するので `false`。
   */
  installSignalHandlers?: boolean;
}

export interface WorkerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface WorkerHandle {
  /**
   * pg-boss の graceful stop + Prisma disconnect を行う。
   * `installSignalHandlers: true` の場合はシグナル経由で内部的に呼ばれる。
   */
  stop: () => Promise<void>;
}

const defaultLogger: WorkerLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const log = opts.logger ?? defaultLogger;
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("[worker] DATABASE_URL is not set. See .env.example.");
  }

  log.info("[worker] starting pg-boss…");
  const boss = await bootPgBoss({ databaseUrl });

  const paths = await ensureAddroidPaths();
  const config = (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  const workspace = await ensureWorkspace(prisma, {
    slug: config.workspace.slug,
    displayName: config.workspace.displayName,
    configPath: paths.configFile,
    storageDir: paths.storageDir,
    databaseUrlRef: config.database.urlRef,
    // regression fix: 初回 create 時のシード値。既存行は worker 再起動で
    // 触らない (UI/CLI からの mode 変更を保持する)。
    executionMode: config.workspace.executionMode,
  });
  log.info(
    `[worker] workspace ready: ${workspace.slug} (${workspace.id}) mode=${workspace.executionMode}`
  );
  const opsRepoCheckout = await ensureOpsRepoLocalCheckout({
    prisma: prisma as never,
    workspaceId: workspace.id,
  }).catch((err) => {
    log.warn(`[worker] ops repo local checkout not ready: ${(err as Error).message}`);
    return null;
  });
  const opsRepoRootDir =
    opsRepoCheckout?.rootDir ??
    (await resolveOpsRepoLocalDirForWorkspace({
      prisma: prisma as never,
      workspaceId: workspace.id,
    })).rootDir ??
    null;

  const cronStore = createCronOpsStore(prisma, workspace.id);
  const githubStore = createGithubPollStore(prisma);

  const adapterSelection = await resolveGithubAdapter({ prisma });
  injectGithubAdapter(adapterSelection.adapter);
  log.info(
    `[worker] github adapter: ${adapterSelection.choice} (${adapterSelection.reason})`
  );

  const cronScheduleTimeZone = resolveCronScheduleTimeZone(process.env);
  log.info(`[worker] cron schedule timezone: ${cronScheduleTimeZone}`);
  await registerCronPresets(boss, { timeZone: cronScheduleTimeZone });
  const mirror = await mirrorPresetsToCronSchedules({
    store: cronStore,
    workspaceId: workspace.id,
  });
  await syncEnabledCronSchedules({
    prisma,
    boss,
    workspaceId: workspace.id,
    timeZone: cronScheduleTimeZone,
    log,
  });
  const agentTaskSchedule = await rescheduleEnabledAgentTasks({
    prisma,
    boss,
    workspaceId: workspace.id,
  }).catch((err) => {
    log.warn(`[worker] failed to schedule agent tasks: ${(err as Error).message}`);
    return { scheduled: 0 };
  });
  log.info(`[worker] scheduled ${agentTaskSchedule.scheduled} agent task(s)`);

  // Regression fix: Slack 通知ディスパッチャを worker 起動時に
  // 1 度だけ構築する。本 notifier は producer (daily_report /
  // improvement_pr / execute_apply / Slack budget command) の終端で `dispatch(payload)` を呼び、
  // Slack 連携が未設定なら `skipped_no_slack`、設定済みなら Slack Web API へ
  // chat.postMessage を投げる。`createNotificationAuditStore` を audit writer
  // として注入することで、各 dispatch が `audit_logs` に
  // notification.sent | notification.failed | notification.skipped_no_slack
  // を 1 行残す (UI design plan §4.2 NotificationDispatchRow)。
  // 重要: producer は dispatch の戻り値を握りつぶしてよい — Slack 失敗を
  // GitOps polling / Apply / Cron に伝播させないため (acceptance: "Slack
  // and Web UI failures do not block core GitOps polling, Apply, or Cron
  // execution.")。
  const notificationAudit = createNotificationAuditStore(prisma, workspace.id);
  const slackNotifier = createWorkerSlackNotifier({
    prisma,
    audit: notificationAudit,
    logger: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
    },
  });
  const sendSlackNotification = makeSafeNotificationSender(slackNotifier, log);
  const webBaseUrl = process.env.ADDROID_WEB_BASE_URL?.trim() || null;

  // this implementation: daily_report cron は LLM Provider と insights provider
  //   を共有する。ADDROID_LLM_MOCK=1 のときは Mock provider が事前接続され、
  //   完全パイプラインを試せる。それ以外は Stub に倒れ、analyst 段階で
  //   `LLMProviderNotConfiguredError` を吸収して `status="ai_failed"` に倒す
  //   (snapshot は保存される — GitOps state は腐らない)。
  // Codex / OpenAI / Anthropic の OAuth は web 側のコールバックで `oauth_tokens`
  // テーブルに ciphertext + metadata (defaultModel 等) を保存する。worker は
  // prisma 経由で同じ encrypted boundary から token を読み出すため、prisma 注入は必須。
  const llmSelection = await selectLLMProviderForWorker(process.env, { prisma });
  log.info(
    `[worker] llm provider: ${llmSelection.choice} (${llmSelection.reason})`
  );

  // regression fix: improvement_pr cron が image_prompt variants を実画像生成
  // hop に流せるよう、image-Provider と LocalDisk Storage Adapter を 1 度だけ
  // 構築して runImprovementPrOnce に注入する。Provider 未設定 / 失敗時は
  // generateAndQaCreative が prompt-only fallback を返し、orchestrator が
  // creatives 行を storage 列 null で書き続ける (UI design plan principle 21/27)。
  const imageProviderSelection = await selectImageProviderForWorker(process.env, {
    prisma,
    preferCodex: llmSelection.choice === "codex",
  });
  log.info(
    `[worker] image provider: ${imageProviderSelection.choice} (${imageProviderSelection.reason})`
  );
  const creativeStorage = new LocalDiskStorage({ env: process.env });

  const metaAdapterSelection = await buildPrismaMetaAdapterSelection({
    prisma,
    env: process.env,
    // ビジネスポートフォリオごとにトークンが分かれるため、accountKey を渡した
    // 呼び出しではそのアカウント用のトークンを使う (未設定なら既定トークン)。
    resolveTokenRef: createPrismaMetaTokenRefResolver(prisma, workspace.id),
  });
  log.info(
    `[worker] meta adapter: ${metaAdapterSelection.choice} (${metaAdapterSelection.reason})`
  );

  const dailyReportStore = createPrismaDailyReportSnapshotStore(prisma);
  const metaCliInsightsSelection = await resolveMetaCliInsightsProvider({
    env: process.env,
    metaAdapter: metaAdapterSelection.adapter,
    resolveAdAccountId: async (accountKey) => {
      const row = await prisma.adAccount.findUnique({
        where: { workspaceId_key: { workspaceId: workspace.id, key: accountKey } },
        select: { metaAccountId: true },
      });
      return row?.metaAccountId ?? (accountKey.startsWith("act_") ? accountKey : null);
    },
    // CV として数える action_type はアカウントごとに違う (購入 / LINE 友だち追加 /
    // カスタム CV ...)。未設定なら resolveConversionCount 側の既定にフォールバックする。
    resolveConversionEvent: async (accountKey) => {
      const row = await prisma.adAccount.findUnique({
        where: { workspaceId_key: { workspaceId: workspace.id, key: accountKey } },
        select: { cvEvent: true },
      });
      return row?.cvEvent ?? null;
    },
  });
  log.info(
    `[worker] daily_report insights provider: ${metaCliInsightsSelection.mode} (${metaCliInsightsSelection.reason})`
  );
  const dailyReportInsights =
    metaCliInsightsSelection.provider ?? new MockDailyReportInsightsProvider();
  const automationMutationSelection = await resolveAutomationMutationExecutor({
    env: process.env,
    metaAdapter: metaAdapterSelection.adapter,
    resolver: {
      async resolveExternalId(input) {
        if (input.hierarchyId) {
          const node = await prisma.adsHierarchyNode.findFirst({
            where: { accountId: input.accountId, id: input.hierarchyId },
            select: { externalId: true, nodeKey: true },
          });
          return node?.externalId ?? node?.nodeKey ?? null;
        }
        const node = await prisma.adsHierarchyNode.findFirst({
          where: {
            accountId: input.accountId,
            nodeType: input.level,
            nodeKey: input.targetKey,
          },
          select: { externalId: true, nodeKey: true },
        });
        return node?.externalId ?? node?.nodeKey ?? input.targetKey ?? null;
      },
    },
  });
  log.info(
    `[worker] automation mutation executor: ${automationMutationSelection.mode} (${automationMutationSelection.reason})`
  );
  const dailyReportAnalyst = createAnalystRunner({
    provider: llmSelection.provider,
    workspaceId: workspace.id,
  });
  const userTimeZone = resolveRuntimeUserTimeZone(process.env);

  // Regression fix: manual budget checks / improvement_pr cron も同じ
  // LLM Provider 経由で AI を呼び出す。runtime 側は store + agent runner を
  // factor out して、Slack command と各 cron handler から共有する。
  const budgetGuardStore = createPrismaBudgetGuardStore(prisma);
  const budgetRebalanceStore = createPrismaBudgetRebalanceStore(prisma);
  const experimentEvaluateStore = createPrismaExperimentEvaluateStore(prisma);
  const improvementPrStore = createPrismaImprovementPrStore(prisma);

  // Regression fix: 契約上の retention 要件
  //   - "Raw performance data retention is 90 days"
  //   - "aggregated campaign-or-higher retention is 1 year"
  // を強制するため、daily housekeeping preset retention_sweep に同じ store を渡す。
  const retentionStore = createPrismaPerformanceSnapshotRetentionStore(prisma);

  // Regression fix: ad_account 単位の cross-process 直列化境界。
  // Apply/Activate (Regression fix) と同じ Postgres advisory lock
  // を背に持つ provider を共有することで、daily_report / improvement_pr /
  // manual budget checks の per-account inner block も Apply/Activate と同じ canonical
  // 識別子 (`buildAdAccountLockKey`) で 1 並行に直列化される。
  // 受入要件 "Cron workflows must use pg-boss and respect ad_account-level
  // execution limits" を満たす。
  const adAccountLockProvider = createPostgresAdAccountLockProvider({
    prisma,
    onReleaseError: (lockKey, error) => {
      log.warn(
        `[worker] ad_account lock release failed for ${lockKey}: ${(error as Error).message}`
      );
    },
    onAcquireError: (lockKey, error) => {
      log.warn(
        `[worker] ad_account lock acquire failed for ${lockKey}: ${(error as Error).message}`
      );
    },
  });

  const automationRuleSchedule = await syncAndScheduleAutomationRules({
    prisma,
    boss,
    workspaceId: workspace.id,
    env: process.env,
  }).catch((err) => {
    log.warn(`[worker] failed to schedule automation rules: ${(err as Error).message}`);
    return { loaded: 0, scheduled: 0 };
  });
  log.info(
    `[worker] automation rules loaded=${automationRuleSchedule.loaded} scheduled=${automationRuleSchedule.scheduled}`
  );

  for (const preset of CRON_PRESETS) {
    await boss.work(preset.name, async (jobs) => {
      for (const job of jobs) {
        const handle = await startCronRun(cronStore, {
          scheduleId: mirror.scheduleIdByName[preset.name] ?? null,
          name: preset.name,
          jobId: job.id,
        });
        try {
          const presetName = preset.name as string;
          if (presetName === "github_poll") {
            const summary = await runGithubPollOnce({
              boss,
              store: githubStore,
              adapter: getGithubAdapter(),
              workspaceId: workspace.id,
            });
            await cronStore.recordExecutionLog({
              cronRunId: handle.cronRunId,
              workspaceId: workspace.id,
              kind: "github_poll",
              level:
                summary.status === "polled" || summary.status === "not_modified"
                  ? "info"
                  : "warn",
              message: `github_poll: ${summary.status}${summary.detail ? ` — ${summary.detail}` : ""}`,
              payload: {
                status: summary.status,
                prCount: summary.prCount ?? null,
                newlyMerged: summary.newlyMerged ?? null,
                enqueuedJobIds: summary.enqueuedJobIds ?? [],
              },
            });
            await finishCronRun(cronStore, handle, {
              status: summary.status,
              prCount: summary.prCount ?? null,
              newlyMerged: summary.newlyMerged ?? null,
              detail: summary.detail ?? null,
            });
            await syncAndScheduleAutomationRules({
              prisma,
              boss,
              workspaceId: workspace.id,
              env: process.env,
            }).catch((err) => {
              log.warn(`[worker] failed to refresh automation rule schedules after github_poll: ${(err as Error).message}`);
            });
          } else if (presetName === "daily_report" || presetName === "today_report") {
            const requestedMetricDate = readMetricDateFromCronJobData(job.data);
            const metricDateOffsetDays =
              presetName === "daily_report" ? -1 : 0;
            // Workspace 配下の active な ad_account 全件に対して順次実行する。
            // regression fix: 各 account の inner block は Apply/Activate と
            // 共通の `buildAdAccountLockKey` を経由して `withLock` で直列化する。
            // これにより同一 (workspaceId, accountKey) に対する Apply / Activate /
            // 他 cron workflow が cross-process で 1 並行に揃う。
            // regression fix: 同時に modeOverride を取得し、workspace mode との
            // 優先解決で実効 mode を決定する。
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: { key: true, displayName: true, modeOverride: true },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const summaries: DailyReportSummary[] = [];
            const errors: string[] = [];
            for (const acc of accounts) {
              const lease = await metaAdapterSelection.adapter
                .loadAccessTokenPlaintext(acc.key)
                .catch(() => null);
              if (lease?.accessToken) {
                await runMetaMirrorSync({
                  prisma,
                  workspaceId: workspace.id,
                  accessToken: lease.accessToken,
                  accountKey: acc.key,
                  actor: "agent:daily-report",
                  source: presetName,
                }).catch((err) => {
                  log.warn(
                    `[worker] ${presetName}: mirror sync failed for ${acc.key}: ${(err as Error).message}`
                  );
                });
              }
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                () =>
                  runDailyReportOnce({
                    workspaceId: workspace.id,
                    // regression fix: workspace.executionMode と
                    // ad_account.modeOverride を解決した実効 mode。daily_report
                    // 自体は Meta を変更しないが、AI runs / cron output に記録
                    // される `mode` が正しい運用値を反映する必要がある。
                    mode: effectiveMode,
                    accountKey: acc.key,
                    ...(requestedMetricDate
                      ? { metricDate: requestedMetricDate }
                      : { metricDateOffsetDays }),
                    fallbackTimeZone: userTimeZone,
                    insightsProvider: dailyReportInsights,
                    store: dailyReportStore,
                    analyst: dailyReportAnalyst,
                  })
              );
              summaries.push(summary);
              const ok =
                summary.status === "succeeded" ||
                summary.status === "no_account";
              const level: "info" | "warn" | "error" = ok
                ? summary.anomalyDetectionError
                  ? "warn"
                  : "info"
                : summary.status === "no_insights"
                  ? "warn"
                  : "error";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `${preset.name} ${acc.key}: ${summary.status}` +
                  (summary.aiCommentary
                    ? ` — ${summary.aiCommentary.slice(0, 120)}`
                    : summary.errorMessage
                      ? ` — ${summary.errorMessage}`
                      : "") +
                  (summary.anomalyDetectionError
                    ? ` — anomaly detection fallback: ${summary.anomalyDetectionError.slice(0, 120)}`
                    : ""),
                payload: dailyReportSummaryToPayload(summary),
              });
              if (summary.status === "ai_failed") {
                errors.push(`${acc.key}: ${summary.errorMessage ?? "ai failed"}`);
                // regression fix: AI 失敗を Slack に通知する。failCronRun は
                // この per-account ループ終了後に走るため、失敗の発生個所を
                // 通知側でも明示する (acceptance: "Slack notifications are
                // sent for ..., and failures.")。dispatch 失敗は
                // sendSlackNotification 内で握り潰されるので cron 進行を
                // ブロックしない。
                const reportRunsUrl = buildWebUrl(webBaseUrl, "/cron/runs");
                await sendSlackNotification({
                  kind: "daily_report.failed",
                  data: {
                    adAccountKey: acc.key,
                    metricDate: summary.metricDate,
                    errorMessage: summary.errorMessage ?? "ai failed",
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(reportRunsUrl ? { runsUrl: reportRunsUrl } : {}),
                  },
                });
              }
              // regression fix: daily_report が succeeded を返した時のみ
              // `daily_report.completed` 通知を送る。AI 失敗 / no_insights /
              // no_account は通知価値が低く、Slack ノイズを増やすため送らない
              // (= 必要なら /reports や /cron/runs から確認できる)。
              if (summary.status === "succeeded") {
                const reportUrl = summary.aiRunId
                  ? buildWebUrl(webBaseUrl, `/reports/${summary.aiRunId}`)
                  : undefined;
                const topImprovements = summary.topImprovements
                  .slice(0, 3)
                  .map((c) =>
                    [c.target, c.rationale].filter((s) => !!s).join(" — ")
                  )
                  .filter((s) => s.length > 0);
                await sendSlackNotification({
                  kind: "daily_report.completed",
                  data: {
                    reportId: summary.aiRunId ?? `daily_report:${acc.key}`,
                    adAccountKey: acc.key,
                    metricDate: summary.metricDate,
                    spend: summary.current.spend,
                    currency: summary.currency,
                    impressions: summary.current.impressions,
                    clicks: summary.current.clicks,
                    conversions: summary.current.conversions,
                    topImprovements,
                    mode: summary.mode,
                    ...(reportUrl ? { reportUrl } : {}),
                  },
                });
              }
            }
            const aggregate = {
              kind: "daily_report",
              preset: preset.name,
              status: errors.length > 0 ? "failed" : "succeeded",
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              ai_failed: summaries.filter((s) => s.status === "ai_failed").length,
              no_insights: summaries.filter((s) => s.status === "no_insights").length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              llmProvider: llmSelection.choice,
              insightsSource: summaries[0]?.insightsSource ?? "unavailable",
              accounts: summaries.map((s) => dailyReportSummaryToPayload(s)),
            };
            if (errors.length > 0) {
              const message =
                summaries.length === 0
                  ? "daily_report skipped: no active ad_accounts"
                  : `${preset.name} had AI failures: ${errors.join("; ")}`;
              if (summaries.length === 0) {
                // 何もしなかった場合は finish (ok) — ユーザに「未設定」を伝える
                // ためには /accounts の空状態 UI で十分。
                await finishCronRun(cronStore, handle, {
                  ...aggregate,
                  note: "no active ad_accounts in workspace",
                });
              } else {
                await failCronRun(cronStore, handle, message);
              }
            } else {
              await finishCronRun(cronStore, handle, aggregate);
            }
          } else if (presetName === "budget_guard") {
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: {
                id: true,
                key: true,
                displayName: true,
                currency: true,
                modeOverride: true,
              },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const loadedPolicy = loadBudgetGuardPolicyForRoot(opsRepoRootDir);
            const summaries: BudgetGuardSummary[] = [];
            const errors: string[] = [];
            const auditRunner = createBudgetGuardAuditRunner({
              provider: llmSelection.provider,
              workspaceId: workspace.id,
              cronRunId: handle.cronRunId,
            });
            for (const acc of accounts) {
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const accountBudget = loadedPolicy?.accountBudgets[acc.key];
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                async () => {
                  if (!loadedPolicy) {
                    return runBudgetGuardOnce({
                      workspaceId: workspace.id,
                      mode: effectiveMode,
                      accountKey: acc.key,
                      policy: null,
                      store: budgetGuardStore,
                      runner: auditRunner,
                    });
                  }
                  return runBudgetGuardOnce({
                    workspaceId: workspace.id,
                    mode: effectiveMode,
                    accountKey: acc.key,
                    // 共通 alerts に account 単位の上書きを重ねてから評価する。
                    policy: resolveBudgetGuardPolicyForAccount(
                      loadedPolicy.policy,
                      accountBudget
                    ),
                    spendContext: await buildBudgetGuardSpendContext({
                      prisma,
                      accountId: acc.id,
                      dailyBudget: accountBudget?.dailyBudget ?? 0,
                      monthlyBudget: accountBudget?.monthlyBudget ?? 0,
                      currency: accountBudget?.currency ?? acc.currency ?? "JPY",
                    }),
                    store: budgetGuardStore,
                    runner: auditRunner,
                  });
                }
              );
              summaries.push(summary);
              const level: "info" | "warn" | "error" =
                summary.status === "ai_failed"
                  ? "error"
                  : summary.status === "policy_missing" ||
                      summary.status === "no_account"
                    ? "warn"
                    : "info";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `budget_guard ${acc.key}: ${summary.status}` +
                  (summary.errorMessage ? ` — ${summary.errorMessage}` : ""),
                payload: budgetGuardSummaryToPayload(summary),
              });
              if (summary.status === "ai_failed") {
                errors.push(`${acc.key}: ${summary.errorMessage ?? "ai failed"}`);
                const budgetRunsUrl = buildWebUrl(webBaseUrl, "/cron/runs");
                await sendSlackNotification({
                  kind: "budget_guard.failed",
                  data: {
                    adAccountKey: acc.key,
                    errorMessage: summary.errorMessage ?? "ai failed",
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(budgetRunsUrl ? { runsUrl: budgetRunsUrl } : {}),
                  },
                });
              }
            }
            const aggregate = {
              kind: "budget_guard",
              status: errors.length > 0 ? "failed" : "succeeded",
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              policy_missing: summaries.filter((s) => s.status === "policy_missing").length,
              ai_failed: summaries.filter((s) => s.status === "ai_failed").length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              llmProvider: llmSelection.choice,
              policyPath: opsRepoRootDir
                ? "workflows/budget-guard.yaml"
                : null,
              accounts: summaries.map((s) => budgetGuardSummaryToPayload(s)),
            };
            if (errors.length > 0) {
              await failCronRun(
                cronStore,
                handle,
                `budget_guard had AI failures: ${errors.join("; ")}`
              );
            } else {
              await finishCronRun(cronStore, handle, {
                ...aggregate,
                ...(summaries.length === 0
                  ? { note: "no active ad_accounts in workspace" }
                  : {}),
              });
            }
          } else if (presetName === "budget_rebalance") {
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: {
                id: true,
                key: true,
                displayName: true,
                currency: true,
                modeOverride: true,
              },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const policy = loadBudgetRebalancePolicyForRoot(opsRepoRootDir);
            const publisher = createBudgetRebalanceGithubPublisher({
              prisma,
              adapter: getGithubAdapter(),
              workspaceId: workspace.id,
            });
            const audit = createBudgetRebalanceAuditWriter({ prisma });
            const wsForRepo = await prisma.workspace.findUnique({
              where: { id: workspace.id },
              select: { opsRepoId: true },
            });
            const repoRow = wsForRepo?.opsRepoId
              ? await prisma.githubRepo.findUnique({
                  where: { id: wsForRepo.opsRepoId },
                  select: { owner: true, name: true, defaultBranch: true },
                })
              : null;
            const repoSpec = repoRow ? `${repoRow.owner}/${repoRow.name}` : "";
            const baseRef = repoRow?.defaultBranch ?? "main";
            const summaries: BudgetRebalanceSummary[] = [];
            const errors: string[] = [];
            for (const acc of accounts) {
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                () =>
                  runBudgetRebalanceOnce({
                    workspaceId: workspace.id,
                    mode: effectiveMode,
                    accountKey: acc.key,
                    policy,
                    store: budgetRebalanceStore,
                    publisher,
                    audit,
                    repo: repoSpec,
                    baseRef,
                    cronRunId: handle.cronRunId,
                  })
              );
              summaries.push(summary);
              const level: "info" | "warn" | "error" =
                summary.status === "pr_failed"
                  ? "error"
                  : summary.status === "policy_missing" ||
                      summary.status === "no_account"
                    ? "warn"
                    : "info";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `budget_rebalance ${acc.key}: ${summary.status}` +
                  (summary.pullRequest
                    ? ` — PR #${summary.pullRequest.prNumber}`
                    : summary.errorMessage
                      ? ` — ${summary.errorMessage}`
                      : ""),
                payload: budgetRebalanceSummaryToPayload(summary),
              });
              if (summary.status === "pr_failed") {
                errors.push(`${acc.key}: ${summary.errorMessage ?? "pr failed"}`);
              }
              if (
                summary.status === "succeeded" &&
                summary.pullRequest &&
                repoRow
              ) {
                const webApprovalsUrl = buildWebUrl(
                  webBaseUrl,
                  `/approvals/${summary.pullRequest.prNumber}`
                );
                await sendSlackNotification({
                  kind: "pr.opened",
                  data: {
                    prNumber: summary.pullRequest.prNumber,
                    prTitle: `budget_rebalance (${acc.key})`,
                    prUrl: summary.pullRequest.htmlUrl,
                    repoFullName: repoSpec,
                    workflow: "budget_rebalance",
                    adAccountKey: acc.key,
                    riskLabel: summary.classification ?? "requires_approval",
                    ...(webApprovalsUrl ? { webApprovalsUrl } : {}),
                  },
                });
              }
            }
            const aggregate = {
              kind: "budget_rebalance",
              status: errors.length > 0 ? "failed" : "succeeded",
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              no_moves: summaries.filter((s) => s.status === "no_moves").length,
              disabled: summaries.filter((s) => s.status === "disabled").length,
              policy_missing: summaries.filter((s) => s.status === "policy_missing").length,
              pr_failed: summaries.filter((s) => s.status === "pr_failed").length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              policyPath: opsRepoRootDir
                ? "workflows/budget-rebalance.yaml"
                : null,
              accounts: summaries.map((s) => budgetRebalanceSummaryToPayload(s)),
            };
            if (errors.length > 0) {
              await failCronRun(
                cronStore,
                handle,
                `budget_rebalance had PR failures: ${errors.join("; ")}`
              );
            } else {
              await finishCronRun(cronStore, handle, {
                ...aggregate,
                ...(summaries.length === 0
                  ? { note: "no active ad_accounts in workspace" }
                  : {}),
              });
            }
          } else if (presetName === "experiment_evaluate") {
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const publisher = createExperimentGithubPublisher({
              prisma,
              adapter: getGithubAdapter(),
              workspaceId: workspace.id,
            });
            const wsForRepo = await prisma.workspace.findUnique({
              where: { id: workspace.id },
              select: { opsRepoId: true },
            });
            const repoRow = wsForRepo?.opsRepoId
              ? await prisma.githubRepo.findUnique({
                  where: { id: wsForRepo.opsRepoId },
                  select: { owner: true, name: true, defaultBranch: true },
                })
              : null;
            const summary = await runExperimentEvaluateOnce({
              mode: resolveExecutionMode(wsMode, null),
              store: experimentEvaluateStore,
              publisher,
              repo: repoRow ? `${repoRow.owner}/${repoRow.name}` : "",
              baseRef: repoRow?.defaultBranch ?? "main",
            });
            const level: "info" | "warn" | "error" =
              summary.status === "partial_failure" ? "error" : "info";
            await cronStore.recordExecutionLog({
              cronRunId: handle.cronRunId,
              workspaceId: workspace.id,
              kind: "cron",
              refType: "cron_run",
              refId: handle.cronRunId,
              level,
              message:
                `experiment_evaluate: ${summary.status} ` +
                `(evaluated=${summary.evaluated}, concluded=${summary.concluded}, ` +
                `continued=${summary.continued}, cancelled=${summary.cancelled})`,
              payload: experimentEvaluateSummaryToPayload(summary),
            });
            if (summary.status === "partial_failure") {
              await failCronRun(
                cronStore,
                handle,
                `experiment_evaluate had PR failures: ${summary.items
                  .filter((item) => item.status === "pr_failed")
                  .map((item) => `${item.name}: ${item.errorMessage ?? "pr failed"}`)
                  .join("; ")}`
              );
            } else {
              await finishCronRun(
                cronStore,
                handle,
                experimentEvaluateSummaryToPayload(summary)
              );
            }
          } else if (
            presetName === "improvement_pr" ||
            presetName === "auto_creative_generation"
          ) {
            const workflowRunName =
              presetName === "auto_creative_generation"
                ? "auto_creative_generation"
                : "improvement_pr";
            const manualRun = isManualCronJobData(job.data);
            const manualRefreshNow = new Date();
            // regression fix: workspace mode + per-account modeOverride を取得し、
            // 解決した実効 mode を ad_account ごとに改めて渡す。dangerous category
            // / safe-category の policy gate (execution-mode.ts) が mode に応じて
            // fail-closed する。
            const accounts = await prisma.adAccount.findMany({
              where: { workspaceId: workspace.id, active: true },
              select: {
                id: true,
                key: true,
                displayName: true,
                currency: true,
                timezoneName: true,
                modeOverride: true,
              },
              orderBy: { key: "asc" },
            });
            const wsMode = await loadWorkspaceMode(prisma, workspace.id);
            const summaries: ImprovementPrSummary[] = [];
            const errors: string[] = [];
            const pipelineRunner = createImprovementPrPipelineRunner({
              provider: llmSelection.provider,
              workspaceId: workspace.id,
              cronRunId: handle.cronRunId,
            });
            const publisher = createImprovementPrGithubPublisher({
              prisma,
              adapter: getGithubAdapter(),
              workspaceId: workspace.id,
            });
            // regression fix: 生成された YAML 変更を CLI / `/api/plan` と同じ
            // runPlanForRoot で検証し、PR body と audit metadata に実 plan 結果を残す。
            const planValidator = createImprovementPrPlanValidator({
              rootDir: opsRepoRootDir,
              baseDir: process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null,
            });
            const auditWriter = createImprovementPrAuditWriter({ prisma });
            // ops repo "owner/name" を gitops agent に渡すため事前ロード。
            const wsForRepo = await prisma.workspace.findUnique({
              where: { id: workspace.id },
              select: { opsRepoId: true },
            });
            const repoRow = wsForRepo?.opsRepoId
              ? await prisma.githubRepo.findUnique({
                  where: { id: wsForRepo.opsRepoId },
                  select: { owner: true, name: true, defaultBranch: true },
                })
              : null;
            const repoSpec = repoRow
              ? `${repoRow.owner}/${repoRow.name}`
              : "";
            const baseRef = repoRow?.defaultBranch ?? "main";
            for (const acc of accounts) {
              // regression fix: improvement_pr は最終的に GitHub PR を立てる
              // だけで Meta を直接変更しないが、performance_snapshots / ai_runs
              // を読みつつ analyst → media_buyer → gitops を順に走らせる per
              // -account パイプラインのため、Apply/Activate / 他 cron と同じ
              // canonical lock で直列化する (1 ad_account = 1 並行)。
              // 自動 cron では daily_report が残した前日までの直近 7 日を使う。
              // Web/CLI/Chat からの手動実行では、この場で最新 insights を取得し、
              // 今日を含む直近 7 日を analyst input + PR body へ流す。
              const effectiveMode = resolveExecutionMode(
                wsMode,
                acc.modeOverride
              );
              const summary = await adAccountLockProvider.withLock(
                buildAdAccountLockKey({
                  workspaceId: workspace.id,
                  accountKey: acc.key,
                }),
                async () => {
                  const performanceContext =
                    manualRun
                      ? await refreshInsightsAndLoadManualImprovementContext({
                          prisma,
                          cronStore,
                          cronRunId: handle.cronRunId,
                          workspaceId: workspace.id,
                          accountId: acc.id,
                          accountKey: acc.key,
                          accountCurrency: acc.currency ?? "JPY",
                          mode: effectiveMode,
                          timeZone: acc.timezoneName ?? userTimeZone,
                          insightsProvider: dailyReportInsights,
                          snapshotStore: dailyReportStore,
                          now: manualRefreshNow,
                          auditWriter,
                        })
                      : await loadRecentPerformanceSnapshotContext(prisma, {
                          accountId: acc.id,
                          timeZone: acc.timezoneName ?? userTimeZone,
                        });
                  if ("refreshFailedSummary" in performanceContext) {
                    return performanceContext.refreshFailedSummary;
                  }
                  const enrichedContext = await enrichCreativeGenerationContext({
                    provider: llmSelection.provider,
                    storage: creativeStorage,
                    creativeContext: performanceContext.creativeContext,
                  });
                  return runImprovementPrOnce({
                    workspaceId: workspace.id,
                    // regression fix: workspace + ad_account の解決済み mode。
                    // execution-mode.ts の policy gate がここに依存して
                    // report_only=auto_blocked / dangerous=approval_required
                    // を保証する。
                    mode: effectiveMode,
                    workflowIntent:
                      presetName === "auto_creative_generation"
                        ? "auto_creative_generation"
                        : "improvement_proposal",
                    accountKey: acc.key,
                    repo: repoSpec,
                    baseRef,
                    snapshotIds: performanceContext.snapshotIds,
                    analysisWindow: performanceContext.analysisWindow,
                    creativeContext: enrichedContext.creativeContext,
                    referenceImages: enrichedContext.referenceImages,
                    store: improvementPrStore,
                    pipeline: pipelineRunner,
                    publisher,
                    planValidator,
                    audit: auditWriter,
                    cronRunId: handle.cronRunId,
                    // regression fix: image-Provider hop。未設定でも fallback で
                    // 200 OK 返るため、注入条件は付けず常に渡す。
                    imageProvider: imageProviderSelection.provider,
                    creativeStorage,
                    // regression fix: 非空の Creative QA policy を明示的に
                    // 注入する。the current implementation acceptance "Creative QA checks
                    // dimensions, format, quality, forbidden expressions,
                    // and brand-tone constraints before PR attachment" は
                    // production runtime が空 policy で skip 経路に倒れる
                    // ことを許容しない。
                    creativeQaPolicy: DEFAULT_CREATIVE_QA_POLICY,
                  });
                }
              );
              summaries.push(summary);
              const level: "info" | "warn" | "error" =
                summary.status === "succeeded" ||
                summary.status === "skipped_no_proposal" ||
                summary.status === "auto_blocked" ||
                summary.status === "no_account"
                  ? summary.status === "no_account"
                    ? "warn"
                    : "info"
                  : "error";
              await cronStore.recordExecutionLog({
                cronRunId: handle.cronRunId,
                workspaceId: workspace.id,
                kind: "cron",
                refType: "cron_run",
                refId: handle.cronRunId,
                level,
                message:
                  `${workflowRunName} ${acc.key}: ${summary.status}` +
                  (summary.decision
                    ? ` — ${summary.decision} (${summary.proposalCount} proposals)`
                    : summary.errorMessage
                      ? ` — ${summary.errorMessage}`
                      : ""),
                payload: improvementPrSummaryToPayload(summary),
              });
              if (
                summary.status === "ai_failed" ||
                summary.status === "pr_failed"
              ) {
                errors.push(
                  `${acc.key}: ${summary.errorMessage ?? summary.status}`
                );
                // regression fix: AI / PR 作成失敗を Slack に通知する。
                // skipped_no_proposal / auto_blocked は失敗ではない (= AI が
                // 「改善案なし」と判断した正常経路) ので通知しない。
                // dispatch 失敗は sendSlackNotification 内で握り潰されるので
                // cron 進行をブロックしない。
                const improvementRunsUrl = buildWebUrl(
                  webBaseUrl,
                  "/cron/runs"
                );
                await sendSlackNotification({
                  kind: "improvement_pr.failed",
                  data: {
                    adAccountKey: acc.key,
                    failureStage:
                      summary.status === "pr_failed" ? "pr" : "ai",
                    errorMessage: summary.errorMessage ?? summary.status,
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(improvementRunsUrl
                      ? { runsUrl: improvementRunsUrl }
                      : {}),
                  },
                });
              }
              // regression fix: improvement_pr が succeeded で PR を作った時のみ
              // `improvement_pr.opened` 通知を送る。skipped_no_proposal /
              // auto_blocked は通知しない (Slack は PR 承認の主経路ではないため、
              // 「実物 PR が立った」イベントだけが Slack に上がる)。
              // regression fix: 同じ「実物 PR が立った」イベントに対して、
              // generic な `pr.opened` 通知も先に送る。the current implementation acceptance
              // 「Slack notifications are sent for PR creation, ...,
              // improvement PRs, ...」は "PR creation" を独立した notification
              // kind として要求しており、UI design plan §4.2 でも
              // `pr.opened` は NotificationKindBadge と 1:1 対応する別種別。
              // 失敗は `sendSlackNotification` 内で握り潰されるため Apply /
              // Cron に伝播しない。
              if (
                summary.status === "succeeded" &&
                summary.pullRequest &&
                repoRow
              ) {
                const riskLabel: "safe" | "requires_approval" | "dangerous" =
                  summary.classification ?? "requires_approval";
                const webApprovalsUrl = buildWebUrl(
                  webBaseUrl,
                  `/approvals/${summary.pullRequest.prNumber}`
                );
                await sendSlackNotification({
                  kind: "pr.opened",
                  data: {
                    prNumber: summary.pullRequest.prNumber,
                    prTitle: `improvement_pr (${acc.key})`,
                    prUrl: summary.pullRequest.htmlUrl,
                    repoFullName: repoSpec,
                    workflow: "improvement_pr",
                    adAccountKey: acc.key,
                    riskLabel,
                    ...(webApprovalsUrl ? { webApprovalsUrl } : {}),
                  },
                });
                await sendSlackNotification({
                  kind: "improvement_pr.opened",
                  data: {
                    prNumber: summary.pullRequest.prNumber,
                    prTitle: `improvement_pr (${acc.key})`,
                    prUrl: summary.pullRequest.htmlUrl,
                    repoFullName: repoSpec,
                    adAccountKey: acc.key,
                    riskLabel,
                    dangerousCategories: summary.dangerousCategories,
                    mode: summary.mode,
                    ...(summary.aiRunId ? { aiRunId: summary.aiRunId } : {}),
                    ...(webApprovalsUrl ? { webApprovalsUrl } : {}),
                  },
                });
              }
            }
            const aggregate = {
              accountsProcessed: summaries.length,
              succeeded: summaries.filter((s) => s.status === "succeeded").length,
              skipped_no_proposal: summaries.filter(
                (s) => s.status === "skipped_no_proposal"
              ).length,
              auto_blocked: summaries.filter(
                (s) => s.status === "auto_blocked"
              ).length,
              ai_failed: summaries.filter((s) => s.status === "ai_failed").length,
              pr_failed: summaries.filter((s) => s.status === "pr_failed").length,
              no_account: summaries.filter((s) => s.status === "no_account").length,
              llmProvider: llmSelection.choice,
            };
            if (errors.length > 0) {
              await failCronRun(
                cronStore,
                handle,
                `${workflowRunName} had failures: ${errors.join("; ")}`
              );
            } else {
              await finishCronRun(cronStore, handle, {
                ...aggregate,
                ...(summaries.length === 0
                  ? { note: "no active ad_accounts in workspace" }
                  : {}),
              });
            }
          } else if (presetName === "retention_sweep") {
            // Regression fix: performance_snapshots の保持期間
            // (raw=90d / aggregate=1y) を強制する housekeeping。AI を呼ばないため
            // workspace mode に依存しない。1 ティック = 全 workspace 共有の sweep。
            const summary = await runPerformanceSnapshotRetentionOnce({
              store: retentionStore,
            });
            const level: "info" | "warn" | "error" =
              summary.status === "succeeded"
                ? "info"
                : summary.status === "partial_failure"
                  ? "warn"
                  : "error";
            await cronStore.recordExecutionLog({
              cronRunId: handle.cronRunId,
              workspaceId: workspace.id,
              kind: "cron",
              refType: "cron_run",
              refId: handle.cronRunId,
              level,
              message:
                `retention_sweep: ${summary.status} ` +
                `(raw_cleared=${summary.rawCleared.affected}, ` +
                `granular_deleted=${summary.granularDeleted.affected}, ` +
                `aggregated_deleted=${summary.aggregatedDeleted.affected})`,
              payload: retentionSummaryToPayload(summary),
            });
            if (summary.status === "failed") {
              await failCronRun(
                cronStore,
                handle,
                `retention_sweep failed: ${[
                  summary.rawCleared.error,
                  summary.granularDeleted.error,
                  summary.aggregatedDeleted.error,
                ]
                  .filter((e): e is string => e !== null)
                  .join("; ")}`
              );
            } else {
              await finishCronRun(
                cronStore,
                handle,
                retentionSummaryToPayload(summary)
              );
            }
          }
          // 全 preset は上記 if/else if で網羅済み (CRON_PRESETS は型で固定)。
          // 新たな preset を CRON_PRESETS に追加した場合は本ブロックに分岐を足す。
        } catch (err) {
          await failCronRun(cronStore, handle, err).catch(() => undefined);
          log.warn(
            `[worker] cron handler failed (${preset.name}): ${(err as Error).message}`
          );
          // regression fix: 未分類の cron handler crash を Slack に通知する。
          // failCronRun で cron_runs 行は failed に倒れているが、Slack 通知が
          // 無いと運用者は `/cron/runs` を能動的に開くまで気付けない
          // (acceptance: "Slack notifications are sent for ..., and
          // failures.")。dispatch 自体の失敗は sendSlackNotification 内で
          // 握り潰されるので、Slack 連携が切れても cron loop は次の job を
          // 通常通り処理する。
          const cronRunsUrl = buildWebUrl(webBaseUrl, "/cron/runs");
          await sendSlackNotification({
            kind: "cron.failed",
            data: {
              cronName: preset.name,
              errorMessage: (err as Error).message ?? String(err),
              cronRunId: handle.cronRunId,
              ...(cronRunsUrl ? { runsUrl: cronRunsUrl } : {}),
            },
          });
        }
      }
    });
  }

  await boss.work<ScheduledAgentTaskPayload>(SCHEDULED_TASK_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      try {
        if (!job.data?.taskId) throw new Error("scheduled_task_run requires taskId");
        const result = await runScheduledAgentTaskJob({
          prisma,
          workspaceId: workspace.id,
          provider: llmSelection.provider,
          boss,
          githubAdapter: getGithubAdapter(),
          taskId: job.data.taskId,
          jobId: job.id,
          manual: job.data.manual === true,
        });
        await cronStore.recordExecutionLog({
          workspaceId: workspace.id,
          kind: "agent_task",
          level: result.status === "succeeded" ? "info" : "warn",
          message: `scheduled_task_run ${job.data.taskId}: ${result.status}`,
          payload: {
            taskId: job.data.taskId,
            runId: result.runId,
            status: result.status,
            manual: job.data.manual === true,
          },
        });
      } catch (err) {
        log.warn(
          `[worker] scheduled task failed (${job.data?.taskId ?? "unknown"}): ${(err as Error).message}`
        );
        await cronStore.recordExecutionLog({
          workspaceId: workspace.id,
          kind: "agent_task",
          level: "error",
          message: `scheduled_task_run failed: ${(err as Error).message}`,
          payload: {
            taskId: job.data?.taskId ?? null,
            error: (err as Error).message,
          },
        }).catch(() => undefined);
      }
    }
  });

  await boss.work<ScheduledAutomationRulePayload>(AUTOMATION_RULE_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      try {
        if (!job.data?.ruleId) throw new Error("automation_rule_run requires ruleId");
        const summary = await runScheduledAutomationRuleJob({
          prisma,
          workspaceId: workspace.id,
          boss,
          ruleId: job.data.ruleId,
          jobId: job.id,
          insightsProvider: dailyReportInsights,
          mutationExecutor: automationMutationSelection.executor,
          env: process.env,
          fallbackTimeZone: userTimeZone,
        });
        await cronStore.recordExecutionLog({
          workspaceId: workspace.id,
          kind: "automation_rule",
          level: summary.status === "succeeded" ? "info" : "warn",
          message:
            `automation_rule_run ${job.data.ruleKey ?? job.data.ruleId}: ${summary.status}` +
            ` (evaluated=${summary.rulesEvaluated}, planned=${summary.actionsPlanned}, ` +
            `executed=${summary.actionsExecuted}, blocked=${summary.actionsBlocked})`,
          payload: summary as unknown as JsonValue,
        });
      } catch (err) {
        log.warn(
          `[worker] automation rule failed (${job.data?.ruleKey ?? job.data?.ruleId ?? "unknown"}): ${(err as Error).message}`
        );
        await cronStore.recordExecutionLog({
          workspaceId: workspace.id,
          kind: "automation_rule",
          level: "error",
          message: `automation_rule_run failed: ${(err as Error).message}`,
          payload: {
            ruleId: job.data?.ruleId ?? null,
            ruleKey: job.data?.ruleKey ?? null,
            error: (err as Error).message,
          },
        }).catch(() => undefined);
      }
    }
  });

  // execute_apply: merged PR の operation manifest を読み、実行 action を組み、
  // PAUSED-by-default で Meta CLI / mock executor に流す。
  // regression fix: meta adapter は CLI / web と同じ Prisma 永続 token store 経由で
  //   組み立てる (`buildPrismaMetaAdapterSelection`)。OAuth 未連携時は Stub に倒れ、
  //   後段の `resolveApplyExecutor` / `resolveActivateExecutor` で auth_error +
  //   `oauth.meta.reauth_required` notify として fail-closed する。helper 内で
  //   secrets / crypto 読み込みの例外は吸収済みのため、await 1 回で確定する。
  const applyJobStore = createApplyJobStore(prisma, workspace.id);
  // regression fix: AdsLoader は workspace の opsRepoId を識別子として保持し、
  // apply_jobs の context.repoId と一致した PR だけを localDir から load する。
  // ops repo が未登録の workspace では apply_jobs が積まれないため、ここで
  // null だった場合は repoId verification をスキップせず fail-closed する。
  const wsRow = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: { opsRepoId: true },
  });
  const baseAdsLoader = createLocalDirAdsLoaderFromEnv(process.env, {
    expectedRepoId: wsRow?.opsRepoId ?? null,
    localDir: opsRepoRootDir,
  });
  const adsLoader: AdsLoader = {
    async loadForApply(input) {
      await ensureOpsRepoLocalCheckout({
        prisma: prisma as never,
        workspaceId: workspace.id,
      }).catch((err) => {
        log.warn(
          `[worker] ops repo sync before apply failed: ${(err as Error).message}`
        );
        return null;
      });
      return baseAdsLoader.loadForApply(input);
    },
  };
  const applyExecutorSelection = await resolveApplyExecutor({
    env: process.env,
    metaAdapter: metaAdapterSelection.adapter,
    resolveAdAccountId: async (accountKey) => {
      const row = await prisma.adAccount.findUnique({
        where: { workspaceId_key: { workspaceId: workspace.id, key: accountKey } },
        select: { metaAccountId: true },
      });
      return row?.metaAccountId ?? (accountKey.startsWith("act_") ? accountKey : null);
    },
    resolveAdAccountCurrency: async (accountKey) => {
      const row = await prisma.adAccount.findUnique({
        where: { workspaceId_key: { workspaceId: workspace.id, key: accountKey } },
        select: { currency: true },
      });
      return row?.currency ?? null;
    },
  });
  log.info(
    `[worker] apply executor: ${applyExecutorSelection.mode} (${applyExecutorSelection.reason})`
  );

  // regression fix / regression fix: cross-process ad_account ロックは
  // Postgres advisory lock を背に持つ provider を共有する。Apply (worker) と
  // Activate (web/cli)、cron workflows (daily_report/improvement_pr)、
  // manual budget checks が同じ Postgres インスタンスを介して 1 並行を強制する
  // ため、`adAccountLockProvider` は cron preset 登録より先に作成済み。
  await boss.work(APPLY_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      // pg-boss のジョブ ID は apply_jobs.jobId と一致する。row 取得して applyJobId を解決する。
      let applyJobId: string | null = null;
      try {
        const row = await prisma.applyJob.findFirst({
          where: { jobId: job.id },
          select: { id: true },
        });
        applyJobId = row?.id ?? null;
      } catch (err) {
        log.warn(
          `[worker] failed to resolve apply_job for pg-boss job ${job.id}: ${(err as Error).message}`
        );
      }
      if (!applyJobId) {
        log.warn(
          `[worker] received ${APPLY_JOB_NAME} job ${job.id} but no apply_job row; ignoring`
        );
        continue;
      }
      log.info(
        `[worker] received ${APPLY_JOB_NAME} job: ${job.id} (apply_job=${applyJobId})`
      );
      const startedAt = Date.now();
      try {
        const summary = await runExecuteApply({
          applyJobId,
          workspaceId: workspace.id,
          store: applyJobStore,
          loader: adsLoader,
          executor: applyExecutorSelection.executor,
          lockProvider: adAccountLockProvider,
        });
        log.info(
          `[worker] execute_apply ${applyJobId}: ${summary.state} (succeeded=${summary.succeeded}, failed=${summary.failed}, skipped=${summary.skipped}, paused-rewrites=${summary.pausedRewrites})`
        );
        if (summary.state === "succeeded") {
          for (const accountKey of collectAccountKeysFromOutcomes(summary.outcomes)) {
            // アカウントごとにトークンが違い得るのでループ内で解決する。
            const lease = await metaAdapterSelection.adapter
              .loadAccessTokenPlaintext(accountKey)
              .catch(() => null);
            if (lease?.accessToken) {
              await runMetaMirrorSync({
                prisma,
                workspaceId: workspace.id,
                accessToken: lease.accessToken,
                accountKey,
                actor: "agent:execute-apply",
                source: "apply_success",
              }).catch((err) => {
                log.warn(
                  `[worker] apply ${applyJobId}: mirror sync failed for ${accountKey}: ${(err as Error).message}`
                );
              });
            }
          }
        }
        // regression fix: Apply 終端で `apply.completed` または `apply.failed`
        // を Slack 通知する。`simulated` は実 Meta mutation を伴わないため通知
        // 価値が低く、`/apply` から確認できれば十分なので skip。
        if (summary.state === "succeeded" || summary.state === "failed") {
          const meta = await loadApplyNotificationMeta(prisma, applyJobId);
          const accountKeys = collectAccountKeysFromOutcomes(summary.outcomes);
          const adAccountKey =
            accountKeys.length === 0
              ? "(none)"
              : accountKeys.length === 1
                ? accountKeys[0]!
                : `${accountKeys[0]!} +${accountKeys.length - 1}`;
          const applyUrl = buildWebUrl(webBaseUrl, `/apply/${applyJobId}`);
          if (summary.state === "succeeded") {
            await sendSlackNotification({
              kind: "apply.completed",
              data: {
                applyJobId,
                adAccountKey,
                ...(meta?.prNumber != null
                  ? { prNumber: meta.prNumber }
                  : {}),
                ...(meta?.repoFullName
                  ? { repoFullName: meta.repoFullName }
                  : {}),
                filesTouched: summary.totalActions,
                durationMs: Date.now() - startedAt,
                metaObjectsAffected: summary.succeeded,
                ...(applyUrl ? { applyUrl } : {}),
                resultSummary:
                  `succeeded=${summary.succeeded} failed=${summary.failed}` +
                  ` skipped=${summary.skipped} paused-rewrites=${summary.pausedRewrites}`,
              },
            });
          } else {
            await sendSlackNotification({
              kind: "apply.failed",
              data: {
                applyJobId,
                adAccountKey,
                ...(meta?.prNumber != null
                  ? { prNumber: meta.prNumber }
                  : {}),
                ...(meta?.repoFullName
                  ? { repoFullName: meta.repoFullName }
                  : {}),
                errorMessage:
                  summary.errorMessage ?? `apply terminated in ${summary.state}`,
                ...(summary.abortReason
                  ? { errorCode: summary.abortReason }
                  : {}),
                ...(applyUrl ? { applyUrl } : {}),
              },
            });
          }
        }
      } catch (err) {
        log.error(
          `[worker] execute_apply ${applyJobId} crashed: ${(err as Error).message}`
        );
        try {
          await prisma.applyJob.update({
            where: { id: applyJobId },
            data: {
              state: "failed",
              finishedAt: new Date(),
              errorMessage: `worker handler crashed: ${(err as Error).message}`,
            },
          });
        } catch {
          /* swallow secondary error */
        }
        // regression fix: handler crash も failure path として Slack に通知
        // する。markApplyFinished が走った保証は無いが、apply_jobs 行は
        // 上の update で `failed` に倒れているため UI 側と通知が整合する。
        const meta = await loadApplyNotificationMeta(prisma, applyJobId).catch(
          () => null
        );
        const applyUrl = buildWebUrl(webBaseUrl, `/apply/${applyJobId}`);
        await sendSlackNotification({
          kind: "apply.failed",
          data: {
            applyJobId,
            adAccountKey: "(crashed)",
            ...(meta?.prNumber != null ? { prNumber: meta.prNumber } : {}),
            ...(meta?.repoFullName
              ? { repoFullName: meta.repoFullName }
              : {}),
            errorMessage: `worker handler crashed: ${(err as Error).message}`,
            errorCode: "handler_crash",
            ...(applyUrl ? { applyUrl } : {}),
          },
        });
      }
    }
  });

  // regression fix / the current implementation: `slack_command` pg-boss consumer を起動する。
  // Slack Socket Mode 受信機 (= 後段 startSlackSocketRuntime) が
  // `/adops <subcommand>` を ack 後に enqueue する pg-boss キューを処理する。
  // ハンドラ群は report / budget / improve / status / accounts / activate の
  // 6 種を持ち、Web/CLI と同じワークフロー (runDailyReportOnce /
  // runBudgetGuardOnce / runImprovementPrOnce / executeActivate) に橋渡しする。
  //
  // - 結果は Slack response_url に sanitize 済みで返り、`SlackCommandAuditWriter`
  //   が audit_logs に `slash_command.completed | slash_command.failed |
  //   activate.via_slack` を 1 行残す (UI design plan §0.20)。
  // - Slack 連携が未設定でも本 consumer は起動する (Slack 受信機が動かなければ
  //   キューに job が入らないだけ)。逆に Slack 連携を後から追加した場合に worker
  //   再起動なしで処理できる。
  // - 各ハンドラは throw しない契約。万一 throw しても `runSlackCommandJob` が
  //   catch して `slash_command.failed` audit + Slack 通知に倒すため、cron /
  //   apply には伝播しない。
  const slackCommandHandlers = createSlackCommandHandlers({
    prisma,
    workspaceId: workspace.id,
    adAccountLockProvider,
    dailyReportStore,
    dailyReportInsights,
    dailyReportAnalyst,
    userTimeZone,
    budgetGuardStore,
    budgetGuardAuditRunner: createBudgetGuardAuditRunner({
      provider: llmSelection.provider,
      workspaceId: workspace.id,
    }),
    loadBudgetGuardPolicy: () => loadBudgetGuardPolicyForRoot(opsRepoRootDir),
    improvementPrStore,
    improvementPrPipeline: createImprovementPrPipelineRunner({
      provider: llmSelection.provider,
      workspaceId: workspace.id,
    }),
    improvementPrPublisher: createImprovementPrGithubPublisher({
      prisma,
      adapter: getGithubAdapter(),
      workspaceId: workspace.id,
    }),
    improvementPrPlanValidator: createImprovementPrPlanValidator({
      rootDir: opsRepoRootDir,
      baseDir: process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null,
    }),
    improvementPrAudit: createImprovementPrAuditWriter({ prisma }),
    // regression fix: cron 経路と同じ image-Provider + LocalDisk Storage を
    // /adops improve の inline 起動でも共有する。
    improvementPrImageProvider: imageProviderSelection.provider,
    improvementPrLlmProvider: llmSelection.provider,
    improvementPrCreativeStorage: creativeStorage,
    // regression fix: cron 経路と同じ非空 Creative QA policy を /adops improve
    // からも適用する (空 policy で blocking check が skip に倒れて素通りする
    // 状態を slack 経由でも作らない)。
    improvementPrCreativeQaPolicy: DEFAULT_CREATIVE_QA_POLICY,
    loadImprovementPrRepo: async () => {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspace.id },
        select: { opsRepoId: true },
      });
      const repo = ws?.opsRepoId
        ? await prisma.githubRepo.findUnique({
            where: { id: ws.opsRepoId },
            select: { owner: true, name: true, defaultBranch: true },
          })
        : null;
      return {
        repoSpec: repo ? `${repo.owner}/${repo.name}` : "",
        baseRef: repo?.defaultBranch ?? "main",
      };
    },
    metaAdapter: metaAdapterSelection.adapter,
    env: process.env,
    webBaseUrl,
  });
  const slackCommandAudit = createSlackCommandAuditStore(prisma, workspace.id);

  await boss.work(SLACK_COMMAND_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data as SlackCommandJobPayload;
      try {
        const result = await runSlackCommandJob({
          payload,
          handlers: slackCommandHandlers,
          audit: slackCommandAudit,
        });
        log.info(
          `[worker] slack_command ${payload.subcommand}` +
            (payload.target ? ` ${payload.target}` : "") +
            `: ${result.state}` +
            ` (posted=${result.postedToResponseUrl}, durationMs=${result.durationMs})`
        );
      } catch (err) {
        // runSlackCommandJob は throw しない契約だが、防御的に飲み込む。
        // Slack 失敗は GitOps polling / Apply / Cron に伝播させない。
        log.warn(
          `[worker] slack_command ${payload?.subcommand ?? "<unknown>"} crashed: ${(err as Error).message}`
        );
      }
    }
  });

  await boss.work(SLACK_AGENT_JOB_NAME, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data as SlackAgentJobPayload;
      try {
        const installation = await loadSlackInstallation({
          prisma,
          logger: {
            info: (msg) => log.info(msg),
            warn: (msg) => log.warn(msg),
            error: (msg) => log.error(msg),
          },
        });
        if (!installation) {
          log.warn("[worker] slack_agent skipped: Slack installation is not configured.");
          continue;
        }
        const result = await runSlackAgentJob({
          payload,
          prisma,
          workspaceId: workspace.id,
          provider: llmSelection.provider,
          boss,
          botToken: installation.botToken,
          githubAdapter: getGithubAdapter(),
          ...(webBaseUrl ? { webUrl: webBaseUrl } : {}),
          logger: {
            info: (msg) => log.info(msg),
            warn: (msg) => log.warn(msg),
          },
        });
        log.info(
          `[worker] slack_agent ${payload.eventType} ${payload.slackChannelId}: ${result.status}` +
            ` (postedProcessing=${result.postedProcessing}, postedFinal=${result.postedFinal}, durationMs=${result.durationMs})`
        );
      } catch (err) {
        log.warn(
          `[worker] slack_agent crashed: ${(err as Error).message}`
        );
      }
    }
  });

  // regression fix / the current implementation: Slack Socket Mode `/adops` 受信機を起動する。
  // Slack 連携は完全に任意なので、`startSlackSocketRuntime` は token 未設定 /
  // ENCRYPTION_KEY 未設定 / 復号失敗のいずれの場合も `null` を返し、worker は
  // GitOps polling / Apply / Cron を通常通り稼働させる (acceptance: "Slack
  // integration is optional", "Slack and Web UI failures do not block core
  // GitOps polling, Apply, or Cron execution")。
  let slackSocketHandle: SlackSocketReceiverHandle | null = null;
  try {
    slackSocketHandle = await startSlackSocketRuntime({
      prisma,
      boss,
      logger: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
      },
    });
    if (slackSocketHandle) {
      log.info(
        `[worker] slack socket mode receiver: ${slackSocketHandle.getState()} (/adops)`
      );
    } else {
      log.info(
        "[worker] slack socket mode receiver: skipped (Slack is optional and unconfigured)"
      );
    }
  } catch (err) {
    // startSlackSocketRuntime は throw しない契約だが、防御的に握り潰す。
    log.warn(
      `[worker] slack socket mode receiver failed to start: ${(err as Error).message}`
    );
  }

  log.info(
    `[worker] ready. registered ${CRON_PRESETS.length} cron preset(s), execute_apply receiver, slack_command receiver, slack_agent receiver.`
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (slackSocketHandle) {
      try {
        await slackSocketHandle.stop();
      } catch (err) {
        log.warn(
          `[worker] error during slack socket stop: ${(err as Error).message}`
        );
      }
    }
    try {
      await boss.stop({ graceful: true });
    } catch (err) {
      log.warn(`[worker] error during pg-boss stop: ${(err as Error).message}`);
    }
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  };

  if (opts.installSignalHandlers) {
    const onSignal = (signal: NodeJS.Signals) => {
      log.info(`[worker] received ${signal}, shutting down…`);
      stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return { stop };
}

/**
 * this implementation: daily_report summary を execution_logs.payload に
 * 入る形 (JsonValue 互換) に変換する。BigInt や Date は前段で丸められて
 * いるため、ここでは shape の最小化のみを行う。
 */
function dailyReportSummaryToPayload(summary: DailyReportSummary): JsonValue {
  // KpiSet には `frequency: number | null` があり、JsonValue は undefined を
  // 含まないため、null 化したうえで明示的に JsonValue へ落とし込む。
  const kpis = (k: DailyReportSummary["current"]): JsonValue => ({
    spend: k.spend,
    impressions: k.impressions,
    clicks: k.clicks,
    conversions: k.conversions,
    ctr: k.ctr,
    cpc: k.cpc,
    cpa: k.cpa,
    cv: k.cv,
    cpm: k.cpm,
    frequency: k.frequency ?? null,
  });
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    workspaceId: summary.workspaceId,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    currency: summary.currency,
    metricDate: summary.metricDate,
    priorMetricDate: summary.priorMetricDate,
    metricTimeZone: summary.metricTimeZone,
    insightsSource: summary.insightsSource,
    mode: summary.mode,
    snapshotIds: summary.snapshotIds,
    aiRunId: summary.aiRunId,
    deltas: summary.deltas,
    statisticalContext: summary.statisticalContext as unknown as JsonValue,
    anomalies: {
      evaluatedNodeCount: summary.anomalies.evaluatedNodeCount,
      quietDay: summary.anomalies.quietDay,
      findings: summary.anomalies.findings.map((finding) => ({
        hierarchy: finding.hierarchy,
        nodeKey: finding.nodeKey,
        displayName: finding.displayName,
        metric: finding.metric,
        kind: finding.kind,
        zScore: finding.zScore,
        currentValue: finding.currentValue,
        baselineValue: finding.baselineValue,
        relativeChange: finding.relativeChange,
        confidence: finding.confidence,
        severity: finding.severity,
      })),
    },
    current: kpis(summary.current),
    prior: kpis(summary.prior),
    aiCommentary: summary.aiCommentary,
    topImprovements: summary.topImprovements.map((c) => ({
      hierarchy: c.hierarchy,
      target: c.target,
      rationale: c.rationale,
      expectedImpact: c.expectedImpact,
    })),
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  if (summary.anomalyDetectionError) {
    payload.anomalyDetectionError = summary.anomalyDetectionError;
  }
  return payload;
}

/**
 * budget_guard summary → execution_logs.payload / cron_runs.output accounts。
 */
function budgetGuardSummaryToPayload(summary: BudgetGuardSummary): JsonValue {
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    workspaceId: summary.workspaceId,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    mode: summary.mode,
    aiRunId: summary.aiRunId,
    classification: summary.classification,
    decision: summary.decision,
    dangerousCategories: summary.dangerousCategories,
    policyReasons: summary.policyReasons,
    candidateCount: summary.candidateCount,
    alerts: summary.alerts.map((alert) => ({
      rule: alert.rule,
      severity: alert.severity,
      message: alert.message,
      observedValue: alert.observedValue,
      threshold: alert.threshold,
    })),
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  return payload;
}

/**
 * budget_rebalance summary → execution_logs.payload / cron_runs.output accounts。
 */
function budgetRebalanceSummaryToPayload(summary: BudgetRebalanceSummary): JsonValue {
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    workspaceId: summary.workspaceId,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    mode: summary.mode,
    policyEnabled: summary.policyEnabled,
    window: summary.window,
    candidateCount: summary.candidateCount,
    plan: summary.plan
      ? {
          totalDeltaMajor: summary.plan.totalDeltaMajor,
          moves: summary.plan.moves.map((move) => ({
            nodeKey: move.nodeKey,
            displayName: move.displayName,
            direction: move.direction,
            fromMajor: move.fromMajor,
            toMajor: move.toMajor,
            deltaPercent: move.deltaPercent,
            reason: move.reason,
          })),
          skipped: summary.plan.skipped.map((item) => ({
            nodeKey: item.nodeKey,
            reason: item.reason,
          })),
        }
      : null,
    pullRequest: summary.pullRequest
      ? {
          pullRequestId: summary.pullRequest.pullRequestId,
          prNumber: summary.pullRequest.prNumber,
          htmlUrl: summary.pullRequest.htmlUrl,
          headSha: summary.pullRequest.headSha,
        }
      : null,
    classification: summary.classification,
    auditDecision: summary.auditDecision,
    dangerousCategories: summary.dangerousCategories,
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  return payload;
}

/**
 * experiment_evaluate summary → execution_logs.payload / cron_runs.output。
 */
function experimentEvaluateSummaryToPayload(summary: ExperimentEvaluateSummary): JsonValue {
  return {
    status: summary.status,
    evaluated: summary.evaluated,
    continued: summary.continued,
    concluded: summary.concluded,
    inconclusive: summary.inconclusive,
    cancelled: summary.cancelled,
    prFailed: summary.prFailed,
    items: summary.items.map((item) => ({
      experimentId: item.experimentId,
      name: item.name,
      accountKey: item.accountKey,
      status: item.status,
      verdict: item.verdict ? (item.verdict as unknown as JsonValue) : null,
      pullRequest: item.pullRequest
        ? {
            pullRequestId: item.pullRequest.pullRequestId,
            prNumber: item.pullRequest.prNumber,
            htmlUrl: item.pullRequest.htmlUrl,
            headSha: item.pullRequest.headSha,
          }
        : null,
      ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
    })),
  };
}

/**
 * Regression fix: improvement_pr summary → execution_logs.payload。
 */
function improvementPrSummaryToPayload(summary: ImprovementPrSummary): JsonValue {
  const payload: Record<string, JsonValue> = {
    status: summary.status,
    accountKey: summary.accountKey,
    accountId: summary.accountId,
    currency: summary.currency,
    mode: summary.mode,
    aiRunId: summary.aiRunId,
    aiRunIds: summary.aiRunIds,
    decision: summary.decision,
    proposalCount: summary.proposalCount,
    classification: summary.classification,
    auditDecision: summary.auditDecision,
    dangerousCategories: summary.dangerousCategories,
    pullRequest: summary.pullRequest
      ? {
          pullRequestId: summary.pullRequest.pullRequestId,
          prNumber: summary.pullRequest.prNumber,
          htmlUrl: summary.pullRequest.htmlUrl,
          headSha: summary.pullRequest.headSha,
        }
      : null,
  };
  if (summary.errorMessage) payload.errorMessage = summary.errorMessage;
  return payload;
}

/**
 * Regression fix: retention_sweep summary → execution_logs.payload。
 */
function retentionSummaryToPayload(summary: RetentionSweepSummary): JsonValue {
  return {
    status: summary.status,
    rawCutoff: summary.rawCutoff,
    aggregateCutoff: summary.aggregateCutoff,
    policy: {
      rawDays: summary.policy.rawDays,
      aggregateDays: summary.policy.aggregateDays,
    },
    rawCleared: {
      affected: summary.rawCleared.affected,
      error: summary.rawCleared.error,
    },
    granularDeleted: {
      affected: summary.granularDeleted.affected,
      error: summary.granularDeleted.error,
    },
    aggregatedDeleted: {
      affected: summary.aggregatedDeleted.affected,
      error: summary.aggregatedDeleted.error,
    },
  };
}

/**
 * Regression fix: cron tick 単位で `workspaces.executionMode` を
 * 読み出す。worker 起動時にも `ensureWorkspace` が値を返すが、UI/CLI の mode
 * 切替は worker を再起動せずに反映される必要があるため、各 cron 起動時に再取得
 * する (1 行 1 列の lookup なので無視できるコスト)。
 */
async function loadWorkspaceMode(
  client: PrismaClient,
  workspaceId: string
): Promise<string | null> {
  const row = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { executionMode: true },
  });
  return row?.executionMode ?? null;
}

async function syncEnabledCronSchedules(input: {
  prisma: PrismaClient;
  boss: PgBoss;
  workspaceId: string;
  timeZone: string;
  log: WorkerLogger;
}): Promise<void> {
  const internalAlwaysOnPresets = new Set(["github_poll"]);
  const presetByName = new Map(CRON_PRESETS.map((preset) => [preset.name, preset]));
  const rows = await input.prisma.cronSchedule.findMany({
    where: { workspaceId: input.workspaceId },
    select: { name: true, cron: true, enabled: true },
  });

  for (const row of rows) {
    const preset = presetByName.get(row.name as (typeof CRON_PRESETS)[number]["name"]);
    if (!preset) {
      continue;
    }
    try {
      if (row.enabled || internalAlwaysOnPresets.has(row.name)) {
        await scheduleCron(input.boss, row.name, row.cron || preset.cron, input.timeZone);
      } else {
        await input.boss.unschedule(row.name);
      }
    } catch (err) {
      input.log.warn(
        `[worker] failed to sync cron schedule ${row.name}: ${(err as Error).message}`
      );
    }
  }
}

/**
 * Regression fix: Apply 通知 (apply.completed / apply.failed) で
 * 表示する PR 番号 / repo full name を取得する。`apply_jobs.pullRequestId` →
 * `github_pull_requests.repoId` → `github_repos.{owner,name}` の 1 ホップ
 * チェーン。失敗時は null を返し、通知側は該当フィールドを省略する
 * (= notification 失敗で apply pipeline を degrade させない)。
 */
async function loadApplyNotificationMeta(
  client: PrismaClient,
  applyJobId: string
): Promise<{ prNumber: number; repoFullName: string } | null> {
  try {
    const apply = await client.applyJob.findUnique({
      where: { id: applyJobId },
      select: { pullRequestId: true },
    });
    if (!apply?.pullRequestId) return null;
    const pr = await client.githubPullRequest.findUnique({
      where: { id: apply.pullRequestId },
      select: { number: true, repoId: true },
    });
    if (!pr) return null;
    const repo = await client.githubRepo.findUnique({
      where: { id: pr.repoId },
      select: { owner: true, name: true },
    });
    if (!repo) return { prNumber: pr.number, repoFullName: "" };
    return { prNumber: pr.number, repoFullName: `${repo.owner}/${repo.name}` };
  } catch {
    return null;
  }
}

/**
 * Apply の outcomes から触れた ad_account の unique key を昇順で返す。
 * Slack 通知の `adAccountKey` 表示に使う。outcomes が空 (= no_actions) の
 * ケースも安全に空配列を返す。
 */
function collectAccountKeysFromOutcomes(
  outcomes: ReadonlyArray<{ action: { account: string } }>
): string[] {
  const set = new Set<string>();
  for (const o of outcomes) {
    if (o.action && typeof o.action.account === "string") {
      set.add(o.action.account);
    }
  }
  return [...set].sort();
}

/**
 * Regression fix: Slack 通知ディスパッチを producer から呼ぶための
 * 「失敗を握りつぶす」ラッパ。`WorkerSlackNotifier.dispatch` 自身が throw しない
 * 契約だが、防御的に try/catch で覆って Slack 起因の例外が GitOps polling /
 * Apply / Cron / Improvement PR cron に伝播することを根本から塞ぐ。
 *
 * - `failed` / `skipped_no_slack` は audit_logs に notifier 側で記録済み。
 * - logger には sanitize 済みの 1 行 summary のみ書き、平文 token を残さない。
 */
function makeSafeNotificationSender(
  notifier: WorkerSlackNotifier,
  log: WorkerLogger
): (payload: SlackNotificationPayload) => Promise<void> {
  return async (payload: SlackNotificationPayload): Promise<void> => {
    try {
      const result = await notifier.dispatch(payload);
      if (result.state === "failed") {
        log.warn(
          `[worker] slack notification ${result.kind} failed: ${result.errorCode ?? "unknown"}`
        );
      }
    } catch (err) {
      log.warn(
        `[worker] slack notification ${payload.kind} crashed (swallowed): ${(err as Error).message}`
      );
    }
  };
}

/**
 * `webBaseUrl` が設定されていれば `path` を base URL に対して resolve した
 * 絶対 URL を返す。Slack の Block Kit `<button>` action は `http(s)://` で
 * 始まる URL のみ受け付けるため、未設定時は undefined を返してリンクを省略。
 */
function buildWebUrl(
  base: string | null,
  path: string
): string | undefined {
  if (!base) return undefined;
  const trimmedBase = base.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmedBase)) return undefined;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function readMetricDateFromCronJobData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).metricDate;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function isManualCronJobData(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).manual === true;
}

async function refreshInsightsAndLoadManualImprovementContext(input: {
  prisma: PrismaClient;
  cronStore: {
    recordExecutionLog(args: {
      cronRunId: string;
      workspaceId: string;
      kind: string;
      refType: string;
      refId: string;
      level: "info" | "warn" | "error";
      message: string;
      payload?: JsonValue;
    }): Promise<unknown>;
  };
  cronRunId: string;
  workspaceId: string;
  accountId: string;
  accountKey: string;
  accountCurrency: string;
  mode: ImprovementPrExecutionMode;
  timeZone: string;
  insightsProvider: DailyReportInsightsProvider;
  snapshotStore: DailyReportSnapshotStore;
  now: Date;
  auditWriter: ImprovementPrAuditWriter;
}): Promise<
  | Awaited<ReturnType<typeof loadRecentPerformanceSnapshotContext>>
  | { refreshFailedSummary: ImprovementPrSummary }
> {
  const refresh = await refreshLatestInsightsForManualImprovementPr({
    accountId: input.accountId,
    accountKey: input.accountKey,
    timeZone: input.timeZone,
    insightsProvider: input.insightsProvider,
    store: input.snapshotStore,
    now: input.now,
  });
  const message =
    `improvement_pr ${input.accountKey}: refreshed latest insights ` +
    `${refresh.datesSucceeded.length}/${refresh.datesRequested.length} dates, ` +
    `${refresh.rowsUpserted} rows`;
  await input.cronStore.recordExecutionLog({
    cronRunId: input.cronRunId,
    workspaceId: input.workspaceId,
    kind: "cron",
    refType: "cron_run",
    refId: input.cronRunId,
    level:
      refresh.status === "failed"
        ? "error"
        : refresh.status === "partial"
          ? "warn"
          : "info",
    message,
    payload: refresh as unknown as JsonValue,
  });

  if (refresh.status === "failed") {
    const errorMessage =
      "最新レポートを取得できなかったため、古い実績を使った改善提案は作成しませんでした。" +
      (refresh.errors.length > 0 ? ` ${refresh.errors.join("; ")}` : "");
    await input.auditWriter.recordImprovementPrAudit({
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      accountId: input.accountId,
      cronRunId: input.cronRunId,
      action: "improvement_pr.failed",
      pullRequest: null,
      aiRunIds: [],
      auditDecision: null,
      classification: null,
      dangerousCategories: [],
      metadata: {
        failedAt: "refresh_insights",
        refresh,
      },
      summary: `improvement_pr refresh_insights failed; PR not opened`,
    });
    return {
      refreshFailedSummary: {
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
        currency: input.accountCurrency,
        pullRequest: null,
        classification: null,
        auditDecision: null,
        dangerousCategories: [],
        errorMessage,
      },
    };
  }

  return loadRecentPerformanceSnapshotContext(input.prisma, {
    accountId: input.accountId,
    timeZone: input.timeZone,
    now: input.now,
    includeToday: true,
  });
}

function resolveRuntimeUserTimeZone(env: NodeJS.ProcessEnv): string {
  const candidates = [
    env.ADDROID_USER_TIMEZONE,
    env.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
      return trimmed;
    } catch {
      // Keep trying less-specific fallbacks.
    }
  }
  return "UTC";
}

export type { PgBoss };
