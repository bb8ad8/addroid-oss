// AdDroid OSS — execute_apply の MetaCliRunner 接続テスト (regression fix).
//
// 目的: gate review が指摘した「execute_apply が MetaCliRunner / toExecutionLogInput
// を経由せず execution_logs に sanitized Meta CLI 出力を保存していない」状態を再発
// させないために、production 経路 (`CliApplyExecutor` + `MetaCliRunner` +
// `toExecutionLogInput`) を end-to-end で検証する。
//
// spawn は実プロセスではなく EventEmitter ベースの fake に差し替える。token は
// 環境変数注入のみで CLI に渡されること、stdout/stderr は token-redacted で
// `logPayload` に乗ること、exit class が ExecuteActionResult.status と
// recommendedAction にマップされることを確認する。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import type {
  MetaAccessTokenLease,
  MetaAdAccount,
  MetaAdapter,
  MetaBeginOAuthResult,
  MetaBusiness,
  MetaOAuthConnection,
  MetaRefreshResult,
} from "@addroid/meta-adapter";
import { MetaCliRunner, MetaTokenExpiredError } from "@addroid/meta-adapter";
import { LocalDiskStorage } from "@addroid/config";
import type { ApplyAction, ApplyJobContext } from "@addroid/queue";

type CreateCampaignAction = ApplyAction & { kind: "create_campaign" };

import {
  CliApplyExecutor,
  FailClosedApplyExecutor,
  GraphApplyExecutor,
  MockApplyExecutor,
  extractExternalIdFromCliStdout,
  resolveApplyExecutor,
} from "../apply-meta-executor.js";

// ---------------------------------------------------------------------
// fake spawn (cli-runner.test.ts と同じパターン)
// ---------------------------------------------------------------------

interface SpawnLog {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

interface ScriptedRun {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  delayMs?: number;
}

class FakeChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  killed = false;

  constructor() {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function makeSpawn(scripts: ScriptedRun[], log: SpawnLog[]) {
  return ((
    cmd: string,
    args?: readonly string[],
    opts?: Record<string, unknown>,
  ) => {
    log.push({
      command: cmd,
      args: args ? Array.from(args) : [],
      options: (opts ?? {}) as Record<string, unknown>,
    });
    const child = new FakeChildProcess();
    const script = scripts.shift();
    if (!script) throw new Error("fake spawn: no scripted run remaining");
    const delay = script.delayMs ?? 1;
    setTimeout(() => {
      if (script.stdout) child.stdout.push(Buffer.from(script.stdout, "utf8"));
      if (script.stderr) child.stderr.push(Buffer.from(script.stderr, "utf8"));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", script.exitCode, script.signal ?? null);
    }, delay);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

// ---------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------

const TOKEN = "EAA-test-token-1234567890ABCDEFGHIJ";
const META_ADAPTER: MetaAdapter = {
  beginOAuth: async (): Promise<MetaBeginOAuthResult> => ({
    authorizationUrl: "",
    state: "",
  }),
  completeOAuth: async (): Promise<MetaOAuthConnection> => {
    throw new Error("not used");
  },
  refreshLongLivedToken: async (): Promise<MetaRefreshResult> => {
    throw new Error("not used");
  },
  loadAccessTokenPlaintext: async (): Promise<MetaAccessTokenLease> => ({
    accessToken: TOKEN,
    scopes: [],
    expiresAt: null,
    accountIdentifier: "test",
  }),
  fetchBusinesses: async (): Promise<MetaBusiness[]> => [],
  fetchAdAccounts: async (): Promise<MetaAdAccount[]> => [],
};

function ctx(overrides: Partial<ApplyJobContext> = {}): ApplyJobContext {
  return {
    applyJobId: "apply-1",
    pullRequestId: "pr-row-1",
    prNumber: 17,
    headSha: "deadbeefcafebabe",
    htmlUrl: "https://github.example/owner/repo/pull/17",
    repoId: "repo-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// regression fix: shared canonical pre-spawn payload assertion
// ---------------------------------------------------------------------
//
// 仕様: pre-spawn 失敗 (CLI 未設定 / version 未検証 / token 欠落) でも
// spawned 実行と同じ command-evidence shape (stdout/stderr/exitCode/signal/
// timestamps/durationMs/timedOut/throttleHeaders/exitClass/recommendedAction)
// を logPayload に含めること。null/empty/zero 値で正規化される。
function assertCanonicalPreSpawnEnvelope(
  payload: Record<string, unknown>,
  expected: {
    exitClass: "auth_error" | "unknown_error";
    stderrIncludes?: string;
    accountKey: string;
  },
) {
  assert.equal(payload.exitClass, expected.exitClass);
  assert.equal(payload.exitCode, null, "pre-spawn exitCode must be null");
  assert.equal(payload.signal, null, "pre-spawn signal must be null");
  assert.equal(payload.stdout, "", "pre-spawn stdout must be empty");
  assert.equal(
    typeof payload.stderr,
    "string",
    "pre-spawn stderr must be string",
  );
  if (expected.stderrIncludes !== undefined) {
    assert.ok(
      (payload.stderr as string).includes(expected.stderrIncludes),
      `pre-spawn stderr should mention "${expected.stderrIncludes}"`,
    );
  }
  assert.equal(payload.timedOut, false, "pre-spawn timedOut must be false");
  assert.equal(payload.durationMs, 0, "pre-spawn durationMs must be 0");
  assert.equal(typeof payload.startedAt, "string");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(
    payload.throttleHeaders,
    null,
    "pre-spawn throttleHeaders must be null",
  );
  assert.ok(
    payload.recommendedAction && typeof payload.recommendedAction === "object",
    "pre-spawn recommendedAction must be present",
  );
  assert.equal(payload.accountKey, expected.accountKey);
}

function createCampaignAction(): CreateCampaignAction {
  return {
    kind: "create_campaign",
    account: "primary",
    campaignId: "cmp-fall",
    name: "Fall",
    objective: "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: { dailyBudget: 50 },
  };
}

function makeRunner(scripts: ScriptedRun[], log: SpawnLog[]): MetaCliRunner {
  return new MetaCliRunner({
    binaryPath: "/usr/local/bin/meta-ads-cli",
    spawnImpl: makeSpawn(scripts, log),
    loadTokenForAccount: async () => ({ accessToken: TOKEN }),
    baseEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
  });
}

// ---------------------------------------------------------------------
// CliApplyExecutor — success path uses MetaCliRunner.run + toExecutionLogInput
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: success uses MetaCliRunner.run and toExecutionLogInput payload", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  // 1) status mapping: success → "success"
  assert.equal(result.status, "success");

  // 2) sanitized command/args appear in logPayload (proof toExecutionLogInput
  //    の payload を logPayload にしている)
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.exitClass, "success");
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.accountKey, "primary");
  assert.equal(payload.binary, "/usr/local/bin/meta-ads-cli");
  assert.equal(typeof payload.sanitizedCommand, "string");
  assert.ok(
    (payload.sanitizedCommand as string).startsWith(
      "/usr/local/bin/meta-ads-cli ads campaign create",
    ),
    "sanitizedCommand should start with binary + resource verb",
  );
  assert.ok(Array.isArray(payload.sanitizedArgs));
  const sanitizedArgs = payload.sanitizedArgs as string[];
  assert.equal(sanitizedArgs[0], "ads");
  assert.equal(sanitizedArgs[1], "campaign");
  assert.equal(sanitizedArgs[2], "create");

  // 3) recommendedAction (regression fix 由来) も persisted されている
  const rec = payload.recommendedAction as Record<string, unknown>;
  assert.equal(rec.kind, "none");
  assert.equal(rec.retry, false);
  assert.equal(rec.logLevel, "info");

  // 4) timing fields are present
  assert.equal(typeof payload.startedAt, "string");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(typeof payload.durationMs, "number");

  // 5) refType / refId は logPayload には乗らない (ExecuteActionResult が
  //    保持する情報。orchestrator が apply_job に紐付けて execution_logs に書く)
  //    が、最低限 toExecutionLogInput が呼ばれた証拠として `binary`/`accountKey`
  //    が存在することは上で確認済み。

  // 6) spawn invocation: token は argv に乗らず env のみ
  assert.equal(log.length, 1);
  const firstSpawn = log[0]!;
  assert.equal(firstSpawn.command, "/usr/local/bin/meta-ads-cli");
  assert.ok(
    !firstSpawn.args.some((a) => a.includes(TOKEN)),
    "access token must not appear in argv",
  );
  const spawnedEnv =
    (firstSpawn.options as { env?: Record<string, string> }).env ?? {};
  assert.equal(spawnedEnv.ACCESS_TOKEN, TOKEN);
  assert.equal(spawnedEnv.AD_ACCOUNT_ID, "primary");
  assert.equal(spawnedEnv.META_ACCESS_TOKEN, undefined);
  assert.equal(spawnedEnv.META_PRIMARY_ACCESS_TOKEN, undefined);
});

test("CliApplyExecutor.executeAction: converts budgets using the ad account currency minor unit", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([{ stdout: "ok\n", stderr: "", exitCode: 0 }], log);
  const executor = new CliApplyExecutor({
    runner,
    metaAdapter: META_ADAPTER,
    resolveAdAccountCurrency: async () => "JPY",
  });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "success");
  const args = log[0]!.args;
  assert.equal(args[args.indexOf("--daily-budget") + 1], "50");
});

// regression fix: create_* success は CLI stdout から external_id を抽出して
// ExecuteActionResult.externalId に乗せる。これがないと queue 側 runExecuteApply
// が「create_* success なのに externalId 不在」として fail-closed する。

test("CliApplyExecutor.executeAction: create_campaign success extracts externalId from JSON stdout", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        // Meta Graph API style response (CLI が POST レスポンスを stdout に流す想定)
        stdout: '{"id":"act_1/cmp_42","name":"Fall"}\n',
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "success");
  assert.equal(result.externalId, "act_1/cmp_42");
});

