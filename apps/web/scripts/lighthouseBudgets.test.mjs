import { describe, expect, it } from 'vitest';

import {
  LIGHTHOUSE_BUDGETS,
  BASEMAP_HOST,
  TRACKS_PATH,
  appLoaded,
  basemapLoaded,
  evaluateBudgets,
  formatMetric,
  median,
} from './lighthouseBudgets.mjs';

describe('median', () => {
  it('takes the middle value, and the upper middle for an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([7])).toBe(7);
  });

  it('rejects an empty list', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('evaluateBudgets', () => {
  const budgets = [
    { id: 'a', label: 'A', max: 100, unit: 'ms' },
    { id: 'b', label: 'B', max: 0.05, unit: '' },
  ];

  it('gates the median of each metric, inclusive of the limit', () => {
    const result = evaluateBudgets(
      [
        { a: 90, b: 0.01 },
        { a: 500, b: 0.05 },
        { a: 100, b: 0.2 },
      ],
      budgets,
    );
    expect(result[0]?.values).toEqual([90, 500, 100]);
    expect(result.map((r) => [r.id, r.value, r.passed])).toEqual([
      ['a', 100, true],
      ['b', 0.05, true],
    ]);
  });

  it('fails a metric over budget or missing from a run', () => {
    const result = evaluateBudgets([{ a: 101, b: 0 }, { a: 101 }], budgets);
    expect(result.map((r) => r.passed)).toEqual([false, false]);
    expect(result[1]?.value).toBeNaN();
  });

  it('fails every budget when there are no runs', () => {
    expect(evaluateBudgets([], budgets).map((r) => r.passed)).toEqual([false, false]);
  });

  it('matches the CLAUDE.md budget table (metrics and limits)', () => {
    expect(LIGHTHOUSE_BUDGETS.map((b) => [b.label, b.max])).toEqual([
      ['FCP', 1000],
      ['LCP', 2000],
      ['Speed Index', 2400],
      ['CLS', 0.05],
      ['TBT', 4000],
    ]);
  });
});

describe('appLoaded', () => {
  const lhr = (items) => ({ audits: { 'network-requests': { details: { items } } } });

  it('accepts a run whose tracks download succeeded', () => {
    expect(appLoaded(lhr([{ url: `http://127.0.0.1:4300${TRACKS_PATH}`, statusCode: 200 }]))).toBe(true);
  });

  it('rejects a run whose tracks request failed or never happened', () => {
    expect(appLoaded(lhr([{ url: `https://x${TRACKS_PATH}`, statusCode: 500 }]))).toBe(false);
    expect(appLoaded(lhr([{ url: 'https://x/api/v1/dataset', statusCode: 200 }]))).toBe(false);
    expect(appLoaded({ audits: {} })).toBe(false);
    // The path must be the tracks endpoint itself, not merely contain it.
    expect(appLoaded(lhr([{ url: `https://x/proxy?u=${TRACKS_PATH}`, statusCode: 200 }]))).toBe(false);
  });
});

describe('basemapLoaded', () => {
  const lhr = (items) => ({ audits: { 'network-requests': { details: { items } } } });
  const style = { url: `https://${BASEMAP_HOST}/styles/dark`, statusCode: 200 };
  const tile = { url: `https://${BASEMAP_HOST}/planet/20250101/1/1/0.pbf`, statusCode: 200 };

  it('needs both the style and a vector tile from the basemap host', () => {
    expect(basemapLoaded(lhr([style, tile]))).toBe(true);
    expect(basemapLoaded(lhr([style]))).toBe(false);
    expect(basemapLoaded(lhr([tile]))).toBe(false);
  });

  it('rejects failed requests and other hosts (the fallback style)', () => {
    expect(basemapLoaded(lhr([style, { ...tile, statusCode: 503 }]))).toBe(false);
    expect(basemapLoaded(lhr([style, { ...tile, url: 'https://example.org/0.pbf' }]))).toBe(false);
    expect(basemapLoaded({ audits: {} })).toBe(false);
  });

  it('matches the exact host, not a host name hidden in another URL', () => {
    const spoofed = (u) => ({ ...tile, url: u });
    expect(basemapLoaded(lhr([style, spoofed(`https://evil.example/?${BASEMAP_HOST}/0.pbf`)]))).toBe(false);
    expect(basemapLoaded(lhr([style, spoofed(`https://${BASEMAP_HOST}.evil.example/0.pbf`)]))).toBe(false);
    expect(basemapLoaded(lhr([style, { url: 'not a url', statusCode: 200 }]))).toBe(false);
  });
});

describe('formatMetric', () => {
  it('shows times in whole milliseconds and shifts to three decimals', () => {
    expect(formatMetric(1234.4, 'ms')).toBe('1,234 ms');
    expect(formatMetric(0.0123, '')).toBe('0.012');
    expect(formatMetric(Number.NaN, 'ms')).toBe('n/a');
  });
});
