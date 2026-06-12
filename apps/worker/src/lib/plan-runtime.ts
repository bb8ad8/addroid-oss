// AdDroid OSS — dry-run / plan layer の共有境界.
//
// CLI (`addroid plan --dry-run`) / Web UI (`/api/plan`) / 将来の CI workflow が
// 同じ pure 関数を呼び、同じ persistence boundary 経由で `execution_logs` に
// 履歴を残せるようにする。
//
//   - runPlanForRoot(input) — ops repo の operations/*.json を読み、
//     UI/CLI が必要とする per-account サマリと findings を 1 つの構造体で返す。
//     I/O はファイルシステム + JSON パースのみ (Prisma / network 不使用)。
//   - createPrismaPlanStore(prisma) — Prisma を裏に持つ PlanRunStore を返す。
//     テストでは PlanRunStore を fake で差し替えられる。
//   - persistPlanRun(store, input) — runPlanForRoot の結果を 1 行の
//     ExecutionLog に書き込む。kind="plan", level は overall risk 由来。
//
// 注: Activate と異なり、plan は audit_logs に書かない (acceptance には
//     PR merge / Apply / Activate のみ列挙されている)。診断目的の history は
//     execution_logs で十分。

import { Prisma, type PrismaClient } from "@addroid/db";
import fs from "node:fs";
import path from "node:path";
import { isSupportedMetaCliOperation } from "@addroid/meta-adapter";
import {
  loadSubmissionGuardsPolicy,
  type SubmissionGuardsYaml,
} from "@addroid/ops-schemas";
import { isManagedStorageKey } from "./storage-key-validation.js";
export type PlanRunSource =
  | "web"
  | "web-chat"
  | "slack-chat"
  | "agent-task"
  | "ci"
  | "cli";

export interface PlanCounts {
  creates: number;
  updates: number;
  deletes: number;
  errors: number;
  warnings: number;
}

export type PlanRiskLevel = "ok" | "warn" | "error";

export interface ValidationFinding {
  file: string;
  message: string;
  pointer?: string;
}

export interface PlanFinding {
  level: "info" | "warning" | "error";
  message: string;
  pointer?: string;
}

export interface OperationPlanAction {
  kind: "meta_cli_operation" | "graph_operation";
  account: string;
  resource: string;
  verb: string;
  args: string[];
  graphKind?: string;
  ref?: string;
  payload?: Record<string, unknown>;
}

export interface PerAccountPlanSummary {
  account: string;
  actions: OperationPlanAction[];
  findings: PlanFinding[];
  counts: PlanCounts;
  risk: PlanRiskLevel;
}

export interface PlanRunOutput {
  /** ok = validation も plan-level findings も error が無い (= apply 安全) */
  ok: boolean;
  durationMs: number;
  /** ops repo / file 単位の Zod / 整合性 error。account を持たない repo-wide エラー。 */
  validationErrors: ValidationFinding[];
  validationWarnings: ValidationFinding[];
  /** account 単位の plan サマリ。filter 指定があれば 1 件、無指定なら全 operation manifest 件。 */
  perAccount: PerAccountPlanSummary[];
  /** 集計値 (UI 表示用に precomputed)。 */
  totalCounts: PlanCounts;
  /** overall risk: validation error or perAccount.risk=error が 1 つでもあれば "error"。 */
  risk: PlanRiskLevel;
}

export interface PlanRunInput {
  rootDir: string;
  /** 互換引数。operation manifest 経路では参照しない。 */
  baseDir?: string | null;
  /** 指定すると、その accountKey の operation manifest のみ plan 結果に含める。 */
  accountFilter?: string | null;
}

const DEFAULT_SUBMISSION_GUARDS_POLICY: SubmissionGuardsYaml = {
  version: 1,
  guards: {
    budgetIncrease: {
      warnOverRatio: 2,
      blockOverRatio: 5,
    },
  },
};

/**
 * Ops repo を読み、operations/*.json を per-account にまとめ、UI/CLI 用の
 * `PlanRunOutput` を返す。
 *
 * - validation 失敗時も throw しない。`ok=false`, `validationErrors` を埋めて返す。
 * - 1 つでも plan-level error finding があれば、その account の `risk="error"`
 *   かつ overall `ok=false`。
 * - account_filter が指定された場合、validation には全件参加させたうえで
 *   結果の `perAccount` を該当 1 件に絞る (= 他 account のエラーで全体が壊れる
 *   ことを避け、UI の「この account だけ確認したい」要求を満たす)。
 */
