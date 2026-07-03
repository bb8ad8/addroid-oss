import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@addroid/db";
import {
  extractCreativeSnippet,
  loadRecentPerformanceSnapshotContext,
} from "../improvement-pr-performance-context.js";

test("loadRecentPerformanceSnapshotContext uses yesterday-based 7d window and avoids double counting hierarchy levels", async () => {
  let queryArgs: unknown = null;
  const rows = [
    row("cur-account-1", "account", "2026-05-04", 1_000_000n, 100, 10, 1),
    row("cur-campaign-1", "campaign", "2026-05-04", 9_000_000n, 900, 90, 9),
    row("cur-account-2", "account", "2026-05-10", 2_000_000n, 200, 20, 2),
    row("prior-account-1", "account", "2026-05-03", 4_000_000n, 400, 40, 4),
    row("today-account", "account", "2026-05-11", 8_000_000n, 800, 80, 8),
  ];
  const prisma = {
    performanceSnapshot: {
      async findMany(args: unknown) {
        queryArgs = args;
        return rows;
      },
    },
    creative: { async findMany() { return []; } },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.deepEqual(context.snapshotIds, [
    "cur-account-1",
    "cur-campaign-1",
    "cur-account-2",
  ]);
  assert.equal(context.analysisWindow.periodStart, "2026-05-04");
  assert.equal(context.analysisWindow.periodEnd, "2026-05-10");
  assert.equal(context.analysisWindow.priorPeriodStart, "2026-04-27");
  assert.equal(context.analysisWindow.priorPeriodEnd, "2026-05-03");
  assert.equal(context.analysisWindow.current.spend, 3);
  assert.equal(context.analysisWindow.current.impressions, 300);
  assert.equal(context.analysisWindow.current.clicks, 30);
  assert.equal(context.analysisWindow.current.conversions, 3);
  assert.equal(context.analysisWindow.prior?.spend, 4);
  assert.match(JSON.stringify(queryArgs), /2026-04-27T00:00:00.000Z/);
  assert.match(JSON.stringify(queryArgs), /2026-05-10T00:00:00.000Z/);
});

test("loadRecentPerformanceSnapshotContext can include today for manual improvement runs", async () => {
  let queryArgs: unknown = null;
  const prisma = {
    performanceSnapshot: {
      async findMany(args: unknown) {
        queryArgs = args;
        return [
          row("today-account", "account", "2026-05-11", 8_000_000n, 800, 80, 8),
          row("prior-account", "account", "2026-05-04", 2_000_000n, 200, 20, 2),
        ];
      },
    },
    creative: { async findMany() { return []; } },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
    includeToday: true,
  });

  assert.deepEqual(context.snapshotIds, ["today-account"]);
  assert.equal(context.analysisWindow.periodStart, "2026-05-05");
  assert.equal(context.analysisWindow.periodEnd, "2026-05-11");
  assert.equal(context.analysisWindow.priorPeriodStart, "2026-04-28");
  assert.equal(context.analysisWindow.priorPeriodEnd, "2026-05-04");
  assert.equal(context.analysisWindow.current.spend, 8);
  assert.equal(context.analysisWindow.prior?.spend, 2);
  assert.match(JSON.stringify(queryArgs), /2026-04-28T00:00:00.000Z/);
  assert.match(JSON.stringify(queryArgs), /2026-05-11T00:00:00.000Z/);
});

