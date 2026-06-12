import type { CreativePreviewProps } from "../components/creative-preview/CreativePreview";
import {
  parseCreativeSpec,
  readCreativeMetadataByRef,
  type CreativeMetadataDocument,
} from "./creative-helpers";

export interface CreativePreviewSourceRow {
  id: string;
  displayName: string;
  mediaType: string;
  spec: unknown;
  storageRef: string | null;
  account?: {
    key: string;
    displayName: string;
  } | null;
}

export async function buildCreativePreviewProps(
  row: CreativePreviewSourceRow,
): Promise<CreativePreviewProps> {
  const metadata = row.storageRef
    ? await readCreativeMetadataByRef(row.storageRef)
    : null;
  return buildCreativePreviewPropsFromMetadata(row, metadata);
}

export function buildCreativePreviewPropsFromMetadata(
  row: CreativePreviewSourceRow,
  metadata: CreativeMetadataDocument | null,
): CreativePreviewProps {
  const spec = parseCreativeSpec(row.spec);
  const adText = spec.adText;
  const assets =
    metadata?.assets.map((asset) => ({
      assetId: asset.assetId,
      variantKey: asset.variantKey,
      imageUrl: `/api/creatives/${row.id}/asset/${asset.assetId}`,
      width: asset.width,
      height: asset.height,
    })) ?? [];
  const cards =
    spec.carousel?.cards.map((card) => {
      const asset = metadata?.assets.find(
        (candidate) => candidate.variantKey === card.assetVariantKey,
      );
      return {
        position: card.position,
        headline: card.headline,
        description: card.description,
        linkUrl: card.linkUrl,
        ...(asset
          ? {
              imageUrl: `/api/creatives/${row.id}/asset/${asset.assetId}`,
              width: asset.width,
              height: asset.height,
            }
          : {}),
      };
    }) ?? [];
  return {
    accountName: row.account?.displayName || row.account?.key || "AdDroid",
    mediaType: row.mediaType,
    headline: adText?.headline ?? null,
    primaryText: adText?.primaryText ?? null,
    description: adText?.description ?? null,
    cta: adText?.callToAction ?? null,
    assets,
    cards,
  };
}
