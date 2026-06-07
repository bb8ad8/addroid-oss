// `@addroid/queue` discord-command のユニットテスト。
// parseDiscordCommand と runDiscordCommandJob (handler 共有・interaction webhook 返信・
// audit・never-throws) を fetch / handler モックで網羅する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseDiscordCommand,
  runDiscordCommandJob,
  type DiscordCommandAuditInput,
  type DiscordCommandAuditWriter,
  type DiscordCommandJobPayload,
  type DiscordResponseFetch,
  type SlashCommandHandlers,
  type SlashHandlerInput,
  type SlashHandlerOutcome,
} from "../index.js";

function basePayload(over: Partial<DiscordCommandJobPayload> = {}): DiscordCommandJobPayload {
  return {
    subcommand: "report",
    target: "",
    rest: [],
    rawText: "report",
    discordUserId: "user1",
    discordUserName: "alice",
    channelId: "chan1",
    guildId: "guild1",
    applicationId: "app1",
    interactionToken: "tok1",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function handlersReturning(
  outcome: SlashHandlerOutcome,
  seen?: SlashHandlerInput[]
): SlashCommandHandlers {
  const fn = async (input: SlashHandlerInput) => {
    seen?.push(input);
    return outcome;
  };
  return {
    report: fn,
    budget: fn,
    improve: fn,
    status: fn,
    accounts: fn,
    activate: fn,
  };
}

function fakeResponseFetch(
  capture: { url?: string; method?: string; body?: string } = {},
  ok = true
): DiscordResponseFetch {
  return async (url, init) => {
    capture.url = url;
    capture.method = init.method;
    capture.body = init.body;
    return { ok, status: ok ? 200 : 500 };
  };
}

test("parseDiscordCommand は未対応 subcommand を弾く", () => {
  const r = parseDiscordCommand({
    subcommand: "frobnicate",
    discordUserId: "u",
    channelId: "c",
    guildId: "g",
    applicationId: "a",
    interactionToken: "t",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unknown_subcommand");
});

test("parseDiscordCommand は activate の target 欠落を弾く", () => {
  const r = parseDiscordCommand({
    subcommand: "activate",
    discordUserId: "u",
    channelId: "c",
    guildId: "g",
    applicationId: "a",
    interactionToken: "t",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "activate_missing_target");
});

test("parseDiscordCommand は activate の target を受理する", () => {
  const r = parseDiscordCommand({
    subcommand: "activate",
    target: "node-1",
    discordUserId: "u",
    channelId: "c",
    guildId: "g",
    applicationId: "a",
    interactionToken: "t",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.subcommand, "activate");
    assert.equal(r.target, "node-1");
  }
});

test("runDiscordCommandJob は共有 handler を呼び interaction webhook を PATCH する", async () => {
  const seen: SlashHandlerInput[] = [];
  const capture: { url?: string; method?: string; body?: string } = {};
  const result = await runDiscordCommandJob({
    payload: basePayload(),
    handlers: handlersReturning({ state: "succeeded", text: "done", detailUrl: "http://127.0.0.1:3000/reports" }, seen),
    fetchImpl: fakeResponseFetch(capture),
  });
  assert.equal(result.state, "succeeded");
  assert.equal(result.postedToResponseUrl, true);
  assert.equal(capture.method, "PATCH");
  assert.match(capture.url ?? "", /\/webhooks\/app1\/tok1\/messages\/@original$/);
  assert.match(capture.body ?? "", /done/);
  // handler は Discord の値を slack 形フィールドに載せ替えて受け取る
  assert.equal(seen[0]!.payload.slackUserId, "user1");
});

test("runDiscordCommandJob は handler の throw を catch して failed を返す (never throws)", async () => {
  const throwing: SlashCommandHandlers = {
    ...handlersReturning({ state: "succeeded", text: "x" }),
    report: async () => {
      throw new Error("handler boom");
    },
  };
  const result = await runDiscordCommandJob({
    payload: basePayload(),
    handlers: throwing,
    fetchImpl: fakeResponseFetch(),
  });
  assert.equal(result.state, "failed");
  assert.ok(result.handlerError?.includes("handler boom"));
});

test("runDiscordCommandJob は activate 成功で activate.via_discord を audit する", async () => {
  const captured: DiscordCommandAuditInput[] = [];
  const audit: DiscordCommandAuditWriter = {
    async recordSlashCommandExecution(input) {
      captured.push(input);
    },
  };
  await runDiscordCommandJob({
    payload: basePayload({ subcommand: "activate", target: "node-1" }),
    handlers: handlersReturning({ state: "succeeded", text: "activated" }),
    fetchImpl: fakeResponseFetch(),
    audit,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.action, "activate.via_discord");
  assert.equal(captured[0]!.actor, "discord:user1");
});

test("runDiscordCommandJob は audit writer の throw を飲み込む", async () => {
  const result = await runDiscordCommandJob({
    payload: basePayload(),
    handlers: handlersReturning({ state: "succeeded", text: "ok" }),
    fetchImpl: fakeResponseFetch(),
    audit: {
      async recordSlashCommandExecution() {
        throw new Error("audit boom");
      },
    },
  });
  assert.equal(result.state, "succeeded");
});
