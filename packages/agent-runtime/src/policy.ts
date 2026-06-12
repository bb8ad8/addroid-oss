const DENIED_TOOL_NAMES = new Set([
  "run_shell",
  "shell",
  "exec",
  "execute_command",
  "restore",
  "restore_db",
  "db_restore",
  "db_write",
  "database_write",
  "direct_db_write",
  "migrate_db",
  "git_reset",
  "git_checkout",
  "git_clean",
  "git_force_push",
  "delete_repo",
  "print_secret",
  "show_secret",
  "export_secret",
  "direct_meta_apply",
  "meta_mutation",
  "bypass_approval",
  "disable_policy",
]);

const DANGEROUS_TEXT_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+push\b.*\s--force\b/i,
  /\brestore\b.*\b(db|database|postgres|postgresql)\b/i,
  /\bpg_restore\b/i,
  /\bpsql\b.*\b(delete|drop|truncate|update|insert)\b/i,
  /\bprisma\b.*\b(migrate|db\s+push)\b/i,
  /\b(drop|truncate)\s+table\b/i,
  /\b(print|show|cat|echo|export)\b.*\b(access_token|refresh_token|api[_-]?key|secret)\b/i,
  /\b(meta|facebook)\b.*\b(direct|bypass|without approval|approval bypass)\b/i,
  /DB.*復元/,
  /(トークン|APIキー|シークレット).*(表示|出力|見せて|教えて)/,
  /(承認|approval).*(迂回|無視|スキップ)/i,
];

export interface AgentPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateAgentToolPolicy(
  toolName: string,
  args: Record<string, unknown>
): AgentPolicyDecision {
  const normalizedName = normalizeToken(toolName);
  if (DENIED_TOOL_NAMES.has(normalizedName)) {
    return {
      allowed: false,
      reason: `denied tool: ${toolName}`,
    };
  }
  if (normalizedName === "query_meta_ads") {
    const resource = typeof args.resource === "string" ? normalizeToken(args.resource) : "";
    const action = typeof args.action === "string" ? normalizeToken(args.action) : "get";
    const allowedResources = new Set([
      "insights",
      "adaccount",
      "campaign",
      "adset",
      "ad",
      "creative",
      "catalog",
      "dataset",
      "page",
      "product_feed",
      "product_item",
      "product_set",
    ]);
    const allowedActions = new Set(["get", "list", "current"]);
    if (!allowedResources.has(resource) || !allowedActions.has(action)) {
      return {
        allowed: false,
        reason: "query_meta_ads only allows read-only Meta Graph list/get/current operations",
      };
    }
    if (action === "current" && resource !== "adaccount") {
      return {
        allowed: false,
        reason: "query_meta_ads current is only available for adaccount",
      };
    }
    if (resource === "insights" && action !== "get") {
      return {
        allowed: false,
        reason: "query_meta_ads insights only supports get",
      };
    }
  }
  if (normalizedName === "query_performance" || normalizedName === "compare_performance") {
    const forbiddenKeys = new Set(["sql", "query", "raw_sql", "rawsql", "statement"]);
    if (containsForbiddenQueryKey(args, forbiddenKeys)) {
      return {
        allowed: false,
        reason: `${toolName} only accepts predefined query catalog arguments`,
      };
    }
  }
  const text = JSON.stringify({ toolName, args });
  for (const pattern of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        reason: `dangerous request matched policy: ${pattern.source}`,
      };
    }
  }
  return { allowed: true };
}

export function isDeniedAgentRequest(input: string): AgentPolicyDecision {
  for (const pattern of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(input)) {
      return {
        allowed: false,
        reason: `dangerous request matched policy: ${pattern.source}`,
      };
    }
  }
  return { allowed: true };
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function containsForbiddenQueryKey(value: unknown, forbiddenKeys: Set<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenQueryKey(item, forbiddenKeys));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenKeys.has(normalizeToken(key))) return true;
    if (containsForbiddenQueryKey(nested, forbiddenKeys)) return true;
  }
  return false;
}
