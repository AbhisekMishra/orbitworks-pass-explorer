/**
 * The passes for the current pin and filters. Satellites follow the side panel's selection, so
 * one set of filters drives both the map and the pass list. The API is asked for every satellite
 * and the selection is applied here (stats recomputed with the shared function): toggling a
 * satellite never costs a request (CLAUDE.md budget). Requests are debounced while controls move
 * (radius slider, pin drag) and cached per request.
 */
import { computePassStats, type AccessesResponse, type Pass } from '@ow/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { accessesQuery, type AccessRequest } from '../../api/accesses';
import { useDebounced } from '../../lib/useDebounced';
import { useAppStore } from '../../state/store';

/** Long enough to skip the intermediate values of a dragged slider, short enough to feel live. */
export const REQUEST_DEBOUNCE_MS = 250;

const sameRequest = (a: AccessRequest | null, b: AccessRequest | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The (debounced) request for the current state, and whether one is wanted at all. `request` is
 * null when there is nothing to ask (no pin, no satellite) and while a new one settles.
 */
export function useAccessRequest(): { request: AccessRequest | null; wanted: boolean } {
  const access = useAppStore((s) => s.access);
  const hidden = useAppStore((s) => s.hidden);
  const satellites = useAppStore((s) => s.satellites);
  const request = useMemo((): AccessRequest | null => {
    const visible = satellites.filter((id) => !hidden.has(id));
    if (!access.pin || visible.length === 0 || access.endS <= access.startS) return null;
    return {
      lat: access.pin.lat,
      lon: access.pin.lon,
      radiusKm: access.radiusKm,
      startS: access.startS,
      endS: access.endS,
      // Every satellite: the selection is applied client-side (see the module comment).
      satellites: null,
      daylightOnly: access.daylightOnly,
    };
  }, [access, hidden, satellites]);
  const settled = useDebounced(request, REQUEST_DEBOUNCE_MS, sameRequest);
  // Clearing the pin (or every satellite) takes effect at once; only new requests wait.
  return { request: request === null ? null : settled, wanted: request !== null };
}

export interface Accesses {
  request: AccessRequest | null;
  /** A request is wanted (pin and satellites set), even if it is still settling. */
  wanted: boolean;
  query: ReturnType<typeof useAccessesQuery>;
  /** The response restricted to the selected satellites (stats recomputed); none without a request. */
  result: AccessesResponse | undefined;
  /** The passes to show everywhere (`result.passes`). */
  passes: readonly Pass[] | undefined;
}

const useAccessesQuery = (request: AccessRequest | null) => useQuery(accessesQuery(request));

/** Call once (App) and hand the result down: one debounce, one owner of the feature's data. */
export function useAccesses(): Accesses {
  const { request, wanted } = useAccessRequest();
  const query = useAccessesQuery(request);
  const hidden = useAppStore((s) => s.hidden);
  const satellites = useAppStore((s) => s.satellites);
  const data = request ? query.data : undefined;
  const result = useMemo((): AccessesResponse | undefined => {
    if (!data || hidden.size === 0) return data;
    const passes = data.passes.filter((p) => !hidden.has(p.satellite));
    const visible = satellites.filter((id) => !hidden.has(id));
    return { ...data, passes, stats: computePassStats(passes, visible) };
  }, [data, hidden, satellites]);
  return { request, wanted, query, result, passes: result?.passes };
}
