// AdDroid OSS — `@addroid/llm-provider` barrel.
//
// 各サブモジュール (types / token-store / codex-app-server / api-key / mock / stub / factory /
// pricing) を集約し、apps/web / apps/worker / apps/cli から単一エントリで
// 参照できるようにする。新しい I/O を追加する場合はサブモジュール側に閉じ込め、
// 本ファイルからは re-export のみを行う。
//
// Compatibility note:
// この barrel は workspace 内の internal public API。export の削除・リネームは
// release 前の互換性レビュー対象にする。Mock / Stub / InMemory 系はテスト専用に
// 見えても、未設定時 fallback や local harness から参照されるため維持する。

// Core provider contract and shared errors.
export {
  LLMNotImplementedError,
  LLMOAuthStateMismatchError,
  LLMProviderError,
  LLMProviderNotConfiguredError,
  LLMProviderUnauthenticatedError,
  LLMTokenExpiredError,
  type LLMAuthKind,
  type LLMBeginOAuthResult,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMConnectionMeta,
  type LLMEmbedRequest,
  type LLMEmbedResult,
  type LLMImageRequest,
  type LLMImageResult,
  type LLMMessage,
  type LLMProvider,
  type LLMProviderName,
  type LLMRefreshResult,
  type LLMResponseMeta,
  type LLMRole,
  type LLMUsage,
} from "./types.js";

export { redactPayloadForError } from "./redact.js";

// Token-store helpers for tests, local fallback, and connector implementations.
export {
  InMemoryLLMProviderTokenStore,
  type LLMProviderTokenRecord,
  type LLMProviderTokenStore,
} from "./token-store.js";

// Concrete LLM providers and selection helpers.
export {
  CodexAppServerLLMProvider,
  type CodexLLMAppServerHandle,
  type CodexAppServerLLMProviderOptions,
  type CodexAppServerLoginOptions,
  type CodexLLMAppServerRpcClient,
  type CodexLLMAppServerRpcNotification,
} from "./codex-app-server.js";

export {
  ApiKeyLLMProvider,
  defaultApiKeyChatUrl,
  type ApiKeyCryptoBoundary,
  type ApiKeyLLMProviderDeps,
  type ApiKeyLLMProviderName,
} from "./api-key.js";

export { MockLLMProvider, type MockLLMProviderOptions } from "./mock.js";

export { StubLLMProvider } from "./stub.js";

export {
  selectLLMProvider,
  type LLMProviderChoice,
  type LLMProviderSelection,
  type SelectLLMProviderOptions,
} from "./factory.js";

export {
  estimateCostUsd,
  lookupModelPricing,
  type ModelPricing,
} from "./pricing.js";

// AI run persistence helpers.
export {
  AI_AGENTS,
  AI_RUN_LINKED_REF_TYPES,
  AI_RUN_PROVIDERS,
  AI_RUN_STATUSES,
  AI_WORKFLOWS,
  AiRunValidationError,
  buildAiRunCreateInput,
  buildAiRunCreateInputFromCompletion,
  sanitizeAiRunPayload,
  type AiAgent,
  type AiRunCreateInputData,
  type AiRunLinkedRefType,
  type AiRunStatus,
  type AiWorkflow,
  type BuildAiRunInputFromCompletionOptions,
  type BuildAiRunInputOptions,
} from "./ai-runs.js";

// Image provider contract, implementations, and local/mock harness helpers.
export {
  ImageProviderError,
  ImageProviderInvalidRequestError,
  ImageProviderNotConfiguredError,
  validateImageGenerateRequest,
  type ImageGenerateRequest,
  type ImageGenerateResponseMeta,
  type ImageGenerateResponseParameters,
  type ImageGenerateResponseQaLinkage,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImageProvider,
  type ImageProviderName,
  type ImageReferenceInput,
  type ImageVariationCondition,
} from "./image-provider.js";

export {
  MockImageProvider,
  MOCK_IMAGE_MODELS,
  type MockImageProviderOptions,
} from "./image-mock.js";

export {
  StubImageProvider,
  type StubImageProviderOptions,
} from "./image-stub.js";

export {
  OpenAIImageProvider,
  type OpenAIImageProviderOptions,
} from "./image-openai.js";

export {
  CodexAppServerImageProvider,
  type CodexAppServerHandle,
  type CodexAppServerImageProviderOptions,
  type CodexAppServerRpcClient,
  type CodexAppServerRpcNotification,
} from "./image-codex.js";

export {
  selectImageProvider,
  type ImageProviderChoice,
  type ImageProviderSelection,
  type SelectImageProviderOptions,
} from "./image-factory.js";

