// AdDroid OSS — Meta adapter shared types.
//
// `MetaAdapter` interface とそのフローで使う型を集約する。
// 実装 (Stub / Mock / Real) はそれぞれ別ファイルに分離する。

export type MetaTokenProvider = "meta";

/**
 * Meta が返す Business (旧 Business Manager) のサブセット。
 * UI で表示するのに十分な属性のみ保持し、その他はドロップする。
 */
export interface MetaBusiness {
  id: string;
  name: string;
  /** "ADMIN" | "EMPLOYEE" — 取得できた範囲。情報取得不能の場合は null。 */
  role?: string | null;
}

/**
 * Meta が返す Ad Account のサブセット (act_<id> 形式)。
 */
export interface MetaAdAccount {
  /** 数値 ID (例: "1234567890") */
  accountId: string;
  /** "act_<accountId>" 形式の正準形 */
  metaAccountId: string;
  name: string;
  currency?: string | null;
  timezoneName?: string | null;
  /** Meta の business の id (与えられる場合のみ) */
  businessId?: string | null;
  /** Meta の business の表示名 (与えられる場合のみ) */
  businessName?: string | null;
  /**
   * Meta API が返す数値 status:
   *   1 (ACTIVE), 2 (DISABLED), 3 (UNSETTLED), 7 (PENDING_RISK_REVIEW), 9 (IN_GRACE_PERIOD), ...
   */
  accountStatus?: number | null;
}

/**
 * Begin 時に呼び出し側 (Web) に返す情報。
 */
export interface MetaBeginOAuthResult {
  authorizationUrl: string;
  state: string;
}

/**
 * `completeOAuth` の表示用結果。token そのものは含めない。
 */
export interface MetaOAuthConnection {
  provider: MetaTokenProvider;
  /** 表示用の安定識別子。"<meta_user_id>" / "<meta_user_name>" 等。機微ではない。 */
  accountIdentifier: string;
  scopes: string[];
  /** ISO 8601 string. */
  connectedAt: string;
  /** ISO 8601 string. long-lived token の expiresAt。null = expires が分からない場合。 */
  expiresAt: string | null;
  businesses: MetaBusiness[];
  adAccounts: MetaAdAccount[];
}

/**
 * `refreshLongLivedToken` の結果。再認証成功時に呼び出し側へ返す。
 */
export interface MetaRefreshResult {
  provider: MetaTokenProvider;
  accountIdentifier: string;
  scopes: string[];
  refreshedAt: string;
  expiresAt: string | null;
}

/**
 * `loadAccessTokenPlaintext` で復号した結果。CLI runner 等が短命に利用する。
 */
export interface MetaAccessTokenLease {
  accessToken: string;
  scopes: string[];
  expiresAt: Date | null;
  accountIdentifier: string;
}

export interface MetaAdapter {
  /**
   * Meta Login for Business の authorization URL を返す。`state` は CSRF 防止用の
   * ランダム値で、callback で同値検証する。
   */
  beginOAuth(): Promise<MetaBeginOAuthResult>;

  /**
   * OAuth コールバック完了。code を short-lived → long-lived に交換し、
   * 暗号化境界越しに保存する。同時に /me/businesses と /me/adaccounts を取得する。
   */
  completeOAuth(params: { code: string; state: string }): Promise<MetaOAuthConnection>;

  /**
   * 既存の long-lived token を再交換 (token expiry 更新)。Meta は long-lived token を
   * 受け取って新しい long-lived token を返す `fb_exchange_token` を提供している。
   */
  refreshLongLivedToken(): Promise<MetaRefreshResult>;

  /**
   * 取得済み access token を保存先から復号して返す。CLI runner や API route が
   * 環境変数注入のためにのみ使う。
   *
   * @param accountKey ad account key。渡すとその広告アカウント用に登録された
   *   トークンを使う (ビジネスポートフォリオごとにトークンが分かれるケース)。
   *   省略時・解決できない場合は既定 (最後に接続したトークン)。
   */
  loadAccessTokenPlaintext(
    accountKey?: string | null
  ): Promise<MetaAccessTokenLease | null>;

  /**
   * Businesses / Ad Accounts の最新リストを取得する。トークンが無い場合は
   * MetaAdapterUnauthenticatedError を投げる。
   */
  fetchBusinesses(): Promise<MetaBusiness[]>;
  fetchAdAccounts(): Promise<MetaAdAccount[]>;
}

export class MetaAdapterNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `MetaAdapter.${method} is not configured for the active Meta auth mode. Use addroid auth meta for token mode, configure OAuth credentials for OAuth mode, or set ADDROID_META_OAUTH_MOCK=1 to use the mock adapter.`
    );
    this.name = "MetaAdapterNotImplementedError";
  }
}

export class MetaOAuthStateMismatchError extends Error {
  constructor() {
    super("OAuth state did not match the value issued by beginOAuth (possible CSRF).");
    this.name = "MetaOAuthStateMismatchError";
  }
}

export class MetaAdapterUnauthenticatedError extends Error {
  constructor(operation: string) {
    super(
      `MetaAdapter cannot ${operation}: no Meta access token found. Run addroid auth meta first.`
    );
    this.name = "MetaAdapterUnauthenticatedError";
  }
}

export class MetaTokenExpiredError extends Error {
  readonly expiresAt: Date | null;
  constructor(expiresAt: Date | null) {
    super(
      "Meta access token has expired. Re-authenticate from /accounts to obtain a new long-lived token."
    );
    this.name = "MetaTokenExpiredError";
    this.expiresAt = expiresAt;
  }
}
