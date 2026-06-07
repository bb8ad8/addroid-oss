// `@addroid/config` discord-auth のユニットテスト。fetch を注入できるため
// Discord に出ずに検証パスを網羅する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  DiscordApiError,
  DiscordTokenValidationError,
  getDiscordChannel,
  postDiscordMessage,
  validateDiscordInputs,
  verifyDiscordBotToken,
  type DiscordFetch,
} from "../index.js";

// 明示的なダミー (実トークンではない)。GitHub の Discord token パターン
// (先頭 M/N/O) に当たらない形にして secret scanning を避ける。
const VALID_TOKEN =
  "FAKED1SCORDt0kenForTestsOnly.Ab1234.notARealSecretJustForUnitTests00";
const GUILD = "123456789012345678";
const CHANNEL = "987654321098765432";

function fakeFetch(response: {
  ok?: boolean;
  status?: number;
  payload: unknown;
  capture?: { url?: string; method?: string; body?: string; auth?: string; ua?: string };
}): DiscordFetch {
  return async (url, init) => {
    if (response.capture) {
      response.capture.url = url;
      response.capture.method = init.method;
      response.capture.body = init.body;
      response.capture.auth = init.headers["Authorization"];
      response.capture.ua = init.headers["User-Agent"];
    }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.payload,
    };
  };
}

test("validateDiscordInputs は形式を検証し trim 済み値を返す", () => {
  const out = validateDiscordInputs({
    botToken: `  ${VALID_TOKEN}  `,
    guildId: ` ${GUILD} `,
    channelId: ` ${CHANNEL} `,
  });
  assert.equal(out.botToken, VALID_TOKEN);
  assert.equal(out.guildId, GUILD);
  assert.equal(out.channelId, CHANNEL);
});

test("validateDiscordInputs は欠落/不正値で DiscordTokenValidationError", () => {
  assert.throws(() => validateDiscordInputs({ guildId: GUILD, channelId: CHANNEL }), DiscordTokenValidationError);
  assert.throws(
    () => validateDiscordInputs({ botToken: VALID_TOKEN, guildId: "abc", channelId: CHANNEL }),
    (err: unknown) => err instanceof DiscordTokenValidationError && err.code === "invalid_guild_id"
  );
  assert.throws(
    () => validateDiscordInputs({ botToken: "not-a-token", guildId: GUILD, channelId: CHANNEL }),
    (err: unknown) => err instanceof DiscordTokenValidationError && err.code === "invalid_bot_token"
  );
});

test("verifyDiscordBotToken は /applications/@me を Bot 認証付きで呼び appId/bot を返す", async () => {
  const capture: { auth?: string; url?: string; ua?: string } = {};
  const app = await verifyDiscordBotToken(
    VALID_TOKEN,
    fakeFetch({
      payload: { id: "app123", name: "AdDroid Bot", flags: 0, bot: { id: "bot456", username: "addroid" } },
      capture,
    })
  );
  assert.equal(app.applicationId, "app123");
  assert.equal(app.botUserId, "bot456");
  assert.equal(app.botUsername, "addroid");
  assert.equal(capture.auth, `Bot ${VALID_TOKEN}`);
  assert.match(capture.url ?? "", /\/applications\/@me$/);
  assert.ok(capture.ua && capture.ua.length > 0);
});

test("verifyDiscordBotToken は HTTP 401 を DiscordApiError として投げる", async () => {
  await assert.rejects(
    () =>
      verifyDiscordBotToken(
        VALID_TOKEN,
        fakeFetch({ ok: false, status: 401, payload: { code: 0, message: "401: Unauthorized" } })
      ),
    (err: unknown) => err instanceof DiscordApiError && err.status === 401
  );
});

test("getDiscordChannel は channel + guild_id を返す", async () => {
  const channel = await getDiscordChannel(
    VALID_TOKEN,
    CHANNEL,
    fakeFetch({ payload: { id: CHANNEL, type: 0, name: "ops", guild_id: GUILD } })
  );
  assert.equal(channel.id, CHANNEL);
  assert.equal(channel.name, "ops");
  assert.equal(channel.guildId, GUILD);
});

test("getDiscordChannel は Missing Access(50001) を DiscordApiError に code 付きで写す", async () => {
  await assert.rejects(
    () =>
      getDiscordChannel(
        VALID_TOKEN,
        CHANNEL,
        fakeFetch({ ok: false, status: 403, payload: { code: 50001, message: "Missing Access" } })
      ),
    (err: unknown) => err instanceof DiscordApiError && err.discordCode === 50001
  );
});

test("postDiscordMessage は content を Bot 認証で POST し message id を返す", async () => {
  const capture: { method?: string; body?: string; auth?: string; url?: string } = {};
  const res = await postDiscordMessage(VALID_TOKEN, CHANNEL, "hello", {
    fetchImpl: fakeFetch({ payload: { id: "msg789", channel_id: CHANNEL }, capture }),
  });
  assert.equal(res.id, "msg789");
  assert.equal(res.channelId, CHANNEL);
  assert.equal(capture.method, "POST");
  assert.equal(capture.auth, `Bot ${VALID_TOKEN}`);
  assert.match(capture.url ?? "", /\/channels\/.*\/messages$/);
  assert.match(capture.body ?? "", /"content":"hello"/);
});
