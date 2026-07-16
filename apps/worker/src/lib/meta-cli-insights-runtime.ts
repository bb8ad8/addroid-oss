// AdDroid OSS — Meta Graph API backed daily-report insights provider.
//
// This provider keeps the current DailyReportInsightsProvider contract intact
// while using Graph API as the canonical read path.

import { spawn as nodeSpawn } from "node:child_process";
import { CiphertextFormatError } from "@addroid/config";
import {
  fetchInsights,
  MetaCliMissingTokenError,
  MetaCliRunner,
  MetaCliUnsupportedOperationError,
  MetaCliVersionUnverifiedError,
  type MetaAdapter,
  type MetaCliExecutionResult,
  type MetaCliRunnerOptions,
  type MetaCliVersionVerification,
} from "@addroid/meta-adapter";
import {
  enabledBreakdownLevels,
  subtractOneUtcDay,
  type DailyReportInsightsProvider,
  type DailyReportInsightsRequest,
  type DailyReportInsightsResponse,
  type DailyReportInsightsRow,
  type DailyReportNodeType,
} from "@addroid/queue";
import { META_CLI_MIN_VERSION } from "./apply-meta-executor.js";

export interface MetaCliDailyReportInsightsProviderOptions {
  runner: Pick<MetaCliRunner, "run">;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null | undefined>;
  fields?: string[];
  conversionActionTypes?: string[];
  timeoutMs?: number;
}

export class MetaCliDailyReportInsightsProvider implements DailyReportInsightsProvider {
  private readonly runner: Pick<MetaCliRunner, "run">;
  private readonly resolveAdAccountId:
    | ((accountKey: string) => Promise<string | null | undefined>)
    | undefined;
  private readonly fields: string[];
  private readonly conversionActionTypes: string[];
  private readonly timeoutMs: number;
  private readonly maxNodesPerLevel: number;

  constructor(opts: MetaCliDailyReportInsightsProviderOptions) {
    this.runner = opts.runner;
    this.resolveAdAccountId = opts.resolveAdAccountId;
    this.fields = opts.fields ?? [
      "spend",
      "impressions",
      "clicks",
      "reach",
      "inline_link_clicks",
      "conversions",
      "actions",
      "frequency",
      "video_thruplay_watched_actions",
      // video_3_sec_watched_actions removed: Meta Insights API no longer accepts this
      // as a fields parameter and returns HTTP 400. Use actions[action_type=video_view]
      // as a fallback instead. See Issue #40.
      "quality_ranking",
      "engagement_rate_ranking",
      "conversion_rate_ranking",
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "ad_id",
      "ad_name",
      "account_id",
      "account_name",
    ];
    this.conversionActionTypes = opts.conversionActionTypes ?? [
      "purchase",
      "lead",
      "complete_registration",
      "offsite_conversion",
      "omni_purchase",
    ];
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxNodesPerLevel = Number(process.env.ADDROID_META_CLI_DAILY_REPORT_MAX_NODES ?? 50);
  }

