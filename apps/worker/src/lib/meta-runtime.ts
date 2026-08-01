// AdDroid OSS — apps/worker shared helpers for Meta adapter wiring.
//
// CLI (`addroid activate` ほか) と worker runtime の双方が同じ Prisma-backed
// `MetaOAuthTokenStore` と `selectMetaAdapter` 経路を使うために切り出した共通モジュール。
// web 側の `apps/web/lib/meta-runtime.ts` とロジックは等価だが、apps/web は
// `package.json` に `"type": "module"` を持たないため、ESM 専用の CLI / worker から
// 安全に import できる本ファイルにロジックを集約する (apply / activate 用 store 群を
// `apps/worker/src/lib/activate-runtime.ts` に集約しているのと同じ理由)。
//
// regression fix: CLI Activate は本ヘルパー経由で Prisma 永続 token を読む。
//   - token が存在しない / 期限切れ → `CliActivateExecutor` が auth_error +
//     `oauth.meta.reauth_required` notify を返し、再認証を audit に記録する。
//   - production で `InMemoryMetaTokenStore` を使う経路は廃止する (空 store だと
//     どんな永続 token があっても CLI からは見えず、毎回 auth_error になる)。

import {
  ADDROID_META_REQUIRED_SCOPES,
  selectMetaAdapter,
  type MetaAdapterSelection,
  type MetaOAuthClientConfig,
  type MetaOAuthTokenRecord,
  type MetaOAuthTokenStore,
} from "@addroid/meta-adapter";
import {
  getCryptoBoundary,
  readLocalSecrets,
  resolveWebBinding,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";

const META_PROVIDER = "meta" as const;

/**
 * Prisma の `oauth_tokens` テーブルを裏に持つ `MetaOAuthTokenStore`。
 * web 側の `/api/oauth/meta/{begin,callback,refresh}` で保存された ciphertext を
 * そのまま CLI / worker から読み出すための単一経路。
 */
export function createPrismaMetaTokenStore(prisma: PrismaClient): MetaOAuthTokenStore {
  return {
    async saveOAuthToken(record: MetaOAuthTokenRecord): Promise<void> {
      await prisma.oAuthToken.upsert({
        where: {
          provider_accountIdentifier: {
            provider: record.provider,
            accountIdentifier: record.accountIdentifier,
          },
        },
        update: {
          scopes: record.scopes,
          accessTokenCiphertext: record.accessTokenCiphertext,
          refreshTokenCiphertext: record.refreshTokenCiphertext ?? null,
          expiresAt: record.expiresAt ?? null,
          connectedAt: record.connectedAt,
        },
        create: {
          provider: record.provider,
          accountIdentifier: record.accountIdentifier,
          scopes: record.scopes,
          accessTokenCiphertext: record.accessTokenCiphertext,
          refreshTokenCiphertext: record.refreshTokenCiphertext ?? null,
          expiresAt: record.expiresAt ?? null,
          connectedAt: record.connectedAt,
        },
      });
    },
    async loadOAuthToken(provider, accountIdentifier) {
      if (provider !== META_PROVIDER) return null;
      // accountIdentifier 指定時はその行を優先。該当しなければ (トークンが削除された等)
      // 既定の最新 1 件へフォールバックし、取得自体は止めない。
      const row =
        (accountIdentifier
          ? await prisma.oAuthToken.findFirst({
              where: { provider, accountIdentifier },
            })
          : null) ??
        (await prisma.oAuthToken.findFirst({
          where: { provider },
          orderBy: { connectedAt: "desc" },
        }));
      if (!row) return null;
      const out: MetaOAuthTokenRecord = {
        provider: row.provider as typeof META_PROVIDER,
        accountIdentifier: row.accountIdentifier,
        scopes: row.scopes,
        accessTokenCiphertext: row.accessTokenCiphertext,
        connectedAt: row.connectedAt,
      };
      if (row.refreshTokenCiphertext !== null) {
        out.refreshTokenCiphertext = row.refreshTokenCiphertext;
      }
      if (row.expiresAt !== null) out.expiresAt = row.expiresAt;
      return out;
    },
  };
}

/**
 * `~/.addroid/secrets.local.yaml` 等から上級者向け Meta OAuth client 設定を組み立てる。
 * App ID / Secret が揃わなければ null を返す。標準の token 入力方式では null でよい。
 */
export async function loadMetaOAuthClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<MetaOAuthClientConfig | null> {
  let secrets: Awaited<ReturnType<typeof readLocalSecrets>> = null;
  try {
    secrets = await readLocalSecrets(env);
  } catch {
    return null;
  }
  const appIdCiphertext = secrets?.meta?.oauth?.appIdCiphertext;
  const appSecretCiphertext = secrets?.meta?.oauth?.appSecretCiphertext;
  if (!appIdCiphertext || !appSecretCiphertext) return null;
  let appId: string;
  let appSecret: string;
  try {
    const crypto = getCryptoBoundary(env);
    appId = crypto.decrypt(appIdCiphertext);
    appSecret = crypto.decrypt(appSecretCiphertext);
  } catch {
    return null;
  }
  const binding = resolveWebBinding(env);
  const redirectUri =
    env.ADDROID_META_OAUTH_REDIRECT_URI?.trim() ||
    `http://${binding.hostname}:${binding.port}/api/oauth/meta/callback`;
  const permissions = secrets?.meta?.oauth?.permissions;
  const scopes =
    Array.isArray(permissions) && permissions.length > 0
      ? permissions
      : Array.from(ADDROID_META_REQUIRED_SCOPES);
  return { appId, appSecret, redirectUri, scopes };
}

export interface BuildPrismaMetaAdapterOptions {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
  /**
   * ad account key → oauth_tokens.accountIdentifier。省略時は既定トークン 1 本の
   * 従来挙動。ビジネスポートフォリオごとにトークンが分かれる場合に渡す。
   */
  resolveTokenRef?: (accountKey: string) => Promise<string | null | undefined>;
  /** 常にこのトークンを使う (列挙系をトークン別に回すとき)。 */
  forceTokenRef?: string | null;
}

/**
 * `ad_accounts.metaTokenRef` を引く既定のリゾルバ。
 * workspace を跨がずに key で一意に引ける (`@@unique([workspaceId, key])`) ため、
 * ここでは key のみで検索し、見つからなければ null (= 既定トークン) を返す。
 */
export function createPrismaMetaTokenRefResolver(
  prisma: PrismaClient,
  workspaceId: string
): (accountKey: string) => Promise<string | null> {
  return async (accountKey: string) => {
    const row = await prisma.adAccount.findUnique({
      where: { workspaceId_key: { workspaceId, key: accountKey } },
      select: { metaTokenRef: true },
    });
    return row?.metaTokenRef ?? null;
  };
}

/**
 * Prisma 永続 token store + 上級者向け Meta OAuth client + crypto boundary から
 * `selectMetaAdapter` を呼んで `MetaAdapterSelection` を返す。
 *
 * - `ADDROID_META_OAUTH_MOCK=1` → Mock
 * - OAuth client + crypto 揃う → Real (上級者向け OAuth)
 * - crypto のみ → StoredToken (標準の Access Token 入力方式)
 * - それ以外 → Stub (`loadAccessTokenPlaintext` は null を返し、後段で
 *   auth_error + reauth notify に変換される — regression fix/012 共通)
 */
export async function buildPrismaMetaAdapterSelection(
  opts: BuildPrismaMetaAdapterOptions
): Promise<MetaAdapterSelection> {
  const env = opts.env ?? process.env;
  const tokenStore = createPrismaMetaTokenStore(opts.prisma);
  const oauthClient = await loadMetaOAuthClientFromEnv(env);
  let crypto: ReturnType<typeof getCryptoBoundary> | undefined;
  try {
    crypto = getCryptoBoundary(env);
  } catch {
    crypto = undefined;
  }
  return selectMetaAdapter({
    env,
    tokenStore,
    ...(oauthClient ? { oauthClient } : {}),
    ...(crypto ? { crypto } : {}),
    ...(opts.resolveTokenRef ? { resolveTokenRef: opts.resolveTokenRef } : {}),
    ...(opts.forceTokenRef ? { forceTokenRef: opts.forceTokenRef } : {}),
  });
}
