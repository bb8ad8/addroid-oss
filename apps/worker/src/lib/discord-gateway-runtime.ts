// AdDroid OSS — apps/worker Discord Gateway 受信機 (discord.js)。
//
// slack-socket-runtime.ts の Discord 版。Slack は Socket Mode の純粋プロトコル機を
// `@addroid/queue` に置いたが、Discord は discord.js が Gateway WebSocket を内包する
// ため、受信機は worker アダプタに置く (妥当な非対称)。
//
// 役割:
//   1. oauth_tokens(provider="discord") を復号して installation を組み立てる。
//      未設定 (行なし / ENCRYPTION_KEY なし / 復号失敗) なら **null を返し**、worker は
//      Discord 受信機を起動しないまま GitOps polling / Apply / Cron を続行する。
//   2. discord.js Client を最小 intents (Guilds / GuildMessages / MessageContent) で接続。
//      Gateway WebSocket は常時アウトバウンド接続であり inbound webhook を一切開かない。
//   3. ready 時に対象 guild へ `/adops` スラッシュコマンドを登録。
//   4. interactionCreate (/adops) → defer + discord_command ジョブへ enqueue。
//      messageCreate (対象チャンネルの非bot発言) → discord_agent ジョブへ enqueue。
//   5. 本モジュールは throw しない (受信機の失敗を core 実行系に伝播させない)。

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type Interaction,
  type Message,
} from "discord.js";
import {
  getCryptoBoundary,
} from "@addroid/config";
import {
  enqueueDiscordAgentJob,
  enqueueDiscordCommandJob,
  parseDiscordCommand,
  type DiscordCommandBoss,
} from "@addroid/queue";
import type { PrismaClient } from "@addroid/db";

export interface DiscordGatewayLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}

export interface DiscordInstallation {
  botToken: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  botUserId: string;
}

export type DiscordGatewayState =
  | "connecting"
  | "ready"
  | "closed"
  | "failed";

export interface DiscordGatewayHandle {
  getState(): DiscordGatewayState;
  stop(): Promise<void>;
}

export interface StartDiscordGatewayRuntimeOptions {
  prisma: PrismaClient;
  boss: DiscordCommandBoss;
  logger?: DiscordGatewayLogger;
}

// ---------------------------------------------------------------------
// 1) installation loader (decrypt boundary)
// ---------------------------------------------------------------------

interface DiscordInstallationMetadataShape {
  applicationId?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  botUserId?: unknown;
}

export async function loadDiscordInstallation(opts: {
  prisma: PrismaClient;
  logger?: DiscordGatewayLogger;
}): Promise<DiscordInstallation | null> {
  const log = opts.logger;

  let crypto: ReturnType<typeof getCryptoBoundary>;
  try {
    crypto = getCryptoBoundary();
  } catch (err) {
    log?.info(
      `[discord-gateway] ENCRYPTION_KEY 未設定のため Discord 受信機を skip: ${(err as Error).message}`
    );
    return null;
  }

  let row: { accessTokenCiphertext: string; accountIdentifier: string; metadata: unknown } | null;
  try {
    row = await opts.prisma.oAuthToken.findFirst({
      where: { provider: "discord" },
      orderBy: { connectedAt: "desc" },
      select: {
        accessTokenCiphertext: true,
        accountIdentifier: true,
        metadata: true,
      },
    });
  } catch (err) {
    log?.warn(
      `[discord-gateway] oauth_tokens 読み出し失敗 (受信機 skip): ${(err as Error).message}`
    );
    return null;
  }
  if (!row) return null;

  let botToken: string;
  try {
    botToken = crypto.decrypt(row.accessTokenCiphertext);
  } catch (err) {
    log?.warn(
      `[discord-gateway] Discord bot token の復号に失敗 (受信機 skip): ${(err as Error).message}`
    );
    return null;
  }

  const metadata = (row.metadata ?? {}) as DiscordInstallationMetadataShape;
  const applicationId =
    typeof metadata.applicationId === "string" ? metadata.applicationId : "";
  const guildId =
    typeof metadata.guildId === "string" && metadata.guildId.length > 0
      ? metadata.guildId
      : row.accountIdentifier;
  const channelId =
    typeof metadata.channelId === "string" ? metadata.channelId : "";
  const botUserId =
    typeof metadata.botUserId === "string" ? metadata.botUserId : "";

  if (!guildId || !channelId) {
    log?.warn(
      "[discord-gateway] guildId / channelId が metadata にありません — 受信機を skip。`addroid connect discord` を再実行してください。"
    );
    return null;
  }

  return { botToken, applicationId, guildId, channelId, botUserId };
}

