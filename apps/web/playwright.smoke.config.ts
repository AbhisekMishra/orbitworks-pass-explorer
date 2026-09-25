import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test of an already running deployment (e2e/smoke): nothing is started here.
 *   pnpm --filter @ow/web smoke                                     # docker compose stack on :8080
 *   SMOKE_BASE_URL=https://example.vercel.app pnpm --filter @ow/web smoke
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e/smoke',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  forbidOnly: CI,
  // A smoke test that needs a retry is a failure: there is exactly one test.
  retries: 0,
  workers: 1,
  reporter: CI ? [['github'], ['list']] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // Full Chromium in new headless mode, software WebGL (see playwright.config.ts).
    channel: 'chromium',
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://localhost:8080',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
