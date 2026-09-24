import { describe, expect, it } from 'vitest';

import type { Database } from '../db/database.js';

import { loadDatasetInfo, resolveSatellites, type DatasetInfo } from './dataset.js';
import type { Manifest } from './trackArtifacts.js';

const manifest: Manifest = {
  datasetName: 'Test',
  etag: '"e"',
  stepS: 10,
  segmentCount: 0,
  bytes: { raw: 0, brotli: 0, gzip: 0 },
  generatedAt: '2027-03-01T00:00:00.000Z',
};
const stubDb = (satellites: Awaited<ReturnType<Database['satellites']>>, etag = '"e"'): Database => ({
  satellites: () => Promise.resolve(satellites),
  tracksEtag: () => Promise.resolve(etag),
  candidateIds: () => Promise.resolve([]),
  loadGeometry: () => Promise.reject(new Error('unused')),
  ping: () => Promise.resolve(),
  close: () => undefined,
});
const sat = (id: string, startMs: number, endMs: number) => ({
  id,
  startMs,
  endMs,
  segmentCount: 1,
  minAltitudeKm: 500,
  maxAltitudeKm: 510,
});

describe('loadDatasetInfo', () => {
  it('derives the dataset extent from all satellites', async () => {
    const info = await loadDatasetInfo(stubDb([sat('A', 10, 50), sat('B', 5, 40)]), manifest);
    expect(info).toMatchObject({ name: 'Test', startMs: 5, endMs: 50, stepS: 10 });
    expect([...info.satelliteIds]).toEqual(['A', 'B']);
  });

  it('refuses an empty database', async () => {
    await expect(loadDatasetInfo(stubDb([]), manifest)).rejects.toThrow(/no satellites/);
  });

  it('refuses a database built with other artifacts', async () => {
    await expect(loadDatasetInfo(stubDb([sat('A', 0, 1)], '"other"'), manifest)).rejects.toThrow(
      /different seeds/,
    );
  });
});

describe('resolveSatellites', () => {
  const info = {
    satellites: [sat('A', 0, 1), sat('B', 0, 1)],
    satelliteIds: new Set(['A', 'B']),
  } as unknown as DatasetInfo;

  it('defaults to every satellite and keeps a valid selection as given', () => {
    expect(resolveSatellites(info, undefined)).toEqual(['A', 'B']);
    expect(resolveSatellites(info, ['B'])).toEqual(['B']);
  });

  it('rejects unknown ids with a 400', () => {
    expect(() => resolveSatellites(info, ['A', 'Z'])).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
