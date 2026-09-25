import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against production builds: the real API (apps/api/dist, real seeded week of data) and the
 * web app built with `--mode e2e` (identical to production plus read-only test hooks), served by
 * `vite preview`, which proxies /api to the API like nginx does in Docker.
 *
 * Prerequisites (CI and `pnpm verify` do these): `pnpm build` and `pnpm seed`.
 */
const API_PORT = 3100;
const WEB_PORT = 4173;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // A retry that passes is still a failure: retries only collect a trace for diagnosis. (Phase 4
  // shipped with 7 tests that passed only on retry; a green job had hidden them.)
  failOnFlakyTests: CI,
  // One worker on CI: each worker runs its own Chromium with SwiftShader, which renders WebGL on
  // every CPU core. Two of them on a 4-vCPU runner starved each other (GPU process stalls, hung
  // page.evaluate calls, dropped browser contexts: 7–9 flaky tests per run). Locally there is headroom.
  workers: CI ? 1 : 3,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Full Chromium in new headless mode rather than the separate headless shell: with software
        // WebGL the shell intermittently lost browser contexts on CI (newContext: 'Failed to find
        // browser context'), while the Lighthouse job, on full Chromium, never did.
        channel: 'chromium',
        viewport: { width: 1280, height: 800 },
        // WebGL without a GPU (CI runners): SwiftShader software rendering.
        launchOptions: {
          args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'node ../api/dist/server.js',
      url: `http://127.0.0.1:${API_PORT}/readyz`,
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'production',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        // Parallel tests reload the app many times from one IP.
        RATE_LIMIT_TRACKS_PER_MIN: '10000',
        RATE_LIMIT_ACCESSES_PER_MIN: '10000',
        RATE_LIMIT_GLOBAL_PER_MIN: '100000',
      },
    },
    {
      command: `pnpm exec vite preview --outDir dist-e2e --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
