import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYST_AGENT_SYSTEM_PROMPT,
  AUDIT_AGENT_SYSTEM_PROMPT,
  COPY_AGENT_SYSTEM_PROMPT,
  CREATIVE_QA_AGENT_SYSTEM_PROMPT,
  DANGEROUS_CHANGE_CATEGORIES,
  DEFAULT_ASPECT_RATIO_DIMENSIONS,
  GITOPS_AGENT_SYSTEM_PROMPT,
  IMAGE_PROMPT_AGENT_SYSTEM_PROMPT,
  InMemoryLLMProviderTokenStore,
  MEDIA_BUYER_AGENT_SYSTEM_PROMPT,
  MockLLMProvider,
  STRATEGY_AGENT_SYSTEM_PROMPT,
  buildAnalystAgentPrompt,
  buildAuditAgentPrompt,
  buildCopyAgentPrompt,
  buildCreativeQaAgentPrompt,
  buildGitOpsAgentPrompt,
  buildImagePromptAgentPrompt,
  buildMediaBuyerAgentPrompt,
  buildStrategyAgentPrompt,
  extractJsonFromLlmContent,
  imagePromptVariantsToVariationConditions,
  runAnalystAgent,
  runAuditAgent,
  runCopyAgent,
  runCreativeQaAgent,
  runGitOpsAgent,
  runImagePromptAgent,
  runMediaBuyerAgent,
  runStrategyAgent,
  type AgentRunContext,
  type AnalystAgentInput,
  type AuditAgentInput,
  type CopyAgentInput,
  type CopyAgentOutput,
  type CreativeQaAgentInput,
  type GitOpsAgentInput,
  type ImagePromptAgentInput,
  type ImagePromptAgentOutput,
  type ImagePromptVariant,
  type MediaBuyerAgentInput,
  type MediaBuyerProposal,
  type StrategyAgentInput,
} from "../index.js";

// ---- helpers --------------------------------------------------------------

async function connectedMockProvider(opts?: {
  responder?: (input: unknown) => string;
  failure?: "auth_failed" | "completion_failed" | null;
}) {
  const store = new InMemoryLLMProviderTokenStore();
  const provider = new MockLLMProvider({
    tokenStore: store,
    completionResponder: (req) => {
      const last = req.messages[req.messages.length - 1];
      const userPayload = last
        ? JSON.parse(messageContentText(last.content))
        : {};
      return opts?.responder
        ? opts.responder(userPayload)
        : JSON.stringify({ ok: true });
    },
    ...(opts?.failure ? { failureMode: opts.failure } : {}),
  });
  const begin = await provider.beginOAuth();
  await provider.completeOAuth({ code: "c", state: begin.state });
  return provider;
}

function baseCtx(
  provider: MockLLMProvider,
  overrides?: Partial<AgentRunContext>,
): AgentRunContext {
  return {
    provider,
    workspaceId: "ws-1",
    workflow: "improvement_pr",
    ...(overrides ?? {}),
  };
}

// ===========================================================================
// helpers — extractJsonFromLlmContent
// ===========================================================================

test("extractJsonFromLlmContent strips ```json fences", () => {
  const out = extractJsonFromLlmContent('```json\n{"a":1}\n```');
  assert.deepEqual(out, { a: 1 });
});

function messageContentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}

test("extractJsonFromLlmContent recovers when prose surrounds JSON", () => {
  const out = extractJsonFromLlmContent('here you go: {"a":2}\nThanks!') as {
    a: number;
  };
  assert.equal(out.a, 2);
});

test("extractJsonFromLlmContent throws on empty / non-JSON", () => {
  assert.throws(() => extractJsonFromLlmContent(""));
  assert.throws(() => extractJsonFromLlmContent("not json at all"));
});

// ===========================================================================
// 1) Strategy
// ===========================================================================

test("buildStrategyAgentPrompt embeds the strategy system prompt + user JSON", () => {
  const input: StrategyAgentInput = {
    accountId: "act_1",
    objective: "conversion",
    audienceSummary: "JP urban 25-44",
    currency: "JPY",
  };
  const prompt = buildStrategyAgentPrompt(input);
  assert.equal(prompt[0]!.role, "system");
  assert.equal(prompt[0]!.content, STRATEGY_AGENT_SYSTEM_PROMPT);
  assert.equal(prompt[1]!.role, "user");
  assert.deepEqual(JSON.parse(messageContentText(prompt[1]!.content)), input);
});

