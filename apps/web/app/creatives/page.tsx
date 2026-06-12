// AdDroid OSS — /creatives ページ (this implementation).
//
// 生成クリエイティブの一覧。
//
// データソース:
//   - prisma.creative.findMany — Account / Status / Provider フィルタを
//     query string から受けて適用。最新 60 件を表示。
//   - prisma.adAccount.findMany — Toolbar の Account select 用。
//   - 各行の thumbnail は metadata.json (LocalDisk) の先頭 asset を
//     /api/creatives/[id]/asset/[assetId] (proxy) 経由で取得して描画する。
//     Provider の signed URL を直接 src にしない (UI design plan principle 23)。
//
// 設計:
//   - 画像 Provider 未設定でも常に 200 OK で描画する (UI design plan §0.21)。
//   - 何も無いときは EmptyState で「画像 Provider なしでも動作する (任意)」
//     と説明する (creative_copy_rules)。
//   - 通常一覧は storageRef/storagePath を持つ画像生成済み行だけを表示する。
//     prompt-only / fallback_text_only 行は status/provider filter で明示表示する。
//     metadata.json が読めない (storage 未到達) は `storage 未到達` の
//     プレースホルダに倒す。
//   - 再生成 / 編集 / Meta 直接反映の導線は **置かない** (UI design plan §0.30
//     / creative_copy_rules)。

import Link from "next/link";
import type { Prisma } from "@addroid/db";
import {
  APPEAL_AXES,
  GENE_LABELS_JA,
  parseCreativeGenes,
  type AppealAxis,
} from "@addroid/llm-provider";
import {
  buildCreativePerformanceDigest,
  type CreativePerformanceEntry,
} from "@addroid/queue";
import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { StatusDot } from "../../components/ui/StatusDot";
import { InlineCode } from "../../components/ui/CodeBlock";
import { RunCronButton } from "../../components/RunCronButton";
import {
  CreativesToolbar,
  type AccountOption,
  type ProviderOption,
} from "./CreativesToolbar";
import {
  creativeStatusToState,
  findAssetForCreativeRow,
  formatTimestamp,
  isCreativeStatus,
  parseCreativeSpec,
  readCreativeMetadataByRef,
  type CreativeStatus,
} from "../../lib/creative-helpers";
import { ensureWebWorkspace } from "../../lib/meta-runtime";
import { firstSearchParam } from "../../lib/search-params";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  accountId?: string | string[];
  status?: string | string[];
  provider?: string | string[];
  appealAxis?: string | string[];
}

interface CreativeRow {
  id: string;
  key: string;
  displayName: string;
  status: string;
  mediaType: string;
  provider: string | null;
  model: string | null;
  storageRef: string | null;
  storagePath: string | null;
  genes: unknown;
  pullRequestId: string | null;
  aiRunId: string | null;
  creativeQaAiRunId: string | null;
  spec: unknown;
  createdAt: Date;
  account: { id: string; key: string; displayName: string } | null;
  pullRequest: { number: number; htmlUrl: string | null; state: string } | null;
}

interface ResolvedThumb {
  assetId: string | null;
  width: number | null;
  height: number | null;
  storageReachable: boolean;
}

interface CreativeCardPerformance {
  impressions: number;
  ctr: number | null;
  verdict: CreativePerformanceEntry["verdict"];
}

const TAKE = 60;

