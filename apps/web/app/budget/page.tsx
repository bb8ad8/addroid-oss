// AdDroid OSS — Budget Guard page (the current implementation browser regression fix).
//
// Browser test scenario `budget-guard` は `/budget` に直接アクセスし、
//   (1) budget_guard rules と auto_pause_policy 状態が見えること
//   (2) policy 欠落 (= ops repo に workflows/budget-guard.yaml 無し)
//       が「fail-closed」として表現されていること
//   (3) dangerous changes が「approval-required」ラベルで識別できること
// を期待する。
//
// データソース:
//   - `cron_schedules`           → budget_guard プリセットの enable / cron 状態
//   - `cron_runs` (budget_guard) → 直近 run の summary (alerts / candidates /
//                                  classification / decision / dangerous cats)
//   - `ai_runs`   (budget_guard) → 直近 audit agent 実行の provider/model/decision
//
// 設計原則:
//   - ガードレール「No Placeholder Data」: ダミーデータを描かない。
//     データが無い場合は明示的な空状態 / fail-closed バナーを出す。
//   - ルール編集は ops repo (workflows/budget-guard.yaml) を介して行う。
//     Web UI はこの YAML を生成し、budget_guard preset の有効化だけを行う。
//   - sanitize-on-render: ai_runs の prompt/inputs/outputs は本ページでは
//     描画しない (一覧へのリンクは /ai を通じて辿らせる)。

import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { PageHeader } from "../../components/ui/PageHeader";
import {
  DataTable,
  type DataTableColumn,
} from "../../components/ui/DataTable";
import { Pagination } from "../../components/ui/Pagination";
import { EmptyState } from "../../components/ui/EmptyState";
import {
  KeyValueList,
  type KeyValueEntry,
} from "../../components/ui/KeyValueList";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { StatusDot, type StatusState } from "../../components/ui/StatusDot";
import { InlineCode } from "../../components/ui/CodeBlock";
import { CRON_PRESETS } from "@addroid/queue";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";
import { getPaginationState, paginationLabel } from "../../lib/pagination";
import { loadBudgetGuardPolicyConfig } from "../../../worker/src/lib/budget-guard-policy-config";
import { BudgetGuardPolicyForm } from "./BudgetGuardPolicyForm";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  runsPage?: string | string[];
  aiRunsPage?: string | string[];
}

type BudgetGuardRunStatus =
  | "succeeded"
  | "no_account"
  | "policy_missing"
  | "ai_failed";
type BudgetGuardClassification = "safe" | "requires_approval" | "dangerous";
type BudgetGuardDecision =
  | "auto_approved"
  | "approval_required"
  | "auto_blocked";
type BudgetGuardAlertRule =
  | "daily_budget_80"
  | "monthly_pace"
  | "day_over_day"
  | "no_conversions"
  | "auto_pause_policy";
type BudgetGuardAlertSeverity = "info" | "warn" | "trigger";

interface BudgetGuardAlert {
  rule: BudgetGuardAlertRule;
  severity: BudgetGuardAlertSeverity;
  message: string;
  observedValue: number;
  threshold: number;
}

interface BudgetGuardSummary {
  status: BudgetGuardRunStatus;
  workspaceId: string;
  accountKey: string;
  accountId: string | null;
  mode: string;
  aiRunId: string | null;
  classification: BudgetGuardClassification | null;
  decision: BudgetGuardDecision | null;
  dangerousCategories: string[];
  policyReasons: string[];
  candidateCount: number;
  alerts: BudgetGuardAlert[];
  errorMessage?: string;
}

type BudgetRebalanceRunStatus =
  | "succeeded"
  | "no_account"
  | "policy_missing"
  | "disabled"
  | "no_moves"
  | "pr_failed";

interface BudgetRebalanceMove {
  accountKey: string;
  nodeKey: string;
  displayName: string;
  direction: "increase" | "decrease";
  fromMajor: number;
  toMajor: number;
  deltaPercent: number;
  reason: string;
}

interface BudgetRebalanceSkipped {
  accountKey: string;
  nodeKey: string;
  reason: string;
}

interface BudgetRebalancePullRequest {
  prNumber: number;
  htmlUrl: string;
}

interface BudgetRebalanceAccountSummary {
  status: BudgetRebalanceRunStatus;
  accountKey: string;
  candidateCount: number;
  policyEnabled: boolean | null;
  window: { since: string; until: string } | null;
  moves: BudgetRebalanceMove[];
  skipped: BudgetRebalanceSkipped[];
  pullRequest: BudgetRebalancePullRequest | null;
  errorMessage?: string;
}

interface BudgetRebalanceRunSummary {
  status: string;
  accountsProcessed: number;
  succeeded: number;
  noMoves: number;
  disabled: number;
  policyMissing: number;
  prFailed: number;
  policyPath: string | null;
  accounts: BudgetRebalanceAccountSummary[];
}

