// AdDroid OSS — Discord auth (Gateway bot) helpers (optional integration).
//
// 本モジュールは `addroid connect discord` (= `addroid auth discord`) CLI と Web 側
// Setup ルートから共通利用される薄いヘルパ群です。Discord REST API への HTTP 呼び出しと、
// AdDroid 内部の `oauth_tokens` 行に保存するための「非機微メタ」の正規化のみを担い、
// 平文トークンを扱う期間は呼び出し側の関数スコープ内に閉じ込めます。
//
// Slack 版 (`slack-auth.ts`) と対称な設計:
//   - Discord 連携は完全に任意。本モジュールが load された時点では Discord 通信は走らない
//     (各関数を呼んだ時のみ outbound に出る)。
//   - **outbound-only**。inbound webhook / public request URL は一切扱わない。実際の Gateway
//     WebSocket は worker 側 (discord.js) が常時アウトバウンド接続として張る。
//   - 平文 bot トークンはこのモジュールから返るデータ構造には含まれない。呼び出し側で
//     `getCryptoBoundary().encrypt()` を通してから永続化する責務を負う。
//   - すべての Discord REST 呼び出しは `fetch` (Node 22+ 内蔵) を使い、引数注入でモック可能。
//   - サブプロセス起動・shell 経由の文字列展開は行わない (command injection 不要)。

/** Discord REST API のベース URL。テストで上書き可能。 */
export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

/** REST 呼び出しに付ける User-Agent (Discord は UA を要求する)。 */
export const DISCORD_USER_AGENT =
  "AdDroid (https://github.com/addroid/addroid-oss, 0.1.0)";

// Discord bot トークンは `base64(userId).base64(timestamp).hmac` の 3 セグメント構造。
// セグメント区切りの `.` を 2 つ含み、base64url 文字種で構成される。厳密長は変動するため
// 緩めの形式チェックに留め、真正性確認は verifyDiscordBotToken (REST) が担う。
const DISCORD_BOT_TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
// guild / channel ID は Discord snowflake (17〜20 桁の数値文字列)。
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Discord REST API へ流す `fetch` 互換シグネチャ。Node 22+ 標準 `fetch` がそのまま使える。
 * テストではこれをモック注入する。
 */
export type DiscordFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}>;

export interface DiscordAuthInputs {
  /** bot トークン。`GET /applications/@me` / `POST /channels/{id}/messages` で使用。 */
  botToken: string;
  /** 対象サーバー (guild) の ID (snowflake)。 */
  guildId: string;
  /** 通知・受信対象チャンネルの ID (snowflake)。 */
  channelId: string;
}

export class DiscordTokenValidationError extends Error {
  readonly code:
    | "missing_bot_token"
    | "missing_guild_id"
    | "missing_channel_id"
    | "invalid_bot_token"
    | "invalid_guild_id"
    | "invalid_channel_id";
  constructor(code: DiscordTokenValidationError["code"], message: string) {
    super(message);
    this.name = "DiscordTokenValidationError";
    this.code = code;
  }
}

/**
 * 形式バリデーション。値の存在 + 文字種のみを検査する (Discord 側の真正性チェックは
 * {@link verifyDiscordBotToken} / {@link getDiscordChannel} が担う)。受け付けた値は
 * `trim()` 済みの正規化値を返す。
 */
