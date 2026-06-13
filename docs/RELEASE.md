# AdDroid OSS — Release Procedure

このドキュメントは AdDroid OSS のリリース手順を 1 枚に集約します。
**実 npm publish は人間の明示承認なしに実行されません** (CI は `--dry-run` のみ)。
リリースは `@addroid/cli` を npm registry に publish する 1 手順だけで完結し、
他のワークスペース (`@addroid/web`, `@addroid/worker`, `@addroid/*` パッケージ) は
`private: true` のため publish されません。

リリース前のセキュリティ衛生チェックは [`docs/SECURITY.md` §8](./SECURITY.md) と
重複なく接続します。本ドキュメントは「衛生は通った前提で、どうやって出すか」を扱います。

---

## 1. 配布物の境界

| 配布チャネル | 対象 | 公開可否 |
|---|---|---|
| npm registry | `@addroid/cli` (`apps/cli/package.json`) | **公開** (`access: public`) |
| GitHub Releases | リポジトリの tarball / source zip | 公開 (GitHub 標準) |
| Docker Hub / GHCR | (なし) | — |
| その他 npm package | `@addroid/web` / `@addroid/worker` / `@addroid/*` | **非公開** (`private: true`) |

OSS adopter / fork operator はリポジトリを `git clone` し、`npm install`、
`npm run addroid -- init` で初期設定と常駐サービス登録まで進められます。
必要に応じて `npm run addroid -- start` で常駐サービスを起動・修復できます。
`npm install -g @addroid/cli` は CLI bin の配布単位であり、postinstall では非破壊の
next-step message だけを表示します。`@addroid/cli` 単体ではフルコンソールは動かず、
リポジトリの web / worker / prisma に依存します (CLI は `init` / `start` / `stop` / `open` /
`status` / `connect` / `account` / `report` / `submit` / `schedule` / `chat` / `backup` と、
詳細・CI 向けの `doctor` / `logs` / `service` / `restore` / `validate` / `up` / `down` /
`plan` / `activate` / `cron` / `auth` / `accounts` を提供)。

---

## 2. パッケージメタデータの source of truth

| 項目 | 場所 | 備考 |
|---|---|---|
| package name | `apps/cli/package.json#name` | `@addroid/cli` (npm scope `@addroid` を要する) |
| version | `apps/cli/package.json#version` | SemVer (本書 §3) |
| license | `apps/cli/package.json#license` + `apps/cli/LICENSE` + リポジトリ root `LICENSE` | 現在 `Apache-2.0` |
| author | `apps/cli/package.json#author` | `The AdDroid OSS Authors` (個人名は記載しない) |
| repository | `apps/cli/package.json#repository.url` | OSS テンプレ owner (個人 GitHub login をハードコードしない) |
| homepage | `apps/cli/package.json#homepage` | 同上 |
| bugs | `apps/cli/package.json#bugs.url` | 同上 |
| engines | `apps/cli/package.json#engines.node` | `>=22.11.0` (Slack Socket Mode で `globalThis.WebSocket` を使うため) |
| files | `apps/cli/package.json#files` | `bin/addroid.cjs` / `dist/index.mjs` / `README.md` / `LICENSE` のみ tarball に含める |
| bin | `apps/cli/package.json#bin` | `addroid` / `addroid-cli` の 2 alias |

リポジトリ root の `package.json` は `"private": true` のため publish されません。
fork して別 owner で配布する場合、上記すべてを fork owner の値に書き換える必要があります
(個人名 / 個人組織のハードコードは `scripts/oss-hygiene-scan.mjs` で検出されます)。

---

## 3. バージョニング (SemVer 2.0.0)

CHANGELOG.md の冒頭で定義したものを再掲します。

- **Public surface:** `@addroid/cli` npm package (`addroid` / `addroid-cli` bin alias)、
  `addroid` CLI、`apps/web` SSR ルート / API、`prisma/schema.prisma`、
  `~/.addroid/config.yaml`、`packages/ops-schemas` (GitOps operation manifest)、
  `packages/agent-runtime` の Agent tool manifest、ops template の `.addroid/project.json` /
  `operations/*.json` / `budget-guard.json` / `automation-rules.yaml`、
  `docs/SECURITY.md` の outbound-only / localhost-only 契約。
