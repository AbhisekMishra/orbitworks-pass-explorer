/**
 * Read-only access to the seeded DuckDB file.
 *
 * Hardening (defence in depth on top of bound parameters): the file is opened READ_ONLY, extension
 * auto-install/auto-load is off, then external access is disabled and the configuration locked.
 * After that, even an injected statement could not read or write files, ATTACH databases, INSTALL
 * extensions or change settings.
 *
 * Candidate search uses plain numeric columns (bounding box, time, centre vector) rather than the
 * spatial extension's R-tree: measured on the real data, the vectorised scan takes ~3 ms for any
 * radius or latitude, while the R-tree ranges from 1 ms (small circles) to 28 ms once DuckDB's
 * optimiser falls back to scanning geometries for large boxes (see docs/DECISIONS.md).
 *
 * `@duckdb/node-api` runs queries on libuv worker threads, so queries never block the event loop;
 * a small pool of connections lets independent requests run in parallel.
 */
import { DuckDBInstance, listValue, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';

import { EARTH_RADIUS_KM, toVec, type BBox } from '@ow/shared';

import { buildGeometry, type TrackGeometry } from '../domain/geometry.js';

import type { SatelliteRow, SegmentFilter } from './types.js';

export class ConnectionPool {
  private readonly idle: DuckDBConnection[];
  private readonly waiters: ((c: DuckDBConnection) => void)[] = [];

  constructor(connections: DuckDBConnection[]) {
    this.idle = [...connections];
  }

  async use<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
    const connection =
      this.idle.pop() ?? (await new Promise<DuckDBConnection>((resolve) => this.waiters.push(resolve)));
    try {
      return await fn(connection);
    } finally {
      const next = this.waiters.shift();
      if (next) next(connection);
      else this.idle.push(connection);
    }
  }
}

/** A circle on the sphere: segments that cannot reach it are filtered out in SQL. */
export interface Cap {
  lon: number;
  lat: number;
  radiusKm: number;
}

const CAP_SLACK_RAD = 1e-6;

export interface Database {
  satellites(): Promise<SatelliteRow[]>;
  /**
   * Ids (seg_id) of segments whose bounding box intersects `box`, whose time span overlaps the
   * filter window and — when `cap` is given — that can reach the spherical cap. Ids index the
   * geometry from `loadGeometry`; returned in ascending order (satellite, then time).
   */
  candidateIds(box: BBox, filter: SegmentFilter, cap?: Cap): Promise<number[]>;
  /** Every vertex as typed arrays, indexed by seg_id (loaded once at boot: ~0.4 s for the week). */
  loadGeometry(): Promise<TrackGeometry>;
  /** ETag of the track artifacts this database was built with (consistency check at boot). */
  tracksEtag(): Promise<string>;
  ping(): Promise<void>;
  close(): void;
}

// All SQL is static text; request values only ever travel as bound parameters.