export function runPlanForRoot(input: PlanRunInput): PlanRunOutput {
  const startedAt = Date.now();
  const perAccount: PerAccountPlanSummary[] = [];
  const accumulatedErrors: ValidationFinding[] = [];
  const accumulatedWarnings: ValidationFinding[] = [];
  const grouped = new Map<
    string,
    { actions: OperationPlanAction[]; findings: PlanFinding[] }
  >();
  const submissionGuards =
    loadSubmissionGuardsPolicy(input.rootDir) ??
    DEFAULT_SUBMISSION_GUARDS_POLICY;
  for (const file of findOperationFiles(input.rootDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        fs.readFileSync(path.join(input.rootDir, file), "utf8"),
      );
    } catch (err) {
      accumulatedErrors.push({
        file,
        message: `operation manifest JSON を読めません: ${(err as Error).message}`,
      });
      continue;
    }
    const normalized = normalizeOperationManifest(file, parsed);
    accumulatedErrors.push(...normalized.errors);
    accumulatedWarnings.push(...normalized.warnings);
    if (
      !normalized.accountKey ||
      (input.accountFilter && normalized.accountKey !== input.accountFilter)
    )
      continue;
    const current = grouped.get(normalized.accountKey) ?? {
      actions: [],
      findings: [],
    };
    current.actions.push(...normalized.actions);
    current.findings.push(...normalized.findings);
    const guardFindings = evaluateSubmissionGuards({
      file,
      accountKey: normalized.accountKey,
      actions: normalized.actions,
      policy: submissionGuards,
    });
    accumulatedErrors.push(...guardFindings.errors);
    accumulatedWarnings.push(...guardFindings.warnings);
    current.findings.push(...guardFindings.findings);
    grouped.set(normalized.accountKey, current);
  }

  for (const [account, group] of grouped.entries()) {
    const counts = countActions(group.actions, group.findings);
    const risk: PlanRiskLevel =
      counts.errors > 0 ? "error" : counts.warnings > 0 ? "warn" : "ok";
    perAccount.push({
      account,
      actions: group.actions,
      findings: group.findings,
      counts,
      risk,
    });
  }

  const totalCounts: PlanCounts = perAccount.reduce<PlanCounts>(
    (acc, p) => ({
      creates: acc.creates + p.counts.creates,
      updates: acc.updates + p.counts.updates,
      deletes: acc.deletes + p.counts.deletes,
      errors: acc.errors + p.counts.errors,
      warnings: acc.warnings + p.counts.warnings,
    }),
    { creates: 0, updates: 0, deletes: 0, errors: 0, warnings: 0 },
  );

  const ok =
    accumulatedErrors.length === 0 &&
    perAccount.every((p) => p.counts.errors === 0);
  const risk: PlanRiskLevel = !ok
    ? "error"
    : accumulatedWarnings.length > 0 ||
        perAccount.some((p) => p.counts.warnings > 0)
      ? "warn"
      : "ok";

  return {
    ok,
    durationMs: Date.now() - startedAt,
    validationErrors: accumulatedErrors,
    validationWarnings: accumulatedWarnings,
    perAccount,
    totalCounts,
    risk,
  };
}

function evaluateSubmissionGuards(input: {
  file: string;
  accountKey: string;
  actions: OperationPlanAction[];
  policy: SubmissionGuardsYaml;
}): {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  findings: PlanFinding[];
} {
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const findings: PlanFinding[] = [];
  const budgetPolicy = input.policy.guards.budgetIncrease;
  for (let i = 0; i < input.actions.length; i += 1) {
    const action = input.actions[i]!;
    const pointer = `/actions/${i}`;
    const budgetChecks = budgetIncreaseChecks(action);
    for (const check of budgetChecks) {
      if (check.previous === null) {
        continue;
      }
      if (check.previous <= 0) continue;
      const ratio = check.next / check.previous;
      if (!Number.isFinite(ratio) || ratio < 1) continue;
      const summary = `${check.label} ${formatBudgetNumber(check.previous)} -> ${formatBudgetNumber(check.next)} (${formatRatio(ratio)})`;
      if (ratio >= budgetPolicy.blockOverRatio) {
        const message = `予算増加ガード: ${summary} はブロックライン ${formatRatio(budgetPolicy.blockOverRatio)} 以上です。`;
        errors.push({ file: input.file, pointer, message });
        findings.push({ level: "error", pointer, message });
      } else if (ratio >= budgetPolicy.warnOverRatio) {
        const message = `予算増加ガード: ${summary} は警告ライン ${formatRatio(budgetPolicy.warnOverRatio)} 以上です。`;
        warnings.push({ file: input.file, pointer, message });
        findings.push({ level: "warning", pointer, message });
      }
    }
  }
  return { errors, warnings, findings };
}

