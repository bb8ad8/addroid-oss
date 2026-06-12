import test from "node:test";
import assert from "node:assert/strict";
import {
  describeGenesForPrompt,
  parseCreativeGenes,
  renderGenesVocabularyForPrompt,
  type CreativeGenes,
} from "../index.js";

const VALID_GENES: CreativeGenes = {
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

test("parseCreativeGenes accepts valid closed vocabulary genes", () => {
  assert.deepEqual(parseCreativeGenes(VALID_GENES), VALID_GENES);
});

test("parseCreativeGenes rejects vocabulary values outside the closed set", () => {
  assert.equal(
    parseCreativeGenes({ ...VALID_GENES, tone: "friendly" }),
    null
  );
  assert.equal(
    parseCreativeGenes({ ...VALID_GENES, appealAxes: ["price", "discount"] }),
    null
  );
});

test("parseCreativeGenes rejects empty or too many appeal axes", () => {
  assert.equal(parseCreativeGenes({ ...VALID_GENES, appealAxes: [] }), null);
  assert.equal(
    parseCreativeGenes({
      ...VALID_GENES,
      appealAxes: ["price", "authority", "urgency", "benefit"],
    }),
    null
  );
});

test("parseCreativeGenes rejects schemaVersion mismatch and partial objects", () => {
  assert.equal(parseCreativeGenes({ ...VALID_GENES, schemaVersion: 2 }), null);
  const partial: Record<string, unknown> = { ...VALID_GENES };
  delete partial.layout;
  assert.equal(parseCreativeGenes(partial), null);
});

test("describeGenesForPrompt renders a fixed Japanese summary line", () => {
  assert.equal(
    describeGenesForPrompt(VALID_GENES),
    "訴求軸: 価格+緊急性 / トーン: カジュアル / 被写体: 商品 / 配色: 明るい / 構図: 単一焦点 / 文字入り: あり / CTA: あり / 言語: 日本語"
  );
});

test("renderGenesVocabularyForPrompt renders a fixed vocabulary block", () => {
  assert.equal(
    renderGenesVocabularyForPrompt(),
    [
      "CreativeGenes vocabulary (return as field `genes`):",
      "schemaVersion: 1",
      "appealAxes: price | authority | urgency | social_proof | benefit | feature | emotion | curiosity (choose 1-3)",
      "tone: formal | casual | energetic | calm | premium | playful",
      "subjectType: product | person | lifestyle | text_only | illustration | abstract",
      "colorScheme: bright | dark | monochrome | pastel | vivid | brand_palette",
      "layout: single_focus | split | grid | text_heavy | minimal",
      "hasTextOverlay: boolean",
      "hasCta: boolean",
      "language: ja | en | other",
    ].join("\n")
  );
});
