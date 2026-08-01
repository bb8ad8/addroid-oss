import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const ProjectYamlSchema = z
  .object({
    version: z.literal(1),
    workspace: z.object({
      slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug は小文字英数字とハイフンのみ"),
      displayName: z.string().min(1),
    }),
  })
  .strict();

export type ProjectYaml = z.infer<typeof ProjectYamlSchema>;

const CRON_FIELDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
];

function parseCronInteger(s: string): number | null {
  if (s.length === 0 || !/^\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

function validateCronAtom(
  atom: string,
  field: { name: string; min: number; max: number }
): string | null {
  if (atom.length === 0) return `${field.name}: empty atom`;
  let body = atom;
  const slashIdx = atom.indexOf("/");
  if (slashIdx !== -1) {
    body = atom.slice(0, slashIdx);
    const stepStr = atom.slice(slashIdx + 1);
    const step = parseCronInteger(stepStr);
    if (step === null || step <= 0) {
      return `${field.name}: step must be a positive integer (got "${stepStr}")`;
    }
  }
  if (body === "*") return null;
  if (body.length === 0) return `${field.name}: missing value before "/"`;
  const dashIdx = body.indexOf("-");
  if (dashIdx !== -1) {
    const start = parseCronInteger(body.slice(0, dashIdx));
    const end = parseCronInteger(body.slice(dashIdx + 1));
    if (start === null || end === null) return `${field.name}: invalid range "${body}"`;
    if (start < field.min || start > field.max) {
      return `${field.name}: range start ${start} not in [${field.min}, ${field.max}]`;
    }
    if (end < field.min || end > field.max) {
      return `${field.name}: range end ${end} not in [${field.min}, ${field.max}]`;
    }
    if (start > end) return `${field.name}: range start (${start}) is greater than end (${end})`;
    return null;
  }
  const n = parseCronInteger(body);
  if (n === null) return `${field.name}: invalid value "${body}"`;
  if (n < field.min || n > field.max) return `${field.name}: value ${n} not in [${field.min}, ${field.max}]`;
  return null;
}

function validateCronExpression(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `5 フィールドの cron 式である必要があります (got ${fields.length} fields)`;
  for (let i = 0; i < CRON_FIELDS.length; i += 1) {
    const raw = fields[i]!;
    if (raw.length === 0) return `${CRON_FIELDS[i]!.name}: empty field`;
    for (const atom of raw.split(",")) {
      const err = validateCronAtom(atom, CRON_FIELDS[i]!);
      if (err) return err;
    }
  }
  return null;
}

const CronExpressionSchema = z.string().min(1).superRefine((value, ctx) => {
  const err = validateCronExpression(value);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});

export const CronEntrySchema = z
  .object({
    name: z.enum([
      "github_poll",
      "daily_report",
      "today_report",
      "budget_guard",
      "budget_rebalance",
      "experiment_evaluate",
      "improvement_pr",
      "auto_creative_generation",
      "retention_sweep",
    ]),
    cron: CronExpressionSchema,
    enabled: z.boolean().default(false),
  })
  .strict();

export const CronYamlSchema = z
  .object({
    version: z.literal(1),
    schedules: z.array(CronEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.schedules.length; i += 1) {
      const name = value.schedules[i]!.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedules", i, "name"],
          message: `duplicate schedule name: ${name}`,
        });
      }
      seen.add(name);
    }
  });

export type CronYaml = z.infer<typeof CronYamlSchema>;

export const BudgetGuardPolicyAlertsSchema = z
  .object({
    dailyBudgetAlertRatio: z.number().nonnegative().optional(),
    monthlyPaceRatio: z.number().nonnegative().optional(),
    dayOverDayRatio: z.number().nonnegative().optional(),
    noConversionsSpendMin: z.number().nonnegative().optional(),
  })
  .strict();

