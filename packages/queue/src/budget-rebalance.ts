import type { DailyReportAdAccountSnapshot } from "./daily-report.js";
import type { ExecutionMode } from "./execution-mode.js";
import { microsToMajorUnit } from "./metrics.js";
import { confidenceLabel, type ConfidenceLabel } from "./stats.js";

export type BudgetRebalanceExecutionMode = ExecutionMode;

export interface BudgetRebalancePolicy {
  enabled: boolean;
  lookbackDays: number;
  maxShiftPercentPerRun: number;
  minDailyBudgetMajor: number;
  minConversionsForJudgement: number;
  keepTotalBudget: boolean;
  excludeNodeKeys: string[];
}

export interface RebalanceCandidate {
  nodeKey: string;
  displayName: string;
  currentDailyBudgetMajor: number;
  lookback: {
    spendMajor: number;
    conversions: number;
    cpaMajor: number | null;
    impressions?: number;
    clicks?: number;
  };
  confidence: ConfidenceLabel;
}

export interface RebalanceMove {
  nodeKey: string;
  displayName: string;
  direction: "increase" | "decrease";
  fromMajor: number;
  toMajor: number;
  deltaPercent: number;
  reason: string;
}

export interface RebalanceSkipped {
  nodeKey: string;
  reason: "insufficient_data" | "excluded" | "at_floor" | "no_budget";
}

export interface RebalancePlan {
  moves: RebalanceMove[];
  totalDeltaMajor: number;
  skipped: RebalanceSkipped[];
}

export type BudgetRebalanceRunStatus =
  | "succeeded"
  | "no_account"
  | "policy_missing"
  | "disabled"
  | "no_moves"
  | "pr_failed";

export interface BudgetRebalancePullRequestRequest {
  branchName: string;
  prTitle: string;
  prBody: string;
  files: Array<{
    path: string;
    action: "create" | "update" | "delete";
    diff: string;
  }>;
  baseRef: string;
}

export interface BudgetRebalancePullRequestRecord {
  pullRequestId: string;
  prNumber: number;
  htmlUrl: string;
  headSha: string;
}

export interface BudgetRebalancePublisher {
  createPullRequest(req: BudgetRebalancePullRequestRequest): Promise<BudgetRebalancePullRequestRecord>;
}

export interface BudgetRebalanceAuditInput {
  workspaceId: string;
  accountKey: string;
  accountId: string;
  cronRunId: string | null;
  action: "budget_rebalance.opened" | "budget_rebalance.skipped" | "budget_rebalance.failed";
  pullRequest: BudgetRebalancePullRequestRecord | null;
  classification: "requires_approval" | "dangerous" | null;
  auditDecision: "approval_required" | "auto_blocked" | null;
  dangerousCategories: string[];
  metadata: Record<string, unknown>;
  summary: string;
}

export interface BudgetRebalanceAuditWriter {
  recordBudgetRebalanceAudit(input: BudgetRebalanceAuditInput): Promise<void>;
}

