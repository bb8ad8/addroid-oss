// AdDroid OSS — Daily Reports page (the current implementation browser regression fix).
//
// Browser test scenario `daily-report-analytics` は `/reports/daily` に直接
// アクセスし、(1) KPI フィールド spend/impressions/clicks/CTR/CPC/CV/CPA/
// frequency が表示される、(2) report run の状態または空状態が見える、
// (3) snapshot に裏付けられた analytics 状態または空状態が見える、ことを期待
// する。本ページは `cron_runs` (name="daily_report" / "today_report") と
// `performance_snapshots` を Prisma で直接読み出して描画する read-only な
// SSR ページ。実データが無い場合は ガードレール「No Placeholder Data」に従い
// 明示的な空状態 UI を出す。

import Link from "next/link";
import { wilsonInterval } from "@addroid/queue";
import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { PageHeader } from "../../../components/ui/PageHeader";
import { DataTable, type DataTableColumn } from "../../../components/ui/DataTable";
import { Pagination } from "../../../components/ui/Pagination";
import { EmptyState } from "../../../components/ui/EmptyState";
import { KeyValueList, type KeyValueEntry } from "../../../components/ui/KeyValueList";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StatusDot, type StatusState } from "../../../components/ui/StatusDot";
import { InlineCode } from "../../../components/ui/CodeBlock";
import { RunCronButton } from "../../../components/RunCronButton";
import { formatDateTime, formatStoredDateOnly, resolveDisplayTimeZone } from "../../../lib/datetime";
import { ensureWebWorkspace } from "../../../lib/meta-runtime";
import { getPaginationState, paginationLabel } from "../../../lib/pagination";
import { firstSearchParam } from "../../../lib/search-params";

export const dynamic = "force-dynamic";

interface KpiSet {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpa: number;
  cv: number;
  cpm: number;
  frequency: number | null;
}

interface ImprovementCandidate {
  hierarchy: string;
  target: string;
  rationale: string;
  expectedImpact: string;
}

interface DailyReportSummary {
  status: string;
  workspaceId: string;
  accountKey: string;
  accountId: string | null;
  currency: string | null;
  metricDate: string;
  priorMetricDate: string;
  metricTimeZone: string;
  insightsSource: string;
  current: KpiSet;
  prior: KpiSet;
  deltas: Record<string, string>;
  statisticalContext: StatisticalContext;
  snapshotIds: string[];
  aiCommentary: string | null;
  topImprovements: ImprovementCandidate[];
  aiRunId: string | null;
  errorMessage?: string;
  mode: string;
}

interface StatisticalComparison {
  metric: string;
  verdict: string;
  pApprox: number | null;
  relativeChange: number | null;
  minTrialsMet: boolean;
}

interface StatisticalContext {
  comparisons: StatisticalComparison[];
  confidence: "reliable" | "indicative" | "insufficient";
}

