import test from "node:test";
import assert from "node:assert/strict";
import {
  detectAnomalies,
  type AnomalyDetectionStore,
  type SnapshotSeriesRow,
} from "../index.js";

class FakeAnomalyStore implements AnomalyDetectionStore {
  constructor(private readonly rows: SnapshotSeriesRow[]) {}
  async listSnapshotSeries(input: Parameters<AnomalyDetectionStore["listSnapshotSeries"]>[0]) {
    return this.rows.filter(
      (row) =>
        input.nodeTypes.includes(row.hierarchy) &&
        row.metricDate >= input.since &&
        row.metricDate <= input.until,
    );
  }
}

function row(
  metricDate: string,
  overrides: Partial<SnapshotSeriesRow> = {},
): SnapshotSeriesRow {
  return {
    hierarchy: "campaign",
    nodeKey: "cmp_1",
    displayName: "Campaign 1",
    metricDate,
    spendMicros: 100_000_000n,
    impressions: 1000,
    clicks: 50,
    conversions: 10,
    frequency: 1.5,
    ...overrides,
  };
}

function history(
  nodeKey: string,
  values: number[],
  pick: "spend" | "impressions" | "conversions",
): SnapshotSeriesRow[] {
  return values.map((value, idx) => {
    const metricDate = `2026-05-${String(idx + 1).padStart(2, "0")}`;
    if (pick === "spend") {
      return row(metricDate, {
        nodeKey,
        displayName: nodeKey,
        spendMicros: BigInt(Math.round(value * 1_000_000)),
      });
    }
    if (pick === "impressions") {
      return row(metricDate, { nodeKey, displayName: nodeKey, impressions: value });
    }
    return row(metricDate, { nodeKey, displayName: nodeKey, conversions: value });
  });
}

test("detectAnomalies detects spend spike with high severity", async () => {
  const rows = [
    ...history("cmp_spend", [100, 110, 90, 105, 95, 100], "spend"),
    row("2026-05-07", {
      nodeKey: "cmp_spend",
      displayName: "Spend spike",
      spendMicros: 180_000_000n,
    }),
  ];
  const result = await detectAnomalies({
    store: new FakeAnomalyStore(rows),
    accountId: "acc-1",
    targetDate: "2026-05-07",
    lookbackDays: 6,
  });
  assert.equal(result.quietDay, false);
  assert.equal(result.evaluatedNodeCount, 1);
  assert.equal(result.findings[0]!.metric, "spend");
  assert.equal(result.findings[0]!.kind, "spike");
  assert.equal(result.findings[0]!.severity, "high");
});

test("detectAnomalies detects count drops", async () => {
  const rows = [
    ...history("cmp_drop", [1000, 1100, 900, 1050, 950, 1000], "impressions"),
    row("2026-05-07", {
      nodeKey: "cmp_drop",
      impressions: 200,
    }),
  ];
  const result = await detectAnomalies({
    store: new FakeAnomalyStore(rows),
    accountId: "acc-1",
    targetDate: "2026-05-07",
    lookbackDays: 6,
  });
  assert.equal(result.findings[0]!.metric, "impressions");
  assert.equal(result.findings[0]!.kind, "drop");
  assert.equal(result.findings[0]!.severity, "medium");
});

test("detectAnomalies detects significant CTR changes and skips insufficient ratios", async () => {
  const enoughHistory = Array.from({ length: 14 }, (_, idx) =>
    row(`2026-05-${String(idx + 1).padStart(2, "0")}`, {
      nodeKey: "cmp_ctr",
      impressions: 1000,
      clicks: 20,
      conversions: 8,
    }),
  );
  const insufficientHistory = Array.from({ length: 4 }, (_, idx) =>
    row(`2026-05-${String(idx + 1).padStart(2, "0")}`, {
      nodeKey: "cmp_small",
      impressions: 20,
      clicks: 1,
      conversions: 0,
    }),
  );
  const result = await detectAnomalies({
    store: new FakeAnomalyStore([
      ...enoughHistory,
      row("2026-05-15", {
        nodeKey: "cmp_ctr",
        impressions: 1000,
        clicks: 80,
        conversions: 10,
      }),
      ...insufficientHistory,
      row("2026-05-15", {
        nodeKey: "cmp_small",
        impressions: 20,
        clicks: 10,
        conversions: 0,
      }),
    ]),
    accountId: "acc-1",
    targetDate: "2026-05-15",
  });
  assert.ok(result.findings.some((finding) => finding.metric === "ctr"));
  assert.ok(!result.findings.some((finding) => finding.nodeKey === "cmp_small"));
});

test("detectAnomalies detects frequency trend", async () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, idx) =>
      row(`2026-05-${String(idx + 1).padStart(2, "0")}`, {
        nodeKey: "adset_freq",
        hierarchy: "adset",
        frequency: 3.0,
      }),
    ),
    row("2026-05-08", {
      nodeKey: "adset_freq",
      hierarchy: "adset",
      frequency: 3.8,
    }),
  ];
  const result = await detectAnomalies({
    store: new FakeAnomalyStore(rows),
    accountId: "acc-1",
    targetDate: "2026-05-08",
  });
  assert.equal(result.findings[0]!.metric, "frequency");
  assert.equal(result.findings[0]!.kind, "trend");
  assert.equal(result.findings[0]!.severity, "low");
});

test("detectAnomalies returns quietDay when no findings exist", async () => {
  const rows = [
    ...history("cmp_quiet", [100, 101, 99, 100, 102, 98], "spend"),
    row("2026-05-07", {
      nodeKey: "cmp_quiet",
      spendMicros: 101_000_000n,
    }),
  ];
  const result = await detectAnomalies({
    store: new FakeAnomalyStore(rows),
    accountId: "acc-1",
    targetDate: "2026-05-07",
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.quietDay, true);
});

test("detectAnomalies sorts by severity and applies maxFindings", async () => {
  const rows = [
    ...history("cmp_high", [100, 110, 90, 105, 95, 100], "spend"),
    row("2026-05-07", {
      nodeKey: "cmp_high",
      spendMicros: 180_000_000n,
    }),
    ...history("cmp_medium", [1000, 1100, 900, 1050, 950, 1000], "impressions"),
    row("2026-05-07", {
      nodeKey: "cmp_medium",
      impressions: 200,
    }),
  ];
  const result = await detectAnomalies({
    store: new FakeAnomalyStore(rows),
    accountId: "acc-1",
    targetDate: "2026-05-07",
    maxFindings: 1,
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.severity, "high");
  assert.equal(result.findings[0]!.nodeKey, "cmp_high");
});
