import { describe, expect, it } from 'vitest';

import {
  API_BUDGETS,
  EDGE_PINS,
  benchmarkPins,
  describeLimit,
  failedBudgets,
  markdownTable,
  percentile,
  seededRandom,
  summarize,
  summarizeOrNull,
  type BudgetCheck,
} from './latency.js';

describe('percentile', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('uses the nearest rank (an observed value, never interpolated)', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile([1, 10], 95)).toBe(10);
    expect(percentile([7], 1)).toBe(7);
  });

  it('rejects an empty sample and out-of-range ranks', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile(hundred, 0)).toThrow(RangeError);
    expect(() => percentile(hundred, 101)).toThrow(RangeError);
    expect(() => percentile(hundred, Number.NaN)).toThrow(RangeError);
  });
});

describe('summarize', () => {
  it('sorts a copy and reports mean, percentiles and max', () => {
    const samples = [5, 1, 4, 2, 3];
    expect(summarize(samples)).toEqual({ count: 5, meanMs: 3, p50Ms: 3, p95Ms: 5, p99Ms: 5, maxMs: 5 });
    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });

  it('rejects an empty sample (use summarizeOrNull when none may exist)', () => {
    expect(() => summarize([])).toThrow(RangeError);
  });
});

describe('API_BUDGETS', () => {
  it('matches the CLAUDE.md budget table', () => {
    expect(API_BUDGETS).toEqual({ tracksP95Ms: 5, tracksPayloadKb: 600, accessesP95Ms: 60 });
  });
});

describe('summarizeOrNull', () => {
  it('is null for no samples, and the summary otherwise', () => {
    expect(summarizeOrNull([])).toBeNull();
    expect(summarizeOrNull([2])?.p95Ms).toBe(2);
  });
});

describe('benchmarkPins', () => {
  it('starts with the hard cases, then is deterministic for a seed', () => {
    const pins = benchmarkPins(50, 42);
    expect(pins).toHaveLength(50);
    expect(pins.slice(0, EDGE_PINS.length)).toEqual(EDGE_PINS);
    expect(benchmarkPins(50, 42)).toEqual(pins);
    expect(benchmarkPins(50, 7)).not.toEqual(pins);
  });

  it('stays inside the API ranges and covers both hemispheres', () => {
    const pins = benchmarkPins(500, 1);
    for (const { lat, lon } of pins) {
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThan(180);
    }
    expect(pins.some((p) => p.lat < 0) && pins.some((p) => p.lat > 0)).toBe(true);
    expect(pins.some((p) => p.lon < 0) && pins.some((p) => p.lon > 0)).toBe(true);
  });

  it('returns only the first edge pins when fewer are asked for', () => {
    expect(benchmarkPins(2, 1)).toEqual(EDGE_PINS.slice(0, 2));
    expect(benchmarkPins(0, 1)).toEqual([]);
  });
});

describe('seededRandom', () => {
  it('yields values in [0, 1)', () => {
    const random = seededRandom(123);
    for (let i = 0; i < 1000; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('failedBudgets', () => {
  const check = (actual: number, comparator: BudgetCheck['comparator']): BudgetCheck => ({
    name: 'x',
    actual,
    limit: 5,
    unit: 'ms',
    comparator,
  });

  it("applies each budget's own comparator", () => {
    expect(failedBudgets([check(4.9, '<'), check(5, '≤')])).toEqual([]);
    expect(failedBudgets([check(5, '<')])).toHaveLength(1);
    expect(failedBudgets([check(5.1, '≤')])).toHaveLength(1);
  });

  it('fails a missing measurement', () => {
    expect(failedBudgets([check(Number.NaN, '<'), check(Number.NaN, '≤')])).toHaveLength(2);
  });

  it('describes the limit the way CLAUDE.md states it', () => {
    expect(describeLimit(check(1, '<'))).toBe('< 5 ms');
  });
});

describe('markdownTable', () => {
  it('renders a header, a separator and the rows', () => {
    expect(markdownTable(['a', 'b'], [['1', '2']])).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });
});
