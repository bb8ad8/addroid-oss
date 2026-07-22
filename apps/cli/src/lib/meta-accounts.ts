// AdDroid OSS — CLI helpers for Meta Ad Account registration and selection.

import {
  defaultAddroidConfig,
  ensureAddroidPaths,
  readAddroidConfig,
} from "@addroid/config";
import type { MetaAdAccount } from "@addroid/meta-adapter";
import { ensureWorkspace } from "../../../worker/src/lib/prisma-stores.js";

export interface CliWorkspace {
  id: string;
  slug: string;
}

export interface RegisteredAccount {
  id: string;
  key: string;
  displayName: string;
  metaAccountId: string | null;
  businessId?: string | null;
  businessName?: string | null;
  currency?: string | null;
  timezoneName?: string | null;
  accountStatus?: number | null;
}

export interface WorkspaceDefault {
  defaultAdAccountId: string | null;
}

export interface MetaAccountsPrisma {
  workspace: {
    findFirst(args: unknown): Promise<WorkspaceDefault | null>;
    findUnique(args: unknown): Promise<WorkspaceDefault | null>;
    update(args: unknown): Promise<WorkspaceDefault>;
  };
  adAccount: {
    findMany(args: unknown): Promise<RegisteredAccount[]>;
    findFirst(args: unknown): Promise<RegisteredAccount | null>;
    findUnique(args: unknown): Promise<RegisteredAccount | null>;
    create(args: unknown): Promise<RegisteredAccount>;
    update(args: unknown): Promise<RegisteredAccount>;
  };
  auditLog: {
    create(args: unknown): Promise<unknown>;
  };
}

export async function ensureCliWorkspace(prisma: unknown): Promise<CliWorkspace> {
  const paths = await ensureAddroidPaths();
  const config = (await readAddroidConfig().catch(() => null)) ?? defaultAddroidConfig();
  return ensureWorkspace(prisma as never, {
    slug: config.workspace.slug,
    displayName: config.workspace.displayName,
    configPath: paths.configFile,
    storageDir: paths.storageDir,
    databaseUrlRef: config.database.urlRef,
  });
}

export async function listRegisteredAccounts(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<RegisteredAccount[]> {
  return prisma.adAccount.findMany({
    where: { workspaceId },
    orderBy: [{ active: "desc" }, { displayName: "asc" }, { key: "asc" }],
    select: accountSelect(),
  });
}

export async function syncMetaAdAccounts(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  accounts: readonly MetaAdAccount[]
): Promise<{ registered: number; updated: number; accounts: RegisteredAccount[] }> {
  let registered = 0;
  let updated = 0;
  const rows: RegisteredAccount[] = [];
  for (const acc of accounts) {
    const metaAccountId = acc.metaAccountId;
    const existing = await prisma.adAccount.findFirst({
      where: { workspaceId, OR: [{ metaAccountId }, { key: metaAccountId }] },
      select: accountSelect(),
    });
    if (existing) {
      const row = await prisma.adAccount.update({
        where: { id: existing.id },
        data: {
          displayName: shouldRefreshDisplayName(existing)
            ? acc.name || existing.displayName
            : existing.displayName,
          businessId: acc.businessId ?? null,
          businessName: acc.businessName ?? null,
          currency: acc.currency ?? null,
          timezoneName: acc.timezoneName ?? null,
          accountStatus: acc.accountStatus ?? null,
          // active は手動無効化 (DB上の active=false) を保持するため再セットしない。
          // 再有効化は accounts add --ad-account-id (registerManualAccount) 経路で行う。
        },
        select: accountSelect(),
      });
      updated += 1;
      rows.push(row);
      continue;
    }
    const row = await prisma.adAccount.create({
      data: {
        workspaceId,
        key: metaAccountId,
        displayName: acc.name || metaAccountId,
        metaAccountId,
        businessId: acc.businessId ?? null,
        businessName: acc.businessName ?? null,
        currency: acc.currency ?? null,
        timezoneName: acc.timezoneName ?? null,
        accountStatus: acc.accountStatus ?? null,
        active: true,
      },
      select: accountSelect(),
    });
    registered += 1;
    rows.push(row);
  }
  return { registered, updated, accounts: rows };
}

export async function ensureDefaultAccount(
  prisma: MetaAccountsPrisma,
  workspaceId: string
): Promise<RegisteredAccount | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultAdAccountId: true },
  });
  if (ws?.defaultAdAccountId) {
    const existing = await prisma.adAccount.findFirst({
      where: { id: ws.defaultAdAccountId, workspaceId },
      select: accountSelect(),
    });
    if (existing) return existing;
  }
  const first = await prisma.adAccount.findFirst({
    where: { workspaceId, active: true },
    orderBy: [{ createdAt: "asc" }],
    select: accountSelect(),
  });
  if (!first) return null;
  await setDefaultAccount(prisma, workspaceId, first.id, "system:accounts-sync");
  return first;
}

