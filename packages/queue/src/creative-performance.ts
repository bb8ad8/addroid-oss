import {
  describeGenesForPrompt,
  parseCreativeGenes,
  type CreativeGenes,
} from "@addroid/llm-provider";
import { deriveMetrics } from "./metrics.js";
import {
  compareProportions,
  confidenceLabel,
  type ConfidenceLabel,
} from "./stats.js";

export interface CreativePerformanceEntry {
  creativeId: string;
  creativeKey: string;
  displayName: string;
  genes: CreativeGenes | null;
  headline: string | null;
  primaryText: string | null;
  prompt: string | null;
  metrics: {
    impressions: number;
    clicks: number;
    conversions: number;
    spendMajor: number;
    ctr: number | null;
    cpaMajor: number | null;
  };
  confidence: ConfidenceLabel;
  verdict: "winner" | "loser" | "neutral" | "insufficient_data";
  ambiguous?: boolean;
}

export interface CreativePerformanceDigest {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  entries: CreativePerformanceEntry[];
  winners: CreativePerformanceEntry[];
  losers: CreativePerformanceEntry[];
  geneInsights: Array<{
    dimension: "appealAxis" | "tone" | "subjectType";
    value: string;
    creativeCount: number;
    avgCtr: number | null;
    avgCpaMajor: number | null;
  }>;
}

export interface CreativePerformanceSnapshotRow {
  id: string;
  accountId: string;
  nodeType: string;
  nodeKey: string;
  metricDate: Date | string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendMicros: bigint | number;
}

export interface CreativePerformanceHierarchyRow {
  id: string;
  accountId: string;
  nodeType: string;
  nodeKey: string;
  displayName: string;
}

export interface CreativePerformanceCreativeRow {
  id: string;
  key: string;
  displayName: string;
  genes: unknown;
  spec: unknown;
  prompt: string | null;
  status: string;
  updatedAt: Date | string;
}

export interface CreativePerformanceJoinedRow {
  snapshotRow: CreativePerformanceSnapshotRow;
  hierarchyRow: CreativePerformanceHierarchyRow;
  creativeRow: CreativePerformanceCreativeRow;
  ambiguous?: boolean;
}

export interface CreativePerformanceStore {
  listAdCreativePerformance(input: {
    accountId: string;
    since: string;
    until: string;
  }): Promise<CreativePerformanceJoinedRow[]>;
}

interface AggregateEntry {
  creative: CreativePerformanceCreativeRow;
  impressions: number;
  clicks: number;
  conversions: number;
  spendMicros: bigint;
  ambiguous: boolean;
}

const DEFAULT_MAX_ENTRIES = 5;

export async function buildCreativePerformanceDigest(opts: {
  store: CreativePerformanceStore;
  accountId: string;
  since: string;
  until: string;
  maxEntries?: number;
}): Promise<CreativePerformanceDigest> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const rows = await opts.store.listAdCreativePerformance({
    accountId: opts.accountId,
    since: opts.since,
    until: opts.until,
  });

  const aggregates = new Map<string, AggregateEntry>();
  for (const row of selectLatestCreativeRows(rows)) {
    if (row.snapshotRow.nodeType !== "ad") continue;
    if (row.snapshotRow.accountId !== opts.accountId) continue;
    if (row.hierarchyRow.id === "" || row.creativeRow.id === "") continue;
    const existing = aggregates.get(row.creativeRow.id);
    if (existing) {
      existing.impressions += normalizeCount(row.snapshotRow.impressions);
      existing.clicks += normalizeCount(row.snapshotRow.clicks);
      existing.conversions += normalizeCount(row.snapshotRow.conversions);
      existing.spendMicros += normalizeSpendMicros(row.snapshotRow.spendMicros);
      existing.ambiguous ||= Boolean(row.ambiguous);
    } else {
      aggregates.set(row.creativeRow.id, {
        creative: row.creativeRow,
        impressions: normalizeCount(row.snapshotRow.impressions),
        clicks: normalizeCount(row.snapshotRow.clicks),
        conversions: normalizeCount(row.snapshotRow.conversions),
        spendMicros: normalizeSpendMicros(row.snapshotRow.spendMicros),
        ambiguous: Boolean(row.ambiguous),
      });
    }
  }

  const medianCtr = median(
    [...aggregates.values()]
      .map((a) => (a.impressions > 0 ? a.clicks / a.impressions : null))
      .filter((v): v is number => v !== null)
  );
  const medianImpressions = Math.max(
    1,
    Math.round(median([...aggregates.values()].map((a) => a.impressions)) ?? 1)
  );
  const medianCpa = median(
    [...aggregates.values()]
      .map((a) =>
        a.conversions > 0
          ? deriveMetrics({
              impressions: a.impressions,
              clicks: a.clicks,
              conversions: a.conversions,
              spendMicros: a.spendMicros,
            }).cpaMajor
          : null
      )
      .filter((v): v is number => v !== null)
  );

  const entries = [...aggregates.values()].map((aggregate) =>
    toPerformanceEntry(aggregate, medianCtr, medianImpressions, medianCpa)
  );
  const winners = entries
    .filter((entry) => entry.verdict === "winner")
    .sort(compareWinnerEntries)
    .slice(0, maxEntries);
  const losers = entries
    .filter((entry) => entry.verdict === "loser")
    .sort(compareLoserEntries)
    .slice(0, maxEntries);

  return {
    accountId: opts.accountId,
    periodStart: opts.since,
    periodEnd: opts.until,
    entries,
    winners,
    losers,
    geneInsights: buildGeneInsights(entries),
  };
}

