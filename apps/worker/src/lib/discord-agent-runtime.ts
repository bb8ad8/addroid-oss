// AdDroid OSS — Discord 対話 Agent アダプタ。
//
// Slack 版 (slack-agent-runtime.ts) と対称。Agent ループ本体は transport 非依存の
// {@link runChatAgentJob} に移譲し、本ファイルは Discord 固有 I/O (channel への
// postDiscordMessage、CDN URL からの添付画像取得、audit の Discord メタ) だけを組む。

import {
  LocalDiskStorage,
  downloadDiscordAttachment,
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

  const transport: ChatAgentTransport = {
    inputText: opts.payload.text,
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
