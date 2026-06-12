import type { LLMCompletionRequest, LLMProvider } from "@addroid/llm-provider";
import {
  resolveAddroidLanguage,
  translateMessage,
  type AddroidLanguage,
  type AddroidMessageDictionary,
} from "@addroid/config";
import type { AgentContext } from "./context.js";
import {
  evaluateAgentToolPolicy,
  isDeniedAgentRequest,
  type AgentPolicyDecision,
} from "./policy.js";
import {
  isToolAllowedOnSurface,
  renderToolManifestForPrompt,
  type AgentSurface,
  type AgentToolName,
} from "./manifest.js";

export type { AgentSurface, AgentToolName } from "./manifest.js";

export type AgentCommandName =
  | "doctor"
  | "status"
  | "account"
  | "connect"
  | "schedule"
  | "report"
  | "submit"
  | "logs"
  | "stop"
  | "activate"
  | "backup";

export interface AgentToolCall {
  name: string;
  args?: Record<string, unknown>;
  why?: string;
}

export interface AgentResponse {
  message: string;
  toolResults: AgentToolResult[];
}

export interface AgentLoopExecution {
  display: string;
  status: string;
  message: string;
  data?: unknown;
}

export type AgentToolResult =
  | {
      status: "ready";
      tool: AgentToolName;
      command: AgentCommandName | null;
      args: string[];
      toolArgs: Record<string, unknown>;
      display: string;
      why: string;
    }
  | {
      status: "denied";
      toolName: string;
      reason: string;
    }
  | {
      status: "unsupported";
      toolName: string;
      reason: string;
    };

interface ChatAgentResponse {
  message?: string;
  tools?: AgentToolCall[];
}

export const SLASH_COMMANDS = [
  { command: "/help", description: "使い方と例を表示" },
  { command: "/status", description: "接続・起動状態を確認" },
  { command: "/report", description: "日次レポートを取得" },
  { command: "/submit", description: "入稿前チェックを実行" },
  { command: "/connect", description: "Meta / GitHub / AI / Slack を接続" },
  { command: "/account", description: "広告アカウントを確認・選択" },
  { command: "/schedule", description: "自動実行を確認・変更" },
  { command: "/open", description: "Web UI の URL を表示" },
  { command: "/stop", description: "Web UI と worker を停止" },
  { command: "/exit", description: "チャットを終了" },
] as const;

export async function runAgentTurn(opts: {
  input: string;
  provider: LLMProvider;
  agentContext: AgentContext;
  model?: string;
  purpose?: string;
  surface?: AgentSurface;
  language?: AddroidLanguage;
}): Promise<AgentResponse> {
  const language = opts.language ?? resolveAddroidLanguage();
  const requestPolicy = isDeniedAgentRequest(opts.input);
  if (!requestPolicy.allowed) {
    return {
      message: t(language, "policy.denied", { reason: requestPolicy.reason ?? "policy denied" }),
      toolResults: [],
    };
  }

  const response = await buildAgentResponseWithLlm(opts).catch((err) =>
    buildFallbackAgentResponse(opts.input, err, language)
  );

  const toolResults: AgentToolResult[] = [];
  const surface = opts.surface ?? "cli-chat";
  for (const rawTool of response.tools ?? []) {
    const normalized = normalizeToolCall(rawTool);
    const policy = evaluateAgentToolPolicy(normalized.name, normalized.args);
    if (!policy.allowed) {
      toolResults.push({
        status: "denied",
        toolName: normalized.name,
        reason: policy.reason ?? "policy denied",
      });
      continue;
    }
    if (!isToolAllowedOnSurface(normalized.name, surface)) {
      toolResults.push({
        status: "unsupported",
        toolName: normalized.name,
        reason: `tool is not available on ${surface}`,
      });
      continue;
    }
    const resolved = safeResolveTool(normalized);
    toolResults.push(resolved);
  }

  return {
    message: response.message ?? "",
    toolResults,
  };
}

export { evaluateAgentToolPolicy, isDeniedAgentRequest, type AgentPolicyDecision };

