// `@addroid/config` discord-notifications のユニットテスト。
// embed 描画と dispatcher (skipped/sent/failed/never-throws/audit/redact) を網羅する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscordNotificationMessage,
  dispatchDiscordNotification,
  type DiscordFetch,
  type DiscordNotificationAuditInput,
  type DiscordNotificationAuditWriter,
  type NotificationPayload,
} from "../index.js";

// 明示的なダミー (実トークンではない / secret scanning 回避のため非 Discord 形)。
const BOT_TOKEN = "FAKED1SCORDt0kenForTestsOnly.Ab1234.notARealSecretJustForUnitTests00";
const CHANNEL = "987654321098765432";

function fakeFetch(response: {
  ok?: boolean;
  status?: number;
  payload: unknown;
  capture?: { url?: string; body?: string; auth?: string };
}): DiscordFetch {
  return async (url, init) => {
    if (response.capture) {
      response.capture.url = url;
      response.capture.body = init.body;
      response.capture.auth = init.headers["Authorization"];
    }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.payload,
    };
  };
}

const prOpened: NotificationPayload = {
  kind: "pr.opened",
  data: {
    prNumber: 12,
    prTitle: "Improve CTR",
    prUrl: "https://github.com/acme/ops/pull/12",
    repoFullName: "acme/ops",
    adAccountKey: "main",
    riskLabel: "requires_approval",
    webApprovalsUrl: "http://127.0.0.1:3000/approvals/12",
  },
};

test("buildDiscordNotificationMessage は embed を 1 つ生成しタイトル/フィールドを持つ", () => {
  const msg = buildDiscordNotificationMessage(prOpened);
  assert.equal(msg.embeds.length, 1);
  const embed = msg.embeds[0]!;
  assert.match(embed.title ?? "", /GitHub PR/);
  assert.ok((embed.fields ?? []).some((f) => f.name === "PR" && f.value.includes("12")));
  assert.match(embed.description ?? "", /github\.com\/acme\/ops\/pull\/12/);
});

test("buildDiscordNotificationMessage は平文トークンを redact する", () => {
  const payload: NotificationPayload = {
    kind: "apply.failed",
    data: {
      applyJobId: "job1",
      adAccountKey: "main",
      errorMessage: `boom Bot ${BOT_TOKEN} leaked`,
    },
  };
  const msg = buildDiscordNotificationMessage(payload);
  const json = JSON.stringify(msg);
  assert.ok(!json.includes(BOT_TOKEN), "bot token must be redacted from embed");
  assert.match(json, /\[REDACTED\]/);
});

test("dispatchDiscordNotification は botToken/channel 未指定で skipped_no_discord", async () => {
  const r1 = await dispatchDiscordNotification(prOpened, { channelId: CHANNEL });
  assert.equal(r1.state, "skipped_no_discord");
  const r2 = await dispatchDiscordNotification(prOpened, { botToken: BOT_TOKEN });
  assert.equal(r2.state, "skipped_no_discord");
});

test("dispatchDiscordNotification は POST /channels/{id}/messages を Bot 認証で呼び sent を返す", async () => {
  const capture: { url?: string; auth?: string; body?: string } = {};
  const result = await dispatchDiscordNotification(prOpened, {
    botToken: BOT_TOKEN,
    channelId: CHANNEL,
    fetchImpl: fakeFetch({ payload: { id: "m1", channel_id: CHANNEL }, capture }),
  });
  assert.equal(result.state, "sent");
  assert.equal(result.messageId, "m1");
  assert.equal(capture.auth, `Bot ${BOT_TOKEN}`);
  assert.match(capture.url ?? "", /\/channels\/.*\/messages$/);
  assert.match(capture.body ?? "", /"embeds"/);
});

test("dispatchDiscordNotification は HTTP エラーを failed として返し throw しない", async () => {
  const result = await dispatchDiscordNotification(prOpened, {
    botToken: BOT_TOKEN,
    channelId: CHANNEL,
    fetchImpl: fakeFetch({ ok: false, status: 403, payload: { code: 50001, message: "Missing Access" } }),
  });
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "discord_50001");
});

test("dispatchDiscordNotification は network error を failed として返し例外伝播しない", async () => {
  const result = await dispatchDiscordNotification(prOpened, {
    botToken: BOT_TOKEN,
    channelId: CHANNEL,
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "network_error");
});

test("dispatchDiscordNotification は audit writer に sent + messageId を渡す", async () => {
  const captured: DiscordNotificationAuditInput[] = [];
  const audit: DiscordNotificationAuditWriter = {
    async recordNotificationDispatch(input) {
      captured.push(input);
    },
  };
  await dispatchDiscordNotification(prOpened, {
    botToken: BOT_TOKEN,
    channelId: CHANNEL,
    fetchImpl: fakeFetch({ payload: { id: "m2", channel_id: CHANNEL } }),
    audit,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.state, "sent");
  assert.equal(captured[0]!.discordMessageId, "m2");
});

test("dispatchDiscordNotification は audit writer が throw しても dispatch 結果を変えない", async () => {
  const result = await dispatchDiscordNotification(prOpened, {
    botToken: BOT_TOKEN,
    channelId: CHANNEL,
    fetchImpl: fakeFetch({ payload: { id: "m3", channel_id: CHANNEL } }),
    audit: {
      async recordNotificationDispatch() {
        throw new Error("audit boom");
      },
    },
  });
  assert.equal(result.state, "sent");
});
