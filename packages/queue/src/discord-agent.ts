import type { DiscordCommandBoss } from "./discord-command.js";

export const DISCORD_AGENT_JOB_NAME = "discord_agent" as const;

export type DiscordAgentEventType = "message_create" | "mention";

export interface DiscordAgentAttachmentReference {
  id: string;
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
}

export interface DiscordAgentJobPayload {
  text: string;
  discordUserId: string;
  discordUserName?: string;
  channelId: string;
  guildId?: string;
  messageId: string;
  eventType: DiscordAgentEventType;
  attachments?: DiscordAgentAttachmentReference[];
  enqueuedAt: string;
}

export interface EnqueueDiscordAgentJobOptions {
  boss: DiscordCommandBoss;
  payload: Omit<DiscordAgentJobPayload, "enqueuedAt">;
  singletonKey?: string;
  now?: () => Date;
}

export interface EnqueueDiscordAgentJobResult {
  jobId: string | null;
  singletonKey: string;
  payload: DiscordAgentJobPayload;
}

export function buildDiscordAgentSingletonKey(
  payload: Omit<DiscordAgentJobPayload, "enqueuedAt">
): string {
  const guild = payload.guildId?.trim() || "guild";
  const channel = payload.channelId.trim() || "channel";
  const id = payload.messageId.trim() || "message";
  return `discord_agent:${guild}:${channel}:${id}`;
}

export async function enqueueDiscordAgentJob(
  opts: EnqueueDiscordAgentJobOptions
): Promise<EnqueueDiscordAgentJobResult> {
  const payload: DiscordAgentJobPayload = {
    ...opts.payload,
    enqueuedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  const singletonKey = opts.singletonKey ?? buildDiscordAgentSingletonKey(opts.payload);
  const jobId = await opts.boss.send(DISCORD_AGENT_JOB_NAME, payload, {
    singletonKey,
  });
  return { jobId, singletonKey, payload };
}
