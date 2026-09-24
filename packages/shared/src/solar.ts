/**
 * Sun position from the NOAA "General Solar Position Calculations" (fractional-year Fourier series).
 * Accuracy is ~0.1–0.5°, ample for classifying a pass as daylight/night and for showing the Sun
 * elevation an optical payload would see. All inputs are UTC epoch milliseconds.
 */
import { MS_PER_DAY, MS_PER_HOUR } from './constants.js';
import { normalizeHours, toDeg, toRad } from './geo.js';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DEG_OF_LON = 4; // Earth turns 1° in 4 minutes

/** Milliseconds elapsed since the start of the UTC day (also correct for pre-1970 instants). */
const msOfUtcDay = (epochMs: number): number => ((epochMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;

export interface SolarParameters {
  /** Solar declination (radians). */
  declinationRad: number;
  /** Equation of time (minutes): apparent minus mean solar time. */
  equationOfTimeMin: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function solarParameters(epochMs: number): SolarParameters {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const dayOfYear = Math.floor((epochMs - Date.UTC(year, 0, 1)) / MS_PER_DAY) + 1;
  const hours = msOfUtcDay(epochMs) / MS_PER_HOUR;
  const g = ((2 * Math.PI) / (isLeapYear(year) ? 366 : 365)) * (dayOfYear - 1 + (hours - 12) / 24);

  const equationOfTimeMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const declinationRad =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);

  return { declinationRad, equationOfTimeMin };
}

/** Elevation of the Sun above the horizon (degrees, -90..90) at a ground point. */
export function sunElevationDeg(epochMs: number, lon: number, lat: number): number {
  const { declinationRad, equationOfTimeMin } = solarParameters(epochMs);
  const utcMinutes = msOfUtcDay(epochMs) / MS_PER_MINUTE;
  const trueSolarMinutes = utcMinutes + equationOfTimeMin + MINUTES_PER_DEG_OF_LON * lon;
  const hourAngle = toRad(trueSolarMinutes / MINUTES_PER_DEG_OF_LON - 180);
  const la = toRad(lat);
  const cosZenith =
    Math.sin(la) * Math.sin(declinationRad) + Math.cos(la) * Math.cos(declinationRad) * Math.cos(hourAngle);
  return 90 - toDeg(Math.acos(Math.min(1, Math.max(-1, cosZenith))));
}

/**
 * Mean local solar time in hours [0, 24): UTC + longitude / 15.
 * This is exactly how the dataset's `local_time_h` is defined (verified to 1e-14 on all segments),
 * so the client can derive it instead of it being transmitted.
 */
export function meanLocalSolarTimeH(epochMs: number, lon: number): number {
  return normalizeHours(msOfUtcDay(epochMs) / MS_PER_HOUR + lon / 15);
}
