import assert from "node:assert/strict";
import test from "node:test";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMConnectionMeta,
  LLMProvider,
} from "@addroid/llm-provider";
import {
  buildAgentLoopInput,
  buildAgentSystemPrompt,
  evaluateAgentToolPolicy,
  runAgentTurn,
} from "../runtime.js";
import { isToolAllowedOnSurface } from "../manifest.js";

test("runAgentTurn does not infer natural-language tools when LLM returns 429", async () => {
  const provider = new ThrowingProvider("chat completions endpoint returned HTTP 429", 429);
  const result = await runAgentTurn({
    input: "日次レポートを取得して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
  });

  assert.match(result.message, /操作は実行しませんでした/);
  assert.equal(result.toolResults.length, 0);
});

test("query_meta_ads policy allows read-only catalog/product queries and denies mutations", () => {
  assert.equal(
    evaluateAgentToolPolicy("query_meta_ads", { resource: "product_feed", action: "list", catalogId: "123" }).allowed,
    true
  );
  assert.equal(
    evaluateAgentToolPolicy("query_meta_ads", { resource: "catalog", action: "get", id: "123" }).allowed,
    true
  );
  const denied = evaluateAgentToolPolicy("query_meta_ads", {
    resource: "campaign",
    action: "update",
    id: "123",
    status: "ACTIVE",
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /read-only/);
});

test("performance query tools are exposed to web chat and deny raw query shapes", () => {
  assert.equal(isToolAllowedOnSurface("query_performance", "web-chat"), true);
  assert.equal(isToolAllowedOnSurface("compare_performance", "web-chat"), true);
  assert.equal(isToolAllowedOnSurface("query_performance", "scheduled-agent"), true);
  assert.equal(
    evaluateAgentToolPolicy("query_performance", {
      accountId: "acc-1",
      level: "campaign",
      window: { preset: "last_7d" },
      metric: "cpa",
      sql: "select * from performance_snapshots",
    }).allowed,
    false
  );
});

test("system prompt exposes scheduled task creation to chat surfaces only", () => {
  const context = {
    content: "test agent context",
    webUrl: "http://127.0.0.1:3000",
    loadedDocs: ["test"],
  };
  assert.match(
    buildAgentSystemPrompt(context, "cli-chat"),
    /create_scheduled_agent_task/
  );
  assert.doesNotMatch(
    buildAgentSystemPrompt(context, "scheduled-agent"),
    /create_scheduled_agent_task/
  );
});

test("system prompt exposes read-only Meta query and GitOps proposal to scheduled agents", () => {
  const context = {
    content: "test agent context",
    webUrl: "http://127.0.0.1:3000",
    loadedDocs: ["test"],
  };
  const prompt = buildAgentSystemPrompt(context, "scheduled-agent");
  assert.match(prompt, /query_meta_ads/);
  assert.match(prompt, /propose_ops_change/);
  assert.doesNotMatch(prompt, /^- start_delivery:/m);
});

test("system prompt tells the agent to resolve Meta-readable missing values before asking", () => {
  const prompt = buildAgentSystemPrompt(
    {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    "web-chat"
  );
  assert.match(prompt, /Before asking the user for missing ad-operation details/);
  assert.match(prompt, /narrow query_meta_ads follow-up lookups/);
});

test("system prompt guides performance queries and low sample wording", () => {
  const prompt = buildAgentSystemPrompt(
    {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    "web-chat"
  );
  assert.match(prompt, /query_performance/);
  assert.match(prompt, /compare_performance/);
  assert.match(prompt, /サンプル不足のため参考値/);
});

test("runAgentTurn resolves create_scheduled_agent_task on cli-chat", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "設定します。",
      tools: [
        {
          name: "create_scheduled_agent_task",
          args: {
            prompt: "前日分の日次レポートを作成して要約する",
            cron: "0 9 * * *",
          },
          why: "毎朝の定期レポート",
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "毎朝9時に前日のレポートを作って",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "cli-chat",
  });
  assert.equal(result.toolResults[0]?.status, "ready");
  const tool = result.toolResults[0];
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "create_scheduled_agent_task");
  assert.equal(tool.command, null);
  assert.equal(tool.toolArgs.cron, "0 9 * * *");
});

test("runAgentTurn resolves natural-language performance ranking to query_performance", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "直近7日のCPAが良いキャンペーンを確認します。",
      tools: [
        {
          name: "query_performance",
          args: {
            accountId: "acc-1",
            level: "campaign",
            window: { preset: "last_7d" },
            metric: "cpa",
            rank: "bottom",
            limit: 3,
            statusFilter: "all",
          },
          why: "直近7日でCPAが良いキャンペーン上位3件を集計するため",
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "直近7日でCPAが良いキャンペーン上位3件",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "web-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "query_performance");
  assert.equal(tool.command, null);
  assert.deepEqual(tool.toolArgs.window, { preset: "last_7d" });
  assert.equal(tool.toolArgs.metric, "cpa");
  assert.equal(tool.toolArgs.rank, "bottom");
  assert.equal(tool.toolArgs.limit, 3);
});

test("runAgentTurn denies unavailable tools on scheduled-agent surface", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "設定します。",
      tools: [
        {
          name: "create_scheduled_agent_task",
          args: { prompt: "x", cron: "0 9 * * *" },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "さらに毎朝実行して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "scheduled-agent",
  });
  assert.equal(result.toolResults[0]?.status, "unsupported");
});

test("runAgentTurn resolves approval decisions on interactive chat surfaces only", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "承認します。",
      tools: [
        {
          name: "decide_approval",
          args: { prNumber: 12, decision: "approve" },
          why: "ユーザーがPR承認を依頼したため",
        },
      ],
    })
  );
  const context = {
    content: "test agent context",
    webUrl: "http://127.0.0.1:3000",
    loadedDocs: ["test"],
  };
  const interactive = await runAgentTurn({
    input: "PR #12 を承認して",
    provider,
    agentContext: context,
    purpose: "test",
    surface: "cli-chat",
  });
  const tool = interactive.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "decide_approval");
  assert.equal(tool.command, null);
  assert.equal(tool.toolArgs.prNumber, 12);

  const scheduled = await runAgentTurn({
    input: "PR #12 を承認して",
    provider,
    agentContext: context,
    purpose: "test",
    surface: "scheduled-agent",
  });
  assert.equal(scheduled.toolResults[0]?.status, "unsupported");
});

