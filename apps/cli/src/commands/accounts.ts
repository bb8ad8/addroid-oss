// `addroid accounts` — Meta Ad Account registration, refresh, and default selection.

import readline from "node:readline/promises";
import {
  MetaAdapterUnauthenticatedError,
  MetaAdapterNotImplementedError,
} from "@addroid/meta-adapter";
import { buildPrismaMetaAdapterSelection } from "../../../worker/src/lib/meta-runtime.js";
import {
  addManualAdAccount,
  ensureCliWorkspace,
  formatAccountLine,
  listRegisteredAccounts,
  normalizeMetaAccountId,
  setDefaultAccount,
  syncMetaAdAccounts,
  type MetaAccountsPrisma,
  type RegisteredAccount,
} from "../lib/meta-accounts.js";

type AccountsAction =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "list"; json: boolean }
  | { kind: "refresh"; json: boolean; selectDefault: boolean }
  | {
      kind: "add";
      json: boolean;
      all: boolean;
      selectDefault: boolean;
      metaAccountId?: string;
      key?: string;
      name?: string;
    }
  | {
      kind: "select";
      json: boolean;
      adAccountId?: string;
      key?: string;
      yes: boolean;
    }
  | {
      kind: "cv";
      action: "list" | "candidates" | "set";
      json: boolean;
      adAccountId?: string;
      key?: string;
      event?: string;
      clear: boolean;
      days: number;
    };

