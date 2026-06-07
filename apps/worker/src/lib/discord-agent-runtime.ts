// AdDroid OSS — Discord 対話 Agent アダプタ。
//
// Slack 版 (slack-agent-runtime.ts) と対称。Agent ループ本体は transport 非依存の
// {@link runChatAgentJob} に移譲し、本ファイルは Discord 固有 I/O (channel への
// postDiscordMessage、CDN URL からの添付画像取得、audit の Discord メタ) だけを組む。

import {
  LocalDiskStorage,
  downloadDiscordAttachment,
  getRecentDiscordMessages,
  postDiscordMessage,
  type DiscordFetch,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import type { LLMProvider } from "@addroid/llm-provider";
import type PgBoss from "pg-boss";
import type { DiscordAgentJobPayload } from "@addroid/queue";
import {
  CHAT_REFERENCE_IMAGE_MAX_BYTES,
  extensionForChatImageMime,
  normalizeChatImageMime,
  runChatAgentJob,
  safeChatFilename,
  type ChatAgentJobResult,
  type ChatAgentTransport,
} from "./chat-agent-runtime.js";

/** Discord 1 メッセージの content 上限 (2000) に対する安全マージン。 */
const DISCORD_MESSAGE_MAX = 1990;

export interface RunDiscordAgentJobOptions {
  payload: DiscordAgentJobPayload;
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
  botToken: string;
  githubAdapter?: GithubAdapter;
  discordFetch?: DiscordFetch;
  webUrl?: string;
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

export type DiscordAgentJobResult = ChatAgentJobResult;

export async function runDiscordAgentJob(
  opts: RunDiscordAgentJobOptions
): Promise<DiscordAgentJobResult> {
  const actor = `discord:${opts.payload.discordUserId}`;
  const conversationContext = await buildConversationContext(opts);

  const transport: ChatAgentTransport = {
    inputText: opts.payload.text,
    ...(conversationContext ? { conversationContext } : {}),
    actor,
    surface: "discord-chat",
    toolSource: "discord-chat",
    async postProcessing(): Promise<boolean> {
      try {
        await postDiscordMessage(
          opts.botToken,
          opts.payload.channelId,
          "受け付けました。AdDroid Agent が確認しています...",
          opts.discordFetch ? { fetchImpl: opts.discordFetch } : {}
        );
        return true;
      } catch {
        return false;
      }
    },
    loadReferenceImages: () => loadDiscordReferenceImages(opts),
    async postFinal(text: string): Promise<boolean> {
      try {
        await postDiscordMessage(
          opts.botToken,
          opts.payload.channelId,
          text.slice(0, DISCORD_MESSAGE_MAX),
          opts.discordFetch ? { fetchImpl: opts.discordFetch } : {}
        );
        return true;
      } catch {
        return false;
      }
    },
    audit: {
      action: "agent.chat_via_discord",
      target: `discord:${opts.payload.channelId}:${opts.payload.messageId}`,
      metadata: {
        eventType: opts.payload.eventType,
        guildId: opts.payload.guildId ?? null,
        channelId: opts.payload.channelId,
        discordUserId: opts.payload.discordUserId,
        messageId: opts.payload.messageId,
      },
    },
  };

  return runChatAgentJob(
    {
      prisma: opts.prisma,
      workspaceId: opts.workspaceId,
      provider: opts.provider,
      boss: opts.boss,
      ...(opts.githubAdapter ? { githubAdapter: opts.githubAdapter } : {}),
      ...(opts.webUrl ? { webUrl: opts.webUrl } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    },
    transport
  );
}

/**
 * 直近の Discord 会話履歴を取得し、エージェントに渡す「会話メモリ + 一問一答ガイド」
 * の文脈文字列を組み立てる。各 Discord メッセージは独立ジョブで処理され記憶を持たない
 * ため、ここで直近のやり取りを文脈として与えることで多メッセージにまたがる対話を可能にする。
 * 取得失敗は致命的でないので undefined を返す (会話文脈なしで通常応答)。
 */
async function buildConversationContext(
  opts: RunDiscordAgentJobOptions
): Promise<string | undefined> {
  const sections: string[] = [];

  // 1) アカウント名簿: ユーザーは店名/通称でアカウントを指す。ID は知らない前提で、
  //    名前→key の対応表を渡して「ID を聞き返さず名前で照合」させる。
  try {
    const accounts = await opts.prisma.adAccount.findMany({
      where: { workspaceId: opts.workspaceId, active: true },
      select: { key: true, displayName: true },
      orderBy: { displayName: "asc" },
      take: 200,
    });
    if (accounts.length > 0) {
      const directory = accounts
        .map((a) => `- ${a.displayName} → ${a.key}`)
        .join("\n");
      sections.push(
        [
          "【広告アカウント名簿】",
          "ユーザーは店名/通称 (例: めぐる, MEGURU, 上野店) でアカウントを指します。技術的な ID (act_...) は知りません。",
          "下の一覧から名前で照合して対象を特定し、ID を聞き返さないでください。複数該当する場合のみ候補名 (ID ではなく名前) を挙げて選ばせてください。",
          directory,
        ].join("\n")
      );
    }
  } catch (err) {
    opts.logger?.warn(
      `[worker] discord_agent account directory fetch failed: ${(err as Error).message}`
    );
  }

  // 2) 会話履歴: 各メッセージは独立ジョブなので、直近のやり取りを文脈として渡す。
  try {
    const history = await getRecentDiscordMessages(
      opts.botToken,
      opts.payload.channelId,
      10,
      opts.discordFetch ?? (globalThis.fetch as unknown as DiscordFetch)
    );
    const transcript = history
      .filter((m) => m.id !== opts.payload.messageId)
      .filter((m) => m.content && m.content.trim().length > 0)
      // 定型の処理中メッセージはノイズなので除外。
      .filter((m) => !m.content.startsWith("受け付けました。AdDroid Agent"))
      .map((m) => `${m.isBot ? "AdDroid" : m.authorUsername || "user"}: ${m.content.trim()}`)
      .join("\n");
    if (transcript) {
      sections.push(`【継続中の Discord 会話です。直近のやり取り】\n${transcript}`);
    }
  } catch (err) {
    opts.logger?.warn(
      `[worker] discord_agent history fetch failed (会話文脈なしで継続): ${(err as Error).message}`
    );
  }

  // 3) 応答ガイド (スマホの非エンジニアでも使えるように)
  sections.push(
    [
      "【応答ガイド】",
      "- ユーザーは技術用語や ID を知らない前提。アカウントは上の名簿から名前で特定し、ID は聞き返さない。",
      "- 不足情報 (入札戦略・日予算・配信先URL など) は推測せず 1 つずつ、平易な言葉で短く質問する。選択肢があるものは候補を 2〜3 個添えて選びやすくする。",
      "- 情報が揃ったら、対象アカウントに限定したツールで実行する。全アカウント一括の操作はしない。",
      "- すでに会話で確定済みの項目は再度聞かない。",
      "【成果・課題分析の方法】",
      "- 目標値 (登録単価/CPA など) を確認し、合計値だけでなく『直近(date_preset=last_7d)』と『前期間(last_14d や last_30d)』を比較してトレンド(悪化/改善)を示す。",
      "- 期間指定は query_meta_ads の date_preset (today/yesterday/last_7d/last_14d/last_30d/this_month/last_month 等) を優先し、自前の日付計算は避ける。エラー時はエラーメッセージに従って引数を直して 1 回だけ再試行する。",
    ].join("\n")
  );

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

async function loadDiscordReferenceImages(
  opts: RunDiscordAgentJobOptions
): Promise<string[]> {
  const attachments = opts.payload.attachments ?? [];
  if (attachments.length === 0) return [];
  opts.logger?.info(
    `[worker] discord_agent reference images: ${attachments.length} attachment(s) in payload (${opts.payload.channelId}:${opts.payload.messageId})`
  );
  const storage = new LocalDiskStorage({ env: process.env });
  await storage.ensureRoot();
  const dir = `discord-agent-uploads/${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const paths: string[] = [];
  for (const att of attachments.slice(0, 4)) {
    try {
      const mimeType = normalizeChatImageMime(att.contentType ?? null);
      if (!mimeType) {
        opts.logger?.warn(
          `[worker] discord_agent reference image skipped: unsupported mime id=${att.id} mime=${att.contentType ?? "unknown"}`
        );
        continue;
      }
      if (typeof att.size === "number" && att.size > CHAT_REFERENCE_IMAGE_MAX_BYTES) {
        opts.logger?.warn(
          `[worker] discord_agent reference image skipped: too large id=${att.id} size=${att.size}`
        );
        continue;
      }
      if (!att.url) {
        opts.logger?.warn(
          `[worker] discord_agent reference image skipped: no url id=${att.id}`
        );
        continue;
      }
      const downloaded = await downloadDiscordAttachment(
        att.url,
        opts.discordFetch ?? (globalThis.fetch as unknown as DiscordFetch)
      );
      if (downloaded.bytes.byteLength > CHAT_REFERENCE_IMAGE_MAX_BYTES) {
        opts.logger?.warn(
          `[worker] discord_agent reference image skipped: downloaded too large id=${att.id} size=${downloaded.bytes.byteLength}`
        );
        continue;
      }
      const downloadedMime = normalizeChatImageMime(downloaded.contentType) ?? mimeType;
      const filename = safeChatFilename(
        att.name ?? att.id,
        extensionForChatImageMime(downloadedMime)
      );
      const written = await storage.write(`${dir}/${filename}`, downloaded.bytes);
      paths.push(written.path);
      opts.logger?.info(
        `[worker] discord_agent reference image saved: id=${att.id} path=${written.path}`
      );
    } catch (err) {
      opts.logger?.warn(
        `[worker] discord_agent reference image failed: id=${att.id} error=${(err as Error).message}`
      );
      continue;
    }
  }
  return paths;
}
