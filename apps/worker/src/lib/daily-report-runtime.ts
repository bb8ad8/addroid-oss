// AdDroid OSS — apps/worker daily_report wiring (Implementation item).
//
// `runDailyReportOnce` (queue) が要求する 3 境界 (insights provider / snapshot
// store / analyst runner) を、Prisma + LLM Provider + Graph API insights で
// 組み立てる。Meta token が無いテスト/初期状態では決定論的 mock provider を
// fallback として使う。

import { Prisma, type PrismaClient } from "@addroid/db";
import {
  buildAiRunCreateInput,
  type AiRunCreateInputData,
  type LLMProvider,
} from "@addroid/llm-provider";
import {
  runAnalystAgent,
  type AnalystAgentInput,
} from "@addroid/llm-provider";
import {
  mergeBreakdownsPolicy,
  type BreakdownsPolicy,
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
  type SnapshotSeriesRow,
} from "@addroid/queue";

// ---------------------------------------------------------------------
// Snapshot store — Prisma 実装
// ---------------------------------------------------------------------

export function createPrismaDailyReportSnapshotStore(
  prisma: PrismaClient
): DailyReportSnapshotStore {
  return {
    async findAdAccount(input): Promise<DailyReportAdAccountSnapshot | null> {
      const row = await prisma.adAccount.findUnique({
        where: {
          workspaceId_key: {
            workspaceId: input.workspaceId,
            key: input.accountKey,
          },
        },
        select: {
          id: true,
          key: true,
          displayName: true,
          metaAccountId: true,
          currency: true,
          timezoneName: true,
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        displayName: row.displayName,
        metaAccountId: row.metaAccountId,
        currency: row.currency ?? "JPY",
        timezoneName: row.timezoneName,
      };
    },

    async upsertPerformanceSnapshot(
      input: PerformanceSnapshotUpsertInput
    ): Promise<PerformanceSnapshotUpsertResult> {
      const metricDate = new Date(`${input.metricDate}T00:00:00.000Z`);
      const data = {
        accountId: input.accountId,
        nodeType: input.nodeType,
        nodeKey: input.nodeKey,
        metricDate,
        impressions: input.impressions,
        clicks: input.clicks,
        spendMicros: input.spendMicros,
        conversions: input.conversions,
        reach: input.reach ?? null,
        frequency: input.frequency ?? null,
        linkClicks: input.linkClicks ?? null,
        videoThruPlays: input.videoThruPlays ?? null,
        video3SecViews: input.video3SecViews ?? null,
        qualityRanking: input.qualityRanking ?? null,
        engagementRateRanking: input.engagementRateRanking ?? null,
        conversionRateRanking: input.conversionRateRanking ?? null,
        source: input.source,
        ...(input.hierarchyId
          ? { hierarchyId: input.hierarchyId }
          : { hierarchyId: null }),
        raw: (input.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      };
      const row = await prisma.performanceSnapshot.upsert({
        where: {
          accountId_nodeType_nodeKey_metricDate: {
            accountId: input.accountId,
            nodeType: input.nodeType,
            nodeKey: input.nodeKey,
            metricDate,
          },
        },
        update: {
          impressions: data.impressions,
          clicks: data.clicks,
          spendMicros: data.spendMicros,
          conversions: data.conversions,
          reach: data.reach,
          frequency: data.frequency,
          linkClicks: data.linkClicks,
          videoThruPlays: data.videoThruPlays,
          video3SecViews: data.video3SecViews,
          qualityRanking: data.qualityRanking,
          engagementRateRanking: data.engagementRateRanking,
          conversionRateRanking: data.conversionRateRanking,
          source: data.source,
          hierarchyId: data.hierarchyId,
          raw: data.raw,
        },
        create: data,
        select: { id: true },
      });
      return {
        id: row.id,
        nodeType: input.nodeType,
        nodeKey: input.nodeKey,
        metricDate: input.metricDate,
      };
    },

    async createAiRun(data: AiRunCreateInputData): Promise<{ id: string }> {
      const created = await prisma.aiRun.create({
        data: {
          workspaceId: data.workspaceId,
          agent: data.agent,
          workflow: data.workflow,
          provider: data.provider,
          model: data.model,
          status: data.status,
          prompt: (data.prompt ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          inputs: (data.inputs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          outputs: (data.outputs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          decision: data.decision,
          confidence: data.confidence,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          requestId: data.requestId,
          linkedRefType: data.linkedRefType,
          linkedRefId: data.linkedRefId,
          errorMessage: data.errorMessage,
          startedAt: data.startedAt,
          finishedAt: data.finishedAt,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async listSnapshotSeries(input): Promise<SnapshotSeriesRow[]> {
      const rows = await prisma.performanceSnapshot.findMany({
        where: {
          accountId: input.accountId,
          nodeType: { in: input.nodeTypes },
          metricDate: {
            gte: new Date(`${input.since}T00:00:00.000Z`),
            lte: new Date(`${input.until}T00:00:00.000Z`),
          },
        },
        select: {
          nodeType: true,
          nodeKey: true,
          metricDate: true,
          impressions: true,
          clicks: true,
          spendMicros: true,
          conversions: true,
          frequency: true,
          raw: true,
        },
        orderBy: [{ nodeType: "asc" }, { nodeKey: "asc" }, { metricDate: "asc" }],
      });
      return rows.flatMap((row) => {
        if (
          row.nodeType !== "account" &&
          row.nodeType !== "campaign" &&
          row.nodeType !== "adset" &&
          row.nodeType !== "ad"
        ) {
          return [];
        }
        return [
          {
            hierarchy: row.nodeType,
            nodeKey: row.nodeKey,
            displayName: displayNameFromRaw(row.raw, row.nodeKey),
            metricDate: row.metricDate.toISOString().slice(0, 10),
            spendMicros: row.spendMicros,
            impressions: row.impressions,
            clicks: row.clicks,
            conversions: row.conversions,
            frequency: decimalToNumber(row.frequency),
          },
        ];
      });
    },
  };
}

// ---------------------------------------------------------------------
// Analyst runner — LLMProvider に analyst agent を流す
// ---------------------------------------------------------------------

export interface CreateAnalystRunnerOptions {
  provider: LLMProvider;
  workspaceId: string;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

export function createAnalystRunner(
  opts: CreateAnalystRunnerOptions
): DailyReportAnalystRunner {
  return {
    async run(input: DailyReportAnalystInput): Promise<DailyReportAnalystResult> {
      const linkedRefId = input.snapshotIds[0] ?? null;
      const agentInput: AnalystAgentInput = {
        accountId: input.accountId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ...(input.priorPeriodStart
          ? { priorPeriodStart: input.priorPeriodStart }
          : {}),
        ...(input.priorPeriodEnd
          ? { priorPeriodEnd: input.priorPeriodEnd }
          : {}),
        current: input.current,
        ...(input.prior ? { prior: input.prior } : {}),
        ...(input.statisticalContext
          ? { statisticalContext: input.statisticalContext }
          : {}),
        ...(input.anomalyFindings
          ? { anomalyFindings: input.anomalyFindings }
          : {}),
        ...(typeof input.quietDay === "boolean"
          ? { quietDay: input.quietDay }
          : {}),
        snapshotIds: input.snapshotIds,
      };
      try {
        const result = await runAnalystAgent(
          {
            provider: opts.provider,
            workspaceId: opts.workspaceId,
            workflow: "daily_report",
            ...(linkedRefId
              ? {
                  linkedRefType: "performance_snapshot" as const,
                  linkedRefId,
                }
              : {}),
            ...(opts.now ? { now: opts.now } : {}),
          },
          agentInput
        );
        return {
          aiRunInput: result.aiRunInput,
          output: result.output
            ? {
                commentary: result.output.commentary,
                deltas: result.output.deltas,
                topImprovements: result.output.topImprovements,
              }
            : null,
          error: result.error,
        };
      } catch (err) {
        // runAnalystAgent はエラーを catch して `status="failed"` の result を
        // 返すよう設計されているが、provider 自体が同期的に throw した場合は
        // ここに落ちる。fail-closed で ai_runs に書ける形に正規化する。
        const message = err instanceof Error ? err.message : String(err);
        const startedAt = opts.now ? opts.now() : new Date();
        const aiRunInput = buildAiRunCreateInput({
          workspaceId: opts.workspaceId,
          agent: "analyst",
          workflow: "daily_report",
          provider: opts.provider.name,
          model: opts.provider.defaultModel,
          status: "failed",
          inputs: agentInput,
          outputs: null,
          decision: null,
          confidence: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(linkedRefId
            ? {
                linkedRefType: "performance_snapshot" as const,
                linkedRefId,
              }
            : {}),
          errorMessage: message,
          startedAt,
          finishedAt: startedAt,
        });
        return { aiRunInput, output: null, error: message };
      }
    },
  };
}

function decimalToNumber(
  value: Prisma.Decimal | number | null
): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = value.toNumber();
  return Number.isFinite(n) ? n : null;
}

function displayNameFromRaw(raw: Prisma.JsonValue | null, fallback: string): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).displayName;
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------
// Insights provider — Mock (deterministic, network-free)
// ---------------------------------------------------------------------

/**
 * 決定論的な daily_report 用 mock insights provider。
 *
 * - ネットワーク / Meta Graph API を呼ばず、accountKey + metricDate から再現可能な
 *   account / campaign / adset / ad の 4 階層メトリクスを生成する。
 * - 値は KPI 計算 (CTR / CPC / CPA / CPM / frequency / Δ%) を演習できる
 *   範囲で micros 単位 (BigInt) を返す。
 */
export class MockDailyReportInsightsProvider implements DailyReportInsightsProvider {
  async fetchInsights(
    req: DailyReportInsightsRequest
  ): Promise<DailyReportInsightsResponse> {
    const policy = mergeBreakdownsPolicy(req.breakdownsPolicy ?? null);
    const seed = hashString(`${req.accountKey}:${req.metricDate}`);
    const priorSeed = hashString(
      `${req.accountKey}:${shiftDate(req.metricDate, -1)}`
    );
    const current = simulateRows(seed, req.accountKey, policy);
    const prior = req.includePriorPeriod
      ? simulateRows(priorSeed, req.accountKey, policy)
      : [];
    return {
      current,
      prior,
      source: "mock",
      detail: "simulated insights (Meta Graph API insights unavailable in this runtime)",
    };
  }
}

function simulateRows(
  seed: number,
  accountKey: string,
  policy: BreakdownsPolicy
): DailyReportInsightsRow[] {
  // 決定論的な数値を seed から派生 (1 日違いで微小に変動)
  const baseImpressions = 8000 + (seed % 2000); // 8000–9999
  const baseClicks = 150 + (seed % 60); // 150–209
  const baseConversions = 8 + (seed % 6); // 8–13
  const baseSpendMajor = 4500 + (seed % 800); // 4500–5299 (currency major unit)
  const baseFrequency = 1 + ((seed % 50) / 100); // 1.00–1.49

  const account: DailyReportInsightsRow = {
    nodeType: "account",
    nodeKey: accountKey.startsWith("act_") ? accountKey : `act_${accountKey}`,
    displayName: `Account ${accountKey}`,
    impressions: baseImpressions,
    clicks: baseClicks,
    conversions: baseConversions,
    spendMicros: BigInt(baseSpendMajor) * 1_000_000n,
    frequency: baseFrequency,
    reach: Math.floor(baseImpressions / baseFrequency),
    linkClicks: Math.floor(baseClicks * 0.72),
  };

  // 階層: 1 campaign → 1 adset → 1 ad (this implementation では十分)
  // metric は account 合計の ~80% を派生して 1 階層下に渡し、ヒエラルキーを
  // 形成する。
  const campaign: DailyReportInsightsRow = {
    nodeType: "campaign",
    nodeKey: `cmp_${seed.toString(36)}`,
    displayName: "Primary campaign (simulated)",
    impressions: Math.floor(baseImpressions * 0.8),
    clicks: Math.floor(baseClicks * 0.8),
    conversions: Math.floor(baseConversions * 0.8),
    spendMicros:
      (BigInt(baseSpendMajor) * 1_000_000n * 80n) / 100n,
    frequency: baseFrequency,
    reach: Math.floor((baseImpressions * 0.8) / baseFrequency),
    linkClicks: Math.floor(baseClicks * 0.58),
  };
  const adset: DailyReportInsightsRow = {
    nodeType: "adset",
    nodeKey: `as_${seed.toString(36)}`,
    displayName: "Primary adset (simulated)",
    impressions: Math.floor(baseImpressions * 0.6),
    clicks: Math.floor(baseClicks * 0.6),
    conversions: Math.floor(baseConversions * 0.6),
    spendMicros:
      (BigInt(baseSpendMajor) * 1_000_000n * 60n) / 100n,
    frequency: baseFrequency,
    reach: Math.floor((baseImpressions * 0.6) / baseFrequency),
    linkClicks: Math.floor(baseClicks * 0.43),
  };
  const ad: DailyReportInsightsRow = {
    nodeType: "ad",
    nodeKey: `ad_${seed.toString(36)}`,
    displayName: "Primary ad (simulated)",
    impressions: Math.floor(baseImpressions * 0.4),
    clicks: Math.floor(baseClicks * 0.4),
    conversions: Math.floor(baseConversions * 0.4),
    spendMicros:
      (BigInt(baseSpendMajor) * 1_000_000n * 40n) / 100n,
    frequency: baseFrequency,
    reach: Math.floor((baseImpressions * 0.4) / baseFrequency),
    linkClicks: Math.floor(baseClicks * 0.29),
    videoThruPlays: Math.floor(baseImpressions * 0.08),
    video3SecViews: Math.floor(baseImpressions * 0.18),
    qualityRanking: "average",
    engagementRateRanking: "average",
    conversionRateRanking: "average",
  };

  const rows: DailyReportInsightsRow[] = [];
  if (policy.fetchAccount) rows.push(account);
  if (policy.fetchCampaign) rows.push(campaign);
  if (policy.fetchAdset) rows.push(adset);
  if (policy.fetchAd) rows.push(ad);
  return rows;
}

function hashString(s: string): number {
  // FNV-1a 32-bit。Mock データのシードのみに使うため crypto-strong である必要なし。
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 正の整数に正規化
  return h >>> 0;
}

function shiftDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  const d = new Date(utc);
  const y = d.getUTCFullYear();
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${mo}-${day}`;
}