async function buildAgentResponseWithLlm(opts: {
  input: string;
  provider: LLMProvider;
  agentContext: AgentContext;
  model?: string;
  purpose?: string;
  surface?: AgentSurface;
  language?: AddroidLanguage;
}): Promise<ChatAgentResponse> {
  const language = opts.language ?? resolveAddroidLanguage();
  const req: LLMCompletionRequest = {
    ...(opts.model ? { model: opts.model } : {}),
    temperature: 0.2,
    maxOutputTokens: 1_500,
    purpose: opts.purpose ?? "agent:chat",
    messages: [
      {
        role: "system",
        content: buildAgentSystemPrompt(
          opts.agentContext,
          opts.surface ?? "cli-chat",
          language
        ),
      },
      {
        role: "user",
        content: opts.input,
      },
    ],
  };
  const res = await opts.provider.complete(req);
  return parseAgentResponse(res.content);
}

function buildFallbackAgentResponse(
  input: string,
  err: unknown,
  language: AddroidLanguage
): ChatAgentResponse {
  void input;
  const errorMessage = formatLlmFailure(err);
  return {
    message: t(language, "llm.failed", { error: errorMessage }),
    tools: [],
  };
}

function formatLlmFailure(err: unknown): string {
  const error = err as Error & { status?: number; code?: string };
  const status = typeof error.status === "number" ? ` HTTP ${error.status}` : "";
  const code = typeof error.code === "string" ? ` (${error.code})` : "";
  const message = error.message || String(err);
  return `${message}${status}${code}`;
}

