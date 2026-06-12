import Link from "next/link";
import { prisma } from "../../lib/prisma";
import { CRON_PRESETS } from "@addroid/queue";
import { Panel } from "../../components/ui/Panel";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { DataTable } from "../../components/ui/DataTable";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { CronControls } from "./CronControls";
import { CronRateLimitSummary } from "./CronRateLimitSummary";
import { AgentTaskForm, type AgentTaskRow } from "./AgentTaskForm";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";

export const dynamic = "force-dynamic";

export default async function CronSchedulesPage() {
  const pageDisplayTimeZone = resolveDisplayTimeZone();
  type Row = {
    name: string;
    cron: string;
    enabled: boolean;
    lastRunState: string | null;
    nextRunAt: Date | null;
    description: string;
    persistedFromDb: boolean;
  };

  let registered: {
    name: string;
    cron: string;
    enabled: boolean;
    lastRunState: string | null;
    nextRunAt: Date | null;
  }[] = [];
  let dbReady = true;
  let agentTasks: AgentTaskRow[] = [];
  let automationRules: {
    id: string;
    key: string;
    displayName: string;
    enabled: boolean;
    schedule: string;
    safetyMode: string;
    sourceText: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastState: string | null;
  }[] = [];
  try {
    const workspace = await ensureWebWorkspace();
    registered = await prisma.cronSchedule.findMany({
      where: { workspaceId: workspace.id },
      select: { name: true, cron: true, enabled: true, lastRunState: true, nextRunAt: true },
    });
    const taskRows = await prisma.agentTask.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        prompt: true,
        cron: true,
        enabled: true,
        nextRunAt: true,
        lastRunAt: true,
        lastState: true,
      },
    });
    agentTasks = taskRows.map((task) => ({
      ...task,
      nextRunAt: task.nextRunAt
        ? formatDateTime(task.nextRunAt, { timeZone: pageDisplayTimeZone })
        : null,
      lastRunAt: task.lastRunAt
        ? formatDateTime(task.lastRunAt, { timeZone: pageDisplayTimeZone })
        : null,
    }));
    const ruleRows = await prisma.automationRule.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
      take: 50,
      select: {
        id: true,
        key: true,
        displayName: true,
        enabled: true,
        schedule: true,
        safetyMode: true,
        sourceText: true,
        nextRunAt: true,
        lastRunAt: true,
        lastState: true,
      },
    });
    automationRules = ruleRows.map((rule) => ({
      ...rule,
      nextRunAt: rule.nextRunAt
        ? formatDateTime(rule.nextRunAt, { timeZone: pageDisplayTimeZone })
        : null,
      lastRunAt: rule.lastRunAt
        ? formatDateTime(rule.lastRunAt, { timeZone: pageDisplayTimeZone })
        : null,
    }));
  } catch {
    dbReady = false;
  }

  const dbByName = new Map(registered.map((r) => [r.name, r]));
  const userVisiblePresets = CRON_PRESETS.filter((preset) =>
    [
      "github_poll",
      "daily_report",
      "today_report",
      "budget_guard",
      "budget_rebalance",
      "improvement_pr",
      "experiment_evaluate",
      "auto_creative_generation",
    ].includes(preset.name)
  );
  const rows: Row[] = userVisiblePresets.map((preset) => {
    const name = preset.name;
    const persisted = dbByName.get(name);
    return {
      name,
      cron: persisted?.cron ?? preset.cron,
      enabled: persisted?.enabled ?? false,
      lastRunState: persisted?.lastRunState ?? null,
      nextRunAt: persisted?.nextRunAt ?? null,
      description: preset.description,
      persistedFromDb: Boolean(persisted),
    };
  });
  const visibleRegisteredCount = rows.filter((row) => row.persistedFromDb).length;

  return (
    <>
      <PageHeader
        title="自動実行"
        subtitle="日次レポート、予算チェック、改善提案、自動クリエイティブ生成などを定期的に実行します。文章で新しい依頼も保存できます。"
        actions={
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Link href="/cron/runs" className="btn btn--ghost btn--sm">
              実行履歴
            </Link>
            <Link href="/cron/audit" className="btn btn--ghost btn--sm">
              操作履歴
            </Link>
          </div>
        }
      />

      <div className="page-body page-body--single">
        <CronRateLimitSummary />

        <Panel
          title="文章で追加する自動実行"
          subtitle="例: 毎朝、日次レポートを取得して問題があれば改善提案も作る。"
        >
          <AgentTaskForm tasks={agentTasks} />
        </Panel>

        <Panel
          title="承認済み運用ポリシー"
          subtitle="チャットから作成した policy PR が merge されると、ここに表示され、rule ごとの schedule で予約されます。"
        >
          <DataTable
            rows={automationRules}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="承認済みの運用ポリシーはまだありません。"
                description="チャットで「過去7日CPAが低いキャンペーン予算を20%上げるPRを毎朝作って」のように依頼すると、policy PR の作成と承認依頼まで進めます。"
              />
            }
            columns={[
              {
                header: "ルール",
                cell: (row) => (
                  <div>
                    <div>{row.displayName || row.key}</div>
                    <div className="muted">{row.sourceText ?? row.key}</div>
                  </div>
                ),
              },
              {
                header: "実行タイミング",
                cell: (row) => row.schedule || "—",
                className: "mono tabular",
              },
              {
                header: "承認モード",
                cell: (row) => <StatusBadge state={ruleModeState(row.safetyMode)}>{ruleModeLabel(row.safetyMode)}</StatusBadge>,
              },
              {
                header: "状態",
                cell: (row) => (
                  <StatusBadge state={row.enabled ? "ok" : "idle"}>
                    {row.enabled ? "有効" : "停止中"}
                  </StatusBadge>
                ),
              },
              {
                header: "次回",
                cell: (row) => row.nextRunAt ?? "—",
                className: "tabular mono",
              },
              {
                header: "前回",
                cell: (row) => row.lastState ?? "—",
              },
            ]}
          />
        </Panel>

        <Panel
          title="標準の自動実行"
          subtitle={
            dbReady
              ? `${visibleRegisteredCount} 件登録 / ${userVisiblePresets.length} 件利用可能`
              : "保存先を確認してください。"
          }
        >
          <DataTable
            rows={rows}
            rowKey={(row) => row.name}
            empty={
              <EmptyState
                title="登録済みのスケジュールはまだありません。"
                description="AdDroid を開始すると標準の自動実行が登録されます。"
              />
            }
            columns={[
              { header: "内容", cell: (row) => presetLabel(row.name) },
              {
                header: "実行タイミング",
                cell: (row) => row.cron,
                className: "mono tabular",
                headerClassName: "tabular",
              },
              { header: "説明", cell: (row) => row.description },
              {
                header: "状態",
                cell: (row) => (
                  <StatusBadge state={row.enabled ? "ok" : "idle"}>
                    {row.enabled ? "有効" : "停止中"}
                  </StatusBadge>
                ),
              },
              {
                header: "前回",
                cell: (row) => (
                  <StatusBadge
                    state={
                      row.lastRunState === "ok"
                        ? "ok"
                        : row.lastRunState === "warn"
                          ? "warn"
                          : row.lastRunState === "error"
                            ? "error"
                            : "idle"
                    }
                  >
                    {row.lastRunState ?? (row.persistedFromDb ? "未実行" : "未登録")}
                  </StatusBadge>
                ),
              },
              {
                header: "次回",
                cell: (row) =>
                  row.nextRunAt
                    ? formatDateTime(row.nextRunAt, { timeZone: pageDisplayTimeZone })
                    : "—",
                className: "tabular mono",
                headerClassName: "tabular",
              },
              {
                header: "操作",
                cell: (row) => (
                  <CronControls
                    presetName={row.name}
                    description={row.description}
                    initialEnabled={row.enabled}
                    initialCron={row.cron}
                    persistedFromDb={row.persistedFromDb}
                  />
                ),
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}

function ruleModeLabel(mode: string): string {
  if (mode === "auto_apply") return "policy一致で自動実行";
  if (mode === "report_only") return "記録のみ";
  return "PR作成";
}

function ruleModeState(mode: string): "ok" | "warn" | "idle" {
  if (mode === "auto_apply") return "ok";
  if (mode === "report_only") return "idle";
  return "warn";
}

function presetLabel(name: string): string {
  const labels: Record<string, string> = {
    daily_report: "日次レポート",
    today_report: "当日レポート",
    budget_guard: "予算チェック",
    budget_rebalance: "予算再配分",
    automation_rules: "自動運用ルール",
    improvement_pr: "改善提案",
    experiment_evaluate: "A/Bテスト評価",
    auto_creative_generation: "自動クリエイティブ生成",
    github_poll: "承認済み変更の確認",
    retention_cleanup: "古い履歴の整理",
  };
  return labels[name] ?? name;
}
