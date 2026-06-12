// AdDroid OSS — improvement_pr cron handler (Implementation item).
//
// 1 ティック分の improvement_pr ワークフローを実装する:
//
//   1. 対象 ad_account を解決する。未登録なら no_account で抜ける。
//   2. AI 8 agent を順に呼び出す:
//        analyst → strategy → copy → image_prompt → creative_qa →
//        media_buyer → gitops → audit
//      各 agent の `aiRunInput` は呼び出し毎に `store.createAiRun` で永続化する。
//      失敗 (provider error / JSON 不正 / 必須欠落) は throw せず、
//      status="failed" の ai_runs を残してワークフローを `ai_failed` に倒す。
//   3. media_buyer が "propose" を返さない、もしくは proposals が空なら
//      `skipped_no_proposal` で抜ける (PR は作らない)。creative_qa が
//      "approve" を返さなかった、または gitops が "skip" の場合も同様。
//   4. media_buyer + gitops の出力を使って `ImprovementPrGithubPublisher` で
//      PR を作成する。失敗時は `pr_failed` で抜ける (audit には残す)。
//   5. audit agent の分類 (`safe | requires_approval | dangerous`) と
//      decision (`auto_approved | approval_required | auto_blocked`) を
//      `ImprovementPrAuditWriter` で audit_logs / approval_records に書き、
//      summary を返す。
//
// 設計原則:
//   - Prisma / pg-boss / GitHub adapter / LLM Provider を直接 import しない。
//     すべて injected interface 経由。テストは in-memory fake で完結する。
//   - AI 失敗時でも ai_runs は status="failed" で書き、cron_run を ai_failed
//     に倒す (= GitOps state は腐らない)。
//   - dangerous categories (budget_increase / new_campaign / targeting_change /
//     monthly_budget_change / automation_rule_change) は audit agent が
//     `auto_blocked` を返した時点で approval_records.decision="auto_blocked" と
//     して記録され、PR は AdDroid の対話型承認または GitHub merge を承認境界に持つ。
//   - 改善提案は必ず `publisher.createPullRequest` を経由してから succeeded を
//     返す。`pipeline` + `publisher` + `audit` が揃わない呼び出しは throw する
//     (= proposals が PR boundary を迂回して succeeded になる経路は存在しない)。

import {
  DEFAULT_CREATIVE_QA_POLICY,
  buildPlacementExpansionPlan,
  generateAndQaCreative,
  imagePromptVariantsToVariationConditions,
  persistCreativeAssets,
  placementPresetByKey,
  validateCarouselCreativeSpec,
  type AiRunCreateInputData,
  type CarouselCreativeSpec,
  type CreativeGenes,
  type CreativeQaPolicy,
  type CreativeStorageAdapter,
  type ImageProvider,
  type ImagePromptVariant,
  type ImageReferenceInput,
  type ImageVariationCondition,
  type PersistCreativeAssetsResult,
  type PersistedCreativeAsset,
  type PlacementKey,
} from "@addroid/llm-provider";
import type { DailyReportAdAccountSnapshot } from "./daily-report.js";
import {
  buildCreativePerformanceDigest,
  type CreativePerformanceDigest,
  type CreativePerformanceStore,
} from "./creative-performance.js";
import {
  buildProposalFeedbackDigest,
  proposalFeedbackDigestToAgentInput,
  type ProposalFeedbackStore,
  type ProposalWorkspaceFeedback,
} from "./proposal-feedback.js";
import {
  combineApprovalClassifications,
  combineApprovalDecisions,
  evaluateApprovalPolicy,
  unionDangerousCategories,
  type ExecutionMode,
} from "./execution-mode.js";

export type ImprovementPrExecutionMode = ExecutionMode;

export type ImprovementPrDecision =
  | "propose"
  | "skip_no_proposal"
  | "skip_dangerous_only";

export type ImprovementPrAuditDecision =
  | "auto_approved"
  | "approval_required"
  | "auto_blocked";

export type ImprovementPrAuditClassification =
  | "safe"
  | "requires_approval"
  | "dangerous";

export type ImprovementPrRiskTolerance =
  | "conservative"
  | "balanced"
  | "aggressive";

export type ImprovementPrRunStatus =
  | "succeeded"
  | "no_account"
  | "ai_failed"
  | "skipped_no_proposal"
  | "auto_blocked"
  | "pr_failed";

export interface ImprovementPrProposal {
  hierarchy: "account" | "campaign" | "adset" | "ad";
  target: string;
  category: string;
  proposedChange: string;
  rationale: string;
}

export interface ImprovementPrBudgetImpact {
  deltaCurrency: number;
  afterCurrency: number;
  notes: string;
}

export interface ImprovementPrFileChange {
  path: string;
  action: "create" | "update" | "delete";
  diff: string;
}

/**
 * `ImprovementPrCreativeAttachment` — PR に添付する 1 creative 分のサマリ。
 * orchestrator が image_prompt + creative_qa + creatives 永続化の結果から組み立て、
 * (a) PR に添付する creative evidence ファイル
 *     (`evidence/creatives/<account_key>/<creative_id>.yaml`) と、
 * (b) PR body の `## 生成クリエイティブ` セクション
 * の双方を構築するために使う。
 *
 * implementation item 段階では画像バイナリは LocalDisk に書かれていない (image-Provider
 * 実呼び出しは後続 hop / 別タスク)。`storageRef` / `provider` / `model` /
 * `parameters` は将来 image-Provider hop が orchestrator に注入できるよう
 * optional にしてあり、未設定なら PR body は「(プロンプトのみ)」と表示する。
 */
export interface ImprovementPrCreativeAttachment {
  /** `creatives.id` (DB primary key)。manifest ファイル名にも使う。 */
  creativeDbId: string;
  /** `creatives.key` (account 内で安定なクリエイティブキー)。 */
  creativeKey: string;
  /** UI 表示用の sanitized 名前。 */
  displayName: string;
  /** "image" | "carousel" | ... */
  mediaType?: string;
  /** バリアント連番 (0-based)。 */
  variantIndex: number;
  /** バリアントのプロンプト + style metadata。 */
  prompt: ImprovementPrCreativePromptVariant;
  /** image_prompt 全体の rationale (生成理由)。バリアント間で共通。 */
  rationale: string;
  /** creative_status vocabulary の値 (qa_passed | qa_warned | ...)。 */
  status: ImprovementPrCreativeStatus;
  /** creative_qa の評価結果 (per-check breakdown 含む)。 */
  qa: {
    aiRunId: string;
    recommendation: ImprovementPrCreativeQaRecommendation;
    issues: ImprovementPrCreativeQaIssue[];
    rationale: string;
  };
  /** image_prompt agent の ai_run id。 */
  imagePromptAiRunId: string;
  /**
   * 画像 Provider 名 (`openai` | `stability` | `replicate` | `mock`)。
   * implementation item 時点では image-Provider hop が orchestrator に組み込まれていないため
   * null。将来 hop が値を埋める。
   */
  provider?: string | null;
  /** 画像モデル id (例: `gpt-image-1`, `sd3-large`)。同上。 */
  model?: string | null;
  /**
   * `storage://creatives/<account_key>/<creative_id>/<asset_id>.<ext>` の
   * 安定 storage ref (preview / 監査参照用)。バイナリ未生成なら null で、
   * PR body は「(プロンプトのみ)」と明示する (UI design plan principle 23/24)。
   */
  storageRef?: string | null;
  /**
   * Storage Adapter 内の相対 key (`creatives/<account_key>/<creative_id>/<asset>.<ext>`)。
   * `creatives.storagePath` 列に保存される (UI には出さない、内部用)。
   */
  storagePath?: string | null;
  /** 生成パラメータのスナップショット (variation_conditions 等)。同上。 */
  parameters?: Record<string, unknown> | null;
  /** creative_qa agent が推定した閉じた語彙の構造化タグ。 */
  genes?: CreativeGenes | null;
  /** Carousel の場合、カード構成。 */
  carouselSpec?: CarouselCreativeSpec | null;
  /** Carousel など複数 asset を持つ creative の per-asset summary。 */
  assets?: Array<{
    variantKey: string;
    storageRef: string | null;
    storagePath: string | null;
  }>;
}

// ---------------------------------------------------------------------
// Plan / dry-run validator (Regression fix)
// ---------------------------------------------------------------------

export type ImprovementPrPlanRiskLevel = "ok" | "warn" | "error";

export interface ImprovementPrPlanCounts {
  creates: number;
  updates: number;
  deletes: number;
  errors: number;
  warnings: number;
}

export interface ImprovementPrPlanFinding {
  file: string;
  message: string;
  pointer?: string;
}

/**
 * gitops が出した YAML 変更を、プロジェクトの正規 dry-run / plan 経路に通した
 * 結果。LLM-authored の `dryRunSummary` ではなく、Zod 検証 +
 * operation manifest validation による実 plan の出力を 1 つの構造体に丸めたもの。
 */
export interface ImprovementPrPlanValidationResult {
  /** 検証が実際に走ったか。ops repo の local checkout が無い等の理由で skip された場合は false。 */
  available: boolean;
  /** validation / plan-level error が無かったか。available=false なら false。 */
  ok: boolean;
  risk: ImprovementPrPlanRiskLevel;
  counts: ImprovementPrPlanCounts;
  errors: ImprovementPrPlanFinding[];
  warnings: ImprovementPrPlanFinding[];
  /** 1 行 human-readable 要約 (PR body / audit summary 用、sanitize 済み)。 */
  summary: string;
  durationMs: number;
}

export interface ImprovementPrPlanValidator {
  /**
   * gitops 出力 (YAML 変更) を実際の plan/dry-run 経路に通して検証する。
   *
   * - 失敗時も throw せず、`ok=false` + errors を含む結果を返す。
   * - ops repo の local checkout が利用できない場合は `available=false` を返す。
   *   呼び出し側 (orchestrator) は available=false でも PR を発行し、
   *   PR body と audit metadata に「skipped: ops repo 未配備」を残す。
   */
  validate(input: {
    accountKey: string;
    files: ImprovementPrFileChange[];
  }): Promise<ImprovementPrPlanValidationResult>;
}

export interface ImprovementPrCreativePromptVariant {
  prompt: string;
  negativePrompt: string;
  styleNotes: string;
  variantKey?: string;
  baseVariantKey?: string;
  placementKey?: PlacementKey;
  placementLabel?: string;
}

/**
 * `ImprovementPrCreativeRecord` — image_prompt エージェントが生成した 1 バリアント
 * 分のクリエイティブ metadata。orchestrator は `image_prompt` と `creative_qa` の
 * ai_runs を両方とも永続化した後、1 variant につき 1 行 `createCreative` を呼ぶ。
 *
 * - `aiRunId` は image_prompt の ai_run。`Creative.aiRunId` リレーションに使う。
 * - `qa.aiRunId` は creative_qa の ai_run。creatives テーブルの
 *   `creativeQaAiRunId` 列にもコピーされ、JOIN 一発で QA run に辿り着ける。
 * - `status` は creative_status vocabulary の中から 1 値。orchestrator が
 *   creative_qa.recommendation を見て決定する (approve→qa_passed,
 *   request_changes→qa_warned, reject→qa_failed)。PR 添付後は
 *   `linkCreativesToPullRequest` 経由で `attached_to_pr` に書き換わる。
 * - 画像バイナリ (storagePath) は本構造体には含まれない。binary 生成は別 hop で、
 *   QA を通った variant のみ後段の Storage Adapter が `storagePath` /
 *   `storageRef` / `provider` / `model` / `parameters` を埋める。the current implementation
 *   implementation item では prompt-only 段階の保存契約のみを扱い、それらの列は null で
 *   作成される (Storage hop / future image-Provider hop が後で update する)。
 *   prompt-only fallback の場合でもこの構造体で metadata は永続化される。
 */
export interface ImprovementPrCreativeRecord {
  /** AdAccount.id (FK)。 */
  accountId: string;
  /**
   * regression fix: 紐付く ads_hierarchy.id (campaign / adset / ad)。schema 上
   * `Creative.hierarchyId String?` の "where applicable" を満たすため、本フィールドを
   * 経由して orchestrator から runtime store まで値を流す (= acceptance:
   * "creatives table links generated assets to ... campaign/ad where applicable").
   * image_prompt agent が account-level に対して走り、特定 hierarchy node を
   * targeting しない現状運用では null を渡す。後続 task で agent が node を
   * 解決した場合は本フィールドに id を入れて persist される (= データ経路を
   * 開けておく)。
   */
  hierarchyId?: string | null;
  /** account 内で安定なクリエイティブキー (`@@unique([accountId, key])`)。 */
  key: string;
  /** UI 表示用の sanitized 名前。 */
  displayName: string;
  /** "image" | "video" | "carousel" | "text" — the current implementation では基本 "image"。 */
  mediaType: string;
  /** image_prompt ai_run の id。 */
  aiRunId: string;
  /** バリアント連番 (0-based)。 */
  variantIndex: number;
  /** バリアントのプロンプト + style metadata。 */
  prompt: ImprovementPrCreativePromptVariant;
  /** image_prompt 全体の rationale (バリアント間で共通)。 */
  rationale: string;
  /** Meta広告プレビュー用の本文 / 見出し / 説明 / CTA。 */
  adText?: {
    primaryText: string;
    headline: string;
    description: string;
    callToAction: string;
    rationale?: string | null;
  } | null;
  /** 紐付く creative_qa ai_run の id + 評価結果。 */
  qa: {
    aiRunId: string;
    recommendation: ImprovementPrCreativeQaRecommendation;
    issues: ImprovementPrCreativeQaIssue[];
    rationale: string;
  };
  /**
   * creative_status vocabulary の値。orchestrator が `creative_qa.recommendation`
   * から派生して渡す。PR 添付後は `linkCreativesToPullRequest` で
   * `attached_to_pr` に更新される。
   */
  status: ImprovementPrCreativeStatus;
  /**
   * regression fix: image-Provider hop が走った場合に埋まる生成成果物 metadata。
   * 未設定 / Provider 失敗 (= prompt-only fallback) では全項目 null で、
   * `creatives` 行も prompt-only な audit metadata として独立して機能する。
   * Storage Adapter 内の安定 ref (`storage://creatives/<account_key>/<creative_id>/<asset_id>.<ext>`)。
   */
  storageRef?: string | null;
  /** Storage Adapter 内の相対 key (LocalDisk 内部用)。 */
  storagePath?: string | null;
  /** 画像 Provider 名 (`openai` | `stability` | `replicate` | `mock`)。 */
  provider?: string | null;
  /** 画像モデル id (例: `gpt-image-1`, `sd3-large`)。 */
  model?: string | null;
  /** 生成パラメータのスナップショット (variation_conditions / variant_count / purpose 等)。 */
  parameters?: Record<string, unknown> | null;
  /** creative_qa agent が推定した閉じた語彙の構造化タグ。 */
  genes?: CreativeGenes | null;
  /** Carousel の場合、cards/storyArc を creatives.spec に同梱する。 */
  carouselSpec?: CarouselCreativeSpec | null;
}

/**
 * `Creative.status` が取り得る値 (the current implementation creative_status vocabulary)。
 *
 * implementation item で実際に書き込み得るのは `qa_passed | qa_warned | qa_failed |
 * attached_to_pr | fallback_text_only` のみ。`generating` / `qa_running` /
 * `merged` / `active_on_meta` / `superseded` は image-Provider 実呼び出し /
 * github_poll / activate hop が後続タスクで書き込む。
 */
