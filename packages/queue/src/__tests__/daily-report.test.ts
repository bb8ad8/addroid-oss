// AdDroid OSS — daily_report orchestrator tests.
//
// pg-boss / Prisma / Meta CLI / LLM Provider を一切起動せず、
// `runDailyReportOnce` のロジックのみを in-memory fake で検証する。

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeKpiDeltas,
  microsToMajor,
  resolveDailyReportTimeZone,
  runDailyReportOnce,
  subtractOneUtcDay,
  toDateStringInTimeZone,
  toKpiSet,
  toUtcDateString,
  type DailyReportAdAccountSnapshot,
  type DailyReportAnalystInput,
  type DailyReportAnalystResult,
  type DailyReportAnalystRunner,
  type DailyReportInsightsProvider,
  type DailyReportInsightsRequest,
  type DailyReportInsightsResponse,
  type DailyReportInsightsRow,
  type DailyReportSnapshotStore,
  type PerformanceSnapshotUpsertInput,
  type PerformanceSnapshotUpsertResult,
} from "../index.js";
import type { AiRunCreateInputData } from "@addroid/llm-provider";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

class FakeInsightsProvider implements DailyReportInsightsProvider {
  calls: DailyReportInsightsRequest[] = [];
  constructor(private readonly response: DailyReportInsightsResponse) {}
  async fetchInsights(req: DailyReportInsightsRequest) {
    this.calls.push(req);
    return this.response;
  }
}

class FakeSnapshotStore implements DailyReportSnapshotStore {
  account: DailyReportAdAccountSnapshot | null;
  upsertCalls: PerformanceSnapshotUpsertInput[] = [];
  aiRunCalls: AiRunCreateInputData[] = [];
  private nextSnapshotId = 1;
  private nextAiRunId = 1;
  constructor(account: DailyReportAdAccountSnapshot | null) {
    this.account = account;
  }
  async findAdAccount(_input: { workspaceId: string; accountKey: string }) {
    return this.account;
  }
  async upsertPerformanceSnapshot(
    input: PerformanceSnapshotUpsertInput
  ): Promise<PerformanceSnapshotUpsertResult> {
    this.upsertCalls.push(input);
    return {
      id: `snap-${this.nextSnapshotId++}`,
      nodeType: input.nodeType,
      nodeKey: input.nodeKey,
      metricDate: input.metricDate,
    };
  }
  async createAiRun(data: AiRunCreateInputData) {
    this.aiRunCalls.push(data);
    return { id: `run-${this.nextAiRunId++}` };
  }
}

class FakeAnalystRunner implements DailyReportAnalystRunner {
  calls: DailyReportAnalystInput[] = [];
  constructor(private readonly result: DailyReportAnalystResult) {}
  async run(input: DailyReportAnalystInput): Promise<DailyReportAnalystResult> {
    this.calls.push(input);
    return this.result;
  }
}

const ACCOUNT: DailyReportAdAccountSnapshot = {
  id: "acc-1",
  key: "primary",
  displayName: "Primary",
  metaAccountId: "act_111",
  currency: "JPY",
  timezoneName: "Asia/Tokyo",
};

function makeRow(
  nodeType: DailyReportInsightsRow["nodeType"],
  nodeKey: string,
  overrides: Partial<DailyReportInsightsRow> = {}
): DailyReportInsightsRow {
  return {
    nodeType,
    nodeKey,
    spendMicros: 1_000_000_000n, // 1000 JPY
    impressions: 1000,
    clicks: 50,
    conversions: 5,
    frequency: 1.5,
    ...overrides,
  };
}

