// AdDroid OSS — apps/worker budget_guard wiring (Regression fix).
//
// `runBudgetGuardOnce` (queue) が要求する 2 境界 (snapshot store / audit
// runner) を、Prisma + LLMProvider で組み立てる。budget_guard は AI 観点で
// 「auto_pause / alert 候補が dangerous でないか」を audit agent に判定させ、
// その ai_run を `prisma.aiRun.create` で永続化する。
//
// 設計原則:
//   - llm-provider への直接依存を queue から切り離すため、本 wiring 層で
//     `runAuditAgent` を呼び出す。ai_runs 行は AgentRunResult.aiRunInput を
//     そのまま createAiRun に渡す。
//   - audit agent が provider failure / JSON 不正で throw した場合でも、
//     status="failed" の ai_run を返して GitOps state を腐らせない。

import fs from "node:fs";
import { Prisma, type PrismaClient } from "@addroid/db";
import {
  buildAiRunCreateInput,
  runAuditAgent,
  type AiRunCreateInputData,
  type AuditAgentDecision,
  type AuditAgentInput,
  type LLMProvider,
  type MediaBuyerProposal,
} from "@addroid/llm-provider";
import type {
  BudgetGuardAuditInput,
  BudgetGuardAuditOutput,
  BudgetGuardAuditResult,
  BudgetGuardAuditRunner,
  BudgetGuardCandidateAction,
  BudgetGuardPolicy,
  BudgetGuardSpendContext,
  BudgetGuardStore,
  DailyReportAdAccountSnapshot,
} from "@addroid/queue";
import { loadBudgetGuardPolicy as loadBudgetGuardPolicyYaml } from "@addroid/ops-schemas";

// ---------------------------------------------------------------------
// Snapshot store — Prisma 実装 (findAdAccount + createAiRun)
// ---------------------------------------------------------------------