interface BudgetIncreaseCheck {
  label: string;
  previous: number | null;
  next: number;
}

function budgetIncreaseChecks(
  action: OperationPlanAction,
): BudgetIncreaseCheck[] {
  const out: BudgetIncreaseCheck[] = [];
  if (action.kind !== "graph_operation" || !action.payload) return out;
  if (action.verb !== "update") return out;
  if (action.resource !== "campaign" && action.resource !== "adset") return out;
  const payload = action.payload;
  const graphPayload = isRecord(payload.graphPayload)
    ? payload.graphPayload
    : {};
  const guardContext = isRecord(payload.guardContext)
    ? payload.guardContext
    : {};
  const dailyNext =
    readFiniteNumber(payload.dailyBudget) ??
    readFiniteNumber(graphPayload.daily_budget);
  if (dailyNext !== null) {
    out.push({
      label: `${action.resource}.dailyBudget`,
      previous:
        readFiniteNumber(guardContext.currentDailyBudget) ??
        readFiniteNumber(payload.currentDailyBudget) ??
        readFiniteNumber(payload.previousDailyBudget) ??
        readNestedNumber(payload, ["budgetBefore", "dailyBudget"]) ??
        readNestedNumber(payload, ["currentBudget", "dailyBudget"]),
      next: dailyNext,
    });
  }
  const lifetimeNext =
    readFiniteNumber(payload.lifetimeBudget) ??
    readFiniteNumber(graphPayload.lifetime_budget);
  if (lifetimeNext !== null) {
    out.push({
      label: `${action.resource}.lifetimeBudget`,
      previous:
        readFiniteNumber(guardContext.currentLifetimeBudget) ??
        readFiniteNumber(payload.currentLifetimeBudget) ??
        readFiniteNumber(payload.previousLifetimeBudget) ??
        readNestedNumber(payload, ["budgetBefore", "lifetimeBudget"]) ??
        readNestedNumber(payload, ["currentBudget", "lifetimeBudget"]),
      next: lifetimeNext,
    });
  }
  return out;
}

function readNestedNumber(
  root: Record<string, unknown>,
  pathParts: string[],
): number | null {
  let current: unknown = root;
  for (const part of pathParts) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return readFiniteNumber(current);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatRatio(value: number): string {
  return `${Number(value.toFixed(2))}x`;
}

function formatBudgetNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)));
}

function countActions(
  actions: readonly OperationPlanAction[],
  findings: readonly PlanFinding[],
): PlanCounts {
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  for (const a of actions) {
    if (a.verb === "create") creates += 1;
    else if (
      a.verb === "update" ||
      a.verb === "connect" ||
      a.verb === "disconnect" ||
      a.verb === "assign-user"
    )
      updates += 1;
    else if (a.verb === "delete" || a.verb === "status_delete") deletes += 1;
  }
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.level === "error") errors += 1;
    else if (f.level === "warning") warnings += 1;
  }
  return { creates, updates, deletes, errors, warnings };
}

function findOperationFiles(rootDir: string): string[] {
  const operationsDir = path.join(rootDir, "operations");
  if (!fs.existsSync(operationsDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(path.relative(rootDir, abs).replace(/\\/g, "/"));
      }
    }
  };
  walk(operationsDir);
  return out.sort();
}