  async fetchInsights(
    req: DailyReportInsightsRequest
  ): Promise<DailyReportInsightsResponse> {
    const levels = enabledBreakdownLevels(req.breakdownsPolicy ?? {
      fetchAccount: true,
      fetchCampaign: true,
      fetchAdset: true,
      fetchAd: true,
      synthesizeAccountFromCampaigns: true,
    });
    const adAccountId = this.resolveAdAccountId
      ? await this.resolveAdAccountId(req.accountKey)
      : null;
    const current: DailyReportInsightsRow[] = [];
    const prior: DailyReportInsightsRow[] = [];
    const details: string[] = [];
    const errors: string[] = [];

    for (const level of levels) {
      try {
        const currentResult = await this.fetchPeriod({
          accountKey: req.accountKey,
          adAccountId,
          level,
          metricDate: req.metricDate,
        });
        current.push(...currentResult.rows);
        details.push(currentResult.detail);
        if (req.includePriorPeriod) {
          const priorDate = subtractOneUtcDay(req.metricDate);
          const priorResult = await this.fetchPeriod({
            accountKey: req.accountKey,
            adAccountId,
            level,
            metricDate: priorDate,
          });
          prior.push(...priorResult.rows);
          details.push(priorResult.detail);
        }
      } catch (err) {
        errors.push(`${level}: ${summarizeCliInsightsError(err)}`);
      }
    }

    if (current.length === 0 && prior.length === 0 && errors.length > 0) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: errors.join("; "),
      };
    }

    return {
      current,
      prior,
      source: "meta_ads_cli",
      detail: [...details.filter(Boolean), ...errors.map((e) => `partial failure ${e}`)].join("; "),
    };
  }

  private async fetchPeriod(input: {
    accountKey: string;
    adAccountId?: string | null;
    level: DailyReportNodeType;
    metricDate: string;
  }): Promise<{ rows: DailyReportInsightsRow[]; detail: string }> {
    if (input.level === "account") {
      const result = await this.runInsights(input, {});
      return {
        rows: parseInsightsRows(result, input.level, this.conversionActionTypes),
        detail: `${input.level}/${input.metricDate}: ${result.exitClass}`,
      };
    }

    const nodes = await this.listNodes(input, input.level);
    const rows: DailyReportInsightsRow[] = [];
    for (const node of nodes.slice(0, this.maxNodesPerLevel)) {
      const filter =
        input.level === "campaign"
          ? { campaignId: node.id }
          : input.level === "adset"
            ? { adsetId: node.id }
            : { adId: node.id };
      const result = await this.runInsights(input, filter);
      const payload = withFilterIdentity(
        parseJson(result.stdout),
        input.level,
        node.id,
        node.name
      );
      rows.push(...parseInsightsPayload(payload, input.level, this.conversionActionTypes));
    }
    return {
      rows,
      detail: `${input.level}/${input.metricDate}: ${nodes.length} node(s) listed, ${Math.min(nodes.length, this.maxNodesPerLevel)} queried`,
    };
  }

  private async runInsights(
    input: {
      accountKey: string;
      adAccountId?: string | null;
      level: DailyReportNodeType;
      metricDate: string;
    },
    filter: { campaignId?: string; adsetId?: string; adId?: string }
  ): Promise<MetaCliExecutionResult> {
    const args = [
      "--output",
      "json",
      "ads",
      "insights",
      "get",
      "--fields",
      this.compatibleFields(input.level).join(","),
      "--since",
      input.metricDate,
      "--until",
      input.metricDate,
      "--limit",
      "100",
    ];
    if (filter.campaignId) args.push("--campaign-id", filter.campaignId);
    if (filter.adsetId) args.push("--adset-id", filter.adsetId);
    if (filter.adId) args.push("--ad-id", filter.adId);
    const result = await this.runner.run({
      accountKey: input.accountKey,
      adAccountId: input.adAccountId ?? null,
      args,
      timeoutMs: this.timeoutMs,
    });
    if (result.exitClass !== "success") {
      throw new Error(formatCliFailure(`meta ads insights get failed for ${input.level}/${input.metricDate}`, result));
    }
    return result;
  }

  private async listNodes(
    input: {
      accountKey: string;
      adAccountId?: string | null;
    },
    level: Exclude<DailyReportNodeType, "account">
  ): Promise<Array<{ id: string; name: string | null }>> {
    const resource = level === "campaign" ? "campaign" : level === "adset" ? "adset" : "ad";
    const result = await this.runner.run({
      accountKey: input.accountKey,
      adAccountId: input.adAccountId ?? null,
      args: ["--output", "json", "ads", resource, "list"],
      timeoutMs: this.timeoutMs,
    });
    if (result.exitClass !== "success") {
      throw new Error(formatCliFailure(`meta ads ${resource} list failed`, result));
    }
    return extractArray(parseJson(result.stdout))
      .filter(isRecord)
      .flatMap((row) => {
        const id =
          stringField(row, "id") ??
          (level === "campaign"
            ? stringField(row, "campaign_id")
            : level === "adset"
              ? stringField(row, "adset_id")
              : stringField(row, "ad_id"));
        if (!id) return [];
        return [{ id, name: stringField(row, "name") ?? inferDisplayName(row, level) }];
      });
  }

  private compatibleFields(level: DailyReportNodeType): string[] {
    const allowed = new Set([
      "spend",
      "impressions",
      "clicks",
      "ctr",
      "cpc",
      "reach",
      "inline_link_clicks",
      "conversions",
      "actions",
      "frequency",
      "video_thruplay_watched_actions",
      // video_3_sec_watched_actions removed: Meta Insights API no longer accepts this
      // as a fields parameter and returns HTTP 400. See Issue #40.
      "quality_ranking",
      "engagement_rate_ranking",
      "conversion_rate_ranking",
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "ad_id",
      "ad_name",
      "account_id",
      "account_name",
    ]);
    return fieldsForInsightsLevel(
      this.fields.filter((field) => allowed.has(field)),
      level
    );
  }
}

