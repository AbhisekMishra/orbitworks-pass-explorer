/**
 * Turns decoded OWT1 tracks into GPU-ready buffers, once, in the decode worker.
 *
 * - Time is stored relative to the dataset epoch (`t0S`). Absolute epoch seconds (~1.8e9) do not
 *   fit Float32's 24-bit mantissa (~128 s resolution); relative seconds over a week are exact to
 *   ~0.06 s. The GPU then filters the time window with two uniforms and no re-upload.
 * - Each satellite's track is split where it crosses the antimeridian, with an interpolated vertex
 *   on both edges (±180°), so flat (Mercator) rendering never draws a line across the whole map.
 * - Rendered vertices sit RENDER_ALTITUDE_M above the ground. On the globe, a straight segment
 *   between two samples 76 km apart dips ~113 m below the curved surface at its midpoint, where
 *   the globe's depth test would hide it (tracks looked dashed). 2 km is invisible at any zoom.
 * - The original vertices are kept (Float32) for positions at a given time (heads, tooltips).
 */
import type { DecodedTracks } from '@ow/shared';

/** Height of rendered tracks above the ground (see the module comment). */
export const RENDER_ALTITUDE_M = 2000;
/** Components per render vertex: lon, lat, altitude in meters. */
export const POSITION_SIZE = 3;

export interface TrackBuffers {
  satellite: string;
  /** Epoch seconds of the first vertex, and the fixed step between vertices. */
  startS: number;
  stepS: number;
  /** Original vertices, in time order. */
  lon: Float32Array;
  lat: Float32Array;
  altKm: Float32Array;
  /** Render geometry: interleaved [lon, lat, altM] per vertex, split into paths at the antimeridian. */
  positions: Float32Array;
  /** Seconds since the dataset epoch, per render vertex. */
  times: Float32Array;
  /** First render vertex of each path (deck.gl binary `startIndices`). */
  startIndices: Uint32Array;
}

export interface LoadedTracks {
  /** Dataset epoch (seconds): earliest vertex of any track. GPU times are relative to it. */
  t0S: number;
  /** Latest vertex of any track (epoch seconds). */
  t1S: number;
  stepS: number;
  tracks: TrackBuffers[];
}

/** A jump of more than half the globe between consecutive samples can only be a wrap. */
const crossesAntimeridian = (a: number, b: number): boolean => Math.abs(b - a) > 180;

interface SplitInput {
  lon: ArrayLike<number>;
  lat: ArrayLike<number>;
  /** Relative time of vertex 0, and seconds per vertex. */
  t0RelS: number;
  stepS: number;
}

export interface SplitTrack {
  positions: Float32Array;
  times: Float32Array;
  startIndices: Uint32Array;
}

export function splitAtAntimeridian({ lon, lat, t0RelS, stepS }: SplitInput): SplitTrack {
  const n = lon.length;
  let crossings = 0;
  for (let i = 1; i < n; i++) if (crossesAntimeridian(Number(lon[i - 1]), Number(lon[i]))) crossings++;

  const vertexCount = n + 2 * crossings;
  const positions = new Float32Array(vertexCount * POSITION_SIZE);
  const times = new Float32Array(vertexCount);
  const startIndices = new Uint32Array(n === 0 ? 0 : crossings + 1);

  let v = 0;
  let path = 1;
  const push = (x: number, y: number, t: number): void => {
    positions[POSITION_SIZE * v] = x;
    positions[POSITION_SIZE * v + 1] = y;
    positions[POSITION_SIZE * v + 2] = RENDER_ALTITUDE_M;
    times[v] = t;
    v++;
  };

  for (let i = 0; i < n; i++) {
    const x = Number(lon[i]);
    const y = Number(lat[i]);
    const t = t0RelS + i * stepS;
    const px = Number(lon[i - 1]);
    if (i > 0 && crossesAntimeridian(px, x)) {
      // Unwrap the new point next to the previous one, then interpolate where it meets the edge.
      const edge = x < px ? 180 : -180;
      const unwrapped = x + 2 * edge;
      const f = (edge - px) / (unwrapped - px);
      const py = Number(lat[i - 1]);
      const yc = py + f * (y - py);
      const tc = t - stepS + f * stepS;
      push(edge, yc, tc);
      startIndices[path++] = v;
      push(-edge, yc, tc);
    }
    push(x, y, t);
  }
  return { positions, times, startIndices };
}

export function buildTrackBuffers({ header, tracks }: DecodedTracks): LoadedTracks {
  const nonEmpty = tracks.filter((t) => t.lon.length > 0);
  const t0S = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map((t) => t.startS));
  const t1S =
    nonEmpty.length === 0
      ? 0
      : Math.max(...nonEmpty.map((t) => t.startS + (t.lon.length - 1) * header.stepS));
  return {
    t0S,
    t1S,
    stepS: header.stepS,
    tracks: tracks.map((t) => ({
      satellite: t.satellite,
      startS: t.startS,
      stepS: header.stepS,
      lon: Float32Array.from(t.lon),
      lat: Float32Array.from(t.lat),
      altKm: Float32Array.from(t.altKm),
      ...splitAtAntimeridian({ lon: t.lon, lat: t.lat, t0RelS: t.startS - t0S, stepS: header.stepS }),
    })),
  };
}

/** Every ArrayBuffer inside, for zero-copy postMessage transfer. */
export const transferablesOf = (loaded: LoadedTracks): ArrayBuffer[] =>
  loaded.tracks.flatMap((t) =>
    [t.lon, t.lat, t.altKm, t.positions, t.times, t.startIndices].map((a) => a.buffer as ArrayBuffer),
  );
