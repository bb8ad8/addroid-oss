import { META_GRAPH_API_VERSION } from "@addroid/meta-adapter";
import { Prisma, type PrismaClient } from "@addroid/db";
import { resolveRowConversions } from "./meta-cv-event.js";

type NodeType = "campaign" | "adset" | "ad";
type InsightsLevel = NodeType;

interface GraphPage {
  data?: unknown;
  paging?: { next?: unknown };
  error?: { message?: unknown; type?: unknown; code?: unknown };
}

interface GraphRow {
  id: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  campaignId: string | null;
  adsetId: string | null;
  raw: Record<string, unknown>;
}

interface GraphInsightsRow {
  nodeType: InsightsLevel;
  nodeKey: string;
  raw: Record<string, unknown>;
  impressions: number;
  clicks: number;
  spendMicros: bigint;
  conversions: number;
}

interface MetaCreativeSpec {
  key?: string;
  displayName?: string;
  mediaType?: string;
  headline?: string;
  primaryText?: string;
  callToAction?: string;
  linkUrl?: string;
  pageId?: string;
  instagramUserId?: string;
}

export interface MetaMirrorSyncResult {
  ok: true;
  account: {
    id: string;
    key: string;
    displayName: string | null;
    metaAccountId: string;
  };
  campaigns: number;
  adsets: number;
  ads: number;
  upserted: number;
  metrics: {
    metricDate: string;
    rows: number;
    snapshots: number;
    error?: string;
  };
}

export interface RunMetaMirrorSyncOptions {
  prisma: PrismaClient;
  workspaceId: string;
  accessToken: string;
  accountId?: string | null;
  accountKey?: string | null;
  actor: string;
  source: string;
  includeMetrics?: boolean;
}

export async function runMetaMirrorSync(
  opts: RunMetaMirrorSyncOptions
): Promise<MetaMirrorSyncResult> {
  const account = await resolveSyncAccount(opts);
  const metaAccountId = account.metaAccountId ?? account.key;
  if (!metaAccountId) throw new Error("広告アカウントIDが未設定です。");

  const [campaigns, adsets, ads] = await Promise.all([
    fetchGraphRows(metaAccountId, "campaigns", opts.accessToken),
    fetchGraphRows(metaAccountId, "adsets", opts.accessToken),
    fetchGraphRows(metaAccountId, "ads", opts.accessToken),
  ]);
  const result = await persistHierarchy({
    prisma: opts.prisma,
    accountId: account.id,
    campaigns,
    adsets,
    ads,
  });

  const metricDate = currentDateForTimeZone(account.timezoneName);
  let metricResult: MetaMirrorSyncResult["metrics"] = {
    metricDate,
    rows: 0,
    snapshots: 0,
  };
  if (opts.includeMetrics !== false) {
    try {
      const insightRows = await fetchGraphInsights(
        metaAccountId,
        opts.accessToken,
        metricDate,
        account.cvEvent ?? null
      );
      const snapshots = await persistPerformanceSnapshots({
        prisma: opts.prisma,
        accountId: account.id,
        metricDate,
        rows: insightRows,
      });
      metricResult = {
        metricDate,
        rows: insightRows.length,
        snapshots,
      };
    } catch (err) {
      metricResult = {
        metricDate,
        rows: 0,
        snapshots: 0,
        error: (err as Error).message,
      };
    }
  }

  await opts.prisma.auditLog
    .create({
      data: {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        action: "campaigns.synced_from_meta",
        target: `ad_account:${account.id}`,
        ref: metaAccountId,
        metadata: {
          source: opts.source,
          campaignCount: campaigns.length,
          adsetCount: adsets.length,
          adCount: ads.length,
          upserted: result.upserted,
          metricDate: metricResult.metricDate,
          metricRows: metricResult.rows,
          metricSnapshots: metricResult.snapshots,
          metricError: metricResult.error ?? null,
        } satisfies Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);

  return {
    ok: true,
    account: {
      id: account.id,
      key: account.key,
      displayName: account.displayName,
      metaAccountId,
    },
    campaigns: campaigns.length,
    adsets: adsets.length,
    ads: ads.length,
    upserted: result.upserted,
    metrics: metricResult,
  };
}

async function resolveSyncAccount(opts: RunMetaMirrorSyncOptions): Promise<{
  id: string;
  key: string;
  metaAccountId: string | null;
  displayName: string | null;
  timezoneName: string | null;
  cvEvent: string | null;
}> {
  const ws = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { defaultAdAccountId: true },
  });
  const account = await opts.prisma.adAccount.findFirst({
    where: {
      workspaceId: opts.workspaceId,
      active: true,
      ...(opts.accountId
        ? { id: opts.accountId }
        : opts.accountKey
          ? { key: opts.accountKey }
          : ws?.defaultAdAccountId
            ? { id: ws.defaultAdAccountId }
            : {}),
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      key: true,
      metaAccountId: true,
      displayName: true,
      timezoneName: true,
      cvEvent: true,
    },
  });
  if (!account) throw new Error("同期対象の広告アカウントがありません。");
  return account;
}

