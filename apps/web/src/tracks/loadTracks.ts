/**
 * Main-thread side of the decode worker: one worker per load, terminated when done. The worker
 * starts fetching as soon as it runs and takes no input: it builds the tracks URL itself from
 * build-time configuration, so no message can steer what it requests.
 */
import { ApiRequestError } from '../api/client';

import type { LoadStats, WorkerResponse } from './protocol';
import type { LoadedTracks } from './trackBuffers';

export interface TracksResult {
  tracks: LoadedTracks;
  stats: LoadStats;
}

export function loadTracks(signal?: AbortSignal): Promise<TracksResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./tracks.worker.ts', import.meta.url), {
      type: 'module',
      name: 'tracks-decoder',
    });
    const onAbort = (): void => {
      finish();
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    const finish = (): void => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.addEventListener('message', ({ data }: MessageEvent<WorkerResponse>) => {
      finish();
      if (data.type === 'done') resolve({ tracks: data.tracks, stats: data.stats });
      else reject(new ApiRequestError(data.message, data.status));
    });
    worker.addEventListener('error', (event) => {
      finish();
      reject(new Error(event.message || 'The track decoder failed to start.'));
    });
  });
}
