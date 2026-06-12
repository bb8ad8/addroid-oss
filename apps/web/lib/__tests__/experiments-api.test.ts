import assert from "node:assert/strict";
import test from "node:test";
import { ExperimentRegistrationError } from "../../../worker/src/lib/experiment-registration";
import { experimentRegistrationErrorToResponse } from "../../app/api/experiments/route";

test("experiments API maps validation errors to 400", async () => {
  const response = experimentRegistrationErrorToResponse(
    new ExperimentRegistrationError("実験名を指定してください。", 400),
  );

  assert.equal(response?.status, 400);
  assert.deepEqual(await response?.json(), {
    ok: false,
    error: "実験名を指定してください。",
  });
});

test("experiments API maps duplicate running variants to 409", async () => {
  const response = experimentRegistrationErrorToResponse(
    new ExperimentRegistrationError("指定された広告は実行中の実験で使用されています。", 409),
  );

  assert.equal(response?.status, 409);
  assert.deepEqual(await response?.json(), {
    ok: false,
    error: "指定された広告は実行中の実験で使用されています。",
  });
});