export class GraphApiDailyReportInsightsProvider implements DailyReportInsightsProvider {
  private readonly metaAdapter: MetaAdapter;
  private readonly resolveAdAccountId:
    | ((accountKey: string) => Promise<string | null | undefined>)
    | undefined;
  private readonly fields: string[];
  private readonly conversionActionTypes: string[];

  constructor(opts: {
    metaAdapter: MetaAdapter;
    resolveAdAccountId?: (accountKey: string) => Promise<string | null | undefined>;
    fields?: string[];
    conversionActionTypes?: string[];
  }) {
    this.metaAdapter = opts.metaAdapter;
    this.resolveAdAccountId = opts.resolveAdAccountId;
    this.fields = opts.fields ?? [
      "spend",
      "impressions",
      "clicks",
      "reach",
      "inline_link_clicks",
      "conversions",
      "actions",
      "frequency",
      "video_thruplay_watched_actions",
      // video_3_sec_watched_actions removed: Meta Insights API no longer accepts this
      // as a fields parameter and returns HTTP 400. Use actions[action_type=video_view]
      // as a fallback instead. See Issue #40.
      "quality_ranking",
      "engagement_rate_ranking",
      "conversion_rate_ranking",
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "ad_id",
      "ad_name",
      "account_id",
      "account_name",
    ];
    this.conversionActionTypes = opts.conversionActionTypes ?? [
      "purchase",
      "lead",
      "complete_registration",
      "offsite_conversion",
      "omni_purchase",
    ];
  }

  async fetchInsights(
    req: DailyReportInsightsRequest
  ): Promise<DailyReportInsightsResponse> {
    const lease = await this.metaAdapter.loadAccessTokenPlaintext();
    if (!lease) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: "Meta access token is missing; reconnect Meta.",
      };
    }
    const adAccountId = this.resolveAdAccountId
      ? await this.resolveAdAccountId(req.accountKey)
      : req.accountKey;
    if (!adAccountId) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: "Meta ad account id is missing.",
      };
    }
    const levels = enabledBreakdownLevels(req.breakdownsPolicy ?? {
      fetchAccount: true,
      fetchCampaign: true,
      fetchAdset: true,
      fetchAd: true,
      synthesizeAccountFromCampaigns: true,
    });
    const current: DailyReportInsightsRow[] = [];
    const prior: DailyReportInsightsRow[] = [];
    try {
      for (const level of levels) {
        const rows = await fetchInsights({
          accessToken: lease.accessToken,
          adAccountId,
          fields: fieldsForInsightsLevel(this.fields, level),
          level,
          timeRange: { since: req.metricDate, until: req.metricDate },
        });
        current.push(
          ...parseInsightsPayload(rows, level, this.conversionActionTypes)
        );
        if (req.includePriorPeriod) {
          const priorDate = subtractOneUtcDay(req.metricDate);
          const priorRows = await fetchInsights({
            accessToken: lease.accessToken,
            adAccountId,
            fields: fieldsForInsightsLevel(this.fields, level),
            level,
            timeRange: { since: priorDate, until: priorDate },
          });
          prior.push(
            ...parseInsightsPayload(priorRows, level, this.conversionActionTypes)
          );
        }
      }
    } catch (err) {
      return {
        current: [],
        prior: [],
        source: "unavailable",
        detail: err instanceof Error ? err.message : "Meta Graph insights failed.",
      };
    }
    return {
      current,
      prior,
      source: "graph_api",
      detail: "Meta Graph API insights fallback",
    };
  }
}

export interface ResolveMetaCliInsightsProviderOptions {
  metaAdapter: MetaAdapter;
  env?: NodeJS.ProcessEnv;
  resolveAdAccountId?: (accountKey: string) => Promise<string | null | undefined>;
  spawnImpl?: MetaCliRunnerOptions["spawnImpl"];
  versionResolver?: MetaCliRunnerOptions["versionResolver"];
}

export interface MetaCliInsightsProviderSelection {
  provider: DailyReportInsightsProvider | null;
  mode: "cli" | "graph_api" | "unconfigured";
  reason: string;
  versionVerification?: MetaCliVersionVerification;
}

