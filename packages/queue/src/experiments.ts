import { compareProportions, wilsonInterval } from "./stats.js";
import type { ExecutionMode } from "./execution-mode.js";

export type ExperimentMetric = "ctr" | "cvr";

export interface ExperimentVerdict {
  outcome:
    | "a_wins"
    | "b_wins"
    | "no_significant_difference"
    | "insufficient_data"
    | "expired_inconclusive";
  metric: ExperimentMetric;
  a: { impressions: number; successes: number; rate: number | null };
  b: { impressions: number; successes: number; rate: number | null };
  pApprox: number | null;
  decidedAt: string;
}

export interface ExperimentRecord {
  id: string;
  workspaceId: string;
  accountId: string;
  accountKey: string;
  name: string;
  hypothesis: string | null;
  metric: ExperimentMetric;
  adsetNodeKey: string;
  variantAKey: string;
  variantBKey: string;
  startDate: string;
  minImpressionsPerVariant: number;
  maxDurationDays: number;
  createdBy: string;
}

export interface ExperimentVariantStats {
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface ExperimentVariantState {
  variantAActive: boolean;
  variantBActive: boolean;
  reason?: string;
}

export interface ExperimentPullRequestRequest {
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

export interface ExperimentPullRequestRecord {
  pullRequestId: string;
  prNumber: number;
  htmlUrl: string;
  headSha: string;
}

export interface ExperimentPublisher {
  createPullRequest(req: ExperimentPullRequestRequest): Promise<ExperimentPullRequestRecord>;
}

export interface ExperimentEvaluateStore {
  listRunningExperiments(): Promise<ExperimentRecord[]>;
  loadVariantStats(input: {
    accountId: string;
    variantAKey: string;
    variantBKey: string;
    since: string;
    until: string;
  }): Promise<{ a: ExperimentVariantStats; b: ExperimentVariantStats }>;
  loadVariantState(input: {
    accountId: string;
    variantAKey: string;
    variantBKey: string;
  }): Promise<ExperimentVariantState>;
  concludeExperiment(input: {
    experimentId: string;
    status: "concluded" | "inconclusive";
    conclusion: ExperimentVerdict;
    pullRequest?: ExperimentPullRequestRecord | null;
  }): Promise<void>;
  cancelExperiment(input: {
    experimentId: string;
    conclusion: Record<string, unknown>;
  }): Promise<void>;
}

export type ExperimentEvaluateItemStatus =
  | "continued"
  | "concluded"
  | "inconclusive"
  | "cancelled"
  | "pr_failed";

export interface ExperimentEvaluateItemSummary {
  experimentId: string;
  name: string;
  accountKey: string;
  status: ExperimentEvaluateItemStatus;
  verdict: ExperimentVerdict | null;
  pullRequest: ExperimentPullRequestRecord | null;
  errorMessage?: string;
}

export interface ExperimentEvaluateSummary {
  status: "succeeded" | "partial_failure";
  evaluated: number;
  continued: number;
  concluded: number;
  inconclusive: number;
  cancelled: number;
  prFailed: number;
  items: ExperimentEvaluateItemSummary[];
}

export interface RunExperimentEvaluateOptions {
  mode: ExecutionMode;
  store: ExperimentEvaluateStore;
  publisher: ExperimentPublisher;
  repo?: string;
  baseRef?: string;
  now?: () => Date;
}

export function judgeExperiment(opts: {
  metric: ExperimentMetric;
  a: ExperimentVariantStats;
  b: ExperimentVariantStats;
  minImpressionsPerVariant: number;
  elapsedDays: number;
  maxDurationDays: number;
  now?: Date;
}): ExperimentVerdict {
  const aSuccesses = successesForMetric(opts.metric, opts.a);
  const bSuccesses = successesForMetric(opts.metric, opts.b);
  const aImpressions = cleanCount(opts.a.impressions);
  const bImpressions = cleanCount(opts.b.impressions);
  const enoughImpressions =
    aImpressions >= opts.minImpressionsPerVariant &&
    bImpressions >= opts.minImpressionsPerVariant;
  const expired = opts.elapsedDays >= opts.maxDurationDays;
  const base = {
    metric: opts.metric,
    a: {
      impressions: aImpressions,
      successes: aSuccesses,
      rate: rate(aSuccesses, aImpressions),
    },
    b: {
      impressions: bImpressions,
      successes: bSuccesses,
      rate: rate(bSuccesses, bImpressions),
    },
    decidedAt: (opts.now ?? new Date()).toISOString(),
  };

  if (!enoughImpressions) {
    return {
      ...base,
      outcome: expired ? "expired_inconclusive" : "insufficient_data",
      pApprox: null,
    };
  }

  const comparison = compareProportions(
    { successes: aSuccesses, trials: aImpressions },
    { successes: bSuccesses, trials: bImpressions },
    { minTrials: opts.minImpressionsPerVariant }
  );
  if (comparison.verdict === "significant_increase") {
    return { ...base, outcome: "b_wins", pApprox: comparison.pApprox };
  }
  if (comparison.verdict === "significant_decrease") {
    return { ...base, outcome: "a_wins", pApprox: comparison.pApprox };
  }
  return {
    ...base,
    outcome: expired ? "no_significant_difference" : "insufficient_data",
    pApprox: comparison.pApprox,
  };
}

export async function runExperimentEvaluateOnce(
  opts: RunExperimentEvaluateOptions
): Promise<ExperimentEvaluateSummary> {
  const now = opts.now?.() ?? new Date();
  const today = dateString(now);
  const experiments = await opts.store.listRunningExperiments();
  const items: ExperimentEvaluateItemSummary[] = [];
  for (const experiment of experiments) {
    const state = await opts.store.loadVariantState({
      accountId: experiment.accountId,
      variantAKey: experiment.variantAKey,
      variantBKey: experiment.variantBKey,
    });
    if (!state.variantAActive || !state.variantBActive) {
      const conclusion = {
        outcome: "cancelled",
        reason: state.reason ?? "variant_not_active",
        decidedAt: now.toISOString(),
      };
      await opts.store.cancelExperiment({
        experimentId: experiment.id,
        conclusion,
      });
      items.push({
        experimentId: experiment.id,
        name: experiment.name,
        accountKey: experiment.accountKey,
        status: "cancelled",
        verdict: null,
        pullRequest: null,
      });
      continue;
    }

    const stats = await opts.store.loadVariantStats({
      accountId: experiment.accountId,
      variantAKey: experiment.variantAKey,
      variantBKey: experiment.variantBKey,
      since: experiment.startDate,
      until: today,
    });
    const verdict = judgeExperiment({
      metric: experiment.metric,
      a: stats.a,
      b: stats.b,
      minImpressionsPerVariant: experiment.minImpressionsPerVariant,
      elapsedDays: elapsedDays(experiment.startDate, now),
      maxDurationDays: experiment.maxDurationDays,
      now,
    });

    if (verdict.outcome === "insufficient_data") {
      items.push({
        experimentId: experiment.id,
        name: experiment.name,
        accountKey: experiment.accountKey,
        status: "continued",
        verdict,
        pullRequest: null,
      });
      continue;
    }

    if (verdict.outcome === "expired_inconclusive" || verdict.outcome === "no_significant_difference") {
      await opts.store.concludeExperiment({
        experimentId: experiment.id,
        status: "inconclusive",
        conclusion: verdict,
        pullRequest: null,
      });
      items.push({
        experimentId: experiment.id,
        name: experiment.name,
        accountKey: experiment.accountKey,
        status: "inconclusive",
        verdict,
        pullRequest: null,
      });
      continue;
    }

    const loserKey =
      verdict.outcome === "a_wins" ? experiment.variantBKey : experiment.variantAKey;
    const winnerKey =
      verdict.outcome === "a_wins" ? experiment.variantAKey : experiment.variantBKey;
    const request = buildExperimentPausePullRequest({
      experiment,
      verdict,
      loserKey,
      winnerKey,
      repo: opts.repo ?? "",
      baseRef: opts.baseRef ?? "main",
      now,
    });
    try {
      const pullRequest = await opts.publisher.createPullRequest(request);
      await opts.store.concludeExperiment({
        experimentId: experiment.id,
        status: "concluded",
        conclusion: verdict,
        pullRequest,
      });
      items.push({
        experimentId: experiment.id,
        name: experiment.name,
        accountKey: experiment.accountKey,
        status: "concluded",
        verdict,
        pullRequest,
      });
    } catch (err) {
      items.push({
        experimentId: experiment.id,
        name: experiment.name,
        accountKey: experiment.accountKey,
        status: "pr_failed",
        verdict,
        pullRequest: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    status: items.some((item) => item.status === "pr_failed")
      ? "partial_failure"
      : "succeeded",
    evaluated: items.length,
    continued: countStatus(items, "continued"),
    concluded: countStatus(items, "concluded"),
    inconclusive: countStatus(items, "inconclusive"),
    cancelled: countStatus(items, "cancelled"),
    prFailed: countStatus(items, "pr_failed"),
    items,
  };
}

export function buildExperimentPausePullRequest(input: {
  experiment: ExperimentRecord;
  verdict: ExperimentVerdict;
  loserKey: string;
  winnerKey: string;
  repo: string;
  baseRef: string;
  now: Date;
}): ExperimentPullRequestRequest {
  const filePath = `operations/${input.experiment.accountKey}/${timestampForPath(input.now)}-experiment-${input.experiment.id}.json`;
  const manifest = {
    version: 2,
    accountKey: input.experiment.accountKey,
    intent: "status_change",
    source: "experiment_evaluate",
    actor: "addroid",
    rationale: `Experiment ${input.experiment.name}: ${input.winnerKey} beat ${input.loserKey}`,
    createdAt: input.now.toISOString(),
    actions: [
      {
        kind: "ad.status",
        payload: {
          adId: input.loserKey,
          status: "PAUSED",
        },
        entity: {
          nodeType: "ad",
          nodeKey: input.loserKey,
          parentNodeType: "adset",
          parentNodeKey: input.experiment.adsetNodeKey,
          status: "paused",
        },
      },
    ],
  };
  return {
    branchName: `addroid/experiment-${input.experiment.id}-${Date.now().toString(36)}`,
    prTitle: `Experiment winner: pause loser (${input.experiment.name})`,
    prBody: experimentPrBody(input),
    files: [
      {
        path: filePath,
        action: "create",
        diff: fullFileDiff(filePath, `${JSON.stringify(manifest, null, 2)}\n`),
      },
    ],
    baseRef: input.baseRef,
  };
}

function experimentPrBody(input: {
  experiment: ExperimentRecord;
  verdict: ExperimentVerdict;
  loserKey: string;
  winnerKey: string;
  repo: string;
}): string {
  const aCi = wilsonInterval(input.verdict.a.successes, input.verdict.a.impressions);
  const bCi = wilsonInterval(input.verdict.b.successes, input.verdict.b.impressions);
  return [
    "## Summary",
    "",
    `Experiment **${input.experiment.name}** concluded with **${input.winnerKey}** as winner.`,
    input.repo ? `Repository: ${input.repo}` : "",
    input.experiment.hypothesis ? `Hypothesis: ${input.experiment.hypothesis}` : "",
    "",
    "This PR only writes an operation manifest to pause the losing ad. Meta changes happen only after human PR merge and the normal apply path.",
    "",
    "## Verdict",
    "",
    `- Metric: ${input.verdict.metric}`,
    `- Outcome: ${input.verdict.outcome}`,
    `- Winner: ${input.winnerKey}`,
    `- Loser to pause: ${input.loserKey}`,
    `- pApprox: ${input.verdict.pApprox ?? "n/a"}`,
    "",
    "| Variant | Impressions | Successes | Rate | Wilson 95% CI |",
    "| --- | ---: | ---: | ---: | --- |",
    `| A (${input.experiment.variantAKey}) | ${input.verdict.a.impressions} | ${input.verdict.a.successes} | ${formatRate(input.verdict.a.rate)} | ${formatCi(aCi)} |`,
    `| B (${input.experiment.variantBKey}) | ${input.verdict.b.impressions} | ${input.verdict.b.successes} | ${formatRate(input.verdict.b.rate)} | ${formatCi(bCi)} |`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function successesForMetric(metric: ExperimentMetric, stats: ExperimentVariantStats): number {
  return cleanCount(metric === "ctr" ? stats.clicks : stats.conversions);
}

function cleanCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function rate(successes: number, impressions: number): number | null {
  return impressions > 0 ? successes / impressions : null;
}

function elapsedDays(startDate: string, now: Date): number {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1);
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function fullFileDiff(relPath: string, content: string): string {
  const body = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [`--- /dev/null`, `+++ b/${relPath}`, `@@`, body].join("\n");
}

function countStatus(
  items: readonly ExperimentEvaluateItemSummary[],
  status: ExperimentEvaluateItemStatus
): number {
  return items.filter((item) => item.status === status).length;
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function formatCi(value: { lower: number | null; upper: number | null }): string {
  if (value.lower === null || value.upper === null) return "n/a";
  return `${formatRate(value.lower)} - ${formatRate(value.upper)}`;
}