test("CliApplyExecutor.executeAction: create_adset success extracts numeric id field", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: '{"id":1234567890,"name":"AdSet"}\n',
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: {
      kind: "create_adset",
      account: "primary",
      campaignId: "cmp-fall",
      adsetId: "as-jp",
      name: "JP",
      initialState: "paused",
      targeting: { countries: ["JP"], interests: [], customAudiences: [] },
    },
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "success");
  assert.equal(result.externalId, "1234567890");
});

test("CliApplyExecutor.executeAction: create_* success without parseable id leaves externalId undefined", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  // status は success のまま — fail-closed は queue 側 runExecuteApply の責務。
  assert.equal(result.status, "success");
  assert.equal(result.externalId, undefined);
});

// ---------------------------------------------------------------------
// CliApplyExecutor — auth_error → "auth_error" + reauth recommendation
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: auth_error maps status and surfaces reauth recommendation in logPayload", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr:
          '{"error":{"message":"Error validating access token","code":190}}',
        exitCode: 2,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "auth_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.exitClass, "auth_error");
  const rec = payload.recommendedAction as Record<string, unknown>;
  assert.equal(rec.kind, "notify_reauth");
  assert.equal(rec.auditAction, "oauth.meta.reauth_required");
  // retry hint must NOT be set for auth_error
  assert.equal(result.retry, undefined);
  // regression fix: production caller drives notification audit off the
  // recommendedAction by exposing `notify` on ExecuteActionResult.
  assert.ok(
    result.notify,
    "auth_error must expose a notify hint for the orchestrator",
  );
  assert.equal(result.notify!.auditAction, "oauth.meta.reauth_required");
});

// ---------------------------------------------------------------------
// CliApplyExecutor — api_error → "api_error" + notify hint (regression fix)
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: api_error maps to api_error status with meta.api_error notify hint", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr:
          '{"error":{"message":"Invalid parameter","type":"GraphMethodException","code":100,"fbtrace_id":"abc"}}',
        exitCode: 5,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "api_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.exitClass, "api_error");
  const rec = payload.recommendedAction as Record<string, unknown>;
  assert.equal(rec.kind, "notify_api_error");
  assert.equal(rec.auditAction, "meta.api_error");

  // production caller must NOT retry api_error — the notification path runs instead.
  assert.equal(result.retry, undefined);
  assert.ok(
    result.notify,
    "api_error must expose a notify hint for the orchestrator",
  );
  assert.equal(result.notify!.auditAction, "meta.api_error");
});

// ---------------------------------------------------------------------
// CliApplyExecutor — unknown_error notify hint (regression fix)
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: unknown_error attaches meta.cli_unknown_error notify hint", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr: "segfault",
        exitCode: 139,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "unknown_error");
  assert.equal(result.retry, undefined);
  assert.ok(
    result.notify,
    "unknown_error must expose a notify hint for the orchestrator",
  );
  assert.equal(result.notify!.auditAction, "meta.cli_unknown_error");
});

// ---------------------------------------------------------------------
// CliApplyExecutor — rate_limit_error → "rate_limit_error" + retry hint
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: rate_limit_error attaches exponential backoff retry hint", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: "",
        stderr: '{"error":{"message":"User request limit reached","code":17}}',
        exitCode: 3,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 1, // 2 回目の試行 (前回の attempt=0 の後)
  });

  assert.equal(result.status, "rate_limit_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.exitClass, "rate_limit_error");

  // retry hint: exponential backoff (initial * 2^attempt, clamped to maxBackoff)
  assert.ok(result.retry, "retry hint must be set for rate_limit_error");
  assert.equal(result.retry!.maxAttempts, 3);
  // attempt=1 → 5_000 * 2^1 = 10_000 ms (under 60_000 cap)
  assert.equal(result.retry!.delayMs, 10_000);
});

