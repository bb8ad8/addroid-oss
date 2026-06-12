"use client";

// AdDroid OSS — /creatives 上部の Toolbar.
//
// Account / Status / Provider の 3 フィルタを URL クエリに同期する。
// SSR ページ (creatives/page.tsx) は同じクエリを Prisma に渡す。
// CLAUDE.md guardrail #4 (API-First for Every View): フィルタの値はサーバー
// サイドの Prisma クエリに使い、結果は SSR で描画される。

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { APPEAL_AXES, GENE_LABELS_JA } from "@addroid/llm-provider/creative-genes";

export interface AccountOption {
  id: string;
  key: string;
  displayName: string;
}

export interface ProviderOption {
  value: string;
  label: string;
}

export interface CreativesToolbarProps {
  accounts: AccountOption[];
  providers: ProviderOption[];
  selectedAccountId: string | null;
  selectedStatus: string;
  selectedProvider: string;
  selectedAppealAxis: string;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "queued", label: "queued" },
  { value: "generating", label: "generating" },
  { value: "qa_running", label: "qa_running" },
  { value: "qa_passed", label: "qa_passed" },
  { value: "qa_warned", label: "qa_warned" },
  { value: "qa_failed", label: "qa_failed" },
  { value: "attached_to_pr", label: "attached_to_pr" },
  { value: "merged", label: "merged" },
  { value: "active_on_meta", label: "active_on_meta" },
  { value: "superseded", label: "superseded" },
  { value: "fallback_text_only", label: "fallback_text_only" },
];

export function CreativesToolbar({
  accounts,
  providers,
  selectedAccountId,
  selectedStatus,
  selectedProvider,
  selectedAppealAxis,
}: CreativesToolbarProps) {
  const router = useRouter();
  const params = useSearchParams();

  const baseHref = useMemo(() => {
    return new URLSearchParams(params?.toString() ?? "");
  }, [params]);

  function navigate(updates: Record<string, string | null>) {
    const next = new URLSearchParams(baseHref.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    const search = next.toString();
    router.push(search ? `/creatives?${search}` : "/creatives");
  }

  return (
    <div className="toolbar" role="group" aria-label="クリエイティブの絞り込み">
      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="creatives-account">
          Account
        </label>
        <select
          id="creatives-account"
          className="form-select"
          value={selectedAccountId ?? ""}
          onChange={(ev) => navigate({ accountId: ev.target.value || null })}
        >
          <option value="">すべて</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.key} — {account.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="creatives-status">
          Status
        </label>
        <select
          id="creatives-status"
          className="form-select"
          value={selectedStatus}
          onChange={(ev) =>
            navigate({ status: ev.target.value === "all" ? null : ev.target.value })
          }
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="creatives-provider">
          画像生成
        </label>
        <select
          id="creatives-provider"
          className="form-select"
          value={selectedProvider}
          onChange={(ev) =>
            navigate({ provider: ev.target.value === "all" ? null : ev.target.value })
          }
        >
          <option value="all">すべて</option>
          <option value="__none__">未設定</option>
          {providers.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__field">
        <label className="toolbar__label" htmlFor="creatives-appeal-axis">
          訴求軸
        </label>
        <select
          id="creatives-appeal-axis"
          className="form-select"
          value={selectedAppealAxis}
          onChange={(ev) =>
            navigate({ appealAxis: ev.target.value === "all" ? null : ev.target.value })
          }
        >
          <option value="all">すべて</option>
          {APPEAL_AXES.map((axis) => (
            <option key={axis} value={axis}>
              {GENE_LABELS_JA[axis] ?? axis}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
