import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { LocalDiskStorage } from "@addroid/config";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import {
  fetchMetaAssetReadiness,
  META_GRAPH_API_VERSION,
  type MetaAssetIdentityCandidate,
} from "@addroid/meta-adapter";
import {
  DEFAULT_CREATIVE_QA_POLICY,
  extractJsonFromLlmContent,
  generateAndQaCreative,
  persistCreativeAssets,
  type CreativeQaPolicy,
  type ImageReferenceInput,
  type ImageProvider,
  type LLMProvider,
} from "@addroid/llm-provider";
import type {
  ImprovementPrCreativeGenerationContext,
  ImprovementPrCreativeNodeContext,
} from "@addroid/queue";
import { loadRecentPerformanceSnapshotContext } from "./improvement-pr-performance-context.js";
import { landingPageUrlForPrompt } from "./creative-landing-page-context.js";
import { enrichCreativeGenerationContext } from "./creative-generation-context.js";
import { selectImageProviderForWorker } from "./image-runtime.js";
import { buildPrismaMetaAdapterSelection } from "./meta-runtime.js";
import {
  createOpsChangeProposal,
  type OperationProposalAction,
} from "./ops-proposal-runtime.js";
import { runMetaAdsReadOnlyQuery } from "./meta-ads-readonly-runtime.js";

export type CreativeSubmissionSource =
  | "web"
  | "web-chat"
  | "cli-chat"
  | "slack-chat"
  | "discord-chat"
  | "agent-task";

export type CreativeSubmissionPlacementMode =
  | "existing_adset"
  | "new_adset"
  | "new_campaign";

export interface UploadedCreativeMedia {
  filename: string;
  bytes: Uint8Array;
  mimeType?: string | null;
}

export interface CreativeSubmissionInput {
  accountKey?: string;
  placementMode?: CreativeSubmissionPlacementMode;
  inheritFromCampaignId?: string;
  inheritFromAdsetId?: string;
  inheritFromAdId?: string;
  creativeName?: string;
  adName?: string;
  adNameExplicit?: boolean;
  prompt?: string;
  headline?: string;
  primaryText?: string;
  callToAction?: string;
  mediaType?: "image" | "video" | "carousel" | "text";
  localMediaPaths?: string[];
  uploadedMedia?: UploadedCreativeMedia[];
  referenceImagePaths?: string[];
  uploadedReferenceMedia?: UploadedCreativeMedia[];
  generateImage?: boolean;
  imagePlacement?: SubmissionImageProfileKey;
  imageAspectRatio?: SubmissionImageAspectRatio;
  pageId?: string;
  title?: string;
  body?: string;
  linkUrl?: string;
  description?: string;
  instagramUserId?: string;
  instagramActorId?: string;
  instagramAppLink?: string;
  objectStorySpec?: Record<string, unknown>;
  assetFeedSpec?: Record<string, unknown>;
  degreesOfFreedomSpec?: Record<string, unknown>;
  urlTags?: string;
  imageCrops?: Record<string, unknown>;
  platformCustomizations?: Record<string, unknown>;
  videoId?: string;
  thumbnailId?: string;
  templateUrlSpec?: Record<string, unknown>;
  productSetId?: string;
  destinationSetId?: string;
  authorizationCategory?: string;
  adDisclaimerSpec?: Record<string, unknown>;
  brandedContentSponsorPageId?: string;
  creativeGraphPayload?: Record<string, unknown>;
  images?: string[];
  videos?: string[];
  titles?: string[];
  bodies?: string[];
  descriptions?: string[];
  callToActions?: CreativeSubmissionInput["callToAction"][];
  campaignId?: string;
  adsetId?: string;
  campaignName?: string;
  campaignNameExplicit?: boolean;
  adsetName?: string;
  adsetNameExplicit?: boolean;
  objective?: string;
  /** Account-currency major units. */
  dailyBudget?: number;
  lifetimeBudget?: number;
  /** Account-currency major units. Defaults to dailyBudget for new campaigns. */
  campaignDailyBudget?: number;
  campaignLifetimeBudget?: number;
  /** Account-currency major units. Defaults to dailyBudget only when creating an adset under an existing campaign. */
  adsetDailyBudget?: number;
  adsetLifetimeBudget?: number;
  adsetBudgetSharing?: boolean;
  campaignBidStrategy?: string;
  campaignSpendCap?: number;
  campaignStartTime?: string;
  campaignStopTime?: string;
  specialAdCategoryCountry?: string[];
  isAdsetBudgetSharingEnabled?: boolean;
  campaignPacingType?: string[];
  smartPromotionType?: string;
  campaignPromotedObject?: Record<string, unknown>;
  campaignGraphPayload?: Record<string, unknown>;
  optimizationGoal?: string;
  optimizationSubEvent?: string;
  billingEvent?: string;
  adsetBidStrategy?: string;
  /** Account-currency major units. */
  bidAmount?: number;
  bidConstraints?: Record<string, unknown>;
  startTime?: string;
  endTime?: string;
  attributionSpec?: Array<Record<string, unknown>>;
  destinationType?: string;
  frequencyControlSpecs?: Array<Record<string, unknown>>;
  adsetSchedule?: Array<Record<string, unknown>>;
  adsetPacingType?: string[];
  dailySpendCap?: number;
  lifetimeSpendCap?: number;
  dailyMinSpendTarget?: number;
  lifetimeMinSpendTarget?: number;
  isDynamicCreative?: boolean;
  assetFeedId?: string;
  dsaBeneficiary?: string;
  dsaPayor?: string;
  regionalRegulatedCategories?: string[];
  adsetGraphPayload?: Record<string, unknown>;
  pixelId?: string;
  customEventType?:
    | "ADD_PAYMENT_INFO"
    | "ADD_TO_CART"
    | "ADD_TO_WISHLIST"
    | "COMPLETE_REGISTRATION"
    | "CONTACT"
    | "CONTENT_VIEW"
    | "CUSTOMIZE_PRODUCT"
    | "DONATE"
    | "FIND_LOCATION"
    | "INITIATED_CHECKOUT"
    | "LEAD"
    | "OTHER"
    | "PURCHASE"
    | "SCHEDULE"
    | "SEARCH"
    | "START_TRIAL"
    | "SUBMIT_APPLICATION"
    | "SUBSCRIBE";
  adPixelId?: string;
  conversionSpecs?: Record<string, unknown> | Array<Record<string, unknown>>;
  conversionDomain?: string;
  creativeAssetGroupsSpec?: Record<string, unknown>;
  engagementAudience?: boolean;
  priority?: number;
  displaySequence?: number;
  adScheduleStartTime?: string;
  adScheduleEndTime?: string;
  adGraphPayload?: Record<string, unknown>;
  trackingSpecs?: Record<string, unknown> | Array<Record<string, unknown>>;
  targeting?: Record<string, unknown>;
  geoLocations?: Record<string, unknown>;
  excludedGeoLocations?: Record<string, unknown>;
  publisherPlatforms?: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
  messengerPositions?: string[];
  audienceNetworkPositions?: string[];
  devicePlatforms?: string[];
  userDevice?: string[];
  userOs?: string[];
  genders?: number[];
  locales?: number[];
  customAudiences?: Array<Record<string, unknown>>;
  excludedCustomAudiences?: Array<Record<string, unknown>>;
  flexibleSpec?: Array<Record<string, unknown>>;
  exclusions?: Record<string, unknown>;
  behaviors?: Array<Record<string, unknown>>;
  lifeEvents?: Array<Record<string, unknown>>;
  targetingAutomation?: Record<string, unknown>;
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  rationale?: string;
  urgency?: "low" | "normal" | "high";
}

export interface CreativeSubmissionResult {
  prNumber: number;
  htmlUrl: string;
  pullRequestId: string;
  headSha: string;
  accountKey: string;
  creativeId: string;
  adId: string;
  mediaType: "image" | "video" | "carousel" | "text";
  storageKeys: string[];
  generatedImage: boolean;
  planOk: boolean;
  planSummary: string;
}

interface SubmissionImageProfile {
  variantKey: string;
  width: number;
  height: number;
  aspectRatio: SubmissionImageAspectRatio;
  reason: string;
}

export type SubmissionImageProfileKey =
  | "feed_square"
  | "feed_portrait"
  | "story_reels"
  | "feed_landscape";

export type SubmissionImageAspectRatio = "1:1" | "4:5" | "9:16" | "1.91:1";

