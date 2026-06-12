import type { CreativePreviewAsset, CreativePreviewProps } from "./CreativePreview";

export function FeedFrame({
  accountName,
  headline,
  primaryText,
  description,
  cta,
  asset,
}: CreativePreviewProps & { asset: CreativePreviewAsset | null }) {
  return (
    <div className="placement-frame placement-feed" data-testid="creative-preview-feed">
      <div className="placement-feed__header">
        <div className="placement-feed__avatar" aria-hidden="true" />
        <div>
          <div className="placement-feed__account">{accountName || "AdDroid"}</div>
          <div className="placement-feed__sponsored">広告</div>
        </div>
      </div>
      <div className="placement-feed__copy">
        {primaryText || "(本文未設定)"}
        <span className="placement-feed__more">もっと見る</span>
      </div>
      <div className="placement-feed__media">
        {asset ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.imageUrl} alt="" width={asset.width} height={asset.height} />
        ) : (
          <div className="placement-preview__placeholder">画像未取得</div>
        )}
      </div>
      <div className="placement-feed__link">
        <div>
          <div className="placement-feed__headline">{headline || "(見出し未設定)"}</div>
          <div className="placement-feed__description">{description || "(説明未設定)"}</div>
        </div>
        <span className="placement-feed__cta">{ctaLabel(cta)}</span>
      </div>
    </div>
  );
}

export function ctaLabel(value?: string | null): string {
  switch (value) {
    case "SHOP_NOW":
      return "購入する";
    case "SIGN_UP":
      return "登録する";
    case "CONTACT_US":
      return "問い合わせ";
    case "DOWNLOAD":
      return "ダウンロード";
    case "APPLY_NOW":
      return "申し込む";
    case "GET_QUOTE":
      return "見積もり";
    case "SUBSCRIBE":
      return "購読する";
    case "NO_BUTTON":
      return "";
    case "LEARN_MORE":
    default:
      return "詳しく見る";
  }
}
