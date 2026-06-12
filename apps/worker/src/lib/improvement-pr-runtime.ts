// AdDroid OSS — apps/worker improvement_pr wiring (Implementation item).
//
// `runImprovementPrOnce` (queue) が要求する 5 境界を Prisma + LLMProvider +
// GithubAdapter で組み立てる:
//
//   1. `ImprovementPrStore` — ad_account 解決と ai_runs の永続化。
//   2. `ImprovementPrPipelineRunner` — 8 agent (analyst → strategy → copy →
//       image_prompt → creative_qa → media_buyer → gitops → audit) を
//       LLMProvider で順に呼び出す。
//   3. `ImprovementPrGithubPublisher` — gitops 出力を ops repo に PR として
//       書き込み、`github_pull_requests` 行を upsert する。
//   4. `ImprovementPrPlanValidator` — gitops 出力を CLI / `/api/plan` と同じ
//       runPlanForRoot に通し、PR body と audit metadata に実 plan 結果を残す
//       (Regression fix)。
//   5. `ImprovementPrAuditWriter` — audit_logs / approval_records を残す。
//
// 設計原則:
//   - llm-provider への直接依存を queue から切り離すため、本 wiring 層で
//     `runAnalystAgent` 等を呼び出す。各 agent の result.aiRunInput をそのまま
//     orchestrator に返し、orchestrator が `prisma.aiRun.create` を実行する。
//   - GitHub adapter は `getGithubAdapter()` 由来の singleton に閉じ込め、
//     publisher は `createPullRequest` を 1 回呼ぶだけ。Mock 環境では
//     MockGithubAdapter 経由で in-memory に痕跡を残す。
//   - audit writer は ops repo (= workspace.opsRepoId) に紐付く
//     `github_pull_requests` 行を upsert し、`audit_logs` に
//     `improvement_pr.opened|skipped|failed` を 1 行残す。dangerous かつ
//     audit decision="auto_blocked" のときは `approval_records.decision="auto_blocked"`
//     も同時に書く。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Prisma, type PrismaClient } from "@addroid/db";
import {
  buildAiRunCreateInput,
  evaluateCreativeQaBatch,
  runAnalystAgent,
  runAuditAgent,
  runCopyAgent,
  runCreativeQaAgent,
  runGitOpsAgent,
  runImagePromptAgent,
  runMediaBuyerAgent,
  runStrategyAgent,
  type AiRunCreateInputData,
  type AnalystAgentInput,
  type AuditAgentInput,
  type CopyAgentInput,
  type CreativeQaAgentInput,
  type CreativeQaAssetInput,
  type GitOpsAgentInput,
  type ImagePromptAgentInput,
  type LLMProvider,
  type MediaBuyerAgentInput,
  type MediaBuyerProposal,
  type StrategyAgentInput,
} from "@addroid/llm-provider";
import {
  type CreatePullRequestFile,
  type GithubAdapter,
} from "@addroid/github-adapter";
import {
  IMPROVEMENT_PR_IMAGE_DIMENSION_PRESETS,
  creativePerformanceExampleGenes,
  creativePerformanceGeneInsightLines,
  type DailyReportAdAccountSnapshot,
  type CreativePerformanceDigest,
  type ImprovementPrAuditClassification,
  type ImprovementPrAuditDecision,
  type ImprovementPrAuditInput,
  type ImprovementPrAuditWriter,
  type ImprovementPrCreativeQaAssetCheck,
  type ImprovementPrCreativeQaIssue,
  type ImprovementPrCreativeQaOutput,
  type ImprovementPrCreativeGenerationContext,
  type ImprovementPrFileChange,
  type ImprovementPrGithubPublisher,
  type ImprovementPrPerformanceMetrics,
  type ImprovementPrPipelineRunner,
  type ImprovementPrPlanValidationResult,
  type ImprovementPrPlanValidator,
  type ImprovementPrPullRequestRecord,
  type ImprovementPrPullRequestRequest,
  type ImprovementPrStore,
} from "@addroid/queue";
import {
  addLandingPageBriefToCreativeContext,
  landingPageUrlForPrompt,
} from "./creative-landing-page-context.js";
import { runPlanForRoot } from "./plan-runtime.js";

// ---------------------------------------------------------------------
// Snapshot store — Prisma 実装 (findAdAccount + createAiRun)
// ---------------------------------------------------------------------

