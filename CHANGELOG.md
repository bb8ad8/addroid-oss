# Changelog

All notable changes to **AdDroid OSS** are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

> **公開対象 npm package:** [`@addroid/cli`](apps/cli/package.json)。
> その他のワークスペース (`@addroid/web`, `@addroid/worker`, `@addroid/*` パッケージ) は
> `private: true` であり npm には公開されません。CHANGELOG はリポジトリ全体の
> オペレータ可視な変更を記録します。
>
> リリース手順は [`docs/RELEASE.md`](docs/RELEASE.md) を参照してください。

---

## バージョニング方針

- **Public surface:** `@addroid/cli` npm package (`addroid` / `addroid-cli` bin alias)、
  `addroid` CLI、`apps/web` の SSR ルートと API、`prisma/schema.prisma`、
  `~/.addroid/config.yaml` のスキーマ、`packages/ops-schemas` で定義する GitOps operation
  manifest のスキーマ、`packages/agent-runtime` の Agent tool manifest、ops template の
  `.addroid/project.json` / `cron.json` / `budget-guard.json` /
  `automation-rules.yaml`、`docs/SECURITY.md` で定義する outbound-only / localhost-only 契約。
- **MAJOR (X.0.0):** Public surface に対する breaking change (CLI サブコマンド削除 / 既定挙動の
  逆転、Prisma の破壊的マイグレーション、YAML スキーマの後方互換喪失、`~/.addroid/` レイアウトの
  非互換変更、outbound-only / localhost-only 契約の変更)。アップグレードガイドを
  [`docs/RELEASE.md`](docs/RELEASE.md) §"破壊的変更" に併記する。
- **MINOR (0.X.0):** 後方互換を保つ機能追加 (新しい cron preset、新しい LLM / Image / Storage
  Provider、新しい SideNav ルート、新しい `addroid` サブコマンド、追加の Zod スキーマ等)。
- **PATCH (0.0.X):** バグ修正、文言修正、依存更新で Public surface に影響しないもの。
- **0.x.y 期間中の運用:** AdDroid OSS は v1.0.0 到達まで、Public surface の変更は
  MINOR で吸収しうる旨を [`docs/RELEASE.md`](docs/RELEASE.md) に明記する。breaking と判断した
  変更は CHANGELOG の `### Changed` / `### Removed` で **太字** で告知する。

---

## [Unreleased]

### Added — 既存環境の簡単アップデート

- `addroid update` コマンドを追加。`git pull` で新しいバージョンを取り込んだあと、
  これ 1 つで Prisma クライアント再生成 (`db:generate`) と DB スキーマ反映 (`db:push`) を
  実行する。新機能はすべて nullable カラム / default / optional フィールドで追加されるため
  既存データを保持したまま追従でき、破壊的変更を検出した場合のみ停止して
  `addroid backup` → `addroid update --force` を案内する (fail-closed)。
- `addroid doctor` に `schema-drift` チェックを追加。`prisma migrate diff --exit-code` で
  DB スキーマとコードの乖離を検知し、未反映の変更があれば `addroid update` を案内する。
- 既存ユーザー向けのアップデート手順を [`docs/UPDATE.md`](docs/UPDATE.md) に新設。

### Added — リリースノートの GitHub 自動発行

- `v*` タグの push をトリガーに GitHub Release を自動発行する `release` ワークフロー
  ([`.github/workflows/release.yml`](.github/workflows/release.yml)) を追加。Release 本文は
  `scripts/extract-changelog.mjs` が CHANGELOG の該当セクションから抽出するため、CHANGELOG を
  唯一の source of truth に保ったまま「何が変わったか」が Releases ページで一目で分かる。
  ハイフンを含むタグは prerelease として発行する。
- マージ済み PR をラベル別に整形する GitHub 自動リリースノート設定
  ([`.github/release.yml`](.github/release.yml)) を追加。
- CHANGELOG 抽出スクリプトと単体テスト (`npm run test:scripts`) を追加。
- [`docs/RELEASE.md`](docs/RELEASE.md) Step 8 を「タグ push → 自動発行」に更新。

---

## [0.1.0] - 2026-06-03

