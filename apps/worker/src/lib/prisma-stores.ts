// AdDroid OSS — `@addroid/queue` の Store interface を Prisma で実装する。
//
// queue パッケージは prisma を直接 import せず、`CronOpsStore` /
// `GithubPollStore` という最小 interface に依存する。本ファイルが workspaceId を
// 閉じ込めて Prisma クライアントへ橋渡しする層。

import { Prisma, type PrismaClient } from "@addroid/db";
import type {
  ApplyApprovalSnapshot,
  ApplyJobContext,
  ApplyJobStore,
  CronOpsStore,
  ExecutionLogInput,
  FailCronRunInput,
  FinishCronRunInput,
  GithubPollStore,
  MarkApplyFinishedInput,
  MarkApplyRunningInput,
  PrApprovalDecision,
  RecordApplyAuditInput,
  RecordApplyBlockedInput,
  RecordApplyJobInput,
  RecordMergeAuditInput,
  RecordPollingStateInput,
  RecordPrApprovalInput,
  DiscordCommandAuditInput,
  DiscordCommandAuditWriter,
  SlackCommandAuditInput,
  SlackCommandAuditWriter,
  StartCronRunInput,
  UpsertAppliedAdsNodeInput,
  UpsertCronScheduleInput,
  UpsertPullRequestInput,
} from "@addroid/queue";
import type {
  DiscordNotificationAuditInput,
  DiscordNotificationAuditWriter,
  NotificationAuditInput,
  NotificationAuditWriter,
} from "@addroid/config";

function normalizePrApprovalDecision(value: string | null): PrApprovalDecision | null {
  return value === "approved" ||
    value === "rejected" ||
    value === "auto_blocked" ||
    value === "auto_approved"
    ? value
    : null;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readJsonString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// ---------------------------------------------------------------------
// workspace bootstrap (worker 起動時に config.yaml の slug で upsert する)
// ---------------------------------------------------------------------
export interface EnsureWorkspaceInput {
  slug: string;
  displayName: string;
  configPath: string;
  storageDir: string;
  databaseUrlRef?: string;
  /**
   * Regression fix: config.yaml の workspace.executionMode を
   * 初回 create 時のシード値として渡す。`upsertCronSchedule` と同じく "create
   * -or-keep" の挙動 — 既存行はここで上書きしない (UI / CLI からの mode 変更が
   * worker 再起動で巻き戻らないようにするため)。
   */
  executionMode?: "report_only" | "proposal" | "auto_apply";
}

export async function ensureWorkspace(
  prisma: PrismaClient,
  input: EnsureWorkspaceInput
): Promise<{ id: string; slug: string; executionMode: string }> {
  const ws = await prisma.workspace.upsert({
    where: { slug: input.slug },
    update: {
      displayName: input.displayName,
      configPath: input.configPath,
      storageDir: input.storageDir,
      databaseUrlRef: input.databaseUrlRef ?? null,
      // executionMode は意図的に update から外す (DB を source of truth として扱う)。
    },
    create: {
      slug: input.slug,
      displayName: input.displayName,
      configPath: input.configPath,
      storageDir: input.storageDir,
      databaseUrlRef: input.databaseUrlRef ?? null,
      ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    },
    select: { id: true, slug: true, executionMode: true },
  });
  return ws;
}

// ---------------------------------------------------------------------
// ops repo bootstrap → persistence boundary
//
// `GithubAdapter.bootstrapOpsRepo` の結果を Prisma に書き戻す唯一の経路。
// `github_repos` を upsert し、`Workspace.opsRepoId` を更新し、`audit_logs` に
// 1 行残す。これにより GithubPollStore.findOpsRepo が当該 ops repo を見つけられる
// ようになり、cron `github_poll` がポーリング対象として認識する。
// ---------------------------------------------------------------------
export interface PersistOpsRepoBootstrapInput {
  workspaceId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  bootstrappedAt: Date;
  filesCommitted: number;
}

export async function persistOpsRepoBootstrap(
  prisma: PrismaClient,
  input: PersistOpsRepoBootstrapInput
): Promise<{ repoId: string }> {
  const repo = await prisma.githubRepo.upsert({
    where: { owner_name: { owner: input.owner, name: input.name } },
    update: {
      defaultBranch: input.defaultBranch,
      bootstrappedAt: input.bootstrappedAt,
    },
    create: {
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch,
      bootstrappedAt: input.bootstrappedAt,
    },
    select: { id: true },
  });
  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: { opsRepoId: repo.id },
  });
  await prisma.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actor: "addroid",
      action: "ops_repo.bootstrapped",
      target: `github_repo:${repo.id}`,
      ref: `${input.owner}/${input.name}@${input.defaultBranch}`,
      metadata: {
        filesCommitted: input.filesCommitted,
      },
    },
  });
  return { repoId: repo.id };
}

