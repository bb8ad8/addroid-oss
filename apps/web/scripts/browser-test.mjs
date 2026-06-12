#!/usr/bin/env node
// AdDroid OSS — local Web UI browser test (Regression fix).
//
// 目的: the current implementation の受入基準が要求する Web UI surface を localhost-only な
// Next.js dev server から、可能なかぎり実ブラウザでも検証する。
//
// 本スクリプトは三段で構成される:
//   1) HTTP-level smoke (SCENARIOS) — 各 SSR ルートが 200 で返り、必要な
//      文字列と SideNav リンクが揃っていること。
//   2) HTTP-level interactions (INTERACTIONS) — Web UI のクライアント
//      コントロール (MergePrButton / CronControls) が叩く API endpoint が
//      validation error を 4xx で返し 5xx でクラッシュしないこと。
//   3) Browser-level interactions (BROWSER_FLOWS, regression fix) — 実際の
//      Chromium プロセスを CDP 経由で立ち上げ、DOM をクリックして以下を確認:
//        - /approvals に永続化済の pending PR が表示されること。
//        - /approvals/[prNumber] が PR body と変更ファイル/diff プレビューを
//          実状態から描画すること (regression fix finding #2)。
//        - /approvals/[prNumber] の "承認して反映待ちにする" ボタンが
//          ConfirmDialog (caution) を開き、確定時に /api/approvals/.../merge を
//          呼び、結果 (この test fixture では workspace に紐付かないため 4xx)
//          を Toast で表示すること (regression fix finding #3)。
//        - /cron 行内の ON/OFF・時間編集・今すぐ実行 が、ConfirmDialog →
//          API → Toast 完結まで実ブラウザ操作で動くこと (regression fix
//          finding #3)。
//
// 設計方針:
//   * 追加 npm dependency を持ち込まない。Chrome は OS にインストール済の
//     ものを spawn し、CDP は Node 22+ の built-in WebSocket で直接話す。
//   * Chrome / DB は browser verification の前提条件。どちらかが欠けると
//     既定では browser-level 段を **fail** させ、release verification は通らない。
//     明示的な escape hatch として ADDROID_BROWSER_TEST_OPT_OUT=
//     <reason> を環境変数で設定すると skipped に降格できる (CI の typecheck-
//     only stage 等の用途に限る)。降格は loud にログへ記録する。
//   * fixture は決して production-shaped ではない PR# (7777777) と
//     repo (addroid-browser-fixture) を使い、テスト後に必ず削除する。
//   * cron 操作は副作用最小の `github_poll` プリセットを対象に、(a) cron 式を
//     一度書き換えて元に戻す、(b) toggle を片道テストし元に戻す、(c) 今すぐ
//     実行は queue に enqueue するだけで github_poll は AI コスト/PR 作成を
//     伴わないので安全。
//
// 実行: `npm run test:browser` (apps/web から) または リポジトリ root から。
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_APP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEB_APP_DIR, "..", "..");

// regression fix: 子の `next dev` と (browser-flow 用に直接 import する)
// PrismaClient の双方が DATABASE_URL を読み出せるよう、リポジトリ root の
// `.env.local` を起動時に process.env へ反映する。Next.js は cwd から
// `.env.local` を探す挙動なので、cwd=apps/web で起動するとこれを読まない。
// それを回避するため、この test runner 自身が `.env.local` を載せる。
for (const candidate of [
  path.join(REPO_ROOT, ".env.local"),
  path.join(REPO_ROOT, ".env"),
]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      /* ファイルが壊れていても test runner 自身は継続させる */
    }
  }
}

const HOSTNAME = process.env.ADDROID_BROWSER_TEST_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ADDROID_BROWSER_TEST_PORT ?? 3100);
const BASE_URL = `http://${HOSTNAME}:${PORT}`;
const HEALTH_TIMEOUT_MS = Number(
  process.env.ADDROID_BROWSER_TEST_BOOT_TIMEOUT_MS ?? 90_000
);
const REQUEST_TIMEOUT_MS = 15_000;

// regression fix: PR fixture を識別するための高位レンジ番号。実 GitHub から
// 同 PR# が降ってくる確率は実質ゼロ (このリポジトリではまだ #1000 にも届かない)。
const FIXTURE_PR_NUMBER = 7_777_777;
const FIXTURE_REPO_OWNER = "addroid-test";
const FIXTURE_REPO_NAME = "addroid-browser-fixture";
const FIXTURE_CREATIVE_ID = "browser-preview-creative";
const FIXTURE_ACCOUNT_KEY = "browser-preview";

// SideNav が描画する全リンク先。これらは layout 経由で全ページに含まれる
// はずなので、欠けていれば「nav が壊れている」と判定する。
// 並びは apps/web/components/SideNav.tsx の `groups` と同じグループ順
// (全体 / 広告運用 / 改善 / 確認と自動化 / 設定) に揃える。
const REQUIRED_NAV_HREFS = [
  "/",
  "/accounts",
  "/reports/daily",
  "/budget",
  "/guards",
  "/plans",
  "/campaigns",
  "/improvements",
  "/creatives",
  "/approvals",
  "/cron",
  "/cron/runs",
  "/cron/audit",
  "/github",
  "/setup",
];

// 各シナリオ: URL ごとに「最低限ページに含まれているべき文字列」を 1 つ以上指定。
// SSR で出力される PageHeader タイトルや panel タイトルなど、機械的に検証可能な
// 文字列だけを使う。
// 各ページに含まれているはずの文字列。HTML エンティティ化されないように
// "&" のような文字を含む文字列は避ける。
const SCENARIOS = [
  {
    id: "dashboard-status",
    url: "/",
    expectContains: ["ホーム", "保存先", "自動実行", "承認待ち", "日次レポート"],
  },
  {
    id: "accounts-meta-oauth",
    url: "/accounts",
    expectContains: ["広告アカウント", "Meta 連携", "利用する広告アカウント"],
  },
  {
    id: "submission-guards",
    url: "/guards",
    expectContains: ["安全ガード", "予算変更", "警告"],
  },
  {
    id: "plans-adhoc-dry-run",
    url: "/plans",
    // PageHeader title + 2 つの Panel title (今すぐチェック / チェック履歴) は
    // DB 接続状態に関わらず常に SSR される (Panel 内が EmptyState でも header は出る)。
    expectContains: ["入稿前チェック", "今すぐチェック", "チェック履歴"],
  },
  {
    id: "campaigns-apply-activate",
    url: "/campaigns",
    // 安全ルール Panel は条件分岐の外で常に描画される。
    // "最近の反映処理" Panel も同様 (中身が EmptyState でも header は出る)。
    expectContains: ["配信中の広告", "反映と有効化の安全ルール", "最近の反映処理"],
  },
  {
    id: "improvements-workflow",
    url: "/improvements",
    // PageHeader title + 自動実行 Panel (常時描画) + 安全ルール note (常時描画)。
    expectContains: ["改善提案", "自動実行の状態", "安全ルール"],
  },
  {
    id: "creatives-library",
    url: "/creatives",
    // PageHeader title (生成クリエイティブ) + クリエイティブ一覧 Panel header。
    // どちらも DB / 画像 Provider の状態に関わらず常に SSR される。
    expectContains: ["生成クリエイティブ", "クリエイティブ一覧"],
  },
  {
    id: "github-pr-tracking",
    url: "/github",
    expectContains: ["GitHub 連携", "接続状態", "変更管理リポジトリ"],
  },
  {
    id: "approvals-list",
    url: "/approvals",
    // PR が無くても empty state ("マージ待ちの PR はありません。") が出る。
    expectContains: ["承認待ち", "マージ待ち", "最近承認した変更"],
  },
  {
    id: "cron-schedules",
    // SSR 上で行内コントロール (ON/OFF・時間編集・今すぐ実行) が描画されることを
    // 確認する。preset は無条件で 5 件以上 mount されるはずなので、ボタンラベルが
    // 1 つでも見えなければ controls が壊れている。
    url: "/cron",
    expectContains: [
      "自動実行",
      "承認済み変更の確認",
      "今すぐ実行",
      "時間を編集",
    ],
  },
  {
    id: "cron-runs",
    url: "/cron/runs",
    expectContains: ["実行履歴", "自動実行の履歴"],
  },
  {
    id: "cron-audit",
    url: "/cron/audit",
    expectContains: ["操作履歴", "操作イベント"],
  },
  {
    id: "reports-daily-kpi",
    url: "/reports/daily",
    expectContains: [
      "日次レポート",
      "最新レポート",
      "保存された成果データ",
    ],
  },
  {
    id: "setup-docs-security-slack",
    url: "/setup",
    expectContains: [
      "接続と健康状態",
      "安全設定",
      "外部からの着信を使わない",
      "Slack 連携 (任意)",
      "Slack 側でアプリを作り",
      "OPTIONAL",
    ],
  },
];

