import { describe, expect, it } from 'vitest';

import { formatInstant, parseUrlState, serializeUrlState, type SerializableState } from './url';

const T0 = Date.UTC(2027, 2, 1) / 1000;
const H = 3600;
const SATS = ['YAM20', 'YAM21', 'YAM22'];

const base: SerializableState = {
  satellites: SATS,
  hidden: new Set(),
  timeWindow: { startS: T0, endS: T0 + 6 * H },
  defaultWindow: { startS: T0, endS: T0 + 6 * H },
  projection: 'globe',
  camera: null,
};

describe('serializeUrlState', () => {
  it('omits everything at its default', () => {
    expect(serializeUrlState(base)).toBe('');
  });

  it('writes visible satellites, window, projection and camera in a readable form', () => {
    const qs = serializeUrlState({
      ...base,
      hidden: new Set(['YAM21']),
      timeWindow: { startS: T0 + H, endS: T0 + 2 * H },
      projection: 'mercator',
      camera: { lat: 24.4539, lon: 54.3773, zoom: 3.21 },
    });
    expect(qs).toBe(
      '?sats=YAM20,YAM22&from=2027-03-01T01:00Z&to=2027-03-01T02:00Z&proj=flat&map=24.45,54.38,3.2',
    );
  });

  it('writes an empty list when every satellite is hidden', () => {
    expect(serializeUrlState({ ...base, hidden: new Set(SATS) })).toBe('?sats=');
  });

  it('rounds instants to the minute', () => {
    expect(formatInstant(T0 + 89.6)).toBe('2027-03-01T00:01Z');
    expect(formatInstant(T0 + 90)).toBe('2027-03-01T00:02Z');
  });
});

describe('parseUrlState', () => {
  it('round-trips a serialized state', () => {
    const state = {
      ...base,
      hidden: new Set(['YAM20']),
      timeWindow: { startS: T0 + 30 * 60, endS: T0 + 5 * H },
      projection: 'mercator' as const,
      camera: { lat: -33.87, lon: 151.21, zoom: 4.5 },
    };
    expect(parseUrlState(serializeUrlState(state))).toEqual({
      satellites: ['YAM21', 'YAM22'],
      timeWindow: state.timeWindow,
      projection: 'mercator',
      camera: state.camera,
    });
  });

  it('returns nothing for an empty query', () => {
    expect(parseUrlState('')).toEqual({});
  });

  it('parses an explicit globe projection and an empty satellite list', () => {
    expect(parseUrlState('?proj=globe&sats=')).toEqual({ projection: 'globe', satellites: [] });
  });

  it('de-duplicates satellites', () => {
    expect(parseUrlState('?sats=YAM20,YAM20,YAM21').satellites).toEqual(['YAM20', 'YAM21']);
  });

  it.each([
    ['?sats=YAM20,<script>', 'invalid satellite id'],
    ['?from=2027-03-01T01:00Z', 'window without an end'],
    ['?from=2027-03-01T02:00Z&to=2027-03-01T01:00Z', 'inverted window'],
    ['?from=yesterday&to=2027-03-01T01:00Z', 'malformed instant'],
    ['?from=2027-02-30T01:00Z&to=2027-03-03T01:00Z', 'impossible date (would roll over to 2 March)'],
    ['?from=2027-03-01T01:00:00.000Z&to=2027-03-01T02:00Z', 'extra precision'],
    ['?proj=hyperbolic', 'unknown projection'],
    ['?map=91,0,2', 'latitude out of range'],
    ['?map=0,181,2', 'longitude out of range'],
    ['?map=0,0,23', 'zoom out of range'],
    ['?map=0,0', 'missing zoom'],
    ['?map=a,b,c', 'non-numeric camera'],
  ])('ignores %s (%s)', (qs) => {
    expect(parseUrlState(qs)).toEqual({});
  });

  it('caps the number of satellites read from a link', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `S${i}`);
    expect(parseUrlState(`?sats=${ids.join(',')}`).satellites).toHaveLength(64);
  });
});

describe('accesses in links', () => {
  const DAY = 86_400;
  const week = { startS: T0, endS: T0 + 7 * DAY };
  const access = { pin: { lat: 24.4539, lon: 54.3773 }, radiusKm: 400, ...week, daylightOnly: false };

  it('writes nothing about accesses without a pin, and only non-defaults with one', () => {
    expect(serializeUrlState({ ...base, access: { ...access, pin: null }, defaultAccessDays: week })).toBe(
      '',
    );
    expect(serializeUrlState({ ...base, access, defaultAccessDays: week })).toBe('?pin=24.454,54.377');
  });

  it('round-trips pin, radius, inclusive days and the daylight filter', () => {
    const qs = serializeUrlState({
      ...base,
      access: { ...access, radiusKm: 600, startS: T0 + DAY, endS: T0 + 4 * DAY, daylightOnly: true },
      defaultAccessDays: week,
    });
    expect(qs).toBe('?pin=24.454,54.377&r=600&afrom=2027-03-02&ato=2027-03-04&daylight=1');
    expect(parseUrlState(qs)).toEqual({
      pin: { lat: 24.454, lon: 54.377 },
      radiusKm: 600,
      accessDays: { startS: T0 + DAY, endS: T0 + 4 * DAY },
      daylightOnly: true,
    });
  });

  it.each([
    ['?pin=91,0', 'pin latitude out of range'],
    ['?pin=0,200', 'pin longitude out of range'],
    ['?pin=1,2,3', 'pin with extra values'],
    ['?r=5', 'radius below the minimum'],
    ['?r=9999', 'radius above the maximum'],
    ['?r=400.5', 'fractional radius'],
    ['?afrom=2027-03-04&ato=2027-03-02', 'inverted days'],
    ['?afrom=2027-02-30&ato=2027-03-02', 'impossible day'],
    ['?afrom=2027-03-01', 'missing last day'],
    ['?daylight=yes', 'daylight flag not "1"'],
  ])('ignores %s (%s)', (qs) => {
    expect(parseUrlState(qs)).toEqual({});
  });
});
