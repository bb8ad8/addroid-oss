// AdDroid OSS — experiment_evaluate wiring.
//
// A/Bテスト評価は決定論的に queue 側で行い、worker は Prisma と GitHub PR
// 作成だけを受け持つ。敗者 PAUSE は operation manifest PR として出すだけで、
// Meta への直接変更はしない。

import { Prisma, type PrismaClient } from "@addroid/db";
import type {
  CreatePullRequestFile,
  GithubAdapter,
} from "@addroid/github-adapter";
import type {
  ExperimentEvaluateStore,
  ExperimentPullRequestRequest,
  ExperimentPublisher,
  ExperimentRecord,
  ExperimentVariantStats,
} from "@addroid/queue";

export function createPrismaExperimentEvaluateStore(
  prisma: PrismaClient,
): ExperimentEvaluateStore {
  return {
    async listRunningExperiments(): Promise<ExperimentRecord[]> {
      const rows = await prisma.experiment.findMany({
        where: { status: "running" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          workspaceId: true,
          accountId: true,
          name: true,
          hypothesis: true,
          metric: true,
          adsetNodeKey: true,
          variantAKey: true,
          variantBKey: true,
          startDate: true,
          minImpressionsPerVariant: true,
          maxDurationDays: true,
          createdBy: true,
          account: { select: { key: true } },
        },
      });
      return rows.flatMap((row) => {
        if (row.metric !== "ctr" && row.metric !== "cvr") return [];
        return [{
          id: row.id,
          workspaceId: row.workspaceId,
          accountId: row.accountId,
          accountKey: row.account.key,
          name: row.name,
          hypothesis: row.hypothesis,
          metric: row.metric,
          adsetNodeKey: row.adsetNodeKey,
          variantAKey: row.variantAKey,
          variantBKey: row.variantBKey,
          startDate: row.startDate.toISOString().slice(0, 10),
          minImpressionsPerVariant: row.minImpressionsPerVariant,
          maxDurationDays: row.maxDurationDays,
          createdBy: row.createdBy,
        }];
      });
    },
    async loadVariantStats(input) {
      const rows = await prisma.performanceSnapshot.findMany({
        where: {
          accountId: input.accountId,
          nodeType: "ad",
          nodeKey: { in: [input.variantAKey, input.variantBKey] },
          metricDate: {
            gte: new Date(`${input.since}T00:00:00.000Z`),
            lte: new Date(`${input.until}T00:00:00.000Z`),
          },
        },
        select: {
          nodeKey: true,
          impressions: true,
          clicks: true,
          conversions: true,
        },
      });
      const empty = (): ExperimentVariantStats => ({
        impressions: 0,
        clicks: 0,
        conversions: 0,
      });
      const totals = new Map<string, ExperimentVariantStats>([
        [input.variantAKey, empty()],
        [input.variantBKey, empty()],
      ]);
      for (const row of rows) {
        const current = totals.get(row.nodeKey);
        if (!current) continue;
        current.impressions += row.impressions;
        current.clicks += row.clicks;
        current.conversions += row.conversions;
      }
      return {
        a: totals.get(input.variantAKey) ?? empty(),
        b: totals.get(input.variantBKey) ?? empty(),
      };
    },
    async loadVariantState(input) {
      const rows = await prisma.adsHierarchyNode.findMany({
        where: {
          accountId: input.accountId,
          nodeType: "ad",
          nodeKey: { in: [input.variantAKey, input.variantBKey] },
        },
        select: { nodeKey: true, status: true },
      });
      const statusByKey = new Map(rows.map((row) => [row.nodeKey, row.status]));
      const aStatus = statusByKey.get(input.variantAKey);
      const bStatus = statusByKey.get(input.variantBKey);
      const variantAActive = aStatus === "active";
      const variantBActive = bStatus === "active";
      return {
        variantAActive,
        variantBActive,
        ...(!variantAActive || !variantBActive
          ? {
              reason:
                !aStatus || !bStatus
                  ? "variant_missing"
                  : "variant_not_active",
            }
          : {}),
      };
    },
    async concludeExperiment(input) {
      await prisma.experiment.update({
        where: { id: input.experimentId },
        data: {
          status: input.status,
          conclusion: input.conclusion as unknown as Prisma.InputJsonValue,
          ...(input.pullRequest
            ? { pullRequestId: input.pullRequest.pullRequestId }
            : {}),
        },
      });
    },
    async cancelExperiment(input) {
      await prisma.experiment.update({
        where: { id: input.experimentId },
        data: {
          status: "cancelled",
          conclusion: input.conclusion as Prisma.InputJsonValue,
        },
      });
    },
  };
}