export async function runAccountsCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.kind === "help") {
    printAccountsHelp();
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`[addroid accounts] ${parsed.message}\n\n`);
    printAccountsHelp();
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[addroid accounts] DATABASE_URL が設定されていません。先に `addroid init` を実行してください。\n"
    );
    return 2;
  }

  const { prisma } = await import("@addroid/db");
  try {
    const workspace = await ensureCliWorkspace(prisma);
    if (parsed.kind === "list") {
      const accounts = await listRegisteredAccounts(prisma as MetaAccountsPrisma, workspace.id);
      const defaultId = await loadDefaultId(prisma as MetaAccountsPrisma, workspace.id);
      printAccountList(accounts, defaultId, parsed.json);
      return 0;
    }
    if (parsed.kind === "refresh") {
      const result = await fetchAndSync(prisma as MetaAccountsPrisma, workspace.id);
      const defaultAccount = parsed.selectDefault
        ? await chooseAndSetDefault(prisma as MetaAccountsPrisma, workspace.id, result.accounts, {
            yes: false,
          })
        : result.accounts.length === 1
          ? await setDefaultAccount(
              prisma as MetaAccountsPrisma,
              workspace.id,
              result.accounts[0]!.id,
              "system:accounts-sync"
            )
          : await loadDefaultAccount(prisma as MetaAccountsPrisma, workspace.id);
      printRefreshResult(result, defaultAccount, parsed.json);
      return 0;
    }
    if (parsed.kind === "add") {
      if (parsed.metaAccountId) {
        const row = await addManualAdAccount(prisma as MetaAccountsPrisma, workspace.id, {
          metaAccountId: parsed.metaAccountId,
          key: parsed.key ?? null,
          displayName: parsed.name ?? null,
        });
        const defaultAccount = parsed.selectDefault
          ? await setDefaultAccount(prisma as MetaAccountsPrisma, workspace.id, row.id, "user:cli")
          : await loadDefaultAccount(prisma as MetaAccountsPrisma, workspace.id);
        printAddResult([row], defaultAccount, parsed.json);
        return 0;
      }
      const result = await fetchAndSync(prisma as MetaAccountsPrisma, workspace.id);
      const selected = parsed.all
        ? result.accounts
        : [await chooseOneAccount(result.accounts, { yes: false })];
      let defaultAccount: RegisteredAccount | null = null;
      if (parsed.selectDefault || selected.length === 1) {
        defaultAccount = await setDefaultAccount(
          prisma as MetaAccountsPrisma,
          workspace.id,
          selected[0]!.id,
          "user:cli"
        );
      } else {
        defaultAccount = await loadDefaultAccount(prisma as MetaAccountsPrisma, workspace.id);
      }
      printAddResult(selected, defaultAccount, parsed.json);
      return 0;
    }
    if (parsed.kind === "cv") {
      return await runCvAction(prisma as MetaAccountsPrisma, workspace.id, parsed);
    }
    if (parsed.kind === "select") {
      const accounts = await listRegisteredAccounts(prisma as MetaAccountsPrisma, workspace.id);
      const target = resolveSelection(accounts, parsed);
      const selected =
        target ??
        (await chooseOneAccount(accounts, { yes: parsed.yes, promptLabel: "Default account" }));
      const row = await setDefaultAccount(
        prisma as MetaAccountsPrisma,
        workspace.id,
        selected.id,
        "user:cli"
      );
      printSelectResult(row, parsed.json);
      return 0;
    }
    return 2;
  } catch (err) {
    process.stderr.write(`[addroid accounts] ${(err as Error).message}\n`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

export async function fetchAndSync(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<{ registered: number; updated: number; accounts: RegisteredAccount[] }> {
  const selection = await buildPrismaMetaAdapterSelection({ prisma: prisma as never });
  if (selection.choice === "stub") {
    throw new Error(
      `Meta access token support is not configured: ${selection.reason}. Run \`addroid auth meta\` first.`
    );
  }
  try {
    // 登録済みの Meta トークンを全件走査する。ビジネスポートフォリオごとに
    // トークンが分かれていると `me/adaccounts` は 1 本ぶんしか返さないため、
    // 既定トークンだけを見ると他ポートフォリオのアカウントを取りこぼす。
    // syncMetaAdAccounts は upsert のみで削除しないので、あるトークンから見えない
    // アカウントが消えることはない。
    const tokenRefs = await listMetaTokenRefs(prisma);
    let registered = 0;
    let updated = 0;
    const merged = new Map<string, RegisteredAccount>();
    const failures: string[] = [];
    for (const tokenRef of tokenRefs.length > 0 ? tokenRefs : [null]) {
      // fetchAdAccounts は accountKey を持たない (列挙前) ので、トークンを固定した
      // アダプタをトークンごとに作って回す。
      const perToken = tokenRef
        ? (await buildPrismaMetaAdapterSelection({
            prisma: prisma as never,
            forceTokenRef: tokenRef,
          })).adapter
        : selection.adapter;
      let accounts;
      try {
        accounts = await perToken.fetchAdAccounts();
      } catch (err) {
        failures.push(`${tokenRef ?? "default"}: ${(err as Error).message}`);
        continue;
      }
      const result = await syncMetaAdAccounts(prisma, workspaceId, accounts, tokenRef);
      registered += result.registered;
      updated += result.updated;
      for (const row of result.accounts) merged.set(row.id, row);
    }
    if (merged.size === 0 && failures.length > 0) {
      throw new Error(`Meta アカウント取得に失敗しました: ${failures.join("; ")}`);
    }
    if (failures.length > 0) {
      process.stderr.write(
        `[addroid accounts] 一部のトークンで取得に失敗しました: ${failures.join("; ")}\n`
      );
    }
    return { registered, updated, accounts: [...merged.values()] };
  } catch (err) {
    if (
      err instanceof MetaAdapterUnauthenticatedError ||
      err instanceof MetaAdapterNotImplementedError
    ) {
      throw new Error("Meta is not connected. Run `addroid auth meta` first.");
    }
    throw err;
  }
}

/** 登録済み Meta トークンの accountIdentifier を接続日時の新しい順に返す。 */
async function listMetaTokenRefs(prisma: MetaAccountsPrisma): Promise<string[]> {
  const store = prisma as unknown as {
    oAuthToken?: {
      findMany(args: unknown): Promise<Array<{ accountIdentifier: string }>>;
    };
  };
  if (!store.oAuthToken) return [];
  const rows = await store.oAuthToken.findMany({
    where: { provider: "meta" },
    orderBy: { connectedAt: "desc" },
    select: { accountIdentifier: true },
  });
  return rows.map((r) => r.accountIdentifier);
}

/**
 * `addroid accounts cv` — どの action_type を CV として数えるかをアカウント単位で設定する。
 *
 * Meta は同一の CV を複数の別名 action_type で返すため、集計対象を 1 つに決めないと
 * CV が多重計上される。何を CV とするかはアカウントの計測設計次第なので、
 * `candidates` で実データの action_type 別合計を見てから `set` する運用にしている。
 */
async function runCvAction(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  parsed: Extract<AccountsAction, { kind: "cv" }>
): Promise<number> {
  const accounts = await listRegisteredAccounts(prisma, workspaceId);
  if (accounts.length === 0) {
    process.stderr.write(
      "[addroid accounts] 登録済みの広告アカウントがありません。先に `addroid accounts add --all` を実行してください。\n"
    );
    return 2;
  }

  if (parsed.action === "list") {
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify(
          accounts.map((a) => ({
            key: a.key,
            metaAccountId: a.metaAccountId,
            displayName: a.displayName,
            cvEvent: a.cvEvent ?? null,
          })),
          null,
          2
        )}\n`
      );
      return 0;
    }
    process.stdout.write("[addroid accounts cv]\n\n");
    for (const account of accounts) {
      const setting = account.cvEvent?.trim()
        ? account.cvEvent
        : "(未設定 → 既定 omni_purchase → purchase)";
      process.stdout.write(
        `  ${(account.metaAccountId ?? account.key).padEnd(24)} ${account.displayName}\n` +
          `  ${" ".repeat(24)} CVイベント: ${setting}\n\n`
      );
    }
    return 0;
  }

  const targets = filterCvTargets(accounts, parsed);
  if (targets.length === 0) {
    process.stderr.write(
      `[addroid accounts] 指定に一致する広告アカウントがありません: ${parsed.adAccountId ?? parsed.key ?? "(未指定)"}\n`
    );
    return 2;
  }

  if (parsed.action === "set") {
    if (targets.length > 1) {
      process.stderr.write(
        "[addroid accounts] cv set は --ad-account-id か --key で 1 件に絞ってください。\n"
      );
      return 2;
    }
    const target = targets[0]!;
    const nextValue = parsed.clear ? null : (parsed.event?.trim() ?? null);
    await prisma.adAccount.update({
      where: { id: target.id },
      data: { cvEvent: nextValue },
    });
    await prisma.auditLog
      .create({
        data: {
          workspaceId,
          actor: "user:cli",
          action: "ad_account.cv_event_updated",
          target: `ad_account:${target.id}`,
          ref: target.metaAccountId ?? target.key,
          metadata: { before: target.cvEvent ?? null, after: nextValue },
        },
      })
      .catch(() => undefined);
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ key: target.key, metaAccountId: target.metaAccountId, cvEvent: nextValue }, null, 2)}\n`
      );
      return 0;
    }
    process.stdout.write(
      `[addroid accounts cv]\n\n  ${target.displayName}\n` +
        `  CVイベント: ${target.cvEvent ?? "(未設定)"} → ${nextValue ?? "(未設定 = 既定)"}\n\n` +
        "  反映するには worker の再起動が必要です: addroid down && addroid start\n"
    );
    return 0;
  }

  // action === "candidates"
  const { fetchInsights } = await import("@addroid/meta-adapter");
  const { tallyActionTypes } = await import("../../../worker/src/lib/meta-cv-event.js");
  const selection = await buildPrismaMetaAdapterSelection({ prisma: prisma as never });
  if (selection.choice === "stub") {
    process.stderr.write(
      `[addroid accounts] Meta が接続されていません: ${selection.reason}\n  先に \`addroid auth meta\` を実行してください。\n`
    );
    return 2;
  }
  const lease = await selection.adapter.loadAccessTokenPlaintext();
  if (!lease) {
    process.stderr.write("[addroid accounts] Meta access token を読み出せません。\n");
    return 2;
  }
  const until = new Date();
  const since = new Date(until.getTime() - parsed.days * 24 * 60 * 60 * 1000);
  const range = { since: toIsoDate(since), until: toIsoDate(until) };

  process.stdout.write(
    `[addroid accounts cv candidates] ${range.since} 〜 ${range.until} (${parsed.days}日)\n` +
      "  action_type 別の合計。CV に相当する 1 つを選び `cv set --event <action_type>` で設定してください。\n"
  );
  for (const account of targets) {
    const adAccountId = account.metaAccountId ?? account.key;
    process.stdout.write(
      `\n【${account.displayName}】${adAccountId} / 現設定=${account.cvEvent ?? "(未設定→既定)"}\n`
    );
    try {
      const rows = await fetchInsights({
        accessToken: lease.accessToken,
        adAccountId,
        fields: ["actions"],
        timeRange: range,
      });
      const actions = rows.flatMap((row) =>
        row && typeof row === "object" && Array.isArray((row as { actions?: unknown }).actions)
          ? ((row as { actions: unknown[] }).actions ?? [])
          : []
      );
      const tally = tallyActionTypes(actions);
      if (tally.length === 0) {
        process.stdout.write("  (この期間の action データがありません)\n");
        continue;
      }
      for (const entry of tally) {
        process.stdout.write(`  ${entry.actionType.padEnd(42)} ${entry.value}\n`);
      }
    } catch (err) {
      process.stdout.write(`  取得失敗: ${(err as Error).message}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

function filterCvTargets(
  accounts: RegisteredAccount[],
  parsed: Extract<AccountsAction, { kind: "cv" }>
): RegisteredAccount[] {
  if (parsed.adAccountId) {
    const wanted = normalizeMetaAccountId(parsed.adAccountId);
    return accounts.filter(
      (a) => a.metaAccountId === wanted || a.key === wanted || a.key === parsed.adAccountId
    );
  }
  if (parsed.key) return accounts.filter((a) => a.key === parsed.key);
  return accounts;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function loadDefaultId(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<string | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultAdAccountId: true },
  });
  return ws?.defaultAdAccountId ?? null;
}

async function loadDefaultAccount(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<RegisteredAccount | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultAdAccountId: true },
  });
  if (!ws?.defaultAdAccountId) return null;
  return prisma.adAccount.findFirst({
    where: { id: ws.defaultAdAccountId, workspaceId },
    select: {
      id: true,
      key: true,
      displayName: true,
      metaAccountId: true,
      businessId: true,
      businessName: true,
      currency: true,
      timezoneName: true,
      accountStatus: true,
    },
  });
}

async function chooseAndSetDefault(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  accounts: RegisteredAccount[],
  opts: { yes: boolean }
): Promise<RegisteredAccount | null> {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) {
    return setDefaultAccount(prisma, workspaceId, accounts[0]!.id, "user:cli");
  }
  if (opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) return null;
  const selected = await chooseOneAccount(accounts, { yes: false });
  return setDefaultAccount(prisma, workspaceId, selected.id, "user:cli");
}

function resolveSelection(
  accounts: RegisteredAccount[],
  parsed: Extract<AccountsAction, { kind: "select" }>
): RegisteredAccount | null {
  if (accounts.length === 0) {
    throw new Error("No registered ad accounts. Run `addroid accounts add` first.");
  }
  if (parsed.adAccountId) {
    const meta = normalizeMetaAccountId(parsed.adAccountId);
    const found = accounts.find((a) => a.metaAccountId === meta);
    if (!found) throw new Error(`Ad account ${meta} is not registered.`);
    return found;
  }
  if (parsed.key) {
    const found = accounts.find((a) => a.key === parsed.key);
    if (!found) throw new Error(`Ad account key ${parsed.key} is not registered.`);
    return found;
  }
  return null;
}

async function chooseOneAccount(
  accounts: RegisteredAccount[],
  opts: { yes: boolean; promptLabel?: string }
): Promise<RegisteredAccount> {
  if (accounts.length === 0) {
    throw new Error("No ad accounts are available.");
  }
  if (accounts.length === 1 || opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    return accounts[0]!;
  }
  process.stdout.write("\n");
  accounts.forEach((a, i) => {
    process.stdout.write(`  ${String(i + 1).padStart(2)}. ${formatAccountLine(a)}\n`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`? ${opts.promptLabel ?? "Ad account"} [1]: `);
    const n = answer.trim() ? Number(answer.trim()) : 1;
    if (!Number.isInteger(n) || n < 1 || n > accounts.length) {
      throw new Error("Invalid selection.");
    }
    return accounts[n - 1]!;
  } finally {
    rl.close();
  }
}

function printAccountList(
  accounts: RegisteredAccount[],
  defaultId: string | null,
  json: boolean
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, defaultAdAccountId: defaultId, accounts }, null, 2)}\n`
    );
    return;
  }
  process.stdout.write("[addroid accounts]\n\n");
  if (accounts.length === 0) {
    process.stdout.write("  No registered ad accounts. Run `addroid accounts add`.\n");
    return;
  }
  for (const account of accounts) {
    process.stdout.write(
      `${formatAccountLine(account, { default: account.id === defaultId })}\n`
    );
  }
}

function printRefreshResult(
  result: { registered: number; updated: number; accounts: RegisteredAccount[] },
  defaultAccount: RegisteredAccount | null,
  json: boolean
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, defaultAccount }, null, 2)}\n`);
    return;
  }
  process.stdout.write("[addroid accounts refresh]\n\n");
  process.stdout.write(`  fetched       : ${result.accounts.length}\n`);
  process.stdout.write(`  registered    : ${result.registered}\n`);
  process.stdout.write(`  updated       : ${result.updated}\n`);
  process.stdout.write(`  default       : ${defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "unset"}\n`);
}

function printAddResult(
  accounts: RegisteredAccount[],
  defaultAccount: RegisteredAccount | null,
  json: boolean
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, accounts, defaultAccount }, null, 2)}\n`);
    return;
  }
  process.stdout.write("[addroid accounts add]\n\n");
  for (const account of accounts) process.stdout.write(`  added/kept     : ${formatAccountLine(account)}\n`);
  process.stdout.write(`  default       : ${defaultAccount?.metaAccountId ?? defaultAccount?.key ?? "unset"}\n`);
}

