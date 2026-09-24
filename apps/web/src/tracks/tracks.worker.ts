/**
 * Downloads and decodes the whole week of tracks off the main thread: the UI stays responsive
 * while ~600k vertices are decoded and turned into GPU buffers, which are then transferred (not
 * copied) back. Deliberately zod-free: this bundle is the codec plus a few functions.
 *
 * The worker takes no input. It starts on creation and requests a URL built from build-time
 * configuration only, so there is no message handler to abuse (no origin to verify, no URL a
 * message could redirect). The logic lives in fetchTracks.ts (unit-tested).
 */
import { TRACKS_BINARY_ROUTE, apiUrl } from '../api/url';

import { fetchTracks } from './fetchTracks';

void fetchTracks(apiUrl(TRACKS_BINARY_ROUTE)).then(({ response, transfer }) => {
  self.postMessage(response, { transfer });
});
