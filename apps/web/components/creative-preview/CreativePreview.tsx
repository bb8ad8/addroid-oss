"use client";

import { useMemo, useState } from "react";
import { FeedFrame } from "./FeedFrame";
import { StoriesFrame } from "./StoriesFrame";
import { CarouselFrame } from "./CarouselFrame";

export interface CreativePreviewAsset {
  assetId: string;
  variantKey: string;
  imageUrl: string;
  width: number;
  height: number;
}

export interface CreativePreviewCard {
  position: number;
  headline: string;
  description?: string | null;
  linkUrl?: string | null;
  imageUrl?: string;
  width?: number;
  height?: number;
}

export interface CreativePreviewProps {
  accountName: string;
  mediaType: string;
  headline?: string | null;
  primaryText?: string | null;
  description?: string | null;
  cta?: string | null;
  assets: CreativePreviewAsset[];
  cards?: CreativePreviewCard[];
}

type Placement = "feed" | "stories" | "carousel";

const FEED_RATIO = 1;
const STORIES_RATIO = 9 / 16;

export function CreativePreview(props: CreativePreviewProps) {
  const placements = useMemo<Placement[]>(() => {
    const out: Placement[] = ["feed", "stories"];
    if (props.mediaType === "carousel" || (props.cards?.length ?? 0) > 0) {
      out.push("carousel");
    }
    return out;
  }, [props.cards?.length, props.mediaType]);
  const [placement, setPlacement] = useState<Placement>(placements[0] ?? "feed");
  const active = placements.includes(placement) ? placement : placements[0] ?? "feed";
  const feedAsset = selectAsset(props.assets, FEED_RATIO);
  const storiesAsset = selectAsset(props.assets, STORIES_RATIO);
  const storiesDedicated = storiesAsset
    ? Math.abs(assetRatio(storiesAsset) - STORIES_RATIO) < 0.03
    : false;
  return (
    <div className="creative-preview" data-testid="creative-preview">
      <div className="creative-preview__tabs" role="tablist" aria-label="配信面プレビュー">
        {placements.map((item) => (
          <button
            key={item}
            type="button"
            className="creative-preview__tab"
            role="tab"
            aria-selected={active === item}
            data-active={active === item}
            onClick={() => setPlacement(item)}
          >
            {placementLabel(item)}
          </button>
        ))}
      </div>
      <div className="creative-preview__stage">
        {active === "feed" ? (
          <FeedFrame {...props} asset={feedAsset} />
        ) : active === "stories" ? (
          <StoriesFrame {...props} asset={storiesAsset} dedicatedAsset={storiesDedicated} />
        ) : (
          <CarouselFrame {...props} cards={props.cards ?? []} />
        )}
      </div>
    </div>
  );
}

function placementLabel(placement: Placement): string {
  if (placement === "stories") return "Stories";
  if (placement === "carousel") return "Carousel";
  return "Feed";
}

function selectAsset(
  assets: readonly CreativePreviewAsset[],
  targetRatio: number,
): CreativePreviewAsset | null {
  if (assets.length === 0) return null;
  return [...assets].sort(
    (a, b) => Math.abs(assetRatio(a) - targetRatio) - Math.abs(assetRatio(b) - targetRatio),
  )[0] ?? null;
}

function assetRatio(asset: CreativePreviewAsset): number {
  return asset.height > 0 ? asset.width / asset.height : 1;
}
