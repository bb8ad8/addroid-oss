import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRebalancePlan,
  runBudgetRebalanceOnce,
  type BudgetRebalanceAuditInput,
  type BudgetRebalanceAuditWriter,
  type BudgetRebalancePolicy,
  type BudgetRebalancePublisher,
  type BudgetRebalancePullRequestRequest,
  type BudgetRebalanceStore,
  type DailyReportAdAccountSnapshot,
  type RebalanceCandidate,
} from "../index.js";

const POLICY: BudgetRebalancePolicy = {
  enabled: true,
  lookbackDays: 14,
  maxShiftPercentPerRun: 20,
  minDailyBudgetMajor: 50,
  minConversionsForJudgement: 10,
  keepTotalBudget: true,
  excludeNodeKeys: [],
};

const ACCOUNT: DailyReportAdAccountSnapshot = {
  id: "acc-1",
  key: "act_1",
  displayName: "Primary",
  metaAccountId: "act_1",
  currency: "JPY",
};

function candidate(
  nodeKey: string,
  overrides: Partial<RebalanceCandidate> = {}
): RebalanceCandidate {
  return {
    nodeKey,
    displayName: nodeKey,
    currentDailyBudgetMajor: 100,
    lookback: {
      spendMajor: 1000,
      conversions: 10,
      cpaMajor: 100,
      impressions: 1000,
      clicks: 100,
    },
    confidence: "reliable",
    ...overrides,
  };
}

test("computeRebalancePlan keeps total budget unchanged and clips by max shift", () => {
  const plan = computeRebalancePlan(
    [
      candidate("good", { lookback: { spendMajor: 500, conversions: 10, cpaMajor: 50 } }),
      candidate("mid", { lookback: { spendMajor: 1000, conversions: 10, cpaMajor: 100 } }),
      candidate("bad", { lookback: { spendMajor: 2000, conversions: 10, cpaMajor: 200 } }),
    ],
    POLICY
  );
  assert.equal(plan.moves.length, 2);
  assert.equal(plan.totalDeltaMajor, 0);
  assert.deepEqual(
    plan.moves.map((move) => [move.nodeKey, move.direction, move.fromMajor, move.toMajor]),
    [
      ["bad", "decrease", 100, 80],
      ["good", "increase", 100, 120],
    ]
  );
});

test("computeRebalancePlan respects daily budget floor", () => {
  const plan = computeRebalancePlan(
    [
      candidate("good", { lookback: { spendMajor: 500, conversions: 10, cpaMajor: 50 } }),
      candidate("mid", { lookback: { spendMajor: 1000, conversions: 10, cpaMajor: 100 } }),
      candidate("bad", {
        currentDailyBudgetMajor: 60,
        lookback: { spendMajor: 2000, conversions: 10, cpaMajor: 200 },
      }),
    ],
    POLICY
  );
  assert.equal(plan.totalDeltaMajor, 0);
  assert.equal(plan.moves.find((move) => move.nodeKey === "bad")?.toMajor, 50);
  assert.equal(plan.moves.find((move) => move.nodeKey === "good")?.toMajor, 110);
});

test("computeRebalancePlan skips insufficient, excluded, no budget, and at-floor candidates", () => {
  const plan = computeRebalancePlan(
    [
      candidate("good", { lookback: { spendMajor: 500, conversions: 10, cpaMajor: 50 } }),
      candidate("excluded"),
      candidate("small", { confidence: "insufficient" }),
      candidate("no_budget", { currentDailyBudgetMajor: 0 }),
      candidate("floor", {
        currentDailyBudgetMajor: 50,
        lookback: { spendMajor: 2000, conversions: 10, cpaMajor: 200 },
      }),
      candidate("mid", { lookback: { spendMajor: 1000, conversions: 10, cpaMajor: 100 } }),
    ],
    { ...POLICY, excludeNodeKeys: ["excluded"] }
  );
  assert.deepEqual(
    plan.skipped.map((item) => [item.nodeKey, item.reason]),
    [
      ["excluded", "excluded"],
      ["small", "insufficient_data"],
      ["no_budget", "no_budget"],
      ["floor", "at_floor"],
    ]
  );
});