export const BudgetGuardAutoPauseSchema = z
  .object({
    enabled: z.boolean(),
    minDailyBudgetRatio: z.number().nonnegative().optional(),
    minDayOverDayRatio: z.number().nonnegative().optional(),
    safeCategories: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const BudgetGuardAccountBudgetSchema = z
  .object({
    dailyBudget: z.number().nonnegative().default(0),
    monthlyBudget: z.number().nonnegative().default(0),
    currency: z.string().min(1).optional(),
    // account 単位のしきい値上書き。指定したキーだけが共通 `alerts` を上書きし、
    // 未指定のキーは共通値のまま使う。CV 単価も配信規模もアカウントごとに違うため、
    // 「CV=0 でいくら消化したら鳴らすか」を 1 つの共通値で揃えるのは実用的でない。
    alerts: BudgetGuardPolicyAlertsSchema.optional(),
  })
  .strict();

export const BudgetGuardPolicyYamlSchema = z
  .object({
    version: z.literal(1),
    alerts: BudgetGuardPolicyAlertsSchema.default({}),
    autoPause: BudgetGuardAutoPauseSchema.optional(),
    accounts: z.record(BudgetGuardAccountBudgetSchema).default({}),
  })
  .strict();

export type BudgetGuardPolicyYaml = z.infer<typeof BudgetGuardPolicyYamlSchema>;

export const BudgetRebalancePolicyYamlSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().default(false),
    lookbackDays: z.number().int().min(7).max(28).default(14),
    maxShiftPercentPerRun: z.number().min(1).max(30).default(20),
    minDailyBudgetMajor: z.number().min(0).default(0),
    minConversionsForJudgement: z.number().int().min(1).default(10),
    keepTotalBudget: z.boolean().default(true),
    excludeNodeKeys: z.array(z.string()).default([]),
  })
  .strict();

export type BudgetRebalancePolicyYaml = z.infer<typeof BudgetRebalancePolicyYamlSchema>;

export const SubmissionGuardBudgetIncreaseSchema = z
  .object({
    warnOverRatio: z.number().positive().default(2),
    blockOverRatio: z.number().positive().default(5),
  })
  .strict()
  .refine((value) => value.warnOverRatio < value.blockOverRatio, {
    message: "warnOverRatio は blockOverRatio より小さくしてください",
    path: ["warnOverRatio"],
  });

export const SubmissionGuardsYamlSchema = z
  .object({
    version: z.literal(1),
    guards: z
      .object({
        budgetIncrease: SubmissionGuardBudgetIncreaseSchema.default({
          warnOverRatio: 2,
          blockOverRatio: 5,
        }),
      })
      .strict()
      .default({ budgetIncrease: { warnOverRatio: 2, blockOverRatio: 5 } }),
  })
  .strict();

export type SubmissionGuardsYaml = z.infer<typeof SubmissionGuardsYamlSchema>;

export const AutomationMetricWindowSchema = z
  .object({
    preset: z.enum(["today", "yesterday", "last_7d", "last_14d", "last_30d"]).optional(),
    since: z.string().min(1).optional(),
    until: z.string().min(1).optional(),
    timezone: z.union([z.literal("account"), z.literal("utc"), z.string().min(1)]).optional(),
    lookbackHours: z.number().int().positive().max(24 * 30).optional(),
  })
  .passthrough();

export const AutomationRuleScopeSchema = z
  .object({
    level: z.enum(["account", "campaign", "adset", "ad"]),
    accounts: z.array(z.string().min(1)).optional(),
    includePaused: z.boolean().optional(),
  })
  .passthrough();

export const AutomationMetricSpecSchema = z
  .object({
    field: z.string().min(1),
    actionTypes: z.array(z.string().min(1)).optional(),
    unit: z.enum(["currency", "count", "ratio"]).optional(),
  })
  .passthrough();

export const AutomationConditionSchema = z
  .object({
    metric: z.string().min(1),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    eq: z.number().optional(),
    ne: z.number().optional(),
  })
  .strict();

export const AutomationConditionGroupSchema = z
  .object({
    all: z.array(AutomationConditionSchema).optional(),
    any: z.array(AutomationConditionSchema).optional(),
  })
  .strict()
  .refine((v) => (v.all?.length ?? 0) > 0 || (v.any?.length ?? 0) > 0, {
    message: "automation rule requires when.all or when.any",
  });

export const AutomationActionSchema = z
  .object({
    type: z.string().min(1),
    status: z.enum(["ACTIVE", "PAUSED"]).optional(),
    targetLevel: z.enum(["account", "campaign", "adset", "ad"]).optional(),
    operation: z.enum(["increase_percent", "decrease_percent", "set_amount"]).optional(),
    percent: z.number().positive().optional(),
    amount: z.number().positive().optional(),
    targetBudgetLevel: z.enum(["campaign", "adset", "auto"]).optional(),
  })
  .passthrough();

export const AutomationSafetySchema = z
  .object({
    mode: z.enum(["report_only", "proposal", "auto_apply"]).optional(),
    minConversions: z.number().nonnegative().optional(),
    minSpend: z.number().nonnegative().optional(),
    maxIncreasePercentPerDay: z.number().positive().optional(),
    maxDailyBudget: z.number().positive().optional(),
    cooldownHours: z.number().nonnegative().optional(),
  })
  .passthrough();