test("CliApplyExecutor.executeAction: create_creative uses Graph instagram_user_id and rewrites following ad creativeRef", async () => {
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "addroid-creative-test-"),
  );
  const prevAddroidHome = process.env.ADDROID_HOME;
  process.env.ADDROID_HOME = tmp;
  const storageKey =
    "creative-submissions/act_786887980003986/cr-1/creative.png";
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  try {
    await new LocalDiskStorage({ env: process.env }).write(
      storageKey,
      Buffer.from("not-a-real-png"),
    );
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body });
      if (url.includes("/instagram_accounts")) {
        return Response.json({
          data: [{ id: "17841465387326763", username: "sin" }],
        });
      }
      if (url.includes("/281900655012835?")) {
        return Response.json(
          {
            error: {
              code: 200,
              message: "page role not readable in this token",
            },
          },
          { status: 403 },
        );
      }
      if (url.includes("/adsets?")) {
        return Response.json({
          data: [
            { id: "as-1", promoted_object: { page_id: "281900655012835" } },
          ],
        });
      }
      if (url.includes("/adimages")) {
        return Response.json({
          images: { "creative.png": { hash: "img-hash-1" } },
        });
      }
      if (url.includes("/adcreatives")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const spec = JSON.parse(
          params.get("object_story_spec") ?? "{}",
        ) as Record<string, unknown>;
        const linkData = spec.link_data as Record<string, unknown>;
        const cta = linkData.call_to_action as Record<string, unknown>;
        const ctaValue = cta.value as Record<string, unknown>;
        assert.equal(spec.instagram_user_id, "17841465387326763");
        assert.equal(
          Object.prototype.hasOwnProperty.call(spec, "instagram_actor_id"),
          false,
        );
        assert.equal(cta.type, "VIEW_INSTAGRAM_PROFILE");
        assert.equal(
          ctaValue.app_link,
          "instagram://user?username=sin&userid=65414107577",
        );
        return Response.json({ id: "999000111222333" });
      }
      return Response.json(
        { error: { code: 100, message: "unexpected" } },
        { status: 400 },
      );
    }) as typeof fetch;

    const log: SpawnLog[] = [];
    const runner = makeRunner(
      [{ stdout: '{"id":"1200000000001"}\n', stderr: "", exitCode: 0 }],
      log,
    );
    const executor = new CliApplyExecutor({
      runner,
      metaAdapter: META_ADAPTER,
      resolveAdAccountId: async () => "act_786887980003986",
    });
    const creative = await executor.executeAction({
      action: {
        kind: "create_creative",
        account: "act_786887980003986",
        creativeId: "cr-1",
        name: "Creative 1",
        mediaType: "image",
        pageId: "281900655012835",
        linkUrl: "https://example.com",
        primaryText: "body",
        headline: "headline",
        callToAction: "VIEW_INSTAGRAM_PROFILE",
        instagramUserId: "17841465387326763",
        instagramAppLink: "instagram://user?username=sin&userid=65414107577",
        storageKey,
      },
      context: ctx(),
      attempt: 0,
    });
    assert.equal(creative.status, "success");
    assert.equal(creative.externalId, "999000111222333");
    const creativePayload = creative.logPayload as Record<string, unknown>;
    assert.deepEqual(
      (creativePayload.sanitizedArgs as string[]).filter((arg) =>
        arg.startsWith("--instagram-"),
      ),
      ["--instagram-actor-id"],
    );
    assert.equal(
      log.length,
      0,
      "create_creative should not spawn the legacy CLI",
    );

    const ad = await executor.executeAction({
      action: {
        kind: "create_ad",
        account: "act_786887980003986",
        campaignId: "cmp-1",
        adsetId: "as-1",
        adId: "ad-1",
        name: "Ad 1",
        creativeRef: "cr-1",
        initialState: "paused",
      },
      context: ctx(),
      attempt: 0,
    });
    assert.equal(ad.status, "success");
    assert.equal(log.length, 1);
    const creativeFlagIndex = log[0]!.args.indexOf("--creative-id");
    assert.deepEqual(
      log[0]!.args.slice(creativeFlagIndex, creativeFlagIndex + 2),
      ["--creative-id", "999000111222333"],
    );
    assert.ok(calls.some((call) => call.url.includes("/adcreatives")));
  } finally {
    globalThis.fetch = originalFetch;
    if (prevAddroidHome === undefined) delete process.env.ADDROID_HOME;
    else process.env.ADDROID_HOME = prevAddroidHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("CliApplyExecutor.executeAction: create_creative rejects absolute storageKey before upload", async () => {
  const originalFetch = globalThis.fetch;
  const log: SpawnLog[] = [];
  try {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called for invalid storageKey");
    }) as typeof fetch;
    const runner = makeRunner([], log);
    const executor = new CliApplyExecutor({
      runner,
      metaAdapter: META_ADAPTER,
      resolveAdAccountId: async () => "act_786887980003986",
    });
    const result = await executor.executeAction({
      action: {
        kind: "create_creative",
        account: "act_786887980003986",
        creativeId: "cr-absolute",
        name: "Creative absolute",
        mediaType: "image",
        pageId: "281900655012835",
        linkUrl: "https://example.com",
        storageKey: "/tmp/creative.png",
      },
      context: ctx(),
      attempt: 0,
    });

    assert.equal(result.status, "api_error");
    assert.equal(
      log.length,
      0,
      "invalid storageKey must not spawn the legacy CLI",
    );
    const payload = result.logPayload as Record<string, unknown>;
    assert.equal(payload.stage, "plan_args");
    assert.equal(payload.reason, "invalid_storage_key");
    assert.equal(payload.actionKind, "create_creative");
    assert.ok(
      result.notify,
      "invalid storageKey should notify as a Meta API input error",
    );
    assert.equal(result.notify!.auditAction, "meta.api_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CliApplyExecutor.executeAction: meta_cli_operation uses canonical instagram actor flag", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [{ stdout: '{"id":"999000111222333"}\n', stderr: "", exitCode: 0 }],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });

  const result = await executor.executeAction({
    action: {
      kind: "meta_cli_operation",
      account: "act_786887980003986",
      resource: "creatives",
      verb: "create",
      args: [
        "ads",
        "creative",
        "create",
        "--name",
        "Creative 1",
        "--page-id",
        "281900655012835",
        "--image",
        "creative-submissions/act_786887980003986/cr-1/creative.png",
        "--instagram-actor-id",
        "17841465387326763",
      ],
      entity: {
        nodeType: "creative",
        nodeKey: "cr-1",
      },
      externalIdRequired: true,
    },
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "success");
  assert.equal(result.externalId, "999000111222333");
  assert.equal(log.length, 1);
  assert.ok(log[0]!.args.includes("--instagram-actor-id"));
  assert.ok(!log[0]!.args.includes("--instagram-user-id"));
});

test("CliApplyExecutor.executeAction: meta_cli_operation rejects absolute media flags before spawn", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([], log);
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });

  const result = await executor.executeAction({
    action: {
      kind: "meta_cli_operation",
      account: "act_786887980003986",
      resource: "creatives",
      verb: "create",
      args: ["ads", "creative", "create", "--image", "/tmp/creative.png"],
    },
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "api_error");
  assert.equal(
    log.length,
    0,
    "invalid media flag must not spawn the legacy CLI",
  );
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.reason, "invalid_storage_key");
  assert.equal(payload.actionKind, "meta_cli_operation");
});