function selectLatestCreativeRows(
  rows: CreativePerformanceJoinedRow[]
): CreativePerformanceJoinedRow[] {
  const bySnapshot = new Map<string, CreativePerformanceJoinedRow[]>();
  for (const row of rows) {
    const list = bySnapshot.get(row.snapshotRow.id);
    if (list) {
      list.push(row);
    } else {
      bySnapshot.set(row.snapshotRow.id, [row]);
    }
  }
  return [...bySnapshot.values()].map((group) => {
    const distinctCreativeIds = new Set(group.map((row) => row.creativeRow.id));
    const latest = [...group].sort(
      (a, b) => timestampMs(b.creativeRow.updatedAt) - timestampMs(a.creativeRow.updatedAt)
    )[0]!;
    return {
      ...latest,
      ambiguous: Boolean(latest.ambiguous) || distinctCreativeIds.size > 1,
    };
  });
}

export function creativePerformanceGeneInsightLines(
  digest: CreativePerformanceDigest
): string[] {
  return digest.geneInsights.map((insight) => {
    const ctr =
      insight.avgCtr === null ? "CTR n/a" : `平均CTR ${(insight.avgCtr * 100).toFixed(1)}%`;
    const cpa =
      insight.avgCpaMajor === null
        ? "CPA n/a"
        : `平均CPA ${insight.avgCpaMajor.toFixed(0)}`;
    return `${dimensionLabel(insight.dimension)}=${insight.value}: ${ctr} / ${cpa} (${insight.creativeCount}件)`;
  });
}

export function creativePerformanceExampleGenes(genes: CreativeGenes | null): string | undefined {
  return genes ? describeGenesForPrompt(genes) : undefined;
}

function toPerformanceEntry(
  aggregate: AggregateEntry,
  medianCtr: number | null,
  medianImpressions: number,
  medianCpa: number | null
): CreativePerformanceEntry {
  const metrics = deriveMetrics({
    impressions: aggregate.impressions,
    clicks: aggregate.clicks,
    conversions: aggregate.conversions,
    spendMicros: aggregate.spendMicros,
  });
  const confidence = confidenceLabel(aggregate.conversions, aggregate.impressions);
  const spec = parseCreativeSpec(aggregate.creative.spec);
  const entryMetrics = {
    impressions: aggregate.impressions,
    clicks: aggregate.clicks,
    conversions: aggregate.conversions,
    spendMajor: metrics.spendMajor,
    ctr: metrics.ctr,
    cpaMajor: metrics.cpaMajor,
  };

  return {
    creativeId: aggregate.creative.id,
    creativeKey: aggregate.creative.key,
    displayName: aggregate.creative.displayName,
    genes: parseCreativeGenes(aggregate.creative.genes),
    headline: spec.headline,
    primaryText: spec.primaryText,
    prompt: aggregate.creative.prompt,
    metrics: entryMetrics,
    confidence,
    verdict: decideVerdict({
      metrics: entryMetrics,
      confidence,
      medianCtr,
      medianImpressions,
      medianCpa,
    }),
    ...(aggregate.ambiguous ? { ambiguous: true } : {}),
  };
}

