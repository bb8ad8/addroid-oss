// AdDroid OSS — pg-boss 統合層 (`@addroid/queue`).
//
// 本パッケージは pg-boss の薄い起動ラッパと、AdDroid 側の cron_schedules /
// cron_runs / execution_logs / github_pull_requests / apply_jobs を更新する
// ヘルパ群を提供する。Prisma を直接 import しないため、apps/worker から
// `CronOpsStore` / `GithubPollStore` を満たす Prisma 実装を注入して使う。
//
// the current implementation の制約:
//   - GitHub Webhook を使わず、merged PR は github_poll cron で検知する。
//   - daily_report / today_report / improvement_pr / auto_creative_generation は登録のみで未起動。
//   - 自然言語カスタム cron は preset cron ではなく scheduled_task_run job で動く。
//
// Compatibility note:
// この barrel は worker / web / CLI / tests が共有する internal public API。
// export の削除・リネームは release 前の互換性レビュー対象にする。型だけに見える
// Store / Adapter export も、Prisma 実装注入と local harness の境界として維持する。

// Queue names, preset schedules, and pg-boss bootstrapping.
export {
  CRON_PRESETS,
  APPLY_JOB_NAME,
  SCHEDULED_TASK_JOB_NAME,
  AUTOMATION_RULE_JOB_NAME,
  type CronPreset,
  type CronPresetName,
} from "./presets.js";

export {
  bootPgBoss,
  ensureQueue,
  ensureRuntimeQueues,
  registerCronPresets,
  resolveCronScheduleTimeZone,
  RUNTIME_QUEUE_NAMES,
  scheduleCron,
  type BootOptions,
  type CronScheduler,
  type QueueManager,
  type RegisterPresetsOptions,
} from "./boot.js";

export {
  validateCronExpression,
  type CronValidationResult,
} from "./cron-validation.js";

// Store / adapter contracts. These are DI boundaries, not disposable test-only types.
export {
  type AccountExecutionModes,
  type CronOpsStore,
  type GithubPollStore,
  type OpsRepoSnapshot,
  type RecordPollingStateInput,
  type UpsertPullRequestInput,
  type RecordApplyJobInput,
  type RecordApplyBlockedInput,
  type RecordMergeAuditInput,
  type PrApprovalDecision,
  type PrApprovalEvidence,
  type RecordPrApprovalInput,
  type UpsertCronScheduleInput,
  type StartCronRunInput,
  type FinishCronRunInput,
  type FailCronRunInput,
  type ExecutionLogInput,
  type JsonValue,
  type QueueGithubAdapter,
  type QueuePollResult,
  type QueuePullRequestSummary,
  type ApplyApprovalSnapshot,
  type ApplyAuditAction,
  type ApplyJobContext,
  type ApplyJobStore,
  type ApplyTerminalState,
  type MarkApplyFinishedInput,
  type MarkApplyRunningInput,
  type RecordApplyAuditInput,
  type UpsertAppliedAdsNodeInput,
  type WorkspaceExecutionModeContext,
} from "./store.js";

export {
  mirrorPresetsToCronSchedules,
  type MirrorPresetsOptions,
  type MirrorPresetsResult,
} from "./mirror.js";

export {
  startCronRun,
  finishCronRun,
  failCronRun,
  type CronRunHandle,
} from "./runs.js";

// Apply / activate execution pipeline.
export {
  enqueueApplyJob,
  type ApplyJobBoss,
  type ApplyJobSendOptions,
  type EnqueueApplyOptions,
  type EnqueueApplyResult,
} from "./apply.js";

export {
  DEFAULT_META_RATE_LIMIT_POLICY,
  buildAdAccountLockKey,
  buildApplySingletonKey,
  classifyThrottleSeverity,
  computeBackoffDelayMs,
  createCrossProcessAdAccountLockProvider,
  createInProcessAdAccountLockProvider,
  extractThrottleObservation,
  withAccountLock,
  type AdAccountLockProvider,
  type MetaRateLimitPolicy,
  type ThrottleHeaderShape,
  type ThrottleObservation,
  type ThrottleSeverity,
} from "./rate-limit.js";