test("loadRecentPerformanceSnapshotContext grounds snapshot rows via ads_hierarchy when hierarchyId is missing", async () => {
  const prisma = {
    performanceSnapshot: {
      async findMany() {
        return [
          {
            ...row("today-ad", "ad", "2026-05-11", 8_000_000n, 800, 80, 0),
            nodeKey: "120228334025200756",
            hierarchyId: null,
            hierarchy: null,
          },
        ];
      },
    },
    adsHierarchyNode: {
      async findMany() {
        return [
          {
            id: "hier-ad",
            nodeType: "ad",
            nodeKey: "120228334025200756",
            displayName: "既存のトラフィック広告",
            status: "paused",
            externalId: "120228334025200756",
            spec: { raw: { name: "既存のトラフィック広告" } },
            parent: {
              id: "hier-adset",
              nodeType: "adset",
              nodeKey: "120228334025180756",
              displayName: "ADS_店舗A 縦長 - 動画 - プロフィール誘導 - CP予算",
              status: "paused",
              externalId: "120228334025180756",
              spec: { raw: { name: "ADS_店舗A 縦長 - 動画 - プロフィール誘導 - CP予算" } },
              parent: {
                id: "hier-campaign",
                nodeType: "campaign",
                nodeKey: "120228334025190756",
                displayName: "CP_店舗A 縦長 - 動画 - プロフィール誘導 - CP予算",
                status: "paused",
                externalId: "120228334025190756",
                spec: { raw: { name: "CP_店舗A 縦長 - 動画 - プロフィール誘導 - CP予算" } },
              },
            },
          },
        ];
      },
    },
    creative: { async findMany() { return []; } },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
    includeToday: true,
  });

  assert.equal(context.creativeContext?.target?.hierarchyId, "hier-ad");
  assert.equal(context.creativeContext?.target?.displayName, "既存のトラフィック広告");
  assert.match(context.creativeContext?.notes?.join("\n") ?? "", /店舗A 縦長/);
  assert.equal(context.creativeContext?.target?.creative?.primaryText, null);
});

test("loadRecentPerformanceSnapshotContext extracts Meta creative copy and URL from synced ad specs", async () => {
  const prisma = {
    performanceSnapshot: {
      async findMany() {
        return [
          {
            ...row("today-ad", "ad", "2026-05-11", 8_000_000n, 800, 80, 0),
            nodeKey: "ad-1",
            hierarchyId: "hier-ad",
            hierarchy: {
              id: "hier-ad",
              nodeType: "ad",
              nodeKey: "ad-1",
              displayName: "店舗A プロフィール誘導広告",
              status: "active",
              externalId: "ad-1",
              spec: {
                source: "meta_graph_sync",
                creative: {
                  key: "creative-1",
                  displayName: "店舗A PR 動画",
                  mediaType: "video",
                  headline: "駅近のくつろぎ空間",
                  primaryText: "駅から徒歩5分。落ち着いた内装の店舗でゆっくり過ごせます。",
                  callToAction: "LEARN_MORE",
                  linkUrl: "https://example.com/store-a",
                  pageId: "page-1",
                  instagramUserId: "ig-1",
                },
                raw: { name: "店舗A プロフィール誘導広告" },
              },
            },
          },
        ];
      },
    },
    creative: { async findMany() { return []; } },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
    includeToday: true,
  });

  const creative = context.creativeContext?.target?.creative;
  assert.equal(creative?.key, "creative-1");
  assert.equal(creative?.headline, "駅近のくつろぎ空間");
  assert.equal(
    creative?.primaryText,
    "駅から徒歩5分。落ち着いた内装の店舗でゆっくり過ごせます。"
  );
  assert.equal(creative?.callToAction, "LEARN_MORE");
  assert.equal(creative?.linkUrl, "https://example.com/store-a");
  assert.match(context.creativeContext?.notes?.join("\n") ?? "", /link=https:\/\/example.com/);
});