export type ImprovementPrCreativeStatus =
  | "queued"
  | "generating"
  | "qa_running"
  | "qa_passed"
  | "qa_warned"
  | "qa_failed"
  | "attached_to_pr"
  | "merged"
  | "active_on_meta"
  | "superseded"
  | "fallback_text_only";

/**
 * `linkCreativesToPullRequest` 入力。PR 発行成功直後に orchestrator から呼ばれ、
 * 当該 improvement_pr run で生まれた creatives 行に `pullRequestId` をセットし、
 * `status` を `attached_to_pr` に進める。creative_qa が `reject` した variant は
 * `pullRequestId` を持たないため、`creativeIds` には含めない契約。
 */
export interface ImprovementPrCreativeLinkInput {
  /** 当該 PR に添付する creatives.id の配列 (順序は image_prompt variant 順)。 */
  creativeIds: string[];
  /** github_pull_requests.id (FK)。 */
  pullRequestId: string;
  /** github_pull_requests.number (UI 表示 / metadata 用)。 */
  pullRequestNumber: number;
  /**
   * 進める status。既定は `attached_to_pr`。後続 hop が `merged` /
   * `active_on_meta` を上書きするときに同じ method を再利用できるよう、引数化。
   */
  status?: ImprovementPrCreativeStatus;
}

export interface ImprovementPrStore {
  findAdAccount(input: {
    workspaceId: string;
    accountKey: string;
  }): Promise<DailyReportAdAccountSnapshot | null>;
  /**
   * Optional creative performance feedback source. When unavailable or empty,
   * improvement_pr keeps the pre-feedback prompt inputs unchanged.
   */
  listAdCreativePerformance?: CreativePerformanceStore["listAdCreativePerformance"];
  listProposalOutcomes?: ProposalFeedbackStore["listProposalOutcomes"];
  /**
   * 8 agent の sanitized ai_runs 行を 1 行 insert する。
   * 呼び出し側 (apps/worker) は `prisma.aiRun.create({ data })` を実行する。
   */
  createAiRun(data: AiRunCreateInputData): Promise<{ id: string }>;
  linkAiRunToPullRequest?(input: {
    aiRunId: string;
    pullRequestId: string;
  }): Promise<void>;
  /**
   * image_prompt が出力した 1 バリアント分のクリエイティブ metadata を
   * `creatives` テーブルに 1 行 insert する。`spec` は image_prompt の
   * prompt/negativePrompt/styleNotes/rationale + creative_qa の
   * aiRunId/recommendation/issues/rationale を 1 つの JSON にまとめて持つ。
   * Storage Adapter が後段で `storagePath` / `storageRef` / `provider` /
   * `model` / `parameters` を埋めるまで、本テーブル行は prompt-only な
   * 「audit metadata」として独立して機能する。
   */
  createCreative(data: ImprovementPrCreativeRecord): Promise<{ id: string }>;
  /**
   * PR 発行成功直後に呼ばれ、当該 improvement_pr run で生まれた creatives 行に
   * `pullRequestId` を埋め、`status` を `attached_to_pr` に進める (= acceptance
   * criterion: creatives table links generated assets to ... PR)。
   *
   * 入力 `creativeIds` が空配列の場合は何もしない (no-op)。
   * 既に `merged` / `active_on_meta` 等の進んだ status を持つ行に対しては
   * 上書きしないことを実装側 (Prisma updateMany) で担保する。
   */
  linkCreativesToPullRequest(
    input: ImprovementPrCreativeLinkInput,
  ): Promise<void>;
}

// ---------------------------------------------------------------------
// Step result — uniform shape across the 8 agents
// ---------------------------------------------------------------------

export interface ImprovementPrAgentRunResult<TOutput> {
  /** Prisma-ready ai_runs row (sanitize 済み)。失敗時も必ず存在する。 */
  aiRunInput: AiRunCreateInputData;
  /** 成功時のみ非 null。 */
  output: TOutput | null;
  /** 失敗時の sanitized 1 行説明。成功時は null。 */
  error: string | null;
}

// ---------------------------------------------------------------------
// Media buyer agent output (shared with pipeline runner)
// ---------------------------------------------------------------------

export interface ImprovementPrMediaBuyerOutput {
  proposals: ImprovementPrProposal[];
  budgetImpact: ImprovementPrBudgetImpact;
  dryRunSummary: string;
  rationale: string;
}

// ---------------------------------------------------------------------
// Pipeline runner (this implementation) — runs all 8 agents
// ---------------------------------------------------------------------

export interface ImprovementPrPipelineInput {
  accountId: string;
  /** UI 表示 / prompt 用の displayName。 */
  accountDisplayName: string;
  currency: string;
  /** 紐付く performance_snapshots の id。 */
  snapshotIds: string[];
  /** 現在の日次予算 (account 合計, currency 単位)。 */
  currentDailyBudget: number;
  riskTolerance: ImprovementPrRiskTolerance;
  mode: ImprovementPrExecutionMode;
  /** ops repo (例: "myorg/ads-config"). 無ければ空文字。 */
  repo: string;
  /** PR base ref. 既定 "main"。 */
  baseRef?: string;
}

export interface ImprovementPrPerformanceMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr?: number;
  cpc?: number;
  cpa?: number;
}

export interface ImprovementPrAnalysisWindow {
  periodStart: string;
  periodEnd: string;
  priorPeriodStart?: string;
  priorPeriodEnd?: string;
  current: ImprovementPrPerformanceMetrics;
  prior?: ImprovementPrPerformanceMetrics;
}

export interface ImprovementPrCreativeNodeContext {
  hierarchyId: string | null;
  hierarchy: "account" | "campaign" | "adset" | "ad";
  nodeKey: string;
  displayName: string;
  status?: string | null;
  externalId?: string | null;
  current: ImprovementPrPerformanceMetrics;
  prior?: ImprovementPrPerformanceMetrics;
  rationale: string;
  spec?: Record<string, unknown> | null;
  creative?: {
    key?: string | null;
    displayName?: string | null;
    mediaType?: string | null;
    headline?: string | null;
    primaryText?: string | null;
    callToAction?: string | null;
    linkUrl?: string | null;
    pageId?: string | null;
    instagramUserId?: string | null;
    storageRef?: string | null;
    provider?: string | null;
    model?: string | null;
    images?: string[];
  } | null;
}

export interface ImprovementPrBrandProfileContext {
  brandName?: string;
  tone?: string;
  palette?: string[];
  typography?: string;
  guidelines?: string;
  forbiddenTerms?: string[];
}

export interface ImprovementPrCreativeGenerationContext {
  /**
   * 実務では勝ち広告を seed にして派生案を作ることが多いため、既定は
   * `scale_winner`。低調ノードが明確にある場合は target と reference を分ける。
   */
  strategy:
    | "scale_winner"
    | "adapt_winner_to_underperformer"
    | "refresh_underperformer";
  target: ImprovementPrCreativeNodeContext | null;
  references: ImprovementPrCreativeNodeContext[];
  brandProfile?: ImprovementPrBrandProfileContext | null;
  notes?: string[];
}

export interface ImprovementPrAnalystOutput {
  commentary: string;
  deltas: Record<string, string>;
  topImprovements: {
    hierarchy: "account" | "campaign" | "adset" | "ad";
    target: string;
    rationale: string;
    expectedImpact: string;
  }[];
}

export interface ImprovementPrStrategyOutput {
  recommendedApproach: string;
  audienceFocus: string;
  channelMix: string[];
  riskNotes: string[];
  rationale: string;
}

export interface ImprovementPrCopyVariant {
  headline: string;
  primaryText: string;
  cta: string;
  description?: string | null;
}

export interface ImprovementPrCarouselCardPlan {
  position: number;
  role: "hook" | "feature" | "social_proof" | "offer" | "cta";
  headline: string;
  description: string | null;
  imageBrief: string;
  linkUrl?: string | null;
}

export interface ImprovementPrCopyOutput {
  primary: ImprovementPrCopyVariant;
  alternates: ImprovementPrCopyVariant[];
  rationale: string;
  carousel?: {
    cards: ImprovementPrCarouselCardPlan[];
    storyArc: string;
  };
}

export interface ImprovementPrImagePromptVariant {
  prompt: string;
  negativePrompt: string;
  styleNotes: string;
  variantKey?: string;
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
  aspectRatio?: string;
}

export interface ImprovementPrImagePromptOutput {
  variants: ImprovementPrImagePromptVariant[];
  rationale: string;
}

export interface ImprovementPrImageDimensionPreset {
  key: string;
  width: number;
  height: number;
  format?: "png" | "jpeg";
}

export const IMPROVEMENT_PR_IMAGE_DIMENSION_PRESETS: ImprovementPrImageDimensionPreset[] =
  [
    { key: "feed_square", width: 1080, height: 1080, format: "png" },
    { key: "feed_portrait", width: 1080, height: 1350, format: "png" },
    { key: "story_reels", width: 1080, height: 1920, format: "png" },
    { key: "feed_landscape", width: 1200, height: 628, format: "png" },
  ];

export type ImprovementPrCreativeQaRecommendation =
  | "approve"
  | "request_changes"
  | "reject";

export interface ImprovementPrCreativeQaIssue {
  severity: "info" | "warn" | "error";
  category: string;
  message: string;
}

export interface ImprovementPrCreativeQaOutput {
  issues: ImprovementPrCreativeQaIssue[];
  recommendation: ImprovementPrCreativeQaRecommendation;
  rationale: string;
  genes?: CreativeGenes;
}

/**
 * regression fix: `runCreativeQa` の optional 入力。Provider が既に bytes を
 * 返している variant に対して、production wiring が dimensions / format /
 * quality / forbidden_expression / brand_tone の決定論的検査を走らせるための
 * メタデータ。`evaluateCreativeQaBatch` の `CreativeQaAssetInput` と互換な
 * shape (= queue 層が `@addroid/llm-provider` の internal 型を直接 import せず
 * とも同等の入力を組み立てられる)。
 */
export interface ImprovementPrCreativeQaAssetCheck {
  variantKey: string;
  width: number;
  height: number;
  byteSize: number;
  /** "image/png" | "image/jpeg" 等。 */
  mimeType: string;
  /** Provider 報告の quality score (0..1)。任意。 */
  providerQualityScore?: number | null;
  /** OCR / Vision LLM 由来のテキスト (sanitize 済み)。任意。 */
  detectedText?: string | null;
}

export interface ImprovementPrGitOpsOutput {
  prTitle: string;
  prBody: string;
  branchName: string;
  files: ImprovementPrFileChange[];
}

export interface ImprovementPrAuditOutput {
  classification: ImprovementPrAuditClassification;
  dangerousCategories: string[];
  rationale: string;
}

/**
 * `ImprovementPrPipelineRunner` — 8 agent をワークフロー側で順序実行する境界。
 *
 * 各 method は対応する agent を 1 回呼び出し、Prisma-ready `aiRunInput` と
 * パース済みの output を返す。LLM Provider 失敗 / JSON 不正は throw せず
 * `output=null + error="..."` で返す。orchestrator は per-step の永続化と
 * 早期 short-circuit を担当する。
 */
export interface ImprovementPrPipelineRunner {
  runAnalyst(input: {
    accountId: string;
    accountDisplayName: string;
    currency: string;
    snapshotIds: string[];
    currentDailyBudget: number;
    analysisWindow: ImprovementPrAnalysisWindow;
  }): Promise<ImprovementPrAgentRunResult<ImprovementPrAnalystOutput>>;
  runStrategy(input: {
    accountId: string;
    accountDisplayName: string;
    currency: string;
    analystCommentary: string;
    riskTolerance: ImprovementPrRiskTolerance;
    creativeContext?: ImprovementPrCreativeGenerationContext | null;
    workspaceFeedback?: ProposalWorkspaceFeedback;
  }): Promise<ImprovementPrAgentRunResult<ImprovementPrStrategyOutput>>;
  runCopy(input: {
    accountId: string;
    accountDisplayName: string;
    audienceFocus: string;
    recommendedApproach: string;
    creativeContext?: ImprovementPrCreativeGenerationContext | null;
    performanceDigest?: CreativePerformanceDigest | null;
    creativeFormat?: "single_image" | "carousel";
    carouselCardCount?: number;
  }): Promise<ImprovementPrAgentRunResult<ImprovementPrCopyOutput>>;
  runImagePrompt(input: {
    accountId: string;
    accountDisplayName: string;
    currency: string;
    audienceFocus: string;
    primaryHeadline: string;
    primaryText: string;
    analystCommentary: string;
    strategy: ImprovementPrStrategyOutput;
    analysisWindow: ImprovementPrAnalysisWindow;
    creativeContext?: ImprovementPrCreativeGenerationContext | null;
    performanceDigest?: CreativePerformanceDigest | null;
    placementSet?: PlacementKey[];
    carousel?: ImprovementPrCopyOutput["carousel"];
  }): Promise<ImprovementPrAgentRunResult<ImprovementPrImagePromptOutput>>;
  runCreativeQa(input: {
    copy: ImprovementPrCopyOutput;
    imagePrompts: ImprovementPrImagePromptOutput;
    /**
     * regression fix: 既に Provider が bytes を返している場合に渡す per-asset
     * メタデータ。production wiring (`apps/worker/src/lib/improvement-pr-runtime.ts`)
     * は本配列を受け取った時、`evaluateCreativeQaBatch` を実行して dimensions /
     * format / quality / forbidden_expression / brand_tone を決定論的に検査し、
     * blocking failure があれば LLM 出力の `recommendation` を `reject` に
     * 強制ダウングレードする (= "complete per-asset QA before any PR linkage" の
     * acceptance を満たすための明示ゲート)。
     *
     * 配列が空 / 未指定の場合は LLM 単独の判定 (= プロンプトベース) のみで
     * 進む。orchestrator が image_prompt → image-Provider → runCreativeQa の
     * 順で呼ぶよう将来再構成された場合に load-bearing になる契約。
     */
    generatedAssets?: ImprovementPrCreativeQaAssetCheck[];
  }): Promise<ImprovementPrAgentRunResult<ImprovementPrCreativeQaOutput>>;
  runMediaBuyer(input: {
    accountId: string;
    currency: string;
    snapshotIds: string[];
    currentDailyBudget: number;
    riskTolerance: ImprovementPrRiskTolerance;
    analystSummary: string;
    creativeContext?: ImprovementPrCreativeGenerationContext | null;
    workspaceFeedback?: ProposalWorkspaceFeedback;
  }): Promise<
    ImprovementPrAgentRunResult<ImprovementPrMediaBuyerOutput> & {
      decision: ImprovementPrDecision | null;
    }
  >;
  runGitOps(input: {
    accountId: string;
    proposals: ImprovementPrProposal[];
    repo: string;
    baseRef: string;
    branchHint: string;
  }): Promise<
    ImprovementPrAgentRunResult<ImprovementPrGitOpsOutput> & {
      decision: "propose" | "skip" | null;
    }
  >;
  runAudit(input: {
    accountId: string;
    proposals: ImprovementPrProposal[];
    files: ImprovementPrFileChange[];
    mode: ImprovementPrExecutionMode;
    safeCategories: string[];
  }): Promise<
    ImprovementPrAgentRunResult<ImprovementPrAuditOutput> & {
      decision: ImprovementPrAuditDecision | null;
    }
  >;
}