export async function setDefaultAccount(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  adAccountId: string,
  actor: string
): Promise<RegisteredAccount> {
  const account = await prisma.adAccount.findFirst({
    where: { id: adAccountId, workspaceId },
    select: accountSelect(),
  });
  if (!account) {
    throw new Error("Specified ad account is not registered in this workspace.");
  }
  const before = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultAdAccountId: true },
  });
  if (before?.defaultAdAccountId !== account.id) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { defaultAdAccountId: account.id },
      select: { defaultAdAccountId: true },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actor,
        action: "account.default_changed",
        target: `ad_account:${account.id}`,
        ref: account.metaAccountId ?? account.key,
        metadata: {
          previousAdAccountId: before?.defaultAdAccountId ?? null,
          newAdAccountId: account.id,
          displayName: account.displayName,
        },
      },
    });
  }
  return account;
}

export async function addManualAdAccount(
  prisma: MetaAccountsPrisma,
  workspaceId: string,
  input: { metaAccountId: string; key?: string | null; displayName?: string | null }
): Promise<RegisteredAccount> {
  const metaAccountId = normalizeMetaAccountId(input.metaAccountId);
  const key = input.key?.trim() || metaAccountId;
  const displayName = input.displayName?.trim() || metaAccountId;
  const existing = await prisma.adAccount.findFirst({
    where: {
      workspaceId,
      OR: [{ key }, { metaAccountId }],
    },
    select: accountSelect(),
  });
  if (existing) {
    return prisma.adAccount.update({
      where: { id: existing.id },
      data: {
        key,
        displayName,
        metaAccountId,
        active: true,
      },
      select: accountSelect(),
    });
  }
  return prisma.adAccount.create({
    data: {
      workspaceId,
      key,
      displayName,
      metaAccountId,
      active: true,
    },
    select: accountSelect(),
  });
}

export function normalizeMetaAccountId(value: string): string {
  const trimmed = value.trim();
  if (/^act_\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `act_${trimmed}`;
  throw new Error("Meta Ad Account ID must be act_<digits> or digits.");
}

export function formatAccountLine(
  account: RegisteredAccount,
  opts: { selected?: boolean; default?: boolean } = {}
): string {
  const markers = [opts.selected ? "*" : " ", opts.default ? "default" : ""]
    .filter(Boolean)
    .join(" ")
    .padEnd(9);
  const meta = account.metaAccountId ?? "unconfigured";
  const detail = [
    account.currency ?? null,
    account.timezoneName ?? null,
    typeof account.accountStatus === "number" ? `status=${account.accountStatus}` : null,
  ].filter((v): v is string => Boolean(v));
  return `${markers} ${account.key.padEnd(18)} ${meta.padEnd(18)} ${account.displayName}${
    detail.length > 0 ? ` (${detail.join(", ")})` : ""
  }`;
}

function shouldRefreshDisplayName(account: RegisteredAccount): boolean {
  return (
    account.displayName.trim().length === 0 ||
    account.displayName === account.key ||
    account.displayName === account.metaAccountId
  );
}

function accountSelect() {
  return {
    id: true,
    key: true,
    displayName: true,
    metaAccountId: true,
    businessId: true,
    businessName: true,
    currency: true,
    timezoneName: true,
    accountStatus: true,
  } as const;
}
