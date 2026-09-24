import { destination } from '@ow/shared';

import type { Segment } from './geometry.js';

export const STEP_MS = 10_000;
/** Ground distance covered in one 10 s step by a ~500 km LEO. */
export const STEP_KM = 76;
export const SPEED_KM_PER_S = STEP_KM / 10;
export const ALT_KM = 500;
export const T0 = Date.parse('2027-03-01T00:00:00Z');

/**
 * A synthetic ground track made of contiguous 1-minute segments (7 vertices, shared endpoints),
 * travelling on a great circle — the same shape as the real data.
 */
export function makeTrack(opts: {
  satellite: string;
  startMs: number;
  lon: number;
  lat: number;
  bearing: number;
  minutes: number;
}): Segment[] {
  const segments: Segment[] = [];
  // Vertex k lies k steps along the great circle through the start point at the initial bearing.
  const vertex = (k: number): [number, number, number] => {
    const [lon, lat] = destination(opts.lon, opts.lat, opts.bearing, k * STEP_KM);
    return [lon, lat, ALT_KM];
  };
  for (let m = 0; m < opts.minutes; m++) {
    const coords = Array.from({ length: 7 }, (_, v) => vertex(m * 6 + v));
    const startMs = opts.startMs + m * 60_000;
    segments.push({ satellite: opts.satellite, startMs, endMs: startMs + 60_000, coords });
  }
  return segments;
}