interface CronRunRow {
  id: string;
  name: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

interface AiRunRow {
  id: string;
  agent: string;
  provider: string;
  model: string;
  status: string;
  decision: string | null;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  errorMessage: string | null;
  createdAt: Date;
}

interface ScheduleRow {
  name: string;
  cron: string;
  enabled: boolean;
  lastRunState: string | null;
  nextRunAt: Date | null;
}

interface AdAccountTimeZoneRow {
  workspaceId: string;
  key: string;
  timezoneName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

const VALID_STATUS = new Set<BudgetGuardRunStatus>([
  "succeeded",
  "no_account",
  "policy_missing",
  "ai_failed",
]);

const VALID_CLASSIFICATION = new Set<BudgetGuardClassification>([
  "safe",
  "requires_approval",
  "dangerous",
]);

const VALID_DECISION = new Set<BudgetGuardDecision>([
  "auto_approved",
  "approval_required",
  "auto_blocked",
]);

const VALID_ALERT_RULE = new Set<BudgetGuardAlertRule>([
  "daily_budget_80",
  "monthly_pace",
  "day_over_day",
  "no_conversions",
  "auto_pause_policy",
]);

const VALID_ALERT_SEVERITY = new Set<BudgetGuardAlertSeverity>([
  "info",
  "warn",
  "trigger",
]);

function readAlert(v: unknown): BudgetGuardAlert | null {
  if (!isRecord(v)) return null;
  if (typeof v.rule !== "string" || !VALID_ALERT_RULE.has(v.rule as BudgetGuardAlertRule)) {
    return null;
  }
  if (
    typeof v.severity !== "string" ||
    !VALID_ALERT_SEVERITY.has(v.severity as BudgetGuardAlertSeverity)
  ) {
    return null;
  }
  return {
    rule: v.rule as BudgetGuardAlertRule,
    severity: v.severity as BudgetGuardAlertSeverity,
    message: readString(v.message),
    observedValue: readNumber(v.observedValue),
    threshold: readNumber(v.threshold),
  };
}

function parseBudgetGuardSummary(output: unknown): BudgetGuardSummary | null {
  if (!isRecord(output)) return null;
  if (
    typeof output.status !== "string" ||
    !VALID_STATUS.has(output.status as BudgetGuardRunStatus) ||
    typeof output.workspaceId !== "string" ||
    typeof output.accountKey !== "string"
  ) {
    return null;
  }
  const classificationRaw = readString(output.classification);
  const classification =
    classificationRaw && VALID_CLASSIFICATION.has(classificationRaw as BudgetGuardClassification)
      ? (classificationRaw as BudgetGuardClassification)
      : null;
  const decisionRaw = readString(output.decision);
  const decision =
    decisionRaw && VALID_DECISION.has(decisionRaw as BudgetGuardDecision)
      ? (decisionRaw as BudgetGuardDecision)
      : null;
  const dangerousCategories = Array.isArray(output.dangerousCategories)
    ? output.dangerousCategories.filter((x): x is string => typeof x === "string")
    : [];
  const policyReasons = Array.isArray(output.policyReasons)
    ? output.policyReasons.filter((x): x is string => typeof x === "string")
    : [];
  const alerts = Array.isArray(output.alerts)
    ? output.alerts
        .map(readAlert)
        .filter((x): x is BudgetGuardAlert => x !== null)
    : [];
  return {
    status: output.status as BudgetGuardRunStatus,
    workspaceId: output.workspaceId,
    accountKey: output.accountKey,
    accountId: typeof output.accountId === "string" ? output.accountId : null,
    mode: readString(output.mode, "report_only"),
    aiRunId: typeof output.aiRunId === "string" ? output.aiRunId : null,
    classification,
    decision,
    dangerousCategories,
    policyReasons,
    candidateCount: readNumber(output.candidateCount),
    alerts,
    ...(typeof output.errorMessage === "string"
      ? { errorMessage: output.errorMessage }
      : {}),
  };
}

const VALID_REBALANCE_STATUS = new Set<BudgetRebalanceRunStatus>([
  "succeeded",
  "no_account",
  "policy_missing",
  "disabled",
  "no_moves",
  "pr_failed",
]);

function parseBudgetRebalanceRunSummary(output: unknown): BudgetRebalanceRunSummary | null {
  if (!isRecord(output)) return null;
  const accountsRaw = Array.isArray(output.accounts) ? output.accounts : [];
  const accounts = accountsRaw
    .map(parseBudgetRebalanceAccountSummary)
    .filter((x): x is BudgetRebalanceAccountSummary => x !== null);
  if (accounts.length === 0 && output.kind !== "budget_rebalance") return null;
  return {
    status: readString(output.status, "succeeded"),
    accountsProcessed: readNumber(output.accountsProcessed),
    succeeded: readNumber(output.succeeded),
    noMoves: readNumber(output.no_moves),
    disabled: readNumber(output.disabled),
    policyMissing: readNumber(output.policy_missing),
    prFailed: readNumber(output.pr_failed),
    policyPath: typeof output.policyPath === "string" ? output.policyPath : null,
    accounts,
  };
}

function parseBudgetRebalanceAccountSummary(
  output: unknown,
): BudgetRebalanceAccountSummary | null {
  if (!isRecord(output)) return null;
  if (
    typeof output.status !== "string" ||
    !VALID_REBALANCE_STATUS.has(output.status as BudgetRebalanceRunStatus) ||
    typeof output.accountKey !== "string"
  ) {
    return null;
  }
  const accountKey = output.accountKey;
  const plan = isRecord(output.plan) ? output.plan : null;
  const moves = Array.isArray(plan?.moves)
    ? plan.moves
        .map((move) => parseBudgetRebalanceMove(accountKey, move))
        .filter((x): x is BudgetRebalanceMove => x !== null)
    : [];
  const skipped = Array.isArray(plan?.skipped)
    ? plan.skipped
        .map((item) => parseBudgetRebalanceSkipped(accountKey, item))
        .filter((x): x is BudgetRebalanceSkipped => x !== null)
    : [];
  const pr = isRecord(output.pullRequest)
    ? {
        prNumber: readNumber(output.pullRequest.prNumber),
        htmlUrl: readString(output.pullRequest.htmlUrl),
      }
    : null;
  return {
    status: output.status as BudgetRebalanceRunStatus,
    accountKey,
    candidateCount: readNumber(output.candidateCount),
    policyEnabled:
      typeof output.policyEnabled === "boolean" ? output.policyEnabled : null,
    window: isRecord(output.window)
      ? {
          since: readString(output.window.since),
          until: readString(output.window.until),
        }
      : null,
    moves,
    skipped,
    pullRequest: pr && pr.prNumber > 0 && pr.htmlUrl ? pr : null,
    ...(typeof output.errorMessage === "string"
      ? { errorMessage: output.errorMessage }
      : {}),
  };
}

function parseBudgetRebalanceMove(
  accountKey: string,
  value: unknown,
): BudgetRebalanceMove | null {
  if (!isRecord(value)) return null;
  const direction = readString(value.direction);
  if (direction !== "increase" && direction !== "decrease") return null;
  return {
    accountKey,
    nodeKey: readString(value.nodeKey),
    displayName: readString(value.displayName, readString(value.nodeKey)),
    direction,
    fromMajor: readNumber(value.fromMajor),
    toMajor: readNumber(value.toMajor),
    deltaPercent: readNumber(value.deltaPercent),
    reason: readString(value.reason),
  };
}

function parseBudgetRebalanceSkipped(
  accountKey: string,
  value: unknown,
): BudgetRebalanceSkipped | null {
  if (!isRecord(value)) return null;
  const nodeKey = readString(value.nodeKey);
  const reason = readString(value.reason);
  if (!nodeKey || !reason) return null;
  return { accountKey, nodeKey, reason };
}

function cronStateToStatus(state: string): StatusState {
  switch (state) {
    case "success":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    default:
      return "idle";
  }
}

function cronStateLabel(state: string): string {
  const labels: Record<string, string> = {
    success: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
    ok: "成功",
    warn: "警告",
    error: "失敗",
  };
  return labels[state] ?? state;
}

function summaryStatusToState(status: BudgetGuardRunStatus): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "no_account":
      return "warn";
    case "policy_missing":
      return "error";
    case "ai_failed":
      return "error";
    default:
      return "idle";
  }
}

