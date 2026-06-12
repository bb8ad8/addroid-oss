import cronParser from "cron-parser";
import {
  buildAgentContext,
  buildAgentLoopInput,
  runAgentTurn,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import { Prisma, type PrismaClient } from "@addroid/db";
import type PgBoss from "pg-boss";
import type { GithubAdapter } from "@addroid/github-adapter";
import {
  fetchMetaAssetReadiness,
  type MetaAssetReadinessReport,
} from "@addroid/meta-adapter";
import {
  readAddroidConfig,
  resolveAddroidLanguage,
  type AddroidLanguage,
} from "@addroid/config";
import {
  CRON_PRESETS,
  SCHEDULED_TASK_JOB_NAME,
  resolveCronScheduleTimeZone,
  scheduleCron,
  validateCronExpression,
  type CronPresetName,
} from "@addroid/queue";
import type { LLMProvider } from "@addroid/llm-provider";
import {
  createPrismaPlanStore,
  persistPlanRun,
  runPlanForRoot,
  type PlanRunSource,
} from "./plan-runtime.js";
import { runMetaAdsReadOnlyQuery } from "./meta-ads-readonly-runtime.js";
import {
  createOpsChangeProposal,
  type OpsChangeProposalInput,
} from "./ops-proposal-runtime.js";
import {
  createStandaloneCreativeGeneration,
  createCreativeSubmissionProposal,
  normalizeCreativeGenerationInput,
  normalizeCreativeSubmissionInput,
} from "./creative-submission-runtime.js";
import {
  createCreativePromotionProposals,
  normalizeCreativePromotionBatchInput,
} from "./creative-promotion-runtime.js";
import {
  normalizeCreativeSubmissionContextResolverInput,
  resolveCreativeSubmissionContext,
} from "./creative-submission-context-resolver.js";
import {
  createAutomationRuleProposal,
  type AutomationRuleProposalInput,
} from "./automation-rule-proposal-runtime.js";
import {
  ensureOpsRepoLocalCheckout,
  resolveOpsRepoLocalDirForWorkspace,
} from "./ops-repo-local.js";
import {
  createOrReuseAgentTask,
  normalizeAgentTaskPrompt,
} from "./agent-task-store.js";
import {
  saveBudgetGuardPolicyConfig,
  type BudgetGuardPolicyConfigInput,
} from "./budget-guard-policy-config.js";
import {
  saveSubmissionGuardPolicyConfig,
  type SubmissionGuardPolicyConfigInput,
} from "./submission-guard-policy-config.js";
import { formatImprovementReportForUser } from "./improvement-report-format.js";
import {
  decidePullRequestApproval,
  type ApprovalDecisionAction,
} from "./approval-decision-runtime.js";
import { buildPrismaMetaAdapterSelection } from "./meta-runtime.js";
import { runMetaMirrorSync } from "./meta-mirror-runtime.js";
import {
  runPerformanceCompareCatalogTool,
  runPerformanceQueryCatalogTool,
} from "./query-catalog-runtime.js";

export interface RunDueAgentTasksOptions {
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
  githubAdapter?: GithubAdapter;
}

export interface AgentTasksSummary {
  status: "succeeded" | "partial_failure" | "failed";
  due: number;
  succeeded: number;
  failed: number;
}

export interface ScheduledAgentTaskPayload {
  taskId: string;
  manual?: boolean;
  requestedBy?: string;
  requestedAt?: string;
}

interface AgentTaskExecutionOptions extends RunDueAgentTasksOptions {
  taskId: string;
  jobId?: string;
  manual?: boolean;
}

export async function scheduleAgentTaskNextRun(opts: {
  prisma: PrismaClient;
  boss: PgBoss;
  taskId: string;
  workspaceId?: string;
  now?: Date;
}): Promise<{ jobId: string | null; nextRunAt: Date } | null> {
  const task = await opts.prisma.agentTask.findFirst({
    where: {
      id: opts.taskId,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
    select: {
      id: true,
      workspaceId: true,
      cron: true,
      enabled: true,
      scheduledJobId: true,
    },
  });
  if (!task || !task.enabled) return null;
  const nextRunAt = computeNextRunAt(task.cron, opts.now ?? new Date());
  if (task.scheduledJobId) {
    await opts.boss
      .cancel(SCHEDULED_TASK_JOB_NAME, task.scheduledJobId)
      .catch(() => undefined);
  }
  const jobId = await opts.boss.send(
    SCHEDULED_TASK_JOB_NAME,
    {
      taskId: task.id,
      requestedBy: "system:scheduler",
      requestedAt: new Date().toISOString(),
    },
    { startAfter: nextRunAt, singletonKey: task.id }
  );
  await opts.prisma.agentTask.update({
    where: { id: task.id },
    data: { nextRunAt, scheduledJobId: jobId },
  });
  return { jobId, nextRunAt };
}

export async function cancelAgentTaskNextRun(opts: {
  prisma: PrismaClient;
  boss: PgBoss;
  taskId: string;
  workspaceId?: string;
}): Promise<void> {
  const task = await opts.prisma.agentTask.findFirst({
    where: {
      id: opts.taskId,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
    select: { id: true, scheduledJobId: true },
  });
  if (!task) return;
  if (task.scheduledJobId) {
    await opts.boss
      .cancel(SCHEDULED_TASK_JOB_NAME, task.scheduledJobId)
      .catch(() => undefined);
  }
  await opts.prisma.agentTask.update({
    where: { id: task.id },
    data: { scheduledJobId: null, nextRunAt: null },
  });
}

export async function enqueueAgentTaskNow(opts: {
  boss: PgBoss;
  taskId: string;
  requestedBy: string;
}): Promise<string | null> {
  return opts.boss.send(SCHEDULED_TASK_JOB_NAME, {
    taskId: opts.taskId,
    manual: true,
    requestedBy: opts.requestedBy,
    requestedAt: new Date().toISOString(),
  });
}

export async function rescheduleEnabledAgentTasks(opts: {
  prisma: PrismaClient;
  boss: PgBoss;
  workspaceId: string;
}): Promise<{ scheduled: number }> {
  const tasks = await opts.prisma.agentTask.findMany({
    where: { workspaceId: opts.workspaceId, enabled: true },
    select: { id: true },
    orderBy: { nextRunAt: "asc" },
  });
  let scheduled = 0;
  for (const task of tasks) {
    const result = await scheduleAgentTaskNextRun({
      prisma: opts.prisma,
      boss: opts.boss,
      workspaceId: opts.workspaceId,
      taskId: task.id,
    });
    if (result) scheduled += 1;
  }
  return { scheduled };
}

export async function runScheduledAgentTaskJob(
  opts: AgentTaskExecutionOptions
): Promise<{ status: "succeeded" | "failed"; runId: string; message?: string }> {
  const task = await opts.prisma.agentTask.findFirst({
    where: { id: opts.taskId, workspaceId: opts.workspaceId },
    select: {
      id: true,
      title: true,
      prompt: true,
      cron: true,
      enabled: true,
      scheduledJobId: true,
    },
  });
  if (!task) throw new Error(`Agent task not found: ${opts.taskId}`);
  if (!opts.manual && !task.enabled) {
    throw new Error(`Agent task is disabled: ${opts.taskId}`);
  }
  if (!opts.manual && opts.jobId && task.scheduledJobId && task.scheduledJobId !== opts.jobId) {
    throw new Error(`Agent task job is stale: ${opts.taskId}`);
  }

  const run = await opts.prisma.agentTaskRun.create({
    data: {
      workspaceId: opts.workspaceId,
      taskId: task.id,
      status: "running",
    },
    select: { id: true },
  });
  try {
    const language = await resolveWorkerLanguage();
    const agentContext = await buildAgentContext(process.env);
    const executions = [];
    const seenTools = new Set<string>();
    let message = "";
    for (let i = 0; i < 4; i += 1) {
      const turn = await runAgentTurn({
        input: buildAgentLoopInput(task.prompt, executions),
        provider: opts.provider,
        agentContext,
        purpose: "worker:agent-task",
        surface: "scheduled-agent",
        language,
      });
      if (turn.message) message = turn.message;
      if (turn.toolResults.length === 0) break;
      let executedAny = false;
      for (const tool of turn.toolResults) {
        const signature = toolSignature(tool);
        if (signature && seenTools.has(signature)) {
          executions.push({
            display: signature,
            status: "unsupported",
            message: "duplicate tool call skipped",
          });
          continue;
        }
        if (signature) seenTools.add(signature);
        executions.push(await executeWorkerAgentTool({
          tool,
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          boss: opts.boss,
          webUrl: agentContext.webUrl,
          githubAdapter: opts.githubAdapter,
          provider: opts.provider,
        }));
        executedAny = true;
      }
      if (!executedAny) break;
    }
    const hasFailure = executions.some((e) =>
      e.status === "error" || e.status === "denied" || e.status === "unsupported"
    );
    await opts.prisma.agentTaskRun.update({
      where: { id: run.id },
      data: {
        status: hasFailure ? "failed" : "succeeded",
        finishedAt: new Date(),
        message,
        toolCalls: executions as Prisma.InputJsonValue,
        errorMessage: hasFailure
          ? executions.find((e) =>
              e.status === "error" || e.status === "denied" || e.status === "unsupported"
            )?.message ?? "agent task failed"
          : null,
      },
    });
    await opts.prisma.agentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: new Date(),
        lastState: hasFailure ? "failed" : "success",
        ...(opts.manual ? {} : { scheduledJobId: null }),
      },
    });
    if (!opts.manual && task.enabled) {
      await scheduleAgentTaskNextRun({
        prisma: opts.prisma,
        boss: opts.boss,
        workspaceId: opts.workspaceId,
        taskId: task.id,
      });
    }
    return { status: hasFailure ? "failed" : "succeeded", runId: run.id, message };
  } catch (err) {
    await opts.prisma.agentTaskRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: (err as Error).message,
      },
    });
    await opts.prisma.agentTask.update({
      where: { id: task.id },
      data: {
        lastRunAt: new Date(),
        lastState: "failed",
        ...(opts.manual ? {} : { scheduledJobId: null }),
      },
    });
    if (!opts.manual && task.enabled) {
      await scheduleAgentTaskNextRun({
        prisma: opts.prisma,
        boss: opts.boss,
        workspaceId: opts.workspaceId,
        taskId: task.id,
      }).catch(() => undefined);
    }
    throw err;
  }
}

