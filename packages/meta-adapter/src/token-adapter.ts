// AdDroid OSS — Stored-token Meta adapter.
//
// Manual Access Token 登録で保存された `oauth_tokens(provider="meta")` を使う
// adapter。OAuth client (App ID / Secret / redirect URI) が無くても、保存済み
// token で /me/adaccounts 等を取得し、Meta Ads CLI へ短命に token を渡せる。

import {
  fetchAdAccounts as fetchAdAccountsApi,
  fetchBusinesses as fetchBusinessesApi,
} from "./api.js";
import {
  MetaAdapterNotImplementedError,
  MetaAdapterUnauthenticatedError,
  MetaTokenExpiredError,
  type MetaAccessTokenLease,
  type MetaAdAccount,
  type MetaAdapter,
  type MetaBeginOAuthResult,
  type MetaBusiness,
  type MetaOAuthConnection,
  type MetaRefreshResult,
} from "./types.js";
import type { MetaOAuthTokenRecord, MetaOAuthTokenStore } from "./token-store.js";
import type { CryptoEncryptDecrypt } from "./real.js";

export interface StoredTokenMetaAdapterDeps {
  tokenStore: MetaOAuthTokenStore;
  crypto: CryptoEncryptDecrypt;
  fetchImpl?: typeof fetch;
  /**
   * ad account key → 使用する oauth_tokens.accountIdentifier を解決する。
   * ビジネスポートフォリオが違うとトークンも別になるため、アカウント単位で
   * 使い分ける。未指定 / null を返した場合は既定 (最新トークン) を使う。
   */
  resolveTokenRef?: (accountKey: string) => Promise<string | null | undefined>;
  /**
   * このアダプタが常に使うトークン (oauth_tokens.accountIdentifier)。
   * accountKey を持たない列挙系 (fetchAdAccounts / fetchBusinesses) を
   * トークンごとに実行したいときに使う。resolveTokenRef より優先される。
   */
  forceTokenRef?: string | null;
}

export class StoredTokenMetaAdapter implements MetaAdapter {
  private readonly tokenStore: MetaOAuthTokenStore;
  private readonly crypto: CryptoEncryptDecrypt;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveTokenRef:
    | ((accountKey: string) => Promise<string | null | undefined>)
    | undefined;
  private readonly forceTokenRef: string | null;

  constructor(deps: StoredTokenMetaAdapterDeps) {
    this.tokenStore = deps.tokenStore;
    this.crypto = deps.crypto;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.resolveTokenRef = deps.resolveTokenRef;
    this.forceTokenRef = deps.forceTokenRef ?? null;
  }

  /** accountKey が渡されたときだけ、そのアカウント用の tokenRef を引く。 */
  private async tokenRefFor(accountKey?: string | null): Promise<string | null> {
    if (this.forceTokenRef) return this.forceTokenRef;
    if (!accountKey || !this.resolveTokenRef) return null;
    return (await this.resolveTokenRef(accountKey)) ?? null;
  }

  async beginOAuth(): Promise<MetaBeginOAuthResult> {
    throw new MetaAdapterNotImplementedError("beginOAuth");
  }

  async completeOAuth(): Promise<MetaOAuthConnection> {
    throw new MetaAdapterNotImplementedError("completeOAuth");
  }

  async refreshLongLivedToken(): Promise<MetaRefreshResult> {
    throw new MetaAdapterNotImplementedError("refreshLongLivedToken");
  }

  async loadAccessTokenPlaintext(
    accountKey?: string | null
  ): Promise<MetaAccessTokenLease | null> {
    const rec = await this.tokenStore.loadOAuthToken(
      "meta",
      await this.tokenRefFor(accountKey)
    );
    if (!rec) return null;
    if (rec.expiresAt && rec.expiresAt.getTime() < Date.now()) {
      throw new MetaTokenExpiredError(rec.expiresAt);
    }
    return {
      accessToken: this.crypto.decrypt(rec.accessTokenCiphertext),
      scopes: rec.scopes,
      expiresAt: rec.expiresAt ?? null,
      accountIdentifier: rec.accountIdentifier,
    };
  }

  async fetchBusinesses(): Promise<MetaBusiness[]> {
    const lease = await this.requireLease("fetch businesses");
    return fetchBusinessesApi({
      accessToken: lease.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }

  async fetchAdAccounts(): Promise<MetaAdAccount[]> {
    const lease = await this.requireLease("fetch ad accounts");
    return fetchAdAccountsApi({
      accessToken: lease.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }

  private async requireLease(op: string): Promise<MetaAccessTokenLease> {
    const rec = await this.tokenStore.loadOAuthToken(
      "meta",
      await this.tokenRefFor(null)
    );
    if (!rec) throw new MetaAdapterUnauthenticatedError(op);
    if (rec.expiresAt && rec.expiresAt.getTime() < Date.now()) {
      throw new MetaTokenExpiredError(rec.expiresAt);
    }
    return {
      accessToken: this.crypto.decrypt(rec.accessTokenCiphertext),
      scopes: rec.scopes,
      expiresAt: rec.expiresAt ?? null,
      accountIdentifier: rec.accountIdentifier,
    };
  }
}

// 型を export 経路に通すための無参照参照。
export type _StoredTokenRecordRef = MetaOAuthTokenRecord;