function normalizeOperationManifest(
  file: string,
  value: unknown,
): {
  accountKey: string | null;
  actions: OperationPlanAction[];
  findings: PlanFinding[];
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
} {
  if (!isRecord(value)) {
    return {
      accountKey: null,
      actions: [],
      findings: [],
      errors: [{ file, message: "operation manifest must be an object" }],
      warnings: [],
    };
  }
  const accountKey = readString(value.accountKey);
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const findings: PlanFinding[] = [];
  const actions: OperationPlanAction[] = [];
  if (!accountKey) errors.push({ file, message: "accountKey is required" });
  const rawActions = Array.isArray(value.actions) ? value.actions : [];
  if (rawActions.length === 0)
    errors.push({ file, message: "actions[] is required" });
  const version = value.version === 2 ? 2 : 1;
  rawActions.forEach((raw, index) => {
    const pointer = `/actions/${index}`;
    if (!isRecord(raw)) {
      errors.push({
        file,
        pointer,
        message: "operation action must be an object",
      });
      return;
    }
    if (version === 2) {
      const kind = readString(raw.kind);
      if (!kind || !isSupportedGraphOperationKind(kind)) {
        const message = `unsupported Graph operation kind: ${kind ?? "(missing)"}`;
        errors.push({ file, pointer, message });
        findings.push({ level: "error", pointer, message });
        return;
      }
      const payload = isRecord(raw.payload) ? raw.payload : {};
      const [resource, verb] = kind.split(".");
      if (!resource || !verb) {
        const message = `invalid Graph operation kind: ${kind}`;
        errors.push({ file, pointer, message });
        findings.push({ level: "error", pointer, message });
        return;
      }
      const graphPayload = isRecord(payload.graphPayload)
        ? payload.graphPayload
        : {};
      const status = (
        readString(payload.status) ?? readString(graphPayload.status)
      )?.toUpperCase();
      if (verb === "create" && status === "ACTIVE") {
        const message =
          "apply phase cannot create ACTIVE Meta objects; use PAUSED then audited activate flow";
        errors.push({ file, pointer, message });
        findings.push({ level: "error", pointer, message });
        return;
      }
      const storageKey = readString(payload.storageKey);
      if (storageKey && !isManagedStorageKey(storageKey)) {
        const message =
          "storageKey must be a managed AdDroid storage key; local file paths must be imported before creating an ops PR";
        errors.push({ file, pointer, message });
        findings.push({ level: "error", pointer, message });
        return;
      }
      const carouselError = validateCarouselCreativePayload(payload, raw);
      if (carouselError) {
        errors.push({ file, pointer, message: carouselError });
        findings.push({ level: "error", pointer, message: carouselError });
        return;
      }
      actions.push({
        kind: "graph_operation",
        account: accountKey ?? "",
        resource,
        verb,
        args: [],
        graphKind: kind,
        ref: readString(raw.ref) ?? undefined,
        payload,
      });
      return;
    }
    const resource = readString(raw.resource);
    const verb = readString(raw.verb);
    const args = Array.isArray(raw.args)
      ? raw.args.filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
      : [];
    if (!resource || !verb || args.length === 0) {
      errors.push({
        file,
        pointer,
        message: "operation action requires resource, verb and args[]",
      });
      return;
    }
    const support = isSupportedMetaCliOperation(args);
    if (!support.supported) {
      const message = `unsupported legacy operation: ${resource}:${verb}`;
      errors.push({ file, pointer, message });
      findings.push({ level: "error", pointer, message });
      return;
    }
    const invalidStorageFlag = findInvalidStorageFlag(args);
    if (invalidStorageFlag) {
      const message = `${invalidStorageFlag.flag} must be a managed AdDroid storage key; local file paths must be imported before creating an ops PR`;
      errors.push({ file, pointer, message });
      findings.push({ level: "error", pointer, message });
      return;
    }
    actions.push({
      kind: "meta_cli_operation",
      account: accountKey ?? "",
      resource,
      verb,
      args,
    });
  });
  return { accountKey, actions, findings, errors, warnings };
}

const GRAPH_OPERATION_KINDS = new Set([
  "campaign.create",
  "campaign.update",
  "campaign.delete",
  "campaign.status",
  "adset.create",
  "adset.update",
  "adset.delete",
  "adset.status",
  "creative.create",
  "creative.update",
  "creative.delete",
  "ad.create",
  "ad.update",
  "ad.delete",
  "ad.status",
]);

function isSupportedGraphOperationKind(kind: string): boolean {
  return GRAPH_OPERATION_KINDS.has(kind);
}

function validateCarouselCreativePayload(
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
): string | null {
  const creative = isRecord(payload.creative)
    ? payload.creative
    : isRecord(raw.creative)
      ? raw.creative
      : null;
  const mediaType =
    readString(payload.mediaType)?.toLowerCase() ??
    readString(payload.type)?.toLowerCase();
  const isCarousel =
    mediaType === "carousel" ||
    readString(creative?.type)?.toLowerCase() === "carousel";
  if (!isCarousel) return null;
  const cards = Array.isArray(payload.cards)
    ? payload.cards
    : Array.isArray(creative?.cards)
      ? creative.cards
      : [];
  if (cards.length < 2 || cards.length > 10) {
    return "carousel creative requires 2-10 cards";
  }
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    if (!isRecord(card)) return `carousel card ${i + 1} must be an object`;
    const storageKey =
      readString(card.storageKey) ??
      readString(card.storage_key) ??
      storageKeyFromStorageRef(
        readString(card.storageRef) ?? readString(card.storage_ref),
      );
    if (!storageKey)
      return `carousel card ${i + 1} requires storage_ref or storageKey`;
    if (!isManagedStorageKey(storageKey)) {
      return "carousel card storage_ref must be a managed AdDroid storage key";
    }
    if (!readString(card.headline))
      return `carousel card ${i + 1} requires headline`;
  }
  return null;
}

