"use client";

// AdDroid OSS — Web UI Merge button (this implementation).
//
// ConfirmDialog (caution) を経由して /api/approvals/[prNumber]/merge を叩く。
// 成功・失敗どちらも Toast でフィードバック (Unified Feedback)。
// 失敗してもダイアログを自動で閉じない (operator がエラーをコピーできるように)。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { useToast } from "../../../components/ui/Toast";
import { InlineCode } from "../../../components/ui/CodeBlock";

export interface MergePrButtonProps {
  prNumber: number;
  prTitle: string;
  repoFullName: string;
  expectedHeadSha: string;
  htmlUrl: string | null;
  rejectionReasons: Array<{ value: string; label: string }>;
}

interface DecisionResponse {
  ok?: boolean;
  action?: "approve" | "reject";
  merged?: boolean;
  sha?: string;
  message?: string;
  error?: string;
  status?: number;
}

export function MergePrButton({
  prNumber,
  prTitle,
  repoFullName,
  expectedHeadSha,
  htmlUrl,
  rejectionReasons,
}: MergePrButtonProps) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState(rejectionReasons[0]?.value ?? "other");
  const [rejectionNote, setRejectionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const router = useRouter();
  const { push } = useToast();

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setInlineError(null);
    try {
      const res = await fetch(`/api/approvals/${prNumber}/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdDroid-Web-Action": "1",
        },
        body: JSON.stringify({ expectedHeadSha }),
      });
      const body = (await res.json().catch(() => ({}))) as DecisionResponse;
      if (!res.ok || !body.ok) {
        const errMessage =
          body.error ?? body.message ?? `HTTP ${res.status}: マージに失敗しました`;
        setInlineError(errMessage);
        push({
          variant: "error",
          title: `PR #${prNumber} の承認に失敗しました`,
          description: errMessage,
        });
        return;
      }
      push({
        variant: "success",
        title: `PR #${prNumber} を承認しました`,
        description: body.sha
          ? `変更ID=${body.sha.slice(0, 12)} · 次の確認で反映処理に進みます`
          : "承認を記録しました",
      });
      setMergeOpen(false);
      router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      setInlineError(msg);
      push({
        variant: "error",
        title: `PR #${prNumber} の承認に失敗しました`,
        description: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (busy) return;
    setBusy(true);
    setInlineError(null);
    try {
      const res = await fetch(`/api/approvals/${prNumber}/reject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdDroid-Web-Action": "1",
        },
        body: JSON.stringify({
          expectedHeadSha,
          rejectionReason,
          rejectionNote,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as DecisionResponse;
      if (!res.ok || !body.ok) {
        const errMessage =
          body.error ?? body.message ?? `HTTP ${res.status}: 非承認に失敗しました`;
        setInlineError(errMessage);
        push({
          variant: "error",
          title: `PR #${prNumber} の非承認に失敗しました`,
          description: errMessage,
        });
        return;
      }
      push({
        variant: "success",
        title: `PR #${prNumber} を非承認にしました`,
        description: "この変更から反映処理は起動しません",
      });
      setRejectOpen(false);
      router.refresh();
    } catch (err) {
      const msg = (err as Error).message;
      setInlineError(msg);
      push({
        variant: "error",
        title: `PR #${prNumber} の非承認に失敗しました`,
        description: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="btn btn--caution"
          onClick={() => {
            setInlineError(null);
            setMergeOpen(true);
          }}
          disabled={busy}
        >
          承認して反映待ちにする
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            setInlineError(null);
            setRejectOpen(true);
          }}
          disabled={busy}
        >
          非承認にする
        </button>
        <span style={{ fontSize: "0.8125rem", color: "var(--color-text-secondary)" }}>
          承認後は反映待ち、非承認後は反映停止として記録します。
        </span>
      </div>
      <ConfirmDialog
        open={mergeOpen}
        onClose={() => {
          if (!busy) setMergeOpen(false);
        }}
        onConfirm={handleConfirm}
        busy={busy}
        confirmLabel="承認して反映待ちにする"
        confirmVariant="caution"
        title="この変更を承認しますか？"
        description={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div>
              承認後、この変更は次の確認で反映処理に進みます。反映は停止状態で行われ、
              配信開始には別途確認が必要です。
            </div>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.7 }}>
              <li>
                リポジトリ: <InlineCode>{repoFullName}</InlineCode>
              </li>
              <li>
                PR: <InlineCode>#{prNumber}</InlineCode> {prTitle}
              </li>
              <li>
                変更ID: <InlineCode>{expectedHeadSha.slice(0, 12)}</InlineCode>
              </li>
              <li>
                反映処理: <InlineCode>次の確認で開始</InlineCode>
              </li>
              {htmlUrl ? (
                <li>
                  GitHub:{" "}
                  <a
                    href={htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {htmlUrl}
                  </a>
                </li>
              ) : null}
            </ul>
            {inlineError ? (
              <div
                role="alert"
                style={{
                  padding: "var(--space-3)",
                  border: "1px solid var(--color-status-error)",
                  background: "var(--color-status-error-subtle)",
                  color: "var(--color-status-error)",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8125rem",
                }}
              >
                {inlineError}
              </div>
            ) : null}
          </div>
        }
      />
      <ConfirmDialog
        open={rejectOpen}
        onClose={() => {
          if (!busy) setRejectOpen(false);
        }}
        onConfirm={handleReject}
        busy={busy}
        confirmLabel="非承認にする"
        confirmVariant="danger"
        title="この変更を非承認にしますか？"
        description={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div>
              非承認にすると approval_records に rejected を記録し、この PR からの反映処理を
              起動しません。
            </div>
            <ul style={{ margin: 0, paddingLeft: "1.25rem", lineHeight: 1.7 }}>
              <li>
                リポジトリ: <InlineCode>{repoFullName}</InlineCode>
              </li>
              <li>
                PR: <InlineCode>#{prNumber}</InlineCode> {prTitle}
              </li>
              <li>
                変更ID: <InlineCode>{expectedHeadSha.slice(0, 12)}</InlineCode>
              </li>
              {htmlUrl ? (
                <li>
                  GitHub:{" "}
                  <a
                    href={htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {htmlUrl}
                  </a>
                </li>
              ) : null}
            </ul>
            <label className="field">
              <span>非承認理由</span>
              <select
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
              >
                {rejectionReasons.map((reason) => (
                  <option key={reason.value} value={reason.value}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>メモ</span>
              <textarea
                value={rejectionNote}
                onChange={(event) => setRejectionNote(event.target.value)}
                maxLength={200}
                rows={3}
              />
            </label>
            {inlineError ? (
              <div
                role="alert"
                style={{
                  padding: "var(--space-3)",
                  border: "1px solid var(--color-status-error)",
                  background: "var(--color-status-error-subtle)",
                  color: "var(--color-status-error)",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8125rem",
                }}
              >
                {inlineError}
              </div>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