// ---------------------------------------------------------------------
// CliApplyExecutor — unsupported action kind is fail-closed (skipped)
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: unsupported action kind is skipped without spawning CLI", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner([], log); // no scripted runs — must not be invoked
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });

  const unsupportedPseudoAction = {
    kind: "create_experiment",
    account: "primary",
    experimentId: "exp-x",
    campaignId: "cmp-x",
    name: "experiment",
    variants: [],
  } as unknown as ApplyAction;

  const result = await executor.executeAction({
    action: unsupportedPseudoAction,
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "skipped");
  assert.equal(log.length, 0, "must not spawn CLI for unsupported action kind");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.reason, "unsupported_action");
  assert.equal(payload.actionKind, "create_experiment");
});

// ---------------------------------------------------------------------
// CliApplyExecutor — token never leaks into logPayload even if CLI echoes it
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: tokens echoed by CLI are redacted in logPayload", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        // CLI が誤って token を出力した場合でも logPayload は redacted で永続化される
        stdout: `created campaign with token ${TOKEN}\n`,
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  const payload = result.logPayload as Record<string, unknown>;
  const stdout = payload.stdout as string;
  assert.ok(
    !stdout.includes(TOKEN),
    "raw token must never appear in logPayload.stdout",
  );
  assert.ok(stdout.includes("[REDACTED]"), "stdout should be redacted");
  assert.ok(
    !(payload.sanitizedCommand as string).includes(TOKEN),
    "sanitizedCommand must never include token",
  );
});

// ---------------------------------------------------------------------
// MockApplyExecutor — used when CLI bin / token unavailable
// ---------------------------------------------------------------------

test("MockApplyExecutor: returns success with sanitized mock command in logPayload", async () => {
  const executor = new MockApplyExecutor();
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "success");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.mode, "mock");
  assert.equal(payload.resource, "campaigns");
  assert.equal(payload.verb, "create");
  assert.ok(typeof payload.sanitizedCommand === "string");
  assert.ok(
    (payload.sanitizedCommand as string).startsWith(
      "meta-ads-cli ads campaign create",
    ),
  );
});

// regression fix: MockApplyExecutor は create_* に対して決定的な mocked
// external_id を返さなければならない。これがないと local-test simulation で
// PAUSED ads_hierarchy 行が externalId=null で挿入され、後続 Activate が
// 永久に拒否されて mocked equivalent としての受入要件を満たさなくなる。

test("MockApplyExecutor: create_campaign success surfaces a deterministic mocked externalId", async () => {
  const executor = new MockApplyExecutor();
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });

  assert.equal(result.status, "success");
  assert.equal(typeof result.externalId, "string");
  assert.ok(
    (result.externalId ?? "").length > 0,
    "create_* mock must surface a non-empty externalId",
  );
  // 同じ action で 2 回呼んでも同じ id を返す (決定的)。
  const again = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(again.externalId, result.externalId);
});

test("MockApplyExecutor: create_adset / create_ad / create_creative all surface deterministic mocked externalIds", async () => {
  const executor = new MockApplyExecutor();
  const adsetResult = await executor.executeAction({
    action: {
      kind: "create_adset",
      account: "primary",
      campaignId: "cmp-fall",
      adsetId: "as-jp",
      name: "JP",
      initialState: "paused",
      targeting: { countries: ["JP"], interests: [], customAudiences: [] },
    },
    context: ctx(),
    attempt: 0,
  });
  assert.equal(adsetResult.status, "success");
  assert.ok(
    nonEmpty(adsetResult.externalId),
    "create_adset mock must surface a non-empty externalId",
  );

  const adResult = await executor.executeAction({
    action: {
      kind: "create_ad",
      account: "primary",
      campaignId: "cmp-fall",
      adsetId: "as-jp",
      adId: "ad-banner",
      name: "Banner",
      creativeRef: "cr-1",
      initialState: "paused",
    },
    context: ctx(),
    attempt: 0,
  });
  assert.equal(adResult.status, "success");
  assert.ok(
    nonEmpty(adResult.externalId),
    "create_ad mock must surface a non-empty externalId",
  );

  const creativeResult = await executor.executeAction({
    action: {
      kind: "create_creative",
      account: "primary",
      creativeId: "cr-1",
      name: "Creative 1",
      mediaType: "image",
    },
    context: ctx(),
    attempt: 0,
  });
  assert.equal(creativeResult.status, "success");
  assert.ok(
    nonEmpty(creativeResult.externalId),
    "create_creative mock surfaces an externalId for observability",
  );
});

function nonEmpty(s: string | undefined): boolean {
  return typeof s === "string" && s.length > 0;
}

// ---------------------------------------------------------------------
// extractExternalIdFromCliStdout — boundary / robustness tests
// ---------------------------------------------------------------------

test("extractExternalIdFromCliStdout: extracts id field from a single-line JSON object", () => {
  assert.equal(
    extractExternalIdFromCliStdout('{"id":"act_1/cmp_42"}\n'),
    "act_1/cmp_42",
  );
});

test("extractExternalIdFromCliStdout: extracts numeric id field as string", () => {
  assert.equal(
    extractExternalIdFromCliStdout('{"id":1234567890}\n'),
    "1234567890",
  );
});

test("extractExternalIdFromCliStdout: prefers externalId over id when both are present", () => {
  assert.equal(
    extractExternalIdFromCliStdout('{"externalId":"ext_1","id":"raw_1"}\n'),
    "ext_1",
  );
});

test("extractExternalIdFromCliStdout: scans line-by-line when stdout has multi-line JSON-Lines", () => {
  const stdout =
    "INFO created object\n" +
    '{"id":"act_1/cmp_42","name":"Fall"}\n' +
    "INFO done\n";
  assert.equal(extractExternalIdFromCliStdout(stdout), "act_1/cmp_42");
});

test('extractExternalIdFromCliStdout: regex fallback recognizes "id":"..." inside non-JSON text', () => {
  const stdout = 'created campaign with "id":"act_1/cmp_42" successfully\n';
  assert.equal(extractExternalIdFromCliStdout(stdout), "act_1/cmp_42");
});

test("extractExternalIdFromCliStdout: extracts id from Meta CLI table stdout", () => {
  const stdout = "ID                \n------------------\n120244589795090756\n";
  assert.equal(extractExternalIdFromCliStdout(stdout), "120244589795090756");
});

test("extractExternalIdFromCliStdout: empty / non-id stdout yields undefined (caller fails closed)", () => {
  assert.equal(extractExternalIdFromCliStdout(""), undefined);
  assert.equal(extractExternalIdFromCliStdout("\n\n"), undefined);
  assert.equal(extractExternalIdFromCliStdout("ok\n"), undefined);
  assert.equal(
    extractExternalIdFromCliStdout('{"name":"no id here"}\n'),
    undefined,
  );
});