function printSelectResult(account: RegisteredAccount, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, account }, null, 2)}\n`);
    return;
  }
  process.stdout.write("[addroid accounts select]\n\n");
  process.stdout.write(`  default       : ${account.metaAccountId ?? account.key} (${account.displayName})\n`);
}

function parseArgs(args: string[]): AccountsAction {
  const [subcommand = "list", ...rawRest] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return { kind: "help" };
  }
  // `accounts cv <action>` は 2 語のサブコマンド。先頭の非オプション語を action として取る。
  let cvAction: "list" | "candidates" | "set" = "list";
  let rest = rawRest;
  if (subcommand === "cv" && rawRest[0] && !rawRest[0].startsWith("-")) {
    const [head, ...tail] = rawRest;
    if (head !== "list" && head !== "candidates" && head !== "set") {
      return { kind: "error", message: `unknown cv action: ${head}` };
    }
    cvAction = head;
    rest = tail;
  }
  let json = false;
  let all = false;
  let selectDefault = false;
  let yes = false;
  let clear = false;
  let days = 14;
  let event: string | undefined;
  let metaAccountId: string | undefined;
  let key: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    const next = () => {
      const v = rest[++i];
      if (!v) throw new Error(`${a} requires a value`);
      return v;
    };
    try {
      if (a === "--json") json = true;
      else if (a === "--all") all = true;
      else if (a === "--select-default") selectDefault = true;
      else if (a === "--yes" || a === "-y") yes = true;
      else if (a === "--ad-account-id") metaAccountId = next();
      else if (a.startsWith("--ad-account-id=")) metaAccountId = a.slice("--ad-account-id=".length);
      else if (a === "--key") key = next();
      else if (a.startsWith("--key=")) key = a.slice("--key=".length);
      else if (a === "--name") name = next();
      else if (a.startsWith("--name=")) name = a.slice("--name=".length);
      else if (a === "--event") event = next();
      else if (a.startsWith("--event=")) event = a.slice("--event=".length);
      else if (a === "--clear") clear = true;
      else if (a === "--days") days = Number(next());
      else if (a.startsWith("--days=")) days = Number(a.slice("--days=".length));
      else return { kind: "error", message: `unknown option: ${a}` };
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
  }
  if (subcommand === "list") return { kind: "list", json };
  if (subcommand === "refresh") return { kind: "refresh", json, selectDefault };
  if (subcommand === "add") {
    return {
      kind: "add",
      json,
      all,
      selectDefault,
      ...(metaAccountId ? { metaAccountId } : {}),
      ...(key ? { key } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (subcommand === "select") {
    return {
      kind: "select",
      json,
      ...(metaAccountId ? { adAccountId: metaAccountId } : {}),
      ...(key ? { key } : {}),
      yes,
    };
  }
  if (subcommand === "cv") {
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return { kind: "error", message: "--days は 1〜90 の日数で指定してください" };
    }
    if (cvAction === "set" && !event && !clear) {
      return { kind: "error", message: "cv set には --event <action_type> か --clear が必要です" };
    }
    return {
      kind: "cv",
      action: cvAction,
      json,
      ...(metaAccountId ? { adAccountId: metaAccountId } : {}),
      ...(key ? { key } : {}),
      ...(event ? { event } : {}),
      clear,
      days,
    };
  }
  return { kind: "error", message: `unknown subcommand: ${subcommand}` };
}

function printAccountsHelp(): void {
  process.stdout.write(
    [
      "addroid accounts — Meta Ad Account selection",
      "",
      "Usage:",
      "  addroid accounts list [--json]",
      "  addroid accounts refresh [--select-default] [--json]",
      "  addroid accounts add [--all] [--select-default] [--json]",
      "  addroid accounts add --ad-account-id act_123 [--key primary] [--name NAME]",
      "  addroid accounts select [--ad-account-id act_123 | --key primary] [--yes] [--json]",
      "",
      "CV イベント (どの action_type を CV として数えるか。アカウントごとに設定):",
      "  addroid accounts cv list [--json]",
      "  addroid accounts cv candidates [--ad-account-id act_123] [--days 14]",
      "  addroid accounts cv set --ad-account-id act_123 --event purchase",
      "  addroid accounts cv set --ad-account-id act_123 --clear",
      "",
      "  Meta は同一の CV を複数の action_type (purchase / omni_purchase /",
      "  offsite_conversion.fb_pixel_purchase ...) で重複して返します。集計対象を 1 つに",
      "  決めないと CV が多重計上され CPA が実際より安く見えます。candidates で実データの",
      "  action_type 別合計を確認してから set してください。未設定時の既定は",
      "  omni_purchase → purchase の順で最初に見つかった 1 系統です。",
      "",
    ].join("\n")
  );
}
