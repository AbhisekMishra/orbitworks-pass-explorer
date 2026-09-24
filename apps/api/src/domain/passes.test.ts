import { EARTH_RADIUS_KM, destination, distanceKm, type Pass } from '@ow/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ALT_KM, SPEED_KM_PER_S, T0, makeTrack } from '../../test/synthetic.js';
import { geometryFromSegments, type Segment } from '../../test/geometry.js';

import { computePasses as computeOnGeometry, computeStats, type PassQuery } from './passes.js';

/** Runs the engine over every segment (ids = array indices, already satellite/time ordered per test). */
const computePasses = (segments: readonly Segment[], q: PassQuery) =>
  computeOnGeometry(geometryFromSegments(segments), segments.keys(), q);

const KM_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_KM;
const WEEK_MS = 7 * 86_400_000;
const at = (ms: number) => Date.parse(new Date(ms).toISOString());
const query = (over: Partial<PassQuery> = {}): PassQuery => ({
  lon: 10,
  lat: 0,
  radiusKm: 100,
  startMs: T0,
  endMs: T0 + WEEK_MS,
  daylightOnly: false,
  includePath: true,
  ...over,
});

/** A northbound track that starts `leadKm` south of (lon, 0), so it crosses the equator at lon. */
const northbound = (satellite: string, lon: number, leadKm = 300, startMs = T0, minutes = 3): Segment[] =>
  makeTrack({ satellite, startMs, lon, lat: -leadKm / KM_PER_DEG, bearing: 0, minutes });

/** Seconds from the track start at which a point `km` along the track is reached. */
const secondsAt = (km: number) => km / SPEED_KM_PER_S;
/** The clipped path, asserting it was requested and returned. */
const pathOf = (pass: Pass | undefined): [number, number][] => {
  expect(pass?.path).toBeDefined();
  return pass?.path ?? [];
};
const expectTimeNear = (iso: string, expectedMs: number) => {
  expect(Math.abs(Date.parse(iso) - expectedMs)).toBeLessThanOrEqual(1000); // output is rounded to 1 s
};