// ---------------------------------------------------------------------
// GitHub publisher — gitops 出力を ops repo に PR として反映する境界
// ---------------------------------------------------------------------

export interface ImprovementPrPullRequestRequest {
  branchName: string;
  prTitle: string;
  prBody: string;
  files: ImprovementPrFileChange[];
  baseRef: string;
}

export interface ImprovementPrPullRequestRecord {
  /** github_pull_requests.id */
  pullRequestId: string;
  /** github_pull_requests.number */
  prNumber: number;
  /** PR HTML URL (sanitize 済みで UI に出る). */
  htmlUrl: string;
  /** branch HEAD sha */
  headSha: string;
}

export interface ImprovementPrGithubPublisher {
  /**
   * gitops 出力を ops repo に PR として書き込む。
   *
   * - 成功時: `{ pullRequestId, prNumber, htmlUrl, headSha }` を返す。
   * - 失敗時: throw する。orchestrator は status="pr_failed" に倒し、audit に
   *   失敗を記録する。github_pull_requests 行が部分的に作られていても
   *   GitOps state は腐らない (audit_logs に痕跡が残る)。
   */
  createPullRequest(
    req: ImprovementPrPullRequestRequest,
  ): Promise<ImprovementPrPullRequestRecord>;
}

// ---------------------------------------------------------------------
// Audit writer — workflow 単位の audit_logs / approval_records 書き込み境界
// ---------------------------------------------------------------------

export type ImprovementPrAuditAction =
  | "improvement_pr.opened"
  | "improvement_pr.skipped"
  | "improvement_pr.failed";

export interface ImprovementPrAuditInput {
  workspaceId: string;
  accountKey: string;
  accountId: string;
  cronRunId: string | null;
  action: ImprovementPrAuditAction;
  /** PR が立った場合のみ非 null。 */
  pullRequest: ImprovementPrPullRequestRecord | null;
  /** 紐付く ai_runs.id 一覧 (永続化された全段)。 */
  aiRunIds: string[];
  /** audit agent の決定。失敗時は null。 */
  auditDecision: ImprovementPrAuditDecision | null;
  classification: ImprovementPrAuditClassification | null;
  dangerousCategories: string[];
  /** 実体としては budget impact / proposalCount / snapshotIds 等を含む。 */
  metadata: Record<string, unknown>;
  summary: string;
}

export interface ImprovementPrAuditWriter {
  recordImprovementPrAudit(input: ImprovementPrAuditInput): Promise<void>;
}

// ---------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------

export interface ImprovementPrSummary {
  status: ImprovementPrRunStatus;
  workspaceId: string;
  accountKey: string;
  accountId: string | null;
  mode: ImprovementPrExecutionMode;
  /** 旧 API: media_buyer の ai_run.id。後方互換のため残す。 */
  aiRunId: string | null;
  /** 全 step の ai_runs.id 一覧 (順序: analyst → ... → audit). */
  aiRunIds: string[];
  /**
   * 当該 run で永続化された creatives.id 一覧 (image_prompt の variant 順)。
   * creative_qa が出力を返さなかった、または image_prompt が失敗した場合は空配列。
   */
  creativeIds: string[];
  /** media_buyer の決定。 */
  decision: ImprovementPrDecision | null;
  proposalCount: number;
  /** 表示通貨。account が解決できない場合は null。 */
  currency: string | null;
  /** PR 作成成功時のみ非 null。 */
  pullRequest: ImprovementPrPullRequestRecord | null;
  /** audit agent の最終分類。失敗時は null。 */
  classification: ImprovementPrAuditClassification | null;
  /** audit agent の最終決定。失敗時は null。 */
  auditDecision: ImprovementPrAuditDecision | null;
  dangerousCategories: string[];
  errorMessage?: string;
}