test("runAgentTurn keeps nested proposal args and rejects direct activation on chat surfaces", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "PRを作成します。",
      tools: [
        {
          name: "propose_ops_change",
          args: {
            intent: "pause",
            accountKey: "act_123",
            targets: [{ level: "campaign", id: "cmp_1" }],
            desiredChanges: { initialState: "PAUSED", budget: { dailyBudget: 10 } },
            rationale: "CV0のため",
          },
        },
        {
          name: "start_delivery",
          args: { hierarchyId: "cmp_2" },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "CV0のキャンペーンを止めて",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "cli-chat",
  });

  const proposal = result.toolResults[0];
  assert.equal(proposal?.status, "ready");
  if (proposal?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(proposal.tool, "propose_ops_change");
  assert.deepEqual(proposal.toolArgs.targets, [{ level: "campaign", id: "cmp_1" }]);
  assert.deepEqual(proposal.toolArgs.desiredChanges, {
    initialState: "PAUSED",
    budget: { dailyBudget: 10 },
  });
  assert.equal(result.toolResults[1]?.status, "unsupported");
});

test("runAgentTurn preserves deep Graph payloads for proposal operations", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "Graph API 入稿PRを作成します。",
      tools: [
        {
          name: "propose_ops_change",
          args: {
            intent: "other",
            accountKey: "act_123",
            operations: [
              {
                kind: "creative.create",
                ref: "creative:deep",
                payload: {
                  name: "Deep creative",
                  graphPayload: {
                    object_story_spec: {
                      page_id: "page_1",
                      link_data: {
                        link: "https://example.com",
                        message: "hello",
                        call_to_action: {
                          type: "LEARN_MORE",
                          value: {
                            link: "https://example.com/lp",
                          },
                        },
                      },
                    },
                    degrees_of_freedom_spec: {
                      creative_features_spec: {
                        standard_enhancements: {
                          enroll_status: "OPT_OUT",
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "Graph API の raw payload でクリエイティブを入稿PRにして",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "scheduled-agent",
  });

  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "propose_ops_change");
  const operation = (tool.toolArgs.operations as Array<Record<string, unknown>>)[0]!;
  const payload = operation.payload as Record<string, unknown>;
  const graphPayload = payload.graphPayload as Record<string, unknown>;
  assert.deepEqual(graphPayload.object_story_spec, {
    page_id: "page_1",
    link_data: {
      link: "https://example.com",
      message: "hello",
      call_to_action: {
        type: "LEARN_MORE",
        value: {
          link: "https://example.com/lp",
        },
      },
    },
  });
  assert.deepEqual(graphPayload.degrees_of_freedom_spec, {
    creative_features_spec: {
      standard_enhancements: {
        enroll_status: "OPT_OUT",
      },
    },
  });
});

test("runAgentTurn resolves creative submission as a GitOps PR tool", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "入稿PRを作成します。",
      tools: [
        {
          name: "propose_creative_submission",
          args: {
            accountKey: "act_123",
            creativeName: "spring-sale",
            adName: "春セール広告",
            headline: "春だけの特典",
            primaryText: "新商品を今すぐ確認できます。",
            campaignId: "cmp_1",
            adsetId: "as_1",
            localMediaPaths: ["/tmp/spring.png"],
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "この画像でMeta広告に入稿して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "cli-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "propose_creative_submission");
  assert.equal(tool.command, null);
  assert.deepEqual(tool.toolArgs.localMediaPaths, ["/tmp/spring.png"]);
});

test("runAgentTurn preserves level-specific Graph payloads for creative submission", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "入稿PRを作成します。",
      tools: [
        {
          name: "propose_creative_submission",
          args: {
            accountKey: "act_123",
            creativeName: "graph-creative",
            adName: "Graph ad",
            campaignId: "cmp_1",
            adsetId: "as_1",
            creativeGraphPayload: {
              object_story_spec: {
                page_id: "page_1",
                link_data: {
                  link: "https://example.com",
                  call_to_action: {
                    type: "SIGN_UP",
                    value: { link: "https://example.com/signup" },
                  },
                },
              },
            },
            adGraphPayload: {
              conversion_domain: "example.com",
              tracking_specs: [
                {
                  action_type: ["offsite_conversion"],
                  fb_pixel: ["pixel_1"],
                },
              ],
            },
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "raw Graph payload も含めて広告を作成して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "slack-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "propose_creative_submission");
  assert.deepEqual(tool.toolArgs.creativeGraphPayload, {
    object_story_spec: {
      page_id: "page_1",
      link_data: {
        link: "https://example.com",
        call_to_action: {
          type: "SIGN_UP",
          value: { link: "https://example.com/signup" },
        },
      },
    },
  });
  assert.deepEqual(tool.toolArgs.adGraphPayload, {
    conversion_domain: "example.com",
    tracking_specs: [
      {
        action_type: ["offsite_conversion"],
        fb_pixel: ["pixel_1"],
      },
    ],
  });
});

test("runAgentTurn resolves creative generation as a library-only tool on chat surfaces", async () => {
  for (const surface of ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"] as const) {
    const provider = new StaticProvider(
      JSON.stringify({
        message: "生成します。",
        tools: [
          {
            name: "generate_creatives",
            args: {
              accountKey: "act_123",
              prompt: "添付画像と既存広告を参考に新しいクリエイティブを生成",
              referenceImagePaths: ["/tmp/ref.png"],
            },
          },
        ],
      })
    );
    const result = await runAgentTurn({
      input: "この画像を参考に新しいクリエイティブを生成して",
      provider,
      agentContext: {
        content: "test agent context",
        webUrl: "http://127.0.0.1:3000",
        loadedDocs: ["test"],
      },
      purpose: "test",
      surface,
    });
    const tool = result.toolResults[0];
    assert.equal(tool?.status, "ready");
    if (tool?.status !== "ready") throw new Error(`expected ready tool for ${surface}`);
    assert.equal(tool.tool, "generate_creatives");
    assert.equal(tool.command, null);
    assert.deepEqual(tool.toolArgs.referenceImagePaths, ["/tmp/ref.png"]);
  }
});

test("runAgentTurn resolves creative submission context resolver as a read-only tool", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "不足情報を確認します。",
      tools: [
        {
          name: "resolve_creative_submission_context",
          args: {
            creativeId: "creative_1",
            preferActiveCampaign: true,
            sameAsExistingAd: true,
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "Creative ID creative_1 を現在オンのキャンペーン配下に入稿したい。不足情報を確認して。",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "web-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "resolve_creative_submission_context");
  assert.equal(tool.command, null);
  assert.equal(tool.toolArgs.creativeId, "creative_1");
});

test("runAgentTurn keeps creative submission args for new adset placement", async () => {
  const provider = new StaticProvider(
    JSON.stringify({
      message: "広告セット作成PRを作成します。",
      tools: [
        {
          name: "propose_creative_submission",
          args: {
            accountKey: "act_123",
            creativeName: "summer-sale",
            adName: "夏セール広告",
            headline: "夏の特典",
            primaryText: "新しい広告セットで配信します。",
            campaignId: "cmp_1",
            adsetName: "JP 25-44",
            countries: ["JP"],
            callToAction: "OPEN_LINK",
            optimizationGoal: "LINK_CLICKS",
            billingEvent: "IMPRESSIONS",
          },
        },
      ],
    })
  );
  const result = await runAgentTurn({
    input: "既存キャンペーン cmp_1 の下に新しい広告セットを作って入稿して",
    provider,
    agentContext: {
      content: "test agent context",
      webUrl: "http://127.0.0.1:3000",
      loadedDocs: ["test"],
    },
    purpose: "test",
    surface: "slack-chat",
  });
  const tool = result.toolResults[0];
  assert.equal(tool?.status, "ready");
  if (tool?.status !== "ready") throw new Error("expected ready tool");
  assert.equal(tool.tool, "propose_creative_submission");
  assert.equal(tool.toolArgs.campaignId, "cmp_1");
  assert.equal(tool.toolArgs.adsetName, "JP 25-44");
  assert.deepEqual(tool.toolArgs.countries, ["JP"]);
  assert.equal(tool.toolArgs.callToAction, "OPEN_LINK");
  assert.equal(tool.toolArgs.optimizationGoal, "LINK_CLICKS");
  assert.equal(tool.toolArgs.billingEvent, "IMPRESSIONS");
});

test("buildAgentLoopInput includes prior tool results for multi-step reasoning", () => {
  const input = buildAgentLoopInput("CV0を確認して必要なら止めて", [
    {
      display: "Meta Graph read-only query",
      status: "success",
      message: "2件取得しました",
      data: { rows: [{ campaign_id: "cmp_1", conversions: 0 }] },
    },
  ]);
  assert.match(input, /Original user request:/);
  assert.match(input, /Tool results already executed/);
  assert.match(input, /cmp_1/);
  assert.match(input, /Do not repeat a successful tool call/);
});

class ThrowingProvider implements LLMProvider {
  readonly name = "codex";
  readonly authKind = "oauth";
  readonly defaultModel = "gpt-4.1";

  constructor(
    private readonly message: string,
    private readonly status: number
  ) {}

  async beginOAuth(): Promise<never> {
    throw new Error("not implemented");
  }

  async completeOAuth(): Promise<never> {
    throw new Error("not implemented");
  }

  async refreshToken(): Promise<never> {
    throw new Error("not implemented");
  }

  async disconnect(): Promise<boolean> {
    return false;
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    return {
      provider: "codex",
      accountIdentifier: "test",
      scopes: [],
      connectedAt: new Date(0).toISOString(),
      expiresAt: null,
      defaultModel: this.defaultModel,
    };
  }

  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const err = new Error(`[codex] ${this.message}`) as Error & { status: number };
    err.status = this.status;
    throw err;
  }

  async generateImage(): Promise<never> {
    throw new Error("not implemented");
  }

  async embed(): Promise<never> {
    throw new Error("not implemented");
  }
}

class StaticProvider implements LLMProvider {
  readonly name = "mock";
  readonly authKind = "oauth";
  readonly defaultModel = "mock-small";

  constructor(private readonly content: string) {}

  async beginOAuth(): Promise<never> {
    throw new Error("not implemented");
  }

  async completeOAuth(): Promise<never> {
    throw new Error("not implemented");
  }

  async refreshToken(): Promise<never> {
    throw new Error("not implemented");
  }

  async disconnect(): Promise<boolean> {
    return false;
  }

  async getConnection(): Promise<LLMConnectionMeta | null> {
    return null;
  }

  async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
    return {
      content: this.content,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      meta: {
        provider: "mock",
        model: this.defaultModel,
        requestId: "static-req",
        accountIdentifier: "static-user",
      },
      costUsd: 0,
    };
  }

  async generateImage(): Promise<never> {
    throw new Error("not implemented");
  }

  async embed(): Promise<never> {
    throw new Error("not implemented");
  }
}
