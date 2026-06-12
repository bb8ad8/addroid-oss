// AdDroid OSS — apps/web 側の Creative metadata パーサ / status マッパ.
//
// /creatives と /creatives/[id] と /api/creatives/[id]/asset/[assetId] が共通で
// 使う読み取り専用ヘルパ。書き込みは行わない。
//
// 設計:
//   - creatives.spec / creatives.parameters は worker 側で sanitize 済みの
//     JSON が入っている前提だが、UI 表示直前にも redactor を通す
//     (UI design plan principle 7 / sanitize-on-render の二重防御)。
//   - LocalDisk Storage Adapter から metadata.json を読み出すヘルパも提供する。
//     storage 上に metadata.json が無い (古い / fallback / 削除) ケースは
//     呼び出し側が空状態 UI に倒す。
//   - status → StatusDot/StatusBadge の StatusState 写像も 1 箇所に集約する。

import path from "node:path";
import { LocalDiskStorage } from "@addroid/config";
import {
  parseCarouselCreativeSpec,
  parseCreativeGenes,
  type CarouselCreativeSpec,
  type CreativeGenes,
} from "@addroid/llm-provider";
import type { StatusState } from "../components/ui/StatusDot";
import { formatDateTime } from "./datetime";
import { sanitizeForDisplay } from "./meta-runtime";

// ---------------------------------------------------------------------
// creative_status vocabulary (UI design plan §0.26).
// ---------------------------------------------------------------------
export const CREATIVE_STATUSES = [
  "queued",
  "generating",
  "qa_running",
  "qa_passed",
  "qa_warned",
  "qa_failed",
  "attached_to_pr",
  "merged",
  "active_on_meta",
  "superseded",
  "fallback_text_only",
] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];

export function isCreativeStatus(v: string): v is CreativeStatus {
  return (CREATIVE_STATUSES as readonly string[]).includes(v);
}

