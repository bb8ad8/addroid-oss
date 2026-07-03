import { toDateStringInTimeZone, type ImprovementPrAnalysisWindow } from "@addroid/queue";
import type {
  ImprovementPrCreativeGenerationContext,
  ImprovementPrCreativeNodeContext,
  ImprovementPrPerformanceMetrics,
} from "@addroid/queue";
import type { PrismaClient } from "@addroid/db";

export interface ImprovementPrPerformanceContext {
  snapshotIds: string[];
  analysisWindow: ImprovementPrAnalysisWindow;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
}

interface PerformanceSnapshotMetricRow {
  id: string;
  nodeType: string;
  nodeKey: string;
  hierarchyId: string | null;
  metricDate: Date;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
  createdAt: Date;
  raw: unknown;
  hierarchy: {
    id: string;
    nodeType: string;
    nodeKey: string;
    displayName: string;
    status: string;
    externalId: string | null;
    spec: unknown;
    parent?: {
      id: string;
      nodeType: string;
      nodeKey: string;
      displayName: string;
      status: string;
      externalId: string | null;
      spec: unknown;
      parent?: {
        id: string;
        nodeType: string;
        nodeKey: string;
        displayName: string;
        status: string;
        externalId: string | null;
        spec: unknown;
      } | null;
    } | null;
  } | null;
}

export async function loadRecentPerformanceSnapshotContext(
  prisma: PrismaClient,
  input: {
    accountId: string;
    timeZone: string;
    now?: Date;
    includeToday?: boolean;
  }
): Promise<ImprovementPrPerformanceContext> {
  const today = toDateStringInTimeZone(input.now ?? new Date(), input.timeZone);
  const periodEnd = input.includeToday ? today : addDateDays(today, -1);
  const periodStart = addDateDays(periodEnd, -6);
  const priorPeriodEnd = addDateDays(periodStart, -1);
  const priorPeriodStart = addDateDays(priorPeriodEnd, -6);
  const rows = await prisma.performanceSnapshot.findMany({
    where: {
      accountId: input.accountId,
      metricDate: {
        gte: dateOnlyUtc(priorPeriodStart),
        lte: dateOnlyUtc(periodEnd),
      },
    },
    select: {
      id: true,
      nodeType: true,
      nodeKey: true,
      hierarchyId: true,
      metricDate: true,
      impressions: true,
      clicks: true,
      spendMicros: true,
      conversions: true,
      createdAt: true,
      raw: true,
      hierarchy: {
        select: {
          id: true,
          nodeType: true,
          nodeKey: true,
          displayName: true,
          status: true,
          externalId: true,
          spec: true,
        },
      },
    },
    orderBy: [{ metricDate: "asc" }, { createdAt: "asc" }],
  });
  const rowsWithHierarchy = await attachHierarchyFallbacks(prisma, input.accountId, rows);
  const currentRows = rowsWithHierarchy.filter((row) => {
    const metricDate = dateOnlyString(row.metricDate);
    return metricDate >= periodStart && metricDate <= periodEnd;
  });
  const priorRows = rowsWithHierarchy.filter((row) => {
    const metricDate = dateOnlyString(row.metricDate);
    return metricDate >= priorPeriodStart && metricDate <= priorPeriodEnd;
  });
  return {
    snapshotIds: currentRows.map((row) => row.id),
    analysisWindow: {
      periodStart,
      periodEnd,
      priorPeriodStart,
      priorPeriodEnd,
      current: aggregateSnapshotMetrics(currentRows),
      prior: aggregateSnapshotMetrics(priorRows),
    },
    creativeContext: await buildCreativeGenerationContext(prisma, {
      accountId: input.accountId,
      currentRows,
      priorRows,
      periodStart,
      periodEnd,
    }),
  };
}

