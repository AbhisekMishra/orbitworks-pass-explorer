import type { AccessesResponse, Pass } from '@ow/shared';
import { describe, expect, it } from 'vitest';

import { splitAtAntimeridian, type TrackBuffers } from '../../tracks/trackBuffers';

import {
  circleData,
  circleRing,
  csvFileName,
  edgeElevationDeg,
  groupPassesByDay,
  passPath,
  passPortions,
  passesToCsv,
  radiusToSlider,
  roundRadius,
  sliderToRadius,
  unwrapLongitudes,
} from './accessMath';

const pass = (over: Partial<Pass>): Pass => ({
  id: 'YAM20-1',
  satellite: 'YAM20',
  start: '2027-03-01T06:58:16Z',
  end: '2027-03-01T06:59:58Z',
  durationS: 102,
  tca: '2027-03-01T06:59:07Z',
  minDistanceKm: 161.1,
  maxElevationDeg: 70.7,
  sunElevationDeg: 50,
  daylight: true,
  direction: 'descending',
  localSolarTimeH: 10.61,
  altitudeKm: 496.7,
  ...over,
});

describe('groupPassesByDay', () => {
  it('groups by UTC day of the start, chronologically', () => {
    const groups = groupPassesByDay([
      pass({ id: 'c', start: '2027-03-02T07:02:00Z' }),
      pass({ id: 'a', start: '2027-03-01T06:58:16Z' }),
      pass({ id: 'b', start: '2027-03-01T10:07:12Z' }),
    ]);
    expect(groups.map((g) => [g.day, g.passes.map((p) => p.id)])).toEqual([
      ['2027-03-01', ['a', 'b']],
      ['2027-03-02', ['c']],
    ]);
  });

  it('returns no groups for no passes', () => {
    expect(groupPassesByDay([])).toEqual([]);
  });
});

describe('edgeElevationDeg', () => {
  it('is 90° overhead and falls towards the horizon as the radius grows', () => {
    expect(edgeElevationDeg(0, 500)).toBeCloseTo(90, 6);
    expect(edgeElevationDeg(400, 500)).toBeGreaterThan(45);
    expect(edgeElevationDeg(400, 500)).toBeLessThan(55);
    // ~2,500 km is roughly the 0° horizon of a 500 km orbit.
    expect(Math.abs(edgeElevationDeg(2500, 500))).toBeLessThan(2);
  });
});

describe('unwrapLongitudes', () => {
  it('removes ±360° jumps across the antimeridian', () => {
    expect(
      unwrapLongitudes([
        [179, 0],
        [-179, 1],
        [-177, 2],
      ]),
    ).toEqual([
      [179, 0],
      [181, 1],
      [183, 2],
    ]);
    expect(unwrapLongitudes([])).toEqual([]);
  });
});

describe('circleData', () => {
  it('is empty without a pin', () => {
    expect(circleData(null, 400).features).toEqual([]);
  });

  it('is a filled polygon plus its outline for an ordinary circle', () => {
    const { features } = circleData({ lat: 24.45, lon: 54.38 }, 400);
    expect(features.map((f) => f.geometry.type)).toEqual(['Polygon', 'LineString']);
  });

  it('keeps one continuous ring next to the antimeridian', () => {
    const outline = circleData({ lat: 0, lon: 179.9 }, 400).features.at(-1);
    if (outline?.geometry.type !== 'LineString') throw new Error('no outline');
    const lons = outline.geometry.coordinates.map((c) => c[0] ?? 0);
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(20);
  });

  it('draws only the outline of a circle around a pole', () => {
    const { features } = circleData({ lat: 85, lon: 0 }, 1000);
    expect(features.map((f) => f.geometry.type)).toEqual(['LineString']);
  });
});

describe('circleRing', () => {
  it('draws a closed, continuous ring across the antimeridian', () => {
    const { ring, enclosesPole } = circleRing(179.5, 0, 400);
    expect(enclosesPole).toBe(false);
    expect(ring[0]![0]).toBeCloseTo(ring.at(-1)![0], 6);
    const lons = ring.map(([lon]) => lon);
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(10);
  });

  it('flags circles that enclose a pole', () => {
    expect(circleRing(0, 85, 1000).enclosesPole).toBe(true);
    expect(circleRing(0, -85, 1000).enclosesPole).toBe(true);
    expect(circleRing(0, 60, 1000).enclosesPole).toBe(false);
  });
});

describe('passPath', () => {
  const T0 = 1_000_000;
  const lon = [178, 179, -179, -178, -177];
  const track: TrackBuffers = {
    satellite: 'S',
    startS: T0,
    stepS: 10,
    lon: Float32Array.from(lon),
    lat: Float32Array.from([0, 1, 2, 3, 4]),
    altKm: Float32Array.from(lon.map(() => 500)),
    ...splitAtAntimeridian({ lon, lat: [0, 1, 2, 3, 4], t0RelS: 0, stepS: 10 }),
  };

  it('interpolates the ends, keeps the samples between and stays continuous over 180°', () => {
    const path = passPath(track, T0 + 5, T0 + 25);
    expect(path).toHaveLength(4); // start, t=10, t=20, end
    expect(path[0]![0]).toBeCloseTo(178.5, 4);
    expect(path[1]![0]).toBeCloseTo(179, 4);
    expect(path[2]![0]).toBeCloseTo(181, 4);
    expect(path[3]![0]).toBeCloseTo(181.5, 4);
    expect(path[3]![1]).toBeCloseTo(2.5, 4);
  });

  it('includes a sample that coincides with the start only once', () => {
    expect(passPath(track, T0 + 10, T0 + 20)).toHaveLength(2);
  });

  it('returns what it can for a pass reaching past the track', () => {
    expect(passPath(track, T0 + 30, T0 + 999)).toHaveLength(2); // t=30, t=40
  });
});