export interface BudgetRebalanceStore {
  findAdAccount(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<DailyReportAdAccountSnapshot | null>;
  listRebalanceCandidates(input: {
    accountId: string;
    since: string;
    until: string;
    excludeNodeKeys: string[];
  }): Promise<RebalanceCandidate[]>;
}

export interface BudgetRebalanceSummary {
  status: BudgetRebalanceRunStatus;
  workspaceId: string;
  accountKey: string;
  accountId: string | null;
  mode: BudgetRebalanceExecutionMode;
  policyEnabled: boolean | null;
  window: { since: string; until: string } | null;
  candidateCount: number;
  plan: RebalancePlan | null;
  pullRequest: BudgetRebalancePullRequestRecord | null;
  classification: "requires_approval" | "dangerous" | null;
  auditDecision: "approval_required" | "auto_blocked" | null;
  dangerousCategories: string[];
  errorMessage?: string;
}

export interface RunBudgetRebalanceOptions {
  workspaceId: string;
  mode: BudgetRebalanceExecutionMode;
  accountKey: string;
  policy: BudgetRebalancePolicy | null;
  store: BudgetRebalanceStore;
  publisher: BudgetRebalancePublisher;
  audit: BudgetRebalanceAuditWriter;
  repo?: string;
  baseRef?: string;
  cronRunId?: string | null;
  now?: () => Date;
}

interface CandidateDelta {
  candidate: RebalanceCandidate;
  direction: "increase" | "decrease";
  rawDeltaMajor: number;
  reason: string;
}

const MICROS_PER_MAJOR = 1_000_000n;

export function computeRebalancePlan(
  candidates: RebalanceCandidate[],
  policy: BudgetRebalancePolicy
): RebalancePlan {
  const skipped: RebalanceSkipped[] = [];
  const excluded = new Set(policy.excludeNodeKeys);
  const eligible: RebalanceCandidate[] = [];
  for (const candidate of candidates) {
    if (excluded.has(candidate.nodeKey)) {
      skipped.push({ nodeKey: candidate.nodeKey, reason: "excluded" });
      continue;
    }
    if (candidate.currentDailyBudgetMajor <= 0) {
      skipped.push({ nodeKey: candidate.nodeKey, reason: "no_budget" });
      continue;
    }
    if (
      candidate.confidence === "insufficient" ||
      candidate.lookback.conversions < policy.minConversionsForJudgement ||
      candidate.lookback.cpaMajor === null
    ) {
      skipped.push({ nodeKey: candidate.nodeKey, reason: "insufficient_data" });
      continue;
    }
    eligible.push(candidate);
  }
  const medianCpa = median(eligible.map((candidate) => candidate.lookback.cpaMajor));
  if (medianCpa === null || medianCpa <= 0) return { moves: [], totalDeltaMajor: 0, skipped };

  const increases: CandidateDelta[] = [];
  const decreases: CandidateDelta[] = [];
  for (const candidate of eligible) {
    const cpa = candidate.lookback.cpaMajor;
    if (cpa === null || cpa <= 0) continue;
    if (cpa <= medianCpa * 0.7) {
      const percent = Math.min(
        policy.maxShiftPercentPerRun,
        ((medianCpa - cpa) / medianCpa) * 100
      );
      increases.push({
        candidate,
        direction: "increase",
        rawDeltaMajor: candidate.currentDailyBudgetMajor * (percent / 100),
        reason: `CPA が中央値より ${formatPercent((medianCpa - cpa) / medianCpa)} 良好`,
      });
    } else if (cpa >= medianCpa * 1.5) {
      const percent = Math.min(
        policy.maxShiftPercentPerRun,
        (cpa / medianCpa - 1) * 100
      );
      const maxDecrease = Math.max(0, candidate.currentDailyBudgetMajor - policy.minDailyBudgetMajor);
      const rawDeltaMajor = Math.min(
        candidate.currentDailyBudgetMajor * (percent / 100),
        maxDecrease
      );
      if (rawDeltaMajor <= 0) {
        skipped.push({ nodeKey: candidate.nodeKey, reason: "at_floor" });
        continue;
      }
      decreases.push({
        candidate,
        direction: "decrease",
        rawDeltaMajor,
        reason: `CPA が中央値より ${formatPercent(cpa / medianCpa - 1)} 悪化`,
      });
    }
  }

  if (policy.keepTotalBudget) {
    const totalIncrease = sumDeltas(increases);
    const totalDecrease = sumDeltas(decreases);
    if (totalIncrease <= 0 || totalDecrease <= 0) {
      return { moves: [], totalDeltaMajor: 0, skipped };
    }
    const targetShift = Math.min(totalIncrease, totalDecrease);
    const moves = [
      ...toMoves(decreases, -(targetShift / totalDecrease), policy),
      ...toMoves(increases, targetShift / totalIncrease, policy),
    ];
    const adjusted = adjustRounding(moves);
    if (adjusted.length < 2) return { moves: [], totalDeltaMajor: 0, skipped };
    return {
      moves: adjusted,
      totalDeltaMajor: round2(sumMoveDeltas(adjusted)),
      skipped,
    };
  }

  const moves = [...toMoves(decreases, -1, policy), ...toMoves(increases, 1, policy)];
  if (moves.length < 2) return { moves: [], totalDeltaMajor: 0, skipped };
  return { moves, totalDeltaMajor: round2(sumMoveDeltas(moves)), skipped };
}

export async function runBudgetRebalanceOnce(
  opts: RunBudgetRebalanceOptions
): Promise<BudgetRebalanceSummary> {
  const account = await opts.store.findAdAccount({
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
  });
  if (!account) {
    return {
      status: "no_account",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: null,
      mode: opts.mode,
      policyEnabled: opts.policy?.enabled ?? null,
      window: null,
      candidateCount: 0,
      plan: null,
      pullRequest: null,
      classification: null,
      auditDecision: null,
      dangerousCategories: [],
      errorMessage: `ad_account '${opts.accountKey}' not found in workspace`,
    };
  }
  if (!opts.policy) {
    return await skippedSummary(opts, account, "policy_missing", "budget_rebalance policy missing");
  }
  if (!opts.policy.enabled) {
    return await skippedSummary(opts, account, "disabled", "budget_rebalance policy disabled");
  }
  const window = resolveLookbackWindow(opts.policy.lookbackDays, opts.now?.() ?? new Date());
  const candidates = await opts.store.listRebalanceCandidates({
    accountId: account.id,
    since: window.since,
    until: window.until,
    excludeNodeKeys: opts.policy.excludeNodeKeys,
  });
  const plan = computeRebalancePlan(candidates, opts.policy);
  if (plan.moves.length === 0) {
    return await skippedSummary(opts, account, "no_moves", "budget_rebalance found no actionable moves", {
      window,
      candidateCount: candidates.length,
      plan,
    });
  }

  const filePath = `operations/${opts.accountKey}/${timestampForPath(opts.now?.() ?? new Date())}-budget_rebalance.json`;
  const pullRequestRequest = buildBudgetRebalancePullRequest({
    account,
    accountKey: opts.accountKey,
    baseRef: opts.baseRef ?? "main",
    filePath,
    plan,
    repo: opts.repo ?? "",
  });

  try {
    const pullRequest = await opts.publisher.createPullRequest(pullRequestRequest);
    const summary: BudgetRebalanceSummary = {
      status: "succeeded",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      mode: opts.mode,
      policyEnabled: true,
      window,
      candidateCount: candidates.length,
      plan,
      pullRequest,
      classification: "requires_approval",
      auditDecision: "approval_required",
      dangerousCategories: ["budget_increase"],
    };
    await opts.audit.recordBudgetRebalanceAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId: opts.cronRunId ?? null,
      action: "budget_rebalance.opened",
      pullRequest,
      classification: summary.classification,
      auditDecision: summary.auditDecision,
      dangerousCategories: summary.dangerousCategories,
      metadata: budgetRebalanceSummaryToMetadata(summary),
      summary: `budget_rebalance opened PR #${pullRequest.prNumber} with ${plan.moves.length} moves`,
    });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await opts.audit.recordBudgetRebalanceAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId: opts.cronRunId ?? null,
      action: "budget_rebalance.failed",
      pullRequest: null,
      classification: null,
      auditDecision: null,
      dangerousCategories: ["budget_increase"],
      metadata: { window, plan, candidateCount: candidates.length, errorMessage: message },
      summary: `budget_rebalance PR failed: ${message}`,
    });
    return {
      status: "pr_failed",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      mode: opts.mode,
      policyEnabled: true,
      window,
      candidateCount: candidates.length,
      plan,
      pullRequest: null,
      classification: null,
      auditDecision: null,
      dangerousCategories: ["budget_increase"],
      errorMessage: message,
    };
  }
}