test("runStrategyAgent: succeeds, builds ai_run with provider/model/usage/cost", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        recommendedApproach: "Lean into mid-funnel video.",
        audienceFocus: "Returning visitors past 30d.",
        channelMix: ["facebook_reels", "instagram_reels"],
        riskNotes: ["seasonal demand drop"],
        rationale: "Engagement uplifted in similar windows.",
        decision: "propose",
        confidence: 0.72,
      }),
  });
  const result = await runStrategyAgent(baseCtx(provider), {
    accountId: "act_1",
    objective: "conversion",
    audienceSummary: "JP urban 25-44",
    currency: "JPY",
  });
  assert.equal(result.error, null);
  assert.ok(result.output);
  assert.equal(result.output!.channelMix.length, 2);
  assert.equal(result.aiRunInput.agent, "strategy");
  assert.equal(result.aiRunInput.workflow, "improvement_pr");
  assert.equal(result.aiRunInput.provider, "mock");
  assert.equal(result.aiRunInput.status, "succeeded");
  assert.equal(result.aiRunInput.decision, "propose");
  assert.equal(result.aiRunInput.confidence, 0.72);
  assert.equal(result.aiRunInput.inputTokens, 12);
  assert.equal(result.aiRunInput.outputTokens, 24);
  assert.equal(result.aiRunInput.costUsd, 0); // mock pricing
  assert.ok(result.aiRunInput.startedAt);
  assert.ok(result.aiRunInput.finishedAt);
});

test("runStrategyAgent: invalid JSON => failed ai_run with errorMessage", async () => {
  const provider = await connectedMockProvider({ responder: () => "not-json" });
  const result = await runStrategyAgent(baseCtx(provider), {
    accountId: "act_1",
    objective: "conversion",
    audienceSummary: "JP urban 25-44",
    currency: "JPY",
  });
  assert.equal(result.output, null);
  assert.ok(result.error);
  assert.equal(result.aiRunInput.status, "failed");
  assert.ok(result.aiRunInput.errorMessage);
  assert.equal(result.aiRunInput.decision, null);
  assert.equal(result.aiRunInput.confidence, null);
});

test("runStrategyAgent: provider failure => failed ai_run, no decision", async () => {
  const provider = await connectedMockProvider({
    failure: "completion_failed",
  });
  const result = await runStrategyAgent(baseCtx(provider), {
    accountId: "act_1",
    objective: "conversion",
    audienceSummary: "JP urban",
    currency: "JPY",
  });
  assert.equal(result.aiRunInput.status, "failed");
  assert.equal(result.output, null);
  assert.match(result.aiRunInput.errorMessage ?? "", /completion failed/);
});

test("runStrategyAgent: rejects unknown decision value", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        recommendedApproach: "x",
        audienceFocus: "y",
        channelMix: [],
        riskNotes: [],
        rationale: "z",
        decision: "yolo",
        confidence: 0.5,
      }),
  });
  const result = await runStrategyAgent(baseCtx(provider), {
    accountId: "a",
    objective: "conversion",
    audienceSummary: "u",
    currency: "JPY",
  });
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /decision must be 'propose' or 'skip'/);
});

// ===========================================================================
// 2) Copy
// ===========================================================================

test("runCopyAgent: returns primary + alternates, sanitizes secret-shaped input", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        primary: {
          headline: "Try the new beta.",
          primaryText: "Built for ops.",
          cta: "Sign up",
        },
        alternates: [
          {
            headline: "Beta access today.",
            primaryText: "Localhost-only.",
            cta: "Learn more",
          },
        ],
        rationale: "Direct, mid-funnel.",
        decision: "propose",
        confidence: 0.8,
      }),
  });
  const input: CopyAgentInput = {
    accountId: "act_1",
    audienceSummary: "JP urban 25-44",
    brandTone: "concise, technical",
    productOffer: "AdDroid OSS — Bearer sk-leaked-test-1234567",
  };
  const result = await runCopyAgent(baseCtx(provider), input);
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.agent, "copy");
  const out = result.output as CopyAgentOutput;
  assert.equal(out.alternates.length, 1);
  // sanitize: prompt + inputs in ai_run must not contain raw sk-/Bearer
  const promptStr = JSON.stringify(result.aiRunInput.prompt);
  const inputsStr = JSON.stringify(result.aiRunInput.inputs);
  assert.ok(!promptStr.includes("sk-leaked-test-1234567"));
  assert.ok(!inputsStr.includes("sk-leaked-test-1234567"));
});

test("buildCopyAgentPrompt uses copy system prompt", () => {
  const prompt = buildCopyAgentPrompt({
    accountId: "act_1",
    audienceSummary: "x",
    brandTone: "y",
    productOffer: "z",
  });
  assert.equal(prompt[0]!.content, COPY_AGENT_SYSTEM_PROMPT);
});

test("runCopyAgent: parses valid carousel cards", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        primary: {
          headline: "Try it",
          primaryText: "Built for ops.",
          cta: "Sign up",
        },
        alternates: [],
        carousel: {
          storyArc: "Problem, feature, CTA",
          cards: [
            {
              position: 1,
              role: "hook",
              headline: "運用のムダを発見",
              description: "最初のカード",
              imageBrief: "operator noticing wasted spend",
            },
            {
              position: 2,
              role: "cta",
              headline: "改善案を見る",
              description: null,
              imageBrief: "clear product screen with CTA",
              linkUrl: "https://example.com",
            },
          ],
        },
        rationale: "Carousel tells a short story.",
        decision: "propose",
        confidence: 0.8,
      }),
  });
  const result = await runCopyAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "JP ops",
    brandTone: "concise",
    productOffer: "AdDroid",
    format: "carousel",
    carouselCardCount: 2,
  });
  assert.equal(result.error, null);
  assert.equal(result.output?.carousel?.cards.length, 2);
  assert.equal(result.output?.carousel?.cards[0]!.position, 1);
  assert.equal(result.output?.carousel?.cards[1]!.role, "cta");
});

