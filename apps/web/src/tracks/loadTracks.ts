/** Main-thread side of the decode worker: one worker per load, terminated when done. */
import { ApiRequestError } from '../api/client';

import type { LoadStats, WorkerRequest, WorkerResponse } from './protocol';
import type { LoadedTracks } from './trackBuffers';

export interface TracksResult {
  tracks: LoadedTracks;
  stats: LoadStats;
}

export function loadTracks(url: string, signal?: AbortSignal): Promise<TracksResult> {
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
    worker.postMessage({ url } satisfies WorkerRequest);
  });
}