function storageKeyFromStorageRef(value: string | null): string | null {
  if (!value) return null;
  const prefix = "storage://";
  return value.startsWith(prefix)
    ? readString(value.slice(prefix.length))
    : value;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findInvalidStorageFlag(
  args: readonly string[],
): { flag: string; value: string } | null {
  for (const flag of ["--image", "--video", "--images", "--videos"]) {
    for (let i = 0; i < args.length - 1; i += 1) {
      if (args[i] !== flag) continue;
      const value = readString(args[i + 1]);
      if (value && !isManagedStorageKey(value)) return { flag, value };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------
// Persistence boundary
// ---------------------------------------------------------------------

/**
 * `execution_logs.payload` に書き込まれる plan 履歴 1 行分の JSON 構造。
 * /plans ページの DataTable / PlanPreview はこの形を想定して描画する。
 */
export interface PlanRunPayloadJson {
  source: PlanRunSource;
  triggeredBy: string;
  rootDir: string;
  baseDir: string | null;
  accountFilter: string | null;
  ok: boolean;
  risk: PlanRiskLevel;
  durationMs: number;
  totalCounts: PlanCounts;
  validationErrors: ValidationFinding[];
  validationWarnings: ValidationFinding[];
  perAccount: PerAccountPlanSummary[];
}

export interface RecordPlanExecutionLogInput {
  workspaceId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  payload: PlanRunPayloadJson;
}

export interface PlanRunStore {
  recordPlanExecutionLog(
    input: RecordPlanExecutionLogInput,
  ): Promise<{ id: string }>;
}

export function createPrismaPlanStore(prisma: PrismaClient): PlanRunStore {
  return {
    async recordPlanExecutionLog(input) {
      const row = await prisma.executionLog.create({
        data: {
          workspaceId: input.workspaceId ?? null,
          kind: "plan",
          refType: null,
          refId: null,
          level: input.level,
          message: input.message,
          payload: input.payload as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { id: row.id };
    },
  };
}

export interface PersistPlanRunInput {
  store: PlanRunStore;
  workspaceId: string | null;
  source: PlanRunSource;
  triggeredBy: string;
  rootDir: string;
  baseDir?: string | null;
  accountFilter?: string | null;
  result: PlanRunOutput;
}

/**
 * runPlanForRoot の結果を 1 行の ExecutionLog として保存する。
 * level は overall risk から決め、message は人間可読な短いサマリ。
 */
export async function persistPlanRun(
  input: PersistPlanRunInput,
): Promise<{ id: string }> {
  const { result } = input;
  const level: "info" | "warn" | "error" =
    result.risk === "error"
      ? "error"
      : result.risk === "warn"
        ? "warn"
        : "info";
  const message = formatSummaryMessage(
    input.source,
    result,
    input.accountFilter ?? null,
  );
  const payload: PlanRunPayloadJson = {
    source: input.source,
    triggeredBy: input.triggeredBy,
    rootDir: input.rootDir,
    baseDir: input.baseDir ?? null,
    accountFilter: input.accountFilter ?? null,
    ok: result.ok,
    risk: result.risk,
    durationMs: result.durationMs,
    totalCounts: result.totalCounts,
    validationErrors: result.validationErrors,
    validationWarnings: result.validationWarnings,
    perAccount: result.perAccount,
  };
  return input.store.recordPlanExecutionLog({
    workspaceId: input.workspaceId,
    level,
    message,
    payload,
  });
}

function formatSummaryMessage(
  source: PlanRunSource,
  result: PlanRunOutput,
  accountFilter: string | null,
): string {
  const scope =
    accountFilter !== null
      ? `account=${accountFilter}`
      : `accounts=${result.perAccount.length}`;
  const counts = result.totalCounts;
  const summary = `+${counts.creates} ~${counts.updates} -${counts.deletes}`;
  if (!result.ok) {
    return `plan failed [source=${source}, ${scope}] ${summary} errors=${counts.errors + result.validationErrors.length}`;
  }
  if (result.risk === "warn") {
    return `plan ok with warnings [source=${source}, ${scope}] ${summary} warnings=${counts.warnings + result.validationWarnings.length}`;
  }
  return `plan ok [source=${source}, ${scope}] ${summary}`;
}
