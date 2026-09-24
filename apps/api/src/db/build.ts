/* eslint-disable security/detect-non-literal-fs-filename -- paths come from the seed CLI / operator
   config (DATA_DIR, source file), never from request input. */
/**
 * Builds the DuckDB database and the precompressed track artifacts from the source GeoJSON.
 * Used by `pnpm seed` (and at Docker build time) and by the integration tests with a fixture file,
 * so the exact production seed path is covered by tests.
 *
 * Parsing happens inside DuckDB (C++ `read_json`, gzip handled natively): the 59 MB GeoJSON never
 * goes through V8's JSON.parse.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';

import { dataFiles } from '../config.js';
import {
  PENDING_SUFFIX,
  artifactFiles,
  encodeArtifacts,
  writeArtifacts,
  type Manifest,
} from '../services/trackArtifacts.js';

import { readGeometry } from './database.js';

/** The whole FeatureCollection is one JSON object (59 MB for the week); allow up to 1 GB. */
const MAX_SOURCE_OBJECT_BYTES = 1_000_000_000;

/** Segment bounding boxes wider than this cross the antimeridian (true span is only ~0.5–5°). */
const ANTIMERIDIAN_SPAN_DEG = 180;

/**
 * The expected input, declared instead of inferred: it documents the contract, skips DuckDB's
 * schema-sampling pass, and makes empty or unexpected files fail with our own clear errors.
 */
const SOURCE_COLUMNS = `{
  features: 'STRUCT(
    geometry STRUCT(coordinates DOUBLE[][]),
    properties STRUCT(satellite VARCHAR, ts_start TIMESTAMP, ts_end TIMESTAMP, local_time_h DOUBLE)
  )[]'
}`;

/** Unit-vector component of vertex `c` (lon = c[1], lat = c[2]). */
const VX = (c: string) => `cos(radians(${c}[2])) * cos(radians(${c}[1]))`;
const VY = (c: string) => `cos(radians(${c}[2])) * sin(radians(${c}[1]))`;
const VZ = (c: string) => `sin(radians(${c}[2]))`;
const CENTRE = 'coords[(len(coords) + 1) // 2]';

/**
 * One row per 1-minute segment, with everything the candidate search needs as plain numeric
 * columns (DuckDB filters those vectorised over all 100k rows in ~3 ms):
 *  - bounding box (min/max lon/lat). A segment crossing ±180° would get a box spanning the globe
 *    the wrong way round (e.g. [-179.9, 179.9]) and be missed near the antimeridian, so crossing
 *    segments get a full-width box instead (a superset: exact geometry follows);
 *  - centre vertex as a unit vector (cx, cy, cz) and `reach_rad`, the largest angle from the centre
 *    to any vertex. Along a short great-circle arc the distance to a fixed point peaks at an
 *    endpoint, so the segment lies inside the cap (centre, reach) — an exact spherical pre-test.
 *
 * seg_id numbers segments satellite-major (satellite, then time) — the order the pass engine needs —
 * and indexes the in-memory geometry loaded at boot. Rows are stored time-major so DuckDB's zone
 * maps prune time windows as the data grows.
 */
const CREATE_SEGMENTS_SQL = `
CREATE TABLE segments AS
WITH raw AS (
  SELECT unnest(features) AS f
  FROM read_json($1, columns = ${SOURCE_COLUMNS}, maximum_object_size = ${MAX_SOURCE_OBJECT_BYTES})
),
flat AS (
  SELECT f.properties.satellite AS satellite,
         epoch_ms(f.properties.ts_start::TIMESTAMP) AS start_ms,
         epoch_ms(f.properties.ts_end::TIMESTAMP) AS end_ms,
         f.properties.local_time_h AS local_time_h,
         f.geometry.coordinates AS coords
  FROM raw
),
bounds AS (
  SELECT *,
         list_min(list_transform(coords, c -> c[1])) AS lon_lo,
         list_max(list_transform(coords, c -> c[1])) AS lon_hi,
         list_min(list_transform(coords, c -> c[2])) AS min_lat,
         list_max(list_transform(coords, c -> c[2])) AS max_lat,
         list_min(list_transform(coords, c -> c[3])) AS min_alt_km,
         list_max(list_transform(coords, c -> c[3])) AS max_alt_km,
         (lon_hi - lon_lo) > ${ANTIMERIDIAN_SPAN_DEG} AS crosses_antimeridian,
         ${VX(CENTRE)} AS cx,
         ${VY(CENTRE)} AS cy,
         ${VZ(CENTRE)} AS cz
  FROM flat
)
SELECT (row_number() OVER (ORDER BY satellite, start_ms) - 1)::INTEGER AS seg_id,
       satellite, start_ms, end_ms, local_time_h, coords,
       CASE WHEN crosses_antimeridian THEN -180 ELSE lon_lo END AS min_lon,
       CASE WHEN crosses_antimeridian THEN 180 ELSE lon_hi END AS max_lon,
       min_lat, max_lat, min_alt_km, max_alt_km, crosses_antimeridian,
       cx, cy, cz,
       list_max(list_transform(coords, c ->
         acos(least(1.0, cx * ${VX('c')} + cy * ${VY('c')} + cz * ${VZ('c')})))) AS reach_rad
FROM bounds
ORDER BY start_ms, satellite`;