// HTML に「壊れたエラーページ」のシグネチャが現れていないか確認する。
// 注意: Next.js App Router は健康なページの RSC payload にも
// 既定の `NotFound` コンポーネント ("This page could not be found") を
// 埋め込むため、これを broken marker にしてはいけない。実際の 404 は
// HTTP status 404 で返るので res.ok チェックで捕える。
const BROKEN_MARKERS = [
  "Application error: a server-side exception",
  "表示中にエラーが発生しました",
];

const INTERACTIONS = [
  {
    id: "approvals-detail-non-existent-pr",
    method: "GET",
    url: "/approvals/99999999",
    expectStatus: 404,
    note: "存在しない PR# は notFound() で 404 (5xx クラッシュではない)",
  },
  {
    id: "approvals-merge-invalid-pr-number",
    method: "POST",
    url: "/api/approvals/0/merge",
    headers: {
      "X-AdDroid-Web-Action": "1",
      Origin: BASE_URL,
    },
    body: { expectedHeadSha: "deadbeefcafebabefeedfaceabad1dea12345678" },
    expectStatus: 400,
    expectJsonOkFalse: true,
    note: "Web UI Merge API は PR#=0 を 400 で拒否",
  },
  {
    id: "cron-toggle-unknown-preset",
    method: "POST",
    url: "/api/cron/__unknown_preset__/toggle",
    body: { enabled: true },
    expectStatus: 400,
    expectJsonOkFalse: true,
    note: "Cron toggle API は未知の preset を 400 で拒否 (CronControls の ON/OFF)",
  },
  {
    id: "cron-schedule-unknown-preset",
    method: "POST",
    url: "/api/cron/__unknown_preset__/schedule",
    body: { cron: "0 0 * * *" },
    expectStatus: 400,
    expectJsonOkFalse: true,
    note: "Cron schedule API は未知の preset を 400 で拒否 (CronControls の時間編集)",
  },
  {
    id: "cron-run-unknown-preset",
    method: "POST",
    url: "/api/cron/__unknown_preset__/run",
    body: {},
    expectStatus: 400,
    expectJsonOkFalse: true,
    note: "Cron run API は未知の preset を 400 で拒否 (CronControls の 今すぐ実行)",
  },
  {
    id: "cron-toggle-missing-enabled-field",
    method: "POST",
    url: "/api/cron/daily_report/toggle",
    body: {},
    expectStatus: 400,
    expectJsonOkFalse: true,
    note: "Cron toggle API は { enabled: boolean } 必須を 400 で強制",
  },
  {
    id: "cron-schedule-missing-cron-field",
    method: "POST",
    url: "/api/cron/daily_report/schedule",
    body: {},
    expectStatus: 400,
    expectJsonOkFalse: true,
    note: "Cron schedule API は { cron: string } 必須を 400 で強制",
  },
];

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function isServerUp(baseUrl) {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/health`, { timeoutMs: 2_000 });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(baseUrl, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isServerUp(baseUrl)) return true;
    await delay(1_000);
  }
  return false;
}

function resolveBrowserTestStoragePath(key) {
  const root = path.join(
    process.env.ADDROID_HOME?.trim()
      ? path.resolve(process.env.ADDROID_HOME.trim())
      : path.join(process.env.HOME ?? process.cwd(), ".addroid"),
    "storage",
  );
  const normalized = path.posix.normalize(String(key).replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(`invalid browser-test storage key: ${key}`);
  }
  const abs = path.resolve(root, normalized);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`browser-test storage key escapes root: ${key}`);
  }
  return abs;
}

function writeBrowserTestStorage(key, data) {
  const abs = resolveBrowserTestStoragePath(key);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data, { mode: 0o600 });
}

function startServer() {
  const nextBin = path.join(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next"
  );
  const child = spawn(
    nextBin,
    ["dev", "--webpack", "--hostname", HOSTNAME, "--port", String(PORT)],
    {
      cwd: WEB_APP_DIR,
      env: { ...process.env, BROWSER: "none", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout.on("data", (chunk) => {
    process.stderr.write(`[next dev] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[next dev] ${chunk}`);
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 10; i++) {
    if (child.exitCode != null) return;
    await delay(300);
  }
  if (child.exitCode == null) child.kill("SIGKILL");
}

function findFailures(html, scenario) {
  const failures = [];
  for (const marker of BROKEN_MARKERS) {
    if (html.includes(marker)) {
      failures.push(`broken page marker present: "${marker}"`);
    }
  }
  for (const needle of scenario.expectContains) {
    if (!html.includes(needle)) {
      failures.push(`expected content not found: "${needle}"`);
    }
  }
  for (const href of REQUIRED_NAV_HREFS) {
    const literal = `href="${href}"`;
    if (!html.includes(literal)) {
      failures.push(`primary nav link missing: ${href}`);
    }
  }
  return failures;
}

async function runScenarios() {
  let pass = 0;
  let fail = 0;
  const failedDetails = [];
  for (const scenario of SCENARIOS) {
    const url = `${BASE_URL}${scenario.url}`;
    const label = `${scenario.id} (${scenario.url})`;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        fail += 1;
        failedDetails.push({ label, reason: `HTTP ${res.status}` });
        console.error(`FAIL ${label}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const failures = findFailures(html, scenario);
      if (failures.length > 0) {
        fail += 1;
        failedDetails.push({ label, reason: failures.join("; ") });
        console.error(`FAIL ${label}: ${failures.join("; ")}`);
      } else {
        pass += 1;
        console.log(`PASS ${label}`);
      }
    } catch (err) {
      fail += 1;
      const reason = err instanceof Error ? err.message : String(err);
      failedDetails.push({ label, reason });
      console.error(`FAIL ${label}: ${reason}`);
    }
  }
  return { pass, fail, failedDetails };
}