export function validateDiscordInputs(
  raw: Partial<DiscordAuthInputs>
): DiscordAuthInputs {
  const botToken = (raw.botToken ?? "").trim();
  const guildId = (raw.guildId ?? "").trim();
  const channelId = (raw.channelId ?? "").trim();
  if (!botToken)
    throw new DiscordTokenValidationError(
      "missing_bot_token",
      "Discord bot トークンが指定されていません"
    );
  if (!guildId)
    throw new DiscordTokenValidationError(
      "missing_guild_id",
      "対象サーバー (guild) ID が指定されていません"
    );
  if (!channelId)
    throw new DiscordTokenValidationError(
      "missing_channel_id",
      "対象チャンネル ID が指定されていません"
    );
  if (!DISCORD_BOT_TOKEN_RE.test(botToken))
    throw new DiscordTokenValidationError(
      "invalid_bot_token",
      "Discord bot トークンの形式が不正です (Developer Portal > Bot > Reset Token で取得した値を渡してください)"
    );
  if (!DISCORD_SNOWFLAKE_RE.test(guildId))
    throw new DiscordTokenValidationError(
      "invalid_guild_id",
      "guild ID は 17〜20 桁の数値 (snowflake) です"
    );
  if (!DISCORD_SNOWFLAKE_RE.test(channelId))
    throw new DiscordTokenValidationError(
      "invalid_channel_id",
      "channel ID は 17〜20 桁の数値 (snowflake) です"
    );
  return { botToken, guildId, channelId };
}

export class DiscordApiError extends Error {
  readonly endpoint: string;
  readonly status: number;
  /** Discord が返した JSON エラーコード (例: 50001 = Missing Access)。 */
  readonly discordCode: number | null;
  constructor(
    endpoint: string,
    status: number,
    discordCode: number | null,
    message: string
  ) {
    super(message);
    this.name = "DiscordApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.discordCode = discordCode;
  }
}

function authHeaders(botToken: string): Record<string, string> {
  return {
    Authorization: `Bot ${botToken}`,
    "User-Agent": DISCORD_USER_AGENT,
  };
}

async function parseDiscordError(
  endpoint: string,
  status: number,
  res: Awaited<ReturnType<DiscordFetch>>
): Promise<DiscordApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* ignore — body may be empty / non-JSON */
  }
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const code = typeof obj["code"] === "number" ? (obj["code"] as number) : null;
    const message =
      typeof obj["message"] === "string" ? (obj["message"] as string) : null;
    return new DiscordApiError(
      endpoint,
      status,
      code,
      message
        ? `Discord ${endpoint} が失敗しました (HTTP ${status}${code != null ? `, code=${code}` : ""}): ${message}`
        : `Discord ${endpoint} が HTTP ${status} を返しました`
    );
  }
  return new DiscordApiError(
    endpoint,
    status,
    null,
    `Discord ${endpoint} が HTTP ${status} を返しました`
  );
}

/**
 * Discord REST の GET/POST を呼び、成功時にリソース JSON を返す。Discord は Slack と異なり
 * `{ ok: true }` ラッパを持たず、HTTP ステータスで成否を表す。失敗時は {@link DiscordApiError}。
 */
async function callDiscordApi<T>(
  endpoint: string,
  method: "GET" | "POST",
  botToken: string,
  fetchImpl: DiscordFetch,
  body?: Record<string, unknown>
): Promise<T> {
  if (typeof fetchImpl !== "function") {
    throw new DiscordApiError(
      endpoint,
      0,
      null,
      "fetch が利用できません (Node 22+ で実行してください)"
    );
  }
  const url = `${DISCORD_API_BASE_URL}${endpoint}`;
  const headers = authHeaders(botToken);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw await parseDiscordError(endpoint, res.status, res);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new DiscordApiError(
      endpoint,
      res.status,
      null,
      `Discord ${endpoint} の応答 JSON をパースできませんでした: ${(err as Error).message}`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new DiscordApiError(
      endpoint,
      res.status,
      null,
      `Discord ${endpoint} の応答が不正です (object でない)`
    );
  }
  return parsed as T;
}

export interface DiscordApplicationResponse {
  /** application ID (= slash command 登録に使う application_id)。 */
  applicationId: string;
  name: string;
  botUserId: string;
  botUsername: string;
  /** application flags (GATEWAY_MESSAGE_CONTENT 等の特権インテント状態を含む)。 */
  flags: number;
}

interface RawDiscordApplication {
  id?: unknown;
  name?: unknown;
  flags?: unknown;
  bot?: { id?: unknown; username?: unknown } | null;
}

/**
 * `GET /applications/@me` を呼び、bot トークンの真正性と application ID / bot user を確認する。
 * application ID は guild slash command 登録に必須。
 */
