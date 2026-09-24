/* eslint-disable security/detect-non-literal-fs-filename -- every path derives from the operator's
   DATA_DIR setting (validated in config.ts), never from request input: no traversal vector. */
/**
 * The full-dataset track stream is immutable per deployment, so it is encoded and compressed once
 * at seed time (brotli quality 11 takes ~2.7 s of CPU — never on the request path) and served from
 * memory with a strong ETag.
 *
 * Artifacts are written under temporary names and only renamed into place together with the
 * database (see publishDatabase), and the database records the artifact ETag: a partial or
 * interrupted seed can never leave a server booting with mismatched data.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { z } from 'zod';

import { dataFiles } from '../config.js';
import type { TrackGeometry } from '../domain/geometry.js';

import { encodeSegments } from './tracks.js';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const unbrotli = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

/** Suffix of files written by the seed before they are published. */
export const PENDING_SUFFIX = '.tmp';

export const ManifestSchema = z.object({
  datasetName: z.string(),
  etag: z.string(),
  stepS: z.number().positive(),
  segmentCount: z.number().int().nonnegative(),
  bytes: z.object({ raw: z.number(), brotli: z.number(), gzip: z.number() }),
  generatedAt: z.iso.datetime(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface EncodedTracks {
  raw: Buffer;
  brotli: Buffer;
  gzip: Buffer;
  etag: string;
}

/** Strong ETag: content hash of the uncompressed stream (identical for every encoding). */
export const etagOf = (bytes: Uint8Array): string =>
  `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;

/** Encodes every segment of the geometry and compresses it once, at maximum quality. */
export async function encodeArtifacts(geometry: TrackGeometry, stepS: number): Promise<EncodedTracks> {
  const all = Array.from({ length: geometry.segmentCount }, (_, i) => i);
  const raw = Buffer.from(encodeSegments(geometry, all, stepS));
  const [br, gz] = await Promise.all([
    brotli(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
    gzip(raw, { level: zlib.constants.Z_BEST_COMPRESSION }),
  ]);
  return { raw, brotli: br, gzip: gz, etag: etagOf(raw) };
}

/** Artifact files in dataDir: the live ones, or with `pending` the not-yet-published ones. */
export function artifactFiles(dataDir: string, pending = false): string[] {
  const f = dataFiles(dataDir);
  const suffix = pending ? PENDING_SUFFIX : '';
  return [f.tracks, f.tracksBrotli, f.tracksGzip, f.manifest].map((p) => p + suffix);
}

/** Writes the artifacts under their pending names; publishDatabase moves them into place. */
export async function writeArtifacts(
  dataDir: string,
  encoded: EncodedTracks,
  meta: Pick<Manifest, 'datasetName' | 'stepS' | 'segmentCount'>,
): Promise<Manifest> {
  const manifest: Manifest = {
    ...meta,
    etag: encoded.etag,
    bytes: { raw: encoded.raw.length, brotli: encoded.brotli.length, gzip: encoded.gzip.length },
    generatedAt: new Date().toISOString(),
  };
  const [raw, br, gz, manifestFile] = artifactFiles(dataDir, true);
  await Promise.all([
    writeFile(String(raw), encoded.raw),
    writeFile(String(br), encoded.brotli),
    writeFile(String(gz), encoded.gzip),
    writeFile(String(manifestFile), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  return manifest;
}

export interface LoadedArtifacts extends EncodedTracks {
  manifest: Manifest;
}

export async function loadArtifacts(dataDir: string): Promise<LoadedArtifacts> {
  const files = dataFiles(dataDir);
  const [raw, br, gz, manifestJson] = await Promise.all([
    readFile(files.tracks),
    readFile(files.tracksBrotli),
    readFile(files.tracksGzip),
    readFile(files.manifest, 'utf8'),
  ]);
  const manifest = ManifestSchema.parse(JSON.parse(manifestJson));
  // Every representation must be the same bytes: a stale .br/.gz (e.g. a seed interrupted between
  // renames) would otherwise be served under the new strong ETag. Decompressing takes a few ms.
  const [fromBrotli, fromGzip] = await Promise.all([unbrotli(br), gunzip(gz)]);
  if (etagOf(raw) !== manifest.etag || !fromBrotli.equals(raw) || !fromGzip.equals(raw)) {
    throw new Error('Track artifacts do not match the manifest; re-run `pnpm seed`.');
  }
  return { raw, brotli: br, gzip: gz, etag: manifest.etag, manifest };
}