describe('CSV', () => {
  it('writes a header and one row per pass, RFC 4180 style', () => {
    const csv = passesToCsv([pass({}), pass({ satellite: 'YAM"25', direction: 'ascending' })]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'satellite,start_utc,end_utc,duration_s,closest_approach_utc,min_distance_km,max_elevation_deg,sun_elevation_deg,daylight,direction,local_solar_time_h,altitude_km',
    );
    expect(lines[1]).toBe(
      'YAM20,2027-03-01T06:58:16Z,2027-03-01T06:59:58Z,102,2027-03-01T06:59:07Z,161.1,70.7,50,true,descending,10.61,496.7',
    );
    expect(lines[2]!.startsWith('"YAM""25",')).toBe(true);
    expect(lines.at(-1)).toBe('');
  });

  it('neutralises text that a spreadsheet would run as a formula, but keeps negative numbers', () => {
    const lines = passesToCsv([
      pass({ satellite: '-A1', sunElevationDeg: -12.3 }),
      pass({ satellite: '=1+1' }),
      pass({ satellite: '@SUM' }),
    ]).split('\r\n');
    expect(lines[1]!.startsWith("'-A1,")).toBe(true);
    expect(lines[1]).toContain(',-12.3,');
    expect(lines[2]!.startsWith("'=1+1,")).toBe(true);
    expect(lines[3]!.startsWith("'@SUM,")).toBe(true);
  });

  it('names the file after the place, radius and inclusive dates', () => {
    const q: AccessesResponse['query'] = {
      lat: 24.4539,
      lon: -54.37,
      radiusKm: 400,
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-08T00:00:00Z',
      satellites: [],
      daylightOnly: false,
      includePath: false,
    };
    expect(csvFileName(q)).toBe('passes_24.45N_54.37W_400km_2027-03-01_2027-03-07.csv');
    expect(csvFileName({ ...q, lat: -10 })).toContain('10.00S');
  });
});

describe('radius slider', () => {
  it('rounds radii to readable steps', () => {
    expect([12, 97, 403, 1234, 2480].map(roundRadius)).toEqual([10, 95, 400, 1250, 2500]);
  });

  it('maps the ends of the slider to the radius limits', () => {
    expect(sliderToRadius(0)).toBe(10);
    expect(sliderToRadius(1000)).toBe(2500);
    expect(sliderToRadius(-5)).toBe(10);
    expect(sliderToRadius(2000)).toBe(2500);
    expect(radiusToSlider(10)).toBe(0);
    expect(radiusToSlider(2500)).toBe(1000);
    expect(radiusToSlider(99_999)).toBe(1000);
  });

  it('round-trips radii within one rounding step', () => {
    for (const km of [10, 50, 400, 1000, 2500]) expect(sliderToRadius(radiusToSlider(km))).toBe(km);
  });

  it('gives small radii room on the slider (logarithmic)', () => {
    expect(radiusToSlider(100)).toBeGreaterThan(400);
  });
});

describe('passPortions', () => {
  const T0 = Date.UTC(2027, 2, 1) / 1000;
  const lon = [50, 51, 52, 53];
  const track: TrackBuffers = {
    satellite: 'YAM20',
    startS: T0,
    stepS: 10,
    lon: Float32Array.from(lon),
    lat: Float32Array.from([20, 21, 22, 23]),
    altKm: Float32Array.from(lon.map(() => 500)),
    ...splitAtAntimeridian({ lon, lat: [20, 21, 22, 23], t0RelS: 0, stepS: 10 }),
  };
  const colors = new Map([['YAM20', { rgb: [1, 2, 3] as const }]]);
  const at = (s: number) => new Date((T0 + s) * 1000).toISOString();

  it('builds lifted portions with epoch times for known satellites only', () => {
    const portions = passPortions(
      [
        pass({ id: 'a', start: at(5), end: at(25) }),
        pass({ id: 'b', satellite: 'GHOST', start: at(5), end: at(25) }),
        pass({ id: 'c', start: at(100), end: at(200) }), // outside the track: no geometry
      ],
      [track],
      colors,
    );
    expect(portions.map((p) => p.id)).toEqual(['a']);
    expect(portions[0]).toMatchObject({
      satellite: 'YAM20',
      startS: T0 + 5,
      endS: T0 + 25,
      color: [1, 2, 3],
    });
    expect(portions[0]!.path).toHaveLength(4);
    expect(portions[0]!.path.every((v) => v[2] === 2000)).toBe(true);
  });
});
