/**
 * Track output built from the in-memory geometry (typed arrays loaded once at boot). Serving from
 * memory keeps every tracks request free of DuckDB row conversion — the expensive part for large
 * results — and gives the seed and the API one single encoding path.
 */
import { encodeTracks, type TrackInput, type TracksGeoJson } from '@ow/shared';

import type { SegmentFilter } from '../db/types.js';
import type { TrackGeometry } from '../domain/geometry.js';
import { isoSeconds as iso } from '../lib/time.js';

/** Ids of the segments matching the window, in seg_id (satellite, then time) order. */
export function selectSegments(g: TrackGeometry, w: SegmentFilter): number[] {
  const wanted = w.satellites ? new Set(w.satellites) : null;
  const ids: number[] = [];
  for (let s = 0; s < g.segmentCount; s++) {
    if (wanted && !wanted.has(g.satellites[Number(g.satelliteIndex[s])] ?? '')) continue;
    if (w.startMs !== undefined && Number(g.endMs[s]) <= w.startMs) continue;
    if (w.endMs !== undefined && Number(g.startMs[s]) >= w.endMs) continue;
    ids.push(s);
  }
  return ids;
}

interface MutableTrack extends TrackInput {
  lon: number[];
  lat: number[];
  altKm: number[];
}

/**
 * Codec tracks: one per run of contiguous segments of a satellite (a data gap starts a new track
 * rather than drawing a false straight line), dropping the first vertex of each continuing segment
 * because it duplicates the previous segment's last one.
 */
export function trackInputs(g: TrackGeometry, ids: readonly number[]): TrackInput[] {
  const tracks: MutableTrack[] = [];
  let current: MutableTrack | undefined;
  let previous = -1;
  for (const s of ids) {
    const continues =
      previous >= 0 &&
      g.satelliteIndex[previous] === g.satelliteIndex[s] &&
      g.endMs[previous] === g.startMs[s];
    if (!continues || !current) {
      current = {
        satellite: g.satellites[Number(g.satelliteIndex[s])] ?? '',
        startS: Number(g.startMs[s]) / 1000,
        lon: [],
        lat: [],
        altKm: [],
      };
      tracks.push(current);
    }
    for (let v = Number(g.vertexStart[s]) + (continues ? 1 : 0); v < Number(g.vertexStart[s + 1]); v++) {
      current.lon.push(Number(g.lon[v]));
      current.lat.push(Number(g.lat[v]));
      current.altKm.push(Number(g.altKm[v]));
    }
    previous = s;
  }
  return tracks;
}

export function encodeSegments(g: TrackGeometry, ids: readonly number[], stepS: number): Uint8Array {
  return encodeTracks(trackInputs(g, ids), { stepS });
}

/** GeoJSON mirroring the source: one LineString Feature per 1-minute segment ([lon, lat, altKm]). */
export function segmentsToGeoJson(g: TrackGeometry, ids: readonly number[]): TracksGeoJson {
  return {
    type: 'FeatureCollection',
    features: ids.map((s) => {
      const coordinates: [number, number, number][] = [];
      for (let v = Number(g.vertexStart[s]); v < Number(g.vertexStart[s + 1]); v++) {
        coordinates.push([Number(g.lon[v]), Number(g.lat[v]), Number(g.altKm[v])]);
      }
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          satellite: g.satellites[Number(g.satelliteIndex[s])] ?? '',
          start: iso(Number(g.startMs[s])),
          end: iso(Number(g.endMs[s])),
        },
      };
    }),
  };
}