describe('computePasses — geometry', () => {
  it('finds an overhead pass with exact AOS/LOS, TCA, distance and elevation', () => {
    const [pass, ...rest] = computePasses(northbound('S1', 10), query());
    expect(rest).toHaveLength(0);
    // Along a great circle through the centre, the arc inside the circle is exactly 2r long.
    expectTimeNear(pass!.start, T0 + secondsAt(200) * 1000);
    expectTimeNear(pass!.end, T0 + secondsAt(400) * 1000);
    expectTimeNear(pass!.tca, T0 + secondsAt(300) * 1000);
    expect(pass!.durationS).toBeCloseTo(secondsAt(200), -0.5);
    expect(pass!.minDistanceKm).toBeLessThan(0.1);
    expect(pass!.maxElevationDeg).toBeGreaterThan(89.9);
    expect(pass!.altitudeKm).toBe(ALT_KM);
    expect(pass!.direction).toBe('ascending');
    expect(pass!.satellite).toBe('S1');
  });

  it('clips the ground track to the circle: path endpoints lie on the boundary', () => {
    const [pass] = computePasses(northbound('S1', 10), query());
    const path = pathOf(pass);
    const first = path[0]!;
    const last = path.at(-1)!;
    expect(distanceKm([10, 0], first)).toBeCloseTo(100, 1);
    expect(distanceKm([10, 0], last)).toBeCloseTo(100, 1);
    expect(path.length).toBeGreaterThan(2); // interior vertices kept for display
  });

  it('matches the spherical chord for an offset pass (cos r = cos d · cos x)', () => {
    const offsetKm = 60;
    const target = destination(10, 0, 90, offsetKm); // 60 km east of the track
    const [pass] = computePasses(northbound('S1', 10), query({ lon: target[0], lat: target[1] }));
    const halfArcKm =
      Math.acos(Math.cos(100 / EARTH_RADIUS_KM) / Math.cos(offsetKm / EARTH_RADIUS_KM)) * EARTH_RADIUS_KM;
    expect(pass!.minDistanceKm).toBeCloseTo(offsetKm, 0);
    expect(pass!.durationS).toBeCloseTo(secondsAt(2 * halfArcKm), -0.5);
    expect(pass!.maxElevationDeg).toBeLessThan(90);
    expect(pass!.maxElevationDeg).toBeGreaterThan(80);
  });

  it('reports nothing when the track stays outside the circle', () => {
    const target = destination(10, 0, 90, 150);
    expect(computePasses(northbound('S1', 10), query({ lon: target[0], lat: target[1] }))).toEqual([]);
  });

  it('labels a southbound pass as descending', () => {
    const southbound = makeTrack({
      satellite: 'S2',
      startMs: T0,
      lon: 10,
      lat: 300 / KM_PER_DEG,
      bearing: 180,
      minutes: 3,
    });
    expect(computePasses(southbound, query())[0]?.direction).toBe('descending');
  });

  it('merges pieces across arc and segment boundaries into one pass', () => {
    // 1-minute segments cover ~456 km; a 400 km-radius circle spans two segment boundaries.
    const passes = computePasses(northbound('S1', 10, 600, T0, 4), query({ radiusKm: 400 }));
    expect(passes).toHaveLength(1);
    expect(passes[0]!.durationS).toBeCloseTo(secondsAt(800), -0.5);
  });

  it('keeps a continuous path across the antimeridian', () => {
    const east = makeTrack({ satellite: 'AM', startMs: T0, lon: 177, lat: 0, bearing: 90, minutes: 3 });
    const [pass] = computePasses(east, query({ lon: 180, lat: 0, radiusKm: 200 }));
    expect(pass).toBeDefined();
    const lons = pathOf(pass).map(([lon]) => lon);
    expect(lons.every((l, i) => i === 0 || l > (lons[i - 1] ?? 0))).toBe(true); // no ±360° jump
    expect(Math.min(...lons)).toBeLessThan(180);
    expect(Math.max(...lons)).toBeGreaterThan(180);
  });

  it('omits the path unless requested (it dominates the response size)', () => {
    const [pass] = computePasses(northbound('S1', 10), query({ includePath: false }));
    expect(pass).toBeDefined();
    expect(pass).not.toHaveProperty('path');
  });

  it('finds an exact pass over the North Pole', () => {
    // Due north along lon 10 from 80°N: the track crosses the pole and continues down lon -170.
    // 4 minutes: the pass ends ~186 s in, so a 3-minute track would stop inside the circle.
    const polar = makeTrack({ satellite: 'P', startMs: T0, lon: 10, lat: 80, bearing: 0, minutes: 4 });
    const [pass, ...rest] = computePasses(polar, query({ lon: 0, lat: 90, radiusKm: 300 }));
    expect(rest).toHaveLength(0);
    const toPoleKm = 10 * KM_PER_DEG;
    expectTimeNear(pass!.start, T0 + secondsAt(toPoleKm - 300) * 1000);
    expectTimeNear(pass!.end, T0 + secondsAt(toPoleKm + 300) * 1000);
    expect(pass!.minDistanceKm).toBeLessThan(0.1);
    const lons = pathOf(pass).map(([lon]) => lon);
    for (let i = 1; i < lons.length; i++) expect(Math.abs(lons[i]! - lons[i - 1]!)).toBeLessThanOrEqual(180);
  });

  it('handles a zero-length arc (repeated vertex) inside the circle', () => {
    const stalled: Segment = {
      satellite: 'Z',
      startMs: T0,
      endMs: T0 + 30_000,
      coords: [
        [10, -0.5, 500],
        [10, 0, 500],
        [10, 0, 500],
        [10, 0.5, 500],
      ],
    };
    const [pass] = computePasses([stalled], query());
    expect(pass!.minDistanceKm).toBeLessThan(0.1);
    expect(Number.isFinite(pass!.maxElevationDeg)).toBe(true);
  });

  it('ignores segments with fewer than two vertices', () => {
    const degenerate: Segment = { satellite: 'X', startMs: T0, endMs: T0 + 60_000, coords: [[10, 0, 500]] };
    expect(computePasses([degenerate], query())).toEqual([]);
  });
});

