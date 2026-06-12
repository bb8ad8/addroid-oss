import type { PrismaClient } from "@addroid/db";
import type {
  ProposalFeedbackProposal,
  ProposalFeedbackStore,
  ProposalOutcomeRow,
} from "@addroid/queue";

export function createPrismaProposalFeedbackStore(
  prisma: PrismaClient
): ProposalFeedbackStore {
  return {
    async listProposalOutcomes(input) {
      const approvals = await prisma.approvalRecord.findMany({
        where: {
          workspaceId: input.workspaceId,
          createdAt: { gte: input.since },
          pullRequestId: { not: null },
          decision: { in: ["approved", "auto_approved", "rejected"] },
        },
        orderBy: { createdAt: "desc" },
        select: {
          decision: true,
          createdAt: true,
          metadata: true,
          pullRequestId: true,
        },
      });
      const prIds = [
        ...new Set(
          approvals
            .map((approval) => approval.pullRequestId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      if (prIds.length === 0) return [];
      const mediaBuyerRuns = await prisma.aiRun.findMany({
        where: {
          workspaceId: input.workspaceId,
          workflow: "improvement_pr",
          agent: "media_buyer",
          linkedRefType: "github_pull_request",
          linkedRefId: { in: prIds },
        },
        orderBy: { createdAt: "desc" },
        select: {
          linkedRefId: true,
          outputs: true,
        },
      });
      const proposalsByPr = new Map<string, ProposalFeedbackProposal[]>();
      for (const run of mediaBuyerRuns) {
        if (!run.linkedRefId || proposalsByPr.has(run.linkedRefId)) continue;
        const proposals = readProposals(run.outputs);
        if (proposals.length > 0) proposalsByPr.set(run.linkedRefId, proposals);
      }
      return approvals.flatMap((approval): ProposalOutcomeRow[] => {
        if (
          approval.decision !== "approved" &&
          approval.decision !== "auto_approved" &&
          approval.decision !== "rejected"
        ) {
          return [];
        }
        const pullRequestId = approval.pullRequestId;
        if (!pullRequestId) return [];
        const proposals = proposalsByPr.get(pullRequestId) ?? [];
        if (proposals.length === 0) return [];
        const metadata = isRecord(approval.metadata) ? approval.metadata : {};
        return [
          {
            decision: approval.decision,
            decidedAt: approval.createdAt,
            rejectionReason: readString(metadata.rejectionReason),
            rejectionNote: readString(metadata.rejectionNote),
            proposals,
          },
        ];
      });
    },
  };
}

function readProposals(value: unknown): ProposalFeedbackProposal[] {
  if (!isRecord(value) || !Array.isArray(value.proposals)) return [];
  return value.proposals.flatMap((item): ProposalFeedbackProposal[] => {
    if (!isRecord(item)) return [];
    const category = readString(item.category);
    const proposedChange = readString(item.proposedChange);
    if (!category || !proposedChange) return [];
    return [{ category, proposedChange }];
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