export function buildAgentSystemPrompt(
  agentContext: AgentContext,
  surface: AgentSurface = "cli-chat",
  language: AddroidLanguage = resolveAddroidLanguage()
): string {
  const responseLanguage =
    language === "en"
      ? "Respond in English. Be concise and operational."
      : "Respond in Japanese. Be concise and operational.";
  const jsonSchema =
    language === "en"
      ? '{"message":"short English message","tools":[{"name":"get_report","args":{"kind":"daily"},"why":"short reason"}]}'
      : '{"message":"short Japanese message","tools":[{"name":"get_report","args":{"kind":"daily"},"why":"short reason"}]}';
  return [
    "You are AdDroid local agent.",
    responseLanguage,
    "You may answer normally when no tool is needed.",
    "When an AdDroid operation should run, return ONLY strict JSON with this schema:",
    jsonSchema,
    "Do not wrap JSON in markdown.",
    `Current surface: ${surface}`,
    "Available tools for this surface:",
    renderToolManifestForPrompt(surface, language),
    "Users may also type slash shortcuts such as /status, /report, /submit, /connect, /account, /schedule, and /open. Interpret those as normal user intent and choose the appropriate tool.",
    "Choose tools by user intent and recent chat context. Use get_report for user-facing daily, budget, and improvement reports because it returns the standard AdDroid summary/commentary format. Use metricDate as YYYY-MM-DD for explicit calendar dates and metricDateRelative for relative dates. Use query_meta_ads for raw read-only Meta Ads inspection, hierarchy lookup, and specific field/object checks. Treat read-only query results as internal evidence: in the final user-facing answer, mention only the facts needed for the user's request and do not dump unrelated rows, catalogs, or full object lists.",
    "Use query_performance for natural-language ranking questions such as top campaigns by spend, best CPA, or recent CTR. Use compare_performance for two-window changes. These tools are safe predefined aggregations; never invent SQL or ask for raw SQL. When reporting query_performance results, include the value, period, and target. If a result has lowSample=true, say サンプル不足のため参考値.",
    "Before asking the user for missing ad-operation details, decide whether the missing value is likely available through Meta Ads read-only data. If it is, autonomously run narrow query_meta_ads lookups first, such as get by known campaign/adset/ad/creative/page IDs or parent-filtered lists with small limits. Ask the user only after those read-only lookups cannot resolve the value or the choice is genuinely business context.",
    "You are allowed to inspect read-only data freely. When the user wants a one-time production mutation such as pause, activate, budget change, targeting change, create, update, or delete, never mutate Meta directly; use propose_ops_change to create a GitOps PR for human review. For common pause/activate/budget changes, pass targets + desiredChanges. For less common Meta mutations, pass propose_ops_change.operations as Graph manifest actions with kind and payload, not CLI args. Put official Meta Graph API snake_case fields that are not modeled as typed aliases under payload.graphPayload; graphPayload overrides aliases. Never include access_token or read-only fields such as id/account_id/created_time/updated_time/effective_status/configured_status/issues_info/recommendations. For budget changes, first inspect current Meta campaign/adset budget fields and pass an explicit target level. Campaign budgets and adset budgets are separate; if the requested object does not actually carry the budget, target the object that does or ask before creating a PR.",
    "When the user asks only to generate new creative ideas/images for the /creatives library, use generate_creatives and do not ask about campaign/adset placement, CTA, optimizationGoal, billingEvent, or Meta delivery settings because generation does not submit to Meta. If the user provides a landing page or destination URL for creative generation, pass it as linkUrl or destinationUrl; the generator may ask the LLM to inspect that URL and include the page context. When the user wants to submit or create a PR from existing /creatives item(s) or Creative ID(s), use promote_creative_submission so the stored image and stored Meta ad text are reused. If multiple Creative IDs are already selected, pass all selected IDs as creativeIds and ask only for missing submission settings, not which creative to use. When the user wants to generate, upload, or submit ad creative as an ad/campaign/adset or asks for a PR without an existing Creative ID, use propose_creative_submission for Graph API-backed submission. Always choose and pass placementMode: existing_adset, new_adset, or new_campaign. existing_adset requires campaignId+adsetId as the destination. new_adset requires campaignId as the parent plus adsetName+optimizationGoal+billingEvent. new_campaign requires campaignName+adsetName+objective+optimizationGoal+billingEvent and a budget; dailyBudget is campaign-level by default for new_campaign, while adsetDailyBudget is only for an explicit adset-level budget. If the user says to use the same settings as an existing/active campaign or adset while creating a new campaign, use the existing IDs only as inheritFromCampaignId/inheritFromAdsetId, never as campaignId/adsetId destinations. Budget and bid amounts are account-currency major units; for a JPY account, 500円/日は dailyBudget:500. Meta account sync and account listing include an asset readiness check; use those results to avoid asking non-engineers to find raw Page / Instagram IDs when the system can infer evidence from the ad account, page connection, adset promoted_object, or existing creative object_story_spec. Collect or infer pageId, body/title/link/description/CTA, instagramUserId, DCO arrays, optimizationGoal, optimizationSubEvent, billingEvent, bid strategy/amount, attributionSpec, destinationType, schedule, DSA/regulatory fields, pixel/custom event, ad tracking/conversion specs, targeting, and countries when relevant. Use campaignGraphPayload/adsetGraphPayload/creativeGraphPayload/adGraphPayload for official snake_case Graph fields without aliases; raw graph payload overrides aliases and must not include access_token/read-only fields. If images are attached as references for generation, pass them as referenceImagePaths and set generateImage:true for propose_creative_submission, or pass them as referenceImagePaths for generate_creatives. Use localMediaPaths only when the attached files themselves should be the final ad media. Ask concise clarification questions before calling propose_creative_submission or promote_creative_submission if placement, pageId, optimization/billing, budget, destination link, country targeting, or required copy is missing.",
    "For existing Creative ID submission requests with missing placement/page/Instagram/link info, especially phrases like 現在オンのキャンペーン配下 or 既存広告と同様, call resolve_creative_submission_context first. It performs the real-time Meta read-only lookup and returns suggestedPromotionArgs. Treat resolver campaignId/adsetId as existing destinations only when placementMode is existing_adset. If the user later says 新規キャンペーン or 新規広告セット, keep resolver IDs only as inheritFromCampaignId/inheritFromAdsetId and set placementMode accordingly. If resolver output is missing fields that Meta can plausibly provide, continue with narrow query_meta_ads follow-up lookups instead of immediately asking the user. If ready, ask the user to confirm the concise resolved facts; after confirmation, call promote_creative_submission with suggestedPromotionArgs plus the explicit placementMode instead of repeating broad inspection.",
    surface === "scheduled-agent"
      ? "When the saved task asks for conditional ad operations, inspect current performance data first. If a production mutation is needed, create a GitOps PR unless the saved task carries an explicit auto-execute policy that allows a narrow safe operation."
      : "When the user asks for recurring or conditional production ad automation, use propose_automation_rule, not create_scheduled_agent_task. Ask concise clarification questions if schedule, lookback window, decision timing, target scope, action, approval mode, or limits are ambiguous. The automation rule PR is the approval request; after merge, the rule schedule is registered internally.",
    "Meta read-only data comes from Graph API and Mirror DB. For hierarchy detail, prefer narrow ID-filtered or parent-filtered reads and use limits when a broad list is unavoidable.",
    "For performance analysis, request the fields needed for the user's question. For frequency ask for frequency. For CPA/CV/conversion checks request spend plus actions and, when useful, cost_per_action_type/action_values. Do not rely on display text for automation decisions; tool executors keep raw structured rows.",
    "Chat must not mutate Meta directly. Use check_submission for dry-run review when a local ops repo change already exists, and use propose_ops_change for production changes. For raw operations, include Graph action objects with kind and payload.",
    "When a tool result says dry-run failed and includes cause/detail lines, report those concrete lines to the user. Do not replace them with guesses unless the detail explicitly says that.",
    "Never request arbitrary shell, restore, destructive git, direct DB writes, direct Meta mutation outside audited paths, or secret display.",
    "Actual ad submission must go through ops repo validation, dry-run plan, GitHub PR review/merge, and worker apply.",
    "For recurring read-only scheduled tasks, keep flexibility: interpret the saved natural-language task at runtime and choose tools based on current state. For production automation rules, rely on the structured rule DSL and do not invent cadence, lookback windows, target scope, approval mode, or limits when the user left them ambiguous.",
    "Agent context:",
    agentContext.content,
  ].join("\n");
}

