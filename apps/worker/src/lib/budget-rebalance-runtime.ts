// AdDroid OSS — apps/worker budget_rebalance wiring.
//
// queue の純粋な `runBudgetRebalanceOnce` に、Prisma 由来の adset / snapshot
// store、GitHub PR publisher、audit writer を差し込む。Meta への直接変更は
// 行わず、operation manifest を ops repo PR として提案するだけに留める。

import fs from "node:fs";
import { Prisma, type PrismaClient } from "@addroid/db";
import type {
  CreatePullRequestFile,
  GithubAdapter,
} from "@addroid/github-adapter";
import {
  loadBudgetRebalancePolicy as loadBudgetRebalancePolicyYaml,
  type BudgetRebalancePolicyYaml,
} from "@addroid/ops-schemas";
import {
  rebalanceCandidateFromSnapshot,
  type BudgetRebalanceAuditInput,
  type BudgetRebalanceAuditWriter,
  type BudgetRebalancePolicy,
  type BudgetRebalancePullRequestRequest,
  type BudgetRebalancePublisher,
  type BudgetRebalanceStore,
  type DailyReportAdAccountSnapshot,
} from "@addroid/queue";

export function createPrismaBudgetRebalanceStore(
  prisma: PrismaClient,
): BudgetRebalanceStore {
  return {
    async findAdAccount(input): Promise<DailyReportAdAccountSnapshot | null> {
      const row = await prisma.adAccount.findUnique({
        where: {
          workspaceId_key: {
            workspaceId: input.workspaceId,
            key: input.accountKey,
          },
        },
        select: {
          id: true,
          key: true,
          displayName: true,
          metaAccountId: true,
          currency: true,
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        displayName: row.displayName,
        metaAccountId: row.metaAccountId,
        currency: row.currency ?? "JPY",
      };
    },
    async listRebalanceCandidates(input) {
      const account = await prisma.adAccount.findUnique({
        where: { id: input.accountId },
        select: { currency: true },
      });
      const nodes = await prisma.adsHierarchyNode.findMany({
        where: {
          accountId: input.accountId,
          nodeType: "adset",
          status: "active",
          ...(input.excludeNodeKeys.length
            ? { nodeKey: { notIn: input.excludeNodeKeys } }
            : {}),
        },
        select: {
          id: true,
          nodeKey: true,
          externalId: true,
          displayName: true,
          spec: true,
        },
        orderBy: { nodeKey: "asc" },
      });
      if (nodes.length === 0) return [];

      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const nodeByMetricKey = new Map<string, (typeof nodes)[number]>();
      for (const node of nodes) {
        nodeByMetricKey.set(node.nodeKey, node);
        if (node.externalId) nodeByMetricKey.set(node.externalId, node);
      }
      const metricKeys = [...nodeByMetricKey.keys()];
      const snapshots = await prisma.performanceSnapshot.findMany({
        where: {
          accountId: input.accountId,
          nodeType: "adset",
          metricDate: {
            gte: new Date(`${input.since}T00:00:00.000Z`),
            lte: new Date(`${input.until}T00:00:00.000Z`),
          },
          OR: [
            { hierarchyId: { in: nodes.map((node) => node.id) } },
            { nodeKey: { in: metricKeys } },
          ],
        },
        select: {
          hierarchyId: true,
          nodeKey: true,
          impressions: true,
          clicks: true,
          conversions: true,
          spendMicros: true,
        },
      });

      const totals = new Map<
        string,
        { spendMicros: bigint; impressions: number; clicks: number; conversions: number }
      >();
      for (const snapshot of snapshots) {
        const node =
          (snapshot.hierarchyId ? nodeById.get(snapshot.hierarchyId) : null) ??
          nodeByMetricKey.get(snapshot.nodeKey);
        if (!node) continue;
        const current = totals.get(node.id) ?? {
          spendMicros: 0n,
          impressions: 0,
          clicks: 0,
          conversions: 0,
        };
        current.spendMicros += snapshot.spendMicros;
        current.impressions += snapshot.impressions;
        current.clicks += snapshot.clicks;
        current.conversions += snapshot.conversions;
        totals.set(node.id, current);
      }

      const currency = account?.currency ?? "JPY";
      return nodes.map((node) => {
        const total = totals.get(node.id) ?? {
          spendMicros: 0n,
          impressions: 0,
          clicks: 0,
          conversions: 0,
        };
        return rebalanceCandidateFromSnapshot({
          nodeKey: node.nodeKey,
          displayName: node.displayName,
          currentDailyBudgetMajor: readDailyBudgetMajor(node.spec, currency),
          spendMicros: total.spendMicros,
          impressions: total.impressions,
          clicks: total.clicks,
          conversions: total.conversions,
        });
      });
    },
  };
}

export interface CreateBudgetRebalanceGithubPublisherOptions {
  prisma: PrismaClient;
  adapter: GithubAdapter;
  workspaceId: string;
}

export function createBudgetRebalanceGithubPublisher(
  opts: CreateBudgetRebalanceGithubPublisherOptions,
): BudgetRebalancePublisher {
  return {
    async createPullRequest(req: BudgetRebalancePullRequestRequest) {
      const ws = await opts.prisma.workspace.findUnique({
        where: { id: opts.workspaceId },
        select: { opsRepoId: true },
      });
      if (!ws?.opsRepoId) {
        throw new Error("budget_rebalance: workspace has no ops repository connected");
      }
      const repo = await opts.prisma.githubRepo.findUnique({
        where: { id: ws.opsRepoId },
        select: { id: true, owner: true, name: true, defaultBranch: true },
      });
      if (!repo) {
        throw new Error(
          `budget_rebalance: ops repo ${ws.opsRepoId} not found in github_repos`,
        );
      }

      const files: CreatePullRequestFile[] = req.files.map((file) => ({
        path: file.path,
        diff: file.diff,
        action: file.action,
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
        where: {
          repoId_number: { repoId: repo.id, number: created.number },
        },
        update: {
          title: req.prTitle,
          state: "open",
          headSha: created.headSha,
          baseRef: req.baseRef || repo.defaultBranch,
          htmlUrl: created.htmlUrl,
          body: req.prBody,
          filesChangedJson: summarizeFilesForPreview(req.files) as unknown as Prisma.InputJsonValue,
          filesChangedCount: req.files.length,
          previewSource: "budget_rebalance",
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
          previewSource: "budget_rebalance",
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

export function createBudgetRebalanceAuditWriter(opts: {
  prisma: PrismaClient;
}): BudgetRebalanceAuditWriter {
  return {
    async recordBudgetRebalanceAudit(input: BudgetRebalanceAuditInput) {
      await opts.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: "addroid",
          action: input.action,
          target: input.pullRequest
            ? `github_pull_request:${input.pullRequest.pullRequestId}`
            : `ad_account:${input.accountId}`,
          ref: input.pullRequest ? `#${input.pullRequest.prNumber}` : input.accountKey,
          metadata: {
            source: "budget_rebalance",
            summary: input.summary,
            accountKey: input.accountKey,
            cronRunId: input.cronRunId,
            classification: input.classification,
            auditDecision: input.auditDecision,
            dangerousCategories: input.dangerousCategories,
            ...input.metadata,
          } as Prisma.InputJsonValue,
        },
      });
    },
  };
}

export function loadBudgetRebalancePolicyForRoot(
  root: string | null | undefined,
): BudgetRebalancePolicy | null {
  if (!root || !fs.existsSync(root)) return null;
  const yaml = loadBudgetRebalancePolicyYaml(root);
  return yaml ? budgetRebalancePolicyFromYaml(yaml) : null;
}

function budgetRebalancePolicyFromYaml(
  yaml: BudgetRebalancePolicyYaml,
): BudgetRebalancePolicy {
  return {
    enabled: yaml.enabled,
    lookbackDays: yaml.lookbackDays,
    maxShiftPercentPerRun: yaml.maxShiftPercentPerRun,
    minDailyBudgetMajor: yaml.minDailyBudgetMajor,
    minConversionsForJudgement: yaml.minConversionsForJudgement,
    keepTotalBudget: yaml.keepTotalBudget,
    excludeNodeKeys: yaml.excludeNodeKeys,
  };
}

function readDailyBudgetMajor(spec: Prisma.JsonValue | null, currency: string): number {
  if (!isRecord(spec)) return 0;
  const major =
    readNumberAt(spec, ["budget", "dailyBudget"]) ??
    readNumberAt(spec, ["dailyBudget"]) ??
    readNumberAt(spec, ["daily_budget_major"]) ??
    readNumberAt(spec, ["budget", "daily_budget_major"]);
  if (major !== null) return major;
  const minor =
    readNumberAt(spec, ["raw", "daily_budget"]) ??
    readNumberAt(spec, ["raw", "dailyBudget"]) ??
    readNumberAt(spec, ["daily_budget"]) ??
    readNumberAt(spec, ["budget", "daily_budget"]);
  return minor === null ? 0 : minorToMajor(minor, currency);
}

function readNumberAt(
  value: Record<string, unknown>,
  path: string[],
): number | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string" && current.trim()) {
    const parsed = Number(current);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function minorToMajor(value: number, currency: string): number {
  const divisor = zeroDecimalCurrencies.has(currency.toUpperCase()) ? 1 : 100;
  return Math.round((value / divisor) * 100) / 100;
}

const zeroDecimalCurrencies = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PREVIEW_MAX_FILES = 50;
const PREVIEW_MAX_DIFF_BYTES = 4096;

function summarizeFilesForPreview(files: BudgetRebalancePullRequestRequest["files"]) {
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
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "") + "\n…";
}
