// #3844: apply_job 失敗時に execution_logs.payload から Meta エラー詳細
// (code / error_subcode / message) を DB 直読なしで抜き出せることを確認する。
// フィクスチャは実データ (execution_logs, kind=apply, level=warn) の payload
// 構造を反映している (packages/queue/src/apply-executor.ts が書く形)。

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMetaErrorSummary,
  formatMetaErrorLine,
  maskSecretsDeep,
} from "../lib/apply-errors.js";

const REAL_SHAPE_PAYLOAD = {
  account: "act_1119490772506479",
  attempt: 1,
  executor: {
    mode: "graph",
    verb: "create",
    binary: "meta-graph-api",
    stderr: "Application does not have permission for this action",
    stdout: "",
    exitCode: 400,
    response: {
      error: {
        code: 10,
        type: "OAuthException",
        message: "Application does not have permission for this action",
        error_data:
          '{"actor_id":61568541057447,"ad_account_id":1119490772506479,"page_id":443354308869171,"required_permission":"Ads"}',
        fbtrace_id: "A8RSTjHIocsrBq8G5tFC1wz",
        is_transient: false,
        error_subcode: 1341012,
        error_user_msg: "このプロフィールへの必要なアクセス権限がありません",
        error_user_title: "このプロフィールへのアクセス権限がありません",
      },
    },
    exitClass: "api_error",
  },
};

test("extractMetaErrorSummary reads code/error_subcode/message from payload.executor.response.error", () => {
  const summary = extractMetaErrorSummary(REAL_SHAPE_PAYLOAD);
  assert.ok(summary, "expected a summary");
  assert.equal(summary?.code, 10);
  assert.equal(summary?.errorSubcode, 1341012);
  assert.equal(summary?.message, "Application does not have permission for this action");
});

test("formatMetaErrorLine renders a single-line summary", () => {
  const line = formatMetaErrorLine({
    code: 10,
    errorSubcode: 1341012,
    message: "Application does not have permission for this action",
  });
  assert.equal(
    line,
    "code=10 subcode=1341012 — Application does not have permission for this action"
  );
});

test("formatMetaErrorLine omits code/subcode when absent", () => {
  const line = formatMetaErrorLine({ message: "executor threw: boom" });
  assert.equal(line, "executor threw: boom");
});

test("extractMetaErrorSummary falls back to executor.message when no structured error", () => {
  const summary = extractMetaErrorSummary({ executor: { message: "spawn ENOENT" } });
  assert.ok(summary);
  assert.equal(summary?.message, "spawn ENOENT");
  assert.equal(summary?.code, undefined);
});

test("extractMetaErrorSummary returns null for unrelated / malformed payloads", () => {
  assert.equal(extractMetaErrorSummary(null), null);
  assert.equal(extractMetaErrorSummary("not an object"), null);
  assert.equal(extractMetaErrorSummary({ foo: "bar" }), null);
  assert.equal(extractMetaErrorSummary({ executor: { response: {} } }), null);
});

test("maskSecretsDeep redacts secret-like keys and Bearer/DB-url patterns in strings", () => {
  const input = {
    accessToken: "abcdefgh12345",
    nested: { apiKey: "sk-live-xxxxxxxx", note: "ok" },
    message: "auth header was Bearer abcdef123456 during connect",
    dbUrl: "postgres://user:pass@host:5432/db",
    safe: "keep this",
  };
  const masked = maskSecretsDeep(input) as Record<string, unknown>;
  assert.equal(masked.accessToken, "[REDACTED]");
  assert.equal((masked.nested as Record<string, unknown>).apiKey, "[REDACTED]");
  assert.equal((masked.nested as Record<string, unknown>).note, "ok");
  assert.match(masked.message as string, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(masked.message as string, /abcdef123456/);
  assert.match(masked.dbUrl as string, /\[REDACTED\]/);
  assert.doesNotMatch(masked.dbUrl as string, /pass@host/);
  assert.equal(masked.safe, "keep this");
});

test("maskSecretsDeep redacts real execution_logs fixture without throwing", () => {
  const masked = JSON.stringify(maskSecretsDeep(REAL_SHAPE_PAYLOAD));
  assert.doesNotMatch(masked, /Bearer\s+[A-Za-z0-9._-]{8,}/);
  // message/error_user_msg content (non-secret business text) survives.
  assert.match(masked, /Application does not have permission for this action/);
});