// ---------------------------------------------------------------------
// 2) /adops slash command 定義 (Slack の SLACK_SLASH_SUBCOMMANDS と同集合)
// ---------------------------------------------------------------------

function buildAdopsCommandData() {
  return [
    new SlashCommandBuilder()
      .setName("adops")
      .setDescription(
        "AdDroid operations (report / budget / improve / status / accounts / activate)"
      )
      .addSubcommand((s) =>
        s.setName("report").setDescription("アクティブな ad_account の daily_report を実行")
      )
      .addSubcommand((s) => s.setName("budget").setDescription("budget_guard を評価"))
      .addSubcommand((s) =>
        s.setName("improve").setDescription("improvement_pr を起動 (PR を作成)")
      )
      .addSubcommand((s) => s.setName("status").setDescription("現在の AdDroid 状態を取得"))
      .addSubcommand((s) => s.setName("accounts").setDescription("ad_account 一覧を取得"))
      .addSubcommand((s) =>
        s
          .setName("activate")
          .setDescription("PAUSED の ads_hierarchy を audited で activate")
          .addStringOption((o) =>
            o
              .setName("target")
              .setDescription("ads_hierarchy id / external id / nodeKey")
              .setRequired(true)
          )
      )
      .toJSON(),
  ];
}

// ---------------------------------------------------------------------
// 3) 起動
// ---------------------------------------------------------------------

