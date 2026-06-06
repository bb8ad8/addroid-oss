import { type PrismaClient } from "@addroid/db";
import { META_GRAPH_API_VERSION, fetchInsights } from "@addroid/meta-adapter";
import { buildPrismaMetaAdapterSelection } from "./meta-runtime.js";

export async function runMetaAdsReadOnlyQuery(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  args: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<{ label: string; rows: unknown[]; rowCount: number; message: string }> {
  const env = opts.env ?? process.env;
  const resource = normalizeMetaResource(requireMetaString(opts.args, "resource"));
  const action = readMetaStringArg(opts.args, "action") ?? (resource === "insights" ? "get" : "list");
  const accountKey = readMetaStringArg(opts.args, "accountKey", "account_key");
  const account = accountKey
    ? await opts.prisma.adAccount.findFirst({
        where: { workspaceId: opts.workspaceId, OR: [{ key: accountKey }, { metaAccountId: accountKey }] },
        orderBy: { updatedAt: "desc" },
      })
    : await opts.prisma.adAccount.findFirst({
        where: { workspaceId: opts.workspaceId, active: true },
        orderBy: { updatedAt: "desc" },
      });
  let label = `${resource} ${action}`;
  let rows: unknown[] = [];
  if (resource === "insights") {
    const adAccountId = account?.metaAccountId ?? account?.key ?? accountKey;
    if (!adAccountId) throw new Error("広告アカウントが選択されていません。`addroid account` で選択してください。");
    const selection = await buildPrismaMetaAdapterSelection({ prisma: opts.prisma, env });
    const lease = await selection.adapter.loadAccessTokenPlaintext();
    if (!lease) throw new Error("Meta token が未接続です。`addroid connect meta` を実行してください。");
    const fields = readStringArray(opts.args.fields);
    rows = await fetchInsights({
      accessToken: lease.accessToken,
      adAccountId,
      fields: fields.length ? fields : ["spend", "impressions", "clicks", "ctr", "cpc", "reach", "frequency", "cpm", "cpp", "actions"],
      level: graphInsightsLevel(opts.args),
      datePreset: readMetaStringArg(opts.args, "datePreset", "date_preset") ?? undefined,
      timeRange:
        readMetaStringArg(opts.args, "since") || readMetaStringArg(opts.args, "until")
          ? {
              since: readMetaStringArg(opts.args, "since") ?? readMetaStringArg(opts.args, "until")!,
              until: readMetaStringArg(opts.args, "until") ?? readMetaStringArg(opts.args, "since")!,
            }
          : undefined,
      timeIncrement: normalizeTimeIncrement(
        readMetaStringArg(opts.args, "timeIncrement", "time_increment")
      ),
      breakdowns: readStringArray(opts.args.breakdowns).concat(readStringArray(opts.args.breakdown)),
      limit: readPositiveInt(opts.args.limit) ?? 100,
    });
    label = "insights";
  } else if (resource === "adaccount") {
    if (!account) throw new Error("広告アカウントが選択されていません。`addroid account` で選択してください。");
    const selection = await buildPrismaMetaAdapterSelection({ prisma: opts.prisma, env });
    const lease = await selection.adapter.loadAccessTokenPlaintext();
    if (!lease) throw new Error("Meta token が未接続です。`addroid connect meta` を実行してください。");
    rows = await fetchGraphReadRows({
      accessToken: lease.accessToken,
      resource,
      action,
      accountId: account.metaAccountId ?? account.key,
      args: opts.args,
      prisma: opts.prisma,
      accountDbId: account.id,
    });
  } else if (resource === "campaign" || resource === "adset" || resource === "ad" || resource === "creative" || resource === "page") {
    if (!account) throw new Error("広告アカウントが選択されていません。`addroid account` で選択してください。");
    const selection = await buildPrismaMetaAdapterSelection({ prisma: opts.prisma, env });
    const lease = await selection.adapter.loadAccessTokenPlaintext();
    if (!lease) throw new Error("Meta token が未接続です。`addroid connect meta` を実行してください。");
    rows = await fetchGraphReadRows({
      accessToken: lease.accessToken,
      resource,
      action,
      accountId: account.metaAccountId ?? account.key,
      args: opts.args,
      prisma: opts.prisma,
      accountDbId: account.id,
    });
  }
  return {
    label,
    rows,
    rowCount: rows.length,
    message: `Meta Ads から ${label} を取得しました。結果: ${rows.length}件`,
  };
}

async function fetchGraphReadRows(input: {
  accessToken: string;
  resource: MetaReadOnlyResource;
  action: string;
  accountId: string;
  args: Record<string, unknown>;
  prisma: PrismaClient;
  accountDbId: string;
}): Promise<unknown[]> {
  const accountPath = normalizeGraphAccountId(input.accountId);
  if (input.resource === "adaccount") {
    return [
      await fetchGraphObject(accountPath, input.accessToken, {
        fields: "id,account_id,name,account_status,currency,timezone_name,business{id,name}",
      }),
    ];
  }
  if (input.resource === "page") {
    const id = readMetaResourceId(input.resource, input.args);
    if (!id) return [];
    return [await fetchGraphObject(id, input.accessToken, { fields: "id,name,instagram_business_account{id,username},connected_instagram_account{id,username}" })];
  }
  if (input.resource === "creative") {
    const id = readMetaResourceId(input.resource, input.args);
    if (id) {
      return [await fetchGraphObject(id, input.accessToken, { fields: graphFieldsForResource(input.resource) })];
    }
    return fetchGraphEdgeRows(`${accountPath}/adcreatives`, input.accessToken, {
      fields: graphFieldsForResource(input.resource),
      limit: String(readPositiveInt(input.args.limit) ?? 50),
    });
  }
  if (input.resource === "campaign" || input.resource === "adset" || input.resource === "ad") {
    const id = await resolveMetaReadId(input);
    if (id && (input.action === "get" || input.action === "current")) {
      return [await fetchGraphObject(id, input.accessToken, { fields: graphFieldsForResource(input.resource) })];
    }
    const edgePath = await graphListPath(input, accountPath);
    return fetchGraphEdgeRows(edgePath, input.accessToken, {
      fields: graphFieldsForResource(input.resource),
      limit: String(readPositiveInt(input.args.limit) ?? 50),
    });
  }
  return [];
}

async function graphListPath(
  input: {
    resource: MetaReadOnlyResource;
    args: Record<string, unknown>;
    prisma: PrismaClient;
    accountDbId: string;
  },
  accountPath: string
): Promise<string> {
  if (input.resource === "campaign") return `${accountPath}/campaigns`;
  if (input.resource === "adset") {
    const campaignId = await resolveHierarchyId(input.prisma, input.accountDbId, "campaign", readMetaStringArg(input.args, "campaignId", "campaign_id"));
    return campaignId ? `${campaignId}/adsets` : `${accountPath}/adsets`;
  }
  if (input.resource === "ad") {
    const adsetId = await resolveHierarchyId(input.prisma, input.accountDbId, "adset", readMetaStringArg(input.args, "adsetId", "adset_id"));
    if (adsetId) return `${adsetId}/ads`;
    const campaignId = await resolveHierarchyId(input.prisma, input.accountDbId, "campaign", readMetaStringArg(input.args, "campaignId", "campaign_id"));
    return campaignId ? `${campaignId}/ads` : `${accountPath}/ads`;
  }
  return accountPath;
}

async function resolveMetaReadId(input: {
  resource: MetaReadOnlyResource;
  args: Record<string, unknown>;
  prisma: PrismaClient;
  accountDbId: string;
}): Promise<string | null> {
  const raw = readMetaResourceId(input.resource, input.args);
  if (!raw) return null;
  if (input.resource === "campaign" || input.resource === "adset" || input.resource === "ad") {
    return await resolveHierarchyId(input.prisma, input.accountDbId, input.resource, raw);
  }
  return raw;
}

async function resolveHierarchyId(
  prisma: PrismaClient,
  accountDbId: string,
  nodeType: "campaign" | "adset" | "ad",
  raw: string | null
): Promise<string | null> {
  if (!raw) return null;
  const row = await prisma.adsHierarchyNode.findFirst({
    where: {
      accountId: accountDbId,
      nodeType,
      OR: [{ id: raw }, { externalId: raw }, { nodeKey: raw }],
    },
    orderBy: { updatedAt: "desc" },
    select: { externalId: true },
  });
  return row?.externalId || raw;
}

async function fetchGraphObject(
  path: string,
  accessToken: string,
  params: Record<string, string>
): Promise<unknown> {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw graphReadError(response.status, json);
  if (isRecord(json) && isRecord(json.error)) throw graphReadError(response.status, json);
  return json;
}

async function fetchGraphEdgeRows(
  path: string,
  accessToken: string,
  params: Record<string, string>
): Promise<unknown[]> {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw graphReadError(response.status, json);
  if (isRecord(json) && isRecord(json.error)) throw graphReadError(response.status, json);
  return extractMetaAdsReadOnlyRows(json);
}

function graphReadError(status: number, payload: unknown): Error {
  const message = isRecord(payload) && isRecord(payload.error)
    ? readOptionalString(payload.error.message) ?? `Meta Graph read failed (${status})`
    : `Meta Graph read failed (${status})`;
  return new Error(message);
}

function graphFieldsForResource(resource: MetaReadOnlyResource): string {
  switch (resource) {
    case "campaign":
      return "id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,bid_strategy,spend_cap,special_ad_categories,special_ad_category_country,is_adset_budget_sharing_enabled,created_time,updated_time,start_time,stop_time";
    case "adset":
      return "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_amount,bid_strategy,bid_constraints,targeting,promoted_object,attribution_spec,destination_type,frequency_control_specs,pacing_type,daily_spend_cap,lifetime_spend_cap,daily_min_spend_target,lifetime_min_spend_target,is_dynamic_creative,created_time,updated_time,start_time,end_time";
    case "ad":
      return "id,name,status,effective_status,campaign_id,adset_id,creative{id,name,title,body,call_to_action_type,object_url,template_url,object_story_spec,thumbnail_url,image_url,video_id,effective_object_story_id,instagram_user_id,instagram_permalink_url},tracking_specs,conversion_specs,created_time,updated_time";
    case "creative":
      return "id,name,title,body,call_to_action_type,object_url,template_url,object_story_spec,thumbnail_url,image_url,video_id,effective_object_story_id,instagram_user_id,instagram_permalink_url,asset_feed_spec,degrees_of_freedom_spec,url_tags";
    default:
      return "id,name";
  }
}

function normalizeGraphAccountId(value: string): string {
  return value.startsWith("act_") ? value : `act_${value}`;
}

function graphInsightsLevel(args: Record<string, unknown>): "account" | "campaign" | "adset" | "ad" {
  if (readMetaStringArg(args, "adId", "ad_id")) return "ad";
  if (readMetaStringArg(args, "adsetId", "adset_id")) return "adset";
  if (readMetaStringArg(args, "campaignId", "campaign_id")) return "campaign";
  const level = readMetaStringArg(args, "level");
  return level === "campaign" || level === "adset" || level === "ad" ? level : "account";
}

/**
 * Meta insights の `time_increment` を有効値だけに正規化する。
 * Meta が受け付けるのは整数 1〜90 (日数)・"monthly"・"all_days" のみ。
 * それ以外 (例: "weekly", "daily", "7d") は HTTP 400 になるので落として
 * 期間集計 (= 増分なし) にフォールバックする。エージェントが誤った値を渡しても
 * 無駄な 400 を出さないための防御。
 */
function normalizeTimeIncrement(raw: string | null | undefined): string | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "monthly" || v === "all_days") return v;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 90) return String(n);
  return undefined;
}