> AdDroid OSS の初回 OSS 公開リリース。`addroid init` / `addroid start` / `addroid status` /
> `addroid open` と詳細診断系コマンドでローカル起動が完結する localhost-only / outbound-only / GitOps 駆動の
> Meta 広告運用コンソールを提供します。

### Added — Operator console foundation

- `apps/web` (Next.js App Router, TypeScript) を `127.0.0.1:3000` only で listen。
  Web UI 認証は持たず、ローカルプロセス信頼モデルで動作。
- `apps/worker` (pg-boss) と `apps/cli` (`addroid` コマンド) のモノレポ構成。
- `addroid` / `addroid-cli` bin alias と、operator 向けコマンド
  `init` / `start` / `stop` / `open` / `status` / `connect` / `account` /
  `report` / `submit` / `schedule` / `chat` / `backup`。
- 詳細・CI 向けコマンド `doctor` / `logs` / `service` / `restore` /
  `validate` / `up` / `down` / `plan` / `activate` / `cron` / `auth` /
  `accounts`。
- `~/.addroid/` 配下の `config.yaml` / `secrets.local.yaml` / `storage/` / `logs/` /
  `run/` の冪等初期化と `0600` パーミッション強制。
- `packages/config` の AES-256-GCM 暗号化境界 (`v1.aes256gcm.<iv>.<tag>.<payload>` 形式)。
- Prisma schema に AdDroid 12 必須テーブル + pg-boss 互換スキーマ。
- SideNav の 6 グループ (Overview / Meta Ads / AI Workflows / GitOps / Notifications /
  Maintenance)、TopBar の Mode / Provider / Image / Meta / Slack チップ。

### Added — GitOps + Apply / Activate split

- GitHub OAuth + Octokit + ETag-aware ポーリングで merged PR を検知 (Webhook 不使用)。
- ops repo bootstrap (`@addroid/ops-template` 由来の operation manifest skeleton ほか)。
- Apply executor が新規オブジェクトを **すべて PAUSED で作成** し、ACTIVE 化は別経路
  (`addroid activate` / Web UI / Slack) に分離。
- `audit_logs` の polymorphic targetType による Apply / Activate の独立承認境界。
- `/plans` `/campaigns` `/accounts` `/accounts/select` ルートと、
  `/api/plan` / `/api/approvals/[prNumber]/merge` / `/api/campaigns/sync` /
  `/api/campaigns/[id]/activate` / `/api/accounts` / `/api/accounts/default`。
- `/setup` の Doctor 結果セクション (DB / worker / GitHub / Meta / Storage / env_hygiene)。

### Added — AI workflows + LLM Provider abstraction

- `packages/llm-provider` に Codex / Stub / Mock の 3 実装と factory。
- `daily_report` / `budget_guard` / `improvement_pr` / `adhoc` の 4 ワークフロー。
- AI agents (strategy / copy / analyst / media_buyer / gitops / audit) の役割分離。
- LLM Provider 未設定時の `StubLLMProvider` fail-closed 動作 (GitOps 状態を破壊しない)。
- `/reports/daily` `/budget` `/improvements` `/ai` ルートと、
  `/api/budget/policy` / `/api/ai/provider` / `/api/agent-tasks` /
  `/api/agent-tasks/[id]/run` / `/api/agent-tasks/[id]/toggle`。
- ai_runs の inputs / outputs に対する sanitize-on-render redactor。

### Added — Optional Slack integration + three approval paths

- Slack Socket Mode (`xapp-` の `connections:write` scope) + Bot トークン (`xoxb-`) の
  暗号化保存。Slack request URL / event URL は不要。
- `/adops` slash command 6 サブコマンド (3 秒以内 ack → pg-boss → response_url 応答)。
- 通知 dispatch (`notification_dispatch`) と任意 fail-soft 動作 (Slack 未設定時は skip)。
- 3 経路 merge (GitHub merge / Web UI merge / Slack `/adops activate`) の
  `approval_records.decisionSource` 区別。
- `/approvals` `/approvals/[prNumber]` ルートと、
  `/api/slack/connect` / `/api/chat` / `/api/cron/[name]/run-status` /
  `/api/cron/[name]/run` / `/api/cron/[name]/schedule` / `/api/cron/[name]/toggle`。
- `templates/slack-app-manifest.yaml` (Socket Mode only テンプレ)。

