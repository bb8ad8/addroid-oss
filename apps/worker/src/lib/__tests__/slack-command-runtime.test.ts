// AdDroid OSS — apps/worker `/adops` slash command handlers (Regression fix).
//
// Prisma / Meta CLI / Slack を一切起動せず、`createSlackCommandHandlers` が
// 返す 6 ハンドラの routing と summary を in-memory fake で検証する。

import test from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@addroid/db";
import type {
  AdAccountLockProvider,
  BudgetGuardAuditRunner,
  BudgetGuardStore,
  BudgetGuardSummary,
  DailyReportAnalystRunner,
  DailyReportInsightsProvider,
  DailyReportSnapshotStore,
  DailyReportSummary,
  ImprovementPrAuditWriter,
  ImprovementPrGithubPublisher,
  ImprovementPrPipelineRunner,
  ImprovementPrPlanValidator,
  ImprovementPrStore,
  ImprovementPrSummary,
  SlackCommandJobPayload,
  SlashHandlerInput,
} from "@addroid/queue";
import type { MetaAdapter } from "@addroid/meta-adapter";

import { createSlackCommandHandlers } from "../slack-command-runtime.js";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

interface FakeAdAccountRow {
  id: string;
  workspaceId: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
  modeOverride: string | null;
  active: boolean;
}

interface FakeWorkspaceRow {
  id: string;
  slug: string;
  executionMode: string;
  opsRepoId: string | null;
}

interface FakeAdsHierarchyRow {
  id: string;
  accountId: string;
  workspaceId: string;
  externalId: string | null;
  nodeKey: string;
}

function fakePrisma(opts: {
  workspaces?: FakeWorkspaceRow[];
  adAccounts?: FakeAdAccountRow[];
  pendingPrCount?: number;
  recentAiRunCount?: number;
  hierarchyNodes?: FakeAdsHierarchyRow[];
} = {}): PrismaClient {
  const workspaces = opts.workspaces ?? [];
  const adAccounts = opts.adAccounts ?? [];
  const hierarchies = opts.hierarchyNodes ?? [];
  const pendingPrCount = opts.pendingPrCount ?? 0;
  const recentAiRunCount = opts.recentAiRunCount ?? 0;
  const fake = {
    workspace: {
      findUnique: async (q: { where: { id: string } }) =>
        workspaces.find((w) => w.id === q.where.id) ?? null,
    },
    adAccount: {
      findMany: async (q: {
        where: { workspaceId: string; active: boolean };
      }) =>
        adAccounts.filter(
          (a) => a.workspaceId === q.where.workspaceId && a.active === q.where.active
        ),
      count: async (q: { where: { workspaceId: string; active: boolean } }) =>
        adAccounts.filter(
          (a) => a.workspaceId === q.where.workspaceId && a.active === q.where.active
        ).length,
    },
    githubPullRequest: { count: async () => pendingPrCount },
    aiRun: { count: async () => recentAiRunCount },
    applyJob: { findFirst: async () => null },
    adsHierarchyNode: {
      findFirst: async (q: {
        where: {
          id?: string;
          externalId?: string;
          nodeKey?: string;
          account: { workspaceId: string };
        };
      }) => {
        const wsId = q.where.account.workspaceId;
        if (q.where.id) {
          return hierarchies.find(
            (h) => h.id === q.where.id && h.workspaceId === wsId
          ) ?? null;
        }
        if (q.where.externalId) {
          return hierarchies.find(
            (h) =>
              h.externalId === q.where.externalId && h.workspaceId === wsId
          ) ?? null;
        }
        if (q.where.nodeKey) {
          return hierarchies.find(
            (h) => h.nodeKey === q.where.nodeKey && h.workspaceId === wsId
          ) ?? null;
        }
        return null;
      },
    },
    performanceSnapshot: {
      findFirst: async () => null,
      findMany: async () => [],
    },
  };
  return fake as unknown as PrismaClient;
}

function passThroughLockProvider(): AdAccountLockProvider {
  return {
    withLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
  };
}

function buildPayload(
  partial: Partial<SlackCommandJobPayload> = {}
): SlackCommandJobPayload {
  return {
    subcommand: "report",
    target: "",
    rest: [],
    rawText: "report",
    slackUserId: "U001",
    slackUserName: "alice",
    slackChannelId: "C001",
    slackTeamId: "T001",
    responseUrl: "https://hooks.slack.com/commands/T1/2/abc",
    enqueuedAt: "2026-05-02T00:00:00.000Z",
    ...partial,
  };
}

// Minimal fakes for the workflow-level dependencies. The handler does not
// inspect the internal results beyond `status`, `pullRequest`, etc.
const FAKE_METRIC = "2026-05-02";