interface CronRunRow {
  id: string;
  name: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

interface SnapshotRow {
  id: string;
  accountId: string;
  nodeType: string;
  nodeKey: string;
  metricDate: Date;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
  frequency: number | { toNumber(): number } | null;
  linkClicks: number | null;
  source: string;
  createdAt: Date;
}

interface AdAccountTimeZoneRow {
  workspaceId: string;
  key: string;
  timezoneName: string | null;
}

interface SearchParamsInput {
  runId?: string | string[];
  runsPage?: string | string[];
  snapshotsPage?: string | string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function readKpi(v: unknown): KpiSet {
  if (!isRecord(v)) {
    return {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpc: 0,
      cpa: 0,
      cv: 0,
      cpm: 0,
      frequency: null,
    };
  }
  return {
    spend: readNumber(v.spend),
    impressions: readNumber(v.impressions),
    clicks: readNumber(v.clicks),
    conversions: readNumber(v.conversions),
    ctr: readNumber(v.ctr),
    cpc: readNumber(v.cpc),
    cpa: readNumber(v.cpa),
    cv: readNumber(v.cv),
    cpm: readNumber(v.cpm),
    frequency: readNullableNumber(v.frequency),
  };
}

function parseDailyReportSummary(output: unknown): DailyReportSummary | null {
  if (!isRecord(output)) return null;
  // status / workspaceId / accountKey が欠ければ daily_report の output として扱わない。
  if (
    typeof output.status !== "string" ||
    typeof output.workspaceId !== "string" ||
    typeof output.accountKey !== "string"
  ) {
    return null;
  }
  const deltasRaw = isRecord(output.deltas) ? output.deltas : {};
  const deltas: Record<string, string> = {};
  for (const [k, v] of Object.entries(deltasRaw)) {
    if (typeof v === "string") deltas[k] = v;
  }
  const snapshotIds = Array.isArray(output.snapshotIds)
    ? output.snapshotIds.filter((x): x is string => typeof x === "string")
    : [];
  const topImprovements = Array.isArray(output.topImprovements)
    ? output.topImprovements
        .filter(isRecord)
        .map((row) => ({
          hierarchy: readString(row.hierarchy),
          target: readString(row.target),
          rationale: readString(row.rationale),
          expectedImpact: readString(row.expectedImpact),
        }))
    : [];
  const statisticalContext = parseStatisticalContext(output.statisticalContext);
  return {
    status: output.status,
    workspaceId: output.workspaceId,
    accountKey: output.accountKey,
    accountId: typeof output.accountId === "string" ? output.accountId : null,
    currency: typeof output.currency === "string" ? output.currency : null,
    metricDate: readString(output.metricDate),
    priorMetricDate: readString(output.priorMetricDate),
    metricTimeZone: readString(output.metricTimeZone, "UTC"),
    insightsSource: readString(output.insightsSource, "unavailable"),
    current: readKpi(output.current),
    prior: readKpi(output.prior),
    deltas,
    statisticalContext,
    snapshotIds,
    aiCommentary:
      typeof output.aiCommentary === "string" ? output.aiCommentary : null,
    topImprovements,
    aiRunId: typeof output.aiRunId === "string" ? output.aiRunId : null,
    ...(typeof output.errorMessage === "string"
      ? { errorMessage: output.errorMessage }
      : {}),
    mode: readString(output.mode, "report_only"),
  };
}

function parseStatisticalContext(value: unknown): StatisticalContext {
  if (!isRecord(value)) return { comparisons: [], confidence: "insufficient" };
  const confidence =
    value.confidence === "reliable" ||
    value.confidence === "indicative" ||
    value.confidence === "insufficient"
      ? value.confidence
      : "insufficient";
  const comparisons = Array.isArray(value.comparisons)
    ? value.comparisons.filter(isRecord).map((row) => ({
        metric: readString(row.metric),
        verdict: readString(row.verdict, "insufficient_data"),
        pApprox: readNullableNumber(row.pApprox),
        relativeChange: readNullableNumber(row.relativeChange),
        minTrialsMet: row.minTrialsMet === true,
      }))
    : [];
  return { comparisons, confidence };
}

function parseDailyReportSummaries(output: unknown): DailyReportSummary[] {
  if (isRecord(output) && Array.isArray(output.accounts)) {
    return output.accounts
      .map(parseDailyReportSummary)
      .filter((x): x is DailyReportSummary => x !== null);
  }
  const single = parseDailyReportSummary(output);
  return single ? [single] : [];
}

function cronStateToStatus(state: string): StatusState {
  switch (state) {
    case "success":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    default:
      return "idle";
  }
}

function cronStateLabel(state: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
    skipped: "スキップ",
  };
  return labels[state] ?? state;
}

function reportRunLabel(name: string): string {
  const labels: Record<string, string> = {
    daily_report: "前日分",
    today_report: "当日分",
  };
  return labels[name] ?? name;
}

function reportSummaryStatusToState(status: string): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "no_account":
    case "no_insights":
      return "warn";
    case "ai_failed":
      return "error";
    default:
      return "idle";
  }
}

function reportStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    succeeded: "取得済み",
    no_account: "対象なし",
    no_insights: "データなし",
    ai_failed: "AIコメント失敗",
  };
  return labels[status] ?? status;
}

function hierarchyLabel(nodeType: string): string {
  const labels: Record<string, string> = {
    account: "広告アカウント",
    campaign: "キャンペーン",
    adset: "広告セット",
    ad: "広告",
  };
  return labels[nodeType] ?? nodeType;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    meta_cli: "Meta",
    meta_graph: "Meta",
    mock: "テストデータ",
  };
  return labels[source] ?? source;
}