export default async function CreativesPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  const accountIdParam = firstSearchParam(resolvedSearchParams?.accountId) ?? null;
  const statusParam = (firstSearchParam(resolvedSearchParams?.status) ?? "all").trim();
  const providerParam = (firstSearchParam(resolvedSearchParams?.provider) ?? "all").trim();
  const appealAxisParam = (firstSearchParam(resolvedSearchParams?.appealAxis) ?? "all").trim();
  const selectedAppealAxis: AppealAxis | "all" = APPEAL_AXES.includes(
    appealAxisParam as AppealAxis
  )
    ? (appealAxisParam as AppealAxis)
    : "all";

  let dbReady = true;
  let accounts: AccountOption[] = [];
  let creatives: CreativeRow[] = [];
  let totalForAccount = 0;
  let providers: ProviderOption[] = [];

  try {
    const ws = await ensureWebWorkspace();
    if (ws) {
      const accountRows = await prisma.adAccount.findMany({
        where: { workspaceId: ws.id, active: true },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, key: true, displayName: true },
      });
      accounts = accountRows;
    }

    const where: Prisma.CreativeWhereInput = {
      account: { workspaceId: ws.id },
      aiRunId: { not: null },
      creativeQaAiRunId: { not: null },
    };
    if (accountIdParam) {
      where.accountId = accountIdParam;
    }
    if (statusParam !== "all" && isCreativeStatus(statusParam)) {
      where.status = statusParam;
    }
    if (providerParam === "__none__") {
      where.provider = null;
    } else if (providerParam !== "all") {
      where.provider = providerParam;
    }
    if (statusParam === "all" && providerParam === "all") {
      where.storageRef = { not: null };
      where.storagePath = { not: null };
    }
    if (selectedAppealAxis !== "all") {
      where.genes = {
        path: ["appealAxes"],
        array_contains: [selectedAppealAxis],
      };
    }

    creatives = await prisma.creative.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: TAKE,
      select: {
        id: true,
        key: true,
        displayName: true,
        status: true,
        mediaType: true,
        provider: true,
        model: true,
        storageRef: true,
        storagePath: true,
        genes: true,
        pullRequestId: true,
        aiRunId: true,
        creativeQaAiRunId: true,
        spec: true,
        createdAt: true,
        account: { select: { id: true, key: true, displayName: true } },
        pullRequest: { select: { number: true, htmlUrl: true, state: true } },
      },
    });

    totalForAccount = await prisma.creative.count({ where });

    // Toolbar の Provider dropdown 用 (現 account scope の distinct)。
    const providerRows = await prisma.creative.findMany({
      where: accountIdParam
        ? {
            accountId: accountIdParam,
            account: { workspaceId: ws.id },
            aiRunId: { not: null },
            creativeQaAiRunId: { not: null },
          }
        : {
            account: { workspaceId: ws.id },
            aiRunId: { not: null },
            creativeQaAiRunId: { not: null },
          },
      distinct: ["provider"],
      select: { provider: true },
    });
    providers = providerRows
      .map((r) => r.provider)
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .sort()
      .map((p) => ({ value: p, label: p }));
  } catch {
    dbReady = false;
  }

  // metadata.json を並列で読み出して thumbnail 用 asset_id を解決する。
  // localhost の LocalDisk read は十分高速。失敗 (= storage 未到達) は
  // プレースホルダに倒す。
  //
  // regression fix: 各 Creative 行は metadata 内の特定 variant に対応する。
  // `findAssetForCreativeRow` が `storagePath` (per-asset 相対 path) で
  // metadata.assets を引き当てる。同一 metadata.json を共有する複数行が
  // 同じ asset を盲目的に指す回路を避ける。
  const thumbs = await Promise.all(
    creatives.map(async (row): Promise<ResolvedThumb> => {
      if (!row.storageRef) {
        return { assetId: null, width: null, height: null, storageReachable: false };
      }
      const metadata = await readCreativeMetadataByRef(row.storageRef);
      if (!metadata || metadata.assets.length === 0) {
        return { assetId: null, width: null, height: null, storageReachable: false };
      }
      const matched = findAssetForCreativeRow(metadata, {
        storagePath: row.storagePath,
      });
      if (!matched) {
        return { assetId: null, width: null, height: null, storageReachable: false };
      }
      return {
        assetId: matched.assetId,
        width: matched.width,
        height: matched.height,
        storageReachable: true,
      };
    })
  );

  const showingCount = creatives.length;
  const moreCount = Math.max(totalForAccount - showingCount, 0);
  const performanceByCreativeId = await loadPerformanceByCreativeId(creatives);

  return (
    <>
      <PageHeader
        title="生成クリエイティブ"
        subtitle={
          <>
            自動クリエイティブ生成で作成された広告クリエイティブの一覧です。
            通常表示では画像ファイルまで生成できたものだけを表示します。
          </>
        }
        actions={
          <form
            id="creative-submit-selected-form"
            className="creative-actions"
            action="/creatives/submit"
            method="get"
          >
            <button className="btn" type="submit">
              入稿チャット
            </button>
            <RunCronButton presetName="auto_creative_generation" label="生成を開始" />
          </form>
        }
      />

      <div className="page-body page-body--single">
        <CreativesToolbar
          accounts={accounts}
          providers={providers}
          selectedAccountId={accountIdParam}
          selectedStatus={statusParam}
          selectedProvider={providerParam}
          selectedAppealAxis={selectedAppealAxis}
        />

        <Panel
          title="クリエイティブ一覧"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : `${totalForAccount} 件 (直近 ${showingCount} を表示${
                  moreCount > 0 ? ` / 他 ${moreCount} 件` : ""
                })`
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : showingCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "warn"
                : showingCount === 0
                  ? "未作成"
                  : `${showingCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="クリエイティブを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : creatives.length === 0 ? (
            <EmptyState
              title="まだ生成クリエイティブはありません"
              description={
                <>
                  自動クリエイティブ生成を実行すると、生成されたクリエイティブがここに表示されます。
                  画像生成を設定していない場合も、テキスト案として承認待ちの変更を作成できます。
                </>
              }
            />
          ) : (
            <div className="creative-grid" data-testid="creative-grid">
              {creatives.map((row, i) => (
                <CreativeCard
                  key={row.id}
                  row={row}
                  thumb={thumbs[i] ?? {
                    assetId: null,
                    width: null,
                    height: null,
                    storageReachable: false,
                  }}
                  performance={performanceByCreativeId.get(row.id) ?? null}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function CreativeCard({
  row,
  thumb,
  performance,
}: {
  row: CreativeRow;
  thumb: ResolvedThumb;
  performance: CreativeCardPerformance | null;
}) {
  const status = row.status as CreativeStatus | string;
  const statusState = creativeStatusToState(status);
  const hasStorageRef = Boolean(row.storageRef);
  const showImage = hasStorageRef && thumb.assetId !== null;
  const showStorageMissing = hasStorageRef && !thumb.storageReachable;
  const spec = parseCreativeSpec(row.spec);
  const genes = parseCreativeGenes(row.genes) ?? spec.genes;
  const adText = spec.adText;
  const accountName = row.account?.displayName || row.account?.key || "AdDroid";
  const headline = adText?.headline || row.displayName;
  const primaryText = adText?.primaryText || "広告テキスト案は詳細画面で確認できます。";
  const description = adText?.description || "詳しくはこちら";
  const cta = adText?.callToAction || "LEARN_MORE";
  const disabled = row.status === "qa_failed";

  return (
    <article className="creative-card-wrap">
      <label className="creative-card__select" title={disabled ? "このCRは入稿候補にできません" : "入稿候補に選択"}>
        <input
          form="creative-submit-selected-form"
          type="checkbox"
          name="creativeId"
          value={row.id}
          disabled={disabled}
        />
        <span>入稿候補</span>
      </label>
      <Link
        href={`/creatives/${row.id}`}
        className="creative-card"
        data-testid="creative-card"
        data-status={row.status}
      >
        <div className="creative-card__ad-preview" aria-label="Meta広告プレビュー">
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
            {showImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/creatives/${row.id}/asset/${thumb.assetId}`}
                alt={`creative ${row.displayName}`}
                width={160}
                height={160}
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="creative-card__placeholder" aria-hidden="true">
                <span>{showStorageMissing ? "画像未取得" : "画像なし"}</span>
              </div>
            )}
            {showStorageMissing ? (
              <div className="creative-card__overlay">
                <StatusBadge state="warn">画像未取得</StatusBadge>
              </div>
            ) : null}
            {!hasStorageRef ? (
              <div className="creative-card__overlay">
                <StatusBadge state="idle">テキスト案</StatusBadge>
              </div>
            ) : null}
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
        <div className="creative-card__meta">
          <div className="creative-card__row">
            <StatusBadge state={statusState}>{row.status}</StatusBadge>
          </div>
          <div className="creative-card__genes" aria-label="訴求軸">
            {genes ? (
              genes.appealAxes.map((axis) => (
                <span className="creative-gene-chip" key={axis}>
                  {GENE_LABELS_JA[axis] ?? axis}
                </span>
              ))
            ) : (
              <span className="creative-card__optional">タグなし</span>
            )}
          </div>
          <div className="creative-card__title" title={row.displayName}>
            {row.displayName}
          </div>
          <div className="creative-card__provider mono">
            {row.provider && row.model ? (
              <InlineCode>
                {row.provider}/{row.model}
              </InlineCode>
            ) : (
              <span className="creative-card__optional">画像 Provider 未設定</span>
            )}
          </div>
          {thumb.width && thumb.height ? (
            <div className="creative-card__dim mono">
              <InlineCode>
                {thumb.width}×{thumb.height}
              </InlineCode>
            </div>
          ) : null}
          <div className="creative-card__performance">
            {performance ? (
              <>
                <span className="mono">{performance.impressions.toLocaleString("ja-JP")} imp</span>
                <span className="mono">
                  CTR {performance.ctr === null ? "—" : `${(performance.ctr * 100).toFixed(1)}%`}
                </span>
                <StatusBadge state={performanceState(performance.verdict)}>
                  {performanceLabel(performance.verdict)}
                </StatusBadge>
              </>
            ) : (
              <span className="creative-card__optional">実績なし</span>
            )}
          </div>
          <div className="creative-card__footer">
            <span className="creative-card__account mono">
              {row.account ? row.account.key : "—"}
            </span>
            <span className="creative-card__pr mono">
              {row.pullRequest ? `PR #${row.pullRequest.number}` : "未添付"}
            </span>
          </div>
          <div className="creative-card__time mono">
            {formatTimestamp(row.createdAt)}
          </div>
        </div>
      </Link>
    </article>
  );
}

