/**
 * Fixed-bucket latency histogram + percentile-by-linear-interpolation. Pure
 * functions, no I/O — see apps/workers/scripts/self-test-metrics.ts for
 * direct unit coverage.
 *
 * Approximation note: percentiles are computed by assuming values are
 * uniformly distributed WITHIN each bucket, then linearly interpolating to
 * the target rank. That's exact only when the underlying distribution truly
 * is uniform per-bucket; in practice it's a reasonable approximation as long
 * as buckets are narrow relative to the metric's spread (true here — buckets
 * roughly double from 250ms up to 32s). The last bucket has no upper bound
 * (it's the "+inf" overflow catch-all), so a target rank landing there can't
 * be interpolated — we return the bucket's lower edge, which *underestimates*
 * the true p95 whenever there's a long tail past 32s. Fine for a product
 * dashboard; not precise enough for an SLA.
 */

export const LATENCY_BUCKET_BOUNDARIES_MS: readonly number[] = [
  0, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000,
];

export function emptyHistogram(): number[] {
  return new Array(LATENCY_BUCKET_BOUNDARIES_MS.length).fill(0) as number[];
}

/** Index of the bucket a value falls into: the largest i such that
 *  boundaries[i] <= value (boundaries must be sorted ascending). Values past
 *  the last boundary land in the final (overflow, "+inf") bucket. */
export function bucketIndexForValue(boundaries: readonly number[], value: number): number {
  const v = Math.max(0, value || 0);
  let idx = 0;
  for (let i = 0; i < boundaries.length; i++) {
    if (v >= (boundaries[i] ?? 0)) idx = i;
    else break;
  }
  return idx;
}

export function addToHistogram(hist: number[], boundaries: readonly number[], value: number): void {
  const idx = bucketIndexForValue(boundaries, value);
  hist[idx] = (hist[idx] ?? 0) + 1;
}

/** Adds `source` bucket-for-bucket into `target` (in place). Buckets must be
 *  the same length/boundaries — used to merge N days of a metric together. */
export function mergeHistogramInto(target: number[], source: readonly number[] | undefined): void {
  if (!source) return;
  for (let i = 0; i < target.length; i++) {
    target[i] = (target[i] ?? 0) + (source[i] ?? 0);
  }
}

export function percentileFromHistogram(
  counts: readonly number[],
  boundaries: readonly number[],
  p: number,
): number {
  const total = counts.reduce((a: number, b) => a + (b ?? 0), 0);
  if (total <= 0) return 0;
  const targetRank = Math.min(1, Math.max(0, p)) * total;

  let cumulative = 0;
  for (let i = 0; i < counts.length; i++) {
    const bucketCount = counts[i] ?? 0;
    const nextCumulative = cumulative + bucketCount;
    const lower = boundaries[i] ?? 0;
    const upper = boundaries[i + 1];

    if (targetRank <= nextCumulative || i === counts.length - 1) {
      if (bucketCount <= 0 || upper === undefined) return lower;
      const fracIntoBucket = (targetRank - cumulative) / bucketCount;
      return lower + fracIntoBucket * (upper - lower);
    }
    cumulative = nextCumulative;
  }
  return boundaries[boundaries.length - 1] ?? 0;
}
