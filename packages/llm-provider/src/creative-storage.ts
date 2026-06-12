// AdDroid OSS — Creative LocalDisk persistence (Implementation item).
//
// `ImageProvider.generateImage()` が返した bytes と、`evaluateCreativeQa*` が
// 返した QA 結果を **LocalDisk Storage Adapter** に書き出すヘルパ。
//
// 配置レイアウト:
//
//   <storage-root>/                            ← `~/.addroid/storage` (LocalDisk)
//     creatives/
//       <account_key>/
//         <creative_id>/
//           <asset_id>.<ext>                   ← Provider が返した bytes
//           <asset_id>.<ext>
//           ...
//           metadata.json                      ← prompt / provider / model /
//                                                parameters / qa / linkage
//
// the current implementation acceptance:
//   - "Generated images and metadata are stored under the configured LocalDisk
//      storage path with stable references."
//   - "Metadata must preserve prompt, model/provider, parameters, and QA result."
//
// 設計原則:
//   - Storage Adapter には structural typing (`CreativeStorageAdapter`) で依存し、
//     `@addroid/config.LocalDiskStorage` への hard dependency を増やさない。
//     呼び出し側 (apps/worker / apps/web) が LocalDiskStorage instance をそのまま
//     渡せる shape にしてある。
//   - 戻り値の参照 ID は **必ず `storage://creatives/<account_key>/<creative_id>/...`
//     の安定 ref**。絶対 file path (`~/.addroid/...`) は呼び出し元に返さない
//     (UI design plan principle 24)。
//   - 文字列入力 (`accountKey`, `creativeId`) は path-traversal を拒否し、
//     LocalDiskStorage の resolve に渡す前に validate する (defense in depth)。
//   - asset_id は `(creativeId, variantKey)` から決定論的に派生 (sha256 → 12 hex)。
//     同じ generation を二度書いても安定したファイル名 / storage_ref になる。
//   - metadata.json は **生成時パラメータ + QA 結果 + linkage** を 1 つに集約。
//     creatives テーブル row を引かなくても storage 上だけで監査が完結する。
//   - 副作用は Storage Adapter の write() のみ。Prisma も外部 fetch も触らない。

import { createHash } from "node:crypto";

import type {
  ImageGenerateResult,
  ImageProviderName,
  ImageVariationCondition,
} from "./image-provider.js";
import {
  CREATIVE_QA_CHECK_KINDS,
  type CreativeQaAssetResult,
  type CreativeQaBatchResult,
  type CreativeQaCheckKind,
  type CreativeQaCheckResult,
  type CreativeQaOverallOutcome,
} from "./creative-qa.js";
import type { CreativeGenes } from "./creative-genes.js";

// ---------------------------------------------------------------------------
// Adapter shape
// ---------------------------------------------------------------------------

/**
 * `CreativeStorageAdapter` — `@addroid/config.LocalDiskStorage` と structurally
 * 互換な書き出し境界。テスト / 将来の S3/GCS adapter に差し替えられるよう、
 * ここでは duck typing で受ける。
 *
 * `write(key, data)`:
 *   - `key` は POSIX 風の相対 key (例: `creatives/acme/creative_xxx/asset_xxx.png`)。
 *   - 戻り値の `path` は absolute fs path。本ヘルパは戻り値の `path` を
 *     呼び出し元には返さない (UI design plan principle 24)。
 */
