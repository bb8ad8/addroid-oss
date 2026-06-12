// AdDroid OSS — Improvements page (the current implementation browser regression fix).
//
// Browser test scenario `improvement-pr-workflow` は `/improvements` に直接
// アクセスし、(1) improvement_pr workflow の状態が見える、(2) record が
// あれば AI rationale / risk / dry-run フィールドが見える、(3) AI が PR 承認を
// 迂回できる導線が UI 上に存在しない、を期待する。
//
// データソース:
//   - `cron_schedules`            → improvement_pr プリセットの enable / cron 状態
//   - `cron_runs` (improvement_pr) → 直近 cron tick の集計 (accountsProcessed /
//                                    succeeded / skipped_no_proposal /
//                                    auto_blocked / ai_failed / pr_failed)
//   - `audit_logs` (improvement_pr.opened|skipped|failed)
//                                  → per-account の最終ステータスと PR・
//                                    classification / dangerous categories /
//                                    budget impact / dry-run validation を含む
//                                    metadata (improvement-pr-runtime.ts で
//                                    sanitize 済みで書き込まれる)
//   - `ai_runs` (workflow="improvement_pr")
//                                  → 8 段パイプライン (analyst → ... → audit)
//                                    の provider / model / decision /
//                                    confidence / tokens
//
// 設計原則:
//   - ガードレール「No Placeholder Data」: ダミーデータを描かない。
//     データが無ければ明示的な空状態 / fail-closed バナーを出す。
//   - ガードレール「No Dead UI」: 本ページは read-only。改善 PR は ops repo の
//     workflow / AI ワークフローを介して生成される設計境界のため、UI 側に
//     「Adhoc 起動」「PR 承認」「Meta 反映」ボタンを置かない。
//   - 承認境界: AI は Meta を直接変更しない。改善は必ず GitHub PR を経由し、
//     dangerous categories (budget_increase / new_campaign / targeting_change /
//     monthly_budget_change / automation_rule_change) は approval_required で
//     人間の merge を待つ。本ページはその境界を明示するコピーを page-header
//     subtitle と承認境界カードの 2 箇所で出す。

import Link from "next/link";
import type { ReactNode } from "react";
import {
  buildProposalFeedbackDigest,
  REJECTION_REASON_LABELS_JA,
  REJECTION_REASONS,
  type ProposalFeedbackDigest,
  type RejectionReason,
} from "@addroid/queue";
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
import { RunCronButton } from "../../components/RunCronButton";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { ensureWebWorkspace } from "../../lib/github-runtime";
import { getPaginationState, paginationLabel } from "../../lib/pagination";
import { firstSearchParamOrNull } from "../../lib/search-params";
import { createPrismaProposalFeedbackStore } from "../../../worker/src/lib/proposal-feedback-runtime";

export const dynamic = "force-dynamic";

interface SearchParamsInput {
  auditId?: string | string[];
  proposalsPage?: string | string[];
  runsPage?: string | string[];
  aiRunsPage?: string | string[];
}

type ImprovementPrClassification = "safe" | "requires_approval" | "dangerous";
type ImprovementPrAuditDecision =
  | "auto_approved"
  | "approval_required"
  | "auto_blocked";
type ImprovementPrAction =
  | "improvement_pr.opened"
  | "improvement_pr.skipped"
  | "improvement_pr.failed";

const VALID_ACTIONS = new Set<ImprovementPrAction>([
  "improvement_pr.opened",
  "improvement_pr.skipped",
  "improvement_pr.failed",
]);

const VALID_CLASSIFICATION = new Set<ImprovementPrClassification>([
  "safe",
  "requires_approval",
  "dangerous",
]);

const VALID_AUDIT_DECISION = new Set<ImprovementPrAuditDecision>([
  "auto_approved",
  "approval_required",
  "auto_blocked",
]);

interface CronRunRow {
  id: string;
  state: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  output: unknown;
}

