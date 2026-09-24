/**
 * What the decode worker does, as a plain async function (the worker file only wires messages to
 * it), so every outcome is unit-tested: success, network failure, HTTP error, a body that fails
 * mid-download and corrupt data. It never throws: every failure becomes an error message, so the
 * UI always leaves its loading state.
 */
import { TRACK_CODEC_MEDIA_TYPE, decodeTracks } from '@ow/shared';

import type { LoadStats, WorkerResponse } from './protocol';
import { buildTrackBuffers, transferablesOf } from './trackBuffers';

export interface FetchTracksResult {
  response: WorkerResponse;
  /** Buffers to transfer (not copy) with the response. */
  transfer: Transferable[];
}

const UNREACHABLE = 'The server could not be reached. Check your connection.';

/** Compressed size from Resource Timing (same-origin, or cross-origin with Timing-Allow-Origin). */
function transferSize(url: string): number | null {
  const entry = performance.getEntriesByName(url).at(-1);
  return entry instanceof PerformanceResourceTiming && entry.encodedBodySize > 0
    ? entry.encodedBodySize
    : null;
}

const failure = (status: number, message: string): FetchTracksResult => ({
  response: { type: 'error', status, message },
  transfer: [],
});

export async function fetchTracks(url: string, fetchFn: typeof fetch = fetch): Promise<FetchTracksResult> {
  const t0 = performance.now();
  let bytes: ArrayBuffer;
  try {
    const res = await fetchFn(url, { headers: { accept: TRACK_CODEC_MEDIA_TYPE } });
    if (!res.ok) return failure(res.status, `Could not load the satellite tracks (HTTP ${res.status}).`);
    bytes = await res.arrayBuffer(); // can fail mid-download (dropped connection, proxy reset)
  } catch {
    return failure(0, UNREACHABLE);
  }
  const t1 = performance.now();
  try {
    const tracks = buildTrackBuffers(decodeTracks(bytes));
    const stats: LoadStats = {
      rawBytes: bytes.byteLength,
      transferBytes: transferSize(url),
      fetchMs: t1 - t0,
      decodeMs: performance.now() - t1,
    };
    return { response: { type: 'done', tracks, stats }, transfer: transferablesOf(tracks) };
  } catch (err) {
    return failure(0, `The track data is corrupt: ${err instanceof Error ? err.message : String(err)}`);
  }
}
