import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlacementExpansionPlan,
  DEFAULT_ASPECT_RATIO_DIMENSIONS,
} from "../index.js";

const SQUARE = DEFAULT_ASPECT_RATIO_DIMENSIONS["1:1"]!;
const VERTICAL = DEFAULT_ASPECT_RATIO_DIMENSIONS["4:5"]!;
const STORIES = DEFAULT_ASPECT_RATIO_DIMENSIONS["9:16"]!;
const LANDSCAPE = DEFAULT_ASPECT_RATIO_DIMENSIONS["1.91:1"]!;

test("buildPlacementExpansionPlan expands variant keys and dimensions", () => {
  const plan = buildPlacementExpansionPlan(
    {
      variantKey: "concept-a",
      prompt: "p",
      negativePrompt: "n",
      styleNotes: "keep subject centered",
    },
    ["feed_square", "feed_vertical", "stories_reels", "link_landscape"]
  );

  assert.equal(plan.baseVariantKey, "concept-a");
  assert.deepEqual(
    plan.expansions.map((e) => e.variantKey),
    [
      "concept-a--feed_square",
      "concept-a--feed_vertical",
      "concept-a--stories_reels",
      "concept-a--link_landscape",
    ]
  );
  assert.deepEqual(plan.expansions.map((e) => [e.condition.width, e.condition.height]), [
    [SQUARE.width, SQUARE.height],
    [VERTICAL.width, VERTICAL.height],
    [STORIES.width, STORIES.height],
    [LANDSCAPE.width, LANDSCAPE.height],
  ]);
});

test("buildPlacementExpansionPlan handles empty placements", () => {
  const plan = buildPlacementExpansionPlan(
    { prompt: "p", negativePrompt: "n", styleNotes: "s" },
    []
  );

  assert.equal(plan.baseVariantKey, "variant-0");
  assert.deepEqual(plan.expansions, []);
});
