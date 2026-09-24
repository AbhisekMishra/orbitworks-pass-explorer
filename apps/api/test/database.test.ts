import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { capBoundingBoxes, slerp, toLonLat, toVec } from '@ow/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dataFiles } from '../src/config.js';
import { buildDatabase, datasetNameFromFile } from '../src/db/build.js';
import { ConnectionPool, openHardenedInstance } from '../src/db/database.js';
import { geometryFromSegments } from './geometry.js';
import { computePasses } from '../src/domain/passes.js';
import { findAccesses } from '../src/services/accesses.js';
import { loadDatasetInfo } from '../src/services/dataset.js';
import { artifactFiles, encodeArtifacts, writeArtifacts } from '../src/services/trackArtifacts.js';

import { createFixtureEnv, segmentsOf, type FixtureEnv } from './fixture-env.js';
import { T0, makeTrack } from './synthetic.js';

let env: FixtureEnv;
beforeAll(async () => {
  env = await createFixtureEnv();
});
afterAll(async () => {
  await env.close();
});

describe('seeded database (production build path over the fixture)', () => {
  it('summarises every satellite and records which artifacts it belongs to', async () => {
    const satellites = await env.db.satellites();
    expect(satellites.map((s) => s.id)).toEqual(['YAM20', 'YAM25']);
    for (const s of satellites) {
      expect(s.segmentCount).toBe(180); // 3 h of 1-minute segments
      expect(s.minAltitudeKm).toBeGreaterThan(480);
      expect(s.maxAltitudeKm).toBeLessThan(560);
    }
    expect(env.artifacts.manifest).toMatchObject({ datasetName: 'Fixture', stepS: 10, segmentCount: 360 });
    expect(await env.db.tracksEtag()).toBe(env.artifacts.etag);
  });

  it('finds candidate ids near a known vertex (bounding box + time filter)', async () => {
    const seg = segmentsOf(env.geometry, { satellites: ['YAM20'] })[30]!;
    const [lon, lat] = seg.coords[3]!;
    const [box] = capBoundingBoxes(lon, lat, 50);
    expect(await env.db.candidateIds(box!, {})).toContain(seg.id);
    expect(await env.db.candidateIds(box!, { startMs: seg.endMs + 60_000 })).not.toContain(seg.id);
    expect(await env.db.candidateIds(box!, { satellites: ['YAM25'] })).not.toContain(seg.id);
  });

  it('returns candidate ids in ascending (satellite, then time) order', async () => {
    const ids = await env.db.candidateIds([-180, -90, 180, 90], {});
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toHaveLength(360);
  });

  it('loads the whole geometry indexed by seg_id, matching the stored coordinates', () => {
    const g = env.geometry;
    expect(g.segmentCount).toBe(360);
    expect(g.satellites).toEqual(['YAM20', 'YAM25']);
    expect(g.vertexStart[360]).toBe(360 * 7);
    const seg = segmentsOf(g, { satellites: ['YAM25'] })[5]!;
    const v = g.vertexStart[seg.id]! + 2;
    const [lon, lat] = toLonLat([g.x[v]!, g.y[v]!, g.z[v]!]);
    expect(lon).toBeCloseTo(seg.coords[2]![0], 9);
    expect(lat).toBeCloseTo(seg.coords[2]![1], 9);
  });

  it('finds antimeridian-crossing segments from either side (full-width boxes)', async () => {
    const crossing = segmentsOf(env.geometry).find((s) => {
      const lons = s.coords.map((c) => c[0]);
      return Math.max(...lons) - Math.min(...lons) > 180;
    });
    expect(crossing).toBeDefined();
    const [, lat] = crossing!.coords[3]!;
    for (const lon of [179.95, -179.95]) {
      const boxes = capBoundingBoxes(lon, lat, 30);
      const ids = (await Promise.all(boxes.map((b) => env.db.candidateIds(b, {})))).flat();
      expect(ids).toContain(crossing!.id);
    }
  });

  it('treats hostile satellite ids as data, not SQL', async () => {
    for (const id of ["YAM20' OR '1'='1", 'YAM20); DROP TABLE segments; --']) {
      expect(await env.db.candidateIds([-180, -90, 180, 90], { satellites: [id] })).toEqual([]);
    }
    expect(await env.db.satellites()).toHaveLength(2); // table intact
  });

  it('answers the readiness ping', async () => {
    await expect(env.db.ping()).resolves.toBeUndefined();
  });
});

