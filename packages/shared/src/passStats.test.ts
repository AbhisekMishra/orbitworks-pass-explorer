import { describe, expect, it } from 'vitest';

import { computePassStats } from './passStats.js';
import type { Pass } from './schemas.js';

describe('computePassStats', () => {
  const pass = (satellite: string, start: string, end: string): Pass => ({
    id: `${satellite}-${start}`,
    satellite,
    start,
    end,
    durationS: (Date.parse(end) - Date.parse(start)) / 1000,
    tca: start,
    minDistanceKm: 0,
    maxElevationDeg: 90,
    sunElevationDeg: 10,
    daylight: true,
    direction: 'ascending',
    localSolarTimeH: 10,
    altitudeKm: 500,
    path: [],
  });

  it('reports zeros and nulls without passes, listing every requested satellite', () => {
    expect(computePassStats([], ['A', 'B'])).toEqual({
      passCount: 0,
      totalDurationS: 0,
      bySatellite: { A: 0, B: 0 },
      meanRevisitS: null,
      maxGapS: null,
    });
  });

  it('needs two passes for revisit and gap statistics', () => {
    const stats = computePassStats([pass('A', '2027-03-01T00:00:00Z', '2027-03-01T00:01:00Z')], ['A']);
    expect(stats).toMatchObject({ passCount: 1, totalDurationS: 60, meanRevisitS: null, maxGapS: null });
  });

  it('computes mean revisit from starts and the longest uncovered gap across overlapping passes', () => {
    const passes = [
      pass('A', '2027-03-01T00:00:00Z', '2027-03-01T00:10:00Z'),
      pass('B', '2027-03-01T00:05:00Z', '2027-03-01T00:20:00Z'), // overlaps A: no gap
      pass('A', '2027-03-01T01:00:00Z', '2027-03-01T01:01:00Z'), // 40 min after B ends
    ];
    const stats = computePassStats(passes, ['A', 'B', 'C']);
    expect(stats.bySatellite).toEqual({ A: 2, B: 1, C: 0 });
    expect(stats.meanRevisitS).toBe(1800); // starts at 0, 5, 60 min → mean step 30 min
    expect(stats.maxGapS).toBe(2400);
    expect(stats.totalDurationS).toBe(600 + 900 + 60);
  });
});