test("runCopyAgent: invalid carousel cards are dropped while primary copy remains", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        primary: {
          headline: "Try it",
          primaryText: "Built for ops.",
          cta: "Sign up",
        },
        alternates: [],
        carousel: {
          storyArc: "Broken duplicate positions",
          cards: [
            {
              position: 1,
              role: "hook",
              headline: "x",
              description: null,
              imageBrief: "first",
            },
            {
              position: 1,
              role: "cta",
              headline: "y",
              description: null,
              imageBrief: "duplicate",
            },
          ],
        },
        rationale: "Primary still works.",
        decision: "propose",
        confidence: 0.8,
      }),
  });
  const result = await runCopyAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "JP ops",
    brandTone: "concise",
    productOffer: "AdDroid",
    format: "carousel",
  });
  assert.equal(result.error, null);
  assert.equal(result.output?.primary.headline, "Try it");
  assert.equal(result.output?.carousel, undefined);
});

// ===========================================================================
// 3) Image Prompt
// ===========================================================================

test("runImagePromptAgent: requires non-empty variants array", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [],
        rationale: "n/a",
        decision: "propose",
        confidence: 0.4,
      }),
  });
  const input: ImagePromptAgentInput = {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
  };
  const result = await runImagePromptAgent(baseCtx(provider), input);
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /variants/);
});

test("runImagePromptAgent: succeeds with valid variants", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [
          {
            prompt: "abstract gradient, indigo + slate",
            negativePrompt: "no text, no logos",
            styleNotes: "soft, operator-grade",
          },
        ],
        rationale: "Matches operator aesthetic.",
        decision: "propose",
        confidence: 0.6,
      }),
  });
  const result = await runImagePromptAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.agent, "image_prompt");
  assert.equal(result.aiRunInput.decision, "propose");
});

test("buildImagePromptAgentPrompt uses image_prompt system prompt", () => {
  const prompt = buildImagePromptAgentPrompt({
    accountId: "a",
    audienceSummary: "u",
    brandStyle: "s",
    aspectRatio: "1:1",
  });
  assert.equal(prompt[0]!.content, IMAGE_PROMPT_AGENT_SYSTEM_PROMPT);
});

test("IMAGE_PROMPT_AGENT_SYSTEM_PROMPT mentions performance / brandProfile / improvementContext / dimensionPresets", () => {
  // this implementation: agent must understand structured 実績 / ブランド情報 /
  // 改善方針 / variation conditions inputs.
  assert.match(IMAGE_PROMPT_AGENT_SYSTEM_PROMPT, /performance/);
  assert.match(IMAGE_PROMPT_AGENT_SYSTEM_PROMPT, /brandProfile/);
  assert.match(IMAGE_PROMPT_AGENT_SYSTEM_PROMPT, /improvementContext/);
  assert.match(IMAGE_PROMPT_AGENT_SYSTEM_PROMPT, /dimensionPresets/);
  assert.match(IMAGE_PROMPT_AGENT_SYSTEM_PROMPT, /variantKey/);
});

test("buildImagePromptAgentPrompt embeds the structured input as the user payload", () => {
  const input: ImagePromptAgentInput = {
    accountId: "act_42",
    audienceSummary: "JP urban 25-44",
    brandStyle: "operator-grade",
    aspectRatio: "1:1",
    performance: {
      periodLabel: "2026-04-25..2026-04-30",
      recentKpis: { ctr: 0.012, cpa: 4200 },
      analystCommentary: "CTR flat, CPA improved.",
      snapshotIds: ["snap-1"],
    },
    brandProfile: {
      brandName: "AdDroid",
      tone: "concise, technical",
      palette: ["indigo", "slate"],
      forbiddenTerms: ["guaranteed", "best ever"],
    },
    improvementContext: {
      strategySummary: "Lean into mid-funnel video.",
      rationale: "CTR uplift opportunity.",
      mediaBuyerProposals: [
        {
          hierarchy: "adset",
          target: "adset_42",
          category: "creative_refresh",
          proposedChange: "swap hero image",
          rationale: "fatigue",
        },
      ],
    },
    variantCount: 2,
    dimensionPresets: [
      { key: "feed_square", width: 1080, height: 1080, format: "png" },
      { key: "feed_landscape", width: 1200, height: 628, format: "png" },
    ],
  };
  const prompt = buildImagePromptAgentPrompt(input);
  const userPayload = JSON.parse(messageContentText(prompt[1]!.content));
  assert.equal(userPayload.accountId, "act_42");
  assert.equal(userPayload.performance.recentKpis.ctr, 0.012);
  assert.equal(userPayload.brandProfile.tone, "concise, technical");
  assert.deepEqual(userPayload.brandProfile.forbiddenTerms, [
    "guaranteed",
    "best ever",
  ]);
  assert.equal(
    userPayload.improvementContext.strategySummary,
    "Lean into mid-funnel video.",
  );
  assert.equal(userPayload.improvementContext.mediaBuyerProposals.length, 1);
  assert.equal(userPayload.variantCount, 2);
  assert.equal(userPayload.dimensionPresets.length, 2);
});

