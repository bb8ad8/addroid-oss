import {
  compareProportions,
  confidenceLabel,
  scoreAnomaly,
  type ConfidenceLabel,
} from "./stats.js";
import { deriveMetrics, microsToMajorUnit } from "./metrics.js";

export type AnomalyHierarchy = "account" | "campaign" | "adset" | "ad";
export type AnomalyMetric =
  | "spend"
  | "ctr"
  | "cvr"
  | "cpa"
  | "conversions"
  | "frequency"
  | "impressions";
export type AnomalyKind = "spike" | "drop" | "trend";
export type AnomalySeverity = "high" | "medium" | "low";

export interface SnapshotSeriesRow {
  hierarchy: AnomalyHierarchy;
  nodeKey: string;
  displayName?: string | null;
  metricDate: string;
  spendMicros: bigint;
  impressions: number;
  clicks: number;
  conversions: number;
  frequency?: number | null;
}

export interface NodeAnomalyFinding {
  hierarchy: AnomalyHierarchy;
  nodeKey: string;
  displayName: string;
  metric: AnomalyMetric;
  kind: AnomalyKind;
  zScore: number | null;
  currentValue: number;
  baselineValue: number;
  relativeChange: number | null;
  confidence: ConfidenceLabel;
  severity: AnomalySeverity;
}

export interface AnomalyDetectionResult {
  findings: NodeAnomalyFinding[];
  evaluatedNodeCount: number;
  quietDay: boolean;
}

export interface AnomalyDetectionStore {
  listSnapshotSeries(input: {
    accountId: string;
    nodeTypes: AnomalyHierarchy[];
    since: string;
    until: string;
  }): Promise<SnapshotSeriesRow[]>;
}