export function createPrismaImprovementPrStore(
  prisma: PrismaClient,
): ImprovementPrStore {
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
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        displayName: row.displayName,
        metaAccountId: row.metaAccountId,
        currency: "JPY",
      };
    },
    async listAdCreativePerformance(input) {
      const snapshots = await prisma.performanceSnapshot.findMany({
        where: {
          accountId: input.accountId,
          nodeType: "ad",
          metricDate: {
            gte: new Date(`${input.since}T00:00:00.000Z`),
            lte: new Date(`${input.until}T00:00:00.000Z`),
          },
        },
        select: {
          id: true,
          accountId: true,
          nodeType: true,
          nodeKey: true,
          metricDate: true,
          impressions: true,
          clicks: true,
          conversions: true,
          spendMicros: true,
          hierarchy: {
            select: {
              id: true,
              accountId: true,
              nodeType: true,
              nodeKey: true,
              displayName: true,
            },
          },
        },
      });
      const hierarchyIds = [
        ...new Set(
          snapshots
            .map((snapshot) => snapshot.hierarchy?.id)
            .filter((id): id is string => typeof id === "string"),
        ),
      ];
      if (hierarchyIds.length === 0) return [];
      const creatives = await prisma.creative.findMany({
        where: {
          accountId: input.accountId,
          hierarchyId: { in: hierarchyIds },
          status: { in: ["merged", "active_on_meta"] },
        },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          key: true,
          displayName: true,
          genes: true,
          spec: true,
          prompt: true,
          status: true,
          updatedAt: true,
          hierarchyId: true,
        },
      });
      const creativesByHierarchy = new Map<string, typeof creatives>();
      for (const creative of creatives) {
        if (!creative.hierarchyId) continue;
        const list = creativesByHierarchy.get(creative.hierarchyId);
        if (list) {
          list.push(creative);
        } else {
          creativesByHierarchy.set(creative.hierarchyId, [creative]);
        }
      }
      return snapshots.flatMap((snapshot) => {
        const hierarchy = snapshot.hierarchy;
        if (!hierarchy) return [];
        const creativeRows = creativesByHierarchy.get(hierarchy.id) ?? [];
        return creativeRows.map((creative) => ({
          snapshotRow: {
            id: snapshot.id,
            accountId: snapshot.accountId,
            nodeType: snapshot.nodeType,
            nodeKey: snapshot.nodeKey,
            metricDate: snapshot.metricDate,
            impressions: snapshot.impressions,
            clicks: snapshot.clicks,
            conversions: snapshot.conversions,
            spendMicros: snapshot.spendMicros,
          },
          hierarchyRow: hierarchy,
          creativeRow: creative,
          ambiguous: creativeRows.length > 1,
        }));
      });
    },
    async createAiRun(data: AiRunCreateInputData): Promise<{ id: string }> {
      const created = await prisma.aiRun.create({
        data: {
          workspaceId: data.workspaceId,
          agent: data.agent,
          workflow: data.workflow,
          provider: data.provider,
          model: data.model,
          status: data.status,
          prompt: (data.prompt ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          inputs: (data.inputs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          outputs: (data.outputs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          decision: data.decision,
          confidence: data.confidence,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          requestId: data.requestId,
          linkedRefType: data.linkedRefType,
          linkedRefId: data.linkedRefId,
          errorMessage: data.errorMessage,
          startedAt: data.startedAt,
          finishedAt: data.finishedAt,
        },
        select: { id: true },
      });
      return { id: created.id };
    },
    async createCreative(data): Promise<{ id: string }> {
      // regression fix: image_prompt の prompt/negativePrompt/styleNotes/rationale
      // と creative_qa の aiRunId/recommendation/issues/rationale を 1 つの spec
      // JSON にまとめて 1 行 insert する。`@@unique([accountId, key])` は
      // 呼び出し側が `image_<imagePromptAiRunId>_v<idx>` で衝突回避を保証する。
      //
      // regression fix: orchestrator (`runImprovementPrOnce`) が image-Provider
      // hop を経由して bytes を LocalDisk Storage Adapter に書き出した場合、
      // `storagePath` / `storageRef` / `provider` / `model` / `parameters` を
      // 同じ insert で永続化する。Provider 未注入 / Provider 失敗 / fallback の
      // ときは orchestrator 側で全項目 null を流すので、ここではそのまま書く
      // だけで prompt-only fallback を表現できる (UI design plan principle 24/27)。
      const spec: Record<string, unknown> = {
        prompt: data.prompt.prompt,
        negativePrompt: data.prompt.negativePrompt,
        styleNotes: data.prompt.styleNotes,
        rationale: data.rationale,
        variantIndex: data.variantIndex,
        adText: data.adText ?? null,
        metaTextRecommendations: {
          primaryText: 125,
          headline: 40,
          description: 30,
        },
        qa: {
          aiRunId: data.qa.aiRunId,
          recommendation: data.qa.recommendation,
          issues: data.qa.issues.map((i) => ({
            severity: i.severity,
            category: i.category,
            message: i.message,
          })),
          rationale: data.qa.rationale,
        },
        genes: data.genes ?? null,
      };
      if (data.carouselSpec) {
        spec.carousel = data.carouselSpec;
      }
      const created = await prisma.creative.create({
        data: {
          accountId: data.accountId,
          // regression fix: 生成 asset を campaign / adset / ad ノードに結び付ける
          // 経路を schema (`Creative.hierarchyId String?`) と orchestrator から
          // ここまで通す。image_prompt agent が node を targeting しない現状運用では
          // null だが、フィールドは経由する (= acceptance: "creatives table links
          // generated assets to ... campaign/ad where applicable").
          hierarchyId: data.hierarchyId ?? null,
          aiRunId: data.aiRunId,
          creativeQaAiRunId: data.qa.aiRunId,
          key: data.key,
          displayName: data.displayName,
          mediaType: data.mediaType,
          status: data.status,
          // implementation item: プロンプト本文を Creative.prompt にも書き出し、/creatives
          // 一覧の query を spec JSON 抜きで成立させる (denormalized for read).
          prompt: data.prompt.prompt,
          spec: spec as unknown as Prisma.InputJsonValue,
          // regression fix: image-Provider hop が走った場合のみ非 null。Provider
          // 未注入 / 失敗時は全項目 null のまま prompt-only audit metadata として
          // 機能する (acceptance: "creatives table links generated assets to
          // ... storage ref, provider, model, parameters")。
          storagePath: data.storagePath ?? null,
          storageRef: data.storageRef ?? null,
          provider: data.provider ?? null,
          model: data.model ?? null,
          parameters:
            data.parameters !== undefined && data.parameters !== null
              ? (data.parameters as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          genes:
            data.genes !== undefined && data.genes !== null
              ? (data.genes as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
        select: { id: true },
      });
      return { id: created.id };
    },
    async linkCreativesToPullRequest(input): Promise<void> {
      // implementation item: PR 発行成功直後に creatives 行へ pullRequestId を埋め、
      // status を `attached_to_pr` (引数指定がない場合の既定) に進める。
      // 既に `merged` / `active_on_meta` / `superseded` 等の進んだ status を
      // 持つ行は after-the-fact で書き換えないように `status: { in: [...] }`
      // で前置条件を絞る (= idempotency + future hop の上書き防止)。
      //
      // regression fix: PR 添付前に **per-row deterministic QA gate** を強制する。
      //   - 各 creative 行を pre-flight で読み、`status` が qa_passed/qa_warned
      //     であること、`creativeQaAiRunId` が記録されていること (= 実際に QA
      //     hop が走っていること) を確認する。
      //   - 上記を満たす行に対してのみ `updateMany` で pullRequestId を書く。
      //     status が `merged` / `active_on_meta` / `superseded` 等に進んでいる
      //     行は引き続き `status: { in: [...] }` で除外する (idempotency)。
      //
      // regression fix: さらに、PR linkage 対象の各行が **生成 asset の完全な
      // metadata (storageRef + storagePath + provider + model)** を持つことを
      // 強制する。理由:
      //   - acceptance: "creatives table links generated assets to ... storage
      //     ref, and PR" — pullRequestId を持つ行は実 asset が背後に存在することが
      //     前提 (creative evidence が storage ref を載せ、PR レビュアが proxy
      //     経由で preview できる)。
      //   - prompt-only fallback (Provider 未注入 / 失敗) で生まれた qa_passed 行は
      //     creatives テーブルに audit metadata として残るが、PR 添付経路は通さない。
      //     orchestrator (`runImprovementPrOnce`) も同じ条件で linkable を絞るが、
      //     production 経路では本 gate が DB 側 fail-loud な二重防御になる。
      //   - いずれかが満たせない creative_id が混ざっていたら、orchestrator が
      //     gating を撒き散らしたことになるので throw して PR linkage / metadata
      //     記録を中断する (= "complete per-asset QA before any PR linkage").
      if (input.creativeIds.length === 0) return;
      const nextStatus = input.status ?? "attached_to_pr";
      const rows = await prisma.creative.findMany({
        where: { id: { in: input.creativeIds } },
        select: {
          id: true,
          status: true,
          creativeQaAiRunId: true,
          storagePath: true,
          storageRef: true,
          provider: true,
          model: true,
        },
      });
      const rowById = new Map(rows.map((r) => [r.id, r] as const));
      const ineligible: { id: string; reason: string }[] = [];
      for (const id of input.creativeIds) {
        const row = rowById.get(id);
        if (!row) {
          ineligible.push({ id, reason: "creative row not found" });
          continue;
        }
        if (row.status !== "qa_passed" && row.status !== "qa_warned") {
          ineligible.push({
            id,
            reason: `status='${row.status}' (must be qa_passed or qa_warned)`,
          });
          continue;
        }
        if (row.creativeQaAiRunId === null) {
          ineligible.push({
            id,
            reason:
              "creativeQaAiRunId is null (per-asset QA was never recorded)",
          });
          continue;
        }
        if (row.storageRef === null) {
          ineligible.push({
            id,
            reason:
              "storageRef is null (generated-asset storage reference missing — prompt-only rows must not be PR-linked)",
          });
          continue;
        }
        if (row.storagePath === null) {
          ineligible.push({
            id,
            reason:
              "storagePath is null (storage adapter persistence incomplete)",
          });
          continue;
        }
        if (row.provider === null) {
          ineligible.push({
            id,
            reason:
              "provider is null (image-Provider attribution missing on generated asset)",
          });
          continue;
        }
        if (row.model === null) {
          ineligible.push({
            id,
            reason:
              "model is null (image-Provider model attribution missing on generated asset)",
          });
          continue;
        }
      }
      if (ineligible.length > 0) {
        const detail = ineligible.map((e) => `${e.id}: ${e.reason}`).join("; ");
        throw new Error(
          `improvement_pr: refusing to link creatives to PR without complete per-asset QA: ${detail}`,
        );
      }
      await prisma.creative.updateMany({
        where: {
          id: { in: input.creativeIds },
          status: { in: ["qa_passed", "qa_warned"] },
        },
        data: {
          pullRequestId: input.pullRequestId,
          status: nextStatus,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------
// Pipeline runner — 8 agent を LLMProvider で流す
// ---------------------------------------------------------------------

export interface CreateImprovementPrPipelineRunnerOptions {
  provider: LLMProvider;
  workspaceId: string;
  /** 紐付ける cron_run id (linkedRefType=cron_run)。 */
  cronRunId?: string | null;
  /** test seam: 現在時刻。 */
  now?: () => Date;
}

export function createImprovementPrPipelineRunner(
  opts: CreateImprovementPrPipelineRunnerOptions,
): ImprovementPrPipelineRunner {
  const ctxBase = () => {
    const linkedRefId = opts.cronRunId ?? null;
    const base = {
      provider: opts.provider,
      workspaceId: opts.workspaceId,
      workflow: "improvement_pr" as const,
      ...(opts.now ? { now: opts.now } : {}),
      ...(linkedRefId
        ? {
            linkedRefType: "cron_run" as const,
            linkedRefId,
          }
        : {}),
    };
    return base;
  };

  return {
    async runAnalyst(input) {
      const agentInput: AnalystAgentInput = {
        accountId: input.accountId,
        periodStart: input.analysisWindow.periodStart,
        periodEnd: input.analysisWindow.periodEnd,
        ...(input.analysisWindow.priorPeriodStart
          ? { priorPeriodStart: input.analysisWindow.priorPeriodStart }
          : {}),
        ...(input.analysisWindow.priorPeriodEnd
          ? { priorPeriodEnd: input.analysisWindow.priorPeriodEnd }
          : {}),
        current: input.analysisWindow.current,
        ...(input.analysisWindow.prior
          ? { prior: input.analysisWindow.prior }
          : {}),
        snapshotIds: input.snapshotIds,
      };
      try {
        const result = await runAnalystAgent(ctxBase(), agentInput);
        return {
          aiRunInput: result.aiRunInput,
          output: result.output
            ? {
                commentary: result.output.commentary,
                deltas: result.output.deltas,
                topImprovements: result.output.topImprovements,
              }
            : null,
          error: result.error,
        };
      } catch (err) {
        return failedAiRun({
          opts,
          agent: "analyst",
          inputs: agentInput,
          err,
        });
      }
    },

    async runStrategy(input) {
      const recentKpis =
        input.creativeContext?.target?.current ??
        input.creativeContext?.references[0]?.current;
      const agentInput: StrategyAgentInput = {
        accountId: input.accountId,
        objective: "conversion",
        audienceSummary:
          input.creativeContext?.target?.displayName ??
          input.creativeContext?.references[0]?.displayName ??
          input.accountDisplayName,
        currency: input.currency,
        ...(recentKpis ? { recentKpis: metricsToRecord(recentKpis) } : {}),
        ...(input.creativeContext?.notes
          ? { constraints: input.creativeContext.notes }
          : {}),
      };
      try {
        const result = await runStrategyAgent(ctxBase(), agentInput);
        return {
          aiRunInput: result.aiRunInput,
          output: result.output ?? null,
          error: result.error,
        };
      } catch (err) {
        return failedAiRun({
          opts,
          agent: "strategy",
          inputs: agentInput,
          err,
        });
      }
    },

    async runCopy(input) {
      const agentInput: CopyAgentInput = {
        accountId: input.accountId,
        audienceSummary: [
          input.audienceFocus,
          input.creativeContext?.target
            ? `target=${input.creativeContext.target.displayName}`
            : null,
          input.creativeContext?.references[0]
            ? `winning reference=${input.creativeContext.references[0].displayName}`
            : null,
        ]
          .filter(Boolean)
          .join(" / "),
        brandTone:
          input.creativeContext?.brandProfile?.tone ?? "operator-grade",
        productOffer: [
          input.recommendedApproach,
          input.creativeContext?.target?.creative?.headline,
          input.creativeContext?.references[0]?.creative?.headline,
        ]
          .filter(Boolean)
          .join(" / "),
        ...(input.creativeContext?.brandProfile?.forbiddenTerms
          ? {
              forbiddenKeywords:
                input.creativeContext.brandProfile.forbiddenTerms,
            }
          : {}),
        ...(input.performanceDigest
          ? {
              performanceContext: copyPerformanceContext(
                input.performanceDigest,
              ),
            }
          : {}),
        ...(input.creativeFormat ? { format: input.creativeFormat } : {}),
        ...(input.carouselCardCount
          ? { carouselCardCount: input.carouselCardCount }
          : {}),
      };
      try {
        const result = await runCopyAgent(ctxBase(), agentInput);
        return {
          aiRunInput: result.aiRunInput,
          output: result.output ?? null,
          error: result.error,
        };
      } catch (err) {
        return failedAiRun({
          opts,
          agent: "copy",
          inputs: agentInput,
          err,
        });
      }
    },

    async runImagePrompt(input) {
      const creativeContext = await addLandingPageBriefToCreativeContext(
        opts.provider,
        input.creativeContext ?? null,
      );
      const performance: ImagePromptAgentInput["performance"] = {
        periodLabel: `${input.analysisWindow.periodStart}..${input.analysisWindow.periodEnd}`,
        recentKpis: metricsToRecord(
          creativeContext?.target?.current ?? input.analysisWindow.current,
        ),
        analystCommentary: input.analystCommentary,
        placementSignals: placementSignalsFromCreativeContext(creativeContext),
      };
      const target = creativeContext?.target;
      const performanceNotes = input.performanceDigest
        ? creativePerformanceGeneInsightLines(input.performanceDigest)
        : [];
      const agentInput: ImagePromptAgentInput = {
        accountId: input.accountId,
        audienceSummary: input.audienceFocus,
        copyContext: {
          headline: input.primaryHeadline,
          primaryText: input.primaryText,
        },
        brandStyle: creativeContext?.brandProfile?.tone ?? "operator-grade",
        aspectRatio: "1:1",
        performance,
        brandProfile: creativeContext?.brandProfile ?? {
          brandName: input.accountDisplayName,
        },
        improvementContext: {
          strategySummary: [
            input.strategy.recommendedApproach,
            input.strategy.audienceFocus,
          ]
            .filter(Boolean)
            .join(" / "),
          rationale: input.strategy.rationale,
          notes: [...(creativeContext?.notes ?? []), ...performanceNotes],
        },
        ...(target
          ? {
              targetContext: {
                hierarchy: target.hierarchy,
                nodeKey: target.nodeKey,
                displayName: target.displayName,
                status: target.status ?? null,
                current: metricsToRecord(target.current),
                ...(target.prior
                  ? { prior: metricsToRecord(target.prior) }
                  : {}),
                rationale: target.rationale,
                currentCreative: sanitizeCreativeForPrompt(
                  target.creative ?? null,
                ),
              },
            }
          : {}),
        ...(creativeContext
          ? {
              referenceCreatives: [
                ...creativeContext.references.map((r) => ({
                  hierarchy: r.hierarchy,
                  nodeKey: r.nodeKey,
                  displayName: r.displayName,
                  current: metricsToRecord(r.current),
                  rationale: r.rationale,
                  creative: sanitizeCreativeForPrompt(r.creative ?? null),
                })),
                ...referenceCreativesFromDigest(
                  input.performanceDigest ?? null,
                ),
              ],
              creativeStrategy: creativeContext.strategy,
            }
          : input.performanceDigest
            ? {
                referenceCreatives: referenceCreativesFromDigest(
                  input.performanceDigest,
                ),
                creativeStrategy: "scale_winner" as const,
              }
            : {}),
        variantCount: 3,
        ...(input.placementSet ? { placementSet: input.placementSet } : {}),
        ...(input.carousel
          ? {
              carouselCards: input.carousel.cards.map((card) => ({
                position: card.position,
                imageBrief: card.imageBrief,
                headline: card.headline,
              })),
            }
          : {}),
        dimensionPresets: IMPROVEMENT_PR_IMAGE_DIMENSION_PRESETS,
        policyConstraints: [
          ...(creativeContext?.brandProfile?.forbiddenTerms ?? []).map(
            (term) => `forbidden:${term}`,
          ),
          "no_trademarked_logos",
        ],
      };
      try {
        const result = await runImagePromptAgent(ctxBase(), agentInput);
        return {
          aiRunInput: result.aiRunInput,
          output: result.output ?? null,
          error: result.error,
        };
      } catch (err) {
        return failedAiRun({
          opts,
          agent: "image_prompt",
          inputs: agentInput,
          err,
        });
      }
    },

    async runCreativeQa(input) {
      const agentInput: CreativeQaAgentInput = {
        copy: input.copy,
        imagePrompts: input.imagePrompts,
      };
      try {
        const result = await runCreativeQaAgent(ctxBase(), agentInput);
        // regression fix: Provider が既に bytes を返している場合 (= orchestrator
        // が `generatedAssets` を渡してきた場合) は、LLM プロンプトベースの判定に
        // 加えて `evaluateCreativeQaBatch` で dimensions / format / quality /
        // forbidden_expression / brand_tone を **決定論的に** 検査する。
        // blocking failure があれば LLM の `recommendation` を `reject` に強制
        // ダウングレードし、検査結果を issues に追記する。これにより:
        //   - 「LLM が approve したが asset が dimensions blocking で落ちた」という
        //     ケースで PR 添付経路が走らない (acceptance: "Creative QA checks
        //     dimensions, format, quality, ... before PR attachment").
        //   - 既に runImageGenerationHop 側で同等の決定論的検査が走っており、
        //     creative.status / linkCreativesToPullRequest / orchestrator partition
        //     という三層ゲートが PR linkage を gating するが、本ルートはそれらに
        //     先立つ runCreativeQa 単体での明示ゲートを提供する (defense in depth)。
        //   - 配列が空 / 未指定の場合は LLM 単独判定を維持し、prompt-only
        //     fallback の経路を壊さない。
        if (
          input.generatedAssets &&
          input.generatedAssets.length > 0 &&
          result.output
        ) {
          const merged = mergeDeterministicCreativeQa(
            result.output,
            input.generatedAssets,
          );
          return {
            aiRunInput: result.aiRunInput,
            output: merged,
            error: result.error,
          };
        }
        return {
          aiRunInput: result.aiRunInput,
          output: result.output ?? null,
          error: result.error,
        };
      } catch (err) {
        return failedAiRun({
          opts,
          agent: "creative_qa",
          inputs: agentInput,
          err,
        });
      }
    },

    async runMediaBuyer(input) {
      const agentInput: MediaBuyerAgentInput = {
        accountId: input.accountId,
        currency: input.currency,
        snapshotIds: input.snapshotIds,
        currentDailyBudget: input.currentDailyBudget,
        riskTolerance: input.riskTolerance,
        analystSummary: input.analystSummary,
      };
      try {
        const result = await runMediaBuyerAgent(ctxBase(), agentInput);
        const decision =
          (result.aiRunInput.decision as
            | "propose"
            | "skip_no_proposal"
            | "skip_dangerous_only"
            | null) ?? null;
        return {
          aiRunInput: result.aiRunInput,
          output: result.output ?? null,
          decision: result.error ? null : decision,
          error: result.error,
        };
      } catch (err) {
        const failed = failedAiRun({
          opts,
          agent: "media_buyer",
          inputs: agentInput,
          err,
        });
        return { ...failed, decision: null };
      }
    },

    async runGitOps(input) {
      const agentInput: GitOpsAgentInput = {
        accountId: input.accountId,
        proposals: input.proposals as MediaBuyerProposal[],
        repo: input.repo,
        baseRef: input.baseRef,
        branchHint: input.branchHint,
      };
      try {
        const result = await runGitOpsAgent(ctxBase(), agentInput);
        const decision =
          (result.aiRunInput.decision as "propose" | "skip" | null) ?? null;
        return {
          aiRunInput: result.aiRunInput,
          output: result.output ?? null,
          decision: result.error ? null : decision,
          error: result.error,
        };
      } catch (err) {
        const failed = failedAiRun({
          opts,
          agent: "gitops",
          inputs: agentInput,
          err,
        });
        return { ...failed, decision: null };
      }
    },

    async runAudit(input) {
      const agentInput: AuditAgentInput = {
        accountId: input.accountId,
        proposals: input.proposals as MediaBuyerProposal[],
        files: input.files,
        mode: input.mode,
        safeCategories: input.safeCategories,
      };
      try {
        const result = await runAuditAgent(ctxBase(), agentInput);
        const decision =
          (result.aiRunInput.decision as
            | "auto_approved"
            | "approval_required"
            | "auto_blocked"
            | null) ?? null;
        return {
          aiRunInput: result.aiRunInput,
          output: result.output
            ? {
                classification: result.output.classification,
                dangerousCategories: result.output.dangerousCategories,
                rationale: result.output.rationale,
              }
            : null,
          decision: result.error ? null : decision,
          error: result.error,
        };
      } catch (err) {
        const failed = failedAiRun({
          opts,
          agent: "audit",
          inputs: agentInput,
          err,
        });
        return { ...failed, decision: null };
      }
    },
  };
}

interface FailedAiRunArgs {
  opts: CreateImprovementPrPipelineRunnerOptions;
  agent:
    | "analyst"
    | "strategy"
    | "copy"
    | "image_prompt"
    | "creative_qa"
    | "media_buyer"
    | "gitops"
    | "audit";
  inputs: unknown;
  err: unknown;
}

function failedAiRun(args: FailedAiRunArgs): {
  aiRunInput: AiRunCreateInputData;
  output: null;
  error: string;
} {
  const message =
    args.err instanceof Error ? args.err.message : String(args.err);
  const startedAt = args.opts.now ? args.opts.now() : new Date();
  const linkedRefId = args.opts.cronRunId ?? null;
  const aiRunInput = buildAiRunCreateInput({
    workspaceId: args.opts.workspaceId,
    agent: args.agent,
    workflow: "improvement_pr",
    provider: args.opts.provider.name,
    model: args.opts.provider.defaultModel,
    status: "failed",
    inputs: args.inputs,
    outputs: null,
    decision: null,
    confidence: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(linkedRefId
      ? {
          linkedRefType: "cron_run" as const,
          linkedRefId,
        }
      : {}),
    errorMessage: message,
    startedAt,
    finishedAt: startedAt,
  });
  return { aiRunInput, output: null, error: message };
}

function copyPerformanceContext(
  digest: CreativePerformanceDigest,
): NonNullable<CopyAgentInput["performanceContext"]> {
  return {
    winningExamples: digest.winners
      .filter((entry) => entry.headline && entry.primaryText)
      .slice(0, 3)
      .map((entry) => {
        const genes = creativePerformanceExampleGenes(entry.genes);
        return {
          headline: entry.headline!,
          primaryText: entry.primaryText!,
          ...(genes ? { genes } : {}),
          ...(entry.metrics.ctr !== null ? { ctr: entry.metrics.ctr } : {}),
        };
      }),
    losingExamples: digest.losers
      .filter((entry) => entry.headline && entry.primaryText)
      .slice(0, 3)
      .map((entry) => {
        const genes = creativePerformanceExampleGenes(entry.genes);
        return {
          headline: entry.headline!,
          primaryText: entry.primaryText!,
          ...(genes ? { genes } : {}),
        };
      }),
    geneInsights: creativePerformanceGeneInsightLines(digest),
  };
}

function referenceCreativesFromDigest(
  digest: CreativePerformanceDigest | null,
): NonNullable<ImagePromptAgentInput["referenceCreatives"]> {
  if (!digest) return [];
  return digest.winners.slice(0, 3).map((entry) => ({
    hierarchy: "ad" as const,
    nodeKey: entry.creativeKey,
    displayName: entry.displayName,
    current: {
      impressions: entry.metrics.impressions,
      clicks: entry.metrics.clicks,
      conversions: entry.metrics.conversions,
      spend: entry.metrics.spendMajor,
      ...(entry.metrics.ctr !== null ? { ctr: entry.metrics.ctr } : {}),
      ...(entry.metrics.cpaMajor !== null
        ? { cpa: entry.metrics.cpaMajor }
        : {}),
    },
    rationale: [
      `creative performance verdict=${entry.verdict}`,
      creativePerformanceExampleGenes(entry.genes),
    ]
      .filter(Boolean)
      .join(" / "),
    creative: {
      key: entry.creativeKey,
      displayName: entry.displayName,
      headline: entry.headline,
      primaryText: entry.primaryText,
      callToAction: null,
      linkUrl: null,
    },
  }));
}

function metricsToRecord(
  metrics: ImprovementPrPerformanceMetrics,
): Record<string, number> {
  const out: Record<string, number> = {
    spend: metrics.spend,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    conversions: metrics.conversions,
  };
  if (typeof metrics.ctr === "number") out.ctr = metrics.ctr;
  if (typeof metrics.cpc === "number") out.cpc = metrics.cpc;
  if (typeof metrics.cpa === "number") out.cpa = metrics.cpa;
  return out;
}

function sanitizeCreativeForPrompt<
  T extends { linkUrl?: string | null } | null,
>(creative: T): T {
  if (!creative) return creative;
  return {
    ...creative,
    linkUrl: landingPageUrlForPrompt(creative.linkUrl),
  };
}

function placementSignalsFromCreativeContext(
  context: ImprovementPrCreativeGenerationContext | null,
): string[] {
  if (!context) return [];
  const out: string[] = [];
  const covered = new Set<string>();
  const add = (value: unknown, label: string) => {
    const summary = placementSummaryFromValue(value);
    if (summary) out.push(`${label}: ${summary}`);
    for (const category of placementCategoriesFromValue(value))
      covered.add(category);
  };
  add(context.target?.spec, "target");
  context.references.slice(0, 3).forEach((ref, index) => {
    add(ref.spec, `reference_${index + 1}`);
  });
  for (const note of context.notes ?? []) add(note, "note");
  if (covered.size > 0) {
    const missing = [
      "feed_square",
      "feed_portrait",
      "story_reels",
      "feed_landscape",
    ].filter((category) => !covered.has(category));
    if (missing.length > 0) {
      out.push(
        `coverage_gap: no clear evidence for ${missing.join(", ")} in current creative context`,
      );
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function placementSummaryFromValue(value: unknown): string | null {
  const text = JSON.stringify(value ?? "").toLowerCase();
  if (!text || text === '""') return null;
  const surfaces: string[] = [];
  if (text.includes("story") || text.includes("stories"))
    surfaces.push("stories");
  if (text.includes("reel")) surfaces.push("reels");
  if (text.includes("feed") || text.includes("stream") || text.includes("home"))
    surfaces.push("feed");
  if (text.includes("facebook")) surfaces.push("facebook");
  if (text.includes("instagram")) surfaces.push("instagram");
  if (text.includes("messenger")) surfaces.push("messenger");
  if (text.includes("audience_network")) surfaces.push("audience_network");
  if (text.includes("4:5") || text.includes("portrait")) surfaces.push("4:5");
  if (text.includes("9:16")) surfaces.push("9:16");
  if (text.includes("1:1") || text.includes("square")) surfaces.push("1:1");
  if (text.includes("1.91:1") || text.includes("landscape"))
    surfaces.push("1.91:1");
  return surfaces.length > 0 ? [...new Set(surfaces)].join(", ") : null;
}

function placementCategoriesFromValue(value: unknown): string[] {
  const text = JSON.stringify(value ?? "").toLowerCase();
  if (!text || text === '""') return [];
  const out = new Set<string>();
  if (text.includes("story") || text.includes("reel") || text.includes("9:16"))
    out.add("story_reels");
  if (text.includes("portrait") || text.includes("4:5"))
    out.add("feed_portrait");
  if (text.includes("landscape") || text.includes("1.91:1"))
    out.add("feed_landscape");
  if (
    text.includes("feed") ||
    text.includes("stream") ||
    text.includes("home") ||
    text.includes("square") ||
    text.includes("1:1")
  ) {
    out.add("feed_square");
  }
  return [...out];
}

/**
 * regression fix: LLM creative_qa の出力に、生成済み asset 群に対する決定論的
 * `evaluateCreativeQaBatch` 結果をマージする。
 *
 * - dimensions / format / quality / forbidden_expression / brand_tone のうち
 *   `outcome="fail"` かつ `severity="blocking"` の check が 1 件でもある場合、
 *   `recommendation` を `reject` に強制ダウングレードする (= "Creative QA
 *   checks ... before PR attachment" acceptance)。
 * - 検査の per-check 結果を `issues` に追記する (LLM の issues は保持)。
 * - `rationale` の末尾に「deterministic gate appended N issue(s)」 を追加し、
 *   PR body / audit 上で由来が分かるようにする。
 * - 入力 `assets` が空の場合は LLM 出力をそのまま返す (= 呼び出し側で空配列を
 *   弾いている契約だが defense in depth)。
 *
 * 本関数は副作用なし。Prisma も外部 fetch も触らない。
 */
function mergeDeterministicCreativeQa(
  llmOutput: ImprovementPrCreativeQaOutput,
  assets: readonly ImprovementPrCreativeQaAssetCheck[],
): ImprovementPrCreativeQaOutput {
  if (assets.length === 0) return llmOutput;
  const inputs: CreativeQaAssetInput[] = assets.map((a) => {
    // ImageGeneratedAsset.mimeType は Provider 抽象で `"image/png" | "image/jpeg"`
    // に絞られるが、本ヘルパは queue 経由の任意の string を受けるため、
    // 未知の値はそのまま evaluateCreativeQaBatch に流して `format` check に
    // 失敗判定させる (= 監査経路に痕跡を残す)。
    const mimeTypeForAsset =
      a.mimeType === "image/png" || a.mimeType === "image/jpeg"
        ? a.mimeType
        : ("image/png" as const);
    const input: CreativeQaAssetInput = {
      asset: {
        variantKey: a.variantKey,
        // bytes は not-needed — evaluateCreativeQaBatch の検査は metadata 中心。
        // 空 Uint8Array を渡し、quality check は providerQualityScore + byteSize で判定する。
        bytes: new Uint8Array(0),
        mimeType: mimeTypeForAsset,
        width: a.width,
        height: a.height,
        byteSize: a.byteSize,
      },
    };
    if (a.detectedText !== undefined && a.detectedText !== null) {
      input.detectedText = a.detectedText;
    }
    if (
      a.providerQualityScore !== undefined &&
      a.providerQualityScore !== null
    ) {
      input.providerQualityScore = a.providerQualityScore;
    }
    return input;
  });
  const batch = evaluateCreativeQaBatch(inputs);
  const appended: ImprovementPrCreativeQaIssue[] = [];
  let blockingFailureCount = 0;
  for (const assetResult of batch.assets) {
    for (const check of assetResult.checks) {
      if (check.outcome === "fail" && check.severity === "blocking") {
        blockingFailureCount += 1;
      }
      if (check.outcome === "fail" || check.outcome === "warn") {
        const severity: ImprovementPrCreativeQaIssue["severity"] =
          check.outcome === "fail" && check.severity === "blocking"
            ? "error"
            : check.outcome === "fail"
              ? "warn"
              : "warn";
        appended.push({
          severity,
          category: `deterministic.${check.kind}.${assetResult.variantKey}`,
          message: check.evidence
            ? `${check.detail} (${check.evidence})`
            : check.detail,
        });
      }
    }
  }
  const recommendation: ImprovementPrCreativeQaOutput["recommendation"] =
    blockingFailureCount > 0 ? "reject" : llmOutput.recommendation;
  const rationale =
    appended.length > 0
      ? `${llmOutput.rationale} (deterministic gate appended ${appended.length} issue(s); ${blockingFailureCount} blocking)`
      : llmOutput.rationale;
  return {
    issues: [...llmOutput.issues, ...appended],
    recommendation,
    rationale,
  };
}

// ---------------------------------------------------------------------
// GitHub publisher — gitops 出力を ops repo に PR として書き込む
// ---------------------------------------------------------------------

export interface CreateImprovementPrGithubPublisherOptions {
  prisma: PrismaClient;
  adapter: GithubAdapter;
  workspaceId: string;
}

/**
 * `createImprovementPrGithubPublisher` — `getGithubAdapter().createPullRequest`
 * を呼んで PR を立て、`github_pull_requests` 行を upsert する。
 *
 * - ops repo (= workspace.opsRepoId) が未設定なら throw する。
 *   呼び出し側 (orchestrator) は `pr_failed` に倒す。
 * - branch 名は `gitops` agent が出した `branchName` をそのまま使う。
 */
export function createImprovementPrGithubPublisher(
  opts: CreateImprovementPrGithubPublisherOptions,
): ImprovementPrGithubPublisher {
  return {
    async createPullRequest(
      req: ImprovementPrPullRequestRequest,
    ): Promise<ImprovementPrPullRequestRecord> {
      const ws = await opts.prisma.workspace.findUnique({
        where: { id: opts.workspaceId },
        select: { opsRepoId: true },
      });
      if (!ws?.opsRepoId) {
        throw new Error(
          "improvement_pr: workspace has no ops repository connected",
        );
      }
      const repo = await opts.prisma.githubRepo.findUnique({
        where: { id: ws.opsRepoId },
        select: { id: true, owner: true, name: true, defaultBranch: true },
      });
      if (!repo) {
        throw new Error(
          `improvement_pr: ops repo ${ws.opsRepoId} not found in github_repos`,
        );
      }

      const adapterFiles: CreatePullRequestFile[] = req.files.map(
        (f: ImprovementPrFileChange) => ({
          path: f.path,
          diff: f.diff,
          action: f.action,
        }),
      );
      const created = await opts.adapter.createPullRequest({
        spec: {
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        },
        title: req.prTitle,
        body: req.prBody,
        branchName: req.branchName,
        files: adapterFiles,
        baseRef: req.baseRef ?? repo.defaultBranch,
      });

      // regression fix: Web UI /approvals/[prNumber] が PR プレビュー (本文・
      // 変更ファイル/diff サマリ) を実 local 状態から描画できるよう、publisher
      // が手元に持っている body/files をこの行に永続化する。値は LLM 出力由来で
      // 既に sanitize 済み (ai_runs と同じ rendering boundary)。diff は DB 肥大化を
      // 抑えるため 50 ファイル / 4 KiB ずつに切り詰める。
      const filesPreview = summarizeFilesForPreview(req.files);
      const previewUpdatedAt = new Date();

      // github_pull_requests に upsert する。github_poll が再走したときに
      // 重複行を作らないため (= unique(repoId, number))。
      const prRow = await opts.prisma.githubPullRequest.upsert({
        where: {
          repoId_number: { repoId: repo.id, number: created.number },
        },
        update: {
          title: req.prTitle,
          state: "open",
          headSha: created.headSha,
          baseRef: req.baseRef ?? repo.defaultBranch,
          htmlUrl: created.htmlUrl,
          body: req.prBody,
          filesChangedJson: filesPreview as unknown as Prisma.InputJsonValue,
          filesChangedCount: req.files.length,
          previewSource: "improvement_pr",
          previewUpdatedAt,
        },
        create: {
          repoId: repo.id,
          number: created.number,
          title: req.prTitle,
          state: "open",
          headSha: created.headSha,
          baseRef: req.baseRef ?? repo.defaultBranch,
          htmlUrl: created.htmlUrl,
          body: req.prBody,
          filesChangedJson: filesPreview as unknown as Prisma.InputJsonValue,
          filesChangedCount: req.files.length,
          previewSource: "improvement_pr",
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

// regression fix: PR プレビュー (本文・変更ファイル/diff サマリ) を
// `github_pull_requests.filesChangedJson` に書き込む際の正規化ヘルパ。
// 50 ファイル / 4 KiB を超える分は切り詰め、UI が安全に描画できる
// shape (Json) を返す。LLM 出力由来の値は既に sanitize 済み (ai_runs の
// rendering boundary を継承) のため、ここでは追加 redact は行わない。
const PREVIEW_MAX_FILES = 50;
const PREVIEW_MAX_DIFF_BYTES = 4096;

interface FileChangePreviewEntry {
  path: string;
  action: "create" | "update" | "delete";
  diffPreview: string;
  diffTruncated: boolean;
  diffByteLength: number;
  additions: number;
  deletions: number;
}

interface FileChangePreview {
  files: FileChangePreviewEntry[];
  truncatedFileCount: number;
  totalFileCount: number;
}

function summarizeFilesForPreview(
  files: readonly ImprovementPrFileChange[],
): FileChangePreview {
  const total = files.length;
  const slice = files.slice(0, PREVIEW_MAX_FILES);
  const truncatedFileCount = total - slice.length;
  const entries: FileChangePreviewEntry[] = slice.map((f) => {
    const diff = typeof f.diff === "string" ? f.diff : "";
    const byteLength = Buffer.byteLength(diff, "utf8");
    const truncated = byteLength > PREVIEW_MAX_DIFF_BYTES;
    const diffPreview = truncated
      ? truncateUtf8(diff, PREVIEW_MAX_DIFF_BYTES)
      : diff;
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split(/\r?\n/)) {
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("@@") ||
        line.startsWith("diff ") ||
        line.startsWith("index ")
      ) {
        continue;
      }
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return {
      path: f.path,
      action: f.action,
      diffPreview,
      diffTruncated: truncated,
      diffByteLength: byteLength,
      additions,
      deletions,
    };
  });
  return {
    files: entries,
    truncatedFileCount,
    totalFileCount: total,
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  // UTF-8 のマルチバイト境界で切らないよう、可能なら直前の改行で揃える。
  let end = maxBytes;
  for (let i = end; i >= Math.max(0, end - 256); i--) {
    if (buf[i] === 0x0a /* \n */) {
      end = i;
      break;
    }
  }
  return buf.slice(0, end).toString("utf8");
}

// ---------------------------------------------------------------------
// Audit writer — audit_logs / approval_records を残す
// ---------------------------------------------------------------------

export interface CreateImprovementPrAuditWriterOptions {
  prisma: PrismaClient;
}

/**
 * `createImprovementPrAuditWriter` — workflow 単位の audit を 1 行記録する。
 *
 * - 常に `audit_logs` を 1 行作る (`improvement_pr.opened|skipped|failed`)。
 * - PR が立った場合は `approval_records` を 1 行作り、audit decision を
 *   schema-allowed (`approved | rejected | auto_blocked | auto_approved`) に
 *   マップする (`approval_required` は schema 値が無いため記録しない — UI は
 *   approval_records の不在を「required」状態として表示する設計)。
 */
export function createImprovementPrAuditWriter(
  opts: CreateImprovementPrAuditWriterOptions,
): ImprovementPrAuditWriter {
  return {
    async recordImprovementPrAudit(
      input: ImprovementPrAuditInput,
    ): Promise<void> {
      const targetRef = input.pullRequest
        ? `pr#${input.pullRequest.prNumber}@${input.pullRequest.headSha}`
        : `account:${input.accountKey}`;
      const target = input.pullRequest
        ? `github_pull_request:${input.pullRequest.pullRequestId}`
        : `ad_account:${input.accountId}`;
      const metadata = {
        accountKey: input.accountKey,
        accountId: input.accountId,
        cronRunId: input.cronRunId,
        aiRunIds: input.aiRunIds,
        auditDecision: input.auditDecision,
        classification: input.classification,
        dangerousCategories: input.dangerousCategories,
        summary: input.summary,
        ...input.metadata,
        ...(input.pullRequest
          ? {
              prNumber: input.pullRequest.prNumber,
              htmlUrl: input.pullRequest.htmlUrl,
              headSha: input.pullRequest.headSha,
            }
          : {}),
      } satisfies Record<string, unknown>;

      await opts.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: "addroid",
          action: input.action,
          target,
          ref: targetRef,
          metadata: metadata as Prisma.InputJsonValue,
        },
      });

      if (input.pullRequest && input.auditDecision) {
        const decision = mapAuditDecisionToApprovalRecord(input.auditDecision);
        if (decision) {
          await opts.prisma.approvalRecord.create({
            data: {
              workspaceId: input.workspaceId,
              pullRequestId: input.pullRequest.pullRequestId,
              approvedBy: "addroid",
              decision,
              comment: input.summary,
              metadata: {
                classification: input.classification,
                dangerousCategories: input.dangerousCategories,
                aiRunIds: input.aiRunIds,
                source: "improvement_pr",
              } satisfies Record<string, unknown> as Prisma.InputJsonValue,
            },
          });
        }
      }
    },
  };
}

function mapAuditDecisionToApprovalRecord(
  decision: ImprovementPrAuditDecision,
): "auto_approved" | "auto_blocked" | null {
  // Schema allowed values: approved | rejected | auto_blocked | auto_approved.
  // `approval_required` は AdDroid の Web UI / CLI / Slack 承認、または GitHub merge
  // に委ねるため、
  // approval_records には行を残さない (UI は不在を "required" として描画する)。
  switch (decision) {
    case "auto_approved":
      return "auto_approved";
    case "auto_blocked":
      return "auto_blocked";
    case "approval_required":
      return null;
    default:
      return null;
  }
}

// keep classification reference exported for typecheck consumers
export type { ImprovementPrAuditClassification };

// ---------------------------------------------------------------------
// Plan validator — gitops 出力を ADDROID_OPS_REPO_LOCAL_DIR の作業 copy に
// 適用してから runPlanForRoot を実行する (Regression fix)
// ---------------------------------------------------------------------

export interface CreateImprovementPrPlanValidatorOptions {
  /**
   * ops repo の local checkout 絶対パス。`ADDROID_OPS_REPO_LOCAL_DIR` 経由で渡す。
   * 未設定 / 存在しない場合は `available=false` を返す validator になる。
   */
  rootDir: string | null;
  /** plan 比較の base (任意)。`ADDROID_OPS_REPO_BASE_DIR` 経由で渡す。 */
  baseDir?: string | null;
  /** test seam: 一時ディレクトリ生成。 */
  mkdtemp?: () => string;
}

/**
 * `createImprovementPrPlanValidator` — gitops が出した
 * `ImprovementPrFileChange[]` を ADDROID_OPS_REPO_LOCAL_DIR の作業 copy に
 * 適用してから `runPlanForRoot` を回す。CLI / `/api/plan` と同一の
 * `runPlanForRoot` を共有するため、UI からの dry-run と PR 経路の dry-run が
 * 完全に同等になる (acceptance: "dry-run result" を PR に含める)。
 *
 * - validator の例外は throw せず、`available=false` + summary に reason を
 *   sanitize 済みで残す (orchestrator は PR 発行を継続)。
 * - 一時ディレクトリは finally で必ず削除する。
 */
export function createImprovementPrPlanValidator(
  opts: CreateImprovementPrPlanValidatorOptions,
): ImprovementPrPlanValidator {
  const mkdtemp =
    opts.mkdtemp ??
    (() => fs.mkdtempSync(path.join(os.tmpdir(), "addroid-improvement-plan-")));
  return {
    async validate(input): Promise<ImprovementPrPlanValidationResult> {
      const startedAt = Date.now();
      if (!opts.rootDir) {
        return skippedResult(
          "ADDROID_OPS_REPO_LOCAL_DIR not set; plan validation skipped",
          startedAt,
        );
      }
      if (!fs.existsSync(opts.rootDir)) {
        return skippedResult(
          `ADDROID_OPS_REPO_LOCAL_DIR (${opts.rootDir}) does not exist; plan validation skipped`,
          startedAt,
        );
      }
      let workDir: string | null = null;
      try {
        workDir = mkdtemp();
        copyDirSync(opts.rootDir, workDir);
        for (const file of input.files) {
          applyFileChange(workDir, file);
        }
        const planRun = runPlanForRoot({
          rootDir: workDir,
          baseDir: opts.baseDir ?? opts.rootDir,
          accountFilter: input.accountKey,
        });
        const counts = planRun.totalCounts;
        const errors = planRun.validationErrors.map(toFinding);
        const warnings = planRun.validationWarnings.map(toFinding);
        const accountSummary = planRun.perAccount[0];
        const status = planRun.ok ? "ok" : "error";
        const summary =
          `plan ${status} for account=${input.accountKey}: ` +
          `+${counts.creates} ~${counts.updates} -${counts.deletes}` +
          (accountSummary ? ` (risk=${accountSummary.risk})` : "") +
          (errors.length > 0 ? ` errors=${errors.length}` : "") +
          (warnings.length > 0 ? ` warnings=${warnings.length}` : "");
        return {
          available: true,
          ok: planRun.ok,
          risk: planRun.risk,
          counts: {
            creates: counts.creates,
            updates: counts.updates,
            deletes: counts.deletes,
            errors: counts.errors,
            warnings: counts.warnings,
          },
          errors,
          warnings,
          summary,
          durationMs: planRun.durationMs,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          available: false,
          ok: false,
          risk: "error",
          counts: {
            creates: 0,
            updates: 0,
            deletes: 0,
            errors: 0,
            warnings: 0,
          },
          errors: [],
          warnings: [],
          summary: `plan validation failed: ${message}`,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        if (workDir) {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {
            // 一時ディレクトリの掃除失敗は黙殺する (OS が tmp を自動 GC する)。
          }
        }
      }
    },
  };
}

function skippedResult(
  reason: string,
  startedAt: number,
): ImprovementPrPlanValidationResult {
  return {
    available: false,
    ok: false,
    risk: "error",
    counts: { creates: 0, updates: 0, deletes: 0, errors: 0, warnings: 0 },
    errors: [],
    warnings: [],
    summary: reason,
    durationMs: Date.now() - startedAt,
  };
}

function toFinding(f: { file: string; message: string; pointer?: string }): {
  file: string;
  message: string;
  pointer?: string;
} {
  const out: { file: string; message: string; pointer?: string } = {
    file: f.file,
    message: f.message,
  };
  if (f.pointer) out.pointer = f.pointer;
  return out;
}

/**
 * gitops の `ImprovementPrFileChange` を 1 件、作業 copy に適用する。
 *
 * - create / update: diff から復元したファイル本体を書き込む。
 * - delete: ファイルを取り除く (存在しなければ no-op)。
 *
 * パスは作業 copy 内 (`workDir` 配下) に正規化し、ディレクトリトラバーサルを防ぐ。
 */
function applyFileChange(workDir: string, file: ImprovementPrFileChange): void {
  const safeRel = path.normalize(file.path).replace(/^([\\/]|\.\.[\\/])+/, "");
  const dest = path.resolve(workDir, safeRel);
  const workDirAbs = path.resolve(workDir);
  if (!dest.startsWith(workDirAbs + path.sep) && dest !== workDirAbs) {
    throw new Error(
      `improvement_pr plan validator: refused unsafe path '${file.path}'`,
    );
  }
  if (file.action === "delete") {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
    }
    return;
  }
  const content = extractAddedContentFromDiff(file.diff);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
}

function copyDirSync(src: string, dest: string): void {
  // Node 18+ の cpSync は recursive copy を提供する。
  fs.cpSync(src, dest, { recursive: true, dereference: false });
}

/**
 * gitops agent が出した unified diff から、追加行だけを取り出してファイル本体を
 * 復元する。`packages/github-adapter/src/octokit-adapter.ts` の同名関数と同じ
 * 契約 ("create / update のいずれも完全な新ファイル本体を `+` 行で表現する")
 * に従う。
 */
function extractAddedContentFromDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      out.push(line.slice(1));
    } else {
      out.push(line);
    }
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}