function filterClause(filter: SegmentFilter, firstParam: number): { sql: string; params: DuckDBValue[] } {
  const parts: string[] = [];
  const params: DuckDBValue[] = [];
  /** Binds `value` and returns its placeholder ($n): numbering follows the params array itself. */
  const bind = (value: DuckDBValue): string => `$${firstParam + params.push(value) - 1}`;
  if (filter.startMs !== undefined) parts.push(`end_ms > ${bind(BigInt(Math.floor(filter.startMs)))}`);
  if (filter.endMs !== undefined) parts.push(`start_ms < ${bind(BigInt(Math.ceil(filter.endMs)))}`);
  if (filter.satellites !== undefined) {
    parts.push(`list_contains(${bind(listValue([...filter.satellites]))}, satellite)`);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}

const columnsOf = async (c: DuckDBConnection, sql: string, params: DuckDBValue[] = []) =>
  (await c.runAndReadAll(sql, params)).getColumnsJS() as unknown[][];

/**
 * All vertices, flattened into plain numeric columns (far cheaper to convert than nested lists),
 * in seg_id order. Shared by the seed (artifact encoding) and the server (pass engine).
 */
export async function readGeometry(c: DuckDBConnection): Promise<TrackGeometry> {
  const [satellite = [], startMs = [], endMs = [], vertexCount = []] = await columnsOf(
    c,
    'SELECT satellite, start_ms, end_ms, len(coords) FROM segments ORDER BY seg_id',
  );
  const [lon = [], lat = [], altKm = []] = await columnsOf(
    c,
    `SELECT v[1], v[2], v[3] FROM (
       SELECT seg_id, unnest(coords) AS v, generate_subscripts(coords, 1) AS i FROM segments
     ) ORDER BY seg_id, i`,
  );
  return buildGeometry({
    satellite: satellite.map(String),
    startMs: startMs.map(Number),
    endMs: endMs.map(Number),
    vertexCount: vertexCount.map(Number),
    lon: lon.map(Number),
    lat: lat.map(Number),
    altKm: altKm.map(Number),
  });
}

/** Opens the database file read-only and locks the session down (see the module comment). */
export async function openHardenedInstance(
  path: string,
): Promise<{ instance: DuckDBInstance; connection: DuckDBConnection }> {
  const instance = await DuckDBInstance.create(path, {
    access_mode: 'READ_ONLY',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const connection = await instance.connect();
  await connection.run('SET enable_external_access = false');
  await connection.run('SET lock_configuration = true');
  return { instance, connection };
}

export async function openDatabase(opts: { path: string; poolSize: number }): Promise<Database> {
  const { instance, connection } = await openHardenedInstance(opts.path);
  const connections = [connection];
  for (let i = 1; i < opts.poolSize; i++) connections.push(await instance.connect());
  const pool = new ConnectionPool(connections);
  const columns = (sql: string, params: DuckDBValue[] = []) => pool.use((c) => columnsOf(c, sql, params));

  return {
    async satellites() {
      const [id = [], start = [], end = [], n = [], minAlt = [], maxAlt = []] = await columns(
        `SELECT satellite, min(start_ms), max(end_ms), count(*), min(min_alt_km), max(max_alt_km)
         FROM segments GROUP BY satellite ORDER BY satellite`,
      );
      return id.map((sat, i) => ({
        id: String(sat),
        startMs: Number(start[i]),
        endMs: Number(end[i]),
        segmentCount: Number(n[i]),
        minAltitudeKm: Number(minAlt[i]),
        maxAltitudeKm: Number(maxAlt[i]),
      }));
    },

    async candidateIds(box, filter, cap) {
      // Box overlap, then an exact spherical test: near the poles a box spans every longitude and
      // ~60 % of its hits cannot reach the circle. acos loses ~1e-8 rad near 0, hence the slack
      // (a superset is fine: exact geometry follows).
      const capSql = cap ? ' AND acos(least(1.0, cx * $5 + cy * $6 + cz * $7)) <= $8 + reach_rad' : '';
      const capParams = cap
        ? [...toVec(cap.lon, cap.lat), cap.radiusKm / EARTH_RADIUS_KM + CAP_SLACK_RAD]
        : [];
      const where = filterClause(filter, 5 + capParams.length);
      const [ids = []] = await columns(
        `SELECT seg_id FROM segments
         WHERE max_lon >= $1 AND min_lat <= $4 AND min_lon <= $3 AND max_lat >= $2${capSql}${where.sql}
         ORDER BY seg_id`,
        [...box, ...capParams, ...where.params],
      );
      return ids.map(Number);
    },

    loadGeometry() {
      return pool.use(readGeometry);
    },

    async tracksEtag() {
      const [etag = []] = await columns('SELECT tracks_etag FROM meta');
      return String(etag[0]);
    },

    async ping() {
      await columns('SELECT 1');
    },

    close() {
      for (const c of connections) c.closeSync();
      instance.closeSync();
    },
  };
}