export async function verifyDiscordBotToken(
  botToken: string,
  fetchImpl: DiscordFetch = (globalThis as { fetch?: DiscordFetch }).fetch as DiscordFetch
): Promise<DiscordApplicationResponse> {
  const app = await callDiscordApi<RawDiscordApplication>(
    "/applications/@me",
    "GET",
    botToken,
    fetchImpl
  );
  const applicationId = typeof app.id === "string" ? app.id : "";
  if (!applicationId) {
    throw new DiscordApiError(
      "/applications/@me",
      200,
      null,
      "Discord application 応答に id がありません"
    );
  }
  return {
    applicationId,
    name: typeof app.name === "string" ? app.name : "",
    botUserId: typeof app.bot?.id === "string" ? app.bot.id : "",
    botUsername: typeof app.bot?.username === "string" ? app.bot.username : "",
    flags: typeof app.flags === "number" ? app.flags : 0,
  };
}

export interface DiscordChannelResponse {
  id: string;
  /** テキストチャンネル等の type (0 = GUILD_TEXT)。 */
  type: number;
  name: string | null;
  guildId: string | null;
}

interface RawDiscordChannel {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  guild_id?: unknown;
}

/**
 * `GET /channels/{id}` を呼び、対象チャンネルへ bot がアクセスできることを確認する。
 * 取得した `guild_id` で接続フォームの guild 指定と突き合わせできる。
 */
export async function getDiscordChannel(
  botToken: string,
  channelId: string,
  fetchImpl: DiscordFetch = (globalThis as { fetch?: DiscordFetch }).fetch as DiscordFetch
): Promise<DiscordChannelResponse> {
  const channel = await callDiscordApi<RawDiscordChannel>(
    `/channels/${encodeURIComponent(channelId)}`,
    "GET",
    botToken,
    fetchImpl
  );
  return {
    id: typeof channel.id === "string" ? channel.id : channelId,
    type: typeof channel.type === "number" ? channel.type : -1,
    name: typeof channel.name === "string" ? channel.name : null,
    guildId: typeof channel.guild_id === "string" ? channel.guild_id : null,
  };
}

