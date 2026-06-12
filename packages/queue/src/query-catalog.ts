import { z } from "zod";
import { deriveMetrics, microsToMajorUnit } from "./metrics.js";
import {
  INDICATIVE_MIN_CONVERSIONS,
  INDICATIVE_MIN_IMPRESSIONS,
} from "./stats.js";
import {
  buildCreativePerformanceDigest,
  type CreativePerformanceStore,
} from "./creative-performance.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 90;

export const QueryWindowSchema = z
  .union([
    z
      .object({
        preset: z.enum(["today", "yesterday", "last_7d", "last_14d", "last_30d"]),
      })
      .strict(),
    z
      .object({
        since: z.string().regex(DATE_RE, "since must be YYYY-MM-DD"),
        until: z.string().regex(DATE_RE, "until must be YYYY-MM-DD"),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if ("since" in value && daysBetween(value.since, value.until) > MAX_WINDOW_DAYS - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "window must be 90 days or shorter",
        path: ["until"],
      });
    }
    if ("since" in value && value.until < value.since) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "until must be on or after since",
        path: ["until"],
      });
    }
  });

export const PerformanceMetricSchema = z.enum([
  "spend",
  "impressions",
  "clicks",
  "conversions",
  "ctr",
  "cpc",
  "cpm",
  "cpa",
  "frequency",
]);

export const PerformanceQuerySchema = z
  .object({
    accountId: z.string().min(1),
    level: z.enum(["account", "campaign", "adset", "ad"]),
    window: QueryWindowSchema,
    metric: PerformanceMetricSchema,
    rank: z.enum(["top", "bottom"]).default("top"),
    limit: z.number().int().min(1).max(20).default(5),
    statusFilter: z.enum(["active", "paused", "all"]).default("all"),
  })
  .strict();

export const PerformanceCompareSchema = z
  .object({
    accountId: z.string().min(1),
    level: z.enum(["account", "campaign", "adset", "ad"]),
    currentWindow: QueryWindowSchema,
    baselineWindow: QueryWindowSchema,
    metric: PerformanceMetricSchema,
    rank: z.enum(["top", "bottom"]).default("top"),
    limit: z.number().int().min(1).max(20).default(5),
    statusFilter: z.enum(["active", "paused", "all"]).default("all"),
  })
  .strict();