type MetaReadOnlyResource =
  | "insights" | "adaccount" | "campaign" | "adset" | "ad" | "creative"
  | "catalog" | "dataset" | "page" | "product_feed" | "product_item" | "product_set";

function normalizeMetaResource(value: string): MetaReadOnlyResource {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const allowed: MetaReadOnlyResource[] = ["insights", "adaccount", "campaign", "adset", "ad", "creative", "catalog", "dataset", "page", "product_feed", "product_item", "product_set"];
  if (allowed.includes(normalized as MetaReadOnlyResource)) return normalized as MetaReadOnlyResource;
  throw new Error(`resource は ${allowed.join(" / ")} のいずれかで指定してください`);
}

function readMetaResourceId(resource: MetaReadOnlyResource, args: Record<string, unknown>): string | null {
  const keys: Partial<Record<MetaReadOnlyResource, string[]>> = {
    adaccount: ["accountId", "account_id", "adAccountId", "ad_account_id"],
    campaign: ["campaignId", "campaign_id"],
    adset: ["adsetId", "adset_id"],
    ad: ["adId", "ad_id"],
    creative: ["creativeId", "creative_id"],
    catalog: ["catalogId", "catalog_id"],
    dataset: ["datasetId", "dataset_id", "pixelId", "pixel_id"],
    page: ["pageId", "page_id"],
    product_feed: ["productFeedId", "product_feed_id"],
    product_item: ["productItemId", "product_item_id"],
    product_set: ["productSetId", "product_set_id"],
  };
  for (const key of keys[resource] ?? []) {
    const value = readOptionalString(args[key]);
    if (value) return value;
  }
  return readOptionalString(args.id);
}

function requireMetaString(args: Record<string, unknown>, key: string): string {
  const value = readOptionalString(args[key]);
  if (!value) throw new Error(`${key} を指定してください`);
  return value;
}

function readMetaStringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = readOptionalString(args[key]);
    if (value) return value;
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []) : [];
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function extractMetaAdsReadOnlyRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.results)) return payload.results;
    if (Object.keys(payload).length > 0) return [payload];
  }
  return [];
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
