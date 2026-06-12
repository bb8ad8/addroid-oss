// AdDroid OSS — closed vocabulary for creative structure tags.

export const APPEAL_AXES = [
  "price",
  "authority",
  "urgency",
  "social_proof",
  "benefit",
  "feature",
  "emotion",
  "curiosity",
] as const;
export type AppealAxis = (typeof APPEAL_AXES)[number];

export const TONES = ["formal", "casual", "energetic", "calm", "premium", "playful"] as const;
export type CreativeTone = (typeof TONES)[number];

export const SUBJECT_TYPES = [
  "product",
  "person",
  "lifestyle",
  "text_only",
  "illustration",
  "abstract",
] as const;
export type CreativeSubjectType = (typeof SUBJECT_TYPES)[number];

export const COLOR_SCHEMES = [
  "bright",
  "dark",
  "monochrome",
  "pastel",
  "vivid",
  "brand_palette",
] as const;
export type CreativeColorScheme = (typeof COLOR_SCHEMES)[number];

export const LAYOUTS = ["single_focus", "split", "grid", "text_heavy", "minimal"] as const;
export type CreativeLayout = (typeof LAYOUTS)[number];

export const LANGUAGES = ["ja", "en", "other"] as const;
export type CreativeLanguage = (typeof LANGUAGES)[number];

export interface CreativeGenes {
  schemaVersion: 1;
  appealAxes: AppealAxis[];
  tone: CreativeTone;
  subjectType: CreativeSubjectType;
  colorScheme: CreativeColorScheme;
  layout: CreativeLayout;
  hasTextOverlay: boolean;
  hasCta: boolean;
  language: CreativeLanguage;
}

export const GENE_LABELS_JA: Record<string, string> = {
  price: "価格",
  authority: "権威性",
  urgency: "緊急性",
  social_proof: "社会的証明",
  benefit: "ベネフィット",
  feature: "機能",
  emotion: "情緒",
  curiosity: "好奇心",
  formal: "フォーマル",
  casual: "カジュアル",
  energetic: "勢い",
  calm: "落ち着き",
  premium: "高級感",
  playful: "遊び心",
  product: "商品",
  person: "人物",
  lifestyle: "利用シーン",
  text_only: "テキスト中心",
  illustration: "イラスト",
  abstract: "抽象",
  bright: "明るい",
  dark: "暗い",
  monochrome: "モノクロ",
  pastel: "パステル",
  vivid: "ビビッド",
  brand_palette: "ブランド配色",
  single_focus: "単一焦点",
  split: "分割",
  grid: "グリッド",
  text_heavy: "文字多め",
  minimal: "ミニマル",
  ja: "日本語",
  en: "英語",
  other: "その他",
};

const APPEAL_AXIS_SET = new Set<string>(APPEAL_AXES);
const TONE_SET = new Set<string>(TONES);
const SUBJECT_TYPE_SET = new Set<string>(SUBJECT_TYPES);
const COLOR_SCHEME_SET = new Set<string>(COLOR_SCHEMES);
const LAYOUT_SET = new Set<string>(LAYOUTS);
const LANGUAGE_SET = new Set<string>(LANGUAGES);

export function parseCreativeGenes(value: unknown): CreativeGenes | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (!Array.isArray(value.appealAxes)) return null;
  if (value.appealAxes.length < 1 || value.appealAxes.length > 3) return null;
  const appealAxes: AppealAxis[] = [];
  const seenAxes = new Set<string>();
  for (const axis of value.appealAxes) {
    if (typeof axis !== "string" || !APPEAL_AXIS_SET.has(axis) || seenAxes.has(axis)) {
      return null;
    }
    seenAxes.add(axis);
    appealAxes.push(axis as AppealAxis);
  }
  if (typeof value.tone !== "string" || !TONE_SET.has(value.tone)) return null;
  if (typeof value.subjectType !== "string" || !SUBJECT_TYPE_SET.has(value.subjectType)) {
    return null;
  }
  if (typeof value.colorScheme !== "string" || !COLOR_SCHEME_SET.has(value.colorScheme)) {
    return null;
  }
  if (typeof value.layout !== "string" || !LAYOUT_SET.has(value.layout)) return null;
  if (typeof value.hasTextOverlay !== "boolean") return null;
  if (typeof value.hasCta !== "boolean") return null;
  if (typeof value.language !== "string" || !LANGUAGE_SET.has(value.language)) return null;

  return {
    schemaVersion: 1,
    appealAxes,
    tone: value.tone as CreativeTone,
    subjectType: value.subjectType as CreativeSubjectType,
    colorScheme: value.colorScheme as CreativeColorScheme,
    layout: value.layout as CreativeLayout,
    hasTextOverlay: value.hasTextOverlay,
    hasCta: value.hasCta,
    language: value.language as CreativeLanguage,
  };
}

export function describeGenesForPrompt(genes: CreativeGenes): string {
  return [
    `訴求軸: ${genes.appealAxes.map(labelJa).join("+")}`,
    `トーン: ${labelJa(genes.tone)}`,
    `被写体: ${labelJa(genes.subjectType)}`,
    `配色: ${labelJa(genes.colorScheme)}`,
    `構図: ${labelJa(genes.layout)}`,
    `文字入り: ${genes.hasTextOverlay ? "あり" : "なし"}`,
    `CTA: ${genes.hasCta ? "あり" : "なし"}`,
    `言語: ${labelJa(genes.language)}`,
  ].join(" / ");
}

export function renderGenesVocabularyForPrompt(): string {
  return [
    "CreativeGenes vocabulary (return as field `genes`):",
    "schemaVersion: 1",
    `appealAxes: ${renderVocabulary(APPEAL_AXES)} (choose 1-3)`,
    `tone: ${renderVocabulary(TONES)}`,
    `subjectType: ${renderVocabulary(SUBJECT_TYPES)}`,
    `colorScheme: ${renderVocabulary(COLOR_SCHEMES)}`,
    `layout: ${renderVocabulary(LAYOUTS)}`,
    "hasTextOverlay: boolean",
    "hasCta: boolean",
    `language: ${renderVocabulary(LANGUAGES)}`,
  ].join("\n");
}

function renderVocabulary(values: readonly string[]): string {
  return values.join(" | ");
}

function labelJa(value: string): string {
  return GENE_LABELS_JA[value] ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