async function fetchGraphRows(
  accountId: string,
  edge: "campaigns" | "adsets" | "ads",
  accessToken: string
): Promise<GraphRow[]> {
  const fields =
    edge === "campaigns"
      ? "id,name,status,effective_status,configured_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,bid_strategy,spend_cap,start_time,stop_time,special_ad_categories,special_ad_category_country,is_adset_budget_sharing_enabled,updated_time"
      : edge === "adsets"
        ? "id,name,status,effective_status,configured_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,bid_amount,bid_strategy,bid_constraints,start_time,end_time,updated_time,targeting,optimization_goal,billing_event,attribution_spec,destination_type,frequency_control_specs,pacing_type,promoted_object,daily_spend_cap,lifetime_spend_cap,daily_min_spend_target,lifetime_min_spend_target,is_dynamic_creative"
        : [
            "id",
            "name",
            "status",
            "effective_status",
            "configured_status",
            "campaign_id",
            "adset_id",
            "updated_time",
            "creative{id,name,title,body,call_to_action_type,object_url,template_url,object_story_spec,thumbnail_url,image_url,video_id,effective_object_story_id,instagram_user_id,instagram_permalink_url}",
          ].join(",");
  let url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/${edge}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "500");

  const rows: GraphRow[] = [];
  for (let page = 0; page < 10 && url; page += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as GraphPage;
    if (!res.ok || body.error) {
      const message =
        typeof body.error?.message === "string"
          ? body.error.message
          : `Meta Graph API ${edge} failed: HTTP ${res.status}`;
      throw new Error(message);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      rows.push({
        id: item.id,
        name: readString(item.name),
        status: readString(item.status),
        effectiveStatus: readString(item.effective_status),
        configuredStatus: readString(item.configured_status),
        campaignId: readString(item.campaign_id),
        adsetId: readString(item.adset_id),
        raw: item,
      });
    }
    const next = typeof body.paging?.next === "string" ? body.paging.next : "";
    if (!next) break;
    url = new URL(next);
    url.searchParams.delete("access_token");
  }
  return rows;
}

async function persistHierarchy(input: {
  prisma: PrismaClient;
  accountId: string;
  campaigns: GraphRow[];
  adsets: GraphRow[];
  ads: GraphRow[];
}): Promise<{ upserted: number }> {
  const campaignIds = new Map<string, string>();
  const adsetIds = new Map<string, string>();
  let upserted = 0;

  for (const row of input.campaigns) {
    const saved = await upsertNode(input.prisma, input.accountId, "campaign", row, null);
    campaignIds.set(row.id, saved.id);
    upserted += 1;
  }
  for (const row of input.adsets) {
    const saved = await upsertNode(
      input.prisma,
      input.accountId,
      "adset",
      row,
      row.campaignId ? campaignIds.get(row.campaignId) ?? null : null
    );
    adsetIds.set(row.id, saved.id);
    upserted += 1;
  }
  for (const row of input.ads) {
    await upsertNode(
      input.prisma,
      input.accountId,
      "ad",
      row,
      row.adsetId ? adsetIds.get(row.adsetId) ?? null : null
    );
    upserted += 1;
  }
  return { upserted };
}