function makeAnalystResult(
  overrides: Partial<DailyReportAnalystResult> = {}
): DailyReportAnalystResult {
  const aiRunInput: AiRunCreateInputData = {
    workspaceId: "ws-1",
    agent: "analyst",
    workflow: "daily_report",
    provider: "mock",
    model: "mock-small",
    status: "succeeded",
    prompt: null,
    inputs: { hello: "world" },
    outputs: { ok: true },
    decision: "report_only",
    confidence: 0.7,
    inputTokens: 12,
    outputTokens: 24,
    costUsd: 0,
    requestId: "mock-1",
    linkedRefType: "performance_snapshot",
    linkedRefId: "snap-1",
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
  };
  return {
    aiRunInput,
    output: {
      commentary: "spend stable, CTR up vs prior day",
      deltas: { ctr: "+10.0%" },
      topImprovements: [
        {
          hierarchy: "campaign",
          target: "cmp_1",
          rationale: "low CTR adset",
          expectedImpact: "+15% CTR",
        },
      ],
    },
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------

test("microsToMajor handles JPY-scale spend without precision loss", () => {
  assert.equal(microsToMajor(0n), 0);
  assert.equal(microsToMajor(1_000_000n), 1);
  assert.equal(microsToMajor(5_500_000n), 5.5);
  // very large bigint
  assert.equal(microsToMajor(1_000_000_000_000n), 1_000_000);
});

test("toKpiSet derives CTR / CPC / CPA / CPM from raw rows", () => {
  const k = toKpiSet({
    nodeType: "account",
    nodeKey: "act_111",
    spendMicros: 1_000_000_000n, // 1000 unit
    impressions: 10_000,
    clicks: 100,
    conversions: 10,
    frequency: 2.0,
  });
  assert.equal(k.spend, 1000);
  assert.equal(k.impressions, 10_000);
  assert.equal(k.clicks, 100);
  assert.equal(k.conversions, 10);
  assert.equal(k.cv, 10);
  assert.equal(k.ctr, 1); // 100/10000 * 100
  assert.equal(k.cpc, 10); // 1000/100
  assert.equal(k.cpa, 100); // 1000/10
  assert.equal(k.cpm, 100); // 1000/10000 * 1000
  assert.equal(k.frequency, 2.0);
});

test("toKpiSet defends against zero denominators", () => {
  const k = toKpiSet({
    nodeType: "account",
    nodeKey: "act_111",
    spendMicros: 0n,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    frequency: null,
  });
  assert.equal(k.ctr, 0);
  assert.equal(k.cpc, 0);
  assert.equal(k.cpa, 0);
  assert.equal(k.cpm, 0);
  assert.equal(k.frequency, null);
});

test("computeKpiDeltas formats +/- percent text and handles zeros", () => {
  const cur = toKpiSet(makeRow("account", "act_111", { clicks: 110 }));
  const prior = toKpiSet(makeRow("account", "act_111", { clicks: 100 }));
  const deltas = computeKpiDeltas(cur, prior);
  assert.equal(deltas.clicks, "+10.0%");
  // zero prior + non-zero current => +∞
  const inf = computeKpiDeltas(
    toKpiSet(makeRow("account", "act_111", { clicks: 5 })),
    toKpiSet(makeRow("account", "act_111", { clicks: 0 }))
  );
  assert.equal(inf.clicks, "+∞%");
  // both zero => 0%
  const z = computeKpiDeltas(
    toKpiSet(makeRow("account", "act_111", { clicks: 0 })),
    toKpiSet(makeRow("account", "act_111", { clicks: 0 }))
  );
  assert.equal(z.clicks, "0%");
});

test("subtractOneUtcDay handles month/year rollovers", () => {
  assert.equal(subtractOneUtcDay("2026-05-02"), "2026-05-01");
  assert.equal(subtractOneUtcDay("2026-05-01"), "2026-04-30");
  assert.equal(subtractOneUtcDay("2026-01-01"), "2025-12-31");
});

test("toUtcDateString is UTC-stable", () => {
  assert.equal(toUtcDateString(new Date("2026-05-02T03:00:00Z")), "2026-05-02");
  assert.equal(toUtcDateString(new Date("2026-05-02T23:59:00Z")), "2026-05-02");
});

test("toDateStringInTimeZone derives the local calendar date", () => {
  const instant = new Date("2026-05-02T23:30:00Z");
  assert.equal(toDateStringInTimeZone(instant, "UTC"), "2026-05-02");
  assert.equal(toDateStringInTimeZone(instant, "Asia/Tokyo"), "2026-05-03");
  assert.equal(
    toDateStringInTimeZone(new Date("2026-05-02T02:30:00Z"), "America/Los_Angeles"),
    "2026-05-01"
  );
});

test("resolveDailyReportTimeZone prefers account timezone over fallback", () => {
  assert.equal(
    resolveDailyReportTimeZone("America/Los_Angeles", "Asia/Tokyo"),
    "America/Los_Angeles"
  );
  assert.equal(resolveDailyReportTimeZone(null, "Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(resolveDailyReportTimeZone("not/a-zone", "UTC"), "UTC");
});

// ---------------------------------------------------------------------
// runDailyReportOnce — orchestration
// ---------------------------------------------------------------------

test("runDailyReportOnce returns no_account when ad_account is missing", async () => {
  const insights = new FakeInsightsProvider({
    current: [],
    prior: [],
    source: "mock",
  });
  const store = new FakeSnapshotStore(null);
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    metricDate: "2026-05-02",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.status, "no_account");
  assert.equal(summary.snapshotIds.length, 0);
  assert.equal(summary.aiRunId, null);
  assert.equal(insights.calls.length, 0);
  assert.equal(store.upsertCalls.length, 0);
  assert.equal(analyst.calls.length, 0);
});

test("runDailyReportOnce derives metricDate from the Meta account timezone", async () => {
  const insights = new FakeInsightsProvider({
    current: [makeRow("account", "act_111")],
    prior: [],
    source: "mock",
  });
  const store = new FakeSnapshotStore({
    ...ACCOUNT,
    timezoneName: "Asia/Tokyo",
  });
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    now: () => new Date("2026-05-02T23:30:00Z"),
    fallbackTimeZone: "UTC",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.metricDate, "2026-05-03");
  assert.equal(summary.priorMetricDate, "2026-05-02");
  assert.equal(summary.metricTimeZone, "Asia/Tokyo");
  assert.equal(insights.calls[0]!.metricDate, "2026-05-03");
});

test("runDailyReportOnce can derive the previous local day for scheduled daily_report", async () => {
  const insights = new FakeInsightsProvider({
    current: [makeRow("account", "act_111")],
    prior: [],
    source: "mock",
  });
  const store = new FakeSnapshotStore({
    ...ACCOUNT,
    timezoneName: "Asia/Tokyo",
  });
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    now: () => new Date("2026-05-02T23:30:00Z"),
    metricDateOffsetDays: -1,
    fallbackTimeZone: "UTC",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.metricDate, "2026-05-02");
  assert.equal(summary.priorMetricDate, "2026-05-01");
  assert.equal(insights.calls[0]!.metricDate, "2026-05-02");
});

test("runDailyReportOnce falls back to the user timezone when account timezone is missing", async () => {
  const insights = new FakeInsightsProvider({
    current: [makeRow("account", "act_111")],
    prior: [],
    source: "mock",
  });
  const store = new FakeSnapshotStore({
    ...ACCOUNT,
    timezoneName: null,
  });
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    now: () => new Date("2026-05-02T02:30:00Z"),
    fallbackTimeZone: "America/Los_Angeles",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.metricDate, "2026-05-01");
  assert.equal(summary.metricTimeZone, "America/Los_Angeles");
});