export interface RunImprovementPrOptions {
  workspaceId: string;
  mode: ImprovementPrExecutionMode;
  /**
   * `auto_creative_generation` は creative 作成と QA 記録までで止める。
   * Meta 変更や GitHub PR 作成は行わず、creatives ライブラリに候補を残す。
   */
  workflowIntent?: "improvement_proposal" | "auto_creative_generation";
  accountKey: string;
  /** 紐付く performance_snapshots の id (analyst が直近で生成したもの)。 */
  snapshotIds?: string[];
  /** 現在の日次予算 (account 合計, currency 単位)。0 が既定。 */
  currentDailyBudget?: number;
  /**
   * 改善提案の判断に使う実績期間。未指定時は後方互換のため実行日・0実績に倒す。
   * production cron は前日までの直近 7 日を渡す。
   */
  analysisWindow?: ImprovementPrAnalysisWindow;
  /**
   * 生成クリエイティブの実務文脈。production worker は performance_snapshots と
   * ads_hierarchy から「参照する勝ち広告」と「改善対象ノード」を組み立てて渡す。
   */
  creativeContext?: ImprovementPrCreativeGenerationContext | null;
  riskTolerance?: ImprovementPrRiskTolerance;
  /** ops repo "owner/name". 未設定だと PR 経路は無効化される。 */
  repo?: string;
  /** PR base ref. 既定 "main"。 */
  baseRef?: string;
  /** auto_apply モードで許される safe operation カテゴリ。 */
  safeCategories?: string[];
  store: ImprovementPrStore;
  /** 8 agent を流す pipeline runner。 */
  pipeline: ImprovementPrPipelineRunner;
  /** PR 発行ハンドラ。 */
  publisher: ImprovementPrGithubPublisher;
  /**
   * gitops 出力 (YAML 変更) を実 plan / dry-run 経路に通すバリデータ。
   * ops repo を持たない環境では available=false を返す実装でよい (PR は発行され、
   * PR body と audit metadata に skipped が残る)。
   */
  planValidator: ImprovementPrPlanValidator;
  /** audit_logs 書き込みハンドラ。 */
  audit: ImprovementPrAuditWriter;
  /** 紐付く cron_run id (audit_logs.metadata に含めるための識別子)。 */
  cronRunId?: string | null;
  /**
   * regression fix: image-Provider hop。注入されている場合のみ image_prompt
   * variants を `generateAndQaCreative` に流して実バイナリ + 決定論的 QA を実行し、
   * 通った asset を `persistCreativeAssets` で LocalDisk Storage に書き出す。
   * 未注入 / `enabled=false` / Provider 失敗時は prompt-only fallback に縮退し、
   * UI design plan principle 27 のとおり benign idle として扱う (PR 自体は成立する)。
   */
  imageProvider?: ImageProvider | null;
  /** Optional visual reference images for image-capable providers. */
  referenceImages?: ImageReferenceInput[];
  /**
   * regression fix: 生成 asset の永続化先 (LocalDisk Storage Adapter)。
   * `imageProvider` が注入されている場合のみ参照される。注入されていなければ
   * prompt-only fallback (= `creatives.storagePath` / `storageRef` / `provider` /
   * `model` / `parameters` は null のまま) になる。
   */
  creativeStorage?: CreativeStorageAdapter | null;
  /**
   * `generateAndQaCreative` に渡す Creative QA policy。
   *
   * regression fix: 未指定の場合は **空 policy ではなく `DEFAULT_CREATIVE_QA_POLICY`**
   * (dimensions / format / quality / forbiddenExpression / brandTone すべてに
   * 最低限の制約を持つ非空 policy) を適用する。これにより acceptance
   * "Creative QA checks dimensions, format, quality, forbidden expressions,
   * and brand-tone constraints before PR attachment" を、production の
   * runtime が policy を明示しない場合でも保証する。
   *
   * workspace_settings.creativeQaPolicy が後続タスクで読み込まれた場合は、
   * 呼び出し側で `DEFAULT_CREATIVE_QA_POLICY` 上に merge してここに渡す想定。
   */
  creativeQaPolicy?: CreativeQaPolicy;
  /**
   * 指定時、image_prompt の各案を後段で placement 別アスペクト比に展開する。
   * 未指定なら従来どおり ImagePromptVariant 1 件 = 生成 asset 1 件。
   */
  placementSet?: PlacementKey[];
  /** 生成クリエイティブの形式。未指定時は従来どおり single_image。 */
  creativeFormat?: "single_image" | "carousel";
  /** carousel のカード数 (2-10)。未指定時は copy agent の既定値。 */
  carouselCardCount?: number;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

/**
 * `runImprovementPrOnce` — improvement_pr cron handler の純粋なオーケストレータ。
 * pg-boss handler は本関数を 1 回呼び、戻り値を `cron_runs.output` に書く。
 *
 * 8 段パイプラインを実行し、GitHub PR と audit_logs を作る。proposals が
 * 存在する経路はすべて `publisher.createPullRequest` を経由してからのみ
 * `succeeded` を返す (= PR 境界を迂回する経路は存在しない)。
 */
export async function runImprovementPrOnce(
  opts: RunImprovementPrOptions,
): Promise<ImprovementPrSummary> {
  const account = await opts.store.findAdAccount({
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
  });
  if (!account) {
    return {
      status: "no_account",
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: null,
      mode: opts.mode,
      aiRunId: null,
      aiRunIds: [],
      creativeIds: [],
      decision: null,
      proposalCount: 0,
      currency: null,
      pullRequest: null,
      classification: null,
      auditDecision: null,
      dangerousCategories: [],
      errorMessage: `ad_account '${opts.accountKey}' not found in workspace`,
    };
  }

  return await runPipelineMode(opts, account);
}

// ---------------------------------------------------------------------
// Pipeline mode (this implementation)
// ---------------------------------------------------------------------

async function runPipelineMode(
  opts: RunImprovementPrOptions,
  account: DailyReportAdAccountSnapshot,
): Promise<ImprovementPrSummary> {
  const pipeline = opts.pipeline;
  const publisher = opts.publisher;
  const auditWriter = opts.audit;

  const accountIdForAi = account.metaAccountId ?? account.key;
  const baseRef = opts.baseRef ?? "main";
  const cronRunId = opts.cronRunId ?? null;
  const aiRunIds: string[] = [];
  const creativeIds: string[] = [];
  const creativeAttachments: ImprovementPrCreativeAttachment[] = [];
  const safeCategories = opts.safeCategories ?? [];
  const analysisWindow =
    opts.analysisWindow ??
    defaultImprovementPrAnalysisWindow(opts.now?.() ?? new Date());
  const creativeContext = opts.creativeContext ?? null;
  const workspaceFeedback = await loadProposalWorkspaceFeedback(opts);

  // ── 1) analyst ────────────────────────────────────────────────────────
  const analyst = await pipeline.runAnalyst({
    accountId: accountIdForAi,
    accountDisplayName: account.displayName,
    currency: account.currency,
    snapshotIds: opts.snapshotIds ?? [],
    currentDailyBudget: opts.currentDailyBudget ?? 0,
    analysisWindow,
  });
  const analystRow = await opts.store.createAiRun(analyst.aiRunInput);
  aiRunIds.push(analystRow.id);
  if (!analyst.output) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      stage: "analyst",
      error: analyst.error ?? "analyst agent failed",
      auditWriter,
      cronRunId,
    });
  }

  // ── 2) strategy ───────────────────────────────────────────────────────
  const strategy = await pipeline.runStrategy({
    accountId: accountIdForAi,
    accountDisplayName: account.displayName,
    currency: account.currency,
    analystCommentary: analyst.output.commentary,
    riskTolerance: opts.riskTolerance ?? "balanced",
    creativeContext,
    ...(workspaceFeedback ? { workspaceFeedback } : {}),
  });
  const strategyRow = await opts.store.createAiRun(strategy.aiRunInput);
  aiRunIds.push(strategyRow.id);
  if (!strategy.output) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      stage: "strategy",
      error: strategy.error ?? "strategy agent failed",
      auditWriter,
      cronRunId,
    });
  }

  const creativePerformanceDigest = await loadCreativePerformanceDigest({
    store: opts.store,
    accountId: account.id,
    now: opts.now?.() ?? new Date(),
  });

  // ── 3) copy ───────────────────────────────────────────────────────────
  const copy = await pipeline.runCopy({
    accountId: accountIdForAi,
    accountDisplayName: account.displayName,
    audienceFocus: strategy.output.audienceFocus,
    recommendedApproach: strategy.output.recommendedApproach,
    creativeContext,
    ...(creativePerformanceDigest
      ? { performanceDigest: creativePerformanceDigest }
      : {}),
    ...(opts.creativeFormat ? { creativeFormat: opts.creativeFormat } : {}),
    ...(opts.carouselCardCount
      ? { carouselCardCount: opts.carouselCardCount }
      : {}),
  });
  const copyRow = await opts.store.createAiRun(copy.aiRunInput);
  aiRunIds.push(copyRow.id);
  if (!copy.output) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      stage: "copy",
      error: copy.error ?? "copy agent failed",
      auditWriter,
      cronRunId,
    });
  }

  // ── 4) image_prompt ───────────────────────────────────────────────────
  const imagePrompt = await pipeline.runImagePrompt({
    accountId: accountIdForAi,
    accountDisplayName: account.displayName,
    currency: account.currency,
    audienceFocus: strategy.output.audienceFocus,
    primaryHeadline: copy.output.primary.headline,
    primaryText: copy.output.primary.primaryText,
    analystCommentary: analyst.output.commentary,
    strategy: strategy.output,
    analysisWindow,
    creativeContext,
    ...(creativePerformanceDigest
      ? { performanceDigest: creativePerformanceDigest }
      : {}),
    ...(opts.placementSet ? { placementSet: opts.placementSet } : {}),
    ...(copy.output.carousel ? { carousel: copy.output.carousel } : {}),
  });
  const imageRow = await opts.store.createAiRun(imagePrompt.aiRunInput);
  aiRunIds.push(imageRow.id);
  if (!imagePrompt.output) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      stage: "image_prompt",
      error: imagePrompt.error ?? "image_prompt agent failed",
      auditWriter,
      cronRunId,
    });
  }

  // ── 5) creative_qa ────────────────────────────────────────────────────
  const creativeQa = await pipeline.runCreativeQa({
    copy: copy.output,
    imagePrompts: imagePrompt.output,
  });
  const qaRow = await opts.store.createAiRun(creativeQa.aiRunInput);
  aiRunIds.push(qaRow.id);
  if (!creativeQa.output) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      stage: "creative_qa",
      error: creativeQa.error ?? "creative_qa agent failed",
      auditWriter,
      cronRunId,
    });
  }

  // ── 5b) creatives ─────────────────────────────────────────────────────
  // Acceptance: "Image Prompt Agent stores prompts and rationale in ai_runs
  // and creative metadata" + "creatives table links generated assets to
  // account, ai_run, ..." を満たすため、image_prompt が出した variant ごとに
  // `creatives` 行を 1 つ書く。creative_qa の recommendation/issues/rationale
  // も同じ行の `spec` に同梱して、creatives テーブルだけ参照すれば QA 結果と
  // image_prompt rationale が辿れるようにする (UI / audit / forensic 経路)。
  // QA が approve しなかった場合でも metadata は残し、PR 添付だけが skip される
  // (= rejected variants も creative library 上で audit 可能)。
  // implementation item: status を creative_qa.recommendation から派生して書き込む。
  // approve  → qa_passed (添付候補。後段で attached_to_pr に進む)
  // request_changes → qa_warned (非ブロッキング issues あり。添付候補)
  // reject   → qa_failed (PR 添付なし。audit 用に行は残す)
  const llmCreativeQaStatus: ImprovementPrCreativeStatus =
    creativeQa.output.recommendation === "approve"
      ? "qa_passed"
      : creativeQa.output.recommendation === "request_changes"
        ? "qa_warned"
        : "qa_failed";
  const carouselPlan =
    opts.creativeFormat === "carousel" && copy.output.carousel
      ? copy.output.carousel
      : null;
  const imagePromptVariantsForGeneration = carouselPlan
    ? prepareCarouselImagePromptVariants(
        imagePrompt.output.variants,
        carouselPlan,
      )
    : imagePrompt.output.variants;

  // regression fix: image-Provider hop。注入されている (= `enabled=true`) かつ
  // creative_qa が reject してない場合のみ実バイナリを生成し、決定論的 QA →
  // LocalDisk Storage Adapter への永続化まで一気に通す。Provider 未設定 /
  // 失敗時は prompt-only fallback に縮退し、creatives 行は storage 列を null
  // のまま書く (UI design plan principle 27)。reject 時は元々 PR 添付しないので
  // バイナリ生成しても破棄されるだけなので skip する (= unnecessary cost を避ける)。
  const imageGen = await runImageGenerationHop({
    imageProvider: opts.imageProvider ?? null,
    referenceImages: opts.referenceImages ?? [],
    creativeStorage: opts.creativeStorage ?? null,
    accountKey: account.key,
    variants: imagePromptVariantsForGeneration,
    dimensionPresets: IMPROVEMENT_PR_IMAGE_DIMENSION_PRESETS,
    placementSet: carouselPlan ? undefined : opts.placementSet,
    rationale: imagePrompt.output.rationale,
    // regression fix: production が policy を明示しないケースでも、空 policy
    // で全 check が `skipped` に倒れて素通りすることを禁止する。
    // `DEFAULT_CREATIVE_QA_POLICY` は dimensions/format/quality/forbiddenExpression
    // /brandTone すべてに最低限のガードを持つ。
    qaPolicy: opts.creativeQaPolicy ?? DEFAULT_CREATIVE_QA_POLICY,
    imagePromptAiRunId: imageRow.id,
    creativeQaAiRunId: qaRow.id,
    genes: creativeQa.output.genes ?? null,
    skipBinary: creativeQa.output.recommendation === "reject",
  });

  if (carouselPlan) {
    const carouselSpec = buildCarouselCreativeSpec(carouselPlan);
    const carouselValidation = validateCarouselCreativeSpec(carouselSpec, {
      assetVariantKeys: imageGen.perVariant
        .filter((v) => v.storagePath !== null)
        .map((v) => v.variantKey),
    });
    const firstVariant = imageGen.variants[0] ?? {
      prompt: carouselPlan.storyArc,
      negativePrompt: "",
      styleNotes: "",
      variantKey: "carousel",
      baseVariantKey: "carousel",
      sourceVariantIndex: 0,
    };
    const firstOutcome =
      imageGen.perVariant.find((v) => v.storagePath !== null) ??
      imageGen.perVariant[0] ??
      null;
    let creativeStatus: ImprovementPrCreativeStatus;
    if (!carouselValidation.ok) {
      creativeStatus = "qa_failed";
    } else if (imageGen.providerError !== null) {
      creativeStatus = "fallback_text_only";
    } else if (!imageGen.fallback) {
      const statuses = imageGen.perVariant.map((v) => v.status).filter(Boolean);
      creativeStatus = statuses.includes("qa_failed")
        ? "qa_failed"
        : statuses.includes("qa_warned")
          ? "qa_warned"
          : "qa_passed";
    } else {
      creativeStatus = llmCreativeQaStatus;
    }
    const promptVariant: ImprovementPrCreativePromptVariant = {
      prompt: firstVariant.prompt,
      negativePrompt: firstVariant.negativePrompt,
      styleNotes: firstVariant.styleNotes,
      variantKey: "carousel",
    };
    const qaIssues = !carouselValidation.ok
      ? [
          ...creativeQa.output.issues,
          ...carouselValidation.reasons.map((message) => ({
            severity: "error" as const,
            category: "carousel_spec",
            message,
          })),
        ]
      : creativeQa.output.issues;
    const creativeKey = `image_${imageRow.id}_carousel`;
    const created = await opts.store.createCreative({
      accountId: account.id,
      hierarchyId: creativeContext?.target?.hierarchyId ?? null,
      key: creativeKey,
      displayName: `Carousel creative (${carouselPlan.cards.length} cards)`,
      mediaType: "carousel",
      aiRunId: imageRow.id,
      variantIndex: 0,
      prompt: promptVariant,
      rationale: imagePrompt.output.rationale,
      adText: creativeAdTextForVariant(copy.output, 0),
      qa: {
        aiRunId: qaRow.id,
        recommendation: carouselValidation.ok
          ? creativeQa.output.recommendation
          : "reject",
        issues: qaIssues,
        rationale: carouselValidation.ok
          ? creativeQa.output.rationale
          : `Carousel spec failed deterministic checks: ${carouselValidation.reasons.join("; ")}`,
      },
      genes: creativeQa.output.genes ?? null,
      carouselSpec,
      status: creativeStatus,
      storageRef: firstOutcome?.storagePath ? imageGen.baseStorageRef : null,
      storagePath: firstOutcome?.storagePath ?? null,
      provider: imageGen.providerName,
      model: imageGen.model,
      parameters: imageGen.parameters,
    });
    creativeIds.push(created.id);
    creativeAttachments.push({
      creativeDbId: created.id,
      creativeKey,
      displayName: `Carousel creative (${carouselPlan.cards.length} cards)`,
      mediaType: "carousel",
      variantIndex: 0,
      prompt: promptVariant,
      rationale: imagePrompt.output.rationale,
      status: creativeStatus,
      qa: {
        aiRunId: qaRow.id,
        recommendation: carouselValidation.ok
          ? creativeQa.output.recommendation
          : "reject",
        issues: qaIssues,
        rationale: carouselValidation.ok
          ? creativeQa.output.rationale
          : `Carousel spec failed deterministic checks: ${carouselValidation.reasons.join("; ")}`,
      },
      genes: creativeQa.output.genes ?? null,
      carouselSpec,
      imagePromptAiRunId: imageRow.id,
      storageRef: imageGen.baseStorageRef,
      storagePath: firstOutcome?.storagePath ?? null,
      provider: imageGen.providerName,
      model: imageGen.model,
      parameters: imageGen.parameters,
      assets: imageGen.perVariant.map((asset) => ({
        variantKey: asset.variantKey,
        storageRef: asset.storageRef,
        storagePath: asset.storagePath,
      })),
    });
  } else {
    for (let i = 0; i < imageGen.variants.length; i++) {
      const variant = imageGen.variants[i]!;
      const creativeKey = `image_${imageRow.id}_v${i}`;
      const displayName = variant.placementLabel
        ? `Image variant ${variant.sourceVariantIndex + 1} / ${variant.placementLabel}`
        : `Image variant ${i + 1}`;
      const promptVariant: ImprovementPrCreativePromptVariant = {
        prompt: variant.prompt,
        negativePrompt: variant.negativePrompt,
        styleNotes: variant.styleNotes,
        variantKey: variant.variantKey,
        baseVariantKey: variant.baseVariantKey,
        ...(variant.placementKey ? { placementKey: variant.placementKey } : {}),
        ...(variant.placementLabel
          ? { placementLabel: variant.placementLabel }
          : {}),
      };
      // image-Provider hop が成功したケースでは、決定論的 QA の per-asset overall
      // を creative.status に反映させる (qa_passed / qa_warned / qa_failed)。
      // Provider が注入されたが失敗した場合 (`providerError !== null`) は明示的に
      // `fallback_text_only` に倒し、benign idle 状態をテーブル側でも一目で
      // 読み取れるようにする (UI design plan principle 27)。Provider が注入されて
      // いない (= optional 任意設定の現行運用) 場合は LLM creative_qa.recommendation
      // 由来の status を維持し、prompt-only な creative を audit metadata として
      // 残し続ける契約 (= 既存の implementation item acceptance を後退させない)。
      const variantOutcome = imageGen.perVariant[i] ?? null;
      let creativeStatus: ImprovementPrCreativeStatus;
      if (imageGen.providerError !== null) {
        creativeStatus = "fallback_text_only";
      } else if (!imageGen.fallback && variantOutcome?.status) {
        creativeStatus = variantOutcome.status;
      } else {
        creativeStatus = llmCreativeQaStatus;
      }
      // regression fix: `Creative.storageRef` には **base ref**
      // (`storage://creatives/<account_key>/<creative_id>`) を焼く。Web UI / proxy が
      // `readCreativeMetadataByRef(row.storageRef)` で `<base>/metadata.json` を引く
      // 契約に揃える。per-asset ref をそのまま入れると `<asset>.png/metadata.json`
      // という存在しない path に解決され、proxy が 410 を返す回路に落ちる。
      // per-asset の実体パスは引き続き `storagePath` (`creatives/.../<asset>.<ext>`)
      // が保持し、attachments / PR YAML 側は variantOutcome.storageRef (per-asset)
      // を使い続ける (こちらは reviewer / proxy の deep-link 用途で per-asset の方が
      // 直に使える)。
      const created = await opts.store.createCreative({
        accountId: account.id,
        // 生成対象ノードが解決できる場合は Creative.hierarchyId に保持する。
        // これにより UI と audit から「どの広告/広告セット改善か」を逆引きできる。
        hierarchyId: creativeContext?.target?.hierarchyId ?? null,
        key: creativeKey,
        displayName,
        mediaType: "image",
        aiRunId: imageRow.id,
        variantIndex: i,
        prompt: promptVariant,
        rationale: imagePrompt.output.rationale,
        adText: creativeAdTextForVariant(
          copy.output,
          variant.sourceVariantIndex,
        ),
        qa: {
          aiRunId: qaRow.id,
          recommendation: creativeQa.output.recommendation,
          issues: creativeQa.output.issues,
          rationale: creativeQa.output.rationale,
        },
        genes: creativeQa.output.genes ?? null,
        status: creativeStatus,
        storageRef: variantOutcome?.storagePath
          ? imageGen.baseStorageRef
          : null,
        storagePath: variantOutcome?.storagePath ?? null,
        provider: imageGen.providerName,
        model: imageGen.model,
        parameters: imageGen.parameters,
      });
      creativeIds.push(created.id);
      // implementation item: PR 添付に必要な per-creative metadata を 1 箇所に集める。
      // attachments は creative_qa が approve したケースでのみ後段の PR body /
      // YAML manifest に流れる (qa_warned / qa_failed は短絡パスで PR を作らない)。
      creativeAttachments.push({
        creativeDbId: created.id,
        creativeKey,
        displayName,
        mediaType: "image",
        variantIndex: i,
        prompt: promptVariant,
        rationale: imagePrompt.output.rationale,
        status: creativeStatus,
        qa: {
          aiRunId: qaRow.id,
          recommendation: creativeQa.output.recommendation,
          issues: creativeQa.output.issues,
          rationale: creativeQa.output.rationale,
        },
        genes: creativeQa.output.genes ?? null,
        imagePromptAiRunId: imageRow.id,
        storageRef: variantOutcome?.storageRef ?? null,
        storagePath: variantOutcome?.storagePath ?? null,
        provider: imageGen.providerName,
        model: imageGen.model,
        parameters: imageGen.parameters,
      });
    }
  }

  // regression fix: deterministic per-asset QA が `qa_failed` (= blocking) を
  // 返した variant は、LLM creative_qa が "approve" であっても **PR linkage /
  // PR diff / PR body / audit metadata から外す**。これにより:
  //   - linkCreativesToPullRequest が PR linkage を qa_passed/qa_warned に
  //     限定する Prisma store 側の per-row gate と矛盾しない (= store が throw
  //     しない契約 = "complete per-asset QA before any PR linkage").
  //   - PR diff の creative evidence と PR body の "## 生成クリエイティブ"
  //     セクションが、Meta に届く可能性のある creative だけを参照する
  //     (= "no PR metadata for blocked assets")。
  //   - qa_failed creatives 自体は creatives テーブルに残るので Web UI / audit /
  //     forensic からは依然として辿れる (UI design plan principle 25)。
  //   - LLM creative_qa が "reject" / "request_changes" を返した場合は下の短絡で
  //     PR 自体が立たないため、partition は "approve かつ deterministic blocking"
  //     のケースだけを実質的に切り出す。
  const attachableCreativeAttachments = creativeAttachments.filter(
    (a) => a.status !== "qa_failed",
  );
  const attachableCreativeIds = attachableCreativeAttachments.map(
    (a) => a.creativeDbId,
  );
  const blockedCreativeIds = creativeAttachments
    .filter((a) => a.status === "qa_failed")
    .map((a) => a.creativeDbId);
  // PR linkage は status='attached_to_pr' に進めるため fallback_text_only を
  // 含めない。
  //
  // regression fix: さらに、qa_passed / qa_warned であっても **生成 asset の
  // 完全な metadata (storageRef + storagePath + provider + model) を持たない
  // 行は linkage 対象から外す**。理由:
  //   - acceptance: "creatives table links generated assets to ... storage ref,
  //     and PR" — pullRequestId を持つ行は実 asset が背後に存在することが前提。
  //   - prompt-only fallback (Provider 未注入 / 失敗) で生成された qa_passed 行は
  //     audit metadata としては creatives テーブルに残るが、PR 添付経路は通さない
  //     (creative evidence にも storage ref を載せられないため意味を持たない)。
  //   - 同じ条件は runtime store (`linkCreativesToPullRequest`) の per-row gate
  //     でも DB 側で再検査される (二重防御 + production fail-loud)。
  const linkableCreativeIds = attachableCreativeAttachments
    .filter(
      (a) =>
        (a.status === "qa_passed" || a.status === "qa_warned") &&
        a.storageRef !== null &&
        a.storagePath !== null &&
        a.provider !== null &&
        a.model !== null,
    )
    .map((a) => a.creativeDbId);

  if (opts.workflowIntent === "auto_creative_generation") {
    const persistedImageCount = creativeAttachments.filter(
      (a) =>
        a.storageRef !== null &&
        a.storagePath !== null &&
        a.provider !== null &&
        a.model !== null,
    ).length;
    let autoCreativeErrorMessage: string | null = null;
    if (persistedImageCount === 0) {
      if (imageGen.providerError) {
        autoCreativeErrorMessage = `image generation failed: ${imageGen.providerError}`;
      } else if (!opts.imageProvider || opts.imageProvider.enabled === false) {
        autoCreativeErrorMessage =
          "image generation skipped: image provider is not configured";
      } else if (!opts.creativeStorage) {
        autoCreativeErrorMessage =
          "image generation skipped: creative storage is not configured";
      } else if (creativeQa.output.recommendation !== "approve") {
        autoCreativeErrorMessage = `creative_qa recommended ${creativeQa.output.recommendation}`;
      } else {
        autoCreativeErrorMessage =
          "image generation completed with no persisted assets";
      }
    }
    await auditWriter.recordImprovementPrAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId,
      action: "improvement_pr.skipped",
      pullRequest: null,
      aiRunIds,
      auditDecision: null,
      classification: null,
      dangerousCategories: [],
      metadata: {
        skippedAt: "auto_creative_generation_complete",
        recommendation: creativeQa.output.recommendation,
        issues: creativeQa.output.issues,
        creativeContext: creativeGenerationContextToMetadata(creativeContext),
        creativeIds,
        linkableCreativeIds,
        blockedCreativeIds,
        imageGeneration: {
          fallback: imageGen.fallback,
          persistedImageCount,
          baseStorageRef: imageGen.baseStorageRef,
          provider: imageGen.providerName ?? opts.imageProvider?.name ?? null,
          model: imageGen.model ?? opts.imageProvider?.defaultModel ?? null,
          providerError: imageGen.providerError,
        },
      },
      summary:
        autoCreativeErrorMessage === null
          ? "auto_creative_generation completed; PR not opened"
          : `auto_creative_generation skipped: ${autoCreativeErrorMessage}`,
    });
    return buildSummary({
      status: persistedImageCount > 0 ? "succeeded" : "skipped_no_proposal",
      opts,
      account,
      aiRunIds,
      creativeIds,
      mediaBuyerDecision: null,
      proposalCount: 0,
      pullRequest: null,
      audit: null,
      errorMessage: autoCreativeErrorMessage ?? undefined,
    });
  }

  if (creativeQa.output.recommendation !== "approve") {
    // QA が approve しない場合は提案 skip。failure ではなく skipped として扱う。
    await auditWriter.recordImprovementPrAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId,
      action: "improvement_pr.skipped",
      pullRequest: null,
      aiRunIds,
      auditDecision: null,
      classification: null,
      dangerousCategories: [],
      metadata: {
        skippedAt: "creative_qa",
        recommendation: creativeQa.output.recommendation,
        issues: creativeQa.output.issues,
        creativeContext: creativeGenerationContextToMetadata(creativeContext),
        creativeIds,
      },
      summary: `creative_qa recommended ${creativeQa.output.recommendation}; PR not opened`,
    });
    return buildSummary({
      status: "skipped_no_proposal",
      opts,
      account,
      aiRunIds,
      creativeIds,
      mediaBuyerDecision: null,
      proposalCount: 0,
      pullRequest: null,
      audit: null,
      errorMessage: `creative_qa recommended ${creativeQa.output.recommendation}`,
    });
  }

  // ── 6) media_buyer ────────────────────────────────────────────────────
  const mediaBuyer = await pipeline.runMediaBuyer({
    accountId: accountIdForAi,
    currency: account.currency,
    snapshotIds: opts.snapshotIds ?? [],
    currentDailyBudget: opts.currentDailyBudget ?? 0,
    riskTolerance: opts.riskTolerance ?? "balanced",
    analystSummary: analyst.output.commentary,
    creativeContext,
    ...(workspaceFeedback ? { workspaceFeedback } : {}),
  });
  const mediaBuyerRow = await opts.store.createAiRun(mediaBuyer.aiRunInput);
  aiRunIds.push(mediaBuyerRow.id);
  if (!mediaBuyer.output || !mediaBuyer.decision) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      creativeIds,
      stage: "media_buyer",
      error: mediaBuyer.error ?? "media_buyer agent failed",
      auditWriter,
      cronRunId,
    });
  }
  if (
    mediaBuyer.decision !== "propose" ||
    mediaBuyer.output.proposals.length === 0
  ) {
    await auditWriter.recordImprovementPrAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId,
      action: "improvement_pr.skipped",
      pullRequest: null,
      aiRunIds,
      auditDecision: null,
      classification: null,
      dangerousCategories: [],
      metadata: {
        skippedAt: "media_buyer",
        decision: mediaBuyer.decision,
        proposalCount: mediaBuyer.output.proposals.length,
        proposals: mediaBuyer.output.proposals,
        mediaBuyerRationale: mediaBuyer.output.rationale,
        budgetImpact: mediaBuyer.output.budgetImpact,
        creativeContext: creativeGenerationContextToMetadata(creativeContext),
        creativeIds,
      },
      summary: `media_buyer decision=${mediaBuyer.decision}; PR not opened`,
    });
    return buildSummary({
      status: "skipped_no_proposal",
      opts,
      account,
      aiRunIds,
      creativeIds,
      mediaBuyerDecision: mediaBuyer.decision,
      proposalCount: mediaBuyer.output.proposals.length,
      pullRequest: null,
      audit: null,
    });
  }

  // ── 7) gitops ─────────────────────────────────────────────────────────
  const gitops = await pipeline.runGitOps({
    accountId: accountIdForAi,
    proposals: mediaBuyer.output.proposals,
    repo: opts.repo ?? "",
    baseRef,
    branchHint: `improvement-${opts.accountKey}`,
  });
  const gitopsRow = await opts.store.createAiRun(gitops.aiRunInput);
  aiRunIds.push(gitopsRow.id);
  if (!gitops.output || !gitops.decision) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      creativeIds,
      stage: "gitops",
      error: gitops.error ?? "gitops agent failed",
      auditWriter,
      cronRunId,
    });
  }
  // implementation item: gitops 出力に「生成クリエイティブの reference manifest」ファイルを
  // 1 creative につき 1 ファイル追加する。manifest は
  // `evidence/creatives/<account_key>/<creative_id>.yaml` に書かれ、
  // apply operations からは独立した evidence file として扱う。これにより:
  //   - evidence の中に creative reference (storage ref / provider / model /
  //     prompt rationale / QA breakdown) が形として残り、merge 後も diff から
  //     生成系列を辿れる。
  //   - audit / plan validator / publisher が同じ files を見るので、
  //     human reviewer の手元 PR diff と pipeline 側の検証対象が一致する。
  // gitops.output.files を直接 mutate せず、enhancedFiles を以降のすべての段で
  // 使う (gitops.output.files は ai_runs に既に永続化されているため、後追いの
  // metadata ファイルは orchestrator 経由でのみ載せる)。
  // regression fix: PR diff には deterministic QA 通過分のみを載せる
  // (qa_failed は creatives テーブル上には残るが、creative evidence には載せない)。
  const creativeAttachmentFiles = buildCreativeAttachmentFiles({
    accountKey: opts.accountKey,
    attachments: attachableCreativeAttachments,
  });
  const enhancedFiles: ImprovementPrFileChange[] = [
    ...gitops.output.files,
    ...creativeAttachmentFiles,
  ];
  if (gitops.decision === "skip" || gitops.output.files.length === 0) {
    await auditWriter.recordImprovementPrAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId,
      action: "improvement_pr.skipped",
      pullRequest: null,
      aiRunIds,
      auditDecision: null,
      classification: null,
      dangerousCategories: [],
      metadata: {
        skippedAt: "gitops",
        decision: gitops.decision,
        fileCount: gitops.output.files.length,
        creativeIds,
      },
      summary: "gitops produced no YAML changes; PR not opened",
    });
    return buildSummary({
      status: "skipped_no_proposal",
      opts,
      account,
      aiRunIds,
      creativeIds,
      mediaBuyerDecision: mediaBuyer.decision,
      proposalCount: mediaBuyer.output.proposals.length,
      pullRequest: null,
      audit: null,
    });
  }

  // ── 8) audit ──────────────────────────────────────────────────────────
  const audit = await pipeline.runAudit({
    accountId: accountIdForAi,
    proposals: mediaBuyer.output.proposals,
    files: enhancedFiles,
    mode: opts.mode,
    safeCategories,
  });
  const auditRow = await opts.store.createAiRun(audit.aiRunInput);
  aiRunIds.push(auditRow.id);
  if (!audit.output || !audit.decision) {
    return await failPipeline({
      opts,
      account,
      aiRunIds,
      creativeIds,
      stage: "audit",
      error: audit.error ?? "audit agent failed",
      auditWriter,
      cronRunId,
    });
  }

  // ── 8b) plan validation (Regression fix) ───────────────────
  // gitops の YAML 変更を実 plan / dry-run 経路に通す。LLM-authored の
  // dryRunSummary ではなく、operation manifest validation による実 plan の
  // 結果を PR body と audit metadata に残すことで、人間レビュアが実際の
  // diff の妥当性を判断できるようにする。
  let planValidation: ImprovementPrPlanValidationResult;
  try {
    planValidation = await opts.planValidator.validate({
      accountKey: opts.accountKey,
      files: enhancedFiles,
    });
  } catch (err) {
    // バリデータ自身の例外 (FS/IO 等) は plan を skipped 扱いにし PR は発行する。
    // 改善提案そのものを腐らせないため、例外メッセージは PR/audit に sanitize 済みで残す。
    const message = err instanceof Error ? err.message : String(err);
    planValidation = {
      available: false,
      ok: false,
      risk: "error",
      counts: { creates: 0, updates: 0, deletes: 0, errors: 0, warnings: 0 },
      errors: [],
      warnings: [],
      summary: `plan validation skipped: validator error: ${message}`,
      durationMs: 0,
    };
  }

  // ── 8c) deterministic approval policy (this implementation) ───────────
  // AI の audit は LLM のため、契約境界 (report_only は Meta 不変更 / auto_apply
  // は safe operations のみ / dangerous は必ず PR 承認) を AI 単独で保証できない。
  // 純粋関数 `evaluateApprovalPolicy` で同じ入力を決定論的に再評価し、
  // fail-closed (= 厳しい方が勝つ) で AI の決定と合成する。
  const policyResult = evaluateApprovalPolicy({
    mode: opts.mode,
    candidates: mediaBuyer.output.proposals.map((p) => ({
      category: p.category,
    })),
    safeCategories,
  });
  const finalDecision = combineApprovalDecisions(
    audit.decision,
    policyResult.decision,
  );
  const finalClassification = combineApprovalClassifications(
    audit.output.classification,
    policyResult.classification,
  );
  const finalDangerousCategories = unionDangerousCategories(
    audit.output.dangerousCategories,
    policyResult.dangerousCategories,
  );

  // ── 8d) fail-closed for auto_blocked decisions (regression fix) ───────
  // 決定論的 policy または audit agent が `auto_blocked` を返した場合、PR を
  // 開かずにここで停止する。理由:
  //   - report_only / 危険カテゴリ等で「Meta を変えない」と決まった出力に対し
  //     mergeable な PR を提示すると、人間が誤って merge した瞬間に
  //     github_poll → execute_apply 経路が走り得る。
  //   - PR を開かなければ後段の merge 検出が発火しないため、auto_blocked 決定が
  //     merge を跨いで生き残る (= execute_apply 境界が承認決定を覆さない)。
  // audit_log は `improvement_pr.skipped` で残し、UI / forensic から決定理由
  // (AI 分類、policy reasons、mode、proposals 等) を完全に追跡できるようにする。
  if (finalDecision === "auto_blocked") {
    await auditWriter.recordImprovementPrAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId,
      action: "improvement_pr.skipped",
      pullRequest: null,
      aiRunIds,
      auditDecision: finalDecision,
      classification: finalClassification,
      dangerousCategories: finalDangerousCategories,
      metadata: {
        skippedAt: "policy_auto_blocked",
        proposalCount: mediaBuyer.output.proposals.length,
        proposals: mediaBuyer.output.proposals,
        mediaBuyerRationale: mediaBuyer.output.rationale,
        fileCount: gitops.output.files.length,
        budgetImpact: mediaBuyer.output.budgetImpact,
        creativeContext: creativeGenerationContextToMetadata(creativeContext),
        planValidation: planValidationToMetadata(planValidation),
        snapshotIds: opts.snapshotIds ?? [],
        mode: opts.mode,
        aiClassification: audit.output.classification,
        aiDecision: audit.decision,
        aiDangerousCategories: audit.output.dangerousCategories,
        policyDecision: policyResult.decision,
        policyClassification: policyResult.classification,
        policyReasons: policyResult.reasons,
        creativeIds,
      },
      summary: `improvement_pr auto_blocked (${finalClassification}); PR not opened`,
    });
    return buildSummary({
      status: "auto_blocked",
      opts,
      account,
      aiRunIds,
      creativeIds,
      mediaBuyerDecision: mediaBuyer.decision,
      proposalCount: mediaBuyer.output.proposals.length,
      pullRequest: null,
      audit: {
        classification: finalClassification,
        decision: finalDecision,
        dangerousCategories: finalDangerousCategories,
      },
    });
  }

  // ── 9) PR creation ────────────────────────────────────────────────────
  const prBody = composePrBody({
    aiRationale: gitops.output.prBody,
    mediaBuyerRationale: mediaBuyer.output.rationale,
    risk: {
      classification: finalClassification,
      dangerousCategories: finalDangerousCategories,
      rationale: audit.output.rationale,
    },
    auditDecision: finalDecision,
    policyReasons: policyResult.reasons,
    budgetImpact: mediaBuyer.output.budgetImpact,
    planValidation,
    snapshotIds: opts.snapshotIds ?? [],
    creativeContext,
    // regression fix: PR body の "## 生成クリエイティブ" も deterministic QA
    // 通過分のみを載せる (qa_failed は audit metadata の blockedCreativeIds で別軸記録)。
    creatives: attachableCreativeAttachments,
  });
  let pr: ImprovementPrPullRequestRecord;
  try {
    pr = await publisher.createPullRequest({
      branchName: gitops.output.branchName,
      prTitle: gitops.output.prTitle,
      prBody,
      files: enhancedFiles,
      baseRef,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditWriter.recordImprovementPrAudit({
      workspaceId: opts.workspaceId,
      accountKey: opts.accountKey,
      accountId: account.id,
      cronRunId,
      action: "improvement_pr.failed",
      pullRequest: null,
      aiRunIds,
      auditDecision: finalDecision,
      classification: finalClassification,
      dangerousCategories: finalDangerousCategories,
      metadata: {
        failedAt: "publish_pr",
        branchName: gitops.output.branchName,
        fileCount: gitops.output.files.length,
        // implementation item: PR diff には gitops files に加えて 1 creative につき
        // 1 manifest YAML を載せている。失敗時も人間が「何を載せようとしたか」
        // を audit から再構成できるよう、添付ファイル数と creative ids を残す。
        // regression fix: `attachedCreativeIds` は実際に PR diff に載せた
        // (= deterministic QA を通った) creatives のみ。`blockedCreativeIds` は
        // qa_failed のため添付しなかった creatives を別軸で記録する。
        attachedCreativeFileCount: creativeAttachmentFiles.length,
        attachedCreativeIds: attachableCreativeIds,
        blockedCreativeIds,
        proposalCount: mediaBuyer.output.proposals.length,
        proposals: mediaBuyer.output.proposals,
        mediaBuyerRationale: mediaBuyer.output.rationale,
        budgetImpact: mediaBuyer.output.budgetImpact,
        creativeContext: creativeGenerationContextToMetadata(creativeContext),
        aiClassification: audit.output.classification,
        aiDecision: audit.decision,
        aiDangerousCategories: audit.output.dangerousCategories,
        policyDecision: policyResult.decision,
        policyClassification: policyResult.classification,
        policyReasons: policyResult.reasons,
        planValidation: planValidationToMetadata(planValidation),
        mode: opts.mode,
        creativeIds,
      },
      summary: `improvement_pr publish failed: ${message}`,
    });
    return buildSummary({
      status: "pr_failed",
      opts,
      account,
      aiRunIds,
      creativeIds,
      mediaBuyerDecision: mediaBuyer.decision,
      proposalCount: mediaBuyer.output.proposals.length,
      pullRequest: null,
      audit: {
        classification: finalClassification,
        decision: finalDecision,
        dangerousCategories: finalDangerousCategories,
      },
      errorMessage: message,
    });
  }

  // ── 9b) link media_buyer ai_run / creatives to PR ────────────────────
  if (opts.store.linkAiRunToPullRequest) {
    await opts.store.linkAiRunToPullRequest({
      aiRunId: mediaBuyerRow.id,
      pullRequestId: pr.pullRequestId,
    });
  }

  // PR が立ったので、creative_qa を通った variant 行に pullRequestId を埋め
  // status を `attached_to_pr` に進める。creativeIds が空 (= image_prompt が
  // variant を出さなかった、または QA で rejected) の場合は何もしない契約。
  //
  // regression fix: PR linkage は deterministic per-asset QA を通った
  // (qa_passed | qa_warned) creatives のみに絞る。qa_failed と fallback_text_only
  // は除外する (前者は blocking failure、後者は storage ref を持たないため
  // attached_to_pr の意味的前提を満たさない)。production の Prisma store も
  // 同じ前提で per-row 検証 → 不整合が混じったら throw する契約 (二重防御)。
  if (linkableCreativeIds.length > 0) {
    await opts.store.linkCreativesToPullRequest({
      creativeIds: linkableCreativeIds,
      pullRequestId: pr.pullRequestId,
      pullRequestNumber: pr.prNumber,
      status: "attached_to_pr",
    });
  }

  // ── 10) audit_logs / approval_records ────────────────────────────────
  await auditWriter.recordImprovementPrAudit({
    workspaceId: opts.workspaceId,
    accountKey: opts.accountKey,
    accountId: account.id,
    cronRunId,
    action: "improvement_pr.opened",
    pullRequest: pr,
    aiRunIds,
    auditDecision: finalDecision,
    classification: finalClassification,
    dangerousCategories: finalDangerousCategories,
    metadata: {
      proposalCount: mediaBuyer.output.proposals.length,
      proposals: mediaBuyer.output.proposals,
      mediaBuyerRationale: mediaBuyer.output.rationale,
      fileCount: gitops.output.files.length,
      // implementation item: PR diff には gitops files に加えて 1 creative につき
      // 1 evidence YAML (`evidence/creatives/<key>/<creative_id>.yaml`) を
      // 載せている。merge 後に human が PR diff を辿り直す際の補助として、
      // 添付ファイル数を audit metadata にも記録する。
      attachedCreativeFileCount: creativeAttachmentFiles.length,
      budgetImpact: mediaBuyer.output.budgetImpact,
      creativeContext: creativeGenerationContextToMetadata(creativeContext),
      // regression fix: media_buyer の LLM-authored dryRunSummary は ai_runs に
      // 既に保存されている。audit metadata には実 plan/dry-run 経路を通した
      // 結果のみを残し、PR body と一致させる。
      planValidation: planValidationToMetadata(planValidation),
      snapshotIds: opts.snapshotIds ?? [],
      mode: opts.mode,
      aiClassification: audit.output.classification,
      aiDecision: audit.decision,
      aiDangerousCategories: audit.output.dangerousCategories,
      policyDecision: policyResult.decision,
      policyClassification: policyResult.classification,
      policyReasons: policyResult.reasons,
      // regression fix: creatives テーブル行を audit_logs から逆引きできるように
      // しておく (acceptance: creatives table links generated assets to
      // account, ai_run, ..., and PR; PR は pullRequest 経由で別軸で記録される)。
      // regression fix: PR メタデータ (= 「PR にどの creative が紐づいたか」)
      // は deterministic QA を通った行のみを記録する。`creativeIds` は当該 run
      // で生まれた全 creatives (qa_failed 含む) を残し forensic 経路を維持する。
      creativeIds,
      attachedCreativeIds: attachableCreativeIds,
      linkedCreativeIds: linkableCreativeIds,
      blockedCreativeIds,
    },
    summary: `improvement_pr opened: PR #${pr.prNumber} (${finalClassification}/${finalDecision})`,
  });

  return buildSummary({
    status: "succeeded",
    opts,
    account,
    aiRunIds,
    creativeIds,
    mediaBuyerDecision: mediaBuyer.decision,
    proposalCount: mediaBuyer.output.proposals.length,
    pullRequest: pr,
    audit: {
      classification: finalClassification,
      decision: finalDecision,
      dangerousCategories: finalDangerousCategories,
    },
  });
}

async function loadProposalWorkspaceFeedback(
  opts: RunImprovementPrOptions
): Promise<ProposalWorkspaceFeedback | undefined> {
  if (!opts.store.listProposalOutcomes) return undefined;
  try {
    const digest = await buildProposalFeedbackDigest({
      store: {
        listProposalOutcomes: (input) =>
          opts.store.listProposalOutcomes!(input),
      },
      workspaceId: opts.workspaceId,
      now: opts.now?.() ?? new Date(),
    });
    return proposalFeedbackDigestToAgentInput(digest);
  } catch {
    return undefined;
  }
}

function creativeAdTextForVariant(
  copy: ImprovementPrCopyOutput,
  variantIndex: number,
): NonNullable<ImprovementPrCreativeRecord["adText"]> {
  const source =
    variantIndex === 0
      ? copy.primary
      : (copy.alternates[variantIndex - 1] ?? copy.primary);
  return {
    primaryText: truncateMetaText(source.primaryText, 125),
    headline: truncateMetaText(source.headline, 40),
    description: truncateMetaText(source.description ?? "詳しくはこちら", 30),
    callToAction: normalizeCopyCta(source.cta),
    rationale: copy.rationale,
  };
}

function normalizeCopyCta(value: string): string {
  const raw = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    LEARN_MORE: "LEARN_MORE",
    LEARN: "LEARN_MORE",
    MORE: "LEARN_MORE",
    SIGN_UP: "SIGN_UP",
    SHOP_NOW: "SHOP_NOW",
    BUY_NOW: "BUY_NOW",
    CONTACT_US: "CONTACT_US",
    DOWNLOAD: "DOWNLOAD",
    APPLY_NOW: "APPLY_NOW",
    GET_QUOTE: "GET_QUOTE",
    SUBSCRIBE: "SUBSCRIBE",
  };
  return aliases[raw] ?? "LEARN_MORE";
}

