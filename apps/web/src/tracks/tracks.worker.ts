/**
 * Downloads and decodes the whole week of tracks off the main thread: the UI stays responsive
 * while ~600k vertices are decoded and turned into GPU buffers, which are then transferred (not
 * copied) back. Deliberately zod-free: this bundle is the codec plus a few functions.
 * The logic lives in fetchTracks.ts (unit-tested); this file only wires messages to it.
 */
import { fetchTracks } from './fetchTracks';

// A dedicated worker only receives messages from the page that created it (event.origin is
// always empty here), so there is no origin to verify; the payload shape is still checked.
// eslint-disable-next-line sonarjs/post-message
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const { data } = event;
  if (typeof data === 'object' && data !== null && 'url' in data && typeof data.url === 'string') {
    void fetchTracks(data.url).then(({ response, transfer }) => {
      self.postMessage(response, { transfer });
    });
  }
});