describe('database lockdown (defence in depth behind bound parameters)', () => {
  it('refuses file access, writes, extension installs and settings changes', async () => {
    const { instance, connection } = await openHardenedInstance(dataFiles(env.dataDir).database);
    const outside = path.join(env.dataDir, 'secret.csv');
    await writeFile(outside, 'a\n1\n');
    try {
      await expect(connection.run(`SELECT * FROM read_csv('${outside}')`)).rejects.toThrow(
        /Permission|disabled/i,
      );
      await expect(connection.run(`COPY (SELECT 1) TO '${outside}'`)).rejects.toThrow();
      await expect(connection.run('CREATE TABLE t (x INTEGER)')).rejects.toThrow(/read-only/i);
      await expect(connection.run("ATTACH 'other.duckdb'")).rejects.toThrow();
      await expect(connection.run('INSTALL httpfs')).rejects.toThrow();
      await expect(connection.run('SET enable_external_access = true')).rejects.toThrow(/configuration/i);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});

describe('candidate pre-filter is lossless', () => {
  // Filtered by bounding box + spherical cap in SQL vs. every segment: identical passes. Targets are
  // taken from the fixture itself so that every case really has passes (no vacuous [] === []).
  const fixtureTargets = (): [string, number, number][] => {
    const segments = segmentsOf(env.geometry);
    const vertices = segments.flatMap((s) => s.coords);
    const highest = vertices.reduce((m, v) => (Math.abs(v[1]) > Math.abs(m[1]) ? v : m), vertices[0]!);
    const arcs = segments.flatMap((s) => s.coords.slice(1).map((end, i) => [s.coords[i]!, end] as const));
    const [from, to] = arcs.find(([p, q]) => Math.abs(q[0] - p[0]) > 180)!;
    const [crossLon, crossLat] = toLonLat(slerp(toVec(from[0], from[1]), toVec(to[0], to[1]), 0.5));
    const onTrack = segments[30]!.coords[3]!;
    return [
      ['on the track', onTrack[0], onTrack[1]],
      ['on the antimeridian crossing', crossLon, crossLat],
      [`at the highest latitude reached (${highest[1].toFixed(1)}°)`, highest[0], highest[1]],
    ];
  };
  const all = () => Array.from({ length: env.geometry.segmentCount }, (_, i) => i);
  const compare = async (lon: number, lat: number, radiusKm: number) => {
    const q = { lat, lon, radiusKm, daylightOnly: false, includePath: true };
    const viaDb = await findAccesses(env.db, env.geometry, env.info, q);
    const exhaustive = computePasses(env.geometry, all(), {
      ...q,
      startMs: env.info.startMs,
      endMs: env.info.endMs,
    });
    return { viaDb: viaDb.passes, exhaustive };
  };

  it.each([10, 400, 2500])('radius %i km, targets on the fixture tracks', async (radiusKm) => {
    for (const [label, lon, lat] of fixtureTargets()) {
      const { viaDb, exhaustive } = await compare(lon, lat, radiusKm);
      expect(exhaustive.length, label).toBeGreaterThan(0);
      expect(viaDb, label).toEqual(exhaustive);
    }
  });

  it('radius 2500 km over both poles and open ocean', async () => {
    for (const [lon, lat] of [
      [0, 89.5],
      [45, -89.5],
      [-150, -40],
    ] as const) {
      const { viaDb, exhaustive } = await compare(lon, lat, 2500);
      expect(viaDb).toEqual(exhaustive);
    }
  });

  it('finds passes over the poles with the largest radius (every polar orbit covers them)', async () => {
    for (const lat of [89.5, -89.5]) {
      const res = await findAccesses(env.db, env.geometry, env.info, {
        lat,
        lon: 0,
        radiusKm: 2500,
        daylightOnly: false,
        includePath: false,
      });
      expect(new Set(res.passes.map((p) => p.satellite))).toEqual(new Set(['YAM20', 'YAM25']));
    }
  });
});

describe('ConnectionPool', () => {
  it('serialises work beyond its size and hands connections to waiters in order', async () => {
    const pool = new ConnectionPool([{} as never]);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = pool.use(
      () =>
        new Promise<void>((resolve) => {
          order.push('first:start');
          release = () => {
            order.push('first:end');
            resolve();
          };
        }),
    );
    const second = pool.use(() => {
      order.push('second');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']); // second waits for the only connection
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('returns the connection even when the work fails', async () => {
    const pool = new ConnectionPool([{} as never]);
    await expect(pool.use(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(pool.use(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('seed consistency', () => {
  it('refuses to boot with artifacts from a different seed than the database', async () => {
    // Simulate a seed interrupted between renames: new artifacts next to the old database.
    const other = geometryFromSegments(
      makeTrack({ satellite: 'X', startMs: T0, lon: 0, lat: 0, bearing: 0, minutes: 2 }),
    );
    const manifest = await writeArtifacts(env.dataDir, await encodeArtifacts(other, 10), {
      datasetName: 'Other',
      stepS: 10,
      segmentCount: 2,
    });
    const live = artifactFiles(env.dataDir);
    await Promise.all(artifactFiles(env.dataDir, true).map((pending, i) => rename(pending, String(live[i]))));
    await expect(loadDatasetInfo(env.db, manifest)).rejects.toThrow(/different seeds/);
  });
});

describe('buildDatabase validation', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function buildFrom(features: unknown[]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ow-build-'));
    dirs.push(dir);
    const source = path.join(dir, 'Bad-tracks.json');
    await writeFile(source, JSON.stringify({ type: 'FeatureCollection', features }));
    return buildDatabase({ sourcePath: source, dataDir: path.join(dir, 'out') });
  }

  const feature = (start: string, end: string, coords: number[][]) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { satellite: 'X', ts_start: start, ts_end: end, local_time_h: 1 },
  });

  it('rejects unevenly spaced vertices (the codec needs a fixed step)', async () => {
    await expect(
      buildFrom([
        feature('2027-03-01T00:00:00Z', '2027-03-01T00:01:00Z', [
          [0, 0, 500],
          [1, 0, 500],
        ]),
        feature('2027-03-01T00:01:00Z', '2027-03-01T00:03:00Z', [
          [1, 0, 500],
          [2, 0, 500],
        ]),
      ]),
    ).rejects.toThrow(/evenly spaced/);
  });

  it('rejects segments with a single vertex', async () => {
    await expect(
      buildFrom([feature('2027-03-01T00:00:00Z', '2027-03-01T00:01:00Z', [[0, 0, 500]])]),
    ).rejects.toThrow(/fewer than 2 vertices/);
  });

  it('rejects a dataset without segments', async () => {
    await expect(buildFrom([])).rejects.toThrow(/no segments/);
  });
});

describe('datasetNameFromFile', () => {
  it.each([
    ['data/Altair-2P5S-tracks-1w.json.gz', 'Altair-2P5S'],
    ['Fixture-tracks-3h.json', 'Fixture'],
    ['/x/constellation.json', 'constellation'],
    ['tracks.json', 'tracks'],
  ])('%s → %s', (file, name) => {
    expect(datasetNameFromFile(file)).toBe(name);
  });
});