function buildDailyReportSummary(
  accountKey: string,
  status: DailyReportSummary["status"]
): DailyReportSummary {
  return {
    status,
    workspaceId: "ws-1",
    accountKey,
    accountId: status === "no_account" ? null : `acct-${accountKey}`,
    currency: "JPY",
    metricDate: FAKE_METRIC,
    priorMetricDate: "2026-05-01",
    metricTimeZone: "Asia/Tokyo",
    insightsSource: "mock",
    current: {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpc: 0,
      cpa: 0,
      cv: 0,
      cpm: 0,
      frequency: null,
    },
    prior: {
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpc: 0,
      cpa: 0,
      cv: 0,
      cpm: 0,
      frequency: null,
    },
    deltas: {},
    statisticalContext: {
      comparisons: [],
      confidence: "insufficient",
    },
    anomalies: {
      findings: [],
      evaluatedNodeCount: 0,
      quietDay: true,
    },
    snapshotIds: [],
    aiCommentary: status === "succeeded" ? `commentary for ${accountKey}` : null,
    topImprovements: [],
    aiRunId: status === "succeeded" ? "ai-1" : null,
    mode: "proposal",
  };
}

function buildBudgetGuardSummary(
  accountKey: string,
  status: BudgetGuardSummary["status"]
): BudgetGuardSummary {
  return {
    status,
    workspaceId: "ws-1",
    accountKey,
    accountId: status === "no_account" ? null : `acct-${accountKey}`,
    mode: "proposal",
    aiRunId: null,
    classification: null,
    decision: null,
    dangerousCategories: [],
    policyReasons: [],
    candidateCount: 0,
    alerts: [],
  };
}

function buildImprovementPrSummary(
  accountKey: string,
  status: ImprovementPrSummary["status"],
  withPr = false
): ImprovementPrSummary {
  const pr = withPr
    ? {
        pullRequestId: `pr-row-${accountKey}`,
        prNumber: 42,
        htmlUrl: `https://example.test/pr/${accountKey}`,
        headSha: "deadbeef",
      }
    : null;
  return {
    status,
    workspaceId: "ws-1",
    accountKey,
    accountId: `acct-${accountKey}`,
    currency: "JPY",
    mode: "proposal",
    aiRunId: null,
    aiRunIds: [],
    creativeIds: [],
    decision: null,
    proposalCount: 0,
    classification: null,
    auditDecision: null,
    dangerousCategories: [],
    pullRequest: pr,
  };
}

// `runDailyReportOnce` 等は store/insights/analyst を内部から呼ぶが、ここでは
// 「呼ばれたかどうか」を観測したいだけ。store の findAdAccount を返さない
// (= no_account) と単純化したいので、accountKey ごとに pre-built summary を返す
// ように `dailyReportStore.findAdAccount` を実装する。
// ここでは workflow を直接モックする代わりに、`runDailyReportOnce` の
// `findAdAccount: () => null` 経路 (= status="no_account") を返させて handler の
// per-account 集計と "0 succeeded" メッセージを観測する。

function fakeDailyReportStore(): DailyReportSnapshotStore {
  return {
    async findAdAccount() {
      return null;
    },
    async upsertPerformanceSnapshot() {
      throw new Error("not used in test");
    },
    async createAiRun() {
      throw new Error("not used in test");
    },
    async listSnapshotSeries() {
      return [];
    },
  };
}

function fakeDailyReportInsights(): DailyReportInsightsProvider {
  return {
    async fetchInsights() {
      return { current: [], prior: [], source: "mock" };
    },
  };
}

function fakeDailyReportAnalyst(): DailyReportAnalystRunner {
  return {
    async run() {
      throw new Error("not used in test");
    },
  };
}

function fakeBudgetGuardStore(): BudgetGuardStore {
  return {
    async findAdAccount() {
      return null;
    },
    async createAiRun() {
      throw new Error("not used in test");
    },
  };
}

function fakeBudgetGuardAuditRunner(): BudgetGuardAuditRunner {
  return {
    async run() {
      throw new Error("not used in test");
    },
  };
}

function fakeImprovementPrStore(): ImprovementPrStore {
  return {
    async findAdAccount() {
      return null;
    },
    async createAiRun() {
      throw new Error("not used in test");
    },
    async createCreative() {
      throw new Error("not used in test");
    },
    async linkCreativesToPullRequest() {
      throw new Error("not used in test");
    },
  };
}

