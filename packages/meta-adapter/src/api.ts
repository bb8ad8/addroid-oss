// AdDroid OSS — Meta Graph API 呼び出し (read-only / OAuth flow 用).
//
// 本ファイルは `Real adapter` から呼ばれる。token は引数で受け取り、レスポンスを
// 正規化された `MetaBusiness` / `MetaAdAccount` に変換して返す。
//
// 重要: token はこのモジュールでは **直接ログ出力しない**。エラー文も token を
// 含めずに組み立てる。

import { META_GRAPH_API_VERSION } from "./oauth.js";
import type { MetaAdAccount, MetaBusiness } from "./types.js";

export interface FetchAccountsOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
  /** 既定 25。Meta はデフォルトで page size 25。1 アカウントが個人で持つ範囲では十分。 */
  limit?: number;
}

export interface FetchInsightsOptions {
  accessToken: string;
  adAccountId: string;
  fields: string[];
  level?: "account" | "campaign" | "adset" | "ad";
  timeRange?: { since: string; until: string };
  datePreset?: string;
  timeIncrement?: string;
  breakdowns?: string[];
  actionAttributionWindows?: string[];
  limit?: number;
  fetchImpl?: typeof fetch;
}

const ME_FIELDS = "id,name";
const BUSINESS_FIELDS = "id,name";
const ADACCOUNT_FIELDS =
  "id,account_id,name,account_status,currency,timezone_name,business{id,name}";
const GRAPH_FETCH_MAX_ATTEMPTS = 3;
const GRAPH_FETCH_RETRY_BASE_MS = 350;

export interface MetaMeProfile {
  id: string;
  name: string;
}

export class MetaApiError extends Error {
  readonly status?: number;
  readonly payload?: unknown;
  constructor(message: string, opts?: { status?: number; payload?: unknown }) {
    super(message);
    this.name = "MetaApiError";
    this.status = opts?.status;
    this.payload = opts?.payload;
  }
}

/**
 * Meta のエラーレスポンス本文から人間可読の理由を抜き出す。
 * 本文に access token は含まれない (token は Authorization ヘッダ送信のため) が、
 * 念のため短く truncate する。理由が取れない場合は空文字。
 */
function extractMetaErrorDetail(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        error_user_title?: string;
        error_user_msg?: string;
        code?: number;
      };
    };
    const e = parsed?.error;
    if (!e) return "";
    const text =
      [e.error_user_title, e.error_user_msg, e.message]
        .find((s): s is string => typeof s === "string" && s.length > 0) ?? "";
    if (!text) return "";
    return (typeof e.code === "number" ? `(#${e.code}) ${text}` : text).slice(0, 300);
  } catch {
    return body.slice(0, 200);
  }
}

async function fetchGraph<T>(
  fetchImpl: typeof fetch,
  path: string,
  params: Record<string, string>,
  accessToken: string,
  origin: string
): Promise<T> {
  // access_token は Authorization ヘッダで送る。URL に含めない (アクセスログ漏洩防止)。
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const request = () =>
    fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  const res = await fetchGraphWithRetry(request, origin);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = extractMetaErrorDetail(text);
    throw new MetaApiError(
      `${origin}: Meta Graph HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
      { status: res.status, payload: text }
    );
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | T | null;
  if (!json || typeof json !== "object") {
    throw new MetaApiError(`${origin}: Meta Graph returned non-JSON body`);
  }
  if ((json as { error?: { message?: string } }).error) {
    const msg = (json as { error?: { message?: string } }).error?.message ?? "unknown";
    throw new MetaApiError(`${origin}: Meta Graph error: ${msg}`, { payload: json });
  }
  return json as T;
}

async function fetchGraphUrl<T>(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  origin: string
): Promise<T> {
  const request = () =>
    fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  const res = await fetchGraphWithRetry(request, origin);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = extractMetaErrorDetail(text);
    throw new MetaApiError(
      `${origin}: Meta Graph HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
      { status: res.status, payload: text }
    );
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | T | null;
  if (!json || typeof json !== "object") {
    throw new MetaApiError(`${origin}: Meta Graph returned non-JSON body`);
  }
  if ((json as { error?: { message?: string } }).error) {
    const msg = (json as { error?: { message?: string } }).error?.message ?? "unknown";
    throw new MetaApiError(`${origin}: Meta Graph error: ${msg}`, { payload: json });
  }
  return json as T;
}

