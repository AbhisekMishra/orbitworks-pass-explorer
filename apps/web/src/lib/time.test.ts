import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatHour,
  formatDay,
  formatDuration,
  formatHours,
  formatPassDuration,
  parseUtcDay,
  toEpochS,
  toIsoSeconds,
  formatTime,
  fromDateTimeInput,
  toDateTimeInput,
} from './time';

const T = Date.UTC(2027, 2, 1, 6, 58, 30) / 1000; // Mon 2027-03-01 06:58:30 UTC

describe('UTC formatting', () => {
  it('formats date-times, times and days in UTC', () => {
    expect(formatDateTime(T)).toBe('2027-03-01 06:58');
    expect(formatTime(T)).toBe('06:58:30');
    expect(formatDay(T)).toBe('Mon 01 Mar');
    expect(formatDay(T + 6 * 86_400)).toBe('Sun 07 Mar');
    expect(formatDate(T)).toBe('2027-03-01');
    expect(formatHour(T)).toBe('06');
  });

  it('round-trips datetime-local values as UTC at minute precision', () => {
    expect(toDateTimeInput(T)).toBe('2027-03-01T06:58');
    expect(fromDateTimeInput('2027-03-01T06:58')).toBe(T - 30);
  });

  it.each([
    '',
    '2027-03-01',
    '2027-03-01T6:58',
    '2027-13-01T06:58',
    '2027-02-30T06:58',
    '2027-03-01T24:00',
    'x',
  ])('rejects malformed datetime-local value %j', (v) => {
    expect(fromDateTimeInput(v)).toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [-5, '0 s'],
    [45, '45 s'],
    [60, '1 min'],
    [12 * 60 + 20, '12 min'],
    [6 * 3600, '6 h'],
    [6.5 * 3600, '6 h 30 min'],
    [86_400, '1 d'],
    [86_400 + 6 * 3600, '1 d 6 h'],
    [7 * 86_400, '7 d'],
    // Rounding carries into the next unit instead of showing 60 min or 24 h.
    [3570, '1 h'],
    [3 * 3600 + 59 * 60 + 40, '4 h'],
    [6 * 86_400 + 23 * 3600 + 40 * 60, '7 d'],
  ])('%d s → %s', (s, expected) => {
    expect(formatDuration(s)).toBe(expected);
  });
});

describe('formatHours', () => {
  it.each([
    [0, '00:00'],
    [10.5, '10:30'],
    [23.999, '00:00'],
    [22.25, '22:15'],
  ])('%d h → %s', (h, expected) => {
    expect(formatHours(h)).toBe(expected);
  });
});

describe('formatPassDuration', () => {
  it.each([
    [58.4, '58 s'],
    [60, '1 min'],
    [102, '1 min 42 s'],
    [725, '12 min 5 s'],
    [-3, '0 s'],
  ])('%d s → %s', (s, expected) => {
    expect(formatPassDuration(s)).toBe(expected);
  });
});

describe('instants and days', () => {
  it('converts API instants both ways, without milliseconds', () => {
    expect(toEpochS('2027-03-01T06:58:30Z')).toBe(T);
    expect(toIsoSeconds(T)).toBe('2027-03-01T06:58:30Z');
  });

  it('parses whole UTC days, rejecting malformed and impossible ones', () => {
    expect(parseUtcDay('2027-03-01')).toBe(Date.UTC(2027, 2, 1) / 1000);
    expect(parseUtcDay('2027-02-30')).toBeNull();
    expect(parseUtcDay('2027-3-1')).toBeNull();
    expect(parseUtcDay('')).toBeNull();
  });
});