async function buildCreativeGenerationContext(
  prisma: PrismaClient,
  input: {
    accountId: string;
    currentRows: PerformanceSnapshotMetricRow[];
    priorRows: PerformanceSnapshotMetricRow[];
    periodStart: string;
    periodEnd: string;
  }
): Promise<ImprovementPrCreativeGenerationContext | null> {
  const currentNodes = aggregateNodeMetrics(input.currentRows);
  const priorNodes = new Map(
    aggregateNodeMetrics(input.priorRows).map((node) => [nodeMapKey(node), node] as const)
  );
  const candidates = currentNodes
    .filter((n) => n.hierarchy !== "account")
    .sort(preferActionableNode);
  if (candidates.length === 0) return null;

  const enriched = await attachCreativeSnippets(prisma, input.accountId, candidates);
  const underperformers = enriched
    .filter((n) => isUnderperformingNode(n, priorNodes.get(nodeMapKey(n))))
    .sort((a, b) =>
      underperformingScore(b, priorNodes.get(nodeMapKey(b))) -
      underperformingScore(a, priorNodes.get(nodeMapKey(a)))
    );
  const underperformingKeys = new Set(underperformers.map(nodeMapKey));
  const references = enriched
    .filter((n) => isWinningNode(n) && !underperformingKeys.has(nodeMapKey(n)))
    .sort(compareWinningNode)
    .slice(0, 3);

  const target = underperformers[0] ?? references[0] ?? enriched[0] ?? null;
  if (!target && references.length === 0) return null;

  const strategy =
    references.length > 0 && underperformers.length > 0
      ? "adapt_winner_to_underperformer"
      : references.length > 0
        ? "scale_winner"
        : "refresh_underperformer";

  return {
    strategy,
    target,
    references,
    brandProfile: null,
    notes: [
      "Generated from recent performance snapshots.",
      "Prefer winning ads as positive creative seeds; use underperformers only as adaptation targets.",
      ...(await placementInsightNotes(prisma, {
        accountId: input.accountId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      })),
      ...creativeContextNotes(target, references),
    ],
  };
}

async function placementInsightNotes(
  prisma: PrismaClient,
  input: { accountId: string; periodStart: string; periodEnd: string }
): Promise<string[]> {
  const insightRowClient = (prisma as unknown as {
    insightRow?: {
      findMany?: (args: unknown) => Promise<Array<{
        metrics: unknown;
        dimensions: unknown;
      }>>;
    };
  }).insightRow;
  if (!insightRowClient?.findMany) return [];
  try {
    const rows = await insightRowClient.findMany({
      where: {
        accountId: input.accountId,
        dateStart: { gte: dateOnlyUtc(input.periodStart) },
        dateStop: { lte: dateOnlyUtc(input.periodEnd) },
      },
      select: { metrics: true, dimensions: true },
      orderBy: [{ createdAt: "desc" }],
      take: 500,
    });
    return summarizePlacementInsightRows(rows);
  } catch {
    return [];
  }
}

async function attachHierarchyFallbacks(
  prisma: PrismaClient,
  accountId: string,
  rows: PerformanceSnapshotMetricRow[]
): Promise<PerformanceSnapshotMetricRow[]> {
  const keys = rows
    .filter((row) => !row.hierarchy && row.nodeType !== "account")
    .map((row) => ({ nodeType: normalizeHierarchy(row.nodeType), nodeKey: row.nodeKey }));
  if (keys.length === 0) return rows;
  const nodeTypes = [...new Set(keys.map((key) => key.nodeType))];
  const nodeKeys = [...new Set(keys.map((key) => key.nodeKey))];
  const nodes = await prisma.adsHierarchyNode.findMany({
    where: {
      accountId,
      nodeType: { in: nodeTypes },
      nodeKey: { in: nodeKeys },
    },
    select: {
      id: true,
      nodeType: true,
      nodeKey: true,
      displayName: true,
      status: true,
      externalId: true,
      spec: true,
      parent: {
        select: {
          id: true,
          nodeType: true,
          nodeKey: true,
          displayName: true,
          status: true,
          externalId: true,
          spec: true,
          parent: {
            select: {
              id: true,
              nodeType: true,
              nodeKey: true,
              displayName: true,
              status: true,
              externalId: true,
              spec: true,
            },
          },
        },
      },
    },
  });
  const byKey = new Map(nodes.map((node) => [`${node.nodeType}:${node.nodeKey}`, node] as const));
  return rows.map((row) => {
    if (row.hierarchy || row.nodeType === "account") return row;
    const hierarchy = byKey.get(`${normalizeHierarchy(row.nodeType)}:${row.nodeKey}`);
    if (!hierarchy) return row;
    return {
      ...row,
      hierarchyId: row.hierarchyId ?? hierarchy.id,
      hierarchy,
    };
  });
}

