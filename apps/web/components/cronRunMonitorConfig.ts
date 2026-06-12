"use client";

const MINUTE_MS = 60 * 1000;

export function cronRunMonitorConfigForPreset(presetName: string): {
  pollIntervalMs: number;
  timeoutMs: number;
} {
  switch (presetName) {
    case "improvement_pr":
    case "auto_creative_generation":
      return { pollIntervalMs: 5000, timeoutMs: 20 * MINUTE_MS };
    case "daily_report":
    case "today_report":
      return { pollIntervalMs: 4000, timeoutMs: 10 * MINUTE_MS };
    case "github_poll":
      return { pollIntervalMs: 3000, timeoutMs: 3 * MINUTE_MS };
    case "budget_guard":
    case "budget_rebalance":
    case "experiment_evaluate":
      return { pollIntervalMs: 4000, timeoutMs: 8 * MINUTE_MS };
    case "retention_sweep":
      return { pollIntervalMs: 5000, timeoutMs: 10 * MINUTE_MS };
    default:
      return { pollIntervalMs: 3000, timeoutMs: 10 * MINUTE_MS };
  }
}
