import test from "node:test";
import assert from "node:assert/strict";
import {
  extractActionValue,
  fieldsForInsightsLevel,
  MetaCliDailyReportInsightsProvider,
} from "../meta-cli-insights-runtime.js";
import type { MetaCliExecutionResult, MetaCliInvocation } from "@addroid/meta-adapter";

test("MetaCliDailyReportInsightsProvider parses CLI JSON rows into daily report rows", async () => {
  const invocations: MetaCliInvocation[] = [];
  const provider = new MetaCliDailyReportInsightsProvider({
    runner: {
      async run(invocation) {
        invocations.push(invocation);
        return {
          exitCode: 0,
          signal: null,
          exitClass: "success",
          stdout: JSON.stringify({
            data: [
              {
                campaign_id: "cmp_1",
                campaign_name: "Campaign 1",
                spend: "123.45",
                impressions: "1000",
                clicks: "50",
                reach: "800",
                inline_link_clicks: "40",
                actions: [{ action_type: "purchase", value: "2" }],
                frequency: "1.2",
                video_thruplay_watched_actions: [
                  { action_type: "video_thruplay_watched_actions", value: "11" },
                ],
                video_3_sec_watched_actions: [
                  { action_type: "video_3_sec_watched_actions", value: "21" },
                ],
              },
            ],
          }),
          stderr: "",
          sanitizedCommand: "meta --output json ads insights get",
          sanitizedArgs: invocation.args,
          throttleHeaders: null,
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(0).toISOString(),
          timedOut: false,
          accountKey: invocation.accountKey,
          binary: "meta",
          recommendedAction: {
            kind: "none",
            retry: false,
            notify: "none",
            logLevel: "info",
            reason: "success",
          },
        };
      },
    },
    resolveAdAccountId: async () => "act_123",
  });

  const result = await provider.fetchInsights({
    accountKey: "primary",
    metricDate: "2026-05-04",
    includePriorPeriod: false,
    breakdownsPolicy: {
      fetchAccount: false,
      fetchCampaign: true,
      fetchAdset: false,
      fetchAd: false,
      synthesizeAccountFromCampaigns: true,
    },
  });

  assert.equal(result.source, "meta_ads_cli");
  assert.equal(result.current.length, 1);
  assert.equal(result.current[0]!.nodeType, "campaign");
  assert.equal(result.current[0]!.nodeKey, "cmp_1");
  assert.equal(result.current[0]!.spendMicros, 123450000n);
  assert.equal(result.current[0]!.conversions, 2);
  assert.equal(result.current[0]!.reach, 800);
  assert.equal(result.current[0]!.linkClicks, 40);
  assert.equal(result.current[0]!.videoThruPlays, 11);
  assert.equal(result.current[0]!.video3SecViews, 21);
  assert.equal(invocations[1]!.adAccountId, "act_123");
  assert.deepEqual(invocations[1]!.args.slice(0, 5), [
    "--output",
    "json",
    "ads",
    "insights",
    "get",
  ]);
});

test("fieldsForInsightsLevel requests ranking diagnostics only at ad level", () => {
  const fields = [
    "spend",
    "quality_ranking",
    "engagement_rate_ranking",
    "conversion_rate_ranking",
  ];
  assert.deepEqual(fieldsForInsightsLevel(fields, "campaign"), ["spend"]);
  assert.deepEqual(fieldsForInsightsLevel(fields, "ad"), fields);
});

test("extractActionValue handles missing, multiple, and numeric-string actions", () => {
  assert.equal(extractActionValue(null, "video_3_sec_watched_actions"), null);
  assert.equal(
    extractActionValue(
      [
        { action_type: "other", value: "100" },
        { action_type: "video_3_sec_watched_actions", value: "12.7" },
        { action_type: "video_3_sec_watched_actions", value: 2 },
      ],
      "video_3_sec_watched_actions"
    ),
    14
  );
});

test("MetaCliDailyReportInsightsProvider keeps account totals when optional breakdowns hit a rate limit", async () => {
  const invocations: MetaCliInvocation[] = [];
  const provider = new MetaCliDailyReportInsightsProvider({
    runner: {
      async run(invocation) {
        invocations.push(invocation);
        if (invocation.args.includes("campaign") && invocation.args.includes("list")) {
          return cliResult(invocation, {
            exitClass: "rate_limit_error",
            exitCode: 17,
            stderr: "Error: API error (17): User request limit reached",
          });
        }
        return cliResult(invocation, {
          stdout: JSON.stringify({
            data: [
              {
                spend: "103",
                impressions: "206",
                clicks: "4",
                ctr: "1.941748",
              },
            ],
          }),
        });
      },
    },
    resolveAdAccountId: async () => "act_123",
  });

  const result = await provider.fetchInsights({
    accountKey: "primary",
    metricDate: "2026-05-08",
    includePriorPeriod: false,
    breakdownsPolicy: {
      fetchAccount: true,
      fetchCampaign: true,
      fetchAdset: false,
      fetchAd: false,
      synthesizeAccountFromCampaigns: false,
    },
  });

  assert.equal(result.source, "meta_ads_cli");
  assert.equal(result.current.length, 1);
  assert.equal(result.current[0]!.nodeType, "account");
  assert.equal(result.current[0]!.spendMicros, 103000000n);
  assert.match(result.detail ?? "", /partial failure campaign:/);
  assert.match(result.detail ?? "", /User request limit reached/);
  assert.equal(invocations.length, 2);
});

function cliResult(
  invocation: MetaCliInvocation,
  overrides: Partial<MetaCliExecutionResult> = {}
): MetaCliExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    exitClass: "success",
    stdout: JSON.stringify({ data: [] }),
    stderr: "",
    sanitizedCommand: "meta --output json ads insights get",
    sanitizedArgs: invocation.args,
    throttleHeaders: null,
    durationMs: 1,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    timedOut: false,
    accountKey: invocation.accountKey,
    binary: "meta",
    recommendedAction: {
      kind: "none",
      retry: false,
      notify: "none",
      logLevel: "info",
      reason: "success",
    },
    ...overrides,
  };
}