- **MAJOR (X.0.0):** Public surface に対する後方互換喪失。例: CLI サブコマンド削除 /
  既定挙動の逆転、Prisma の破壊的マイグレーション、YAML スキーマ非互換、`~/.addroid/`
  レイアウト変更、outbound-only / localhost-only 契約の変更。
- **MINOR (0.X.0):** 後方互換を保つ機能追加。
- **PATCH (0.0.X):** バグ修正・依存更新で Public surface に影響しないもの。
- **0.x.y 期間中:** v1.0.0 到達まで Public surface の変更は MINOR で吸収しうる
  (CHANGELOG の `### Changed` / `### Removed` で太字告知すること)。

破壊的変更を含むリリースは CHANGELOG に **アップグレードガイド** を併記します
(操作手順 + 想定される DB / 設定 / YAML 変換 + 復旧経路)。

### 3.1 単一バージョンの統一方針

`apps/cli/package.json#version` だけが npm に publish される唯一の値ですが、
リポジトリ root の `package.json#version` が `0.0.0` のまま残っているとレビュー時の
混乱の原因になるため、**リリース時は両者を同じ値に揃える**ことを推奨します
(本書 §5 Step 2 で実施)。

private workspaces (`@addroid/web` / `@addroid/worker` / `@addroid/*`) の version は
`0.0.0` 固定で構いません — npm 公開されないため意味を持ちません。

---

## 4. リリース前チェックリスト

> このチェックリストは **すべて pass してから** §5 のリリース手順に進みます。
> セキュリティ衛生 (`.env*` / 個人 path / token / 個人 GitHub login の有無) は
> [`docs/SECURITY.md` §8](./SECURITY.md) のチェックリストを優先して通します。

### 4.1 リポジトリ衛生 (DRY: SECURITY.md §8 を流用)

- [ ] [`docs/SECURITY.md` §8 OSS リリース衛生チェックリスト](./SECURITY.md) の全項目が pass
- [ ] `git status` がクリーン (release 用 commit のみ)
- [ ] `main` ブランチが最新で、CI が green

### 4.2 自動チェック (full local run)

- [ ] `node scripts/oss-hygiene-scan.mjs` が `[oss-hygiene] OK` を返す
- [ ] `npm run db:generate` が成功
- [ ] `npm run typecheck` が全 workspace で成功
- [ ] `npm run lint` が全 workspace で成功
- [ ] `npm run test` が全 workspace で成功
- [ ] `npm run build` が全 workspace で成功
- [ ] `npm run package:smoke` が packed install の `postinstall` 案内、`addroid --help`、
      `addroid doctor` を検証して完了
- [ ] `npm run publish:dry-run` が成功し、tarball 内容が
      `bin/addroid.cjs` / `dist/index.mjs` / `README.md` / `LICENSE` のみ
- [ ] (任意) PostgreSQL を立てて `npm run test:browser` が green

### 4.3 ドキュメント整合性

- [ ] `CHANGELOG.md` の `[Unreleased]` セクションが今回リリースに移動済み、または
      初回リリースの場合は `[X.Y.Z] - YYYY-MM-DD` セクションが完成している
- [ ] CHANGELOG の日付欄が `YYYY-MM-DD` プレースホルダのままになっていない (Step 5 で確定)
- [ ] `README.md` のコマンド表 / バージョン記述が新版と整合
- [ ] CLI public command (`apps/cli/src/index.ts` の dispatch) と CHANGELOG / README の
      コマンド表が整合
- [ ] `apps/web/app/**/page.tsx` と `apps/web/app/api/**/route.ts` の SSR / API route 一覧が
      CHANGELOG / README の公開 route 記述と整合
- [ ] `packages/agent-runtime/src/manifest.ts` の tool 名・引数・`allowedSurfaces` の変更が
      breaking / deprecation 対象としてレビュー済み
- [ ] `packages/*/src/index.ts` の barrel export 削除・リネームが internal public API 変更として
      レビュー済み
- [ ] `templates/addroid-ops-template/` の `.addroid/project.json` / `operations/*.json` /
      `budget-guard.json` / `automation-rules.yaml` の変更が GitOps schema 互換性レビュー済み
- [ ] 破壊的変更がある場合、CHANGELOG にアップグレードガイドを併記

### 4.4 メタデータ整合性

