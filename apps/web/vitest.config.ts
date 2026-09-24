import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Logic tests run in node (fast); component tests opt into jsdom with a docblock.
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/testing/setup.ts'],
      server: { deps: { inline: ['@ow/shared'] } },
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/testing/**',
          'src/main.tsx',
          'src/vite-env.d.ts',
          // WebGL / Worker / MapLibre glue: jsdom has none of these. Covered by the Playwright
          // suite (e2e/*.spec.ts); the logic they call lives in unit-tested modules.
          'src/map/MapView.tsx',
          'src/map/mapController.ts',
          'src/map/TrackLayer.ts',
          'src/tracks/tracks.worker.ts',
        ],
        reporter: ['text-summary', 'lcov', 'json-summary'],
        thresholds: {
          // Logic (stores, utils, math): CLAUDE.md budget ≥ 85 %.
          'src/**/*.ts': { lines: 85, branches: 85, functions: 85, statements: 85 },
          // Components: ≥ 70 %.
          'src/**/*.tsx': { lines: 70, branches: 70, functions: 70, statements: 70 },
        },
      },
    },
  }),
);
