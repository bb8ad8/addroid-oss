# AdDroid OSS — Discord Setup (任意 / Gateway)

Discord 連携は **完全に任意**です。トークンを設定しなくても AdDroid OSS は通常通り稼働し、
`/setup` の Discord セクションは benign idle 表示になります。連携時は Slack と並ぶ第2の
対話チャネルとして、対象チャンネルから `/adops` スラッシュコマンドやメンションで依頼でき、
承認待ちPR・日次レポート・budget guard 等の通知を Discord で受け取れます。

> **Outbound-only**: AdDroid は Discord Gateway (WebSocket) への **アウトバウンド常時接続**
> のみを使い、public な webhook / request URL を一切開きません。Web UI は 127.0.0.1 のみ。
> bot トークンはローカルに AES-256-GCM で暗号化保存し、ops リポジトリには絶対にコミットしません。

> **承認の人間ゲート**: Discord は AI 提案の起動・閲覧・activate を担いますが、**PR の承認(merge)
> は GitHub または Web UI `/approvals` のみ**です (Slack と同じ安全姿勢)。AI は提案、人が承認、
> システムが PAUSED で反映、という流れは Discord 経由でも変わりません。

---

## 1. Discord Bot の作成

1. https://discord.com/developers/applications の "New Application" でアプリを作成
2. 左メニュー **Bot** → "Add Bot"。**Reset Token** で bot トークンを取得 (一度しか表示されません)
3. **Privileged Gateway Intents** で **MESSAGE CONTENT INTENT** を **ON** にする
   (対象チャンネルの発言本文を読むために必須)
4. 左メニュー **OAuth2 > URL Generator** で scope `bot` + `applications.commands` を選び、
   Bot Permissions に最低限 `View Channels` / `Send Messages` / `Read Message History` を付与
5. 生成された URL でアプリを対象サーバー (guild) に招待
6. AdDroid を動かしたいチャンネルに bot がアクセスできることを確認

必要な ID の取得 (Discord の "開発者モード" を ON にすると右クリックでコピーできます):

- **guild ID**: サーバー名を右クリック → "サーバー ID をコピー"
- **channel ID**: 対象チャンネルを右クリック → "チャンネル ID をコピー"

---

## 2. AdDroid 側のトークン登録

```bash
# 推奨: addroid CLI 経由 (REST 検証 → テスト送信 → 成功時のみ暗号化保存)
addroid connect discord \
  --bot-token <BOT_TOKEN> \
  --guild <GUILD_ID> \
  --channel <CHANNEL_ID>

# 環境変数でも可
DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... DISCORD_CHANNEL_ID=... \
  addroid connect discord
```

CLI は以下を順に実行します:

1. `GET /applications/@me` で bot トークンの真正性と application ID / bot user を検証
2. `GET /channels/{id}` で対象チャンネルへアクセスできることを検証 (guild 一致も確認)
3. 対象チャンネルへテストメッセージを送信 (`--no-test` でスキップ可)
4. 成功した場合のみ `oauth_tokens` (provider="discord", accountIdentifier=<guild_id>) に
   bot トークンを AES-256-GCM で暗号化保存。guild / channel / application ID は非機微メタとして metadata に保存
5. 失敗時はトークンを永続化せず、原因を hint として表示

Web UI からも設定できます: `/setup` の **Discord 連携** セクションに bot トークン・guild ID・
channel ID を貼り付けて保存 (Slack と同じフォーム体験)。

登録後に **worker を再起動**すると Discord Gateway へ接続し、対象チャンネルへ `/adops`
スラッシュコマンドを登録します (guild scoped = 即時反映)。

```bash
npm run addroid -- down   # keepalive が自動で up し直します
```

---

## 3. 使い方

対象チャンネルで:

- `/adops report` — アクティブな ad_account の daily_report を実行
- `/adops improve` — improvement_pr を起動 (改善提案 PR を作成)
- `/adops budget` — budget_guard を評価
- `/adops status` / `/adops accounts` — 現状・アカウント一覧
- `/adops activate <ads_hierarchy_id>` — PAUSED のノードを audited で activate
- 自然文メンション (例: 「昨日のレポート出して」「改善提案して」) — 共有 Agent が応答

通知 (承認待ちPR・日次レポート・budget guard・apply 完了/失敗など) は Slack と同じイベントが
対象チャンネルに embed で届きます。

---

## 4. Discord 連携を解除する

`/setup` の Discord セクションの「切断」、または DB の `oauth_tokens` から
`provider="discord"` の行を削除します。Discord 側の bot は Developer Portal から手動で削除してください。

---

## 5. ヘルスチェック

```bash
addroid doctor
```

`discord` チェックが表示されます:

- `[skip ]` — 未接続 (任意なので正常)
- `[ ok  ]` — 接続済み (guild / channel が揃い、bot トークンが復号可能)
- `[warn ]` — 接続済みだが guild/channel が未設定
- `[error]` — bot トークンを復号できない (ENCRYPTION_KEY を確認のうえ再接続)

---

## トラブルシューティング

- **bot がメッセージに反応しない**: MESSAGE CONTENT INTENT が ON か、worker を再起動したか、
  対象チャンネル ID が正しいかを確認。`addroid doctor` の `discord` チェックも参照。
- **`/adops` が出てこない**: コマンドは worker 起動時に guild scoped で登録されます。worker の
  ログに `/adops guild commands registered` が出ているか確認してください。
- **Missing Access (50001)**: bot が対象チャンネル/サーバーに招待されていない、または
  チャンネルの閲覧・送信権限が不足しています。
- **本セッションの Discord MCP とは別物**: Claude に接続された Discord MCP はユーザー操作用で、
  AdDroid が使う bot とは別です。AdDroid 専用の bot トークンを発行してください。