// ---------------------------------------------------------------------
// CronOpsStore
// ---------------------------------------------------------------------
export function createCronOpsStore(
  prisma: PrismaClient,
  workspaceId: string
): CronOpsStore {
  return {
    async upsertCronSchedule(input: UpsertCronScheduleInput) {
      // this implementation: cron_schedules.enabled / cron は CLI (`addroid cron`)
      // で運用者が変更しうる。worker 再起動のたびに preset 既定値で上書きすると
      // CLI 側の enable/disable/set 操作が黙って巻き戻ってしまうため、行が無い
      // ときだけ create し、存在する行は触らない (= "create-or-keep")。
      // 既存値の検出には findUnique → create を使い、競合時は upsert へ倒す。
      const existing = await prisma.cronSchedule.findUnique({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
        select: { id: true },
      });
      if (existing) return { id: existing.id };
      const row = await prisma.cronSchedule.upsert({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
        update: {},
        create: {
          workspaceId: input.workspaceId,
          name: input.name,
          cron: input.cron,
          enabled: input.enabled,
        },
        select: { id: true },
      });
      return { id: row.id };
    },

    async startCronRun(input: StartCronRunInput) {
      const row = await prisma.cronRun.create({
        data: {
          scheduleId: input.scheduleId,
          name: input.name,
          jobId: input.jobId,
          state: "running",
        },
        select: { id: true },
      });
      return { id: row.id };
    },

    async finishCronRun(input: FinishCronRunInput) {
      await prisma.cronRun.update({
        where: { id: input.cronRunId },
        data: {
          state: "success",
          finishedAt: new Date(),
          durationMs: input.durationMs,
          output: (input.output ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      await prisma.cronSchedule.updateMany({
        where: { workspaceId, name: input.scheduleName },
        data: { lastRunState: "ok" },
      });
    },

    async failCronRun(input: FailCronRunInput) {
      await prisma.cronRun.update({
        where: { id: input.cronRunId },
        data: {
          state: "failed",
          finishedAt: new Date(),
          durationMs: input.durationMs,
          errorMessage: input.error,
        },
      });
      await prisma.cronSchedule.updateMany({
        where: { workspaceId, name: input.scheduleName },
        data: { lastRunState: "error" },
      });
    },

    async recordExecutionLog(input: ExecutionLogInput) {
      await prisma.executionLog.create({
        data: {
          cronRunId: input.cronRunId ?? null,
          workspaceId: input.workspaceId ?? workspaceId,
          kind: input.kind,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          level: input.level ?? "info",
          message: input.message,
          payload: (input.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------
// GithubPollStore
// ---------------------------------------------------------------------
export function createGithubPollStore(prisma: PrismaClient): GithubPollStore {
  return {
    async loadWorkspaceExecutionModeContext(input: { workspaceId: string }) {
      // regression fix: workspaces.executionMode と active な
      // ad_accounts.modeOverride を 1 セットで返す。`runGithubPollOnce` が
      // `resolveExecutionMode` で fail-closed 判定を行うため、ここでは raw
      // string を返すだけで unknown 値の正規化は queue 層に任せる。
      const ws = await prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { executionMode: true },
      });
      const accounts = await prisma.adAccount.findMany({
        where: { workspaceId: input.workspaceId, active: true },
        select: { modeOverride: true },
      });
      return {
        workspaceMode: ws?.executionMode ?? null,
        accountOverrides: accounts.map((a) => a.modeOverride ?? null),
      };
    },

    async findOpsRepo(workspaceId: string) {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { opsRepoId: true },
      });
      if (!ws?.opsRepoId) return null;
      const repo = await prisma.githubRepo.findUnique({
        where: { id: ws.opsRepoId },
        select: {
          id: true,
          owner: true,
          name: true,
          defaultBranch: true,
          pollingState: { select: { etag: true, lastModified: true } },
        },
      });
      if (!repo) return null;
      return {
        repoId: repo.id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        etag: repo.pollingState?.etag ?? null,
        lastModified: repo.pollingState?.lastModified ?? null,
      };
    },

    async recordPollingState(input: RecordPollingStateInput) {
      const now = new Date();
      await prisma.githubPollingState.upsert({
        where: { repoId: input.repoId },
        update: {
          etag: input.etag ?? null,
          lastModified: input.lastModified ?? null,
          lastStatusCode: input.lastStatusCode,
          lastPolledAt: now,
          nextPollAt: input.nextPollAt ?? null,
        },
        create: {
          repoId: input.repoId,
          resource: "pulls",
          etag: input.etag ?? null,
          lastModified: input.lastModified ?? null,
          lastStatusCode: input.lastStatusCode,
          lastPolledAt: now,
          nextPollAt: input.nextPollAt ?? null,
        },
      });
    },

    async upsertPullRequest(input: UpsertPullRequestInput) {
      const existing = await prisma.githubPullRequest.findUnique({
        where: { repoId_number: { repoId: input.repoId, number: input.number } },
        select: { id: true, state: true },
      });
      const wasMerged = existing?.state === "merged";
      const isMerged = input.state === "merged";
      const transitionedToMerged = isMerged && !wasMerged;
      const mergedAt = input.mergedAt ? new Date(input.mergedAt) : null;

      const row = await prisma.githubPullRequest.upsert({
        where: { repoId_number: { repoId: input.repoId, number: input.number } },
        update: {
          title: input.title,
          state: input.state,
          headSha: input.headSha,
          baseRef: input.baseRef,
          htmlUrl: input.htmlUrl,
          mergedAt,
          polledAt: new Date(),
        },
        create: {
          repoId: input.repoId,
          number: input.number,
          title: input.title,
          state: input.state,
          headSha: input.headSha,
          baseRef: input.baseRef,
          htmlUrl: input.htmlUrl,
          mergedAt,
        },
        select: { id: true },
      });
      return { id: row.id, transitionedToMerged };
    },

    async recordApplyJob(input: RecordApplyJobInput) {
      const row = await prisma.applyJob.create({
        data: {
          pullRequestId: input.pullRequestId,
          jobId: input.jobId || null,
          state: input.state,
        },
        select: { id: true },
      });
      return { id: row.id };
    },

    async recordMergeAudit(input: RecordMergeAuditInput) {
      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: "addroid",
          action: "apply.enqueued",
          target: `github_pull_request:${input.pullRequestId}`,
          ref: `pr#${input.prNumber}@${input.headSha}`,
          metadata: {
            prNumber: input.prNumber,
            headSha: input.headSha,
            htmlUrl: input.htmlUrl,
            jobId: input.jobId,
            applyJobId: input.applyJobId,
          },
        },
      });
    },

    async recordApplyBlocked(input: RecordApplyBlockedInput) {
      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: "addroid",
          action: "apply.blocked_unapproved",
          target: `github_pull_request:${input.pullRequestId}`,
          ref: `pr#${input.prNumber}@${input.headSha}`,
          metadata: {
            prNumber: input.prNumber,
            headSha: input.headSha,
            htmlUrl: input.htmlUrl,
            reason: input.reason,
            detail: input.detail,
          },
        },
      });
      await prisma.executionLog.create({
        data: {
          workspaceId: input.workspaceId,
          kind: "github_poll",
          refType: "pull_request",
          refId: input.pullRequestId,
          level: "warn",
          message: `merged PR #${input.prNumber} blocked: ${input.reason}`,
          payload: {
            prNumber: input.prNumber,
            headSha: input.headSha,
            htmlUrl: input.htmlUrl,
            reason: input.reason,
            detail: input.detail,
          },
        },
      });
    },

    async recordPrApproval(input: RecordPrApprovalInput) {
      await prisma.approvalRecord.create({
        data: {
          workspaceId: input.workspaceId,
          pullRequestId: input.pullRequestId,
          approvedBy: input.approvedBy,
          decision: input.decision,
          comment: input.comment ?? null,
          metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    },

    async findLatestPrApproval(input: { pullRequestId: string }) {
      const latest = await prisma.approvalRecord.findFirst({
        where: { pullRequestId: input.pullRequestId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          decision: true,
          approvedBy: true,
          metadata: true,
        },
      });
      const decision = latest?.decision ?? null;
      const normalized = normalizePrApprovalDecision(decision);
      if (!latest || !normalized) return null;
      const metadata = readJsonObject(latest.metadata);
      return {
        id: latest.id,
        decision: normalized,
        approvedBy: latest.approvedBy,
        headSha: readJsonString(metadata.headSha),
        mergeSha: readJsonString(metadata.mergeSha),
        decisionSource: readJsonString(metadata.decisionSource),
      };
    },
  };
}

// ---------------------------------------------------------------------
// ApplyJobStore — execute_apply ハンドラの永続化境界。
// ---------------------------------------------------------------------
export function createApplyJobStore(
  prisma: PrismaClient,
  workspaceId: string
): ApplyJobStore {
  return {
    async loadAccountExecutionModes(input: {
      workspaceId: string;
      accountKeys: readonly string[];
    }) {
      // regression fix: AdsLoader が返した accountKey 集合に対し、Meta CLI を
      // 起動する直前で workspace + per-account override を取り直す。
      // `runExecuteApply` は `resolveExecutionMode` を通して 1 件でも
      // `report_only` に倒れる account を見つけたら Meta executor を呼ばずに
      // fail-closed する (acceptance: "report_only never mutates Meta")。
      const ws = await prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { executionMode: true },
      });
      const overrideByAccountKey: Record<string, string | null> = {};
      if (input.accountKeys.length > 0) {
        const accounts = await prisma.adAccount.findMany({
          where: {
            workspaceId: input.workspaceId,
            key: { in: [...input.accountKeys] },
          },
          select: { key: true, modeOverride: true },
        });
        for (const acc of accounts) {
          overrideByAccountKey[acc.key] = acc.modeOverride ?? null;
        }
      }
      return {
        workspaceMode: ws?.executionMode ?? null,
        overrideByAccountKey,
      };
    },

    async findApplyJobContext(applyJobId: string): Promise<ApplyJobContext | null> {
      const row = await prisma.applyJob.findUnique({
        where: { id: applyJobId },
        select: {
          id: true,
          pullRequestId: true,
          pullRequest: {
            select: {
              id: true,
              number: true,
              headSha: true,
              htmlUrl: true,
              repoId: true,
            },
          },
        },
      });
      if (!row || !row.pullRequest) return null;
      return {
        applyJobId: row.id,
        pullRequestId: row.pullRequest.id,
        prNumber: row.pullRequest.number,
        headSha: row.pullRequest.headSha,
        htmlUrl: row.pullRequest.htmlUrl,
        repoId: row.pullRequest.repoId,
      };
    },

    async loadApplyApprovalSnapshot(
      applyJobId: string
    ): Promise<ApplyApprovalSnapshot | null> {
      // regression fix: PR / repo / 最新 approval_record を実行直前に再取得する。
      // 1 クエリで apply_job → PR → repo を取り、approval_records は別クエリで
      // 「最新 1 行」を引く (PR は 1:N で複数 decision を持ちうるため)。
      const row = await prisma.applyJob.findUnique({
        where: { id: applyJobId },
        select: {
          pullRequest: {
            select: {
              id: true,
              state: true,
              headSha: true,
              mergedAt: true,
            },
          },
        },
      });
      if (!row?.pullRequest) return null;
      const latest = await prisma.approvalRecord.findFirst({
        where: { pullRequestId: row.pullRequest.id },
        orderBy: { createdAt: "desc" },
        // regression fix: id も同時に取得し、Apply 経路 (runExecuteApply →
        // CliApplyExecutor → MetaCliInvocation.refs.approvalRecordId) が
        // 個々の Meta CLI 実行ログを承認境界に紐付けられるようにする。
        select: { id: true, decision: true, metadata: true },
      });
      const stateRaw = row.pullRequest.state;
      const pullRequestState: "open" | "closed" | "merged" =
        stateRaw === "open" || stateRaw === "closed" || stateRaw === "merged"
          ? stateRaw
          : "open"; // 想定外の string は最も保守的な "open" に倒し、revalidation で reject させる
      const decisionRaw = latest?.decision ?? null;
      const latestApprovalDecision: ApplyApprovalSnapshot["latestApprovalDecision"] =
        decisionRaw === "approved" ||
        decisionRaw === "rejected" ||
        decisionRaw === "auto_blocked" ||
        decisionRaw === "auto_approved"
          ? decisionRaw
          : null;
      return {
        pullRequestState,
        pullRequestHeadSha: row.pullRequest.headSha,
        latestApprovalDecision,
        approvalRecordId: latest?.id ?? null,
        approvalRecordHeadSha: readJsonString(readJsonObject(latest?.metadata).headSha),
        approvalRecordMergeSha: readJsonString(readJsonObject(latest?.metadata).mergeSha),
        approvalDecisionSource: readJsonString(
          readJsonObject(latest?.metadata).decisionSource
        ),
        mergedAt: row.pullRequest.mergedAt,
      };
    },

    async markApplyRunning(input: MarkApplyRunningInput) {
      await prisma.applyJob.update({
        where: { id: input.applyJobId },
        data: { state: "running", startedAt: new Date() },
      });
    },

    async markApplyFinished(input: MarkApplyFinishedInput) {
      await prisma.applyJob.update({
        where: { id: input.applyJobId },
        data: {
          state: input.state,
          finishedAt: new Date(),
          ...(input.errorMessage !== undefined
            ? { errorMessage: input.errorMessage }
            : {}),
          result: (input.result ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    },

    async recordApplyExecutionLog(input: ExecutionLogInput) {
      await prisma.executionLog.create({
        data: {
          cronRunId: input.cronRunId ?? null,
          workspaceId: input.workspaceId ?? workspaceId,
          kind: input.kind,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          level: input.level ?? "info",
          message: input.message,
          payload: (input.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    },

    async recordApplyAudit(input: RecordApplyAuditInput) {
      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: "addroid",
          action: input.action,
          target: `apply_job:${input.applyJobId}`,
          ref:
            input.ref ?? `pr#${input.prNumber}@${input.headSha}`,
          metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    },

    // regression fix: ads_hierarchy への永続化境界。
    // - AdAccount は (workspaceId, accountKey) で 1 行に解決する。未登録なら
    //   throw して orchestrator 側の warn execution_log に流す。
    // - 親ノード解決は同じ accountId 配下から (parentNodeType, parentNodeKey) で
    //   引く。見つからなければ parentId は null のまま続行する (apply の依存順
    //   により通常は親が先に永続化済み)。
    // - 既存行があれば update のみ (insert しない) で displayName を保護できる。
    //   行が無く displayName 未指定の場合は nodeKey を fallback に使い not-null を満たす。
    async upsertAppliedAdsNode(
      input: UpsertAppliedAdsNodeInput
    ): Promise<{ id: string }> {
      const account = await prisma.adAccount.findUnique({
        where: {
          workspaceId_key: {
            workspaceId: input.workspaceId,
            key: input.accountKey,
          },
        },
        select: { id: true },
      });
      if (!account) {
        throw new Error(
          `ad_account not found for workspaceId=${input.workspaceId} key=${input.accountKey}`
        );
      }
      let parentId: string | null = null;
      if (input.parentNodeType && input.parentNodeKey) {
        const parent = await prisma.adsHierarchyNode.findUnique({
          where: {
            accountId_nodeType_nodeKey: {
              accountId: account.id,
              nodeType: input.parentNodeType,
              nodeKey: input.parentNodeKey,
            },
          },
          select: { id: true },
        });
        parentId = parent?.id ?? null;
      }
      const status = input.status ?? "paused";
      const specJson = (input.spec ?? Prisma.JsonNull) as Prisma.InputJsonValue;
      const existing = await prisma.adsHierarchyNode.findUnique({
        where: {
          accountId_nodeType_nodeKey: {
            accountId: account.id,
            nodeType: input.nodeType,
            nodeKey: input.nodeKey,
          },
        },
        select: { id: true },
      });
      if (existing) {
        const data: Prisma.AdsHierarchyNodeUpdateInput = {
          lastCommitSha: input.lastCommitSha,
          spec: specJson,
        };
        if (input.displayName !== undefined) data.displayName = input.displayName;
        if (input.externalId !== undefined) data.externalId = input.externalId;
        if (input.status !== undefined) data.status = status;
        if (parentId) data.parent = { connect: { id: parentId } };
        const row = await prisma.adsHierarchyNode.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        });
        return { id: row.id };
      }
      const row = await prisma.adsHierarchyNode.create({
        data: {
          accountId: account.id,
          nodeType: input.nodeType,
          nodeKey: input.nodeKey,
          displayName: input.displayName ?? input.nodeKey,
          status,
          externalId: input.externalId ?? null,
          lastCommitSha: input.lastCommitSha,
          spec: specJson,
          ...(parentId ? { parentId } : {}),
        },
        select: { id: true },
      });
      return { id: row.id };
    },
  };
}

// ---------------------------------------------------------------------
// Slack audit stores (Implementation item)
//
// `runSlackCommandJob` (queue) と `dispatchSlackNotification` (config) は
// それぞれ AuditWriter 境界を受け取り、実行終了時に audit_logs へ 1 行残す。
// これらは prisma を直接 import しないので、apps/worker 側で Prisma 実装を
// 注入する。actor は slash command 側が `slack:<user_id>` (UI design plan
// §0.20)、notification 側は system actor `addroid` を使う (Slack 通知は
// system が起動するため)。
// ---------------------------------------------------------------------

/**
 * implementation item: `runSlackCommandJob` から呼ばれる audit_logs writer。
 * 1 回の実行につき 1 行を `audit_logs` に追加する。
 *
 * - actor は `SlackCommandAuditInput.actor` (例: `slack:U012ABC`) をそのまま使う。
 *   `runSlackCommandJob` が空ユーザの場合 `slack:_` に丸めてから渡してくる。
 * - action は `slash_command.completed` / `slash_command.failed` /
 *   `activate.via_slack` の 3 値。
 * - target は `slack_command:<subcommand>` 文字列 (UI cron/audit 列で per-action
 *   フィルタが効くように subcommand 単位の noun: id 形式)。
 * - metadata には sanitize 済みの slack_user_id / slack_channel_id /
 *   response_url 利用結果 / handler 結果 / durationMs を入れる。Slack 平文
 *   token は dispatcher 側で sanitize 済みのものだけが渡る。
 */
export function createSlackCommandAuditStore(
  prisma: PrismaClient,
  workspaceId: string
): SlackCommandAuditWriter {
  return {
    async recordSlashCommandExecution(input: SlackCommandAuditInput): Promise<void> {
      const metadata: Prisma.InputJsonValue = {
        subcommand: input.subcommand,
        subcommandTarget: input.subcommandTarget,
        slackUserId: input.slackUserId,
        slackUserName: input.slackUserName,
        slackChannelId: input.slackChannelId,
        slackTeamId: input.slackTeamId,
        state: input.state,
        handlerState: input.handlerState,
        postedToResponseUrl: input.postedToResponseUrl,
        ...(input.postError !== undefined ? { postError: input.postError } : {}),
        ...(input.handlerError !== undefined
          ? { handlerError: input.handlerError }
          : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        durationMs: input.durationMs,
        finishedAt: input.finishedAt,
      };
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actor: input.actor,
          action: input.action,
          target: input.target,
          ref: input.ref,
          metadata,
        },
      });
    },
  };
}

/**
 * Discord slash command 実行を audit_logs に 1 行残す writer
 * (`createSlackCommandAuditStore` の Discord 版)。
 */
export function createDiscordCommandAuditStore(
  prisma: PrismaClient,
  workspaceId: string
): DiscordCommandAuditWriter {
  return {
    async recordSlashCommandExecution(
      input: DiscordCommandAuditInput
    ): Promise<void> {
      const metadata: Prisma.InputJsonValue = {
        subcommand: input.subcommand,
        subcommandTarget: input.subcommandTarget,
        discordUserId: input.discordUserId,
        discordUserName: input.discordUserName,
        channelId: input.channelId,
        guildId: input.guildId,
        state: input.state,
        handlerState: input.handlerState,
        postedToResponseUrl: input.postedToResponseUrl,
        ...(input.postError !== undefined ? { postError: input.postError } : {}),
        ...(input.handlerError !== undefined
          ? { handlerError: input.handlerError }
          : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        durationMs: input.durationMs,
        finishedAt: input.finishedAt,
      };
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actor: input.actor,
          action: input.action,
          target: input.target,
          ref: input.ref,
          metadata,
        },
      });
    },
  };
}

/**
 * implementation item: `dispatchSlackNotification` から呼ばれる audit_logs writer。
 * 1 回の dispatch につき 1 行を `audit_logs` に追加する。
 *
 * - actor は `addroid` 固定 (Slack 通知は system が emit する。Slack ユーザに
 *   起因しない)。
 * - action は `notification.sent` / `notification.failed` /
 *   `notification.skipped_no_slack` の 3 値で、`SlackDispatchState` と 1:1。
 * - target は `slack_notification:<kind>` 文字列。
 * - metadata は `slack_message_ts` (= 受入要件「slack_message_ts を紐づける」)、
 *   channel、kind、エラー詳細 (sanitize 済み) を含む。
 */
export function createNotificationAuditStore(
  prisma: PrismaClient,
  workspaceId: string
): NotificationAuditWriter {
  return {
    async recordNotificationDispatch(input: NotificationAuditInput): Promise<void> {
      const action =
        input.state === "sent"
          ? "notification.sent"
          : input.state === "failed"
            ? "notification.failed"
            : "notification.skipped_no_slack";
      const metadata: Prisma.InputJsonValue = {
        kind: input.kind,
        state: input.state,
        ...(input.slackMessageTs !== undefined
          ? { slackMessageTs: input.slackMessageTs }
          : {}),
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage !== undefined
          ? { errorMessage: input.errorMessage }
          : {}),
        preparedAt: input.preparedAt,
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      };
      const ref =
        input.slackMessageTs ??
        (input.errorCode ? `error:${input.errorCode}` : input.state);
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actor: "addroid",
          action,
          target: `slack_notification:${input.kind}`,
          ref,
          metadata,
        },
      });
    },
  };
}

/**
 * Discord 通知 dispatch を audit_logs に 1 行残す writer
 * (`createNotificationAuditStore` の Discord 版)。
 */
export function createDiscordNotificationAuditStore(
  prisma: PrismaClient,
  workspaceId: string
): DiscordNotificationAuditWriter {
  return {
    async recordNotificationDispatch(
      input: DiscordNotificationAuditInput
    ): Promise<void> {
      const action =
        input.state === "sent"
          ? "notification.sent"
          : input.state === "failed"
            ? "notification.failed"
            : "notification.skipped_no_discord";
      const metadata: Prisma.InputJsonValue = {
        kind: input.kind,
        state: input.state,
        ...(input.discordMessageId !== undefined
          ? { discordMessageId: input.discordMessageId }
          : {}),
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage !== undefined
          ? { errorMessage: input.errorMessage }
          : {}),
        preparedAt: input.preparedAt,
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      };
      const ref =
        input.discordMessageId ??
        (input.errorCode ? `error:${input.errorCode}` : input.state);
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actor: "addroid",
          action,
          target: `discord_notification:${input.kind}`,
          ref,
          metadata,
        },
      });
    },
  };
}
