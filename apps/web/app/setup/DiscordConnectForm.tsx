"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "../../components/ui/Toast";

interface ApiResponse {
  ok?: boolean;
  error?: string;
  botUsername?: string;
  channelName?: string;
  removed?: number;
}

export function DiscordConnectForm() {
  const router = useRouter();
  const toast = useToast();
  const [botToken, setBotToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [sendTestMessage, setSendTestMessage] = useState(false);
  const [busy, setBusy] = useState(false);

  async function connect(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/discord/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AdDroid-Web-Action": "1" },
        body: JSON.stringify({ botToken, guildId, channelId, sendTestMessage }),
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      setBotToken("");
      toast.push({
        variant: "success",
        title: "Discord を接続しました",
        description: body.botUsername
          ? `bot @${body.botUsername} を保存しました。worker 再起動後に有効化されます。`
          : "接続情報を暗号化して保存しました。",
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "Discord を接続できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/discord/connect", {
        method: "DELETE",
        headers: { "X-AdDroid-Web-Action": "1" },
      });
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.push({
        variant: "success",
        title: "Discord を切断しました",
        description: `${body.removed ?? 0} 件の credential を削除しました。`,
      });
      router.refresh();
    } catch (err) {
      toast.push({
        variant: "error",
        title: "Discord を切断できませんでした",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="toolbar" onSubmit={connect} aria-label="Discord 接続">
      <div className="toolbar__field" style={{ minWidth: "16rem" }}>
        <label className="toolbar__label" htmlFor="discord-bot-token">
          Bot トークン
        </label>
        <input
          id="discord-bot-token"
          className="form-input"
          type="password"
          autoComplete="off"
          value={botToken}
          onChange={(ev) => setBotToken(ev.target.value)}
          disabled={busy}
          placeholder="Developer Portal > Bot のトークン"
        />
      </div>
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="discord-guild">
          サーバー (guild) ID
        </label>
        <input
          id="discord-guild"
          className="form-input"
          value={guildId}
          onChange={(ev) => setGuildId(ev.target.value)}
          disabled={busy}
          placeholder="000000000000000000"
        />
      </div>
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="discord-channel">
          チャンネル ID
        </label>
        <input
          id="discord-channel"
          className="form-input"
          value={channelId}
          onChange={(ev) => setChannelId(ev.target.value)}
          disabled={busy}
          placeholder="000000000000000000"
        />
      </div>
      <label className="toolbar__field" style={{ gap: "0.5rem" }}>
        <span className="toolbar__label">Test</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <input
            type="checkbox"
            checked={sendTestMessage}
            onChange={(ev) => setSendTestMessage(ev.target.checked)}
            disabled={busy}
          />
          送信する
        </span>
      </label>
      <button
        type="submit"
        className="btn btn--primary btn--sm"
        disabled={busy || !botToken.trim() || !guildId.trim() || !channelId.trim()}
      >
        {busy ? "保存中…" : "接続"}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={disconnect} disabled={busy}>
        切断
      </button>
    </form>
  );
}
