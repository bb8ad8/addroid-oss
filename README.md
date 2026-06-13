# AdDroid OSS

AdDroid は、Meta 広告運用を **GitOps** として管理するためのセルフホスト可能な OSS です。
Ads YAML をリポジトリの単一ソースとして扱い、AI が広告案・改善案を生成し、AdDroid が
GitHub PR と監査ログで変更を管理し、pg-boss Cron でレポート取得・予算監視・改善提案を
自動実行します。

> **Status:** Initial OSS release candidate. repository checkout では
> `npm install` / `npm run addroid -- init` で
> セットアップと常駐サービス登録が完結し、その後は `addroid <command>` を直接使えます。必要に応じて `addroid start` で
> 常駐サービスを起動・修復できます。セットアップ後の通常操作は
> `addroid chat` に自然文で依頼します。`addroid init` は
> GitHub CLI / PostgreSQL を診断し、不足分は同じ流れで確認しながらセットアップできます。
> Meta 広告アカウントを実際に利用するには Meta Access Token が必須です。未設定でも core
> ヘルスチェックは通りますが、Apply / Activate / レポート取得はできません。

---

## デザイン原則

- **ローカル完結**: Web UI は `127.0.0.1:3000` のみで listen。public IP / 専用ドメイン /
  SSL 証明書 / トンネリングサービスを要求しません。
- **outbound-only**: 全ての外部連携 (GitHub, Meta, Slack, LLM Provider, Image Provider) は
  AdDroid 側から outbound で起動します。GitHub Webhook は使わず、merged PR 検知は
  ETag-aware ポーリングで行います。Slack は Socket Mode のみで、request URL を要求しません。
- **GitOps**: 広告変更は ops repository の Pull Request としてレビュー・マージされ、
  全ての操作は監査ログ (`audit_logs`) に記録されます。
- **AI-assisted, human-approved**: AI は提案 (PR) を生成しますが、適用 (Apply) と有効化
  (Activate) は分離され、人間の承認 (PR merge / Web UI merge / Slack `/adops activate`) を
  経由してから Meta に反映されます。
- **Apply / Activate split**: PR merge から発火する Apply は新規オブジェクトを **PAUSED**
  で作成するのみで、ACTIVE 化は監査された有効化経路 (Web UI / Slack / 詳細 CLI) で行います。
- **未設定統合は idle で OK**: Slack / Meta / LLM Provider / Image Provider が未設定の状態でも
  Web UI は 200 OK を返し、Dashboard は idle 表示になります。ただし実際の Meta 広告アカウントを
  利用するには Meta Access Token が必須です。

詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。

---

## 必要条件

最初に手で用意する必要があるのは **Node.js / npm** です。Git でこのリポジトリを
clone する場合は Git も必要です。`.nvmrc` に固定しているため、`nvm use` で
Node.js 22.11 以上を使ってください。

初心者向けに分けると、セットアップで必要になるものは次の 3 種類です。

| 区分 | 必要なもの | 何に使うか | 誰が入れるか |
|---|---|---|---|
| 先に用意 | Node.js / npm | `npm install` と AdDroid CLI の実行 | ユーザー |
| 先に用意 | Git | リポジトリ clone と GitOps / PR 管理 | ユーザー |
| `npm install` | JavaScript / TypeScript 依存 | Web UI、worker、CLI、Prisma など | npm が repo 内の `node_modules` に入れる |
| `addroid init` | GitHub CLI (`gh`) | client id 不要のGitHubブラウザ認証 / ops repo 作成 | macOS は `brew install gh`、Linux は OS package manager で導入 |
| `addroid init` | PostgreSQL 16+ | AdDroid DB、queue、監査ログ | Homebrew / apt / dnf 等を実行前に確認 |
| Meta 側で発行 | Meta Access Token | Graph API 経由の Meta 広告アカウント接続、Apply / Activate、レポート取得 | ユーザーが Meta Business Suite / Graph API Explorer 等で発行 |

