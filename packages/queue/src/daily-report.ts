// AdDroid OSS — daily_report cron handler (Implementation item).
//
// 1 ティック分の daily_report ワークフローを実装する:
//
//   1. 対象 ad_account を解決し、当該 workspace の execution mode を取得する。
//   2. `DailyReportInsightsProvider` から account / campaign / adset / ad の
//      4 階層分の insights を取得する (real Meta CLI が未対応なら simulator)。
//   3. 取得した metrics を `performance_snapshots` に当日分 (period.end) と
//      前日分 (period.start - 1d) で upsert する (KPI delta の元データ)。
//   4. 当日 vs 前日 の KPI (spend / impressions / clicks / CTR / CPC / CV /
//      CPA / frequency) を pure に計算する。
//   5. analyst agent (`DailyReportAnalystRunner`) に集計値 + snapshot ID を渡し、
//      AI コメント + 上位 3 改善候補を生成する。生成失敗でも snapshot は保存済み。
//   6. ai_runs を `linkedRefType="performance_snapshot"` 付きで永続化し、
//      最終的な daily_report 出力 (KPI deltas + AI commentary + top
//      improvements) を cron_runs.output と execution_logs に記録する。
//
// 設計原則:
//   - Prisma / pg-boss / Meta CLI / LLM Provider を直接 import しない。
//     すべて injected interface 経由。テストは in-memory fake で完結する。
//   - AI 失敗 (analyst agent throw / decision != "report_only") は workflow 全体を
//     "ai_failed" 状態で終了させ、UI / cron_runs に user-visible なエラーを残すが
//     snapshot は破棄しない (= GitOps state は腐らない)。
//   - mode は `report_only` / `proposal` / `auto_apply` のいずれでも Meta を変更
  //     しない。daily_report は常に観測のみで、副作用は別の GitOps / automation
  //     境界が担当する。
//   - 数値計算は BigInt-safe な helper を使い、micros (Meta の通貨マイクロ単位) を
//     最小通貨単位で割って major unit に揃える (UI は currency 単位で表示)。

import type { AiRunCreateInputData } from "@addroid/llm-provider";
import type { JsonValue } from "./store.js";
import {
  mergeBreakdownsPolicy,
  selectAccountKpiSet,
  type BreakdownsPolicy,
} from "./analytics.js";
import { deriveMetrics } from "./metrics.js";

// ---------------------------------------------------------------------
// Insights provider — Meta CLI / Mock / Fixture が満たす境界
// ---------------------------------------------------------------------

export type DailyReportNodeType = "account" | "campaign" | "adset" | "ad";

export interface DailyReportInsightsRow {
  /** "account" | "campaign" | "adset" | "ad" */
  nodeType: DailyReportNodeType;
  /**
   * 階層上の安定キー。"account" の場合は ad account の identifier
   * (act_ プレフィックス推奨)。campaign/adset/ad は Meta 側 ID をそのまま使う。
   */
  nodeKey: string;
  /** UI 表示用の人間可読名。任意 (ai_runs payload に含まれる)。 */
  displayName?: string;
  /** ads_hierarchy.id への参照 (ある場合のみ)。snapshot upsert で使用。 */
  hierarchyId?: string;
  /** Meta が課金通貨マイクロ単位で返す spend。BigInt で精度を保つ。 */
  spendMicros: bigint;
  impressions: number;
  clicks: number;
  conversions: number;
  /** 平均露出回数。Meta は "frequency" を float で返す。null 可。 */
  frequency?: number | null;
  /** リーチ数。Meta は "reach" を整数文字列で返すことがある。 */
  reach?: number | null;
  /** リンククリック数。Meta field は inline_link_clicks。 */
  linkClicks?: number | null;
  /** 動画 ThruPlay。動画なし / 未取得なら null。 */
  videoThruPlays?: number | null;
  /** 3秒動画再生。動画なし / 未取得なら null。 */
  video3SecViews?: number | null;
  qualityRanking?: string | null;
  engagementRateRanking?: string | null;
  conversionRateRanking?: string | null;
}