async function runInteractions() {
  let pass = 0;
  let fail = 0;
  const failedDetails = [];
  for (const interaction of INTERACTIONS) {
    const url = `${BASE_URL}${interaction.url}`;
    const label = `${interaction.id} (${interaction.method} ${interaction.url})`;
    try {
      /** @type {RequestInit & { timeoutMs?: number }} */
      const init = { method: interaction.method };
      if (interaction.headers !== undefined) {
        init.headers = { ...interaction.headers };
      }
      if (interaction.method !== "GET") {
        init.headers = {
          "X-AdDroid-Web-Action": "1",
          Origin: BASE_URL,
          ...(init.headers ?? {}),
        };
      }
      if (interaction.body !== undefined) {
        init.headers = { ...(init.headers ?? {}), "Content-Type": "application/json" };
        init.body = JSON.stringify(interaction.body);
      }
      const res = await fetchWithTimeout(url, init);
      const reasons = [];
      if (typeof interaction.expectStatus === "number" && res.status !== interaction.expectStatus) {
        reasons.push(`expected HTTP ${interaction.expectStatus} but got ${res.status}`);
      }
      if (res.status >= 500) {
        reasons.push(`5xx response: HTTP ${res.status}`);
      }
      if (interaction.expectJsonOkFalse) {
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          reasons.push(`expected JSON body but Content-Type is "${ct}"`);
        } else {
          let parsed;
          try {
            parsed = await res.clone().json();
          } catch (err) {
            reasons.push(
              `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          if (parsed !== undefined) {
            if (parsed === null || typeof parsed !== "object" || parsed.ok !== false) {
              reasons.push(`expected body { ok: false, ... } but got ${JSON.stringify(parsed)}`);
            }
          }
        }
      }
      if (reasons.length > 0) {
        fail += 1;
        failedDetails.push({ label, reason: reasons.join("; ") });
        console.error(`FAIL ${label}: ${reasons.join("; ")}`);
      } else {
        pass += 1;
        console.log(`PASS ${label} — ${interaction.note}`);
      }
    } catch (err) {
      fail += 1;
      const reason = err instanceof Error ? err.message : String(err);
      failedDetails.push({ label, reason });
      console.error(`FAIL ${label}: ${reason}`);
    }
  }
  return { pass, fail, failedDetails };
}

// =====================================================================
// Browser-level interactions (regression fix)
//
// 以下、Chrome を spawn して CDP 経由で driver する一式。npm dep は追加せず、
// Node 22+ の built-in WebSocket だけで CDP 上のメソッドを呼ぶ。
// =====================================================================

const CHROME_CANDIDATES = (() => {
  const candidates = [];
  if (process.env.ADDROID_BROWSER_TEST_CHROME) {
    candidates.push(process.env.ADDROID_BROWSER_TEST_CHROME);
  }
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    );
  }
  return candidates;
})();

function locateChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> { pending: Map }
    this.eventListeners = new Map();
    ws.addEventListener("message", (ev) => this._onMessage(ev));
  }
  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (msg.id != null) {
      const sessionPending = msg.sessionId
        ? this.sessions.get(msg.sessionId)?.pending
        : this.pending;
      const entry = sessionPending?.get(msg.id);
      if (entry) {
        sessionPending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`CDP ${entry.method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) {
      const listeners = this.eventListeners.get(msg.method);
      if (listeners) {
        for (const cb of listeners) cb(msg.params, msg.sessionId);
      }
    }
  }
  on(method, cb) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, new Set());
    this.eventListeners.get(method).add(cb);
    return () => this.eventListeners.get(method)?.delete(cb);
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = sessionId
      ? { id, method, params, sessionId }
      : { id, method, params };
    return new Promise((resolve, reject) => {
      const pending = sessionId
        ? this.sessions.get(sessionId).pending
        : this.pending;
      pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }
  registerSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { pending: new Map() });
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function launchChrome() {
  const bin = locateChrome();
  if (!bin) {
    return { ok: false, reason: "Chrome binary not found" };
  }
  const userDataDir = mkdtempSync(path.join(tmpdir(), "addroid-browser-test-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LANG: "C.UTF-8" },
  });
  // Chrome は stderr に "DevTools listening on ws://..." を吐く。
  let wsUrl = null;
  const wsPromise = new Promise((resolve, reject) => {
    const onLine = (line) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line);
      if (match) {
        wsUrl = match[1];
        resolve(wsUrl);
      }
    };
    let buf = "";
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!wsUrl) reject(new Error(`Chrome exited (code=${code}) before announcing CDP endpoint`));
    });
    setTimeout(() => {
      if (!wsUrl) reject(new Error("Timed out waiting for Chrome CDP endpoint"));
    }, 30_000);
  });
  let url;
  try {
    url = await wsPromise;
  } catch (err) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    rmSync(userDataDir, { recursive: true, force: true });
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    child,
    wsUrl: url,
    cleanup: async () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      for (let i = 0; i < 20; i++) {
        if (child.exitCode != null) break;
        await delay(150);
      }
      if (child.exitCode == null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

async function attachCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(undefined), { once: true });
    ws.addEventListener("error", (ev) => reject(ev.error ?? new Error("WebSocket error")), { once: true });
  });
  return new CdpClient(ws);
}

class Page {
  constructor(client, sessionId) {
    this.client = client;
    this.sessionId = sessionId;
  }
  send(method, params) {
    return this.client.send(method, params, this.sessionId);
  }
  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitForLoad();
  }
  async waitForLoad(timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ev = await this.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (ev.result?.value === "complete") return;
      await delay(100);
    }
    throw new Error(`Page did not finish loading within ${timeoutMs}ms`);
  }
  async eval(expression, timeoutMs = 10_000) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    });
    if (r.exceptionDetails) {
      const text =
        r.exceptionDetails.exception?.description ??
        r.exceptionDetails.text ??
        "Runtime.evaluate exception";
      throw new Error(`page.eval failed: ${text}`);
    }
    return r.result?.value;
  }
  async waitFor(predicateExpr, { timeoutMs = 10_000, intervalMs = 150 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.eval(`return Boolean(${predicateExpr});`);
      if (ok) return true;
      await delay(intervalMs);
    }
    throw new Error(`waitFor timed out: ${predicateExpr}`);
  }
}

async function openPage(cdp, baseUrl) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const session = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  cdp.registerSession(session.sessionId);
  const page = new Page(cdp, session.sessionId);
  await page.send("Page.enable", {});
  await page.send("Runtime.enable", {});
  await page.send("Network.enable", {});
  page.targetId = target.targetId;
  page.baseUrl = baseUrl;
  return page;
}

