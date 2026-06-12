import test from "node:test";
import assert from "node:assert/strict";
import {
  PerformanceQuerySchema,
  runPerformanceCompare,
  runPerformanceQuery,
  type PerformanceQueryStore,
  type PerformanceSnapshotQueryRow,
} from "../index.js";

class FakePerformanceStore implements PerformanceQueryStore {
  calls: Array<Parameters<PerformanceQueryStore["listPerformanceSnapshots"]>[0]> = [];

  constructor(private readonly rows: PerformanceSnapshotQueryRow[]) {}

  async listPerformanceSnapshots(
    input: Parameters<PerformanceQueryStore["listPerformanceSnapshots"]>[0]
  ): Promise<PerformanceSnapshotQueryRow[]> {
    this.calls.push(input);
    return this.rows.filter((row) => {
      const status = row.status?.toLowerCase() ?? null;
      return (
        row.metricDate >= input.since &&
        row.metricDate <= input.until &&
        (input.statusFilter === "all" || status === input.statusFilter)
      );
    });
  }
}

function row(
  metricDate: string,
  overrides: Partial<PerformanceSnapshotQueryRow> = {}
): PerformanceSnapshotQueryRow {
  return {
    nodeKey: "cmp_a",
    displayName: "Campaign A",
    status: "active",
    metricDate,
    spendMicros: 10_000_000n,
    impressions: 1000,
    clicks: 50,
    conversions: 10,
    frequency: 1.2,
    ...overrides,
  };
}

test("PerformanceQuerySchema rejects invalid metric, too-large limit, long windows, and extra keys", () => {
  const base = {
    accountId: "acc-1",
    level: "campaign",
    window: { since: "2026-01-01", until: "2026-01-07" },
    metric: "ctr",
  };
  assert.equal(PerformanceQuerySchema.safeParse({ ...base, metric: "sql" }).success, false);
  assert.equal(PerformanceQuerySchema.safeParse({ ...base, limit: 21 }).success, false);
  assert.equal(
    PerformanceQuerySchema.safeParse({
      ...base,
      window: { since: "2026-01-01", until: "2026-04-15" },
    }).success,
    false
  );
  assert.equal(PerformanceQuerySchema.safeParse({ ...base, sql: "select * from x" }).success, false);
});

test("runPerformanceQuery recomputes ratio metrics from period sums and returns null for zero division", async () => {
  const store = new FakePerformanceStore([
    row("2026-05-01", {
      nodeKey: "cmp_a",
      impressions: 1000,
      clicks: 100,
      conversions: 1,
      spendMicros: 20_000_000n,
    }),
    row("2026-05-02", {
      nodeKey: "cmp_a",
      impressions: 100,
      clicks: 0,
      conversions: 0,
      spendMicros: 0n,
    }),
    row("2026-05-01", {
      nodeKey: "cmp_zero",
      displayName: "Zero",
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spendMicros: 10_000_000n,
    }),
  ]);

  const ctr = await runPerformanceQuery({
    store,
    input: {
      accountId: "acc-1",
      level: "campaign",
      window: { since: "2026-05-01", until: "2026-05-02" },
      metric: "ctr",
      rank: "top",
      limit: 10,
    },
  });
  assert.equal(ctr.rows.find((r) => r.nodeKey === "cmp_a")?.value, 100 / 1100);

  const cpa = await runPerformanceQuery({
    store,
    input: {
      accountId: "acc-1",
      level: "campaign",
      window: { since: "2026-05-01", until: "2026-05-02" },
      metric: "cpa",
      rank: "top",
      limit: 10,
    },
  });
  assert.equal(cpa.rows.find((r) => r.nodeKey === "cmp_zero")?.value, null);
});

test("runPerformanceQuery supports top, bottom, and lowSample tail ordering", async () => {
  const store = new FakePerformanceStore([
    row("2026-05-01", {
      nodeKey: "cmp_mid",
      displayName: "Mid",
      spendMicros: 1_000_000n,
      impressions: 1000,
      clicks: 30,
      conversions: 6,
    }),
    row("2026-05-01", {
      nodeKey: "cmp_best",
      displayName: "Best",
      spendMicros: 100_000n,
      impressions: 1000,
      clicks: 30,
      conversions: 10,
    }),
    row("2026-05-01", {
      nodeKey: "cmp_small",
      displayName: "Small sample",
      spendMicros: 1_000n,
      impressions: 20,
      clicks: 20,
      conversions: 20,
    }),
  ]);

  const topSpend = await runPerformanceQuery({
    store,
    input: {
      accountId: "acc-1",
      level: "campaign",
      window: { since: "2026-05-01", until: "2026-05-01" },
      metric: "spend",
      rank: "top",
      limit: 3,
    },
  });
  assert.deepEqual(
    topSpend.rows.map((r) => r.nodeKey),
    ["cmp_mid", "cmp_best", "cmp_small"]
  );
  assert.equal(topSpend.rows[2]?.lowSample, true);

  const bottomCpa = await runPerformanceQuery({
    store,
    input: {
      accountId: "acc-1",
      level: "campaign",
      window: { since: "2026-05-01", until: "2026-05-01" },
      metric: "cpa",
      rank: "bottom",
      limit: 3,
    },
  });
  assert.deepEqual(
    bottomCpa.rows.map((r) => r.nodeKey),
    ["cmp_best", "cmp_mid", "cmp_small"]
  );
});

test("runPerformanceCompare ranks by relative change and keeps supporting metrics", async () => {
  const store = new FakePerformanceStore([
    row("2026-05-01", { nodeKey: "cmp_up", spendMicros: 10_000_000n }),
    row("2026-05-08", { nodeKey: "cmp_up", spendMicros: 20_000_000n }),
    row("2026-05-01", { nodeKey: "cmp_down", spendMicros: 10_000_000n }),
    row("2026-05-08", { nodeKey: "cmp_down", spendMicros: 5_000_000n }),
  ]);
  const result = await runPerformanceCompare({
    store,
    input: {
      accountId: "acc-1",
      level: "campaign",
      currentWindow: { since: "2026-05-08", until: "2026-05-08" },
      baselineWindow: { since: "2026-05-01", until: "2026-05-01" },
      metric: "spend",
      rank: "top",
      limit: 2,
    },
  });
  assert.equal(result.rows[0]?.nodeKey, "cmp_up");
  assert.equal(result.rows[0]?.relativeChange, 1);
  assert.equal(result.rows[0]?.currentSupporting.spendMajor, 20);
});
