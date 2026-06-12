export interface SnapshotMetricInput {
  impressions: number;
  clicks: number;
  linkClicks?: number | null;
  spendMicros: bigint;
  conversions: number;
  reach?: number | null;
  frequency?: number | null;
}

export interface DerivedMetrics {
  ctr: number | null;
  linkCtr: number | null;
  cpcMajor: number | null;
  cpmMajor: number | null;
  cpaMajor: number | null;
  spendMajor: number;
}

export function microsToMajorUnit(micros: bigint): number {
  const div = Number(micros / 1_000_000n);
  const rem = Number(micros % 1_000_000n) / 1_000_000;
  return div + rem;
}

export function deriveMetrics(input: SnapshotMetricInput): DerivedMetrics {
  const impressions = normalizeCount(input.impressions);
  const clicks = normalizeCount(input.clicks);
  const linkClicks = normalizeNullableCount(input.linkClicks);
  const conversions = normalizeCount(input.conversions);
  const spendMajor = microsToMajorUnit(input.spendMicros);

  return {
    ctr: impressions > 0 ? clicks / impressions : null,
    linkCtr:
      impressions > 0 && linkClicks !== null ? linkClicks / impressions : null,
    cpcMajor: clicks > 0 ? spendMajor / clicks : null,
    cpmMajor: impressions > 0 ? (spendMajor / impressions) * 1000 : null,
    cpaMajor: conversions > 0 ? spendMajor / conversions : null,
    spendMajor,
  };
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeNullableCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return normalizeCount(value);
}
