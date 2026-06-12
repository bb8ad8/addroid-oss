import assert from "node:assert/strict";
import test from "node:test";
import {
  judgeExperiment,
  runExperimentEvaluateOnce,
  type ExperimentEvaluateStore,
  type ExperimentPublisher,
  type ExperimentRecord,
  type ExperimentVariantState,
  type ExperimentVariantStats,
} from "../experiments.js";

const NOW = new Date("2026-06-13T00:00:00.000Z");

test("judgeExperiment returns insufficient_data before sample threshold", () => {
  const verdict = judgeExperiment({
    metric: "ctr",
    a: stats({ impressions: 1999, clicks: 100 }),
    b: stats({ impressions: 2000, clicks: 140 }),
    minImpressionsPerVariant: 2000,
    elapsedDays: 3,
    maxDurationDays: 14,
    now: NOW,
  });
  assert.equal(verdict.outcome, "insufficient_data");
  assert.equal(verdict.pApprox, null);
});

test("judgeExperiment expires inconclusive when threshold is not reached by max duration", () => {
  const verdict = judgeExperiment({
    metric: "ctr",
    a: stats({ impressions: 1999, clicks: 100 }),
    b: stats({ impressions: 2000, clicks: 140 }),
    minImpressionsPerVariant: 2000,
    elapsedDays: 14,
    maxDurationDays: 14,
    now: NOW,
  });
  assert.equal(verdict.outcome, "expired_inconclusive");
});

test("judgeExperiment detects a_wins and b_wins", () => {
  const aWins = judgeExperiment({
    metric: "ctr",
    a: stats({ impressions: 5000, clicks: 500 }),
    b: stats({ impressions: 5000, clicks: 250 }),
    minImpressionsPerVariant: 2000,
    elapsedDays: 5,
    maxDurationDays: 14,
    now: NOW,
  });
  const bWins = judgeExperiment({
    metric: "cvr",
    a: stats({ impressions: 5000, clicks: 500, conversions: 50 }),
    b: stats({ impressions: 5000, clicks: 400, conversions: 100 }),
    minImpressionsPerVariant: 2000,
    elapsedDays: 5,
    maxDurationDays: 14,
    now: NOW,
  });
  assert.equal(aWins.outcome, "a_wins");
  assert.equal(bWins.outcome, "b_wins");
  assert.ok(aWins.pApprox !== null && aWins.pApprox < 0.05);
});

test("judgeExperiment keeps not-significant tests running until max duration", () => {
  const running = judgeExperiment({
    metric: "ctr",
    a: stats({ impressions: 5000, clicks: 250 }),
    b: stats({ impressions: 5000, clicks: 255 }),
    minImpressionsPerVariant: 2000,
    elapsedDays: 13,
    maxDurationDays: 14,
    now: NOW,
  });
  const done = judgeExperiment({
    metric: "ctr",
    a: stats({ impressions: 5000, clicks: 250 }),
    b: stats({ impressions: 5000, clicks: 255 }),
    minImpressionsPerVariant: 2000,
    elapsedDays: 14,
    maxDurationDays: 14,
    now: NOW,
  });
  assert.equal(running.outcome, "insufficient_data");
  assert.equal(done.outcome, "no_significant_difference");
});

test("runExperimentEvaluateOnce continues insufficient experiments without writes", async () => {
  const store = new FakeExperimentStore([
    experiment({ id: "exp-1", startDate: "2026-06-10" }),
  ]);
  store.stats.set("exp-1", {
    a: stats({ impressions: 1000, clicks: 100 }),
    b: stats({ impressions: 1000, clicks: 100 }),
  });
  const publisher = new FakePublisher();
  const summary = await runExperimentEvaluateOnce({
    mode: "proposal",
    store,
    publisher,
    now: () => NOW,
  });
  assert.equal(summary.continued, 1);
  assert.equal(store.conclusions.length, 0);
  assert.equal(publisher.requests.length, 0);
});

test("runExperimentEvaluateOnce opens a pause PR and concludes on winner", async () => {
  const store = new FakeExperimentStore([
    experiment({ id: "exp-2", name: "headline-test", startDate: "2026-06-10" }),
  ]);
  store.stats.set("exp-2", {
    a: stats({ impressions: 5000, clicks: 500 }),
    b: stats({ impressions: 5000, clicks: 250 }),
  });
  const publisher = new FakePublisher();
  const summary = await runExperimentEvaluateOnce({
    mode: "proposal",
    store,
    publisher,
    repo: "bb8ad8/addroid-ops",
    now: () => NOW,
  });
  assert.equal(summary.concluded, 1);
  assert.equal(store.conclusions[0]!.status, "concluded");
  assert.equal(store.conclusions[0]!.pullRequest?.prNumber, 77);
  assert.match(publisher.requests[0]!.files[0]!.diff, /"kind": "ad.status"/);
  assert.match(publisher.requests[0]!.files[0]!.diff, /"adId": "ad-b"/);
});

