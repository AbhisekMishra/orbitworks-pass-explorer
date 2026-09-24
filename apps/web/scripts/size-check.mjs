// Bundle size gate (CLAUDE.md "Performance budgets"): gzip sizes of the production build.
//   app code (every chunk that is not a vendor group or a worker) ≤ 80 KB
//   all JavaScript, workers and dist/vendor (unbundled MapLibre) included ≤ 750 KB
// Vendor chunks (maplibre, deck, react, vendor) are split out in vite.config.ts on purpose.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const BUDGETS = { appCode: 80 * KB, totalJs: 750 * KB };
const VENDOR_CHUNK = /^(maplibre|deck|react|vendor|rolldown-runtime)-/;
const WORKER_CHUNK = /worker/;

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const assets = path.join(dist, 'assets');

let files;
try {
  files = readdirSync(assets).filter((f) => f.endsWith('.js'));
} catch {
  console.error(`✖ No build found in ${assets}; run "pnpm --filter @ow/web build" first.`);
  process.exit(1);
}

const gzipOf = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
const sizes = files.map((file) => ({
  file,
  gzip: gzipOf(path.join(assets, file)),
  app: !VENDOR_CHUNK.test(file) && !WORKER_CHUNK.test(file),
}));
// MapLibre ships unbundled under dist/vendor (see vite.config.ts): vendor code, counted in total.
for (const entry of readdirSync(path.join(dist, 'vendor'), { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) {
    const file = path.join(entry.parentPath, entry.name);
    sizes.push({ file: path.relative(dist, file), gzip: gzipOf(file), app: false });
  }
}
const total = sizes.reduce((sum, s) => sum + s.gzip, 0);
const app = sizes.filter((s) => s.app).reduce((sum, s) => sum + s.gzip, 0);

const fmt = (b) => `${(b / KB).toFixed(1)} KB`;
for (const s of sizes.sort((a, b) => b.gzip - a.gzip)) {
  console.log(`  ${fmt(s.gzip).padStart(10)}  ${s.app ? 'app   ' : '      '} ${s.file}`);
}
console.log(
  `\n  app code ${fmt(app)} (≤ ${fmt(BUDGETS.appCode)}) · total JS ${fmt(total)} (≤ ${fmt(BUDGETS.totalJs)})`,
);

const failures = [];
if (app > BUDGETS.appCode) failures.push(`app code ${fmt(app)} > ${fmt(BUDGETS.appCode)}`);
if (total > BUDGETS.totalJs) failures.push(`total JS ${fmt(total)} > ${fmt(BUDGETS.totalJs)}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`✖ ${f}`);
  process.exit(1);
}
console.log('✔ Size budgets met');
