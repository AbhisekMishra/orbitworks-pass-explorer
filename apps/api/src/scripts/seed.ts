/**
 * `pnpm seed [path/to/tracks.json(.gz)]` — builds the DuckDB database and the precompressed track
 * artifacts into DATA_DIR. Defaults to the challenge dataset in <repo>/data.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, loadConfig } from '../config.js';
import { buildDatabase, publishDatabase } from '../db/build.js';

function defaultSource(): string {
  const dir = path.join(REPO_ROOT, 'data');
  const file = readdirSync(dir).find((f) => /\.json(\.gz)?$/i.test(f));
  if (!file) throw new Error(`No *.json or *.json.gz dataset found in ${dir}`);
  return path.join(dir, file);
}

const config = loadConfig();
const sourcePath = path.resolve(process.argv[2] ?? defaultSource());
const started = performance.now();

const result = await buildDatabase({
  sourcePath,
  dataDir: config.DATA_DIR,
  log: (m) => {
    console.log(`[seed] ${m}`);
  },
});
await publishDatabase(config.DATA_DIR);

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const { bytes } = result.manifest;
console.log(
  [
    `[seed] Done in ${((performance.now() - started) / 1000).toFixed(1)} s → ${config.DATA_DIR}`,
    `[seed]   ${result.segmentCount} segments (${result.antimeridianSegments} cross the antimeridian), step ${result.manifest.stepS} s`,
    `[seed]   tracks: ${kb(bytes.raw)} raw, ${kb(bytes.brotli)} brotli, ${kb(bytes.gzip)} gzip · ETag ${result.manifest.etag}`,
  ].join('\n'),
);
