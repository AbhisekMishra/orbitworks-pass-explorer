import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MAX_SATELLITES_PER_QUERY, RADIUS_KM } from './constants.js';
import {
  AccessesQuerySchema,
  AccessesResponseSchema,
  ApiErrorSchema,
  DatasetSchema,
  PassSchema,
  SatelliteListSchema,
  TracksBinaryQuerySchema,
  TracksGeoJsonQuerySchema,
  TracksGeoJsonSchema,
  UtcInstantSchema,
  type AccessesResponse,
  type Pass,
} from './schemas.js';

const T0 = '2027-03-01T00:00:00Z';
const T0_MS = Date.parse(T0);

const messages = (res: { error?: { issues: { message: string }[] } }) =>
  res.error?.issues.map((i) => i.message).join(' | ') ?? '';

describe('SatelliteListSchema', () => {
  it.each([
    ['YAM20', ['YAM20']],
    ['YAM20,YAM21', ['YAM20', 'YAM21']],
    [' YAM20 , YAM21 ,', ['YAM20', 'YAM21']],
    [
      ['YAM20', 'YAM21'],
      ['YAM20', 'YAM21'],
    ],
    [
      ['YAM20,YAM21', 'YAM22'],
      ['YAM20', 'YAM21', 'YAM22'],
    ],
    ['YAM20,YAM20,YAM21', ['YAM20', 'YAM21']],
    ['A'.repeat(32), ['A'.repeat(32)]],
  ])('parses %j', (input, expected) => {
    expect(SatelliteListSchema.parse(input)).toEqual(expected);
  });

  it.each([['YAM 20'], ['YAM20;DROP'], ["x'--"], ['<b>'], ['A'.repeat(33)], [[42]]])(
    'rejects %j',
    (input) => {
      expect(SatelliteListSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects an empty list explicitly instead of guessing "none" or "all"', () => {
    for (const input of ['', ',', [''], []]) {
      expect(messages(SatelliteListSchema.safeParse(input))).toMatch(/at least one satellite/);
    }
  });

  it('accepts exactly the maximum number of ids and rejects one more', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`).join(',');
    expect(SatelliteListSchema.parse(ids(MAX_SATELLITES_PER_QUERY))).toHaveLength(MAX_SATELLITES_PER_QUERY);
    expect(SatelliteListSchema.safeParse(ids(MAX_SATELLITES_PER_QUERY + 1)).success).toBe(false);
  });
});

describe('UtcInstantSchema', () => {
  it.each([
    [T0, T0_MS],
    ['2027-03-01T01:00:00+01:00', T0_MS],
    ['2027-03-01T00:00:00.500Z', T0_MS + 500],
    ['2027-03-01', T0_MS],
    ['2000-01-01', Date.UTC(2000, 0, 1)],
    ['2099-12-31T23:59:59Z', Date.UTC(2099, 11, 31, 23, 59, 59)],
  ])('parses %s', (input, expected) => {
    expect(UtcInstantSchema.parse(input)).toBe(expected);
  });

  it.each([['2027-03-01T00:00:00'], ['01/03/2027'], ['2027-13-01'], ['2027-02-30'], ['now'], ['']])(
    'rejects ambiguous or invalid %j',
    (input) => {
      expect(UtcInstantSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([['1999-12-31T23:59:59Z'], ['2100-01-01'], ['0001-01-01']])(
    'rejects out-of-range instant %s',
    (input) => {
      expect(messages(UtcInstantSchema.safeParse(input))).toMatch(/2000–2099/);
    },
  );
});

describe('TracksGeoJsonQuerySchema', () => {
  it('requires a bounded window and points to the binary endpoint', () => {
    expect(messages(TracksGeoJsonQuerySchema.safeParse({}))).toMatch(/\/tracks\/binary/);
    expect(messages(TracksGeoJsonQuerySchema.safeParse({ start: T0 }))).toMatch(/requires "start" and "end"/);
  });

  it('accepts a window up to exactly 6 h and rejects longer or reversed ones', () => {
    expect(TracksGeoJsonQuerySchema.parse({ start: T0, end: '2027-03-01T06:00:00Z' })).toEqual({
      start: T0_MS,
      end: Date.parse('2027-03-01T06:00:00Z'),
    });
    expect(messages(TracksGeoJsonQuerySchema.safeParse({ start: T0, end: '2027-03-01T06:00:01Z' }))).toMatch(
      /6 hours/,
    );
    expect(messages(TracksGeoJsonQuerySchema.safeParse({ start: '2027-03-02', end: T0 }))).toMatch(/after/);
  });
});

describe('TracksBinaryQuerySchema', () => {
  it('allows the whole dataset, one-sided windows and satellite filters', () => {
    expect(TracksBinaryQuerySchema.parse({})).toEqual({});
    expect(TracksBinaryQuerySchema.parse({ start: T0 })).toEqual({ start: T0_MS });
    expect(TracksBinaryQuerySchema.parse({ satellites: 'YAM20,YAM21' }).satellites).toEqual([
      'YAM20',
      'YAM21',
    ]);
  });

  it('allows exactly 31 days', () => {
    expect(TracksBinaryQuerySchema.safeParse({ start: '2027-01-01', end: '2027-02-01' }).success).toBe(true);
  });

  it.each([
    [{ start: '2027-03-02', end: '2027-03-01' }, /after/],
    [{ start: '2027-03-01', end: '2027-03-01' }, /after/],
    [{ start: '2027-01-01', end: '2027-02-01T00:00:01Z' }, /31 days/],
    [{ satellites: 'bad id' }, /Satellite ids/],
  ])('rejects %j', (input, message) => {
    const res = TracksBinaryQuerySchema.safeParse(input);
    expect(res.success).toBe(false);
    expect(messages(res)).toMatch(message);
  });
});

describe('AccessesQuerySchema', () => {
  const base = { lat: '25.2', lon: '55.27' };

  it('parses strings into typed values with defaults', () => {
    expect(AccessesQuerySchema.parse(base)).toEqual({
      lat: 25.2,
      lon: 55.27,
      radiusKm: RADIUS_KM.default,
      daylightOnly: false,
      includePath: false,
    });
  });

  it('parses every optional parameter', () => {
    const q = AccessesQuerySchema.parse({
      ...base,
      radiusKm: '1500',
      start: '2027-03-01',
      end: '2027-03-03T12:00:00Z',
      satellites: 'YAM20',
      daylightOnly: 'true',
    });
    expect(q).toMatchObject({ radiusKm: 1500, start: T0_MS, satellites: ['YAM20'], daylightOnly: true });
  });

  it.each([
    ['-12.5', -12.5],
    ['1e1', 10],
    ['+3', 3],
    ['.5', 0.5],
    [' 12 ', 12],
    [7, 7],
  ])('accepts number %j', (lat, expected) => {
    expect(AccessesQuerySchema.parse({ ...base, lat }).lat).toBe(expected);
  });

  it.each([
    [''],
    [' '],
    ['abc'],
    ['0x10'],
    ['Infinity'],
    ['1e999'],
    ['NaN'],
    ['1.2.3'],
    ['--1'],
    ['1_0'],
    ['91'],
    ['-90.01'],
  ])('rejects lat %j (no silent coercion)', (lat) => {
    expect(AccessesQuerySchema.safeParse({ ...base, lat }).success).toBe(false);
  });

  it.each([
    ['lat', '-90'],
    ['lat', '90'],
    ['lon', '-180'],
    ['lon', '180'],
    ['radiusKm', String(RADIUS_KM.min)],
    ['radiusKm', String(RADIUS_KM.max)],
  ])('accepts inclusive bound %s = %s', (field, value) => {
    expect(AccessesQuerySchema.parse({ ...base, [field]: value })).toHaveProperty(field, Number(value));
  });

  it.each([
    ['lon', '180.5'],
    ['lon', '-180.01'],
    ['radiusKm', String(RADIUS_KM.min - 0.01)],
    ['radiusKm', String(RADIUS_KM.max + 1)],
  ])('rejects out-of-range %s = %s', (field, value) => {
    expect(AccessesQuerySchema.safeParse({ ...base, [field]: value }).success).toBe(false);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['1', true],
  ])('parses daylightOnly=%s', (value, expected) => {
    expect(AccessesQuerySchema.parse({ ...base, daylightOnly: value }).daylightOnly).toBe(expected);
  });

  it.each([
    ['missing longitude', { lat: '1' }, /./],
    ['a reversed window', { ...base, start: '2027-03-05', end: '2027-03-01' }, /after/],
    ['a zero-length window', { ...base, start: T0, end: T0 }, /after/],
    ['a window over 31 days', { ...base, start: '2027-01-01', end: '2027-02-01T00:00:01Z' }, /31 days/],
    ['a non-boolean flag', { ...base, daylightOnly: 'maybe' }, /./],
  ])('rejects %s', (_label, input, message) => {
    expect(messages(AccessesQuerySchema.safeParse(input))).toMatch(message);
  });
});

describe('response schemas', () => {
  const pass: Pass = {
    id: 'YAM20-1',
    satellite: 'YAM20',
    start: T0,
    end: T0,
    durationS: 60,
    tca: T0,
    minDistanceKm: 12,
    maxElevationDeg: 80,
    sunElevationDeg: 40,
    daylight: true,
    direction: 'descending',
    localSolarTimeH: 10.5,
    altitudeKm: 505,
    path: [
      [1, 2],
      [1.1, 2.1],
    ],
  };

  it('accept well-formed payloads', () => {
    expect(
      DatasetSchema.parse({
        name: 'Altair-2P5S',
        start: T0,
        end: '2027-03-08T00:01:00Z',
        stepS: 10,
        satellites: [
          { id: 'YAM20', start: T0, end: T0, segmentCount: 10081, minAltitudeKm: 490, maxAltitudeKm: 542 },
        ],
      }).satellites,
    ).toHaveLength(1);

    const accesses: AccessesResponse = {
      query: {
        lat: 1,
        lon: 2,
        radiusKm: 400,
        start: T0,
        end: T0,
        satellites: ['YAM20'],
        daylightOnly: false,
        includePath: true,
      },
      passes: [pass],
      stats: {
        passCount: 1,
        totalDurationS: 60,
        bySatellite: { YAM20: 1 },
        meanRevisitS: null,
        maxGapS: null,
      },
    };
    expect(AccessesResponseSchema.parse(accesses)).toEqual(accesses);

    const error = {
      statusCode: 400,
      error: 'Bad Request',
      message: 'x',
      issues: [{ path: 'lat', message: 'y' }],
    };
    expect(ApiErrorSchema.parse(error)).toEqual(error);
  });

  it.each([
    ['direction', 'sideways'],
    ['localSolarTimeH', 24],
    ['localSolarTimeH', -0.1],
    ['durationS', -1],
    ['minDistanceKm', -1],
    ['start', '2027-03-01'],
    ['satellite', 'bad id'],
  ])('rejects a pass with an invalid %s (%j) — on that field', (field, value) => {
    const res = PassSchema.safeParse({ ...pass, [field]: value });
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.path[0])).toEqual([field]);
  });

  it('makes the pass path optional (omitted unless requested)', () => {
    const withoutPath: Pass = { ...pass };
    delete withoutPath.path;
    expect(PassSchema.parse(withoutPath)).not.toHaveProperty('path');
  });

  it('rejects GeoJSON coordinates without altitude', () => {
    const feature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 0]] },
      properties: { satellite: 'YAM20', start: T0, end: T0 },
    };
    expect(TracksGeoJsonSchema.safeParse({ type: 'FeatureCollection', features: [feature] }).success).toBe(
      false,
    );
  });
});

describe('zod configuration', () => {
  it('is jitless, so no schema ever calls eval (the web CSP forbids it)', () => {
    expect(z.config().jitless).toBe(true);
  });
});
