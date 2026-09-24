import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api');

/** Fails fast with the fix, instead of a web-server timeout, when prerequisites are missing. */
export default function globalSetup(): void {
  const missing = [
    [path.join(api, 'dist', 'server.js'), 'pnpm --filter @ow/api build'],
    [path.join(api, 'data', 'manifest.json'), 'pnpm seed'],
    [path.resolve(api, '..', 'web', 'dist-e2e', 'index.html'), 'pnpm --filter @ow/web build:e2e'],
  ].filter(([file]) => !existsSync(String(file)));
  if (missing.length > 0) {
    throw new Error(`E2E prerequisites missing; run: ${missing.map(([, fix]) => fix).join(' && ')}`);
  }
}
