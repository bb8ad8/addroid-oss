import test from "node:test";
import assert from "node:assert/strict";
import { deriveMetrics, microsToMajorUnit } from "../index.js";

test("deriveMetrics returns ratios and major currency units", () => {
  const metrics = deriveMetrics({
    impressions: 10_000,
    clicks: 100,
    linkClicks: 80,
    spendMicros: 1_250_000_000n,
    conversions: 5,
  });

  assert.equal(metrics.spendMajor, 1250);
  assert.equal(metrics.ctr, 0.01);
  assert.equal(metrics.linkCtr, 0.008);
  assert.equal(metrics.cpcMajor, 12.5);
  assert.equal(metrics.cpmMajor, 125);
  assert.equal(metrics.cpaMajor, 250);
});

test("deriveMetrics returns null for zero denominators", () => {
  const metrics = deriveMetrics({
    impressions: 0,
    clicks: 0,
    linkClicks: null,
    spendMicros: 0n,
    conversions: 0,
  });

  assert.equal(metrics.ctr, null);
  assert.equal(metrics.linkCtr, null);
  assert.equal(metrics.cpcMajor, null);
  assert.equal(metrics.cpmMajor, null);
  assert.equal(metrics.cpaMajor, null);
  assert.equal(metrics.spendMajor, 0);
});

test("microsToMajorUnit preserves fractional micros", () => {
  assert.equal(microsToMajorUnit(1_234_567n), 1.234567);
});