function fakeImprovementPrPipeline(): ImprovementPrPipelineRunner {
  // すべて throw しない (no_account 経路でしか呼ばれないため、この実装は届かない想定)。
  const noopAi = () => ({
    aiRunInput: {} as never,
    output: null,
    error: "not used in test",
  });
  return {
    async runAnalyst() {
      return noopAi();
    },
    async runStrategy() {
      return noopAi();
    },
    async runCopy() {
      return noopAi();
    },
    async runImagePrompt() {
      return noopAi();
    },
    async runCreativeQa() {
      return noopAi();
    },
    async runMediaBuyer() {
      return { ...noopAi(), decision: null };
    },
    async runGitOps() {
      return { ...noopAi(), decision: null };
    },
    async runAudit() {
      return { ...noopAi(), decision: null };
    },
  };
}

function fakeImprovementPrPublisher(): ImprovementPrGithubPublisher {
  return {
    async createPullRequest() {
      throw new Error("not used in test");
    },
  };
}

function fakeImprovementPrPlanValidator(): ImprovementPrPlanValidator {
  return {
    async validate() {
      return {
        available: false,
        ok: false,
        risk: "error",
        counts: { creates: 0, updates: 0, deletes: 0, errors: 0, warnings: 0 },
        errors: [],
        warnings: [],
        summary: "skipped",
        durationMs: 0,
      };
    },
  };
}

function fakeImprovementPrAudit(): ImprovementPrAuditWriter {
  return {
    async recordImprovementPrAudit() {
      // no-op
    },
  };
}

function fakeMetaAdapter(): MetaAdapter {
  // 本テストでは activate は executeActivate 内で先に prisma の AdsHierarchy を
  // 引いて null になる経路 (= node_not_found) を観測するか、もしくは
  // node_not_found を resolveActivateTarget の段階で先に判定するため、
  // metaAdapter は呼ばれない。型を満たす最小スタブとして渡す。
  return {} as unknown as MetaAdapter;
}

// ---------------------------------------------------------------------
// 全 6 ハンドラの存在
// ---------------------------------------------------------------------

test("createSlackCommandHandlers は 6 サブコマンドのハンドラを返す", () => {
  const h = createSlackCommandHandlers(buildDeps({}));
  assert.equal(typeof h.report, "function");
  assert.equal(typeof h.budget, "function");
  assert.equal(typeof h.improve, "function");
  assert.equal(typeof h.status, "function");
  assert.equal(typeof h.accounts, "function");
  assert.equal(typeof h.activate, "function");
});

// ---------------------------------------------------------------------
// status
// ---------------------------------------------------------------------

test("status: workspace mode + counts を含む 1 行サマリを返す", async () => {
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        {
          id: "ws-1",
          slug: "default",
          executionMode: "proposal",
          opsRepoId: "repo-1",
        },
      ],
      adAccounts: [
        accountRow("primary"),
        accountRow("secondary"),
      ],
      pendingPrCount: 3,
      recentAiRunCount: 7,
    },
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.status({ payload: buildPayload({ subcommand: "status" }) });
  assert.equal(r.state, "succeeded");
  assert.match(r.text, /workspace=default/);
  assert.match(r.text, /mode=proposal/);
  assert.match(r.text, /active_accounts=2/);
  assert.match(r.text, /pending_prs=3/);
  assert.match(r.text, /ai_runs_24h=7/);
});

// ---------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------

test("accounts: 空状態は登録ガイドを返す", async () => {
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        { id: "ws-1", slug: "default", executionMode: "proposal", opsRepoId: null },
      ],
      adAccounts: [],
    },
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.accounts({ payload: buildPayload({ subcommand: "accounts" }) });
  assert.equal(r.state, "succeeded");
  assert.match(r.text, /登録された ad_account がありません/);
});

test("accounts: 全 ad_account を 1 行ずつ列挙する", async () => {
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        { id: "ws-1", slug: "default", executionMode: "proposal", opsRepoId: null },
      ],
      adAccounts: [
        { ...accountRow("primary"), metaAccountId: "act_111" },
        { ...accountRow("secondary"), modeOverride: "report_only" },
      ],
    },
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.accounts({ payload: buildPayload({ subcommand: "accounts" }) });
  assert.equal(r.state, "succeeded");
  assert.match(r.text, /Active ad_accounts \(2\)/);
  assert.match(r.text, /primary/);
  assert.match(r.text, /act_111/);
  assert.match(r.text, /mode_override=report_only/);
});

// ---------------------------------------------------------------------
// report (no_account 経路で per-account 集計を観測)
// ---------------------------------------------------------------------