async function resolveWorkerLanguage(): Promise<AddroidLanguage> {
  const config = await readAddroidConfig().catch(() => null);
  return resolveAddroidLanguage({
    preference: config?.ui.language,
  });
}

function computeNextRunAt(cron: string, currentDate = new Date()): Date {
  const validation = validateCronExpression(cron);
  if (!validation.ok) throw new Error(`cron 式が不正です: ${validation.reason}`);
  return cronParser
    .parseExpression(cron, {
      currentDate,
      tz: resolveCronScheduleTimeZone(),
    })
    .next()
    .toDate();
}

export async function executeWorkerAgentTool(opts: {
  tool: AgentToolResult;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
  webUrl: string;
  githubAdapter?: GithubAdapter;
  provider?: LLMProvider;
  referenceImagePaths?: string[];
  actor?: string;
  source?: PlanRunSource;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const { tool } = opts;
  if (tool.status === "denied") {
    return { display: tool.toolName, status: "denied", message: tool.reason };
  }
  if (tool.status === "unsupported") {
    return { display: tool.toolName, status: "unsupported", message: tool.reason };
  }
  const readyTool = tool;
  try {
    switch (readyTool.tool) {
      case "open_web_ui":
        return { display: readyTool.display, status: "ok", message: opts.webUrl };
      case "check_status":
      case "diagnose":
        return { display: readyTool.display, status: "ok", message: "worker is running" };
      case "list_ad_accounts": {
        const accounts = await opts.prisma.adAccount.findMany({
          where: { workspaceId: opts.workspaceId, active: true },
          select: { key: true, displayName: true, metaAccountId: true },
          orderBy: { key: "asc" },
        });
        const assetReadiness = await loadWorkerMetaAssetReadiness(opts.prisma, accounts);
        const blocked = assetReadiness.filter((report) => !report.ok);
        return {
          display: readyTool.display,
          status: "ok",
          message:
            blocked.length > 0
              ? `${accounts.length} 件の広告アカウントがあります。Meta権限の要確認が ${blocked.length} 件あります: ${blocked[0]!.messages[0] ?? "アセット権限を確認してください。"}`
              : `${accounts.length} 件の広告アカウントがあります。${assetReadiness.length ? `Meta権限チェックは ${assetReadiness.length} 件 OK です。` : ""}`,
          data: { accounts, assetReadiness },
        };
      }
      case "select_ad_account":
        return await selectDefaultAccount({ ...opts, tool: readyTool });
      case "connect_service":
        return connectServiceResult(readyTool.toolArgs, readyTool.display, opts.webUrl);
      case "get_report": {
        const preset = reportPreset(
          typeof readyTool.toolArgs.kind === "string" ? readyTool.toolArgs.kind : "daily"
        );
        const metricDate = resolveMetricDateArg(readyTool.toolArgs);
        const jobId = await opts.boss.send(preset, {
          ...(metricDate ? { metricDate } : {}),
          manual: true,
          requestedBy: opts.actor ?? "agent:scheduled-task",
          requestedAt: new Date().toISOString(),
        });
        if (preset === "improvement_pr") {
          if (!jobId) {
            return {
              display: readyTool.display,
              status: "ok",
              message: `改善提案は既に実行中です。完了後に ${opts.webUrl}/improvements で確認できます。`,
              data: { jobId },
            };
          }
          const run = await waitForCronRun(opts.prisma, jobId, preset, 300_000);
          if (!run) {
            return {
              display: readyTool.display,
              status: "ok",
              message: `改善提案を作成中です。完了後に ${opts.webUrl}/improvements で確認できます。`,
              data: { jobId },
            };
          }
          const [logs, audits] = await Promise.all([
            opts.prisma.executionLog.findMany({
              where: { cronRunId: run.id },
              orderBy: { createdAt: "asc" },
              select: { level: true, message: true, payload: true },
            }),
            loadImprovementAuditsForCronRun(opts.prisma, opts.workspaceId, run.id),
          ]);
          return {
            display: readyTool.display,
            status: run.state === "failed" ? "error" : "ok",
            message: formatImprovementReportForUser(run, logs, audits, opts.webUrl),
            data: { jobId, cronRunId: run.id },
          };
        }
        return {
          display: readyTool.display,
          status: "ok",
          message: `${preset} を enqueue しました。`,
          data: { jobId },
        };
      }
      case "create_scheduled_agent_task":
        return await createScheduledAgentTask({ ...opts, tool: readyTool });
      case "set_schedule_enabled":
        return await setScheduleEnabled({ ...opts, tool: readyTool });
      case "configure_budget_guard":
        return await configureBudgetGuard({ ...opts, tool: readyTool });
      case "configure_submission_guards":
        return await configureSubmissionGuards({ ...opts, tool: readyTool });
      case "manage_schedule":
        return await manageSchedule({ ...opts, tool: readyTool });
      case "check_submission":
        return await runSubmissionCheck({ ...opts, tool: readyTool });
      case "show_logs":
        return await showRecentLogs({ ...opts, tool: readyTool });
      case "query_performance": {
        try {
          const result = await runPerformanceQueryCatalogTool({
            prisma: opts.prisma,
            args: readyTool.toolArgs,
          });
          return {
            display: readyTool.display,
            status: "ok",
            message: result.message,
            data: result.result,
          };
        } catch (err) {
          return {
            display: readyTool.display,
            status: "error",
            message: `パフォーマンス集計を実行できませんでした: ${(err as Error).message}`,
          };
        }
      }
      case "compare_performance": {
        try {
          const result = await runPerformanceCompareCatalogTool({
            prisma: opts.prisma,
            args: readyTool.toolArgs,
          });
          return {
            display: readyTool.display,
            status: "ok",
            message: result.message,
            data: result.result,
          };
        } catch (err) {
          return {
            display: readyTool.display,
            status: "error",
            message: `パフォーマンス比較を実行できませんでした: ${(err as Error).message}`,
          };
        }
      }
      case "query_meta_ads": {
        const result = await runMetaAdsReadOnlyQuery({
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          args: readyTool.toolArgs,
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: result.message,
          data: { label: result.label, rowCount: result.rowCount, rows: result.rows.slice(0, 20) },
        };
      }
      case "sync_meta_mirror":
        return await syncMetaMirror({ ...opts, tool: readyTool });
      case "propose_ops_change": {
        if (!opts.githubAdapter) {
          return {
            display: readyTool.display,
            status: "error",
            message: "GitHub adapter が worker に注入されていません。",
          };
        }
        const result = await createOpsChangeProposal({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          input: normalizeOpsProposalInput(readyTool.toolArgs),
          actor: opts.actor ?? "agent:scheduled-task",
          source: opts.source ?? "scheduled-agent",
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `GitOps PR #${result.prNumber} を作成しました。`,
          data: result,
        };
      }
      case "decide_approval": {
        const action = normalizeApprovalDecision(readyTool.toolArgs);
        const result = await decidePullRequestApproval({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          prNumber: readRequiredPrNumber(readyTool.toolArgs),
          action,
          actor: opts.actor ?? "agent:scheduled-task",
          decisionSource: action === "approve" ? "slack_merge" : "slack_reject",
          ...(normalizeMergeMethod(readyTool.toolArgs)
            ? { mergeMethod: normalizeMergeMethod(readyTool.toolArgs) }
            : {}),
          ...(readOptionalString(readyTool.toolArgs.comment)
            ? { comment: readOptionalString(readyTool.toolArgs.comment)! }
            : {}),
        });
        return {
          display: readyTool.display,
          status: "ok",
          message:
            action === "approve"
              ? `PR #${result.prNumber} を承認しました。`
              : `PR #${result.prNumber} を否決しました。`,
          data: result,
        };
      }
      case "propose_creative_submission": {
        if (!opts.githubAdapter) {
          return {
            display: readyTool.display,
            status: "error",
            message: "GitHub adapter が worker に注入されていません。",
          };
        }
        const result = await createCreativeSubmissionProposal({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          input: normalizeCreativeSubmissionInput(
            mergeReferenceImagePaths(readyTool.toolArgs, opts.referenceImagePaths ?? [])
          ),
          actor: opts.actor ?? "agent:scheduled-task",
          source: normalizeCreativeSubmissionSource(opts.source),
          llmProvider: opts.provider ?? null,
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `クリエイティブ入稿 PR #${result.prNumber} を作成しました。`,
          data: result,
        };
      }
      case "generate_creatives": {
        const result = await createStandaloneCreativeGeneration({
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          input: normalizeCreativeGenerationInput(
            mergeReferenceImagePaths(readyTool.toolArgs, opts.referenceImagePaths ?? [])
          ),
          actor: opts.actor ?? "agent:scheduled-task",
          source: normalizeCreativeGenerationSource(opts.source),
          llmProvider: opts.provider ?? null,
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: result.message,
          data: result,
        };
      }
      case "resolve_creative_submission_context": {
        const result = await resolveCreativeSubmissionContext({
          prisma: opts.prisma,
          workspaceId: opts.workspaceId,
          input: normalizeCreativeSubmissionContextResolverInput(readyTool.toolArgs),
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: result.message,
          data: result,
        };
      }
      case "promote_creative_submission": {
        if (!opts.githubAdapter) {
          return {
            display: readyTool.display,
            status: "error",
            message: "GitHub adapter が worker に注入されていません。",
          };
        }
        const result = await createCreativePromotionProposals({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          input: normalizeCreativePromotionBatchInput(readyTool.toolArgs),
          actor: opts.actor ?? "agent:scheduled-task",
          source: normalizeCreativeSubmissionSource(opts.source),
          llmProvider: opts.provider ?? null,
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `生成済みクリエイティブ ${result.count} 件を入稿 PR ${result.prNumbers.map((n) => `#${n}`).join(", ")} に回しました。`,
          data: result,
        };
      }
      case "propose_automation_rule": {
        if (!opts.githubAdapter) {
          return {
            display: readyTool.display,
            status: "error",
            message: "GitHub adapter が worker に注入されていません。",
          };
        }
        const result = await createAutomationRuleProposal({
          prisma: opts.prisma,
          githubAdapter: opts.githubAdapter,
          workspaceId: opts.workspaceId,
          input: normalizeAutomationRuleProposalInput(readyTool.toolArgs),
          actor: opts.actor ?? "agent:scheduled-task",
          source: opts.source ?? "scheduled-agent",
        });
        return {
          display: readyTool.display,
          status: "ok",
          message: `自動化ルール PR #${result.prNumber} を作成しました。`,
          data: result,
        };
      }
      default:
        return {
          display: readyTool.display,
          status: "unsupported",
          message: `scheduled task では未対応の tool です: ${readyTool.tool}`,
        };
    }
  } catch (err) {
    return {
      display: readyTool.display,
      status: "error",
      message: (err as Error).message,
    };
  }
}

async function loadWorkerMetaAssetReadiness(
  prisma: PrismaClient,
  accounts: readonly { key: string; metaAccountId: string | null }[]
): Promise<MetaAssetReadinessReport[]> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma }).catch(() => null);
  if (!selection || selection.choice === "stub") return [];
  const lease = await selection.adapter.loadAccessTokenPlaintext().catch(() => null);
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

async function syncMetaMirror(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  actor?: string;
  source?: PlanRunSource;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma: opts.prisma }).catch(() => null);
  const lease = await selection?.adapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease?.accessToken) {
    return {
      display: opts.tool.display,
      status: "error",
      message: "Meta token が未接続です。",
    };
  }
  const result = await runMetaMirrorSync({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    accessToken: lease.accessToken,
    accountId: readOptionalString(opts.tool.toolArgs.accountId),
    accountKey:
      readOptionalString(opts.tool.toolArgs.accountKey) ??
      readOptionalString(opts.tool.toolArgs.account_key),
    includeMetrics:
      opts.tool.toolArgs.includeMetrics !== false &&
      opts.tool.toolArgs.include_metrics !== false,
    actor: opts.actor ?? "agent:scheduled-task",
    source: opts.source ?? "scheduled-agent",
  });
  return {
    display: opts.tool.display,
    status: "ok",
    message: `Mirror DB を同期しました。campaign=${result.campaigns}, adset=${result.adsets}, ad=${result.ads}, snapshot=${result.metrics.snapshots}`,
    data: result,
  };
}

function normalizeCreativeSubmissionSource(source: PlanRunSource | undefined) {
  if (
    source === "web-chat" ||
    source === "slack-chat" ||
    source === "agent-task" ||
    source === "cli"
  ) {
    return source === "cli" ? "cli-chat" : source;
  }
  return "agent-task";
}

function normalizeCreativeGenerationSource(source: PlanRunSource | undefined) {
  if (source === "web-chat" || source === "slack-chat" || source === "agent-task" || source === "cli") {
    return source === "cli" ? "cli-chat" : source;
  }
  return "agent-task";
}

function mergeReferenceImagePaths(
  args: Record<string, unknown>,
  paths: string[]
): Record<string, unknown> {
  if (paths.length === 0) return args;
  if (Array.isArray(args.localMediaPaths) && args.localMediaPaths.length > 0) return args;
  const existing = Array.isArray(args.referenceImagePaths)
    ? args.referenceImagePaths.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  return {
    ...args,
    referenceImagePaths: [...new Set([...existing, ...paths])],
    generateImage: args.generateImage === false ? false : true,
  };
}

function toolSignature(tool: AgentToolResult): string | null {
  if (tool.status !== "ready") return null;
  try {
    return `${tool.tool}:${JSON.stringify(tool.toolArgs)}`;
  } catch {
    return tool.tool;
  }
}

async function selectDefaultAccount(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const key = readStringArg(opts.tool.toolArgs, "key");
  const adAccountId = readStringArg(opts.tool.toolArgs, "adAccountId", "ad_account_id");
  if (!key && !adAccountId) {
    return {
      display: opts.tool.display,
      status: "unsupported",
      message: "選択する広告アカウントが指定されていません。",
    };
  }
  const account = await opts.prisma.adAccount.findFirst({
    where: {
      workspaceId: opts.workspaceId,
      active: true,
      ...(key ? { key } : { id: adAccountId ?? "" }),
    },
    select: { id: true, key: true, displayName: true, metaAccountId: true },
  });
  if (!account) {
    return {
      display: opts.tool.display,
      status: "error",
      message: "指定された広告アカウントが見つかりません。",
    };
  }
  await opts.prisma.workspace.update({
    where: { id: opts.workspaceId },
    data: { defaultAdAccountId: account.id },
  });
  return {
    display: opts.tool.display,
    status: "ok",
    message: `${account.displayName} をデフォルト広告アカウントにしました。`,
    data: { account },
  };
}

function connectServiceResult(
  args: Record<string, unknown>,
  display: string,
  webUrl: string
): { display: string; status: string; message: string; data?: unknown } {
  const service = typeof args.service === "string" ? args.service : "";
  const path =
    service === "meta"
      ? "/accounts"
      : service === "github"
        ? "/github"
        : service === "ai"
          ? "/ai"
          : "/setup";
  return {
    display,
    status: "ok",
    message: `${service || "service"} の接続画面を開いてください: ${webUrl}${path}`,
    data: { url: `${webUrl}${path}` },
  };
}

async function createScheduledAgentTask(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
  actor?: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const prompt = readRequiredString(opts.tool.toolArgs.prompt, "prompt");
  const cron = readRequiredString(opts.tool.toolArgs.cron, "cron");
  const title = readStringArg(opts.tool.toolArgs, "title") ?? deriveAgentTaskTitle(prompt);
  const validation = validateCronExpression(cron);
  if (!validation.ok) throw new Error(`cron 式が不正です: ${validation.reason}`);
  const runNow = opts.tool.toolArgs.runNow === true;
  const normalizedPrompt = normalizeAgentTaskPrompt(prompt);
  const { task, created } = await createOrReuseAgentTask(opts.prisma as never, {
    workspaceId: opts.workspaceId,
    title,
    prompt: normalizedPrompt,
    cron,
    nextRunAt: runNow ? new Date() : computeNextRunAt(cron),
    createdBy: opts.actor ?? "agent:scheduled-task",
  });
  const scheduled = await scheduleAgentTaskNextRun({
    prisma: opts.prisma,
    boss: opts.boss,
    workspaceId: opts.workspaceId,
    taskId: task.id,
  });
  const queued = runNow
    ? await enqueueAgentTaskNow({
        boss: opts.boss,
        taskId: task.id,
        requestedBy: opts.actor ?? "agent:scheduled-task",
      })
    : null;
  return {
    display: opts.tool.display,
    status: "ok",
    message: created
      ? `Agent task を設定しました。次回実行: ${(scheduled?.nextRunAt ?? task.nextRunAt)?.toISOString() ?? "未定"}`
      : `同じ Agent task が既にあるため再利用しました。次回実行: ${(scheduled?.nextRunAt ?? task.nextRunAt)?.toISOString() ?? "未定"}`,
    data: { task, scheduled, queued, created },
  };
}

function deriveAgentTaskTitle(prompt: string): string {
  const first = prompt.replace(/\s+/g, " ").trim();
  return first.length <= 40 ? first : `${first.slice(0, 39)}...`;
}

async function setScheduleEnabled(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const preset = reportPreset(readRequiredString(opts.tool.toolArgs.preset, "preset"));
  const presetDef = CRON_PRESETS.find((item) => item.name === preset);
  const cron = readStringArg(opts.tool.toolArgs, "cron") ?? presetDef?.cron ?? "";
  const enabled = opts.tool.toolArgs.enabled === true;
  const validation = validateCronExpression(cron);
  if (!validation.ok) throw new Error(`cron 式が不正です: ${validation.reason}`);
  if (enabled) {
    await scheduleCron(opts.boss as never, preset, cron);
  } else {
    await (opts.boss as unknown as { unschedule(name: string): Promise<void> })
      .unschedule(preset)
      .catch(() => undefined);
  }
  const row = await opts.prisma.cronSchedule.upsert({
    where: { workspaceId_name: { workspaceId: opts.workspaceId, name: preset } },
    update: { cron, enabled, nextRunAt: null },
    create: { workspaceId: opts.workspaceId, name: preset, cron, enabled },
    select: { name: true, cron: true, enabled: true },
  });
  return {
    display: opts.tool.display,
    status: "ok",
    message: `${preset} を ${enabled ? "ON" : "OFF"} にしました。cron=${cron}`,
    data: row,
  };
}

async function configureBudgetGuard(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
  webUrl: string;
  actor?: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const saved = await saveBudgetGuardPolicyConfig({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    input: normalizeBudgetGuardConfigInput(opts.tool.toolArgs),
    actor: opts.actor ?? "agent:scheduled-task",
    env: process.env,
  });
  const scheduleResult = await setScheduleEnabled({
    tool: {
      ...opts.tool,
      toolArgs: {
        preset: "budget",
        cron: readStringArg(opts.tool.toolArgs, "cron") ?? undefined,
        enabled: typeof opts.tool.toolArgs.enabled === "boolean" ? opts.tool.toolArgs.enabled : false,
      },
    },
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    boss: opts.boss,
  });
  return {
    display: opts.tool.display,
    status: scheduleResult.status === "ok" ? "ok" : "error",
    message:
      `予算チェックを保存しました。${scheduleResult.message} 確認: ${opts.webUrl}/budget`,
    data: { saved, schedule: scheduleResult.data },
  };
}

async function configureSubmissionGuards(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  webUrl: string;
  actor?: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const saved = await saveSubmissionGuardPolicyConfig({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    input: normalizeSubmissionGuardConfigInput(opts.tool.toolArgs),
    actor: opts.actor ?? "agent:scheduled-task",
    env: process.env,
  });
  const budget = saved.policy.guards.budgetIncrease;
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor ?? "agent:scheduled-task",
      action: "submission_guards.policy_saved_via_chat",
      target: "submission_guards_policy",
      ref: "workflows/guards.yaml",
      metadata: {
        warnOverRatio: budget.warnOverRatio,
        blockOverRatio: budget.blockOverRatio,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);
  return {
    display: opts.tool.display,
    status: "ok",
    message:
      `安全ガードを保存しました。予算変更は ${budget.warnOverRatio}倍以上で警告、` +
      `${budget.blockOverRatio}倍以上でブロックします。確認: ${opts.webUrl}/guards`,
    data: { saved },
  };
}

async function showRecentLogs(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const limit =
    typeof opts.tool.toolArgs.lines === "number"
      ? Math.max(1, Math.min(50, opts.tool.toolArgs.lines))
      : 20;
  const logs = await opts.prisma.executionLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { createdAt: true, kind: true, level: true, message: true },
  });
  return {
    display: opts.tool.display,
    status: "ok",
    message: `${logs.length} 件の execution log を取得しました。`,
    data: { logs },
  };
}