function aggregateNodeMetrics(
  rows: PerformanceSnapshotMetricRow[]
): ImprovementPrCreativeNodeContext[] {
  const byKey = new Map<
    string,
    {
      sample: PerformanceSnapshotMetricRow;
      spendMicros: bigint;
      impressions: number;
      clicks: number;
      conversions: number;
    }
  >();
  for (const row of rows) {
    const key = `${row.nodeType}:${row.nodeKey}`;
    const acc =
      byKey.get(key) ??
      {
        sample: row,
        spendMicros: 0n,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      };
    acc.spendMicros += row.spendMicros;
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    acc.conversions += row.conversions;
    byKey.set(key, acc);
  }
  return [...byKey.values()].map((acc) => {
    const row = acc.sample;
    const metrics = metricsFromTotals(acc);
    const hierarchy = normalizeHierarchy(row.nodeType);
    return {
      hierarchyId: row.hierarchyId,
      hierarchy,
      nodeKey: row.nodeKey,
      displayName: row.hierarchy?.displayName ?? readRawString(row.raw, "displayName") ?? row.nodeKey,
      status: row.hierarchy?.status ?? null,
      externalId: row.hierarchy?.externalId ?? null,
      current: metrics,
      rationale: creativeRationale(metrics, null),
      spec: hierarchySpecWithContext(row.hierarchy?.spec, row.hierarchy),
      creative: extractCreativeSnippet(
        hierarchySpecWithContext(row.hierarchy?.spec, row.hierarchy)
      ),
    };
  });
}

function hierarchySpecWithContext(
  spec: unknown,
  hierarchy: PerformanceSnapshotMetricRow["hierarchy"]
): Record<string, unknown> | null {
  const base = isRecord(spec) ? { ...spec } : {};
  const context = hierarchyContext(hierarchy);
  if (context.length === 0 && Object.keys(base).length === 0) return null;
  return {
    ...base,
    hierarchyContext: context,
  };
}

function hierarchyContext(
  hierarchy: PerformanceSnapshotMetricRow["hierarchy"]
): Array<Record<string, unknown>> {
  if (!hierarchy) return [];
  const out: Array<Record<string, unknown>> = [];
  let node: PerformanceSnapshotMetricRow["hierarchy"] | NonNullable<PerformanceSnapshotMetricRow["hierarchy"]>["parent"] = hierarchy;
  while (node) {
    out.push({
      hierarchy: normalizeHierarchy(node.nodeType),
      nodeKey: node.nodeKey,
      displayName: node.displayName,
      status: node.status,
      externalId: node.externalId,
      placementSummary: placementSummaryFromSpec(node.spec),
      rawName: readRawString(node.spec, "name") ?? readNestedRawString(node.spec, ["raw", "name"]),
      effectiveStatus:
        readSpecString(node.spec, "effectiveStatus") ??
        readNestedRawString(node.spec, ["raw", "effective_status"]),
    });
    node = node.parent ?? null;
  }
  return out;
}

async function attachCreativeSnippets(
  prisma: PrismaClient,
  accountId: string,
  nodes: ImprovementPrCreativeNodeContext[]
): Promise<ImprovementPrCreativeNodeContext[]> {
  const creativeRefs = new Set<string>();
  for (const node of nodes) {
    const ref = readSpecString(node.spec, "creativeRef");
    if (ref) creativeRefs.add(ref);
  }
  if (creativeRefs.size === 0) return nodes;
  const rows = await prisma.creative.findMany({
    where: { accountId, key: { in: [...creativeRefs] } },
    select: {
      key: true,
      displayName: true,
      mediaType: true,
      spec: true,
      prompt: true,
      provider: true,
      model: true,
      storageRef: true,
    },
  });
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  return nodes.map((node) => {
    const ref = readSpecString(node.spec, "creativeRef");
    const row = ref ? byKey.get(ref) : null;
    if (!row) return node;
    const rowSnippet = extractCreativeSnippet(row.spec);
    return {
      ...node,
      creative: {
        ...node.creative,
        ...(rowSnippet ?? {}),
        key: row.key,
        displayName: rowSnippet?.displayName ?? row.displayName,
        mediaType: row.mediaType,
        storageRef: row.storageRef,
        provider: row.provider,
        model: row.model,
        primaryText:
          rowSnippet?.primaryText ??
          (typeof row.prompt === "string" ? row.prompt : null),
      },
    };
  });
}

