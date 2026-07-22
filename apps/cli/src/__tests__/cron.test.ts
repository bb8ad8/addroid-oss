// `addroid cron` のフラグ解釈と境界エラーを検証する。
// DB / pg-boss を起動しない範囲 (引数バリデーション、help、未知サブコマンド、
// 未知プリセット、DATABASE_URL 未設定) を扱う。

import test from "node:test";
import assert from "node:assert/strict";

import { runCronCommand, validateCronExpression } from "../commands/cron.js";

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture(
  fn: () => Promise<number>
): Promise<{ code: number; out: Captured }> {
  const out: Captured = { stdout: "", stderr: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    out.stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    out.stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function withoutDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
}

test("cron --help は Usage を出して 0 を返す", async () => {
  const { code, out } = await capture(() => runCronCommand(["--help"]));
  assert.equal(code, 0);
  assert.match(out.stdout, /addroid cron/);
  assert.match(out.stdout, /list \[--json\]/);
  assert.match(out.stdout, /enable\s+<name>/);
  assert.match(out.stdout, /disable\s+<name>/);
  assert.match(out.stdout, /set\s+<name>/);
  assert.match(out.stdout, /run\s+<name>/);
  assert.match(out.stdout, /--metric-date/);
  assert.match(out.stdout, /logs\s+<name>/);
  assert.match(out.stdout, /Internal read-only presets:/);
  assert.match(out.stdout, /github_poll/);
});

test("cron は引数なしで help を出して 2 を返す", async () => {
  const { code, out } = await capture(() => runCronCommand([]));
  assert.equal(code, 2);
  assert.match(out.stdout, /addroid cron/);
});

test("cron は未知のサブコマンドを 2 で拒否する", async () => {
  const { code, out } = await capture(() => runCronCommand(["bogus"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /未知のサブコマンド/);
});

test("cron list は DATABASE_URL 未設定で exit 2", async () => {
  await withoutDatabaseUrl(async () => {
    const { code, out } = await capture(() => runCronCommand(["list"]));
    assert.equal(code, 2);
    assert.match(out.stderr, /DATABASE_URL/);
  });
});

test("cron enable は <name> なしで exit 2", async () => {
  const { code, out } = await capture(() => runCronCommand(["enable"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /<name> が必要/);
});

test("cron enable は未知のプリセット名を exit 2 で拒否する", async () => {
  const { code, out } = await capture(() =>
    runCronCommand(["enable", "totally_unknown"])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /未知のプリセット名/);
  assert.match(out.stderr, /daily_report/);
  assert.match(out.stderr, /today_report/);
  assert.match(out.stderr, /improvement_pr/);
});

test("cron enable は内部管理 github_poll を拒否する", async () => {
  await withoutDatabaseUrl(async () => {
    const { code, out } = await capture(() =>
      runCronCommand(["enable", "github_poll"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /未知のプリセット名/);
    assert.doesNotMatch(out.stderr, /DATABASE_URL/);
  });
});

test("cron disable は未知のプリセット名を exit 2 で拒否する", async () => {
  const { code, out } = await capture(() =>
    runCronCommand(["disable", "totally_unknown"])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /未知のプリセット名/);
});

test("cron set は cron 式が無いと exit 2", async () => {
  const { code, out } = await capture(() =>
    runCronCommand(["set", "daily_report"])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /<cron-expression> が必要/);
});

test("cron run は <name> なしで exit 2", async () => {
  const { code, out } = await capture(() => runCronCommand(["run"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /<name> が必要/);
});

test("cron run は未知のプリセット名を exit 2 で拒否する", async () => {
  const { code, out } = await capture(() =>
    runCronCommand(["run", "totally_unknown"])
  );
  assert.equal(code, 2);
  assert.match(out.stderr, /未知のプリセット名/);
});

test("cron run は metric-date-relative の不正値を DB 起動前に拒否する", async () => {
  await withoutDatabaseUrl(async () => {
    const { code, out } = await capture(() =>
      runCronCommand(["run", "daily_report", "--metric-date-relative", "tomorrow"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /today \/ yesterday/);
    assert.doesNotMatch(out.stderr, /DATABASE_URL/);
  });
});

test("cron logs は <name> なしで exit 2", async () => {
  const { code, out } = await capture(() => runCronCommand(["logs"]));
  assert.equal(code, 2);
  assert.match(out.stderr, /<name> が必要/);
});

test("cron logs は --limit に正の整数以外を渡すと exit 2", async () => {
  const { code, out } = await capture(() =>
    runCronCommand(["logs", "daily_report", "--limit", "-3"])
  );
  // -3 は parseNameArg ではなくサブコマンド側で reject される (DATABASE_URL チェックの前)
  // ことを担保するため、DATABASE_URL あり / なしで挙動が変わらないことを確認する。
  // ここでは DATABASE_URL の有無に関わらず最終的に 2 になることを期待する。
  assert.equal(code, 2);
  assert.ok(out.stderr.length > 0);
});

test("cron logs は内部管理 github_poll をログ参照対象として受け付ける", async () => {
  await withoutDatabaseUrl(async () => {
    const { code, out } = await capture(() =>
      runCronCommand(["logs", "github_poll", "--limit", "-3"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /--limit は正の整数/);
    assert.doesNotMatch(out.stderr, /未知のプリセット名/);
    assert.doesNotMatch(out.stderr, /DATABASE_URL/);
  });
});

test("cron set は parse 時点で 5 フィールドでない cron 式を 2 で拒否する (DB 不要)", async () => {
  // validateCronExpression は parseSet 内で呼ばれるため、DATABASE_URL の有無に
  // かかわらず DB / pg-boss を起動する前に exit 2 になることを担保する。
  await withoutDatabaseUrl(async () => {
    const { code, out } = await capture(() =>
      runCronCommand(["set", "daily_report", "not", "valid"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /cron 式が不正/);
    // DATABASE_URL チェックより前で reject されることを担保する。
    assert.doesNotMatch(out.stderr, /DATABASE_URL/);
  });
});

test("cron set は範囲外 cron 式を 2 で拒否する (DB 不要)", async () => {
  await withoutDatabaseUrl(async () => {
    // 60 分は分フィールドの 0-59 を超える。
    const { code, out } = await capture(() =>
      runCronCommand(["set", "daily_report", "60", "*", "*", "*", "*"])
    );
    assert.equal(code, 2);
    assert.match(out.stderr, /cron 式が不正/);
    assert.match(out.stderr, /minute/);
    assert.doesNotMatch(out.stderr, /DATABASE_URL/);
  });
});

test("validateCronExpression は典型的な有効式を受理する", () => {
  const valid = [
    "* * * * *",
    "30 9 * * *",
    "*/15 * * * *",
    "0 10 * * 1",
    "0,15,30,45 * * * *",
    "0 9-17 * * 1-5",
    "0 0 1 JAN MON",
    "0 0 1 jan sun",
    "15 3 * * *",
    "*/2 * * * *",
    "0 0 * * 7", // dow=7 は日曜として許容
    "0-30/5 * * * *",
  ];
  for (const expr of valid) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, true, `expected valid: ${expr} (got: ${"reason" in r ? r.reason : ""})`);
  }
});

test("validateCronExpression はフィールド数が違う式を拒否する", () => {
  const invalid = ["", "   ", "*", "* *", "* * *", "* * * *", "* * * * * *", "not valid"];
  for (const expr of invalid) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, false, `expected invalid: ${JSON.stringify(expr)}`);
  }
});

test("validateCronExpression は範囲外の値を拒否する", () => {
  const cases: Array<[string, RegExp]> = [
    ["60 * * * *", /minute/],
    ["* 24 * * *", /hour/],
    ["* * 32 * *", /day-of-month/],
    ["* * 0 * *", /day-of-month/], // dom は 1 始まり
    ["* * * 13 *", /month/],
    ["* * * 0 *", /month/], // month は 1 始まり
    ["* * * * 8", /day-of-week/],
    ["10-5 * * * *", /逆順/],
    ["* * * * BOG", /day-of-week/],
    ["* * * BOG *", /month/],
  ];
  for (const [expr, pattern] of cases) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, false, `expected invalid: ${expr}`);
    if (!r.ok) {
      assert.match(r.reason, pattern, `expected reason match for: ${expr}`);
    }
  }
});

test("validateCronExpression は不正なステップ表記を拒否する", () => {
  const invalid = [
    "*/0 * * * *",   // step が 0
    "*/abc * * * *", // step が非整数
    "*/  * * * *",   // step が空
    "/5 * * * *",    // body が空
    "*/-5 * * * *",  // 負の step
    "*/100 * * * *", // 範囲外の step
  ];
  for (const expr of invalid) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, false, `expected invalid: ${expr}`);
  }
});

test("validateCronExpression は空のリスト要素を拒否する", () => {
  const invalid = [",1 * * * *", "1, * * * *", "1,,2 * * * *"];
  for (const expr of invalid) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, false, `expected invalid: ${expr}`);
  }
});
