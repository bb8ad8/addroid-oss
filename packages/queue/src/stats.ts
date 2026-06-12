export const DEFAULT_WILSON_Z = 1.96;
export const DEFAULT_PROPORTION_ALPHA = 0.05;
export const DEFAULT_PROPORTION_MIN_TRIALS = 1000;
export const DEFAULT_PROPORTION_MIN_SUCCESSES = 5;
export const DEFAULT_ANOMALY_Z_THRESHOLD = 2.0;
export const RELIABLE_MIN_CONVERSIONS = 30;
export const RELIABLE_MIN_IMPRESSIONS = 1000;
export const INDICATIVE_MIN_CONVERSIONS = 5;
export const INDICATIVE_MIN_IMPRESSIONS = 300;

export interface ProportionCI {
  rate: number | null;
  lower: number | null;
  upper: number | null;
  trials: number;
}

export function wilsonInterval(
  successes: number,
  trials: number,
  z = DEFAULT_WILSON_Z
): ProportionCI {
  const cleanTrials = normalizeCount(trials);
  const cleanSuccesses = Math.min(normalizeCount(successes), cleanTrials);
  if (cleanTrials === 0 || !Number.isFinite(z) || z <= 0) {
    return { rate: null, lower: null, upper: null, trials: cleanTrials };
  }

  const n = cleanTrials;
  const phat = cleanSuccesses / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));

  return {
    rate: phat,
    lower: clamp01(center - margin),
    upper: clamp01(center + margin),
    trials: cleanTrials,
  };
}

export interface ProportionComparison {
  verdict:
    | "significant_increase"
    | "significant_decrease"
    | "not_significant"
    | "insufficient_data";
  pApprox: number | null;
  relativeChange: number | null;
  minTrialsMet: boolean;
}

export function compareProportions(
  a: { successes: number; trials: number },
  b: { successes: number; trials: number },
  opts: { alpha?: number; minTrials?: number; minSuccesses?: number } = {}
): ProportionComparison {
  const alpha = opts.alpha ?? DEFAULT_PROPORTION_ALPHA;
  const minTrials = opts.minTrials ?? DEFAULT_PROPORTION_MIN_TRIALS;
  const minSuccesses = opts.minSuccesses ?? DEFAULT_PROPORTION_MIN_SUCCESSES;
  const aTrials = normalizeCount(a.trials);
  const bTrials = normalizeCount(b.trials);
  const aSuccesses = Math.min(normalizeCount(a.successes), aTrials);
  const bSuccesses = Math.min(normalizeCount(b.successes), bTrials);
  const minTrialsMet = aTrials >= minTrials && bTrials >= minTrials;
  const minSuccessesMet = aSuccesses >= minSuccesses && bSuccesses >= minSuccesses;
  const relativeChange =
    aTrials > 0 && aSuccesses > 0
      ? bSuccesses / bTrials / (aSuccesses / aTrials) - 1
      : null;

  if (!minTrialsMet || !minSuccessesMet || aTrials === 0 || bTrials === 0) {
    return {
      verdict: "insufficient_data",
      pApprox: null,
      relativeChange,
      minTrialsMet,
    };
  }

  const p1 = aSuccesses / aTrials;
  const p2 = bSuccesses / bTrials;
  const pooled = (aSuccesses + bSuccesses) / (aTrials + bTrials);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / aTrials + 1 / bTrials));
  if (standardError === 0 || !Number.isFinite(standardError)) {
    return {
      verdict: "not_significant",
      pApprox: 1,
      relativeChange,
      minTrialsMet,
    };
  }

  const z = (p2 - p1) / standardError;
  const pApprox = clamp01(2 * (1 - normalCdf(Math.abs(z))));
  if (!Number.isFinite(alpha) || alpha <= 0 || pApprox >= alpha) {
    return {
      verdict: "not_significant",
      pApprox,
      relativeChange,
      minTrialsMet,
    };
  }
  return {
    verdict: p2 > p1 ? "significant_increase" : "significant_decrease",
    pApprox,
    relativeChange,
    minTrialsMet,
  };
}

export interface AnomalyScore {
  zScore: number | null;
  direction: "up" | "down" | "flat";
  isAnomaly: boolean;
}

export function scoreAnomaly(
  history: number[],
  current: number,
  threshold = DEFAULT_ANOMALY_Z_THRESHOLD
): AnomalyScore {
  const values = history.filter((value) => Number.isFinite(value));
  const direction = directionOf(current);
  if (values.length < 3 || !Number.isFinite(current)) {
    return { zScore: null, direction, isAnomaly: false };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0 || !Number.isFinite(stddev)) {
    return { zScore: null, direction, isAnomaly: false };
  }
  const zScore = (current - mean) / stddev;
  return {
    zScore,
    direction: directionOf(zScore),
    isAnomaly: Math.abs(zScore) >= threshold,
  };
}

export type ConfidenceLabel = "reliable" | "indicative" | "insufficient";

export function confidenceLabel(
  conversions: number,
  impressions: number
): ConfidenceLabel {
  const cleanConversions = normalizeCount(conversions);
  const cleanImpressions = normalizeCount(impressions);
  if (
    cleanConversions >= RELIABLE_MIN_CONVERSIONS &&
    cleanImpressions >= RELIABLE_MIN_IMPRESSIONS
  ) {
    return "reliable";
  }
  if (
    cleanConversions >= INDICATIVE_MIN_CONVERSIONS &&
    cleanImpressions >= INDICATIVE_MIN_IMPRESSIONS
  ) {
    return "indicative";
  }
  return "insufficient";
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function directionOf(value: number): "up" | "down" | "flat" {
  if (!Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax));
  return sign * y;
}