export interface DailyReportInsightsRequest {
  accountKey: string;
  /** 対象期間の終了日 (YYYY-MM-DD)。 */
  metricDate: string;
  /** prior period (= metricDate の 1 日前) を取り込むかどうか。 */
  includePriorPeriod: boolean;
  /**
   * 取得する階層 (account / campaign / adset / ad) の方針。Meta CLI / Mock /
   * Fixture 各 provider はこれに従って `current` / `prior` を絞り込む。
   * 省略時は `DEFAULT_BREAKDOWNS_POLICY` (= 4 階層すべて取得)。
   */
  breakdownsPolicy?: BreakdownsPolicy;
}

export interface DailyReportInsightsResponse {
  /** 当日 (= metricDate) の階層別 insights。 */
  current: DailyReportInsightsRow[];
  /** 前日 (= metricDate - 1d) の階層別 insights。空でも null でもよい。 */
  prior: DailyReportInsightsRow[];
  /** 取得元の identifier (UI/audit 用)。"meta_ads_cli" / "mock" 等。 */
  source: "meta_ads_cli" | "graph_api" | "mock" | "fixture" | "unavailable";
  /** sanitized 1 行説明 (ログに残る)。 */
  detail?: string;
}

export interface DailyReportInsightsProvider {
  fetchInsights(req: DailyReportInsightsRequest): Promise<DailyReportInsightsResponse>;
}

// ---------------------------------------------------------------------
// Snapshot store — performance_snapshots / ai_runs を永続化する境界
// ---------------------------------------------------------------------

export interface PerformanceSnapshotUpsertInput {
  accountId: string;
  hierarchyId?: string | null;
  nodeType: DailyReportNodeType;
  nodeKey: string;
  metricDate: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
  reach?: number | null;
  frequency?: number | null;
  linkClicks?: number | null;
  videoThruPlays?: number | null;
  video3SecViews?: number | null;
  qualityRanking?: string | null;
  engagementRateRanking?: string | null;
  conversionRateRanking?: string | null;
  raw?: JsonValue | null;
  source: string;
}

export interface PerformanceSnapshotUpsertResult {
  /** Prisma が確定させた snapshot.id。analyst agent input + UI deep-link で使う。 */
  id: string;
  nodeType: DailyReportNodeType;
  nodeKey: string;
  metricDate: string;
}

export interface DailyReportAdAccountSnapshot {
  /** Prisma の ad_accounts.id */
  id: string;
  /** AdDroid の ad account key と一致 */
  key: string;
  displayName: string;
  /** Meta 側 ad account ID (例: act_123)。なければ null。 */
  metaAccountId: string | null;
  /** 表示通貨 (UI / commentary 用)。 */
  currency: string;
  /** Meta ad account の IANA timezone (例: Asia/Tokyo)。なければ null。 */
  timezoneName?: string | null;
}

export interface DailyReportSnapshotStore {
  /** 対象 workspace + accountKey の ad_account を返す。未登録なら null。 */
  findAdAccount(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<DailyReportAdAccountSnapshot | null>;

  /**
   * 1 行の performance_snapshots を冪等に upsert する。
   * (accountId, nodeType, nodeKey, metricDate) で unique。
   */
  upsertPerformanceSnapshot(
    input: PerformanceSnapshotUpsertInput
  ): Promise<PerformanceSnapshotUpsertResult>;

  /**
   * analyst agent の sanitized ai_runs 行を 1 行 insert する。
   * 呼び出し側 (apps/worker) は `prisma.aiRun.create({ data })` を実行する。
   */
  createAiRun(data: AiRunCreateInputData): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------
// Analyst runner — llm-provider への直接依存を queue に持ち込まないための
//   薄いラッパ。apps/worker が LLMProvider 等を埋め込んだ runner を注入する。
// ---------------------------------------------------------------------

export interface DailyReportAnalystInput {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  priorPeriodStart?: string;
  priorPeriodEnd?: string;
  current: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr?: number;
    cpc?: number;
    cpa?: number;
    frequency?: number;
    reach?: number;
    cpm?: number;
    qualityRankingSummary?: string;
  };
  prior?: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr?: number;
    cpc?: number;
    cpa?: number;
    frequency?: number;
    reach?: number;
    cpm?: number;
    qualityRankingSummary?: string;
  };
  snapshotIds: string[];
}