test("runDailyReportOnce stores 4-level snapshots and emits AI commentary + top improvements", async () => {
  const current: DailyReportInsightsRow[] = [
    makeRow("account", "act_111", { clicks: 110, impressions: 11_000 }),
    makeRow("campaign", "cmp_1", { clicks: 60 }),
    makeRow("adset", "as_1", { clicks: 40 }),
    makeRow("ad", "ad_1", { clicks: 20 }),
  ];
  const prior: DailyReportInsightsRow[] = [
    makeRow("account", "act_111", { clicks: 100, impressions: 10_000 }),
    makeRow("campaign", "cmp_1", { clicks: 55 }),
    makeRow("adset", "as_1", { clicks: 38 }),
    makeRow("ad", "ad_1", { clicks: 18 }),
  ];
  const insights = new FakeInsightsProvider({
    current,
    prior,
    source: "mock",
  });
  const store = new FakeSnapshotStore(ACCOUNT);
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "proposal",
    accountKey: "primary",
    metricDate: "2026-05-02",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.status, "succeeded");
  // 4 current + 4 prior snapshots upserted
  assert.equal(store.upsertCalls.length, 8);
  assert.equal(summary.snapshotIds.length, 4);
  // current upserts wear metricDate=2026-05-02
  assert.equal(
    store.upsertCalls.filter((c) => c.metricDate === "2026-05-02").length,
    4
  );
  // prior upserts wear metricDate=2026-05-01
  assert.equal(
    store.upsertCalls.filter((c) => c.metricDate === "2026-05-01").length,
    4
  );
  // AI run was persisted exactly once and is linked to a performance_snapshot
  assert.equal(store.aiRunCalls.length, 1);
  assert.equal(summary.aiRunId, "run-1");
  // KPI delta on clicks = +10%
  assert.equal(summary.deltas.clicks, "+10.0%");
  // Account currency surfaced
  assert.equal(summary.currency, "JPY");
  const adUpsert = store.upsertCalls.find((c) => c.nodeType === "ad" && c.metricDate === "2026-05-02");
  assert.equal(adUpsert?.frequency, 1.5);
  // analyst input received the snapshot ids of all 4 current rows
  const analystCall = analyst.calls[0]!;
  assert.equal(analystCall.snapshotIds.length, 4);
  assert.equal(analystCall.current.ctr, 1);
  assert.equal(analystCall.current.cpc, 9.090909);
  assert.equal(analystCall.current.cpa, 200);
  assert.equal(analystCall.current.frequency, 1.5);
  assert.equal(analystCall.current.cpm, 90.909091);
  // top improvements truncated to <= 3 (we returned 1)
  assert.equal(summary.topImprovements.length, 1);
  assert.equal(summary.topImprovements[0]!.target, "cmp_1");
  // commentary present
  assert.equal(summary.aiCommentary, "spend stable, CTR up vs prior day");
  // mode preserved on the summary (UI ModeBadge needs this)
  assert.equal(summary.mode, "proposal");
  // insightsProvider was asked for prior period
  assert.equal(insights.calls[0]!.includePriorPeriod, true);
});