// =====================================================================
// Prisma fixture utilities
//
// regression fix finding #2: /approvals が seed 済 PR を表示し、
//   /approvals/[prNumber] が body と file diff サマリを描画する状態を
//   実ブラウザで検証するため、fixture を Prisma で投入し、テスト後に
//   削除する。
// =====================================================================

async function loadPrisma() {
  try {
    const mod = await import("@prisma/client");
    const PrismaClient = mod.PrismaClient ?? mod.default?.PrismaClient;
    if (!PrismaClient) {
      return { ok: false, reason: "PrismaClient export not found" };
    }
    const prisma = new PrismaClient({ log: ["warn", "error"] });
    // 軽い疎通: workspaces のカウント。schema が無ければ throw。
    await prisma.workspace.count();
    return { ok: true, prisma };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
}

async function seedPrFixture(prisma) {
  // 既存 fixture が残っていれば削除 (前回テストの中断対策)。
  await cleanupPrFixture(prisma);
  const workspace =
    (await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true, opsRepoId: true },
    })) ??
    (await prisma.workspace.create({
      data: {
        slug: "browser-test",
        displayName: "Browser Test",
        configPath: "browser-test",
        storageDir: "browser-test",
        databaseUrlRef: "DATABASE_URL",
      },
      select: { id: true, opsRepoId: true },
    }));
  const repo = await prisma.githubRepo.create({
    data: {
      owner: FIXTURE_REPO_OWNER,
      name: FIXTURE_REPO_NAME,
      defaultBranch: "main",
    },
  });
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { opsRepoId: repo.id },
  });
  const pr = await prisma.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: FIXTURE_PR_NUMBER,
      title: "[regression fix] browser-test fixture PR",
      state: "open",
      headSha: "deadbeefcafebabefeedfaceabad1dea12345678",
      baseRef: "main",
      htmlUrl: "https://example.invalid/addroid-test/pull/7777777",
      body:
        "# regression fix fixture body\n\n" +
        "This PR body is seeded by `apps/web/scripts/browser-test.mjs` to exercise " +
        "/approvals/[prNumber] body + file diff rendering through a real browser.\n\n" +
        "Linked: ai_run=fixture-ai-run, improvement_pr=fixture-improvement.\n",
      filesChangedJson: {
        files: [
          {
            path: "config/fixture-target.yaml",
            action: "update",
            diffPreview:
              "@@ -1,3 +1,3 @@\n daily_budget_jpy: 1000\n-objective: REACH\n+objective: TRAFFIC\n status: PAUSED\n",
            diffTruncated: false,
            diffByteLength: 110,
            additions: 1,
            deletions: 1,
          },
          {
            path: "config/fixture-new.yaml",
            action: "create",
            diffPreview:
              "@@ -0,0 +1,3 @@\n+name: browser-fixture\n+enabled: true\n+notes: fixture\n",
            diffTruncated: false,
            diffByteLength: 64,
            additions: 3,
            deletions: 0,
          },
        ],
        truncatedFileCount: 0,
        totalFileCount: 2,
      },
      filesChangedCount: 2,
      previewSource: "improvement_pr",
      previewUpdatedAt: new Date(),
    },
  });
  const account = await prisma.adAccount.upsert({
    where: {
      workspaceId_key: { workspaceId: workspace.id, key: FIXTURE_ACCOUNT_KEY },
    },
    create: {
      workspaceId: workspace.id,
      key: FIXTURE_ACCOUNT_KEY,
      displayName: "Browser Preview Account",
      metaAccountId: "act_browser_preview",
      currency: "JPY",
      timezoneName: "Asia/Tokyo",
    },
    update: {
      displayName: "Browser Preview Account",
      active: true,
    },
  });
  const baseKey = `creatives/${FIXTURE_ACCOUNT_KEY}/${FIXTURE_CREATIVE_ID}`;
  const assetKey = `${baseKey}/asset_square.png`;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );
  writeBrowserTestStorage(assetKey, png);
  writeBrowserTestStorage(
    `${baseKey}/metadata.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        creativeId: FIXTURE_CREATIVE_ID,
        accountKey: FIXTURE_ACCOUNT_KEY,
        storageRef: `storage://${baseKey}`,
        createdAt: new Date().toISOString(),
        provider: "mock",
        model: "browser-test",
        prompt: "browser preview fixture",
        generatedAt: new Date().toISOString(),
        requestId: null,
        variantCount: 1,
        parameters: {
          purpose: "browser-test",
          variationConditions: [
            { width: 1080, height: 1080, format: "png", variantKey: "square" },
          ],
        },
        costUsd: 0,
        assets: [
          {
            variantKey: "square",
            assetId: "asset_aaaaaaaaaaaa",
            filename: "asset_square.png",
            storageRef: `storage://${assetKey}`,
            mimeType: "image/png",
            width: 1080,
            height: 1080,
            byteSize: png.byteLength,
            qaOverall: "qa_passed",
          },
        ],
        qa: {
          overall: "qa_passed",
          passingCount: 1,
          failingCount: 0,
          assets: [],
        },
        links: { pullRequestNumber: FIXTURE_PR_NUMBER },
      },
      null,
      2,
    ),
  );
  await prisma.creative.upsert({
    where: {
      accountId_key: { accountId: account.id, key: FIXTURE_CREATIVE_ID },
    },
    create: {
      id: FIXTURE_CREATIVE_ID,
      accountId: account.id,
      pullRequestId: pr.id,
      key: FIXTURE_CREATIVE_ID,
      displayName: "Browser Preview Creative",
      mediaType: "image",
      status: "qa_passed",
      provider: "mock",
      model: "browser-test",
      parameters: {
        purpose: "browser-test",
        variationConditions: [
          { width: 1080, height: 1080, format: "png", variantKey: "square" },
        ],
      },
      storagePath: assetKey,
      storageRef: `storage://${baseKey}`,
      spec: {},
    },
    update: {
      pullRequestId: pr.id,
      status: "qa_passed",
      storagePath: assetKey,
      storageRef: `storage://${baseKey}`,
      spec: {},
    },
  });
  return {
    repo,
    pr,
    workspaceId: workspace.id,
    previousOpsRepoId: workspace.opsRepoId,
    accountId: account.id,
    creativeId: FIXTURE_CREATIVE_ID,
  };
}

async function cleanupPrFixture(prisma, fixture = null) {
  // approval_records / apply_jobs は cascade で削除されるが、fixture 自体は明示的に消す。
  const repo = await prisma.githubRepo
    .findUnique({
      where: { owner_name: { owner: FIXTURE_REPO_OWNER, name: FIXTURE_REPO_NAME } },
      select: { id: true },
    })
    .catch(() => null);
  if (!repo) return;
  if (fixture?.workspaceId) {
    await prisma.workspace
      .update({
        where: { id: fixture.workspaceId },
        data: { opsRepoId: fixture.previousOpsRepoId ?? null },
      })
      .catch(() => undefined);
  } else {
    await prisma.workspace
      .updateMany({ where: { opsRepoId: repo.id }, data: { opsRepoId: null } })
      .catch(() => undefined);
  }
  await prisma.githubPullRequest
    .deleteMany({ where: { repoId: repo.id } })
    .catch(() => undefined);
  await prisma.adAccount
    .deleteMany({
      where: { key: FIXTURE_ACCOUNT_KEY },
    })
    .catch(() => undefined);
  await prisma.githubRepo
    .delete({ where: { id: repo.id } })
    .catch(() => undefined);
}