- [ ] `apps/cli/package.json#version` が今回の SemVer 値と一致
- [ ] (推奨) リポジトリ root `package.json#version` が同じ値
- [ ] `apps/cli/package.json#license` と `apps/cli/LICENSE` の SPDX が一致
- [ ] `repository.url` / `homepage` / `bugs.url` が個人 GitHub login を含まない
- [ ] `engines.node` が `.nvmrc` と整合
- [ ] `files` 配列に余計なエントリ (例: `*.test.ts`、`scripts/`、`tsconfig*.json`) がない

### 4.5 npm 認証

- [ ] `npm whoami` で publish 権限を持つアカウントにログイン済み
- [ ] `@addroid` scope の publish 権限を確認
- [ ] 2FA (TOTP / WebAuthn) が enabled (npm の `auth-and-writes` レベル推奨)

---

## 5. リリース手順

> **想定環境:** クリーンな checkout の `main` ブランチ。`~/.addroid/` を汚さないため
> `ADDROID_HOME` を一時ディレクトリに向けても良い (任意)。

### Step 1. 直近の `main` を取り込む

```bash
git checkout main
git pull --ff-only
git status   # クリーンであること
```

### Step 2. バージョンを決める

例として `0.1.0` をリリースする場合:

```bash
NEW_VERSION="0.1.0"

# apps/cli/package.json#version を更新 (publish 対象)。
npm version "${NEW_VERSION}" --workspace apps/cli --no-git-tag-version

# リポジトリ root も同じ値に揃える (推奨)。
npm version "${NEW_VERSION}" --no-git-tag-version --allow-same-version
```

private workspace の version 更新は不要です。

### Step 3. CHANGELOG を確定する

- `CHANGELOG.md` の `[Unreleased]` 配下を、必要なら新しい `[X.Y.Z] - YYYY-MM-DD`
  セクションに移動
- 日付プレースホルダを `YYYY-MM-DD` 形式の確定日に置換
- リンク参照 (`[Unreleased]: ... compare/vX.Y.Z...HEAD` と `[X.Y.Z]: ... releases/tag/vX.Y.Z`)
  を更新

### Step 4. リリース commit を作成

```bash
git add CHANGELOG.md package.json package-lock.json apps/cli/package.json
git status   # 上記 4 ファイルだけが変わっていること
git commit -m "release: v${NEW_VERSION}"
```

### Step 5. ローカルで最終確認

§4.2 のフルセットを再実行します。

```bash
node scripts/oss-hygiene-scan.mjs
npm run db:generate
npm run typecheck
npm run lint
npm run test
npm run build
npm run package:smoke
npm run publish:dry-run
```

`publish:dry-run` の出力で tarball サイズと収録ファイル一覧を確認し、想定外のファイル
(個人 path を含むスクリーンショット / `.env*` / `secrets.local.yaml` / `node_modules/` /
`*.test.ts` 等) が含まれていないことを目視確認します。

### Step 6. PR を作って main に merge する

リリース commit は **必ず PR 経由** で main にマージします (個人ブランチからの直 push 禁止)。
PR description には:

- 今回のバージョン (`v${NEW_VERSION}`)
- CHANGELOG の差分要約
- 破壊的変更の有無
- リリース後の手動操作 (npm publish タイミング、git tag、GitHub Release ノート)

### Step 7. 人間承認 → npm publish (実発行)

PR が main にマージされ、CI (`.github/workflows/ci.yml`) が green になってから、
**publish 権限を持つ人間が手動で**実行します。

```bash
# main の release commit を fetch / checkout
git checkout main
git pull --ff-only
git log -1   # release commit であることを確認

# (任意) npm 認証の再確認
npm whoami

# 実 publish。--access public は scope パッケージで必須。
npm publish --workspace apps/cli --access public

# 直後に正しい tarball が registry に乗ったか確認 (1〜2 分の伝播遅延あり)
npm view "@addroid/cli@${NEW_VERSION}" version dist-tags
```

> CI から `npm publish` を行わない理由:
> - `NPM_TOKEN` を CI に置くと CI 経由の悪意ある PR から公開される攻撃面が生まれる。
> - `--dry-run` は CI で常に走り、`npm publish` の前段検証はすでに自動化されている。
> - 人間が `npm whoami` / 2FA でゲートする運用が AdDroid OSS の契約 (本書 §10)。

### Step 8. git tag を push → GitHub Release は自動発行

タグを push するだけで、`.github/workflows/release.yml` が CHANGELOG の該当セクションを
本文とした GitHub Release を**自動で発行**します。利用者は Releases ページで「何が変わったか」を
一目で確認でき、リポジトリを Watch していれば更新通知も受け取れます。

