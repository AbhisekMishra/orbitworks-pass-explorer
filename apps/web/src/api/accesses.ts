/** The passes query: request shape, its URL and the query definition (cache key = request). */
import { AccessesResponseSchema } from '@ow/shared';
import { keepPreviousData, queryOptions, skipToken } from '@tanstack/react-query';

import { toIsoSeconds } from '../lib/time';

import { getJson } from './client';

export interface AccessRequest {
  lat: number;
  lon: number;
  radiusKm: number;
  /** Epoch seconds, end exclusive. */
  startS: number;
  endS: number;
  /** Satellites to include; null means all of them (no filter sent). */
  satellites: readonly string[] | null;
  daylightOnly: boolean;
}

/** Coordinates are sent at ~1 m precision: enough, and it keeps cache keys and URLs stable. */
const COORD_DECIMALS = 5;

export function accessesPath(r: AccessRequest): string {
  const p = new URLSearchParams({
    lat: r.lat.toFixed(COORD_DECIMALS),
    lon: r.lon.toFixed(COORD_DECIMALS),
    radiusKm: String(r.radiusKm),
    start: toIsoSeconds(r.startS),
    end: toIsoSeconds(r.endS),
  });
  if (r.satellites) p.set('satellites', r.satellites.join(','));
  if (r.daylightOnly) p.set('daylightOnly', 'true');
  return `/accesses?${p.toString()}`;
}

/** The query for a request; null (no pin, no satellite) is a disabled query with no data. */
export const accessesQuery = (r: AccessRequest | null) =>
  queryOptions({
    queryKey: ['accesses', r],
    queryFn: r ? ({ signal }) => getJson(accessesPath(r), AccessesResponseSchema, signal) : skipToken,
    // Immutable per deployment: a pass list never goes stale.
    staleTime: Infinity,
    // Keep showing the previous result while a new radius or date range loads (no flicker), but
    // never for a disabled query: with no pin or no satellite there is nothing to show.
    placeholderData: r ? keepPreviousData : undefined,
  });