`addroid init` は初回セットアップ中に次の依存を診断します。不足している場合は、
実行するコマンドを表示してから確認します。`brew` や `sudo` を伴う可能性がある
system 変更は個別に確認します。

| 依存 | 用途 | `addroid init` の動作 |
|---|---|---|
| GitHub CLI (`gh`) | GitHub ブラウザ認証 / ops repo 作成 | macOS は Homebrew、Linux は apt / dnf 実行前に確認 |
| PostgreSQL 16+ | DB / pg-boss queue | macOS は Homebrew、Linux は apt / dnf 実行前に確認 |

Meta 連携の正規経路は Graph API です。Meta Ads CLI / Python / uv は標準必須依存では
ありません。CLI backend の検証や将来互換を試す場合だけ、別途 `meta-ads` CLI を導入し
`ADDROID_META_CLI_BIN` を設定してください。

PostgreSQL の OS パッケージ導入には Homebrew または `sudo` が必要になる場合があります。
セットアップに失敗した場合でも、表示されたコマンドを実行してから `addroid init`
を再実行すれば途中から続行できます。

`npm install` だけでは PostgreSQL などの OS 依存は入りません。OS やユーザー環境を
変更するものは `addroid init` の中で確認してから実行します。

`addroid init` が作成する主なローカルファイル:

- `.env`: `DATABASE_URL`、`ENCRYPTION_KEY`、任意の mock / provider 設定
- `~/.addroid/config.yaml`: AdDroid のローカル設定
- `~/.addroid/secrets.local.yaml`: provider 固有の暗号化済み secret stub
- `~/.addroid/storage` / `~/.addroid/logs` / `~/.addroid/run`: 実行時データ、ログ、pid file

これらの secret 系ファイルは git 追跡対象外です。Meta Access Token は
`ENCRYPTION_KEY` で暗号化され、平文では保存しません。

### サポート対象プラットフォーム

AdDroid OSS は POSIX 前提 (`0600` パーミッション、`pg_dump` / `pg_restore`、
shell で起動する worker / web プロセス) で動作するため、以下の OS のみ動作検証
しています。

| OS | 状態 | 備考 |
|---|---|---|
| macOS 13+ (darwin x86_64 / arm64) | **対応** | 主開発環境。Homebrew 経由で PostgreSQL を導入する想定 |
| Linux (x86_64 / arm64, glibc) | **対応** | Ubuntu 22.04+ / Debian 12+ / Fedora 39+ で動作 |
| Windows + WSL2 (Ubuntu 22.04+) | **対応 (推奨)** | WSL2 内の Linux として扱う。Windows native との混在不可 |
| Windows native (PowerShell / cmd.exe) | **非対応** | `0600` パーミッション、`pg_dump` の dynamic-link、常駐サービスの POSIX 前提が成立しないため対応しません。WSL2 を使用してください |
| その他 (FreeBSD, Alpine musl, etc.) | 動作未検証 | 詳細診断コマンド `addroid doctor` は `warn` として通過させますが動作保証は行いません |

`addroid doctor` の `platform` チェックがこの分類を runtime で再確認します
(macOS / Linux / WSL2 → `ok`、Windows native → `error`、それ以外 → `warn`)。
詳細は [`docs/SETUP.md` §1](docs/SETUP.md) と
[`docs/TROUBLESHOOTING.md` §0](docs/TROUBLESHOOTING.md) を参照してください。

実利用で必要な外部連携:

- GitHub 認証 — ops repo bootstrap と PR ポーリングに必要。CLI は `gh` があれば
  GitHub CLI のブラウザ認証を使うため client id 入力は不要です。Web UI OAuth Code Flow
  も使う場合は `~/.addroid/secrets.local.yaml` に `clientId` / `clientSecret` を追加します