test("loadRecentPerformanceSnapshotContext falls back to raw Meta object_story_spec creative fields", async () => {
  const prisma = {
    performanceSnapshot: {
      async findMany() {
        return [
          {
            ...row("today-ad", "ad", "2026-05-11", 8_000_000n, 800, 80, 0),
            nodeKey: "ad-1",
            hierarchyId: "hier-ad",
            hierarchy: {
              id: "hier-ad",
              nodeType: "ad",
              nodeKey: "ad-1",
              displayName: "店舗A プロフィール誘導広告",
              status: "active",
              externalId: "ad-1",
              spec: {
                source: "meta_graph_sync",
                raw: {
                  name: "店舗A プロフィール誘導広告",
                  creative: {
                    id: "creative-raw-1",
                    name: "Raw creative",
                    object_story_spec: {
                      page_id: "page-raw",
                      link_data: {
                        name: "駅近でくつろぐ夜",
                        message: "Wi-Fiと電源を備えた落ち着いたカフェバー。",
                        link: "https://example.com/raw-store-a",
                        call_to_action: { type: "LEARN_MORE" },
                      },
                    },
                  },
                },
              },
            },
          },
        ];
      },
    },
    creative: { async findMany() { return []; } },
  } as unknown as PrismaClient;

  const context = await loadRecentPerformanceSnapshotContext(prisma, {
    accountId: "acct-1",
    timeZone: "UTC",
    now: new Date("2026-05-11T12:00:00.000Z"),
    includeToday: true,
  });

  const creative = context.creativeContext?.target?.creative;
  assert.equal(creative?.key, "creative-raw-1");
  assert.equal(creative?.headline, "駅近でくつろぐ夜");
  assert.equal(creative?.primaryText, "Wi-Fiと電源を備えた落ち着いたカフェバー。");
  assert.equal(creative?.callToAction, "LEARN_MORE");
  assert.equal(creative?.linkUrl, "https://example.com/raw-store-a");
  assert.equal(creative?.pageId, "page-raw");
});

function row(
  id: string,
  nodeType: string,
  metricDate: string,
  spendMicros: bigint,
  impressions: number,
  clicks: number,
  conversions: number
) {
  return {
    id,
    nodeType,
    nodeKey: `${nodeType}-${id}`,
    hierarchyId: nodeType === "account" ? null : `hier-${id}`,
    metricDate: new Date(`${metricDate}T00:00:00.000Z`),
    spendMicros,
    impressions,
    clicks,
    conversions,
    createdAt: new Date(`${metricDate}T01:00:00.000Z`),
    raw: { displayName: `${nodeType} ${id}` },
    hierarchy:
      nodeType === "account"
        ? null
        : {
            id: `hier-${id}`,
            nodeType,
            nodeKey: `${nodeType}-${id}`,
            displayName: `${nodeType} ${id}`,
            status: "active",
            externalId: `ext-${id}`,
            spec: {},
          },
  };
}

test("extractCreativeSnippet reads copy from raw.creative.asset_feed_spec (Advantage+/dynamic)", () => {
  const snippet = extractCreativeSnippet({
    raw: {
      creative: {
        id: "1065086112754429",
        object_story_spec: {
          page_id: "1098186850054003",
          instagram_user_id: "17841414792475688",
        },
        asset_feed_spec: {
          titles: [{ text: "社長のXを、裏方が伸ばす。" }],
          bodies: [{ text: 'フォロワーの数よりも、"誰に届くか"が大切です。' }],
          call_to_action_types: ["LEARN_MORE"],
          link_urls: [{ website_url: "https://urakata.no-wave.jp/" }],
        },
      },
    },
  });

  assert.ok(snippet, "snippet should not be null");
  assert.equal(snippet?.headline, "社長のXを、裏方が伸ばす。");
  assert.equal(snippet?.primaryText, 'フォロワーの数よりも、"誰に届くか"が大切です。');
  assert.equal(snippet?.callToAction, "LEARN_MORE");
  assert.equal(snippet?.linkUrl, "https://urakata.no-wave.jp/");
});

test("extractCreativeSnippet keeps object_story_spec copy (no regression)", () => {
  const snippet = extractCreativeSnippet({
    raw: {
      creative: {
        id: "c-2",
        object_story_spec: {
          link_data: {
            name: "既存ヘッドライン",
            message: "既存の本文メッセージ",
          },
        },
        asset_feed_spec: {
          bodies: [{ text: "asset_feed の本文（使われないはず）" }],
        },
      },
    },
  });

  assert.equal(snippet?.headline, "既存ヘッドライン");
  assert.equal(snippet?.primaryText, "既存の本文メッセージ");
});