/**
 * Cron 行へのブラウザ操作 (toggle / schedule edit / run-now) は test 環境で
 * pg-boss queue 未初期化によって success/error が混在する。意図せずテスト
 * 後に github_poll の cron_schedules.enabled / cron が変わってしまうのを
 * 防ぐため、テスト前のスナップショットを取り、テスト後に DB レベルで
 * 復元する。スナップショットが取れない (= row が無い) 場合は何もしない。
 */
async function snapshotGithubPollSchedule(prisma) {
  return await prisma.cronSchedule
    .findFirst({
      where: { name: "github_poll" },
      select: { workspaceId: true, cron: true, enabled: true },
    })
    .catch(() => null);
}

async function restoreGithubPollSchedule(prisma, snapshot) {
  if (!snapshot) return;
  await prisma.cronSchedule
    .updateMany({
      where: { workspaceId: snapshot.workspaceId, name: "github_poll" },
      data: { enabled: snapshot.enabled, cron: snapshot.cron },
    })
    .catch(() => undefined);
}

// =====================================================================
// Browser flows
// =====================================================================

/**
 * 共通: クリック対象ボタンを「テキストで検索 → click」する。Toast / dialog
 * の状態を JS 側で確認できるよう、すべて page.eval 内に閉じ込める。
 */
const HELPER_FNS = `
  function findButtonByText(text, root) {
    const r = root ?? document;
    const buttons = Array.from(r.querySelectorAll("button"));
    return buttons.find((b) => (b.textContent || "").trim().includes(text)) || null;
  }
  function findRowByCellText(cellText) {
    const rows = Array.from(document.querySelectorAll("tr"));
    return rows.find((row) =>
      Array.from(row.querySelectorAll("td")).some((td) =>
        (td.textContent || "").trim() === cellText
      )
    ) || null;
  }
  function getOpenDialog() {
    return document.querySelector("[role='dialog']");
  }
  function getLatestToast(variant) {
    const toasts = Array.from(document.querySelectorAll(".toast"));
    if (toasts.length === 0) return null;
    if (variant) {
      const filtered = toasts.filter((t) => t.dataset.variant === variant);
      return filtered[filtered.length - 1] || null;
    }
    return toasts[toasts.length - 1];
  }
`;