test("MockApplyExecutor: skipped for unsupported action kinds", async () => {
  const executor = new MockApplyExecutor();
  const unsupportedPseudoAction = {
    kind: "create_experiment",
    account: "primary",
    experimentId: "exp-x",
    campaignId: "cmp-x",
    name: "experiment",
    variants: [],
  } as unknown as ApplyAction;
  const result = await executor.executeAction({
    action: unsupportedPseudoAction,
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "skipped");
});

// ---------------------------------------------------------------------
// resolveApplyExecutor — env + Meta OAuth state による分岐
// ---------------------------------------------------------------------

class FakeMetaAdapter implements MetaAdapter {
  constructor(private readonly lease: MetaAccessTokenLease | null) {}

  async beginOAuth(): Promise<MetaBeginOAuthResult> {
    throw new Error("not used");
  }
  async completeOAuth(): Promise<MetaOAuthConnection> {
    throw new Error("not used");
  }
  async refreshLongLivedToken(): Promise<MetaRefreshResult> {
    throw new Error("not used");
  }
  async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
    return this.lease;
  }
  async fetchBusinesses(): Promise<MetaBusiness[]> {
    return [];
  }
  async fetchAdAccounts(): Promise<MetaAdAccount[]> {
    return [];
  }
}

async function makeDiagnosticCliExecutor(
  opts: {
    lease?: MetaAccessTokenLease | null;
    versionResolver?: () => Promise<string>;
  } = {},
): Promise<CliApplyExecutor> {
  const runner = new MetaCliRunner({
    binaryPath: "/usr/local/bin/meta-ads-cli",
    spawnImpl: makeSpawn([], []),
    loadTokenForAccount: async () =>
      opts.lease === null
        ? null
        : { accessToken: opts.lease?.accessToken ?? TOKEN },
    baseEnv: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    minVersion: "0.5.0",
    versionResolver: opts.versionResolver ?? (async () => "meta-ads-cli 0.5.0"),
    requireVerifiedVersion: true,
  });
  await runner.verifyVersion();
  return new CliApplyExecutor({
    runner,
    metaAdapter: new FakeMetaAdapter(
      opts.lease ?? {
        accessToken: TOKEN,
        scopes: ["ads_management"],
        expiresAt: null,
        accountIdentifier: "primary",
      },
    ),
  });
}

// regression fix: CLI 未設定で `ADDROID_META_ADS_CLI_MOCK=1` を明示的に立てた
// 「local-test simulation」要求のときだけ MockApplyExecutor を選ぶ。

test("resolveApplyExecutor: ADDROID_META_CLI_BIN unset + ADDROID_META_ADS_CLI_MOCK=1 → MockApplyExecutor", async () => {
  const sel = await resolveApplyExecutor({
    env: { ADDROID_META_ADS_CLI_MOCK: "1" } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
  });
  assert.equal(sel.mode, "mock");
  assert.ok(sel.executor instanceof MockApplyExecutor);
  assert.match(sel.reason, /ADDROID_META_ADS_CLI_MOCK=1/);
});

test("resolveApplyExecutor: ADDROID_META_CLI_BIN unset and no MOCK flag → GraphApplyExecutor", async () => {
  const sel = await resolveApplyExecutor({
    env: {} as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
  });
  assert.equal(sel.mode, "graph");
  assert.ok(sel.executor instanceof GraphApplyExecutor);
  assert.ok(!(sel.executor instanceof MockApplyExecutor));
  assert.match(sel.reason, /Graph API/);
  assert.equal(sel.versionVerification, undefined);
});