test("report: ad_account が無いと skip メッセージを返す", async () => {
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        { id: "ws-1", slug: "default", executionMode: "proposal", opsRepoId: null },
      ],
      adAccounts: [],
    },
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.report({ payload: buildPayload({ subcommand: "report" }) });
  assert.equal(r.state, "succeeded");
  assert.match(r.text, /アクティブな ad_account がない/);
});

test("report: account あり + store=no_account のとき failed=0 で succeeded", async () => {
  // dailyReportStore.findAdAccount は null を返すため、runDailyReportOnce は
  // status="no_account" を返す。handler はこれを ai_failed としてカウントしない。
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        { id: "ws-1", slug: "default", executionMode: "proposal", opsRepoId: null },
      ],
      adAccounts: [accountRow("primary"), accountRow("secondary")],
    },
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.report({ payload: buildPayload({ subcommand: "report" }) });
  assert.equal(r.state, "succeeded");
  assert.match(r.text, /processed 2 ad_accounts/);
  assert.match(r.text, /ai_failed=0/);
});

// ---------------------------------------------------------------------
// improve (ops repo 未連携 → ops_repo_not_configured)
// ---------------------------------------------------------------------

test("improve: ops repo 未連携なら ops_repo_not_configured で failed", async () => {
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        { id: "ws-1", slug: "default", executionMode: "proposal", opsRepoId: null },
      ],
      adAccounts: [accountRow("primary")],
    },
    loadImprovementPrRepo: async () => ({ repoSpec: "", baseRef: "main" }),
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.improve({
    payload: buildPayload({ subcommand: "improve" }),
  });
  assert.equal(r.state, "failed");
  assert.equal(r.errorCode, "ops_repo_not_configured");
});

// ---------------------------------------------------------------------
// activate (target 解決 + node_not_found)
// ---------------------------------------------------------------------

test("activate: target が空なら missing_target で failed", async () => {
  const deps = buildDeps({});
  const h = createSlackCommandHandlers(deps);
  const r = await h.activate({
    payload: buildPayload({ subcommand: "activate", target: "" }),
  });
  assert.equal(r.state, "failed");
  assert.equal(r.errorCode, "missing_target");
});

test("activate: workspace 配下に該当 hierarchy が無いと node_not_found", async () => {
  const deps = buildDeps({
    prismaOpts: {
      workspaces: [
        { id: "ws-1", slug: "default", executionMode: "proposal", opsRepoId: null },
      ],
      adAccounts: [accountRow("primary")],
      hierarchyNodes: [],
    },
  });
  const h = createSlackCommandHandlers(deps);
  const r = await h.activate({
    payload: buildPayload({ subcommand: "activate", target: "missing-id" }),
  });
  assert.equal(r.state, "failed");
  assert.equal(r.errorCode, "node_not_found");
  assert.match(r.text, /missing-id/);
});

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function accountRow(key: string): FakeAdAccountRow {
  return {
    id: `acct-${key}`,
    workspaceId: "ws-1",
    key,
    displayName: `${key} display`,
    metaAccountId: null,
    modeOverride: null,
    active: true,
  };
}

function buildDeps(opts: {
  prismaOpts?: Parameters<typeof fakePrisma>[0];
  loadImprovementPrRepo?: () => Promise<{ repoSpec: string; baseRef: string }>;
}): Parameters<typeof createSlackCommandHandlers>[0] {
  const prisma = fakePrisma(opts.prismaOpts ?? {});
  return {
    prisma,
    workspaceId: "ws-1",
    adAccountLockProvider: passThroughLockProvider(),
    dailyReportStore: fakeDailyReportStore(),
    dailyReportInsights: fakeDailyReportInsights(),
    dailyReportAnalyst: fakeDailyReportAnalyst(),
    budgetGuardStore: fakeBudgetGuardStore(),
    budgetGuardAuditRunner: fakeBudgetGuardAuditRunner(),
    loadBudgetGuardPolicy: () => null,
    improvementPrStore: fakeImprovementPrStore(),
    improvementPrPipeline: fakeImprovementPrPipeline(),
    improvementPrPublisher: fakeImprovementPrPublisher(),
    improvementPrPlanValidator: fakeImprovementPrPlanValidator(),
    improvementPrAudit: fakeImprovementPrAudit(),
    loadImprovementPrRepo:
      opts.loadImprovementPrRepo ??
      (async () => ({ repoSpec: "owner/repo", baseRef: "main" })),
    metaAdapter: fakeMetaAdapter(),
    env: {},
    webBaseUrl: null,
  };
}

// keep unused references reachable (silence noUnusedLocals if any helpers
// happen to remain unused in this skeleton)
void buildDailyReportSummary;
void buildBudgetGuardSummary;
void buildImprovementPrSummary;
void ((_: SlashHandlerInput) => undefined);