export function buildBudgetRebalancePullRequest(input: {
  account: DailyReportAdAccountSnapshot;
  accountKey: string;
  repo: string;
  baseRef: string;
  filePath: string;
  plan: RebalancePlan;
}): BudgetRebalancePullRequestRequest {
  const manifest = {
    version: 2,
    accountKey: input.accountKey,
    intent: "budget_change",
    source: "budget_rebalance",
    actor: "addroid",
    rationale: "CPA efficiency based budget rebalance proposal",
    createdAt: new Date().toISOString(),
    actions: input.plan.moves.map((move) => ({
      kind: "adset.update",
      payload: {
        adsetId: move.nodeKey,
        dailyBudget: move.toMajor,
      },
      entity: {
        nodeType: "adset",
        nodeKey: move.nodeKey,
        displayName: move.displayName,
      },
    })),
  };
  const body = budgetRebalancePrBody(input.account, input.plan, input.repo);
  return {
    branchName: `addroid/budget-rebalance-${input.accountKey}-${Date.now().toString(36)}`,
    prTitle: `Budget rebalance proposal (${input.accountKey})`,
    prBody: body,
    files: [
      {
        path: input.filePath,
        action: "create",
        diff: fullFileDiff(input.filePath, `${JSON.stringify(manifest, null, 2)}\n`),
      },
    ],
    baseRef: input.baseRef,
  };
}