test("GraphApplyExecutor passes graphPayload through, resolves nested refs, and drops protected fields", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  try {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
      if (url.includes("/campaigns"))
        return Response.json({ id: "cmp_meta_1" });
      if (url.includes("/adsets")) return Response.json({ id: "as_meta_1" });
      return Response.json(
        { error: { code: 100, message: "unexpected" } },
        { status: 400 },
      );
    }) as typeof fetch;

    const executor = new GraphApplyExecutor({
      metaAdapter: META_ADAPTER,
      resolveAdAccountId: async () => "act_123",
      resolveAdAccountCurrency: async () => "JPY",
    });

    const campaign = await executor.executeAction({
      action: {
        kind: "campaign.create",
        account: "primary",
        ref: "campaign:spring",
        payload: {
          name: "Spring",
          objective: "OUTCOME_TRAFFIC",
          status: "PAUSED",
        },
      },
      context: ctx(),
      attempt: 0,
    });
    assert.equal(campaign.status, "success");
    const campaignBody = calls.find((call) =>
      call.url.includes("/campaigns"),
    )!.body;
    assert.equal(campaignBody.get("objective"), "OUTCOME_TRAFFIC");
    assert.equal(campaignBody.has("buying_type"), false);
    assert.equal(campaignBody.has("special_ad_categories"), false);

    const adset = await executor.executeAction({
      action: {
        kind: "adset.create",
        account: "primary",
        payload: {
          campaignRef: "{{campaign:spring}}",
          name: "Raw Ad Set",
          status: "PAUSED",
          optimizationGoal: "LINK_CLICKS",
          graphPayload: {
            campaign_id: "{{campaign:spring}}",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 7 }],
            access_token: "do-not-send",
            id: "read-only",
            nested: { access_token: "nested-secret", ok: true },
          },
        },
      },
      context: ctx(),
      attempt: 0,
    });
    assert.equal(adset.status, "success");

    const adsetBody = calls.find((call) => call.url.includes("/adsets"))!.body;
    assert.equal(adsetBody.get("campaign_id"), "cmp_meta_1");
    assert.equal(adsetBody.get("bid_strategy"), "LOWEST_COST_WITHOUT_CAP");
    assert.equal(adsetBody.has("targeting"), false);
    assert.equal(adsetBody.has("access_token"), false);
    assert.equal(adsetBody.has("id"), false);
    assert.deepEqual(JSON.parse(adsetBody.get("nested") ?? "{}"), { ok: true });
    assert.deepEqual(JSON.parse(adsetBody.get("attribution_spec") ?? "[]"), [
      { event_type: "CLICK_THROUGH", window_days: 7 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphApplyExecutor creates carousel creative then PAUSED ad in mutation order", async () => {
  const tmp = await fs.mkdtemp(
    path.join(os.tmpdir(), "addroid-carousel-apply-"),
  );
  const prevAddroidHome = process.env.ADDROID_HOME;
  process.env.ADDROID_HOME = tmp;
  const storage = new LocalDiskStorage({ env: process.env });
  await storage.write(
    "creatives/primary/carousel-1/card-1.png",
    Buffer.from("card-1"),
  );
  await storage.write(
    "creatives/primary/carousel-1/card-2.png",
    Buffer.from("card-2"),
  );
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let imageUploadCount = 0;
  try {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body });
      if (url.includes("/instagram_accounts")) {
        return Response.json({ data: [] });
      }
      if (url.includes("/281900655012835?")) {
        return Response.json({ id: "281900655012835", name: "Page" });
      }
      if (url.includes("/adsets?")) {
        return Response.json({ data: [] });
      }
      if (url.includes("/adimages")) {
        imageUploadCount += 1;
        return Response.json({
          images: {
            [`card-${imageUploadCount}.png`]: {
              hash: `hash-${imageUploadCount}`,
            },
          },
        });
      }
      if (url.includes("/adcreatives")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const spec = JSON.parse(
          params.get("object_story_spec") ?? "{}",
        ) as Record<string, unknown>;
        const linkData = spec.link_data as Record<string, unknown>;
        const children = linkData.child_attachments as Array<
          Record<string, unknown>
        >;
        assert.equal(children.length, 2);
        assert.deepEqual(
          children.map((child) => child.image_hash),
          ["hash-1", "hash-2"],
        );
        assert.deepEqual(
          children.map((child) => child.name),
          ["Hook card", "CTA card"],
        );
        assert.equal(children[0]!.link, "https://example.com/1");
        assert.equal(children[1]!.link, "https://example.com");
        return Response.json({ id: "cr_meta_1" });
      }
      if (/\/act_123\/ads(?:$|\?)/.test(url)) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        assert.equal(params.get("status"), "PAUSED");
        assert.deepEqual(JSON.parse(params.get("creative") ?? "{}"), {
          creative_id: "cr_meta_1",
        });
        return Response.json({ id: "ad_meta_1" });
      }
      return Response.json(
        { error: { code: 100, message: `unexpected ${url}` } },
        { status: 400 },
      );
    }) as typeof fetch;

    const executor = new GraphApplyExecutor({
      metaAdapter: META_ADAPTER,
      resolveAdAccountId: async () => "act_123",
    });
    const creative = await executor.executeAction({
      action: {
        kind: "creative.create",
        account: "primary",
        ref: "creative:carousel-1",
        payload: {
          creativeId: "carousel-1",
          name: "Carousel 1",
          pageId: "281900655012835",
          mediaType: "carousel",
          linkUrl: "https://example.com",
          primaryText: "main message",
          cards: [
            {
              storageKey: "creatives/primary/carousel-1/card-1.png",
              headline: "Hook card",
              description: "first",
              linkUrl: "https://example.com/1",
            },
            {
              storageKey: "creatives/primary/carousel-1/card-2.png",
              headline: "CTA card",
              description: "second",
            },
          ],
        },
      },
      context: ctx(),
      attempt: 0,
    });
    assert.equal(creative.status, "success");
    assert.equal(creative.externalId, "cr_meta_1");

    const ad = await executor.executeAction({
      action: {
        kind: "ad.create",
        account: "primary",
        payload: {
          adId: "ad-1",
          adsetId: "as-1",
          name: "Carousel Ad",
          creativeRef: "{{creative:carousel-1}}",
        },
      },
      context: ctx(),
      attempt: 0,
    });
    assert.equal(ad.status, "success");
    assert.equal(ad.externalId, "ad_meta_1");

    const mutationOrder = calls
      .filter((call) => call.method === "POST")
      .map((call) => call.url)
      .filter(
        (url) =>
          url.includes("/adimages") ||
          url.includes("/adcreatives") ||
          /\/act_123\/ads(?:$|\?)/.test(url),
      )
      .map((url) =>
        url.includes("/adimages")
          ? "adimages"
          : url.includes("/adcreatives")
            ? "adcreatives"
            : "ads",
      );
    assert.deepEqual(mutationOrder, [
      "adimages",
      "adimages",
      "adcreatives",
      "ads",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevAddroidHome === undefined) delete process.env.ADDROID_HOME;
    else process.env.ADDROID_HOME = prevAddroidHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("FailClosedApplyExecutor: skipped for unsupported action kinds (matches Cli/Mock contract)", async () => {
  const executor = new FailClosedApplyExecutor();
  const unsupportedPseudoAction = {
    kind: "create_experiment",
    account: "primary",
    experimentId: "exp-x",
    campaignId: "cmp-x",
    name: "experiment",
    variants: [],
  } as unknown as ApplyAction;
  const result = await executor.executeAction({
    action: unsupportedPseudoAction,
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "skipped");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.reason, "unsupported_action");
  assert.equal(payload.actionKind, "create_experiment");
});

test("resolveApplyExecutor: CLI bin set but no Meta token → GraphApplyExecutor that fails auth_error per invocation", async () => {
  const sel = await resolveApplyExecutor({
    env: {
      ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli",
    } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter(null),
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "graph");
  assert.ok(sel.executor instanceof GraphApplyExecutor);
  assert.match(sel.reason, /Graph API/);
  assert.equal(sel.versionVerification, undefined);

  const result = await sel.executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "auth_error");
  assert.ok(result.notify, "missing-token must surface a reauth notify hint");
  assert.equal(result.notify!.auditAction, "oauth.meta.reauth_required");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.accountKey, "primary");
  assert.equal(payload.mode, "graph");
  // sanity: token wasn't somehow leaked into the sanitized command (there is no token here)
  assert.equal(typeof payload.sanitizedCommand, "string");
  assert.ok(!(payload.sanitizedCommand as string).includes(TOKEN));
});

test("resolveApplyExecutor: CLI bin + Meta token present → GraphApplyExecutor", async () => {
  const sel = await resolveApplyExecutor({
    env: {
      ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli",
    } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "graph");
  assert.ok(sel.executor instanceof GraphApplyExecutor);
  assert.match(sel.reason, /Graph API/);
  assert.equal(sel.versionVerification, undefined);
});

test("resolveApplyExecutor: adapter throws MetaTokenExpiredError → GraphApplyExecutor that returns auth_error with reauth notify", async () => {
  const throwingAdapter: MetaAdapter = {
    async beginOAuth(): Promise<MetaBeginOAuthResult> {
      throw new Error("not used");
    },
    async completeOAuth(): Promise<MetaOAuthConnection> {
      throw new Error("not used");
    },
    async refreshLongLivedToken(): Promise<MetaRefreshResult> {
      throw new Error("not used");
    },
    async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
      throw new MetaTokenExpiredError(new Date(0));
    },
    async fetchBusinesses(): Promise<MetaBusiness[]> {
      return [];
    },
    async fetchAdAccounts(): Promise<MetaAdAccount[]> {
      return [];
    },
  };
  const sel = await resolveApplyExecutor({
    env: {
      ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli",
    } as NodeJS.ProcessEnv,
    metaAdapter: throwingAdapter,
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "graph");
  assert.ok(sel.executor instanceof GraphApplyExecutor);

  const result = await sel.executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "auth_error");
  assert.ok(result.notify, "expired-token must surface a reauth notify hint");
  assert.equal(result.notify!.auditAction, "oauth.meta.reauth_required");
  const payload = result.logPayload as Record<string, unknown>;
  assert.match(String(payload.stderr ?? ""), /expired|Meta token/i);
});