function truncateMetaText(value: string, maxChars: number): string {
  const chars = Array.from(value.trim().replace(/\s+/g, " "));
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

interface FailPipelineArgs {
  opts: RunImprovementPrOptions;
  account: DailyReportAdAccountSnapshot;
  aiRunIds: string[];
  /**
   * creative_qa 段階以降に作成済みの creatives.id 一覧。creative_qa 失敗時は
   * 空配列、media_buyer 以降の失敗時は `creativeIds` が埋まる。
   */
  creativeIds?: string[];
  stage: string;
  error: string;
  auditWriter: ImprovementPrAuditWriter;
  cronRunId: string | null;
}

async function failPipeline(
  args: FailPipelineArgs,
): Promise<ImprovementPrSummary> {
  const creativeIds = args.creativeIds ?? [];
  await args.auditWriter.recordImprovementPrAudit({
    workspaceId: args.opts.workspaceId,
    accountKey: args.opts.accountKey,
    accountId: args.account.id,
    cronRunId: args.cronRunId,
    action: "improvement_pr.failed",
    pullRequest: null,
    aiRunIds: args.aiRunIds,
    auditDecision: null,
    classification: null,
    dangerousCategories: [],
    metadata: { failedAt: args.stage, creativeIds },
    summary: `improvement_pr ai_failed at ${args.stage}: ${args.error}`,
  });
  return buildSummary({
    status: "ai_failed",
    opts: args.opts,
    account: args.account,
    aiRunIds: args.aiRunIds,
    creativeIds,
    mediaBuyerDecision: null,
    proposalCount: 0,
    pullRequest: null,
    audit: null,
    errorMessage: args.error,
  });
}

interface BuildSummaryArgs {
  status: ImprovementPrRunStatus;
  opts: RunImprovementPrOptions;
  account: DailyReportAdAccountSnapshot;
  aiRunIds: string[];
  creativeIds?: string[];
  mediaBuyerDecision: ImprovementPrDecision | null;
  proposalCount: number;
  pullRequest: ImprovementPrPullRequestRecord | null;
  audit: {
    classification: ImprovementPrAuditClassification;
    decision: ImprovementPrAuditDecision;
    dangerousCategories: string[];
  } | null;
  errorMessage?: string;
}

function buildSummary(args: BuildSummaryArgs): ImprovementPrSummary {
  const lastAiRunId =
    args.aiRunIds.length > 0
      ? (args.aiRunIds[args.aiRunIds.length - 1] ?? null)
      : null;
  return {
    status: args.status,
    workspaceId: args.opts.workspaceId,
    accountKey: args.opts.accountKey,
    accountId: args.account.id,
    mode: args.opts.mode,
    aiRunId: lastAiRunId,
    aiRunIds: [...args.aiRunIds],
    creativeIds: [...(args.creativeIds ?? [])],
    decision: args.mediaBuyerDecision,
    proposalCount: args.proposalCount,
    currency: args.account.currency,
    pullRequest: args.pullRequest,
    classification: args.audit?.classification ?? null,
    auditDecision: args.audit?.decision ?? null,
    dangerousCategories: args.audit?.dangerousCategories ?? [],
    ...(args.errorMessage !== undefined
      ? { errorMessage: args.errorMessage }
      : {}),
  };
}

function defaultImprovementPrAnalysisWindow(
  now: Date,
): ImprovementPrAnalysisWindow {
  const period = now.toISOString().slice(0, 10);
  return {
    periodStart: period,
    periodEnd: period,
    current: {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
    },
  };
}

async function loadCreativePerformanceDigest(input: {
  store: ImprovementPrStore;
  accountId: string;
  now: Date;
}): Promise<CreativePerformanceDigest | null> {
  if (!input.store.listAdCreativePerformance) return null;
  const until = dateOnly(addUtcDays(input.now, -1));
  const since = dateOnly(addUtcDays(input.now, -28));
  try {
    const digest = await buildCreativePerformanceDigest({
      store: {
        listAdCreativePerformance: (query) =>
          input.store.listAdCreativePerformance!(query),
      },
      accountId: input.accountId,
      since,
      until,
    });
    return digest.entries.length > 0 ? digest : null;
  } catch {
    return null;
  }
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function composePrBody(input: {
  aiRationale: string;
  mediaBuyerRationale: string;
  risk: {
    classification: ImprovementPrAuditClassification;
    dangerousCategories: string[];
    rationale: string;
  };
  auditDecision: ImprovementPrAuditDecision;
  policyReasons: string[];
  budgetImpact: ImprovementPrBudgetImpact;
  planValidation: ImprovementPrPlanValidationResult;
  snapshotIds: string[];
  creativeContext: ImprovementPrCreativeGenerationContext | null;
  creatives: ImprovementPrCreativeAttachment[];
}): string {
  const dangerLine =
    input.risk.dangerousCategories.length > 0
      ? `- categories: ${input.risk.dangerousCategories.join(", ")}\n`
      : "";
  const snapshotLine =
    input.snapshotIds.length > 0
      ? input.snapshotIds.map((id) => `- ${id}`).join("\n")
      : "- (none)";
  const policyLines =
    input.policyReasons.length > 0
      ? input.policyReasons.map((r) => `- ${r}`).join("\n")
      : "- (no deterministic policy reasons)";
  const creativeContextLines = formatCreativeContextForPrBody(
    input.creativeContext,
  );
  return [
    "## AI rationale",
    input.aiRationale,
    "",
    `> media_buyer: ${input.mediaBuyerRationale}`,
    "",
    "## Risk",
    `- classification: \`${input.risk.classification}\``,
    `- decision: \`${input.auditDecision}\``,
    dangerLine,
    `- ${input.risk.rationale}`,
    "",
    "## Approval policy",
    policyLines,
    "",
    "## Budget impact",
    `- delta: \`${input.budgetImpact.deltaCurrency}\``,
    `- after: \`${input.budgetImpact.afterCurrency}\``,
    `- ${input.budgetImpact.notes}`,
    "",
    "## Dry-run",
    formatPlanValidationForPrBody(input.planValidation),
    "",
    "## Creative context",
    creativeContextLines,
    "",
    "## 生成クリエイティブ",
    formatCreativesForPrBody(input.creatives),
    "",
    "## Snapshots",
    snapshotLine,
  ].join("\n");
}

function formatCreativeContextForPrBody(
  context: ImprovementPrCreativeGenerationContext | null,
): string {
  if (!context) {
    return "- 文脈情報なし。アカウント単位の最小プロンプトで生成しました。";
  }
  const lines: string[] = [];
  lines.push(`- strategy: \`${context.strategy}\``);
  if (context.target) {
    lines.push(
      `- target: \`${context.target.hierarchy}\` ${oneLine(context.target.displayName)} (\`${context.target.nodeKey}\`)`,
    );
    lines.push(`- target rationale: ${oneLine(context.target.rationale)}`);
  } else {
    lines.push("- target: (no underperforming node selected)");
  }
  if (context.references.length > 0) {
    lines.push("- references:");
    for (const ref of context.references.slice(0, 3)) {
      lines.push(
        `  - \`${ref.hierarchy}\` ${oneLine(ref.displayName)} (\`${ref.nodeKey}\`): ${oneLine(ref.rationale)}`,
      );
    }
  } else {
    lines.push("- references: (none)");
  }
  if (context.brandProfile?.brandName) {
    lines.push(`- brand: ${oneLine(context.brandProfile.brandName)}`);
  }
  return lines.join("\n");
}

/**
 * implementation item: PR body の `## 生成クリエイティブ` セクションを組み立てる。
 *
 * 1 creative につき以下を出す:
 *   - creative id / variant index / status (creative_status vocabulary)
 *   - 生成理由 (image_prompt rationale)
 *   - プロンプト要約 (prompt / negativePrompt / styleNotes; 各 1 行)
 *   - QA 結果 per-check (recommendation + 各 issue の severity/category/message)
 *   - preview (`storage://...` ref。バイナリ未生成なら "(プロンプトのみ)")
 *   - リスク (per-creative の attach 区分。approve→safe, request_changes→non-blocking)
 *
 * creatives が空 (= image_prompt が variants を出さなかった/全て qa_failed で
 * 添付対象なし) の場合は benign idle の説明を残し、PR body を空にしない。
 * Image-Provider が任意である旨もここで明示し、UI design plan の
 * 「画像 Provider 未設定/失敗は workflow 失敗ではない」原則 (principle 27) を
 * PR レビュー視点でも担保する。
 */
function formatCreativesForPrBody(
  creatives: ImprovementPrCreativeAttachment[],
): string {
  if (creatives.length === 0) {
    return [
      "- 添付された生成クリエイティブはありません。",
      "- 画像 Provider は任意です (未設定/失敗時はテキストプロンプトのみで PR を作成します)。",
    ].join("\n");
  }
  const lines: string[] = [];
  for (const c of creatives) {
    const preview =
      c.storageRef && c.storageRef.length > 0
        ? `\`${c.storageRef}\``
        : "(プロンプトのみ — 画像バイナリは未生成)";
    const provider =
      c.provider && c.model
        ? `\`${c.provider}/${c.model}\``
        : "(provider 未割当 / プロンプトのみ)";
    const risk = creativeAttachmentRisk(c.qa.recommendation);
    lines.push(`- creative: \`${c.creativeDbId}\``);
    lines.push(`  - key: \`${c.creativeKey}\``);
    lines.push(`  - media type: \`${c.mediaType ?? "image"}\``);
    lines.push(`  - variant: ${c.variantIndex}`);
    lines.push(`  - status: \`${c.status}\``);
    lines.push(`  - provider/model: ${provider}`);
    lines.push(`  - preview: ${preview}`);
    lines.push(`  - 生成理由 (rationale): ${oneLine(c.rationale)}`);
    lines.push(`  - prompt: ${oneLine(c.prompt.prompt)}`);
    if (c.prompt.negativePrompt && c.prompt.negativePrompt.length > 0) {
      lines.push(`  - negative prompt: ${oneLine(c.prompt.negativePrompt)}`);
    }
    if (c.prompt.styleNotes && c.prompt.styleNotes.length > 0) {
      lines.push(`  - style notes: ${oneLine(c.prompt.styleNotes)}`);
    }
    if (c.carouselSpec) {
      lines.push(`  - carousel story: ${oneLine(c.carouselSpec.storyArc)}`);
      lines.push(`  - cards:`);
      for (const card of c.carouselSpec.cards) {
        const asset = c.assets?.find(
          (a) => a.variantKey === card.assetVariantKey,
        );
        const assetRef = asset?.storageRef
          ? ` \`${asset.storageRef}\``
          : " (asset 未保存)";
        lines.push(
          `    - ${card.position}. \`${card.role}\` ${oneLine(card.headline)} → \`${card.assetVariantKey}\`${assetRef}`,
        );
      }
    }
    lines.push(
      `  - QA 結果: \`${c.qa.recommendation}\` — ${oneLine(c.qa.rationale)}`,
    );
    if (c.qa.issues.length === 0) {
      lines.push(`    - checks: (no issues reported)`);
    } else {
      for (const issue of c.qa.issues) {
        lines.push(
          `    - [${issue.severity}] \`${issue.category}\`: ${oneLine(issue.message)}`,
        );
      }
    }
    lines.push(`  - リスク: ${risk}`);
    lines.push(`  - image_prompt ai_run: \`${c.imagePromptAiRunId}\``);
    lines.push(`  - creative_qa ai_run: \`${c.qa.aiRunId}\``);
  }
  return lines.join("\n");
}

function creativeAttachmentRisk(
  recommendation: ImprovementPrCreativeQaRecommendation,
): string {
  switch (recommendation) {
    case "approve":
      return "safe (ブロッキング issues なし)";
    case "request_changes":
      return "non-blocking (warn issues あり、添付は許可)";
    case "reject":
      // PR 添付段階で reject が混ざるのは契約違反 (orchestrator が短絡している)
      // が、文字列としては安全に表現しておく。
      return "blocking (本来 PR 添付されない)";
  }
}

function oneLine(s: string): string {
  // PR body の bullet 行は markdown レベルで 1 行に折り畳むため、改行を空白へ
  // 正規化する。長文の場合でも先頭から 280 文字までに切り詰めて重さを抑える。
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= 280) return flat;
  return flat.slice(0, 277) + "...";
}

/**
 * implementation item: 添付対象の creatives を evidence 配下に配置する YAML ファイル
 * (`evidence/creatives/<account_key>/<creative_id>.yaml`) を組み立てる。
 *
 * - apply operations とは別の evidence file で、Meta 反映対象にはしない。
 * - 機密値 (API key 等) は image_prompt / creative_qa 出力には含まれない契約だが、
 *   prompt 本文に万一含まれても sanitize しない (PR 本文と同じく ai_runs の
 *   rendering boundary を継承)。`storage://` 以外の絶対 fs path は載せない。
 * - 戻り値の path はすべて POSIX 風で、accountKey / creativeDbId は呼び出し側が
 *   既に validate 済み (account.key / `creates` から返る uuid)。念のため traversal
 *   になる文字 (`/`, `..`) を含むものは黙って除外する。
 */
function buildCreativeAttachmentFiles(input: {
  accountKey: string;
  attachments: ImprovementPrCreativeAttachment[];
}): ImprovementPrFileChange[] {
  if (input.attachments.length === 0) return [];
  if (!isPathSafeSegment(input.accountKey)) return [];
  const files: ImprovementPrFileChange[] = [];
  for (const a of input.attachments) {
    if (!isPathSafeSegment(a.creativeDbId)) continue;
    const yaml = renderCreativeManifestYaml(input.accountKey, a);
    const diff = yaml
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    files.push({
      path: `evidence/creatives/${input.accountKey}/${a.creativeDbId}.yaml`,
      action: "create",
      diff,
    });
  }
  return files;
}

function isPathSafeSegment(s: string): boolean {
  if (s.length === 0) return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (s === "." || s === "..") return false;
  if (s.includes("..")) return false;
  return true;
}

/**
 * Creative attachment の YAML manifest を組み立てる。
 *
 * - 文字列はすべて double-quoted YAML で書き出し、`\` `"` `\n` をエスケープ。
 * - null / 未設定の Provider 由来フィールドは `null` リテラルで明示し、
 *   downstream reader が「prompt-only fallback」を判別できるようにする。
 */
function renderCreativeManifestYaml(
  accountKey: string,
  a: ImprovementPrCreativeAttachment,
): string {
  const lines: string[] = [];
  lines.push("version: 1");
  lines.push("creative:");
  lines.push(`  id: ${quoteYaml(a.creativeDbId)}`);
  lines.push(`  key: ${quoteYaml(a.creativeKey)}`);
  lines.push(`  accountKey: ${quoteYaml(accountKey)}`);
  lines.push(`  displayName: ${quoteYaml(a.displayName)}`);
  lines.push(`  mediaType: ${quoteYaml(a.mediaType ?? "image")}`);
  lines.push(`  variantIndex: ${a.variantIndex}`);
  lines.push(`  status: ${quoteYaml(a.status)}`);
  lines.push("prompt:");
  lines.push(`  text: ${quoteYaml(a.prompt.prompt)}`);
  lines.push(`  negativePrompt: ${quoteYaml(a.prompt.negativePrompt ?? "")}`);
  lines.push(`  styleNotes: ${quoteYaml(a.prompt.styleNotes ?? "")}`);
  lines.push(`  rationale: ${quoteYaml(a.rationale)}`);
  lines.push("generation:");
  lines.push(`  provider: ${a.provider ? quoteYaml(a.provider) : "null"}`);
  lines.push(`  model: ${a.model ? quoteYaml(a.model) : "null"}`);
  lines.push(
    `  storageRef: ${a.storageRef ? quoteYaml(a.storageRef) : "null"}`,
  );
  // regression fix: image-Provider hop が orchestrator に注入する `parameters`
  // (variationConditions / purpose / variantCount 等) を manifest にも残し、
  // PR レビュー時に variant 数や寸法・format を YAML から確認できるようにする。
  // prompt-only fallback (Provider 未注入 / 失敗 / `skipBinary`) では null。
  if (
    a.parameters &&
    typeof a.parameters === "object" &&
    !Array.isArray(a.parameters) &&
    Object.keys(a.parameters).length > 0
  ) {
    lines.push("  parameters:");
    appendYamlBlock(lines, a.parameters, "    ");
  } else {
    lines.push("  parameters: null");
  }
  if (a.assets && a.assets.length > 0) {
    lines.push("  assets:");
    for (const asset of a.assets) {
      lines.push(`    - variantKey: ${quoteYaml(asset.variantKey)}`);
      lines.push(
        `      storageRef: ${asset.storageRef ? quoteYaml(asset.storageRef) : "null"}`,
      );
      lines.push(
        `      storagePath: ${asset.storagePath ? quoteYaml(asset.storagePath) : "null"}`,
      );
    }
  }
  if (a.carouselSpec) {
    lines.push("carousel:");
    lines.push(`  schemaVersion: ${a.carouselSpec.schemaVersion}`);
    lines.push(`  storyArc: ${quoteYaml(a.carouselSpec.storyArc)}`);
    lines.push("  cards:");
    for (const card of a.carouselSpec.cards) {
      lines.push(`    - position: ${card.position}`);
      lines.push(`      role: ${quoteYaml(card.role)}`);
      lines.push(`      headline: ${quoteYaml(card.headline)}`);
      lines.push(
        `      description: ${card.description ? quoteYaml(card.description) : "null"}`,
      );
      lines.push(
        `      linkUrl: ${card.linkUrl ? quoteYaml(card.linkUrl) : "null"}`,
      );
      lines.push(`      assetVariantKey: ${quoteYaml(card.assetVariantKey)}`);
    }
  }
  lines.push("qa:");
  lines.push(`  recommendation: ${quoteYaml(a.qa.recommendation)}`);
  lines.push(`  rationale: ${quoteYaml(a.qa.rationale)}`);
  lines.push("  issues:");
  if (a.qa.issues.length === 0) {
    lines.push("    []");
  } else {
    for (const issue of a.qa.issues) {
      lines.push(`    - severity: ${quoteYaml(issue.severity)}`);
      lines.push(`      category: ${quoteYaml(issue.category)}`);
      lines.push(`      message: ${quoteYaml(issue.message)}`);
    }
  }
  lines.push("ai:");
  lines.push(`  imagePromptAiRunId: ${quoteYaml(a.imagePromptAiRunId)}`);
  lines.push(`  creativeQaAiRunId: ${quoteYaml(a.qa.aiRunId)}`);
  return lines.join("\n") + "\n";
}

function quoteYaml(s: string): string {
  // double-quoted YAML scalar: `\` `"` をエスケープし、改行は `\n` に圧縮する。
  // タブはそのまま許容 (`"\t"` は valid scalar)。
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
  return `"${escaped}"`;
}

/**
 * 任意の `Record<string, unknown>` (image-Provider hop が注入する `parameters`)
 * を YAML ブロック形式に書き出すヘルパ。
 *
 * - 文字列は `quoteYaml` で double-quoted、数値・真偽値はリテラル、
 *   `null` / `undefined` / 非有限数 / その他の型は `null` リテラル。
 * - 入れ子オブジェクトは `key:` の次行から `+2 indent` で展開。空 `{}` は inline。
 * - 配列は `key:` の次行から `- ` リーダで展開。空 `[]` は inline。
 *   配列要素のオブジェクトは 1 番目のキーを `- ` 同行 + 2 番目以降を揃え
 *   (manifest の `qa.issues` ブロックと同じ規約)。
 *
 * `parameters` の shape は image_prompt agent + image-Provider 実装が共同で決め、
 * orchestrator は透過的に伝搬させる契約 (= ここでは shape 検証しない)。
 */
function appendYamlBlock(
  lines: string[],
  obj: Record<string, unknown>,
  indent: string,
): void {
  for (const [k, v] of Object.entries(obj)) {
    appendYamlKeyValue(lines, k, v, indent);
  }
}

function appendYamlKeyValue(
  lines: string[],
  key: string,
  value: unknown,
  indent: string,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${indent}${key}: []`);
      return;
    }
    lines.push(`${indent}${key}:`);
    appendYamlArrayItems(lines, value, indent);
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      lines.push(`${indent}${key}: {}`);
      return;
    }
    lines.push(`${indent}${key}:`);
    appendYamlBlock(lines, value as Record<string, unknown>, indent + "  ");
    return;
  }
  lines.push(`${indent}${key}: ${formatYamlScalar(value)}`);
}

function appendYamlArrayItems(
  lines: string[],
  arr: unknown[],
  indent: string,
): void {
  // parent key の次行に `- ` 行を並べる (parent と同じ列の `+2` indent)。
  // 既存 manifest の `  issues:` → `    -` の 2-space ステップに揃える。
  const itemIndent = indent + "  ";
  for (const item of arr) {
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${itemIndent}- []`);
        continue;
      }
      lines.push(`${itemIndent}-`);
      appendYamlArrayItems(lines, item, itemIndent + "  ");
      continue;
    }
    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${itemIndent}- {}`);
        continue;
      }
      // 1 番目のキーを `- ` の同行に置き、続行は揃えで書く。
      const [firstKey, firstValue] = entries[0]!;
      const continuationIndent = itemIndent + "  ";
      if (Array.isArray(firstValue)) {
        if (firstValue.length === 0) {
          lines.push(`${itemIndent}- ${firstKey}: []`);
        } else {
          lines.push(`${itemIndent}- ${firstKey}:`);
          appendYamlArrayItems(lines, firstValue, continuationIndent);
        }
      } else if (firstValue !== null && typeof firstValue === "object") {
        const sub = Object.entries(firstValue as Record<string, unknown>);
        if (sub.length === 0) {
          lines.push(`${itemIndent}- ${firstKey}: {}`);
        } else {
          lines.push(`${itemIndent}- ${firstKey}:`);
          appendYamlBlock(
            lines,
            firstValue as Record<string, unknown>,
            continuationIndent + "  ",
          );
        }
      } else {
        lines.push(
          `${itemIndent}- ${firstKey}: ${formatYamlScalar(firstValue)}`,
        );
      }
      for (let i = 1; i < entries.length; i++) {
        const [k, v] = entries[i]!;
        appendYamlKeyValue(lines, k, v, continuationIndent);
      }
      continue;
    }
    lines.push(`${itemIndent}- ${formatYamlScalar(item)}`);
  }
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quoteYaml(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return "null";
}

function formatPlanValidationForPrBody(
  p: ImprovementPrPlanValidationResult,
): string {
  if (!p.available) {
    return [`- status: \`skipped\``, `- ${p.summary}`].join("\n");
  }
  const lines: string[] = [];
  lines.push(`- status: \`${p.ok ? "ok" : "error"}\``);
  lines.push(`- risk: \`${p.risk}\``);
  lines.push(
    `- counts: +${p.counts.creates} ~${p.counts.updates} -${p.counts.deletes}` +
      ` (errors=${p.counts.errors} warnings=${p.counts.warnings})`,
  );
  lines.push(`- durationMs: \`${p.durationMs}\``);
  if (p.errors.length > 0) {
    lines.push("- errors:");
    for (const e of p.errors) {
      const ptr = e.pointer ? ` ${e.pointer}` : "";
      lines.push(`  - \`${e.file}\`${ptr}: ${e.message}`);
    }
  }
  if (p.warnings.length > 0) {
    lines.push("- warnings:");
    for (const w of p.warnings) {
      const ptr = w.pointer ? ` ${w.pointer}` : "";
      lines.push(`  - \`${w.file}\`${ptr}: ${w.message}`);
    }
  }
  if (p.summary) {
    lines.push(`- ${p.summary}`);
  }
  return lines.join("\n");
}

