import type { Dataset } from '@ow/shared';

import type { Database } from '../db/database.js';
import type { SatelliteRow } from '../db/types.js';
import { HttpError } from '../http/errors.js';
import { isoSeconds as iso } from '../lib/time.js';

import type { Manifest } from './trackArtifacts.js';

/** Dataset facts resolved once at boot (the data is immutable while the process runs). */
export interface DatasetInfo {
  name: string;
  startMs: number;
  endMs: number;
  stepS: number;
  satellites: SatelliteRow[];
  satelliteIds: ReadonlySet<string>;
}

export async function loadDatasetInfo(db: Database, manifest: Manifest): Promise<DatasetInfo> {
  // The seed publishes the database and the artifacts together; refuse a mixed set (e.g. a seed
  // interrupted between renames) rather than serve tracks and passes from different data.
  if ((await db.tracksEtag()) !== manifest.etag) {
    throw new Error('The database and the track artifacts come from different seeds; re-run `pnpm seed`.');
  }
  const satellites = await db.satellites();
  if (satellites.length === 0) throw new Error('The database contains no satellites; re-run `pnpm seed`.');
  return {
    name: manifest.datasetName,
    startMs: Math.min(...satellites.map((s) => s.startMs)),
    endMs: Math.max(...satellites.map((s) => s.endMs)),
    stepS: manifest.stepS,
    satellites,
    satelliteIds: new Set(satellites.map((s) => s.id)),
  };
}

export function toDatasetResponse(info: DatasetInfo): Dataset {
  return {
    name: info.name,
    start: iso(info.startMs),
    end: iso(info.endMs),
    stepS: info.stepS,
    satellites: info.satellites.map((s) => ({
      id: s.id,
      start: iso(s.startMs),
      end: iso(s.endMs),
      segmentCount: s.segmentCount,
      minAltitudeKm: Math.round(s.minAltitudeKm * 10) / 10,
      maxAltitudeKm: Math.round(s.maxAltitudeKm * 10) / 10,
    })),
  };
}

/** Resolves an optional satellite filter against the dataset; unknown ids are a client error. */
export function resolveSatellites(info: DatasetInfo, requested: readonly string[] | undefined): string[] {
  if (!requested) return info.satellites.map((s) => s.id);
  const unknown = requested.filter((id) => !info.satelliteIds.has(id));
  if (unknown.length > 0) throw new HttpError(400, `Unknown satellite id(s): ${unknown.join(', ')}`);
  return [...requested];
}