const MESSAGES: AddroidMessageDictionary = {
  ja: {
    "policy.denied":
      "その操作は安全ポリシーにより実行できません: {reason}\nAdDroid では validate / dry-run / GitHub PR / worker apply の経路を使ってください。",
    "llm.failed":
      "LLM による解釈に失敗したため、操作は実行しませんでした: {error}\n少し待って同じ内容をもう一度送るか、接続状態を確認してください。",
  },
  en: {
    "policy.denied":
      "That operation cannot be executed because of the safety policy: {reason}\nUse AdDroid's validate / dry-run / GitHub PR / worker apply path instead.",
    "llm.failed":
      "AdDroid did not run an operation because LLM interpretation failed: {error}\nPlease try the same request again in a moment, or check the connection status.",
  },
};

function t(
  language: AddroidLanguage,
  key: string,
  values?: Record<string, string | number | null | undefined>
): string {
  return translateMessage(MESSAGES, language, key, values);
}

export function buildAgentLoopInput(
  originalInput: string,
  executions: readonly AgentLoopExecution[]
): string {
  if (executions.length === 0) return originalInput;
  return [
    "Original user request:",
    originalInput,
    "",
    "Tool results already executed in this turn:",
    ...executions.map((item, index) => {
      const data = item.data === undefined ? "" : ` data=${truncateLoopJson(item.data, 1_200)}`;
      return `${index + 1}. ${item.display}: status=${item.status}; message=${truncateLoopText(item.message, 1_200)}${data}`;
    }),
    "",
    "Continue from these results. If enough information has been gathered, answer the user normally with no tools. If more work is necessary, return strict JSON with only additional tools. Do not repeat a successful tool call that appears above.",
  ].join("\n");
}

function parseAgentResponse(content: string): ChatAgentResponse {
  const trimmed = content.trim();
  const jsonText = tryExtractJsonObject(trimmed);
  if (!jsonText) return { message: trimmed, tools: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return { message: trimmed, tools: [] };
  }
  if (!isRecord(parsed)) return { message: trimmed, tools: [] };
  const message = typeof parsed.message === "string" ? parsed.message : "";
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.flatMap((t) => (isRecord(t) ? [toolFromRecord(t)] : []))
    : [];
  return { message, tools };
}

