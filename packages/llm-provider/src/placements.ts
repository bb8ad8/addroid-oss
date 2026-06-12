import type { ImageVariationCondition } from "./image-provider.js";
import type { ImagePromptVariant } from "./agents.js";

export const PLACEMENT_PRESETS = [
  {
    key: "feed_square",
    label: "フィード (正方形)",
    aspectRatio: "1:1",
    width: 1080,
    height: 1080,
  },
  {
    key: "feed_vertical",
    label: "フィード (縦長)",
    aspectRatio: "4:5",
    width: 1080,
    height: 1350,
  },
  {
    key: "stories_reels",
    label: "ストーリーズ/リール",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
  },
  {
    key: "link_landscape",
    label: "リンク広告 (横長)",
    aspectRatio: "1.91:1",
    width: 1200,
    height: 628,
  },
] as const;

export type PlacementKey = (typeof PLACEMENT_PRESETS)[number]["key"];

export const DEFAULT_PLACEMENT_SET: PlacementKey[] = [
  "feed_square",
  "stories_reels",
];

export interface PlacementExpansionPlan {
  baseVariantKey: string;
  expansions: Array<{
    placementKey: PlacementKey;
    variantKey: string;
    condition: ImageVariationCondition;
  }>;
}

export function buildPlacementExpansionPlan(
  baseVariant: ImagePromptVariant,
  placements: readonly PlacementKey[]
): PlacementExpansionPlan {
  const baseVariantKey = sanitizeBaseVariantKey(baseVariant.variantKey ?? "variant-0");
  const expansions = placements.map((placementKey) => {
    const preset = placementPresetByKey(placementKey);
    const variantKey = `${baseVariantKey}--${preset.key}`;
    return {
      placementKey: preset.key,
      variantKey,
      condition: {
        width: preset.width,
        height: preset.height,
        format: baseVariant.format ?? "png",
        ...(baseVariant.styleNotes ? { styleNotes: baseVariant.styleNotes } : {}),
        ...(baseVariant.negativePrompt
          ? { negativePrompt: baseVariant.negativePrompt }
          : {}),
        variantKey,
      },
    };
  });
  return { baseVariantKey, expansions };
}

export function placementPresetByKey(key: PlacementKey) {
  const preset = PLACEMENT_PRESETS.find((p) => p.key === key);
  if (!preset) {
    throw new Error(`Unknown placement key: ${key}`);
  }
  return preset;
}

function sanitizeBaseVariantKey(raw: string): string {
  const sanitized = raw.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "variant-0";
}
