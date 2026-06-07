// AdDroid OSS — 日次 ad/adset/campaign 単位 実績蓄積スクリプト。
//
// 指定クライアント (TARGET_ACCOUNTS) について、Meta の階層 (campaign/adset/ad) を
// 同期しつつ「前日(JST, 完全な1日)」の実績を performance_snapshots に蓄積する。
// 朝に毎日回すことで「どの広告・どのクリエイティブがCVを生むか」の時系列が積み上がる。
//
//   実行:        node --import tsx scripts/accumulate-ad-metrics.ts
//   日付指定:    node --import tsx scripts/accumulate-ad-metrics.ts 2026-06-05
//
// .env はリポジトリ root から自動ロードされる (@addroid/db import 時)。

import { prisma } from "@addroid/db";
import { runMetaMirrorSync } from "../apps/worker/src/lib/meta-mirror-runtime.js";
import { buildPrismaMetaAdapterSelection } from "../apps/worker/src/lib/meta-runtime.js";

// 蓄積対象クライアント [表示名, metaAccountId]。増減はここを編集する。
const TARGET_ACCOUNTS: Array<[string, string]> = [
  ["MEGURU", "act_409375025604424"],
  ["整体院TAK", "act_485006324299212"],
  ["整足院", "act_1384276956051351"],
  ["矢野鍼灸院", "act_2563359070573682"],
  ["ビリーズケア", "act_3540167132968068"],
];

function yesterdayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  jst.setUTCDate(jst.getUTCDate() - 1);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const metricDate = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : yesterdayJst();

  const ws = await prisma.workspace.findFirst({ select: { id: true } });
  if (!ws) throw new Error("workspace not found");
  const sel = await buildPrismaMetaAdapterSelection({ prisma, env: process.env });
  const lease = await sel.adapter.loadAccessTokenPlaintext();
  if (!lease) throw new Error("Meta token が未接続です (`addroid connect meta`)。");

  console.log(`[accumulate-ad-metrics] metricDate=${metricDate} accounts=${TARGET_ACCOUNTS.length}`);
  let ok = 0;
  for (const [name, key] of TARGET_ACCOUNTS) {
    try {
      const r = await runMetaMirrorSync({
        prisma,
        workspaceId: ws.id,
        accessToken: lease.accessToken,
        accountKey: key,
        actor: "cron:ad-metrics",
        source: "daily-ad-metrics",
        includeMetrics: true,
        metricDate,
      });
      ok += 1;
      console.log(
        `OK   ${name}: campaigns ${r.campaigns}/adsets ${r.adsets}/ads ${r.ads}` +
          ` | metrics rows ${r.metrics.rows} snapshots ${r.metrics.snapshots}` +
          (r.metrics.error ? ` | metricsERR ${r.metrics.error}` : "")
      );
    } catch (e) {
      console.log(`FAIL ${name}: ${(e as Error).message}`);
    }
  }
  console.log(`[accumulate-ad-metrics] done: ${ok}/${TARGET_ACCOUNTS.length} ok (metricDate=${metricDate})`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[accumulate-ad-metrics] fatal:", (e as Error).message);
  process.exit(1);
});
