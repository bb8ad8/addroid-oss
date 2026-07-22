// apply_job 実行結果 (execution_logs.payload) から Meta API エラー詳細を取り出す
// 純粋ヘルパ群。#3844 (Phase 1 縮小版): DB 直読なしで CLI からエラー詳細
// (code / error_subcode / message) に到達できるようにする。
//
// 対象 payload の実体 (packages/queue/src/apply-executor.ts が書く形):
//   payload.executor.response.error = {
//     code, type, message, error_data, fbtrace_id, is_transient,
//     error_subcode, error_user_msg, error_user_title,
//   }
//
// `payload` は execution_logs.payload (jsonb) をそのまま渡す想定で、形式が
// 想定と異なっていても例外を投げず null/best-effort を返す (fail-soft — 表示
// ツールなので取得失敗より表示継続を優先する)。

export interface MetaErrorSummary {
  code?: number;
  errorSubcode?: number;
  message: string;
}

/** `payload.executor.response.error` から 1 行サマリ用の情報を抜き出す。 */
export function extractMetaErrorSummary(payload: unknown): MetaErrorSummary | null {
  const error = getMetaErrorObject(payload);
  if (error) {
    const message =
      typeof error.message === "string" && error.message.trim()
        ? error.message.trim()
        : typeof error.error_user_msg === "string" && error.error_user_msg.trim()
          ? error.error_user_msg.trim()
          : "(no message)";
    return {
      ...(typeof error.code === "number" ? { code: error.code } : {}),
      ...(typeof error.error_subcode === "number" ? { errorSubcode: error.error_subcode } : {}),
      message,
    };
  }

  // フォールバック: executor.message (Meta 構造化エラーが取れない unknown_error 等)。
  const executor = getRecord(payload)?.executor;
  const executorRecord = getRecord(executor);
  if (executorRecord && typeof executorRecord.message === "string" && executorRecord.message.trim()) {
    return { message: executorRecord.message.trim() };
  }

  return null;
}

/** 1 行サマリ文字列。`addroid status` / `addroid logs` 双方から使う。 */
export function formatMetaErrorLine(summary: MetaErrorSummary): string {
  const parts: string[] = [];
  if (summary.code !== undefined) parts.push(`code=${summary.code}`);
  if (summary.errorSubcode !== undefined) parts.push(`subcode=${summary.errorSubcode}`);
  const prefix = parts.length > 0 ? `${parts.join(" ")} — ` : "";
  return `${prefix}${summary.message}`;
}

function getMetaErrorObject(payload: unknown): Record<string, unknown> | null {
  const root = getRecord(payload);
  const executor = getRecord(root?.executor);
  const response = getRecord(executor?.response);
  const error = getRecord(response?.error);
  return error;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Secret masking — execution_logs.payload を整形表示する前に必ず通す。
// ---------------------------------------------------------------------

/** キー名がこれに一致する場合、値を丸ごと `[REDACTED]` にする。 */
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|authorization|api[_-]?key|access[_-]?key|database[_-]?url|dsn|connection[_-]?string/i;

/** 文字列中に埋め込まれたトークンっぽい値を検出して伏せる (Bearer ヘッダ等)。 */
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /(access_token|token|api_key)\s*=\s*[^\s&"']{8,}/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi,
];

/**
 * JSON 値を再帰的に walk し、機密っぽいキー・パターンをマスクした deep copy を返す。
 * 循環参照は想定しない (execution_logs.payload は JSON シリアライズ済みデータ)。
 */
export function maskSecretsDeep(value: unknown): unknown {
  return maskInner(value, new Set());
}

function maskInner(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((v) => maskInner(v, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = maskInner(v, seen);
      }
    }
    return out;
  }
  return value;
}

function maskString(s: string): string {
  let out = s;
  for (const re of SECRET_TEXT_PATTERNS) {
    out = out.replace(re, (match) => {
      if (/^Bearer/i.test(match)) return "Bearer [REDACTED]";
      const eq = match.indexOf("=");
      if (eq >= 0) return `${match.slice(0, eq + 1)}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return out;
}
