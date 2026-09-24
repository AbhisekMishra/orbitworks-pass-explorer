/**
 * Regenerates the integration-test fixture: a small, real slice of the challenge dataset.
 *   pnpm --filter @ow/api exec tsx src/scripts/make-fixture.ts
 * Two satellites (different orbital planes) × the first 3 hours: 360 segments that include
 * antimeridian crossings, day and night passes, and ascending and descending arcs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { API_ROOT, REPO_ROOT } from '../config.js';

export const FIXTURE_SATELLITES = ['YAM20', 'YAM25'];
export const FIXTURE_END = '2027-03-01T03:00:00Z';

interface Feature {
  properties: { satellite: string; ts_start: string };
  geometry: { coordinates: number[][] };
}

const source = path.join(REPO_ROOT, 'data', 'Altair-2P5S-tracks-1w.json.gz');
const collection = JSON.parse(zlib.gunzipSync(readFileSync(source)).toString('utf8')) as {
  features: Feature[];
};
const end = Date.parse(FIXTURE_END);
const features = collection.features.filter(
  (f) => FIXTURE_SATELLITES.includes(f.properties.satellite) && Date.parse(f.properties.ts_start) < end,
);
const crossings = features.filter((f) => {
  const lons = f.geometry.coordinates.map((c) => c[0] ?? 0);
  return Math.max(...lons) - Math.min(...lons) > 180;
}).length;

const out = path.join(API_ROOT, 'test', 'fixtures', 'Fixture-tracks-3h.json.gz');
writeFileSync(out, zlib.gzipSync(JSON.stringify({ type: 'FeatureCollection', features }), { level: 9 }));
console.log(`Wrote ${features.length} segments (${crossings} cross the antimeridian) to ${out}`);
