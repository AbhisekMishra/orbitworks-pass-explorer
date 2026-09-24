import { capBoundingBoxes, normalizeLon, type AccessesQuery, type AccessesResponse } from '@ow/shared';

import type { Database } from '../db/database.js';
import type { TrackGeometry } from '../domain/geometry.js';
import { computePasses, computeStats } from '../domain/passes.js';
import { isoSeconds as iso } from '../lib/time.js';

import { resolveSatellites, type DatasetInfo } from './dataset.js';

/**
 * Extra radius for the bounding-box pre-filter. Segment boxes are built from vertices, but the
 * great-circle arc between two vertices ~76 km apart bulges poleward by up to ~0.8 km at the
 * orbit's highest latitudes; 5 km covers that with a wide margin (exact distances follow).
 */
export const PREFILTER_MARGIN_KM = 5;

/** Candidate segment ids, unique and sorted: seg_id order is satellite-then-time. */
async function candidateIds(
  db: Database,
  q: AccessesQuery,
  window: { startMs: number; endMs: number },
  satellites: readonly string[],
): Promise<number[]> {
  // One vectorised scan per box (two boxes when the circle straddles the antimeridian), run in
  // parallel on the connection pool.
  const cap = { lon: q.lon, lat: q.lat, radiusKm: q.radiusKm + PREFILTER_MARGIN_KM };
  const boxes = capBoundingBoxes(cap.lon, cap.lat, cap.radiusKm);
  const results = await Promise.all(boxes.map((box) => db.candidateIds(box, { ...window, satellites }, cap)));
  // Each list is already sorted; only the antimeridian case needs a merge (boxes can overlap at ±180).
  if (results.length === 1) return results[0] ?? [];
  return [...new Set(results.flat())].sort((a, b) => a - b);
}

export async function findAccesses(
  db: Database,
  geometry: TrackGeometry,
  info: DatasetInfo,
  q: AccessesQuery,
): Promise<AccessesResponse> {
  const satellites = resolveSatellites(info, q.satellites);
  // Missing bounds default to the dataset extent; requested windows are clamped to it.
  const startMs = Math.max(q.start ?? info.startMs, info.startMs);
  const endMs = Math.max(startMs, Math.min(q.end ?? info.endMs, info.endMs));
  const window = { startMs, endMs };

  const ids = endMs > startMs ? await candidateIds(db, q, window, satellites) : [];
  const passes = computePasses(geometry, ids, {
    lon: q.lon,
    lat: q.lat,
    radiusKm: q.radiusKm,
    ...window,
    daylightOnly: q.daylightOnly,
    includePath: q.includePath,
  });
  return {
    query: {
      lat: q.lat,
      lon: normalizeLon(q.lon), // [-180, 180): 180 and -180 are the same meridian
      radiusKm: q.radiusKm,
      start: iso(startMs),
      end: iso(endMs),
      satellites,
      daylightOnly: q.daylightOnly,
      includePath: q.includePath,
    },
    passes,
    stats: computeStats(passes, satellites),
  };
}