export interface CreativeStorageAdapter {
  write(key: string, data: string | Uint8Array): Promise<{ path: string; bytes: number }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CreativeStorageInvalidIdError extends Error {
  readonly field: "accountKey" | "creativeId" | "variantKey";
  readonly value: string;
  constructor(field: "accountKey" | "creativeId" | "variantKey", value: string, detail: string) {
    super(`creative storage: ${field}=${JSON.stringify(value)} is invalid: ${detail}`);
    this.name = "CreativeStorageInvalidIdError";
    this.field = field;
    this.value = value;
  }
}

/**
 * regression fix / regression fix: Storage 永続化と PR 添付の境界で「complete
 * per-asset QA」を強制するためのエラー型。
 *
 * the current implementation acceptance:
 *   "Creative QA checks dimensions, format, quality, forbidden expressions,
 *    and brand-tone constraints before PR attachment."
 *   "creatives table links generated assets to ... storage ref, and PR."
 *
 * 「QA を通っていない asset を storage に書く」あるいは「QA 結果が空 / 部分的な
 * 状態で PR 番号 (`pullRequestNumber`) を metadata に焼き付ける」操作は
 * audit 上 PR 添付前ゲートを迂回したことになる。`persistCreativeAssets` は
 * これらを **書き込み前に throw** することで storage 上に半端な状態を作らない。
 *
 * regression fix: PR-linkage には「全 asset が 5 種の check kind を持つ」
 * (`pr_link_with_incomplete_check_kinds`) と「どの asset も `qa_failed` でない」
 * (`pr_link_with_qa_failed`) の二つを追加で強制する。前者は PR に attach する
 * 時点で QA が dimensions / format / quality / forbidden_expression / brand_tone
 * を網羅していることを担保し、後者は blocking failure を引きずったまま
 * `pullRequestNumber` を metadata に焼くのを禁じる。
 *
 * `reason` は呼び出し元が UI / audit metadata に流す sanitized メッセージ。
 * `missingVariantKeys` は QA が欠けている variant、または qa_failed / 未網羅の
 * variant の安定キー (定義域 = generation 内の variantKey)。
 */
export type CreativeStorageQaIncompleteReason =
  | "qa_missing"
  | "qa_assets_missing"
  | "pr_link_without_qa"
  | "pr_link_with_qa_failed"
  | "pr_link_with_incomplete_check_kinds";

export class CreativeStorageQaIncompleteError extends Error {
  readonly reason: CreativeStorageQaIncompleteReason;
  readonly missingVariantKeys: readonly string[];
  constructor(
    reason: CreativeStorageQaIncompleteReason,
    detail: string,
    missingVariantKeys: readonly string[] = []
  ) {
    super(`creative storage: per-asset QA gate failed (${reason}): ${detail}`);
    this.name = "CreativeStorageQaIncompleteError";
    this.reason = reason;
    this.missingVariantKeys = [...missingVariantKeys];
  }
}

// ---------------------------------------------------------------------------
// Public API: persist
// ---------------------------------------------------------------------------

export interface PersistCreativeAssetsLinks {
  /**
   * `Creative.aiRunId` (image_prompt の ai_run id)。Web UI / audit deep-link 用。
   */
  aiRunId?: string | null;
  /**
   * Image Prompt Agent の ai_run id (上の `aiRunId` と同義のことが多いが、
   * orchestrator が両方分けて管理したいとき用)。
   */
  imagePromptAiRunId?: string | null;
  /** Creative QA agent / QA hop の ai_run id (任意)。 */
  creativeQaAiRunId?: string | null;
  /** improvement_pr workflow run の id (任意)。 */
  improvementRunId?: string | null;
  /** PR 添付済みの場合の PR 番号 (任意)。未添付なら null。 */
  pullRequestNumber?: number | null;
}

export interface PersistCreativeAssetsOptions {
  storage: CreativeStorageAdapter;
  /** AdAccount.key と一致する安定キー。path-safe である必要がある。 */
  accountKey: string;
  /** `creatives.id` (DB primary key)。path-safe である必要がある。 */
  creativeId: string;
  /** ImageProvider.generateImage() の結果。 */
  generation: ImageGenerateResult;
  /** evaluateCreativeQaBatch() の結果 (任意; Provider が走らなかった場合 null)。 */
  qa?: CreativeQaBatchResult | null;
  /** Web UI / audit からの deep-link 用 linkage。 */
  links?: PersistCreativeAssetsLinks;
  /** creative_qa agent が推定した閉じた語彙の構造化タグ。 */
  genes?: CreativeGenes | null;
  /**
   * metadata.json の `createdAt` フィールド。指定がなければ ISO 現在時刻。
   * test seam として注入できるように分離。
   */
  metadataCreatedAt?: string;
  /**
   * 戻り値 / metadata.json で使う scheme prefix。既定 `"storage://"`。
   * Storage Adapter を S3/GCS に差し替えるときに変える余地として持つ。
   */
  storageScheme?: string;
}

export interface PersistedCreativeAsset {
  variantKey: string;
  assetId: string;
  /** ファイル名 (例: `asset_a1b2c3d4e5f6.png`)。 */
  filename: string;
  /** `creatives/<account_key>/<creative_id>/<asset_id>.<ext>` (Storage Adapter key)。 */
  storageKey: string;
  /** `storage://creatives/<account_key>/<creative_id>/<asset_id>.<ext>` (UI / PR / 監査参照用)。 */
  storageRef: string;
  byteSize: number;
  mimeType: string;
  width: number;
  height: number;
  /**
   * 当該 asset の Creative QA overall outcome。
   *
   * regression fix: `persistCreativeAssets` は per-asset QA を必須化したため、
   * 永続化された asset は必ず確定的な outcome を持つ。`null` は返らない契約
   * (= the current implementation acceptance "Creative QA checks ... before PR attachment").
   */
  qaOverall: CreativeQaOverallOutcome;
}

export interface PersistedCreativeMetadata {
  /** `creatives/<account_key>/<creative_id>/metadata.json`。 */
  storageKey: string;
  /** `storage://creatives/<account_key>/<creative_id>/metadata.json`。 */
  storageRef: string;
  byteSize: number;
}

export interface PersistCreativeAssetsResult {
  creativeId: string;
  accountKey: string;
  /** `creatives/<account_key>/<creative_id>` (assets の親ディレクトリ key)。 */
  baseStorageKey: string;
  /** `storage://creatives/<account_key>/<creative_id>` (assets の親ディレクトリ ref)。 */
  baseStorageRef: string;
  assets: PersistedCreativeAsset[];
  metadata: PersistedCreativeMetadata;
}

const DEFAULT_STORAGE_SCHEME = "storage://";

/**
 * 生成 1 回分 (= 1 creative_id) の bytes と metadata を LocalDisk に永続化する。
 *
 * - 各 asset を `creatives/<account_key>/<creative_id>/<asset_id>.<ext>` に書く。
 * - `metadata.json` を同じディレクトリに書く。prompt / provider / model /
 *   variation_conditions / qa per-check breakdown / linkage を含む。
 * - `qa` が指定されていれば、各 asset の overall を metadata と戻り値の双方に
 *   写し込む (Web UI が creatives テーブル抜きで storage を引いても QA 結果を
 *   復元できる)。
 * - 失敗 / 部分書き込みを呼び出し元に明示するため、書き込み中の例外は throw する
 *   (Storage Adapter 側で失敗を観測しても caller に投げ返す)。
 */
export async function persistCreativeAssets(
  opts: PersistCreativeAssetsOptions
): Promise<PersistCreativeAssetsResult> {
  const accountKey = validateSegment("accountKey", opts.accountKey);
  const creativeId = validateSegment("creativeId", opts.creativeId);
  const scheme = opts.storageScheme ?? DEFAULT_STORAGE_SCHEME;

  const baseStorageKey = `creatives/${accountKey}/${creativeId}`;
  const baseStorageRef = `${scheme}${baseStorageKey}`;

  // regression fix: per-asset QA を必須化する。`opts.qa` が無い、または
  // generation.assets と variantKey が突き合わない場合は **storage に何も
  // 書かずに** throw する。これにより以下を同時に達成する:
  //   - "Creative QA checks ... before PR attachment" (the current implementation acceptance)
  //   - 「QA を欠いた asset を storage に積む → 後段で qaOverall=null のまま
  //     PR 添付されてしまう」回路を物理的に塞ぐ。
  //   - `links.pullRequestNumber` を引数で受けたまま QA が無い、という
  //     「PR 番号が metadata に焼かれるのに QA は無記録」という監査上問題の
  //     ある状態を作らない。
  const pullRequestNumber = opts.links?.pullRequestNumber ?? null;
  if (!opts.qa) {
    if (pullRequestNumber !== null) {
      throw new CreativeStorageQaIncompleteError(
        "pr_link_without_qa",
        `pullRequestNumber=${pullRequestNumber} requires a complete CreativeQaBatchResult`,
      );
    }
    throw new CreativeStorageQaIncompleteError(
      "qa_missing",
      `creativeId=${creativeId}: persistCreativeAssets requires a non-null qa argument`
    );
  }
  const qaByVariant = new Map<string, CreativeQaAssetResult>();
  for (const a of opts.qa.assets) {
    qaByVariant.set(a.variantKey, a);
  }
  const missingVariantKeys: string[] = [];
  for (const asset of opts.generation.assets) {
    if (!qaByVariant.has(asset.variantKey)) {
      missingVariantKeys.push(asset.variantKey);
    }
  }
  if (missingVariantKeys.length > 0) {
    if (pullRequestNumber !== null) {
      throw new CreativeStorageQaIncompleteError(
        "pr_link_without_qa",
        `pullRequestNumber=${pullRequestNumber} requires QA results for every generated asset; ` +
          `missing variantKeys=${JSON.stringify(missingVariantKeys)}`,
        missingVariantKeys
      );
    }
    throw new CreativeStorageQaIncompleteError(
      "qa_assets_missing",
      `creativeId=${creativeId}: per-asset QA is missing for variantKeys=${JSON.stringify(missingVariantKeys)}`,
      missingVariantKeys
    );
  }

  // regression fix: PR-linkage 専用ゲート。`pullRequestNumber` を metadata に
  // 焼き付ける前に、当該 generation の全 asset が以下を満たすことを確認する:
  //   1. dimensions / format / quality / forbidden_expression / brand_tone の
  //      5 種 check kind を **全て** 持つ (the current implementation acceptance: "Creative QA
  //      checks dimensions, format, quality, forbidden expressions, and
  //      brand-tone constraints before PR attachment").
  //   2. どの asset も `overall === 'qa_failed'` でない (blocking failure を
  //      引きずったまま PR 添付されるのを防ぐ)。
  // どちらかが破れている状態で `pullRequestNumber` を許容すると、
  // metadata.links.pullRequestNumber が「QA 不完全 / 失敗 + PR 添付」という
  // 監査上不可能な組み合わせで storage に焼かれてしまう。assets / metadata
  // のいずれも書き出さずに throw する。
  if (pullRequestNumber !== null) {
    const failedVariantKeys: string[] = [];
    const incompleteVariantKeys: string[] = [];
    for (const asset of opts.generation.assets) {
      const qaResult = qaByVariant.get(asset.variantKey)!;
      if (qaResult.overall === "qa_failed") {
        failedVariantKeys.push(asset.variantKey);
      }
      const presentKinds = new Set<CreativeQaCheckKind>(
        qaResult.checks.map((c) => c.kind)
      );
      const missingKinds = CREATIVE_QA_CHECK_KINDS.filter(
        (k) => !presentKinds.has(k)
      );
      if (missingKinds.length > 0) {
        incompleteVariantKeys.push(asset.variantKey);
      }
    }
    if (incompleteVariantKeys.length > 0) {
      throw new CreativeStorageQaIncompleteError(
        "pr_link_with_incomplete_check_kinds",
        `pullRequestNumber=${pullRequestNumber} requires every asset's QA to include all ` +
          `${CREATIVE_QA_CHECK_KINDS.length} check kinds [${CREATIVE_QA_CHECK_KINDS.join(", ")}]; ` +
          `incomplete variantKeys=${JSON.stringify(incompleteVariantKeys)}`,
        incompleteVariantKeys
      );
    }
    if (failedVariantKeys.length > 0) {
      throw new CreativeStorageQaIncompleteError(
        "pr_link_with_qa_failed",
        `pullRequestNumber=${pullRequestNumber} cannot be linked to qa_failed assets; ` +
          `failing variantKeys=${JSON.stringify(failedVariantKeys)}`,
        failedVariantKeys
      );
    }
  }

  const persistedAssets: PersistedCreativeAsset[] = [];
  for (const asset of opts.generation.assets) {
    const variantKey = validateSegment("variantKey", asset.variantKey);
    const assetId = deriveAssetId(creativeId, variantKey);
    const ext = mimeTypeToExtension(asset.mimeType);
    const filename = `${assetId}.${ext}`;
    const storageKey = `${baseStorageKey}/${filename}`;
    const storageRef = `${scheme}${storageKey}`;

    await opts.storage.write(storageKey, asset.bytes);

    // qaByVariant.has(asset.variantKey) は上で確認済みなので qaResult は必ず非 null。
    const qaResult = qaByVariant.get(asset.variantKey)!;
    persistedAssets.push({
      variantKey: asset.variantKey,
      assetId,
      filename,
      storageKey,
      storageRef,
      byteSize: asset.byteSize,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      qaOverall: qaResult.overall,
    });
  }

  const metadataKey = `${baseStorageKey}/metadata.json`;
  const metadataRef = `${scheme}${metadataKey}`;
  const metadataDoc = buildMetadataDocument({
    creativeId,
    accountKey,
    baseStorageRef,
    generation: opts.generation,
    // regression fix: opts.qa は上で必須化済み (`!opts.qa` で throw)。
    qa: opts.qa,
    persistedAssets,
    links: opts.links ?? {},
    genes: opts.genes ?? null,
    createdAt: opts.metadataCreatedAt ?? new Date().toISOString(),
  });
  const metadataJson = JSON.stringify(metadataDoc, null, 2) + "\n";
  const metadataWrite = await opts.storage.write(metadataKey, metadataJson);

  return {
    creativeId,
    accountKey,
    baseStorageKey,
    baseStorageRef,
    assets: persistedAssets,
    metadata: {
      storageKey: metadataKey,
      storageRef: metadataRef,
      byteSize: metadataWrite.bytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Metadata document
// ---------------------------------------------------------------------------

interface MetadataDocumentInput {
  creativeId: string;
  accountKey: string;
  baseStorageRef: string;
  generation: ImageGenerateResult;
  /**
   * regression fix: QA は呼び出し側 (`persistCreativeAssets`) で必須化済みの
   * ため、ここで null を受け取ることはない。
   */
  qa: CreativeQaBatchResult;
  persistedAssets: PersistedCreativeAsset[];
  links: PersistCreativeAssetsLinks;
  genes: CreativeGenes | null;
  createdAt: string;
}

interface MetadataAsset {
  variantKey: string;
  assetId: string;
  filename: string;
  storageRef: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  /**
   * regression fix: persistCreativeAssets が per-asset QA を必須化したため、
   * metadata 上の qaOverall は常に確定的な outcome を持つ。
   */
  qaOverall: CreativeQaOverallOutcome;
}

interface MetadataQaCheck {
  kind: CreativeQaCheckResult["kind"];
  severity: CreativeQaCheckResult["severity"];
  outcome: CreativeQaCheckResult["outcome"];
  detail: string;
  evidence: string | null;
}

interface MetadataQaAsset {
  variantKey: string;
  overall: CreativeQaOverallOutcome;
  checks: MetadataQaCheck[];
}

interface MetadataQa {
  overall: CreativeQaOverallOutcome;
  passingCount: number;
  failingCount: number;
  assets: MetadataQaAsset[];
}

interface MetadataDocument {
  schemaVersion: 1;
  creativeId: string;
  accountKey: string;
  storageRef: string;
  createdAt: string;
  provider: ImageProviderName;
  model: string;
  prompt: string;
  generatedAt: string;
  requestId: string | null;
  variantCount: number;
  parameters: {
    purpose: string | null;
    variationConditions: ImageVariationCondition[];
  };
  costUsd: number;
  assets: MetadataAsset[];
  /**
   * regression fix: per-asset QA は永続化前に必須化されたため、metadata 上の
   * `qa` は常に確定的な document を持つ (`null` は返らない)。
   */
  qa: MetadataQa;
  genes: CreativeGenes | null;
  links: {
    aiRunId: string | null;
    imagePromptAiRunId: string | null;
    creativeQaAiRunId: string | null;
    improvementRunId: string | null;
    pullRequestNumber: number | null;
  };
}

function buildMetadataDocument(input: MetadataDocumentInput): MetadataDocument {
  const meta = input.generation.meta;
  const qa: MetadataQa = {
    overall: input.qa.overall,
    passingCount: input.qa.passingCount,
    failingCount: input.qa.failingCount,
    assets: input.qa.assets.map((a) => ({
      variantKey: a.variantKey,
      overall: a.overall,
      checks: a.checks.map((c) => ({
        kind: c.kind,
        severity: c.severity,
        outcome: c.outcome,
        detail: c.detail,
        evidence: c.evidence,
      })),
    })),
  };

  return {
    schemaVersion: 1,
    creativeId: input.creativeId,
    accountKey: input.accountKey,
    storageRef: input.baseStorageRef,
    createdAt: input.createdAt,
    provider: meta.provider,
    model: meta.model,
    prompt: meta.prompt,
    generatedAt: meta.generatedAt,
    requestId: meta.requestId,
    variantCount: meta.parameters.variantCount,
    parameters: {
      purpose: meta.parameters.purpose,
      variationConditions: meta.parameters.variationConditions,
    },
    costUsd: input.generation.costUsd,
    assets: input.persistedAssets.map((a) => ({
      variantKey: a.variantKey,
      assetId: a.assetId,
      filename: a.filename,
      storageRef: a.storageRef,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      byteSize: a.byteSize,
      qaOverall: a.qaOverall,
    })),
    qa,
    genes: input.genes,
    links: {
      aiRunId: input.links.aiRunId ?? null,
      imagePromptAiRunId: input.links.imagePromptAiRunId ?? null,
      creativeQaAiRunId: input.links.creativeQaAiRunId ?? null,
      improvementRunId: input.links.improvementRunId ?? null,
      pullRequestNumber: input.links.pullRequestNumber ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEGMENT_MAX_LEN = 128;
// path-safe: 英数 + `_` + `-`。先頭は英数のみ。`.` 単独や `..` は弾く。
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function validateSegment(
  field: "accountKey" | "creativeId" | "variantKey",
  value: unknown
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CreativeStorageInvalidIdError(field, String(value), "must be a non-empty string");
  }
  if (value.length > SEGMENT_MAX_LEN) {
    throw new CreativeStorageInvalidIdError(
      field,
      value,
      `must be ${SEGMENT_MAX_LEN} characters or fewer`
    );
  }
  if (!SEGMENT_PATTERN.test(value)) {
    throw new CreativeStorageInvalidIdError(
      field,
      value,
      "must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (no '/', no '.', no whitespace)"
    );
  }
  return value;
}

function deriveAssetId(creativeId: string, variantKey: string): string {
  const h = createHash("sha256")
    .update(`${creativeId}|${variantKey}`)
    .digest("hex");
  return `asset_${h.slice(0, 12)}`;
}

function mimeTypeToExtension(mime: string): "png" | "jpg" {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  // Provider abstraction guarantees image/png | image/jpeg, but keep a safe
  // default so we never write extensionless files.
  return "png";
}