function modeToState(mode: string): StatusState {
  switch (mode) {
    case "auto_apply":
      return "warn";
    case "proposal":
      return "info";
    case "report_only":
    default:
      return "idle";
  }
}

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    auto_apply: "自動反映候補",
    proposal: "提案",
    report_only: "レポートのみ",
  };
  return labels[mode] ?? mode;
}

function microsToMajor(micros: bigint): number {
  const div = Number(micros / 1_000_000n);
  const rem = Number(micros % 1_000_000n) / 1_000_000;
  return div + rem;
}

function formatNumber(n: number, fractionDigits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatCurrency(n: number, currency: string | null): string {
  const amount = formatNumber(n, 2);
  return currency ? `${amount} ${currency}` : amount;
}

function formatPercent(n: number): string {
  return `${formatNumber(n, 2)}%`;
}

function formatFrequency(n: number | null): string {
  return n === null ? "—" : formatNumber(n, 2);
}

function decimalToNumber(value: number | { toNumber(): number } | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null && typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatNullablePercent(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
}

function formatDelta(value: string | undefined): string {
  return value && value.length > 0 ? value : "—";
}

function formatRate(n: number | null): string {
  return n === null ? "—" : formatPercent(n * 100);
}

function cvr(k: KpiSet): number | null {
  return k.clicks > 0 ? k.conversions / k.clicks : null;
}

function formatWilson(successes: number, trials: number): string {
  const ci = wilsonInterval(successes, trials);
  if (ci.lower === null || ci.upper === null) return "95% CI —";
  return `95% CI ${formatPercent(ci.lower * 100)}–${formatPercent(ci.upper * 100)}`;
}

interface KpiCellProps {
  label: string;
  value: string;
  delta: string;
  hint?: string;
}

function KpiCell({ label, value, delta, hint }: KpiCellProps) {
  return (
    <div className="kpi-cell">
      <div className="kpi-cell__label">{label}</div>
      <div
        className="kpi-cell__value tabular-nums"
        style={{ fontFamily: "var(--font-mono)", fontSize: "1.25rem", fontWeight: 600 }}
      >
        {value}
      </div>
      <div
        className="kpi-cell__delta tabular-nums"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.8125rem",
          color: "var(--color-text-secondary)",
        }}
      >
        Δ {delta}
      </div>
      {hint ? (
        <div
          className="kpi-cell__hint"
          style={{
            fontSize: "0.75rem",
            color: "var(--color-text-tertiary)",
            marginTop: "0.125rem",
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function reportKpiRows(summary: DailyReportSummary): {
  label: string;
  valueOf: (k: KpiSet) => string;
  deltaKey: string;
  hint?: string;
}[] {
  const currency = summary.currency;
  return [
    {
      label: "Spend",
      valueOf: (k) => formatCurrency(k.spend, currency),
      deltaKey: "spend",
    },
    { label: "Impressions", valueOf: (k) => formatNumber(k.impressions), deltaKey: "impressions" },
    { label: "Clicks", valueOf: (k) => formatNumber(k.clicks), deltaKey: "clicks" },
    {
      label: "CTR",
      valueOf: (k) => formatPercent(k.ctr),
      deltaKey: "ctr",
      hint: formatWilson(summary.current.clicks, summary.current.impressions),
    },
    {
      label: "CVR",
      valueOf: (k) => formatRate(cvr(k)),
      deltaKey: "cvr",
      hint: formatWilson(summary.current.conversions, summary.current.clicks),
    },
    {
      label: "CPC",
      valueOf: (k) => formatCurrency(k.cpc, currency),
      deltaKey: "cpc",
    },
    {
      label: "CV",
      valueOf: (k) => formatNumber(k.conversions),
      deltaKey: "conversions",
      hint: "= conversions",
    },
    {
      label: "CPA",
      valueOf: (k) => formatCurrency(k.cpa, currency),
      deltaKey: "cpa",
    },
    { label: "Frequency", valueOf: (k) => formatFrequency(k.frequency), deltaKey: "frequency" },
  ];
}

function comparisonBadgeState(verdict: string): StatusState {
  switch (verdict) {
    case "significant_increase":
      return "ok";
    case "significant_decrease":
      return "warn";
    case "insufficient_data":
      return "warn";
    case "not_significant":
    default:
      return "idle";
  }
}

function comparisonBadgeLabel(comparison: StatisticalComparison): string {
  const metric = comparison.metric.toUpperCase();
  switch (comparison.verdict) {
    case "significant_increase":
      return `${metric}: 有意な増加`;
    case "significant_decrease":
      return `${metric}: 有意な低下`;
    case "not_significant":
      return `${metric}: 有意差なし`;
    case "insufficient_data":
    default:
      return `${metric}: 参考値 (サンプル不足)`;
  }
}

function confidenceBadge(summary: DailyReportSummary) {
  const labels: Record<StatisticalContext["confidence"], string> = {
    reliable: "統計信頼度: 高",
    indicative: "統計信頼度: 参考",
    insufficient: "統計信頼度: サンプル不足",
  };
  const state: Record<StatisticalContext["confidence"], StatusState> = {
    reliable: "ok",
    indicative: "info",
    insufficient: "warn",
  };
  const confidence = summary.statisticalContext.confidence;
  return <StatusBadge state={state[confidence]}>{labels[confidence]}</StatusBadge>;
}

function summaryItems(summary: DailyReportSummary, displayTimeZone: string): KeyValueEntry[] {
  return [
    {
      label: "広告アカウント",
      value: <InlineCode>{summary.accountKey}</InlineCode>,
    },
    {
      label: "対象日",
      value: (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {summary.metricDate || "—"}
          {summary.priorMetricDate ? ` (vs ${summary.priorMetricDate})` : ""}
        </span>
      ),
    },
    {
      label: "タイムゾーン",
      value: <InlineCode>{displayTimeZone}</InlineCode>,
    },
    {
      label: "通貨",
      value: summary.currency ? <InlineCode>{summary.currency}</InlineCode> : <span>—</span>,
    },
    {
      label: "取得元",
      value: sourceLabel(summary.insightsSource),
    },
    {
      label: "取得結果",
      value: (
        <StatusBadge state={reportSummaryStatusToState(summary.status)}>
          {reportStatusLabel(summary.status)}
        </StatusBadge>
      ),
    },
    {
      label: "実行モード",
      value: (
        <StatusBadge state={modeToState(summary.mode)}>
          {modeLabel(summary.mode)}
        </StatusBadge>
      ),
    },
    {
      label: "保存データ",
      value:
        summary.snapshotIds.length === 0 ? (
          <span>—</span>
        ) : (
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {summary.snapshotIds.length} 件 ({summary.snapshotIds.slice(0, 4).join(", ")}
            {summary.snapshotIds.length > 4 ? ", …" : ""})
          </span>
        ),
    },
    {
      label: "AI実行ID",
      value: summary.aiRunId ? <InlineCode>{summary.aiRunId}</InlineCode> : <span>—</span>,
    },
  ];
}

function DailyReportDetail({
  summary,
  displayTimeZone,
}: {
  summary: DailyReportSummary;
  displayTimeZone: string;
}) {
  const kpiRows = reportKpiRows(summary);
  return (
    <div style={{ display: "grid", gap: "1.25rem" }}>
      <KeyValueList items={summaryItems(summary, displayTimeZone)} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "0.75rem",
        }}
      >
        {kpiRows.map((kpi) => (
          <KpiCell
            key={kpi.label}
            label={kpi.label}
            value={kpi.valueOf(summary.current)}
            delta={formatDelta(summary.deltas[kpi.deltaKey])}
            {...(kpi.hint ? { hint: kpi.hint } : {})}
          />
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {confidenceBadge(summary)}
        {summary.statisticalContext.comparisons.map((comparison) => (
          <StatusBadge
            key={`${comparison.metric}:${comparison.verdict}`}
            state={comparisonBadgeState(comparison.verdict)}
          >
            {comparisonBadgeLabel(comparison)}
          </StatusBadge>
        ))}
      </div>

      {summary.aiCommentary ? (
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--color-text-secondary)",
              marginBottom: "0.25rem",
            }}
          >
            AIコメント
          </div>
          <p style={{ margin: 0 }}>{summary.aiCommentary}</p>
        </div>
      ) : null}

      {summary.topImprovements.length > 0 ? (
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--color-text-secondary)",
              marginBottom: "0.25rem",
            }}
          >
            改善候補
          </div>
          <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {summary.topImprovements.map((imp, idx) => (
              <li key={idx} style={{ marginBottom: "0.25rem" }}>
                <InlineCode>{imp.hierarchy}</InlineCode> <InlineCode>{imp.target}</InlineCode> —{" "}
                {imp.rationale}
                {imp.expectedImpact ? (
                  <span
                    style={{
                      color: "var(--color-text-secondary)",
                      marginLeft: "0.25rem",
                    }}
                  >
                    ({imp.expectedImpact})
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {summary.errorMessage ? (
        <div
          style={{
            fontSize: "0.8125rem",
            color: "var(--color-status-error)",
          }}
        >
          {summary.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function combinedReportStatus(summaries: DailyReportSummary[]): StatusState {
  if (summaries.length === 0) return "idle";
  if (summaries.some((s) => reportSummaryStatusToState(s.status) === "error")) return "error";
  if (summaries.some((s) => reportSummaryStatusToState(s.status) === "warn")) return "warn";
  if (summaries.some((s) => reportSummaryStatusToState(s.status) === "ok")) return "ok";
  return "idle";
}

export default async function ReportsDailyPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  const selectedRunId = firstSearchParam(resolvedSearchParams?.runId) ?? null;
  let runs: CronRunRow[] = [];
  let latestRunCandidates: CronRunRow[] = [];
  let selectedRunFromQuery: CronRunRow | null = null;
  let snapshots: SnapshotRow[] = [];
  let runsTotal = 0;
  let snapshotsTotal = 0;
  let adAccountTimeZones: AdAccountTimeZoneRow[] = [];
  let dbReady = true;
  try {
    const workspace = await ensureWebWorkspace();
    const runsWhere = {
      name: { in: ["daily_report", "today_report"] },
      OR: [
        { schedule: { is: { workspaceId: workspace.id } } },
        { executionLogs: { some: { workspaceId: workspace.id } } },
      ],
    };
    const snapshotsWhere = { account: { workspaceId: workspace.id } };
    [runsTotal, snapshotsTotal] = await Promise.all([
      prisma.cronRun.count({ where: runsWhere }),
      prisma.performanceSnapshot.count({ where: snapshotsWhere }),
    ]);
    const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", runsTotal);
    const snapshotsPagination = getPaginationState(
      resolvedSearchParams,
      "snapshotsPage",
      snapshotsTotal
    );
    [runs, latestRunCandidates, selectedRunFromQuery, snapshots, adAccountTimeZones] = await Promise.all([
      prisma.cronRun.findMany({
        where: runsWhere,
        orderBy: { startedAt: "desc" },
        skip: runsPagination.skip,
        take: runsPagination.take,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.cronRun.findMany({
        where: runsWhere,
        orderBy: { startedAt: "desc" },
        take: 10,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      selectedRunId
        ? prisma.cronRun.findFirst({
            where: { ...runsWhere, id: selectedRunId },
            select: {
              id: true,
              name: true,
              state: true,
              startedAt: true,
              finishedAt: true,
              durationMs: true,
              errorMessage: true,
              output: true,
            },
          })
        : Promise.resolve(null),
      prisma.performanceSnapshot.findMany({
        where: snapshotsWhere,
        orderBy: [{ metricDate: "desc" }, { createdAt: "desc" }],
        skip: snapshotsPagination.skip,
        take: snapshotsPagination.take,
        select: {
          id: true,
          accountId: true,
          nodeType: true,
          nodeKey: true,
          metricDate: true,
          impressions: true,
          clicks: true,
          spendMicros: true,
          conversions: true,
          frequency: true,
          linkClicks: true,
          source: true,
          createdAt: true,
        },
      }),
      prisma.adAccount.findMany({
        where: { workspaceId: workspace.id, active: true },
        select: { workspaceId: true, key: true, timezoneName: true },
      }),
    ]);
  } catch {
    dbReady = false;
  }

  // 直近 succeeded run の output を拾う。なければ最新 run の output を拾う。
  const parsedSummaries = latestRunCandidates.flatMap((r) =>
    parseDailyReportSummaries(r.output).map((summary) => ({ run: r, summary }))
  );
  const latestSucceeded =
    parsedSummaries.find(({ summary }) => summary.status === "succeeded") ??
    parsedSummaries[0] ??
    null;
  const selectedRun = selectedRunId ? selectedRunFromQuery : null;
  const selectedSummaries = selectedRun ? parseDailyReportSummaries(selectedRun.output) : [];
  const displayedSummaries = selectedRun ? selectedSummaries : latestSucceeded ? [latestSucceeded.summary] : [];
  const showMissingSelectedRun = Boolean(selectedRunId && !selectedRun);

  const runsCount = runsTotal;
  const snapshotsCount = snapshotsTotal;
  const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", runsTotal);
  const snapshotsPagination = getPaginationState(
    resolvedSearchParams,
    "snapshotsPage",
    snapshotsTotal
  );
  const timeZoneByAccount = new Map(
    adAccountTimeZones.map((row) => [`${row.workspaceId}:${row.key}`, row.timezoneName])
  );
  const summaryTimeZone = (summary: DailyReportSummary | null): string =>
    resolveDisplayTimeZone(
      summary ? timeZoneByAccount.get(`${summary.workspaceId}:${summary.accountKey}`) : null,
      summary?.metricTimeZone
    );
  const pageDisplayTimeZone = displayedSummaries[0]
    ? summaryTimeZone(displayedSummaries[0])
    : resolveDisplayTimeZone();
  const runTimeZone = (row: CronRunRow): string => {
    const summary = parseDailyReportSummaries(row.output)[0] ?? null;
    return summary ? summaryTimeZone(summary) : pageDisplayTimeZone;
  };

  const runColumns: DataTableColumn<CronRunRow>[] = [
    {
      header: "開始日時",
      cell: (row) => formatDateTime(row.startedAt, { timeZone: runTimeZone(row) }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "種別",
      cell: (row) => reportRunLabel(row.name),
    },
    {
      header: "実行状態",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>{cronStateLabel(row.state)}</StatusBadge>
      ),
    },
    {
      header: "広告アカウント",
      cell: (row) => {
        const summaries = parseDailyReportSummaries(row.output);
        const first = summaries[0] ?? null;
        if (!first) return <span>—</span>;
        return (
          <span>
            <InlineCode>{first.accountKey}</InlineCode>
            {summaries.length > 1 ? (
              <span style={{ color: "var(--color-text-secondary)", marginLeft: "0.25rem" }}>
                +{summaries.length - 1}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      header: "対象日",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary && summary.metricDate ? (
          <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {summary.metricDate}
          </span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "取得結果",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? (
          <StatusBadge state={reportSummaryStatusToState(summary.status)}>
            {reportStatusLabel(summary.status)}
          </StatusBadge>
        ) : (
          <span>—</span>
        );
      },
    },
    {
      header: "保存データ",
      cell: (row) => {
        const summary = parseDailyReportSummaries(row.output)[0] ?? null;
        return summary ? (
          <span className="tabular-nums">{summary.snapshotIds.length}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "所要時間",
      cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "表示",
      cell: (row) => {
        const summaries = parseDailyReportSummaries(row.output);
        if (summaries.length === 0) return <span>—</span>;
        return (
          <Link
            href={`/reports/daily?runId=${encodeURIComponent(row.id)}#report-detail`}
            className="btn btn--ghost btn--sm"
            aria-current={row.id === selectedRunId ? "true" : undefined}
          >
            {row.id === selectedRunId ? "表示中" : "表示"}
          </Link>
        );
      },
    },
  ];

  const snapshotColumns: DataTableColumn<SnapshotRow>[] = [
    {
      header: "日付",
      cell: (row) => formatStoredDateOnly(row.metricDate),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "階層",
      cell: (row) => hierarchyLabel(row.nodeType),
    },
    {
      header: "対象",
      cell: (row) => <InlineCode>{row.nodeKey}</InlineCode>,
    },
    {
      header: "表示回数",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.impressions)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "クリック",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.clicks)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "CTR",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNullablePercent(row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "CPM",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.impressions > 0
            ? formatNumber((microsToMajor(row.spendMicros) / row.impressions) * 1000, 2)
            : "—"}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "Frequency",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatFrequency(decimalToNumber(row.frequency))}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "利用金額",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(microsToMajor(row.spendMicros), 2)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "成果",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatNumber(row.conversions)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "取得元",
      cell: (row) => sourceLabel(row.source),
    },
  ];

  const latestSummaryStatus: StatusState = !dbReady
    ? "warn"
    : showMissingSelectedRun
      ? "warn"
    : selectedRun
      ? combinedReportStatus(selectedSummaries)
    : latestSucceeded
      ? combinedReportStatus([latestSucceeded.summary])
      : "idle";
  const latestSummaryStatusLabel = !dbReady
    ? "warn"
    : showMissingSelectedRun
      ? "履歴なし"
    : selectedRun
      ? `${selectedSummaries.length} 件`
    : latestSucceeded
      ? reportStatusLabel(latestSucceeded.summary.status)
      : "未実行";
  const reportPanelTitle = selectedRun ? "過去レポート" : "最新レポート";
  const reportPanelSubtitle = selectedRun
    ? `${formatDateTime(selectedRun.startedAt, { timeZone: pageDisplayTimeZone })} に実行したレポート`
    : "直近に取得した広告アカウント全体のKPIとAIコメント";

  return (
    <>
      <PageHeader
        title="日次レポート"
        subtitle={
          <>
            広告成果のKPIとAIコメントを確認します。この画面からMetaの広告設定は変更しません。
          </>
        }
        actions={
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <RunCronButton presetName="daily_report" label="前日分を取得" />
            <RunCronButton presetName="today_report" label="当日分を取得" />
          </div>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title={reportPanelTitle}
          subtitle={reportPanelSubtitle}
          status={
            <StatusDot state={latestSummaryStatus}>{latestSummaryStatusLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="日次レポートを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : showMissingSelectedRun ? (
            <EmptyState
              title="指定された実行履歴が見つかりません"
              description="下の実行履歴から表示するレポートを選び直してください。"
            />
          ) : displayedSummaries.length === 0 ? (
            <EmptyState
              title={selectedRun ? "この実行には表示できるレポートがありません" : "日次レポートはまだ実行されていません"}
              description={
                selectedRun
                  ? "実行履歴には残っていますが、レポート本文に必要な出力が保存されていません。"
                  : "自動実行画面から日次レポートを有効化するか、ホームのチャットから依頼すると、ここに成果とAIコメントが表示されます。"
              }
            />
          ) : (
            <div id="report-detail" style={{ display: "grid", gap: "1.5rem" }}>
              {selectedRun ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    実行ID <InlineCode>{selectedRun.id}</InlineCode>
                  </span>
                  <Link href="/reports/daily" className="btn btn--ghost btn--sm">
                    最新に戻る
                  </Link>
                </div>
              ) : null}
              {displayedSummaries.map((summary, idx) => (
                <div
                  key={`${summary.accountKey}:${summary.metricDate}:${idx}`}
                  style={{
                    display: "grid",
                    gap: "1.25rem",
                    ...(idx > 0
                      ? {
                          borderTop: "1px solid var(--color-border-subtle)",
                          paddingTop: "1.5rem",
                        }
                      : {}),
                  }}
                >
                  {displayedSummaries.length > 1 ? (
                    <div
                      style={{
                        fontSize: "0.875rem",
                        fontWeight: 600,
                      }}
                    >
                      <InlineCode>{summary.accountKey}</InlineCode>
                    </div>
                  ) : null}
                  <DailyReportDetail summary={summary} displayTimeZone={summaryTimeZone(summary)} />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="実行履歴"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : paginationLabel(runsPagination)
          }
          status={
            <StatusDot state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "要確認" : runsCount === 0 ? "未実行" : `${runsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="日次レポートの実行履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <div>
              <DataTable
                rows={runs}
                rowKey={(row) => row.id}
                columns={runColumns}
                empty={
                  <EmptyState
                    title="日次レポートはまだ実行されていません"
                    description="自動実行を有効化すると、各回の状態・対象日・所要時間がここに記録されます。"
                  />
                }
              />
              <Pagination
                basePath="/reports/daily"
                searchParams={resolvedSearchParams}
                pageParam="runsPage"
                state={runsPagination}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="保存された成果データ"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : paginationLabel(snapshotsPagination)
          }
          status={
            <StatusDot state={!dbReady ? "warn" : snapshotsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "要確認" : snapshotsCount === 0 ? "未保存" : `${snapshotsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="成果データを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <div>
              <DataTable
                rows={snapshots}
                rowKey={(row) => row.id}
                columns={snapshotColumns}
                empty={
                  <EmptyState
                    title="保存された成果データはまだありません"
                    description="日次レポートが実行されると、広告アカウント、キャンペーン、広告セット、広告ごとの成果がここに保存されます。"
                  />
                }
              />
              <Pagination
                basePath="/reports/daily"
                searchParams={resolvedSearchParams}
                pageParam="snapshotsPage"
                state={snapshotsPagination}
              />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