export {
  prepareApprovedApplyAction,
  isNoopAction,
  runExecuteApply,
  type AccountAdsState,
  type AdsLoader,
  type AdsLoaderInput,
  type AdsLoadResult,
  type ApplyAction,
  type ApplyActionOutcome,
  type ExecuteActionInput,
  type ExecuteActionResult,
  type ExecuteActionStatus,
  type GraphOperationAction,
  type GraphOperationKind,
  type MetaCliOperationAction,
  type MetaActionExecutor,
  type RunExecuteApplyOptions,
  type RunExecuteApplySummary,
} from "./apply-executor.js";

export {
  deriveActivateDecisionSource,
  runActivate,
  type ActivateApprovalDecision,
  type ActivateApprovalInput,
  type ActivateAuditAction,
  type ActivateAuditInput,
  type ActivateDecisionSource,
  type ActivateExecuteInput,
  type ActivateExecuteResult,
  type ActivateExecuteStatus,
  type ActivateExecutor,
  type ActivateNodeSnapshot,
  type ActivateOutcomeStatus,
  type ActivateRequest,
  type ActivateSource,
  type ActivateStore,
  type ActivateSummary,
  type RunActivateOptions,
} from "./activate-executor.js";

export {
  runGithubPollOnce,
  type GithubPollStatus,
  type GithubPollSummary,
  type RunGithubPollOptions,
} from "./github-poll.js";

// Scheduled business workflows.
export {
  computeKpiDeltas,
  microsToMajor,
  resolveDailyReportTimeZone,
  runDailyReportOnce,
  subtractOneUtcDay,
  toDateStringInTimeZone,
  toKpiSet,
  toUtcDateString,
  type DailyReportAdAccountSnapshot,
  type DailyReportAnalystImprovement,
  type DailyReportAnalystInput,
  type DailyReportAnalystResult,
  type DailyReportAnalystRunner,
  type DailyReportExecutionMode,
  type DailyReportImprovementCandidate,
  type DailyReportInsightsProvider,
  type DailyReportInsightsRequest,
  type DailyReportInsightsResponse,
  type DailyReportInsightsRow,
  type DailyReportKpiSet,
  type DailyReportNodeType,
  type DailyReportRunStatus,
  type DailyReportSnapshotStore,
  type DailyReportStatisticalComparison,
  type DailyReportStatisticalContext,
  type DailyReportSummary,
  type PerformanceSnapshotUpsertInput,
  type PerformanceSnapshotUpsertResult,
  type RunDailyReportOptions,
  buildStatisticalContext,
} from "./daily-report.js";

export {
  detectAnomalies,
  type AnomalyDetectionResult,
  type AnomalyDetectionStore,
  type AnomalyHierarchy,
  type AnomalyKind,
  type AnomalyMetric,
  type AnomalySeverity,
  type NodeAnomalyFinding,
  type SnapshotSeriesRow,
} from "./anomaly-detection.js";

export {
  deriveMetrics,
  microsToMajorUnit,
  type DerivedMetrics,
  type SnapshotMetricInput,
} from "./metrics.js";

export {
  buildCreativePerformanceDigest,
  creativePerformanceExampleGenes,
  creativePerformanceGeneInsightLines,
  type CreativePerformanceCreativeRow,
  type CreativePerformanceDigest,
  type CreativePerformanceEntry,
  type CreativePerformanceHierarchyRow,
  type CreativePerformanceJoinedRow,
  type CreativePerformanceSnapshotRow,
  type CreativePerformanceStore,
} from "./creative-performance.js";

export {
  DEFAULT_ANOMALY_Z_THRESHOLD,
  DEFAULT_PROPORTION_ALPHA,
  DEFAULT_PROPORTION_MIN_SUCCESSES,
  DEFAULT_PROPORTION_MIN_TRIALS,
  DEFAULT_WILSON_Z,
  INDICATIVE_MIN_CONVERSIONS,
  INDICATIVE_MIN_IMPRESSIONS,
  RELIABLE_MIN_CONVERSIONS,
  RELIABLE_MIN_IMPRESSIONS,
  compareProportions,
  confidenceLabel,
  scoreAnomaly,
  wilsonInterval,
  type AnomalyScore,
  type ConfidenceLabel,
  type ProportionCI,
  type ProportionComparison,
} from "./stats.js";

