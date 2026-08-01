// AdDroid OSS — Meta token persistence boundary.
//
// adapter は `oauth_tokens` テーブルを直接触らず、本 interface 越しに保存/取得する。
// 暗号化は adapter 側で実施し、Store には常に ciphertext を渡す。
//
// 実装:
//   - InMemoryMetaTokenStore  (本ファイル) — テストとローカル simulation 用
//   - PrismaMetaTokenStore     (apps/web/lib/meta-runtime.ts)

import type { MetaTokenProvider } from "./types.js";

export interface MetaOAuthTokenRecord {
  provider: MetaTokenProvider;
  /** 表示用の安定識別子 (Meta user id 等)。機微ではない。 */
  accountIdentifier: string;
  scopes: string[];
  /** 暗号化済み access token (例 "v1.aes256gcm.iv.tag.payload")。 */
  accessTokenCiphertext: string;
  /** Meta は refresh_token を持たないが、interface 統一のため null 許容で残す。 */
  refreshTokenCiphertext?: string | null;
  /** long-lived token の expiresAt。null = 不明 (System User token 等)。 */
  expiresAt?: Date | null;
  connectedAt: Date;
}

export interface MetaOAuthTokenStore {
  /** provider+account 単位で upsert する。 */
  saveOAuthToken(record: MetaOAuthTokenRecord): Promise<void>;
  /**
   * トークンを 1 件返す。
   *
   * @param accountIdentifier 指定するとその行を返す。ビジネスポートフォリオごとに
   *   トークンが分かれるため、広告アカウント単位で使い分けられるようにしている。
   *   未指定、または該当行が無い場合は直近で接続された 1 件にフォールバックする。
   */
  loadOAuthToken(
    provider: MetaTokenProvider,
    accountIdentifier?: string | null
  ): Promise<MetaOAuthTokenRecord | null>;
}

/**
 * メモリ内に保持するテスト用 store。同一 provider+account は最新値で上書きされ、
 * `loadOAuthToken` は connectedAt 降順で最も新しい行を返す。
 */
export class InMemoryMetaTokenStore implements MetaOAuthTokenStore {
  private records = new Map<string, MetaOAuthTokenRecord>();

  async saveOAuthToken(record: MetaOAuthTokenRecord): Promise<void> {
    const key = `${record.provider}:${record.accountIdentifier}`;
    this.records.set(key, { ...record });
  }

  async loadOAuthToken(
    provider: MetaTokenProvider,
    accountIdentifier?: string | null
  ): Promise<MetaOAuthTokenRecord | null> {
    if (accountIdentifier) {
      const exact = this.records.get(`${provider}:${accountIdentifier}`);
      if (exact) return { ...exact };
      // 該当なしは既定へフォールバック (下へ抜ける)。
    }
    let latest: MetaOAuthTokenRecord | null = null;
    for (const rec of this.records.values()) {
      if (rec.provider !== provider) continue;
      if (!latest || rec.connectedAt.getTime() > latest.connectedAt.getTime()) {
        latest = rec;
      }
    }
    return latest ? { ...latest } : null;
  }

  /** test helper. */
  size(): number {
    return this.records.size;
  }
}