interface SubmissionImageNormalizationReport {
  originalKey: string;
  normalizedKey: string;
  originalWidth: number | null;
  originalHeight: number | null;
  targetWidth: number;
  targetHeight: number;
  action: "resized" | "letterboxed" | "converted" | "skipped";
  reason: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const IMAGE_ASPECT_TOLERANCE = 0.025;
const IMAGE_PROFILES: Record<SubmissionImageProfileKey, SubmissionImageProfile> = {
  feed_square: {
    variantKey: "feed_square",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    reason: "Meta feed square creative",
  },
  feed_portrait: {
    variantKey: "feed_portrait",
    width: 1080,
    height: 1350,
    aspectRatio: "4:5",
    reason: "Meta feed portrait creative",
  },
  story_reels: {
    variantKey: "story_reels",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    reason: "Meta Stories/Reels creative",
  },
  feed_landscape: {
    variantKey: "feed_landscape",
    width: 1200,
    height: 628,
    aspectRatio: "1.91:1",
    reason: "Meta feed landscape creative",
  },
};
const DEFAULT_IMAGE_PROFILE = IMAGE_PROFILES.feed_square;
const COMMON_CREATIVE_CALL_TO_ACTIONS = new Set([
  "APPLY_NOW",
  "BOOK_TRAVEL",
  "BUY_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "GET_OFFER",
  "GET_QUOTE",
  "LEARN_MORE",
  "NO_BUTTON",
  "OPEN_LINK",
  "SHOP_NOW",
  "SIGN_UP",
  "SUBSCRIBE",
  "VIEW_INSTAGRAM_PROFILE",
  "WATCH_MORE",
]);
const DEFAULT_GENERATED_CTA = "LEARN_MORE";
const META_TEXT_RECOMMENDED_LIMITS = {
  primaryText: 125,
  headline: 40,
  description: 30,
} as const;

export interface CreativeGenerationInput {
  accountKey?: string;
  prompt?: string;
  creativeName?: string;
  linkUrl?: string;
  destinationUrl?: string;
  referenceImagePaths?: string[];
  uploadedReferenceMedia?: UploadedCreativeMedia[];
  variantCount?: number;
  imagePlacement?: SubmissionImageProfileKey;
  imageAspectRatio?: SubmissionImageAspectRatio;
}

export interface CreativeGenerationResult {
  accountKey: string;
  accountDisplayName: string;
  creativeIds: string[];
  generatedImage: boolean;
  provider: string | null;
  model: string | null;
  status: string;
  message: string;
}

export type CreativeGenerationSource = "web-chat" | "cli-chat" | "slack-chat" | "discord-chat" | "agent-task";
type ReferenceImageUsageMode = "abstract_visual_brief" | "direct_image_reference";

interface CreativeTextVariant {
  primaryText: string;
  headline: string;
  description: string;
  callToAction: string;
  rationale: string | null;
}

interface CreativeTextGenerationResult {
  source: "llm" | "fallback";
  variants: CreativeTextVariant[];
  error: string | null;
}

export function normalizeCreativeGenerationInput(args: Record<string, unknown>): CreativeGenerationInput {
  return {
    accountKey: readString(args.accountKey) ?? undefined,
    prompt: readString(args.prompt) ?? undefined,
    creativeName: readString(args.creativeName) ?? undefined,
    linkUrl: readString(args.linkUrl ?? args.destinationUrl) ?? undefined,
    destinationUrl: readString(args.destinationUrl) ?? undefined,
    referenceImagePaths: readStringArray(args.referenceImagePaths),
    variantCount: readPositiveInteger(args.variantCount) ?? undefined,
    imagePlacement: readImagePlacement(args.imagePlacement ?? args.placementProfile ?? args.placement) ?? undefined,
    imageAspectRatio: readImageAspectRatio(args.imageAspectRatio ?? args.aspectRatio) ?? undefined,
  };
}

export async function createStandaloneCreativeGeneration(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  input: CreativeGenerationInput;
  actor: string;
  source: CreativeGenerationSource;
  env?: NodeJS.ProcessEnv;
  imageProvider?: ImageProvider | null;
  llmProvider?: LLMProvider | null;
  creativeQaPolicy?: CreativeQaPolicy | null;
}): Promise<CreativeGenerationResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      defaultAdAccount: {
        select: { id: true, key: true, displayName: true, currency: true, timezoneName: true },
      },
    },
  });
  const accountKey = readAccountKey(
    { accountKey: opts.input.accountKey },
    workspace?.defaultAdAccount?.key ?? null
  );
  const account = await opts.prisma.adAccount.findUnique({
    where: { workspaceId_key: { workspaceId: opts.workspaceId, key: accountKey } },
    select: { id: true, key: true, displayName: true, currency: true, timezoneName: true, metaAccountId: true },
  });
  if (!account) {
    throw new Error(`広告アカウント ${accountKey} が登録されていません。先に account sync/select を完了してください。`);
  }
  const userPrompt = opts.input.prompt?.trim();
  if (!userPrompt) throw new Error("生成したいクリエイティブの意図を入力してください。");

  const storage = new LocalDiskStorage({ env });
  await storage.ensureRoot();
  const creativeContext = await loadCreativeContextForSubmission(opts.prisma, {
    accountId: account.id,
    timeZone: account.timezoneName ?? workspace?.defaultAdAccount?.timezoneName ?? "UTC",
  });
  const userReferenceImages = await loadSubmissionReferenceImages({
    referenceImagePaths: opts.input.referenceImagePaths,
    uploadedReferenceMedia: opts.input.uploadedReferenceMedia,
  });
  const enrichedContext = await enrichCreativeGenerationContext({
    provider: opts.llmProvider ?? null,
    storage,
    creativeContext,
    userReferenceImages,
    explicitUrls: [
      { label: "requested landing page", url: opts.input.linkUrl },
      { label: "requested destination URL", url: opts.input.destinationUrl },
    ],
  });
  const referenceImages = enrichedContext.referenceImages;
  const referenceImageUsageMode = referenceImageUsageModeForPrompt(userPrompt);
  const generationReferenceImages =
    referenceImageUsageMode === "direct_image_reference" ? referenceImages : [];
  const creativeContextWithLanding = enrichedContext.creativeContext;
  const variantCount = Math.max(1, Math.min(4, opts.input.variantCount ?? 3));
  const generatedText = await generateCreativeTextVariants({
    provider: opts.llmProvider ?? null,
    prompt: userPrompt,
    accountDisplayName: account.displayName || accountKey,
    linkUrl: opts.input.linkUrl ?? opts.input.destinationUrl,
    creativeContext: creativeContextWithLanding,
    variantCount,
  });
  const firstText = generatedText.variants[0];
  const contextualPrompt = buildCreativeSubmissionImagePrompt({
    input: {
      prompt: userPrompt,
      creativeName: opts.input.creativeName,
      headline: firstText?.headline,
      primaryText: firstText?.primaryText,
      description: firstText?.description,
      callToAction: firstText?.callToAction,
      linkUrl: opts.input.linkUrl ?? opts.input.destinationUrl,
      mediaType: "image",
      generateImage: true,
      referenceImagePaths: opts.input.referenceImagePaths,
      uploadedReferenceMedia: opts.input.uploadedReferenceMedia,
    },
    accountKey,
    accountDisplayName: account.displayName || accountKey,
    accountCurrency: account.currency ?? workspace?.defaultAdAccount?.currency ?? null,
    creativeContext: creativeContextWithLanding,
    referenceImageUsageMode,
  });
  if (!contextualPrompt) throw new Error("画像生成プロンプトを作成できませんでした。");

  const llmConnection = opts.llmProvider
    ? await opts.llmProvider.getConnection().catch(() => null)
    : null;
  const selected =
    opts.imageProvider ??
    (await selectImageProviderForWorker(env, {
      prisma: opts.prisma,
      preferCodex: llmConnection?.provider === "codex",
    })).provider;
  const imageProfiles = selectStandaloneImageProfiles({
    input: opts.input,
    creativeContext: creativeContextWithLanding,
    count: variantCount,
  });
  const variationConditions = imageProfiles.map((profile, i) => ({
    width: profile.width,
    height: profile.height,
    format: "png" as const,
    variantKey: `${profile.variantKey}_${i}`,
    styleNotes: `Compose for ${profile.aspectRatio} ${profile.reason}. Keep important subjects away from edge safe areas.`,
  }));
  const now = new Date();
  const imageRun = await opts.prisma.aiRun.create({
    data: {
      workspaceId: opts.workspaceId,
      agent: "image_prompt",
      workflow: "creative_generation",
      provider: llmConnection?.provider ?? "local",
      model: llmConnection?.defaultModel ?? "rule",
      status: "succeeded",
      prompt: { prompt: userPrompt } as Prisma.InputJsonValue,
      inputs: {
        source: opts.source,
        accountKey,
        referenceImageCount: referenceImages.length,
        generationReferenceImageCount: generationReferenceImages.length,
        referenceImageUsageMode,
        creativeContext: creativeContextToMetadata(creativeContextWithLanding),
      } as Prisma.InputJsonValue,
      outputs: {
        prompt: contextualPrompt,
        variantCount,
        generatedText,
        metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
      } as unknown as Prisma.InputJsonValue,
      decision: "generate",
      startedAt: now,
      finishedAt: now,
    },
    select: { id: true },
  });
  const generated = await generateAndQaCreative({
    provider: selected,
    request: {
      prompt: contextualPrompt,
      purpose: `creative_generation:${opts.source}`,
      referenceImages: generationReferenceImages,
      variationConditions,
    },
    variants: variationConditions.map((condition) => ({
      variantKey: condition.variantKey,
      prompt: contextualPrompt,
      negativePrompt: "",
      styleNotes: "",
      width: condition.width,
      height: condition.height,
      format: condition.format,
    })),
    policy: opts.creativeQaPolicy ?? DEFAULT_CREATIVE_QA_POLICY,
  });
  const qaRun = await opts.prisma.aiRun.create({
    data: {
      workspaceId: opts.workspaceId,
      agent: "creative_qa",
      workflow: "creative_generation",
      provider: "local",
      model: "deterministic",
      status: generated.qa ? "succeeded" : "failed",
      prompt: Prisma.JsonNull,
      inputs: {
        imagePromptAiRunId: imageRun.id,
        referenceImageCount: referenceImages.length,
        generationReferenceImageCount: generationReferenceImages.length,
        referenceImageUsageMode,
      } as Prisma.InputJsonValue,
      outputs: generated.qa
        ? (generated.qa as unknown as Prisma.InputJsonValue)
        : ({ providerError: generated.providerError, outcome: generated.outcome } as Prisma.InputJsonValue),
      decision: generated.outcome,
      errorMessage: generated.providerError,
      startedAt: now,
      finishedAt: new Date(),
    },
    select: { id: true },
  });

  if (!generated.generation || !generated.qa) {
    const textVariant = generatedText.variants[0] ?? fallbackCreativeTextVariant(userPrompt, account.displayName || accountKey);
    const created = await opts.prisma.creative.create({
      data: {
        accountId: account.id,
        hierarchyId: creativeContextWithLanding?.target?.hierarchyId ?? null,
        aiRunId: imageRun.id,
        creativeQaAiRunId: qaRun.id,
        key: `image_${imageRun.id}_fallback`,
        displayName: opts.input.creativeName || "Chat generated creative prompt",
        mediaType: "image",
        status: "fallback_text_only",
        prompt: contextualPrompt,
        provider: null,
        model: null,
        parameters: {
          source: opts.source,
          referenceImageCount: referenceImages.length,
          generationReferenceImageCount: generationReferenceImages.length,
          referenceImageUsageMode,
          providerError: generated.providerError,
          creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        } as unknown as Prisma.InputJsonValue,
        spec: {
          prompt: contextualPrompt,
          adText: textVariant,
          textVariants: generatedText.variants,
          metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
          rationale: userPrompt,
          qa: {
            aiRunId: qaRun.id,
            recommendation: "fallback_text_only",
            issues: [],
            rationale: generated.providerError,
          },
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await opts.prisma.auditLog.create({
      data: {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        action: "creative.generated_via_web_chat",
        target: `creative:${created.id}`,
        metadata: {
          source: opts.source,
          accountKey,
          creativeIds: [created.id],
          generatedImage: false,
          referenceImageCount: referenceImages.length,
          generationReferenceImageCount: generationReferenceImages.length,
          referenceImageUsageMode,
        } as Prisma.InputJsonValue,
      },
    });
    return {
      accountKey,
      accountDisplayName: account.displayName || accountKey,
      creativeIds: [created.id],
      generatedImage: false,
      provider: null,
      model: null,
      status: "fallback_text_only",
      message: "画像 Provider が利用できないため、生成プロンプトのみ creatives に保存しました。",
    };
  }

  const persisted = await persistCreativeAssets({
    storage,
    accountKey,
    creativeId: `imgrun_${imageRun.id}`,
    generation: generated.generation,
    qa: generated.qa,
    links: { imagePromptAiRunId: imageRun.id, creativeQaAiRunId: qaRun.id },
  });
  const assetByKey = new Map(persisted.assets.map((asset) => [asset.variantKey, asset]));
  const creativeIds: string[] = [];
  for (let i = 0; i < variationConditions.length; i += 1) {
    const condition = variationConditions[i]!;
    const asset = assetByKey.get(condition.variantKey) ?? null;
    const textVariant = generatedText.variants[i] ?? generatedText.variants[0] ?? fallbackCreativeTextVariant(userPrompt, account.displayName || accountKey);
    const created = await opts.prisma.creative.create({
      data: {
        accountId: account.id,
        hierarchyId: creativeContextWithLanding?.target?.hierarchyId ?? null,
        aiRunId: imageRun.id,
        creativeQaAiRunId: qaRun.id,
        key: `image_${imageRun.id}_v${i + 1}`,
        displayName: opts.input.creativeName || `Chat image variant ${i + 1}`,
        mediaType: "image",
        status: asset?.qaOverall ?? "qa_warned",
        prompt: contextualPrompt,
        provider: generated.generation.meta.provider,
        model: generated.generation.meta.model,
        parameters: ({
          ...generated.generation.meta.parameters,
          source: opts.source,
          referenceImageCount: referenceImages.length,
          generationReferenceImageCount: generationReferenceImages.length,
          referenceImageUsageMode,
          creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        } as unknown) as Prisma.InputJsonValue,
        storagePath: asset?.storageKey ?? null,
        storageRef: asset ? persisted.baseStorageRef : null,
        spec: {
          prompt: contextualPrompt,
          adText: textVariant,
          textVariants: generatedText.variants,
          metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
          negativePrompt: null,
          styleNotes: `Generated from ${opts.source} references and account creative context.`,
          rationale: userPrompt,
          variantIndex: i,
          qa: {
            aiRunId: qaRun.id,
            recommendation: generated.qa.overall,
            issues: generated.qa.assets.flatMap((qaAsset) =>
              qaAsset.checks
                .filter((check) => check.outcome !== "pass")
                .map((check) => ({
                  severity: check.severity,
                  category: check.kind,
                  message: check.detail,
                }))
            ),
            rationale: generated.qa.overall,
          },
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    creativeIds.push(created.id);
  }
  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "creative.generated_via_web_chat",
      target: `creative:${creativeIds[0] ?? imageRun.id}`,
      metadata: {
        source: opts.source,
        accountKey,
        creativeIds,
        generatedImage: true,
        referenceImageCount: referenceImages.length,
        generationReferenceImageCount: generationReferenceImages.length,
        referenceImageUsageMode,
        provider: generated.generation.meta.provider,
        model: generated.generation.meta.model,
      } as Prisma.InputJsonValue,
    },
  });
  return {
    accountKey,
    accountDisplayName: account.displayName || accountKey,
    creativeIds,
    generatedImage: true,
    provider: generated.generation.meta.provider,
    model: generated.generation.meta.model,
    status: generated.qa.overall,
    message: `${creativeIds.length} 件の生成クリエイティブ画像と広告テキスト案を /creatives に保存しました。`,
  };
}

export async function createCreativeSubmissionProposal(opts: {
  prisma: PrismaClient;
  githubAdapter: GithubAdapter;
  workspaceId: string;
  input: CreativeSubmissionInput;
  actor: string;
  source: CreativeSubmissionSource;
  env?: NodeJS.ProcessEnv;
  imageProvider?: ImageProvider | null;
  llmProvider?: LLMProvider | null;
  creativeQaPolicy?: CreativeQaPolicy | null;
}): Promise<CreativeSubmissionResult> {
  const env = opts.env ?? process.env;
  const workspace = await opts.prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: {
      opsRepoId: true,
      defaultAdAccount: {
        select: { id: true, key: true, displayName: true, currency: true, timezoneName: true },
      },
    },
  });
  if (!workspace?.opsRepoId) {
    throw new Error("ops repo が未接続です。GitHub 接続と ops repo bootstrap を完了してください。");
  }
  const repo = await opts.prisma.githubRepo.findUnique({
    where: { id: workspace.opsRepoId },
    select: { id: true, owner: true, name: true, defaultBranch: true },
  });
  if (!repo) throw new Error(`ops repo ${workspace.opsRepoId} が github_repos に見つかりません。`);

  const accountKey = readAccountKey(opts.input, workspace.defaultAdAccount?.key ?? null);
  const account = await opts.prisma.adAccount.findUnique({
    where: { workspaceId_key: { workspaceId: opts.workspaceId, key: accountKey } },
    select: {
      id: true,
      key: true,
      displayName: true,
      currency: true,
      timezoneName: true,
      metaAccountId: true,
    },
  });
  if (!account) {
    throw new Error(`広告アカウント ${accountKey} が登録されていません。先に account sync/select を完了してください。`);
  }

  const draftState: Record<string, unknown> = { creatives: [], campaigns: [] };

  const normalized = { ...opts.input };
  normalizeSubmissionPlacementIntent(normalized);
  applyAddroidSubmissionNamePolicy(normalized, {
    source: opts.source,
    timeZone: account.timezoneName ?? workspace.defaultAdAccount?.timezoneName ?? "UTC",
    now: new Date(),
  });
  validateCreativeSubmissionInput(normalized);
  await applyInheritedPlacementSettings({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    accountId: account.id,
    accountKey,
    env,
    input: normalized,
  });
  await inferCreativeIdentity({
    prisma: opts.prisma,
    accountKey,
    adAccountId: account.metaAccountId ?? account.key,
    state: draftState,
    input: normalized,
  });
  await inferInstagramActorIdForCli({
    prisma: opts.prisma,
    adAccountId: account.metaAccountId ?? account.key,
    input: normalized,
  });
  normalizeCallToActionForDestination(normalized);
  validateCreativeSubmissionInput(normalized);
  const draftId = makeStableId(normalized.creativeName || normalized.adName || normalized.headline || "creative");
  const creativeId = uniqueId(ensureArray(draftState, "creatives"), draftId);
  const adId = uniqueNestedAdId(draftState, makeStableId(normalized.adName || normalized.creativeName || "ad"));
  const storage = new LocalDiskStorage({ env });
  await storage.ensureRoot();
  const creativeContext = await loadCreativeContextForSubmission(opts.prisma, {
    accountId: account.id,
    timeZone: account.timezoneName ?? workspace.defaultAdAccount?.timezoneName ?? "UTC",
  });
  const userReferenceImages = await loadSubmissionReferenceImages(normalized);
  const enrichedContext = await enrichCreativeGenerationContext({
    provider: opts.llmProvider ?? null,
    storage,
    creativeContext,
    userReferenceImages,
    explicitUrls: [{ label: "requested landing page", url: normalized.linkUrl }],
  });
  const referenceImages = enrichedContext.referenceImages;
  const referenceImageUsageMode = referenceImageUsageModeForPrompt(normalized.prompt);
  const generationReferenceImages =
    referenceImageUsageMode === "direct_image_reference" ? referenceImages : [];
  const creativeContextWithLanding = enrichedContext.creativeContext;
  const generatedSubmissionText =
    normalized.prompt && needsGeneratedCreativeText(normalized)
      ? await generateCreativeTextVariants({
          provider: opts.llmProvider ?? null,
          prompt: normalized.prompt,
          accountDisplayName: account.displayName || accountKey,
          linkUrl: normalized.linkUrl,
          creativeContext: creativeContextWithLanding,
          variantCount: 3,
        })
      : null;
  if (generatedSubmissionText) {
    applyGeneratedTextToSubmissionInput(normalized, generatedSubmissionText.variants[0]);
    normalizeCallToActionForDestination(normalized);
  }
  const llmConnection = opts.llmProvider
    ? await opts.llmProvider.getConnection().catch(() => null)
    : null;

  const preparedMedia = await prepareMedia({
    input: normalized,
    accountKey,
    accountDisplayName: account.displayName || accountKey,
    accountCurrency: account.currency ?? workspace.defaultAdAccount?.currency ?? null,
    creativeId,
    storage,
    prisma: opts.prisma,
    env,
    imageProvider: opts.imageProvider ?? null,
    creativeQaPolicy: opts.creativeQaPolicy ?? null,
    creativeContext: creativeContextWithLanding,
    referenceImages: generationReferenceImages,
    referenceImageUsageMode,
    preferCodexImageProvider: llmConnection?.provider === "codex",
  });

  const mediaType = preparedMedia.mediaType;
  const creative = removeUndefined({
    id: creativeId,
    name: normalized.creativeName || normalized.adName || normalized.headline || creativeId,
    mediaType,
    headline: normalized.headline,
    primaryText: normalized.primaryText || normalized.prompt,
    callToAction: normalized.callToAction,
    pageId: normalized.pageId,
    title: normalized.title,
    body: normalized.body,
    linkUrl: normalized.linkUrl,
    description: normalized.description,
    instagramUserId: normalized.instagramUserId,
    instagramActorId: normalized.instagramActorId,
    images: normalized.images,
    videos: normalized.videos,
    titles: normalized.titles,
    bodies: normalized.bodies,
    descriptions: normalized.descriptions,
    callToActions: normalized.callToActions,
    storageKey: preparedMedia.storageKeys[0],
  });
  ensureArray(draftState, "creatives").push(creative);
  const placement = placeAdDraft(draftState, {
    input: normalized,
    creativeId,
    adId,
  });

  const operations = buildCreativeSubmissionOperations({
    input: normalized,
    accountKey,
    accountCurrency: account.currency ?? workspace.defaultAdAccount?.currency ?? "USD",
    creativeId,
    adId,
    placement,
    creative,
    preparedStorageKeys: preparedMedia.storageKeys,
    storage,
  });
  validateSubmissionActionGraph(normalized, operations);
  const proposal = await createOpsChangeProposal({
    prisma: opts.prisma,
    githubAdapter: opts.githubAdapter,
    workspaceId: opts.workspaceId,
    input: {
      intent: "other",
      accountKey,
      operations,
      rationale: normalized.rationale ?? "Creative submission from AdDroid.",
      urgency: normalized.urgency ?? "normal",
    },
    actor: opts.actor,
    source: opts.source,
    env,
  });
  const prRow = { id: proposal.pullRequestId };

  await opts.prisma.creative.create({
    data: {
      accountId: account.id,
      pullRequestId: prRow.id,
      key: `evidence/creatives/${accountKey}/${creativeId}`,
      displayName: String(creative.name),
      mediaType,
      status: "attached_to_pr",
      prompt: normalized.prompt ?? null,
      provider: preparedMedia.provider,
      model: preparedMedia.model,
      parameters: {
        source: opts.source,
        proposalSource: "creative_submission",
        generatedImage: preparedMedia.generatedImage,
        imageNormalization: preparedMedia.imageNormalization,
        creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        localMediaCount: (normalized.localMediaPaths?.length ?? 0) + (normalized.uploadedMedia?.length ?? 0),
      } as unknown as Prisma.InputJsonValue,
      storagePath: preparedMedia.storageKeys[0] ?? null,
      storageRef: preparedMedia.storageKeys[0] ? `storage://${preparedMedia.storageKeys[0]}` : null,
      spec: {
        adText: generatedSubmissionText?.variants[0] ?? creativeTextVariantFromSubmissionInput(normalized),
        metaTextRecommendations: META_TEXT_RECOMMENDED_LIMITS,
        rationale: normalized.rationale ?? null,
      } as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  await opts.prisma.auditLog.create({
    data: {
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      action: "creative_submission.pr_opened",
      target: `github_pull_request:${prRow.id}`,
      ref: String(proposal.prNumber),
      metadata: {
        source: opts.source,
        accountKey,
        creativeId,
        adId,
        mediaType,
        storageKeyCount: preparedMedia.storageKeys.length,
        generatedImage: preparedMedia.generatedImage,
        imageNormalization: preparedMedia.imageNormalization,
        creativeContext: creativeContextToMetadata(creativeContextWithLanding),
        planSummary: proposal.planSummary,
      } as unknown as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return {
    prNumber: proposal.prNumber,
    htmlUrl: proposal.htmlUrl,
    pullRequestId: prRow.id,
    headSha: proposal.headSha,
    accountKey,
    creativeId,
    adId,
    mediaType,
    storageKeys: preparedMedia.storageKeys,
    generatedImage: preparedMedia.generatedImage,
    planOk: proposal.planOk,
    planSummary: proposal.planSummary,
  };
}

export function normalizeCreativeSubmissionInput(args: Record<string, unknown>): CreativeSubmissionInput {
  const input: CreativeSubmissionInput = {
    accountKey: readString(args.accountKey) ?? undefined,
    placementMode: readPlacementMode(args.placementMode ?? args.placement_mode ?? args.submissionPlacementMode) ?? undefined,
    inheritFromCampaignId: readString(
      args.inheritFromCampaignId ?? args.inherit_from_campaign_id ?? args.sourceCampaignId ?? args.source_campaign_id
    ) ?? undefined,
    inheritFromAdsetId: readString(
      args.inheritFromAdsetId ?? args.inherit_from_adset_id ?? args.sourceAdsetId ?? args.source_adset_id
    ) ?? undefined,
    inheritFromAdId: readString(
      args.inheritFromAdId ?? args.inherit_from_ad_id ?? args.sourceAdId ?? args.source_ad_id ?? args.existingAdId ?? args.existing_ad_id
    ) ?? undefined,
    creativeName: readString(args.creativeName) ?? undefined,
    adName: readString(args.adName) ?? undefined,
    adNameExplicit: readBoolean(args.adNameExplicit ?? args.ad_name_explicit ?? args.preserveAdName ?? args.preserve_ad_name) ?? undefined,
    prompt: readString(args.prompt) ?? undefined,
    headline: readString(args.headline) ?? undefined,
    primaryText: readString(args.primaryText) ?? undefined,
    callToAction: readCallToAction(args.callToAction) ?? undefined,
    mediaType: readMediaType(args.mediaType) ?? undefined,
    localMediaPaths: readStringArray(args.localMediaPaths),
    referenceImagePaths: readStringArray(args.referenceImagePaths),
    generateImage: args.generateImage === true,
    pageId: readString(args.pageId) ?? undefined,
    title: readString(args.title) ?? undefined,
    body: readString(args.body) ?? undefined,
    linkUrl: readString(args.linkUrl ?? args.destinationUrl) ?? undefined,
    description: readString(args.description) ?? undefined,
    instagramUserId: readString(args.instagramUserId) ?? undefined,
    instagramActorId: readString(args.instagramActorId) ?? undefined,
    instagramAppLink: readString(args.instagramAppLink) ?? undefined,
    objectStorySpec: readRecord(args.objectStorySpec ?? args.object_story_spec) ?? undefined,
    assetFeedSpec: readRecord(args.assetFeedSpec ?? args.asset_feed_spec) ?? undefined,
    degreesOfFreedomSpec: readRecord(args.degreesOfFreedomSpec ?? args.degrees_of_freedom_spec) ?? undefined,
    urlTags: readString(args.urlTags ?? args.url_tags) ?? undefined,
    imageCrops: readRecord(args.imageCrops ?? args.image_crops) ?? undefined,
    platformCustomizations: readRecord(args.platformCustomizations ?? args.platform_customizations) ?? undefined,
    videoId: readString(args.videoId ?? args.video_id) ?? undefined,
    thumbnailId: readString(args.thumbnailId ?? args.thumbnail_id) ?? undefined,
    templateUrlSpec: readRecord(args.templateUrlSpec ?? args.template_url_spec) ?? undefined,
    productSetId: readString(args.productSetId ?? args.product_set_id) ?? undefined,
    destinationSetId: readString(args.destinationSetId ?? args.destination_set_id) ?? undefined,
    authorizationCategory: readString(args.authorizationCategory ?? args.authorization_category) ?? undefined,
    adDisclaimerSpec: readRecord(args.adDisclaimerSpec ?? args.ad_disclaimer_spec) ?? undefined,
    brandedContentSponsorPageId: readString(args.brandedContentSponsorPageId ?? args.branded_content_sponsor_page_id) ?? undefined,
    creativeGraphPayload: readRecord(args.creativeGraphPayload ?? args.creative_graph_payload ?? args.graphPayload ?? args.graph_payload) ?? undefined,
    images: readStringArray(args.images),
    videos: readStringArray(args.videos),
    titles: readStringArray(args.titles),
    bodies: readStringArray(args.bodies),
    descriptions: readStringArray(args.descriptions),
    callToActions: readCallToActionArray(args.callToActions),
    campaignId: readString(args.campaignId) ?? undefined,
    adsetId: readString(args.adsetId) ?? undefined,
    campaignName: readString(args.campaignName) ?? undefined,
    campaignNameExplicit: readBoolean(args.campaignNameExplicit ?? args.campaign_name_explicit ?? args.preserveCampaignName ?? args.preserve_campaign_name) ?? undefined,
    adsetName: readString(args.adsetName) ?? undefined,
    adsetNameExplicit: readBoolean(args.adsetNameExplicit ?? args.adset_name_explicit ?? args.preserveAdsetName ?? args.preserve_adset_name) ?? undefined,
    objective: readObjective(args.objective) ?? undefined,
    dailyBudget: readNumber(args.dailyBudget) ?? undefined,
    lifetimeBudget: readNumber(args.lifetimeBudget) ?? undefined,
    campaignDailyBudget: readNumber(args.campaignDailyBudget ?? args.campaign_daily_budget) ?? undefined,
    campaignLifetimeBudget: readNumber(args.campaignLifetimeBudget ?? args.campaign_lifetime_budget) ?? undefined,
    adsetDailyBudget: readNumber(args.adsetDailyBudget ?? args.adset_daily_budget) ?? undefined,
    adsetLifetimeBudget: readNumber(args.adsetLifetimeBudget ?? args.adset_lifetime_budget) ?? undefined,
    adsetBudgetSharing: readBoolean(args.adsetBudgetSharing) ?? undefined,
    campaignBidStrategy: readMetaEnumToken(args.campaignBidStrategy ?? args.campaign_bid_strategy) ?? undefined,
    campaignSpendCap: readNumber(args.campaignSpendCap ?? args.campaign_spend_cap) ?? undefined,
    campaignStartTime: readString(args.campaignStartTime ?? args.campaign_start_time) ?? undefined,
    campaignStopTime: readString(args.campaignStopTime ?? args.campaign_stop_time) ?? undefined,
    specialAdCategoryCountry: readCountries(args.specialAdCategoryCountry ?? args.special_ad_category_country),
    isAdsetBudgetSharingEnabled: readBoolean(args.isAdsetBudgetSharingEnabled ?? args.is_adset_budget_sharing_enabled) ?? undefined,
    campaignPacingType: readStringArray(args.campaignPacingType ?? args.campaign_pacing_type),
    smartPromotionType: readMetaEnumToken(args.smartPromotionType ?? args.smart_promotion_type) ?? undefined,
    campaignPromotedObject: readRecord(args.campaignPromotedObject ?? args.campaign_promoted_object) ?? undefined,
    campaignGraphPayload: readRecord(args.campaignGraphPayload ?? args.campaign_graph_payload) ?? undefined,
    optimizationGoal: readOptimizationGoal(args.optimizationGoal) ?? undefined,
    optimizationSubEvent: readMetaEnumToken(args.optimizationSubEvent ?? args.optimization_sub_event) ?? undefined,
    billingEvent: readBillingEvent(args.billingEvent) ?? undefined,
    adsetBidStrategy: readMetaEnumToken(args.adsetBidStrategy ?? args.adset_bid_strategy ?? args.bidStrategy ?? args.bid_strategy) ?? undefined,
    bidAmount: readNumber(args.bidAmount) ?? undefined,
    bidConstraints: readRecord(args.bidConstraints ?? args.bid_constraints) ?? undefined,
    startTime: readString(args.startTime) ?? undefined,
    endTime: readString(args.endTime) ?? undefined,
    attributionSpec: readRecordArray(args.attributionSpec ?? args.attribution_spec),
    destinationType: readMetaEnumToken(args.destinationType ?? args.destination_type) ?? undefined,
    frequencyControlSpecs: readRecordArray(args.frequencyControlSpecs ?? args.frequency_control_specs),
    adsetSchedule: readRecordArray(args.adsetSchedule ?? args.adset_schedule),
    adsetPacingType: readStringArray(args.adsetPacingType ?? args.adset_pacing_type),
    dailySpendCap: readNumber(args.dailySpendCap ?? args.daily_spend_cap) ?? undefined,
    lifetimeSpendCap: readNumber(args.lifetimeSpendCap ?? args.lifetime_spend_cap) ?? undefined,
    dailyMinSpendTarget: readNumber(args.dailyMinSpendTarget ?? args.daily_min_spend_target) ?? undefined,
    lifetimeMinSpendTarget: readNumber(args.lifetimeMinSpendTarget ?? args.lifetime_min_spend_target) ?? undefined,
    isDynamicCreative: readBoolean(args.isDynamicCreative ?? args.is_dynamic_creative) ?? undefined,
    assetFeedId: readString(args.assetFeedId ?? args.asset_feed_id) ?? undefined,
    dsaBeneficiary: readString(args.dsaBeneficiary ?? args.dsa_beneficiary) ?? undefined,
    dsaPayor: readString(args.dsaPayor ?? args.dsa_payor) ?? undefined,
    regionalRegulatedCategories: readStringArray(args.regionalRegulatedCategories ?? args.regional_regulated_categories),
    adsetGraphPayload: readRecord(args.adsetGraphPayload ?? args.adset_graph_payload) ?? undefined,
    pixelId: readString(args.pixelId) ?? undefined,
    customEventType: readCustomEventType(args.customEventType) ?? undefined,
    adPixelId: readString(args.adPixelId) ?? undefined,
    conversionSpecs: readRecord(args.conversionSpecs ?? args.conversion_specs) ?? readRecordArray(args.conversionSpecs ?? args.conversion_specs) ?? undefined,
    conversionDomain: readString(args.conversionDomain ?? args.conversion_domain) ?? undefined,
    creativeAssetGroupsSpec: readRecord(args.creativeAssetGroupsSpec ?? args.creative_asset_groups_spec) ?? undefined,
    engagementAudience: readBoolean(args.engagementAudience ?? args.engagement_audience) ?? undefined,
    priority: readNumber(args.priority) ?? undefined,
    displaySequence: readInteger(args.displaySequence ?? args.display_sequence) ?? undefined,
    adScheduleStartTime: readString(args.adScheduleStartTime ?? args.ad_schedule_start_time) ?? undefined,
    adScheduleEndTime: readString(args.adScheduleEndTime ?? args.ad_schedule_end_time) ?? undefined,
    adGraphPayload: readRecord(args.adGraphPayload ?? args.ad_graph_payload) ?? undefined,
    trackingSpecs: readRecord(args.trackingSpecs ?? args.tracking_specs) ?? readRecordArray(args.trackingSpecs ?? args.tracking_specs) ?? undefined,
    targeting: readRecord(args.targeting) ?? undefined,
    geoLocations: readRecord(args.geoLocations ?? args.geo_locations) ?? undefined,
    excludedGeoLocations: readRecord(args.excludedGeoLocations ?? args.excluded_geo_locations) ?? undefined,
    publisherPlatforms: readStringArray(args.publisherPlatforms ?? args.publisher_platforms),
    facebookPositions: readStringArray(args.facebookPositions ?? args.facebook_positions),
    instagramPositions: readStringArray(args.instagramPositions ?? args.instagram_positions),
    messengerPositions: readStringArray(args.messengerPositions ?? args.messenger_positions),
    audienceNetworkPositions: readStringArray(args.audienceNetworkPositions ?? args.audience_network_positions),
    devicePlatforms: readStringArray(args.devicePlatforms ?? args.device_platforms),
    userDevice: readStringArray(args.userDevice ?? args.user_device),
    userOs: readStringArray(args.userOs ?? args.user_os),
    genders: readIntegerArray(args.genders),
    locales: readIntegerArray(args.locales),
    customAudiences: readRecordArray(args.customAudiences ?? args.custom_audiences),
    excludedCustomAudiences: readRecordArray(args.excludedCustomAudiences ?? args.excluded_custom_audiences),
    flexibleSpec: readRecordArray(args.flexibleSpec ?? args.flexible_spec),
    exclusions: readRecord(args.exclusions) ?? undefined,
    behaviors: readRecordArray(args.behaviors),
    lifeEvents: readRecordArray(args.lifeEvents ?? args.life_events),
    targetingAutomation: readRecord(args.targetingAutomation ?? args.targeting_automation) ?? undefined,
    countries: readCountries(args.countries),
    ageMin: readInteger(args.ageMin) ?? undefined,
    ageMax: readInteger(args.ageMax) ?? undefined,
    imagePlacement: readImagePlacement(args.imagePlacement ?? args.placementProfile ?? args.placement) ?? undefined,
    imageAspectRatio: readImageAspectRatio(args.imageAspectRatio ?? args.aspectRatio) ?? undefined,
    rationale: readString(args.rationale) ?? undefined,
    urgency: readUrgency(args.urgency) ?? undefined,
  };
  normalizeSubmissionPlacementIntent(input);
  validateCreativeSubmissionInput(input);
  return input;
}

function validateCreativeSubmissionInput(input: CreativeSubmissionInput): void {
  if (!input.headline && !input.primaryText && !input.prompt) {
    throw new Error("見出し、本文、または生成プロンプトのいずれかが必要です。");
  }
  if (requiresDestinationUrlForCurrentCreativeApply(input) && !input.linkUrl) {
    throw new Error(
      "現在の Graph API 入稿ではリンク広告として作成するため、linkUrl または destinationUrl が必要です。キャンペーン種別ではなく、入稿するクリエイティブ形式に対する必須項目です。"
    );
  }
  if (input.campaignId) {
    if (input.adsetId) {
      return;
    }
    if (input.placementMode === "new_adset") {
      return;
    }
    if (!input.adsetName) {
      throw new Error(
        "既存キャンペーン配下に入稿する場合は、既存広告セットへ入れるなら adsetId、新しい広告セットを作るなら adsetName が必要です。"
      );
    }
    return;
  }
  if (input.adsetId) {
    throw new Error("adsetId を指定する場合は campaignId も必要です。");
  }
  if (
    !input.objective ||
    !hasAnySubmissionBudget(input)
  ) {
    throw new Error(
      "新規キャンペーンから入稿するには campaignName、adsetName、objective、dailyBudget または lifetimeBudget が必要です。予算は広告アカウント通貨の金額で指定してください。既存キャンペーン配下に入れる場合は campaignId と adsetName、既存広告セットに入れる場合は campaignId と adsetId を指定してください。"
    );
  }
}

function normalizeSubmissionPlacementIntent(input: CreativeSubmissionInput): void {
  const mode = input.placementMode ?? inferPlacementMode(input);
  if (!mode) return;
  input.placementMode = mode;

  if (mode === "new_campaign") {
    if (input.campaignId && !input.inheritFromCampaignId) {
      input.inheritFromCampaignId = input.campaignId;
    }
    if (input.adsetId && !input.inheritFromAdsetId) {
      input.inheritFromAdsetId = input.adsetId;
    }
    delete input.campaignId;
    delete input.adsetId;
    return;
  }

  if (mode === "new_adset") {
    if (input.adsetId && !input.inheritFromAdsetId) {
      input.inheritFromAdsetId = input.adsetId;
    }
    delete input.adsetId;
  }
}

function normalizeCallToActionForDestination(input: CreativeSubmissionInput): void {
  const instagramProfileCta = inferInstagramProfileCallToActionForSubmission(input);
  if (instagramProfileCta) input.callToAction = instagramProfileCta;
}

function inferInstagramProfileCallToActionForSubmission(input: CreativeSubmissionInput): string | null {
  const destinationType = readString(input.destinationType)?.toUpperCase();
  const optimizationGoal = readString(input.optimizationGoal)?.toUpperCase();
  const linkUrl = readString(input.linkUrl)?.toLowerCase();
  const hasInstagramIdentity = Boolean(
    input.instagramActorId || input.instagramUserId || input.instagramAppLink
  );
  if (destinationType === "INSTAGRAM_PROFILE") return "VIEW_INSTAGRAM_PROFILE";
  if (optimizationGoal === "PROFILE_VISIT" && hasInstagramIdentity) return "VIEW_INSTAGRAM_PROFILE";
  if (hasInstagramIdentity && input.instagramAppLink) return "VIEW_INSTAGRAM_PROFILE";
  if (hasInstagramIdentity && linkUrl && /(^https?:\/\/)?(www\.)?instagram\.com\//.test(linkUrl)) {
    return "VIEW_INSTAGRAM_PROFILE";
  }
  return null;
}

function inferPlacementMode(input: CreativeSubmissionInput): CreativeSubmissionPlacementMode | null {
  if (input.campaignId && input.adsetId) return "existing_adset";
  if (input.campaignId && input.adsetName) return "new_adset";
  if (input.campaignName && input.adsetName) return "new_campaign";
  return null;
}

function applyAddroidSubmissionNamePolicy(
  input: CreativeSubmissionInput,
  opts: { source: CreativeSubmissionSource; timeZone: string; now: Date }
): void {
  const suffix = `${formatDateInTimeZone(opts.now, opts.timeZone)}_addroid`;
  const sourceTreatsProvidedNamesAsExplicit = opts.source === "web";
  const mode = input.placementMode ?? inferPlacementMode(input);
  const createsCampaign = mode === "new_campaign" || (!input.campaignId && !input.adsetId);
  const createsAdset = createsCampaign || mode === "new_adset" || Boolean(input.campaignId && !input.adsetId);

  if (createsCampaign) {
    const explicit = input.campaignNameExplicit === true || (sourceTreatsProvidedNamesAsExplicit && Boolean(input.campaignName));
    const base = input.campaignName ?? defaultSubmissionEntityName(input, "Campaign");
    input.campaignName = explicit ? base : appendAddroidNameSuffix(base, suffix);
  }

  if (createsAdset) {
    const explicit = input.adsetNameExplicit === true || (sourceTreatsProvidedNamesAsExplicit && Boolean(input.adsetName));
    const base = input.adsetName ?? defaultSubmissionEntityName(input, "Adset");
    input.adsetName = explicit ? base : appendAddroidNameSuffix(base, suffix);
  }

  const explicitAdName = input.adNameExplicit === true || (sourceTreatsProvidedNamesAsExplicit && Boolean(input.adName));
  const adBase = input.adName ?? input.creativeName ?? input.headline ?? defaultSubmissionEntityName(input, "Ad");
  input.adName = explicitAdName ? adBase : appendAddroidNameSuffix(adBase, suffix);
}

function defaultSubmissionEntityName(input: CreativeSubmissionInput, entity: "Campaign" | "Adset" | "Ad"): string {
  const base = input.creativeName ?? input.headline ?? input.title ?? input.primaryText ?? input.prompt ?? entity;
  const compact = base.trim().replace(/\s+/g, " ");
  if (!compact) return entity;
  return compact.length > 80 ? compact.slice(0, 80).trim() : compact;
}

function appendAddroidNameSuffix(name: string, suffix: string): string {
  const trimmed = name.trim();
  if (!trimmed) return suffix;
  if (/[ _-]\d{4}-\d{2}-\d{2}_addroid$/.test(trimmed) || trimmed === suffix) return trimmed;
  return `${trimmed} ${suffix}`;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function applyInheritedPlacementSettings(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  accountId: string;
  accountKey: string;
  env: NodeJS.ProcessEnv;
  input: CreativeSubmissionInput;
}): Promise<void> {
  if (opts.input.placementMode !== "new_campaign" && opts.input.placementMode !== "new_adset") return;

  opts.input.inheritFromAdId ??= await inferInheritedAdSourceId(opts);
  const adSource = opts.input.inheritFromAdId;
  if (adSource) {
    const raw = await readInheritedMetaRaw(opts, "ad", adSource);
    opts.input.adGraphPayload ??= copyGraphFields(opts.input.adGraphPayload, raw, [
      "conversion_domain",
      "engagement_audience",
    ]);
  }

  const adsetSource = opts.input.inheritFromAdsetId;
  if (adsetSource) {
    const raw = await readInheritedMetaRaw(opts, "adset", adsetSource);
    opts.input.optimizationGoal = readString(raw.optimization_goal) ?? opts.input.optimizationGoal;
    opts.input.billingEvent = readString(raw.billing_event) ?? opts.input.billingEvent;
    opts.input.destinationType = readString(raw.destination_type) ?? opts.input.destinationType;
    opts.input.adsetBidStrategy = readString(raw.bid_strategy) ?? opts.input.adsetBidStrategy;
    opts.input.targeting = readRecord(raw.targeting) ?? opts.input.targeting;
    const promotedObject = readRecord(raw.promoted_object);
    opts.input.pageId ??= readString(promotedObject?.page_id) ?? undefined;
    opts.input.adsetGraphPayload ??= copyGraphFields(opts.input.adsetGraphPayload, raw, [
      "attribution_spec",
      "bid_amount",
      "bid_constraints",
      "bid_strategy",
      "daily_budget",
      "daily_min_spend_target",
      "daily_spend_cap",
      "destination_type",
      "end_time",
      "frequency_control_specs",
      "is_dynamic_creative",
      "lifetime_budget",
      "lifetime_min_spend_target",
      "lifetime_spend_cap",
      "optimization_goal",
      "billing_event",
      "pacing_type",
      "promoted_object",
      "start_time",
      "targeting",
    ]);
  }

  const campaignSource = opts.input.inheritFromCampaignId;
  if (campaignSource) {
    const raw = await readInheritedMetaRaw(opts, "campaign", campaignSource);
    opts.input.objective = readObjective(raw.objective) ?? opts.input.objective;
    opts.input.campaignBidStrategy = readString(raw.bid_strategy) ?? opts.input.campaignBidStrategy;
    opts.input.campaignGraphPayload ??= copyGraphFields(opts.input.campaignGraphPayload, raw, [
      "objective",
      "buying_type",
      "bid_strategy",
      "daily_budget",
      "lifetime_budget",
      "spend_cap",
      "start_time",
      "stop_time",
      "is_adset_budget_sharing_enabled",
      "special_ad_categories",
      "special_ad_category_country",
    ]);
  }
}

async function inferInheritedAdSourceId(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  accountKey: string;
  env: NodeJS.ProcessEnv;
  input: CreativeSubmissionInput;
}): Promise<string | undefined> {
  const adsetSource = opts.input.inheritFromAdsetId;
  if (!adsetSource) return undefined;
  try {
    const result = await runMetaAdsReadOnlyQuery({
      prisma: opts.prisma,
      workspaceId: opts.workspaceId,
      env: opts.env,
      args: {
        resource: "ad",
        action: "list",
        accountKey: opts.accountKey,
        adsetId: adsetSource,
        limit: 25,
      },
    });
    const ads = result.rows.map(readRecord).filter((row): row is Record<string, unknown> => Boolean(row));
    const activeAds = ads.filter((ad) => {
      const status = readString(ad.effective_status ?? ad.status)?.toUpperCase();
      return status === "ACTIVE";
    });
    const candidates = activeAds.length > 0 ? activeAds : ads;
    if (candidates.length !== 1) return undefined;
    return readString(candidates[0]?.id) ?? undefined;
  } catch {
    return undefined;
  }
}

async function readInheritedMetaRaw(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    accountId: string;
    accountKey: string;
    env: NodeJS.ProcessEnv;
  },
  resource: "campaign" | "adset" | "ad",
  externalId: string
): Promise<Record<string, unknown>> {
  let live: Record<string, unknown> | null = null;
  try {
    live = await readLiveInheritedMetaRaw(opts, resource, externalId);
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
    const label = resource === "campaign" ? "キャンペーン" : resource === "adset" ? "広告セット" : "広告";
    throw new Error(
      `既存${label} ${externalId} の live Graph 設定を取得できませんでした${detail}。` +
        "「既存設定と同じで新規作成」は正確性を保証できないため、DB キャッシュでは作成しません。Meta 接続・権限・rate limit を確認してください。"
    );
  }
  if (!live || Object.keys(live).length === 0) {
    const label = resource === "campaign" ? "キャンペーン" : resource === "adset" ? "広告セット" : "広告";
    throw new Error(
      `既存${label} ${externalId} の live Graph 設定が空でした。` +
        "「既存設定と同じで新規作成」は正確性を保証できないため、DB キャッシュでは作成しません。"
    );
  }
  return live;
}

async function readLiveInheritedMetaRaw(
  opts: {
    prisma: PrismaClient;
    workspaceId: string;
    accountKey: string;
    env: NodeJS.ProcessEnv;
  },
  resource: "campaign" | "adset" | "ad",
  externalId: string
): Promise<Record<string, unknown> | null> {
  const result = await runMetaAdsReadOnlyQuery({
    prisma: opts.prisma,
    workspaceId: opts.workspaceId,
    env: opts.env,
    args: {
      resource,
      action: "get",
      accountKey: opts.accountKey,
      ...(resource === "campaign"
        ? { campaignId: externalId }
        : resource === "adset"
          ? { adsetId: externalId }
          : { adId: externalId }),
    },
  });
  return readRecord(result.rows[0]);
}

function copyGraphFields(
  current: Record<string, unknown> | undefined,
  raw: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    if (raw[key] !== undefined) copied[key] = raw[key];
  }
  if (Object.keys(copied).length === 0) return current;
  return { ...copied, ...(current ?? {}) };
}

function sanitizeAdCreateTrackingSpecs(
  value: unknown
): Record<string, unknown> | Array<Record<string, unknown>> | undefined {
  const specs = readRecordArray(value) ?? (readRecord(value) ? [readRecord(value)!] : undefined);
  const safeSpecs = specs?.filter(isSafeAdCreateTrackingSpec) ?? [];
  if (safeSpecs.length === 0) return undefined;
  return Array.isArray(value) ? safeSpecs : safeSpecs[0];
}

function sanitizeAdCreateGraphPayload(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const next = { ...value };
  if ("tracking_specs" in next) {
    const trackingSpecs = sanitizeAdCreateTrackingSpecs(next.tracking_specs);
    if (trackingSpecs === undefined) {
      delete next.tracking_specs;
    } else {
      next.tracking_specs = trackingSpecs;
    }
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

function isSafeAdCreateTrackingSpec(spec: Record<string, unknown>): boolean {
  return hasTrackingActionObject(spec) && !hasCreativeSpecificTrackingReference(spec);
}

function hasTrackingActionObject(spec: Record<string, unknown>): boolean {
  return Object.keys(spec).some((key) => key !== "action.type");
}

function hasCreativeSpecificTrackingReference(spec: Record<string, unknown>): boolean {
  const creativeSpecificKeys = new Set(["post", "post.wall", "post_id", "video", "video_id"]);
  return Object.keys(spec).some((key) => creativeSpecificKeys.has(key));
}

function validateSubmissionActionGraph(
  input: CreativeSubmissionInput,
  operations: OperationProposalAction[]
): void {
  const mode = input.placementMode ?? inferPlacementMode(input);
  if (!mode) return;
  const kinds = new Set(operations.map((op) => op.kind));
  const hasCampaignCreate = kinds.has("campaign.create");
  const hasAdsetCreate = kinds.has("adset.create");
  const hasAdCreate = kinds.has("ad.create");

  if (!hasAdCreate) {
    throw new Error("入稿PRの検証に失敗しました: ad.create がありません。");
  }
  if (mode === "new_campaign" && (!hasCampaignCreate || !hasAdsetCreate)) {
    throw new Error(
      "入稿PRの検証に失敗しました: 新規キャンペーン指定なのに campaign.create / adset.create が含まれていません。"
    );
  }
  if (mode === "new_adset" && (hasCampaignCreate || !hasAdsetCreate)) {
    throw new Error(
      "入稿PRの検証に失敗しました: 既存キャンペーン配下の新規広告セット指定と生成された変更内容が一致しません。"
    );
  }
  if (mode === "existing_adset" && (hasCampaignCreate || hasAdsetCreate)) {
    throw new Error(
      "入稿PRの検証に失敗しました: 既存広告セット配下指定なのに campaign/adset 作成が含まれています。"
    );
  }
}

function requiresDestinationUrlForCurrentCreativeApply(input: CreativeSubmissionInput): boolean {
  if (hasExplicitCreativeGraphShape(input)) return false;
  if (input.mediaType === "image" || input.mediaType === "video" || input.mediaType === "carousel") return true;
  if ((input.localMediaPaths?.length ?? 0) > 0 || (input.uploadedMedia?.length ?? 0) > 0) return true;
  if (input.generateImage === true) return true;
  if ((input.images?.length ?? 0) > 0 || (input.videos?.length ?? 0) > 0) return true;
  if (
    (input.titles?.length ?? 0) > 0 ||
    (input.bodies?.length ?? 0) > 0 ||
    (input.descriptions?.length ?? 0) > 0 ||
    (input.callToActions?.length ?? 0) > 0
  ) {
    return true;
  }
  return Boolean(input.callToAction && input.callToAction !== "NO_BUTTON");
}

function hasExplicitCreativeGraphShape(input: CreativeSubmissionInput): boolean {
  const graphPayload = readRecord(input.creativeGraphPayload);
  return Boolean(
    input.objectStorySpec ||
      input.assetFeedSpec ||
      input.degreesOfFreedomSpec ||
      input.videoId ||
      input.productSetId ||
      input.destinationSetId ||
      readRecord(graphPayload?.object_story_spec) ||
      readRecord(graphPayload?.asset_feed_spec) ||
      readRecord(graphPayload?.degrees_of_freedom_spec) ||
      readString(graphPayload?.video_id) ||
      readString(graphPayload?.product_set_id) ||
      readString(graphPayload?.destination_set_id)
  );
}

async function loadCreativeContextForSubmission(
  prisma: PrismaClient,
  input: { accountId: string; timeZone: string }
): Promise<ImprovementPrCreativeGenerationContext | null> {
  try {
    const context = await loadRecentPerformanceSnapshotContext(prisma, {
      accountId: input.accountId,
      timeZone: input.timeZone,
      includeToday: true,
    });
    return context.creativeContext;
  } catch {
    return null;
  }
}

function buildCreativeSubmissionImagePrompt(input: {
  input: CreativeSubmissionInput;
  accountKey: string;
  accountDisplayName: string;
  accountCurrency: string | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  referenceImageUsageMode?: ReferenceImageUsageMode;
}): string | null {
  const source = input.input.prompt?.trim();
  const safeLinkUrl = landingPageUrlForPrompt(input.input.linkUrl);
  const copyLines = [
    input.input.headline ? `headline=${input.input.headline}` : null,
    input.input.primaryText ? `primaryText=${input.input.primaryText}` : null,
    input.input.description ? `description=${input.input.description}` : null,
    input.input.callToAction ? `cta=${input.input.callToAction}` : null,
    safeLinkUrl ? `linkUrl=${safeLinkUrl}` : null,
    input.input.rationale ? `requestRationale=${input.input.rationale}` : null,
  ].filter((line): line is string => line !== null);

  const sections = [
    "Create a Meta ad image for the connected account.",
    `Account: ${input.accountDisplayName} (${input.accountKey})`,
    input.accountCurrency ? `Account currency: ${input.accountCurrency}` : null,
    source ? `User prompt: ${source}` : null,
    copyLines.length > 0 ? `Requested copy/context:\n${copyLines.map((line) => `- ${line}`).join("\n")}` : null,
    formatCreativeContextForImagePrompt(input.creativeContext),
    formatReferenceImageAdaptationRules(
      input.input,
      input.referenceImageUsageMode,
      hasReferenceImageEvidence(input.input, input.creativeContext)
    ),
    [
      "Rules:",
      "- Use winning reference creatives as positive seeds when present.",
      "- Preserve the winning message structure and visual logic, then adapt it to this request.",
      "- Do not invent unrelated industries, products, people, locations, account names, claims, or logos.",
      "- If evidence is sparse, stay product-neutral and account-specific rather than adding arbitrary subject matter.",
      "- Avoid text-heavy layouts; leave room for Meta ad copy outside the image.",
    ].join("\n"),
  ].filter((section): section is string => typeof section === "string" && section.trim().length > 0);

  if (!source && copyLines.length === 0 && !input.creativeContext) return null;
  return sections.join("\n\n");
}

function formatReferenceImageAdaptationRules(
  input: CreativeSubmissionInput,
  explicitMode: ReferenceImageUsageMode | undefined,
  hasReferenceEvidence: boolean
): string | null {
  if (!hasReferenceEvidence) return null;
  const mode = explicitMode ?? referenceImageUsageModeForPrompt(input.prompt);
  const modeLine =
    mode === "direct_image_reference"
      ? "Reference image handling: direct image reference mode. The user explicitly asked to base/edit/match the image, so image references may guide structure and material fidelity."
      : "Reference image handling: abstract visual brief mode. Use reference images only as planning evidence; do not use them as a template or recreate the same image.";
  const lines = [
    modeLine,
    mode === "direct_image_reference"
      ? "- Even in direct mode, produce a new ad creative rather than a near duplicate; change at least one major element."
      : "- Do not reproduce the same object arrangement, crop, camera distance, lens angle, light placement, or background layout.",
    "- Change at least two of: main subject, camera distance, composition, background setting, light direction, color accent, CTA framing, or offer framing.",
    "- Anchor the result to the connected account and improvement target; add a concrete improvement angle such as profile visit, store atmosphere, product experience, visit motivation, or premium relaxation value.",
    "- For multiple variants, make each concept materially distinct rather than minor redraws of one reference image.",
  ];
  return lines.join("\n");
}

function hasReferenceImageEvidence(
  input: CreativeSubmissionInput,
  context: ImprovementPrCreativeGenerationContext | null
): boolean {
  if (hasUserReferenceImages(input)) return true;
  if ((context?.references?.length ?? 0) > 0) return true;
  return (context?.notes ?? []).some((note) =>
    /Reference image visual analysis/i.test(note)
  );
}

function hasUserReferenceImages(input: CreativeSubmissionInput): boolean {
  return (
    (input.referenceImagePaths?.length ?? 0) > 0 ||
    (input.uploadedReferenceMedia?.length ?? 0) > 0
  );
}

function referenceImageUsageModeForPrompt(prompt: string | null | undefined): ReferenceImageUsageMode {
  const text = (prompt ?? "").toLowerCase();
  const directPatterns = [
    /この画像を(?:ベース|元|土台)に/,
    /元画像を(?:ベース|土台)に/,
    /画像を(?:ベース|元|土台)に/,
    /画像を加工/,
    /素材を加工/,
    /同じ構図/,
    /構図をそのまま/,
    /この画像をそのまま/,
    /ほぼ同じ/,
    /edit this image/,
    /use this image as (?:the )?base/,
    /base (?:it|the creative) on this image/,
    /same composition/,
    /keep the same composition/,
  ];
  return directPatterns.some((pattern) => pattern.test(text))
    ? "direct_image_reference"
    : "abstract_visual_brief";
}

function formatCreativeContextForImagePrompt(
  context: ImprovementPrCreativeGenerationContext | null
): string | null {
  if (!context) return null;
  const lines = [
    "Creative performance context:",
    `- strategy=${context.strategy}`,
    context.target ? `- target=${formatCreativeNodeForPrompt(context.target)}` : null,
  ].filter((line): line is string => line !== null);
  if (context.references.length > 0) {
    lines.push(
      context.strategy === "refresh_underperformer"
        ? "- references:"
        : "- winning references:"
    );
    for (const reference of context.references.slice(0, 3)) {
      lines.push(`  - ${formatCreativeNodeForPrompt(reference)}`);
    }
  }
  if (context.notes?.length) {
    lines.push(`- notes=${context.notes.join(" / ")}`);
  }
  return lines.join("\n");
}

function formatCreativeNodeForPrompt(node: ImprovementPrCreativeNodeContext): string {
  const creative = node.creative;
  const safeLinkUrl = landingPageUrlForPrompt(creative?.linkUrl);
  const parts = [
    `${node.hierarchy}:${node.displayName}`,
    `status=${node.status ?? "unknown"}`,
    `ctr=${formatMetric(node.current.ctr)}`,
    `conversions=${formatMetric(node.current.conversions)}`,
    `cpa=${formatMetric(node.current.cpa)}`,
    creative?.displayName ? `creativeName=${creative.displayName}` : null,
    creative?.mediaType ? `mediaType=${creative.mediaType}` : null,
    creative?.headline ? `headline=${creative.headline}` : null,
    creative?.primaryText ? `primaryText=${creative.primaryText}` : null,
    creative?.callToAction ? `cta=${creative.callToAction}` : null,
    safeLinkUrl ? `linkUrl=${safeLinkUrl}` : null,
    creative?.storageRef ? `storageRef=${creative.storageRef}` : null,
    creative?.images?.length ? `images=${creative.images.join(",")}` : null,
    node.rationale ? `rationale=${node.rationale}` : null,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.join("; ");
}

function formatMetric(value: number | undefined): string {
  if (value === undefined) return "0";
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(4)).toString();
}

function needsGeneratedCreativeText(input: CreativeSubmissionInput): boolean {
  return !input.headline || !input.primaryText || !input.description || !input.callToAction;
}

function applyGeneratedTextToSubmissionInput(
  input: CreativeSubmissionInput,
  variant: CreativeTextVariant | undefined
): void {
  if (!variant) return;
  input.headline = input.headline ?? variant.headline;
  input.primaryText = input.primaryText ?? variant.primaryText;
  input.description = input.description ?? variant.description;
  input.callToAction = input.callToAction ?? variant.callToAction;
}

function creativeTextVariantFromSubmissionInput(input: CreativeSubmissionInput): CreativeTextVariant | null {
  const primaryText = input.primaryText ?? input.prompt ?? input.headline ?? input.description ?? null;
  const headline = input.headline ?? input.creativeName ?? input.adName ?? primaryText;
  const description = input.description ?? "詳しくはこちら";
  if (!primaryText && !headline && !description) return null;
  return {
    primaryText: truncateChars(primaryText ?? "", META_TEXT_RECOMMENDED_LIMITS.primaryText),
    headline: truncateChars(headline ?? "", META_TEXT_RECOMMENDED_LIMITS.headline),
    description: truncateChars(description, META_TEXT_RECOMMENDED_LIMITS.description),
    callToAction: input.callToAction ?? DEFAULT_GENERATED_CTA,
    rationale: input.rationale ?? null,
  };
}

async function generateCreativeTextVariants(input: {
  provider: LLMProvider | null;
  prompt: string;
  accountDisplayName: string;
  linkUrl?: string | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  variantCount: number;
}): Promise<CreativeTextGenerationResult> {
  const count = Math.max(1, Math.min(4, input.variantCount));
  const fallback = fillTextVariants(
    [fallbackCreativeTextVariant(input.prompt, input.accountDisplayName)],
    count
  );
  if (!input.provider) {
    return { source: "fallback", variants: fallback, error: "LLM Provider が未設定です。" };
  }
  try {
    const completion = await input.provider.complete({
      purpose: "creative_text_generation",
      maxOutputTokens: 1600,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: [
            "You generate Meta ad copy to accompany generated image creatives.",
            "Return JSON only. Do not use Markdown.",
            "Required output shape: {\"variants\":[{\"primaryText\":\"...\",\"headline\":\"...\",\"description\":\"...\",\"callToAction\":\"LEARN_MORE\",\"rationale\":\"...\"}]}",
            "Generate materially distinct variants, not minor rewrites.",
            `Respect recommended display lengths: primaryText <= ${META_TEXT_RECOMMENDED_LIMITS.primaryText} characters, headline <= ${META_TEXT_RECOMMENDED_LIMITS.headline}, description <= ${META_TEXT_RECOMMENDED_LIMITS.description}.`,
            `Prefer common Meta CTA enum tokens such as: ${joinMetaValues(COMMON_CREATIVE_CALL_TO_ACTIONS)}.`,
            "Do not invent unsupported claims, rankings, prices, guarantees, medical/safety claims, unrelated products, unrelated locations, or unrelated brands.",
            "Use landing page and creative performance context when provided.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            accountDisplayName: input.accountDisplayName,
            userPrompt: input.prompt,
            linkUrl: landingPageUrlForPrompt(input.linkUrl),
            variantCount: count,
            creativeContext: input.creativeContext ? creativeContextToMetadata(input.creativeContext) : null,
            requiredFields: ["primaryText", "headline", "description", "callToAction"],
            recommendedLengths: META_TEXT_RECOMMENDED_LIMITS,
          }),
        },
      ],
    });
    const parsed = extractJsonFromLlmContent(completion.content);
    const variants = parseCreativeTextVariants(parsed, input.prompt, input.accountDisplayName);
    return { source: "llm", variants: fillTextVariants(variants, count), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: "fallback", variants: fallback, error: message };
  }
}

function parseCreativeTextVariants(
  parsed: unknown,
  prompt: string,
  accountDisplayName: string
): CreativeTextVariant[] {
  const root = isRecord(parsed) ? parsed : {};
  const rawVariants = Array.isArray(root.variants) ? root.variants : [];
  const variants = rawVariants
    .filter(isRecord)
    .map((item) => normalizeCreativeTextVariant(item))
    .filter((item): item is CreativeTextVariant => item !== null);
  return variants.length > 0 ? variants : [fallbackCreativeTextVariant(prompt, accountDisplayName)];
}

function normalizeCreativeTextVariant(item: Record<string, unknown>): CreativeTextVariant | null {
  const primaryText = readString(item.primaryText) ?? readString(item.message);
  const headline = readString(item.headline) ?? readString(item.name) ?? readString(item.title);
  const description = readString(item.description);
  if (!primaryText && !headline && !description) return null;
  const cta = readCallToAction(item.callToAction) ?? readCallToAction(item.cta) ?? DEFAULT_GENERATED_CTA;
  return {
    primaryText: truncateChars(primaryText ?? headline ?? description ?? "", META_TEXT_RECOMMENDED_LIMITS.primaryText),
    headline: truncateChars(headline ?? primaryText ?? description ?? "", META_TEXT_RECOMMENDED_LIMITS.headline),
    description: truncateChars(description ?? "詳しくはこちら", META_TEXT_RECOMMENDED_LIMITS.description),
    callToAction: cta,
    rationale: readString(item.rationale),
  };
}

function fallbackCreativeTextVariant(prompt: string, accountDisplayName: string): CreativeTextVariant {
  const fallbackHeadline = accountDisplayName || "詳しく見る";
  return {
    primaryText: truncateChars(prompt || `${fallbackHeadline}の魅力を詳しく見る`, META_TEXT_RECOMMENDED_LIMITS.primaryText),
    headline: truncateChars(fallbackHeadline, META_TEXT_RECOMMENDED_LIMITS.headline),
    description: truncateChars("詳しくはこちら", META_TEXT_RECOMMENDED_LIMITS.description),
    callToAction: DEFAULT_GENERATED_CTA,
    rationale: "LLMコピー生成が使えない場合のフォールバック",
  };
}

function fillTextVariants(variants: CreativeTextVariant[], count: number): CreativeTextVariant[] {
  const out = variants.slice(0, count);
  const fallback = variants[0] ?? fallbackCreativeTextVariant("", "詳しく見る");
  while (out.length < count) out.push({ ...fallback });
  return out;
}

function truncateChars(value: string, max: number): string {
  const chars = Array.from(value.trim().replace(/\s+/g, " "));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

async function prepareMedia(input: {
  input: CreativeSubmissionInput;
  accountKey: string;
  accountDisplayName: string;
  accountCurrency: string | null;
  creativeId: string;
  storage: LocalDiskStorage;
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  imageProvider: ImageProvider | null;
  creativeQaPolicy: CreativeQaPolicy | null;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  referenceImages: ImageReferenceInput[];
  referenceImageUsageMode: ReferenceImageUsageMode;
  preferCodexImageProvider?: boolean;
}): Promise<{
  mediaType: "image" | "video" | "carousel" | "text";
  storageKeys: string[];
  generatedImage: boolean;
  provider: string | null;
  model: string | null;
  imageNormalization: SubmissionImageNormalizationReport[];
}> {
  const imageProfile = selectSubmissionImageProfile({
    input: input.input,
    creativeContext: input.creativeContext,
  });
  const uploaded = input.input.uploadedMedia ?? [];
  if (uploaded.length > 0) {
    const stored = await storeUploadedMedia(input.storage, input.accountKey, input.creativeId, uploaded);
    const normalized = await normalizeStoredSubmissionImages({
      storage: input.storage,
      storageKeys: stored.storageKeys,
      mediaType: input.input.mediaType ?? stored.mediaType,
      profile: imageProfile,
    });
    return {
      mediaType: input.input.mediaType ?? stored.mediaType,
      storageKeys: normalized.storageKeys,
      generatedImage: false,
      provider: null,
      model: null,
      imageNormalization: normalized.reports,
    };
  }
  if (input.input.localMediaPaths && input.input.localMediaPaths.length > 0) {
    const stored = await storeLocalMedia(input.storage, input.accountKey, input.creativeId, input.input.localMediaPaths);
    const normalized = await normalizeStoredSubmissionImages({
      storage: input.storage,
      storageKeys: stored.storageKeys,
      mediaType: input.input.mediaType ?? stored.mediaType,
      profile: imageProfile,
    });
    return {
      mediaType: input.input.mediaType ?? stored.mediaType,
      storageKeys: normalized.storageKeys,
      generatedImage: false,
      provider: null,
      model: null,
      imageNormalization: normalized.reports,
    };
  }
  const wantsImage = input.input.generateImage || input.input.mediaType === "image";
  const contextualPrompt = buildCreativeSubmissionImagePrompt({
    input: input.input,
    accountKey: input.accountKey,
    accountDisplayName: input.accountDisplayName,
    accountCurrency: input.accountCurrency,
    creativeContext: input.creativeContext,
    referenceImageUsageMode: input.referenceImageUsageMode,
  });
  if (wantsImage && contextualPrompt) {
    const selected =
      input.imageProvider ??
      (await selectImageProviderForWorker(input.env, {
        prisma: input.prisma,
        preferCodex: input.preferCodexImageProvider === true,
      })).provider;
    const generated = await generateAndQaCreative({
      provider: selected,
      request: {
        prompt: contextualPrompt,
        purpose: "creative_submission",
        referenceImages: input.referenceImages,
        variationConditions: [
          {
            width: imageProfile.width,
            height: imageProfile.height,
            format: "png",
            variantKey: imageProfile.variantKey,
            styleNotes: `Compose for ${imageProfile.aspectRatio} Meta placement. Keep important subjects away from the outer 14% safe margins.`,
          },
        ],
      },
      policy: input.creativeQaPolicy ?? DEFAULT_CREATIVE_QA_POLICY,
    });
    if (generated.generation && generated.qa) {
      const persisted = await persistCreativeAssets({
        storage: input.storage,
        accountKey: input.accountKey,
        creativeId: input.creativeId,
        generation: generated.generation,
        qa: generated.qa,
        links: { pullRequestNumber: null },
      });
      const normalized = await normalizeStoredSubmissionImages({
        storage: input.storage,
        storageKeys: persisted.assets.map((a) => a.storageKey),
        mediaType: "image",
        profile: imageProfile,
      });
      return {
        mediaType: "image",
        storageKeys: normalized.storageKeys,
        generatedImage: true,
        provider: generated.generation.meta.provider,
        model: generated.generation.meta.model,
        imageNormalization: normalized.reports,
      };
    }
  }
  return {
    mediaType: input.input.mediaType ?? "text",
    storageKeys: [],
    generatedImage: false,
    provider: null,
    model: null,
    imageNormalization: [],
  };
}

function selectSubmissionImageProfile(input: {
  input: CreativeSubmissionInput;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
}): SubmissionImageProfile {
  const explicit = profileFromPlacementOrAspect(
    input.input.imagePlacement,
    input.input.imageAspectRatio
  );
  if (explicit) return explicit;
  return profileFromCreativeContext(input.creativeContext) ?? DEFAULT_IMAGE_PROFILE;
}

function selectStandaloneImageProfiles(input: {
  input: CreativeGenerationInput;
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  count: number;
}): SubmissionImageProfile[] {
  const explicit = profileFromPlacementOrAspect(
    input.input.imagePlacement,
    input.input.imageAspectRatio
  );
  if (explicit) return Array.from({ length: input.count }, () => explicit);
  const contextual = profileFromCreativeContext(input.creativeContext);
  const preferred = contextual ?? DEFAULT_IMAGE_PROFILE;
  const candidates = [
    preferred,
    IMAGE_PROFILES.feed_portrait,
    IMAGE_PROFILES.story_reels,
    IMAGE_PROFILES.feed_square,
    IMAGE_PROFILES.feed_landscape,
  ];
  const unique = dedupeImageProfiles(candidates);
  return Array.from({ length: input.count }, (_, i) => unique[i % unique.length] ?? DEFAULT_IMAGE_PROFILE);
}

function dedupeImageProfiles(profiles: SubmissionImageProfile[]): SubmissionImageProfile[] {
  const seen = new Set<string>();
  const out: SubmissionImageProfile[] = [];
  for (const profile of profiles) {
    if (seen.has(profile.variantKey)) continue;
    seen.add(profile.variantKey);
    out.push(profile);
  }
  return out;
}

function profileFromPlacementOrAspect(
  placement: SubmissionImageProfileKey | undefined,
  aspectRatio: SubmissionImageAspectRatio | undefined
): SubmissionImageProfile | null {
  if (placement) return IMAGE_PROFILES[placement];
  if (!aspectRatio) return null;
  if (aspectRatio === "9:16") return IMAGE_PROFILES.story_reels;
  if (aspectRatio === "4:5") return IMAGE_PROFILES.feed_portrait;
  if (aspectRatio === "1.91:1") return IMAGE_PROFILES.feed_landscape;
  return IMAGE_PROFILES.feed_square;
}

function profileFromCreativeContext(
  context: ImprovementPrCreativeGenerationContext | null
): SubmissionImageProfile | null {
  if (!context) return null;
  const evidence = [
    context.target?.spec,
    ...context.references.map((ref) => ref.spec),
    ...(context.notes ?? []),
  ];
  for (const value of evidence) {
    const profile = profileFromPlacementEvidence(value);
    if (profile) return profile;
  }
  return null;
}

function profileFromPlacementEvidence(value: unknown): SubmissionImageProfile | null {
  const text = JSON.stringify(value ?? "").toLowerCase();
  if (!text || text === "\"\"") return null;
  if (
    /\b(story|stories|reels?|instagram_stories|instagram_reels)\b/.test(text) ||
    text.includes("9:16")
  ) {
    return IMAGE_PROFILES.story_reels;
  }
  if (/\b(instagram_stream|facebook_feed|feed|home|instagram_feed)\b/.test(text)) {
    if (text.includes("4:5") || text.includes("portrait")) return IMAGE_PROFILES.feed_portrait;
    if (text.includes("1.91:1") || text.includes("landscape")) return IMAGE_PROFILES.feed_landscape;
    return IMAGE_PROFILES.feed_square;
  }
  if (text.includes("4:5") || text.includes("portrait")) return IMAGE_PROFILES.feed_portrait;
  if (text.includes("1.91:1") || text.includes("landscape")) return IMAGE_PROFILES.feed_landscape;
  return null;
}

async function normalizeStoredSubmissionImages(input: {
  storage: LocalDiskStorage;
  storageKeys: string[];
  mediaType: "image" | "video" | "carousel" | "text";
  profile: SubmissionImageProfile;
}): Promise<{ storageKeys: string[]; reports: SubmissionImageNormalizationReport[] }> {
  if (input.mediaType === "video" || input.mediaType === "text" || input.storageKeys.length === 0) {
    return { storageKeys: input.storageKeys, reports: [] };
  }
  const out: string[] = [];
  const reports: SubmissionImageNormalizationReport[] = [];
  for (const key of input.storageKeys) {
    if (!isImageStorageKey(key)) {
      out.push(key);
      continue;
    }
    const normalized = await normalizeSubmissionImage({
      storage: input.storage,
      storageKey: key,
      profile: input.profile,
    });
    out.push(normalized.normalizedKey);
    reports.push(normalized);
  }
  return { storageKeys: out, reports };
}

function isImageStorageKey(key: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(key).toLowerCase());
}

async function normalizeSubmissionImage(input: {
  storage: LocalDiskStorage;
  storageKey: string;
  profile: SubmissionImageProfile;
}): Promise<SubmissionImageNormalizationReport> {
  const sourcePath = input.storage.resolve(input.storageKey);
  const base = input.storageKey.replace(/\.[^.\\/]+$/, "");
  const normalizedKey = `${base}-${input.profile.variantKey}.png`;
  const targetRatio = input.profile.width / input.profile.height;

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(sourcePath, { failOn: "none" }).rotate().metadata();
  } catch {
    throw new Error(`画像 ${path.basename(input.storageKey)} の形式を確認できませんでした。PNG/JPEG/WebP の有効な画像を指定してください。`);
  }
  const originalWidth = metadata.width ?? null;
  const originalHeight = metadata.height ?? null;
  if (!originalWidth || !originalHeight) {
    throw new Error(`画像 ${path.basename(input.storageKey)} のサイズを確認できませんでした。別の画像を指定してください。`);
  }

  const actualRatio = originalWidth / originalHeight;
  const ratioDelta = Math.abs(actualRatio - targetRatio) / targetRatio;
  const needsCanvas = ratioDelta > IMAGE_ASPECT_TOLERANCE;
  const needsConversion = path.extname(input.storageKey).toLowerCase() !== ".png";
  const needsResize =
    originalWidth !== input.profile.width ||
    originalHeight !== input.profile.height;

  if (!needsCanvas && !needsConversion && !needsResize) {
    return {
      originalKey: input.storageKey,
      normalizedKey: input.storageKey,
      originalWidth,
      originalHeight,
      targetWidth: input.profile.width,
      targetHeight: input.profile.height,
      action: "skipped",
      reason: "already matches target Meta image profile",
    };
  }

  const output = needsCanvas
    ? await renderLetterboxedImage(sourcePath, input.profile)
    : await sharp(sourcePath, { failOn: "none" })
        .rotate()
        .resize(input.profile.width, input.profile.height, {
          fit: "cover",
          position: "attention",
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
  await input.storage.write(normalizedKey, output);
  return {
    originalKey: input.storageKey,
    normalizedKey,
    originalWidth,
    originalHeight,
    targetWidth: input.profile.width,
    targetHeight: input.profile.height,
    action: needsCanvas ? "letterboxed" : needsConversion ? "converted" : "resized",
    reason: input.profile.reason,
  };
}

async function renderLetterboxedImage(
  sourcePath: string,
  profile: SubmissionImageProfile
): Promise<Buffer> {
  const background = await sharp(sourcePath, { failOn: "none" })
    .rotate()
    .resize(profile.width, profile.height, { fit: "cover", position: "attention" })
    .blur(32)
    .modulate({ brightness: 0.72, saturation: 0.82 })
    .png()
    .toBuffer();
  const foreground = await sharp(sourcePath, { failOn: "none" })
    .rotate()
    .resize(profile.width, profile.height, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.floor((profile.width - foreground.info.width) / 2));
  const top = Math.max(0, Math.floor((profile.height - foreground.info.height) / 2));
  return sharp(background)
    .composite([{ input: foreground.data, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function storeUploadedMedia(
  storage: LocalDiskStorage,
  accountKey: string,
  creativeId: string,
  media: UploadedCreativeMedia[]
): Promise<{ storageKeys: string[]; mediaType: "image" | "video" | "carousel" }> {
  const storageKeys: string[] = [];
  let detected: "image" | "video" = "image";
  for (const item of media) {
    const safe = safeFilename(item.filename);
    const kind = detectMediaKind(safe, item.mimeType ?? null);
    detected = kind;
    if (item.bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new Error(`${safe} は 100MB を超えるため取り込めません。`);
    }
    const key = `creative-submissions/${accountKey}/${creativeId}/${safe}`;
    await storage.write(key, item.bytes);
    storageKeys.push(key);
  }
  return { storageKeys, mediaType: storageKeys.length > 1 ? "carousel" : detected };
}

async function storeLocalMedia(
  storage: LocalDiskStorage,
  accountKey: string,
  creativeId: string,
  mediaPaths: string[]
): Promise<{ storageKeys: string[]; mediaType: "image" | "video" | "carousel" }> {
  const storageKeys: string[] = [];
  let detected: "image" | "video" = "image";
  for (const rawPath of mediaPaths) {
    const abs = path.resolve(rawPath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`素材ファイルではありません: ${rawPath}`);
    if (stat.size > MAX_MEDIA_BYTES) throw new Error(`${rawPath} は 100MB を超えるため取り込めません。`);
    const filename = safeFilename(path.basename(abs));
    detected = detectMediaKind(filename, null);
    const key = `creative-submissions/${accountKey}/${creativeId}/${filename}`;
    await storage.write(key, fs.readFileSync(abs));
    storageKeys.push(key);
  }
  return { storageKeys, mediaType: storageKeys.length > 1 ? "carousel" : detected };
}

async function loadSubmissionReferenceImages(
  input: CreativeSubmissionInput
): Promise<ImageReferenceInput[]> {
  const refs: ImageReferenceInput[] = [];
  for (const item of input.uploadedReferenceMedia ?? []) {
    const filename = safeFilename(item.filename);
    const mimeType = referenceMimeType(filename, item.mimeType);
    if (!mimeType) continue;
    if (item.bytes.byteLength === 0 || item.bytes.byteLength > MAX_MEDIA_BYTES) continue;
    refs.push({
      bytes: item.bytes,
      mimeType,
      filename,
      sourceRef: `upload://${filename}`,
    });
  }
  for (const rawPath of input.referenceImagePaths ?? []) {
    const abs = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MEDIA_BYTES) continue;
    const filename = safeFilename(path.basename(abs));
    const mimeType = referenceMimeType(filename, null);
    if (!mimeType) continue;
    refs.push({
      bytes: new Uint8Array(fs.readFileSync(abs)),
      mimeType,
      filename,
      sourceRef: abs,
      localPath: abs,
    });
  }
  return refs;
}

function referenceMimeType(
  filename: string,
  mimeType: string | null | undefined
): ImageReferenceInput["mimeType"] | null {
  const lowerMime = mimeType?.toLowerCase() ?? "";
  if (lowerMime === "image/png") return "image/png";
  if (lowerMime === "image/jpeg" || lowerMime === "image/jpg") return "image/jpeg";
  if (lowerMime === "image/webp") return "image/webp";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return null;
}

function detectMediaKind(filename: string, mimeType: string | null): "image" | "video" {
  const lowerMime = mimeType?.toLowerCase() ?? "";
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.startsWith("video/")) return "video";
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  throw new Error(`対応していない素材形式です: ${filename}`);
}

function placeAdDraft(
  brand: Record<string, unknown>,
  opts: {
    input: CreativeSubmissionInput;
    creativeId: string;
    adId: string;
  }
): {
  campaignId: string;
  adsetId: string;
  createdCampaign: boolean;
  createdAdset: boolean;
  adoptedCampaign: boolean;
  adoptedAdset: boolean;
} {
  const ad = {
    id: opts.adId,
    name: opts.input.adName || opts.input.creativeName || opts.adId,
    creativeRef: opts.creativeId,
    initialState: "paused",
    ...removeUndefined({
      pixelId: opts.input.adPixelId,
      trackingSpecs: opts.input.trackingSpecs,
    }),
  };
  const adsetOptions = buildAdsetOptions(opts.input);
  const campaigns = ensureArray(brand, "campaigns");
  if (opts.input.campaignId && opts.input.adsetId) {
    for (const campaign of campaigns) {
      if (!isRecord(campaign) || campaign.id !== opts.input.campaignId) continue;
      const adsets = ensureArray(campaign, "adsets");
      for (const adset of adsets) {
        if (!isRecord(adset) || adset.id !== opts.input.adsetId) continue;
        ensureArray(adset, "ads").push(ad);
        return {
          campaignId: opts.input.campaignId,
          adsetId: opts.input.adsetId,
          createdCampaign: false,
          createdAdset: false,
          adoptedCampaign: false,
          adoptedAdset: false,
        };
      }
      adsets.push(importedExistingAdset(opts.input, ad));
      return {
        campaignId: opts.input.campaignId,
        adsetId: opts.input.adsetId,
        createdCampaign: false,
        createdAdset: false,
        adoptedCampaign: false,
        adoptedAdset: true,
      };
    }
    campaigns.push(importedExistingCampaign(opts.input, ad));
    return {
      campaignId: opts.input.campaignId,
      adsetId: opts.input.adsetId,
      createdCampaign: false,
      createdAdset: false,
      adoptedCampaign: true,
      adoptedAdset: true,
    };
  }
  if (opts.input.campaignId && opts.input.adsetName) {
    for (const campaign of campaigns) {
      if (!isRecord(campaign) || campaign.id !== opts.input.campaignId) continue;
      const adsets = ensureArray(campaign, "adsets");
      const adsetId = uniqueId(adsets, makeStableId(opts.input.adsetName));
      adsets.push(newAdsetDraft(opts.input, ad, adsetId, adsetOptions));
      return {
        campaignId: opts.input.campaignId,
        adsetId,
        createdCampaign: false,
        createdAdset: true,
        adoptedCampaign: false,
        adoptedAdset: false,
      };
    }
    const adsetId = makeStableId(opts.input.adsetName);
    campaigns.push(importedExistingCampaign(opts.input, ad, newAdsetDraft(opts.input, ad, adsetId, adsetOptions)));
    return {
      campaignId: opts.input.campaignId,
      adsetId,
      createdCampaign: false,
      createdAdset: true,
      adoptedCampaign: true,
      adoptedAdset: false,
    };
  }

  const campaignId = uniqueId(campaigns, makeStableId(opts.input.campaignName ?? "campaign"));
  const adsetId = makeStableId(opts.input.adsetName ?? "adset");
  campaigns.push({
    id: campaignId,
    name: opts.input.campaignName,
    objective: opts.input.objective,
    initialState: "paused",
    budget: removeUndefined({
      dailyBudget: campaignDailyBudget(opts.input),
      lifetimeBudget: campaignLifetimeBudget(opts.input),
    }),
    ...(opts.input.adsetBudgetSharing !== undefined ? { adsetBudgetSharing: opts.input.adsetBudgetSharing } : {}),
    adsets: [
      {
        id: adsetId,
        name: opts.input.adsetName,
        initialState: "paused",
        ...adsetOptions,
        targeting: removeUndefined({
          countries: opts.input.countries ?? [],
          ageMin: opts.input.ageMin,
          ageMax: opts.input.ageMax,
          interests: [],
          customAudiences: [],
        }),
        ads: [ad],
      },
    ],
  });
  return {
    campaignId,
    adsetId,
    createdCampaign: true,
    createdAdset: true,
    adoptedCampaign: false,
    adoptedAdset: false,
  };
}

function importedExistingCampaign(
  input: CreativeSubmissionInput,
  ad: Record<string, unknown>,
  adset: Record<string, unknown> = importedExistingAdset(input, ad)
) {
  return {
    id: input.campaignId!,
    externalId: input.campaignId!,
    importedExisting: true,
    name: input.campaignName || `Existing campaign ${input.campaignId}`,
    objective: input.objective ?? "OUTCOME_TRAFFIC",
    initialState: "paused",
    budget: removeUndefined({
      dailyBudget: campaignDailyBudget(input) ?? 1,
      lifetimeBudget: campaignLifetimeBudget(input),
    }),
    adsets: [adset],
  };
}

function newAdsetDraft(
  input: CreativeSubmissionInput,
  ad: Record<string, unknown>,
  adsetId: string,
  adsetOptions = buildAdsetOptions(input)
) {
  return {
    id: adsetId,
    name: input.adsetName!,
    initialState: "paused",
    ...(adsetDailyBudget(input, false) !== undefined || adsetLifetimeBudget(input, false) !== undefined
      ? {
          budget: removeUndefined({
            dailyBudget: adsetDailyBudget(input, false),
            lifetimeBudget: adsetLifetimeBudget(input, false),
          }),
        }
      : {}),
    ...adsetOptions,
    targeting: removeUndefined({
      countries: input.countries ?? [],
      ageMin: input.ageMin,
      ageMax: input.ageMax,
      interests: [],
      customAudiences: [],
    }),
    ads: [ad],
  };
}

function importedExistingAdset(input: CreativeSubmissionInput, ad: Record<string, unknown>) {
  return {
    id: input.adsetId!,
    externalId: input.adsetId!,
    importedExisting: true,
    name: input.adsetName || `Existing adset ${input.adsetId}`,
    initialState: "paused",
    targeting: removeUndefined({
      countries: input.countries ?? [],
      interests: [],
      customAudiences: [],
    }),
    ads: [ad],
  };
}

function buildAdsetOptions(input: CreativeSubmissionInput): Record<string, unknown> {
  return removeUndefined({
    optimizationGoal: input.optimizationGoal,
    billingEvent: input.billingEvent,
    bidAmount: bidAmount(input),
    startTime: input.startTime,
    endTime: input.endTime,
    pixelId: input.pixelId,
    customEventType: input.customEventType,
  });
}

function buildCreativeSubmissionOperations(input: {
  input: CreativeSubmissionInput;
  accountKey: string;
  accountCurrency: string;
  creativeId: string;
  adId: string;
  placement: {
    campaignId: string;
    adsetId: string;
    createdCampaign: boolean;
    createdAdset: boolean;
  };
  creative: Record<string, unknown>;
  preparedStorageKeys: string[];
  storage: LocalDiskStorage;
}): OperationProposalAction[] {
  const operations: OperationProposalAction[] = [
    {
      kind: "creative.create",
      ref: operationRef("creative", input.creativeId),
      payload: removeUndefined({
        creativeId: input.creativeId,
        name: String(input.creative.name ?? input.creativeId),
        pageId: input.input.pageId,
        storageKey: input.preparedStorageKeys[0],
        mediaType: input.input.mediaType ?? "image",
        body: input.input.body ?? input.input.primaryText ?? input.input.prompt,
        primaryText: input.input.primaryText ?? input.input.prompt,
        title: input.input.title ?? input.input.headline,
        headline: input.input.headline,
        linkUrl: input.input.linkUrl,
        description: input.input.description,
        callToAction: input.input.callToAction,
        instagramUserId: input.input.instagramUserId ?? input.input.instagramActorId,
        instagramActorId: input.input.instagramActorId,
        instagramAppLink: input.input.instagramAppLink,
        titles: input.input.titles,
        bodies: input.input.bodies,
        descriptions: input.input.descriptions,
        callToActions: input.input.callToActions,
        objectStorySpec: input.input.objectStorySpec,
        assetFeedSpec: input.input.assetFeedSpec,
        degreesOfFreedomSpec: input.input.degreesOfFreedomSpec,
        urlTags: input.input.urlTags,
        imageCrops: input.input.imageCrops,
        platformCustomizations: input.input.platformCustomizations,
        videoId: input.input.videoId,
        thumbnailId: input.input.thumbnailId,
        templateUrlSpec: input.input.templateUrlSpec,
        productSetId: input.input.productSetId,
        destinationSetId: input.input.destinationSetId,
        authorizationCategory: input.input.authorizationCategory,
        adDisclaimerSpec: input.input.adDisclaimerSpec,
        brandedContentSponsorPageId: input.input.brandedContentSponsorPageId,
        graphPayload: input.input.creativeGraphPayload,
      }),
      entity: {
        nodeType: "creative",
        nodeKey: input.creativeId,
        displayName: String(input.creative.name ?? input.creativeId),
      },
      externalIdRequired: true,
    },
  ];

  let campaignRef = input.input.campaignId ?? input.placement.campaignId;
  if (input.placement.createdCampaign) {
    operations.push({
      kind: "campaign.create",
      ref: operationRef("campaign", input.placement.campaignId),
      payload: removeUndefined({
        campaignId: input.placement.campaignId,
        name: input.input.campaignName ?? input.placement.campaignId,
        objective: input.input.objective,
        status: "PAUSED",
        specialAdCategoryCountry: input.input.specialAdCategoryCountry,
        dailyBudget: campaignDailyBudget(input.input),
        lifetimeBudget: campaignLifetimeBudget(input.input),
        adsetBudgetSharing: input.input.adsetBudgetSharing,
        bidStrategy: input.input.campaignBidStrategy,
        spendCap: input.input.campaignSpendCap,
        startTime: input.input.campaignStartTime,
        stopTime: input.input.campaignStopTime,
        isAdsetBudgetSharingEnabled: input.input.isAdsetBudgetSharingEnabled,
        pacingType: input.input.campaignPacingType,
        smartPromotionType: input.input.smartPromotionType,
        promotedObject: input.input.campaignPromotedObject,
        graphPayload: input.input.campaignGraphPayload,
      }),
      entity: {
        nodeType: "campaign",
        nodeKey: input.placement.campaignId,
        displayName: input.input.campaignName ?? input.placement.campaignId,
        status: "paused",
      },
      externalIdRequired: true,
    });
    campaignRef = operationRef("campaign", input.placement.campaignId);
  }

  let adsetRef = input.input.adsetId ?? input.placement.adsetId;
  if (input.placement.createdAdset) {
    operations.push({
      kind: "adset.create",
      ref: operationRef("adset", input.placement.adsetId),
      dependsOn: input.placement.createdCampaign ? [operationRef("campaign", input.placement.campaignId)] : undefined,
      payload: removeUndefined({
        adsetId: input.placement.adsetId,
        campaignRef,
        name: input.input.adsetName ?? input.placement.adsetId,
        status: "PAUSED",
        optimizationGoal: input.input.optimizationGoal,
        optimizationSubEvent: input.input.optimizationSubEvent,
        billingEvent: input.input.billingEvent,
        bidStrategy: input.input.adsetBidStrategy,
        dailyBudget: adsetDailyBudget(input.input, input.placement.createdCampaign),
        lifetimeBudget: adsetLifetimeBudget(input.input, input.placement.createdCampaign),
        bidAmount: input.input.bidAmount,
        bidConstraints: input.input.bidConstraints,
        startTime: input.input.startTime,
        endTime: input.input.endTime,
        targeting: buildSubmissionTargeting(input.input),
        pixelId: input.input.pixelId,
        customEventType: input.input.customEventType,
        attributionSpec: input.input.attributionSpec,
        destinationType: input.input.destinationType,
        frequencyControlSpecs: input.input.frequencyControlSpecs,
        adsetSchedule: input.input.adsetSchedule,
        pacingType: input.input.adsetPacingType,
        dailySpendCap: input.input.dailySpendCap,
        lifetimeSpendCap: input.input.lifetimeSpendCap,
        dailyMinSpendTarget: input.input.dailyMinSpendTarget,
        lifetimeMinSpendTarget: input.input.lifetimeMinSpendTarget,
        isDynamicCreative: input.input.isDynamicCreative,
        assetFeedId: input.input.assetFeedId,
        dsaBeneficiary: input.input.dsaBeneficiary,
        dsaPayor: input.input.dsaPayor,
        regionalRegulatedCategories: input.input.regionalRegulatedCategories,
        graphPayload: input.input.adsetGraphPayload,
      }),
      entity: {
        nodeType: "adset",
        nodeKey: input.placement.adsetId,
        displayName: input.input.adsetName ?? input.placement.adsetId,
        parentNodeType: "campaign",
        parentNodeKey: input.placement.campaignId,
        status: "paused",
      },
      externalIdRequired: true,
    });
    adsetRef = operationRef("adset", input.placement.adsetId);
  }

  operations.push({
    kind: "ad.create",
    ref: operationRef("ad", input.adId),
    dependsOn: [
      operationRef("creative", input.creativeId),
      ...(input.placement.createdAdset ? [operationRef("adset", input.placement.adsetId)] : []),
    ],
    payload: removeUndefined({
      adId: input.adId,
      adsetRef,
      name: input.input.adName ?? input.input.creativeName ?? input.adId,
      creativeRef: operationRef("creative", input.creativeId),
      status: "PAUSED",
      pixelId: input.input.adPixelId,
      conversionSpecs: input.input.conversionSpecs,
      conversionDomain: input.input.conversionDomain,
      creativeAssetGroupsSpec: input.input.creativeAssetGroupsSpec,
      engagementAudience: input.input.engagementAudience,
      priority: input.input.priority,
      displaySequence: input.input.displaySequence,
      adScheduleStartTime: input.input.adScheduleStartTime,
      adScheduleEndTime: input.input.adScheduleEndTime,
      trackingSpecs: sanitizeAdCreateTrackingSpecs(input.input.trackingSpecs),
      graphPayload: sanitizeAdCreateGraphPayload(input.input.adGraphPayload),
    }),
    entity: {
      nodeType: "ad",
      nodeKey: input.adId,
      displayName: input.input.adName ?? input.input.creativeName ?? input.adId,
      parentNodeType: "adset",
      parentNodeKey: input.placement.adsetId,
      status: "paused",
    },
    externalIdRequired: true,
  });

  return operations;
}

function buildSubmissionTargeting(input: CreativeSubmissionInput): Record<string, unknown> | undefined {
  const targeting = removeUndefined({
    ...(input.targeting ?? {}),
    geo_locations:
      input.geoLocations ??
      input.targeting?.geo_locations ??
      ((input.countries && input.countries.length > 0) ? { countries: input.countries } : undefined),
    excluded_geo_locations: input.excludedGeoLocations,
    age_min: input.ageMin,
    age_max: input.ageMax,
    publisher_platforms: input.publisherPlatforms,
    facebook_positions: input.facebookPositions,
    instagram_positions: input.instagramPositions,
    messenger_positions: input.messengerPositions,
    audience_network_positions: input.audienceNetworkPositions,
    device_platforms: input.devicePlatforms,
    user_device: input.userDevice,
    user_os: input.userOs,
    genders: input.genders,
    locales: input.locales,
    custom_audiences: input.customAudiences,
    excluded_custom_audiences: input.excludedCustomAudiences,
    flexible_spec: input.flexibleSpec,
    exclusions: input.exclusions,
    behaviors: input.behaviors,
    life_events: input.lifeEvents,
    targeting_automation: input.targetingAutomation,
  });
  return Object.keys(targeting).length > 0 ? targeting : undefined;
}

function operationRef(nodeType: string, nodeKey: string): string {
  return `{{${nodeType}:${nodeKey}}}`;
}

function flagIfString(flag: string, value: unknown): string[] {
  return typeof value === "string" && value.trim().length > 0 ? [flag, value.trim()] : [];
}

function repeatFlags(flag: string, values: readonly string[] | undefined): string[] {
  return (values ?? []).filter((value) => value.trim().length > 0).flatMap((value) => [flag, value]);
}

function budgetFlagsForOperations(input: CreativeSubmissionInput, accountCurrency: string): string[] {
  const out: string[] = [];
  const daily = dailyBudget(input);
  const lifetime = lifetimeBudget(input);
  if (daily !== undefined) out.push("--daily-budget", amountToMinorUnitsForOperations(daily, accountCurrency));
  if (lifetime !== undefined) out.push("--lifetime-budget", amountToMinorUnitsForOperations(lifetime, accountCurrency));
  return out;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function amountToMinorUnitsForOperations(value: number, accountCurrency: string): string {
  const currency = accountCurrency.trim().toUpperCase();
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return String(Math.round(value * multiplier));
}

function cliValue(value: string): string {
  return value.trim().toLowerCase();
}

function creativeContextToMetadata(
  context: ImprovementPrCreativeGenerationContext | null
): Prisma.InputJsonValue {
  if (!context) return null as unknown as Prisma.InputJsonValue;
  return {
    strategy: context.strategy,
    target: context.target ? creativeNodeToMetadata(context.target) : null,
    references: context.references.slice(0, 3).map(creativeNodeToMetadata),
    notes: context.notes ?? [],
  } as Prisma.InputJsonValue;
}

function creativeNodeToMetadata(node: ImprovementPrCreativeNodeContext): Record<string, unknown> {
  return {
    hierarchyId: node.hierarchyId,
    hierarchy: node.hierarchy,
    nodeKey: node.nodeKey,
    displayName: node.displayName,
    status: node.status,
    current: node.current,
    rationale: node.rationale,
    creative: node.creative ?? null,
  };
}

function readAccountKey(input: CreativeSubmissionInput, fallback: string | null): string {
  const key = input.accountKey?.trim() || fallback;
  if (!key) throw new Error("accountKey が未指定で、デフォルト広告アカウントも未設定です。");
  return key;
}

async function inferCreativeIdentity(input: {
  prisma: PrismaClient;
  accountKey: string;
  adAccountId: string;
  state: Record<string, unknown>;
  input: CreativeSubmissionInput;
}): Promise<void> {
  if (input.input.pageId && input.input.instagramUserId) return;
  const candidates = [
    ...identityCandidatesFromState(input.state),
    ...(await identityCandidatesFromMeta(input.prisma, input.adAccountId)),
  ];
  const chosen = chooseIdentityCandidate(candidates, input.input);
  if (!input.input.pageId && chosen?.pageId) input.input.pageId = chosen.pageId;
  if (!input.input.instagramUserId && chosen?.instagramUserId) {
    input.input.instagramUserId = chosen.instagramUserId;
  }
}

async function inferInstagramActorIdForCli(input: {
  prisma: PrismaClient;
  adAccountId: string;
  input: CreativeSubmissionInput;
}): Promise<void> {
  if (!input.input.instagramUserId) return;
  const actorId = await resolveInstagramActorIdForCli({
    prisma: input.prisma,
    adAccountId: input.adAccountId,
    instagramUserId: input.input.instagramUserId,
  });
  if (actorId) input.input.instagramActorId = actorId;
}

async function resolveInstagramActorIdForCli(input: {
  prisma: PrismaClient;
  adAccountId: string;
  instagramUserId: string;
}): Promise<string | null> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma: input.prisma }).catch(() => null);
  if (!selection || selection.choice === "stub") return null;
  const lease = await selection.adapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease) return null;
  const accountId = input.adAccountId.startsWith("act_")
    ? input.adAccountId
    : `act_${input.adAccountId}`;
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}/instagram_accounts`);
  url.searchParams.set("fields", "id,ig_id,username");
  url.searchParams.set("limit", "100");
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${lease.accessToken}`,
    },
  }).catch(() => null);
  if (!response?.ok) return null;
  const json = (await response.json().catch(() => null)) as unknown;
  const rows = isRecord(json) && Array.isArray(json.data) ? json.data.filter(isRecord) : [];
  const matched = rows.find((row) =>
    readString(row.id) === input.instagramUserId || readString(row.ig_id) === input.instagramUserId
  );
  return readString(matched?.id);
}

