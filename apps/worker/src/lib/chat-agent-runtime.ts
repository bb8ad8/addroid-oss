// AdDroid OSS — transport非依存の対話 Agent コア (Slack / Discord 共有)。
//
// `slack-agent-runtime.ts` が担っていた Agent ループ本体 (4 ターン上限 / tool 重複抑止 /
// executeWorkerAgentTool 実行 / 返信整形 / audit_logs 1 行) をここに抽出し、transport
// 固有部 (処理中メッセージ投稿・最終投稿・添付画像のダウンロード・actor/surface/audit
// 命名) だけを {@link ChatAgentTransport} として差し込めるようにした。
//
// Slack 経路は本コアを呼ぶ薄いアダプタ (`slack-agent-runtime.ts`) に置き換わるが、ユーザー
// に見えるメッセージ文字列・挙動は完全に維持する。Discord 経路 (`discord-agent-runtime.ts`)
// も同じコアを通る。

import {
  buildAgentContext,
  buildAgentLoopInput,
  runAgentTurn,
  type AgentSurface,
  type AgentToolResult,
} from "@addroid/agent-runtime";
import {
  readAddroidConfig,
  resolveAddroidLanguage,
  type AddroidLanguage,
} from "@addroid/config";
import { Prisma, type PrismaClient } from "@addroid/db";
import type { GithubAdapter } from "@addroid/github-adapter";
import type { LLMProvider } from "@addroid/llm-provider";
import path from "node:path";
import type PgBoss from "pg-boss";
import { sanitizeText } from "@addroid/queue";
import { executeWorkerAgentTool } from "./agent-task-runtime.js";
import type { PlanRunSource } from "./plan-runtime.js";

export interface ChatAgentLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ChatAgentExecution {
  display: string;
  status: string;
  message: string;
  data?: unknown;
}

/** Agent コアが必要とするプロセス境界 (Slack / Discord で共通)。 */
export interface ChatAgentCoreDeps {
  prisma: PrismaClient;
  workspaceId: string;
  provider: LLMProvider;
  boss: PgBoss;
  githubAdapter?: GithubAdapter;
  webUrl?: string;
  logger?: ChatAgentLogger;
}

/** transport 固有の送受信 + 帰属情報。 */
export interface ChatAgentTransport {
  /** ユーザー入力テキスト。 */
  inputText: string;
  /** `slack:<id>` / `discord:<id>` 等。audit_logs.actor と executeWorkerAgentTool に渡す。 */
  actor: string;
  /** Agent surface (tool 許可判定に使う)。 */
  surface: AgentSurface;
  /** executeWorkerAgentTool の source (PlanRunSource)。 */
  toolSource: PlanRunSource;
  /** 「受け付けました」処理中メッセージを投稿する。投稿成否を返す。 */
  postProcessing(): Promise<boolean>;
  /** 添付画像をローカルへ保存し、保存先パス配列を返す。無ければ []。 */
  loadReferenceImages(): Promise<string[]>;
  /** 最終結果を投稿する。投稿成否を返す。 */
  postFinal(text: string): Promise<boolean>;
  /** audit_logs に残す action / target / 追加 metadata (transport 固有)。 */
  audit: {
    action: string;
    target: string;
    metadata: Record<string, unknown>;
  };
}

export interface ChatAgentJobResult {
  status: "succeeded" | "failed";
  durationMs: number;
  postedProcessing: boolean;
  postedFinal: boolean;
}

const MAX_AGENT_TURNS = 4;

