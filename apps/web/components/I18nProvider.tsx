"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WebLanguage = "ja" | "en";

const CLIENT_MESSAGES: Record<WebLanguage, Record<string, string>> = {
  ja: {
    "nav.group.overview": "全体",
    "nav.home": "ホーム",
    "nav.group.ops": "広告運用",
    "nav.accounts": "広告アカウント",
    "nav.dailyReport": "日次レポート",
    "nav.budget": "予算チェック",
    "nav.guards": "安全ガード",
    "nav.plans": "入稿前チェック",
    "nav.campaigns": "配信中の広告",
    "nav.group.improve": "改善",
    "nav.improvements": "改善提案",
    "nav.experiments": "A/Bテスト",
    "nav.creatives": "クリエイティブ生成",
    "nav.creativeSubmit": "クリエイティブ入稿",
    "nav.group.automation": "確認と自動化",
    "nav.approvals": "承認待ち",
    "nav.cron": "自動実行",
    "nav.cronRuns": "実行ログ",
    "nav.audit": "操作履歴",
    "nav.github": "GitHub 連携",
    "nav.group.settings": "設定",
    "nav.setup": "接続と健康状態",
    "chat.title": "やりたいことを入力",
    "chat.description":
      "レポート取得、入稿前チェック、アカウント同期、バックアップ、自動実行の設定を文章で依頼できます。",
    "chat.empty":
      "「日次レポートを取得」「入稿前チェック」「Meta広告アカウントを同期」「予算チェックを有効にして」などを入力できます。",
    "chat.badge": "安全確認つき",
    "chat.placeholder": "例: 日次レポートを取得して",
    "chat.example.daily": "日次レポートを取得して",
    "chat.example.submit": "入稿前チェックを実行して",
    "chat.example.sync": "Meta広告アカウントを同期して",
    "chat.example.backup": "バックアップを作成して",
    "chat.example.status": "広告アカウントの状態を確認して",
    "chat.example.schedule": "毎朝9時に日次レポートを送る設定にして",
    "chat.history": "会話履歴",
    "chat.current": "現在の会話",
    "chat.new": "新しい会話",
    "chat.startNew": "新しい会話を開始",
    "chat.thinking": "応答を作成中",
    "chat.attach": "素材・参考画像を添付",
    "chat.running": "実行中",
    "chat.send": "送信",
    "chat.history.openFailed": "会話履歴を開けません",
    "chat.attachmentPrefix": "添付:",
    "chat.failed": "実行できませんでした: {error}",
    "chat.done": "実行しました。",
    "chat.noAnswer": "回答はありません。",
  },
  en: {
    "nav.group.overview": "Overview",
    "nav.home": "Home",
    "nav.group.ops": "Ad Operations",
    "nav.accounts": "Ad Accounts",
    "nav.dailyReport": "Daily Report",
    "nav.budget": "Budget Check",
    "nav.guards": "Safety Guards",
    "nav.plans": "Pre-Submit Check",
    "nav.campaigns": "Live Ads",
    "nav.group.improve": "Improve",
    "nav.improvements": "Improvement Ideas",
    "nav.experiments": "A/B Tests",
    "nav.creatives": "Creative Generation",
    "nav.creativeSubmit": "Creative Submission",
    "nav.group.automation": "Review & Automation",
    "nav.approvals": "Pending Approval",
    "nav.cron": "Automation",
    "nav.cronRuns": "Run Logs",
    "nav.audit": "Audit Trail",
    "nav.github": "GitHub",
    "nav.group.settings": "Settings",
    "nav.setup": "Connections & Health",
    "chat.title": "What would you like to do?",
    "chat.description":
      "Ask for reports, pre-submit checks, account sync, backups, and automation settings in plain language.",
    "chat.empty":
      'Try requests like "Get the daily report", "Run a pre-submit check", "Sync Meta ad accounts", or "Enable budget checks".',
    "chat.badge": "Safety checked",
    "chat.placeholder": "Example: Get the daily report",
    "chat.example.daily": "Get the daily report",
    "chat.example.submit": "Run a pre-submit check",
    "chat.example.sync": "Sync Meta ad accounts",
    "chat.example.backup": "Create a backup",
    "chat.example.status": "Check ad account status",
    "chat.example.schedule": "Send the daily report every morning at 9",
    "chat.history": "Conversation history",
    "chat.current": "Current conversation",
    "chat.new": "New conversation",
    "chat.startNew": "Start a new conversation",
    "chat.thinking": "Composing a response",
    "chat.attach": "Attach assets or reference images",
    "chat.running": "Running",
    "chat.send": "Send",
    "chat.history.openFailed": "Could not open conversation history",
    "chat.attachmentPrefix": "Attached:",
    "chat.failed": "Could not run: {error}",
    "chat.done": "Done.",
    "chat.noAnswer": "No answer was returned.",
  },
};

