import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@addroid/db";
import {
  createExperimentRegistration,
  ExperimentRegistrationError,
} from "../experiment-registration.js";

test("createExperimentRegistration rejects incomplete API input as 400", async () => {
  await assert.rejects(
    createExperimentRegistration({
      prisma: fakePrisma() as unknown as PrismaClient,
      workspaceId: "ws-1",
      input: { accountKey: "primary" },
      actor: "test",
    }),
    (err) =>
      err instanceof ExperimentRegistrationError &&
      err.statusCode === 400 &&
      /実験名/.test(err.message),
  );
});

test("createExperimentRegistration rejects running variant overlap as 409", async () => {
  const prisma = fakePrisma({ duplicateExperiment: { id: "exp-old", name: "old test" } });

  await assert.rejects(
    createExperimentRegistration({
      prisma: prisma as unknown as PrismaClient,
      workspaceId: "ws-1",
      input: validInput(),
      actor: "test",
    }),
    (err) =>
      err instanceof ExperimentRegistrationError &&
      err.statusCode === 409 &&
      /old test/.test(err.message),
  );
});

test("createExperimentRegistration creates a running experiment and audit log", async () => {
  const prisma = fakePrisma();
  const created = await createExperimentRegistration({
    prisma: prisma as unknown as PrismaClient,
    workspaceId: "ws-1",
    input: validInput(),
    actor: "test",
  });

  assert.equal(created.name, "hero copy test");
  assert.equal(created.accountKey, "primary");
  assert.equal(created.status, "running");
  assert.equal(prisma.experiment.created.length, 1);
  assert.equal(prisma.auditLog.rows[0]?.action, "experiment.created");
  assert.equal(prisma.auditLog.rows[0]?.metadata.variantAKey, "ad-a");
});

function validInput() {
  return {
    accountKey: "primary",
    name: "hero copy test",
    metric: "ctr",
    adsetNodeKey: "adset-1",
    variantAKey: "ad-a",
    variantBKey: "ad-b",
    minImpressionsPerVariant: 100,
    maxDurationDays: 7,
  };
}

function fakePrisma(opts: {
  duplicateExperiment?: { id: string; name: string } | null;
} = {}) {
  const account = { id: "acc-1", key: "primary" };
  const adset = { id: "adset-row-1", status: "active" };
  const variants = [
    { nodeKey: "ad-a", parentId: adset.id, status: "active" },
    { nodeKey: "ad-b", parentId: adset.id, status: "active" },
  ];
  return {
    adAccount: {
      async findFirst() {
        return account;
      },
    },
    adsHierarchyNode: {
      async findUnique() {
        return adset;
      },
      async findMany() {
        return variants;
      },
    },
    experiment: {
      created: [] as Array<Record<string, unknown>>,
      async findFirst() {
        return opts.duplicateExperiment ?? null;
      },
      async create(input: {
        data: Record<string, unknown>;
        select: Record<string, boolean>;
      }) {
        this.created.push(input.data);
        return {
          id: "exp-1",
          name: input.data.name,
          status: "running",
          metric: input.data.metric,
          adsetNodeKey: input.data.adsetNodeKey,
          variantAKey: input.data.variantAKey,
          variantBKey: input.data.variantBKey,
        };
      },
    },
    auditLog: {
      rows: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
      async create(input: { data: { action: string; metadata: Record<string, unknown> } }) {
        this.rows.push(input.data);
        return { id: "audit-1" };
      },
    },
  };
}