test("computeRebalancePlan returns no moves when there is no decrease funding or less than two moves", () => {
  const noFunding = computeRebalancePlan(
    [
      candidate("good", { lookback: { spendMajor: 500, conversions: 10, cpaMajor: 50 } }),
      candidate("mid", { lookback: { spendMajor: 1000, conversions: 10, cpaMajor: 100 } }),
    ],
    POLICY
  );
  assert.equal(noFunding.moves.length, 0);

  const oneSided = computeRebalancePlan(
    [
      candidate("bad", { lookback: { spendMajor: 2000, conversions: 10, cpaMajor: 200 } }),
      candidate("mid", { lookback: { spendMajor: 1000, conversions: 10, cpaMajor: 100 } }),
    ],
    POLICY
  );
  assert.equal(oneSided.moves.length, 0);
});

test("runBudgetRebalanceOnce skips missing policy and disabled policy without PR", async () => {
  const store = new FakeStore([]);
  const publisher = new FakePublisher();
  const audit = new FakeAuditWriter();
  const missing = await runBudgetRebalanceOnce({
    workspaceId: "ws",
    mode: "proposal",
    accountKey: "act_1",
    policy: null,
    store,
    publisher,
    audit,
  });
  assert.equal(missing.status, "policy_missing");
  const disabled = await runBudgetRebalanceOnce({
    workspaceId: "ws",
    mode: "proposal",
    accountKey: "act_1",
    policy: { ...POLICY, enabled: false },
    store,
    publisher,
    audit,
  });
  assert.equal(disabled.status, "disabled");
  assert.equal(publisher.requests.length, 0);
  assert.equal(audit.inputs.length, 2);
});

test("runBudgetRebalanceOnce creates a PR and approval-required audit for moves", async () => {
  const store = new FakeStore([
    candidate("good", { lookback: { spendMajor: 500, conversions: 10, cpaMajor: 50 } }),
    candidate("mid", { lookback: { spendMajor: 1000, conversions: 10, cpaMajor: 100 } }),
    candidate("bad", { lookback: { spendMajor: 2000, conversions: 10, cpaMajor: 200 } }),
  ]);
  const publisher = new FakePublisher();
  const audit = new FakeAuditWriter();
  const summary = await runBudgetRebalanceOnce({
    workspaceId: "ws",
    mode: "proposal",
    accountKey: "act_1",
    policy: POLICY,
    store,
    publisher,
    audit,
    repo: "owner/repo",
    baseRef: "main",
    now: () => new Date("2026-06-13T00:00:00.000Z"),
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.auditDecision, "approval_required");
  assert.deepEqual(summary.dangerousCategories, ["budget_increase"]);
  assert.equal(publisher.requests.length, 1);
  assert.match(publisher.requests[0]!.files[0]!.diff, /"kind": "adset\.update"/);
  assert.match(publisher.requests[0]!.prBody, /normal apply path/);
  assert.equal(audit.inputs.at(-1)?.action, "budget_rebalance.opened");
});

class FakeStore implements BudgetRebalanceStore {
  constructor(private readonly candidates: RebalanceCandidate[]) {}

  async findAdAccount() {
    return ACCOUNT;
  }

  async listRebalanceCandidates() {
    return this.candidates;
  }
}

class FakePublisher implements BudgetRebalancePublisher {
  requests: BudgetRebalancePullRequestRequest[] = [];

  async createPullRequest(req: BudgetRebalancePullRequestRequest) {
    this.requests.push(req);
    return {
      pullRequestId: "pr-db-1",
      prNumber: 12,
      htmlUrl: "https://example.com/pr/12",
      headSha: "abc123",
    };
  }
}

class FakeAuditWriter implements BudgetRebalanceAuditWriter {
  inputs: BudgetRebalanceAuditInput[] = [];

  async recordBudgetRebalanceAudit(input: BudgetRebalanceAuditInput) {
    this.inputs.push(input);
  }
}