function tryExtractJsonObject(text: string): string | null {
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function toolFromRecord(record: Record<string, unknown>): AgentToolCall {
  const args = isRecord(record.args) ? record.args : {};
  return {
    name: String(record.name ?? ""),
    args,
    why: typeof record.why === "string" ? record.why : "",
  };
}

function normalizeToolCall(tool: AgentToolCall): Required<AgentToolCall> {
  return {
    name: tool.name.trim(),
    args: sanitizeToolArgs(tool.args ?? {}),
    why: tool.why ?? "",
  };
}

function sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const sanitized = sanitizeToolValue(value, 0);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function sanitizeToolValue(value: unknown, depth: number): unknown {
  if (depth > 12) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeToolValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(k)) continue;
      const sanitized = sanitizeToolValue(v, depth + 1);
      if (sanitized !== undefined) out[k] = sanitized;
    }
    return out;
  }
  return undefined;
}

function safeResolveTool(tool: Required<AgentToolCall>): AgentToolResult {
  try {
    const resolved = resolveTool(tool);
    if (!resolved) {
      return {
        status: "unsupported",
        toolName: tool.name,
        reason: "unsupported tool",
      };
    }
    return { status: "ready", ...resolved };
  } catch (err) {
    return {
      status: "unsupported",
      toolName: tool.name,
      reason: (err as Error).message,
    };
  }
}

function resolveTool(
  tool: Required<AgentToolCall>
): Omit<Extract<AgentToolResult, { status: "ready" }>, "status"> | null {
  const name = normalizeToolName(tool.name);
  switch (name) {
    case "diagnose":
      return commandTool(name, "doctor", [], tool.args, tool.why);
    case "check_status":
      return commandTool(name, "status", [], tool.args, tool.why);
    case "list_ad_accounts":
      return commandTool(name, "account", boolArgs([], tool.args, ["json"]), tool.args, tool.why);
    case "sync_ad_accounts":
      return commandTool(
        name,
        "account",
        boolArgs(["sync"], tool.args, ["selectDefault", "json"], {
          selectDefault: "--select-default",
        }),
        tool.args,
        tool.why
      );
    case "select_ad_account":
      return commandTool(name, "account", buildSelectAccountArgs(tool.args), tool.args, tool.why);
    case "connect_service":
      return commandTool(name, "connect", buildConnectArgs(tool.args), tool.args, tool.why);
    case "get_report":
      return commandTool(name, "report", buildReportArgs(tool.args), tool.args, tool.why);
    case "check_submission":
      return commandTool(name, "submit", buildSubmitArgs(tool.args), tool.args, tool.why);
    case "create_scheduled_agent_task":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "create scheduled Agent task",
        why: tool.why,
      };
    case "set_schedule_enabled":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "set preset schedule",
        why: tool.why,
      };
    case "configure_budget_guard":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "configure budget guard",
        why: tool.why,
      };
    case "manage_schedule":
      return commandTool(name, "schedule", buildScheduleArgs(tool.args), tool.args, tool.why);
    case "show_logs":
      return commandTool(name, "logs", buildLogsArgs(tool.args), tool.args, tool.why);
    case "stop_services":
      return commandTool(name, "stop", [], tool.args, tool.why);
    case "start_delivery":
      return commandTool(name, "activate", buildActivateArgs(tool.args), tool.args, tool.why);
    case "propose_ops_change":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "create GitOps proposal PR",
        why: tool.why,
      };
    case "decide_approval":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "decide approval",
        why: tool.why,
      };
    case "propose_creative_submission":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "create creative submission PR",
        why: tool.why,
      };
    case "generate_creatives":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "generate creative variants",
        why: tool.why,
      };
    case "resolve_creative_submission_context":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "resolve creative submission context",
        why: tool.why,
      };
    case "promote_creative_submission":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "promote creative to submission PR",
        why: tool.why,
      };
    case "propose_automation_rule":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "create automation rule PR",
        why: tool.why,
      };
    case "propose_automation_rule_update":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "create automation rule recalibration PR",
        why: tool.why,
      };
    case "backup_data":
      return commandTool(name, "backup", [], tool.args, tool.why);
    case "open_web_ui":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "open Web UI",
        why: tool.why,
      };
    case "query_meta_ads":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "Meta Graph read-only query",
        why: tool.why,
      };
    case "query_performance":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "performance query",
        why: tool.why,
      };
    case "compare_performance":
      return {
        tool: name,
        command: null,
        args: [],
        toolArgs: tool.args,
        display: "performance comparison",
        why: tool.why,
      };
    default:
      return null;
  }
}