export interface BuildOptions {
  sourcePath: string;
  dataDir: string;
  log?: (message: string) => void;
}

export interface BuildResult {
  manifest: Manifest;
  segmentCount: number;
  antimeridianSegments: number;
}

interface Stats {
  n: bigint;
  crossing: bigint;
  step_variants: bigint;
  step_ms: bigint | null;
  degenerate: bigint;
}

/** "Altair-2P5S-tracks-1w.json.gz" → "Altair-2P5S". */
export function datasetNameFromFile(file: string): string {
  const base = path.basename(file).replace(/\.json(\.gz)?$/i, '');
  const cut = base.search(/-tracks/i);
  return cut > 0 ? base.slice(0, cut) : base;
}

/** Fails loudly on data the pass engine and codec cannot represent faithfully. */
function validateStats(stats: Stats | undefined): number {
  if (!stats || stats.n === 0n) throw new Error('The source contains no segments');
  if (stats.degenerate > 0n) throw new Error(`${stats.degenerate} segments have fewer than 2 vertices`);
  if (stats.step_variants !== 1n || stats.step_ms === null) {
    throw new Error('Vertices are not evenly spaced in time; the track codec requires a fixed step');
  }
  return Number(stats.step_ms) / 1000;
}

export async function buildDatabase({
  sourcePath,
  dataDir,
  log = () => undefined,
}: BuildOptions): Promise<BuildResult> {
  const files = dataFiles(dataDir);
  const tmpDb = `${files.database}${PENDING_SUFFIX}`;
  await mkdir(dataDir, { recursive: true });
  await rm(tmpDb, { force: true });

  const instance = await DuckDBInstance.create(tmpDb);
  const c = await instance.connect();
  try {
    log(`Loading ${path.basename(sourcePath)}`);
    await c.run(CREATE_SEGMENTS_SQL, [sourcePath]);

    const [stats] = (
      await c.runAndReadAll(`
        SELECT count(*) AS n,
               count(*) FILTER (crosses_antimeridian) AS crossing,
               count(DISTINCT (end_ms - start_ms) // (len(coords) - 1)) AS step_variants,
               any_value((end_ms - start_ms) // (len(coords) - 1)) AS step_ms,
               count(*) FILTER (len(coords) < 2) AS degenerate
        FROM segments`)
    ).getRowObjectsJS() as unknown as Stats[];
    const stepS = validateStats(stats);

    log('Encoding and compressing the track stream (brotli q11, gzip 9)');
    const datasetName = datasetNameFromFile(sourcePath);
    const encoded = await encodeArtifacts(await readGeometry(c), stepS);
    // The database remembers which artifacts it belongs to; the server refuses a mismatch at boot.
    await c.run('CREATE TABLE meta AS SELECT $1::VARCHAR AS tracks_etag, $2::VARCHAR AS dataset_name', [
      encoded.etag,
      datasetName,
    ]);
    const manifest = await writeArtifacts(dataDir, encoded, {
      datasetName,
      stepS,
      segmentCount: Number(stats?.n),
    });

    await c.run('CHECKPOINT');
    return { manifest, segmentCount: Number(stats?.n), antimeridianSegments: Number(stats?.crossing) };
  } finally {
    c.closeSync();
    instance.closeSync();
    await rm(`${tmpDb}.wal`, { force: true });
  }
}

/**
 * Moves the freshly built database and artifacts into place. Each rename atomically replaces its
 * target (POSIX and Windows), so readers never see a missing file; and should the process stop
 * between two renames, the ETag recorded in the database makes the server refuse the mixed set.
 */
export async function publishDatabase(dataDir: string): Promise<void> {
  const files = dataFiles(dataDir);
  await rename(`${files.database}${PENDING_SUFFIX}`, files.database);
  const live = artifactFiles(dataDir);
  await Promise.all(artifactFiles(dataDir, true).map((pending, i) => rename(pending, String(live[i]))));
}