describe('computePasses — time window', () => {
  it('clips a pass that starts before the window', () => {
    const windowStart = T0 + secondsAt(250) * 1000; // after AOS, before TCA
    const [pass] = computePasses(northbound('S1', 10), query({ startMs: windowStart }));
    expectTimeNear(pass!.start, windowStart);
    expectTimeNear(pass!.tca, T0 + secondsAt(300) * 1000);
  });

  it('clamps the closest approach into the window when TCA falls outside it', () => {
    const windowEnd = T0 + secondsAt(250) * 1000; // before TCA
    const [pass] = computePasses(northbound('S1', 10), query({ endMs: windowEnd }));
    expectTimeNear(pass!.end, windowEnd);
    expectTimeNear(pass!.tca, windowEnd);
    expect(pass!.minDistanceKm).toBeCloseTo(50, 0); // 50 km short of the target at the window end
  });

  it('returns nothing for a window starting just after loss of signal', () => {
    const afterLos = T0 + secondsAt(400) * 1000 + 50;
    expect(computePasses(northbound('S1', 10), query({ startMs: afterLos }))).toEqual([]);
  });

  it('returns nothing for a window that misses the pass', () => {
    expect(computePasses(northbound('S1', 10), query({ startMs: T0 + 3_600_000 }))).toEqual([]);
    expect(computePasses(northbound('S1', 10), query({ endMs: T0 + 5_000 }))).toEqual([]);
  });
});

describe('computePasses — ordering and daylight', () => {
  // Over (0°, 0°) in early March: ~12:07 UTC is local noon, ~00:07 UTC local midnight.
  const noon = Date.parse('2027-03-01T12:00:00Z');
  const midnight = Date.parse('2027-03-01T00:00:00Z');
  const tracks = [...northbound('NIGHT', 0, 300, midnight), ...northbound('DAY', 0, 300, noon)];

  it('classifies passes by Sun elevation at the target', () => {
    const passes = computePasses(tracks, query({ lon: 0 }));
    const day = passes.find((p) => p.satellite === 'DAY');
    const night = passes.find((p) => p.satellite === 'NIGHT');
    expect(day).toMatchObject({ daylight: true });
    expect(day!.sunElevationDeg).toBeGreaterThan(60);
    expect(night).toMatchObject({ daylight: false });
    expect(night!.sunElevationDeg).toBeLessThan(-60);
    expect(day!.localSolarTimeH).toBeCloseTo(12, 0);
  });

  it('filters to daylight passes on request', () => {
    const passes = computePasses(tracks, query({ lon: 0, daylightOnly: true }));
    expect(passes.map((p) => p.satellite)).toEqual(['DAY']);
  });

  it('sorts by start time, and does not merge simultaneous passes of different satellites', () => {
    const simultaneous = [...northbound('B', 10), ...northbound('A', 10)];
    const passes = computePasses(simultaneous, query());
    expect(passes.map((p) => p.satellite)).toEqual(['A', 'B']);
    expect(at(Date.parse(passes[0]!.start))).toBe(at(Date.parse(passes[1]!.start)));
  });
});