export {
  combineApprovalClassifications,
  combineApprovalDecisions,
  evaluateApprovalPolicy,
  isDangerousCategory,
  normalizeExecutionMode,
  resolveExecutionMode,
  unionDangerousCategories,
  type ApprovalCandidate,
  type ApprovalClassification,
  type ApprovalDecision,
  type ApprovalPolicyInput,
  type ApprovalPolicyResult,
  type ExecutionMode,
} from "./execution-mode.js";

export {
  evaluateBudgetGuardPolicy,
  runBudgetGuardOnce,
  type BudgetGuardAlert,
  type BudgetGuardAlertRule,
  type BudgetGuardAlertSeverity,
  type BudgetGuardAuditInput,
  type BudgetGuardAuditOutput,
  type BudgetGuardAuditResult,
  type BudgetGuardAuditRunner,
  type BudgetGuardAutoPausePolicy,
  type BudgetGuardCandidateAction,
  type BudgetGuardClassification,
  type BudgetGuardDecision,
  type BudgetGuardEvaluation,
  type BudgetGuardExecutionMode,
  type BudgetGuardPolicy,
  type BudgetGuardPolicyAlerts,
  type BudgetGuardRunStatus,
  type BudgetGuardSpendContext,
  type BudgetGuardStore,
  type BudgetGuardSummary,
  type RunBudgetGuardOptions,
} from "./budget-guard.js";

export {
  DEFAULT_RETENTION_POLICY,
  runPerformanceSnapshotRetentionOnce,
  type PerformanceSnapshotRetentionStore,
  type RetentionPolicyDays,
  type RetentionSweepStatus,
  type RetentionSweepStepResult,
  type RetentionSweepSummary,
  type RunPerformanceSnapshotRetentionOptions,
} from "./retention.js";

export {
  DEFAULT_BREAKDOWNS_POLICY,
  aggregateInsightsByHierarchy,
  aggregateInsightsRows,
  enabledBreakdownLevels,
  mergeBreakdownsPolicy,
  selectAccountKpiSet,
  type BreakdownsPolicy,
} from "./analytics.js";

// Natural-language automation rule DSL and guardrail helpers.
export {
  evaluateAutomationRule,
  interpretAutomationRequestTiming,
  validateAutomationRule,
  type AutomationAdjustBudgetAction,
  type AutomationBudgetOperation,
  type AutomationClarificationIntent,
  type AutomationClarificationOption,
  type AutomationClarificationReason,
  type AutomationCondition,
  type AutomationConditionGroup,
  type AutomationImmediateIntent,
  type AutomationLevel,
  type AutomationMetricSpec,
  type AutomationMetricSubject,
  type AutomationMetricWindow,
  type AutomationPlannedAction,
  type AutomationRecurringIntent,
  type AutomationRequestIntent,
  type AutomationRequestIntentKind,
  type AutomationRuleAction,
  type AutomationRuleDsl,
  type AutomationRuleEvaluation,
  type AutomationRuleScope,
  type AutomationSafetyMode,
  type AutomationSafetyPolicy,
  type AutomationSetStatusAction,
  type AutomationSkippedSubject,
  type AutomationStatus,
  type AutomationUnsupportedIntent,
  type InterpretAutomationRequestTimingInput,
} from "./automation-rules.js";

export {
  buildAutomationBaselineStats,
  buildAutomationRuleCalibration,
  evaluateAutomationCalibrationDrift,
  extractSpendThresholdFromConditions,
  parseAutomationRuleCalibration,
  recommendAutomationGuardrails,
  type AutomationBaselineInput,
  type AutomationBaselineQuality,
  type AutomationBaselineSnapshot,
  type AutomationBaselineStats,
  type AutomationCalibrationDriftPolicy,
  type AutomationCalibrationMode,
  type AutomationDriftEvaluation,
  type AutomationGuardrailInput,
  type AutomationGuardrailRecommendation,
  type AutomationRuleCalibration,
} from "./automation-baseline.js";