- Meta Access Token — 実際の Meta 広告アカウント接続、Apply / Activate、レポート取得に必須
- LLM Provider — AI workflow 実行に必要。初回セットアップまたは `addroid connect ai` で
  Codex app-server / OpenAI API key / Claude (Anthropic) API key を選択できます
  (未設定時は StubLLMProvider で fail-closed)
- Image Provider — クリエイティブ画像生成に必要。OpenAI API key は GPT Image 2 に再利用でき、
  Codex は localhost の app-server 経路で生成できます
- Slack Bot / App-level token — 通知と `/adops` slash command に必要 (任意)

---

## Meta Access Token の取得

Meta へ実際に接続して Apply / Activate するには、Meta Marketing API を呼び出せる
Access Token が必要です。AdDroid の標準セットアップは OAuth callback を使わず、
`addroid connect meta` で token を貼り付ける方式です。ローカル利用のために HTTPS
callback URL やトンネルサービスを用意する必要はありません。

App ID / App Secret だけでは広告アカウントの読み書きはできません。AdDroid が
Graph API 呼び出し時に使うのは `ACCESS_TOKEN` と `AD_ACCOUNT_ID` です。AdDroid は token
入力後に取得できる Ad Account を表示し、利用するアカウントを選択します。

本番の広告入稿まで行う場合は、token 発行元の Meta App も本番利用できる状態にしておく
必要があります。AdDroid 自体は localhost-only のままで構いませんが、Meta App の
**App settings > Basic** に、外部から開ける **Privacy Policy URL** を設定し、必要に
応じてデータ削除方法の URL / 説明も設定してください。そのうえで App Mode を
**Live / 公開** にします。App が Development / 開発モードのままだと、token 登録や
アカウント一覧取得は通っても、Apply 時の creative 作成で Meta API が拒否することがあります。

公式リンク:

