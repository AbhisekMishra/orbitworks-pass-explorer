/**
 * Splits a satellite's render geometry into fixed time chunks, so only the chunks overlapping the
 * time window are drawn.
 *
 * Why: the GPU filter (TrackLayer) discards fragments outside the window, but the vertex shader
 * still runs for every segment of the week (605k) on every frame. Drawing only overlapping chunks
 * makes GPU work proportional to the window: a 6 h window touches ≤ 2 chunks per satellite
 * instead of the whole week (~7× less). Toggling a chunk is a `visible` prop: no re-upload.
 *
 * Chunks are views into the track's buffers (no copy). Adjacent chunks share one boundary vertex:
 * the segment crossing a boundary belongs to the later chunk only, so there is no gap and no
 * segment is drawn twice (which would double its alpha).
 */
import { POSITION_SIZE, type SplitTrack } from '../tracks/trackBuffers';

/** 12 h: ≤ 2 chunks per satellite for the default 6 h window, ~15 layers per satellite overall. */
export const CHUNK_S = 12 * 3600;

export interface TrackChunk extends SplitTrack {
  index: number;
  /** Time span actually covered by the chunk's vertices, in seconds since the dataset epoch. */
  startRelS: number;
  endRelS: number;
}

/** First index whose value is ≥ t (binary search over sorted times). */
function lowerBound(times: Float32Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(times[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Path starts inside the vertex range [v0, v1], rebased to v0 (the path containing v0 first). */
function localStarts(startIndices: Uint32Array, v0: number, v1: number): Uint32Array {
  const starts = [0];
  for (const s of startIndices) if (s > v0 && s <= v1) starts.push(s - v0);
  return Uint32Array.from(starts);
}

export function chunkTrack(track: SplitTrack, chunkS = CHUNK_S): TrackChunk[] {
  const { positions, times, startIndices } = track;
  const n = times.length;
  if (n < 2) return [];
  const chunks: TrackChunk[] = [];
  const count = Math.floor(Number(times[n - 1]) / chunkS) + 1;
  for (let index = Math.floor(Number(times[0]) / chunkS); index < count; index++) {
    // From the last vertex before the chunk start (so the crossing segment is drawn here) to
    // the last vertex before the next chunk start.
    const v0 = Math.max(0, lowerBound(times, index * chunkS) - 1);
    const v1 = Math.min(n, lowerBound(times, (index + 1) * chunkS)) - 1;
    if (v1 <= v0) continue;
    chunks.push({
      index,
      startRelS: Number(times[v0]),
      endRelS: Number(times[v1]),
      positions: positions.subarray(v0 * POSITION_SIZE, (v1 + 1) * POSITION_SIZE),
      times: times.subarray(v0, v1 + 1),
      startIndices: localStarts(startIndices, v0, v1),
    });
  }
  return chunks;
}

/** Whether any part of the chunk falls inside the window (relative seconds). */
export const chunkOverlaps = (chunk: TrackChunk, startRelS: number, endRelS: number): boolean =>
  chunk.endRelS >= startRelS && chunk.startRelS <= endRelS;
