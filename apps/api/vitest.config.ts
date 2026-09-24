import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests must run against @ow/shared *source*, never a stale dist/ build: resolve the source
  // condition in the SSR (node) environment and inline the package so Vite transforms it.
  resolve: { conditions: ['@ow/source'] },
  ssr: { resolve: { conditions: ['@ow/source'] } },
  test: {
    server: { deps: { inline: ['@ow/shared'] } },
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Process entrypoints: exercised as real child processes (test/server.test.ts boots the
        // server; the seed runs in CI and at Docker build), which v8 coverage cannot instrument.
        'src/server.ts',
        'src/scripts/**',
      ],
      reporter: ['text-summary', 'lcov', 'json-summary'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