export async function runChatAgentJob(
  deps: ChatAgentCoreDeps,
  transport: ChatAgentTransport
): Promise<ChatAgentJobResult> {
  const started = Date.now();
  let postedProcessing = false;
  let postedFinal = false;

  try {
    postedProcessing = await transport.postProcessing();
  } catch {
    postedProcessing = false;
  }

  const executions: ChatAgentExecution[] = [];
  let message = "";
  let failed = false;
  try {
    const language = await resolveChatAgentLanguage();
    const agentContext = await buildAgentContext(process.env);
    const webUrl = deps.webUrl ?? agentContext.webUrl;
    const referenceImagePaths = await transport.loadReferenceImages();
    const agentInput = appendReferenceImageContext(
      transport.inputText,
      referenceImagePaths
    );
    const seenTools = new Set<string>();
    for (let i = 0; i < MAX_AGENT_TURNS; i += 1) {
      const turn = await runAgentTurn({
        input: buildAgentLoopInput(agentInput, executions),
        provider: deps.provider,
        agentContext,
        purpose: `worker:${transport.surface}`,
        surface: transport.surface,
        language,
      });
      if (turn.message) message = turn.message;
      if (turn.toolResults.length === 0) break;
      let executedAny = false;
      for (const tool of turn.toolResults) {
        const signature = toolSignature(tool);
        if (signature && seenTools.has(signature)) {
          executions.push({
            display: signature,
            status: "unsupported",
            message: "同じ tool call の繰り返しを防止しました。",
          });
          continue;
        }
        if (signature) seenTools.add(signature);
        executions.push(
          await executeWorkerAgentTool({
            tool,
            prisma: deps.prisma,
            workspaceId: deps.workspaceId,
            boss: deps.boss,
            webUrl,
            githubAdapter: deps.githubAdapter,
            provider: deps.provider,
            referenceImagePaths,
            actor: transport.actor,
            source: transport.toolSource,
          })
        );
        executedAny = true;
      }
      if (!executedAny) break;
    }
    failed = executions.some(
      (e) =>
        e.status === "error" || e.status === "denied" || e.status === "unsupported"
    );
  } catch (err) {
    failed = true;
    message = `Agent 実行に失敗しました: ${(err as Error).message}`;
  }

  const finalText = formatChatAgentReply(message, executions, failed);
  try {
    postedFinal = await transport.postFinal(finalText);
  } catch {
    postedFinal = false;
  }

  await deps.prisma.auditLog
    .create({
      data: {
        workspaceId: deps.workspaceId,
        action: transport.audit.action,
        actor: transport.actor,
        target: transport.audit.target,
        metadata: {
          ...transport.audit.metadata,
          input: sanitizeText(transport.inputText),
          message: sanitizeText(message),
          executions: executions.map((e) => ({
            display: e.display,
            status: e.status,
            message: e.message,
          })),
          postedProcessing,
          postedFinal,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);

  return {
    status: failed ? "failed" : "succeeded",
    durationMs: Date.now() - started,
    postedProcessing,
    postedFinal,
  };
}

async function resolveChatAgentLanguage(): Promise<AddroidLanguage> {
  const config = await readAddroidConfig().catch(() => null);
  return resolveAddroidLanguage({
    preference: config?.ui.language,
  });
}

function toolSignature(tool: AgentToolResult): string | null {
  if (tool.status !== "ready") return null;
  try {
    return `${tool.tool}:${JSON.stringify(tool.toolArgs)}`;
  } catch {
    return tool.tool;
  }
}

// =====================================================================
// 添付画像コンテキスト + 返信整形 (Slack / Discord 共通)
// =====================================================================

export const CHAT_REFERENCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export function appendReferenceImageContext(input: string, paths: string[]): string {
  if (paths.length === 0) return input;
  return [
    input,
    "",
    "添付画像はこのローカルパスに保存済みです。",
    "新しいクリエイティブ案だけを生成する場合は generate_creatives の referenceImagePaths にこの配列を指定してください。",
    "/creatives の Creative ID を指定して入稿PRに回す場合は promote_creative_submission を使ってください。配信先や既存広告と同じページ/遷移先が未確定なら、先に resolve_creative_submission_context を使ってください。",
    "広告作成・入稿・PR作成を明示された場合は propose_creative_submission の referenceImagePaths に指定してください。",
    "遷移先URLが依頼文にある場合は generate_creatives / propose_creative_submission / promote_creative_submission の linkUrl または destinationUrl に指定してください。",
    "添付そのものを最終広告素材として入稿する場合だけ localMediaPaths に指定してください。",
    JSON.stringify(paths),
  ].join("\n");
}

export function normalizeChatImageMime(
  value: string | null | undefined
): "image/png" | "image/jpeg" | "image/webp" | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  if (mime === "image/png") return "image/png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "image/jpeg";
  if (mime === "image/webp") return "image/webp";
  return null;
}

export function extensionForChatImageMime(
  mime: "image/png" | "image/jpeg" | "image/webp"
): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

export function safeChatFilename(value: string, fallbackExtension: string): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "-");
  if (!base || base === "." || base === ".." || base.includes(path.sep)) {
    return `chat-reference-${Date.now().toString(36)}${fallbackExtension}`;
  }
  return /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `${base}${fallbackExtension}`;
}

export function formatChatAgentReply(
  message: string,
  executions: Array<{ display: string; status: string; message: string }>,
  failed: boolean
): string {
  const lines = [
    failed ? "完了しましたが、一部の処理で問題がありました。" : "完了しました。",
  ];
  if (message.trim()) lines.push("", sanitizeText(message.trim()));
  const visibleExecutions = executions.filter(isVisibleExecution);
  if (visibleExecutions.length > 0) {
    lines.push("", "実行内容:");
    for (const execution of visibleExecutions.slice(0, 8)) {
      lines.push(
        `- ${sanitizeText(execution.display)}: ${execution.status} - ${sanitizeText(execution.message)}`
      );
    }
    if (visibleExecutions.length > 8) {
      lines.push(`- ...ほか ${visibleExecutions.length - 8} 件`);
    }
  }
  const text = lines.join("\n");
  return text.length > 3500 ? `${text.slice(0, 3490)}...` : text;
}

function isVisibleExecution(execution: { display: string; status: string }): boolean {
  if (execution.status !== "ok") return true;
  return execution.display !== "Meta Graph read-only query";
}
