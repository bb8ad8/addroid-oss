import { Prisma, type PrismaClient } from "@addroid/db";

export interface CreateExperimentInput {
  accountId?: unknown;
  accountKey?: unknown;
  name?: unknown;
  hypothesis?: unknown;
  metric?: unknown;
  adsetNodeKey?: unknown;
  variantAKey?: unknown;
  variantBKey?: unknown;
  minImpressionsPerVariant?: unknown;
  maxDurationDays?: unknown;
}

export interface CreateExperimentResult {
  id: string;
  name: string;
  accountKey: string;
  status: string;
  metric: string;
  adsetNodeKey: string;
  variantAKey: string;
  variantBKey: string;
}

export class ExperimentRegistrationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export async function createExperimentRegistration(opts: {
  prisma: PrismaClient;
  workspaceId: string;
  input: CreateExperimentInput;
  actor: string;
}): Promise<CreateExperimentResult> {
  const accountRef = readString(opts.input.accountKey) ?? readString(opts.input.accountId);
  if (!accountRef) {
    throw new ExperimentRegistrationError("広告アカウントを指定してください。");
  }
  const name = readString(opts.input.name);
  if (!name) throw new ExperimentRegistrationError("実験名を指定してください。");
  const metric = readString(opts.input.metric) ?? "ctr";
  if (metric !== "ctr" && metric !== "cvr") {
    throw new ExperimentRegistrationError("metric は ctr または cvr を指定してください。");
  }
  const adsetNodeKey = requireString(opts.input.adsetNodeKey, "adsetNodeKey");
  const variantAKey = requireString(opts.input.variantAKey, "variantAKey");
  const variantBKey = requireString(opts.input.variantBKey, "variantBKey");
  if (variantAKey === variantBKey) {
    throw new ExperimentRegistrationError("比較する広告は2つ別々に指定してください。");
  }

  const account = await opts.prisma.adAccount.findFirst({
    where: {
      workspaceId: opts.workspaceId,
      OR: [{ id: accountRef }, { key: accountRef }, { metaAccountId: accountRef }],
    },
    select: { id: true, key: true },
  });
  if (!account) {
    throw new ExperimentRegistrationError("広告アカウントが見つかりません。", 404);
  }

  const adset = await opts.prisma.adsHierarchyNode.findUnique({
    where: {
      accountId_nodeType_nodeKey: {
        accountId: account.id,
        nodeType: "adset",
        nodeKey: adsetNodeKey,
      },
    },
    select: { id: true, status: true },
  });
  if (!adset) {
    throw new ExperimentRegistrationError("指定された広告セットが見つかりません。", 404);
  }

  const variants = await opts.prisma.adsHierarchyNode.findMany({
    where: {
      accountId: account.id,
      nodeType: "ad",
      nodeKey: { in: [variantAKey, variantBKey] },
    },
    select: { nodeKey: true, parentId: true, status: true },
  });
  if (variants.length !== 2) {
    throw new ExperimentRegistrationError("指定された2つの広告が見つかりません。", 404);
  }
  for (const variant of variants) {
    if (variant.parentId !== adset.id) {
      throw new ExperimentRegistrationError("2つの広告は同一広告セット内から選んでください。");
    }
    if (variant.status !== "active") {
      throw new ExperimentRegistrationError("実験に登録する広告は active のものを選んでください。");
    }
  }

  const duplicate = await opts.prisma.experiment.findFirst({
    where: {
      accountId: account.id,
      status: "running",
      OR: [
        { variantAKey: { in: [variantAKey, variantBKey] } },
        { variantBKey: { in: [variantAKey, variantBKey] } },
      ],
    },
    select: { id: true, name: true },
  });
  if (duplicate) {
    throw new ExperimentRegistrationError(
      `指定された広告は実行中の実験「${duplicate.name}」で使用されています。`,
      409,
    );
  }

  const minImpressionsPerVariant = readPositiveInt(
    opts.input.minImpressionsPerVariant,
    2000,
  );
  const maxDurationDays = readPositiveInt(opts.input.maxDurationDays, 14);
  try {
    const created = await opts.prisma.experiment.create({
      data: {
        workspaceId: opts.workspaceId,
        accountId: account.id,
        name,
        hypothesis: readString(opts.input.hypothesis),
        metric,
        adsetNodeKey,
        variantAKey,
        variantBKey,
        startDate: todayUtc(),
        minImpressionsPerVariant,
        maxDurationDays,
        createdBy: opts.actor,
      },
      select: {
        id: true,
        name: true,
        status: true,
        metric: true,
        adsetNodeKey: true,
        variantAKey: true,
        variantBKey: true,
      },
    });
    await opts.prisma.auditLog.create({
      data: {
        workspaceId: opts.workspaceId,
        actor: opts.actor,
        action: "experiment.created",
        target: `experiment:${created.id}`,
        ref: account.key,
        metadata: {
          accountKey: account.key,
          name: created.name,
          metric: created.metric,
          adsetNodeKey,
          variantAKey,
          variantBKey,
        } as Prisma.InputJsonValue,
      },
    });
    return { ...created, accountKey: account.key };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ExperimentRegistrationError("同じ広告アカウントに同名の実験があります。", 409);
    }
    throw err;
  }
}

function requireString(value: unknown, field: string): string {
  const s = readString(value);
  if (!s) throw new ExperimentRegistrationError(`${field} を指定してください。`);
  return s;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}