// Slack queue integration.
export {
  SLACK_COMMAND_JOB_NAME,
  SLACK_SLASH_COMMAND,
  SLACK_SLASH_SUBCOMMANDS,
  buildAckMessage,
  buildSlackCommandSingletonKey,
  enqueueSlackCommandJob,
  parseSlashCommand,
  postSlackResponse,
  runSlackCommandJob,
  sanitizeText,
  type EnqueueSlackCommandOptions,
  type EnqueueSlackCommandResult,
  type ParsedSlashCommand,
  type RawSlackSlashCommandRequest,
  type RunSlackCommandJobOptions,
  type SlackCommandAuditInput,
  type SlackCommandAuditWriter,
  type SlackCommandBoss,
  type SlackCommandJobPayload,
  type SlackCommandSendOptions,
  type SlackResponseFetch,
  type SlackResponseMessage,
  type SlashCommandAckMessage,
  type SlashCommandHandlers,
  type SlashCommandJobResult,
  type SlashCommandJobState,
  type SlashCommandParseError,
  type SlashCommandParseFailure,
  type SlashCommandParseResult,
  type SlashHandlerInput,
  type SlashHandlerOutcome,
  type SlashResponseBlock,
  type SlashSubcommand,
} from "./slack-command.js";

export {
  SLACK_AGENT_JOB_NAME,
  buildSlackAgentSingletonKey,
  enqueueSlackAgentJob,
  type EnqueueSlackAgentJobOptions,
  type EnqueueSlackAgentJobResult,
  type SlackAgentEventType,
  type SlackAgentJobPayload,
} from "./slack-agent.js";

export {
  startSlackSocketReceiver,
  type SlackInstallation,
  type SlackInstallationLoader,
  type SlackSocketReceiverHandle,
  type SlackSocketReceiverLogger,
  type SlackSocketReceiverOptions,
  type SlackSocketReceiverState,
  type SocketModeReceiverChannel,
  type SocketModeReceiverChannelOpener,
  type SocketModeReceiverHandlers,
  type SocketModeUrlOpener,
} from "./slack-socket-receiver.js";

// Improvement PR generation pipeline.
export {
  IMPROVEMENT_PR_IMAGE_DIMENSION_PRESETS,
  runImprovementPrOnce,
	  type ImprovementPrAgentRunResult,
	  type ImprovementPrAnalysisWindow,
	  type ImprovementPrAnalystOutput,
  type ImprovementPrAuditAction,
  type ImprovementPrAuditClassification,
  type ImprovementPrAuditDecision,
  type ImprovementPrAuditInput,
  type ImprovementPrAuditOutput,
  type ImprovementPrAuditWriter,
  type ImprovementPrBudgetImpact,
  type ImprovementPrBrandProfileContext,
  type ImprovementPrCopyOutput,
  type ImprovementPrCopyVariant,
  type ImprovementPrCreativeAttachment,
  type ImprovementPrCreativeGenerationContext,
  type ImprovementPrCreativeLinkInput,
  type ImprovementPrCreativeNodeContext,
  type ImprovementPrCreativePromptVariant,
  type ImprovementPrCreativeQaAssetCheck,
  type ImprovementPrCreativeQaIssue,
  type ImprovementPrCreativeQaOutput,
  type ImprovementPrCreativeQaRecommendation,
  type ImprovementPrCreativeRecord,
  type ImprovementPrCreativeStatus,
  type ImprovementPrDecision,
  type ImprovementPrExecutionMode,
  type ImprovementPrFileChange,
  type ImprovementPrGitOpsOutput,
  type ImprovementPrGithubPublisher,
  type ImprovementPrImagePromptOutput,
  type ImprovementPrImagePromptVariant,
  type ImprovementPrImageDimensionPreset,
	  type ImprovementPrMediaBuyerOutput,
	  type ImprovementPrPerformanceMetrics,
  type ImprovementPrPipelineInput,
  type ImprovementPrPipelineRunner,
  type ImprovementPrPlanCounts,
  type ImprovementPrPlanFinding,
  type ImprovementPrPlanRiskLevel,
  type ImprovementPrPlanValidationResult,
  type ImprovementPrPlanValidator,
  type ImprovementPrProposal,
  type ImprovementPrPullRequestRecord,
  type ImprovementPrPullRequestRequest,
  type ImprovementPrRiskTolerance,
  type ImprovementPrRunStatus,
  type ImprovementPrStore,
  type ImprovementPrStrategyOutput,
  type ImprovementPrSummary,
  type RunImprovementPrOptions,
} from "./improvement-pr.js";