test("runImagePromptAgent: parses extended variant fields (variantKey/width/height/format/aspectRatio)", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [
          {
            prompt: "abstract gradient, indigo + slate",
            negativePrompt: "no text, no logos",
            styleNotes: "soft, operator-grade",
            variantKey: "feed_square",
            width: 1080,
            height: 1080,
            format: "png",
            aspectRatio: "1:1",
          },
          {
            prompt: "wider landscape with subtle product silhouette",
            negativePrompt: "no faces",
            styleNotes: "calm, monochromatic",
            variantKey: "feed_landscape",
            width: 1200,
            height: 628,
            format: "png",
          },
        ],
        rationale: "Two placements: square hero + landscape inline.",
        decision: "propose",
        confidence: 0.7,
      }),
  });
  const result = await runImagePromptAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
    dimensionPresets: [
      { key: "feed_square", width: 1080, height: 1080 },
      { key: "feed_landscape", width: 1200, height: 628 },
    ],
  });
  assert.equal(result.error, null);
  const out = result.output as ImagePromptAgentOutput;
  assert.equal(out.variants.length, 2);
  assert.equal(out.variants[0]!.variantKey, "feed_square");
  assert.equal(out.variants[0]!.width, 1080);
  assert.equal(out.variants[1]!.variantKey, "feed_landscape");
  assert.equal(out.variants[1]!.height, 628);
});

test("runImagePromptAgent: carouselCards can produce card-N square variants", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [
          {
            prompt: "card one visual",
            negativePrompt: "no logos",
            styleNotes: "same visual system",
            variantKey: "card-1",
            width: 1080,
            height: 1080,
            format: "png",
            aspectRatio: "1:1",
          },
          {
            prompt: "card two visual",
            negativePrompt: "no logos",
            styleNotes: "same visual system",
            variantKey: "card-2",
            width: 1080,
            height: 1080,
            format: "png",
            aspectRatio: "1:1",
          },
        ],
        rationale: "Cards share one design system.",
        decision: "propose",
        confidence: 0.7,
      }),
  });
  const result = await runImagePromptAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
    carouselCards: [
      { position: 1, imageBrief: "hook", headline: "Hook" },
      { position: 2, imageBrief: "cta", headline: "CTA" },
    ],
  });
  assert.equal(result.error, null);
  assert.deepEqual(
    result.output?.variants.map((variant) => variant.variantKey),
    ["card-1", "card-2"],
  );
  assert.equal(result.output?.variants[0]!.width, 1080);
});

test("runImagePromptAgent: rejects invalid variant width", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [
          {
            prompt: "p",
            negativePrompt: "n",
            styleNotes: "s",
            width: 99999,
            height: 1080,
          },
        ],
        rationale: "r",
        decision: "propose",
        confidence: 0.5,
      }),
  });
  const result = await runImagePromptAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
  });
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /width must be an integer in \(0, 4096\]/);
});

test("runImagePromptAgent: rejects more than 6 variants", async () => {
  const item = {
    prompt: "p",
    negativePrompt: "n",
    styleNotes: "s",
  };
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [item, item, item, item, item, item, item],
        rationale: "r",
        decision: "propose",
        confidence: 0.5,
      }),
  });
  const result = await runImagePromptAgent(baseCtx(provider), {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
  });
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /may not exceed 6/);
});

test("runImagePromptAgent: sanitizes secret-shaped strings inside performance/brand/improvement context", async () => {
  // Sanitizer should redact even when the credential leaks through brand
  // guidelines or analyst commentary — ai-runs.ts walks the full inputs tree.
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        variants: [{ prompt: "p", negativePrompt: "n", styleNotes: "s" }],
        rationale: "r",
        decision: "propose",
        confidence: 0.5,
      }),
  });
  const input: ImagePromptAgentInput = {
    accountId: "act_1",
    audienceSummary: "x",
    brandStyle: "minimal",
    aspectRatio: "1:1",
    performance: {
      analystCommentary: "see internal note Bearer sk-leaked-secret-9876543",
    },
    brandProfile: {
      guidelines: "do not paste OPENAI_API_KEY=sk-leaked-2222222222",
    },
    improvementContext: {
      rationale: "user pasted token: sk-zzzzzzzzzzzzzzzzz",
    },
  };
  const result = await runImagePromptAgent(baseCtx(provider), input);
  assert.equal(result.error, null);
  const inputsStr = JSON.stringify(result.aiRunInput.inputs);
  const promptStr = JSON.stringify(result.aiRunInput.prompt);
  assert.ok(!inputsStr.includes("sk-leaked-secret-9876543"));
  assert.ok(!inputsStr.includes("sk-leaked-2222222222"));
  assert.ok(!inputsStr.includes("sk-zzzzzzzzzzzzzzzzz"));
  assert.ok(!promptStr.includes("sk-leaked-secret-9876543"));
});

