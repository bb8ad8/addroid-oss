import { Prisma, type PrismaClient } from "@addroid/db";
import {
  GithubAdapterUnauthenticatedError,
  GithubMergeFailedError,
  type GithubAdapter,
} from "@addroid/github-adapter";

export type ApprovalDecisionAction = "approve" | "reject";
export type ApprovalDecisionSource =
  | "cli_merge"
  | "cli_reject"
  | "slack_merge"
  | "slack_reject"
  | "web_merge"
  | "web_reject";

export interface DecidePullRequestApprovalOptions {
  prisma: PrismaClient;
  githubAdapter?: GithubAdapter;
  workspaceId: string;
  prNumber: number;
  action: ApprovalDecisionAction;
  actor: string;
  decisionSource: ApprovalDecisionSource;
  expectedHeadSha?: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  comment?: string;
  rejectionReason?: string;
  rejectionNote?: string;
}

export interface DecidePullRequestApprovalResult {
  ok: true;
  action: ApprovalDecisionAction;
  prNumber: number;
  approvalRecordId: string;
  decisionSource: ApprovalDecisionSource;
  htmlUrl: string | null;
  merged?: boolean;
  sha?: string;
  message: string;
}

export class ApprovalDecisionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApprovalDecisionError";
  }
}

export async function decidePullRequestApproval(
  opts: DecidePullRequestApprovalOptions
): Promise<DecidePullRequestApprovalResult> {
  if (!Number.isFinite(opts.prNumber) || opts.prNumber <= 0) {
    throw new ApprovalDecisionError(400, "Invalid PR number.");
  }
  const mergeMethod = opts.mergeMethod ?? "merge";
  const pr = await opts.prisma.githubPullRequest.findFirst({
    where: {
      number: opts.prNumber,
      repo: { workspace: { is: { id: opts.workspaceId } } },
    },
    orderBy: { polledAt: "desc" },
    select: {
      id: true,
      number: true,
      title: true,
      state: true,
      headSha: true,
      baseRef: true,
      htmlUrl: true,
      repo: {
        select: {
          owner: true,
          name: true,
          defaultBranch: true,
        },
      },
    },
  });
  if (!pr) {
    throw new ApprovalDecisionError(
      404,
      `PR #${opts.prNumber} is not tracked locally yet.`
    );
  }
  if (pr.state !== "open") {
    throw new ApprovalDecisionError(
      409,
      `PR #${opts.prNumber} is not open (current state: ${pr.state}).`
    );
  }
  const expectedHeadSha = opts.expectedHeadSha?.trim() || pr.headSha;
  if (expectedHeadSha !== pr.headSha) {
    throw new ApprovalDecisionError(
      409,
      `Local HEAD sha (${pr.headSha}) does not match expected (${expectedHeadSha}). Refresh and retry.`
    );
  }

  const latest = await opts.prisma.approvalRecord.findFirst({
    where: { workspaceId: opts.workspaceId, pullRequestId: pr.id },
    orderBy: { createdAt: "desc" },
    select: { decision: true },
  });
  if (opts.action === "approve" && (latest?.decision === "rejected" || latest?.decision === "auto_blocked")) {
    throw new ApprovalDecisionError(
      409,
      `PR #${opts.prNumber} is blocked by approval_records.decision="${latest.decision}".`
    );
  }

  if (opts.action === "reject") {
    const approval = await opts.prisma.$transaction(async (tx) => {
      const row = await tx.approvalRecord.create({
        data: {
          workspaceId: opts.workspaceId,
          pullRequestId: pr.id,
          approvedBy: opts.actor,
          decision: "rejected",
          comment: opts.comment?.trim() || "変更を否決しました。",
          metadata: {
            decisionSource: opts.decisionSource,
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            rejectionReason: opts.rejectionReason ?? null,
            rejectionNote: opts.rejectionNote ?? null,
          } satisfies Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: opts.workspaceId,
          actor: opts.actor,
          action: "pr.rejected",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: opts.decisionSource,
            approvalRecordId: row.id,
            comment: opts.comment?.trim() || null,
            rejectionReason: opts.rejectionReason ?? null,
            rejectionNote: opts.rejectionNote ?? null,
          } satisfies Prisma.InputJsonValue,
        },
      });
      return row;
    });
    return {
      ok: true,
      action: "reject",
      prNumber: pr.number,
      approvalRecordId: approval.id,
      decisionSource: opts.decisionSource,
      htmlUrl: pr.htmlUrl,
      message: `PR #${pr.number} を否決しました。後続の反映処理は起動しません。`,
    };
  }

  if (!opts.githubAdapter) {
    throw new ApprovalDecisionError(500, "GitHub adapter が注入されていません。");
  }

  let approvalRecordId: string;
  try {
    const approval = await opts.prisma.$transaction(async (tx) => {
      const row = await tx.approvalRecord.create({
        data: {
          workspaceId: opts.workspaceId,
          pullRequestId: pr.id,
          approvedBy: opts.actor,
          decision: "approved",
          comment: opts.comment?.trim() || "対話型チャットからマージ要求を受け付けました。",
          metadata: {
            decisionSource: opts.decisionSource,
            mergeMethod,
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            phase: "pre_merge",
          } satisfies Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: opts.workspaceId,
          actor: opts.actor,
          action: "pr.merge_via_chat_attempted",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: opts.decisionSource,
            mergeMethod,
            approvalRecordId: row.id,
          } satisfies Prisma.InputJsonValue,
        },
      });
      return row;
    });
    approvalRecordId = approval.id;
  } catch (err) {
    throw new ApprovalDecisionError(
      500,
      `Failed to persist approval/audit before GitHub merge: ${err instanceof Error ? err.message : String(err)}. GitHub merge は呼び出していません。`
    );
  }

  let mergeResult: { sha: string; merged: boolean; message: string };
  try {
    mergeResult = await opts.githubAdapter.mergePullRequest({
      spec: {
        owner: pr.repo.owner,
        name: pr.repo.name,
        defaultBranch: pr.repo.defaultBranch,
      },
      number: pr.number,
      expectedHeadSha,
      mergeMethod,
    });
  } catch (err) {
    const status = err instanceof GithubMergeFailedError ? err.status : 502;
    const message =
      err instanceof GithubAdapterUnauthenticatedError
        ? "GitHub adapter is not authenticated. Connect GitHub first."
        : err instanceof Error
          ? err.message
          : String(err);
    await opts.prisma.auditLog
      .create({
        data: {
          workspaceId: opts.workspaceId,
          actor: opts.actor,
          action: "pr.merge_via_chat_failed",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: opts.decisionSource,
            mergeMethod,
            error: message,
            httpStatus: status,
            preMergeApprovalRecordId: approvalRecordId,
          } satisfies Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    throw new ApprovalDecisionError(status, message);
  }

  if (!mergeResult.merged) {
    await opts.prisma.auditLog
      .create({
        data: {
          workspaceId: opts.workspaceId,
          actor: opts.actor,
          action: "pr.merge_via_chat_failed",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            htmlUrl: pr.htmlUrl,
            decisionSource: opts.decisionSource,
            mergeMethod,
            error: mergeResult.message,
            githubMerged: false,
            preMergeApprovalRecordId: approvalRecordId,
          } satisfies Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    throw new ApprovalDecisionError(
      502,
      `GitHub returned merged=false: ${mergeResult.message}`
    );
  }

  await opts.prisma
    .$transaction(async (tx) => {
      await tx.approvalRecord.update({
        where: { id: approvalRecordId },
        data: {
          metadata: {
            decisionSource: opts.decisionSource,
            mergeMethod,
            prNumber: pr.number,
            headSha: pr.headSha,
            mergeSha: mergeResult.sha,
            htmlUrl: pr.htmlUrl,
            phase: "merged",
          } satisfies Prisma.InputJsonValue,
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: opts.workspaceId,
          actor: opts.actor,
          action: "pr.merged_via_chat",
          target: `github_pull_request:${pr.id}`,
          ref: `pr#${pr.number}@${pr.headSha}`,
          metadata: {
            prNumber: pr.number,
            headSha: pr.headSha,
            mergeSha: mergeResult.sha,
            htmlUrl: pr.htmlUrl,
            decisionSource: opts.decisionSource,
            mergeMethod,
            preMergeApprovalRecordId: approvalRecordId,
          } satisfies Prisma.InputJsonValue,
        },
      });
    })
    .catch(() => undefined);

  return {
    ok: true,
    action: "approve",
    prNumber: pr.number,
    approvalRecordId,
    decisionSource: opts.decisionSource,
    htmlUrl: pr.htmlUrl,
    merged: true,
    sha: mergeResult.sha,
    message: `PR #${pr.number} を承認しました。次の GitHub 確認で反映処理に進みます。`,
  };
}
