import { NextResponse } from "next/server";
import { Prisma } from "@addroid/db";
import {
  buildDiscordInstallationMetadata,
  getCryptoBoundary,
  getDiscordChannel,
  postDiscordMessage,
  DiscordApiError,
  DiscordTokenValidationError,
  validateDiscordInputs,
  verifyDiscordBotToken,
} from "@addroid/config";
import { prisma } from "../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../lib/github-runtime";
import { requireTrustedJsonWebAction, requireTrustedWebAction } from "../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  botToken?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  sendTestMessage?: unknown;
}

const TEST_MESSAGE =
  "AdDroid 接続テスト — Web UI から Discord 接続を保存しました。";

type DiscordConnectStage =
  | "prepare"
  | "workspace"
  | "applications.@me"
  | "channels"
  | "channels.messages"
  | "persist"
  | "audit";

function discordConnectErrorPayload(stage: DiscordConnectStage, err: unknown) {
  const message = (err as Error).message || "unknown error";
  if (err instanceof DiscordApiError) {
    return {
      ok: false,
      stage,
      error: `${stage} に失敗しました: ${message}`,
      discordCode: err.discordCode,
      httpStatus: err.status,
    };
  }
  return { ok: false, stage, error: `${stage} に失敗しました: ${message}` };
}

function logDiscordConnectFailure(stage: DiscordConnectStage, err: unknown) {
  if (err instanceof DiscordApiError) {
    console.error("[discord-connect] failed", {
      stage,
      endpoint: err.endpoint,
      httpStatus: err.status,
      discordCode: err.discordCode,
      message: err.message,
    });
    return;
  }
  console.error("[discord-connect] failed", {
    stage,
    name: (err as Error).name,
    message: (err as Error).message,
  });
}

export async function POST(request: Request) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 }
    );
  }

  let normalized;
  try {
    normalized = validateDiscordInputs({
      botToken: typeof payload.botToken === "string" ? payload.botToken : "",
      guildId: typeof payload.guildId === "string" ? payload.guildId : "",
      channelId: typeof payload.channelId === "string" ? payload.channelId : "",
    });
  } catch (err) {
    if (err instanceof DiscordTokenValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 400 }
    );
  }

  let stage: DiscordConnectStage = "prepare";
  try {
    const crypto = getCryptoBoundary(process.env);
    stage = "workspace";
    const workspace = await ensureWebWorkspace();
    stage = "applications.@me";
    const application = await verifyDiscordBotToken(normalized.botToken);
    stage = "channels";
    const channel = await getDiscordChannel(normalized.botToken, normalized.channelId);
    if (channel.guildId && channel.guildId !== normalized.guildId) {
      return NextResponse.json(
        {
          ok: false,
          stage: "channels",
          error: `指定 channel は guild ${channel.guildId} に属します (guild ${normalized.guildId} と不一致)。`,
        },
        { status: 400 }
      );
    }
    let testMessageOkAt: Date | null = null;
    if (payload.sendTestMessage === true) {
      stage = "channels.messages";
      await postDiscordMessage(normalized.botToken, normalized.channelId, TEST_MESSAGE);
      testMessageOkAt = new Date();
    }
    const verifiedAt = new Date();
    const metadata = buildDiscordInstallationMetadata({
      application,
      guildId: normalized.guildId,
      channelId: normalized.channelId,
      channelName: channel.name,
      verifiedAt,
      testMessageOkAt,
    }) as unknown as Prisma.InputJsonValue;
    stage = "persist";
    await prisma.oAuthToken.upsert({
      where: {
        provider_accountIdentifier: {
          provider: "discord",
          accountIdentifier: normalized.guildId,
        },
      },
      update: {
        scopes: ["bot", "applications.commands"],
        accessTokenCiphertext: crypto.encrypt(normalized.botToken),
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt: verifiedAt,
        metadata,
      },
      create: {
        provider: "discord",
        accountIdentifier: normalized.guildId,
        scopes: ["bot", "applications.commands"],
        accessTokenCiphertext: crypto.encrypt(normalized.botToken),
        refreshTokenCiphertext: null,
        expiresAt: null,
        connectedAt: verifiedAt,
        metadata,
      },
    });
    stage = "audit";
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:discord-ui",
        action: "oauth.discord.connected_via_web",
        target: `oauth_tokens:discord:${normalized.guildId}`,
        ref: normalized.guildId,
        metadata: {
          applicationId: application.applicationId,
          botUserId: application.botUserId,
          botUsername: application.botUsername,
          guildId: normalized.guildId,
          channelId: normalized.channelId,
          channelName: channel.name,
          testMessageSent: testMessageOkAt !== null,
        },
      },
    });
    return NextResponse.json({
      ok: true,
      applicationId: application.applicationId,
      botUsername: application.botUsername,
      guildId: normalized.guildId,
      channelId: normalized.channelId,
      channelName: channel.name,
      connectedAt: verifiedAt.toISOString(),
      testMessageSent: testMessageOkAt !== null,
    });
  } catch (err) {
    logDiscordConnectFailure(stage, err);
    return NextResponse.json(discordConnectErrorPayload(stage, err), { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const denied = requireTrustedWebAction(request);
  if (denied) return denied;

  try {
    const workspace = await ensureWebWorkspace();
    const result = await prisma.oAuthToken.deleteMany({ where: { provider: "discord" } });
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actor: "user:discord-ui",
        action: "oauth.discord.disconnected_via_web",
        target: "oauth_tokens:discord",
        ref: "discord",
        metadata: { removed: result.count },
      },
    });
    return NextResponse.json({ ok: true, removed: result.count });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