```bash
git tag -a "v${NEW_VERSION}" -m "AdDroid OSS v${NEW_VERSION}"
git push origin "v${NEW_VERSION}"
# → release ワークフローが起動し、CHANGELOG [${NEW_VERSION}] を本文に Release を作成する。
#   ハイフンを含むタグ (例 v0.2.0-rc.1) は prerelease として作成される。
```

Release 本文は `scripts/extract-changelog.mjs` が CHANGELOG から抽出するため、
**CHANGELOG が唯一の source of truth**として保たれます。発行内容は手元でも確認できます。

```bash
node scripts/extract-changelog.mjs "${NEW_VERSION}"   # Release 本文のプレビュー
```

> 既存タグから手動で再発行したい場合は、GitHub の **Actions → release → Run workflow** から
> タグ名を指定して dispatch します (本文は再抽出され、既存 Release があれば上書きされます)。
>
> PR ごとの一覧 (どの PR が含まれるか) が欲しい場合は、Release 編集画面の
> 「Generate release notes」を押すと `.github/release.yml` の分類設定でラベル別に整形されます。
> このワークフローは **GitHub Release の発行のみ**を行い、npm publish は Step 7 の手動操作のままです
> (理由は §10)。

### Step 9. インストール smoke

別マシン / クリーンな WSL2 / docker container 等で:

```bash
mkdir -p /tmp/addroid-smoke && cd /tmp/addroid-smoke
npm init -y >/dev/null
npm install "@addroid/cli@${NEW_VERSION}"
./node_modules/.bin/addroid --help
./node_modules/.bin/addroid version
./node_modules/.bin/addroid doctor   # check 出力で exit 0 or 1
```

`addroid doctor` が config / DB なしの clean smoke env で check を出力し、
exit code 0 または 1 で終わること、加えて `postinstall` が非破壊の次ステップ案内だけを
出すことを確認します (`apps/cli/scripts/smoke-test.mjs` と
同等の検証)。

### Step 10. CHANGELOG を `[Unreleased]` に戻す

リリース直後の post-release commit (PR 経由) で:

- `CHANGELOG.md` の `[Unreleased]` セクションを再度上に追加
  (Added / Changed / Deprecated / Removed / Fixed / Security の空欄カテゴリ)
- リンク参照の `[Unreleased]: ... compare/v${NEW_VERSION}...HEAD` を更新

これで次回リリースに向けた追記場所が用意されます。

---

## 6. 破壊的変更 (MAJOR) の追加手順

通常リリース手順に加えて:

- [ ] CHANGELOG にアップグレードガイドセクションを追加 (操作手順 + DB / 設定 /
      YAML / `~/.addroid/` レイアウトの差分)
- [ ] `addroid doctor` に新版用の互換性 check を追加 (旧 layout を検出して error / warn)
- [ ] `docs/SETUP.md` / `docs/ARCHITECTURE.md` / `docs/META.md` 等のドキュメントを
      新版に揃える
- [ ] 直前 MINOR の `[Unreleased]` に **deprecation 通告** を追加した上で、
      最低 1 つの MINOR を挟んでから MAJOR を出す (互換期間)
- [ ] GitHub Release notes の冒頭に「BREAKING CHANGE — 移行ガイド: ...」を明記

---

## 7. ロールバック

実 publish 後に重大な問題が見つかった場合の手順です。
**npm の `unpublish` は OSS エコシステムを壊すので原則使いません** (npm policy で
72 時間以降は admin 介入が必要)。代わりに以下の経路を取ります。

### 7.1 即応 (修正済みパッチ版を出す)

最も推奨される経路です。

1. 問題を再現するテストを追加
2. 修正
3. CHANGELOG に PATCH エントリ追加
4. §5 の Step 2 〜 Step 9 をパッチバージョンで再実行
5. 利用者にはパッチバージョンへのアップグレードを案内

### 7.2 deprecate (壊れた版を install させない)

利用者が問題版を install しないようにマークします。**unpublish ではない**ため、
既に install されたユーザーには影響しません。

```bash
# 該当版に警告を付ける。message は npm install 時に表示される。
npm deprecate "@addroid/cli@${BROKEN_VERSION}" \
  "v${BROKEN_VERSION} には ${SHORT_DESCRIPTION} の問題があります。v${FIXED_VERSION} を使ってください。"

# 後で解除する場合は空文字列を指定。
npm deprecate "@addroid/cli@${BROKEN_VERSION}" ""
```