test("runDailyReportOnce surfaces analyst failures without losing snapshots", async () => {
  const current = [makeRow("account", "act_111")];
  const insights = new FakeInsightsProvider({
    current,
    prior: [],
    source: "mock",
  });
  const store = new FakeSnapshotStore(ACCOUNT);
  const failed = makeAnalystResult({
    output: null,
    error: "LLMProviderError: rate_limit",
    aiRunInput: {
      ...makeAnalystResult().aiRunInput,
      status: "failed",
      outputs: null,
      decision: null,
      errorMessage: "rate_limit",
    },
  });
  const analyst = new FakeAnalystRunner(failed);
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "proposal",
    accountKey: "primary",
    metricDate: "2026-05-02",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.status, "ai_failed");
  // snapshots still persisted
  assert.equal(store.upsertCalls.length, 1);
  assert.equal(summary.snapshotIds.length, 1);
  // ai_run row written even on failure (status=failed sanitized)
  assert.equal(store.aiRunCalls.length, 1);
  assert.equal(store.aiRunCalls[0]!.status, "failed");
  assert.equal(summary.aiRunId, "run-1");
  // user-visible error message bubbled up
  assert.match(summary.errorMessage ?? "", /rate_limit/);
  assert.equal(summary.aiCommentary, null);
  assert.equal(summary.topImprovements.length, 0);
});

test("runDailyReportOnce returns no_insights when provider returns empty current period", async () => {
  const insights = new FakeInsightsProvider({
    current: [],
    prior: [],
    source: "mock",
    detail: "no insights returned",
  });
  const store = new FakeSnapshotStore(ACCOUNT);
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    metricDate: "2026-05-02",
    insightsProvider: insights,
    store,
    analyst,
  });
  assert.equal(summary.status, "no_insights");
  assert.equal(summary.snapshotIds.length, 0);
  // analyst should not run when there's nothing to analyze
  assert.equal(analyst.calls.length, 0);
  assert.equal(store.aiRunCalls.length, 0);
});

test("runDailyReportOnce forwards breakdownsPolicy to the insights provider and synthesizes account KPIs from campaigns when no account row is fetched", async () => {
  // Provider returns ONLY campaign-level rows (= policy disabled fetchAccount).
  // The orchestrator must still produce non-zero account KPIs for the
  // analyst input + summary by aggregating the campaign rows.
  const current: DailyReportInsightsRow[] = [
    makeRow("campaign", "cmp_1", {
      spendMicros: 600_000_000n,
      impressions: 6_000,
      clicks: 60,
      conversions: 6,
    }),
    makeRow("campaign", "cmp_2", {
      spendMicros: 400_000_000n,
      impressions: 4_000,
      clicks: 40,
      conversions: 4,
    }),
  ];
  const insights = new FakeInsightsProvider({
    current,
    prior: [],
    source: "mock",
  });
  const store = new FakeSnapshotStore(ACCOUNT);
  const analyst = new FakeAnalystRunner(makeAnalystResult());
  const summary = await runDailyReportOnce({
    workspaceId: "ws-1",
    mode: "report_only",
    accountKey: "primary",
    metricDate: "2026-05-02",
    insightsProvider: insights,
    store,
    analyst,
    breakdownsPolicy: { fetchAccount: false },
  });
  // breakdownsPolicy should reach the provider verbatim (after merge).
  assert.equal(insights.calls[0]!.breakdownsPolicy?.fetchAccount, false);
  assert.equal(insights.calls[0]!.breakdownsPolicy?.fetchCampaign, true);
  // Synthesized account KPIs come from summing the campaign rows
  // (10000 impressions / 100 clicks / 1000 spend / 10 conversions).
  assert.equal(summary.current.spend, 1000);
  assert.equal(summary.current.impressions, 10_000);
  assert.equal(summary.current.clicks, 100);
  assert.equal(summary.current.conversions, 10);
  assert.equal(summary.current.ctr, 1); // 100 / 10000 * 100
  assert.equal(summary.status, "succeeded");
});
