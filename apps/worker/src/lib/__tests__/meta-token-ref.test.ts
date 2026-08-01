import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryMetaTokenStore, StoredTokenMetaAdapter } from "@addroid/meta-adapter";

/** 復号せずそのまま返す test 用 crypto boundary。 */
const passthroughCrypto = {
  encrypt: (plaintext: string) => plaintext,
  decrypt: (ciphertext: string) => ciphertext,
};

async function storeWithTwoPortfolios(): Promise<InMemoryMetaTokenStore> {
  const store = new InMemoryMetaTokenStore();
  // 先に接続した方 (= 既定にならない方)
  await store.saveOAuthToken({
    provider: "meta",
    accountIdentifier: "sysuser-connectera",
    scopes: [],
    accessTokenCiphertext: "TOKEN_CONNECTERA",
    connectedAt: new Date("2026-08-01T00:00:00Z"),
  });
  // 後から接続した方 (= 既定)
  await store.saveOAuthToken({
    provider: "meta",
    accountIdentifier: "sysuser-pilates",
    scopes: [],
    accessTokenCiphertext: "TOKEN_PILATES",
    connectedAt: new Date("2026-08-01T01:00:00Z"),
  });
  return store;
}

test("metaTokenRef が解決できたら、そのアカウント用のトークンを使う", async () => {
  const adapter = new StoredTokenMetaAdapter({
    tokenStore: await storeWithTwoPortfolios(),
    crypto: passthroughCrypto,
    resolveTokenRef: async (accountKey) =>
      accountKey === "act_shokunin" ? "sysuser-pilates" : "sysuser-connectera",
  });
  const shokunin = await adapter.loadAccessTokenPlaintext("act_shokunin");
  assert.equal(shokunin?.accessToken, "TOKEN_PILATES");
  const makisensei = await adapter.loadAccessTokenPlaintext("act_makisensei");
  assert.equal(makisensei?.accessToken, "TOKEN_CONNECTERA");
});

test("accountKey 未指定なら従来どおり最後に接続したトークンを使う", async () => {
  const adapter = new StoredTokenMetaAdapter({
    tokenStore: await storeWithTwoPortfolios(),
    crypto: passthroughCrypto,
    resolveTokenRef: async () => "sysuser-connectera",
  });
  const lease = await adapter.loadAccessTokenPlaintext();
  assert.equal(lease?.accessToken, "TOKEN_PILATES");
});

test("参照先トークンが存在しない場合は既定へフォールバックする (fail-open)", async () => {
  const adapter = new StoredTokenMetaAdapter({
    tokenStore: await storeWithTwoPortfolios(),
    crypto: passthroughCrypto,
    // 削除済みのトークンを指しているケース
    resolveTokenRef: async () => "sysuser-deleted",
  });
  const lease = await adapter.loadAccessTokenPlaintext("act_any");
  assert.equal(lease?.accessToken, "TOKEN_PILATES");
});

test("resolveTokenRef 未設定なら常に既定トークン (既存挙動を壊さない)", async () => {
  const adapter = new StoredTokenMetaAdapter({
    tokenStore: await storeWithTwoPortfolios(),
    crypto: passthroughCrypto,
  });
  const lease = await adapter.loadAccessTokenPlaintext("act_any");
  assert.equal(lease?.accessToken, "TOKEN_PILATES");
});

test("forceTokenRef は resolveTokenRef より優先される (列挙をトークン別に回す用途)", async () => {
  const adapter = new StoredTokenMetaAdapter({
    tokenStore: await storeWithTwoPortfolios(),
    crypto: passthroughCrypto,
    resolveTokenRef: async () => "sysuser-pilates",
    forceTokenRef: "sysuser-connectera",
  });
  const lease = await adapter.loadAccessTokenPlaintext("act_any");
  assert.equal(lease?.accessToken, "TOKEN_CONNECTERA");
});