export const AutomationApprovalSchema = z
  .object({
    mode: z
      .enum([
        "report_only",
        "proposal",
        "auto_apply",
        "auto_apply_if_policy_matched",
        "auto_merge_if_policy_matched",
      ])
      .optional(),
  })
  .passthrough();

export const AutomationLimitsSchema = z
  .object({
    maxActionsPerRun: z.number().int().positive().optional(),
    maxCampaignsPerRun: z.number().int().positive().optional(),
    maxDailyBudgetAffected: z.number().nonnegative().optional(),
  })
  .passthrough();

export const AutomationCalibrationSchema = z
  .object({
    mode: z.enum(["static", "adaptive_with_bounds"]).optional(),
    source: z.literal("account_history").optional(),
    generatedAt: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    lookbackDays: z.number().int().positive().optional(),
    minSampleDays: z.number().int().positive().optional(),
    quality: z.enum(["sufficient", "insufficient", "empty"]).optional(),
    baseline: z.unknown().optional(),
    recommended: z.unknown().optional(),
    bounds: z.unknown().optional(),
    drift: z.unknown().optional(),
  })
  .passthrough();

export const AutomationRuleYamlSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "id は英数字・_・- のみ"),
    enabled: z.boolean().default(false),
    schedule: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    scope: AutomationRuleScopeSchema,
    window: AutomationMetricWindowSchema.default({ preset: "today", timezone: "account" }),
    metrics: z.record(AutomationMetricSpecSchema).default({}),
    computed: z.record(z.string().min(1)).optional(),
    when: AutomationConditionGroupSchema,
    action: AutomationActionSchema,
    safety: AutomationSafetySchema.optional(),
    approval: AutomationApprovalSchema.optional(),
    limits: AutomationLimitsSchema.optional(),
    calibration: AutomationCalibrationSchema.optional(),
    sourceText: z.string().min(1).optional(),
  })
  .passthrough();

export const AutomationRulesYamlSchema = z
  .object({
    version: z.literal(1).default(1),
    policies: z.unknown().optional(),
    rules: z.array(AutomationRuleYamlSchema).default([]),
  })
  .passthrough();

export type AutomationRuleYaml = z.infer<typeof AutomationRuleYamlSchema>;
export type AutomationRulesYaml = z.infer<typeof AutomationRulesYamlSchema>;

export interface OpsRepoLayout {
  projectYaml: string;
  cronYaml: string;
  budgetGuardYaml: string;
  budgetRebalanceYaml: string;
  submissionGuardsYaml: string;
  automationRulesYaml: string;
}

export const DEFAULT_OPS_REPO_LAYOUT: OpsRepoLayout = {
  projectYaml: ".addroid/project.yaml",
  cronYaml: "workflows/cron.yaml",
  budgetGuardYaml: "workflows/budget-guard.yaml",
  budgetRebalanceYaml: "workflows/budget-rebalance.yaml",
  submissionGuardsYaml: "workflows/guards.yaml",
  automationRulesYaml: "workflows/automation-rules.yaml",
};

export function loadBudgetGuardPolicy(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): BudgetGuardPolicyYaml | null {
  return loadYamlFile(rootDir, layout.budgetGuardYaml, BudgetGuardPolicyYamlSchema);
}

export function loadBudgetRebalancePolicy(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): BudgetRebalancePolicyYaml | null {
  return loadYamlFile(rootDir, layout.budgetRebalanceYaml, BudgetRebalancePolicyYamlSchema);
}

export function loadSubmissionGuardsPolicy(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): SubmissionGuardsYaml | null {
  return loadYamlFile(rootDir, layout.submissionGuardsYaml, SubmissionGuardsYamlSchema);
}

export function loadAutomationRules(
  rootDir: string,
  layout: OpsRepoLayout = DEFAULT_OPS_REPO_LAYOUT
): AutomationRulesYaml | null {
  return loadYamlFile(rootDir, layout.automationRulesYaml, AutomationRulesYamlSchema);
}

function loadYamlFile<TSchema extends z.ZodTypeAny>(
  rootDir: string,
  relPath: string,
  schema: TSchema
): z.infer<TSchema> | null {
  const abs = path.join(rootDir, relPath);
  if (!fs.existsSync(abs)) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  const out = schema.safeParse(parsed);
  return out.success ? out.data : null;
}
