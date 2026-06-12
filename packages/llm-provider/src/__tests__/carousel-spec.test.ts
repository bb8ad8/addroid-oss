import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCarouselCreativeSpec,
  validateCarouselCreativeSpec,
  type CarouselCreativeSpec,
} from "../index.js";

const baseSpec: CarouselCreativeSpec = {
  schemaVersion: 1,
  storyArc: "Hook, proof, CTA",
  cards: [
    {
      position: 1,
      role: "hook",
      headline: "課題に気づく",
      description: "最初の一歩",
      linkUrl: null,
      assetVariantKey: "card-1",
    },
    {
      position: 2,
      role: "cta",
      headline: "今すぐ確認",
      description: null,
      linkUrl: "https://example.com",
      assetVariantKey: "card-2",
    },
  ],
};

test("carousel spec: accepts valid 2-card boundary and asset keys", () => {
  const parsed = parseCarouselCreativeSpec(baseSpec);
  assert.ok(parsed);
  const validation = validateCarouselCreativeSpec(baseSpec, {
    assetVariantKeys: ["card-1", "card-2"],
  });
  assert.equal(validation.ok, true);
});

test("carousel spec: rejects duplicate positions", () => {
  const validation = validateCarouselCreativeSpec({
    ...baseSpec,
    cards: [baseSpec.cards[0]!, { ...baseSpec.cards[1]!, position: 1 }],
  });
  assert.equal(validation.ok, false);
  assert.match(validation.reasons.join("\n"), /duplicate card position 1/);
});

test("carousel spec: headline 40 chars is allowed but 41 chars is rejected", () => {
  const forty = "あ".repeat(40);
  const fortyOne = "あ".repeat(41);
  assert.equal(
    validateCarouselCreativeSpec({
      ...baseSpec,
      cards: [{ ...baseSpec.cards[0]!, headline: forty }, baseSpec.cards[1]!],
    }).ok,
    true,
  );
  const rejected = validateCarouselCreativeSpec({
    ...baseSpec,
    cards: [{ ...baseSpec.cards[0]!, headline: fortyOne }, baseSpec.cards[1]!],
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reasons.join("\n"), /headline exceeds 40 chars/);
});

test("carousel spec: rejects missing persisted asset variant", () => {
  const validation = validateCarouselCreativeSpec(baseSpec, {
    assetVariantKeys: ["card-1"],
  });
  assert.equal(validation.ok, false);
  assert.match(validation.reasons.join("\n"), /card-2/);
});
