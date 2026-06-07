import fs from "node:fs";
import path from "node:path";
import { headers } from "next/headers";
import {
  buildSlackAppManifest,
  homeAnchorPath,
  readAddroidConfig,
  resolveAddroidPaths,
  resolveWebBinding,
  type BuiltSlackAppManifest,
  type SlackInstallationMetadata,
} from "@addroid/config";
import { prisma } from "../../lib/prisma";
import { Panel } from "../../components/ui/Panel";
import { StatusDot, type StatusState } from "../../components/ui/StatusDot";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { CodeBlock, InlineCode } from "../../components/ui/CodeBlock";
import { KeyValueList } from "../../components/ui/KeyValueList";
import { PageHeader } from "../../components/ui/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { SlackConnectForm } from "./SlackConnectForm";
import { DiscordConnectForm } from "./DiscordConnectForm";
import { formatDateTime, resolveDisplayTimeZone } from "../../lib/datetime";
import { resolveWebLanguage, webT } from "../../lib/i18n";

export const dynamic = "force-dynamic";

interface DoctorCheck {
  name: string;
  state: StatusState;
  message: string;
  hint?: string;
}

interface SlackManifestPreview {
  built: BuiltSlackAppManifest | null;
  yaml: string;
  error: string | null;
}

function buildSlackManifestPreview(
  repoRoot: string,
  workspaceDisplayName: string
): SlackManifestPreview {
  try {
    const built = buildSlackAppManifest({ workspaceDisplayName });
    return { built, yaml: built.yaml, error: null };
  } catch (err) {
    let fallbackYaml = "";
    try {
      fallbackYaml = fs.readFileSync(
        path.join(repoRoot, "templates/slack-app-manifest.yaml"),
        "utf8"
      );
    } catch {
      // Keep the original manifest error visible; the raw fallback is only a display aid.
    }
    return {
      built: null,
      yaml: fallbackYaml,
      error: (err as Error).message,
    };
  }
}

