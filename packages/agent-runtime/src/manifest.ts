// Agent tool manifest is an internal public API shared by CLI chat, Web chat,
// Slack, and scheduled-agent runs. Tool names, args, effects, and
// allowedSurfaces require the same compatibility review as CLI commands.
// Deprecated tools should remain listed with an empty allowedSurfaces window
// until a release note explicitly removes them.

import type { AddroidLanguage } from "@addroid/config";

export type AgentSurface = "cli-chat" | "web-chat" | "slack-chat" | "scheduled-agent";

export type AgentToolEffect =
  | "read"
  | "local-write"
  | "queue"
  | "gitops-pr"
  | "approval-decision"
  | "audited-meta-activate";

export interface AgentToolDefinition {
  name: string;
  description: string;
  args: string;
  effects: AgentToolEffect[];
  allowedSurfaces: AgentSurface[];
  guidance?: string;
}

export const AGENT_TOOL_MANIFEST = [
  {
    name: "diagnose",
    description: "AdDroid の詳細診断を実行する。",
    args: "{}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
  },
  {
    name: "check_status",
    description: "接続、DB、worker、GitHub などの状態を確認する。",
    args: "{}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
  },
  {
    name: "list_ad_accounts",
    description: "登録済みの Meta 広告アカウントと Page / Instagram アセット権限の証跡を確認する。",
    args: "{json?: boolean}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
  },
  {
    name: "sync_ad_accounts",
    description: "Meta から広告アカウントを同期し、Page / Instagram アセット権限の証跡も確認する。",
    args: "{selectDefault?: boolean,json?: boolean}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "select_ad_account",
    description: "デフォルト広告アカウントを選択する。",
    args: "{adAccountId?: string,key?: string,json?: boolean}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "connect_service",
    description: "Meta / GitHub / AI / Slack の接続フローを開始または案内する。",
    args: "{service:'meta'|'github'|'ai'|'slack', aiProvider?:'codex'|'openai'|'anthropic'}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "get_report",
    description: "日次レポート、予算チェック、改善提案を今すぐ実行する。",
    args: "{kind?:'daily'|'budget'|'improvement', metricDate?:'YYYY-MM-DD', metricDateRelative?:'today'|'yesterday'}",
    effects: ["queue"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use metricDateRelative for relative dates, especially in scheduled-agent tasks. For '前日' or '昨日', use metricDateRelative:'yesterday'.",
  },
  {
    name: "check_submission",
    description: "ops repo の入稿内容を validate し、dry-run の変更予定を表示する。Meta には反映しない。",
    args: "{root?: string,base?: string,account?: string,save?: boolean}",
    effects: ["read", "local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
  },
  {
    name: "create_scheduled_agent_task",
    description:
      "自然言語の定期タスクを保存し、有効化する。定期レポートや継続チェックの依頼は preset schedule ではなく通常この tool を使う。",
    args: "{prompt:string, cron:string, title?:string, runNow?:boolean}",
    effects: ["local-write", "queue"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "For read-only/reporting recurring tasks such as '毎朝9時に前日のレポート', save a prompt that still says '前日分の日次レポートを作成して要約する' and cron '0 9 * * *'. Do not use this for production ad mutations; use propose_automation_rule instead.",
  },
  {
    name: "set_schedule_enabled",
    description:
      "既存の pg-boss preset schedule を cron と enabled 状態込みで更新する。preset 自体の ON/OFF が明示された場合に使う。",
    args: "{preset:'daily'|'today'|'budget'|'rebalance'|'experiment'|'improvement'|'github'|'retention', cron?: string, enabled:boolean}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "If the user asks to schedule a business task in natural language, prefer create_scheduled_agent_task. Use this only when they refer to an existing preset schedule.",
  },
  {
    name: "configure_budget_guard",
    description:
      "広告アカウントごとの予算チェックルールを保存し、必要なら budget_guard schedule を有効化する。Meta は直接変更しない。",
    args:
      "{accountKey?:string,dailyBudget:number,monthlyBudget:number,currency?:string,dailyBudgetAlertRatio?:number,monthlyPaceRatio?:number,dayOverDayRatio?:number,noConversionsSpendMin?:number,autoPauseEnabled?:boolean,autoPauseMinDailyBudgetRatio?:number,autoPauseMinDayOverDayRatio?:number,safeCategories?:string[],cron?:string,enabled?:boolean}",
    effects: ["local-write", "queue"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "Use this when the user explicitly provides budget amounts or threshold values. If the account or budget amounts are missing, ask a concise clarification question first. autoPause only creates approval-gated candidates; it must not directly mutate Meta from chat.",
  },
  {
    name: "create_experiment",
    description:
      "同一広告セット内の active 広告2つを A/B テストとして登録する。評価と敗者PAUSE提案は experiment_evaluate schedule が行う。",
    args:
      "{accountId?:string,accountKey?:string,name:string,hypothesis?:string,metric?:'ctr'|'cvr',adsetNodeKey:string,variantAKey:string,variantBKey:string,minImpressionsPerVariant?:number,maxDurationDays?:number}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "Use this when the user asks to start/register an A/B test between two existing ads. The two variants must be active ads in the same adset, and an ad cannot belong to multiple running experiments. This tool only registers the experiment; it does not mutate Meta.",
  },
  {
    name: "configure_submission_guards",
    description:
      "入稿・変更PRを事前検査する安全ガードを設定する。まずは予算増加ガードを変更し、Meta は直接変更しない。",
    args:
      "{budgetIncrease?:{warnOverRatio?:number,blockOverRatio?:number}, warnOverRatio?:number, blockOverRatio?:number}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "Use this when the user asks to change submission/safety guardrails such as '予算ガードを3倍で警告、6倍でブロック'. Require both warning and blocking ratios unless the missing value can be safely kept from current context. warnOverRatio must be smaller than blockOverRatio. Do not use configure_budget_guard; that is for spend monitoring, while this tool is for pre-submit CI/plan guards.",
  },
  {
    name: "manage_schedule",
    description: "既存 preset schedule の一覧、履歴、または単発実行を扱う。",
    args: "{action:'list'|'run'|'logs', preset?:'daily'|'today'|'budget'|'rebalance'|'experiment'|'improvement'|'github'|'retention', limit?: number}",
    effects: ["read", "queue"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
  },
  {
    name: "show_logs",
    description: "AdDroid の運用ログを表示する。",
    args: "{target?:'up'|'web'|'worker'|'all', lines?: number}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "stop_services",
    description: "ローカル AdDroid プロセスを停止する。",
    args: "{}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "start_delivery",
    description:
      "Deprecated for agent chat. 本番配信に影響するため propose_ops_change で GitOps PR にする。",
    args: "{hierarchyId:string,note?:string,json?:boolean}",
    effects: ["audited-meta-activate"],
    allowedSurfaces: [],
  },
  {
    name: "propose_ops_change",
    description:
      "停止、配信開始、予算変更、作成、更新、削除など本番広告に影響する変更案を ops repo の GitHub PR として作成する。Meta には直接反映しない。",
    args: "{intent:'pause'|'activate'|'status_change'|'budget_change'|'other', accountKey?:string, targets?:Array<{level:'campaign'|'adset'|'ad', id:string}>, targetIds?:string[], desiredChanges?:object, operations?:Array<{kind:string, ref?:string, dependsOn?:string[], payload:{graphPayload?:object,[key:string]:unknown}, entity?:{nodeType?:string,nodeKey?:string,displayName?:string,parentNodeType?:string,parentNodeKey?:string,status?:string}, externalIdRequired?:boolean}>, rationale?:string, urgency?:'low'|'normal'|'high'}",
    effects: ["gitops-pr"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this for any production mutation intent. For common pause/activate/budget changes, first inspect read-only data and pass targets + desiredChanges. For other Graph API mutations, pass operations as Graph manifest actions with kind and payload, not CLI args. Use payload.graphPayload for official Meta Graph API snake_case fields that AdDroid does not have a typed alias for; graphPayload overrides aliases. Never include access_token, id, account_id, created_time, updated_time, effective_status, configured_status, issues_info, or recommendations. For budget_change, inspect campaign and adset budget fields first and target the object that actually carries the budget. Human merge is required.",
  },
  {
    name: "decide_approval",
    description:
      "承認待ち GitOps PR を承認して merge する、または否決して後続反映を止める。",
    args:
      "{prNumber:number, decision:'approve'|'reject', comment?:string, mergeMethod?:'merge'|'squash'|'rebase'}",
    effects: ["approval-decision"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "Use this only when the user explicitly asks to approve/承認 or reject/否決 a tracked PR. For approve, this records approval before GitHub merge; for reject, this records rejected and does not mutate Meta.",
  },
  {
    name: "propose_creative_submission",
    description:
      "広告クリエイティブを生成またはローカル素材から取り込み、キャンペーン作成・広告セット作成・広告作成のいずれかの階層で ops repo PR を作成する。Meta には直接反映しない。",
    args:
      "{accountKey?:string,placementMode?:'existing_adset'|'new_adset'|'new_campaign',inheritFromCampaignId?:string,inheritFromAdsetId?:string,inheritFromAdId?:string,creativeName?:string,adName?:string,adNameExplicit?:boolean,prompt?:string,headline?:string,primaryText?:string,pageId?:string,title?:string,body?:string,linkUrl?:string,description?:string,instagramUserId?:string,instagramActorId?:string,instagramAppLink?:string,callToAction?:string,callToActions?:string[],mediaType?:'image'|'video'|'carousel'|'text',localMediaPaths?:string[],referenceImagePaths?:string[],images?:string[],videos?:string[],titles?:string[],bodies?:string[],descriptions?:string[],generateImage?:boolean,imagePlacement?:'feed_square'|'feed_portrait'|'story_reels'|'feed_landscape',imageAspectRatio?:'1:1'|'4:5'|'9:16'|'1.91:1',campaignId?:string,adsetId?:string,campaignName?:string,campaignNameExplicit?:boolean,adsetName?:string,adsetNameExplicit?:boolean,objective?:string,dailyBudget?:number,lifetimeBudget?:number,adsetBudgetSharing?:boolean,campaignBidStrategy?:string,campaignSpendCap?:number,campaignStartTime?:string,campaignStopTime?:string,specialAdCategoryCountry?:string[],isAdsetBudgetSharingEnabled?:boolean,campaignPacingType?:string[],campaignGraphPayload?:object,optimizationGoal?:string,optimizationSubEvent?:string,billingEvent?:string,adsetBidStrategy?:string,bidAmount?:number,bidConstraints?:object,attributionSpec?:object[],destinationType?:string,frequencyControlSpecs?:object[],adsetSchedule?:object[],adsetPacingType?:string[],dailySpendCap?:number,lifetimeSpendCap?:number,isDynamicCreative?:boolean,dsaBeneficiary?:string,dsaPayor?:string,regionalRegulatedCategories?:string[],adsetGraphPayload?:object,pixelId?:string,customEventType?:string,objectStorySpec?:object,assetFeedSpec?:object,degreesOfFreedomSpec?:object,urlTags?:string,platformCustomizations?:object,videoId?:string,productSetId?:string,destinationSetId?:string,creativeGraphPayload?:object,adPixelId?:string,trackingSpecs?:object|object[],conversionSpecs?:object|object[],conversionDomain?:string,creativeAssetGroupsSpec?:object,engagementAudience?:boolean,priority?:number,adGraphPayload?:object,countries?:string[],rationale?:string,urgency?:'low'|'normal'|'high'}",
    effects: ["gitops-pr"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this when the user asks to create/upload/submit Meta ad creative. PRs are applied through the Meta Graph API route. Always set placementMode from intent: existing_adset uses campaignId+adsetId as the destination; new_adset uses campaignId as the destination parent; new_campaign must not use campaignId/adsetId as destinations. When the user says 'same settings as an existing/active campaign/adset' while also asking for a new campaign, put the existing campaign/adset/ad IDs in inheritFromCampaignId/inheritFromAdsetId/inheritFromAdId and set placementMode:'new_campaign'. Do not invent campaignName/adsetName/adName only for naming convenience; AdDroid auto-generates missing names and appends YYYY-MM-DD_addroid. If the user explicitly specifies a campaign/adset/ad name, pass that name and set campaignNameExplicit/adsetNameExplicit/adNameExplicit respectively so the runtime preserves it. Campaign creation needs objective+optimizationGoal+billingEvent and dailyBudget or lifetimeBudget. Budget and bid amounts are account-currency major units; for a JPY account, 500円/日は dailyBudget:500. Use typed aliases for common Graph fields such as bid strategy, attribution spec, optimization sub event, destination type, DSA fields, asset_feed_spec, degrees_of_freedom_spec, url_tags, conversion domain/specs, and tracking specs. Use campaignGraphPayload/adsetGraphPayload/creativeGraphPayload/adGraphPayload for official Meta Graph API snake_case fields without a typed alias; raw graph payload overrides aliases. Never include access_token or read-only fields in graph payloads. Use imagePlacement only as a generation/media-sizing hint unless explicit placement targeting is requested. Ask concise clarification questions for missing placement, pageId, optimizationGoal/billingEvent, budget, destination link, country targeting, or copy before calling the tool. Use referenceImagePaths when attached/local images should guide new image generation; use localMediaPaths only when the files themselves should be submitted as final ad media. Human PR merge is required.",
  },
  {
    name: "generate_creatives",
    description:
      "参考画像や既存の勝ちクリエイティブ文脈を使って、新しい画像クリエイティブ案を生成し、/creatives のライブラリに保存する。PR作成やMeta反映はしない。",
    args:
      "{accountKey?:string,prompt:string,creativeName?:string,linkUrl?:string,destinationUrl?:string,referenceImagePaths?:string[],variantCount?:number,imagePlacement?:'feed_square'|'feed_portrait'|'story_reels'|'feed_landscape',imageAspectRatio?:'1:1'|'4:5'|'9:16'|'1.91:1'}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this for requests like '画像を参考に新しいクリエイティブを生成して' or '既存のアクティブ広告も参考にして案を作って' when the user did not ask to submit/create an ad, create a campaign/adset, or open a PR. If the user provides a landing/destination URL, pass it as linkUrl or destinationUrl so the creative generator can ask the LLM to inspect it. Preserve attached images in referenceImagePaths. If the user names a surface, pass imagePlacement/imageAspectRatio as a sizing hint; otherwise the generator creates variants across common Meta placements using current creative context. Do not ask about Meta delivery settings because this tool does not submit to Meta.",
  },
  {
    name: "resolve_creative_submission_context",
    description:
      "保存済みCreativeを入稿PRに回す前に、現在のMeta状態から配信先・既存広告のページ/Instagram/遷移先など不足情報をまとめて確認する。",
    args:
      "{creativeId:string, accountKey?:string, campaignId?:string, adsetId?:string, preferActiveCampaign?:boolean, sameAsExistingAd?:boolean}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this before promote_creative_submission when the user asks to submit an existing Creative ID but placement/page/Instagram/link info is missing or says to use the currently active campaign/adset or same settings as an existing ad. This resolver performs real-time Meta read-only checks and returns suggestedPromotionArgs. Do not dump broad Meta lists; use its message to ask concise confirmation. After the user confirms, call promote_creative_submission with suggestedPromotionArgs rather than re-running broad inspection.",
  },
  {
    name: "promote_creative_submission",
    description:
      "/creatives に保存済みの生成クリエイティブを、画像と広告テキスト込みで ops repo の入稿PRに回す。Meta には直接反映しない。",
    args:
      "{creativeId?:string,creativeIds?:string[],placementMode?:'existing_adset'|'new_adset'|'new_campaign',inheritFromCampaignId?:string,inheritFromAdsetId?:string,inheritFromAdId?:string,creativeName?:string,adName?:string,adNameExplicit?:boolean,pageId?:string,title?:string,body?:string,linkUrl?:string,description?:string,instagramUserId?:string,instagramActorId?:string,instagramAppLink?:string,callToAction?:string,campaignId?:string,adsetId?:string,campaignName?:string,campaignNameExplicit?:boolean,adsetName?:string,adsetNameExplicit?:boolean,objective?:string,dailyBudget?:number,lifetimeBudget?:number,campaignDailyBudget?:number,campaignLifetimeBudget?:number,adsetDailyBudget?:number,adsetLifetimeBudget?:number,adsetBudgetSharing?:boolean,campaignBidStrategy?:string,campaignSpendCap?:number,campaignStartTime?:string,campaignStopTime?:string,specialAdCategoryCountry?:string[],isAdsetBudgetSharingEnabled?:boolean,campaignPacingType?:string[],optimizationGoal?:string,optimizationSubEvent?:string,billingEvent?:string,adsetBidStrategy?:string,bidAmount?:number,bidConstraints?:object,attributionSpec?:object[],destinationType?:string,frequencyControlSpecs?:object[],adsetSchedule?:object[],adsetPacingType?:string[],dailySpendCap?:number,lifetimeSpendCap?:number,dailyMinSpendTarget?:number,lifetimeMinSpendTarget?:number,isDynamicCreative?:boolean,pixelId?:string,customEventType?:string,objectStorySpec?:object,assetFeedSpec?:object,degreesOfFreedomSpec?:object,urlTags?:string,platformCustomizations?:object,videoId?:string,productSetId?:string,destinationSetId?:string,adPixelId?:string,trackingSpecs?:object|object[],conversionSpecs?:object|object[],conversionDomain?:string,creativeAssetGroupsSpec?:object,engagementAudience?:boolean,campaignGraphPayload?:object,adsetGraphPayload?:object,creativeGraphPayload?:object,adGraphPayload?:object,targeting?:object,countries?:string[],rationale?:string,urgency?:'low'|'normal'|'high'}",
    effects: ["gitops-pr"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this when the user asks to submit, PR, or入稿 creatives that already exist in /creatives, or gives Creative ID(s) from the creative library. If multiple Creative IDs are already selected, pass all of them as creativeIds and ask only for missing placement/submission settings, not which creative to use. Always set placementMode from intent. For existing_adset, campaignId/adsetId are the destination. For new_adset, campaignId is the parent. For new_campaign, campaignId/adsetId must not be destinations; if they came from a resolver or active object lookup, pass them as inheritFromCampaignId/inheritFromAdsetId/inheritFromAdId and provide objective/optimizationGoal/billingEvent/budget. Do not invent campaignName/adsetName/adName only for naming convenience; AdDroid auto-generates missing names and appends YYYY-MM-DD_addroid. If the user explicitly specifies a campaign/adset/ad name, pass that name and set campaignNameExplicit/adsetNameExplicit/adNameExplicit respectively so the runtime preserves it. For new_campaign, dailyBudget is campaign-level by default; use adsetDailyBudget only when the new adset itself should carry budget. Use typed aliases for common Graph fields and campaignGraphPayload/adsetGraphPayload/creativeGraphPayload/adGraphPayload for official snake_case fields without aliases. It reuses the stored image and stored Meta ad text; do not call generate_creatives again. Ask for missing creativeId/creativeIds, placement, pageId, destination link, optimizationGoal/billingEvent, budget, or country targeting before calling the tool. Human PR merge is required.",
  },
  {
    name: "propose_automation_rule",
    description:
      "自然言語の継続監視・自動運用依頼を安全評価可能なルール変更 PR として作成する。直接Metaには反映しない。",
    args:
      "{sourceText:string, rule:{id?:string, enabled?:boolean, schedule?:string, intent?:string, scope:{level:'account'|'campaign'|'adset'|'ad', accounts?:string[]}, window?:object, metrics?:object, computed?:object, when:{all?:Array<object>, any?:Array<object>}, action:{type:string, status?:'ACTIVE'|'PAUSED', [key:string]:unknown}, limits?:object, approval?:{mode:'proposal'|'auto_apply_if_policy_matched'|'auto_merge_if_policy_matched'|'report_only'}, safety?:object}, rationale?:string, title?:string}",
    effects: ["gitops-pr"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this when the user asks for recurring or conditional ad operations in natural language, such as hourly pause rules, budget changes, duplicating campaigns, or scheduled campaign changes. Ask concise clarification questions if schedule, lookback window, target scope, action, approval mode, or limits are missing. The PR itself is the approval request; once merged, enabled rules are listed on the automation page and scheduled by rule.schedule.",
  },
  {
    name: "propose_automation_rule_update",
    description:
      "drift検知などで停止した既存 automation rule の安全レール校正を、現在の実績に基づいて更新するGitHub PRを作成する。ユーザーがPR作成を承認した場合だけ使う。",
    args:
      "{ruleId:string, rationale?:string, title?:string}",
    effects: ["gitops-pr"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
    guidance:
      "Use this only after the user approves creating a recalibration PR for an existing automation rule. Do not use it from scheduled-agent runs; cron should only block and suggest.",
  },
  {
    name: "backup_data",
    description: "AdDroid データベースのバックアップを作成する。",
    args: "{}",
    effects: ["local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "open_web_ui",
    description: "ローカル Web UI の URL を表示する。",
    args: "{}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat"],
  },
  {
    name: "query_meta_ads",
    description: "Meta Graph API / Mirror DB の read-only query を実行する。",
    args: "{resource:'insights'|'adaccount'|'campaign'|'adset'|'ad'|'creative'|'catalog'|'dataset'|'page'|'product_feed'|'product_item'|'product_set', action?:'get'|'list'|'current', accountKey?:string, businessId?:string, catalogId?:string, since?:'YYYY-MM-DD', until?:'YYYY-MM-DD', datePreset?:'today'|'yesterday'|'last_3d'|'last_7d'|'last_14d'|'last_30d'|'last_90d'|'this_month'|'last_month', timeIncrement?:'daily'|'weekly'|'monthly'|'all_days', breakdowns?:string[], fields?:string[], campaignId?:string, adsetId?:string, adId?:string, id?:string, limit?:number}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use narrow read-only lookups to resolve factual missing values before asking the user, especially pageId, instagramUserId, linkUrl, existing creative, current active campaign/adset/ad, budget fields, status, objective, optimization, and billing fields. Prefer get by known ID or parent-filtered list with a small limit. Do not use this for mutations.",
  },
  {
    name: "query_performance",
    description: "Mirror DB の安全な定型集計で広告パフォーマンスを順位付き取得する。",
    args: "{accountId:string, level:'account'|'campaign'|'adset'|'ad', window:{preset:'today'|'yesterday'|'last_7d'|'last_14d'|'last_30d'}|{since:'YYYY-MM-DD', until:'YYYY-MM-DD'}, metric:'spend'|'impressions'|'clicks'|'conversions'|'ctr'|'cpc'|'cpm'|'cpa'|'frequency', rank?:'top'|'bottom', limit?:number, statusFilter?:'active'|'paused'|'all'}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this for natural-language performance ranking questions. It accepts only catalog fields, never SQL. Ratio metrics are computed from period sums. For efficiency metrics like cpa/cpc, use rank:'bottom' when the user asks for good/best/cheap results.",
  },
  {
    name: "compare_performance",
    description: "Mirror DB の安全な定型集計で2期間の広告パフォーマンス変化を比較する。",
    args: "{accountId:string, level:'account'|'campaign'|'adset'|'ad', currentWindow:{preset:'today'|'yesterday'|'last_7d'|'last_14d'|'last_30d'}|{since:'YYYY-MM-DD', until:'YYYY-MM-DD'}, baselineWindow:{preset:'today'|'yesterday'|'last_7d'|'last_14d'|'last_30d'}|{since:'YYYY-MM-DD', until:'YYYY-MM-DD'}, metric:'spend'|'impressions'|'clicks'|'conversions'|'ctr'|'cpc'|'cpm'|'cpa'|'frequency', rank?:'top'|'bottom', limit?:number, statusFilter?:'active'|'paused'|'all'}",
    effects: ["read"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this for before/after or period-over-period questions. It accepts only catalog fields, never SQL, and ranks by relative change while keeping low-sample rows flagged.",
  },
  {
    name: "sync_meta_mirror",
    description:
      "Meta の現在状態を Mirror DB に同期し、/campaigns や各チャット系の表示元を最新化する。Meta 側は変更しない。",
    args: "{accountKey?:string, accountId?:string, includeMetrics?:boolean}",
    effects: ["read", "local-write"],
    allowedSurfaces: ["cli-chat", "web-chat", "slack-chat", "scheduled-agent"],
    guidance:
      "Use this when the user asks to sync, refresh, update the displayed campaigns, or after Meta-side manual changes. This is read-only against Meta and writes only the local mirror DB.",
  },
] as const satisfies readonly AgentToolDefinition[];

export type AgentToolName = (typeof AGENT_TOOL_MANIFEST)[number]["name"];

export function getAgentToolsForSurface(
  surface: AgentSurface
): readonly AgentToolDefinition[] {
  return AGENT_TOOL_MANIFEST.filter((tool) =>
    (tool.allowedSurfaces as readonly AgentSurface[]).includes(surface)
  );
}

export function renderToolManifestForPrompt(
  surface: AgentSurface,
  language: AddroidLanguage = "ja"
): string {
  return getAgentToolsForSurface(surface)
    .map((tool) => {
      const guidance = tool.guidance ? ` ${tool.guidance}` : "";
      const description =
        language === "en" ? ENGLISH_TOOL_DESCRIPTIONS[tool.name] ?? tool.description : tool.description;
      return `- ${tool.name}: ${description} args ${tool.args}.${guidance}`;
    })
    .join("\n");
}

const ENGLISH_TOOL_DESCRIPTIONS: Record<string, string> = {
  diagnose: "Run a detailed AdDroid diagnosis.",
  check_status: "Check connection, DB, worker, GitHub, and runtime status.",
  list_ad_accounts: "List registered Meta ad accounts and Page / Instagram asset readiness evidence.",
  sync_ad_accounts: "Sync ad accounts from Meta and check Page / Instagram asset readiness evidence.",
  select_ad_account: "Select the default ad account.",
  connect_service: "Start or guide a Meta / GitHub / AI / Slack connection flow.",
  get_report: "Run a daily report, budget check, or improvement proposal now.",
  check_submission: "Validate ops repo submissions and show the dry-run plan without applying to Meta.",
  create_scheduled_agent_task: "Save and enable a recurring natural-language task.",
  set_schedule_enabled: "Update an existing preset schedule and enabled state.",
  configure_budget_guard: "Save ad-account budget monitoring rules and optionally enable its schedule.",
  create_experiment: "Register an A/B test between two active ads in the same ad set.",
  configure_submission_guards: "Configure pre-submit safety guards for ad changes.",
  manage_schedule: "List, run, or inspect existing preset schedules.",
  show_logs: "Show AdDroid operational logs.",
  stop_services: "Stop local AdDroid processes.",
  start_delivery: "Deprecated; use a GitOps PR for delivery-affecting changes.",
  propose_ops_change: "Create a GitHub PR for production ad changes without applying directly to Meta.",
  decide_approval: "Approve and merge, or reject, a tracked GitOps PR.",
  propose_creative_submission: "Create a creative/campaign/adset/ad submission PR from generated or local assets.",
  generate_creatives: "Generate new image creative ideas and save them to the creative library.",
  resolve_creative_submission_context: "Resolve missing placement/Page/Instagram/link context from current Meta state.",
  promote_creative_submission: "Promote saved generated creatives into an ops repo submission PR.",
  propose_automation_rule: "Create a safe GitHub PR for recurring or conditional ad-operation rules.",
  propose_automation_rule_update: "Create a recalibration PR for an existing automation rule.",
  backup_data: "Create an AdDroid database backup.",
  open_web_ui: "Show the local Web UI URL.",
  query_meta_ads: "Run a read-only query against Meta Graph API / Mirror DB.",
  query_performance: "Run a safe cataloged aggregate performance query against the Mirror DB.",
  compare_performance: "Compare two safe cataloged aggregate performance windows in the Mirror DB.",
  sync_meta_mirror: "Sync current Meta state into the Mirror DB without changing Meta.",
};

export function isToolAllowedOnSurface(
  toolName: string,
  surface: AgentSurface
): boolean {
  const normalized = toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return getAgentToolsForSurface(surface).some((tool) => tool.name === normalized);
}