describe('computePasses — agrees with brute-force sampling (property)', () => {
  it('reports the same AOS/LOS as sampling the track every 0.1 s', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -170, max: 170, noNaN: true }),
        fc.double({ min: -85, max: 85, noNaN: true }), // near-polar starts too
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 20, max: 1500, noNaN: true }), // target offset from the track start
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 10, max: 2500, noNaN: true }), // radius, up to the API maximum
        (lon, lat, bearing, offKm, offBearing, radiusKm) => {
          const track = makeTrack({ satellite: 'P', startMs: T0, lon, lat, bearing, minutes: 3 });
          const [tLon, tLat] = destination(lon, lat, offBearing, offKm);
          const passes = computePasses(track, query({ lon: tLon, lat: tLat, radiusKm }));

          const intervals: [number, number][] = [];
          const sampledKm: number[] = [];
          let entry: number | null = null;
          for (let ms = 0; ms <= 180_000; ms += 100) {
            const k = ms / 10_000; // steps along the great circle
            const p = destination(lon, lat, bearing, k * 76);
            const d = distanceKm(p, [tLon, tLat]);
            sampledKm.push(d);
            const inside = d <= radiusKm;
            if (inside && entry === null) entry = ms;
            if (!inside && entry !== null) {
              intervals.push([entry, ms]);
              entry = null;
            }
          }
          if (entry !== null) intervals.push([entry, 180_000]);
          // Ignore sub-second grazes that sampling or rounding cannot resolve consistently.
          const significant = (xs: [number, number][]) => xs.filter(([a, b]) => b - a > 1500);
          const computed = passes.map((p): [number, number] => [
            Date.parse(p.start) - T0,
            Date.parse(p.end) - T0,
          ]);
          expect(significant(computed)).toHaveLength(significant(intervals).length);
          for (const [a, b] of significant(intervals)) {
            const match = computed.find(([c]) => Math.abs(c - a) <= 700);
            expect(match).toBeDefined();
            expect(Math.abs((match?.[1] ?? 0) - b)).toBeLessThanOrEqual(700);
            // Closest approach vs the samples: samples are 0.76 km apart along the track, so the
            // sampled minimum can only overshoot the true one, by at most half a step (0.38 km);
            // the reported value is rounded to 0.1 km.
            const pass = passes[computed.indexOf(match ?? [NaN, NaN])];
            const sampledMin = Math.min(...sampledKm.slice(Math.floor(a / 100), Math.ceil(b / 100) + 1));
            const reported = pass?.minDistanceKm ?? NaN;
            expect(reported).toBeLessThanOrEqual(sampledMin + 0.05);
            expect(sampledMin - reported).toBeLessThanOrEqual(0.38 + 0.05);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('computeStats', () => {
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
    expect(computeStats([], ['A', 'B'])).toEqual({
      passCount: 0,
      totalDurationS: 0,
      bySatellite: { A: 0, B: 0 },
      meanRevisitS: null,
      maxGapS: null,
    });
  });

  it('needs two passes for revisit and gap statistics', () => {
    const stats = computeStats([pass('A', '2027-03-01T00:00:00Z', '2027-03-01T00:01:00Z')], ['A']);
    expect(stats).toMatchObject({ passCount: 1, totalDurationS: 60, meanRevisitS: null, maxGapS: null });
  });

  it('computes mean revisit from starts and the longest uncovered gap across overlapping passes', () => {
    const passes = [
      pass('A', '2027-03-01T00:00:00Z', '2027-03-01T00:10:00Z'),
      pass('B', '2027-03-01T00:05:00Z', '2027-03-01T00:20:00Z'), // overlaps A: no gap
      pass('A', '2027-03-01T01:00:00Z', '2027-03-01T01:01:00Z'), // 40 min after B ends
    ];
    const stats = computeStats(passes, ['A', 'B', 'C']);
    expect(stats.bySatellite).toEqual({ A: 2, B: 1, C: 0 });
    expect(stats.meanRevisitS).toBe(1800); // starts at 0, 5, 60 min → mean step 30 min
    expect(stats.maxGapS).toBe(2400);
    expect(stats.totalDurationS).toBe(600 + 900 + 60);
  });
});