test("resolveApplyExecutor: token loader is invoked per executeAction call (reauth picks up next time)", async () => {
  // Counts loadAccessTokenPlaintext invocations and lets the test mutate the
  // returned state between calls — proving the lease is NOT captured at startup.
  let callCount = 0;
  let nextLease: MetaAccessTokenLease | null = null;
  let nextThrow: Error | null = null;
  const adapter: MetaAdapter = {
    async beginOAuth(): Promise<MetaBeginOAuthResult> {
      throw new Error("not used");
    },
    async completeOAuth(): Promise<MetaOAuthConnection> {
      throw new Error("not used");
    },
    async refreshLongLivedToken(): Promise<MetaRefreshResult> {
      throw new Error("not used");
    },
    async loadAccessTokenPlaintext(): Promise<MetaAccessTokenLease | null> {
      callCount += 1;
      if (nextThrow) throw nextThrow;
      return nextLease;
    },
    async fetchBusinesses(): Promise<MetaBusiness[]> {
      return [];
    },
    async fetchAdAccounts(): Promise<MetaAdAccount[]> {
      return [];
    },
  };

  const sel = await resolveApplyExecutor({
    env: {
      ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli",
    } as NodeJS.ProcessEnv,
    metaAdapter: adapter,
    versionResolver: async () => "meta-ads-cli 0.5.0",
  });
  assert.equal(sel.mode, "graph");

  // resolveApplyExecutor itself MUST NOT pre-load the token (lease is per-invocation).
  assert.equal(
    callCount,
    0,
    "resolveApplyExecutor must not pre-load the token at startup",
  );

  // 1st call: token expired → auth_error.
  nextThrow = new MetaTokenExpiredError(new Date(0));
  nextLease = null;
  const first = await sel.executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(first.status, "auth_error");
  const firstPayload = first.logPayload as Record<string, unknown>;
  assert.match(String(firstPayload.stderr ?? ""), /expired|Meta token/i);
  assert.equal(callCount, 1, "first executeAction must trigger a token load");

  // Operator reauths — adapter now reports no token at all (still pre-spawn failure
  // path, so we don't have to script a fake spawn). The executor must read the new
  // state on the next call rather than reusing the expired-token error from before.
  nextThrow = null;
  nextLease = null;
  const second = await sel.executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(second.status, "auth_error");
  const secondPayload = second.logPayload as Record<string, unknown>;
  assert.match(
    String(secondPayload.stderr ?? ""),
    /no Meta access token found/,
  );
  assert.equal(
    callCount,
    2,
    "token loader must be re-invoked on each executeAction call",
  );
});

test("resolveApplyExecutor: CLI versionResolver is ignored by canonical Graph route", async () => {
  const spawnLog: SpawnLog[] = [];
  let called = false;
  const sel = await resolveApplyExecutor({
    env: {
      ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli",
    } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => {
      called = true;
      throw new Error("ENOENT: meta-ads-cli not installed");
    },
  });
  assert.equal(sel.mode, "graph");
  assert.ok(sel.executor instanceof GraphApplyExecutor);
  assert.equal(sel.versionVerification, undefined);
  assert.equal(called, false);
  assert.equal(spawnLog.length, 0);
});

test("resolveApplyExecutor: older CLI versions do not affect canonical Graph selection", async () => {
  const spawnLog: SpawnLog[] = [];
  const sel = await resolveApplyExecutor({
    env: {
      ADDROID_META_CLI_BIN: "/usr/local/bin/meta-ads-cli",
    } as NodeJS.ProcessEnv,
    metaAdapter: new FakeMetaAdapter({
      accessToken: TOKEN,
      scopes: ["ads_management"],
      expiresAt: null,
      accountIdentifier: "primary",
    }),
    spawnImpl: makeSpawn([], spawnLog),
    versionResolver: async () => "meta-ads-cli 0.4.9",
  });
  assert.equal(sel.mode, "graph");
  assert.equal(sel.versionVerification, undefined);
  assert.equal(
    spawnLog.length,
    0,
    "must not spawn CLI while Graph is the canonical route",
  );
});

// ---------------------------------------------------------------------
// regression fix: approvalRecordId propagation into MetaCli refs
// ---------------------------------------------------------------------

test("CliApplyExecutor.executeAction: success propagates context.approvalRecordId into Meta CLI refs/payload", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: '{"id":"act_1/cmp_42","name":"Fall"}\n',
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx({ approvalRecordId: "appr-xyz-001" }),
    attempt: 0,
  });
  assert.equal(result.status, "success");
  const payload = result.logPayload as Record<string, unknown>;
  // toExecutionLogInput が refs.approvalRecordId を payload に焼き付けることを assert。
  // 既存 cli-runner.test.ts は同じ振る舞いをユニットレベルで検証済み。本テストは
  // CliApplyExecutor → runner → toExecutionLogInput の end-to-end 経路で
  // context.approvalRecordId が refs に乗ることをカバーする。
  assert.equal(
    payload.approvalRecordId,
    "appr-xyz-001",
    "approvalRecordId must flow from context into Meta CLI execution_log payload",
  );
  // pullRequestNumber は従来から refs に乗っているので回帰しないこと。
  assert.equal(payload.pullRequestNumber, 17);
});

test("CliApplyExecutor.executeAction: missing context.approvalRecordId omits the field from payload (no null leak)", async () => {
  const log: SpawnLog[] = [];
  const runner = makeRunner(
    [
      {
        stdout: '{"id":"act_1/cmp_42"}\n',
        stderr: "",
        exitCode: 0,
      },
    ],
    log,
  );
  const executor = new CliApplyExecutor({ runner, metaAdapter: META_ADAPTER });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(), // approvalRecordId 未設定
    attempt: 0,
  });
  const payload = result.logPayload as Record<string, unknown>;
  assert.ok(
    !("approvalRecordId" in payload),
    "approvalRecordId must be omitted when context does not carry it",
  );
});

// ---------------------------------------------------------------------
// regression fix: pre-spawn payloads carry the canonical command-evidence shape
// ---------------------------------------------------------------------

test("FailClosedApplyExecutor: pre-spawn unknown_error payload includes canonical CLI evidence fields", async () => {
  const executor = new FailClosedApplyExecutor();
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "unknown_error");
  const payload = result.logPayload as Record<string, unknown>;
  assertCanonicalPreSpawnEnvelope(payload, {
    exitClass: "unknown_error",
    stderrIncludes: "ADDROID_META_CLI_BIN is not configured",
    accountKey: "primary",
  });
  // 失敗ステージ固有の追加情報も保持されていること (envelope を上書きしない)。
  assert.equal(payload.mode, "fail_closed");
  assert.equal(payload.stage, "resolve_executor");
  assert.equal(payload.reason, "cli_not_configured");
  assert.equal(payload.resource, "campaigns");
  assert.equal(payload.verb, "create");
});

test("CliApplyExecutor.executeAction: version-unverified pre-spawn unknown_error payload includes canonical CLI evidence fields", async () => {
  const executor = await makeDiagnosticCliExecutor({
    versionResolver: async () => {
      throw new Error("ENOENT: meta-ads-cli not installed");
    },
  });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "unknown_error");
  const payload = result.logPayload as Record<string, unknown>;
  assertCanonicalPreSpawnEnvelope(payload, {
    exitClass: "unknown_error",
    stderrIncludes: "CLI version not verified",
    accountKey: "primary",
  });
  // 既存テストの assertion (stage / errorName / verification) も併せて検証。
  assert.equal(payload.stage, "verify_version");
  assert.equal(payload.errorName, "MetaCliVersionUnverifiedError");
  assert.ok(payload.verification);
});