function decideVerdict(input: {
  metrics: CreativePerformanceEntry["metrics"];
  confidence: ConfidenceLabel;
  medianCtr: number | null;
  medianImpressions: number;
  medianCpa: number | null;
}): CreativePerformanceEntry["verdict"] {
  if (input.confidence === "insufficient") return "insufficient_data";
  if (input.metrics.cpaMajor !== null && input.medianCpa !== null && input.medianCpa > 0) {
    if (input.metrics.cpaMajor < input.medianCpa) return "winner";
    if (input.metrics.cpaMajor > input.medianCpa) return "loser";
    return "neutral";
  }
  if (input.medianCtr === null) return "neutral";
  const baselineSuccesses = Math.round(input.medianCtr * input.medianImpressions);
  const comparison = compareProportions(
    { successes: baselineSuccesses, trials: input.medianImpressions },
    { successes: input.metrics.clicks, trials: input.metrics.impressions }
  );
  if (comparison.verdict === "significant_increase") return "winner";
  if (comparison.verdict === "significant_decrease") return "loser";
  if (comparison.verdict === "insufficient_data") return "insufficient_data";
  return "neutral";
}

function buildGeneInsights(
  entries: CreativePerformanceEntry[]
): CreativePerformanceDigest["geneInsights"] {
  const buckets = new Map<
    string,
    {
      dimension: "appealAxis" | "tone" | "subjectType";
      value: string;
      entries: CreativePerformanceEntry[];
    }
  >();
  for (const entry of entries) {
    if (!entry.genes) continue;
    for (const axis of entry.genes.appealAxes) {
      addBucket(buckets, "appealAxis", axis, entry);
    }
    addBucket(buckets, "tone", entry.genes.tone, entry);
    addBucket(buckets, "subjectType", entry.genes.subjectType, entry);
  }
  return [...buckets.values()]
    .map((bucket) => ({
      dimension: bucket.dimension,
      value: bucket.value,
      creativeCount: bucket.entries.length,
      avgCtr: averageNullable(bucket.entries.map((entry) => entry.metrics.ctr)),
      avgCpaMajor: averageNullable(bucket.entries.map((entry) => entry.metrics.cpaMajor)),
    }))
    .sort((a, b) =>
      a.dimension === b.dimension
        ? a.value.localeCompare(b.value)
        : a.dimension.localeCompare(b.dimension)
    );
}

function addBucket(
  buckets: Map<
    string,
    {
      dimension: "appealAxis" | "tone" | "subjectType";
      value: string;
      entries: CreativePerformanceEntry[];
    }
  >,
  dimension: "appealAxis" | "tone" | "subjectType",
  value: string,
  entry: CreativePerformanceEntry
) {
  const key = `${dimension}:${value}`;
  const existing = buckets.get(key);
  if (existing) {
    existing.entries.push(entry);
  } else {
    buckets.set(key, { dimension, value, entries: [entry] });
  }
}

function parseCreativeSpec(spec: unknown): { headline: string | null; primaryText: string | null } {
  if (!isRecord(spec)) return { headline: null, primaryText: null };
  const adText = isRecord(spec.adText) ? spec.adText : spec;
  return {
    headline: readString(adText.headline),
    primaryText: readString(adText.primaryText),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function averageNullable(values: Array<number | null>): number | null {
  const clean = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function compareWinnerEntries(a: CreativePerformanceEntry, b: CreativePerformanceEntry): number {
  if (a.metrics.cpaMajor !== null && b.metrics.cpaMajor !== null) {
    return a.metrics.cpaMajor - b.metrics.cpaMajor;
  }
  return (b.metrics.ctr ?? 0) - (a.metrics.ctr ?? 0);
}

function compareLoserEntries(a: CreativePerformanceEntry, b: CreativePerformanceEntry): number {
  if (a.metrics.cpaMajor !== null && b.metrics.cpaMajor !== null) {
    return b.metrics.cpaMajor - a.metrics.cpaMajor;
  }
  return (a.metrics.ctr ?? 0) - (b.metrics.ctr ?? 0);
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeSpendMicros(value: bigint | number): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  return Number.isFinite(value) && value > 0 ? BigInt(Math.floor(value)) : 0n;
}

function timestampMs(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dimensionLabel(dimension: "appealAxis" | "tone" | "subjectType"): string {
  switch (dimension) {
    case "appealAxis":
      return "訴求軸";
    case "tone":
      return "トーン";
    case "subjectType":
      return "被写体";
  }
}
