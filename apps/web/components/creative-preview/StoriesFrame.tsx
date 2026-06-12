import type { CreativePreviewAsset, CreativePreviewProps } from "./CreativePreview";
import { ctaLabel } from "./FeedFrame";

export function StoriesFrame({
  accountName,
  headline,
  primaryText,
  cta,
  asset,
  dedicatedAsset,
}: CreativePreviewProps & {
  asset: CreativePreviewAsset | null;
  dedicatedAsset: boolean;
}) {
  const crop = cropDirection(asset);
  return (
    <div className="placement-frame placement-stories" data-testid="creative-preview-stories">
      <div className="placement-stories__progress" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      {asset ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="placement-stories__image"
          src={asset.imageUrl}
          alt=""
          width={asset.width}
          height={asset.height}
        />
      ) : (
        <div className="placement-preview__placeholder placement-preview__placeholder--dark">
          画像未取得
        </div>
      )}
      {asset && crop !== "none" ? (
        <div className={`placement-stories__crop placement-stories__crop--${crop}`}>
          <span>この範囲は表示されません</span>
          <span>この範囲は表示されません</span>
        </div>
      ) : null}
      <div className="placement-stories__top">
        <div className="placement-stories__avatar" aria-hidden="true" />
        <span>{accountName || "AdDroid"}</span>
        <span>広告</span>
      </div>
      <div className="placement-stories__bottom">
        <div>
          <div className="placement-stories__headline">{headline || "(見出し未設定)"}</div>
          <div className="placement-stories__copy">{primaryText || "(本文未設定)"}</div>
        </div>
        <div className="placement-stories__cta">↑ {ctaLabel(cta)}</div>
        {!dedicatedAsset ? (
          <div className="placement-stories__note">Stories 専用サイズ未生成</div>
        ) : null}
      </div>
    </div>
  );
}

function cropDirection(asset: CreativePreviewAsset | null): "none" | "horizontal" | "vertical" {
  if (!asset || asset.width <= 0 || asset.height <= 0) return "none";
  const ratio = asset.width / asset.height;
  const storiesRatio = 9 / 16;
  const diff = Math.abs(ratio - storiesRatio);
  if (diff < 0.03) return "none";
  return ratio > storiesRatio ? "horizontal" : "vertical";
}
