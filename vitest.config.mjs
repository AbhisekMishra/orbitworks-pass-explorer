// Root Vitest config: only the harness self-tests live at the root. Packages have their own configs.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/harness/**/*.test.mjs'],
    testTimeout: 20_000,
  },
});