export function creativeStatusToState(status: string): StatusState {
  switch (status) {
    case "qa_passed":
    case "merged":
    case "active_on_meta":
      return "ok";
    case "qa_warned":
      return "warn";
    case "qa_failed":
      return "error";
    case "generating":
    case "qa_running":
      return "info";
    case "attached_to_pr":
      return "info";
    case "queued":
    case "superseded":
    case "fallback_text_only":
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------
// QA outcome / severity (matches packages/llm-provider creative-qa.ts).
// ---------------------------------------------------------------------
export type CreativeQaOutcome = "pass" | "warn" | "fail" | "skipped";
export type CreativeQaSeverity = "blocking" | "non_blocking" | "info_only";
export type CreativeQaCheckKind =
  | "dimensions"
  | "format"
  | "quality"
  | "forbidden_expression"
  | "brand_tone";
export type CreativeQaOverall =
  | "qa_passed"
  | "qa_warned"
  | "qa_failed"
  | "fallback_text_only";

export function qaOutcomeToState(outcome: CreativeQaOutcome): StatusState {
  switch (outcome) {
    case "pass":
      return "ok";
    case "warn":
      return "warn";
    case "fail":
      return "error";
    case "skipped":
    default:
      return "idle";
  }
}

export function qaOverallToState(overall: CreativeQaOverall): StatusState {
  switch (overall) {
    case "qa_passed":
      return "ok";
    case "qa_warned":
      return "warn";
    case "qa_failed":
      return "error";
    case "fallback_text_only":
    default:
      return "idle";
  }
}

// ---------------------------------------------------------------------
// creatives.spec parser — improvement-pr-runtime.ts の createCreative が書く形。
// ---------------------------------------------------------------------
export interface CreativeSpecQaIssue {
  severity: string;
  category: string;
  message: string;
}

export interface CreativeSpecQa {
  aiRunId: string | null;
  recommendation: string | null;
  issues: CreativeSpecQaIssue[];
  rationale: string | null;
}

export interface CreativeSpecAdText {
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  callToAction: string | null;
  rationale: string | null;
}

export interface CreativeSpecTextRecommendations {
  primaryText: number | null;
  headline: number | null;
  description: number | null;
}

export interface CreativeSpec {
  prompt: string | null;
  negativePrompt: string | null;
  styleNotes: string | null;
  rationale: string | null;
  variantIndex: number | null;
  adText: CreativeSpecAdText | null;
  textVariants: CreativeSpecAdText[];
  metaTextRecommendations: CreativeSpecTextRecommendations | null;
  qa: CreativeSpecQa | null;
  genes: CreativeGenes | null;
  carousel: CarouselCreativeSpec | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStr(v: unknown): string | null {
  return typeof v === "string" ? sanitizeForDisplay(v) : null;
}

function readNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseAdText(v: unknown): CreativeSpecAdText | null {
  if (!isRecord(v)) return null;
  return {
    primaryText: readStr(v.primaryText),
    headline: readStr(v.headline),
    description: readStr(v.description),
    callToAction: readStr(v.callToAction),
    rationale: readStr(v.rationale),
  };
}

export function parseCreativeSpec(spec: unknown): CreativeSpec {
  const r = isRecord(spec) ? spec : {};
  let qa: CreativeSpecQa | null = null;
  if (isRecord(r.qa)) {
    const issues = Array.isArray(r.qa.issues)
      ? r.qa.issues.filter(isRecord).map((i) => ({
          severity: readStr(i.severity) ?? "",
          category: readStr(i.category) ?? "",
          message: readStr(i.message) ?? "",
        }))
      : [];
    qa = {
      aiRunId: readStr(r.qa.aiRunId),
      recommendation: readStr(r.qa.recommendation),
      issues,
      rationale: readStr(r.qa.rationale),
    };
  }
  const adText =
    parseAdText(r.adText) ??
    (readStr(r.primaryText) ||
    readStr(r.headline) ||
    readStr(r.description) ||
    readStr(r.callToAction)
      ? {
          primaryText: readStr(r.primaryText),
          headline: readStr(r.headline),
          description: readStr(r.description),
          callToAction: readStr(r.callToAction),
          rationale: readStr(r.rationale),
        }
      : null);
  const textVariants = Array.isArray(r.textVariants)
    ? r.textVariants
        .map(parseAdText)
        .filter((v): v is CreativeSpecAdText => v !== null)
    : [];
  const recommendations = isRecord(r.metaTextRecommendations)
    ? {
        primaryText: readNum(r.metaTextRecommendations.primaryText),
        headline: readNum(r.metaTextRecommendations.headline),
        description: readNum(r.metaTextRecommendations.description),
      }
    : null;
  return {
    prompt: readStr(r.prompt),
    negativePrompt: readStr(r.negativePrompt),
    styleNotes: readStr(r.styleNotes),
    rationale: readStr(r.rationale),
    variantIndex: readNum(r.variantIndex),
    adText,
    textVariants,
    metaTextRecommendations: recommendations,
    qa,
    genes: parseCreativeGenes(r.genes),
    carousel: parseCarouselCreativeSpec(r.carousel),
  };
}

// ---------------------------------------------------------------------
// creatives.parameters parser — image-Provider 由来 (purpose / variationConditions)。
//
// `variationConditions[]` は packages/llm-provider の `ImageVariationCondition`
// と同じ shape で worker に persist される (improvement-pr.ts の generate hop が
// `result.generation.meta.parameters.variationConditions` をそのまま書き込む)。
// UI では width/height/format を主、styleNotes/negativePrompt/variantKey を
// 任意の補助情報として扱う。
// ---------------------------------------------------------------------
export interface CreativeVariationCondition {
  width: number | null;
  height: number | null;
  format: string | null;
  styleNotes: string | null;
  negativePrompt: string | null;
  variantKey: string | null;
}

export interface CreativeParameters {
  purpose: string | null;
  variationConditions: CreativeVariationCondition[];
}

export function parseCreativeParameters(
  parameters: unknown,
): CreativeParameters {
  const r = isRecord(parameters) ? parameters : {};
  const conditions = Array.isArray(r.variationConditions)
    ? r.variationConditions.filter(isRecord).map((c) => ({
        width: readNum(c.width),
        height: readNum(c.height),
        format: readStr(c.format),
        styleNotes: readStr(c.styleNotes),
        negativePrompt: readStr(c.negativePrompt),
        variantKey: readStr(c.variantKey),
      }))
    : [];
  return {
    purpose: readStr(r.purpose),
    variationConditions: conditions,
  };
}

// ---------------------------------------------------------------------
// metadata.json parser — creative-storage.ts の MetadataDocument に対応する。
// LocalDisk から読み出した内容を UI 表示用に narrow + sanitize する。
// ---------------------------------------------------------------------
export interface CreativeMetadataAsset {
  variantKey: string;
  assetId: string;
  filename: string;
  storageRef: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  qaOverall: CreativeQaOverall;
}

export interface CreativeMetadataQaCheck {
  kind: CreativeQaCheckKind;
  severity: CreativeQaSeverity;
  outcome: CreativeQaOutcome;
  detail: string;
  evidence: string | null;
}

export interface CreativeMetadataQaAsset {
  variantKey: string;
  overall: CreativeQaOverall;
  checks: CreativeMetadataQaCheck[];
}

export interface CreativeMetadataQa {
  overall: CreativeQaOverall;
  passingCount: number;
  failingCount: number;
  assets: CreativeMetadataQaAsset[];
}

export interface CreativeMetadataLinks {
  aiRunId: string | null;
  imagePromptAiRunId: string | null;
  creativeQaAiRunId: string | null;
  improvementRunId: string | null;
  pullRequestNumber: number | null;
}

export interface CreativeMetadataDocument {
  schemaVersion: number;
  creativeId: string;
  accountKey: string;
  storageRef: string;
  createdAt: string;
  provider: string;
  model: string;
  prompt: string;
  generatedAt: string;
  requestId: string | null;
  variantCount: number;
  parameters: CreativeParameters;
  costUsd: number;
  assets: CreativeMetadataAsset[];
  qa: CreativeMetadataQa;
  genes: CreativeGenes | null;
  links: CreativeMetadataLinks;
}

const VALID_QA_OUTCOMES: ReadonlySet<CreativeQaOutcome> = new Set([
  "pass",
  "warn",
  "fail",
  "skipped",
]);
const VALID_QA_SEVERITIES: ReadonlySet<CreativeQaSeverity> = new Set([
  "blocking",
  "non_blocking",
  "info_only",
]);
const VALID_QA_CHECK_KINDS: ReadonlySet<CreativeQaCheckKind> = new Set([
  "dimensions",
  "format",
  "quality",
  "forbidden_expression",
  "brand_tone",
]);
const VALID_QA_OVERALLS: ReadonlySet<CreativeQaOverall> = new Set([
  "qa_passed",
  "qa_warned",
  "qa_failed",
  "fallback_text_only",
]);

function asQaOutcome(v: unknown): CreativeQaOutcome {
  return typeof v === "string" && VALID_QA_OUTCOMES.has(v as CreativeQaOutcome)
    ? (v as CreativeQaOutcome)
    : "skipped";
}

function asQaSeverity(v: unknown): CreativeQaSeverity {
  return typeof v === "string" &&
    VALID_QA_SEVERITIES.has(v as CreativeQaSeverity)
    ? (v as CreativeQaSeverity)
    : "info_only";
}

function asQaCheckKind(v: unknown): CreativeQaCheckKind | null {
  return typeof v === "string" &&
    VALID_QA_CHECK_KINDS.has(v as CreativeQaCheckKind)
    ? (v as CreativeQaCheckKind)
    : null;
}

function asQaOverall(v: unknown): CreativeQaOverall {
  return typeof v === "string" && VALID_QA_OVERALLS.has(v as CreativeQaOverall)
    ? (v as CreativeQaOverall)
    : "fallback_text_only";
}

export function parseCreativeMetadata(
  raw: unknown,
): CreativeMetadataDocument | null {
  if (!isRecord(raw)) return null;
  const assetsArr = Array.isArray(raw.assets) ? raw.assets : [];
  const assets: CreativeMetadataAsset[] = assetsArr
    .filter(isRecord)
    .map((a) => ({
      variantKey: readStr(a.variantKey) ?? "",
      assetId: readStr(a.assetId) ?? "",
      filename: readStr(a.filename) ?? "",
      storageRef: readStr(a.storageRef) ?? "",
      mimeType: readStr(a.mimeType) ?? "",
      width: readNum(a.width) ?? 0,
      height: readNum(a.height) ?? 0,
      byteSize: readNum(a.byteSize) ?? 0,
      qaOverall: asQaOverall(a.qaOverall),
    }));

  const qaRaw = isRecord(raw.qa) ? raw.qa : {};
  const qaAssetsRaw = Array.isArray(qaRaw.assets) ? qaRaw.assets : [];
  const qaAssets: CreativeMetadataQaAsset[] = qaAssetsRaw
    .filter(isRecord)
    .map((a) => ({
      variantKey: readStr(a.variantKey) ?? "",
      overall: asQaOverall(a.overall),
      checks: Array.isArray(a.checks)
        ? a.checks
            .filter(isRecord)
            .map((c) => {
              const kind = asQaCheckKind(c.kind);
              if (!kind) return null;
              return {
                kind,
                severity: asQaSeverity(c.severity),
                outcome: asQaOutcome(c.outcome),
                detail: readStr(c.detail) ?? "",
                evidence: readStr(c.evidence),
              } satisfies CreativeMetadataQaCheck;
            })
            .filter((c): c is CreativeMetadataQaCheck => c !== null)
        : [],
    }));

  const linksRaw = isRecord(raw.links) ? raw.links : {};

  return {
    schemaVersion: readNum(raw.schemaVersion) ?? 0,
    creativeId: readStr(raw.creativeId) ?? "",
    accountKey: readStr(raw.accountKey) ?? "",
    storageRef: readStr(raw.storageRef) ?? "",
    createdAt: readStr(raw.createdAt) ?? "",
    provider: readStr(raw.provider) ?? "",
    model: readStr(raw.model) ?? "",
    prompt: readStr(raw.prompt) ?? "",
    generatedAt: readStr(raw.generatedAt) ?? "",
    requestId: readStr(raw.requestId),
    variantCount: readNum(raw.variantCount) ?? 0,
    parameters: parseCreativeParameters(raw.parameters),
    costUsd: readNum(raw.costUsd) ?? 0,
    assets,
    qa: {
      overall: asQaOverall(qaRaw.overall),
      passingCount: readNum(qaRaw.passingCount) ?? 0,
      failingCount: readNum(qaRaw.failingCount) ?? 0,
      assets: qaAssets,
    },
    genes: parseCreativeGenes(raw.genes),
    links: {
      aiRunId: readStr(linksRaw.aiRunId),
      imagePromptAiRunId: readStr(linksRaw.imagePromptAiRunId),
      creativeQaAiRunId: readStr(linksRaw.creativeQaAiRunId),
      improvementRunId: readStr(linksRaw.improvementRunId),
      pullRequestNumber: readNum(linksRaw.pullRequestNumber),
    },
  };
}

// ---------------------------------------------------------------------
// Storage Adapter helpers — `storage://` ref を LocalDisk read に解決する。
// 絶対 fs path は呼び出し元には返さない (UI design plan principle 24)。
// ---------------------------------------------------------------------

const STORAGE_SCHEME = "storage://";

let cachedStorage: LocalDiskStorage | null = null;
function getStorage(): LocalDiskStorage {
  if (!cachedStorage) {
    cachedStorage = new LocalDiskStorage({ env: process.env });
  }
  return cachedStorage;
}

/**
 * `storage://creatives/<account_key>/<creative_id>/...` を Storage Adapter
 * の相対 key に変換する。scheme prefix が無い / 別形式は拒否する (SSRF 防止)。
 */
export function storageRefToKey(ref: string): string | null {
  if (typeof ref !== "string" || !ref.startsWith(STORAGE_SCHEME)) return null;
  const key = ref.slice(STORAGE_SCHEME.length);
  if (key.length === 0 || key.includes("..") || key.startsWith("/")) {
    return null;
  }
  return key;
}

/**
 * `<base>/metadata.json` を読み出す。引数は **base ref**
 * (`storage://creatives/<account_key>/<creative_id>`) を期待する。
 *
 * regression fix: 旧経路 (queue) が `Creative.storageRef` に per-asset ref
 * (`storage://.../<asset_id>.png`) を入れていた回路への防御として、引数の
 * 末尾セグメントが「拡張子付きのファイル名」(= per-asset ref または
 * `metadata.json` 直接指定) のときは親ディレクトリに正規化してから
 * `metadata.json` を結合する。これにより list / detail / proxy のいずれが
 * (たまたま) per-asset ref を渡しても 410 ループに陥らない。
 */
export async function readCreativeMetadataByRef(
  baseStorageRef: string,
): Promise<CreativeMetadataDocument | null> {
  const baseKey = storageRefToKey(baseStorageRef);
  if (!baseKey) return null;
  const dirKey = stripTrailingFilename(baseKey);
  const metadataKey = path.posix.join(dirKey, "metadata.json");
  const storage = getStorage();
  try {
    const text = await storage.readText(metadataKey);
    const json = JSON.parse(text);
    return parseCreativeMetadata(json);
  } catch {
    return null;
  }
}

function stripTrailingFilename(key: string): string {
  const lastSlash = key.lastIndexOf("/");
  const last = lastSlash === -1 ? key : key.slice(lastSlash + 1);
  if (last.length > 0 && last.includes(".")) {
    return lastSlash === -1 ? "" : key.slice(0, lastSlash);
  }
  return key;
}

/**
 * (creativeId, assetId) を resolved な (storage key, abs path, fs stat) に
 * 解決する。tenant 境界 (account_key 一致) は呼び出し元 (proxy route) で
 * Prisma row の accountId と session を突き合わせて確認する。
 *
 * URL パラメータを直接受けない。proxy route が DB から storage_ref を
 * 引き当て、その base ref + assetId のみを渡す前提 (SSRF 防止)。
 */
export interface ResolvedCreativeAsset {
  storageKey: string;
  bytes: Buffer;
  byteSize: number;
  mimeType: string;
}

/**
 * `Creative` 行から、その行が表す per-asset を `metadata.assets[]` の中から
 * 解決する。
 *
 * regression fix: list ページや proxy が `metadata.assets[0]` を盲目的に
 * 採用すると、複数 variant がぶら下がる creative_id (= 同一 metadata.json を
 * 共有する improvement_pr 1 回分) の中で **どの行も同じ asset を指してしまう**。
 * 各 Creative 行は `storagePath`
 * (`creatives/<account_key>/<creative_id>/<asset_id>.<ext>`) で per-asset を
 * 一意に指しているので、そのファイル名で metadata 内の asset を引く。
 *
 * `storagePath` が空 (= prompt-only fallback) の場合は null を返し、呼び出し元
 * は thumbnail プレースホルダに倒す。
 */
export function findAssetForCreativeRow(
  metadata: CreativeMetadataDocument,
  row: { storagePath: string | null },
): CreativeMetadataAsset | null {
  if (!row.storagePath) return null;
  const filename = path.posix.basename(row.storagePath);
  if (!filename) return null;
  return metadata.assets.find((a) => a.filename === filename) ?? null;
}

export async function readCreativeAssetByMetadata(
  metadata: CreativeMetadataDocument,
  assetId: string,
): Promise<ResolvedCreativeAsset | null> {
  if (typeof assetId !== "string" || !/^asset_[a-f0-9]{12}$/.test(assetId)) {
    return null;
  }
  const asset = metadata.assets.find((a) => a.assetId === assetId);
  if (!asset) return null;
  const storageKey = storageRefToKey(asset.storageRef);
  if (!storageKey) return null;
  const storage = getStorage();
  try {
    const bytes = await storage.read(storageKey);
    return {
      storageKey,
      bytes,
      byteSize: asset.byteSize,
      mimeType: asset.mimeType || "application/octet-stream",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Display formatters.
// ---------------------------------------------------------------------

export function formatTimestamp(d: Date | string): string {
  return formatDateTime(d);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDimensions(w: number, h: number): string {
  if (!w || !h) return "—";
  return `${w}×${h}`;
}