// ---- variant → ImageVariationCondition helper ----------------------------

test("DEFAULT_ASPECT_RATIO_DIMENSIONS covers Meta-required ratios", () => {
  // The set must at minimum cover feed_square (1:1) and feed_landscape (1.91:1)
  // — these are the dimensions referenced by the Creative QA dimensions check.
  assert.deepEqual(DEFAULT_ASPECT_RATIO_DIMENSIONS["1:1"], {
    width: 1080,
    height: 1080,
  });
  assert.deepEqual(DEFAULT_ASPECT_RATIO_DIMENSIONS["4:5"], {
    width: 1080,
    height: 1350,
  });
  assert.deepEqual(DEFAULT_ASPECT_RATIO_DIMENSIONS["9:16"], {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(DEFAULT_ASPECT_RATIO_DIMENSIONS["1.91:1"], {
    width: 1200,
    height: 628,
  });
});

test("imagePromptVariantsToVariationConditions: passes through explicit width/height/format", () => {
  const variants: ImagePromptVariant[] = [
    {
      prompt: "p",
      negativePrompt: "n",
      styleNotes: "s",
      variantKey: "k1",
      width: 1080,
      height: 1080,
      format: "jpeg",
    },
  ];
  const out = imagePromptVariantsToVariationConditions(variants);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.width, 1080);
  assert.equal(out[0]!.height, 1080);
  assert.equal(out[0]!.format, "jpeg");
  assert.equal(out[0]!.variantKey, "k1");
  assert.equal(out[0]!.styleNotes, "s");
  assert.equal(out[0]!.negativePrompt, "n");
});

test("imagePromptVariantsToVariationConditions: resolves dimensions from dimensionPresets via variantKey", () => {
  const variants: ImagePromptVariant[] = [
    {
      prompt: "p",
      negativePrompt: "n",
      styleNotes: "s",
      variantKey: "feed_square",
    },
    {
      prompt: "p2",
      negativePrompt: "n2",
      styleNotes: "s2",
      variantKey: "feed_landscape",
    },
  ];
  const out = imagePromptVariantsToVariationConditions(variants, {
    dimensionPresets: [
      { key: "feed_square", width: 1080, height: 1080, format: "png" },
      { key: "feed_landscape", width: 1200, height: 628, format: "jpeg" },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.width, 1080);
  assert.equal(out[0]!.height, 1080);
  assert.equal(out[0]!.format, "png");
  assert.equal(out[0]!.variantKey, "feed_square");
  assert.equal(out[1]!.width, 1200);
  assert.equal(out[1]!.height, 628);
  assert.equal(out[1]!.format, "jpeg");
});

test("imagePromptVariantsToVariationConditions: falls back to aspectRatio defaults and synthesizes variantKey", () => {
  const variants: ImagePromptVariant[] = [
    { prompt: "p", negativePrompt: "n", styleNotes: "s" },
    {
      prompt: "p2",
      negativePrompt: "n2",
      styleNotes: "s2",
      aspectRatio: "1.91:1",
    },
  ];
  const out = imagePromptVariantsToVariationConditions(variants, {
    aspectRatio: "1:1",
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.width, 1080);
  assert.equal(out[0]!.height, 1080);
  assert.equal(out[0]!.format, "png");
  assert.ok(out[0]!.variantKey?.startsWith("aspect-1-1-"));
  assert.equal(out[1]!.width, 1200);
  assert.equal(out[1]!.height, 628);
  assert.ok(out[1]!.variantKey?.startsWith("aspect-1-91-1-"));
});

test("imagePromptVariantsToVariationConditions: defaults format to png when nothing else specifies", () => {
  const out = imagePromptVariantsToVariationConditions([
    {
      prompt: "p",
      negativePrompt: "n",
      styleNotes: "s",
      width: 800,
      height: 800,
    },
  ]);
  assert.equal(out[0]!.format, "png");
});

test("imagePromptVariantsToVariationConditions: throws when dimensions cannot be resolved", () => {
  const variants: ImagePromptVariant[] = [
    { prompt: "p", negativePrompt: "n", styleNotes: "s" },
  ];
  // No aspectRatio, no preset, no width/height — must throw.
  assert.throws(
    () => imagePromptVariantsToVariationConditions(variants),
    /cannot resolve dimensions/,
  );
});

test("imagePromptVariantsToVariationConditions: dedupes synthesized keys when collisions occur", () => {
  // Two variants with the same explicit variantKey -> the second one must be
  // suffixed so Provider adapter can use variantKey as a unique identifier.
  const variants: ImagePromptVariant[] = [
    {
      prompt: "p1",
      negativePrompt: "n",
      styleNotes: "s",
      variantKey: "shared",
      width: 800,
      height: 800,
    },
    {
      prompt: "p2",
      negativePrompt: "n",
      styleNotes: "s",
      variantKey: "shared",
      width: 800,
      height: 800,
    },
  ];
  const out = imagePromptVariantsToVariationConditions(variants);
  assert.equal(out[0]!.variantKey, "shared");
  assert.notEqual(out[1]!.variantKey, "shared");
});

test("imagePromptVariantsToVariationConditions: throws on empty variant array", () => {
  assert.throws(
    () => imagePromptVariantsToVariationConditions([]),
    /non-empty array/,
  );
});

// ===========================================================================
// 4) Creative QA
// ===========================================================================

test("runCreativeQaAgent: rejects 'approve' when an issue is severity=error", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        issues: [
          {
            severity: "error",
            category: "policy",
            message: "Health claim found.",
          },
        ],
        recommendation: "approve",
        rationale: "n/a",
        confidence: 0.5,
      }),
  });
  const input: CreativeQaAgentInput = {
    copy: {
      primary: { headline: "h", primaryText: "p", cta: "c" },
      alternates: [],
      rationale: "r",
    },
  };
  const result = await runCreativeQaAgent(baseCtx(provider), input);
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /approve.*severity='error'/);
});

