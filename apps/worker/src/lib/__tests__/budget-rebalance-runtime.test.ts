import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@addroid/db";
import type { CreatePullRequestInput, GithubAdapter } from "@addroid/github-adapter";
import {
  createBudgetRebalanceAuditWriter,
  createBudgetRebalanceGithubPublisher,
} from "../budget-rebalance-runtime.js";

test("budget_rebalance publisher opens a GitOps PR without an LLM provider", async () => {
  const adapter = new FakeGithubAdapter();
  const prisma = fakePrisma();
  const publisher = createBudgetRebalanceGithubPublisher({
    prisma: prisma as unknown as PrismaClient,
    adapter: adapter as unknown as GithubAdapter,
    workspaceId: "ws-1",
  });

  const result = await publisher.createPullRequest({
    branchName: "addroid/budget-rebalance-act_1-test",
    prTitle: "Budget rebalance proposal (act_1)",
    prBody: "body",
    baseRef: "main",
    files: [
      {
        path: "operations/act_1/test-budget_rebalance.json",
        action: "create",
        diff: "--- /dev/null\n+++ b/operations/act_1/test-budget_rebalance.json\n@@\n+{}",
      },
    ],
  });

  assert.equal(result.prNumber, 42);
  assert.equal(adapter.inputs.length, 1);
  assert.equal(adapter.inputs[0]!.spec.owner, "bb8ad8");
  assert.equal(adapter.inputs[0]!.files[0]!.path, "operations/act_1/test-budget_rebalance.json");
  assert.equal(prisma.githubPullRequest.rows[0]!.previewSource, "budget_rebalance");
});

test("budget_rebalance audit writer records approval-required metadata without approval records", async () => {
  const prisma = fakePrisma();
  const audit = createBudgetRebalanceAuditWriter({
    prisma: prisma as unknown as PrismaClient,
  });

  await audit.recordBudgetRebalanceAudit({
    workspaceId: "ws-1",
    accountKey: "act_1",
    accountId: "acc-1",
    cronRunId: "cron-1",
    action: "budget_rebalance.opened",
    pullRequest: {
      pullRequestId: "pr-row-1",
      prNumber: 42,
      htmlUrl: "https://github.example/pull/42",
      headSha: "abc",
    },
    classification: "requires_approval",
    auditDecision: "approval_required",
    dangerousCategories: ["budget_increase"],
    metadata: { candidateCount: 3 },
    summary: "opened",
  });

  assert.equal(prisma.auditLog.rows.length, 1);
  assert.equal(prisma.auditLog.rows[0]!.action, "budget_rebalance.opened");
  assert.equal(prisma.auditLog.rows[0]!.target, "github_pull_request:pr-row-1");
  assert.equal(prisma.auditLog.rows[0]!.metadata.auditDecision, "approval_required");
  assert.equal(prisma.auditLog.rows[0]!.metadata.source, "budget_rebalance");
});

class FakeGithubAdapter {
  inputs: CreatePullRequestInput[] = [];

  async createPullRequest(input: CreatePullRequestInput) {
    this.inputs.push(input);
    return {
      number: 42,
      htmlUrl: "https://github.example/bb8ad8/addroid-ops/pull/42",
      headSha: "abc123",
    };
  }
}

function fakePrisma() {
  return {
    workspace: {
      async findUnique() {
        return { opsRepoId: "repo-1" };
      },
    },
    githubRepo: {
      async findUnique() {
        return {
          id: "repo-1",
          owner: "bb8ad8",
          name: "addroid-ops",
          defaultBranch: "main",
        };
      },
    },
    githubPullRequest: {
      rows: [] as Array<Record<string, unknown>>,
      async upsert(input: { create: Record<string, unknown>; update: Record<string, unknown> }) {
        this.rows.push(input.create);
        return { id: "pr-row-1" };
      },
    },
    auditLog: {
      rows: [] as Array<{
        action: string;
        target: string | null;
        metadata: Record<string, unknown>;
      }>,
      async create(input: {
        data: {
          action: string;
          target: string | null;
          metadata: Record<string, unknown>;
        };
      }) {
        this.rows.push(input.data);
        return { id: "audit-1" };
      },
    },
  };
}