export function createExperimentGithubPublisher(opts: {
  prisma: PrismaClient;
  adapter: GithubAdapter;
  workspaceId: string;
}): ExperimentPublisher {
  return {
    async createPullRequest(req: ExperimentPullRequestRequest) {
      const ws = await opts.prisma.workspace.findUnique({
        where: { id: opts.workspaceId },
        select: { opsRepoId: true },
      });
      if (!ws?.opsRepoId) {
        throw new Error("experiment_evaluate: workspace has no ops repository connected");
      }
      const repo = await opts.prisma.githubRepo.findUnique({
        where: { id: ws.opsRepoId },
        select: { id: true, owner: true, name: true, defaultBranch: true },
      });
      if (!repo) {
        throw new Error(
          `experiment_evaluate: ops repo ${ws.opsRepoId} not found in github_repos`,
        );
      }
      const files: CreatePullRequestFile[] = req.files.map((file) => ({
        path: file.path,
        action: file.action,
        diff: file.diff,
      }));
      const created = await opts.adapter.createPullRequest({
        spec: {
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        },
        title: req.prTitle,
        body: req.prBody,
        branchName: req.branchName,
        files,
        baseRef: req.baseRef || repo.defaultBranch,
      });
      const previewUpdatedAt = new Date();
      const prRow = await opts.prisma.githubPullRequest.upsert({
        where: { repoId_number: { repoId: repo.id, number: created.number } },
        update: {
          title: req.prTitle,
          state: "open",
          headSha: created.headSha,
          baseRef: req.baseRef || repo.defaultBranch,
          htmlUrl: created.htmlUrl,
          body: req.prBody,
          filesChangedJson: summarizeFilesForPreview(req.files) as unknown as Prisma.InputJsonValue,
          filesChangedCount: req.files.length,
          previewSource: "experiment_evaluate",
          previewUpdatedAt,
        },
        create: {
          repoId: repo.id,
          number: created.number,
          title: req.prTitle,
          state: "open",
          headSha: created.headSha,
          baseRef: req.baseRef || repo.defaultBranch,
          htmlUrl: created.htmlUrl,
          body: req.prBody,
          filesChangedJson: summarizeFilesForPreview(req.files) as unknown as Prisma.InputJsonValue,
          filesChangedCount: req.files.length,
          previewSource: "experiment_evaluate",
          previewUpdatedAt,
        },
        select: { id: true },
      });
      return {
        pullRequestId: prRow.id,
        prNumber: created.number,
        htmlUrl: created.htmlUrl,
        headSha: created.headSha,
      };
    },
  };
}

const PREVIEW_MAX_FILES = 50;
const PREVIEW_MAX_DIFF_BYTES = 4096;

function summarizeFilesForPreview(files: ExperimentPullRequestRequest["files"]) {
  const slice = files.slice(0, PREVIEW_MAX_FILES);
  return {
    files: slice.map((file) => {
      const byteLength = Buffer.byteLength(file.diff, "utf8");
      const diffPreview =
        byteLength > PREVIEW_MAX_DIFF_BYTES
          ? truncateUtf8(file.diff, PREVIEW_MAX_DIFF_BYTES)
          : file.diff;
      return {
        path: file.path,
        action: file.action,
        diffPreview,
        diffTruncated: byteLength > PREVIEW_MAX_DIFF_BYTES,
        diffByteLength: byteLength,
        additions: countDiffLines(file.diff, "+"),
        deletions: countDiffLines(file.diff, "-"),
      };
    }),
    truncatedFileCount: files.length - slice.length,
    totalFileCount: files.length,
  };
}

function countDiffLines(diff: string, marker: "+" | "-"): number {
  return diff
    .split("\n")
    .filter((line) => line.startsWith(marker) && !line.startsWith(`${marker}${marker}${marker}`))
    .length;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.byteLength <= maxBytes) return value;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "") + "\n...";
}