test("runCreativeQaAgent: succeeds with request_changes when issues present", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        issues: [
          { severity: "warn", category: "tone", message: "Too breezy." },
        ],
        recommendation: "request_changes",
        rationale: "Tone mismatch.",
        confidence: 0.55,
      }),
  });
  const result = await runCreativeQaAgent(baseCtx(provider), {
    copy: {
      primary: { headline: "h", primaryText: "p", cta: "c" },
      alternates: [],
      rationale: "r",
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.decision, "request_changes");
});

test("runCreativeQaAgent: accepts valid genes", async () => {
  const genes = {
    schemaVersion: 1,
    appealAxes: ["price", "urgency"],
    tone: "casual",
    subjectType: "product",
    colorScheme: "bright",
    layout: "single_focus",
    hasTextOverlay: true,
    hasCta: true,
    language: "ja",
  };
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        issues: [],
        recommendation: "approve",
        rationale: "Ready.",
        genes,
        confidence: 0.8,
      }),
  });
  const result = await runCreativeQaAgent(baseCtx(provider), {
    copy: {
      primary: {
        headline: "今だけ20%OFF",
        primaryText: "今日中にお試しください",
        cta: "詳しく見る",
      },
      alternates: [],
      rationale: "r",
    },
    imagePrompts: {
      variants: [
        {
          prompt: "bright product hero with bold Japanese CTA overlay",
          negativePrompt: "no logo",
          styleNotes: "single product focus",
        },
      ],
      rationale: "r",
    },
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.output?.genes, genes);
});

test("runCreativeQaAgent: ignores invalid genes while QA succeeds", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        issues: [],
        recommendation: "approve",
        rationale: "Ready.",
        genes: {
          schemaVersion: 1,
          appealAxes: ["price"],
          tone: "friendly",
          subjectType: "product",
          colorScheme: "bright",
          layout: "single_focus",
          hasTextOverlay: true,
          hasCta: true,
          language: "ja",
        },
        confidence: 0.8,
      }),
  });
  const result = await runCreativeQaAgent(baseCtx(provider), {
    copy: {
      primary: { headline: "h", primaryText: "p", cta: "c" },
      alternates: [],
      rationale: "r",
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.status, "succeeded");
  assert.equal(result.output?.genes, undefined);
});

test("runCreativeQaAgent: missing genes remains backward compatible", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        issues: [],
        recommendation: "approve",
        rationale: "Ready.",
        confidence: 0.8,
      }),
  });
  const result = await runCreativeQaAgent(baseCtx(provider), {
    copy: {
      primary: { headline: "h", primaryText: "p", cta: "c" },
      alternates: [],
      rationale: "r",
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.output?.genes, undefined);
});

test("buildCreativeQaAgentPrompt uses creative_qa system prompt", () => {
  const prompt = buildCreativeQaAgentPrompt({
    copy: {
      primary: { headline: "h", primaryText: "p", cta: "c" },
      alternates: [],
      rationale: "r",
    },
  });
  assert.equal(prompt[0]!.content, CREATIVE_QA_AGENT_SYSTEM_PROMPT);
});

// ===========================================================================
// 5) Analyst
// ===========================================================================

