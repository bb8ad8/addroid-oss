// AdDroid OSS — /creatives/[id] ページ (this implementation).
//
// 単一 creative の詳細。プレビュー + 全 metadata + QA per-check breakdown +
// 関連 PR / improvement_run / ai_run / audit_logs を表示する。
//
// 設計:
//   - 画像バイナリは /api/creatives/[id]/asset/[assetId] proxy 経由でのみ表示する
//     (UI design plan principle 23)。
//   - storage://* ref は mono inline-code 表示。絶対 fs path は出さない (principle 24)。
//   - QA per-check (dimensions / format / quality / forbidden_expression /
//     brand_tone) を **必ず展開表示** する (principle 25 / creative_copy_rules)。
//   - 再生成 / 編集 / Meta 直接反映ボタンは置かない (principle 30)。
//   - metadata.json が読めない (storage 未到達) 場合は creatives テーブル単独の
//     情報を表示するフォールバックに倒す (principle 23)。

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  GENE_LABELS_JA,
  parseCreativeGenes,
  type CreativeGenes,
} from "@addroid/llm-provider";
import { prisma } from "../../../lib/prisma";
import { Panel } from "../../../components/ui/Panel";
import { PageHeader } from "../../../components/ui/PageHeader";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StatusDot } from "../../../components/ui/StatusDot";
import { InlineCode, CodeBlock } from "../../../components/ui/CodeBlock";
import {
  KeyValueList,
  type KeyValueEntry,
} from "../../../components/ui/KeyValueList";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { Pagination } from "../../../components/ui/Pagination";
import {
  creativeStatusToState,
  formatBytes,
  formatDimensions,
  formatTimestamp,
  parseCreativeParameters,
  parseCreativeSpec,
  qaOutcomeToState,
  qaOverallToState,
  readCreativeMetadataByRef,
  type CreativeSpecAdText,
  type CreativeMetadataAsset,
  type CreativeMetadataDocument,
  type CreativeMetadataQaAsset,
  type CreativeMetadataQaCheck,
} from "../../../lib/creative-helpers";
import {
  ensureWebWorkspace,
  sanitizeForDisplay,
} from "../../../lib/meta-runtime";
import { getPaginationState, paginationLabel } from "../../../lib/pagination";
import { DashboardChatPanel } from "../../DashboardChatPanel";
import { CreativePreview } from "../../../components/creative-preview/CreativePreview";
import { buildCreativePreviewPropsFromMetadata } from "../../../lib/creative-preview-data";

export const dynamic = "force-dynamic";

