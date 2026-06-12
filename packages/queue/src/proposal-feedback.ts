export const REJECTION_REASONS = [
  "budget_too_aggressive",
  "wrong_target",
  "creative_off_brand",
  "timing",
  "already_planned",
  "dont_trust_data",
  "other",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const REJECTION_REASON_LABELS_JA: Record<RejectionReason, string> = {
  budget_too_aggressive: "予算変更が大きすぎる",
  wrong_target: "対象が不適切",
  creative_off_brand: "ブランドに合わない",
  timing: "時期が悪い",
  already_planned: "別途対応予定",
  dont_trust_data: "根拠データに納得できない",
  other: "その他",
};

const REJECTION_REASON_SET = new Set<string>(REJECTION_REASONS);

export interface ProposalFeedbackProposal {
  category: string;
  proposedChange: string;
}

export interface ProposalOutcomeRow {
  decision: "approved" | "auto_approved" | "rejected";
  decidedAt: Date | string;
  rejectionReason: string | null;
  rejectionNote: string | null;
  proposals: ProposalFeedbackProposal[];
}

export interface ProposalOutcomeStats {
  category: string;
  proposed: number;
  approved: number;
  rejected: number;
  topRejectionReasons: Array<{ reason: string; count: number }>;
}

export interface ProposalFeedbackDigest {
  workspaceId: string;
  periodDays: number;
  stats: ProposalOutcomeStats[];
  recentRejections: Array<{
    category: string;
    proposedChange: string;
    reason: string | null;
    note: string | null;
    decidedAt: string;
  }>;
}

export interface ProposalFeedbackStore {
  listProposalOutcomes(input: {
    workspaceId: string;
    since: Date;
  }): Promise<ProposalOutcomeRow[]>;
}

export interface ProposalWorkspaceFeedback {
  approvalStats: Array<{
    category: string;
    approvedRatio: number | null;
    sampleSize: number;
  }>;
  recentRejections: Array<{
    category: string;
    proposedChange: string;
    reason: string | null;
    note: string | null;
  }>;
}

export async function buildProposalFeedbackDigest(opts: {
  store: ProposalFeedbackStore;
  workspaceId: string;
  periodDays?: number;
  now?: Date;
}): Promise<ProposalFeedbackDigest> {
  const periodDays = Math.max(1, Math.floor(opts.periodDays ?? 90));
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - periodDays * 86_400_000);
  const rows = await opts.store.listProposalOutcomes({
    workspaceId: opts.workspaceId,
    since,
  });
  const byCategory = new Map<
    string,
    { proposed: number; approved: number; rejected: number; reasons: Map<string, number> }
  >();
  const recentRejections: ProposalFeedbackDigest["recentRejections"] = [];

  for (const row of rows) {
    const approved = row.decision === "approved" || row.decision === "auto_approved";
    const rejected = row.decision === "rejected";
    for (const proposal of row.proposals) {
      const category = proposal.category.trim() || "unknown";
      const stats =
        byCategory.get(category) ??
        { proposed: 0, approved: 0, rejected: 0, reasons: new Map<string, number>() };
      stats.proposed += 1;
      if (approved) stats.approved += 1;
      if (rejected) {
        stats.rejected += 1;
        const reason = normalizeRejectionReason(row.rejectionReason) ?? "other";
        stats.reasons.set(reason, (stats.reasons.get(reason) ?? 0) + 1);
        recentRejections.push({
          category,
          proposedChange: truncateText(proposal.proposedChange, 160) ?? "",
          reason,
          note: sanitizeRejectionNote(row.rejectionNote),
          decidedAt: toIsoString(row.decidedAt),
        });
      }
      byCategory.set(category, stats);
    }
  }

  const stats = [...byCategory.entries()]
    .map(([category, item]) => ({
      category,
      proposed: item.proposed,
      approved: item.approved,
      rejected: item.rejected,
      topRejectionReasons: [...item.reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, 3),
    }))
    .sort((a, b) => b.proposed - a.proposed || a.category.localeCompare(b.category));

  return {
    workspaceId: opts.workspaceId,
    periodDays,
    stats,
    recentRejections: recentRejections
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
      .slice(0, 5),
  };
}

export function proposalFeedbackDigestToAgentInput(
  digest: ProposalFeedbackDigest
): ProposalWorkspaceFeedback | undefined {
  if (digest.stats.length === 0 && digest.recentRejections.length === 0) return undefined;
  return {
    approvalStats: digest.stats.map((item) => ({
      category: item.category,
      approvedRatio:
        item.approved + item.rejected > 0
          ? round4(item.approved / (item.approved + item.rejected))
          : null,
      sampleSize: item.approved + item.rejected,
    })),
    recentRejections: digest.recentRejections.map((item) => ({
      category: item.category,
      proposedChange: item.proposedChange,
      reason: item.reason,
      note: item.note,
    })),
  };
}

export function normalizeRejectionReason(value: unknown): RejectionReason | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return REJECTION_REASON_SET.has(normalized) ? (normalized as RejectionReason) : null;
}

export function sanitizeRejectionNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return truncateText(value, 200);
}

function truncateText(value: string, maxLength: number): string | null {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length <= maxLength ? compact : compact.slice(0, maxLength);
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