test("runAnalystAgent: forces decision='report_only', accepts top-3 improvements", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        commentary: "Spend up 8%, CTR flat, CPA improved 4%.",
        deltas: { spend: "+8.0%", ctr: "+0.0%", cpa: "-4.1%" },
        topImprovements: [
          {
            hierarchy: "campaign",
            target: "cmp_123",
            rationale: "Mid-funnel video lifted CTR.",
            expectedImpact: "+5% CV",
          },
        ],
        decision: "report_only",
        confidence: 0.8,
      }),
  });
  const input: AnalystAgentInput = {
    accountId: "act_1",
    periodStart: "2026-04-25",
    periodEnd: "2026-04-30",
    snapshotIds: ["snap-1", "snap-2"],
    current: {
      spend: 100000,
      impressions: 200000,
      clicks: 4000,
      conversions: 50,
    },
  };
  const result = await runAnalystAgent(
    baseCtx(provider, { workflow: "daily_report" }),
    input,
  );
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.workflow, "daily_report");
  assert.equal(result.aiRunInput.agent, "analyst");
  assert.equal(result.aiRunInput.decision, "report_only");
});

test("runAnalystAgent: rejects topImprovements > 3", async () => {
  const provider = await connectedMockProvider({
    responder: () => {
      const item = {
        hierarchy: "ad",
        target: "ad_x",
        rationale: "r",
        expectedImpact: "i",
      };
      return JSON.stringify({
        commentary: "x",
        deltas: {},
        topImprovements: [item, item, item, item],
        decision: "report_only",
        confidence: 0.5,
      });
    },
  });
  const result = await runAnalystAgent(
    baseCtx(provider, { workflow: "daily_report" }),
    {
      accountId: "a",
      periodStart: "2026-04-25",
      periodEnd: "2026-04-30",
      snapshotIds: [],
      current: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    },
  );
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /topImprovements may not exceed 3/);
});

test("buildAnalystAgentPrompt uses analyst system prompt", () => {
  const prompt = buildAnalystAgentPrompt({
    accountId: "a",
    periodStart: "2026-04-25",
    periodEnd: "2026-04-30",
    snapshotIds: [],
    current: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
  });
  assert.equal(prompt[0]!.content, ANALYST_AGENT_SYSTEM_PROMPT);
  // The analyst system prompt must explicitly defer budget/targeting changes
  // to the media_buyer agent — the current implementation separation of concerns.
  assert.match(ANALYST_AGENT_SYSTEM_PROMPT, /media_buyer/);
});

// ===========================================================================
// 6) Media Buyer
// ===========================================================================

test("DANGEROUS_CHANGE_CATEGORIES matches the current implementation dangerous list", () => {
  assert.deepEqual([...DANGEROUS_CHANGE_CATEGORIES].sort(), [
    "automation_rule_change",
    "budget_increase",
    "monthly_budget_change",
    "new_campaign",
    "targeting_change",
  ]);
});

test("runMediaBuyerAgent: decision='propose' with empty proposals is rejected", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        proposals: [],
        budgetImpact: { deltaCurrency: 0, afterCurrency: 0, notes: "n/a" },
        dryRunSummary: "n/a",
        rationale: "r",
        decision: "propose",
        confidence: 0.5,
      }),
  });
  const input: MediaBuyerAgentInput = {
    accountId: "act_1",
    currency: "JPY",
    snapshotIds: [],
    currentDailyBudget: 10000,
    riskTolerance: "balanced",
  };
  const result = await runMediaBuyerAgent(baseCtx(provider), input);
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /requires at least one entry/);
});

test("runMediaBuyerAgent: succeeds with skip_no_proposal", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        proposals: [],
        budgetImpact: {
          deltaCurrency: 0,
          afterCurrency: 10000,
          notes: "no change",
        },
        dryRunSummary: "no candidates",
        rationale: "Insufficient signal.",
        decision: "skip_no_proposal",
        confidence: 0.65,
      }),
  });
  const result = await runMediaBuyerAgent(baseCtx(provider), {
    accountId: "act_1",
    currency: "JPY",
    snapshotIds: [],
    currentDailyBudget: 10000,
    riskTolerance: "conservative",
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.decision, "skip_no_proposal");
});

test("buildMediaBuyerAgentPrompt uses media_buyer system prompt", () => {
  const prompt = buildMediaBuyerAgentPrompt({
    accountId: "a",
    currency: "JPY",
    snapshotIds: [],
    currentDailyBudget: 0,
    riskTolerance: "balanced",
  });
  assert.equal(prompt[0]!.content, MEDIA_BUYER_AGENT_SYSTEM_PROMPT);
});

// ===========================================================================
// 7) GitOps
// ===========================================================================

test("runGitOpsAgent: decision='propose' must include at least one file", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        prTitle: "t",
        prBody: "b",
        branchName: "addroid/x",
        files: [],
        decision: "propose",
        confidence: 0.5,
      }),
  });
  const input: GitOpsAgentInput = {
    accountId: "act_1",
    proposals: [],
    repo: "myorg/ads-config",
  };
  const result = await runGitOpsAgent(baseCtx(provider), input);
  assert.equal(result.aiRunInput.status, "failed");
});

