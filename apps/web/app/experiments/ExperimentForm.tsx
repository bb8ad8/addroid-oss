"use client";

import { useMemo, useState } from "react";
import { TRUSTED_WEB_ACTION_HEADER } from "../../lib/request-guard";

export interface ExperimentFormAccount {
  key: string;
  displayName: string;
  adsets: Array<{
    nodeKey: string;
    displayName: string;
    ads: Array<{ nodeKey: string; displayName: string }>;
  }>;
}

export function ExperimentForm({ accounts }: { accounts: ExperimentFormAccount[] }) {
  const [accountKey, setAccountKey] = useState(accounts[0]?.key ?? "");
  const account = accounts.find((item) => item.key === accountKey) ?? accounts[0] ?? null;
  const [adsetNodeKey, setAdsetNodeKey] = useState(account?.adsets[0]?.nodeKey ?? "");
  const adset = account?.adsets.find((item) => item.nodeKey === adsetNodeKey) ?? account?.adsets[0] ?? null;
  const ads = useMemo(() => adset?.ads ?? [], [adset]);
  const [variantAKey, setVariantAKey] = useState(ads[0]?.nodeKey ?? "");
  const [variantBKey, setVariantBKey] = useState(ads[1]?.nodeKey ?? "");
  const [metric, setMetric] = useState<"ctr" | "cvr">("ctr");
  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [minImpressions, setMinImpressions] = useState(2000);
  const [maxDurationDays, setMaxDurationDays] = useState(14);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onAccountChange(next: string) {
    setAccountKey(next);
    const nextAccount = accounts.find((item) => item.key === next) ?? null;
    const nextAdset = nextAccount?.adsets[0] ?? null;
    setAdsetNodeKey(nextAdset?.nodeKey ?? "");
    setVariantAKey(nextAdset?.ads[0]?.nodeKey ?? "");
    setVariantBKey(nextAdset?.ads[1]?.nodeKey ?? "");
  }

  function onAdsetChange(next: string) {
    setAdsetNodeKey(next);
    const nextAdset = account?.adsets.find((item) => item.nodeKey === next) ?? null;
    setVariantAKey(nextAdset?.ads[0]?.nodeKey ?? "");
    setVariantBKey(nextAdset?.ads[1]?.nodeKey ?? "");
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/experiments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TRUSTED_WEB_ACTION_HEADER]: "1",
        },
        body: JSON.stringify({
          accountKey,
          adsetNodeKey,
          variantAKey,
          variantBKey,
          metric,
          name,
          hypothesis,
          minImpressionsPerVariant: minImpressions,
          maxDurationDays,
        }),
      });
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "実験を登録できませんでした。");
      setMessage("実験を登録しました。次回の experiment_evaluate で評価されます。");
      setName("");
      setHypothesis("");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = !account || !adset || ads.length < 2 || submitting;

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.875rem" }}>
      <div className="form-grid">
        <label className="field">
          <span>広告アカウント</span>
          <select value={accountKey} onChange={(event) => onAccountChange(event.target.value)}>
            {accounts.map((item) => (
              <option key={item.key} value={item.key}>
                {item.displayName} ({item.key})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>広告セット</span>
          <select value={adsetNodeKey} onChange={(event) => onAdsetChange(event.target.value)}>
            {(account?.adsets ?? []).map((item) => (
              <option key={item.nodeKey} value={item.nodeKey}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Variant A</span>
          <select value={variantAKey} onChange={(event) => setVariantAKey(event.target.value)}>
            {ads.map((ad) => (
              <option key={ad.nodeKey} value={ad.nodeKey}>
                {ad.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Variant B</span>
          <select value={variantBKey} onChange={(event) => setVariantBKey(event.target.value)}>
            {ads.map((ad) => (
              <option key={ad.nodeKey} value={ad.nodeKey}>
                {ad.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>指標</span>
          <select value={metric} onChange={(event) => setMetric(event.target.value as "ctr" | "cvr")}>
            <option value="ctr">CTR</option>
            <option value="cvr">CVR</option>
          </select>
        </label>
        <label className="field">
          <span>実験名</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="field">
          <span>最小imp/広告</span>
          <input
            type="number"
            min={1}
            value={minImpressions}
            onChange={(event) => setMinImpressions(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>最大日数</span>
          <input
            type="number"
            min={1}
            value={maxDurationDays}
            onChange={(event) => setMaxDurationDays(Number(event.target.value))}
          />
        </label>
      </div>
      <label className="field">
        <span>仮説</span>
        <input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} />
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <button className="btn btn--primary" disabled={disabled || variantAKey === variantBKey}>
          {submitting ? "登録中" : "登録"}
        </button>
        {message ? <span className="muted">{message}</span> : null}
      </div>
    </form>
  );
}
