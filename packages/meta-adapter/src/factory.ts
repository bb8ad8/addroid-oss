// AdDroid OSS — Meta adapter factory.
//
// 実行環境に応じて MetaAdapter 実装を選択する。優先度:
//   1. ADDROID_META_OAUTH_MOCK=1   → MockMetaAdapter
//   2. OAuth client config が揃う + crypto → RealMetaAdapter
//   3. crypto のみ揃う                    → StoredTokenMetaAdapter
//   4. それ以外                           → StubMetaAdapter
//
// Meta App ID / Secret はこの関数の引数 / 環境変数からのみ流入し、
// コード内に literal を残さない。

import { MockMetaAdapter, type MockMetaAdapterOptions } from "./mock.js";
import { RealMetaAdapter, type CryptoEncryptDecrypt } from "./real.js";
import { StoredTokenMetaAdapter } from "./token-adapter.js";
import { StubMetaAdapter } from "./stub.js";
import type { MetaOAuthClientConfig } from "./oauth.js";
import type { MetaOAuthTokenStore } from "./token-store.js";
import type { MetaAdapter } from "./types.js";

export interface SelectMetaAdapterOptions {
  env?: NodeJS.ProcessEnv;
  tokenStore: MetaOAuthTokenStore;
  crypto?: CryptoEncryptDecrypt;
  oauthClient?: MetaOAuthClientConfig | null;
  mock?: Omit<MockMetaAdapterOptions, "tokenStore">;
  fetchImpl?: typeof fetch;
  /**
   * ad account key → oauth_tokens.accountIdentifier。ビジネスポートフォリオごとに
   * トークンが分かれる場合に、広告アカウント単位で使い分けるためのフック。
   */
  resolveTokenRef?: (accountKey: string) => Promise<string | null | undefined>;
  /** 常にこのトークンを使う (列挙系をトークン別に回すとき)。 */
  forceTokenRef?: string | null;
}

export type MetaAdapterChoice = "mock" | "real" | "token" | "stub";

export interface MetaAdapterSelection {
  adapter: MetaAdapter;
  choice: MetaAdapterChoice;
  reason: string;
}

export function selectMetaAdapter(opts: SelectMetaAdapterOptions): MetaAdapterSelection {
  const env = opts.env ?? process.env;
  if (env.ADDROID_META_OAUTH_MOCK === "1") {
    return {
      adapter: new MockMetaAdapter({ tokenStore: opts.tokenStore, ...(opts.mock ?? {}) }),
      choice: "mock",
      reason: "ADDROID_META_OAUTH_MOCK=1",
    };
  }
  if (opts.oauthClient && opts.crypto) {
    return {
      adapter: new RealMetaAdapter({
        oauthClient: opts.oauthClient,
        tokenStore: opts.tokenStore,
        crypto: opts.crypto,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
      choice: "real",
      reason: "Meta OAuth client + crypto boundary configured",
    };
  }
  if (opts.crypto) {
    return {
      adapter: new StoredTokenMetaAdapter({
        tokenStore: opts.tokenStore,
        crypto: opts.crypto,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.resolveTokenRef ? { resolveTokenRef: opts.resolveTokenRef } : {}),
        ...(opts.forceTokenRef ? { forceTokenRef: opts.forceTokenRef } : {}),
      }),
      choice: "token",
      reason: "Manual Meta access token + crypto boundary configured",
    };
  }
  return {
    adapter: new StubMetaAdapter(),
    choice: "stub",
    reason: missingReason(opts),
  };
}

function missingReason(opts: SelectMetaAdapterOptions): string {
  const missing: string[] = [];
  if (!opts.crypto) missing.push("crypto");
  return `Meta access token support not configured (missing: ${missing.join(", ") || "n/a"})`;
}