test("runGitOpsAgent: skip path requires empty files array", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        prTitle: "t",
        prBody: "b",
        branchName: "addroid/x",
        files: [
          { path: "ads/x.yaml", action: "update", diff: "@@\n-foo\n+bar" },
        ],
        decision: "skip",
        confidence: 0.4,
      }),
  });
  const result = await runGitOpsAgent(baseCtx(provider), {
    accountId: "act_1",
    proposals: [],
    repo: "myorg/ads-config",
  });
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /skip.*empty/);
});

test("runGitOpsAgent: succeeds with one file diff", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        prTitle: "Increase mid-funnel adset bid by 10%",
        prBody: "## AI rationale\n...\n## Risk\n...\n## Budget impact\n+10%",
        branchName: "addroid/act_1-budget-2026-04-30",
        files: [
          {
            path: "operations/act_1/2026-04-30-budget.json",
            action: "update",
            diff: "@@\n-bid: 100\n+bid: 110",
          },
        ],
        decision: "propose",
        confidence: 0.7,
      }),
  });
  const result = await runGitOpsAgent(baseCtx(provider), {
    accountId: "act_1",
    proposals: [],
    repo: "myorg/ads-config",
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.agent, "gitops");
  assert.equal(result.aiRunInput.decision, "propose");
});

test("buildGitOpsAgentPrompt uses gitops system prompt", () => {
  const prompt = buildGitOpsAgentPrompt({
    accountId: "a",
    proposals: [],
    repo: "r/n",
  });
  assert.equal(prompt[0]!.content, GITOPS_AGENT_SYSTEM_PROMPT);
});

// ===========================================================================
// 8) Audit
// ===========================================================================

const dangerousProposal: MediaBuyerProposal = {
  hierarchy: "campaign",
  target: "cmp_42",
  category: "budget_increase",
  proposedChange: "+15%",
  rationale: "CTR uplift.",
};

test("runAuditAgent: 'dangerous' classification cannot pair with 'auto_approved'", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        classification: "dangerous",
        dangerousCategories: ["budget_increase"],
        findings: [
          {
            category: "budget_increase",
            proposalIndex: 0,
            reason: "+15% > 10%",
          },
        ],
        rationale: "Budget increase requires human approval.",
        decision: "auto_approved",
        confidence: 0.9,
      }),
  });
  const input: AuditAgentInput = {
    accountId: "act_1",
    proposals: [dangerousProposal],
    mode: "auto_apply",
    safeCategories: [],
  };
  const result = await runAuditAgent(baseCtx(provider), input);
  assert.equal(result.aiRunInput.status, "failed");
  assert.match(result.error ?? "", /fail-closed/);
});

test("runAuditAgent: dangerous => approval_required succeeds", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        classification: "dangerous",
        dangerousCategories: ["budget_increase"],
        findings: [
          { category: "budget_increase", proposalIndex: 0, reason: "+15%" },
        ],
        rationale: "Human merge required.",
        decision: "approval_required",
        confidence: 0.95,
      }),
  });
  const result = await runAuditAgent(baseCtx(provider), {
    accountId: "act_1",
    proposals: [dangerousProposal],
    mode: "auto_apply",
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.decision, "approval_required");
  assert.equal(result.aiRunInput.confidence, 0.95);
});

test("runAuditAgent: safe + auto_apply may auto_approve", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        classification: "safe",
        dangerousCategories: [],
        findings: [],
        rationale: "Pure copy update.",
        decision: "auto_approved",
        confidence: 0.6,
      }),
  });
  const result = await runAuditAgent(baseCtx(provider), {
    accountId: "act_1",
    proposals: [
      {
        hierarchy: "ad",
        target: "ad_1",
        category: "copy_update",
        proposedChange: "headline tweak",
        rationale: "+CTR",
      },
    ],
    mode: "auto_apply",
    safeCategories: ["copy_update"],
  });
  assert.equal(result.error, null);
  assert.equal(result.aiRunInput.decision, "auto_approved");
});

test("buildAuditAgentPrompt uses audit system prompt", () => {
  const prompt = buildAuditAgentPrompt({
    accountId: "a",
    proposals: [],
    mode: "proposal",
  });
  assert.equal(prompt[0]!.content, AUDIT_AGENT_SYSTEM_PROMPT);
});

// ===========================================================================
// linked ref propagation
// ===========================================================================

test("agent ai_run carries linkedRefType + linkedRefId from ctx", async () => {
  const provider = await connectedMockProvider({
    responder: () =>
      JSON.stringify({
        commentary: "x",
        deltas: {},
        topImprovements: [],
        decision: "report_only",
        confidence: 0.5,
      }),
  });
  const result = await runAnalystAgent(
    baseCtx(provider, {
      workflow: "daily_report",
      linkedRefType: "performance_snapshot",
      linkedRefId: "snap-99",
    }),
    {
      accountId: "act_1",
      periodStart: "2026-04-25",
      periodEnd: "2026-04-30",
      snapshotIds: ["snap-99"],
      current: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    },
  );
  assert.equal(result.aiRunInput.linkedRefType, "performance_snapshot");
  assert.equal(result.aiRunInput.linkedRefId, "snap-99");
});