function aggregateSnapshotMetrics(rows: PerformanceSnapshotMetricRow[]) {
  const selectedRows = selectNonOverlappingSnapshotRows(rows);
  let spendMicros = 0n;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  for (const row of selectedRows) {
    spendMicros += row.spendMicros;
    impressions += row.impressions;
    clicks += row.clicks;
    conversions += row.conversions;
  }
  const spend = Number(spendMicros) / 1_000_000;
  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpa: conversions > 0 ? spend / conversions : 0,
  };
}

function selectNonOverlappingSnapshotRows(rows: PerformanceSnapshotMetricRow[]) {
  for (const nodeType of ["account", "campaign", "adset", "ad"]) {
    const selected = rows.filter((row) => row.nodeType === nodeType);
    if (selected.length > 0) return selected;
  }
  return [];
}

function metricsFromTotals(input: {
  spendMicros: bigint;
  impressions: number;
  clicks: number;
  conversions: number;
}): ImprovementPrPerformanceMetrics {
  const spend = Number(input.spendMicros) / 1_000_000;
  return {
    spend,
    impressions: input.impressions,
    clicks: input.clicks,
    conversions: input.conversions,
    ctr: input.impressions > 0 ? (input.clicks / input.impressions) * 100 : 0,
    cpc: input.clicks > 0 ? spend / input.clicks : 0,
    cpa: input.conversions > 0 ? spend / input.conversions : 0,
  };
}

function preferActionableNode(
  a: ImprovementPrCreativeNodeContext,
  b: ImprovementPrCreativeNodeContext
): number {
  return hierarchyRank(b.hierarchy) - hierarchyRank(a.hierarchy);
}

function hierarchyRank(value: ImprovementPrCreativeNodeContext["hierarchy"]): number {
  switch (value) {
    case "ad":
      return 4;
    case "adset":
      return 3;
    case "campaign":
      return 2;
    case "account":
    default:
      return 1;
  }
}

function isWinningNode(node: ImprovementPrCreativeNodeContext): boolean {
  const m = node.current;
  if (m.impressions < 100 && m.clicks < 10) return false;
  if (m.conversions > 0) return true;
  return (m.ctr ?? 0) >= 1 && m.clicks >= 10;
}

function compareWinningNode(
  a: ImprovementPrCreativeNodeContext,
  b: ImprovementPrCreativeNodeContext
): number {
  const acpa = a.current.cpa && a.current.cpa > 0 ? a.current.cpa : Number.POSITIVE_INFINITY;
  const bcpa = b.current.cpa && b.current.cpa > 0 ? b.current.cpa : Number.POSITIVE_INFINITY;
  const convDelta = b.current.conversions - a.current.conversions;
  if (convDelta !== 0) return convDelta;
  const cpaDelta = acpa - bcpa;
  if (Number.isFinite(cpaDelta) && cpaDelta !== 0) return cpaDelta;
  return (b.current.ctr ?? 0) - (a.current.ctr ?? 0);
}

function isUnderperformingNode(
  node: ImprovementPrCreativeNodeContext,
  prior: ImprovementPrCreativeNodeContext | undefined
): boolean {
  const m = node.current;
  if (m.spend > 0 && m.conversions === 0 && (m.clicks >= 10 || m.spend >= 1000)) return true;
  if (!prior) return false;
  const currentCtr = m.ctr ?? 0;
  const priorCtr = prior.current.ctr ?? 0;
  if (priorCtr > 0 && currentCtr < priorCtr * 0.8 && m.impressions >= 100) return true;
  const currentCpa = m.cpa ?? 0;
  const priorCpa = prior.current.cpa ?? 0;
  return priorCpa > 0 && currentCpa > priorCpa * 1.25;
}