async function upsertNode(
  prisma: PrismaClient,
  accountId: string,
  nodeType: NodeType,
  row: GraphRow,
  parentId: string | null
): Promise<{ id: string }> {
  const status = normalizeMetaStatus(row.effectiveStatus ?? row.status);
  const creative = nodeType === "ad" ? normalizeMetaCreative(row.raw) : null;
  const data = {
    displayName: row.name ?? row.id,
    status,
    externalId: row.id,
    parentId,
    spec: {
      source: "meta_graph_sync",
      configuredStatus: row.configuredStatus ?? row.status,
      effectiveStatus: row.effectiveStatus,
      syncedAt: new Date().toISOString(),
      ...(creative ? { creative } : {}),
      raw: row.raw,
    } as unknown as Prisma.InputJsonValue,
  };
  return prisma.adsHierarchyNode.upsert({
    where: {
      accountId_nodeType_nodeKey: {
        accountId,
        nodeType,
        nodeKey: row.id,
      },
    },
    update: data,
    create: {
      accountId,
      nodeType,
      nodeKey: row.id,
      ...data,
    },
    select: { id: true },
  });
}

async function fetchGraphInsights(
  accountId: string,
  accessToken: string,
  metricDate: string,
  cvEvent: string | null
): Promise<GraphInsightsRow[]> {
  const levels: InsightsLevel[] = ["campaign", "adset", "ad"];
  const nested = await Promise.all(
    levels.map((level) => fetchGraphInsightsLevel(accountId, level, accessToken, metricDate, cvEvent))
  );
  return nested.flat();
}