export default async function SetupPage() {
  const headerList = await headers();
  const language = await resolveWebLanguage(headerList.get("accept-language"));
  const t = (key: string, values?: Record<string, string | number | null | undefined>) =>
    webT(language, key, values);
  const pageDisplayTimeZone = resolveDisplayTimeZone();
  const paths = resolveAddroidPaths();
  const repoRoot = process.cwd().includes("/apps/web")
    ? path.resolve(process.cwd(), "../..")
    : process.cwd();
  const binding = (() => {
    try {
      return resolveWebBinding();
    } catch {
      return { hostname: "127.0.0.1", port: 3000 };
    }
  })();
  const workspaceDisplayName = await readAddroidConfig()
    .then((config) => config?.workspace.displayName ?? "Default Workspace")
    .catch(() => "Default Workspace");
  const slackManifestPreview = buildSlackManifestPreview(repoRoot, workspaceDisplayName);
  const slackManifest = slackManifestPreview.built?.manifest ?? null;
  const slackSlashCommand = slackManifest?.features.slash_commands?.[0] ?? null;
  const slackBotScopes = slackManifest?.oauth_config.scopes.bot ?? [];
  const slackBotEvents = slackManifest?.settings.event_subscriptions?.bot_events ?? [];

  // 直近 doctor 結果を表示。`addroid doctor` は実行のたびに doctor_results に
  // 1 行追記するので、最新行を取り出して状態と詳細を提示する。未実行 (DB 行なし) の
  // ケースは EmptyState で「まだ実行していない」ことを honest に示す。
  let lastDoctor: { ranAt: Date; overall: string; checks: DoctorCheck[] } | null = null;
  let dbReady = true;
  try {
    const row = await prisma.doctorResult.findFirst({ orderBy: { ranAt: "desc" } });
    if (row) {
      lastDoctor = {
        ranAt: row.ranAt,
        overall: row.overall,
        checks: Array.isArray(row.checks) ? (row.checks as unknown as DoctorCheck[]) : [],
      };
    }
  } catch {
    dbReady = false;
  }

  // Slack OAuth/Socket Mode 状態を `oauth_tokens(provider='slack')` から読む。
  // Slack は任意統合なので、行が無いケースは error / warn ではなく benign idle として
  // 扱い、UI とセキュリティチェックの双方で「Slack 未設定 (任意)」を info で示す。
  // 行が DB から取れなかった (DB 接続自体が落ちている) 場合は、別経路の dbReady で
  // Doctor 結果側がエラーを伝えるため、ここでは `null` を返す。
  let slackInstallation: {
    accountIdentifier: string;
    scopes: string[];
    hasBotToken: boolean;
    hasAppToken: boolean;
    connectedAt: Date;
    updatedAt: Date;
    metadata: Partial<SlackInstallationMetadata> | null;
  } | null = null;
  try {
    const row = await prisma.oAuthToken.findFirst({
      where: { provider: "slack" },
      orderBy: { connectedAt: "desc" },
    });
    if (row) {
      const meta =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Partial<SlackInstallationMetadata>)
          : null;
      slackInstallation = {
        accountIdentifier: row.accountIdentifier,
        scopes: row.scopes ?? [],
        hasBotToken: typeof row.accessTokenCiphertext === "string" && row.accessTokenCiphertext.length > 0,
        hasAppToken:
          typeof row.refreshTokenCiphertext === "string" && row.refreshTokenCiphertext.length > 0,
        connectedAt: row.connectedAt,
        updatedAt: row.updatedAt,
        metadata: meta,
      };
    }
  } catch {
    // DB 接続不可は doctor / dbReady 側で別途警告される。Slack 任意統合自体は
    // 失敗を伝播させない。
    slackInstallation = null;
  }

  // Setup ページのセキュリティチェック / 専用 Panel で再利用する Slack 状態サマリ。
  const slackStatus: { state: StatusState; label: string; detail: string } = (() => {
    if (!slackInstallation) {
      return {
        state: "info",
        label: t("setup.slack.unset"),
        detail: t("setup.slack.unsetDetail"),
      };
    }
    if (!slackInstallation.hasAppToken) {
      return {
        state: "warn",
        label: t("setup.slack.connectedNoAppToken"),
        detail:
          "xoxb- bot token は登録されていますが、xapp- app-level token が未登録のため Socket Mode が使えません。addroid connect slack を再実行して app token を登録してください。",
      };
    }
    const teamName = slackInstallation.metadata?.teamName ?? slackInstallation.accountIdentifier;
    const channelId = slackInstallation.metadata?.notificationChannelId;
    return {
      state: "ok",
      label: t("setup.slack.connected", {
        team: `${teamName}${channelId ? ` (channel ${channelId})` : ""}`,
      }),
      detail:
        "通知チャンネルが保存されています。Slack に障害があっても、承認済み変更の確認や自動実行は通常通り稼働します。",
    };
  })();

  // OSS リリース衛生チェック (UI 内で読み取り可能なものだけ判定する)
  const securityChecks: DoctorCheck[] = [
    {
      name: t("setup.security.localOnly"),
      state: binding.hostname === "127.0.0.1" || binding.hostname === "localhost" ? "ok" : "error",
      message: `bind=${binding.hostname}:${binding.port}`,
      hint:
        binding.hostname === "127.0.0.1" || binding.hostname === "localhost"
          ? undefined
          : "ADDROID_WEB_HOSTNAME を 127.0.0.1 に戻してください。",
    },
    {
      name: t("setup.security.secretsIgnored"),
      ...(() => {
        const gitignorePath = path.join(repoRoot, ".gitignore");
        try {
          const content = fs.readFileSync(gitignorePath, "utf8");
          const required = [".env", "secrets.local.yaml"];
          const missing = required.filter((token) => !content.includes(token));
          if (missing.length === 0) {
            return {
              state: "ok" as StatusState,
            message: "接続情報ファイルは共有対象から除外されています。",
            };
          }
          return {
            state: "error" as StatusState,
            message: `.gitignore に不足: ${missing.join(", ")}`,
          };
        } catch (err) {
          return {
            state: "warn" as StatusState,
            message: `.gitignore を読めません: ${(err as Error).message}`,
          };
        }
      })(),
    },
    {
      name: t("setup.security.encryption"),
      ...(() => {
        const key = process.env.ENCRYPTION_KEY ?? "";
        if (!key) {
          return {
            state: "error" as StatusState,
            message: "暗号化キーが未設定です。",
            hint: "初期設定をやり直してください。",
          };
        }
        if (key.length < 16) {
          return {
            state: "warn" as StatusState,
            message: "暗号化キーが短すぎます (16 文字以上推奨)。",
          };
        }
        return {
          state: "ok" as StatusState,
          message: "暗号化キーが設定されています。",
        };
      })(),
    },
    {
      name: t("setup.security.noInbound"),
      state: "ok",
      message:
        "AdDroid は公開URLを要求しません。承認済み変更は定期確認で検出します。",
    },
    {
      name: "Slack 連携 (任意)",
      state: slackStatus.state,
      message: slackStatus.label,
      hint: slackStatus.detail,
    },
  ];

  return (
    <>
      <PageHeader
        title={t("setup.title")}
        subtitle={t("setup.subtitle")}
      />

      <div className="page-body page-body--single">
        <Panel title={t("setup.memo.title")} subtitle={t("setup.memo.subtitle")}>
          <KeyValueList
            items={[
              { label: "アプリの準備", value: <CodeBlock>npm install</CodeBlock> },
              {
                label: "保存先の準備",
                value: (
                  <CodeBlock>
                    {`pg_isready -h localhost -p 5432
# addroid ロールを先に作成し、addroid 所有で DB を作成する
# (createdb 単独だと OS ユーザーが public スキーマを所有し、Prisma db push と pg-boss が失敗する)
# PASSWORD には 'addroid' のような既知の弱い値ではなく自前の強いパスワードを入れる
# (例: DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"))
psql -d postgres -c "CREATE ROLE addroid WITH LOGIN PASSWORD '<choose-a-strong-password>' CREATEDB;" 2>/dev/null || true
createdb -O addroid addroid 2>/dev/null || true
psql -d addroid -c "ALTER SCHEMA public OWNER TO addroid;" 2>/dev/null || true
psql -d addroid -c "GRANT ALL ON SCHEMA public TO addroid;" 2>/dev/null || true
# 上で決めたパスワードを .env / .env.local の DATABASE_URL に反映する
#   DATABASE_URL=postgresql://addroid:<password>@localhost:5432/addroid
npm run db:push`}
                  </CodeBlock>
                ),
              },
              {
                label: "初期化と起動 (推奨)",
                value: (
                  <CodeBlock>
                    {`addroid init      # 初期設定と接続を対話で完了
addroid status    # 接続・起動状態を確認
addroid start     # Web UI (127.0.0.1:3000) + worker を起動`}
                  </CodeBlock>
                ),
              },
              {
                label: "個別起動 (必要な時だけ)",
                value: (
                  <CodeBlock>
                    {`npm run dev          # apps/web 単独 (127.0.0.1:3000)
npm run dev:worker   # apps/worker (pg-boss) 単独`}
                  </CodeBlock>
                ),
              },
            ]}
          />
        </Panel>

        <Panel
          title="診断結果"
          subtitle="直近の接続・起動チェック"
          status={
            lastDoctor ? (
              <StatusDot state={lastDoctor.overall as StatusState}>{lastDoctor.overall}</StatusDot>
            ) : (
              <StatusDot state="idle">未実行</StatusDot>
            )
          }
        >
          {!dbReady ? (
            <EmptyState
              title="保存先の準備が未完了です"
              description="初期設定メモを確認した後、状態確認を実行すると検査結果がここに表示されます。"
            />
          ) : !lastDoctor ? (
            <EmptyState
              title="診断履歴はまだありません。"
              description="状態確認を実行すると、最新の検査結果がここに表示されます。"
            />
          ) : (
            <KeyValueList
              items={[
                {
                  label: "実行時刻",
                  value: formatDateTime(lastDoctor.ranAt, { timeZone: pageDisplayTimeZone }),
                  mono: true,
                },
                { label: "総合", value: lastDoctor.overall },
                {
                  label: "詳細",
                  value: (
                    <ul style={{ margin: 0, paddingLeft: "1rem" }}>
                      {lastDoctor.checks.map((c, idx) => (
                        <li key={idx}>
                          <strong>{c.name}:</strong> {c.message}
                          {c.hint ? <> — <em>{c.hint}</em></> : null}
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="安全設定" subtitle="ローカル運用で守る条件">
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "var(--space-3)" }}>
            {securityChecks.map((check) => (
              <li
                key={check.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content 1fr",
                  columnGap: "var(--space-3)",
                  alignItems: "start",
                }}
              >
                <StatusDot state={check.state}>{check.state}</StatusDot>
                <div>
                  <div style={{ fontWeight: "var(--weight-medium)" }}>{check.name}</div>
                  <div style={{ color: "var(--color-text-secondary)", fontSize: "var(--size-sm)" }}>
                    {check.message}
                  </div>
                  {check.hint ? (
                    <div style={{ color: "var(--color-text-tertiary)", fontSize: "var(--size-xs)" }}>
                      {check.hint}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title="Slack 連携 (任意)"
          subtitle="Slack 通知や /adops を使う場合だけ設定します"
          status={
            <span style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
              <StatusBadge state="idle">OPTIONAL</StatusBadge>
              <StatusDot state={slackStatus.state}>{slackStatus.label}</StatusDot>
            </span>
          }
        >
          <div className="setup-guide" aria-label="Slack 連携手順">
            <div className="setup-guide__intro">
              <h3>Slack 連携の手順</h3>
              <p>
                Slack 側でアプリを作り、3つの値をこの画面に貼り付けます。公開URLや
                ngrok は不要です。
              </p>
            </div>
            <ol className="setup-guide__steps">
              <li>
                <span className="setup-guide__step-index">1</span>
                <div>
                  <strong>Slack App を作成</strong>
                  <p>
                    <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
                      Slack API の Apps 画面
                    </a>
                    を開き、<InlineCode>Create New App</InlineCode> から
                    <InlineCode>From an app manifest</InlineCode> を選びます。
                    マニフェストは <InlineCode>templates/slack-app-manifest.yaml</InlineCode>
                    の内容を YAML 入力欄に貼り付けます。
                  </p>
                  <div className="slack-manifest-card">
                    <div className="slack-manifest-card__head">
                      <div>
                        <div className="slack-manifest-card__title">
                          Slack に貼り付けるマニフェスト
                        </div>
                        <p>
                          下の内容を Slack の <InlineCode>From an app manifest</InlineCode>
                          の YAML 入力欄にそのまま貼り付けます。JSON 入力欄ではありません。
                          ワークスペース名は
                          <InlineCode>{workspaceDisplayName}</InlineCode> として展開済みです。
                        </p>
                      </div>
                      <StatusBadge state={slackManifestPreview.error ? "warn" : "ok"}>
                        {slackManifestPreview.error ? "TEMPLATE" : "READY"}
                      </StatusBadge>
                    </div>
                    <KeyValueList
                      items={[
                        {
                          label: "作られるアプリ",
                          value: slackManifest?.display_information.name ?? "AdDroid",
                        },
                        {
                          label: "接続方式",
                          value: slackManifest?.settings.socket_mode_enabled
                            ? "Socket Mode のみ。公開URL / ngrok / request URL は不要です。"
                            : "テンプレートを確認してください。",
                        },
                        {
                          label: "Slash command",
                          value: slackSlashCommand ? (
                            <span>
                              <InlineCode>{slackSlashCommand.command}</InlineCode>{" "}
                              {slackSlashCommand.usage_hint}
                            </span>
                          ) : (
                            "—"
                          ),
                        },
                        {
                          label: "Slack からの起動",
                          value:
                            slackBotEvents.length > 0 ? (
                              <span>
                                <InlineCode>@AdDroid</InlineCode> メンション / DM を受信します
                                <span className="mono"> ({slackBotEvents.join(", ")})</span>
                              </span>
                            ) : (
                              "—"
                            ),
                        },
                        {
                          label: "Bot scopes",
                          value:
                            slackBotScopes.length > 0 ? (
                              <span className="mono">{slackBotScopes.join(", ")}</span>
                            ) : (
                              "—"
                            ),
                        },
                        {
                          label: "Interactivity",
                          value: slackManifest?.settings.interactivity?.is_enabled
                            ? "有効。Socket Mode 経由なので request_url は空のままです。"
                            : "—",
                        },
                      ]}
                    />
                    {slackManifestPreview.error ? (
                      <div className="setup-guide__note">
                        マニフェストの検証で警告が出ています: {slackManifestPreview.error}
                      </div>
                    ) : null}
                    <details className="slack-manifest-card__details" open>
                      <summary>YAML 入力欄に貼り付ける内容を表示</summary>
                      {slackManifestPreview.yaml ? (
                        <CodeBlock>{slackManifestPreview.yaml}</CodeBlock>
                      ) : (
                        <EmptyState
                          title="マニフェストを読み込めません"
                          description="templates/slack-app-manifest.yaml が存在するか確認してください。"
                        />
                      )}
                    </details>
                  </div>
                </div>
              </li>
              <li>
                <span className="setup-guide__step-index">2</span>
                <div>
                  <strong>Bot token を取得</strong>
                  <p>
                    Slack App の <InlineCode>OAuth & Permissions</InlineCode> で
                    ワークスペースにインストールし、<InlineCode>Bot User OAuth Token</InlineCode>
                    をコピーします。値は <InlineCode>xoxb-</InlineCode> で始まります。
                    添付画像を参考にしたクリエイティブ生成には
                    <InlineCode>files:read</InlineCode> が必要です。既存アプリの権限を
                    更新した場合は、再インストールしてからこの画面で再接続してください。
                  </p>
                </div>
              </li>
              <li>
                <span className="setup-guide__step-index">3</span>
                <div>
                  <strong>App token を取得</strong>
                  <p>
                    <InlineCode>Basic Information</InlineCode> の
                    <InlineCode>App-Level Tokens</InlineCode> で
                    <InlineCode>connections:write</InlineCode> を付けて作成します。
                    値は <InlineCode>xapp-</InlineCode> で始まります。
                  </p>
                </div>
              </li>
              <li>
                <span className="setup-guide__step-index">4</span>
                <div>
                  <strong>通知先チャンネルを決める</strong>
                  <p>
                    Slack のチャンネル詳細からチャンネルIDをコピーします。
                    <InlineCode>C</InlineCode> や <InlineCode>G</InlineCode> で始まる値です。
                    そのチャンネルで <InlineCode>/invite @AdDroid</InlineCode> を実行し、
                    AdDroid のBotも追加してください。Bot が未参加だとテスト送信は
                    <InlineCode>not_in_channel</InlineCode> で失敗します。
                  </p>
                </div>
              </li>
              <li>
                <span className="setup-guide__step-index">5</span>
                <div>
                  <strong>この画面で保存</strong>
                  <p>
                    下のフォームに3つの値を貼り付けます。テスト送信をONにすると、
                    保存時に通知チャンネルへ接続確認メッセージを送ります。
                  </p>
                </div>
              </li>
            </ol>
            <div className="setup-guide__note">
              保存した token は暗号化してDBに保存され、この画面には再表示しません。
              Slack 側で権限を変更した場合は、Slack App を再インストールしてから再接続してください。
              <InlineCode>files:read</InlineCode> がない古い接続では、Slack 添付画像を
              クリエイティブ生成の参考画像として取得できません。
            </div>
          </div>
          <div style={{ marginBottom: "var(--space-4)" }}>
            <SlackConnectForm />
          </div>
          {!slackInstallation ? (
            <EmptyState
              title="Slack は任意です。AdDroid は Slack なしでも動作します。"
              description="Slack 通知や /adops を有効にしたい場合のみ接続してください。公開 URL は必要ありません。"
            />
          ) : (
            <KeyValueList
              items={[
                {
                  label: "状態",
                  value: <StatusDot state={slackStatus.state}>{slackStatus.label}</StatusDot>,
                },
                {
                  label: "Team",
                  value: slackInstallation.metadata?.teamName
                    ? `${slackInstallation.metadata.teamName} (${slackInstallation.metadata.teamId ?? slackInstallation.accountIdentifier})`
                    : slackInstallation.accountIdentifier,
                  mono: true,
                },
                {
                  label: "Bot user",
                  value: slackInstallation.metadata?.botUser
                    ? `@${slackInstallation.metadata.botUser}${
                        slackInstallation.metadata.botUserId
                          ? ` (${slackInstallation.metadata.botUserId})`
                          : ""
                      }`
                    : "—",
                  mono: true,
                },
                {
                  label: "通知チャンネル",
                  value: slackInstallation.metadata?.notificationChannelId ?? "—",
                  mono: true,
                },
                {
                  label: "Bot token (xoxb-)",
                  value: (
                    <StatusDot state={slackInstallation.hasBotToken ? "ok" : "warn"}>
                      {slackInstallation.hasBotToken
                        ? "保存済み"
                        : "未登録"}
                    </StatusDot>
                  ),
                },
                {
                  label: "Slack アプリ接続",
                  value: (
                    <StatusDot state={slackInstallation.hasAppToken ? "ok" : "warn"}>
                      {slackInstallation.hasAppToken
                        ? "保存済み"
                        : "未登録"}
                    </StatusDot>
                  ),
                },
                {
                  label: "許可された範囲",
                  value:
                    slackInstallation.scopes.length > 0 ? (
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {slackInstallation.scopes.join(", ")}
                      </span>
                    ) : (
                      "—"
                    ),
                },
                  {
                    label: "直近 Socket Mode 接続テスト",
                    value: slackInstallation.metadata?.lastSocketModeTestAt
                      ? formatDateTime(slackInstallation.metadata.lastSocketModeTestAt, {
                          timeZone: pageDisplayTimeZone,
                        })
                      : "未テスト",
                    mono: true,
                  },
                  {
                    label: "直近テストメッセージ送信",
                    value: slackInstallation.metadata?.lastTestMessageAt
                      ? formatDateTime(slackInstallation.metadata.lastTestMessageAt, {
                          timeZone: pageDisplayTimeZone,
                        })
                      : "未送信",
                    mono: true,
                  },
                  {
                    label: "接続日時",
                    value: formatDateTime(slackInstallation.connectedAt, {
                      timeZone: pageDisplayTimeZone,
                    }),
                    mono: true,
                  },
                  {
                    label: "更新日時",
                    value: formatDateTime(slackInstallation.updatedAt, {
                      timeZone: pageDisplayTimeZone,
                    }),
                    mono: true,
                  },
                {
                  label: "再接続 / 切断",
                  value: "上のフォームから更新または切断できます。",
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="Discord 連携 (任意)" subtitle="Slack と並ぶ第2の対話チャネル">
          <div className="setup-guide__note">
            Discord Developer Portal で Bot を作成し、<strong>MessageContent 特権インテント</strong>を
            有効化、対象サーバーへ招待してから、Bot トークン・サーバー(guild) ID・チャンネル ID を
            入力してください。Gateway はアウトバウンド接続のみで公開 URL は不要です。保存した
            token は暗号化保存され、この画面には再表示しません。
          </div>
          <div style={{ marginBottom: "var(--space-4)" }}>
            <DiscordConnectForm />
          </div>
          <EmptyState
            title="Discord は任意です。AdDroid は Discord なしでも動作します。"
            description="承認待ちPR・日次レポート・budget guard 通知を Discord で受け取り、対象チャンネルで /adops コマンドやメンションから依頼できます。接続状態は `addroid doctor` で確認できます。"
          />
        </Panel>

        <Panel title="Documentation" subtitle="リポジトリ内の参照ドキュメント">
          <KeyValueList
            items={[
              { label: "README", value: <InlineCode>README.md</InlineCode> },
              { label: "Setup ガイド", value: <InlineCode>docs/SETUP.md</InlineCode> },
              { label: "Security 文書", value: <InlineCode>docs/SECURITY.md</InlineCode> },
              { label: "Architecture", value: <InlineCode>docs/ARCHITECTURE.md</InlineCode> },
              { label: "AdDroid home", value: homeAnchorPath(paths.home), mono: true },
              { label: "Config file", value: homeAnchorPath(paths.configFile), mono: true },
              {
                label: "Secrets file (gitignored)",
                value: homeAnchorPath(paths.secretsFile),
                mono: true,
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