function planValidationToMetadata(
  p: ImprovementPrPlanValidationResult,
): Record<string, unknown> {
  return {
    available: p.available,
    ok: p.ok,
    risk: p.risk,
    counts: p.counts,
    errors: p.errors,
    warnings: p.warnings,
    summary: p.summary,
    durationMs: p.durationMs,
  };
}

function creativeGenerationContextToMetadata(
  context: ImprovementPrCreativeGenerationContext | null,
): Record<string, unknown> | null {
  if (!context) return null;
  return {
    strategy: context.strategy,
    target: context.target
      ? creativeNodeContextToMetadata(context.target)
      : null,
    references: context.references.map(creativeNodeContextToMetadata),
    brandProfile: context.brandProfile ?? null,
    notes: context.notes ?? [],
  };
}

function creativeNodeContextToMetadata(
  node: ImprovementPrCreativeNodeContext,
): Record<string, unknown> {
  return {
    hierarchyId: node.hierarchyId,
    hierarchy: node.hierarchy,
    nodeKey: node.nodeKey,
    displayName: node.displayName,
    status: node.status ?? null,
    externalId: node.externalId ?? null,
    current: node.current,
    prior: node.prior ?? null,
    rationale: node.rationale,
    creative: node.creative ?? null,
  };
}

// ---------------------------------------------------------------------
// regression fix — image-Provider hop helper
// ---------------------------------------------------------------------

