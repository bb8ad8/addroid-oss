import type { CreativePreviewCard, CreativePreviewProps } from "./CreativePreview";
import { ctaLabel } from "./FeedFrame";

export function CarouselFrame({
  accountName,
  primaryText,
  cta,
  cards,
}: CreativePreviewProps & { cards: CreativePreviewCard[] }) {
  return (
    <div className="placement-frame placement-carousel" data-testid="creative-preview-carousel">
      <div className="placement-feed__header">
        <div className="placement-feed__avatar" aria-hidden="true" />
        <div>
          <div className="placement-feed__account">{accountName || "AdDroid"}</div>
          <div className="placement-feed__sponsored">広告</div>
        </div>
      </div>
      <div className="placement-feed__copy">{primaryText || "(本文未設定)"}</div>
      <div className="placement-carousel__rail">
        {cards.length === 0 ? (
          <div className="placement-carousel__empty">カルーセルカード未設定</div>
        ) : (
          cards.map((card) => <CarouselCard key={card.position} card={card} cta={cta} />)
        )}
      </div>
    </div>
  );
}

function CarouselCard({ card, cta }: { card: CreativePreviewCard; cta?: string | null }) {
  return (
    <article className="placement-carousel__card">
      <div className="placement-carousel__media">
        {card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.imageUrl} alt="" width={card.width ?? 1080} height={card.height ?? 1080} />
        ) : (
          <div className="placement-preview__placeholder">画像未取得</div>
        )}
      </div>
      <div className="placement-carousel__body">
        <div className="placement-carousel__headline">{card.headline || "(見出し未設定)"}</div>
        <div className="placement-carousel__description">
          {card.description || "(説明未設定)"}
        </div>
        <span className="placement-feed__cta">{ctaLabel(cta)}</span>
      </div>
    </article>
  );
}