async function manageSchedule(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  boss: PgBoss;
  actor?: string;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  const action =
    typeof opts.tool.toolArgs.action === "string" ? opts.tool.toolArgs.action : "list";
  if (action === "list" || action === "logs") {
    const schedules = await opts.prisma.cronSchedule.findMany({
      where: { workspaceId: opts.workspaceId },
      orderBy: { name: "asc" },
      select: { name: true, cron: true, enabled: true, lastRunState: true },
    });
    return {
      display: opts.tool.display,
      status: "ok",
      message: `${schedules.length} 件の schedule があります。`,
      data: { schedules },
    };
  }
  const preset = reportPreset(
    typeof opts.tool.toolArgs.preset === "string" ? opts.tool.toolArgs.preset : ""
  );
  if (action === "run") {
    const jobId = await opts.boss.send(preset, {
      manual: true,
      requestedBy: opts.actor ?? "agent:scheduled-task",
      requestedAt: new Date().toISOString(),
    });
    return {
      display: opts.tool.display,
      status: "ok",
      message: `${preset} を enqueue しました。`,
      data: { jobId },
    };
  }
  return {
    display: opts.tool.display,
    status: "unsupported",
    message: "scheduled task から schedule の変更は行いません。Web UI の Schedules で変更してください。",
  };
}

