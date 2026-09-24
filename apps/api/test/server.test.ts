// Boots the real process entrypoint (src/server.ts) against a seeded fixture directory, so the
// wiring — config, database, artifacts, consistency check, geometry, listen — is covered end to end.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatasetSchema } from '@ow/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_ROOT } from '../src/config.js';

import { createFixtureEnv, type FixtureEnv } from './fixture-env.js';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });

async function waitUntilReady(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`Server not ready at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let env: FixtureEnv;
let child: ChildProcess | undefined;
let base = '';
let output = '';

beforeAll(async () => {
  env = await createFixtureEnv();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  child = spawn(
    process.execPath,
    [tsxCli, '--conditions=@ow/source', path.join(API_ROOT, 'src', 'server.ts')],
    {
      cwd: API_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATA_DIR: env.dataDir,
        LOG_LEVEL: 'warn',
      },
    },
  );
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
}, 120_000);

afterAll(async () => {
  child?.kill();
  await env.close();
});

describe('server process', () => {
  it('boots from a seeded DATA_DIR and serves readiness and data', async () => {
    const ready = await waitUntilReady(`${base}/readyz`, 60_000).catch((err: unknown) => {
      throw new Error(`${String(err)}\nServer output:\n${output}`);
    });
    expect(await ready.json()).toEqual({ status: 'ready' });

    const dataset = await fetch(`${base}/api/v1/dataset`);
    expect(dataset.status).toBe(200);
    expect(DatasetSchema.parse(await dataset.json()).name).toBe('Fixture');
  }, 90_000);
});
