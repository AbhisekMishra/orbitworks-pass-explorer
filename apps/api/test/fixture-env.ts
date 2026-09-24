import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { dataFiles, loadConfig, type Config } from '../src/config.js';
import { buildDatabase, publishDatabase } from '../src/db/build.js';
import { openDatabase, type Database } from '../src/db/database.js';
import type { Segment } from './geometry.js';
import type { TrackGeometry } from '../src/domain/geometry.js';
import { loadDatasetInfo, type DatasetInfo } from '../src/services/dataset.js';
import { loadArtifacts, type LoadedArtifacts } from '../src/services/trackArtifacts.js';
import type { SegmentFilter } from '../src/db/types.js';
import { selectSegments } from '../src/services/tracks.js';

import { FIXTURE_PATH } from './paths.js';

export interface FixtureEnv {
  dataDir: string;
  db: Database;
  geometry: TrackGeometry;
  info: DatasetInfo;
  artifacts: LoadedArtifacts;
  /** Builds an app over the shared fixture database with optional config overrides. */
  app(env?: Record<string, string>): Promise<FastifyInstance>;
  close(): Promise<void>;
}

/** Segments read back from the in-memory geometry, with their seg_id (for building expectations). */
export function segmentsOf(g: TrackGeometry, window: SegmentFilter = {}): (Segment & { id: number })[] {
  return selectSegments(g, window).map((id) => {
    const coords: [number, number, number][] = [];
    for (let v = Number(g.vertexStart[id]); v < Number(g.vertexStart[id + 1]); v++) {
      coords.push([Number(g.lon[v]), Number(g.lat[v]), Number(g.altKm[v])]);
    }
    return {
      id,
      satellite: g.satellites[Number(g.satelliteIndex[id])] ?? '',
      startMs: Number(g.startMs[id]),
      endMs: Number(g.endMs[id]),
      coords,
    };
  });
}

export const testConfig = (env: Record<string, string> = {}): Config =>
  loadConfig({ NODE_ENV: 'test', ...env });

/** Seeds the fixture with the production build path into a temp dir and opens it read-only. */
export async function createFixtureEnv(): Promise<FixtureEnv> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ow-api-'));
  await buildDatabase({ sourcePath: FIXTURE_PATH, dataDir });
  await publishDatabase(dataDir);
  const db = await openDatabase({
    path: dataFiles(dataDir).database,
    poolSize: 2,
  });
  const artifacts = await loadArtifacts(dataDir);
  const info = await loadDatasetInfo(db, artifacts.manifest);
  const geometry = await db.loadGeometry();
  const apps: FastifyInstance[] = [];

  return {
    dataDir,
    db,
    geometry,
    info,
    artifacts,
    async app(env = {}) {
      const app = await buildApp({ config: testConfig(env), db, geometry, info, artifacts });
      apps.push(app);
      return app;
    },
    async close() {
      await Promise.all(apps.map((a) => a.close()));
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