function commandTool(
  tool: AgentToolName,
  command: AgentCommandName,
  args: string[],
  toolArgs: Record<string, unknown>,
  why: string
): Omit<Extract<AgentToolResult, { status: "ready" }>, "status"> {
  if (args.some(hasUnsafeShellChars)) {
    throw new Error(`unsafe characters in ${tool} args`);
  }
  return {
    tool,
    command,
    args,
    toolArgs,
    display: `addroid ${command}${args.length ? ` ${args.join(" ")}` : ""}`,
    why,
  };
}

function buildSelectAccountArgs(args: Record<string, unknown>): string[] {
  const out = boolArgs(["choose", "--yes"], args, ["json"]);
  pushOptionalString(out, "--ad-account-id", args, "adAccountId");
  pushOptionalString(out, "--key", args, "key");
  return out;
}

function buildConnectArgs(args: Record<string, unknown>): string[] {
  const service = requireEnum(args, "service", ["meta", "github", "ai", "slack"]);
  const out: string[] = [service];
  if (service === "ai") {
    const aiProvider = optionalEnum(args, "aiProvider", ["codex", "openai", "anthropic"]);
    if (aiProvider) out.push("--provider", aiProvider);
  }
  return out;
}

function buildReportArgs(args: Record<string, unknown>): string[] {
  const kind = optionalEnum(args, "kind", ["daily", "budget", "improvement"]);
  const out = kind ? [kind] : [];
  pushOptionalString(out, "--metric-date", args, "metricDate");
  pushOptionalString(out, "--metric-date-relative", args, "metricDateRelative");
  return out;
}

function buildSubmitArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  pushOptionalString(out, "--root", args, "root");
  pushOptionalString(out, "--base", args, "base");
  pushOptionalString(out, "--account", args, "account");
  if (args.save === true) out.push("--save");
  return out;
}

function buildScheduleArgs(args: Record<string, unknown>): string[] {
  const action = requireEnum(args, "action", ["list", "run", "logs"]);
  const out: string[] = [action];
  if (action !== "list") {
    out.push(requireEnum(args, "preset", ["daily", "today", "improvement", "github", "retention"]));
  }
  const limit = optionalPositiveInt(args, "limit");
  if (limit !== null) out.push("--limit", String(limit));
  return out;
}

function buildLogsArgs(args: Record<string, unknown>): string[] {
  const target = optionalEnum(args, "target", ["up", "web", "worker", "all"]);
  const out: string[] = target ? [target] : [];
  const lines = optionalPositiveInt(args, "lines");
  if (lines !== null) out.push("--lines", String(lines));
  return out;
}

function buildActivateArgs(args: Record<string, unknown>): string[] {
  const out = [requireString(args, "hierarchyId")];
  pushOptionalString(out, "--note", args, "note");
  if (args.json === true) out.push("--json");
  return out;
}

function boolArgs(
  base: string[],
  args: Record<string, unknown>,
  keys: string[],
  aliases: Record<string, string> = {}
): string[] {
  const out = [...base];
  for (const key of keys) {
    if (args[key] === true) out.push(aliases[key] ?? `--${kebab(key)}`);
  }
  return out;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: T[]
): T {
  const value = requireString(args, key);
  if (!values.includes(value as T)) {
    throw new Error(`${key} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: T[]
): T | null {
  const value = args[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function optionalPositiveInt(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return Math.floor(n);
}

function pushOptionalString(
  out: string[],
  flag: string,
  args: Record<string, unknown>,
  key: string
): void {
  const value = args[key];
  if (typeof value === "string" && value.trim() !== "") {
    out.push(flag, value.trim());
  }
}

function hasUnsafeShellChars(value: string): boolean {
  return /[;&|`$<>]/.test(value);
}

function normalizeToolName(value: string): AgentToolName {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_") as AgentToolName;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateLoopText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`;
}

function truncateLoopJson(value: unknown, max: number): string {
  try {
    return truncateLoopText(JSON.stringify(value), max);
  } catch {
    return "[unserializable]";
  }
}
