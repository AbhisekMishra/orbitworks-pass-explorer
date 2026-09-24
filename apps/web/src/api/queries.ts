/**
 * Query definitions shared by the entry point (which starts both downloads before the map code
 * is even fetched) and the components (which read the same cache entries).
 */
import { DatasetSchema } from '@ow/shared';
import { queryOptions } from '@tanstack/react-query';

import { loadTracks } from '../tracks/loadTracks';

import { apiUrl, getJson } from './client';

export const datasetQuery = queryOptions({
  queryKey: ['dataset'],
  queryFn: ({ signal }) => getJson('/dataset', DatasetSchema, signal),
  staleTime: Infinity,
});

export const tracksQuery = queryOptions({
  queryKey: ['tracks'],
  queryFn: ({ signal }) => loadTracks(apiUrl('/tracks/binary'), signal),
  // Immutable per deployment; the HTTP cache (ETag) covers reloads.
  staleTime: Infinity,
  gcTime: Infinity,
});