function summaryStatusLabel(status: BudgetGuardRunStatus): string {
  const labels: Record<BudgetGuardRunStatus, string> = {
    succeeded: "チェック済み",
    no_account: "対象なし",
    policy_missing: "ルール未設定",
    ai_failed: "AI判断失敗",
  };
  return labels[status] ?? status;
}

function rebalanceStatusToState(status: BudgetRebalanceRunStatus | string): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "no_moves":
    case "disabled":
      return "idle";
    case "no_account":
    case "policy_missing":
      return "warn";
    case "pr_failed":
      return "error";
    default:
      return "idle";
  }
}

function rebalanceStatusLabel(status: BudgetRebalanceRunStatus | string): string {
  const labels: Record<string, string> = {
    succeeded: "PR作成",
    no_account: "対象なし",
    policy_missing: "ポリシー未設定",
    disabled: "停止中",
    no_moves: "変更なし",
    pr_failed: "PR作成失敗",
    failed: "失敗",
  };
  return labels[status] ?? status;
}

function classificationToState(c: BudgetGuardClassification | null): StatusState {
  switch (c) {
    case "dangerous":
      return "error";
    case "requires_approval":
      return "warn";
    case "safe":
      return "idle";
    default:
      return "idle";
  }
}

function classificationLabel(c: BudgetGuardClassification | null): string {
  if (c === "dangerous") return "高リスク";
  if (c === "requires_approval") return "承認が必要";
  if (c === "safe") return "低リスク";
  return "—";
}

function decisionToState(d: BudgetGuardDecision | null): StatusState {
  switch (d) {
    case "auto_approved":
      return "idle";
    case "approval_required":
      return "warn";
    case "auto_blocked":
      return "error";
    default:
      return "idle";
  }
}

function decisionLabel(d: BudgetGuardDecision | null): string {
  if (d === "auto_approved") return "自動承認";
  if (d === "approval_required") return "承認が必要";
  if (d === "auto_blocked") return "自動ブロック";
  return "—";
}