### 7.3 dist-tag を巻き戻す

`latest` タグを安全な過去版に戻します (新規 install 先を変えるだけで、`@${BROKEN_VERSION}`
の install は引き続き可能)。

```bash
# latest が壊れた版を指している場合、安全版に巻き戻す。
npm dist-tag add "@addroid/cli@${SAFE_VERSION}" latest

# 確認
npm view "@addroid/cli" dist-tags
```

### 7.4 unpublish (最後の手段)

publish 後 72 時間以内かつ重大なセキュリティ事案 (個人情報 / トークンの漏洩等) の場合のみ:

```bash
npm unpublish "@addroid/cli@${BROKEN_VERSION}"
```

72 時間を超えた場合は npm support への申請が必要です。GitHub Release も同時に削除し、
git tag は **残す** (歴史改竄を避けるため) のが慣行です。

### 7.5 利用者への告知

- GitHub Release notes に「YANKED — v${FIXED_VERSION} を使ってください」を上書き
- `CHANGELOG.md` の該当バージョンを `### Yanked` セクションに分離 (Keep a Changelog
  1.1.0 の慣行) し、置換版へのリンクを併記
- セキュリティ事案の場合は GitHub Security Advisories (CVE 取得を含む)

---

## 8. ライセンスと帰属

- 現在のライセンスは `Apache-2.0` (リポジトリ root `LICENSE` と
  `apps/cli/LICENSE` と `apps/cli/package.json#license` の 3 箇所が source of truth)。
- ライセンスを変更する場合は **公開済みバージョン全体に対する影響**を検討してから
  変更してください (コントリビュータの帰属、依存ライブラリの互換、配布済みバイナリの
  扱い)。fork が独自ライセンスで再配布することは Apache-2.0 の範囲で可能です。
- `package.json#author` は `The AdDroid OSS Authors` (個人名を入れない)。
  contributors は `git log` と GitHub Contributors graph で参照。

---

## 9. サポート境界

OSS / セルフホスト / コミュニティサポート (issue 経由) / **SLA なし**。

| 種別 | 経路 | 期待応答 |
|---|---|---|
| バグ報告 | GitHub Issues | ベストエフォート (週単位) |
| 機能要望 | GitHub Issues / Discussions | ベストエフォート |
| セキュリティ脆弱性 | GitHub Security Advisories (**非公開**) | 72 時間以内に確認 |
| 商用サポート / SLA / マネージド運用 | (提供しない) | — |

OSS adopter / fork operator は自身の運用責任で AdDroid を稼働させてください。
AdDroid OSS は localhost-only / outbound-only / 単一オペレータ前提で設計されています。
マルチテナント / リモートホスティング / SSO 等の運用は本書の範囲外です。

---

## 10. なぜ CI から実 publish しないのか

- `NPM_TOKEN` を CI に保管すると、CI 経由 (悪意ある PR / 依存更新の supply chain attack) で
  npm に公開される攻撃面が広がる。
- AdDroid OSS は localhost-only の小さな OSS であり、リリース頻度は人間レビューの
  ペースで十分。
- `--dry-run` を CI で必ず実行することで、`npm publish` の前段検証 (tarball 内容 /
  メタデータ / 認証以外の問題) は自動化されている。
- 実 publish の瞬間に **`npm whoami` と 2FA を人間がゲート**する設計を契約として固定する
  (`README.md` / `docs/SECURITY.md` § 1 / 本書 §5 Step 7)。

---

## 11. 参照

- [`CHANGELOG.md`](../CHANGELOG.md) — リリースごとの変更点
- [`docs/SECURITY.md` §8](./SECURITY.md) — OSS リリース衛生チェックリスト (本書 §4.1 で参照)
- [`CONTRIBUTING.md` §6](../CONTRIBUTING.md) — contribution 全体の流れと release 章への入口
- [`apps/cli/scripts/smoke-test.mjs`](../apps/cli/scripts/smoke-test.mjs) — package smoke の実装
- [`scripts/oss-hygiene-scan.mjs`](../scripts/oss-hygiene-scan.mjs) — secret / 個人 path /
  hardcoded value の build-time scan
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — CI による build / typecheck /
  test / db setup / browser E2E / package smoke / publish dry-run