export function createPrismaBudgetGuardStore(
  prisma: PrismaClient
): BudgetGuardStore {
  return {
    async findAdAccount(input): Promise<DailyReportAdAccountSnapshot | null> {
      const row = await prisma.adAccount.findUnique({
        where: {
          workspaceId_key: {
            workspaceId: input.workspaceId,
            key: input.accountKey,
          },
        },
        select: {
          id: true,
          key: true,
          displayName: true,
          metaAccountId: true,
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        displayName: row.displayName,
        metaAccountId: row.metaAccountId,
        // 通貨は ad_accounts に未保存 (daily-report-runtime と同じく "JPY" 既定)。
        currency: "JPY",
      };
    },
    async createAiRun(data: AiRunCreateInputData): Promise<{ id: string }> {
      const created = await prisma.aiRun.create({
        data: {
          workspaceId: data.workspaceId,
          agent: data.agent,
          workflow: data.workflow,
          provider: data.provider,
          model: data.model,
          status: data.status,
          prompt: (data.prompt ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          inputs: (data.inputs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          outputs: (data.outputs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          decision: data.decision,
          confidence: data.confidence,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          requestId: data.requestId,
          linkedRefType: data.linkedRefType,
          linkedRefId: data.linkedRefId,
          errorMessage: data.errorMessage,
          startedAt: data.startedAt,
          finishedAt: data.finishedAt,
        },
        select: { id: true },
      });
      return { id: created.id };
    },
  };
}

// ---------------------------------------------------------------------
// Audit runner — LLMProvider に audit agent を流す
// ---------------------------------------------------------------------

export interface CreateBudgetGuardAuditRunnerOptions {
  provider: LLMProvider;
  workspaceId: string;
  /** 紐付ける cron_run id (audit_log として 1:1 で残るので linkedRefType=cron_run)。 */
  cronRunId?: string | null;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

export function createBudgetGuardAuditRunner(
  opts: CreateBudgetGuardAuditRunnerOptions
): BudgetGuardAuditRunner {
  return {
    async run(input: BudgetGuardAuditInput): Promise<BudgetGuardAuditResult> {
      const proposals = candidateActionsToProposals(input.candidateActions);
      const agentInput: AuditAgentInput = {
        accountId: input.accountId,
        proposals,
        mode: input.mode,
        safeCategories: input.safeCategories,
      };
      const linkedRefId = opts.cronRunId ?? null;
      try {
        const result = await runAuditAgent(
          {
            provider: opts.provider,
            workspaceId: opts.workspaceId,
            workflow: "budget_guard",
            ...(linkedRefId
              ? {
                  linkedRefType: "cron_run" as const,
                  linkedRefId,
                }
              : {}),
            ...(opts.now ? { now: opts.now } : {}),
          },
          agentInput
        );
        const decision = (result.aiRunInput.decision ??
          null) as AuditAgentDecision | null;
        const output: BudgetGuardAuditOutput | null = result.output
          ? {
              classification: result.output.classification,
              dangerousCategories: result.output.dangerousCategories,
              rationale: result.output.rationale,
            }
          : null;
        return {
          aiRunInput: result.aiRunInput,
          output,
          decision: result.error ? null : decision,
          error: result.error,
        };
      } catch (err) {
        // runAuditAgent は通常エラーを catch して `status="failed"` の result を
        // 返すよう設計されているが、provider 自体が同期的に throw した場合は
        // ここに落ちる。fail-closed で ai_runs に書ける形に正規化する。
        const message = err instanceof Error ? err.message : String(err);
        const startedAt = opts.now ? opts.now() : new Date();
        const aiRunInput = buildAiRunCreateInput({
          workspaceId: opts.workspaceId,
          agent: "audit",
          workflow: "budget_guard",
          provider: opts.provider.name,
          model: opts.provider.defaultModel,
          status: "failed",
          inputs: agentInput,
          outputs: null,
          decision: null,
          confidence: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(linkedRefId
            ? {
                linkedRefType: "cron_run" as const,
                linkedRefId,
              }
            : {}),
          errorMessage: message,
          startedAt,
          finishedAt: startedAt,
        });
        return { aiRunInput, output: null, decision: null, error: message };
      }
    },
  };
}

function candidateActionsToProposals(
  candidates: BudgetGuardCandidateAction[]
): MediaBuyerProposal[] {
  // budget_guard の candidate (auto_pause 候補等) を audit agent が受ける
  // MediaBuyerProposal 形に詰め替える。dangerous 分類は audit 側で決まるため、
  // ここでは cosmetic な変換のみ行う。
  return candidates.map((c) => ({
    hierarchy: c.hierarchy,
    target: c.target,
    category: c.category,
    proposedChange: c.description,
    rationale: `budget_guard candidate: ${c.description}`,
  }));
}

// ---------------------------------------------------------------------
// Policy loader (this implementation)
// ---------------------------------------------------------------------

export interface BudgetGuardAccountBudgetEntry {
  dailyBudget: number;
  monthlyBudget: number;
  currency?: string;
  /** account 単位のしきい値上書き。指定したキーだけが共通 alerts に勝つ。 */
  alerts?: BudgetGuardPolicy["alerts"];
}

/**
 * 共通 alerts に account 単位の上書きを重ねる。指定のないキーは共通値のまま。
 * 検知 GAS の「共通設定 → 案件マスタで上書き」と同じ優先順位。
 */
export function resolveBudgetGuardPolicyForAccount(
  policy: BudgetGuardPolicy,
  entry: BudgetGuardAccountBudgetEntry | undefined
): BudgetGuardPolicy {
  if (!entry?.alerts) return policy;
  return { ...policy, alerts: { ...policy.alerts, ...entry.alerts } };
}

export interface LoadedBudgetGuardPolicy {
  policy: BudgetGuardPolicy;
  /** ad_accounts.key → 個別 budget。未指定の account は budget=0 として扱う。 */
  accountBudgets: Record<string, BudgetGuardAccountBudgetEntry>;
}

/**
 * `loadBudgetGuardPolicy` — env から ops repo を解決し、
 * `workflows/budget-guard.yaml` を読み込んで {@link BudgetGuardPolicy} と
 * per-account budgets に変換する。ops repo 自体が未指定 / ファイル無し /
 * 不正なら null を返し、orchestrator は fail-closed (`policy_missing`) で
 * 抜ける。
 */
export function loadBudgetGuardPolicy(
  env: NodeJS.ProcessEnv
): LoadedBudgetGuardPolicy | null {
  const root = env.ADDROID_OPS_REPO_LOCAL_DIR?.trim();
  return loadBudgetGuardPolicyForRoot(root || null);
}

export function loadBudgetGuardPolicyForRoot(
  root: string | null | undefined
): LoadedBudgetGuardPolicy | null {
  if (!root || !fs.existsSync(root)) return null;
  const yaml = loadBudgetGuardPolicyYaml(root);
  if (!yaml) return null;
  const policy: BudgetGuardPolicy = {
    alerts: {
      ...(yaml.alerts.dailyBudgetAlertRatio !== undefined
        ? { dailyBudgetAlertRatio: yaml.alerts.dailyBudgetAlertRatio }
        : {}),
      ...(yaml.alerts.monthlyPaceRatio !== undefined
        ? { monthlyPaceRatio: yaml.alerts.monthlyPaceRatio }
        : {}),
      ...(yaml.alerts.dayOverDayRatio !== undefined
        ? { dayOverDayRatio: yaml.alerts.dayOverDayRatio }
        : {}),
      ...(yaml.alerts.noConversionsSpendMin !== undefined
        ? { noConversionsSpendMin: yaml.alerts.noConversionsSpendMin }
        : {}),
    },
    ...(yaml.autoPause
      ? {
          autoPause: {
            enabled: yaml.autoPause.enabled,
            ...(yaml.autoPause.minDailyBudgetRatio !== undefined
              ? { minDailyBudgetRatio: yaml.autoPause.minDailyBudgetRatio }
              : {}),
            ...(yaml.autoPause.minDayOverDayRatio !== undefined
              ? { minDayOverDayRatio: yaml.autoPause.minDayOverDayRatio }
              : {}),
            safeCategories: yaml.autoPause.safeCategories,
          },
        }
      : {}),
  };
  const accountBudgets: Record<string, BudgetGuardAccountBudgetEntry> = {};
  for (const [key, value] of Object.entries(yaml.accounts)) {
    accountBudgets[key] = {
      dailyBudget: value.dailyBudget,
      monthlyBudget: value.monthlyBudget,
      ...(value.currency ? { currency: value.currency } : {}),
      ...(value.alerts ? { alerts: value.alerts } : {}),
    };
  }
  return { policy, accountBudgets };
}

// ---------------------------------------------------------------------
// Spend context (this implementation)
// ---------------------------------------------------------------------

const MICROS_PER_MAJOR = 1_000_000n;

function microsToMajorNumber(micros: bigint): number {
  // BigInt の精度を保ったまま Number に変換 (daily-report と同じ約束事)。
  const div = Number(micros / MICROS_PER_MAJOR);
  const rem = Number(micros % MICROS_PER_MAJOR) / 1_000_000;
  return div + rem;
}

function utcDate(d: Date): { dayOfMonth: number; daysInMonth: number; today: Date } {
  const today = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const daysInMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return { dayOfMonth: today.getUTCDate(), daysInMonth, today };
}

export interface BuildBudgetGuardSpendContextOptions {
  prisma: PrismaClient;
  accountId: string;
  /** 日次予算 (currency major)。0 = 未設定。 */
  dailyBudget?: number;
  /** 月次予算 (currency major)。0 = 未設定。 */
  monthlyBudget?: number;
  /** 通貨 (UI 用)。 */
  currency?: string;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

/**
 * `buildBudgetGuardSpendContext` — ad_account の `performance_snapshots`
 * (account 階層) から当日 / 前日 / MTD の spend + conversions を集計して
 * spend context を組み立てる。
 *
 * 集計範囲:
 *   - today      = 当日 (UTC)
 *   - yesterday  = 当日 - 1d (UTC)
 *   - MTD        = 月初 (1日) 〜 当日まで (UTC)
 * いずれも `nodeType="account"` 行のみを対象にする (campaign/adset/ad は
 * snapshot として保存されているがここでは集計しない)。
 */
export async function buildBudgetGuardSpendContext(
  opts: BuildBudgetGuardSpendContextOptions
): Promise<BudgetGuardSpendContext> {
  const now = opts.now ? opts.now() : new Date();
  const { dayOfMonth, daysInMonth, today } = utcDate(now);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)
  );

  const todayRows = await opts.prisma.performanceSnapshot.findMany({
    where: {
      accountId: opts.accountId,
      nodeType: "account",
      metricDate: today,
    },
    select: { spendMicros: true, conversions: true },
  });
  const yesterdayRows = await opts.prisma.performanceSnapshot.findMany({
    where: {
      accountId: opts.accountId,
      nodeType: "account",
      metricDate: yesterday,
    },
    select: { spendMicros: true },
  });
  const mtdRows = await opts.prisma.performanceSnapshot.findMany({
    where: {
      accountId: opts.accountId,
      nodeType: "account",
      metricDate: { gte: monthStart, lte: today },
    },
    select: { spendMicros: true },
  });

  let todaySpend = 0;
  let todayConversions = 0;
  for (const r of todayRows) {
    todaySpend += microsToMajorNumber(r.spendMicros);
    todayConversions += r.conversions;
  }
  let yesterdaySpend = 0;
  for (const r of yesterdayRows) {
    yesterdaySpend += microsToMajorNumber(r.spendMicros);
  }
  let monthToDateSpend = 0;
  for (const r of mtdRows) {
    monthToDateSpend += microsToMajorNumber(r.spendMicros);
  }

  return {
    todaySpend,
    yesterdaySpend,
    todayConversions,
    monthToDateSpend,
    dailyBudget: opts.dailyBudget ?? 0,
    monthlyBudget: opts.monthlyBudget ?? 0,
    dayOfMonth,
    daysInMonth,
    ...(opts.currency ? { currency: opts.currency } : {}),
  };
}