async function loadPerformanceByCreativeId(
  creatives: CreativeRow[]
): Promise<Map<string, CreativeCardPerformance>> {
  const accountIds = [
    ...new Set(
      creatives
        .map((creative) => creative.account?.id)
        .filter((id): id is string => typeof id === "string")
    ),
  ];
  if (accountIds.length === 0) return new Map();
  const now = new Date();
  const until = dateOnly(addUtcDays(now, -1));
  const since = dateOnly(addUtcDays(now, -28));
  const entries = await Promise.all(
    accountIds.map(async (accountId) => {
      const digest = await buildCreativePerformanceDigest({
        store: {
          listAdCreativePerformance: (input) =>
            listAdCreativePerformanceForWeb(input.accountId, input.since, input.until),
        },
        accountId,
        since,
        until,
      });
      return digest.entries;
    })
  );
  const out = new Map<string, CreativeCardPerformance>();
  for (const entry of entries.flat()) {
    out.set(entry.creativeId, {
      impressions: entry.metrics.impressions,
      ctr: entry.metrics.ctr,
      verdict: entry.verdict,
    });
  }
  return out;
}

async function listAdCreativePerformanceForWeb(accountId: string, since: string, until: string) {
  const snapshots = await prisma.performanceSnapshot.findMany({
    where: {
      accountId,
      nodeType: "ad",
      metricDate: {
        gte: new Date(`${since}T00:00:00.000Z`),
        lte: new Date(`${until}T00:00:00.000Z`),
      },
    },
    select: {
      id: true,
      accountId: true,
      nodeType: true,
      nodeKey: true,
      metricDate: true,
      impressions: true,
      clicks: true,
      conversions: true,
      spendMicros: true,
      hierarchy: {
        select: {
          id: true,
          accountId: true,
          nodeType: true,
          nodeKey: true,
          displayName: true,
        },
      },
    },
  });
  const hierarchyIds = [
    ...new Set(
      snapshots
        .map((snapshot) => snapshot.hierarchy?.id)
        .filter((id): id is string => typeof id === "string")
    ),
  ];
  if (hierarchyIds.length === 0) return [];
  const creativeRows = await prisma.creative.findMany({
    where: {
      accountId,
      hierarchyId: { in: hierarchyIds },
      status: { in: ["merged", "active_on_meta"] },
    },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      key: true,
      displayName: true,
      genes: true,
      spec: true,
      prompt: true,
      status: true,
      updatedAt: true,
      hierarchyId: true,
    },
  });
  const creativesByHierarchy = new Map<string, typeof creativeRows>();
  for (const creative of creativeRows) {
    if (!creative.hierarchyId) continue;
    const list = creativesByHierarchy.get(creative.hierarchyId);
    if (list) {
      list.push(creative);
    } else {
      creativesByHierarchy.set(creative.hierarchyId, [creative]);
    }
  }
  return snapshots.flatMap((snapshot) => {
    const hierarchy = snapshot.hierarchy;
    if (!hierarchy) return [];
    const matched = creativesByHierarchy.get(hierarchy.id) ?? [];
    return matched.map((creative) => ({
      snapshotRow: {
        id: snapshot.id,
        accountId: snapshot.accountId,
        nodeType: snapshot.nodeType,
        nodeKey: snapshot.nodeKey,
        metricDate: snapshot.metricDate,
        impressions: snapshot.impressions,
        clicks: snapshot.clicks,
        conversions: snapshot.conversions,
        spendMicros: snapshot.spendMicros,
      },
      hierarchyRow: hierarchy,
      creativeRow: creative,
      ambiguous: matched.length > 1,
    }));
  });
}

function performanceState(verdict: CreativePerformanceEntry["verdict"]) {
  switch (verdict) {
    case "winner":
      return "ok";
    case "loser":
      return "error";
    case "neutral":
      return "info";
    case "insufficient_data":
      return "idle";
  }
}

function performanceLabel(verdict: CreativePerformanceEntry["verdict"]): string {
  switch (verdict) {
    case "winner":
      return "勝ち";
    case "loser":
      return "負け";
    case "neutral":
      return "中立";
    case "insufficient_data":
      return "不足";
  }
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
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
