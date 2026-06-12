import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AutomationRulesYamlSchema,
  BudgetRebalancePolicyYamlSchema,
  BudgetGuardPolicyYamlSchema,
  CronYamlSchema,
  ProjectYamlSchema,
  SubmissionGuardsYamlSchema,
  loadAutomationRules,
  loadBudgetRebalancePolicy,
  loadBudgetGuardPolicy,
  loadSubmissionGuardsPolicy,
} from "../index.js";

test("ProjectYamlSchema accepts project metadata", () => {
  const out = ProjectYamlSchema.safeParse({
    version: 1,
    workspace: { slug: "default-workspace", displayName: "Default" },
  });
  assert.equal(out.success, true);
});

test("CronYamlSchema validates cron fields and duplicates", () => {
  assert.equal(
    CronYamlSchema.safeParse({
      version: 1,
      schedules: [{ name: "budget_rebalance", cron: "0 10 * * 2", enabled: false }],
    }).success,
    true
  );
  assert.equal(
    CronYamlSchema.safeParse({
      version: 1,
      schedules: [{ name: "daily_report", cron: "60 9 * * *", enabled: true }],
    }).success,
    false
  );
  assert.equal(
    CronYamlSchema.safeParse({
      version: 1,
      schedules: [
        { name: "daily_report", cron: "0 9 * * *", enabled: true },
        { name: "daily_report", cron: "0 10 * * *", enabled: false },
      ],
    }).success,
    false
  );
});

test("BudgetGuardPolicyYamlSchema accepts optional policy fields", () => {
  const out = BudgetGuardPolicyYamlSchema.safeParse({
    version: 1,
    alerts: { dailyBudgetAlertRatio: 0.8 },
    autoPause: { enabled: false, safeCategories: [] },
    accounts: { primary: { dailyBudget: 500, monthlyBudget: 15000, currency: "JPY" } },
  });
  assert.equal(out.success, true);
});

test("BudgetRebalancePolicyYamlSchema defaults optional controls and caps ranges", () => {
  const out = BudgetRebalancePolicyYamlSchema.safeParse({
    version: 1,
    enabled: true,
  });
  assert.equal(out.success, true);
  if (!out.success) throw new Error("expected success");
  assert.equal(out.data.lookbackDays, 14);
  assert.equal(out.data.keepTotalBudget, true);
  assert.equal(
    BudgetRebalancePolicyYamlSchema.safeParse({
      version: 1,
      enabled: true,
      lookbackDays: 90,
    }).success,
    false
  );
});

test("SubmissionGuardsYamlSchema accepts budget increase guard and rejects inverted ratios", () => {
  assert.equal(
    SubmissionGuardsYamlSchema.safeParse({
      version: 1,
      guards: { budgetIncrease: { warnOverRatio: 2, blockOverRatio: 5 } },
    }).success,
    true
  );
  assert.equal(
    SubmissionGuardsYamlSchema.safeParse({
      version: 1,
      guards: { budgetIncrease: { warnOverRatio: 5, blockOverRatio: 2 } },
    }).success,
    false
  );
});

test("AutomationRulesYamlSchema accepts a rule document", () => {
  const out = AutomationRulesYamlSchema.safeParse({
    version: 1,
    rules: [
      {
        id: "pause_waste",
        enabled: true,
        scope: { level: "ad" },
        when: { all: [{ metric: "spend", gte: 1000 }] },
        action: { type: "pause", status: "PAUSED" },
      },
    ],
  });
  assert.equal(out.success, true);
});

test("loadBudgetGuardPolicy and loadAutomationRules read ops policy files leniently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addroid-ops-schemas-"));
  try {
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "workflows/budget-guard.yaml"),
      "version: 1\nalerts:\n  dailyBudgetAlertRatio: 0.8\naccounts: {}\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "workflows/automation-rules.yaml"),
      "version: 1\nrules: []\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "workflows/budget-rebalance.yaml"),
      "version: 1\nenabled: true\nlookbackDays: 14\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "workflows/guards.yaml"),
      "version: 1\nguards:\n  budgetIncrease:\n    warnOverRatio: 2\n    blockOverRatio: 5\n",
      "utf8"
    );
    assert.equal(loadBudgetGuardPolicy(dir)?.version, 1);
    assert.equal(loadBudgetRebalancePolicy(dir)?.enabled, true);
    assert.equal(loadAutomationRules(dir)?.rules.length, 0);
    assert.equal(loadSubmissionGuardsPolicy(dir)?.guards.budgetIncrease.blockOverRatio, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
