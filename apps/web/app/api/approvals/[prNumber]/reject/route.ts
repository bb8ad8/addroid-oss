import { NextResponse } from "next/server";
import {
  normalizeRejectionReason,
  sanitizeRejectionNote,
  type RejectionReason,
} from "@addroid/queue";
import {
  ApprovalDecisionError,
  decidePullRequestApproval,
} from "../../../../../../worker/src/lib/approval-decision-runtime";
import { prisma } from "../../../../../lib/prisma";
import { ensureWebWorkspace } from "../../../../../lib/github-runtime";
import { requireTrustedJsonWebAction } from "../../../../../lib/request-guard";

export const dynamic = "force-dynamic";

interface Body {
  expectedHeadSha?: unknown;
  comment?: unknown;
  rejectionReason?: unknown;
  rejectionNote?: unknown;
}

export type RejectFeedbackParseResult =
  | {
      ok: true;
      rejectionReason: RejectionReason;
      rejectionNote: string | undefined;
    }
  | { ok: false; status: 400; error: string };

export function parseRejectFeedbackPayload(
  payload: Body
): RejectFeedbackParseResult {
  const rejectionReason = normalizeRejectionReason(payload.rejectionReason);
  if (!rejectionReason) {
    return {
      ok: false,
      status: 400,
      error: "Reject requests must include a valid rejectionReason.",
    };
  }
  return {
    ok: true,
    rejectionReason,
    rejectionNote: sanitizeRejectionNote(payload.rejectionNote) ?? undefined,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ prNumber: string }> }
) {
  const untrustedResponse = requireTrustedJsonWebAction(request);
  if (untrustedResponse) return untrustedResponse;

  const { prNumber: prNumberRaw } = await params;
  const prNumber = Number.parseInt(prNumberRaw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid PR number." },
      { status: 400 }
    );
  }

  let payload: Body;
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    payload = parsed as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Reject requests must include a valid JSON body." },
      { status: 400 }
    );
  }

  const expectedHeadSha =
    typeof payload.expectedHeadSha === "string" && payload.expectedHeadSha.trim().length > 0
      ? payload.expectedHeadSha.trim()
      : undefined;
  if (expectedHeadSha === undefined) {
    return NextResponse.json(
      { ok: false, error: "Reject requests must include expectedHeadSha." },
      { status: 400 }
    );
  }
  const comment =
    typeof payload.comment === "string" && payload.comment.trim().length > 0
      ? payload.comment.trim()
      : undefined;
  const feedback = parseRejectFeedbackPayload(payload);
  if (!feedback.ok) {
    return NextResponse.json(
      { ok: false, error: feedback.error },
      { status: feedback.status },
    );
  }
  const workspace = await ensureWebWorkspace();

  try {
    const result = await decidePullRequestApproval({
      prisma,
      workspaceId: workspace.id,
      prNumber,
      action: "reject",
      actor: "user:web-ui",
      decisionSource: "web_reject",
      expectedHeadSha,
      comment:
        comment ??
        [feedback.rejectionReason, feedback.rejectionNote].filter(Boolean).join(": "),
      rejectionReason: feedback.rejectionReason,
      ...(feedback.rejectionNote ? { rejectionNote: feedback.rejectionNote } : {}),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const status = err instanceof ApprovalDecisionError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
