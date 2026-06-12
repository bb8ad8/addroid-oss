import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROPORTION_MIN_SUCCESSES,
  DEFAULT_PROPORTION_MIN_TRIALS,
  compareProportions,
  confidenceLabel,
  scoreAnomaly,
  wilsonInterval,
} from "../index.js";

test("wilsonInterval handles zero trials", () => {
  assert.deepEqual(wilsonInterval(0, 0), {
    rate: null,
    lower: null,
    upper: null,
    trials: 0,
  });
});

test("wilsonInterval handles edge rates and known 50/1000 interval", () => {
  const zero = wilsonInterval(0, 1000);
  assert.equal(zero.rate, 0);
  assert.equal(zero.lower, 0);
  assert.ok(zero.upper !== null && zero.upper > 0);

  const all = wilsonInterval(1000, 1000);
  assert.equal(all.rate, 1);
  assert.ok(all.lower !== null && all.lower < 1);
  assert.equal(all.upper, 1);

  const known = wilsonInterval(50, 1000);
  assert.equal(known.rate, 0.05);
  assert.ok(known.lower !== null && known.lower > 0.038 && known.lower < 0.039);
  assert.ok(known.upper !== null && known.upper > 0.065 && known.upper < 0.066);
});

test("compareProportions detects a clear significant increase", () => {
  const result = compareProportions(
    { successes: 50, trials: 5000 },
    { successes: 100, trials: 5000 }
  );
  assert.equal(result.verdict, "significant_increase");
  assert.ok(result.pApprox !== null && result.pApprox < 0.05);
  assert.ok(result.relativeChange !== null && result.relativeChange > 0.9);
  assert.equal(result.minTrialsMet, true);
});

test("compareProportions detects same-rate non-significance", () => {
  const result = compareProportions(
    { successes: 50, trials: 5000 },
    { successes: 50, trials: 5000 }
  );
  assert.equal(result.verdict, "not_significant");
  assert.ok(result.pApprox !== null && result.pApprox > 0.999);
  assert.equal(result.relativeChange, 0);
});

test("compareProportions fails closed when either sample is too small", () => {
  const result = compareProportions(
    { successes: 4, trials: 999 },
    { successes: 20, trials: 5000 }
  );
  assert.equal(result.verdict, "insufficient_data");
  assert.equal(result.pApprox, null);
  assert.equal(result.minTrialsMet, false);
});

test("compareProportions accepts exact threshold samples", () => {
  const result = compareProportions(
    {
      successes: DEFAULT_PROPORTION_MIN_SUCCESSES,
      trials: DEFAULT_PROPORTION_MIN_TRIALS,
    },
    {
      successes: DEFAULT_PROPORTION_MIN_SUCCESSES,
      trials: DEFAULT_PROPORTION_MIN_TRIALS,
    }
  );
  assert.equal(result.verdict, "not_significant");
  assert.equal(result.minTrialsMet, true);
});

test("scoreAnomaly returns null for short or zero-variance history", () => {
  assert.deepEqual(scoreAnomaly([1, 2], 10), {
    zScore: null,
    direction: "up",
    isAnomaly: false,
  });
  assert.deepEqual(scoreAnomaly([5, 5, 5], 10), {
    zScore: null,
    direction: "up",
    isAnomaly: false,
  });
});

test("scoreAnomaly flags a clear outlier", () => {
  const result = scoreAnomaly([10, 11, 9, 10, 10], 20);
  assert.ok(result.zScore !== null && result.zScore > 2);
  assert.equal(result.direction, "up");
  assert.equal(result.isAnomaly, true);
});

test("confidenceLabel covers all boundary levels", () => {
  assert.equal(confidenceLabel(30, 1000), "reliable");
  assert.equal(confidenceLabel(29, 1000), "indicative");
  assert.equal(confidenceLabel(5, 300), "indicative");
  assert.equal(confidenceLabel(4, 300), "insufficient");
  assert.equal(confidenceLabel(5, 299), "insufficient");
});
