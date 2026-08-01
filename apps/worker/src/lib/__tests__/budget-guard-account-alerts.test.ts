import test from "node:test";
import assert from "node:assert/strict";
import { resolveBudgetGuardPolicyForAccount } from "../budget-guard-runtime.js";
import type { BudgetGuardPolicy } from "@addroid/queue";

const COMMON: BudgetGuardPolicy = {
  alerts: {
    dailyBudgetAlertRatio: 0.8,
    monthlyPaceRatio: 1.0,
    dayOverDayRatio: 1.5,
    noConversionsSpendMin: 3000,
  },
};

test("account 側に alerts が無ければ共通値をそのまま使う", () => {
  assert.deepEqual(resolveBudgetGuardPolicyForAccount(COMMON, undefined), COMMON);
  assert.deepEqual(
    resolveBudgetGuardPolicyForAccount(COMMON, {
      dailyBudget: 0,
      monthlyBudget: 0,
    }),
    COMMON
  );
});

test("指定したキーだけを上書きし、他のキーは共通値のまま残る", () => {
  // まき先生: CV 単価が安いので CV=0 を早く鳴らしたい (共通3000 → 800)
  const resolved = resolveBudgetGuardPolicyForAccount(COMMON, {
    dailyBudget: 0,
    monthlyBudget: 0,
    alerts: { noConversionsSpendMin: 800 },
  });
  assert.equal(resolved.alerts.noConversionsSpendMin, 800);
  // 上書きしていないキーは共通値を維持する
  assert.equal(resolved.alerts.dayOverDayRatio, 1.5);
  assert.equal(resolved.alerts.dailyBudgetAlertRatio, 0.8);
  assert.equal(resolved.alerts.monthlyPaceRatio, 1.0);
});

test("共通ポリシーを破壊しない (別アカウントの解決に影響しない)", () => {
  const before = JSON.stringify(COMMON);
  resolveBudgetGuardPolicyForAccount(COMMON, {
    dailyBudget: 0,
    monthlyBudget: 0,
    alerts: { noConversionsSpendMin: 6000, dayOverDayRatio: 1.3 },
  });
  assert.equal(JSON.stringify(COMMON), before);
});

test("複数キーの同時上書きができる", () => {
  const resolved = resolveBudgetGuardPolicyForAccount(COMMON, {
    dailyBudget: 0,
    monthlyBudget: 0,
    alerts: { noConversionsSpendMin: 6000, dayOverDayRatio: 1.3 },
  });
  assert.equal(resolved.alerts.noConversionsSpendMin, 6000);
  assert.equal(resolved.alerts.dayOverDayRatio, 1.3);
  assert.equal(resolved.alerts.monthlyPaceRatio, 1.0);
});