export interface DiscordPostMessageResponse {
  id: string;
  channelId: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

export interface DiscordPostMessageOptions {
  embeds?: DiscordEmbed[];
  fetchImpl?: DiscordFetch;
}

/**
 * `POST /channels/{id}/messages` でメッセージ (任意で embeds) を送信する。
 * 失敗 (Missing Access 等) は {@link DiscordApiError} で throw される。
 */
export async function postDiscordMessage(
  botToken: string,
  channelId: string,
  content: string,
  optionsOrFetch: DiscordFetch | DiscordPostMessageOptions = {}
): Promise<DiscordPostMessageResponse> {
  const options =
    typeof optionsOrFetch === "function"
      ? { fetchImpl: optionsOrFetch }
      : optionsOrFetch;
  const fetchImpl =
    options.fetchImpl ?? ((globalThis as { fetch?: DiscordFetch }).fetch as DiscordFetch);
  const body: Record<string, unknown> = {};
  // Discord は content か embeds の少なくとも一方が必須。
  if (content) body["content"] = content;
  if (options.embeds && options.embeds.length > 0) body["embeds"] = options.embeds;
  const res = await callDiscordApi<{ id?: unknown; channel_id?: unknown }>(
    `/channels/${encodeURIComponent(channelId)}/messages`,
    "POST",
    botToken,
    fetchImpl,
    body
  );
  return {
    id: typeof res.id === "string" ? res.id : "",
    channelId: typeof res.channel_id === "string" ? res.channel_id : channelId,
  };
}

export interface DiscordMessageSummary {
  id: string;
  authorId: string;
  authorUsername: string;
  isBot: boolean;
  content: string;
}

interface RawDiscordMessage {
  id?: unknown;
  content?: unknown;
  author?: { id?: unknown; username?: unknown; bot?: unknown } | null;
}

/**
 * チャンネル/DM の直近メッセージを新しい順→古い順 (chronological) に取得する。
 * 対話エージェントの「会話メモリ」(直前のやり取りを文脈として渡す) に使う。
 * Read Message History 権限が必要。DM では bot 自身の DM 履歴を読める。
 */
export async function getRecentDiscordMessages(
  botToken: string,
  channelId: string,
  limit = 10,
  fetchImpl: DiscordFetch = (globalThis as { fetch?: DiscordFetch }).fetch as DiscordFetch
): Promise<DiscordMessageSummary[]> {
  const capped = Math.max(1, Math.min(limit, 50));
  const raw = await callDiscordApi<RawDiscordMessage[]>(
    `/channels/${encodeURIComponent(channelId)}/messages?limit=${capped}`,
    "GET",
    botToken,
    fetchImpl
  );
  const list = Array.isArray(raw) ? raw : [];
  // Discord は新しい順で返すので、文脈用に古い順へ反転する。
  return list
    .map((m): DiscordMessageSummary => ({
      id: typeof m.id === "string" ? m.id : "",
      authorId: typeof m.author?.id === "string" ? m.author.id : "",
      authorUsername: typeof m.author?.username === "string" ? m.author.username : "",
      isBot: m.author?.bot === true,
      content: typeof m.content === "string" ? m.content : "",
    }))
    .reverse();
}

/**
 * Discord 添付ファイル (signed CDN URL) を取得する。CDN URL 自体が署名付きなので
 * Authorization ヘッダは付けない。Slack の {@link downloadSlackPrivateFile} と対称。
 */
export async function downloadDiscordAttachment(
  url: string,
  fetchImpl: DiscordFetch = (globalThis as { fetch?: DiscordFetch }).fetch as DiscordFetch
): Promise<{
  bytes: Uint8Array;
  contentType: string | null;
  contentLength: number | null;
}> {
  if (typeof fetchImpl !== "function") {
    throw new DiscordApiError(
      "attachment.download",
      0,
      null,
      "fetch が利用できません (Node 22+ で実行してください)"
    );
  }
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { "User-Agent": DISCORD_USER_AGENT },
  });
  if (!res.ok) {
    throw new DiscordApiError(
      "attachment.download",
      res.status,
      null,
      `Discord 添付ダウンロードが HTTP ${res.status} を返しました`
    );
  }
  if (typeof res.arrayBuffer !== "function") {
    throw new DiscordApiError(
      "attachment.download",
      res.status,
      null,
      "Discord 添付ダウンロードの応答が binary body を返しませんでした"
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const rawLength = res.headers?.get("content-length") ?? null;
  const contentLength = rawLength ? Number(rawLength) : null;
  return {
    bytes,
    contentType: res.headers?.get("content-type") ?? null,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
  };
}

/**
 * `oauth_tokens.metadata` (JSON 列) に保存する Discord 固有の非機微メタ。
 * 平文 bot トークンはここに **入れない** — それは ciphertext 列の役割。
 */
export interface DiscordInstallationMetadata {
  applicationId: string;
  botUserId: string;
  botUsername: string;
  guildId: string;
  channelId: string;
  channelName?: string;
  /** 直近の接続確認時刻 (ISO timestamp)。 */
  lastVerifiedAt: string;
  /** 直近テストメッセージ送信成功時刻 (ISO timestamp)。失敗時は更新しない。 */
  lastTestMessageAt?: string;
}

export function buildDiscordInstallationMetadata(input: {
  application: DiscordApplicationResponse;
  guildId: string;
  channelId: string;
  channelName?: string | null;
  verifiedAt: Date;
  testMessageOkAt: Date | null;
}): DiscordInstallationMetadata {
  const out: DiscordInstallationMetadata = {
    applicationId: input.application.applicationId,
    botUserId: input.application.botUserId,
    botUsername: input.application.botUsername,
    guildId: input.guildId,
    channelId: input.channelId,
    lastVerifiedAt: input.verifiedAt.toISOString(),
  };
  if (input.channelName) out.channelName = input.channelName;
  if (input.testMessageOkAt)
    out.lastTestMessageAt = input.testMessageOkAt.toISOString();
  return out;
}