async function runSubmissionCheck(opts: {
  tool: Extract<AgentToolResult, { status: "ready" }>;
  prisma: PrismaClient;
  workspaceId: string;
  actor?: string;
  source?: PlanRunSource;
}): Promise<{ display: string; status: string; message: string; data?: unknown }> {
  let rootDir =
    typeof opts.tool.toolArgs.root === "string" && opts.tool.toolArgs.root.trim()
      ? opts.tool.toolArgs.root.trim()
      : "";
  if (!rootDir) {
    const checkout = await ensureOpsRepoLocalCheckout({
      prisma: opts.prisma as never,
      workspaceId: opts.workspaceId,
    }).catch(() => null);
    rootDir =
      checkout?.rootDir ??
      (await resolveOpsRepoLocalDirForWorkspace({
        prisma: opts.prisma as never,
        workspaceId: opts.workspaceId,
      })).rootDir ??
      "";
  }
  const baseDir =
    typeof opts.tool.toolArgs.base === "string" && opts.tool.toolArgs.base.trim()
      ? opts.tool.toolArgs.base.trim()
      : process.env.ADDROID_OPS_REPO_BASE_DIR?.trim() || null;
  if (!rootDir) {
    return {
      display: opts.tool.display,
      status: "error",
      message: "ops repo の local checkout を解決できません。",
    };
  }
  const result = runPlanForRoot({
    rootDir,
    baseDir,
    accountFilter:
      typeof opts.tool.toolArgs.account === "string" ? opts.tool.toolArgs.account : null,
  });
  const recorded = await persistPlanRun({
    store: createPrismaPlanStore(opts.prisma),
    workspaceId: opts.workspaceId,
    source: opts.source ?? "agent-task",
    triggeredBy: opts.actor ?? "agent:scheduled-task",
    rootDir,
    baseDir,
    accountFilter:
      typeof opts.tool.toolArgs.account === "string" ? opts.tool.toolArgs.account : null,
    result,
  }).catch(() => null);
  return {
    display: opts.tool.display,
    status: result.ok ? "ok" : "error",
    message: result.ok ? "dry-run は OK です。" : "dry-run で問題があります。",
    data: { executionLogId: recorded?.id ?? null, result },
  };
}

function readStringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} が指定されていません。`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRequiredPrNumber(args: Record<string, unknown>): number {
  const raw = args.prNumber ?? args.pr_number ?? args.number;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error("prNumber が指定されていません。");
  return n;
}

function normalizeApprovalDecision(args: Record<string, unknown>): ApprovalDecisionAction {
  const raw =
    readStringArg(args, "decision") ??
    readStringArg(args, "action") ??
    readStringArg(args, "intent");
  const normalized = raw?.toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "approve" ||
    normalized === "approved" ||
    normalized === "承認"
  ) {
    return "approve";
  }
  if (
    normalized === "reject" ||
    normalized === "rejected" ||
    normalized === "deny" ||
    normalized === "否決" ||
    normalized === "却下"
  ) {
    return "reject";
  }
  throw new Error("decision は approve または reject を指定してください。");
}

function normalizeMergeMethod(
  args: Record<string, unknown>
): "merge" | "squash" | "rebase" | undefined {
  const raw = readStringArg(args, "mergeMethod", "merge_method");
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "merge" || normalized === "squash" || normalized === "rebase") {
    return normalized;
  }
  throw new Error("mergeMethod は merge / squash / rebase のいずれかです。");
}

function normalizeBudgetGuardConfigInput(
  args: Record<string, unknown>
): BudgetGuardPolicyConfigInput {
  return {
    accountKey: readStringArg(args, "accountKey", "account_key"),
    dailyBudget: readNumberArg(args.dailyBudget, "dailyBudget"),
    monthlyBudget: readNumberArg(args.monthlyBudget, "monthlyBudget"),
    currency: readStringArg(args, "currency"),
    dailyBudgetAlertRatio: readOptionalNumberArg(args.dailyBudgetAlertRatio),
    monthlyPaceRatio: readOptionalNumberArg(args.monthlyPaceRatio),
    dayOverDayRatio: readOptionalNumberArg(args.dayOverDayRatio),
    noConversionsSpendMin: readOptionalNumberArg(args.noConversionsSpendMin),
    autoPauseEnabled:
      typeof args.autoPauseEnabled === "boolean" ? args.autoPauseEnabled : null,
    autoPauseMinDailyBudgetRatio: readOptionalNumberArg(
      args.autoPauseMinDailyBudgetRatio
    ),
    autoPauseMinDayOverDayRatio: readOptionalNumberArg(
      args.autoPauseMinDayOverDayRatio
    ),
    safeCategories:
      Array.isArray(args.safeCategories) || typeof args.safeCategories === "string"
        ? (args.safeCategories as string[] | string)
        : null,
  };
}

function normalizeSubmissionGuardConfigInput(
  args: Record<string, unknown>
): SubmissionGuardPolicyConfigInput {
  const budgetIncrease = isRecord(args.budgetIncrease) ? args.budgetIncrease : {};
  return {
    warnOverRatio: readRequiredInlineNumber(
      args.warnOverRatio ??
        args.warn_over_ratio ??
        budgetIncrease.warnOverRatio ??
        budgetIncrease.warn_over_ratio,
      "warnOverRatio"
    ),
    blockOverRatio: readRequiredInlineNumber(
      args.blockOverRatio ??
        args.block_over_ratio ??
        budgetIncrease.blockOverRatio ??
        budgetIncrease.block_over_ratio,
      "blockOverRatio"
    ),
  };
}

function readRequiredInlineNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} が指定されていません。`);
  return n;
}