export const CreativeQuerySchema = z
  .object({
    accountId: z.string().min(1),
    window: QueryWindowSchema,
    metric: z.enum(["spend", "impressions", "clicks", "conversions", "ctr", "cpa"]).default("ctr"),
    rank: z.enum(["top", "bottom"]).default("top"),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export type QueryWindowInput = z.infer<typeof QueryWindowSchema>;
export type PerformanceMetric = z.infer<typeof PerformanceMetricSchema>;
export type PerformanceQueryInput = z.input<typeof PerformanceQuerySchema>;
export type ParsedPerformanceQueryInput = z.infer<typeof PerformanceQuerySchema>;
export type PerformanceCompareInput = z.input<typeof PerformanceCompareSchema>;
export type ParsedPerformanceCompareInput = z.infer<typeof PerformanceCompareSchema>;
export type CreativeQueryInput = z.input<typeof CreativeQuerySchema>;
export type ParsedCreativeQueryInput = z.infer<typeof CreativeQuerySchema>;
export type PerformanceLevel = ParsedPerformanceQueryInput["level"];
export type PerformanceRank = ParsedPerformanceQueryInput["rank"];
export type PerformanceStatusFilter = ParsedPerformanceQueryInput["statusFilter"];

export interface ResolvedQueryWindow {
  since: string;
  until: string;
  label: string;
}

export interface PerformanceSnapshotQueryRow {
  nodeKey: string;
  displayName?: string | null;
  status?: string | null;
  metricDate: string | Date;
  spendMicros: bigint | number;
  impressions: number;
  clicks: number;
  conversions: number;
  frequency?: number | null;
}

export interface PerformanceQueryStore {
  listPerformanceSnapshots(input: {
    accountId: string;
    level: PerformanceLevel;
    since: string;
    until: string;
    statusFilter: PerformanceStatusFilter;
  }): Promise<PerformanceSnapshotQueryRow[]>;
}

export interface PerformanceQuerySupportingMetrics {
  spendMajor: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface PerformanceQueryRow {
  nodeKey: string;
  displayName: string;
  status: string | null;
  value: number | null;
  supporting: PerformanceQuerySupportingMetrics;
  lowSample: boolean;
}

export interface PerformanceQueryResult {
  kind: "performance_query";
  accountId: string;
  level: PerformanceLevel;
  metric: PerformanceMetric;
  rank: PerformanceRank;
  window: ResolvedQueryWindow;
  rows: PerformanceQueryRow[];
}

export interface PerformanceCompareRow {
  nodeKey: string;
  displayName: string;
  status: string | null;
  currentValue: number | null;
  baselineValue: number | null;
  absoluteChange: number | null;
  relativeChange: number | null;
  currentSupporting: PerformanceQuerySupportingMetrics;
  baselineSupporting: PerformanceQuerySupportingMetrics;
  lowSample: boolean;
}

export interface PerformanceCompareResult {
  kind: "performance_compare";
  accountId: string;
  level: PerformanceLevel;
  metric: PerformanceMetric;
  rank: PerformanceRank;
  currentWindow: ResolvedQueryWindow;
  baselineWindow: ResolvedQueryWindow;
  rows: PerformanceCompareRow[];
}

export interface CreativeQueryResult {
  kind: "creative_query";
  accountId: string;
  metric: ParsedCreativeQueryInput["metric"];
  rank: PerformanceRank;
  window: ResolvedQueryWindow;
  rows: PerformanceQueryRow[];
}

interface AggregateBucket {
  nodeKey: string;
  displayName: string;
  status: string | null;
  impressions: number;
  clicks: number;
  conversions: number;
  spendMicros: bigint;
  frequencyNumerator: number;
  frequencyWeight: number;
  frequencyFallbackSum: number;
  frequencyFallbackCount: number;
}

export async function runPerformanceQuery(opts: {
  store: PerformanceQueryStore;
  input: PerformanceQueryInput;
  now?: Date;
}): Promise<PerformanceQueryResult> {
  const input = PerformanceQuerySchema.parse(opts.input);
  const window = resolveQueryWindow(input.window, opts.now);
  const rows = await opts.store.listPerformanceSnapshots({
    accountId: input.accountId,
    level: input.level,
    since: window.since,
    until: window.until,
    statusFilter: input.statusFilter,
  });
  const resultRows = sortQueryRows(
    [...aggregatePerformanceRows(rows).values()].map((bucket) => toQueryRow(bucket, input.metric)),
    input.rank
  ).slice(0, input.limit);
  return {
    kind: "performance_query",
    accountId: input.accountId,
    level: input.level,
    metric: input.metric,
    rank: input.rank,
    window,
    rows: resultRows,
  };
}

export async function runPerformanceCompare(opts: {
  store: PerformanceQueryStore;
  input: PerformanceCompareInput;
  now?: Date;
}): Promise<PerformanceCompareResult> {
  const input = PerformanceCompareSchema.parse(opts.input);
  const currentWindow = resolveQueryWindow(input.currentWindow, opts.now);
  const baselineWindow = resolveQueryWindow(input.baselineWindow, opts.now);
  const [currentRows, baselineRows] = await Promise.all([
    opts.store.listPerformanceSnapshots({
      accountId: input.accountId,
      level: input.level,
      since: currentWindow.since,
      until: currentWindow.until,
      statusFilter: input.statusFilter,
    }),
    opts.store.listPerformanceSnapshots({
      accountId: input.accountId,
      level: input.level,
      since: baselineWindow.since,
      until: baselineWindow.until,
      statusFilter: input.statusFilter,
    }),
  ]);
  const current = aggregatePerformanceRows(currentRows);
  const baseline = aggregatePerformanceRows(baselineRows);
  const keys = new Set([...current.keys(), ...baseline.keys()]);
  const rows = [...keys].map((key) => {
    const currentBucket = current.get(key) ?? emptyBucket(key, baseline.get(key));
    const baselineBucket = baseline.get(key) ?? emptyBucket(key, current.get(key));
    const currentRow = toQueryRow(currentBucket, input.metric);
    const baselineRow = toQueryRow(baselineBucket, input.metric);
    const absoluteChange =
      currentRow.value === null || baselineRow.value === null
        ? null
        : currentRow.value - baselineRow.value;
    const relativeChange =
      absoluteChange === null || baselineRow.value === null || baselineRow.value === 0
        ? null
        : absoluteChange / baselineRow.value;
    return {
      nodeKey: currentRow.nodeKey,
      displayName: currentRow.displayName,
      status: currentRow.status,
      currentValue: currentRow.value,
      baselineValue: baselineRow.value,
      absoluteChange,
      relativeChange,
      currentSupporting: currentRow.supporting,
      baselineSupporting: baselineRow.supporting,
      lowSample: currentRow.lowSample || baselineRow.lowSample,
    };
  });
  return {
    kind: "performance_compare",
    accountId: input.accountId,
    level: input.level,
    metric: input.metric,
    rank: input.rank,
    currentWindow,
    baselineWindow,
    rows: sortCompareRows(rows, input.rank).slice(0, input.limit),
  };
}

export async function runCreativePerformanceQuery(opts: {
  store: CreativePerformanceStore;
  input: CreativeQueryInput;
  now?: Date;
}): Promise<CreativeQueryResult> {
  const input = CreativeQuerySchema.parse(opts.input);
  const window = resolveQueryWindow(input.window, opts.now);
  const digest = await buildCreativePerformanceDigest({
    store: opts.store,
    accountId: input.accountId,
    since: window.since,
    until: window.until,
    maxEntries: input.limit,
  });
  const rows = digest.entries.map((entry) => {
    const supporting = {
      spendMajor: entry.metrics.spendMajor,
      impressions: entry.metrics.impressions,
      clicks: entry.metrics.clicks,
      conversions: entry.metrics.conversions,
    };
    return {
      nodeKey: entry.creativeKey,
      displayName: entry.displayName,
      status: null,
      value: creativeMetricValue(entry.metrics, input.metric),
      supporting,
      lowSample: entry.confidence === "insufficient",
    };
  });
  return {
    kind: "creative_query",
    accountId: input.accountId,
    metric: input.metric,
    rank: input.rank,
    window,
    rows: sortQueryRows(rows, input.rank).slice(0, input.limit),
  };
}

export function resolveQueryWindow(input: QueryWindowInput, now = new Date()): ResolvedQueryWindow {
  if ("since" in input) {
    return { since: input.since, until: input.until, label: `${input.since}..${input.until}` };
  }
  const today = toUtcDateString(now);
  if (input.preset === "today") return { since: today, until: today, label: "today" };
  const yesterday = addUtcDays(today, -1);
  if (input.preset === "yesterday") {
    return { since: yesterday, until: yesterday, label: "yesterday" };
  }
  const days = input.preset === "last_7d" ? 7 : input.preset === "last_14d" ? 14 : 30;
  return {
    since: addUtcDays(today, -(days - 1)),
    until: today,
    label: input.preset,
  };
}

export function formatQueryCatalogValidationError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function isQueryCatalogValidationError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError;
}

function aggregatePerformanceRows(rows: PerformanceSnapshotQueryRow[]): Map<string, AggregateBucket> {
  const buckets = new Map<string, AggregateBucket>();
  for (const row of rows) {
    const key = row.nodeKey;
    const bucket = buckets.get(key) ?? {
      nodeKey: key,
      displayName: row.displayName?.trim() || key,
      status: normalizeStatus(row.status),
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spendMicros: 0n,
      frequencyNumerator: 0,
      frequencyWeight: 0,
      frequencyFallbackSum: 0,
      frequencyFallbackCount: 0,
    };
    bucket.displayName = row.displayName?.trim() || bucket.displayName;
    bucket.status = normalizeStatus(row.status) ?? bucket.status;
    bucket.impressions += normalizeCount(row.impressions);
    bucket.clicks += normalizeCount(row.clicks);
    bucket.conversions += normalizeCount(row.conversions);
    bucket.spendMicros += normalizeSpendMicros(row.spendMicros);
    const frequency = normalizeNullableNumber(row.frequency);
    if (frequency !== null) {
      const impressions = normalizeCount(row.impressions);
      if (impressions > 0) {
        bucket.frequencyNumerator += frequency * impressions;
        bucket.frequencyWeight += impressions;
      } else {
        bucket.frequencyFallbackSum += frequency;
        bucket.frequencyFallbackCount += 1;
      }
    }
    buckets.set(key, bucket);
  }
  return buckets;
}

function toQueryRow(bucket: AggregateBucket, metric: PerformanceMetric): PerformanceQueryRow {
  const supporting = {
    spendMajor: microsToMajorUnit(bucket.spendMicros),
    impressions: bucket.impressions,
    clicks: bucket.clicks,
    conversions: bucket.conversions,
  };
  return {
    nodeKey: bucket.nodeKey,
    displayName: bucket.displayName,
    status: bucket.status,
    value: metricValue(bucket, metric),
    supporting,
    lowSample: isLowSample(bucket, metric),
  };
}

function metricValue(bucket: AggregateBucket, metric: PerformanceMetric): number | null {
  const metrics = deriveMetrics({
    impressions: bucket.impressions,
    clicks: bucket.clicks,
    conversions: bucket.conversions,
    spendMicros: bucket.spendMicros,
    frequency: resolveFrequency(bucket),
  });
  switch (metric) {
    case "spend":
      return metrics.spendMajor;
    case "impressions":
      return bucket.impressions;
    case "clicks":
      return bucket.clicks;
    case "conversions":
      return bucket.conversions;
    case "ctr":
      return metrics.ctr;
    case "cpc":
      return metrics.cpcMajor;
    case "cpm":
      return metrics.cpmMajor;
    case "cpa":
      return metrics.cpaMajor;
    case "frequency":
      return resolveFrequency(bucket);
  }
}

function creativeMetricValue(
  metrics: { spendMajor: number; impressions: number; clicks: number; conversions: number; ctr: number | null; cpaMajor: number | null },
  metric: ParsedCreativeQueryInput["metric"]
): number | null {
  switch (metric) {
    case "spend":
      return metrics.spendMajor;
    case "impressions":
      return metrics.impressions;
    case "clicks":
      return metrics.clicks;
    case "conversions":
      return metrics.conversions;
    case "ctr":
      return metrics.ctr;
    case "cpa":
      return metrics.cpaMajor;
  }
}

function resolveFrequency(bucket: AggregateBucket): number | null {
  if (bucket.frequencyWeight > 0) return bucket.frequencyNumerator / bucket.frequencyWeight;
  if (bucket.frequencyFallbackCount > 0) return bucket.frequencyFallbackSum / bucket.frequencyFallbackCount;
  return null;
}

function sortQueryRows(rows: PerformanceQueryRow[], rank: PerformanceRank): PerformanceQueryRow[] {
  return rows.sort((a, b) => compareRanked(a.value, b.value, a.lowSample, b.lowSample, rank));
}

function sortCompareRows(rows: PerformanceCompareRow[], rank: PerformanceRank): PerformanceCompareRow[] {
  return rows.sort((a, b) =>
    compareRanked(a.relativeChange, b.relativeChange, a.lowSample, b.lowSample, rank)
  );
}

function compareRanked(
  aValue: number | null,
  bValue: number | null,
  aLowSample: boolean,
  bLowSample: boolean,
  rank: PerformanceRank
): number {
  if (aLowSample !== bLowSample) return aLowSample ? 1 : -1;
  if (aValue === null && bValue === null) return 0;
  if (aValue === null) return 1;
  if (bValue === null) return -1;
  return rank === "top" ? bValue - aValue : aValue - bValue;
}

function isLowSample(bucket: AggregateBucket, metric: PerformanceMetric): boolean {
  if (bucket.impressions < INDICATIVE_MIN_IMPRESSIONS) return true;
  if ((metric === "cpa" || metric === "conversions") && bucket.conversions < INDICATIVE_MIN_CONVERSIONS) {
    return true;
  }
  if ((metric === "ctr" || metric === "cpc") && bucket.clicks < INDICATIVE_MIN_CONVERSIONS) {
    return true;
  }
  return false;
}

function emptyBucket(key: string, fallback?: AggregateBucket): AggregateBucket {
  return {
    nodeKey: key,
    displayName: fallback?.displayName ?? key,
    status: fallback?.status ?? null,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendMicros: 0n,
    frequencyNumerator: 0,
    frequencyWeight: 0,
    frequencyFallbackSum: 0,
    frequencyFallbackCount: 0,
  };
}

function normalizeStatus(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeSpendMicros(value: bigint | number): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toUtcDateString(date);
}

function daysBetween(since: string, until: string): number {
  const start = Date.parse(`${since}T00:00:00.000Z`);
  const end = Date.parse(`${until}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.floor((end - start) / 86_400_000);
}
