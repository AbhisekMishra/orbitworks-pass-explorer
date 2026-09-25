/**
 * Pure helpers for the latency benchmark (`pnpm --filter @ow/api bench`): percentiles, a seeded
 * pin generator and budget checks. Kept free of I/O so they are unit-tested like the rest of the API.
 */

/** CLAUDE.md "Performance budgets" for the API (asserted in latency.test.ts). */
export const API_BUDGETS = {
  tracksP95Ms: 5,
  tracksPayloadKb: 600,
  accessesP95Ms: 60,
} as const;

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/**
 * Nearest-rank percentile of ascending-sorted samples: the smallest sample with at least `p` % of
 * the samples at or below it. Never interpolates, so it is always an observed latency.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile of an empty sample');
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] ?? Number.NaN;
}

/** Summary of the samples; null when there are none (e.g. a route without server timing). */
export function summarizeOrNull(samplesMs: readonly number[]): LatencySummary | null {
  return samplesMs.length > 0 ? summarize(samplesMs) : null;
}

export function summarize(samplesMs: readonly number[]): LatencySummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.at(-1) ?? Number.NaN,
  };
}

/** mulberry32: a tiny seeded PRNG, so every run (and CI) queries the same pins. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export interface Pin {
  lat: number;
  lon: number;
}

/** The places the geometry finds hardest, always queried first. */
export const EDGE_PINS: readonly Pin[] = [
  { lat: 89.9, lon: 0 },
  { lat: -89.9, lon: 0 },
  // Both sides of the antimeridian.
  { lat: 0, lon: 179.99 },
  { lat: 0, lon: -180 },
  // The brief's inspiration screenshot (UAE).
  { lat: 24.454, lon: 54.377 },
];

const COORD_DECIMALS = 3;
const round = (v: number) => Number(v.toFixed(COORD_DECIMALS));

/**
 * The edge pins, then points spread uniformly over the sphere: latitude from asin (uniform in
 * degrees would oversample the poles), longitude in [-180, 180), the API's range, after rounding.
 */
export function benchmarkPins(count: number, seed: number): Pin[] {
  const random = seededRandom(seed);
  const pins = EDGE_PINS.slice(0, count);
  while (pins.length < count) {
    const lat = (Math.asin(2 * random() - 1) * 180) / Math.PI;
    const lon = round(random() * 360 - 180);
    pins.push({ lat: round(lat), lon: lon >= 180 ? lon - 360 : lon });
  }
  return pins;
}

export interface BudgetCheck {
  name: string;
  actual: number;
  limit: number;
  unit: string;
  /** As CLAUDE.md states it: "p95 < 5 ms", "payload ≤ 600 KB". */
  comparator: '<' | '≤';
}

/** The checks that miss their budget. A NaN measurement (nothing measured) always fails. */
export function failedBudgets(checks: readonly BudgetCheck[]): BudgetCheck[] {
  return checks.filter((c) => !(c.comparator === '<' ? c.actual < c.limit : c.actual <= c.limit));
}

/** "p95 < 5 ms" style budget text. */
export const describeLimit = (c: BudgetCheck): string => `${c.comparator} ${c.limit} ${c.unit}`;

/** A GitHub-flavoured markdown table (the CI job appends it to the step summary). */
export function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