export async function resolveMetaCliInsightsProvider(
  opts: ResolveMetaCliInsightsProviderOptions
): Promise<MetaCliInsightsProviderSelection> {
  const env = opts.env ?? process.env;
  return {
    provider: new GraphApiDailyReportInsightsProvider({
      metaAdapter: opts.metaAdapter,
      ...(opts.resolveAdAccountId ? { resolveAdAccountId: opts.resolveAdAccountId } : {}),
    }),
    mode: "graph_api",
    reason: "using Meta Graph API as canonical insights provider; Meta Ads CLI is optional diagnostic only",
  };

  /*
   * Internal future/diagnostic CLI path. Kept for reuse, but not selected by
   * operator-facing environment variables while Graph API is the canonical route.
   */
  const binaryPath = env.ADDROID_META_CLI_BIN?.trim();
  if (!binaryPath) {
    if (env.ADDROID_META_GRAPH_INSIGHTS_FALLBACK === "1") {
      return {
        provider: new GraphApiDailyReportInsightsProvider({
          metaAdapter: opts.metaAdapter,
          ...(opts.resolveAdAccountId ? { resolveAdAccountId: opts.resolveAdAccountId } : {}),
        }),
        mode: "graph_api",
        reason:
          "ADDROID_META_CLI_BIN is not set; ADDROID_META_GRAPH_INSIGHTS_FALLBACK=1 selects Graph API read fallback",
      };
    }
    return {
      provider: null,
      mode: "unconfigured",
      reason: "ADDROID_META_CLI_BIN is not set; daily_report insights use mock provider",
    };
  }
  const runner = new MetaCliRunner({
    binaryPath: binaryPath!,
    spawnImpl: opts.spawnImpl ?? nodeSpawn,
    minVersion: META_CLI_MIN_VERSION,
    requireVerifiedVersion: true,
    loadTokenForAccount: async () => {
      const lease = await opts.metaAdapter.loadAccessTokenPlaintext();
      if (!lease) return null;
      return { accessToken: lease.accessToken };
    },
    ...(opts.versionResolver ? { versionResolver: opts.versionResolver } : {}),
  });
  const verification = await runner.verifyVersion();
  return {
    provider: new MetaCliDailyReportInsightsProvider({
      runner,
      ...(opts.resolveAdAccountId ? { resolveAdAccountId: opts.resolveAdAccountId } : {}),
    }),
    mode: "cli",
    versionVerification: verification,
    reason: verification.ok
      ? `using meta-ads-cli at ${binaryPath} for insights (${verification.detail})`
      : `meta-ads-cli at ${binaryPath} failed version verification (${verification.detail}); insights will fail closed`,
  };
}

function parseInsightsRows(
  result: MetaCliExecutionResult,
  fallbackLevel: DailyReportNodeType,
  conversionActionTypes: readonly string[]
): DailyReportInsightsRow[] {
  const payload = parseJson(result.stdout);
  return parseInsightsPayload(payload, fallbackLevel, conversionActionTypes);
}

function withFilterIdentity(
  payload: unknown,
  level: DailyReportNodeType,
  id: string,
  name: string | null
): unknown {
  const rows = extractArray(payload);
  const patched = rows.map((row) => {
    if (!isRecord(row)) return row;
    const out: Record<string, unknown> = { ...row };
    if (level === "campaign") {
      out.campaign_id ??= id;
      if (name) out.campaign_name ??= name;
    } else if (level === "adset") {
      out.adset_id ??= id;
      if (name) out.adset_name ??= name;
    } else if (level === "ad") {
      out.ad_id ??= id;
      if (name) out.ad_name ??= name;
    }
    return out;
  });
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return { ...payload, data: patched };
  }
  return patched;
}

function parseInsightsPayload(
  payload: unknown,
  fallbackLevel: DailyReportNodeType,
  conversionActionTypes: readonly string[]
): DailyReportInsightsRow[] {
  const rows = extractArray(payload);
  const out: DailyReportInsightsRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const level = inferLevel(row, fallbackLevel);
    const nodeKey = inferNodeKey(row, level);
    if (!nodeKey) continue;
    out.push({
      nodeType: level,
      nodeKey,
      displayName: inferDisplayName(row, level) ?? undefined,
      spendMicros: majorToMicros(numberField(row, "spend")),
      impressions: integerField(row, "impressions"),
      clicks: integerField(row, "clicks"),
      conversions: extractConversions(row, conversionActionTypes),
      frequency: nullableNumberField(row, "frequency"),
      reach: nullableIntegerField(row, "reach"),
      linkClicks: nullableIntegerField(row, "inline_link_clicks"),
      videoThruPlays: extractActionValue(
        row.video_thruplay_watched_actions,
        "video_thruplay_watched_actions"
      ),
      // Prefer the legacy dedicated field if present (CLI runner backward compat),
      // otherwise fall back to actions[action_type=video_view] since
      // video_3_sec_watched_actions was removed from the Meta Insights API fields
      // parameter and now causes HTTP 400. See Issue #40.
      video3SecViews:
        extractActionValue(row.video_3_sec_watched_actions, "video_3_sec_watched_actions") ??
        extractActionValue(row.actions, "video_view"),
      qualityRanking: stringField(row, "quality_ranking"),
      engagementRateRanking: stringField(row, "engagement_rate_ranking"),
      conversionRateRanking: stringField(row, "conversion_rate_ranking"),
    });
  }
  return out;
}