function identityCandidatesFromState(state: Record<string, unknown>): MetaAssetIdentityCandidate[] {
  const creatives = Array.isArray(state.creatives) ? state.creatives.filter(isRecord) : [];
  return creatives
    .slice()
    .reverse()
    .map((creative) => ({
      source: "creative_object_story_spec" as const,
      pageId: readString(creative.pageId),
      instagramUserId: readString(creative.instagramUserId),
    }))
    .filter((candidate) => candidate.pageId || candidate.instagramUserId);
}

async function identityCandidatesFromMeta(
  prisma: PrismaClient,
  adAccountId: string
): Promise<MetaAssetIdentityCandidate[]> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma }).catch(() => null);
  if (!selection || selection.choice === "stub") return [];
  const lease = await selection.adapter.loadAccessTokenPlaintext().catch(() => null);
  if (!lease) return [];
  const report = await fetchMetaAssetReadiness({
    accessToken: lease.accessToken,
    adAccountId,
    limit: 100,
  });
  return report.candidates;
}

function chooseIdentityCandidate(
  candidates: readonly MetaAssetIdentityCandidate[],
  input: CreativeSubmissionInput
): MetaAssetIdentityCandidate | null {
  const pageId = input.pageId?.trim() || null;
  const instagramUserId = input.instagramUserId?.trim() || null;
  const withBoth = candidates.filter((candidate) => candidate.pageId && candidate.instagramUserId);
  if (pageId && instagramUserId) {
    return withBoth.find((candidate) => candidate.pageId === pageId && candidate.instagramUserId === instagramUserId) ?? null;
  }
  if (pageId) {
    return withBoth.find((candidate) => candidate.pageId === pageId) ??
      candidates.find((candidate) => candidate.pageId === pageId) ??
      null;
  }
  if (instagramUserId) {
    return withBoth.find((candidate) => candidate.instagramUserId === instagramUserId) ??
      candidates.find((candidate) => candidate.instagramUserId === instagramUserId) ??
      null;
  }
  const firstWithBoth = withBoth[0];
  if (firstWithBoth) return firstWithBoth;
  const uniquePages = uniqueNonNull(candidates.map((candidate) => candidate.pageId));
  const uniqueInstagramUsers = uniqueNonNull(candidates.map((candidate) => candidate.instagramUserId));
  if (uniquePages.length === 1 || uniqueInstagramUsers.length === 1) {
    return {
      source: "creative_object_story_spec",
      pageId: uniquePages[0] ?? null,
      instagramUserId: uniqueInstagramUsers[0] ?? null,
    };
  }
  return null;
}