function modeToState(mode: string): StatusState {
  switch (mode) {
    case "auto_apply":
      return "warn";
    case "proposal":
      return "info";
    case "report_only":
    default:
      return "idle";
  }
}

function severityLabel(severity: BudgetGuardAlertSeverity): string {
  if (severity === "trigger") return "対応が必要";
  if (severity === "warn") return "警告";
  return "情報";
}

function alertSeverityToState(severity: BudgetGuardAlertSeverity): StatusState {
  switch (severity) {
    case "trigger":
      return "error";
    case "warn":
      return "warn";
    case "info":
    default:
      return "info";
  }
}

function aiRunStatusState(status: string): StatusState {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "queued":
    default:
      return "idle";
  }
}

function aiRunStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    succeeded: "成功",
    failed: "失敗",
    running: "実行中",
    queued: "待機中",
  };
  return labels[status] ?? status;
}

function formatRatio(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function formatMajor(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatRule(rule: BudgetGuardAlertRule): string {
  switch (rule) {
    case "daily_budget_80":
      return "daily_budget";
    case "monthly_pace":
      return "monthly_pace";
    case "day_over_day":
      return "day_over_day";
    case "no_conversions":
      return "no_conversions";
    case "auto_pause_policy":
      return "auto_pause_policy";
  }
}

export default async function BudgetGuardPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  let runs: CronRunRow[] = [];
  let latestRunCandidates: CronRunRow[] = [];
  let latestRebalanceRun: CronRunRow | null = null;
  let aiRuns: AiRunRow[] = [];
  let runsTotal = 0;
  let aiRunsTotal = 0;
  let schedules: ScheduleRow[] = [];
  let rebalanceSchedule: ScheduleRow | null = null;
  let adAccountTimeZones: AdAccountTimeZoneRow[] = [];
  let policyConfig: Awaited<ReturnType<typeof loadBudgetGuardPolicyConfig>> | null = null;
  let dbReady = true;
  try {
    const workspace = await ensureWebWorkspace();
    const runsWhere = {
      name: "budget_guard",
      schedule: { is: { workspaceId: workspace.id } },
    };
    const aiRunsWhere = { workspaceId: workspace.id, workflow: "budget_guard" };
    [runsTotal, aiRunsTotal] = await Promise.all([
      prisma.cronRun.count({ where: runsWhere }),
      prisma.aiRun.count({ where: aiRunsWhere }),
    ]);
    const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", runsTotal);
    const aiRunsPagination = getPaginationState(
      resolvedSearchParams,
      "aiRunsPage",
      aiRunsTotal
    );
    const rebalanceRunsWhere = {
      name: "budget_rebalance",
      schedule: { is: { workspaceId: workspace.id } },
    };
    const [
      runsResult,
      latestRunCandidatesResult,
      aiRunsResult,
      schedulesResult,
      rebalanceRunsResult,
      rebalanceSchedulesResult,
      adAccountTimeZonesResult,
    ] = await Promise.all([
      prisma.cronRun.findMany({
        where: runsWhere,
        orderBy: { startedAt: "desc" },
        skip: runsPagination.skip,
        take: runsPagination.take,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.cronRun.findMany({
        where: runsWhere,
        orderBy: { startedAt: "desc" },
        take: 10,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.aiRun.findMany({
        where: aiRunsWhere,
        orderBy: { createdAt: "desc" },
        skip: aiRunsPagination.skip,
        take: aiRunsPagination.take,
        select: {
          id: true,
          agent: true,
          provider: true,
          model: true,
          status: true,
          decision: true,
          confidence: true,
          inputTokens: true,
          outputTokens: true,
          errorMessage: true,
          createdAt: true,
        },
      }),
      prisma.cronSchedule.findMany({
        where: { workspaceId: workspace.id, name: "budget_guard" },
        select: {
          name: true,
          cron: true,
          enabled: true,
          lastRunState: true,
          nextRunAt: true,
        },
      }),
      prisma.cronRun.findMany({
        where: rebalanceRunsWhere,
        orderBy: { startedAt: "desc" },
        take: 1,
        select: {
          id: true,
          name: true,
          state: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          errorMessage: true,
          output: true,
        },
      }),
      prisma.cronSchedule.findMany({
        where: { workspaceId: workspace.id, name: "budget_rebalance" },
        select: {
          name: true,
          cron: true,
          enabled: true,
          lastRunState: true,
          nextRunAt: true,
        },
      }),
      prisma.adAccount.findMany({
        where: { workspaceId: workspace.id, active: true },
        select: { workspaceId: true, key: true, timezoneName: true },
      }),
    ]);
    runs = runsResult;
    latestRunCandidates = latestRunCandidatesResult;
    aiRuns = aiRunsResult;
    schedules = schedulesResult;
    latestRebalanceRun = rebalanceRunsResult[0] ?? null;
    rebalanceSchedule = rebalanceSchedulesResult[0] ?? null;
    adAccountTimeZones = adAccountTimeZonesResult;
    policyConfig = await loadBudgetGuardPolicyConfig({
      prisma,
      workspaceId: workspace.id,
    }).catch(() => null);
  } catch {
    dbReady = false;
  }

  const parsedSummaries = latestRunCandidates
    .map((r) => ({ run: r, summary: parseBudgetGuardSummary(r.output) }))
    .filter(
      (x): x is { run: CronRunRow; summary: BudgetGuardSummary } =>
        x.summary !== null
    );

  const latestSummary = parsedSummaries[0] ?? null;
  const policyMissing = latestSummary?.summary.status === "policy_missing";

  // policy_missing は最新 run だけでなく履歴の中でも fail-closed として扱う
  // (ops repo に YAML 未配置のままになっている可能性を識別するため)。
  const anyPolicyMissing = parsedSummaries.some(
    ({ summary }) => summary.status === "policy_missing"
  );

  const runsCount = runsTotal;
  const aiRunsCount = aiRunsTotal;
  const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", runsTotal);
  const aiRunsPagination = getPaginationState(
    resolvedSearchParams,
    "aiRunsPage",
    aiRunsTotal
  );
  const scheduleRow = schedules[0] ?? null;
  const scheduleView: ScheduleRow | null = scheduleRow;
  const budgetPreset = CRON_PRESETS.find((preset) => preset.name === "budget_guard");
  const rebalancePreset = CRON_PRESETS.find((preset) => preset.name === "budget_rebalance");
  const timeZoneByAccount = new Map(
    adAccountTimeZones.map((row) => [`${row.workspaceId}:${row.key}`, row.timezoneName])
  );
  const accountTimeZone = (summary: BudgetGuardSummary | null): string | null =>
    summary ? timeZoneByAccount.get(`${summary.workspaceId}:${summary.accountKey}`) ?? null : null;
  const pageDisplayTimeZone = resolveDisplayTimeZone(accountTimeZone(latestSummary?.summary ?? null));
  const runTimeZone = (row: CronRunRow): string => {
    const summary = parseBudgetGuardSummary(row.output);
    return resolveDisplayTimeZone(accountTimeZone(summary), pageDisplayTimeZone);
  };

  const runColumns: DataTableColumn<CronRunRow>[] = [
    {
      header: "開始日時",
      cell: (row) => formatDateTime(row.startedAt, { timeZone: runTimeZone(row) }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "実行状態",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>
          {cronStateLabel(row.state)}
        </StatusBadge>
      ),
    },
    {
      header: "広告アカウント",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        return summary ? (
          <InlineCode>{summary.accountKey}</InlineCode>
        ) : (
          <span>—</span>
        );
      },
    },
    {
      header: "チェック結果",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary) return <span>—</span>;
        return (
          <StatusBadge state={summaryStatusToState(summary.status)}>
            {summaryStatusLabel(summary.status)}
          </StatusBadge>
        );
      },
    },
    {
      header: "リスク",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary || !summary.classification) return <span>—</span>;
        return (
          <StatusBadge state={classificationToState(summary.classification)}>
            {classificationLabel(summary.classification)}
          </StatusBadge>
        );
      },
    },
    {
      header: "判断",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        if (!summary || !summary.decision) return <span>—</span>;
        return (
          <StatusBadge state={decisionToState(summary.decision)}>
            {decisionLabel(summary.decision)}
          </StatusBadge>
        );
      },
    },
    {
      header: "アラート",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        return summary ? (
          <span className="tabular-nums">{summary.alerts.length}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "停止候補",
      cell: (row) => {
        const summary = parseBudgetGuardSummary(row.output);
        return summary ? (
          <span className="tabular-nums">{summary.candidateCount}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "所要時間",
      cell: (row) => (row.durationMs == null ? "—" : `${row.durationMs} ms`),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const alertColumns: DataTableColumn<BudgetGuardAlert>[] = [
    {
      header: "ルール",
      cell: (row) => <InlineCode>{formatRule(row.rule)}</InlineCode>,
    },
    {
      header: "重要度",
      cell: (row) => (
        <StatusBadge state={alertSeverityToState(row.severity)}>
          {severityLabel(row.severity)}
        </StatusBadge>
      ),
    },
    {
      header: "観測値",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.rule === "no_conversions"
            ? row.observedValue.toFixed(2)
            : formatRatio(row.observedValue)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "しきい値",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.rule === "no_conversions"
            ? row.threshold.toFixed(2)
            : formatRatio(row.threshold)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "内容",
      cell: (row) => row.message,
    },
  ];

  const aiRunColumns: DataTableColumn<AiRunRow>[] = [
    {
      header: "作成日時",
      cell: (row) => formatDateTime(row.createdAt, { timeZone: pageDisplayTimeZone }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "担当",
      cell: (row) => <InlineCode>{row.agent}</InlineCode>,
    },
    {
      header: "AIモデル",
      cell: (row) => (
        <InlineCode>
          {row.provider}/{row.model}
        </InlineCode>
      ),
    },
    {
      header: "状態",
      cell: (row) => (
        <StatusBadge state={aiRunStatusState(row.status)}>
          {aiRunStatusLabel(row.status)}
        </StatusBadge>
      ),
    },
    {
      header: "判断",
      cell: (row) =>
        row.decision ? (
          <StatusBadge
            state={decisionToState(
              VALID_DECISION.has(row.decision as BudgetGuardDecision)
                ? (row.decision as BudgetGuardDecision)
                : null
            )}
          >
            {row.decision && VALID_DECISION.has(row.decision as BudgetGuardDecision)
              ? decisionLabel(row.decision as BudgetGuardDecision)
              : row.decision}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "信頼度",
      cell: (row) =>
        row.confidence === null ? (
          <span>—</span>
        ) : (
          <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
            {row.confidence.toFixed(2)}
          </span>
        ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "利用量",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const rebalanceSummary = latestRebalanceRun
    ? parseBudgetRebalanceRunSummary(latestRebalanceRun.output)
    : null;
  const rebalanceMoves = rebalanceSummary
    ? rebalanceSummary.accounts.flatMap((account) => account.moves)
    : [];
  const rebalanceSkipped = rebalanceSummary
    ? rebalanceSummary.accounts.flatMap((account) => account.skipped)
    : [];
  const latestRebalancePr =
    rebalanceSummary?.accounts.find((account) => account.pullRequest)?.pullRequest ??
    null;
  const rebalanceItems: KeyValueEntry[] = [
    {
      label: "ポリシー",
      value: (
        <InlineCode>
          {rebalanceSummary?.policyPath ??
            (policyConfig?.rootDir ? "workflows/budget-rebalance.yaml" : "未接続")}
        </InlineCode>
      ),
    },
    {
      label: "自動実行",
      value: rebalanceSchedule ? (
        <StatusBadge state={rebalanceSchedule.enabled ? "ok" : "idle"}>
          {rebalanceSchedule.enabled ? "有効" : "停止中"}
        </StatusBadge>
      ) : (
        <span>未登録</span>
      ),
    },
    {
      label: "実行タイミング",
      value: (
        <InlineCode>
          {rebalanceSchedule?.cron || rebalancePreset?.cron || "0 10 * * 2"}
        </InlineCode>
      ),
    },
    {
      label: "直近結果",
      value: rebalanceSummary ? (
        <StatusBadge state={rebalanceStatusToState(rebalanceSummary.status)}>
          {rebalanceStatusLabel(rebalanceSummary.status)}
        </StatusBadge>
      ) : (
        <span>未実行</span>
      ),
    },
    {
      label: "対象アカウント",
      value: (
        <span className="tabular-nums">
          {rebalanceSummary?.accountsProcessed ?? 0}
        </span>
      ),
    },
    {
      label: "変更案",
      value: (
        <span className="tabular-nums">{rebalanceMoves.length}</span>
      ),
    },
    {
      label: "スキップ",
      value: (
        <span className="tabular-nums">{rebalanceSkipped.length}</span>
      ),
    },
    {
      label: "PR",
      value: latestRebalancePr ? (
        <a href={latestRebalancePr.htmlUrl} target="_blank" rel="noreferrer">
          #{latestRebalancePr.prNumber}
        </a>
      ) : (
        <span>—</span>
      ),
    },
  ];

  const rebalanceMoveColumns: DataTableColumn<BudgetRebalanceMove>[] = [
    {
      header: "広告アカウント",
      cell: (row) => <InlineCode>{row.accountKey}</InlineCode>,
    },
    {
      header: "広告セット",
      cell: (row) => row.displayName || <InlineCode>{row.nodeKey}</InlineCode>,
    },
    {
      header: "方向",
      cell: (row) => (
        <StatusBadge state={row.direction === "increase" ? "warn" : "info"}>
          {row.direction === "increase" ? "増額" : "減額"}
        </StatusBadge>
      ),
    },
    {
      header: "日予算",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {formatMajor(row.fromMajor)} → {formatMajor(row.toMajor)}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "差分",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.deltaPercent}%
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "理由",
      cell: (row) => row.reason,
    },
  ];

  const rebalanceSkippedColumns: DataTableColumn<BudgetRebalanceSkipped>[] = [
    {
      header: "広告アカウント",
      cell: (row) => <InlineCode>{row.accountKey}</InlineCode>,
    },
    {
      header: "対象",
      cell: (row) => <InlineCode>{row.nodeKey}</InlineCode>,
    },
    {
      header: "理由",
      cell: (row) => <InlineCode>{row.reason}</InlineCode>,
    },
  ];

  const policyStateState: StatusState = !dbReady
    ? "warn"
    : !latestSummary
      ? "idle"
      : policyMissing
        ? "error"
        : "ok";
  const policyStateLabel = !dbReady
    ? "要確認"
    : !latestSummary
      ? "未実行"
      : policyMissing
        ? "ルール未設定"
        : "設定済み";

  const latestSummaryItems: KeyValueEntry[] = latestSummary
    ? [
        {
          label: "広告アカウント",
          value: <InlineCode>{latestSummary.summary.accountKey}</InlineCode>,
        },
        {
          label: "チェック結果",
          value: (
            <StatusBadge state={summaryStatusToState(latestSummary.summary.status)}>
              {summaryStatusLabel(latestSummary.summary.status)}
            </StatusBadge>
          ),
        },
        {
          label: "実行モード",
          value: (
            <StatusBadge state={modeToState(latestSummary.summary.mode)}>
              {latestSummary.summary.mode}
            </StatusBadge>
          ),
        },
        {
          label: "リスク",
          value: latestSummary.summary.classification ? (
            <StatusBadge
              state={classificationToState(latestSummary.summary.classification)}
            >
              {classificationLabel(latestSummary.summary.classification)}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "判断",
          value: latestSummary.summary.decision ? (
            <StatusBadge state={decisionToState(latestSummary.summary.decision)}>
              {decisionLabel(latestSummary.summary.decision)}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "停止候補",
          value: (
            <span className="tabular-nums">
              {latestSummary.summary.candidateCount}
            </span>
          ),
        },
        {
          label: "注意が必要な変更",
          value:
            latestSummary.summary.dangerousCategories.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {latestSummary.summary.dangerousCategories.join(", ")}
              </span>
            ),
        },
        {
          label: "AI実行ID",
          value: latestSummary.summary.aiRunId ? (
            <InlineCode>{latestSummary.summary.aiRunId}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  const scheduleItems: KeyValueEntry[] = scheduleView
    ? [
        {
          label: "実行タイミング",
          value: <InlineCode>{scheduleView.cron || "(unscheduled)"}</InlineCode>,
        },
        {
          label: "状態",
          value: (
            <StatusBadge state={scheduleView.enabled ? "ok" : "idle"}>
              {scheduleView.enabled ? "有効" : "停止中"}
            </StatusBadge>
          ),
        },
        {
          label: "前回",
          value: scheduleView.lastRunState ? (
            <StatusBadge
              state={
                scheduleView.lastRunState === "ok"
                  ? "ok"
                  : scheduleView.lastRunState === "warn"
                    ? "warn"
                    : scheduleView.lastRunState === "error"
                      ? "error"
                      : "idle"
              }
            >
              {cronStateLabel(scheduleView.lastRunState)}
            </StatusBadge>
          ) : (
            <span>未実行</span>
          ),
        },
        {
          label: "次回",
          value: scheduleView.nextRunAt ? (
            <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {formatDateTime(scheduleView.nextRunAt, { timeZone: pageDisplayTimeZone })}
            </span>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="予算チェック"
        subtitle={
          <>
            予算超過、月間ペース、急な変化、成果なしを確認します。
            ルールが未設定のときや危険な変更は、Meta を直接変更せず人の承認を待ちます。
          </>
        }
      />

      <div className="page-body page-body--single">
        {policyMissing || anyPolicyMissing ? (
          <div
            role="alert"
            style={{
              border: "1px solid var(--color-status-error)",
              background: "var(--color-status-error-subtle)",
              color: "var(--color-text-primary)",
              borderRadius: "var(--radius-md)",
              padding: "0.875rem 1rem",
              marginBottom: "1rem",
              display: "grid",
              gap: "0.25rem",
            }}
            data-testid="budget-guard-fail-closed"
          >
            <div style={{ fontWeight: 600 }}>
              予算チェックのルールが未設定です
            </div>
            <div style={{ fontSize: "0.8125rem" }}>
              ルールが見つからない間は、AI判断もMetaへの変更も行いません。
              設定が必要な場合は接続と健康状態、またはGitHub連携を確認してください。
            </div>
          </div>
        ) : null}

        <Panel
          title="ルール設定"
          subtitle="広告アカウントごとの予算、アラート条件、定期実行を保存します。"
        >
          {policyConfig?.rootDir ? null : (
            <div
              className="banner"
              data-state="warn"
              style={{ marginBottom: "1rem" }}
            >
              <strong>ops repo のローカル checkout が見つかりません。</strong>
              <span>GitHub 連携を確認してから保存してください。</span>
            </div>
          )}
          <BudgetGuardPolicyForm
            accounts={
              policyConfig?.accounts.map((account) => ({
                key: account.key,
                displayName: account.displayName,
                currency: account.currency,
              })) ?? []
            }
            policy={policyConfig?.policy ?? null}
            initialCron={scheduleView?.cron ?? budgetPreset?.cron ?? "30 9 * * *"}
            initialEnabled={scheduleView?.enabled ?? false}
            disabled={!dbReady || !policyConfig?.rootDir}
          />
        </Panel>

        <Panel
          title="ルールの状態"
          subtitle="予算・月間ペース・急な変化・成果なし・自動停止候補を確認します"
          status={
            <StatusDot state={policyStateState}>{policyStateLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="予算チェックを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !latestSummary ? (
            <EmptyState
              title="予算チェックはまだ実行されていません"
              description="予算条件を含むカスタム自動実行を作成すると、ここにアラートと判断結果が表示されます。"
            />
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList items={latestSummaryItems} />
              {latestSummary.summary.policyReasons.length > 0 ? (
                <div>
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
                    判断理由
                  </div>
                  <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                    {latestSummary.summary.policyReasons.map((r, idx) => (
                      <li key={idx}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {latestSummary.summary.errorMessage ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-status-error)",
                  }}
                >
                  {latestSummary.summary.errorMessage}
                </div>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="自動実行の状態"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : scheduleView
                ? "予算チェックの定期実行"
                : "予算チェックの自動実行は未登録"
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : !scheduleView
                    ? "idle"
                    : scheduleView.enabled
                      ? "ok"
                      : "idle"
              }
            >
              {!dbReady
                ? "warn"
                : !scheduleView
                  ? "未登録"
                  : scheduleView.enabled
                    ? "on"
                    : "off"}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="自動実行の状態を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !scheduleView ? (
            <EmptyState
              title="予算チェックの自動実行はまだ登録されていません"
              description="AdDroid を開始すると標準の自動実行が登録されます。"
            />
          ) : (
            <KeyValueList items={scheduleItems} />
          )}
        </Panel>

        <Panel
          title="予算再配分"
          subtitle="CPA 効率を見て広告セット間の日予算移動案を GitOps PR として提案します"
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : rebalanceSummary
                    ? rebalanceStatusToState(rebalanceSummary.status)
                    : rebalanceSchedule?.enabled
                      ? "info"
                      : "idle"
              }
            >
              {!dbReady
                ? "要確認"
                : rebalanceSummary
                  ? rebalanceStatusLabel(rebalanceSummary.status)
                  : rebalanceSchedule?.enabled
                    ? "待機中"
                    : "停止中"}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="予算再配分の状態を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              <KeyValueList items={rebalanceItems} />
              {latestRebalanceRun ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  直近実行:{" "}
                  <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                    {formatDateTime(latestRebalanceRun.startedAt, {
                      timeZone: pageDisplayTimeZone,
                    })}
                  </span>
                  {latestRebalanceRun.errorMessage
                    ? ` · ${latestRebalanceRun.errorMessage}`
                    : ""}
                </div>
              ) : null}
              <DataTable
                rows={rebalanceMoves}
                rowKey={(row, index) => `${row.accountKey}:${row.nodeKey}:${index}`}
                columns={rebalanceMoveColumns}
                empty={
                  <EmptyState
                    title="直近の再配分案はありません"
                    description="ポリシーが有効で、十分な成果データと移動元・移動先がある場合だけPRを作成します。"
                  />
                }
              />
              {rebalanceSkipped.length > 0 ? (
                <DataTable
                  rows={rebalanceSkipped}
                  rowKey={(row, index) => `${row.accountKey}:${row.nodeKey}:${index}`}
                  columns={rebalanceSkippedColumns}
                  empty={null}
                />
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="最新アラート"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : latestSummary
                ? `しきい値を超えた項目 · ${latestSummary.summary.alerts.length} 件`
                : "直近の実行なし"
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : !latestSummary
                    ? "idle"
                    : latestSummary.summary.alerts.length === 0
                      ? "ok"
                      : "warn"
              }
            >
              {!dbReady
                ? "warn"
                : !latestSummary
                  ? "idle"
                  : latestSummary.summary.alerts.length === 0
                    ? "アラートなし"
                    : `${latestSummary.summary.alerts.length} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="アラートを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !latestSummary ? (
            <EmptyState
              title="アラートはまだありません"
              description="予算チェックが実行されると、しきい値判定結果が表示されます。"
            />
          ) : (
            <DataTable
              rows={latestSummary.summary.alerts}
              rowKey={(_row, index) => `${latestSummary.run.id}:${index}`}
              columns={alertColumns}
              empty={
                <EmptyState
                  title="このランではアラートは発生していません"
                  description="ポリシーで設定したしきい値を超える観測は検出されませんでした。"
                />
              }
            />
          )}
        </Panel>

        <Panel
          title="実行履歴"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : paginationLabel(runsPagination)
          }
          status={
            <StatusDot state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}>
              {!dbReady ? "要確認" : runsCount === 0 ? "未実行" : `${runsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="予算チェックの実行履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <div>
              <DataTable
                rows={runs}
                rowKey={(row) => row.id}
                columns={runColumns}
                empty={
                  <EmptyState
                    title="予算チェックはまだ実行されていません"
                    description="自動実行を有効化すると、各回の状態・判断・アラートがここに記録されます。"
                  />
                }
              />
              <Pagination
                basePath="/budget"
                searchParams={resolvedSearchParams}
                pageParam="runsPage"
                state={runsPagination}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="AI判断履歴"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : paginationLabel(aiRunsPagination)
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : aiRunsCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "要確認"
                : aiRunsCount === 0
                  ? "未実行"
                  : `${aiRunsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="AI判断履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <div>
              <DataTable
                rows={aiRuns}
                rowKey={(row) => row.id}
                columns={aiRunColumns}
                empty={
                  <EmptyState
                    title="AI判断履歴はまだありません"
                    description="予算チェックが実行されると、判断結果とコストの概要がここに保存されます。"
                  />
                }
              />
              <Pagination
                basePath="/budget"
                searchParams={resolvedSearchParams}
                pageParam="aiRunsPage"
                state={aiRunsPagination}
              />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