const CREATIVE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export default async function CreativeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ auditPage?: string | string[] }>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  if (!CREATIVE_ID_PATTERN.test(id)) {
    notFound();
  }

  let row;
  let workspaceId: string | null = null;
  try {
    const workspace = await ensureWebWorkspace();
    workspaceId = workspace.id;
    row = await prisma.creative.findFirst({
      where: { id, account: { workspaceId: workspace.id } },
      select: {
        id: true,
        accountId: true,
        hierarchyId: true,
        aiRunId: true,
        creativeQaAiRunId: true,
        pullRequestId: true,
        key: true,
        displayName: true,
        mediaType: true,
        status: true,
        prompt: true,
        provider: true,
        model: true,
        parameters: true,
        genes: true,
        storagePath: true,
        storageRef: true,
        externalId: true,
        spec: true,
        createdAt: true,
        updatedAt: true,
        account: {
          select: {
            id: true,
            key: true,
            displayName: true,
            metaAccountId: true,
          },
        },
        hierarchy: {
          select: {
            id: true,
            nodeType: true,
            displayName: true,
            externalId: true,
          },
        },
        aiRun: {
          select: {
            id: true,
            agent: true,
            workflow: true,
            provider: true,
            model: true,
            status: true,
            decision: true,
            confidence: true,
            inputTokens: true,
            outputTokens: true,
            createdAt: true,
          },
        },
        creativeQa: {
          select: {
            id: true,
            agent: true,
            workflow: true,
            provider: true,
            model: true,
            status: true,
            decision: true,
            confidence: true,
            inputTokens: true,
            outputTokens: true,
            createdAt: true,
          },
        },
        pullRequest: {
          select: {
            id: true,
            number: true,
            title: true,
            state: true,
            htmlUrl: true,
            mergedAt: true,
            createdAt: true,
          },
        },
      },
    });
  } catch {
    return (
      <>
        <PageHeader title="Creative" />
        <div className="page-body page-body--single">
          <EmptyState
            title="creatives を読み出せません"
            description="Prisma スキーマが未反映の可能性があります。npm run db:push を実行してください。"
          />
        </div>
      </>
    );
  }

  if (!row) {
    notFound();
  }

  const metadata: CreativeMetadataDocument | null = row.storageRef
    ? await readCreativeMetadataByRef(row.storageRef)
    : null;
  const placementPreview = buildCreativePreviewPropsFromMetadata(row, metadata);

  // 関連 audit_logs (target = "creative:<id>") を引く。
  let auditRows: Array<{
    id: string;
    actor: string;
    action: string;
    target: string | null;
    ref: string | null;
    metadata: unknown;
    createdAt: Date;
  }> = [];
  let auditTotal = 0;
  try {
    const auditWhere = {
      ...(workspaceId ? { workspaceId } : {}),
      target: `creative:${row.id}`,
    };
    auditTotal = await prisma.auditLog.count({ where: auditWhere });
    const auditPagination = getPaginationState(
      resolvedSearchParams,
      "auditPage",
      auditTotal,
    );
    auditRows = await prisma.auditLog.findMany({
      where: auditWhere,
      orderBy: { createdAt: "desc" },
      skip: auditPagination.skip,
      take: auditPagination.take,
      select: {
        id: true,
        actor: true,
        action: true,
        target: true,
        ref: true,
        metadata: true,
        createdAt: true,
      },
    });
  } catch {
    /* noop — audit が無くても detail は描画する */
  }

  const spec = parseCreativeSpec(row.spec);
  const genes =
    parseCreativeGenes(row.genes) ?? spec.genes ?? metadata?.genes ?? null;
  const params2 = parseCreativeParameters(row.parameters);
  const statusState = creativeStatusToState(row.status);
  const overallQa = metadata?.qa.overall ?? null;
  const hasStorage = Boolean(row.storageRef);
  const storageReachable = metadata !== null;
  const auditPagination = getPaginationState(
    resolvedSearchParams,
    "auditPage",
    auditTotal,
  );

  const overviewItems: KeyValueEntry[] = [
    {
      label: "Creative ID",
      value: <InlineCode>{row.id}</InlineCode>,
      mono: true,
    },
    { label: "Key", value: <InlineCode>{row.key}</InlineCode>, mono: true },
    { label: "Display name", value: <span>{row.displayName}</span> },
    {
      label: "Status",
      value: <StatusBadge state={statusState}>{row.status}</StatusBadge>,
    },
    {
      label: "Media type",
      value: <InlineCode>{row.mediaType}</InlineCode>,
      mono: true,
    },
    {
      label: "Account",
      value: row.account ? (
        <span>
          <InlineCode>{row.account.key}</InlineCode> — {row.account.displayName}
          {row.account.metaAccountId ? (
            <>
              {" "}
              <span style={{ color: "var(--color-text-secondary)" }}>
                (<InlineCode>{row.account.metaAccountId}</InlineCode>)
              </span>
            </>
          ) : null}
        </span>
      ) : (
        <span>—</span>
      ),
    },
    {
      label: "Hierarchy node",
      value: row.hierarchy ? (
        <span>
          <InlineCode>{row.hierarchy.nodeType}</InlineCode> ·{" "}
          {row.hierarchy.displayName}
          {row.hierarchy.externalId ? (
            <>
              {" "}
              <InlineCode>{row.hierarchy.externalId}</InlineCode>
            </>
          ) : null}
        </span>
      ) : (
        <span>—</span>
      ),
    },
    {
      label: "Provider / model",
      value:
        row.provider && row.model ? (
          <InlineCode>
            {row.provider}/{row.model}
          </InlineCode>
        ) : (
          <span style={{ color: "var(--color-text-secondary)" }}>
            画像 Provider 未設定 (任意) — prompt-only
          </span>
        ),
    },
    {
      label: "Storage ref",
      value: row.storageRef ? (
        <InlineCode>{row.storageRef}</InlineCode>
      ) : (
        <span style={{ color: "var(--color-text-secondary)" }}>
          未保存 (prompt-only fallback)
        </span>
      ),
      mono: true,
    },
    {
      label: "Created",
      value: (
        <span
          className="tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {formatTimestamp(row.createdAt)}
        </span>
      ),
    },
    {
      label: "Updated",
      value: (
        <span
          className="tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {formatTimestamp(row.updatedAt)}
        </span>
      ),
    },
    {
      label: "External ID (Meta)",
      value: row.externalId ? (
        <InlineCode>{row.externalId}</InlineCode>
      ) : (
        <span style={{ color: "var(--color-text-secondary)" }}>
          まだ Meta には反映されていません
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={
          <span>
            Creative ·{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {row.id.slice(0, 12)}…
            </span>
          </span>
        }
        subtitle={
          <>
            <Link href="/creatives" style={{ color: "var(--color-accent)" }}>
              ← 一覧に戻る
            </Link>
            {"  ·  "}
            生成画像は PR を経由してのみ Meta に反映されます。本ページからは
            Meta への直接反映 / 再生成は行えません (再生成は{" "}
            <InlineCode>/improvements</InlineCode> から{" "}
            <InlineCode>auto_creative_generation</InlineCode> を起動)。
          </>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="配信面プレビュー"
          subtitle="Feed / Stories 上での見え方をHTMLフレームで確認します"
          status={
            <StatusDot state={placementPreview.assets.length > 0 ? "ok" : "idle"}>
              {placementPreview.assets.length > 0
                ? `${placementPreview.assets.length} asset`
                : "画像なし"}
            </StatusDot>
          }
        >
          <CreativePreview {...placementPreview} />
        </Panel>

        <Panel
          title="Preview"
          subtitle={
            !hasStorage
              ? "prompt-only fallback — 画像 Provider 未設定 / 失敗のため画像はありません"
              : !storageReachable
                ? "storage 未到達 — metadata.json が見つかりません"
                : `${metadata?.assets.length ?? 0} variant`
          }
          status={
            <StatusDot
              state={
                !hasStorage
                  ? "idle"
                  : !storageReachable
                    ? "warn"
                    : qaOverallToState(overallQa ?? "fallback_text_only")
              }
            >
              {!hasStorage
                ? "prompt-only"
                : !storageReachable
                  ? "storage 未到達"
                  : (overallQa ?? "—")}
            </StatusDot>
          }
        >
          {!hasStorage && spec.adText ? (
            <div className="creative-detail__previews">
              <CreativeAdPreview
                accountName={
                  row.account?.displayName || row.account?.key || "AdDroid"
                }
                displayName={row.displayName}
                adText={spec.adText}
                imageAlt={`creative ${row.displayName}`}
                imageStatusLabel="画像なし"
                selected
                caption={
                  <div className="creative-detail__preview-caption">
                    <div>
                      <StatusBadge state="idle">prompt-only</StatusBadge>
                    </div>
                    <div className="mono">
                      画像 Provider 未設定 / 失敗のため画像はありません
                    </div>
                  </div>
                }
              />
            </div>
          ) : !hasStorage ? (
            <EmptyState
              title="画像はありません (prompt-only fallback)"
              description={
                <>
                  画像 Provider 未設定 / 失敗のため、自動クリエイティブ生成は
                  テキストプロンプトのみで PR を作成しました。GitOps polling /
                  Apply / Cron は通常通り稼働しています。
                </>
              }
            />
          ) : !storageReachable && spec.adText ? (
            <div className="creative-detail__previews">
              <CreativeAdPreview
                accountName={
                  row.account?.displayName || row.account?.key || "AdDroid"
                }
                displayName={row.displayName}
                adText={spec.adText}
                imageAlt={`creative ${row.displayName}`}
                imageStatusLabel="画像未取得"
                selected
                caption={
                  <div className="creative-detail__preview-caption">
                    <div>
                      <StatusBadge state="warn">storage 未到達</StatusBadge>
                    </div>
                    <div className="mono" style={{ wordBreak: "break-all" }}>
                      <InlineCode>{row.storageRef ?? ""}</InlineCode>
                    </div>
                  </div>
                }
              />
            </div>
          ) : !storageReachable ? (
            <EmptyState
              title="storage 上に metadata.json が見つかりません"
              description={
                <>
                  storage ref: <InlineCode>{row.storageRef ?? ""}</InlineCode>
                  。Storage Adapter (LocalDisk) から metadata.json
                  を読み出せません。 生成バイナリが削除された /
                  別ホストで生成された可能性があります。
                </>
              }
            />
          ) : spec.carousel ? (
            <div className="creative-detail__carousel-strip">
              {spec.carousel.cards.map((card) => {
                const asset =
                  metadata!.assets.find(
                    (a) => a.variantKey === card.assetVariantKey,
                  ) ?? null;
                return (
                  <section
                    className="creative-detail__carousel-card"
                    key={card.position}
                  >
                    <div className="creative-detail__variant-group-header">
                      <InlineCode>card-{card.position}</InlineCode>
                      <StatusBadge
                        state={
                          asset ? qaOverallToState(asset.qaOverall) : "warn"
                        }
                      >
                        {card.role}
                      </StatusBadge>
                    </div>
                    <CreativeAdPreview
                      accountName={
                        row.account?.displayName ||
                        row.account?.key ||
                        "AdDroid"
                      }
                      displayName={row.displayName}
                      adText={carouselAdTextForCard(spec.adText, card)}
                      imageSrc={
                        asset
                          ? `/api/creatives/${row.id}/asset/${asset.assetId}`
                          : undefined
                      }
                      imageAlt={`creative ${row.displayName} carousel card ${card.position}`}
                      imageStatusLabel="画像未取得"
                      selected
                      caption={
                        asset ? (
                          <CreativeAssetCaption asset={asset} />
                        ) : (
                          <div className="creative-detail__preview-caption">
                            <StatusBadge state="warn">asset 未保存</StatusBadge>
                            <InlineCode>{card.assetVariantKey}</InlineCode>
                          </div>
                        )
                      }
                    />
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="creative-detail__previews">
              {groupAssetsByBaseVariant(metadata!.assets).map((group) => (
                <section
                  className="creative-detail__variant-group"
                  key={group.baseVariantKey}
                >
                  <div className="creative-detail__variant-group-header">
                    <InlineCode>{group.baseVariantKey}</InlineCode>
                    <span>{group.assets.length} size</span>
                  </div>
                  <div className="creative-detail__variant-group-grid">
                    {group.assets.map(({ asset, assetIndex }) => (
                      <CreativeAdPreview
                        key={asset.assetId}
                        accountName={
                          row.account?.displayName ||
                          row.account?.key ||
                          "AdDroid"
                        }
                        displayName={row.displayName}
                        adText={textForPreview(
                          spec.adText,
                          spec.textVariants,
                          assetIndex,
                        )}
                        imageSrc={`/api/creatives/${row.id}/asset/${asset.assetId}`}
                        imageAlt={`creative ${row.displayName} variant ${asset.variantKey}`}
                        selected
                        caption={<CreativeAssetCaption asset={asset} />}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="入稿PR"
          subtitle="この生成クリエイティブを GitOps PR にして、承認後にMetaへ反映"
        >
          {row.status === "qa_failed" ? (
            <EmptyState
              title="QA failed のためPR化できません"
              description="別variantを選ぶか、再生成してから入稿PRに回してください。"
            />
          ) : (
            <div className="creative-promotion-chat">
              {row.pullRequest ? (
                <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
                  前回の入稿PR: PR #{row.pullRequest.number}
                  {row.pullRequest.htmlUrl ? (
                    <>
                      {" "}
                      <a
                        href={row.pullRequest.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        GitHubで確認
                      </a>
                    </>
                  ) : null}
                  。同じCreativeを別キャンペーンや2回目の入稿に再利用できます。
                </p>
              ) : null}
              <DashboardChatPanel
                surface={`creative-detail:${row.id}`}
                title="入稿PRチャット"
                description="選択中のCreativeを使った入稿PR作成を会話で進めます。足りない配信先情報はエージェントが確認します。"
                emptyText="既存広告セットに入れる、新しい広告セットでテストする、新規キャンペーンから作る、などを入力してください。"
                badge="GitOps PR"
                examples={[
                  "このCreativeを既存広告セットに入稿PR化したい。足りない情報を確認して。",
                  "このCreativeを新規キャンペーンでテストしたい。目的はトラフィック、日予算は500円。",
                  "このCreativeを既存キャンペーン配下の新しい広告セットで入稿したい。",
                ]}
                placeholder="例: このCreativeを既存広告セットに入稿PR化したい"
                initialInput="このCreativeを入稿PRに回したい。足りない配信先情報を確認して。"
                contextPrefix={[
                  "この画面は /creatives/[id] の生成クリエイティブ詳細です。",
                  "このCreativeはユーザーが入稿対象として選択済みです。どのCreativeを使うかは質問せず、creativeId を指定して promote_creative_submission を使ってください。",
                  `creativeId=${row.id}`,
                  `displayName=${row.displayName}`,
                  `account=${row.account?.key ?? "unknown"} (${row.account?.displayName ?? "unknown"})`,
                  `status=${row.status}`,
                  `mediaType=${row.mediaType}`,
                  row.storagePath ? "hasMedia=true" : "hasMedia=false",
                  row.pullRequest
                    ? `previousSubmissionPr=${row.pullRequest.number}`
                    : "previousSubmissionPr=false",
                  spec.adText?.headline
                    ? `headline=${spec.adText.headline}`
                    : null,
                  spec.adText?.primaryText
                    ? `primaryText=${spec.adText.primaryText}`
                    : null,
                  spec.adText?.description
                    ? `description=${spec.adText.description}`
                    : null,
                  spec.adText?.callToAction
                    ? `callToAction=${spec.adText.callToAction}`
                    : null,
                  "このCreativeが過去の入稿PRに紐づいていても、別キャンペーンや2回目の入稿として再度PR化できます。",
                  "不足している placement、campaignId/adsetId、campaignName/adsetName、objective、予算、pageId、optimizationGoal、billingEvent、linkUrl、国ターゲティングはツール実行前に短く質問してください。",
                  "Meta へ直接変更せず、必ず GitOps PR と dry-run の経路を使ってください。",
                ]
                  .filter(Boolean)
                  .join("\n")}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Overview"
          subtitle="creatives テーブル + linkage"
          status={<StatusDot state={statusState}>{row.status}</StatusDot>}
        >
          <KeyValueList items={overviewItems} />
        </Panel>

        <Panel
          title="Creative genes"
          subtitle="creative_qa が付与した構造化タグ"
          status={
            <StatusDot state={genes ? "ok" : "idle"}>
              {genes ? "tagged" : "タグなし"}
            </StatusDot>
          }
        >
          {genes ? (
            <KeyValueList items={creativeGeneItems(genes)} />
          ) : (
            <EmptyState
              title="タグなし"
              description="既存クリエイティブ、または creative_qa のタグ推定が無効だったクリエイティブです。"
            />
          )}
        </Panel>

        <Panel
          title="Prompt"
          subtitle="image_prompt エージェントが生成したプロンプト本文 + 補足"
        >
          {spec.prompt || row.prompt || metadata?.prompt ? (
            <CodeBlock>
              {sanitizeForDisplay(
                spec.prompt ?? row.prompt ?? metadata?.prompt ?? "",
              )}
            </CodeBlock>
          ) : (
            <EmptyState
              title="プロンプトは記録されていません"
              description="creatives.spec.prompt にも metadata.json にもプロンプト本文がありません。"
            />
          )}
          {spec.negativePrompt ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.25rem",
                }}
              >
                Negative prompt
              </div>
              <CodeBlock>{sanitizeForDisplay(spec.negativePrompt)}</CodeBlock>
            </div>
          ) : null}
          {spec.styleNotes ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.25rem",
                }}
              >
                Style notes
              </div>
              <p style={{ margin: 0 }}>{spec.styleNotes}</p>
            </div>
          ) : null}
          {spec.rationale ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.25rem",
                }}
              >
                Rationale
              </div>
              <p style={{ margin: 0 }}>{spec.rationale}</p>
            </div>
          ) : null}
        </Panel>

        <Panel title="Ad text" subtitle="Meta広告の本文 / 見出し / 説明 / CTA">
          {spec.adText ? (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList
                items={[
                  {
                    label: `Primary text${spec.metaTextRecommendations?.primaryText ? ` (推奨 ${spec.metaTextRecommendations.primaryText}字以内)` : ""}`,
                    value: spec.adText.primaryText ? (
                      <span>{spec.adText.primaryText}</span>
                    ) : (
                      <span>—</span>
                    ),
                  },
                  {
                    label: `Headline${spec.metaTextRecommendations?.headline ? ` (推奨 ${spec.metaTextRecommendations.headline}字以内)` : ""}`,
                    value: spec.adText.headline ? (
                      <span>{spec.adText.headline}</span>
                    ) : (
                      <span>—</span>
                    ),
                  },
                  {
                    label: `Description${spec.metaTextRecommendations?.description ? ` (推奨 ${spec.metaTextRecommendations.description}字以内)` : ""}`,
                    value: spec.adText.description ? (
                      <span>{spec.adText.description}</span>
                    ) : (
                      <span>—</span>
                    ),
                  },
                  {
                    label: "CTA",
                    value: spec.adText.callToAction ? (
                      <InlineCode>{spec.adText.callToAction}</InlineCode>
                    ) : (
                      <span>—</span>
                    ),
                    mono: true,
                  },
                ]}
              />
              {spec.adText.rationale ? (
                <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>
                  {spec.adText.rationale}
                </p>
              ) : null}
              {spec.textVariants.length > 1 ? (
                <div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-text-secondary)",
                      marginBottom: "0.5rem",
                    }}
                  >
                    Other variants
                  </div>
                  <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                    {spec.textVariants.slice(0, 4).map((variant, i) => (
                      <li key={i} style={{ marginBottom: "0.5rem" }}>
                        <InlineCode>variant-{i}</InlineCode>{" "}
                        {variant.headline ? (
                          <strong>{variant.headline}</strong>
                        ) : null}
                        {variant.primaryText ? (
                          <span> — {variant.primaryText}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState
              title="広告テキスト案は記録されていません"
              description="古い生成結果、または画像プロンプトのみのクリエイティブです。"
            />
          )}
        </Panel>

        <Panel
          title="Generation parameters"
          subtitle="image_prompt 出力 + image-Provider 渡しパラメータ"
        >
          {params2.purpose || params2.variationConditions.length > 0 ? (
            <KeyValueList
              items={[
                {
                  label: "Purpose",
                  value: params2.purpose ? (
                    <span>{params2.purpose}</span>
                  ) : (
                    <span>—</span>
                  ),
                },
                {
                  label: "Variant count",
                  value: (
                    <span className="tabular-nums">
                      {metadata?.variantCount ??
                        params2.variationConditions.length}
                    </span>
                  ),
                },
                {
                  label: "Variation conditions",
                  value:
                    params2.variationConditions.length === 0 ? (
                      <span>—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                        {params2.variationConditions.map((c, i) => {
                          const dims = formatDimensions(
                            c.width ?? 0,
                            c.height ?? 0,
                          );
                          const fmt = c.format ?? "png";
                          const label = c.variantKey ?? `variant-${i + 1}`;
                          return (
                            <li key={i}>
                              <InlineCode>{label}</InlineCode>
                              <span className="tabular-nums">
                                {" "}
                                — {dims} {fmt}
                              </span>
                              {c.styleNotes ? (
                                <div
                                  style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.8125rem",
                                  }}
                                >
                                  style: {c.styleNotes}
                                </div>
                              ) : null}
                              {c.negativePrompt ? (
                                <div
                                  style={{
                                    color: "var(--color-text-secondary)",
                                    fontSize: "0.8125rem",
                                  }}
                                >
                                  negative: {c.negativePrompt}
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ),
                },
                ...(metadata
                  ? [
                      {
                        label: "Generated at",
                        value: (
                          <span
                            className="tabular-nums"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            {formatTimestamp(metadata.generatedAt)}
                          </span>
                        ),
                      },
                      {
                        label: "Provider request ID",
                        value: metadata.requestId ? (
                          <InlineCode>{metadata.requestId}</InlineCode>
                        ) : (
                          <span>—</span>
                        ),
                        mono: true,
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <EmptyState
              title="生成パラメータは記録されていません"
              description="creatives.parameters が空のため、画像 Provider に渡された variation conditions / purpose がありません (prompt-only fallback の典型)。"
            />
          )}
        </Panel>

        <Panel
          title="Creative QA"
          subtitle={
            metadata
              ? `dimensions / format / quality / forbidden_expression / brand_tone — overall: ${metadata.qa.overall}`
              : spec.qa
                ? "creatives.spec.qa の short summary"
                : "QA 結果は記録されていません"
          }
          status={
            <StatusDot
              state={
                metadata
                  ? qaOverallToState(metadata.qa.overall)
                  : spec.qa
                    ? "info"
                    : "idle"
              }
            >
              {metadata
                ? metadata.qa.overall
                : spec.qa
                  ? (spec.qa.recommendation ?? "summary")
                  : "no qa"}
            </StatusDot>
          }
        >
          {metadata && metadata.qa.assets.length > 0 ? (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList
                items={[
                  {
                    label: "Overall",
                    value: (
                      <StatusBadge
                        state={qaOverallToState(metadata.qa.overall)}
                      >
                        {metadata.qa.overall}
                      </StatusBadge>
                    ),
                  },
                  {
                    label: "Passing assets",
                    value: (
                      <span className="tabular-nums">
                        {metadata.qa.passingCount} / {metadata.qa.assets.length}
                      </span>
                    ),
                  },
                  {
                    label: "Failing assets",
                    value: (
                      <span className="tabular-nums">
                        {metadata.qa.failingCount}
                      </span>
                    ),
                  },
                ]}
              />
              {metadata.qa.assets.map((asset) => (
                <QaAssetBlock key={asset.variantKey} asset={asset} />
              ))}
            </div>
          ) : spec.qa ? (
            <KeyValueList
              items={[
                {
                  label: "Recommendation",
                  value: spec.qa.recommendation ? (
                    <InlineCode>{spec.qa.recommendation}</InlineCode>
                  ) : (
                    <span>—</span>
                  ),
                },
                {
                  label: "Issues",
                  value:
                    spec.qa.issues.length === 0 ? (
                      <span>—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                        {spec.qa.issues.map((issue, i) => (
                          <li key={i}>
                            <StatusBadge
                              state={
                                issue.severity === "blocking"
                                  ? "error"
                                  : issue.severity === "non_blocking"
                                    ? "warn"
                                    : "info"
                              }
                            >
                              {issue.severity}
                            </StatusBadge>{" "}
                            <InlineCode>{issue.category}</InlineCode> —{" "}
                            {issue.message}
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  label: "Rationale",
                  value: spec.qa.rationale ? (
                    <span>{spec.qa.rationale}</span>
                  ) : (
                    <span>—</span>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState
              title="QA 結果は記録されていません"
              description="creatives.spec.qa にも metadata.json にも QA breakdown がありません (storage 未到達 / prompt-only fallback)。"
            />
          )}
        </Panel>

        <Panel
          title="Linked records"
          subtitle="ai_run / improvement_run / pull_request / hierarchy"
        >
          <KeyValueList
            items={[
              {
                label: "Image Prompt ai_run",
                value: row.aiRun ? (
                  <span>
                    <InlineCode>{row.aiRun.id}</InlineCode>{" "}
                    <StatusBadge state="info">{row.aiRun.agent}</StatusBadge>{" "}
                    <InlineCode>
                      {row.aiRun.provider}/{row.aiRun.model}
                    </InlineCode>{" "}
                    <StatusBadge
                      state={
                        row.aiRun.status === "succeeded"
                          ? "ok"
                          : row.aiRun.status === "failed"
                            ? "error"
                            : row.aiRun.status === "running"
                              ? "info"
                              : "idle"
                      }
                    >
                      {row.aiRun.status}
                    </StatusBadge>{" "}
                    <span
                      className="tabular-nums"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      tokens {row.aiRun.inputTokens.toLocaleString()} /{" "}
                      {row.aiRun.outputTokens.toLocaleString()}
                    </span>
                  </span>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
              {
                label: "Creative QA ai_run",
                value: row.creativeQa ? (
                  <span>
                    <InlineCode>{row.creativeQa.id}</InlineCode>{" "}
                    <StatusBadge state="info">
                      {row.creativeQa.agent}
                    </StatusBadge>{" "}
                    <InlineCode>
                      {row.creativeQa.provider}/{row.creativeQa.model}
                    </InlineCode>{" "}
                    <StatusBadge
                      state={
                        row.creativeQa.status === "succeeded"
                          ? "ok"
                          : row.creativeQa.status === "failed"
                            ? "error"
                            : row.creativeQa.status === "running"
                              ? "info"
                              : "idle"
                      }
                    >
                      {row.creativeQa.status}
                    </StatusBadge>{" "}
                    <span
                      className="tabular-nums"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      tokens {row.creativeQa.inputTokens.toLocaleString()} /{" "}
                      {row.creativeQa.outputTokens.toLocaleString()}
                    </span>
                  </span>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
              {
                label: "Pull request",
                value: row.pullRequest ? (
                  <span>
                    {row.pullRequest.htmlUrl ? (
                      <a
                        href={row.pullRequest.htmlUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ color: "var(--color-accent)" }}
                      >
                        <InlineCode>#{row.pullRequest.number}</InlineCode>
                      </a>
                    ) : (
                      <InlineCode>#{row.pullRequest.number}</InlineCode>
                    )}{" "}
                    <StatusBadge
                      state={
                        row.pullRequest.state === "merged"
                          ? "ok"
                          : row.pullRequest.state === "closed"
                            ? "idle"
                            : "info"
                      }
                    >
                      {row.pullRequest.state}
                    </StatusBadge>{" "}
                    {row.pullRequest.title}
                  </span>
                ) : (
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    未添付 (PR 添付前)
                  </span>
                ),
              },
              {
                label: "Improvement run",
                value: metadata?.links.improvementRunId ? (
                  <InlineCode>{metadata.links.improvementRunId}</InlineCode>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
              {
                label: "Storage path (internal)",
                value: row.storagePath ? (
                  <InlineCode>{row.storagePath}</InlineCode>
                ) : (
                  <span>—</span>
                ),
                mono: true,
              },
            ]}
          />
        </Panel>

        <Panel
          title="Audit trail"
          subtitle={`audit_logs (target="creative:${row.id}") · ${paginationLabel(auditPagination)}`}
          status={
            <StatusDot state={auditTotal === 0 ? "idle" : "ok"}>
              {auditTotal === 0 ? "no records" : `${auditTotal} records`}
            </StatusDot>
          }
        >
          <div>
            <DataTable
              rows={auditRows}
              rowKey={(r) => r.id}
              columns={auditColumns}
              empty={
                <EmptyState
                  title="この creative に紐付く audit はまだありません"
                  description="creative.generated / creative.qa_passed / creative.qa_failed / creative.attached_to_pr 等の audit_log が書かれるとここに表示されます。"
                />
              }
            />
            <Pagination
              basePath={`/creatives/${encodeURIComponent(row.id)}`}
              searchParams={resolvedSearchParams}
              pageParam="auditPage"
              state={auditPagination}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

function CreativeAdPreview({
  accountName,
  displayName,
  adText,
  imageSrc,
  imageAlt,
  imageStatusLabel,
  selected,
  caption,
}: {
  accountName: string;
  displayName: string;
  adText: CreativeSpecAdText | null;
  imageSrc?: string;
  imageAlt: string;
  imageStatusLabel?: string;
  selected?: boolean;
  caption?: ReactNode;
}) {
  const headline = adText?.headline || displayName;
  const primaryText =
    adText?.primaryText || "広告テキスト案は詳細画面で確認できます。";
  const description = adText?.description || "詳しくはこちら";
  const cta = adText?.callToAction || "LEARN_MORE";
  return (
    <figure className="creative-detail__preview">
      <div
        className="creative-card__ad-preview creative-detail__ad-preview"
        aria-label="Meta広告プレビュー"
      >
        {selected ? (
          <label
            className="creative-card__select creative-card__select--detail"
            title="入稿候補として選択中"
          >
            <input type="checkbox" checked readOnly />
            <span>入稿候補</span>
          </label>
        ) : null}
        <div className="creative-card__ad-header">
          <div className="creative-card__avatar" aria-hidden="true">
            {accountName.slice(0, 1).toUpperCase()}
          </div>
          <div className="creative-card__ad-identity">
            <div className="creative-card__page-name" title={accountName}>
              {accountName}
            </div>
            <div className="creative-card__sponsored">広告</div>
          </div>
        </div>
        <div className="creative-card__primary-text">{primaryText}</div>
        <div className="creative-card__thumb">
          {imageSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageSrc}
              alt={imageAlt}
              width={360}
              height={360}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="creative-card__placeholder" aria-hidden="true">
              <span>{imageStatusLabel ?? "画像なし"}</span>
            </div>
          )}
        </div>
        <div className="creative-card__link-preview">
          <div className="creative-card__link-copy">
            <div className="creative-card__headline" title={headline}>
              {headline}
            </div>
            <div className="creative-card__description" title={description}>
              {description}
            </div>
          </div>
          <span className="creative-card__cta">{ctaLabel(cta)}</span>
        </div>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function CreativeAssetCaption({ asset }: { asset: CreativeMetadataAsset }) {
  return (
    <div className="creative-detail__preview-caption">
      <div>
        <StatusBadge state={qaOverallToState(asset.qaOverall)}>
          {asset.qaOverall}
        </StatusBadge>
      </div>
      <div className="mono">
        <InlineCode>variantKey={asset.variantKey}</InlineCode>
      </div>
      <div className="mono">
        <InlineCode>{asset.mimeType}</InlineCode> ·{" "}
        <InlineCode>{formatDimensions(asset.width, asset.height)}</InlineCode> ·{" "}
        {formatBytes(asset.byteSize)}
      </div>
      <div className="mono" style={{ wordBreak: "break-all" }}>
        <InlineCode>{asset.storageRef}</InlineCode>
      </div>
    </div>
  );
}

function carouselAdTextForCard(
  base: CreativeSpecAdText | null,
  card: {
    headline: string;
    description: string | null;
  },
): CreativeSpecAdText {
  return {
    primaryText: base?.primaryText ?? null,
    headline: card.headline,
    description: card.description ?? base?.description ?? null,
    callToAction: base?.callToAction ?? "LEARN_MORE",
    rationale: base?.rationale ?? null,
  };
}

function groupAssetsByBaseVariant(assets: CreativeMetadataAsset[]): Array<{
  baseVariantKey: string;
  assets: Array<{ asset: CreativeMetadataAsset; assetIndex: number }>;
}> {
  const groups = new Map<
    string,
    Array<{ asset: CreativeMetadataAsset; assetIndex: number }>
  >();
  assets.forEach((asset, assetIndex) => {
    const baseVariantKey = asset.variantKey.split("--")[0] || asset.variantKey;
    const list = groups.get(baseVariantKey);
    const entry = { asset, assetIndex };
    if (list) {
      list.push(entry);
    } else {
      groups.set(baseVariantKey, [entry]);
    }
  });
  return [...groups.entries()].map(([baseVariantKey, groupedAssets]) => ({
    baseVariantKey,
    assets: groupedAssets,
  }));
}

function textForPreview(
  primary: CreativeSpecAdText | null,
  variants: CreativeSpecAdText[],
  index: number,
): CreativeSpecAdText | null {
  return variants[index] ?? primary;
}

function ctaLabel(value: string): string {
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

const auditColumns: DataTableColumn<{
  id: string;
  actor: string;
  action: string;
  target: string | null;
  ref: string | null;
  metadata: unknown;
  createdAt: Date;
}>[] = [
  {
    header: "Created",
    cell: (r) => (
      <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
        {formatTimestamp(r.createdAt)}
      </span>
    ),
    className: "tabular mono",
    headerClassName: "tabular",
  },
  {
    header: "Actor",
    cell: (r) => <InlineCode>{sanitizeForDisplay(r.actor)}</InlineCode>,
  },
  {
    header: "Action",
    cell: (r) => <InlineCode>{r.action}</InlineCode>,
  },
  {
    header: "Ref",
    cell: (r) =>
      r.ref ? (
        <InlineCode>{sanitizeForDisplay(r.ref)}</InlineCode>
      ) : (
        <span>—</span>
      ),
  },
];

function QaAssetBlock({ asset }: { asset: CreativeMetadataQaAsset }) {
  return (
    <details
      className="qa-asset"
      open
      style={{
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        padding: "0.875rem 1rem",
        background: "var(--color-bg-subtle)",
      }}
      data-testid="qa-asset"
      data-variant-key={asset.variantKey}
    >
      <summary
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          cursor: "pointer",
          fontSize: "0.9375rem",
          fontWeight: 500,
        }}
      >
        <StatusBadge state={qaOverallToState(asset.overall)}>
          {asset.overall}
        </StatusBadge>
        <InlineCode>variantKey={asset.variantKey}</InlineCode>
        <span
          style={{
            color: "var(--color-text-secondary)",
            fontSize: "0.8125rem",
          }}
        >
          {asset.checks.length} check{asset.checks.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div style={{ marginTop: "0.75rem" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Severity</th>
              <th scope="col">Outcome</th>
              <th scope="col">Detail</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {asset.checks.map((c) => (
              <QaCheckRow key={c.kind} check={c} />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function creativeGeneItems(genes: CreativeGenes): KeyValueEntry[] {
  return [
    {
      label: "訴求軸",
      value: (
        <div className="creative-card__genes">
          {genes.appealAxes.map((axis) => (
            <span className="creative-gene-chip" key={axis}>
              {GENE_LABELS_JA[axis] ?? axis}
            </span>
          ))}
        </div>
      ),
    },
    {
      label: "トーン",
      value: <span>{GENE_LABELS_JA[genes.tone] ?? genes.tone}</span>,
    },
    {
      label: "被写体",
      value: (
        <span>{GENE_LABELS_JA[genes.subjectType] ?? genes.subjectType}</span>
      ),
    },
    {
      label: "配色",
      value: (
        <span>{GENE_LABELS_JA[genes.colorScheme] ?? genes.colorScheme}</span>
      ),
    },
    {
      label: "構図",
      value: <span>{GENE_LABELS_JA[genes.layout] ?? genes.layout}</span>,
    },
    {
      label: "文字入り",
      value: <span>{genes.hasTextOverlay ? "あり" : "なし"}</span>,
    },
    { label: "CTA", value: <span>{genes.hasCta ? "あり" : "なし"}</span> },
    {
      label: "言語",
      value: <span>{GENE_LABELS_JA[genes.language] ?? genes.language}</span>,
    },
  ];
}

function QaCheckRow({ check }: { check: CreativeMetadataQaCheck }) {
  return (
    <tr
      data-testid="qa-check"
      data-kind={check.kind}
      data-outcome={check.outcome}
    >
      <td className="mono">
        <InlineCode>{check.kind}</InlineCode>
      </td>
      <td>
        <StatusBadge
          state={
            check.severity === "blocking"
              ? "error"
              : check.severity === "non_blocking"
                ? "warn"
                : "info"
          }
        >
          {check.severity}
        </StatusBadge>
      </td>
      <td>
        <StatusBadge state={qaOutcomeToState(check.outcome)}>
          {check.outcome}
        </StatusBadge>
      </td>
      <td>{check.detail || <span>—</span>}</td>
      <td className="mono">
        {check.evidence ? (
          <InlineCode>{sanitizeForDisplay(check.evidence)}</InlineCode>
        ) : (
          <span>—</span>
        )}
      </td>
    </tr>
  );
}