test("runExperimentEvaluateOnce concludes inconclusive without PR", async () => {
  const store = new FakeExperimentStore([
    experiment({ id: "exp-3", startDate: "2026-05-30" }),
  ]);
  store.stats.set("exp-3", {
    a: stats({ impressions: 5000, clicks: 250 }),
    b: stats({ impressions: 5000, clicks: 255 }),
  });
  const publisher = new FakePublisher();
  const summary = await runExperimentEvaluateOnce({
    mode: "proposal",
    store,
    publisher,
    now: () => NOW,
  });
  assert.equal(summary.inconclusive, 1);
  assert.equal(store.conclusions[0]!.status, "inconclusive");
  assert.equal(publisher.requests.length, 0);
});

test("runExperimentEvaluateOnce cancels when a variant is no longer active", async () => {
  const store = new FakeExperimentStore([experiment({ id: "exp-4" })]);
  store.states.set("exp-4", { variantAActive: true, variantBActive: false, reason: "variant_b_paused" });
  const summary = await runExperimentEvaluateOnce({
    mode: "proposal",
    store,
    publisher: new FakePublisher(),
    now: () => NOW,
  });
  assert.equal(summary.cancelled, 1);
  assert.equal(store.cancellations[0]!.conclusion.reason, "variant_b_paused");
});

function stats(overrides: Partial<ExperimentVariantStats>): ExperimentVariantStats {
  return {
    impressions: overrides.impressions ?? 0,
    clicks: overrides.clicks ?? 0,
    conversions: overrides.conversions ?? 0,
  };
}

function experiment(overrides: Partial<ExperimentRecord>): ExperimentRecord {
  return {
    id: overrides.id ?? "exp",
    workspaceId: "ws-1",
    accountId: "acc-1",
    accountKey: "act_1",
    name: overrides.name ?? "test",
    hypothesis: overrides.hypothesis ?? null,
    metric: overrides.metric ?? "ctr",
    adsetNodeKey: "adset-1",
    variantAKey: "ad-a",
    variantBKey: "ad-b",
    startDate: overrides.startDate ?? "2026-06-01",
    minImpressionsPerVariant: overrides.minImpressionsPerVariant ?? 2000,
    maxDurationDays: overrides.maxDurationDays ?? 14,
    createdBy: "user:web-ui",
  };
}

class FakeExperimentStore implements ExperimentEvaluateStore {
  stats = new Map<string, { a: ExperimentVariantStats; b: ExperimentVariantStats }>();
  states = new Map<string, ExperimentVariantState>();
  conclusions: Array<{
    experimentId: string;
    status: "concluded" | "inconclusive";
    pullRequest?: { prNumber: number } | null;
  }> = [];
  cancellations: Array<{ experimentId: string; conclusion: Record<string, unknown> }> = [];

  constructor(private readonly experiments: ExperimentRecord[]) {}

  async listRunningExperiments() {
    return this.experiments;
  }

  async loadVariantStats(input: { accountId: string }) {
    const exp = this.experiments.find((item) => item.accountId === input.accountId);
    return this.stats.get(exp?.id ?? "") ?? { a: stats({}), b: stats({}) };
  }

  async loadVariantState(input: { accountId: string }) {
    const exp = this.experiments.find((item) => item.accountId === input.accountId);
    return this.states.get(exp?.id ?? "") ?? { variantAActive: true, variantBActive: true };
  }

  async concludeExperiment(input: {
    experimentId: string;
    status: "concluded" | "inconclusive";
    pullRequest?: { prNumber: number } | null;
  }) {
    this.conclusions.push(input);
  }

  async cancelExperiment(input: { experimentId: string; conclusion: Record<string, unknown> }) {
    this.cancellations.push(input);
  }
}

class FakePublisher implements ExperimentPublisher {
  requests: Parameters<ExperimentPublisher["createPullRequest"]>[0][] = [];

  async createPullRequest(req: Parameters<ExperimentPublisher["createPullRequest"]>[0]) {
    this.requests.push(req);
    return {
      pullRequestId: "pr-row-1",
      prNumber: 77,
      htmlUrl: "https://github.example/pull/77",
      headSha: "abc",
    };
  }
}