async function browserFlowApprovals(page, recordResult) {
  // 1) /approvals に fixture PR が表示されること。
  await page.navigate(`${page.baseUrl}/approvals`);
  await page.eval(`${HELPER_FNS}`); // load helpers (no-op other than scope check)
  const seen = await page.eval(`
    ${HELPER_FNS}
    return Array.from(document.querySelectorAll("a"))
      .some(a => (a.getAttribute("href") || "") === "/approvals/${FIXTURE_PR_NUMBER}");
  `);
  recordResult("browser-approvals-list-shows-seeded-pr", seen,
    `/approvals に PR #${FIXTURE_PR_NUMBER} のリンクが見つかりません`);

  // 2) /approvals/[prNumber] が body と file path / diff を描画すること。
  await page.navigate(`${page.baseUrl}/approvals/${FIXTURE_PR_NUMBER}`);
  const detailRender = await page.eval(`
    ${HELPER_FNS}
    const text = document.body.innerText || "";
    return {
      hasTitle: text.includes("[regression fix] browser-test fixture PR"),
      hasBodyPanel: text.includes("変更内容の説明"),
      hasBodyExcerpt: text.includes("regression fix fixture body"),
      hasFilesPanel: text.includes("変更ファイル一覧"),
      hasFixturePathA: text.includes("config/fixture-target.yaml"),
      hasFixturePathB: text.includes("config/fixture-new.yaml"),
      hasMergeButton: !!findButtonByText("承認して反映待ちにする"),
    };
  `);
  recordResult("browser-approvals-detail-renders-title", detailRender.hasTitle, "PR title が描画されていません");
  recordResult("browser-approvals-detail-renders-body-panel", detailRender.hasBodyPanel, "PR 本文 panel が描画されていません");
  recordResult("browser-approvals-detail-renders-body-excerpt", detailRender.hasBodyExcerpt, "PR body 本文が描画されていません");
  recordResult("browser-approvals-detail-renders-files-panel", detailRender.hasFilesPanel, "変更ファイル一覧 panel が描画されていません");
  recordResult("browser-approvals-detail-renders-file-path-a", detailRender.hasFixturePathA, "fixture path config/fixture-target.yaml が描画されていません");
  recordResult("browser-approvals-detail-renders-file-path-b", detailRender.hasFixturePathB, "fixture path config/fixture-new.yaml が描画されていません");
  recordResult("browser-approvals-detail-renders-merge-button", detailRender.hasMergeButton, "Web UI Merge ボタンが描画されていません");

  const approvalPreview = await page.eval(`
    ${HELPER_FNS}
    const text = document.body.innerText || "";
    const preview = document.querySelector("[data-testid='creative-preview']");
    const stories = Array.from(document.querySelectorAll("button"))
      .find((button) => (button.textContent || "").trim() === "Stories");
    if (stories) stories.click();
    return {
      hasSection: text.includes("クリエイティブプレビュー"),
      hasPreview: !!preview,
      hasProxyImage: Array.from(document.querySelectorAll("img"))
        .some((img) => (img.getAttribute("src") || "").startsWith("/api/creatives/")),
      storiesSelected: stories?.getAttribute("aria-selected") === "true",
      hasCropNote: (document.body.innerText || "").includes("この範囲は表示されません"),
      hasPlaceholderCopy: (document.body.innerText || "").includes("(見出し未設定)") &&
        (document.body.innerText || "").includes("(本文未設定)"),
    };
  `);
  recordResult("browser-approvals-detail-renders-creative-preview-section", approvalPreview.hasSection, "承認詳細にクリエイティブプレビュー section がありません");
  recordResult("browser-approvals-detail-renders-creative-preview", approvalPreview.hasPreview, "承認詳細に CreativePreview が描画されていません");
  recordResult("browser-approvals-preview-uses-proxy-image", approvalPreview.hasProxyImage, "プレビュー画像が /api/creatives proxy 経由ではありません");
  recordResult("browser-approvals-preview-stories-tab-switches", approvalPreview.storiesSelected, "Stories タブ切替が動いていません");
  recordResult("browser-approvals-preview-shows-crop-note", approvalPreview.hasCropNote, "Stories の切れ領域注記が表示されていません");
  recordResult("browser-approvals-preview-placeholder-copy", approvalPreview.hasPlaceholderCopy, "copy 無し creative の placeholder が表示されていません");

  await page.navigate(`${page.baseUrl}/creatives/${FIXTURE_CREATIVE_ID}`);
  const creativeDetailPreview = await page.eval(`
    ${HELPER_FNS}
    const text = document.body.innerText || "";
    const stories = Array.from(document.querySelectorAll("button"))
      .find((button) => (button.textContent || "").trim() === "Stories");
    if (stories) stories.click();
    return {
      hasFrame: !!document.querySelector("[data-testid='creative-preview']"),
      storiesSelected: stories?.getAttribute("aria-selected") === "true",
      hasCropNote: (document.body.innerText || "").includes("この範囲は表示されません"),
      hasPlaceholderCopy: text.includes("(見出し未設定)") && text.includes("(本文未設定)"),
    };
  `);
  recordResult("browser-creatives-detail-renders-placement-preview", creativeDetailPreview.hasFrame, "/creatives/[id] に CreativePreview が描画されていません");
  recordResult("browser-creatives-detail-stories-tab-switches", creativeDetailPreview.storiesSelected, "/creatives/[id] の Stories タブ切替が動いていません");
  recordResult("browser-creatives-detail-shows-crop-note", creativeDetailPreview.hasCropNote, "/creatives/[id] の Stories 切れ領域注記が表示されていません");
  recordResult("browser-creatives-detail-placeholder-copy", creativeDetailPreview.hasPlaceholderCopy, "/creatives/[id] の copy placeholder が表示されていません");

  // 3) Web UI Merge ボタンをクリックして ConfirmDialog を開き、確定 → エラー Toast。
  await page.navigate(`${page.baseUrl}/approvals/${FIXTURE_PR_NUMBER}`);
  if (detailRender.hasMergeButton) {
    await page.eval(`
      ${HELPER_FNS}
      const btn = findButtonByText("承認して反映待ちにする");
      btn.click();
    `);
    const dialogOpened = await page
      .waitFor(`(function(){ ${HELPER_FNS}; return !!getOpenDialog(); })()`, { timeoutMs: 5_000 })
      .then(() => true)
      .catch(() => false);
    recordResult("browser-approvals-merge-opens-confirm-dialog", dialogOpened,
      "ConfirmDialog (caution) が開きません");
    if (dialogOpened) {
      // dialog 内の Confirm ボタンをクリック。Confirm ラベルは外側ボタンと同じテキスト。
      await page.eval(`
        ${HELPER_FNS}
        const dialog = getOpenDialog();
        const confirm = findButtonByText("承認して反映待ちにする", dialog);
        confirm.click();
      `);
      // 4xx error Toast を期待 (workspace 紐付けがないため /api/.../merge は 409)。
      const toastInfo = await page
        .waitFor(`(function(){ ${HELPER_FNS}; return !!getLatestToast("error"); })()`, { timeoutMs: 10_000 })
        .then(async () => {
          return await page.eval(`
            ${HELPER_FNS}
            const t = getLatestToast("error");
            return { variant: t?.dataset.variant, text: t ? t.innerText : "" };
          `);
        })
        .catch(() => null);
      recordResult(
        "browser-approvals-merge-shows-error-toast",
        Boolean(toastInfo && toastInfo.variant === "error" && /PR\s*#\s*7?7?7?7?7?7?7?/.test(toastInfo.text || "")),
        `Web UI Merge の失敗 Toast が表示されません (got: ${JSON.stringify(toastInfo)})`
      );
    }
  }
}

/**
 * 任意の Toast (success / error / warning / info) が出れば pass。
 *
 * regression fix finding #3 の本旨は「Web UI のクライアントコントロールが
 * 実際の API に到達し、結果を Toast で表示できる経路が成立している」ことを
 * 実ブラウザで検証すること。pg-boss の queue 初期化状態のように環境依存で
 * success/error が分岐する操作については、Toast が表示された時点で経路は
 * 成立していると判断する。Toast がそもそも出ない場合 (=onClick→fetch→Toast
 * の wire-up が破綻している) のみ failure。
 */
async function waitForAnyToast(page, timeoutMs = 12_000) {
  return await page
    .waitFor(`(function(){ ${HELPER_FNS}; return !!getLatestToast(); })()`, { timeoutMs })
    .then(async () => {
      return await page.eval(`
        ${HELPER_FNS}
        const t = getLatestToast();
        return t ? { variant: t.dataset.variant, text: t.innerText } : null;
      `);
    })
    .catch(() => null);
}

async function browserFlowCron(page, recordResult) {
  // ===== row 描画と SSR ボタン群の確認 =====
  await page.navigate(`${page.baseUrl}/cron`);
  const rowReady = await page
    .waitFor(`(function(){ ${HELPER_FNS}; return !!findRowByCellText("承認済み変更の確認"); })()`, { timeoutMs: 8_000 })
    .then(() => true)
    .catch(() => false);
  recordResult("browser-cron-row-ready", rowReady, "/cron 行 (承認済み変更の確認) が SSR されていません");
  if (!rowReady) return;

  const ssrButtons = await page.eval(`
    ${HELPER_FNS}
    const row = findRowByCellText("承認済み変更の確認");
    return {
      hasToggle: !!findButtonByText("OFF にする", row) || !!findButtonByText("ON にする", row),
      hasEdit: !!findButtonByText("時間を編集", row),
      hasRun: !!findButtonByText("今すぐ実行", row),
    };
  `);
  recordResult("browser-cron-ssr-toggle-button", ssrButtons.hasToggle, "承認済み変更の確認 行に ON/OFF ボタンが SSR されていません");
  recordResult("browser-cron-ssr-edit-button", ssrButtons.hasEdit, "承認済み変更の確認 行に時間編集ボタンが SSR されていません");
  recordResult("browser-cron-ssr-run-button", ssrButtons.hasRun, "承認済み変更の確認 行に 今すぐ実行 ボタンが SSR されていません");

  // ===== schedule 編集の完結フロー =====
  await page.navigate(`${page.baseUrl}/cron`);
  await page.waitFor(`(function(){ ${HELPER_FNS}; return !!findRowByCellText("承認済み変更の確認"); })()`, { timeoutMs: 8_000 }).catch(() => undefined);
  await page.eval(`
    ${HELPER_FNS}
    const row = findRowByCellText("承認済み変更の確認");
    findButtonByText("時間を編集", row)?.click();
  `);
  const inputAppeared = await page
    .waitFor(`(function(){ ${HELPER_FNS}; const row = findRowByCellText("承認済み変更の確認"); return !!row?.querySelector("input"); })()`, { timeoutMs: 4_000 })
    .then(() => true)
    .catch(() => false);
  recordResult("browser-cron-edit-shows-input", inputAppeared, "時間編集モードで input が現れません");
  if (inputAppeared) {
    // 元の cron と異なる値に書き換えて dirty にする (保存ボタンが有効になる)。
    // enabled=true 環境では pg-boss schedule まで成功する必要がある。
    // 失敗 Toast を許すと queue 初期化漏れを見逃すため、success を要求する。
    const TEST_CRON = "*/9 * * * *";
    await page.eval(`
      ${HELPER_FNS}
      const row = findRowByCellText("承認済み変更の確認");
      const input = row.querySelector("input");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(TEST_CRON)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      findButtonByText("保存", row).click();
    `);
    const editToast = await waitForAnyToast(page, 15_000);
    recordResult(
      "browser-cron-schedule-edit-succeeds",
      Boolean(editToast && editToast.variant === "success" && /github_poll|実行タイミング|更新しました/i.test(editToast.text || "")),
      `時間編集 → 保存後に success Toast が出ません (got: ${JSON.stringify(editToast)})`
    );
    // 副作用復旧: schedule 変更が成功したら元の cron に戻す。
    if (editToast && editToast.variant === "success") {
      await page.navigate(`${page.baseUrl}/cron`);
      await page
        .waitFor(`(function(){ ${HELPER_FNS}; return !!findRowByCellText("承認済み変更の確認"); })()`, { timeoutMs: 8_000 })
        .catch(() => undefined);
      await page.eval(`
        ${HELPER_FNS}
        const row = findRowByCellText("承認済み変更の確認");
        findButtonByText("時間を編集", row)?.click();
      `).catch(() => undefined);
      await page
        .waitFor(`(function(){ ${HELPER_FNS}; const row = findRowByCellText("承認済み変更の確認"); return !!row?.querySelector("input"); })()`, { timeoutMs: 4_000 })
        .catch(() => undefined);
      await page.eval(`
        ${HELPER_FNS}
        const row = findRowByCellText("承認済み変更の確認");
        const input = row?.querySelector("input");
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, "*/2 * * * *");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          findButtonByText("保存", row)?.click();
        }
      `).catch(() => undefined);
      await waitForAnyToast(page, 8_000);
    }
  }

  // ===== toggle (ON/OFF) の完結フロー =====
  // 各 sub-flow は /cron に navigate して fresh mount から開始する (前のテストの
  // editing state や busy state を持ち越さない)。
  await page.navigate(`${page.baseUrl}/cron`);
  await page.waitFor(`(function(){ ${HELPER_FNS}; return !!findRowByCellText("承認済み変更の確認"); })()`, { timeoutMs: 8_000 }).catch(() => undefined);
  const toggleInfo = await page.eval(`
    ${HELPER_FNS}
    const row = findRowByCellText("承認済み変更の確認");
    const off = findButtonByText("OFF にする", row);
    const on = findButtonByText("ON にする", row);
    return {
      buttonLabel: off ? "OFF にする" : (on ? "ON にする" : null),
    };
  `);
  if (toggleInfo.buttonLabel) {
    await page.eval(`
      ${HELPER_FNS}
      const row = findRowByCellText("承認済み変更の確認");
      findButtonByText(${JSON.stringify(toggleInfo.buttonLabel)}, row).click();
    `);
    const dlgOpen = await page
      .waitFor(`(function(){ ${HELPER_FNS}; return !!getOpenDialog(); })()`, { timeoutMs: 4_000 })
      .then(() => true).catch(() => false);
    recordResult("browser-cron-toggle-opens-dialog", dlgOpen,
      "cron toggle → ConfirmDialog が開きません");
    if (dlgOpen) {
      await page.eval(`
        ${HELPER_FNS}
        const dialog = getOpenDialog();
        // ConfirmDialog の confirm ボタンは title="github_poll を ON/OFF にする"
        // のとき confirmLabel は "ON にする" / "OFF にする" (CronControls.tsx:352)。
        // dialog 内 button のテキスト末尾でマッチする (キャンセルは "キャンセル")。
        const buttons = Array.from(dialog.querySelectorAll("button"));
        const confirm = buttons.find(b => /^(ON|OFF) にする$/.test((b.textContent || "").trim()));
        if (!confirm) {
          throw new Error("toggle confirm button not found in dialog. Buttons: " + buttons.map(b => JSON.stringify((b.textContent||"").trim())).join(", "));
        }
        confirm.click();
      `);
      const toggleToast = await waitForAnyToast(page, 15_000);
      recordResult(
        "browser-cron-toggle-toast-appears",
        Boolean(toggleToast && /github_poll|有効化|無効化/.test(toggleToast.text || "")),
        `cron toggle confirm 後に Toast が出ません (got: ${JSON.stringify(toggleToast)})`
      );
      // 副作用復旧: toggle が success だった場合は元の状態へ戻す (best-effort)。
      if (toggleToast && toggleToast.variant === "success") {
        await page.navigate(`${page.baseUrl}/cron`);
        await page
          .waitFor(`(function(){ ${HELPER_FNS}; return !!findRowByCellText("承認済み変更の確認"); })()`, { timeoutMs: 8_000 })
          .catch(() => undefined);
        const revert = await page.eval(`
          ${HELPER_FNS}
          const row = findRowByCellText("承認済み変更の確認");
          const off = findButtonByText("OFF にする", row);
          const on = findButtonByText("ON にする", row);
          // 直前と逆向きに戻す。
          const wasOff = ${JSON.stringify(toggleInfo.buttonLabel === "OFF にする")};
          const target = wasOff ? on : off;
          if (target) target.click();
          return !!target;
        `).catch(() => false);
        if (revert) {
          await page
            .waitFor(`(function(){ ${HELPER_FNS}; return !!getOpenDialog(); })()`, { timeoutMs: 4_000 })
            .catch(() => undefined);
          await page.eval(`
            ${HELPER_FNS}
            const dialog = getOpenDialog();
            if (dialog) {
              const buttons = Array.from(dialog.querySelectorAll("button"));
              const c = buttons.find(b => /^(ON|OFF) にする$/.test((b.textContent || "").trim()));
              if (c) c.click();
            }
          `).catch(() => undefined);
          await waitForAnyToast(page, 8_000);
        }
      }
    }
  } else {
    recordResult("browser-cron-toggle-button-found", false, "承認済み変更の確認 行に ON/OFF ボタンがありません");
  }

  // ===== run-now の完結フロー =====
  await page.navigate(`${page.baseUrl}/cron`);
  await page.waitFor(`(function(){ ${HELPER_FNS}; return !!findRowByCellText("承認済み変更の確認"); })()`, { timeoutMs: 8_000 }).catch(() => undefined);
  const runBtnExists = await page.eval(`
    ${HELPER_FNS}
    const row = findRowByCellText("承認済み変更の確認");
    return !!findButtonByText("今すぐ実行", row);
  `);
  if (runBtnExists) {
    await page.eval(`
      ${HELPER_FNS}
      const row = findRowByCellText("承認済み変更の確認");
      findButtonByText("今すぐ実行", row).click();
    `);
    const runDialogOpen = await page
      .waitFor(`(function(){ ${HELPER_FNS}; return !!getOpenDialog(); })()`, { timeoutMs: 4_000 })
      .then(() => true).catch(() => false);
    recordResult("browser-cron-run-now-opens-dialog", runDialogOpen,
      "今すぐ実行 → ConfirmDialog が開きません");
    if (runDialogOpen) {
      await page.eval(`
        ${HELPER_FNS}
        const dialog = getOpenDialog();
        // confirmLabel="今すぐ実行する" (CronControls.tsx:405)
        const buttons = Array.from(dialog.querySelectorAll("button"));
        const confirm = buttons.find(b => /^今すぐ実行する$/.test((b.textContent || "").trim()));
        if (!confirm) {
          throw new Error("run-now confirm button not found in dialog. Buttons: " + buttons.map(b => JSON.stringify((b.textContent||"").trim())).join(", "));
        }
        confirm.click();
      `);
      const runToast = await waitForAnyToast(page, 15_000);
      recordResult(
        "browser-cron-run-now-toast-appears",
        Boolean(runToast && /github_poll|今すぐ実行/.test(runToast.text || "")),
        `今すぐ実行 confirm 後に Toast が出ません (got: ${JSON.stringify(runToast)})`
      );
    }
  } else {
    recordResult("browser-cron-run-button-found", false, "承認済み変更の確認 行に 今すぐ実行 ボタンがありません");
  }
}

async function runBrowserFlows() {
  const result = { pass: 0, fail: 0, skipped: 0, skipReasons: [], failedDetails: [] };

  // ブラウザー検証 は「Chrome + DB が揃った operator 環境」が前提。
  // どちらかが欠けると evidence は成立しないので **既定で fail** にする。
  // CI の typecheck-only stage 等、明示的に browser flow を走らせない運用が
  // 必要な場合に限り、ADDROID_BROWSER_TEST_OPT_OUT=<reason> を環境変数で
  // 設定すると skipped に降格できる。降格は loud にログへ記録する。
  const optOutReason = process.env.ADDROID_BROWSER_TEST_OPT_OUT?.trim() || null;

  const chrome = await launchChrome();
  if (!chrome.ok) {
    if (optOutReason) {
      result.skipped = 1;
      result.skipReasons.push(
        `browser launch skipped (ADDROID_BROWSER_TEST_OPT_OUT="${optOutReason}"): ${chrome.reason}`
      );
      console.warn(
        `[browser-test] WARNING: opting out of browser verification — chrome unavailable (${chrome.reason}); reason="${optOutReason}"`
      );
      return result;
    }
    result.fail += 1;
    result.failedDetails.push({
      label: "browser-flow-prereq-chrome",
      reason:
        `Chrome / Chromium / Edge binary not found (${chrome.reason}). ` +
        `browser verification requires a real browser. ` +
        `Install Chrome / Chromium / Edge, or set ADDROID_BROWSER_TEST_OPT_OUT=<reason> ` +
        `to explicitly opt out (CI-only escape hatch).`,
    });
    console.error(
      `[browser-test] FAIL browser-flow-prereq-chrome: chrome binary not found (${chrome.reason}). ` +
        `browser verification requires a real browser.`
    );
    return result;
  }

  const prismaResult = await loadPrisma();
  if (!prismaResult.ok) {
    await chrome.cleanup();
    if (optOutReason) {
      result.skipped = 1;
      result.skipReasons.push(
        `prisma unavailable (ADDROID_BROWSER_TEST_OPT_OUT="${optOutReason}"): ${prismaResult.reason}`
      );
      console.warn(
        `[browser-test] WARNING: opting out of browser verification — prisma unavailable (${prismaResult.reason}); reason="${optOutReason}"`
      );
      return result;
    }
    result.fail += 1;
    result.failedDetails.push({
      label: "browser-flow-prereq-prisma",
      reason:
        `Prisma client unavailable (${prismaResult.reason}). ` +
        `browser verification requires a working DB so the /approvals fixture can be seeded. ` +
        `Run 'npm run db:generate' and ensure DATABASE_URL is set, or set ADDROID_BROWSER_TEST_OPT_OUT=<reason> ` +
        `to explicitly opt out (CI-only escape hatch).`,
    });
    console.error(
      `[browser-test] FAIL browser-flow-prereq-prisma: prisma unavailable (${prismaResult.reason}). ` +
        `browser verification requires a working DB.`
    );
    return result;
  }
  const { prisma } = prismaResult;

  let cdp = null;
  let page = null;
  let fixture = null;
  let cronSnapshot = null;
  try {
    fixture = await seedPrFixture(prisma);
    cronSnapshot = await snapshotGithubPollSchedule(prisma);

    cdp = await attachCdp(chrome.wsUrl);
    page = await openPage(cdp, BASE_URL);

    const recordResult = (id, ok, failReason) => {
      if (ok) {
        result.pass += 1;
        console.log(`PASS ${id}`);
      } else {
        result.fail += 1;
        result.failedDetails.push({ label: id, reason: failReason });
        console.error(`FAIL ${id}: ${failReason}`);
      }
    };

    await browserFlowApprovals(page, recordResult);
    await browserFlowCron(page, recordResult);
  } catch (err) {
    result.fail += 1;
    const reason = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    result.failedDetails.push({ label: "browser-flow-runtime", reason });
    console.error(`FAIL browser-flow-runtime: ${reason}`);
  } finally {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    if (fixture) {
      await cleanupPrFixture(prisma, fixture).catch(() => undefined);
    }
    if (cronSnapshot) {
      await restoreGithubPollSchedule(prisma, cronSnapshot).catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
    await chrome.cleanup();
  }

  return result;
}

// =====================================================================

async function main() {
  let spawned = null;
  let alreadyUp = await isServerUp(BASE_URL);
  if (!alreadyUp) {
    console.log(`[browser-test] starting next dev on ${BASE_URL} ...`);
    spawned = startServer();
    const ready = await waitForServer(BASE_URL, HEALTH_TIMEOUT_MS);
    if (!ready) {
      console.error(
        `[browser-test] dev server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`
      );
      await stopServer(spawned);
      process.exit(1);
    }
  } else {
    console.log(`[browser-test] reusing already-running server at ${BASE_URL}`);
  }

  let exitCode = 0;
  try {
    const scenarioResult = await runScenarios();
    const interactionResult = await runInteractions();
    const browserResult = await runBrowserFlows();
    const totalCases = SCENARIOS.length + INTERACTIONS.length;
    const totalPass = scenarioResult.pass + interactionResult.pass + browserResult.pass;
    const totalFail = scenarioResult.fail + interactionResult.fail + browserResult.fail;
    console.log(
      `\n[browser-test] ${totalPass} passed, ${totalFail} failed, ${browserResult.skipped > 0 ? `${browserResult.skipped} browser-flow skipped` : "0 skipped"} ` +
      `(scenarios+interactions=${totalCases}; browser flows are dynamic)`
    );
    console.log(
      `  scenarios:        ${scenarioResult.pass}/${SCENARIOS.length} passed`
    );
    console.log(
      `  interactions:     ${interactionResult.pass}/${INTERACTIONS.length} passed`
    );
    console.log(
      `  browser flows:    ${browserResult.pass} passed, ${browserResult.fail} failed${browserResult.skipped > 0 ? ` (skipped: ${browserResult.skipReasons.join(" / ")})` : ""}`
    );
    if (totalFail > 0) {
      exitCode = 1;
      for (const d of [
        ...scenarioResult.failedDetails,
        ...interactionResult.failedDetails,
        ...browserResult.failedDetails,
      ]) {
        console.error(`  - ${d.label}: ${d.reason}`);
      }
    }
  } finally {
    if (spawned) {
      console.log("[browser-test] stopping next dev ...");
      await stopServer(spawned);
    }
  }
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error("[browser-test] unexpected error:", err);
  process.exit(1);
});
