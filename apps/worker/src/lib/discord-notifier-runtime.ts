// AdDroid OSS — apps/worker Discord notification dispatcher wiring.
//
// slack-notifier-runtime.ts と対称。`@addroid/config` の `dispatchDiscordNotification`
// は副作用を持たない関数で、呼び出し側が botToken / channelId / audit writer を渡す契約。
// 本ファイルは worker から producer (daily_report / budget_guard / improvement_pr /
// execute_apply 等) ごとに呼ぶための薄いアダプタを提供する:
//
//   1. `oauth_tokens(provider="discord")` を都度参照し、`getCryptoBoundary` で復号した
//      平文 bot トークンと metadata.channelId をディスパッチに使う。未設定 (行が無い /
//      ENCRYPTION_KEY 不在 / 復号失敗 / channel 未設定) の場合は botToken=""/channelId=""
//      で渡し、dispatcher 側の `skipped_no_discord` 経路に倒す。
//   2. audit writer を注入し、各 dispatch 終了時に `audit_logs` に 1 行残す。
//   3. **本関数は throw しない**。Discord 失敗を core 実行系に伝播させない契約。

import {
  dispatchDiscordNotification,
  getCryptoBoundary,
  sanitizeForSlack,
  type CryptoBoundary,
  type DiscordDispatchResult,
  type DiscordFetch,
  type DiscordNotificationAuditWriter,
  type NotificationPayload,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";

export interface WorkerDiscordNotifierLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface CreateWorkerDiscordNotifierOptions {
  prisma: PrismaClient;
  audit: DiscordNotificationAuditWriter;
  discordFetch?: DiscordFetch;
  cryptoBoundary?: CryptoBoundary;
  now?: () => Date;
  logger?: WorkerDiscordNotifierLogger;
}

export interface WorkerDiscordNotifier {
  dispatch(payload: NotificationPayload): Promise<DiscordDispatchResult>;
}

interface DiscordInstallationMetadataShape {
  channelId?: unknown;
}

async function loadDiscordBotConfig(opts: {
  prisma: PrismaClient;
  cryptoBoundary?: CryptoBoundary;
  logger?: WorkerDiscordNotifierLogger;
}): Promise<{ botToken: string; channelId: string } | null> {
  const log = opts.logger;

  let crypto: CryptoBoundary;
  try {
    crypto = opts.cryptoBoundary ?? getCryptoBoundary();
  } catch (err) {
    log?.info?.(
      `[discord-notifier] ENCRYPTION_KEY 未設定のため Discord 通知を skip: ${(err as Error).message}`
    );
    return null;
  }

  let row: { accessTokenCiphertext: string; metadata: unknown } | null;
  try {
    row = await opts.prisma.oAuthToken.findFirst({
      where: { provider: "discord" },
      orderBy: { connectedAt: "desc" },
      select: { accessTokenCiphertext: true, metadata: true },
    });
  } catch (err) {
    log?.warn?.(
      `[discord-notifier] oauth_tokens 読み出し失敗 (Discord 通知 skip): ${sanitizeForSlack((err as Error).message)}`
    );
    return null;
  }
  if (!row) return null;

  let botToken: string;
  try {
    botToken = crypto.decrypt(row.accessTokenCiphertext);
  } catch (err) {
    log?.warn?.(
      `[discord-notifier] Discord bot token の復号に失敗 (Discord 通知 skip): ${sanitizeForSlack((err as Error).message)}`
    );
    return null;
  }

  const metadata = (row.metadata ?? {}) as DiscordInstallationMetadataShape;
  const channelId =
    typeof metadata.channelId === "string" ? metadata.channelId.trim() : "";
  if (!channelId) {
    log?.info?.(
      "[discord-notifier] metadata.channelId が未設定のため Discord 通知を skip。`addroid connect discord` で対象チャンネルを設定してください。"
    );
    return null;
  }

  return { botToken, channelId };
}

/**
 * worker producer から呼ぶ Discord 通知ディスパッチャを構築する。Slack 版と対称で、
 * 未設定でも例外を出さず `skipped_no_discord` を返す。
 */
export function createWorkerDiscordNotifier(
  opts: CreateWorkerDiscordNotifierOptions
): WorkerDiscordNotifier {
  return {
    async dispatch(payload: NotificationPayload): Promise<DiscordDispatchResult> {
      const config = await loadDiscordBotConfig({
        prisma: opts.prisma,
        ...(opts.cryptoBoundary ? { cryptoBoundary: opts.cryptoBoundary } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
      return await dispatchDiscordNotification(payload, {
        botToken: config?.botToken ?? "",
        channelId: config?.channelId ?? "",
        audit: opts.audit,
        ...(opts.discordFetch ? { fetchImpl: opts.discordFetch } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    },
  };
}
