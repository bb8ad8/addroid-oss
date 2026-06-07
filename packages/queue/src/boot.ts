// AdDroid OSS — pg-boss boot + schedule registration.
//
// pg-boss を 1 つの PostgreSQL 上に起動し、CRON_PRESETS を schedule に登録する。
// ハンドラ attach は呼び出し側 (apps/worker) が行うため、本モジュールはスケジュール
// 名と cron 式の登録までで責務を切る。

import PgBoss from "pg-boss";
import {
  AUTOMATION_RULE_JOB_NAME,
  CRON_PRESETS,
  APPLY_JOB_NAME,
  SCHEDULED_TASK_JOB_NAME,
} from "./presets.js";
import { SLACK_AGENT_JOB_NAME } from "./slack-agent.js";
import { SLACK_COMMAND_JOB_NAME } from "./slack-command.js";
import { DISCORD_AGENT_JOB_NAME } from "./discord-agent.js";
import { DISCORD_COMMAND_JOB_NAME } from "./discord-command.js";

export interface BootOptions {
  databaseUrl: string;
}

export interface QueueManager {
  createQueue(name: string): Promise<void>;
}

export interface CronScheduler extends QueueManager {
  schedule(
    name: string,
    cron: string,
    data?: unknown,
    options?: { tz?: string }
  ): Promise<void>;
}

export const RUNTIME_QUEUE_NAMES = [
  ...CRON_PRESETS.map((preset) => preset.name),
  APPLY_JOB_NAME,
  SCHEDULED_TASK_JOB_NAME,
  AUTOMATION_RULE_JOB_NAME,
  SLACK_COMMAND_JOB_NAME,
  SLACK_AGENT_JOB_NAME,
  DISCORD_COMMAND_JOB_NAME,
  DISCORD_AGENT_JOB_NAME,
] as const;

/**
 * pg-boss v10 は schedule/send/work の前に queue の存在を要求する。
 * createQueue は idempotent なので、web / worker のどちらが先に起動しても
 * 同じ実行時 queue セットを揃えてから操作する。
 */
export async function ensureQueue(
  boss: QueueManager,
  name: string
): Promise<void> {
  await boss.createQueue(name);
}

export async function ensureRuntimeQueues(boss: QueueManager): Promise<void> {
  for (const name of RUNTIME_QUEUE_NAMES) {
    await ensureQueue(boss, name);
  }
}

/**
 * pg-boss インスタンスを start() まで進めて返す。pg-boss は同じ DB 上に
 * `pgboss` スキーマを自動生成する (DB ユーザーが CREATE SCHEMA 権限を持つこと)。
 */
export async function bootPgBoss(opts: BootOptions): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    schema: "pgboss",
  });
  await boss.start();
  await ensureRuntimeQueues(boss);
  return boss;
}

export interface RegisterPresetsOptions {
  /**
   * the current implementation では daily_report 等は enabled=false で登録するが、UI から動作状況を
   * 見せるために schedule の存在は宣言しておく。テストでは true にして全件動かす。
   */
  enableNonEssential?: boolean;
  timeZone?: string;
}

export function resolveCronScheduleTimeZone(
  env: NodeJS.ProcessEnv = process.env
): string {
  const candidates = [
    env.ADDROID_USER_TIMEZONE,
    env.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "UTC",
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
      return trimmed;
    } catch {
      // Try the next fallback.
    }
  }
  return "UTC";
}

export async function scheduleCron(
  boss: CronScheduler,
  name: string,
  cron: string,
  timeZone = resolveCronScheduleTimeZone()
): Promise<void> {
  await ensureQueue(boss, name);
  await boss.schedule(name, cron, undefined, { tz: timeZone });
}

/**
 * pg-boss にプリセット cron を登録する。実ハンドラ attach は呼び出し側で行う。
 * 本関数は idempotent なので worker 再起動のたびに呼んで構わない。
 */
export async function registerCronPresets(
  boss: CronScheduler,
  opts: RegisterPresetsOptions = {}
): Promise<void> {
  const timeZone = opts.timeZone ?? resolveCronScheduleTimeZone();
  for (const preset of CRON_PRESETS) {
    if (!preset.enabledByDefault && !opts.enableNonEssential) continue;
    await scheduleCron(boss, preset.name, preset.cron, timeZone);
  }
}
