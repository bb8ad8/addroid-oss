import assert from "node:assert/strict";
import test from "node:test";
import { parseRejectFeedbackPayload } from "../../app/api/approvals/[prNumber]/reject/route";

test("approval reject API requires a valid rejection reason", () => {
  const result = parseRejectFeedbackPayload({
    rejectionReason: "not_a_reason",
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "Reject requests must include a valid rejectionReason.",
  });
});

test("approval reject API accepts known reasons and sanitizes notes", () => {
  const result = parseRejectFeedbackPayload({
    rejectionReason: "budget_too_aggressive",
    rejectionNote: `  ${"段階的にしたい ".repeat(30)}  `,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rejectionReason, "budget_too_aggressive");
  assert.equal(result.rejectionNote?.length, 200);
});