export function rebalanceCandidateFromSnapshot(input: {
  nodeKey: string;
  displayName: string;
  currentDailyBudgetMajor: number;
  spendMicros: bigint;
  impressions: number;
  clicks: number;
  conversions: number;
}): RebalanceCandidate {
  const spendMajor = microsToMajorUnit(input.spendMicros);
  return {
    nodeKey: input.nodeKey,
    displayName: input.displayName,
    currentDailyBudgetMajor: input.currentDailyBudgetMajor,
    lookback: {
      spendMajor,
      conversions: input.conversions,
      cpaMajor: input.conversions > 0 ? spendMajor / input.conversions : null,
      impressions: input.impressions,
      clicks: input.clicks,
    },
    confidence: confidenceLabel(input.conversions, input.impressions),
  };
}

function toMoves(
  deltas: CandidateDelta[],
  scale: number,
  policy: BudgetRebalancePolicy
): RebalanceMove[] {
  return deltas.flatMap((delta) => {
    const signedDelta = round2(delta.rawDeltaMajor * scale);
    if (signedDelta === 0) return [];
    const from = round2(delta.candidate.currentDailyBudgetMajor);
    const to = round2(
      Math.max(policy.minDailyBudgetMajor, delta.candidate.currentDailyBudgetMajor + signedDelta)
    );
    if (from === to) return [];
    return [
      {
        nodeKey: delta.candidate.nodeKey,
        displayName: delta.candidate.displayName,
        direction: to > from ? "increase" : "decrease",
        fromMajor: from,
        toMajor: to,
        deltaPercent: round2(((to - from) / from) * 100),
        reason: delta.reason,
      },
    ];
  });
}

function adjustRounding(moves: RebalanceMove[]): RebalanceMove[] {
  const total = round2(sumMoveDeltas(moves));
  if (total === 0) return moves;
  const adjustable = moves.find((move) => move.direction === "increase") ?? moves[0];
  if (!adjustable) return moves;
  adjustable.toMajor = round2(adjustable.toMajor - total);
  adjustable.deltaPercent = round2(((adjustable.toMajor - adjustable.fromMajor) / adjustable.fromMajor) * 100);
  return moves.filter((move) => move.toMajor > 0 && move.toMajor !== move.fromMajor);
}