interface RunImageGenerationHopInput {
  imageProvider: ImageProvider | null;
  referenceImages: ImageReferenceInput[];
  creativeStorage: CreativeStorageAdapter | null;
  accountKey: string;
  variants: ImprovementPrImagePromptVariant[];
  dimensionPresets?: ImprovementPrImageDimensionPreset[];
  placementSet?: PlacementKey[];
  rationale: string;
  qaPolicy: CreativeQaPolicy;
  imagePromptAiRunId: string;
  creativeQaAiRunId: string;
  genes: CreativeGenes | null;
  /** creative_qa が reject した時に Provider 呼び出し自体を skip する。 */
  skipBinary: boolean;
}

interface PerVariantOutcome {
  variantKey: string;
  status: ImprovementPrCreativeStatus | null;
  storageRef: string | null;
  storagePath: string | null;
}

interface PreparedImagePromptVariant extends ImprovementPrImagePromptVariant {
  variantKey: string;
  sourceVariantIndex: number;
  baseVariantKey: string;
  placementKey?: PlacementKey;
  placementLabel?: string;
}

interface RunImageGenerationHopResult {
  /** Provider が成功して bytes を書いた場合 false。Provider 未注入 / 失敗時は true。 */
  fallback: boolean;
  /** Provider が呼ばれた場合の name (`openai` / `mock` 等)。未注入 / 失敗時は null。 */
  providerName: string | null;
  /** Provider が呼ばれた場合の model id。同上 null。 */
  model: string | null;
  /** 生成パラメータ snapshot (variation_conditions / variant_count / purpose)。同上 null。 */
  parameters: Record<string, unknown> | null;
  /**
   * 1 回の generation でまとめて永続化された assets の親ディレクトリの安定 ref
   * (`storage://creatives/<account_key>/<creative_id>`)。`metadata.json` がここに
   * 直下で書かれる。Web UI / proxy は `Creative.storageRef` 経由でこれを引いて
   * `metadata.json` を読み出す (per-asset ref を渡すと `<asset>.png/metadata.json`
   * になり 410 を引き起こすため、orchestrator は base ref をここに焼く)。
   * Provider 未注入 / 失敗 / fallback 時は null。
   */
  baseStorageRef: string | null;
  /** image_prompt の variant 順に並ぶ per-variant 永続化結果。 */
  perVariant: PerVariantOutcome[];
  /** 実際に creative 行・PR 添付へ展開する variant 列。 */
  variants: PreparedImagePromptVariant[];
  /** Provider 失敗時の sanitized メッセージ (audit 用)。成功 / 未注入時は null。 */
  providerError: string | null;
  /** placement 展開の監査用メタデータ。未指定時は null。 */
  placementExpansion: Record<string, unknown> | null;
}

