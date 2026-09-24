/** Messages between the main thread and the track decode worker. */
import type { LoadedTracks } from './trackBuffers';

export interface WorkerRequest {
  url: string;
}

export interface LoadStats {
  /** Decoded OWT1 stream size. */
  rawBytes: number;
  /** Bytes on the wire (compressed), when the browser exposes it. */
  transferBytes: number | null;
  fetchMs: number;
  decodeMs: number;
}

export type WorkerResponse =
  | { type: 'done'; tracks: LoadedTracks; stats: LoadStats }
  | { type: 'error'; status: number; message: string };