const CLIENT_LITERAL_OVERRIDES: Record<string, string> = {
  "ガード設定チャット": "Guard Settings Chat",
  "予算増加ガードの警告ラインとブロックラインを会話で変更できます。":
    "Change budget-increase warning and blocking thresholds through chat.",
  "例のように「3倍で警告、6倍でブロック」などと入力してください。保存後、左の一覧に反映されます。":
    'Enter a request such as "warn at 3x and block at 6x". Saved changes appear in the list on the left.',
  "CIガード": "CI guard",
  "例: 予算増加は3倍で警告、6倍でブロックにして":
    "Example: Warn at 3x budget increase and block at 6x",
  "予算増加は2倍で警告、5倍でブロックにして":
    "Warn on budget increases over 2x and block over 5x",
  "警告を3倍、ブロックを6倍に変更して": "Change warning to 3x and blocking to 6x",
  "今より厳しく、1.5倍で警告、3倍でNGにして":
    "Make it stricter: warn at 1.5x and block at 3x",
  "クリエイティブ入稿チャット": "Creative Submission Chat",
  "キャンペーン作成、広告セット作成、既存広告セットへの広告作成を会話で進めます。足りない情報はエージェントが確認します。":
    "Create campaigns, ad sets, or ads in existing ad sets through chat. The agent will ask for missing details.",
  "素材を添付して「この画像で既存広告セットに広告を作って」や「新規キャンペーンから作りたい」と入力してください。Meta への反映は GitHub PR の承認後です。":
    "Attach assets and ask to create an ad in an existing ad set or start a new campaign. Meta changes apply only after GitHub PR approval.",
  "例: 添付画像で春セール広告を作りたい。足りない情報は質問して":
    "Example: Create a spring sale ad from the attached image. Ask me for missing details.",
  "選択済みのCreativeをすべて既存広告セットに入稿PR化したい。足りない情報を確認して。":
    "Create submission PRs for all selected Creatives in an existing ad set. Ask for any missing details.",
  "添付した画像で、既存の広告セットに新しい広告を追加したい。配信先は一緒に確認してほしい。":
    "Use the attached image to add a new ad to an existing ad set. Help me confirm the destination.",
  "新しいキャンペーンから作りたい。目的はサイトへのアクセス、日予算は 500 円、配信国は日本。":
    "I want to create a new campaign. The objective is website traffic, daily budget is 500 JPY, and the country is Japan.",
  "既存キャンペーンの設定をコピーして、別クリエイティブで新規入稿したい。":
    "Copy the settings from an existing campaign and submit a new creative.",
};

const I18nContext = createContext<WebLanguage>("ja");

export function I18nProvider({
  language,
  children,
}: {
  language: WebLanguage;
  children: ReactNode;
}) {
  return <I18nContext.Provider value={language}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const language = useContext(I18nContext);
  return {
    language,
    literal: (value: string) =>
      language === "ja" ? value : CLIENT_LITERAL_OVERRIDES[value] ?? value,
    t: (key: string, values?: Record<string, string | number | null | undefined>) =>
      clientT(language, key, values),
  };
}

function clientT(
  language: WebLanguage,
  key: string,
  values?: Record<string, string | number | null | undefined>
): string {
  const template = CLIENT_MESSAGES[language]?.[key] ?? CLIENT_MESSAGES.ja[key] ?? key;
  if (!values) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const value = values[name];
    return value === null || value === undefined ? "" : String(value);
  });
}