/**
 * regression fix: image-Provider hop。`generateAndQaCreative` で実バイナリ生成 +
 * 決定論的 Creative QA を実行し、合格 asset を `persistCreativeAssets` 経由で
 * LocalDisk Storage Adapter に書き出す。Provider 未注入 / 失敗 / `skipBinary`
 * の場合は prompt-only fallback (`fallback=true`) を返し、orchestrator は
 * creatives 行を storage 列 null で書き続ける (UI design plan principle 27)。
 *
 * - storage adapter が無い + Provider あり、という不整合な構成では Provider 自体を
 *   スキップして fallback 扱いにする (= 永続化境界が抜けたまま PR を出さない)。
 * - persistCreativeAssets が throw した場合も fallback に倒す (= 部分書き込み
 *   による storage 不整合より、prompt-only PR を優先する)。
 */
async function runImageGenerationHop(
  input: RunImageGenerationHopInput,
): Promise<RunImageGenerationHopResult> {
  let prepared = prepareImagePromptVariantsForGeneration({
    variants: input.variants,
    placementSet: input.placementSet,
  });
  let variationConditions: ImageVariationCondition[];
  let placementExpansion = buildPlacementExpansionMetadata(
    prepared,
    input.placementSet,
  );
  const baseEmpty = () =>
    prepared.variants.map((variant) => ({
      variantKey: variant.variantKey,
      status: null,
      storageRef: null,
      storagePath: null,
    }));
  if (
    !input.imageProvider ||
    input.imageProvider.enabled === false ||
    !input.creativeStorage ||
    input.skipBinary ||
    prepared.variants.length === 0
  ) {
    return {
      fallback: true,
      providerName: null,
      model: null,
      parameters: null,
      baseStorageRef: null,
      perVariant: baseEmpty(),
      variants: prepared.variants,
      providerError: null,
      placementExpansion,
    };
  }

  try {
    if (input.placementSet && input.placementSet.length > 0) {
      variationConditions = prepared.variants.map((variant) => ({
        width: variant.width ?? 1080,
        height: variant.height ?? 1080,
        format: variant.format ?? "png",
        ...(variant.styleNotes ? { styleNotes: variant.styleNotes } : {}),
        ...(variant.negativePrompt
          ? { negativePrompt: variant.negativePrompt }
          : {}),
        variantKey: variant.variantKey,
      }));
    } else {
      variationConditions = imagePromptVariantsToVariationConditions(
        prepared.variants,
        {
          aspectRatio: "1:1",
          dimensionPresets: input.dimensionPresets,
          defaultFormat: "png",
        },
      );
      prepared = {
        ...prepared,
        variants: prepared.variants.map((variant, i) => ({
          ...variant,
          variantKey: variationConditions[i]?.variantKey ?? variant.variantKey,
          width: variationConditions[i]?.width ?? variant.width,
          height: variationConditions[i]?.height ?? variant.height,
          format: variationConditions[i]?.format ?? variant.format,
        })),
      };
      placementExpansion = buildPlacementExpansionMetadata(
        prepared,
        input.placementSet,
      );
    }
  } catch {
    return {
      fallback: true,
      providerName: null,
      model: null,
      parameters: null,
      baseStorageRef: null,
      perVariant: baseEmpty(),
      variants: prepared.variants,
      providerError: "image prompt variation conditions were invalid",
      placementExpansion,
    };
  }
  const promptVariants: ImagePromptVariant[] = prepared.variants.map((v, i) => {
    const condition = variationConditions[i]!;
    return {
      variantKey: condition.variantKey,
      prompt: v.prompt,
      negativePrompt: v.negativePrompt,
      styleNotes: v.styleNotes,
      width: condition.width,
      height: condition.height,
      format: condition.format,
      aspectRatio: v.aspectRatio,
    };
  });

  const result = await generateAndQaCreative({
    provider: input.imageProvider,
    request: {
      prompt: input.variants[0]?.prompt ?? "",
      variationConditions,
      purpose: "workflow:improvement_pr",
      referenceImages: input.referenceImages,
    },
    variants: promptVariants,
    policy: input.qaPolicy,
    qaRef: input.creativeQaAiRunId,
  });

  if (!result.generation || result.outcome === "fallback_text_only") {
    return {
      fallback: true,
      providerName: null,
      model: null,
      parameters: null,
      baseStorageRef: null,
      perVariant: baseEmpty(),
      variants: prepared.variants,
      providerError: result.providerError,
      placementExpansion,
    };
  }

  // Storage 永続化。creative_id は creatives 行が既に確定していないと書けないため、
  // ここでは creative_id を「improvement_pr run + variant index」で安定に採番し、
  // creatives 行の DB primary key と独立させる。creatives.storagePath は
  // adapter key (`creatives/<account_key>/<creative_id>/<asset_id>.<ext>`) を
  // そのまま保持し、`storage://` ref と 1:1 対応する (UI design plan principle 24)。
  const creativeIdForStorage = `imgrun_${input.imagePromptAiRunId}`;
  let persisted: PersistCreativeAssetsResult;
  try {
    persisted = await persistCreativeAssets({
      storage: input.creativeStorage,
      accountKey: input.accountKey,
      creativeId: creativeIdForStorage,
      generation: result.generation,
      qa: result.qa,
      links: {
        imagePromptAiRunId: input.imagePromptAiRunId,
        creativeQaAiRunId: input.creativeQaAiRunId,
      },
      genes: input.genes,
    });
  } catch {
    // Storage 失敗は workflow を腐らせず prompt-only fallback に倒す。
    return {
      fallback: true,
      providerName: null,
      model: null,
      parameters: null,
      baseStorageRef: null,
      perVariant: baseEmpty(),
      variants: prepared.variants,
      providerError: "creative storage write failed",
      placementExpansion,
    };
  }

  // image_prompt variant index → 永続化された asset を引くための map。
  const assetByKey = new Map<string, PersistedCreativeAsset>();
  for (const a of persisted.assets) assetByKey.set(a.variantKey, a);

  const perVariant: PerVariantOutcome[] = prepared.variants.map((_, i) => {
    const variantKey = variationConditions[i]?.variantKey ?? `variant-${i}`;
    const asset = assetByKey.get(variantKey) ?? null;
    let status: ImprovementPrCreativeStatus | null = null;
    if (asset) {
      // Per-asset overall is the deterministic QA outcome from generateAndQaCreative.
      // Map qa_passed / qa_warned / qa_failed verbatim into creative_status vocabulary.
      switch (asset.qaOverall) {
        case "qa_passed":
        case "qa_warned":
        case "qa_failed":
          status = asset.qaOverall;
          break;
        default:
          status = null;
          break;
      }
    }
    return {
      variantKey,
      status,
      storageRef: asset?.storageRef ?? null,
      storagePath: asset?.storageKey ?? null,
    };
  });

  return {
    fallback: false,
    providerName: result.generation.meta.provider,
    model: result.generation.meta.model,
    parameters: {
      variationConditions:
        result.generation.meta.parameters.variationConditions,
      purpose: result.generation.meta.parameters.purpose,
      variantCount: result.generation.meta.parameters.variantCount,
      ...(placementExpansion ? { placementExpansion } : {}),
    },
    baseStorageRef: persisted.baseStorageRef,
    perVariant,
    variants: prepared.variants,
    providerError: null,
    placementExpansion,
  };
}

const MAX_PLACEMENT_EXPANDED_VARIANTS = 12;

function prepareCarouselImagePromptVariants(
  variants: ImprovementPrImagePromptVariant[],
  carousel: NonNullable<ImprovementPrCopyOutput["carousel"]>,
): ImprovementPrImagePromptVariant[] {
  const byKey = new Map<string, ImprovementPrImagePromptVariant>();
  for (const variant of variants) {
    if (variant.variantKey) byKey.set(variant.variantKey, variant);
  }
  const prepared: ImprovementPrImagePromptVariant[] = [];
  for (const card of carousel.cards) {
    const key = `card-${card.position}`;
    const variant = byKey.get(key);
    if (!variant) continue;
    prepared.push({
      ...variant,
      variantKey: key,
      width: 1080,
      height: 1080,
      format: "png",
      aspectRatio: "1:1",
    });
  }
  return prepared;
}

function buildCarouselCreativeSpec(
  carousel: NonNullable<ImprovementPrCopyOutput["carousel"]>,
): CarouselCreativeSpec {
  return {
    schemaVersion: 1,
    storyArc: carousel.storyArc,
    cards: carousel.cards
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((card) => ({
        position: card.position,
        role: card.role,
        headline: card.headline,
        description: card.description,
        linkUrl: card.linkUrl ?? null,
        assetVariantKey: `card-${card.position}`,
      })),
  };
}

function prepareImagePromptVariantsForGeneration(input: {
  variants: ImprovementPrImagePromptVariant[];
  placementSet?: PlacementKey[];
}): {
  variants: PreparedImagePromptVariant[];
  originalVariantCount: number;
  usedVariantCount: number;
  maxExpandedVariants: number;
  reduced: boolean;
} {
  if (!input.placementSet || input.placementSet.length === 0) {
    return {
      variants: input.variants.map((variant, i) => {
        const variantKey = variant.variantKey ?? `variant-${i}`;
        return {
          ...variant,
          variantKey,
          sourceVariantIndex: i,
          baseVariantKey: variantKey,
        };
      }),
      originalVariantCount: input.variants.length,
      usedVariantCount: input.variants.length,
      maxExpandedVariants: input.variants.length,
      reduced: false,
    };
  }

  const placements = dedupePlacementSet(input.placementSet);
  if (placements.length === 0) {
    return prepareImagePromptVariantsForGeneration({
      variants: input.variants,
    });
  }
  const allowedBaseCount = Math.max(
    1,
    Math.floor(MAX_PLACEMENT_EXPANDED_VARIANTS / placements.length),
  );
  const usedVariants = input.variants.slice(0, allowedBaseCount);
  const expanded: PreparedImagePromptVariant[] = [];
  for (let i = 0; i < usedVariants.length; i += 1) {
    const base = usedVariants[i]!;
    const baseVariantKey = base.variantKey ?? `variant-${i}`;
    const plan = buildPlacementExpansionPlan(
      { ...base, variantKey: baseVariantKey },
      placements,
    );
    for (const expansion of plan.expansions) {
      const preset = placementPresetByKey(expansion.placementKey);
      expanded.push({
        ...base,
        variantKey: expansion.variantKey,
        width: expansion.condition.width,
        height: expansion.condition.height,
        format: expansion.condition.format ?? "png",
        aspectRatio: preset.aspectRatio,
        sourceVariantIndex: i,
        baseVariantKey: plan.baseVariantKey,
        placementKey: expansion.placementKey,
        placementLabel: preset.label,
      });
    }
  }
  return {
    variants: expanded,
    originalVariantCount: input.variants.length,
    usedVariantCount: usedVariants.length,
    maxExpandedVariants: MAX_PLACEMENT_EXPANDED_VARIANTS,
    reduced: usedVariants.length < input.variants.length,
  };
}

function buildPlacementExpansionMetadata(
  prepared: ReturnType<typeof prepareImagePromptVariantsForGeneration>,
  placementSet?: PlacementKey[],
): Record<string, unknown> | null {
  if (!placementSet || placementSet.length === 0) return null;
  const placements = dedupePlacementSet(placementSet);
  return {
    placementSet: placements,
    originalVariantCount: prepared.originalVariantCount,
    usedVariantCount: prepared.usedVariantCount,
    expandedVariantCount: prepared.variants.length,
    maxExpandedVariants: prepared.maxExpandedVariants,
    reduced: prepared.reduced,
  };
}

function dedupePlacementSet(
  placements: readonly PlacementKey[],
): PlacementKey[] {
  return [...new Set(placements)];
}
