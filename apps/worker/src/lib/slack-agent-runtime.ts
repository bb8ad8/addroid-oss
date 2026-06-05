// AdDroid OSS — Slack 対話 Agent アダプタ。
//
// Agent ループ本体は transport 非依存の {@link runChatAgentJob} (chat-agent-runtime.ts)
// に移譲し、本ファイルは Slack 固有の I/O (処理中/最終メッセージの postSlackMessage、
// Slack File API 経由の添付画像取得、audit の Slack メタ) だけを {@link ChatAgentTransport}
// として組み立てる薄いアダプタ。ユーザーに見える文字列・挙動は従来と同一。

import {
  LocalDiskStorage,
  downloadSlackPrivateFile,
  getSlackFileInfo,
  postSlackMessage,
  type SlackFetch,
} from "@addroid/config";
import type { PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import type { LLMProvider } from "@addroid/llm-provider";
import type PgBoss from "pg-boss";
import type { SlackAgentJobPayload } from "@addroid/queue";
import {
  CHAT_REFERENCE_IMAGE_MAX_BYTES,
  extensionForChatImageMime,
  normalizeChatImageMime,
  runChatAgentJob,
  safeChatFilename,
  type ChatAgentJobResult,
  type ChatAgentTransport,
} from "./chat-agent-runtime.js";

export interface RunSlackAgentJobOptions {
  payload: SlackAgentJobPayload;
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
  botToken: string;
  githubAdapter?: GithubAdapter;
  slackFetch?: SlackFetch;
  webUrl?: string;
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

export type SlackAgentJobResult = ChatAgentJobResult;

export async function runSlackAgentJob(
  opts: RunSlackAgentJobOptions
): Promise<SlackAgentJobResult> {
  const threadTs = opts.payload.threadTs || opts.payload.eventTs;
  const actor = `slack:${opts.payload.slackUserId}`;

  const transport: ChatAgentTransport = {
    inputText: opts.payload.text,
    actor,
    surface: "slack-chat",
    toolSource: "slack-chat",
    async postProcessing(): Promise<boolean> {
      try {
        await postSlackMessage(
          opts.botToken,
          opts.payload.slackChannelId,
          "受け付けました。AdDroid Agent が確認しています...",
          {
            threadTs,
            ...(opts.slackFetch ? { fetchImpl: opts.slackFetch } : {}),
          }
        );
        return true;
      } catch {
        return false;
      }
    },
    loadReferenceImages: () => loadSlackReferenceImages(opts),
    async postFinal(text: string): Promise<boolean> {
      try {
        await postSlackMessage(opts.botToken, opts.payload.slackChannelId, text, {
          threadTs,
          ...(opts.slackFetch ? { fetchImpl: opts.slackFetch } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },
    audit: {
      action: "agent.chat_via_slack",
      target: `slack:${opts.payload.slackChannelId}:${threadTs}`,
      metadata: {
        eventType: opts.payload.eventType,
        slackTeamId: opts.payload.slackTeamId ?? null,
        slackChannelId: opts.payload.slackChannelId,
        slackUserId: opts.payload.slackUserId,
        threadTs,
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

async function loadSlackReferenceImages(opts: RunSlackAgentJobOptions): Promise<string[]> {
  const files = opts.payload.files ?? [];
  if (files.length === 0) {
    if (opts.payload.text.includes("添付") || opts.payload.text.includes("画像")) {
      opts.logger?.warn(
        `[worker] slack_agent reference images: no Slack files in payload (${opts.payload.eventType} ${opts.payload.slackChannelId}:${opts.payload.eventTs})`
      );
    }
    return [];
  }
  opts.logger?.info(
    `[worker] slack_agent reference images: ${files.length} Slack file(s) in payload (${opts.payload.eventType} ${opts.payload.slackChannelId}:${opts.payload.eventTs})`
  );
  const storage = new LocalDiskStorage({ env: process.env });
  await storage.ensureRoot();
  const dir = `slack-agent-uploads/${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const paths: string[] = [];
  for (const fileRef of files.slice(0, 4)) {
    try {
      const info = await getSlackFileInfo(
        opts.botToken,
        fileRef.id,
        opts.slackFetch ?? (globalThis.fetch as unknown as SlackFetch)
      );
      const mimeType = normalizeChatImageMime(info.mimetype ?? fileRef.mimetype ?? null);
      if (!mimeType) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: unsupported mime file=${fileRef.id} mime=${info.mimetype ?? fileRef.mimetype ?? "unknown"}`
        );
        continue;
      }
      const size = typeof info.size === "number" ? info.size : fileRef.size;
      if (typeof size === "number" && size > CHAT_REFERENCE_IMAGE_MAX_BYTES) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: too large file=${fileRef.id} size=${size}`
        );
        continue;
      }
      const url = info.url_private_download ?? info.url_private;
      if (!url) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: no private URL file=${fileRef.id}`
        );
        continue;
      }
      const downloaded = await downloadSlackPrivateFile(
        opts.botToken,
        url,
        opts.slackFetch ?? (globalThis.fetch as unknown as SlackFetch)
      );
      if (downloaded.bytes.byteLength > CHAT_REFERENCE_IMAGE_MAX_BYTES) {
        opts.logger?.warn(
          `[worker] slack_agent reference image skipped: downloaded too large file=${fileRef.id} size=${downloaded.bytes.byteLength}`
        );
        continue;
      }
      const downloadedMime = normalizeChatImageMime(downloaded.contentType) ?? mimeType;
      const filename = safeChatFilename(
        info.name ?? info.title ?? fileRef.name ?? fileRef.id,
        extensionForChatImageMime(downloadedMime)
      );
      const key = `${dir}/${filename}`;
      const written = await storage.write(key, downloaded.bytes);
      paths.push(written.path);
      opts.logger?.info(
        `[worker] slack_agent reference image saved: file=${fileRef.id} path=${written.path}`
      );
    } catch (err) {
      opts.logger?.warn(
        `[worker] slack_agent reference image failed: file=${fileRef.id} error=${(err as Error).message}`
      );
      continue;
    }
  }
  if (paths.length === 0) {
    opts.logger?.warn(
      `[worker] slack_agent reference images: no usable image files (${opts.payload.eventType} ${opts.payload.slackChannelId}:${opts.payload.eventTs})`
    );
  }
  return paths;
}
