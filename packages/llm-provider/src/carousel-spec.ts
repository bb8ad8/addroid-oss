export type CarouselCardRole =
  | "hook"
  | "feature"
  | "social_proof"
  | "offer"
  | "cta";

export interface CarouselCreativeSpec {
  schemaVersion: 1;
  storyArc: string;
  cards: Array<{
    position: number;
    role: CarouselCardRole;
    headline: string;
    description: string | null;
    linkUrl: string | null;
    assetVariantKey: string;
  }>;
}

export interface CarouselCreativeSpecValidation {
  ok: boolean;
  reasons: string[];
}

const VALID_ROLES: ReadonlySet<string> = new Set([
  "hook",
  "feature",
  "social_proof",
  "offer",
  "cta",
]);

export function parseCarouselCreativeSpec(
  value: unknown,
): CarouselCreativeSpec | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (
    typeof value.storyArc !== "string" ||
    value.storyArc.trim().length === 0
  ) {
    return null;
  }
  if (!Array.isArray(value.cards)) return null;
  const cards = value.cards.map((card) => {
    if (!isRecord(card)) return null;
    if (!Number.isInteger(card.position)) return null;
    if (typeof card.role !== "string" || !VALID_ROLES.has(card.role))
      return null;
    if (typeof card.headline !== "string") return null;
    if (card.description !== null && typeof card.description !== "string")
      return null;
    if (
      card.linkUrl !== null &&
      card.linkUrl !== undefined &&
      typeof card.linkUrl !== "string"
    ) {
      return null;
    }
    if (
      typeof card.assetVariantKey !== "string" ||
      card.assetVariantKey.length === 0
    ) {
      return null;
    }
    return {
      position: card.position,
      role: card.role as CarouselCardRole,
      headline: card.headline,
      description: card.description,
      linkUrl: typeof card.linkUrl === "string" ? card.linkUrl : null,
      assetVariantKey: card.assetVariantKey,
    };
  });
  if (cards.some((card) => card === null)) return null;
  const spec: CarouselCreativeSpec = {
    schemaVersion: 1,
    storyArc: value.storyArc,
    cards: cards as CarouselCreativeSpec["cards"],
  };
  return validateCarouselCreativeSpec(spec).ok ? spec : null;
}

export function validateCarouselCreativeSpec(
  spec: CarouselCreativeSpec,
  options?: { assetVariantKeys?: readonly string[] },
): CarouselCreativeSpecValidation {
  const reasons: string[] = [];
  if (spec.schemaVersion !== 1) reasons.push("schemaVersion must be 1");
  if (typeof spec.storyArc !== "string" || spec.storyArc.trim().length === 0) {
    reasons.push("storyArc is required");
  }
  if (!Array.isArray(spec.cards)) {
    reasons.push("cards must be an array");
  } else {
    if (spec.cards.length < 2 || spec.cards.length > 10) {
      reasons.push("card count must be between 2 and 10");
    }
    const positions = new Set<number>();
    for (const card of spec.cards) {
      if (!Number.isInteger(card.position) || card.position <= 0) {
        reasons.push(
          `card position '${String(card.position)}' must be a positive integer`,
        );
      }
      if (positions.has(card.position)) {
        reasons.push(`duplicate card position ${card.position}`);
      }
      positions.add(card.position);
      if (!VALID_ROLES.has(card.role))
        reasons.push(`invalid role at card ${card.position}`);
      if (typeof card.headline !== "string" || card.headline.length === 0) {
        reasons.push(`headline is required at card ${card.position}`);
      } else if (card.headline.length > 40) {
        reasons.push(`headline exceeds 40 chars at card ${card.position}`);
      }
      if (card.description !== null && typeof card.description !== "string") {
        reasons.push(
          `description must be string or null at card ${card.position}`,
        );
      }
      if (card.linkUrl !== null && typeof card.linkUrl !== "string") {
        reasons.push(`linkUrl must be string or null at card ${card.position}`);
      }
      if (
        typeof card.assetVariantKey !== "string" ||
        card.assetVariantKey.length === 0
      ) {
        reasons.push(`assetVariantKey is required at card ${card.position}`);
      }
    }
    const sorted = [...positions].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) {
        reasons.push("card positions must be consecutive starting at 1");
        break;
      }
    }
  }
  if (options?.assetVariantKeys) {
    const keys = new Set(options.assetVariantKeys);
    for (const card of spec.cards) {
      if (!keys.has(card.assetVariantKey)) {
        reasons.push(
          `assetVariantKey '${card.assetVariantKey}' is missing for card ${card.position}`,
        );
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
