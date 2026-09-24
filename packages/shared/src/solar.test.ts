import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { meanLocalSolarTimeH, solarParameters, sunElevationDeg } from './solar.js';

const utc = (iso: string) => Date.parse(iso);
const MINUTE_MS = 60_000;
const OBLIQUITY_DEG = 23.44;
const declinationDeg = (iso: string) => (solarParameters(utc(iso)).declinationRad * 180) / Math.PI;

describe('solarParameters', () => {
  it('has near-zero declination at the March equinox and ±obliquity at the solstices', () => {
    expect(declinationDeg('2027-03-20T12:00:00Z')).toBeCloseTo(0, 0);
    expect(declinationDeg('2027-06-21T12:00:00Z')).toBeCloseTo(OBLIQUITY_DEG, 0);
    expect(declinationDeg('2027-12-21T12:00:00Z')).toBeCloseTo(-OBLIQUITY_DEG, 0);
  });

  it('matches the tabulated equation of time (early Nov ≈ +16.4 min, mid Feb ≈ -14.2 min)', () => {
    expect(solarParameters(utc('2027-11-03T12:00:00Z')).equationOfTimeMin).toBeCloseTo(16.4, 0);
    expect(solarParameters(utc('2027-02-11T12:00:00Z')).equationOfTimeMin).toBeCloseTo(-14.2, 0);
  });

  // The NOAA series itself is only ~0.5° accurate, so comparing against almanac equinox times cannot
  // detect a leap-year bug. Continuity across New Year can: a 365-day year length in a leap year
  // makes 31 Dec map to the same angle as 1 Jan, collapsing the daily change to zero.
  it.each([
    [2027, 'common year'],
    [2028, 'leap year'],
  ])('is continuous across the end of %i (%s)', (year) => {
    const dec30 = declinationDeg(`${year}-12-30T12:00:00Z`);
    const dec31 = declinationDeg(`${year}-12-31T12:00:00Z`);
    const jan1 = declinationDeg(`${year + 1}-01-01T12:00:00Z`);
    const withinYearStep = dec31 - dec30;
    expect(Math.abs(withinYearStep)).toBeGreaterThan(0.03);
    expect(jan1 - dec31).toBeCloseTo(withinYearStep, 1);
  });
});

describe('sunElevationDeg', () => {
  it('puts the Sun overhead at the subsolar point (equinox, equator, local solar noon)', () => {
    // Equation of time on 2027-03-20 is ≈ -7.5 min, so solar noon at lon 0 is ≈ 12:07:30 UTC.
    expect(sunElevationDeg(utc('2027-03-20T12:07:30Z'), 0, 0)).toBeGreaterThan(89);
  });

  it('follows 90° − |lat| at equinox noon', () => {
    expect(sunElevationDeg(utc('2027-03-20T12:07:30Z'), 0, 45)).toBeCloseTo(45, 0);
    expect(sunElevationDeg(utc('2027-03-20T12:07:30Z'), 0, -60)).toBeCloseTo(30, 0);
  });

  it('is at the horizon at sunrise and near nadir at local midnight', () => {
    expect(Math.abs(sunElevationDeg(utc('2027-03-20T06:07:30Z'), 0, 0))).toBeLessThan(1);
    expect(sunElevationDeg(utc('2027-03-20T00:07:30Z'), 0, 0)).toBeLessThan(-88);
  });

  it('peaks at Dubai solar noon (12:00 − 4 min/° × 55.27° − EoT(−12.9 min) = 08:31:48 UTC)', () => {
    const dubai = { lon: 55.27, lat: 25.2 };
    const noon = utc('2027-03-01T08:31:48Z');
    const at = (t: number) => sunElevationDeg(t, dubai.lon, dubai.lat);
    expect(at(noon)).toBeGreaterThan(at(noon - 5 * MINUTE_MS));
    expect(at(noon)).toBeGreaterThan(at(noon + 5 * MINUTE_MS));
    expect(at(noon)).toBeCloseTo(90 - dubai.lat - 7.9, 0); // declination on 1 March ≈ -7.9°
  });

  it('equals the declination at the poles (polar day / night at the June solstice)', () => {
    const t = utc('2027-06-21T00:00:00Z');
    expect(sunElevationDeg(t, 0, 90)).toBeCloseTo(OBLIQUITY_DEG, 0);
    expect(sunElevationDeg(t, 120, -90)).toBeCloseTo(-OBLIQUITY_DEG, 0);
  });

  it('is periodic in longitude (unnormalized longitudes are accepted)', () => {
    const t = utc('2027-03-04T17:20:00Z');
    expect(sunElevationDeg(t, 190, 12)).toBeCloseTo(sunElevationDeg(t, -170, 12), 9);
    expect(sunElevationDeg(t, 180, -33)).toBeCloseTo(sunElevationDeg(t, -180, -33), 9);
  });

  it('is antisymmetric between antipodes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: utc('2020-01-01T00:00:00Z'), max: utc('2035-12-31T23:59:59Z') }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -90, max: 90, noNaN: true }),
        (t, lon, lat) => {
          expect(sunElevationDeg(t, lon + 180, -lat)).toBeCloseTo(-sunElevationDeg(t, lon, lat), 9);
        },
      ),
    );
  });
});

describe('meanLocalSolarTimeH', () => {
  it('reproduces the dataset local_time_h (first YAM20 segment, wrapped to [0, 24))', () => {
    // Source: ts_start 2027-03-01T00:00:00Z, lon -22.551661690439925, local_time_h -1.503444112695995
    expect(meanLocalSolarTimeH(utc('2027-03-01T00:00:00Z'), -22.551661690439925)).toBeCloseTo(
      24 - 1.503444112695995,
      12,
    );
  });

  it('wraps past midnight and handles the antimeridian', () => {
    expect(meanLocalSolarTimeH(utc('2027-03-01T23:00:00Z'), 30)).toBeCloseTo(1, 12);
    expect(meanLocalSolarTimeH(utc('2027-03-01T12:00:00Z'), 180)).toBeCloseTo(0, 12);
    expect(meanLocalSolarTimeH(utc('2027-03-01T12:00:00Z'), -180)).toBeCloseTo(0, 12);
  });

  it('is correct before 1970 (negative epoch milliseconds)', () => {
    expect(meanLocalSolarTimeH(utc('1969-12-31T18:00:00Z'), 0)).toBeCloseTo(18, 12);
  });
});