export async function startDiscordGatewayRuntime(
  opts: StartDiscordGatewayRuntimeOptions
): Promise<DiscordGatewayHandle | null> {
  const log = opts.logger;
  const install = await loadDiscordInstallation({ prisma: opts.prisma, ...(log ? { logger: log } : {}) });
  if (!install) return null;

  let state: DiscordGatewayState = "connecting";

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // DM 運用 (bot との 1:1 ダイレクトメッセージ) の受信に必要。非特権インテント。
      GatewayIntentBits.DirectMessages,
    ],
    // DM チャンネルは cache に乗らないことがあるため、partial で messageCreate を受ける。
    partials: [Partials.Channel],
  });

  client.on(Events.Error, (err) => {
    log?.error?.(`[discord-gateway] client error: ${err.message}`);
  });

  client.once(Events.ClientReady, (ready) => {
    state = "ready";
    log?.info(`[discord-gateway] connected as ${ready.user.tag} (guild=${install.guildId} channel=${install.channelId})`);
    const commands = buildAdopsCommandData();
    // guild scoped = 即時反映 (対象サーバーのテキストチャンネルで使う場合)。
    void ready.application?.commands
      .set(commands, install.guildId)
      .then(() => log?.info("[discord-gateway] /adops guild commands registered"))
      .catch((err: Error) =>
        log?.warn(`[discord-gateway] /adops guild command registration failed: ${err.message}`)
      );
    // global = DM を含む全コンテキストで /adops を出す。Discord 仕様で反映に最大1時間かかる。
    void ready.application?.commands
      .set(commands)
      .then(() => log?.info("[discord-gateway] /adops global commands registered (DM 反映は最大1時間)"))
      .catch((err: Error) =>
        log?.warn(`[discord-gateway] /adops global command registration failed: ${err.message}`)
      );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, install, opts.boss, log);
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, install, opts.boss, log);
  });

  try {
    await client.login(install.botToken);
  } catch (err) {
    state = "failed";
    log?.warn(`[discord-gateway] login に失敗 (受信機 skip): ${(err as Error).message}`);
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    return null;
  }

  return {
    getState: () => state,
    async stop(): Promise<void> {
      state = "closed";
      try {
        await client.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------
// 4) interaction (/adops) → discord_command enqueue
// ---------------------------------------------------------------------

async function handleInteraction(
  interaction: Interaction,
  install: DiscordInstallation,
  boss: DiscordCommandBoss,
  log?: DiscordGatewayLogger
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "adops") return;
  // 設定済みチャンネル (サーバーのテキストチャンネル or bot との DM) 以外は無視。
  // global コマンドはどこからでも起動できるため、ここで対象チャンネルに限定する。
  if (interaction.channelId !== install.channelId) {
    await interaction
      .reply({
        content: "AdDroid は設定済みのチャンネル / DM でのみ動作します。",
        ephemeral: true,
      })
      .catch(() => undefined);
    return;
  }

  const subcommand = interaction.options.getSubcommand(false) ?? "";
  const target =
    subcommand === "activate" ? interaction.options.getString("target") ?? "" : "";

  // 3 秒以内に defer (実処理はジョブで)。
  try {
    await interaction.deferReply();
  } catch (err) {
    log?.warn(`[discord-gateway] deferReply 失敗: ${(err as Error).message}`);
    return;
  }

  const parsed = parseDiscordCommand({
    subcommand,
    target,
    discordUserId: interaction.user.id,
    discordUserName: interaction.user.username,
    channelId: interaction.channelId,
    guildId: interaction.guildId ?? "",
    applicationId: install.applicationId || interaction.applicationId,
    interactionToken: interaction.token,
  });
  if (!parsed.ok) {
    await interaction.editReply(parsed.message).catch(() => undefined);
    return;
  }

  try {
    await enqueueDiscordCommandJob({
      boss,
      parsed,
      request: {
        subcommand: parsed.subcommand,
        target: parsed.target,
        rest: parsed.rest,
        discordUserId: interaction.user.id,
        discordUserName: interaction.user.username,
        channelId: interaction.channelId,
        guildId: interaction.guildId ?? "",
        applicationId: install.applicationId || interaction.applicationId,
        interactionToken: interaction.token,
      },
    });
  } catch (err) {
    log?.warn(`[discord-gateway] discord_command enqueue 失敗: ${(err as Error).message}`);
    await interaction
      .editReply("コマンドのキュー投入に失敗しました。worker のログを確認してください。")
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------
// 5) message (対象チャンネル) → discord_agent enqueue
// ---------------------------------------------------------------------

async function handleMessage(
  message: Message,
  install: DiscordInstallation,
  boss: DiscordCommandBoss,
  log?: DiscordGatewayLogger
): Promise<void> {
  if (message.author.bot) return;
  if (message.channelId !== install.channelId) return;

  const text = stripBotMention(message.content ?? "", install.botUserId).trim();
  if (!text) return;

  const attachments = [...message.attachments.values()].map((a) => ({
    id: a.id,
    url: a.url,
    ...(a.name ? { name: a.name } : {}),
    ...(a.contentType ? { contentType: a.contentType } : {}),
    ...(typeof a.size === "number" ? { size: a.size } : {}),
  }));

  try {
    await enqueueDiscordAgentJob({
      boss,
      payload: {
        text,
        discordUserId: message.author.id,
        discordUserName: message.author.username,
        channelId: message.channelId,
        ...(message.guildId ? { guildId: message.guildId } : {}),
        messageId: message.id,
        eventType: message.mentions.users.has(install.botUserId) ? "mention" : "message_create",
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });
  } catch (err) {
    log?.warn(`[discord-gateway] discord_agent enqueue 失敗: ${(err as Error).message}`);
  }
}

function stripBotMention(content: string, botUserId: string): string {
  if (!botUserId) return content;
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .trim();
}