interface CronRunAggregate {
  accountsProcessed: number;
  succeeded: number;
  skipped_no_proposal: number;
  auto_blocked: number;
  ai_failed: number;
  pr_failed: number;
  no_account: number;
  llmProvider: string | null;
  note: string | null;
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

interface AiRunDetailRow {
  id: string;
  agent: string;
  outputs: unknown;
}

interface AuditRow {
  id: string;
  workspaceId: string | null;
  action: string;
  target: string | null;
  ref: string | null;
  metadata: unknown;
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

interface ParsedAuditMetadata {
  accountKey: string | null;
  accountId: string | null;
  aiRunIds: string[];
  classification: ImprovementPrClassification | null;
  auditDecision: ImprovementPrAuditDecision | null;
  dangerousCategories: string[];
  skippedAt: string | null;
  recommendation: string | null;
  issues: ImprovementIssue[];
  proposals: ImprovementProposalDetail[];
  mediaBuyerRationale: string | null;
  dryRunSummary: string | null;
  proposalCount: number | null;
  fileCount: number | null;
  budgetImpact: BudgetImpact | null;
  planValidation: PlanValidation | null;
  snapshotIds: string[];
  mode: string | null;
  prNumber: number | null;
  htmlUrl: string | null;
  headSha: string | null;
  summary: string | null;
}

interface ImprovementProposalDetail {
  hierarchy: "account" | "campaign" | "adset" | "ad" | "unknown";
  target: string;
  category: string;
  proposedChange: string;
  rationale: string;
}

interface ImprovementIssue {
  severity: string;
  category: string;
  message: string;
}

interface BudgetImpact {
  deltaCurrency: number;
  afterCurrency: number;
  notes: string;
}

interface ProposalGroup {
  key: string;
  label: string;
  proposals: ImprovementProposalDetail[];
}

interface PlanValidation {
  available: boolean;
  ok: boolean;
  risk: string;
  summary: string;
  counts: {
    creates: number;
    updates: number;
    deletes: number;
    errors: number;
    warnings: number;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readString(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" ? v : fallback;
}

function parseCronRunAggregate(output: unknown): CronRunAggregate | null {
  if (!isRecord(output)) return null;
  // accountsProcessed は必須。これが無ければ improvement_pr aggregate ではない。
  if (typeof output.accountsProcessed !== "number") return null;
  return {
    accountsProcessed: readNumber(output.accountsProcessed),
    succeeded: readNumber(output.succeeded),
    skipped_no_proposal: readNumber(output.skipped_no_proposal),
    auto_blocked: readNumber(output.auto_blocked),
    ai_failed: readNumber(output.ai_failed),
    pr_failed: readNumber(output.pr_failed),
    no_account: readNumber(output.no_account),
    llmProvider: readString(output.llmProvider),
    note: readString(output.note),
  };
}

function parseAuditMetadata(metadata: unknown): ParsedAuditMetadata {
  const m = isRecord(metadata) ? metadata : {};
  const classificationRaw = readString(m.classification) ?? "";
  const classification = VALID_CLASSIFICATION.has(
    classificationRaw as ImprovementPrClassification
  )
    ? (classificationRaw as ImprovementPrClassification)
    : null;
  const auditDecisionRaw = readString(m.auditDecision) ?? "";
  const auditDecision = VALID_AUDIT_DECISION.has(
    auditDecisionRaw as ImprovementPrAuditDecision
  )
    ? (auditDecisionRaw as ImprovementPrAuditDecision)
    : null;
  const dangerousCategories = Array.isArray(m.dangerousCategories)
    ? m.dangerousCategories.filter((x): x is string => typeof x === "string")
    : [];
  const snapshotIds = Array.isArray(m.snapshotIds)
    ? m.snapshotIds.filter((x): x is string => typeof x === "string")
    : [];
  const aiRunIds = Array.isArray(m.aiRunIds)
    ? m.aiRunIds.filter((x): x is string => typeof x === "string")
    : [];
  const proposals = parseProposalDetails(m.proposals);

  let budgetImpact: BudgetImpact | null = null;
  if (isRecord(m.budgetImpact)) {
    budgetImpact = {
      deltaCurrency: readNumber(m.budgetImpact.deltaCurrency),
      afterCurrency: readNumber(m.budgetImpact.afterCurrency),
      notes: readString(m.budgetImpact.notes) ?? "",
    };
  }

  let planValidation: PlanValidation | null = null;
  if (isRecord(m.planValidation)) {
    const pv = m.planValidation;
    const counts = isRecord(pv.counts)
      ? {
          creates: readNumber(pv.counts.creates),
          updates: readNumber(pv.counts.updates),
          deletes: readNumber(pv.counts.deletes),
          errors: readNumber(pv.counts.errors),
          warnings: readNumber(pv.counts.warnings),
        }
      : null;
    planValidation = {
      available: Boolean(pv.available),
      ok: Boolean(pv.ok),
      risk: readString(pv.risk) ?? "ok",
      summary: readString(pv.summary) ?? "",
      counts,
    };
  }

  return {
    accountKey: readString(m.accountKey),
    accountId: readString(m.accountId),
    aiRunIds,
    classification,
    auditDecision,
    dangerousCategories,
    skippedAt: readString(m.skippedAt),
    recommendation: readString(m.recommendation),
    issues: parseImprovementIssues(m.issues),
    proposals,
    mediaBuyerRationale: readString(m.mediaBuyerRationale),
    dryRunSummary: readString(m.dryRunSummary),
    proposalCount: readNullableNumber(m.proposalCount),
    fileCount: readNullableNumber(m.fileCount),
    budgetImpact,
    planValidation,
    snapshotIds,
    mode: readString(m.mode),
    prNumber: readNullableNumber(m.prNumber),
    htmlUrl: readString(m.htmlUrl),
    headSha: readString(m.headSha),
    summary: readString(m.summary),
  };
}

function parseImprovementIssues(value: unknown): ImprovementIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const message = readString(item.message) ?? "";
    const category = readString(item.category) ?? "";
    const severity = readString(item.severity) ?? "";
    if (!message && !category && !severity) return [];
    return [{ message, category, severity }];
  });
}

function parseProposalDetails(value: unknown): ImprovementProposalDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const hierarchyRaw = readString(item.hierarchy) ?? "unknown";
    const hierarchy =
      hierarchyRaw === "account" ||
      hierarchyRaw === "campaign" ||
      hierarchyRaw === "adset" ||
      hierarchyRaw === "ad"
        ? hierarchyRaw
        : "unknown";
    const target = readString(item.target) ?? "";
    const category = readString(item.category) ?? "";
    const proposedChange = readString(item.proposedChange) ?? "";
    const rationale = readString(item.rationale) ?? "";
    if (!target && !category && !proposedChange && !rationale) return [];
    return [{ hierarchy, target, category, proposedChange, rationale }];
  });
}

function parseAnalystOutput(outputs: unknown): {
  proposals: ImprovementProposalDetail[];
  rationale: string | null;
} {
  if (!isRecord(outputs)) return { proposals: [], rationale: null };
  const proposals = Array.isArray(outputs.topImprovements)
    ? outputs.topImprovements.flatMap((item) => {
        if (!isRecord(item)) return [];
        const hierarchyRaw = readString(item.hierarchy) ?? "unknown";
        const hierarchy: ImprovementProposalDetail["hierarchy"] =
          hierarchyRaw === "account" ||
          hierarchyRaw === "campaign" ||
          hierarchyRaw === "adset" ||
          hierarchyRaw === "ad"
            ? hierarchyRaw
            : "unknown";
        const target = readString(item.target) ?? "";
        const rationale = readString(item.rationale) ?? "";
        const expectedImpact = readString(item.expectedImpact) ?? "";
        if (!target && !rationale && !expectedImpact) return [];
        return [
          {
            hierarchy,
            target,
            category: "analysis",
            proposedChange: expectedImpact,
            rationale,
          },
        ];
      })
    : [];
  return {
    proposals,
    rationale: readString(outputs.commentary),
  };
}

