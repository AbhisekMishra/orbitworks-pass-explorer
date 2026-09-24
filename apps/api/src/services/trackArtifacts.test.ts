import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { decodeTracks } from '@ow/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { T0, makeTrack } from '../../test/synthetic.js';
import { dataFiles } from '../config.js';
import { geometryFromSegments } from '../../test/geometry.js';

import { artifactFiles, encodeArtifacts, etagOf, loadArtifacts, writeArtifacts } from './trackArtifacts.js';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ow-artifacts-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Writes artifacts and moves them into place the way publishDatabase does. */
async function writeAndPublish(dir: string) {
  const geometry = geometryFromSegments(
    makeTrack({ satellite: 'A', startMs: T0, lon: 0, lat: 0, bearing: 45, minutes: 5 }),
  );
  const encoded = await encodeArtifacts(geometry, 10);
  const manifest = await writeArtifacts(dir, encoded, { datasetName: 'Test', stepS: 10, segmentCount: 5 });
  const live = artifactFiles(dir);
  await Promise.all(artifactFiles(dir, true).map((pending, i) => rename(pending, String(live[i]))));
  return { encoded, manifest };
}

describe('track artifacts', () => {
  it('round-trips through encode → write → publish → load with every representation consistent', async () => {
    const dir = await tempDir();
    const { encoded, manifest } = await writeAndPublish(dir);
    const loaded = await loadArtifacts(dir);

    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.etag).toBe(etagOf(encoded.raw));
    expect(manifest.bytes.brotli).toBeLessThan(manifest.bytes.raw);
    expect(decodeTracks(loaded.raw).tracks[0]?.lon).toHaveLength(5 * 6 + 1);
  });

  it('writes under pending names only (nothing live until published)', async () => {
    const dir = await tempDir();
    const geometry = geometryFromSegments(
      makeTrack({ satellite: 'A', startMs: T0, lon: 0, lat: 0, bearing: 0, minutes: 1 }),
    );
    await writeArtifacts(dir, await encodeArtifacts(geometry, 10), {
      datasetName: 'T',
      stepS: 10,
      segmentCount: 1,
    });
    await expect(loadArtifacts(dir)).rejects.toThrow(/ENOENT/);
  });

  it('refuses artifacts that do not match their manifest (partial or tampered seed)', async () => {
    const dir = await tempDir();
    await writeAndPublish(dir);
    await writeFile(dataFiles(dir).tracks, new Uint8Array([1, 2, 3]));
    await expect(loadArtifacts(dir)).rejects.toThrow(/re-run `pnpm seed`/);
  });

  it('refuses a stale compressed variant (e.g. a seed interrupted between renames)', async () => {
    const dir = await tempDir();
    await writeAndPublish(dir);
    await writeFile(dataFiles(dir).tracksBrotli, zlib.brotliCompressSync(Buffer.from('stale')));
    await expect(loadArtifacts(dir)).rejects.toThrow(/re-run `pnpm seed`/);
  });

  it('produces a quoted, content-derived strong ETag', () => {
    const etag = etagOf(new Uint8Array([1, 2, 3]));
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect(etagOf(new Uint8Array([1, 2, 3]))).toBe(etag);
    expect(etagOf(new Uint8Array([1, 2, 4]))).not.toBe(etag);
  });
});
