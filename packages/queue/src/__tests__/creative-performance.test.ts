import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreativePerformanceDigest,
  creativePerformanceGeneInsightLines,
  type CreativePerformanceJoinedRow,
  type CreativePerformanceStore,
} from "../index.js";

class FakeCreativePerformanceStore implements CreativePerformanceStore {
  constructor(private readonly rows: CreativePerformanceJoinedRow[]) {}
  async listAdCreativePerformance() {
    return this.rows;
  }
}

test("buildCreativePerformanceDigest joins snapshots to the latest creative and marks ambiguity", async () => {
  const rows = [
    row({
      snapshotId: "snap-1",
      creativeId: "creative-old",
      updatedAt: "2026-05-01T00:00:00.000Z",
      clicks: 10,
    }),
    row({
      snapshotId: "snap-1",
      creativeId: "creative-new",
      creativeKey: "new-key",
      updatedAt: "2026-05-02T00:00:00.000Z",
      clicks: 10,
    }),
    row({
      snapshotId: "snap-2",
      nodeType: "campaign",
      creativeId: "ignored-non-ad",
    }),
  ];
  const digest = await buildCreativePerformanceDigest({
    store: new FakeCreativePerformanceStore(rows),
    accountId: "acc-1",
    since: "2026-05-01",
    until: "2026-05-28",
  });

  assert.equal(digest.entries.length, 1);
  assert.equal(digest.entries[0]!.creativeId, "creative-new");
  assert.equal(digest.entries[0]!.creativeKey, "new-key");
  assert.equal(digest.entries[0]!.ambiguous, true);
});

test("buildCreativePerformanceDigest classifies insufficient, winner, loser, and neutral by CTR", async () => {
  const digest = await buildCreativePerformanceDigest({
    store: new FakeCreativePerformanceStore([
      row({ creativeId: "winner", clicks: 200, conversions: 10, impressions: 2000, spendMicros: 0n }),
      row({ creativeId: "neutral", clicks: 100, conversions: 10, impressions: 2000, spendMicros: 0n }),
      row({ creativeId: "neutral-2", clicks: 100, conversions: 10, impressions: 2000, spendMicros: 0n }),
      row({ creativeId: "loser", clicks: 20, conversions: 10, impressions: 2000, spendMicros: 0n }),
      row({ creativeId: "small", clicks: 5, conversions: 0, impressions: 2000, spendMicros: 0n }),
    ]),
    accountId: "acc-1",
    since: "2026-05-01",
    until: "2026-05-28",
  });
  const byId = new Map(digest.entries.map((entry) => [entry.creativeId, entry]));
  assert.equal(byId.get("winner")?.verdict, "winner");
  assert.equal(byId.get("loser")?.verdict, "loser");
  assert.equal(byId.get("small")?.verdict, "insufficient_data");
  assert.equal(byId.get("neutral")?.verdict, "neutral");
  assert.deepEqual(digest.winners.map((entry) => entry.creativeId), ["winner"]);
  assert.deepEqual(digest.losers.map((entry) => entry.creativeId), ["loser"]);
});

test("buildCreativePerformanceDigest prioritizes CPA when median CPA is available", async () => {
  const digest = await buildCreativePerformanceDigest({
    store: new FakeCreativePerformanceStore([
      row({ creativeId: "low-cpa", clicks: 100, conversions: 10, spendMicros: 10_000_000n }),
      row({ creativeId: "mid-cpa", clicks: 100, conversions: 10, spendMicros: 20_000_000n }),
      row({ creativeId: "high-cpa", clicks: 100, conversions: 10, spendMicros: 30_000_000n }),
    ]),
    accountId: "acc-1",
    since: "2026-05-01",
    until: "2026-05-28",
  });
  const byId = new Map(digest.entries.map((entry) => [entry.creativeId, entry]));
  assert.equal(byId.get("low-cpa")?.verdict, "winner");
  assert.equal(byId.get("mid-cpa")?.verdict, "neutral");
  assert.equal(byId.get("high-cpa")?.verdict, "loser");
});

test("buildCreativePerformanceDigest builds gene insights and skips null genes", async () => {
  const digest = await buildCreativePerformanceDigest({
    store: new FakeCreativePerformanceStore([
      row({ creativeId: "price-1", genes: genes(["price"], "casual", "product"), clicks: 100 }),
      row({ creativeId: "price-2", genes: genes(["price"], "casual", "product"), clicks: 200 }),
      row({ creativeId: "null-genes", genes: null, clicks: 300 }),
    ]),
    accountId: "acc-1",
    since: "2026-05-01",
    until: "2026-05-28",
  });
  const price = digest.geneInsights.find(
    (insight) => insight.dimension === "appealAxis" && insight.value === "price"
  );
  assert.ok(price);
  assert.equal(price.creativeCount, 2);
  assert.ok(Math.abs((price.avgCtr ?? 0) - 0.075) < 0.000001);
  assert.deepEqual(creativePerformanceGeneInsightLines(digest), [
    "訴求軸=price: 平均CTR 7.5% / 平均CPA 0 (2件)",
    "被写体=product: 平均CTR 7.5% / 平均CPA 0 (2件)",
    "トーン=casual: 平均CTR 7.5% / 平均CPA 0 (2件)",
  ]);
});

function row(opts: {
  snapshotId?: string;
  accountId?: string;
  nodeType?: string;
  nodeKey?: string;
  creativeId?: string;
  creativeKey?: string;
  updatedAt?: string;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  spendMicros?: bigint;
  genes?: unknown;
} = {}): CreativePerformanceJoinedRow {
  const accountId = opts.accountId ?? "acc-1";
  const nodeType = opts.nodeType ?? "ad";
  const nodeKey = opts.nodeKey ?? "ad-1";
  const creativeId = opts.creativeId ?? "creative-1";
  return {
    snapshotRow: {
      id: opts.snapshotId ?? `snap-${creativeId}`,
      accountId,
      nodeType,
      nodeKey,
      metricDate: "2026-05-10",
      impressions: opts.impressions ?? 2000,
      clicks: opts.clicks ?? 100,
      conversions: opts.conversions ?? 10,
      spendMicros: opts.spendMicros ?? 0n,
    },
    hierarchyRow: {
      id: `hier-${nodeKey}`,
      accountId,
      nodeType,
      nodeKey,
      displayName: nodeKey,
    },
    creativeRow: {
      id: creativeId,
      key: opts.creativeKey ?? creativeId,
      displayName: creativeId,
      genes: opts.genes === undefined ? genes(["benefit"], "calm", "product") : opts.genes,
      spec: {
        adText: {
          headline: `headline ${creativeId}`,
          primaryText: `primary ${creativeId}`,
        },
      },
      prompt: `prompt ${creativeId}`,
      status: "active_on_meta",
      updatedAt: opts.updatedAt ?? "2026-05-01T00:00:00.000Z",
    },
  };
}

function genes(
  appealAxes: string[],
  tone: string,
  subjectType: string
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    appealAxes,
    tone,
    subjectType,
    colorScheme: "bright",
    layout: "single_focus",
    hasTextOverlay: false,
    hasCta: true,
    language: "ja",
  };
}