function uniqueNonNull(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function ensureArray(parent: Record<string, unknown>, key: string): Record<string, unknown>[] {
  if (!Array.isArray(parent[key])) parent[key] = [];
  const arr = (parent[key] as unknown[]).filter(isRecord) as Record<string, unknown>[];
  parent[key] = arr;
  return arr;
}

function uniqueId(existing: Record<string, unknown>[], base: string): string {
  let candidate = base && ID_RE.test(base) ? base : "draft";
  const taken = new Set(existing.map((item) => readString(item.id)).filter((v): v is string => Boolean(v)));
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${candidate}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${Date.now().toString(36)}`;
}

function uniqueNestedAdId(brand: Record<string, unknown>, base: string): string {
  const taken = new Set<string>();
  for (const campaign of ensureArray(brand, "campaigns")) {
    for (const adset of ensureArray(campaign, "adsets")) {
      for (const ad of ensureArray(adset, "ads")) {
        const id = readString(ad.id);
        if (id) taken.add(id);
      }
    }
  }
  return uniqueId([...taken].map((id) => ({ id })), base);
}

function makeStableId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ID_RE.test(normalized) ? normalized : `draft-${Date.now().toString(36)}`;
}

function safeFilename(value: string): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!base || base === "." || base === ".." || base.includes(path.sep)) {
    throw new Error(`素材ファイル名が不正です: ${value}`);
  }
  return base;
}

function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function dailyBudget(input: CreativeSubmissionInput): number | undefined {
  return input.dailyBudget;
}

function lifetimeBudget(input: CreativeSubmissionInput): number | undefined {
  return input.lifetimeBudget;
}

function campaignDailyBudget(input: CreativeSubmissionInput): number | undefined {
  return input.campaignDailyBudget ?? input.dailyBudget;
}

function campaignLifetimeBudget(input: CreativeSubmissionInput): number | undefined {
  return input.campaignLifetimeBudget ?? input.lifetimeBudget;
}

function adsetDailyBudget(input: CreativeSubmissionInput, createdCampaign: boolean): number | undefined {
  return input.adsetDailyBudget ?? (!createdCampaign ? input.dailyBudget : undefined);
}

function adsetLifetimeBudget(input: CreativeSubmissionInput, createdCampaign: boolean): number | undefined {
  return input.adsetLifetimeBudget ?? (!createdCampaign ? input.lifetimeBudget : undefined);
}

function hasAnySubmissionBudget(input: CreativeSubmissionInput): boolean {
  return (
    campaignDailyBudget(input) !== undefined ||
    campaignLifetimeBudget(input) !== undefined ||
    input.adsetDailyBudget !== undefined ||
    input.adsetLifetimeBudget !== undefined ||
    graphPayloadHasBudget(input.campaignGraphPayload) ||
    graphPayloadHasBudget(input.adsetGraphPayload)
  );
}

function graphPayloadHasBudget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.daily_budget !== undefined ||
    value.lifetime_budget !== undefined ||
    value.spend_cap !== undefined ||
    value.daily_spend_cap !== undefined ||
    value.lifetime_spend_cap !== undefined
  );
}

function bidAmount(input: CreativeSubmissionInput): number | undefined {
  return input.bidAmount;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes" || v === "1") return true;
    if (v === "false" || v === "no" || v === "0") return false;
  }
  return null;
}

function readInteger(value: unknown): number | null {
  const n = readNumber(value);
  return n === null ? null : Math.trunc(n);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    const s = readString(item);
    return s ? [s] : [];
  });
  return out.length > 0 ? out : undefined;
}

function readIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    const n = readInteger(item);
    return n === null ? [] : [n];
  });
  return out.length > 0 ? out : undefined;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(isRecord);
  return out.length > 0 ? out : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  const n = readInteger(value);
  return n !== null && n > 0 ? n : null;
}

function readCallToActionArray(value: unknown): CreativeSubmissionInput["callToActions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    const cta = readCallToAction(item);
    return cta ? [cta] : [];
  });
  return out.length > 0 ? out : undefined;
}

function readCountries(value: unknown): string[] | undefined {
  const arr = readStringArray(value);
  if (!arr) return undefined;
  const out = arr.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return out.length > 0 ? out : undefined;
}

function readMediaType(value: unknown): CreativeSubmissionInput["mediaType"] | null {
  const v = readString(value);
  if (v === "image" || v === "video" || v === "carousel" || v === "text") return v;
  return null;
}

function readPlacementMode(value: unknown): CreativeSubmissionPlacementMode | null {
  const raw = readString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return null;
  if (raw === "existing_adset" || raw === "existing_ad_set") return "existing_adset";
  if (raw === "new_adset" || raw === "new_ad_set") return "new_adset";
  if (raw === "new_campaign") return "new_campaign";
  return null;
}

function readImagePlacement(value: unknown): SubmissionImageProfileKey | null {
  const raw = readString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return null;
  if (
    raw === "story_reels" ||
    raw === "stories_reels" ||
    raw === "story" ||
    raw === "stories" ||
    raw === "reel" ||
    raw === "reels" ||
    raw === "instagram_story" ||
    raw === "instagram_stories" ||
    raw === "instagram_reels" ||
    raw === "9:16"
  ) return "story_reels";
  if (
    raw === "feed_portrait" ||
    raw === "portrait" ||
    raw === "instagram_feed_portrait" ||
    raw === "facebook_feed_portrait" ||
    raw === "4:5"
  ) return "feed_portrait";
  if (
    raw === "feed_landscape" ||
    raw === "landscape" ||
    raw === "facebook_feed_landscape" ||
    raw === "instagram_feed_landscape" ||
    raw === "1.91:1" ||
    raw === "191:100"
  ) return "feed_landscape";
  if (
    raw === "feed_square" ||
    raw === "square" ||
    raw === "feed" ||
    raw === "instagram_feed" ||
    raw === "facebook_feed" ||
    raw === "1:1"
  ) return "feed_square";
  return null;
}

function readImageAspectRatio(value: unknown): SubmissionImageAspectRatio | null {
  const raw = readString(value)?.toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;
  if (raw === "1:1" || raw === "square") return "1:1";
  if (raw === "4:5" || raw === "portrait") return "4:5";
  if (raw === "9:16" || raw === "story" || raw === "reels") return "9:16";
  if (raw === "1.91:1" || raw === "landscape" || raw === "1200x628") return "1.91:1";
  return null;
}

function readCallToAction(value: unknown): CreativeSubmissionInput["callToAction"] | null {
  return readMetaEnumToken(value);
}

function readObjective(value: unknown): CreativeSubmissionInput["objective"] | null {
  return readMetaEnumToken(value);
}

function readOptimizationGoal(value: unknown): CreativeSubmissionInput["optimizationGoal"] | null {
  return readMetaEnumToken(value);
}

function readBillingEvent(value: unknown): CreativeSubmissionInput["billingEvent"] | null {
  return readMetaEnumToken(value);
}

function readMetaEnumToken(value: unknown): string | null {
  const v = readString(value)?.trim().toUpperCase();
  if (v && /^[A-Z][A-Z0-9_]*$/.test(v)) return v;
  return null;
}

function joinMetaValues(values: Set<string>): string {
  return Array.from(values).sort().join(" / ");
}

function readCustomEventType(value: unknown): CreativeSubmissionInput["customEventType"] | null {
  const v = readString(value)?.toUpperCase();
  if (
    v === "ADD_PAYMENT_INFO" ||
    v === "ADD_TO_CART" ||
    v === "ADD_TO_WISHLIST" ||
    v === "COMPLETE_REGISTRATION" ||
    v === "CONTACT" ||
    v === "CONTENT_VIEW" ||
    v === "CUSTOMIZE_PRODUCT" ||
    v === "DONATE" ||
    v === "FIND_LOCATION" ||
    v === "INITIATED_CHECKOUT" ||
    v === "LEAD" ||
    v === "OTHER" ||
    v === "PURCHASE" ||
    v === "SCHEDULE" ||
    v === "SEARCH" ||
    v === "START_TRIAL" ||
    v === "SUBMIT_APPLICATION" ||
    v === "SUBSCRIBE"
  ) return v;
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readUrgency(value: unknown): CreativeSubmissionInput["urgency"] | null {
  const v = readString(value);
  if (v === "low" || v === "normal" || v === "high") return v;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