export function fieldsForInsightsLevel(
  fields: readonly string[],
  level: DailyReportNodeType
): string[] {
  const rankingFields = new Set([
    "quality_ranking",
    "engagement_rate_ranking",
    "conversion_rate_ranking",
  ]);
  return fields.filter((field) => level === "ad" || !rankingFields.has(field));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return [];
}

function inferLevel(
  row: Record<string, unknown>,
  fallback: DailyReportNodeType
): DailyReportNodeType {
  const level = stringField(row, "level")?.toLowerCase();
  if (level === "account" || level === "campaign" || level === "adset" || level === "ad") {
    return level;
  }
  if (stringField(row, "ad_id")) return "ad";
  if (stringField(row, "adset_id")) return "adset";
  if (stringField(row, "campaign_id")) return "campaign";
  return fallback;
}

function inferNodeKey(
  row: Record<string, unknown>,
  level: DailyReportNodeType
): string | null {
  if (level === "ad") return stringField(row, "ad_id") ?? stringField(row, "id");
  if (level === "adset") return stringField(row, "adset_id") ?? stringField(row, "id");
  if (level === "campaign") return stringField(row, "campaign_id") ?? stringField(row, "id");
  return stringField(row, "account_id") ?? stringField(row, "id") ?? "account";
}

function inferDisplayName(
  row: Record<string, unknown>,
  level: DailyReportNodeType
): string | null {
  if (level === "ad") return stringField(row, "ad_name") ?? stringField(row, "name");
  if (level === "adset") return stringField(row, "adset_name") ?? stringField(row, "name");
  if (level === "campaign") return stringField(row, "campaign_name") ?? stringField(row, "name");
  return stringField(row, "account_name") ?? stringField(row, "name");
}

function extractConversions(
  row: Record<string, unknown>,
  actionTypes: readonly string[]
): number {
  const direct = numberField(row, "conversions");
  if (direct > 0) return Math.floor(direct);
  const actions = row.actions;
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const type = stringField(action, "action_type");
    if (!type) continue;
    if (actionTypes.some((needle) => type.includes(needle))) {
      total += numberField(action, "value");
    }
  }
  return Math.floor(total);
}

export function extractActionValue(
  actions: unknown,
  actionType: string
): number | null {
  if (!Array.isArray(actions)) return null;
  let total = 0;
  let found = false;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const type = stringField(action, "action_type");
    if (type !== actionType) continue;
    total += numberField(action, "value");
    found = true;
  }
  return found ? Math.max(0, Math.floor(total)) : null;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberField(row: Record<string, unknown>, key: string): number {
  return nullableNumberField(row, key) ?? 0;
}

function nullableNumberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function integerField(row: Record<string, unknown>, key: string): number {
  return Math.max(0, Math.floor(numberField(row, key)));
}

function nullableIntegerField(row: Record<string, unknown>, key: string): number | null {
  const value = nullableNumberField(row, key);
  return value === null ? null : Math.max(0, Math.floor(value));
}

function majorToMicros(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeCliInsightsError(err: unknown): string {
  if (err instanceof MetaCliVersionUnverifiedError) {
    return "Meta Ads CLI version is not verified for insights.";
  }
  if (err instanceof MetaCliMissingTokenError) {
    return "Meta access token is missing; reconnect Meta.";
  }
  if (
    err instanceof CiphertextFormatError ||
    (err instanceof Error && /ciphertext authentication failed|wrong key/i.test(err.message))
  ) {
    return "Meta access token cannot be decrypted with the current ENCRYPTION_KEY. Run `addroid connect meta` to reconnect Meta.";
  }
  if (err instanceof MetaCliUnsupportedOperationError) {
    return "Meta Ads CLI insights operation is not in the verified command matrix.";
  }
  return err instanceof Error ? err.message : "Meta Ads CLI insights failed.";
}

function formatCliFailure(prefix: string, result: MetaCliExecutionResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
  return detail
    ? `${prefix}: ${result.exitClass}. ${detail.slice(0, 800)}`
    : `${prefix}: ${result.exitClass}`;
}