export interface DailyReportAnalystImprovement {
  hierarchy: DailyReportNodeType;
  target: string;
  rationale: string;
  expectedImpact: string;
}

export interface DailyReportAnalystResult {
  /** Prisma-ready ai_runs row (sanitize 済み)。 */
  aiRunInput: AiRunCreateInputData;
  /** 成功時のみ非 null。 */
  output: {
    commentary: string;
    deltas: Record<string, string>;
    topImprovements: DailyReportAnalystImprovement[];
  } | null;
  /** sanitized error message (失敗時のみ)。 */
  error: string | null;
}

export interface DailyReportAnalystRunner {
  run(input: DailyReportAnalystInput): Promise<DailyReportAnalystResult>;
}

// ---------------------------------------------------------------------
// Public orchestrator — runDailyReportOnce
// ---------------------------------------------------------------------

export type DailyReportExecutionMode = "report_only" | "proposal" | "auto_apply";

export interface RunDailyReportOptions {
  workspaceId: string;
  /** workspace 全体の execution mode (cron 起動時の値で固定する)。 */
  mode: DailyReportExecutionMode;
  /** 当該 workspace に紐付く ad_account のキー。 */
  accountKey: string;
  /**
   * 対象日 (YYYY-MM-DD)。
   * 省略時は Meta ad account timezone、fallbackTimeZone、実行環境 timezone、UTC
   * の順で timezone を決め、そのローカル日付を使う。
   */
  metricDate?: string;
  /**
   * metricDate 未指定時に、timezone 解決後のローカル日付からずらす日数。
   * daily_report は -1 (= 前日)、today_report は 0 (= 当日) を渡す。
   */
  metricDateOffsetDays?: number;
  insightsProvider: DailyReportInsightsProvider;
  store: DailyReportSnapshotStore;
  analyst: DailyReportAnalystRunner;
  /**
   * 取得する階層の方針。省略時は `DEFAULT_BREAKDOWNS_POLICY` (= 4 階層すべて
   * 取得)。partial 上書きは `mergeBreakdownsPolicy` 経由で完全な値に正規化される。
   */
  breakdownsPolicy?: Partial<BreakdownsPolicy> | null;
  /** account timezone が無い場合に使うユーザー/実行環境 timezone。 */
  fallbackTimeZone?: string | null;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

export type DailyReportRunStatus =
  | "succeeded"
  | "no_account"
  | "no_insights"
  | "ai_failed";

export interface DailyReportKpiSet {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number; // %
  cpc: number; // currency per click
  cpa: number; // currency per conversion (= cost per acquisition)
  cv: number; // = conversions (alias for UI label)
  cpm: number; // currency per 1000 impressions (informational)
  frequency: number | null;
}

export interface DailyReportImprovementCandidate {
  hierarchy: DailyReportNodeType;
  target: string;
  rationale: string;
  expectedImpact: string;
}

export interface DailyReportSummary {
  status: DailyReportRunStatus;
  workspaceId: string;
  accountKey: string;
  /** 実際に Prisma 解決した ad_account.id (status="no_account" のときは null)。 */
  accountId: string | null;
  /** 表示通貨。account が解決できない / 未指定なら null。 */
  currency: string | null;
  metricDate: string;
  priorMetricDate: string;
  /** metricDate を決定した IANA timezone。明示 metricDate 指定時も記録用に解決する。 */
  metricTimeZone: string;
  insightsSource: DailyReportInsightsResponse["source"];
  /** account 集計の KPI (UI ヘッダ用)。 */
  current: DailyReportKpiSet;
  prior: DailyReportKpiSet;
  /** UI 表示用 (`+12.3%` / `-4.5%`)。 */
  deltas: Record<string, string>;
  /** 永続化された snapshot id 一覧 (4 階層)。 */
  snapshotIds: string[];
  /** AI コメント (analyst agent succeeded のみ非 null)。 */
  aiCommentary: string | null;
  /** 上位 3 改善候補 (analyst agent succeeded のみ非空可能性あり)。 */
  topImprovements: DailyReportImprovementCandidate[];
  /** ai_runs 行の id。 */
  aiRunId: string | null;
  /** AI 失敗時の sanitized message。 */
  errorMessage?: string;
  /** 観測された execution mode (UI バッジ表示用; AI で書き換わらない)。 */
  mode: DailyReportExecutionMode;
}

const ZERO_KPIS: DailyReportKpiSet = Object.freeze({
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
});

/**
 * `runDailyReportOnce` — daily_report cron handler の純粋なオーケストレータ。
 * pg-boss handler は本関数を 1 回呼び、戻り値を `cron_runs.output` に書く。
 */
export async function runDailyReportOnce(
  opts: RunDailyReportOptions
): Promise<DailyReportSummary> {
  const now = opts.now ?? (() => new Date());

  const account = await opts.store.findAdAccount({
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
  });
  const metricTimeZone = resolveDailyReportTimeZone(
    account?.timezoneName,
    opts.fallbackTimeZone
  );
  const metricDate =
    opts.metricDate ??
    toDateStringInTimeZone(
      addUtcDays(now(), opts.metricDateOffsetDays ?? 0),
      metricTimeZone
    );
  const priorMetricDate = subtractOneUtcDay(metricDate);

  if (!account) {
    return {
      status: "no_account",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: null,
      currency: null,
      metricDate,
      priorMetricDate,
      metricTimeZone,
      insightsSource: "unavailable",
      current: ZERO_KPIS,
      prior: ZERO_KPIS,
      deltas: {},
      snapshotIds: [],
      aiCommentary: null,
      topImprovements: [],
      aiRunId: null,
      mode: opts.mode,
      errorMessage: `ad_account '${opts.accountKey}' not found in workspace`,
    };
  }

  const breakdownsPolicy = mergeBreakdownsPolicy(opts.breakdownsPolicy ?? null);
  const insights = await opts.insightsProvider.fetchInsights({
    accountKey: opts.accountKey,
    metricDate,
    includePriorPeriod: true,
    breakdownsPolicy,
  });

  const snapshotIds: string[] = [];
  for (const row of insights.current) {
    const snap = await opts.store.upsertPerformanceSnapshot({
      accountId: account.id,
      hierarchyId: row.hierarchyId ?? null,
      nodeType: row.nodeType,
      nodeKey: row.nodeKey,
      metricDate,
      impressions: row.impressions,
      clicks: row.clicks,
      spendMicros: row.spendMicros,
      conversions: row.conversions,
      reach: row.reach ?? null,
      frequency: row.frequency ?? null,
      linkClicks: row.linkClicks ?? null,
      videoThruPlays: row.videoThruPlays ?? null,
      video3SecViews: row.video3SecViews ?? null,
      qualityRanking: row.qualityRanking ?? null,
      engagementRateRanking: row.engagementRateRanking ?? null,
      conversionRateRanking: row.conversionRateRanking ?? null,
      raw: insightsRowToRaw(row),
      source: insights.source,
    });
    snapshotIds.push(snap.id);
  }
  for (const row of insights.prior) {
    await opts.store.upsertPerformanceSnapshot({
      accountId: account.id,
      hierarchyId: row.hierarchyId ?? null,
      nodeType: row.nodeType,
      nodeKey: row.nodeKey,
      metricDate: priorMetricDate,
      impressions: row.impressions,
      clicks: row.clicks,
      spendMicros: row.spendMicros,
      conversions: row.conversions,
      reach: row.reach ?? null,
      frequency: row.frequency ?? null,
      linkClicks: row.linkClicks ?? null,
      videoThruPlays: row.videoThruPlays ?? null,
      video3SecViews: row.video3SecViews ?? null,
      qualityRanking: row.qualityRanking ?? null,
      engagementRateRanking: row.engagementRateRanking ?? null,
      conversionRateRanking: row.conversionRateRanking ?? null,
      raw: insightsRowToRaw(row),
      source: insights.source,
    });
  }

  // account-level KPI を導出する。Provider が account 行を返さない (= policy の
  // `fetchAccount=false` で campaign 以下のみ取得した) 場合は、
  // `synthesizeAccountFromCampaigns` (既定 true) に従って campaign / adset / ad
  // から合成する (analytics.selectAccountKpiSet)。
  const currentSelection = selectAccountKpiSet(insights.current, {
    synthesizeAccountFromCampaigns:
      breakdownsPolicy.synthesizeAccountFromCampaigns,
  });
  const priorSelection = selectAccountKpiSet(insights.prior, {
    synthesizeAccountFromCampaigns:
      breakdownsPolicy.synthesizeAccountFromCampaigns,
  });
  const current = currentSelection.kpis;
  const prior = priorSelection.kpis;
  const deltas = computeKpiDeltas(current, prior);

  if (insights.current.length === 0) {
    return {
      status: "no_insights",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      currency: account.currency,
      metricDate,
      priorMetricDate,
      metricTimeZone,
      insightsSource: insights.source,
      current,
      prior,
      deltas,
      snapshotIds,
      aiCommentary: null,
      topImprovements: [],
      aiRunId: null,
      mode: opts.mode,
      errorMessage: insights.detail ?? "insights provider returned no rows for current period",
    };
  }

  const analystInput: DailyReportAnalystInput = {
    accountId: account.metaAccountId ?? account.key,
    periodStart: metricDate,
    periodEnd: metricDate,
    priorPeriodStart: priorMetricDate,
    priorPeriodEnd: priorMetricDate,
    current: kpiSetToAnalystMetrics(current),
    snapshotIds,
  };
  if (priorSelection.source !== "none") {
    analystInput.prior = kpiSetToAnalystMetrics(prior);
  }

  const analystResult = await opts.analyst.run(analystInput);
  const aiRunRow = await opts.store.createAiRun(analystResult.aiRunInput);

  if (!analystResult.output) {
    return {
      status: "ai_failed",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      currency: account.currency,
      metricDate,
      priorMetricDate,
      metricTimeZone,
      insightsSource: insights.source,
      current,
      prior,
      deltas,
      snapshotIds,
      aiCommentary: null,
      topImprovements: [],
      aiRunId: aiRunRow.id,
      mode: opts.mode,
      errorMessage: analystResult.error ?? "analyst agent failed",
    };
  }

  const aiDeltas = analystResult.output.deltas;
  const mergedDeltas: Record<string, string> = { ...deltas };
  for (const [k, v] of Object.entries(aiDeltas)) {
    if (typeof v === "string" && v.length > 0 && !(k in mergedDeltas)) {
      mergedDeltas[k] = v;
    }
  }

  const top = analystResult.output.topImprovements.slice(0, 3);

  return {
    status: "succeeded",
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
    accountId: account.id,
    currency: account.currency,
    metricDate,
    priorMetricDate,
    metricTimeZone,
    insightsSource: insights.source,
    current,
    prior,
    deltas: mergedDeltas,
    snapshotIds,
    aiCommentary: analystResult.output.commentary,
    topImprovements: top,
    aiRunId: aiRunRow.id,
    mode: opts.mode,
  };
}

// ---------------------------------------------------------------------
// pure helpers — daily_report KPI math (export for tests)
// ---------------------------------------------------------------------

/**
 * Meta が返す micros (e.g. JPY マイクロ円 = 100 万分の 1 円) を major unit に
 * 直し、Number に降ろす。BigInt → Number 変換時の精度損失は通常 spend では
 * 問題にならない (Number.MAX_SAFE_INTEGER ≒ 9e15)。
 */
export function microsToMajor(micros: bigint): number {
  // BigInt の division で整数部 + 余りを Number に変換して合算。
  const div = Number(micros / 1_000_000n);
  const rem = Number(micros % 1_000_000n) / 1_000_000;
  return div + rem;
}

export function toKpiSet(row: DailyReportInsightsRow): DailyReportKpiSet {
  const spend = microsToMajor(row.spendMicros);
  const impressions = Math.max(0, Math.floor(row.impressions));
  const clicks = Math.max(0, Math.floor(row.clicks));
  const conversions = Math.max(0, Math.floor(row.conversions));
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpc = clicks > 0 ? spend / clicks : 0;
  const cpa = conversions > 0 ? spend / conversions : 0;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const frequency =
    typeof row.frequency === "number" && Number.isFinite(row.frequency)
      ? row.frequency
      : null;
  return {
    spend: round6(spend),
    impressions,
    clicks,
    conversions,
    ctr: round6(ctr),
    cpc: round6(cpc),
    cpa: round6(cpa),
    cv: conversions,
    cpm: round6(cpm),
    frequency,
  };
}

export function computeKpiDeltas(
  current: DailyReportKpiSet,
  prior: DailyReportKpiSet
): Record<string, string> {
  const out: Record<string, string> = {};
  const KEYS: (keyof DailyReportKpiSet)[] = [
    "spend",
    "impressions",
    "clicks",
    "conversions",
    "ctr",
    "cpc",
    "cpa",
    "cv",
    "cpm",
    "frequency",
  ];
  for (const k of KEYS) {
    const c = numericOrZero(current[k]);
    const p = numericOrZero(prior[k]);
    out[k] = formatDelta(c, p);
  }
  return out;
}

function numericOrZero(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function formatDelta(current: number, prior: number): string {
  if (prior === 0 && current === 0) return "0%";
  if (prior === 0) {
    return current > 0 ? "+∞%" : "-∞%";
  }
  const ratio = ((current - prior) / Math.abs(prior)) * 100;
  const sign = ratio > 0 ? "+" : "";
  return `${sign}${ratio.toFixed(1)}%`;
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function kpiSetToAnalystMetrics(k: DailyReportKpiSet): {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpa: number;
  cpm: number;
  frequency?: number;
} {
  const derived = deriveMetrics({
    impressions: k.impressions,
    clicks: k.clicks,
    spendMicros: BigInt(Math.round(k.spend * 1_000_000)),
    conversions: k.conversions,
    frequency: k.frequency,
  });
  const out: {
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    cpc: number;
    cpa: number;
    cpm: number;
    frequency?: number;
  } = {
    spend: k.spend,
    impressions: k.impressions,
    clicks: k.clicks,
    conversions: k.conversions,
    ctr: derived.ctr === null ? k.ctr : round6(derived.ctr * 100),
    cpc: derived.cpcMajor === null ? k.cpc : round6(derived.cpcMajor),
    cpa: derived.cpaMajor === null ? k.cpa : round6(derived.cpaMajor),
    cpm: derived.cpmMajor === null ? k.cpm : round6(derived.cpmMajor),
  };
  if (typeof k.frequency === "number") out.frequency = k.frequency;
  return out;
}

function insightsRowToRaw(row: DailyReportInsightsRow): JsonValue {
  // spend は BigInt のため string に正規化。Prisma JSON カラムは BigInt を扱えない。
  return {
    nodeType: row.nodeType,
    nodeKey: row.nodeKey,
    displayName: row.displayName ?? null,
    spendMicros: row.spendMicros.toString(),
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    reach: row.reach ?? null,
    linkClicks: row.linkClicks ?? null,
    videoThruPlays: row.videoThruPlays ?? null,
    video3SecViews: row.video3SecViews ?? null,
    qualityRanking: row.qualityRanking ?? null,
    engagementRateRanking: row.engagementRateRanking ?? null,
    conversionRateRanking: row.conversionRateRanking ?? null,
    frequency:
      typeof row.frequency === "number" && Number.isFinite(row.frequency)
        ? row.frequency
        : null,
  };
}

/**
 * UTC 基準で `Date` を `YYYY-MM-DD` にする。
 */
export function toUtcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * IANA timezone 基準で `Date` を `YYYY-MM-DD` にする。
 */
export function toDateStringInTimeZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) {
    return toUtcDateString(d);
  }
  return `${year}-${month}-${day}`;
}

export function resolveDailyReportTimeZone(
  accountTimeZone?: string | null,
  fallbackTimeZone?: string | null
): string {
  const candidates = [
    accountTimeZone,
    fallbackTimeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ];
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate.trim();
  }
  return "UTC";
}

function isValidTimeZone(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * `YYYY-MM-DD` を 1 日減算した文字列を返す。UTC 安全。
 */
export function subtractOneUtcDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) {
    throw new Error(`subtractOneUtcDay: invalid date '${date}'`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d) - 24 * 60 * 60 * 1000;
  const prev = new Date(utc);
  return toUtcDateString(prev);
}

function addUtcDays(date: Date, days: number): Date {
  if (!Number.isFinite(days) || days === 0) return date;
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
