import Link from "next/link";
import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import { DataTable, type DataTableColumn } from "../../components/ui/DataTable";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusBadge } from "../../components/ui/StatusBadge";
import type { StatusState } from "../../components/ui/StatusDot";
import { InlineCode } from "../../components/ui/CodeBlock";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";
import { ExperimentForm, type ExperimentFormAccount } from "./ExperimentForm";

export const dynamic = "force-dynamic";

interface ExperimentRow {
  id: string;
  name: string;
  status: string;
  metric: string;
  accountKey: string;
  adsetNodeKey: string;
  variantAKey: string;
  variantBKey: string;
  startDate: Date;
  minImpressionsPerVariant: number;
  maxDurationDays: number;
  conclusion: unknown;
  pullRequest: { number: number; htmlUrl: string | null } | null;
  aImpressions: number;
  bImpressions: number;
}

export default async function ExperimentsPage() {
  const pageDisplayTimeZone = resolveDisplayTimeZone();
  let dbReady = true;
  let rows: ExperimentRow[] = [];
  let formAccounts: ExperimentFormAccount[] = [];
  try {
    const workspace = await ensureWebWorkspace();
    const [accounts, nodes, experiments] = await Promise.all([
      prisma.adAccount.findMany({
        where: { workspaceId: workspace.id, active: true },
        select: { id: true, key: true, displayName: true },
        orderBy: { key: "asc" },
      }),
      prisma.adsHierarchyNode.findMany({
        where: {
          account: { workspaceId: workspace.id },
          nodeType: { in: ["adset", "ad"] },
          status: "active",
        },
        select: {
          id: true,
          accountId: true,
          parentId: true,
          nodeType: true,
          nodeKey: true,
          displayName: true,
        },
        orderBy: [{ nodeType: "asc" }, { nodeKey: "asc" }],
      }),
      prisma.experiment.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: 100,
        select: {
          id: true,
          name: true,
          status: true,
          metric: true,
          accountId: true,
          adsetNodeKey: true,
          variantAKey: true,
          variantBKey: true,
          startDate: true,
          minImpressionsPerVariant: true,
          maxDurationDays: true,
          conclusion: true,
          account: { select: { key: true } },
          pullRequest: { select: { number: true, htmlUrl: true } },
        },
      }),
    ]);
    const adsets = nodes.filter((node) => node.nodeType === "adset");
    const adsByParent = new Map<string, typeof nodes>();
    for (const ad of nodes.filter((node) => node.nodeType === "ad")) {
      if (!ad.parentId) continue;
      const list = adsByParent.get(ad.parentId) ?? [];
      list.push(ad);
      adsByParent.set(ad.parentId, list);
    }
    formAccounts = accounts
      .map((account) => ({
        key: account.key,
        displayName: account.displayName,
        adsets: adsets
          .filter((adset) => adset.accountId === account.id)
          .map((adset) => ({
            nodeKey: adset.nodeKey,
            displayName: adset.displayName,
            ads: (adsByParent.get(adset.id) ?? []).map((ad) => ({
              nodeKey: ad.nodeKey,
              displayName: ad.displayName,
            })),
          }))
          .filter((adset) => adset.ads.length >= 2),
      }))
      .filter((account) => account.adsets.length > 0);

    rows = await Promise.all(
      experiments.map(async (experiment) => {
        const stats = await prisma.performanceSnapshot.groupBy({
          by: ["nodeKey"],
          where: {
            accountId: experiment.accountId,
            nodeType: "ad",
            nodeKey: { in: [experiment.variantAKey, experiment.variantBKey] },
            metricDate: { gte: experiment.startDate },
          },
          _sum: { impressions: true },
        });
        const impressionsByKey = new Map(
          stats.map((item) => [item.nodeKey, item._sum.impressions ?? 0]),
        );
        return {
          id: experiment.id,
          name: experiment.name,
          status: experiment.status,
          metric: experiment.metric,
          accountKey: experiment.account.key,
          adsetNodeKey: experiment.adsetNodeKey,
          variantAKey: experiment.variantAKey,
          variantBKey: experiment.variantBKey,
          startDate: experiment.startDate,
          minImpressionsPerVariant: experiment.minImpressionsPerVariant,
          maxDurationDays: experiment.maxDurationDays,
          conclusion: experiment.conclusion,
          pullRequest: experiment.pullRequest,
          aImpressions: impressionsByKey.get(experiment.variantAKey) ?? 0,
          bImpressions: impressionsByKey.get(experiment.variantBKey) ?? 0,
        };
      }),
    );
  } catch {
    dbReady = false;
  }

  const columns: DataTableColumn<ExperimentRow>[] = [
    {
      header: "実験",
      cell: (row) => (
        <div>
          <div>{row.name}</div>
          <div className="muted">
            <InlineCode>{row.accountKey}</InlineCode> / <InlineCode>{row.adsetNodeKey}</InlineCode>
          </div>
        </div>
      ),
    },
    {
      header: "状態",
      cell: (row) => (
        <StatusBadge state={statusState(row.status)}>{statusLabel(row.status)}</StatusBadge>
      ),
    },
    {
      header: "指標",
      cell: (row) => <InlineCode>{row.metric.toUpperCase()}</InlineCode>,
    },
    {
      header: "進捗",
      cell: (row) => (
        <div style={{ display: "grid", gap: "0.25rem", minWidth: "10rem" }}>
          <progress
            value={Math.min(row.aImpressions, row.bImpressions)}
            max={row.minImpressionsPerVariant}
            style={{ width: "100%" }}
          />
          <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            A {row.aImpressions.toLocaleString()} / B {row.bImpressions.toLocaleString()}
          </span>
        </div>
      ),
    },
    {
      header: "開始日",
      cell: (row) => formatDateTime(row.startDate, { timeZone: pageDisplayTimeZone }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "結論",
      cell: (row) => conclusionLabel(row.conclusion),
    },
    {
      header: "PR",
      cell: (row) =>
        row.pullRequest?.htmlUrl ? (
          <a href={row.pullRequest.htmlUrl} target="_blank" rel="noreferrer">
            #{row.pullRequest.number}
          </a>
        ) : (
          <span>—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="A/Bテスト"
        subtitle="同一広告セット内の2広告を比較し、十分なデータが溜まった場合だけ敗者PAUSE提案PRを作成します。"
        actions={
          <Link href="/cron" className="btn btn--ghost btn--sm">
            自動実行
          </Link>
        }
      />

      <div className="page-body page-body--single">
        <Panel
          title="実験登録"
          subtitle="比較対象は同じ広告セット内の active 広告2つに限定されます。"
        >
          {!dbReady ? (
            <EmptyState title="実験登録を読み出せません" description="接続と健康状態を確認してください。" />
          ) : formAccounts.length === 0 ? (
            <EmptyState
              title="登録できる広告セットがありません"
              description="Meta mirror sync 後、active 広告が2つ以上ある広告セットが表示されます。"
            />
          ) : (
            <ExperimentForm accounts={formAccounts} />
          )}
        </Panel>

        <Panel
          title="実験一覧"
          subtitle="日次評価の進捗、結論、PAUSE提案PRを確認できます。"
        >
          {!dbReady ? (
            <EmptyState title="実験一覧を読み出せません" description="接続と健康状態を確認してください。" />
          ) : (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              columns={columns}
              empty={
                <EmptyState
                  title="登録済みの実験はまだありません"
                  description="上のフォームまたはチャットからA/Bテストを登録できます。"
                />
              }
            />
          )}
        </Panel>
      </div>
    </>
  );
}

function statusState(status: string): StatusState {
  if (status === "running") return "info";
  if (status === "concluded") return "ok";
  if (status === "cancelled") return "warn";
  if (status === "inconclusive") return "idle";
  return "idle";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: "実行中",
    concluded: "勝敗確定",
    cancelled: "取消",
    inconclusive: "結論なし",
  };
  return labels[status] ?? status;
}

function conclusionLabel(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "—";
  const outcome = (value as Record<string, unknown>).outcome;
  if (typeof outcome !== "string") return "—";
  const labels: Record<string, string> = {
    a_wins: "A 勝利",
    b_wins: "B 勝利",
    no_significant_difference: "有意差なし",
    insufficient_data: "サンプル不足",
    expired_inconclusive: "期限切れ",
    cancelled: "取消",
  };
  return labels[outcome] ?? outcome;
}