function underperformingScore(
  node: ImprovementPrCreativeNodeContext,
  prior: ImprovementPrCreativeNodeContext | undefined
): number {
  const m = node.current;
  let score = Math.log10(Math.max(m.spend, 1));
  if (m.conversions === 0 && m.spend > 0) score += 3;
  if (prior) {
    const priorCtr = prior.current.ctr ?? 0;
    if (priorCtr > 0) score += Math.max(0, (priorCtr - (m.ctr ?? 0)) / priorCtr);
    const priorCpa = prior.current.cpa ?? 0;
    if (priorCpa > 0 && (m.cpa ?? 0) > priorCpa) {
      score += ((m.cpa ?? 0) - priorCpa) / priorCpa;
    }
  }
  return score;
}

function nodeMapKey(node: ImprovementPrCreativeNodeContext): string {
  return `${node.hierarchy}:${node.nodeKey}`;
}

function creativeRationale(
  current: ImprovementPrPerformanceMetrics,
  prior: ImprovementPrPerformanceMetrics | null
): string {
  if (current.conversions > 0) {
    return `winner seed: ${current.conversions} conversions, CTR ${(current.ctr ?? 0).toFixed(2)}%, CPA ${current.cpa?.toFixed(2) ?? "n/a"}`;
  }
  if (current.spend > 0 && current.conversions === 0) {
    return `adaptation target: spend ${current.spend.toFixed(2)} with no conversions`;
  }
  if (prior && (current.ctr ?? 0) < (prior.ctr ?? 0)) {
    return `adaptation target: CTR declined from ${(prior.ctr ?? 0).toFixed(2)}% to ${(current.ctr ?? 0).toFixed(2)}%`;
  }
  return `creative seed: CTR ${(current.ctr ?? 0).toFixed(2)}%, clicks ${current.clicks}`;
}

