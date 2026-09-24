/**
 * Geometric queries on decoded tracks: where a satellite is at a time (the "heads" at the end of
 * the window), and which instant of a track is closest to the pointer (the hover tooltip).
 */
import { normalizeLon } from '@ow/shared';

import { POSITION_SIZE, type SplitTrack, type TrackBuffers } from '../tracks/trackBuffers';

export interface TrackSample {
  lon: number;
  lat: number;
  altKm: number;
}

/** Interpolated position at `tS` (epoch seconds), or null outside the track's time span. */
export function sampleTrack(track: TrackBuffers, tS: number): TrackSample | null {
  const n = track.lon.length;
  const f = (tS - track.startS) / track.stepS;
  if (n === 0 || f < 0 || f > n - 1) return null;
  const i = Math.min(Math.floor(f), n - 2);
  if (i < 0) return { lon: track.lon[0] ?? 0, lat: track.lat[0] ?? 0, altKm: track.altKm[0] ?? 0 };
  const w = f - i;
  const lerp = (a: Float32Array): number => (a[i] ?? 0) + w * ((a[i + 1] ?? 0) - (a[i] ?? 0));
  const lon0 = track.lon[i] ?? 0;
  // Shortest way across the antimeridian, then back into [-180, 180).
  const dLon = normalizeLon((track.lon[i + 1] ?? 0) - lon0);
  return { lon: normalizeLon(lon0 + w * dLon), lat: lerp(track.lat), altKm: lerp(track.altKm) };
}

export interface NearestPoint {
  /** Seconds since the dataset epoch (same clock as `TrackBuffers.times`). */
  timeRelS: number;
  /** Squared distance in local degrees (for comparing candidates only). */
  dist2: number;
}

interface NearestQuery {
  /** Render path index (deck.gl picking index). */
  pathIndex: number;
  lon: number;
  lat: number;
  /** Visible window, relative seconds: only the drawn part of the path can be hovered. */
  windowRelS: readonly [number, number];
}

/**
 * Closest point of one render path to (lon, lat), restricted to the visible time window.
 * Works in a local equirectangular frame centred on the pointer (longitude scaled by cos(lat)):
 * exact enough at hover scale, and a single pass over the path's vertices.
 */
export function nearestOnPath(track: SplitTrack, q: NearestQuery): NearestPoint | null {
  const { positions, times, startIndices } = track;
  const first = startIndices[q.pathIndex];
  if (first === undefined) return null;
  const last = (startIndices[q.pathIndex + 1] ?? times.length) - 1;
  const [w0, w1] = q.windowRelS;
  const k = Math.cos((q.lat * Math.PI) / 180);
  const local = (v: number): [number, number] => [
    normalizeLon((positions[POSITION_SIZE * v] ?? 0) - q.lon) * k,
    (positions[POSITION_SIZE * v + 1] ?? 0) - q.lat,
  ];

  let best: NearestPoint | null = null;
  for (let v = first; v < last; v++) {
    const ta = times[v] ?? 0;
    const tb = times[v + 1] ?? 0;
    if (tb < w0 || ta > w1 || tb <= ta) continue;
    const [ax, ay] = local(v);
    const [bx, by] = local(v + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Parameter of the pointer's projection on the segment, limited to its visible part.
    const lo = Math.max(0, (w0 - ta) / (tb - ta));
    const hi = Math.min(1, (w1 - ta) / (tb - ta));
    const u = Math.min(hi, Math.max(lo, len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0));
    const px = ax + u * dx;
    const py = ay + u * dy;
    const dist2 = px * px + py * py;
    if (!best || dist2 < best.dist2) best = { timeRelS: ta + u * (tb - ta), dist2 };
  }
  return best;
}