async function fetchGraphInsightsLevel(
  accountId: string,
  level: InsightsLevel,
  accessToken: string,
  metricDate: string,
  cvEvent: string | null
): Promise<GraphInsightsRow[]> {
  let url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/insights`);
  url.searchParams.set("level", level);
  url.searchParams.set("fields", insightsFieldsForLevel(level));
  url.searchParams.set("time_range", JSON.stringify({ since: metricDate, until: metricDate }));
  url.searchParams.set("limit", "500");

  const rows: GraphInsightsRow[] = [];
  for (let page = 0; page < 10 && url; page += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as GraphPage;
    if (!res.ok || body.error) {
      const message =
        typeof body.error?.message === "string"
          ? body.error.message
          : `Meta Graph API insights failed: HTTP ${res.status}`;
      throw new Error(message);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      if (!isRecord(item)) continue;
      const nodeKey = readString(item[`${level}_id`]) ?? readString(item.id);
      if (!nodeKey) continue;
      rows.push({
        nodeType: level,
        nodeKey,
        raw: item,
        impressions: integerField(item, "impressions"),
        clicks: integerField(item, "clicks"),
        spendMicros: majorToMicros(numberField(item, "spend")),
        conversions: resolveRowConversions(item, cvEvent),
      });
    }
    const next = typeof body.paging?.next === "string" ? body.paging.next : "";
    if (!next) break;
    url = new URL(next);
    url.searchParams.delete("access_token");
  }
  return rows;
}

async function persistPerformanceSnapshots(input: {
  prisma: PrismaClient;
  accountId: string;
  metricDate: string;
  rows: GraphInsightsRow[];
}): Promise<number> {
  if (input.rows.length === 0) return 0;
  const nodes = await input.prisma.adsHierarchyNode.findMany({
    where: {
      accountId: input.accountId,
      nodeType: { in: ["campaign", "adset", "ad"] },
    },
    select: { id: true, nodeType: true, nodeKey: true, externalId: true },
  });
  const nodeIdByKey = new Map<string, string>();
  for (const node of nodes) {
    nodeIdByKey.set(metricNodeKey(node.nodeType, node.nodeKey), node.id);
    if (node.externalId) nodeIdByKey.set(metricNodeKey(node.nodeType, node.externalId), node.id);
  }

  const metricDate = new Date(`${input.metricDate}T00:00:00.000Z`);
  let snapshots = 0;
  for (const row of input.rows) {
    const hierarchyId = nodeIdByKey.get(metricNodeKey(row.nodeType, row.nodeKey)) ?? null;
    await input.prisma.performanceSnapshot.upsert({
      where: {
        accountId_nodeType_nodeKey_metricDate: {
          accountId: input.accountId,
          nodeType: row.nodeType,
          nodeKey: row.nodeKey,
          metricDate,
        },
      },
      update: {
        hierarchyId,
        impressions: row.impressions,
        clicks: row.clicks,
        spendMicros: row.spendMicros,
        conversions: row.conversions,
        raw: row.raw as Prisma.InputJsonValue,
        source: "meta_graph_insights",
      },
      create: {
        accountId: input.accountId,
        hierarchyId,
        nodeType: row.nodeType,
        nodeKey: row.nodeKey,
        metricDate,
        impressions: row.impressions,
        clicks: row.clicks,
        spendMicros: row.spendMicros,
        conversions: row.conversions,
        raw: row.raw as Prisma.InputJsonValue,
        source: "meta_graph_insights",
      },
    });
    snapshots += 1;
  }
  return snapshots;
}

function insightsFieldsForLevel(level: InsightsLevel): string {
  const identity =
    level === "campaign"
      ? "campaign_id,campaign_name"
      : level === "adset"
        ? "adset_id,adset_name,campaign_id"
        : "ad_id,ad_name,adset_id,campaign_id";
  return `${identity},spend,impressions,clicks,actions,date_start,date_stop`;
}

function normalizeMetaCreative(rawAd: Record<string, unknown>): MetaCreativeSpec | null {
  const rawCreative = isRecord(rawAd.creative) ? rawAd.creative : null;
  if (!rawCreative) return null;
  const objectStorySpec = isRecord(rawCreative.object_story_spec)
    ? rawCreative.object_story_spec
    : {};
  const headline = firstString([
    readString(rawCreative.title),
    readNestedString(objectStorySpec, ["link_data", "name"]),
    readNestedString(objectStorySpec, ["video_data", "title"]),
    readNestedString(objectStorySpec, ["template_data", "name"]),
  ]);
  const primaryText = firstString([
    readString(rawCreative.body),
    readNestedString(objectStorySpec, ["link_data", "message"]),
    readNestedString(objectStorySpec, ["video_data", "message"]),
    readNestedString(objectStorySpec, ["template_data", "message"]),
  ]);
  const callToAction = firstString([
    readString(rawCreative.call_to_action_type),
    readNestedString(objectStorySpec, ["link_data", "call_to_action", "type"]),
    readNestedString(objectStorySpec, ["video_data", "call_to_action", "type"]),
    readNestedString(objectStorySpec, ["template_data", "call_to_action", "type"]),
  ]);
  const linkUrl = firstString([
    readString(rawCreative.object_url),
    readString(rawCreative.template_url),
    readNestedString(objectStorySpec, ["link_data", "link"]),
    readNestedString(objectStorySpec, ["link_data", "call_to_action", "value", "link"]),
    readNestedString(objectStorySpec, ["video_data", "call_to_action", "value", "link"]),
    readNestedString(objectStorySpec, ["template_data", "link"]),
    readNestedString(objectStorySpec, ["template_data", "call_to_action", "value", "link"]),
  ]);
  const out: MetaCreativeSpec = {
    key: readString(rawCreative.id) ?? undefined,
    displayName: readString(rawCreative.name) ?? undefined,
    mediaType: readString(rawCreative.video_id) ? "video" : "image",
    headline: headline ?? undefined,
    primaryText: primaryText ?? undefined,
    callToAction: callToAction ?? undefined,
    linkUrl: linkUrl ?? undefined,
    pageId: readNestedString(objectStorySpec, ["page_id"]) ?? undefined,
    instagramUserId:
      readString(rawCreative.instagram_user_id) ??
      readNestedString(objectStorySpec, ["instagram_user_id"]) ??
      undefined,
  };
  return Object.values(out).some((value) => value !== undefined) ? out : null;
}

function normalizeMetaStatus(value: string | null): "active" | "paused" | "archived" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "archived" || normalized === "deleted") return "archived";
  return "paused";
}

function metricNodeKey(nodeType: string, nodeKey: string): string {
  return `${nodeType}:${nodeKey}`;
}

function currentDateForTimeZone(timeZone: string | null): string {
  const safeTimeZone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// CV 抽出は meta-cv-event.ts の resolveRowConversions に集約した (daily_report と共通)。
// 以前はここで action_type を部分一致で合計していたため、同一 CV を返す複数の別名
// (purchase / omni_purchase / offsite_conversion.fb_pixel_purchase ...) を多重計上していた。

function integerField(row: Record<string, unknown>, key: string): number {
  return Math.max(0, Math.floor(numberField(row, key)));
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function majorToMicros(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

function firstString(values: Array<string | null>): string | null {
  return values.find((value): value is string => value !== null) ?? null;
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return readString(current);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