export {
  APPEAL_AXES,
  COLOR_SCHEMES,
  GENE_LABELS_JA,
  LANGUAGES,
  LAYOUTS,
  SUBJECT_TYPES,
  TONES,
  describeGenesForPrompt,
  parseCreativeGenes,
  renderGenesVocabularyForPrompt,
  type AppealAxis,
  type CreativeColorScheme,
  type CreativeGenes,
  type CreativeLanguage,
  type CreativeLayout,
  type CreativeSubjectType,
  type CreativeTone,
} from "./creative-genes.js";

export {
  DEFAULT_PLACEMENT_SET,
  PLACEMENT_PRESETS,
  buildPlacementExpansionPlan,
  placementPresetByKey,
  type PlacementExpansionPlan,
  type PlacementKey,
} from "./placements.js";

export {
  parseCarouselCreativeSpec,
  validateCarouselCreativeSpec,
  type CarouselCardRole,
  type CarouselCreativeSpec,
  type CarouselCreativeSpecValidation,
} from "./carousel-spec.js";

export {
  CreativeStorageInvalidIdError,
  CreativeStorageQaIncompleteError,
  persistCreativeAssets,
  type CreativeStorageAdapter,
  type CreativeStorageQaIncompleteReason,
  type PersistCreativeAssetsLinks,
  type PersistCreativeAssetsOptions,
  type PersistCreativeAssetsResult,
  type PersistedCreativeAsset,
  type PersistedCreativeMetadata,
} from "./creative-storage.js";

// Creative QA public helpers.
export {
  CREATIVE_QA_CHECK_KINDS,
  CREATIVE_QA_FALLBACK_TEXT_ONLY,
  CREATIVE_QA_OUTCOMES,
  CREATIVE_QA_OVERALL_OUTCOMES,
  CREATIVE_QA_SEVERITIES,
  DEFAULT_CREATIVE_QA_POLICY,
  DEFAULT_CREATIVE_QA_SEVERITY,
  evaluateCreativeQa,
  evaluateCreativeQaBatch,
  generateAndQaCreative,
  sanitizeEvidence,
  type BrandTonePolicy,
  type CreativeQaAssetInput,
  type CreativeQaAssetResult,
  type CreativeQaBatchResult,
  type CreativeQaCheckKind,
  type CreativeQaCheckResult,
  type CreativeQaOutcome,
  type CreativeQaOverallOutcome,
  type CreativeQaPolicy,
  type CreativeQaSeverity,
  type DimensionAllowedSize,
  type DimensionPolicy,
  type FormatPolicy,
  type ForbiddenExpressionPolicy,
  type GenerateAndQaCreativeOptions,
  type GenerateAndQaCreativeResult,
  type QualityPolicy,
} from "./creative-qa.js";

// Agent prompt builders and runner helpers used by worker pipelines.
export {
  ANALYST_AGENT_SYSTEM_PROMPT,
  AUDIT_AGENT_SYSTEM_PROMPT,
  COPY_AGENT_SYSTEM_PROMPT,
  CREATIVE_QA_AGENT_SYSTEM_PROMPT,
  DANGEROUS_CHANGE_CATEGORIES,
  DEFAULT_ASPECT_RATIO_DIMENSIONS,
  GITOPS_AGENT_SYSTEM_PROMPT,
  IMAGE_PROMPT_AGENT_SYSTEM_PROMPT,
  MEDIA_BUYER_AGENT_SYSTEM_PROMPT,
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
  type AgentRunResult,
  type AnalystAgentDecision,
  type AnalystAgentImprovementCandidate,
  type AnalystAgentInput,
  type AnalystAgentMetrics,
  type AnalystAgentOutput,
  type AuditAgentDangerousFinding,
  type AuditAgentDecision,
  type AuditAgentInput,
  type AuditAgentOutput,
  type CopyAgentDecision,
  type CarouselCardPlan,
  type CopyAgentInput,
  type CopyAgentOutput,
  type CopyAgentVariant,
  type CreativeQaAgentDecision,
  type CreativeQaAgentInput,
  type CreativeQaAgentOutput,
  type CreativeQaIssue,
  type DangerousChangeCategory,
  type GitOpsAgentDecision,
  type GitOpsAgentFile,
  type GitOpsAgentInput,
  type GitOpsAgentOutput,
  type ImagePromptAgentDecision,
  type ImagePromptAgentInput,
  type ImagePromptAgentOutput,
  type ImagePromptVariant,
  type ImagePromptVariantsToConditionsOptions,
  type MediaBuyerAgentDecision,
  type MediaBuyerAgentInput,
  type MediaBuyerAgentOutput,
  type MediaBuyerProposal,
  type StrategyAgentDecision,
  type StrategyAgentInput,
  type StrategyAgentOutput,
} from "./agents.js";