function creativeContextNotes(
  target: ImprovementPrCreativeNodeContext | null,
  references: ImprovementPrCreativeNodeContext[]
): string[] {
  const nodes = [
    ...(target ? [{ label: "target", node: target }] : []),
    ...references.slice(0, 3).map((node, index) => ({ label: `reference_${index + 1}`, node })),
  ];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const item of nodes) {
    const key = `${item.label}:${item.node.hierarchy}:${item.node.nodeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const context = readHierarchyContext(item.node.spec);
    const hierarchyNames = context
      .map((entry) => {
        const hierarchy = typeof entry.hierarchy === "string" ? entry.hierarchy : "node";
        const name =
          readStringValue(entry.displayName) ??
          readStringValue(entry.rawName) ??
          readStringValue(entry.nodeKey);
        return name ? `${hierarchy}=${name}` : null;
      })
      .filter((value): value is string => value !== null);
    const creative = item.node.creative;
    const placementSummary = placementSummaryFromSpec(item.node.spec);
    notes.push(
      [
        `Existing Meta account context (${item.label})`,
        `${item.node.hierarchy}=${item.node.displayName}`,
        hierarchyNames.length > 0 ? hierarchyNames.join(" / ") : null,
        placementSummary ? `placements=${placementSummary}` : null,
        creative?.displayName ? `creative=${creative.displayName}` : null,
        creative?.headline ? `headline=${creative.headline}` : null,
        creative?.primaryText ? `copy=${creative.primaryText}` : null,
        creative?.linkUrl ? `link=${creative.linkUrl}` : null,
      ].filter(Boolean).join(": ")
    );
  }
  if (notes.length > 0) {
    notes.unshift(
      "Use the existing Meta hierarchy names and creative context as hard grounding; do not invent unrelated stores, locations, industries, products, or dashboard scenes."
    );
  }
  return notes;
}

function placementSummaryFromSpec(spec: unknown): string | null {
  const text = JSON.stringify(spec ?? "").toLowerCase();
  if (!text || text === "\"\"") return null;
  const surfaces: string[] = [];
  if (text.includes("instagram_stories") || text.includes("story")) surfaces.push("instagram_stories");
  if (text.includes("instagram_reels") || text.includes("reel")) surfaces.push("instagram_reels");
  if (text.includes("instagram_stream") || text.includes("instagram_feed")) surfaces.push("instagram_feed");
  if (text.includes("facebook_feed") || text.includes("feed") || text.includes("home")) surfaces.push("facebook_feed");
  if (text.includes("messenger")) surfaces.push("messenger");
  if (text.includes("audience_network")) surfaces.push("audience_network");
  if (text.includes("4:5") || text.includes("portrait")) surfaces.push("4:5");
  if (text.includes("9:16")) surfaces.push("9:16");
  if (text.includes("1:1") || text.includes("square")) surfaces.push("1:1");
  if (text.includes("1.91:1") || text.includes("landscape")) surfaces.push("1.91:1");
  return surfaces.length > 0 ? [...new Set(surfaces)].join(", ") : null;
}

function summarizePlacementInsightRows(
  rows: Array<{ metrics: unknown; dimensions: unknown }>
): string[] {
  const byPlacement = new Map<
    string,
    { impressions: number; clicks: number; conversions: number; spend: number }
  >();
  for (const row of rows) {
    const placement = placementProfileFromDimensions(row.dimensions);
    if (!placement) continue;
    const metrics = row.metrics;
    const acc =
      byPlacement.get(placement) ??
      { impressions: 0, clicks: 0, conversions: 0, spend: 0 };
    acc.impressions += readMetricNumber(metrics, "impressions");
    acc.clicks += readMetricNumber(metrics, "clicks");
    acc.conversions +=
      readMetricNumber(metrics, "conversions") ||
      readMetricNumber(metrics, "actions") ||
      readMetricNumber(metrics, "results");
    acc.spend += readMetricNumber(metrics, "spend");
    byPlacement.set(placement, acc);
  }
  if (byPlacement.size === 0) return [];
  const placements = [...byPlacement.entries()].sort((a, b) => {
    const av = a[1].conversions - b[1].conversions;
    if (av !== 0) return -av;
    const actr = ctr(a[1]);
    const bctr = ctr(b[1]);
    return bctr - actr;
  });
  const top = placements[0];
  const notes: string[] = [];
  if (top) {
    notes.push(
      `Placement performance signal: top=${top[0]} impressions=${top[1].impressions} clicks=${top[1].clicks} conversions=${top[1].conversions} ctr=${ctr(top[1]).toFixed(2)}%.`
    );
  }
  const missing = ["feed_square", "feed_portrait", "story_reels", "feed_landscape"]
    .filter((placement) => !byPlacement.has(placement));
  if (missing.length > 0) {
    notes.push(`Placement coverage gap from stored insights: ${missing.join(", ")}.`);
  }
  return notes;
}

function placementProfileFromDimensions(dimensions: unknown): string | null {
  const text = JSON.stringify(dimensions ?? "").toLowerCase();
  if (!text || text === "\"\"") return null;
  if (text.includes("story") || text.includes("reel") || text.includes("9:16")) return "story_reels";
  if (text.includes("portrait") || text.includes("4:5")) return "feed_portrait";
  if (text.includes("landscape") || text.includes("1.91:1")) return "feed_landscape";
  if (
    text.includes("feed") ||
    text.includes("stream") ||
    text.includes("home") ||
    text.includes("square") ||
    text.includes("1:1")
  ) {
    return "feed_square";
  }
  return null;
}

function ctr(metrics: { impressions: number; clicks: number }): number {
  return metrics.impressions > 0 ? (metrics.clicks / metrics.impressions) * 100 : 0;
}

function readMetricNumber(metrics: unknown, key: string): number {
  if (!isRecord(metrics)) return 0;
  const raw = metrics[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeHierarchy(value: string): ImprovementPrCreativeNodeContext["hierarchy"] {
  if (value === "campaign" || value === "adset" || value === "ad") return value;
  return "account";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRawString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function readSpecString(value: unknown, key: string): string | null {
  return readRawString(value, key);
}

function readNestedRawString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

// Reads the first non-empty string from raw.creative.asset_feed_spec[arrayKey].
// Advantage+ / dynamic creatives keep their copy here (titles/bodies -> {text},
// link_urls -> {website_url}) instead of object_story_spec. When itemKey is omitted
// the array holds plain strings (e.g. call_to_action_types).
function readAssetFeedRawString(
  value: unknown,
  arrayKey: string,
  itemKey?: string,
): string | null {
  const raw = isRecord(value) && isRecord(value.raw) ? value.raw : null;
  const creative = raw && isRecord(raw.creative) ? raw.creative : null;
  const assetFeedSpec =
    creative && isRecord(creative.asset_feed_spec) ? creative.asset_feed_spec : null;
  if (!assetFeedSpec) return null;
  const arr = assetFeedSpec[arrayKey];
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    const candidate = itemKey ? (isRecord(item) ? item[itemKey] : null) : item;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readHierarchyContext(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.hierarchyContext)) return [];
  return value.hierarchyContext.filter(isRecord);
}

export function extractCreativeSnippet(value: unknown):
  | ImprovementPrCreativeNodeContext["creative"]
  | null {
  if (!isRecord(value)) return null;
  const creative = isRecord(value.creative) ? value.creative : null;
  const rawName = readNestedRawString(value, ["raw", "name"]);
  return {
    key:
      readSpecString(creative, "key") ??
      readSpecString(value, "creativeRef") ??
      readSpecString(value, "id") ??
      readNestedRawString(value, ["raw", "creative", "id"]),
    displayName:
      readSpecString(creative, "displayName") ??
      readSpecString(value, "name") ??
      readNestedRawString(value, ["raw", "creative", "name"]) ??
      rawName,
    mediaType:
      readSpecString(creative, "mediaType") ??
      readSpecString(value, "mediaType") ??
      (readNestedRawString(value, ["raw", "creative", "video_id"]) ? "video" : null),
    headline:
      readSpecString(creative, "headline") ??
      readSpecString(value, "headline") ??
      readSpecString(value, "title") ??
      readNestedRawString(value, ["raw", "creative", "title"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "link_data", "name"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "video_data", "title"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "template_data", "name"]) ??
      readAssetFeedRawString(value, "titles", "text"),
    primaryText:
      readSpecString(creative, "primaryText") ??
      readSpecString(value, "primaryText") ??
      readSpecString(value, "body") ??
      readNestedRawString(value, ["raw", "creative", "body"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "link_data", "message"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "video_data", "message"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "template_data", "message"]) ??
      readAssetFeedRawString(value, "bodies", "text") ??
      null,
    callToAction:
      readSpecString(creative, "callToAction") ??
      readSpecString(value, "callToAction") ??
      readNestedRawString(value, ["raw", "creative", "call_to_action_type"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "link_data", "call_to_action", "type"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "video_data", "call_to_action", "type"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "template_data", "call_to_action", "type"]) ??
      readAssetFeedRawString(value, "call_to_action_types"),
    linkUrl:
      readSpecString(creative, "linkUrl") ??
      readSpecString(value, "linkUrl") ??
      readNestedRawString(value, ["raw", "creative", "object_url"]) ??
      readNestedRawString(value, ["raw", "creative", "template_url"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "link_data", "link"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "link_data", "call_to_action", "value", "link"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "video_data", "call_to_action", "value", "link"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "template_data", "link"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "template_data", "call_to_action", "value", "link"]) ??
      readAssetFeedRawString(value, "link_urls", "website_url"),
    pageId:
      readSpecString(creative, "pageId") ??
      readSpecString(value, "pageId") ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "page_id"]),
    instagramUserId:
      readSpecString(creative, "instagramUserId") ??
      readSpecString(value, "instagramUserId") ??
      readNestedRawString(value, ["raw", "creative", "instagram_user_id"]) ??
      readNestedRawString(value, ["raw", "creative", "object_story_spec", "instagram_user_id"]),
    storageRef: readSpecString(value, "storageRef"),
    provider: readSpecString(value, "provider"),
    model: readSpecString(value, "model"),
    images: [
      ...readSpecStringArray(creative, "images"),
      ...readSpecStringArray(value, "images"),
    ],
  };
}

function readSpecStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value)) return [];
  const raw = value[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function addDateDays(date: string, days: number): string {
  const d = dateOnlyUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return dateOnlyString(d);
}

function dateOnlyUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