export async function detectAnomalies(opts: {
  store: AnomalyDetectionStore;
  accountId: string;
  targetDate: string;
  lookbackDays?: number;
  maxFindings?: number;
}): Promise<AnomalyDetectionResult> {
  const lookbackDays = opts.lookbackDays ?? 14;
  const maxFindings = opts.maxFindings ?? 8;
  const since = addUtcDays(opts.targetDate, -lookbackDays);
  const rows = await opts.store.listSnapshotSeries({
    accountId: opts.accountId,
    nodeTypes: ["account", "campaign", "adset", "ad"],
    since,
    until: opts.targetDate,
  });

  const groups = new Map<string, SnapshotSeriesRow[]>();
  for (const row of rows) {
    const key = `${row.hierarchy}:${row.nodeKey}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const findings: NodeAnomalyFinding[] = [];
  let evaluatedNodeCount = 0;
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.metricDate.localeCompare(b.metricDate));
    const current = sorted.find((row) => row.metricDate === opts.targetDate);
    if (!current) continue;
    const history = sorted.filter((row) => row.metricDate < opts.targetDate);
    evaluatedNodeCount += 1;
    findings.push(...detectNodeFindings(current, history));
  }

  findings.sort(compareFindings);
  const limited = findings.slice(0, Math.max(0, maxFindings));
  return {
    findings: limited,
    evaluatedNodeCount,
    quietDay: limited.length === 0,
  };
}

function detectNodeFindings(
  current: SnapshotSeriesRow,
  history: SnapshotSeriesRow[],
): NodeAnomalyFinding[] {
  const out: NodeAnomalyFinding[] = [];
  const currentMetrics = rowMetrics(current);
  const historyMetrics = history.map(rowMetrics);
  const confidence = confidenceLabel(current.conversions, current.impressions);

  for (const metric of ["spend", "impressions", "conversions"] as const) {
    const currentValue = currentMetrics[metric];
    if (currentValue === null) continue;
    const historyValues = historyMetrics
      .map((row) => row[metric])
      .filter((value): value is number => value !== null);
    const score = scoreAnomaly(historyValues, currentValue);
    if (!score.isAnomaly || score.direction === "flat") continue;
    const baselineValue = average(historyValues);
    out.push({
      hierarchy: current.hierarchy,
      nodeKey: current.nodeKey,
      displayName: displayName(current),
      metric,
      kind: score.direction === "up" ? "spike" : "drop",
      zScore: round(score.zScore),
      currentValue: roundNumber(currentValue),
      baselineValue: roundNumber(baselineValue),
      relativeChange: relativeChange(currentValue, baselineValue),
      confidence,
      severity: severityFor(metric, relativeChange(currentValue, baselineValue), false),
    });
  }

  out.push(...detectProportionFinding(current, history, "ctr"));
  out.push(...detectProportionFinding(current, history, "cvr"));

  const frequencyBaseline = average(
    historyMetrics
      .map((row) => row.frequency)
      .filter((value): value is number => value !== null),
  );
  if (
    currentMetrics.frequency !== null &&
    frequencyBaseline > 0 &&
    currentMetrics.frequency > 3.5 &&
    currentMetrics.frequency / frequencyBaseline - 1 >= 0.2
  ) {
    out.push({
      hierarchy: current.hierarchy,
      nodeKey: current.nodeKey,
      displayName: displayName(current),
      metric: "frequency",
      kind: "trend",
      zScore: null,
      currentValue: roundNumber(currentMetrics.frequency),
      baselineValue: roundNumber(frequencyBaseline),
      relativeChange: relativeChange(currentMetrics.frequency, frequencyBaseline),
      confidence,
      severity: "low",
    });
  }

  return out;
}

function detectProportionFinding(
  current: SnapshotSeriesRow,
  history: SnapshotSeriesRow[],
  metric: "ctr" | "cvr",
): NodeAnomalyFinding[] {
  const baseline =
    metric === "ctr"
      ? {
          successes: sum(history, (row) => row.clicks),
          trials: sum(history, (row) => row.impressions),
        }
      : {
          successes: sum(history, (row) => row.conversions),
          trials: sum(history, (row) => row.clicks),
        };
  const today =
    metric === "ctr"
      ? { successes: current.clicks, trials: current.impressions }
      : { successes: current.conversions, trials: current.clicks };
  const compared = compareProportions(baseline, today);
  if (
    compared.verdict !== "significant_increase" &&
    compared.verdict !== "significant_decrease"
  ) {
    return [];
  }
  const confidence = confidenceLabel(current.conversions, current.impressions);
  if (confidence === "insufficient") return [];
  const baselineValue = baseline.trials > 0 ? baseline.successes / baseline.trials : 0;
  const currentValue = today.trials > 0 ? today.successes / today.trials : 0;
  return [
    {
      hierarchy: current.hierarchy,
      nodeKey: current.nodeKey,
      displayName: displayName(current),
      metric,
      kind: compared.verdict === "significant_increase" ? "spike" : "drop",
      zScore: null,
      currentValue: roundNumber(currentValue),
      baselineValue: roundNumber(baselineValue),
      relativeChange: compared.relativeChange === null ? null : round(compared.relativeChange),
      confidence,
      severity: "medium",
    },
  ];
}

function rowMetrics(row: SnapshotSeriesRow): {
  spend: number;
  impressions: number;
  conversions: number;
  cpa: number | null;
  frequency: number | null;
} {
  const derived = deriveMetrics({
    impressions: row.impressions,
    clicks: row.clicks,
    spendMicros: row.spendMicros,
    conversions: row.conversions,
    frequency: row.frequency ?? null,
  });
  return {
    spend: microsToMajorUnit(row.spendMicros),
    impressions: Math.max(0, Math.floor(row.impressions)),
    conversions: Math.max(0, Math.floor(row.conversions)),
    cpa: derived.cpaMajor,
    frequency:
      typeof row.frequency === "number" && Number.isFinite(row.frequency)
        ? row.frequency
        : null,
  };
}

function severityFor(
  metric: AnomalyMetric,
  change: number | null,
  trend: boolean,
): AnomalySeverity {
  if (trend) return "low";
  if (metric === "spend" && change !== null && Math.abs(change) >= 0.5) {
    return "high";
  }
  return "medium";
}

function compareFindings(a: NodeAnomalyFinding, b: NodeAnomalyFinding): number {
  const severity = severityRank(b.severity) - severityRank(a.severity);
  if (severity !== 0) return severity;
  const rel = Math.abs(b.relativeChange ?? 0) - Math.abs(a.relativeChange ?? 0);
  if (rel !== 0) return rel;
  return Math.abs(b.zScore ?? 0) - Math.abs(a.zScore ?? 0);
}

function severityRank(severity: AnomalySeverity): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function displayName(row: SnapshotSeriesRow): string {
  return row.displayName?.trim() || row.nodeKey;
}

function average(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function relativeChange(current: number, baseline: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
    return null;
  }
  return round(current / baseline - 1);
}

function round(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundNumber(value: number): number {
  return round(value) ?? 0;
}

function sum(rows: SnapshotSeriesRow[], pick: (row: SnapshotSeriesRow) => number): number {
  return rows.reduce((total, row) => {
    const value = pick(row);
    return total + (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  }, 0);
}

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