### Added — Creative generation + Image Provider abstraction

- `packages/llm-provider` の image-factory に OpenAI / Stub / Mock の 3 image-Provider。
- Image Prompt Agent + Creative QA Agent (5 check kind: dimensions / format / quality /
  forbidden_expression / brand_tone)。
- `LocalDiskStorage` 抽象 (`storage://creatives/<account_key>/<creative_id>/<asset_id>.<ext>`)
  と `~/.addroid/storage/` への mode `0600` 書き込み + path-traversal 拒否。
- `/api/creatives/[id]/asset/[assetId]` プロキシ (third-party origin を `<img src>` に
  露出しない)。
- improvement_pr に creative metadata + QA result + storage ref を添付するフロー。
- Image Provider 未設定時の `succeeded_text_only` fallback (`improvement_pr` をテキストのみで
  作成、UI は benign idle 表示)。
- `/creatives` `/creatives/[id]` `/creatives/library` `/creatives/review` /
  `/creatives/submit` ルートと、`/api/creatives/[id]/asset/[assetId]` /
  `/api/creatives/submit`。

### Added — Release readiness, sandbox / mock, and npm packaging

- `apps/web/scripts/browser-test.mjs` の自動化と release verification 組み込み (主要 13 ルート SSR + nav)。
- Meta sandbox / mock ハーネス (`MockMetaAdapter` + `MockMetaSandbox` + `META_MOCK=1`)。
  外部 `graph.facebook.com` への通信なしで campaign / adset / ad / creative / insights を
  deterministic に再現。
- TopBar / `/setup#meta` / `/accounts` / Apply・Activate ConfirmDialog の
  `MetaExecutionModeBadge` (`live` / `sandbox` / `mock` / `unconfigured`)。
- `/setup#release` OSS Release Readiness カード (`addroid doctor` の 9 check を 1 枚に集約) と
  `/setup#documentation` ドキュメントクロスリファレンス。
- `.github/workflows/ci.yml` に build / typecheck / test / db setup / browser E2E /
  package smoke / `npm publish --dry-run` を追加 (実 publish は人間承認後の手動)。
- `scripts/oss-hygiene-scan.mjs` (個人 path / 個人 GitHub login / token 形状 /
  unsafe default の build-time 検出) を CI に組み込み。
- `apps/cli` を `npm pack` して clean dir に install し `addroid doctor` を smoke する
  `apps/cli/scripts/smoke-test.mjs`。
- macOS / Linux / WSL2 のサポート対象明示と Windows native 非対応 (WSL2 推奨) 化。
- Prisma migration と pg-boss schema の取扱い、`addroid backup` / `addroid restore` の整備。
- 本ドキュメント (`CHANGELOG.md`) と [`docs/RELEASE.md`](docs/RELEASE.md) を新設。

### Security

- すべての OAuth トークン (GitHub / Meta / Codex / Slack) を `oauth_tokens` テーブルに
  AES-256-GCM で暗号化保存。`ENCRYPTION_KEY` が無いと復号できないため DB スナップショット
  のみが流出してもトークンは漏れない。
- Web UI / CLI / Slack に対する sanitize-on-render により `Bearer ` / `xoxb-` / `xapp-` /
  `xoxp-` / `sk-` プレフィックスを `[REDACTED]` に置換、個人 path を `~/<rest>` に置換。
- `.gitignore` で `.env*` (`.env.example` を除く) / `secrets.local.yaml` / `~/.addroid/`
  配下を除外。CI の OSS hygiene scan で commit 直前にも再点検。

### Known Limitations

- 単一オペレータ・単一 PostgreSQL を前提。マルチテナント / リモートホスティング /
  SSO は範囲外。
- Storage Adapter は LocalDisk のみ。S3 / GCS / Azure Blob は未実装 (将来契約)。
- Ad platform adapter は Meta のみ。Google / X / LinkedIn は未実装。
- Slack 通知の transport は Socket Mode のみ。Email / MS Teams / Discord 通知は未実装。
- Public surface は v1.0.0 到達まで MINOR で破壊的変更が入りうる (上記
  バージョニング方針参照)。

---

[0.1.0]: https://github.com/bb8ad8/addroid-oss/releases/tag/v0.1.0