test("CliApplyExecutor.executeAction: pre-spawn auth_error (missing token) payload includes canonical CLI evidence fields", async () => {
  const executor = await makeDiagnosticCliExecutor({ lease: null });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(),
    attempt: 0,
  });
  assert.equal(result.status, "auth_error");
  const payload = result.logPayload as Record<string, unknown>;
  assertCanonicalPreSpawnEnvelope(payload, {
    exitClass: "auth_error",
    stderrIncludes: "no Meta access token found",
    accountKey: "primary",
  });
  assert.equal(payload.stage, "load_token");
  assert.equal(payload.errorName, "MetaCliMissingTokenError");
  // recommendedAction は exit class に応じた notify_reauth を返すこと。
  const rec = payload.recommendedAction as Record<string, unknown>;
  assert.equal(rec.kind, "notify_reauth");
  assert.equal(rec.auditAction, "oauth.meta.reauth_required");
});

// ---------------------------------------------------------------------
// regression fix: mock 経路 + pre-spawn 経路の payload 正規化
// ---------------------------------------------------------------------
//
// 仕様: spawned 実行が `toExecutionLogInput` 経由で吐く canonical command-evidence
// shape (stdout/stderr/exitCode/signal/timestamps/durationMs/timedOut/
// throttleHeaders/exitClass/recommendedAction) を、MockApplyExecutor の success
// payload と Cli pre-spawn 失敗 (version_unverified / missing_token) payload にも
// 含める。さらに Cli pre-spawn 失敗は context.prNumber / context.approvalRecordId を
// payload に焼き付け、execution_logs の Apply 行を承認境界に紐付ける。

function assertCanonicalSuccessEnvelope(
  payload: Record<string, unknown>,
  expected: { accountKey: string; sanitizedCommandStartsWith: string },
) {
  assert.equal(payload.exitClass, "success");
  assert.equal(payload.exitCode, 0, "mock success exitCode must be 0");
  assert.equal(payload.signal, null, "mock success signal must be null");
  assert.equal(typeof payload.stdout, "string");
  assert.ok(
    (payload.stdout as string).length > 0,
    "mock success stdout should carry a 1 行サマリ",
  );
  assert.equal(payload.stderr, "", "mock success stderr must be empty");
  assert.equal(payload.timedOut, false);
  assert.equal(typeof payload.durationMs, "number");
  assert.equal(typeof payload.startedAt, "string");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(
    payload.throttleHeaders,
    null,
    "mock success throttleHeaders must be null",
  );
  assert.ok(
    payload.recommendedAction && typeof payload.recommendedAction === "object",
    "mock success recommendedAction must be present",
  );
  const rec = payload.recommendedAction as Record<string, unknown>;
  assert.equal(rec.kind, "none");
  assert.equal(payload.accountKey, expected.accountKey);
  assert.equal(payload.binary, null, "mock success binary must be null");
  assert.ok(
    typeof payload.sanitizedCommand === "string" &&
      (payload.sanitizedCommand as string).startsWith(
        expected.sanitizedCommandStartsWith,
      ),
  );
  assert.ok(Array.isArray(payload.sanitizedArgs));
}

test("MockApplyExecutor: success payload includes the canonical CLI evidence shape", async () => {
  const executor = new MockApplyExecutor();
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx({ approvalRecordId: "appr-mock-001" }),
    attempt: 0,
  });
  assert.equal(result.status, "success");
  const payload = result.logPayload as Record<string, unknown>;
  assertCanonicalSuccessEnvelope(payload, {
    accountKey: "primary",
    sanitizedCommandStartsWith: "meta-ads-cli ads campaign create",
  });
  // mock 固有の identity フィールドも引き続き保持される。
  assert.equal(payload.mode, "mock");
  assert.equal(payload.resource, "campaigns");
  assert.equal(payload.verb, "create");
  // PR / 承認境界紐付けも spawned 経路と同じく payload に焼き付ける。
  assert.equal(payload.pullRequestNumber, 17);
  assert.equal(payload.approvalRecordId, "appr-mock-001");
});

test("MockApplyExecutor: success payload omits approvalRecordId when context does not carry it (no null leak)", async () => {
  const executor = new MockApplyExecutor();
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(), // approvalRecordId 未設定
    attempt: 0,
  });
  const payload = result.logPayload as Record<string, unknown>;
  assert.ok(
    !("approvalRecordId" in payload),
    "approvalRecordId must be omitted when context does not carry it",
  );
  // pullRequestNumber は context が常に持つので焼き付ける。
  assert.equal(payload.pullRequestNumber, 17);
});

test("CliApplyExecutor.executeAction: pre-spawn version-unverified payload propagates context.prNumber and approvalRecordId", async () => {
  const executor = await makeDiagnosticCliExecutor({
    versionResolver: async () => {
      throw new Error("ENOENT: meta-ads-cli not installed");
    },
  });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx({ approvalRecordId: "appr-vuv-001" }),
    attempt: 0,
  });
  assert.equal(result.status, "unknown_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(
    payload.pullRequestNumber,
    17,
    "pre-spawn version-unverified payload must carry context.prNumber",
  );
  assert.equal(
    payload.approvalRecordId,
    "appr-vuv-001",
    "pre-spawn version-unverified payload must carry context.approvalRecordId",
  );
});

test("CliApplyExecutor.executeAction: pre-spawn auth_error payload propagates context.prNumber and approvalRecordId", async () => {
  const executor = await makeDiagnosticCliExecutor({ lease: null });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx({ approvalRecordId: "appr-auth-001" }),
    attempt: 0,
  });
  assert.equal(result.status, "auth_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(
    payload.pullRequestNumber,
    17,
    "pre-spawn auth_error payload must carry context.prNumber",
  );
  assert.equal(
    payload.approvalRecordId,
    "appr-auth-001",
    "pre-spawn auth_error payload must carry context.approvalRecordId",
  );
});

test("CliApplyExecutor.executeAction: pre-spawn auth_error omits approvalRecordId when context does not carry it", async () => {
  const executor = await makeDiagnosticCliExecutor({ lease: null });
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx(), // approvalRecordId 未設定
    attempt: 0,
  });
  const payload = result.logPayload as Record<string, unknown>;
  assert.ok(
    !("approvalRecordId" in payload),
    "approvalRecordId must be omitted when context does not carry it",
  );
  assert.equal(payload.pullRequestNumber, 17);
});

test("FailClosedApplyExecutor: pre-spawn unknown_error payload propagates context.prNumber and approvalRecordId", async () => {
  const executor = new FailClosedApplyExecutor();
  const result = await executor.executeAction({
    action: createCampaignAction(),
    context: ctx({ approvalRecordId: "appr-fc-001" }),
    attempt: 0,
  });
  assert.equal(result.status, "unknown_error");
  const payload = result.logPayload as Record<string, unknown>;
  assert.equal(payload.pullRequestNumber, 17);
  assert.equal(payload.approvalRecordId, "appr-fc-001");
});