- [Meta for Developers](https://developers.facebook.com/)
- [Apps dashboard](https://developers.facebook.com/apps/)
- [Create app](https://developers.facebook.com/apps/create/)
- [Meta: Create an app](https://developers.facebook.com/docs/development/create-an-app/)
- [Meta Marketing API](https://developers.facebook.com/docs/marketing-api/)
- [Meta Marketing API: Get Started](https://developers.facebook.com/docs/marketing-apis/get-started)
- [Meta: Install Apps, Generate, Refresh, and Revoke System User Tokens](https://developers.facebook.com/docs/marketing-api/system-users/install-apps-and-generate-tokens)
- [Graph API Explorer](https://developers.facebook.com/tools/explorer/)

推奨手順:

1. [Meta for Developers](https://developers.facebook.com/) にログインし、必要なら開発者登録を完了します。
2. [Apps dashboard](https://developers.facebook.com/apps/) で **Create app** を押し、app type は **Business** を選びます。作成後に App ID が確認できれば、AdDroid 用には基本的に十分です。画面に **Marketing API** の追加や設定が表示される場合だけ有効化してください。
3. 作成した App の **App settings > Basic** を開き、Privacy Policy URL を設定します。店舗・会社サイトのプライバシーポリシーページなど、Meta からもブラウザからも開ける URL を使ってください。Meta の画面でデータ削除方法の URL / 説明を求められた場合も同じ画面で設定します。
4. 同じ App で **App Mode** を **Live / 公開** にします。公開できない場合は、Privacy Policy URL、連絡先メール、必要な基本項目が保存されているか確認してください。開発モードのまま発行した token は、後続の広告 creative 作成で拒否されることがあります。
5. [Meta Business Settings](https://business.facebook.com/settings) を開き、広告アカウントを管理している Business Portfolio を選びます。
6. **Users > System Users** で System User を作成します。長期運用では、個人ユーザーの token ではなく System User Access Token を使います。
7. 作成した System User を選び、**Add Assets** から次の asset を割り当てます。
   - **Ad Account**: AdDroid で連携・入稿・レポート取得する広告アカウント。広告の作成・更新まで行う場合は Admin / Full control 相当を付与します。
   - **Facebook Page**: 出稿に使うページ。Page 紐付けが必要な広告・creative を扱う場合に必要です。
   - **Instagram Account**: Instagram 配信やInstagram連携creativeを使う場合に必要です。
   - **App**: 手順 2 で作成し、手順 3-4 で本番利用できる状態にした Business App。token 発行時に選択します。
8. System User を選んだ状態で **Generate New Token** を押し、手順 2 の Business App を選択します。
9. Permission / scope は、`ads_read`, `ads_management`, `business_management` を選びます。AdDroid は広告アカウント一覧の取得、入稿操作、Business 配下の資産確認にこれらを使います。Meta の System User token は非期限 token と 60 日期限 token を選べます。漏えい時のリスクを抑えたい場合は 60 日期限 token を選び、定期的に再発行してください。
10. 表示された token は、その画面を離れると再表示できない前提で安全な場所に一時保管します。AdDroid へ登録した後は、平文を共有・コミットしないでください。
11. `addroid init` の対話セットアップ中に Meta アカウント連携まで進みます。スキップした場合だけ、後から次を実行してください。token 入力後、AdDroid が取得できる Ad Account を表示するので、利用するアカウントを選択してください。

```bash
addroid connect meta
```

検証だけなら [Graph API Explorer](https://developers.facebook.com/tools/explorer/) で User Access Token を生成して使うこともできます。ただし User token は個人ログインに紐付き、期限切れしやすいため、非エンジニアが継続運用する AdDroid では System User Access Token を標準手順とします。

Access Token はパスワード相当です。README、Issue、Slack、スクリーンショット、`.env.example`
などには貼らず、`addroid connect meta` の入力欄にだけ貼ってください。AdDroid は token を
`ENCRYPTION_KEY` で暗号化して `oauth_tokens` に保存し、Graph API 呼び出しの直前だけ
サーバー側で復号してリクエストに注入します。任意の CLI backend を検証する場合も、
token は実行直前に読み出し、argv やログには載せません。

OAuth callback を使いたい上級者は詳細コマンド `addroid auth meta --oauth` を利用できます。
この場合は HTTPS の callback URL を Meta App に登録できる環境が必要です。通常のローカル
OSS 利用では token 入力方式を使ってください。

---

## クイックスタート

最初に必要なのは Node.js / npm と、この repository checkout だけです。
`addroid init` は PostgreSQL 16+ / GitHub CLI / Codex CLI などを診断し、
不足している場合は実行するコマンドを表示してから `Y/n` で確認します。
推奨設定で進める場合は、内容を確認して Enter または `Y` を押してください。

Meta Access Token、GitHub 認証、LLM Provider は実利用に必要ですが、手元に
token や API key がない場合はセットアップ中に `n` でスキップできます。
スキップした接続は後から `addroid connect ...` で追加できます。

```bash
# 1. 依存をインストール
npm install

# 2. 初回セットアップ
#    PostgreSQL と、Meta / GitHub / LLM Provider の接続を順番に案内します。
#    初回は repository の local bin 経由で起動し、init 中に `addroid` command wrapper を作成します。
npm run addroid -- init

# 3. init 後はチャットに自然文で依頼できます
addroid chat

# 4. init で接続をスキップした場合だけ、後から個別に接続します
#    Meta は Ad Account 選択、GitHub は ops repository 作成まで行います。
#    AI は chat / 改善提案 / 自然言語タスクに必要です。
addroid connect meta
addroid connect github
addroid connect ai

# 5. Web UI や自動実行が動いていない場合だけ、常駐サービスを起動・修復
addroid start
```

### init 後の使い方

非エンジニアの通常利用では、コマンドを覚える必要はありません。`addroid init` が完了したら、
まず `addroid chat` を開き、やりたいことをそのまま日本語で入力してください。

例:

```text
昨日の広告レポートを見せて
今月の予算消化が速すぎるキャンペーンを確認して
改善案を作って GitHub PR にして
入稿ファイルに問題がないかチェックして
毎朝9時に前日のレポートを作るようにして
今使っている Meta 広告アカウントを確認して
Meta の接続をやり直したい
```

チャットは現在の接続状態を確認し、必要な AdDroid 操作を選んで実行します。危険な操作や
直接 Meta を書き換える操作は行わず、入稿・変更は GitHub PR、検証、dry-run 変更予定の確認を
経由します。画面で操作したい場合は `addroid open` で Web UI を開けます。

`addroid chat` が AI 未接続と表示した場合は `addroid connect ai`、Meta 未接続と表示した場合は
`addroid connect meta` を実行してください。接続状態をまとめて確認したい場合は
`addroid status` を使います。

`addroid init` は対話型 wizard として動作します。依存が不足している場合は、実行する
コマンドを見せた上で個別に確認します。Meta token / GitHub / LLM Provider が未設定の場合は、
Meta Access Token 入力、GitHub Device Flow 認証と ops repository 作成、
Codex app-server / OpenAI / Anthropic API key の選択まで案内します。
リポジトリ checkout で `addroid` コマンドが未設定の場合は、init 中に
`~/.addroid/bin/addroid` / `addroid-cli` などの command wrapper を作成し、必要に応じて
shell profile に PATH を追加します。新しい terminal では `addroid status` の形で使えます。
初期設定済みの状態で再実行した場合は、既存の config / secrets / credential を保持し、
状態表示だけで終了します。

初回セットアップで作成・設定されるもの:

- `.env`: password 付き `DATABASE_URL` / `ENCRYPTION_KEY` / 任意の mock / provider 設定
- `~/.addroid/config.yaml`: ローカル設定
- `~/.addroid/secrets.local.yaml`: OAuth secret 置き場の stub
- PostgreSQL の `addroid` DB / role (ローカル既定ではランダム password を生成)
- Prisma schema
- Meta Access Token: 実利用では必須。入力された値は暗号化して `oauth_tokens` に保存し、
  取得できる Ad Account から既定アカウントを選択
- GitHub OAuth: 実際の入稿には必須。CLI は GitHub CLI のブラウザ認証または Device Flow、
  Web UI は既存の OAuth Code Flow を使い、token を `oauth_tokens` に暗号化保存。
  未連携なら private ops repository を自動作成
- LLM Provider: Codex app-server または OpenAI / Anthropic API key を選択。Codex token は
  AdDroid に保存せず、API key のみ `oauth_tokens` に暗号化保存
- Image Provider: OpenAI API key 登録済みなら GPT Image 2 を利用可能。Codex の場合は
  localhost の `codex app-server` 経由で画像生成

Codex を選ぶ場合、`init` は local `codex app-server` を起動し、Codex CLI / ChatGPT の
ログイン状態を確認します。未ログインの場合はブラウザ認証へ進みます。AdDroid は
Codex token を保持しません。
初期セットアップ完了後、実 TTY ではそのまま `addroid chat` が起動します。
自動起動したくない場合は `addroid init --interactive --no-chat` を使います。
Web UI の Dashboard 最上部にも同じ Agent runtime を使うチャット欄があります。
CLI chat / Web chat / 自然言語 Agent task は同じ `AGENTS.md`、tool manifest、
deny policy、暗号化済み LLM credential を共有します。

初期設定済みの credential を更新したい場合は、明示的に再認証します。

```bash
# Meta Access Token を再登録
addroid connect meta

# GitHub token / ops repo を再設定
addroid connect github

# LLM Provider を選び直して再接続 (Codex app-server / OpenAI / Anthropic)
addroid connect ai
```

CI や手元の自動検証では次を使えます。

```bash
addroid init --non-interactive --yes --skip-deps --skip-db-push
```

外部 API に接続せずに起動確認だけしたい場合は mock フラグも同時に作成できます。

```bash
addroid init --non-interactive --yes --skip-deps --mock-integrations --skip-db-push
```

起動前に状態を確認したい場合は `doctor` を実行します。

```bash
addroid status
```

`doctor` は標準必須診断に Meta Ads CLI / Python / uv を含めません。標準の
Apply / Activate / レポート取得は Graph API 経路を使います。CLI backend の検証が必要な
場合だけ、`meta-ads` CLI を別途導入し、`ADDROID_META_CLI_BIN` を設定してください。

日次レポートは Meta Graph API の insights を正規経路として使います。
取得日の timezone は Meta ad account の `timezone_name` を優先し、取得できない場合は
`ADDROID_USER_TIMEZONE` / 実行環境 timezone / UTC の順にフォールバックします。
標準 cron の実行時刻は `ADDROID_USER_TIMEZONE` / `TZ` / 実行環境 timezone / UTC の順で解決し、
`daily_report` が前日分を毎朝9時に取得し、`today_report` が当日分を1時間ごとに取得します。
自然言語で保存したカスタム cron は、毎分の巡回ではなく次回実行分の `scheduled_task_run`
job として予約され、実行後に次回分を再予約します。

自然言語の自動運用リクエストは、直接 Meta を変更せず、まず
`workflows/automation-rules.yaml` と同形の DSL に変換してから評価します。例:
「本日消化 5000 円以上で 0CV のキャンペーンを停止」「過去 7 日間 CPA 3000 円以下の
キャンペーン予算を 20% 上げる」。停止対象は campaign / adset / ad、予算変更対象は
campaign / adset です。`ad` は直接予算を持たないため、親 adset または campaign に解決します。
「今すぐ」「一度だけ」が明示されていれば単発実行、「毎日」「1時間おき」などがあれば
定期ルールとして扱います。どちらか判断できない予算変更・停止・再開リクエストでは、
実行前に「今すぐ一度だけ」「定期ルール」「両方」の確認質問を返します。

リポジトリ checkout では `npm run addroid -- init` が checkout wrapper を作成します。
スキップした場合も `npm run addroid -- init` を再実行すると、以後は
`npm run addroid -- status` ではなく `addroid status` と入力できます。npm package として
導入する場合は `npm install -g @addroid/cli` でも同じ `addroid` コマンドが入ります。
worker のみ別プロセスに分離して水平スケールしたい場合は、前景実行の
`addroid start --foreground --separate-worker` を使います。
低レベルなデバッグ用途で個別に起動したい
場合のみ `npm run dev` / `npm run dev:worker` を直接呼び出せます。その場合は root の
`.env.local` を shell に export してから起動してください。

PostgreSQL の手動準備手順、`.env` と `.env.local` の挙動差、`addroid doctor` が点検する項目の
詳細は [`docs/SETUP.md`](docs/SETUP.md) を参照してください。

---

## モノレポ構成

```
addroid/
├── apps/
│   ├── web/                Next.js App Router (TypeScript) — localhost-only operator console
│   ├── worker/             pg-boss を起動する Node.js TypeScript ワーカー
│   └── cli/                `addroid` コマンド (init / start / stop / open / status / connect / account / report / submit / schedule / chat / backup、詳細系 doctor / logs / validate / plan / activate / cron / auth ほか)
├── packages/
│   ├── db/                 Prisma client の共通エクスポート
│   ├── config/             ~/.addroid/config.yaml と secrets.local.yaml の取扱い、暗号化境界
│   ├── queue/              pg-boss 設定とプリセット cron / Apply executor
│   ├── github-adapter/     GitHub OAuth + Octokit + ETag-aware ポーリング adapter
│   ├── meta-adapter/       Meta Graph API adapter (Real / Mock / Stub) と sandbox harness
│   ├── llm-provider/       LLM / Image Provider 抽象 (Codex / Stub / Mock) と Creative QA
│   ├── ops-schemas/        GitOps operation manifest の Zod スキーマ
│   └── ops-template/       生成 ops リポジトリのテンプレート
├── prisma/
│   └── schema.prisma       AdDroid テーブル + pg-boss 互換スキーマ
├── design/
│   └── tokens.css          UI デザイントークン (source of truth)
├── templates/
│   └── slack-app-manifest.yaml   Slack App Manifest (Socket Mode only)
└── docs/
    ├── ARCHITECTURE.md
    ├── SETUP.md
    ├── SECURITY.md
    ├── TROUBLESHOOTING.md
    ├── META.md
    ├── SLACK.md
    ├── LLM_PROVIDER.md
    └── GITOPS.md
```

---

## 主要コマンド

| コマンド | 説明 |
|---|---|
| `npm install` | ワークスペース全体の依存解決 |
| `npm run addroid -- init` | repository checkout の初回 bootstrap。完了後は `addroid <command>` を直接利用 |
| `addroid init` | command wrapper 作成後の再初期化・状態確認。既存 credential は保持 |
| `addroid update` | 既存環境の更新。Prisma クライアント再生成 + DB スキーマ反映 + 健全性チェックを 1 コマンドで。手順は [`docs/UPDATE.md`](docs/UPDATE.md) |
| `addroid chat` | 通常利用の入口。自然文でレポート、予算確認、改善提案、入稿チェック、接続確認を依頼 |
| `addroid start` | 常駐サービスをインストールして起動・修復。Web UI と worker はサービス内で動作 |
| `addroid stop` | 常駐サービスを停止 |
| `addroid open` | Web UI を開く / URL を表示 |
| `addroid status` | 接続・起動状態を確認 |
| `addroid connect meta` | Meta Access Token を登録し、広告アカウントを選択 |
| `addroid connect github` | GitHub 認証と ops repo 作成 |
| `addroid connect ai` | Codex app-server / OpenAI API key / Claude API key を選択して接続 |
| `addroid account` | 利用する広告アカウントを確認・選択 |
| `addroid report` | 日次レポートや予算チェックを今すぐ実行 |
| `addroid submit` | 入稿前チェックと dry-run 変更予定の確認 |
| `addroid schedule` | 自動実行の確認・変更 |
| `addroid backup` | データベースをバックアップ |
| `addroid doctor` | 詳細診断 (CI / troubleshooting 用) |
| `npm run dev` | (任意) apps/web 単独を `127.0.0.1:3000` で起動 |
| `npm run dev:worker` | (任意) apps/worker (pg-boss) 単独を起動 |
| `npm run typecheck` | 全ワークスペースで `tsc --noEmit` |
| `npm run lint` | 全ワークスペースで lint |
| `npm run test` | 全ワークスペースで単体テスト |
| `npm run db:generate` | Prisma クライアント再生成 |
| `npm run db:push` | DB スキーマを直接反映 (開発用) |
| `npm run db:migrate` | マイグレーションを生成して適用 |
| `npm run package:smoke` | `@addroid/cli` を `npm pack` して clean dir に install し postinstall / help / doctor を smoke-test |
| `npm run publish:dry-run` | `npm publish --dry-run` (実 publish は人間承認後に手動実行) |

---

## 主要ドキュメント

| ドキュメント | 内容 |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | ローカルセットアップ手順、PostgreSQL 準備、環境変数、`addroid doctor` の挙動 |
| [`docs/UPDATE.md`](docs/UPDATE.md) | 既存環境の更新手順 (`addroid update`)、スキーマドリフト警告、破壊的変更時の `--force` フロー |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | プロセスモデル、モノレポ境界、Prisma スキーマ、cron preset、Apply / Activate split |
| [`docs/SECURITY.md`](docs/SECURITY.md) | localhost-only / outbound-only 前提、token 暗号化、Meta / Slack / LLM トークン取扱、OSS リリース衛生 |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | よくある失敗モード (DB / `ENCRYPTION_KEY` / ポート競合 / OAuth / outbound 接続 / Slack Socket Mode / LLM 未設定) |
| [`docs/META.md`](docs/META.md) | Meta Access Token セットアップ、sandbox / mock harness、Apply / Activate split |
| [`docs/SLACK.md`](docs/SLACK.md) | Slack Socket Mode セットアップ (任意)、manifest テンプレ、`/adops` subcommand |
| [`docs/LLM_PROVIDER.md`](docs/LLM_PROVIDER.md) | Codex / OpenAI OAuth、`ADDROID_LLM_MOCK`、StubLLMProvider fail-closed、Image Provider |
| [`docs/GITOPS.md`](docs/GITOPS.md) | ops repo 構成、PR ポーリング、3 つの merge 経路 (GitHub / Web / Slack) と承認境界 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | npm publish 手順、SemVer 方針、CHANGELOG 運用、git tag、ロールバック (deprecate / dist-tag / unpublish) |
| [`CHANGELOG.md`](CHANGELOG.md) | リリースごとの変更点 (Keep a Changelog 1.1.0 / SemVer 2.0.0) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | OSS contribution flow、テスト走行、コミット規約、PR 規約、セキュリティ報告窓口 |

---

## OSS リリース衛生

- **secrets を絶対にコミットしない**: `.env*`, `secrets.local.yaml`, `*.local.yaml` は
  すべて `.gitignore` の対象です。`.env.example` には placeholder 値のみを書き、
  実値 (`ENCRYPTION_KEY` の本体や OAuth トークン) を書き込まないこと。
- **個人パスを書かない**: `~/.addroid` 等の home 相対表現を使い、絶対パスは
  `process.env.HOME` 経由で解決します。`ADDROID_HOME` を環境変数で上書きできます。
- **個人アカウントをハードコードしない**: GitHub / Meta / Slack / LLM の identifier は
  すべて DB / config / env から読みます。特定のユーザー名・トークン・組織名・`act_id` を
  ソースに埋め込まないこと。
- **outbound-only 仕様を破らない**: inbound webhook / 公開 URL / 専用ドメイン /
  SSL 証明書 / トンネリングサービスを要求する変更は禁止です。AdDroid OSS は
  `127.0.0.1` のみで listen し、外部統合は AdDroid 側からの outbound でのみ動作します。
- **任意統合のフェイルクローズ**: LLM Provider 未設定時は `StubLLMProvider` が fail-closed し、
  GitOps 状態を破壊しません。Slack / Image Provider 未設定時は通知 / 画像生成のみが
  skip され、Apply / Activate / レポート取得は通常通り動きます。
- **LLM credential は暗号化保存**: `addroid connect ai --provider openai|anthropic` の
  API key は `ENCRYPTION_KEY` により `oauth_tokens.access_token_ciphertext` に保存されます。
  Codex は local app-server の認証状態を使い、AdDroid は Codex token を保存しません。
- **画像生成キーも平文保存しない**: GPT Image 2 は登録済み OpenAI API key の暗号化済み
  credential を再利用します。Codex app-server 経路は localhost のみ許可し、外部 URL を
  ブラウザに露出しません。

詳細とリリース前チェックリストは [`docs/SECURITY.md`](docs/SECURITY.md) を、
リリース手順 (バージョニング / CHANGELOG / `npm publish` / git tag / ロールバック) は
[`docs/RELEASE.md`](docs/RELEASE.md) を、リリースごとの変更点は
[`CHANGELOG.md`](CHANGELOG.md) を参照してください。

---

## ライセンス

Apache-2.0 — リポジトリ root の `LICENSE` および各ワークスペースの `package.json#license`
が source of truth です。fork 時はライセンスを変更可能ですが、その場合は依存関係の互換性を
ご自身で確認してください。