function readNumberArg(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} は数値で指定してください。`);
  return n;
}

function readOptionalNumberArg(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOpsProposalInput(args: Record<string, unknown>): OpsChangeProposalInput {
  const intentRaw = readStringArg(args, "intent")?.toLowerCase().replace(/-/g, "_");
  const intent: OpsChangeProposalInput["intent"] =
    intentRaw === "activate" ||
    intentRaw === "status_change" ||
    intentRaw === "budget_change" ||
    intentRaw === "other"
      ? intentRaw
      : "pause";
  const targets: NonNullable<OpsChangeProposalInput["targets"]> = Array.isArray(args.targets)
    ? args.targets.flatMap((item) => {
        if (!isRecord(item)) return [];
        const level = typeof item.level === "string" ? item.level : "";
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
        if (!id || (level !== "campaign" && level !== "adset" && level !== "ad")) return [];
        return [{ level, id }];
      })
    : [];
  const targetIds = Array.isArray(args.targetIds)
    ? args.targetIds.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
    : [];
  const desiredChanges = isRecord(args.desiredChanges) ? args.desiredChanges : undefined;
  const urgencyRaw = readStringArg(args, "urgency");
  const urgency =
    urgencyRaw === "low" || urgencyRaw === "high" || urgencyRaw === "normal"
      ? urgencyRaw
      : undefined;
  const accountKey = readStringArg(args, "accountKey", "account_key");
  const rationale = readStringArg(args, "rationale");
  const operations = normalizeOpsOperations(args.operations);
  return {
    intent,
    ...(accountKey ? { accountKey } : {}),
    ...(targets.length > 0 ? { targets } : {}),
    ...(targetIds.length > 0 ? { targetIds } : {}),
    ...(desiredChanges ? { desiredChanges } : {}),
    ...(rationale ? { rationale } : {}),
    ...(urgency ? { urgency } : {}),
    ...(operations.length > 0 ? { operations } : {}),
  };
}

function normalizeOpsOperations(value: unknown): NonNullable<OpsChangeProposalInput["operations"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const resource = readOptionalString(item.resource);
    const verb = readOptionalString(item.verb);
    if (!resource || !verb) return [];
    const args = readStringList(item.args);
    if (args.length === 0) return [];
    const entity = normalizeOpsOperationEntity(item.entity);
    return [{
      resource,
      verb,
      args,
      ...(entity ? { entity } : {}),
      ...(typeof item.externalIdRequired === "boolean"
        ? { externalIdRequired: item.externalIdRequired }
        : typeof item.external_id_required === "boolean"
          ? { externalIdRequired: item.external_id_required }
          : {}),
    }];
  });
}

function normalizeOpsOperationEntity(value: unknown): NonNullable<NonNullable<OpsChangeProposalInput["operations"]>[number]["entity"]> | null {
  if (!isRecord(value)) return null;
  const nodeType = readOptionalString(value.nodeType) ?? readOptionalString(value.node_type);
  const nodeKey = readOptionalString(value.nodeKey) ?? readOptionalString(value.node_key);
  const displayName = readOptionalString(value.displayName) ?? readOptionalString(value.display_name);
  const parentNodeType = readOptionalString(value.parentNodeType) ?? readOptionalString(value.parent_node_type);
  const parentNodeKey = readOptionalString(value.parentNodeKey) ?? readOptionalString(value.parent_node_key);
  const status = readOptionalString(value.status);
  const entity = {
    ...(nodeType ? { nodeType } : {}),
    ...(nodeKey ? { nodeKey } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parentNodeType ? { parentNodeType } : {}),
    ...(parentNodeKey ? { parentNodeKey } : {}),
    ...(status ? { status } : {}),
  };
  return Object.keys(entity).length > 0 ? entity : null;
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = readOptionalString(item);
        return text ? [text] : [];
      })
    : [];
}

function normalizeAutomationRuleProposalInput(
  args: Record<string, unknown>
): AutomationRuleProposalInput {
  const sourceText = readStringArg(args, "sourceText", "source_text", "prompt");
  const rule = isRecord(args.rule) ? args.rule : undefined;
  const rationale = readStringArg(args, "rationale");
  const title = readStringArg(args, "title");
  return {
    ...(sourceText ? { sourceText } : {}),
    ...(rule ? { rule } : {}),
    ...(rationale ? { rationale } : {}),
    ...(title ? { title } : {}),
  };
}

function resolveMetricDateArg(args: Record<string, unknown>): string | null {
  const explicit = readStringArg(args, "metricDate", "metric_date");
  if (explicit) return explicit;
  const relative = readStringArg(args, "metricDateRelative", "metric_date_relative");
  if (!relative) return null;
  const normalized = relative.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "today") return dateStringInRuntimeTimeZone(0);
  if (normalized === "yesterday") return dateStringInRuntimeTimeZone(-1);
  throw new Error("metricDateRelative は today / yesterday のいずれかで指定してください");
}

function dateStringInRuntimeTimeZone(offsetDays: number): string {
  const timeZone =
    process.env.ADDROID_USER_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")?.value ?? "1970");
  const m = Number(parts.find((p) => p.type === "month")?.value ?? "01");
  const d = Number(parts.find((p) => p.type === "day")?.value ?? "01");
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

async function waitForCronRun(
  prisma: PrismaClient,
  jobId: string,
  name: string,
  timeoutMs: number
): Promise<{
  id: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: Prisma.JsonValue;
} | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.cronRun.findFirst({
      where: { jobId, name },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        state: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        errorMessage: true,
        output: true,
      },
    });
    if (run && run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

async function loadImprovementAuditsForCronRun(
  prisma: PrismaClient,
  workspaceId: string,
  cronRunId: string
): Promise<Array<{ action: string; ref: string | null; metadata: unknown }>> {
  const rows = await prisma.auditLog.findMany({
    where: {
      workspaceId,
      action: { startsWith: "improvement_pr." },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { action: true, ref: true, metadata: true },
  });
  return rows.filter((row) => {
    const metadata = row.metadata;
    return (
      typeof metadata === "object" &&
      metadata !== null &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).cronRunId === cronRunId
    );
  });
}

function reportPreset(value: string): CronPresetName {
  const v = value.trim().toLowerCase().replace(/-/g, "_");
  const name =
    v === "daily" || v === "report" || v === "daily_report"
      ? "daily_report"
      : v === "today" || v === "current" || v === "today_report"
        ? "today_report"
        : v === "budget" || v === "budget_guard"
          ? "budget_guard"
          : v === "rebalance" || v === "budget_rebalance" || v === "予算再配分"
            ? "budget_rebalance"
        : v === "improvement" || v === "improvements" || v === "improvement_pr"
          ? "improvement_pr"
          : v === "creative" ||
              v === "creatives" ||
              v === "creative_generation" ||
              v === "auto_creative" ||
              v === "auto_creative_generation" ||
              v === "自動クリエイティブ生成"
            ? "auto_creative_generation"
          : v === "github" || v === "github_poll"
            ? "github_poll"
            : v === "retention" || v === "retention_sweep"
              ? "retention_sweep"
              : "";
  if (CRON_PRESETS.some((p) => p.name === name)) return name as CronPresetName;
  return "daily_report";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