function skippedSummary(
  opts: RunBudgetRebalanceOptions,
  account: DailyReportAdAccountSnapshot,
  status: "policy_missing" | "disabled" | "no_moves",
  message: string,
  extras: {
    window?: { since: string; until: string };
    candidateCount?: number;
    plan?: RebalancePlan;
  } = {}
): Promise<BudgetRebalanceSummary> {
  const summary: BudgetRebalanceSummary = {
    status,
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
    accountId: account.id,
    mode: opts.mode,
    policyEnabled: opts.policy?.enabled ?? null,
    window: extras.window ?? null,
    candidateCount: extras.candidateCount ?? 0,
    plan: extras.plan ?? null,
    pullRequest: null,
    classification: null,
    auditDecision: null,
    dangerousCategories: [],
    errorMessage: message,
  };
  return opts.audit
    .recordBudgetRebalanceAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId: opts.cronRunId ?? null,
      action: "budget_rebalance.skipped",
      pullRequest: null,
      classification: null,
      auditDecision: null,
      dangerousCategories: [],
      metadata: budgetRebalanceSummaryToMetadata(summary),
      summary: message,
    })
    .then(() => summary);
}

function budgetRebalancePrBody(
  account: DailyReportAdAccountSnapshot,
  plan: RebalancePlan,
  repo: string
): string {
  const moveRows = plan.moves
    .map(
      (move) =>
        `| ${move.displayName} | ${move.direction} | ${move.fromMajor} -> ${move.toMajor} | ${move.deltaPercent}% | ${move.reason} |`
    )
    .join("\n");
  const skippedRows = plan.skipped.length
    ? plan.skipped.map((item) => `| ${item.nodeKey} | ${item.reason} |`).join("\n")
    : "| - | - |";
  return [
    "## Summary",
    "",
    `Budget rebalance proposal for ${account.displayName} (${account.key}).`,
    repo ? `Repository: ${repo}` : "",
    "",
    "This PR only writes an operation manifest. Meta budgets change only after human PR merge and the normal apply path.",
    "",
    "## Moves",
    "",
    "| Ad set | Direction | Daily budget | Delta | Reason |",
    "| --- | --- | ---: | ---: | --- |",
    moveRows,
    "",
    "## Skipped",
    "",
    "| Node | Reason |",
    "| --- | --- |",
    skippedRows,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function budgetRebalanceSummaryToMetadata(summary: BudgetRebalanceSummary): Record<string, unknown> {
  return {
    status: summary.status,
    mode: summary.mode,
    policyEnabled: summary.policyEnabled,
    window: summary.window,
    candidateCount: summary.candidateCount,
    plan: summary.plan,
    classification: summary.classification,
    auditDecision: summary.auditDecision,
    dangerousCategories: summary.dangerousCategories,
    ...(summary.pullRequest ? { pullRequest: summary.pullRequest } : {}),
    ...(summary.errorMessage ? { errorMessage: summary.errorMessage } : {}),
  };
}

function resolveLookbackWindow(days: number, now: Date): { since: string; until: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const until = new Date(today.getTime() - 86_400_000);
  const since = new Date(until.getTime() - (days - 1) * 86_400_000);
  return { since: dateString(since), until: dateString(until) };
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function median(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid]!;
  return (clean[mid - 1]! + clean[mid]!) / 2;
}

function sumDeltas(deltas: CandidateDelta[]): number {
  return deltas.reduce((sum, delta) => sum + delta.rawDeltaMajor, 0);
}

function sumMoveDeltas(moves: RebalanceMove[]): number {
  return moves.reduce((sum, move) => sum + (move.toMajor - move.fromMajor), 0);
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function formatPercent(value: number): string {
  return `${round2(value * 100)}%`;
}

function fullFileDiff(relPath: string, content: string): string {
  const body = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [`--- /dev/null`, `+++ b/${relPath}`, `@@`, body].join("\n");
}