function parseMediaBuyerOutput(outputs: unknown): {
  proposals: ImprovementProposalDetail[];
  rationale: string | null;
  dryRunSummary: string | null;
  budgetImpact: BudgetImpact | null;
} {
  if (!isRecord(outputs)) {
    return {
      proposals: [],
      rationale: null,
      dryRunSummary: null,
      budgetImpact: null,
    };
  }
  let budgetImpact: BudgetImpact | null = null;
  if (isRecord(outputs.budgetImpact)) {
    budgetImpact = {
      deltaCurrency: readNumber(outputs.budgetImpact.deltaCurrency),
      afterCurrency: readNumber(outputs.budgetImpact.afterCurrency),
      notes: readString(outputs.budgetImpact.notes) ?? "",
    };
  }
  return {
    proposals: parseProposalDetails(outputs.proposals),
    rationale: readString(outputs.rationale),
    dryRunSummary: readString(outputs.dryRunSummary),
    budgetImpact,
  };
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

function actionToState(action: ImprovementPrAction): StatusState {
  switch (action) {
    case "improvement_pr.opened":
      return "ok";
    case "improvement_pr.skipped":
      return "idle";
    case "improvement_pr.failed":
      return "error";
  }
}

function classificationToState(
  c: ImprovementPrClassification | null
): StatusState {
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

function auditDecisionToState(
  d: ImprovementPrAuditDecision | null
): StatusState {
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

function modeToState(mode: string | null): StatusState {
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

function planRiskToState(risk: string): StatusState {
  switch (risk) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function formatBudgetDelta(impact: BudgetImpact): string {
  const sign = impact.deltaCurrency > 0 ? "+" : impact.deltaCurrency < 0 ? "" : "±";
  return `${sign}${impact.deltaCurrency.toFixed(2)} → ${impact.afterCurrency.toFixed(2)}`;
}

function actionLabel(action: ImprovementPrAction): string {
  switch (action) {
    case "improvement_pr.opened":
      return "PR作成";
    case "improvement_pr.skipped":
      return "PR未作成";
    case "improvement_pr.failed":
      return "失敗";
  }
}

function classificationLabel(c: ImprovementPrClassification | null): string {
  switch (c) {
    case "dangerous":
      return "要注意";
    case "requires_approval":
      return "承認が必要";
    case "safe":
      return "低リスク";
    default:
      return "未判定";
  }
}

function auditDecisionLabel(d: ImprovementPrAuditDecision | null): string {
  switch (d) {
    case "auto_approved":
      return "自動承認可";
    case "approval_required":
      return "承認待ち";
    case "auto_blocked":
      return "自動ブロック";
    default:
      return "未判定";
  }
}

function cronStateLabel(state: string): string {
  switch (state) {
    case "ok":
    case "success":
      return "成功";
    case "error":
    case "failed":
      return "失敗";
    case "warn":
      return "要確認";
    case "running":
      return "実行中";
    case "queued":
      return "待機中";
    default:
      return state;
  }
}

function aiRunStatusLabel(status: string): string {
  switch (status) {
    case "succeeded":
      return "成功";
    case "failed":
      return "失敗";
    case "running":
      return "実行中";
    case "queued":
      return "待機中";
    default:
      return status;
  }
}

function agentLabel(agent: string): string {
  const labels: Record<string, string> = {
    analyst: "分析",
    strategy: "戦略",
    copy: "文言",
    image_prompt: "画像案",
    creative_qa: "クリエイティブ確認",
    media_buyer: "改善判断",
    gitops: "PR作成準備",
    audit: "安全確認",
  };
  return labels[agent] ?? agent;
}

function decisionLabel(decision: string): string {
  const labels: Record<string, string> = {
    propose: "提案あり",
    skip_no_proposal: "提案なし",
    approve: "承認可",
    reject: "却下",
    request_changes: "要修正",
    report_only: "確認のみ",
    auto_approved: "自動承認可",
    approval_required: "承認待ち",
    auto_blocked: "自動ブロック",
  };
  return labels[decision] ?? decision;
}

function hierarchyLabel(value: ImprovementProposalDetail["hierarchy"]): string {
  switch (value) {
    case "account":
      return "アカウント";
    case "campaign":
      return "キャンペーン";
    case "adset":
      return "広告セット";
    case "ad":
      return "広告";
    default:
      return "対象";
  }
}

function proposalCategoryLabel(value: string): string {
  if (!value) return "改善提案";
  const labels: Record<string, string> = {
    budget_increase: "予算増額",
    budget_decrease: "予算減額",
    budget_shift: "予算配分変更",
    bid_change: "入札調整",
    targeting_change: "ターゲット変更",
    creative_refresh: "クリエイティブ改善",
    copy_change: "文言改善",
    pause: "停止提案",
    new_campaign: "新規キャンペーン",
    monthly_budget_change: "月予算変更",
    analysis: "分析候補",
  };
  return labels[value] ?? value.replaceAll("_", " ");
}

function proposalRejectionReasonLabel(value: string | null): string {
  if (!value) return "—";
  if (REJECTION_REASONS.includes(value as RejectionReason)) {
    return REJECTION_REASON_LABELS_JA[value as RejectionReason];
  }
  return value;
}

function proposalGroupLabel(proposal: ImprovementProposalDetail): string {
  const target = proposal.target.trim();
  return target
    ? `${hierarchyLabel(proposal.hierarchy)}: ${target}`
    : hierarchyLabel(proposal.hierarchy);
}

function groupProposals(proposals: ImprovementProposalDetail[]): ProposalGroup[] {
  const groups: ProposalGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const proposal of proposals) {
    const key = `${proposal.hierarchy}:${proposal.target.trim()}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const group = groups[existingIndex];
      if (group) group.proposals.push(proposal);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push({
      key,
      label: proposalGroupLabel(proposal),
      proposals: [proposal],
    });
  }
  return groups;
}

function issueSeverityLabel(value: string): string {
  const labels: Record<string, string> = {
    error: "要修正",
    warn: "注意",
    info: "確認",
  };
  return labels[value] ?? value;
}

function displayProposalCount(
  row: AuditRow & { action: ImprovementPrAction },
  parsed: ParsedAuditMetadata
): number | null {
  if (parsed.proposalCount !== null) return parsed.proposalCount;
  if (row.action === "improvement_pr.skipped") return 0;
  return null;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

export default async function ImprovementsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParamsInput>;
}) {
  const resolvedSearchParams = await searchParams;
  const selectedAuditId = firstSearchParamOrNull(resolvedSearchParams?.auditId);
  let runs: CronRunRow[] = [];
  let aiRuns: AiRunRow[] = [];
  let audits: AuditRow[] = [];
  let latestAudits: AuditRow[] = [];
  let selectedAuditFromQuery: AuditRow | null = null;
  let detailAiRuns: AiRunDetailRow[] = [];
  let runsTotal = 0;
  let aiRunsTotal = 0;
  let auditsTotal = 0;
  let schedules: ScheduleRow[] = [];
  let adAccountTimeZones: AdAccountTimeZoneRow[] = [];
  let proposalFeedbackDigest: ProposalFeedbackDigest | null = null;
  let dbReady = true;
  try {
    const workspace = await ensureWebWorkspace();
    const runsWhere = {
      name: "improvement_pr",
      OR: [
        { schedule: { is: { workspaceId: workspace.id } } },
        { executionLogs: { some: { workspaceId: workspace.id } } },
      ],
    };
    const aiRunsWhere = { workspaceId: workspace.id, workflow: "improvement_pr" };
    const auditsWhere = { workspaceId: workspace.id, action: { startsWith: "improvement_pr." } };
    [runsTotal, aiRunsTotal, auditsTotal] = await Promise.all([
      prisma.cronRun.count({ where: runsWhere }),
      prisma.aiRun.count({ where: aiRunsWhere }),
      prisma.auditLog.count({ where: auditsWhere }),
    ]);
    const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", runsTotal);
    const aiRunsPagination = getPaginationState(
      resolvedSearchParams,
      "aiRunsPage",
      aiRunsTotal
    );
    const auditsPagination = getPaginationState(
      resolvedSearchParams,
      "proposalsPage",
      auditsTotal
    );
    [runs, aiRuns, audits, latestAudits, selectedAuditFromQuery, schedules, adAccountTimeZones] = await Promise.all([
      prisma.cronRun.findMany({
        where: runsWhere,
        orderBy: { startedAt: "desc" },
        skip: runsPagination.skip,
        take: runsPagination.take,
        select: {
          id: true,
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
      prisma.auditLog.findMany({
        where: auditsWhere,
        orderBy: { createdAt: "desc" },
        skip: auditsPagination.skip,
        take: auditsPagination.take,
        select: {
          id: true,
          workspaceId: true,
          action: true,
          target: true,
          ref: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.auditLog.findMany({
        where: auditsWhere,
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          workspaceId: true,
          action: true,
          target: true,
          ref: true,
          metadata: true,
          createdAt: true,
        },
      }),
      selectedAuditId
        ? prisma.auditLog.findFirst({
            where: { ...auditsWhere, id: selectedAuditId },
            select: {
              id: true,
              workspaceId: true,
              action: true,
              target: true,
              ref: true,
              metadata: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
      prisma.cronSchedule.findMany({
        where: { workspaceId: workspace.id, name: "improvement_pr" },
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
    proposalFeedbackDigest = await buildProposalFeedbackDigest({
      store: createPrismaProposalFeedbackStore(prisma),
      workspaceId: workspace.id,
    }).catch(() => null);
  } catch {
    dbReady = false;
  }

  const auditRows = audits
    .filter((a): a is AuditRow & { action: ImprovementPrAction } =>
      VALID_ACTIONS.has(a.action as ImprovementPrAction)
    )
    .map((a) => ({ row: a, parsed: parseAuditMetadata(a.metadata) }));

  const latestAuditRows = latestAudits
    .filter((a): a is AuditRow & { action: ImprovementPrAction } =>
      VALID_ACTIONS.has(a.action as ImprovementPrAction)
    )
    .map((a) => ({ row: a, parsed: parseAuditMetadata(a.metadata) }));

  const latestAudit = latestAuditRows[0] ?? null;
  const selectedAudit =
    selectedAuditFromQuery && VALID_ACTIONS.has(selectedAuditFromQuery.action as ImprovementPrAction)
      ? {
          row: selectedAuditFromQuery as AuditRow & { action: ImprovementPrAction },
          parsed: parseAuditMetadata(selectedAuditFromQuery.metadata),
        }
      : null;
  const detailAudit = selectedAudit ?? latestAudit;
  const showMissingSelectedAudit = Boolean(selectedAuditId && !selectedAudit);
  if (dbReady && detailAudit?.parsed.aiRunIds.length) {
    detailAiRuns = await prisma.aiRun
      .findMany({
        where: { id: { in: detailAudit.parsed.aiRunIds } },
        select: { id: true, agent: true, outputs: true },
      })
      .catch(() => []);
  }
  const mediaBuyerOutput =
    detailAiRuns.find((run) => run.agent === "media_buyer")?.outputs ?? null;
  const analystOutput =
    detailAiRuns.find((run) => run.agent === "analyst")?.outputs ?? null;
  const mediaBuyerDetail = parseMediaBuyerOutput(mediaBuyerOutput);
  const analystDetail = parseAnalystOutput(analystOutput);
  const detailProposals =
    detailAudit?.parsed.proposals.length
      ? detailAudit.parsed.proposals
      : mediaBuyerDetail.proposals.length
        ? mediaBuyerDetail.proposals
        : analystDetail.proposals;
  const detailProposalGroups = groupProposals(detailProposals);
  const detailMediaBuyerRationale =
    detailAudit?.parsed.mediaBuyerRationale ??
    mediaBuyerDetail.rationale ??
    analystDetail.rationale;
  const detailDryRunSummary =
    detailAudit?.parsed.dryRunSummary ?? mediaBuyerDetail.dryRunSummary;
  const detailBudgetImpact =
    detailAudit?.parsed.budgetImpact ?? mediaBuyerDetail.budgetImpact;
  const scheduleRow = schedules[0] ?? null;
  const runsCount = runsTotal;
  const aiRunsCount = aiRunsTotal;
  const auditCount = auditsTotal;
  const auditsPagination = getPaginationState(
    resolvedSearchParams,
    "proposalsPage",
    auditsTotal
  );
  const runsPagination = getPaginationState(resolvedSearchParams, "runsPage", runsTotal);
  const aiRunsPagination = getPaginationState(
    resolvedSearchParams,
    "aiRunsPage",
    aiRunsTotal
  );
  const proposalFeedbackStats = proposalFeedbackDigest?.stats ?? [];
  const proposalFeedbackRejections = proposalFeedbackDigest?.recentRejections ?? [];
  const timeZoneByAccount = new Map(
    adAccountTimeZones.map((row) => [`${row.workspaceId}:${row.key}`, row.timezoneName])
  );
  const auditTimeZone = (row: AuditRow | null, parsed: ParsedAuditMetadata | null): string | null =>
    row?.workspaceId && parsed?.accountKey
      ? timeZoneByAccount.get(`${row.workspaceId}:${parsed.accountKey}`) ?? null
      : null;
  const pageDisplayTimeZone = resolveDisplayTimeZone(
    detailAudit ? auditTimeZone(detailAudit.row, detailAudit.parsed) : null
  );

  const runColumns: DataTableColumn<CronRunRow>[] = [
    {
      header: "開始日時",
      cell: (row) => formatDateTime(row.startedAt, { timeZone: pageDisplayTimeZone }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "状態",
      cell: (row) => (
        <StatusBadge state={cronStateToStatus(row.state)}>
          {cronStateLabel(row.state)}
        </StatusBadge>
      ),
    },
    {
      header: "広告アカウント",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.accountsProcessed}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "PR作成",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.succeeded}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "提案なし",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.skipped_no_proposal}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "自動ブロック",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.auto_blocked}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "AI失敗",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.ai_failed}</span>
        ) : (
          <span>—</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "PR失敗",
      cell: (row) => {
        const agg = parseCronRunAggregate(row.output);
        return agg ? (
          <span className="tabular-nums">{agg.pr_failed}</span>
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

  const auditColumns: DataTableColumn<{
    row: AuditRow & { action: ImprovementPrAction };
    parsed: ParsedAuditMetadata;
  }>[] = [
    {
      header: "作成日時",
      cell: ({ row, parsed }) =>
        formatDateTime(row.createdAt, {
          timeZone: resolveDisplayTimeZone(auditTimeZone(row, parsed), pageDisplayTimeZone),
        }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "結果",
      cell: ({ row }) => (
        <StatusBadge state={actionToState(row.action)}>{actionLabel(row.action)}</StatusBadge>
      ),
    },
    {
      header: "広告アカウント",
      cell: ({ parsed }) =>
        parsed.accountKey ? (
          <InlineCode>{parsed.accountKey}</InlineCode>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "運用モード",
      cell: ({ parsed }) =>
        parsed.mode ? (
          <StatusBadge state={modeToState(parsed.mode)}>{parsed.mode}</StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "リスク",
      cell: ({ parsed }) =>
        parsed.classification ? (
          <StatusBadge state={classificationToState(parsed.classification)}>
            {classificationLabel(parsed.classification)}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "判断",
      cell: ({ parsed }) =>
        parsed.auditDecision ? (
          <StatusBadge state={auditDecisionToState(parsed.auditDecision)}>
            {auditDecisionLabel(parsed.auditDecision)}
          </StatusBadge>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "提案数",
      cell: ({ row, parsed }) => {
        const proposalCount = displayProposalCount(row, parsed);
        return proposalCount === null ? (
          <span>—</span>
        ) : (
          <span className="tabular-nums">{proposalCount}</span>
        );
      },
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "予算影響",
      cell: ({ parsed }) =>
        parsed.budgetImpact ? (
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatBudgetDelta(parsed.budgetImpact)}
          </span>
        ) : (
          <span>—</span>
        ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "入稿前チェック",
      cell: ({ parsed }) => {
        const pv = parsed.planValidation;
        if (!pv) return <span>—</span>;
        if (!pv.available) {
          return <StatusBadge state="idle">skipped</StatusBadge>;
        }
        return (
          <StatusBadge state={planRiskToState(pv.risk)}>{pv.risk}</StatusBadge>
        );
      },
    },
    {
      header: "PR",
      cell: ({ parsed }) =>
        parsed.prNumber !== null ? (
          parsed.htmlUrl ? (
            <a
              href={parsed.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--color-accent)" }}
            >
              <InlineCode>#{parsed.prNumber}</InlineCode>
            </a>
          ) : (
            <InlineCode>#{parsed.prNumber}</InlineCode>
          )
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "表示",
      cell: ({ row }) => (
        <Link
          href={`/improvements?auditId=${encodeURIComponent(row.id)}#improvement-detail`}
          className="btn btn--ghost btn--sm"
          aria-current={row.id === selectedAuditId ? "true" : undefined}
        >
          {row.id === selectedAuditId ? "表示中" : "表示"}
        </Link>
      ),
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
      header: "役割",
      cell: (row) => (
        <span>
          {agentLabel(row.agent)} <InlineCode>{row.agent}</InlineCode>
        </span>
      ),
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
          <span>
            {decisionLabel(row.decision)} <InlineCode>{row.decision}</InlineCode>
          </span>
        ) : (
          <span>—</span>
        ),
    },
    {
      header: "確信度",
      cell: (row) =>
        row.confidence === null ? (
          <span>—</span>
        ) : (
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {row.confidence.toFixed(2)}
          </span>
        ),
      className: "tabular",
      headerClassName: "tabular",
    },
    {
      header: "トークン数",
      cell: (row) => (
        <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
          {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
        </span>
      ),
      className: "tabular",
      headerClassName: "tabular",
    },
  ];

  const proposalFeedbackStatsColumns: DataTableColumn<
    ProposalFeedbackDigest["stats"][number]
  >[] = [
    {
      header: "カテゴリ",
      cell: (row) => proposalCategoryLabel(row.category),
    },
    {
      header: "承認率",
      cell: (row) => {
        const judged = row.approved + row.rejected;
        return judged > 0 ? `${Math.round((row.approved / judged) * 100)}%` : "—";
      },
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "提案",
      cell: (row) => row.proposed,
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "承認",
      cell: (row) => row.approved,
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "非承認",
      cell: (row) => row.rejected,
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "主な理由",
      cell: (row) =>
        row.topRejectionReasons.length > 0
          ? row.topRejectionReasons
              .map((item) => `${proposalRejectionReasonLabel(item.reason)} (${item.count})`)
              .join(" / ")
          : "—",
    },
  ];

  const proposalFeedbackRejectionColumns: DataTableColumn<
    ProposalFeedbackDigest["recentRejections"][number]
  >[] = [
    {
      header: "日時",
      cell: (row) =>
        formatDateTime(new Date(row.decidedAt), { timeZone: pageDisplayTimeZone }),
      className: "tabular mono",
      headerClassName: "tabular",
    },
    {
      header: "カテゴリ",
      cell: (row) => proposalCategoryLabel(row.category),
    },
    {
      header: "理由",
      cell: (row) => proposalRejectionReasonLabel(row.reason),
    },
    {
      header: "提案内容",
      cell: (row) => row.proposedChange,
    },
    {
      header: "メモ",
      cell: (row) => row.note ?? "—",
    },
  ];

  const scheduleItems: KeyValueEntry[] = scheduleRow
    ? [
        {
          label: "実行予定",
          value: <InlineCode>{scheduleRow.cron || "(unscheduled)"}</InlineCode>,
        },
        {
          label: "有効化",
          value: (
            <StatusBadge state={scheduleRow.enabled ? "ok" : "idle"}>
              {scheduleRow.enabled ? "有効" : "無効"}
            </StatusBadge>
          ),
        },
        {
          label: "前回の状態",
          value: scheduleRow.lastRunState ? (
            <StatusBadge
              state={
                scheduleRow.lastRunState === "ok"
                  ? "ok"
                  : scheduleRow.lastRunState === "warn"
                    ? "warn"
                    : scheduleRow.lastRunState === "error"
                      ? "error"
                      : "idle"
              }
            >
              {cronStateLabel(scheduleRow.lastRunState)}
            </StatusBadge>
          ) : (
            <span>未実行</span>
          ),
        },
        {
          label: "次回実行",
          value: scheduleRow.nextRunAt ? (
            <span
              className="tabular-nums"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {formatDateTime(scheduleRow.nextRunAt, { timeZone: pageDisplayTimeZone })}
            </span>
          ) : (
            <span>—</span>
          ),
        },
      ]
    : [];

  const detailAuditItems: KeyValueEntry[] = detailAudit
    ? [
        {
          label: "結果",
          value: (
            <StatusBadge state={actionToState(detailAudit.row.action)}>
              {actionLabel(detailAudit.row.action)}
            </StatusBadge>
          ),
        },
        {
          label: "広告アカウント",
          value: detailAudit.parsed.accountKey ? (
            <InlineCode>{detailAudit.parsed.accountKey}</InlineCode>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "運用モード",
          value: detailAudit.parsed.mode ? (
            <StatusBadge state={modeToState(detailAudit.parsed.mode)}>
              {detailAudit.parsed.mode}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "リスク",
          value: detailAudit.parsed.classification ? (
            <StatusBadge
              state={classificationToState(detailAudit.parsed.classification)}
            >
              {classificationLabel(detailAudit.parsed.classification)}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "判断",
          value: detailAudit.parsed.auditDecision ? (
            <StatusBadge
              state={auditDecisionToState(detailAudit.parsed.auditDecision)}
            >
              {auditDecisionLabel(detailAudit.parsed.auditDecision)}
            </StatusBadge>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "停止箇所",
          value: detailAudit.parsed.skippedAt ? (
            <span>
              <InlineCode>{detailAudit.parsed.skippedAt}</InlineCode>
              {detailAudit.parsed.recommendation ? (
                <>
                  {" "}
                  <StatusBadge
                    state={
                      detailAudit.parsed.recommendation === "approve"
                        ? "ok"
                        : detailAudit.parsed.recommendation === "reject"
                          ? "error"
                          : "warn"
                    }
                  >
                    {decisionLabel(detailAudit.parsed.recommendation)}
                  </StatusBadge>
                </>
              ) : null}
            </span>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "注意が必要な変更",
          value:
            detailAudit.parsed.dangerousCategories.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {detailAudit.parsed.dangerousCategories.join(", ")}
              </span>
            ),
        },
        {
          label: "提案数",
          value:
            displayProposalCount(detailAudit.row, detailAudit.parsed) === null ? (
              <span>—</span>
            ) : (
              <span className="tabular-nums">
                {displayProposalCount(detailAudit.row, detailAudit.parsed)}
              </span>
            ),
        },
        {
          label: "変更ファイル",
          value:
            detailAudit.parsed.fileCount === null ? (
              <span>—</span>
            ) : (
              <span className="tabular-nums">
                {detailAudit.parsed.fileCount}
              </span>
            ),
        },
        {
          label: "予算影響",
          value: detailBudgetImpact ? (
            <span style={{ display: "grid", gap: "0.125rem" }}>
              <span
                className="tabular-nums"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {formatBudgetDelta(detailBudgetImpact)}
              </span>
              {detailBudgetImpact.notes ? (
                <span
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {detailBudgetImpact.notes}
                </span>
              ) : null}
            </span>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "入稿前チェック",
          value: detailAudit.parsed.planValidation ? (
            <span style={{ display: "grid", gap: "0.125rem" }}>
              {detailAudit.parsed.planValidation.available ? (
                <span style={{ display: "flex", gap: "0.5rem" }}>
                  <StatusBadge
                    state={planRiskToState(detailAudit.parsed.planValidation.risk)}
                  >
                    {detailAudit.parsed.planValidation.risk}
                  </StatusBadge>
                  <StatusBadge
                    state={detailAudit.parsed.planValidation.ok ? "ok" : "error"}
                  >
                    {detailAudit.parsed.planValidation.ok ? "ok" : "errors"}
                  </StatusBadge>
                </span>
              ) : (
                <StatusBadge state="idle">skipped (no ops repo)</StatusBadge>
              )}
              {detailAudit.parsed.planValidation.summary ? (
                <span
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {detailAudit.parsed.planValidation.summary}
                </span>
              ) : null}
              {detailAudit.parsed.planValidation.counts ? (
                <span
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  creates={detailAudit.parsed.planValidation.counts.creates}{" "}
                  updates={detailAudit.parsed.planValidation.counts.updates}{" "}
                  deletes={detailAudit.parsed.planValidation.counts.deletes}{" "}
                  errors={detailAudit.parsed.planValidation.counts.errors}{" "}
                  warnings={detailAudit.parsed.planValidation.counts.warnings}
                </span>
              ) : null}
            </span>
          ) : (
            <span>—</span>
          ),
        },
        {
          label: "参照データ",
          value:
            detailAudit.parsed.snapshotIds.length === 0 ? (
              <span>—</span>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {detailAudit.parsed.snapshotIds.length} 件 (
                {detailAudit.parsed.snapshotIds.slice(0, 4).join(", ")}
                {detailAudit.parsed.snapshotIds.length > 4 ? ", …" : ""})
              </span>
            ),
        },
        {
          label: "Pull Request",
          value:
            detailAudit.parsed.prNumber !== null ? (
              detailAudit.parsed.htmlUrl ? (
                <a
                  href={detailAudit.parsed.htmlUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: "var(--color-accent)" }}
                >
                  <InlineCode>#{detailAudit.parsed.prNumber}</InlineCode>
                </a>
              ) : (
                <InlineCode>#{detailAudit.parsed.prNumber}</InlineCode>
              )
            ) : (
              <span>—</span>
            ),
        },
      ]
    : [];

  const detailAuditState: StatusState = !dbReady
    ? "warn"
    : showMissingSelectedAudit
      ? "warn"
      : !detailAudit
      ? "idle"
      : actionToState(detailAudit.row.action);
  const detailAuditLabel = !dbReady
    ? "warn"
    : showMissingSelectedAudit
      ? "履歴なし"
      : !detailAudit
        ? "未実行"
        : actionLabel(detailAudit.row.action);
  const detailPanelTitle = selectedAudit ? "過去の改善提案" : "最新の改善提案";
  const detailPanelSubtitle = selectedAudit
    ? `${formatDateTime(selectedAudit.row.createdAt, { timeZone: pageDisplayTimeZone })} の提案内容`
    : "最新の提案内容、リスク、予算影響、承認待ち状況";

  return (
    <>
      <PageHeader
        title="改善提案"
        subtitle={
          <>
            広告の改善案と、その提案が承認待ちになっているかを確認します。
            AI は Meta を直接変更せず、危険な変更は必ず人の承認を待ちます。
          </>
        }
        actions={<RunCronButton presetName="improvement_pr" label="今すぐ作成" />}
      />

      <div className="page-body page-body--single">
        <div
          role="note"
          style={{
            border: "1px solid var(--color-border-subtle)",
            background: "var(--color-bg-subtle)",
            color: "var(--color-text-primary)",
            borderRadius: "var(--radius-md)",
            padding: "0.875rem 1rem",
            display: "grid",
            gap: "0.25rem",
          }}
          data-testid="improvement-pr-approval-boundary"
        >
          <div style={{ fontWeight: 600 }}>
            安全ルール: AI は提案まで。反映には人の承認が必要です
          </div>
          <div style={{ fontSize: "0.8125rem" }}>
            改善案は承認待ちの変更として作成されます。予算増額、新規キャンペーン、
            ターゲティング変更など影響が大きいものは自動承認されません。
            このページは確認専用で、Meta へ直接反映しません。
          </div>
        </div>

        <Panel
          title="提案の採否サマリ"
          subtitle={
            proposalFeedbackDigest
              ? `直近 ${proposalFeedbackDigest.periodDays} 日の承認・非承認を次回の AI 提案に反映します`
              : "承認・非承認の履歴があると次回の AI 提案に反映します"
          }
        >
          {!dbReady ? (
            <EmptyState
              title="採否サマリを読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : proposalFeedbackStats.length === 0 &&
            proposalFeedbackRejections.length === 0 ? (
            <EmptyState
              title="提案の採否履歴はまだありません"
              description="改善 PR を承認または非承認にすると、カテゴリ別の傾向がここに表示されます。"
            />
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              <section>
                <SectionLabel>カテゴリ別</SectionLabel>
                <DataTable
                  rows={proposalFeedbackStats}
                  rowKey={(row) => row.category}
                  empty={null}
                  columns={proposalFeedbackStatsColumns}
                />
              </section>
              <section>
                <SectionLabel>直近の非承認</SectionLabel>
                <DataTable
                  rows={proposalFeedbackRejections}
                  rowKey={(row) =>
                    `${row.decidedAt}:${row.category}:${row.proposedChange}`
                  }
                  empty={
                    <EmptyState
                      title="直近の非承認はありません"
                      description="非承認時の理由とメモは、次回提案の参考情報として扱われます。"
                    />
                  }
                  columns={proposalFeedbackRejectionColumns}
                />
              </section>
            </div>
          )}
        </Panel>

        <Panel
          title={detailPanelTitle}
          subtitle={detailPanelSubtitle}
          status={
            <StatusDot state={detailAuditState}>{detailAuditLabel}</StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="改善提案の履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : showMissingSelectedAudit ? (
            <EmptyState
              title="指定された改善提案が見つかりません"
              description="下の履歴から表示する提案を選び直してください。"
            />
          ) : !detailAudit ? (
            <EmptyState
              title="改善提案はまだ実行されていません"
              description="自動実行画面から改善提案を有効化すると、最新の提案内容と承認待ち状況がここに表示されます。"
            />
          ) : (
            <div id="improvement-detail" style={{ display: "grid", gap: "1rem" }}>
              {selectedAudit ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-secondary)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    履歴ID <InlineCode>{selectedAudit.row.id}</InlineCode>
                  </span>
                  <Link href="/improvements" className="btn btn--ghost btn--sm">
                    最新に戻る
                  </Link>
                </div>
              ) : null}
              <KeyValueList items={detailAuditItems} />
              {detailProposals.length > 0 ? (
                <div style={{ display: "grid", gap: "0.75rem" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "0.75rem",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <SectionLabel>
                      {detailAudit.parsed.proposals.length || mediaBuyerDetail.proposals.length
                        ? "提案された改善"
                        : "分析からの改善候補"}
                    </SectionLabel>
                    <span
                      style={{
                        color: "var(--color-text-secondary)",
                        fontSize: "0.8125rem",
                      }}
                    >
                      {detailProposals.length} 件
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "0.875rem" }}>
                    {detailProposalGroups.map((group) => (
                      <div
                        key={group.key}
                        style={{
                          border: "1px solid var(--color-border-subtle)",
                          borderRadius: "var(--radius-md)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            background: "var(--color-bg-subtle)",
                            borderBottom: "1px solid var(--color-border-subtle)",
                            color: "var(--color-text-secondary)",
                            fontSize: "0.8125rem",
                            fontWeight: 600,
                            padding: "0.625rem 0.875rem",
                          }}
                        >
                          {group.label}
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gap: "0",
                          }}
                        >
                          {group.proposals.map((proposal, index) => (
                            <div
                              key={`${proposal.category}:${proposal.proposedChange}:${index}`}
                              style={{
                                padding: "0.875rem",
                                borderTop:
                                  index === 0
                                    ? "0"
                                    : "1px solid var(--color-border-subtle)",
                                display: "grid",
                                gap: "0.5rem",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  gap: "0.5rem",
                                  alignItems: "center",
                                  flexWrap: "wrap",
                                }}
                              >
                                <StatusBadge state="info">
                                  {proposalCategoryLabel(proposal.category)}
                                </StatusBadge>
                                <span style={{ fontWeight: 600 }}>
                                  {proposal.proposedChange || proposal.rationale || "改善候補"}
                                </span>
                              </div>
                              {proposal.rationale ? (
                                <div
                                  style={{
                                    fontSize: "0.8125rem",
                                    color: "var(--color-text-secondary)",
                                  }}
                                >
                                  {proposal.rationale}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {detailAudit.parsed.issues.length > 0 ? (
                <div style={{ display: "grid", gap: "0.75rem" }}>
                  <SectionLabel>確認メモ</SectionLabel>
                  <div
                    style={{
                      border: "1px solid var(--color-border-subtle)",
                      borderRadius: "var(--radius-md)",
                      overflow: "hidden",
                    }}
                  >
                    {detailAudit.parsed.issues.map((issue, index) => (
                      <div
                        key={`${issue.category}:${issue.message}:${index}`}
                        style={{
                          padding: "0.75rem 0.875rem",
                          borderTop:
                            index === 0 ? "0" : "1px solid var(--color-border-subtle)",
                          display: "grid",
                          gap: "0.375rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          {issue.severity ? (
                            <StatusBadge
                              state={
                                issue.severity === "error"
                                  ? "error"
                                  : issue.severity === "warn"
                                    ? "warn"
                                    : "info"
                              }
                            >
                              {issueSeverityLabel(issue.severity)}
                            </StatusBadge>
                          ) : null}
                          {issue.category ? (
                            <span style={{ fontWeight: 600 }}>{issue.category}</span>
                          ) : null}
                        </div>
                        {issue.message ? (
                          <div
                            style={{
                              fontSize: "0.875rem",
                              color: "var(--color-text-secondary)",
                            }}
                          >
                            {issue.message}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {detailMediaBuyerRationale || detailDryRunSummary ? (
                <div style={{ display: "grid", gap: "0.5rem" }}>
                  <SectionLabel>提案の補足</SectionLabel>
                  {detailMediaBuyerRationale ? (
                    <p style={{ margin: 0 }}>{detailMediaBuyerRationale}</p>
                  ) : null}
                  {detailDryRunSummary ? (
                    <p
                      style={{
                        margin: 0,
                        color: "var(--color-text-secondary)",
                        fontSize: "0.875rem",
                      }}
                    >
                      入稿前チェック: {detailDryRunSummary}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {detailAudit.parsed.summary ? (
                <div>
                  <SectionLabel>実行サマリ</SectionLabel>
                  <p style={{ margin: 0 }}>{detailAudit.parsed.summary}</p>
                </div>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel
          title="最近の改善提案"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : paginationLabel(auditsPagination)
          }
          status={
            <StatusDot
              state={!dbReady ? "warn" : auditCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "warn"
                : auditCount === 0
                  ? "idle"
                  : `${auditCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="改善提案の履歴を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : (
            <div>
              <DataTable
                rows={auditRows}
                rowKey={({ row }) => row.id}
                columns={auditColumns}
                empty={
                  <EmptyState
                    title="改善提案の履歴はまだありません"
                    description="改善提案が実行されると、広告アカウントごとの結果、リスク、判断、予算影響、承認待ち番号が表示されます。"
                  />
                }
              />
              <Pagination
                basePath="/improvements"
                searchParams={resolvedSearchParams}
                pageParam="proposalsPage"
                state={auditsPagination}
              />
            </div>
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
            <StatusDot
              state={!dbReady ? "warn" : runsCount === 0 ? "idle" : "ok"}
            >
              {!dbReady
                ? "要確認"
                : runsCount === 0
                  ? "未実行"
                  : `${runsCount} 件`}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="改善提案の実行履歴を読み出せません"
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
                    title="改善提案はまだ実行されていません"
                    description="自動実行を有効化すると、各回の処理件数と結果がここに記録されます。"
                  />
                }
              />
              <Pagination
                basePath="/improvements"
                searchParams={resolvedSearchParams}
                pageParam="runsPage"
                state={runsPagination}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="AI 判断履歴"
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
              title="AI 判断履歴を読み出せません"
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
                    title="AI 判断履歴はまだありません"
                    description="改善提案が実行されると、判断結果とコストの概要がここに保存されます。"
                  />
                }
              />
              <Pagination
                basePath="/improvements"
                searchParams={resolvedSearchParams}
                pageParam="aiRunsPage"
                state={aiRunsPagination}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="自動実行の状態"
          subtitle={
            !dbReady
              ? "保存先を確認してください"
              : scheduleRow
                ? "改善提案の定期実行"
                : "改善提案の自動実行は未登録"
          }
          status={
            <StatusDot
              state={
                !dbReady
                  ? "warn"
                  : !scheduleRow
                    ? "idle"
                    : scheduleRow.enabled
                      ? "ok"
                      : "idle"
              }
            >
              {!dbReady
                ? "warn"
                : !scheduleRow
                  ? "未登録"
                  : scheduleRow.enabled
                    ? "有効"
                    : "無効"}
            </StatusDot>
          }
        >
          {!dbReady ? (
            <EmptyState
              title="自動実行の状態を読み出せません"
              description="接続と健康状態を確認してください。"
            />
          ) : !scheduleRow ? (
            <EmptyState
              title="改善提案の自動実行はまだ登録されていません"
              description="AdDroid を開始すると標準の自動実行が登録されます。"
            />
          ) : (
            <KeyValueList items={scheduleItems} />
          )}
        </Panel>
      </div>
    </>
  );
}
