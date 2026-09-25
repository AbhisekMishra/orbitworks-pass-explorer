/* eslint-disable security/detect-non-literal-fs-filename -- build-time config: the only paths read
   are MapLibre's own files, resolved from node_modules. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

/** Where `/api` is proxied in dev and preview (the E2E suite points it at its own API instance). */
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

// Vendor code changes far less often than app code: separate chunks keep returning visitors'
// caches warm across deploys, and let the size gate measure app code on its own. (Module ids are
// normalized to forward slashes, on Windows too.)
const VENDOR_GROUPS = [
  { name: 'deck', test: /node_modules\/(@deck\.gl|@luma\.gl|@math\.gl|@loaders\.gl|@probe\.gl)\// },
  { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
  { name: 'vendor', test: /node_modules\// },
];

const require = createRequire(import.meta.url);
const MAPLIBRE_DIST = path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist');
const { version: MAPLIBRE_VERSION } = JSON.parse(
  readFileSync(path.join(MAPLIBRE_DIST, '..', 'package.json'), 'utf8'),
) as { version: string };
const MAPLIBRE_FILES = ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs'];
/** Versioned path: the files can be cached as immutable, like hashed assets. */
const MAPLIBRE_DIR = `vendor/maplibre-gl-${MAPLIBRE_VERSION}`;

/**
 * Ships MapLibre's own three ES modules unbundled instead of bundling them.
 *
 * MapLibre 6 splits into main + shared + worker modules and loads the worker from a URL relative
 * to its own module. Bundling breaks that URL, and a separately bundled worker duplicates the
 * ~145 KB (gzip) shared module. Served as-is, the worker resolves itself and reuses the shared
 * module from the HTTP cache: ~100 KB less JavaScript per visit and no worker-URL workaround.
 */
function maplibreUnbundled(): Plugin {
  return {
    name: 'ow:maplibre-unbundled',
    apply: 'build',
    config: () => ({
      build: {
        rolldownOptions: {
          external: ['maplibre-gl'],
          output: { paths: { 'maplibre-gl': `/${MAPLIBRE_DIR}/maplibre-gl.mjs` } },
        },
      },
    }),
    generateBundle() {
      for (const file of MAPLIBRE_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `${MAPLIBRE_DIR}/${file}`,
          source: readFileSync(path.join(MAPLIBRE_DIST, file)),
        });
      }
    },
  };
}

/**
 * When the API is another origin (VITE_API_URL, the Vercel build), start its DNS/TCP/TLS setup
 * from the HTML, as for the basemap: otherwise the handshake waits for the JS, and the tracks
 * download (the critical request) waits behind it. Same-origin builds need nothing.
 */
function apiPreconnect(): Plugin {
  let origin: string | null = null;
  return {
    name: 'ow:api-preconnect',
    configResolved(config) {
      const url: unknown = config.env.VITE_API_URL;
      origin = typeof url === 'string' && URL.canParse(url) ? new URL(url).origin : null;
    },
    transformIndexHtml: () =>
      origin
        ? [{ tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: true }, injectTo: 'head' }]
        : [],
  };
}

export default defineConfig({
  plugins: [react(), maplibreUnbundled(), apiPreconnect()],
  // Bundle @ow/shared from source: one TS toolchain, exact sourcemaps, better tree-shaking.
  resolve: { conditions: ['@ow/source', ...defaultClientConditions] },
  // In dev MapLibre is served from node_modules as-is, for the same reason as maplibreUnbundled.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  worker: { format: 'es' },
  server: { proxy: { '/api': API_PROXY_TARGET } },
  preview: { proxy: { '/api': API_PROXY_TARGET } },
  build: {
    target: 'es2022',
    // Maps are generated for debugging but not referenced from the bundles ('hidden').
    sourcemap: 'hidden',
    // deck.gl is ~220 KB gzip; the real budgets are enforced by scripts/size-check.mjs.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: { output: { codeSplitting: { groups: VENDOR_GROUPS } } },
  },
});