async function fetchGraphWithRetry(
  request: () => Promise<Response>,
  origin: string
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= GRAPH_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (err) {
      lastErr = err;
      if (attempt >= GRAPH_FETCH_MAX_ATTEMPTS) break;
      await delay(GRAPH_FETCH_RETRY_BASE_MS * attempt);
    }
  }
  throw new MetaApiError(
    `${origin}: Meta Graph fetch failed after ${GRAPH_FETCH_MAX_ATTEMPTS} attempts: ${formatFetchError(lastErr)}`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFetchError(err: unknown): string {
  const error = err as Error & { cause?: unknown };
  const cause = error?.cause as { code?: string; errors?: Array<{ code?: string; address?: string }> } | undefined;
  const causeCode = cause?.code ? ` (${cause.code})` : "";
  const nested = Array.isArray(cause?.errors) && cause.errors.length > 0
    ? ` [${cause.errors.flatMap((item) => item.code ? [`${item.code}${item.address ? ` ${item.address}` : ""}`] : []).join(", ")}]`
    : "";
  return `${error?.message || String(err)}${causeCode}${nested}`;
}

export async function fetchMeProfile(opts: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<MetaMeProfile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const json = await fetchGraph<MetaMeProfile>(
    fetchImpl,
    "me",
    { fields: ME_FIELDS },
    opts.accessToken,
    "fetchMeProfile"
  );
  return { id: String(json.id ?? ""), name: String(json.name ?? "") };
}

export async function fetchBusinesses(opts: FetchAccountsOptions): Promise<MetaBusiness[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 25;
  type RawBusiness = { id: string; name: string };
type Page = { data?: RawBusiness[] };
type Paging = { paging?: { next?: string } };
  const out: MetaBusiness[] = [];
  const path = "me/businesses";
  const params: Record<string, string> = {
    fields: BUSINESS_FIELDS,
    limit: String(limit),
  };
  let nextUrl: string | null = null;
  do {
    const page: Page & Paging = nextUrl
      ? await fetchGraphUrl(fetchImpl, nextUrl, opts.accessToken, "fetchBusinesses")
      : await fetchGraph<Page & Paging>(
          fetchImpl,
          path,
          params,
          opts.accessToken,
          "fetchBusinesses"
        );
    for (const b of page.data ?? []) {
      if (!b?.id) continue;
      out.push({ id: String(b.id), name: String(b.name ?? ""), role: null });
    }
    nextUrl = page.paging?.next ?? null;
  } while (nextUrl);
  return out;
}

export async function fetchAdAccounts(opts: FetchAccountsOptions): Promise<MetaAdAccount[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 25;
  type RawAdAccount = {
    id: string;
    account_id: string;
    name: string;
    account_status?: number;
    currency?: string;
    timezone_name?: string;
    business?: { id: string; name?: string };
  };
  type Page = { data?: RawAdAccount[]; paging?: { next?: string } };
  const params: Record<string, string> = {
    fields: ADACCOUNT_FIELDS,
    limit: String(limit),
  };
  const out: MetaAdAccount[] = [];
  let nextUrl: string | null = null;
  do {
    const page: Page = nextUrl
      ? await fetchGraphUrl(fetchImpl, nextUrl, opts.accessToken, "fetchAdAccounts")
      : await fetchGraph<Page>(
          fetchImpl,
          "me/adaccounts",
          params,
          opts.accessToken,
          "fetchAdAccounts"
        );
    for (const a of page.data ?? []) {
      if (!a?.account_id) continue;
      const accountId = String(a.account_id);
      out.push({
        accountId,
        metaAccountId: a.id ? String(a.id) : `act_${accountId}`,
        name: String(a.name ?? ""),
        currency: a.currency ?? null,
        timezoneName: a.timezone_name ?? null,
        businessId: a.business?.id ? String(a.business.id) : null,
        businessName: a.business?.name ? String(a.business.name) : null,
        accountStatus: typeof a.account_status === "number" ? a.account_status : null,
      });
    }
    nextUrl = page.paging?.next ?? null;
  } while (nextUrl);
  return out;
}

export async function fetchInsights(opts: FetchInsightsOptions): Promise<unknown[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 100;
  const fields = opts.fields.filter((f) => f.trim().length > 0);
  if (fields.length === 0) {
    throw new MetaApiError("fetchInsights: fields is required");
  }
  const params: Record<string, string> = {
    fields: fields.join(","),
    limit: String(limit),
  };
  if (opts.level) params.level = opts.level;
  if (opts.timeRange) params.time_range = JSON.stringify(opts.timeRange);
  if (opts.datePreset) params.date_preset = opts.datePreset;
  if (opts.timeIncrement) params.time_increment = opts.timeIncrement;
  if (opts.breakdowns?.length) params.breakdowns = opts.breakdowns.join(",");
  if (opts.actionAttributionWindows?.length) {
    params.action_attribution_windows = opts.actionAttributionWindows.join(",");
  }
  type Page = { data?: unknown[] };
  const accountPath = opts.adAccountId.startsWith("act_")
    ? opts.adAccountId
    : `act_${opts.adAccountId}`;
  const page = await fetchGraph<Page>(
    fetchImpl,
    `${accountPath}/insights`,
    params,
    opts.accessToken,
    "fetchInsights"
  );
  return Array.isArray(page.data) ? page.data : [];
}
