/**
 * The accesses query window and pass focus: pure time arithmetic, used by the store and the URL
 * layer (kept apart from the map geometry in accessMath.ts, so state code does not depend on it).
 */
import { SECONDS_PER_DAY } from '../../lib/time';

/** Whole UTC days [startS, endS) inside the dataset span, at least one day long. */
export function clampDays(
  startS: number,
  endS: number,
  bounds: { startS: number; endS: number },
): {
  startS: number;
  endS: number;
} {
  const floorDay = (t: number) => Math.floor(t / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const ceilDay = (t: number) => Math.ceil(t / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const minS = floorDay(bounds.startS);
  const maxS = ceilDay(bounds.endS);
  const start = Math.min(Math.max(floorDay(startS), minS), maxS - SECONDS_PER_DAY);
  const end = Math.max(Math.min(ceilDay(endS), maxS), start + SECONDS_PER_DAY);
  return { startS: start, endS: end };
}

/** Context shown around a focused pass: enough to see the approach and the departure. */
export const PASS_CONTEXT_S = 10 * 60;

/** Timeline window that frames a pass, with context on both sides. */
export function passWindow(startS: number, endS: number): { startS: number; endS: number } {
  const pad = Math.max(PASS_CONTEXT_S, endS - startS);
  return { startS: startS - pad, endS: endS + pad };
}
