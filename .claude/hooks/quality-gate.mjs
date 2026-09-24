// Stop: the agent may not finish a turn while the working tree is red. Runs typecheck and the tests
// related to changed files. A loop guard releases the block after MAX_ATTEMPTS consecutive failures
// so a genuinely stuck situation is surfaced to the human instead of looping forever.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT, block, readEvent, runPnpm, tail } from './lib/io.mjs';

const MAX_ATTEMPTS = 3;
const CODE_FILE = /\.(ts|tsx|mjs|js|css|json)$/;

const event = await readEvent();

const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: PROJECT_ROOT,
  encoding: 'utf8',
});
const changed = (status.stdout ?? '')
  .split(/\r?\n/)
  .map((l) => l.slice(3).trim())
  .filter((f) => CODE_FILE.test(f));
if (changed.length === 0) process.exit(0);

const stateDir = path.join(os.tmpdir(), 'ow-quality-gate');
mkdirSync(stateDir, { recursive: true });
const stateFile = path.join(stateDir, `${String(event.session_id ?? 'default').replace(/[^\w-]/g, '')}.json`);
const attempts = existsSync(stateFile)
  ? Number(JSON.parse(readFileSync(stateFile, 'utf8')).attempts) || 0
  : 0;

const checks = [
  ['Typecheck', ['-r', '--if-present', 'typecheck']],
  ['Tests related to changed files', ['-r', '--if-present', 'test:changed']],
];

for (const [label, args] of checks) {
  const res = runPnpm(args);
  if (!res.ok) {
    if (event.stop_hook_active && attempts + 1 >= MAX_ATTEMPTS) {
      rmSync(stateFile, { force: true });
      process.stderr.write(
        `[quality-gate] ${label} still failing after ${MAX_ATTEMPTS} attempts — releasing the block. ` +
          'Report the failure to the user explicitly; do not claim the work is done.\n',
      );
      process.exit(0);
    }
    writeFileSync(stateFile, JSON.stringify({ attempts: attempts + 1 }));
    block(
      `[quality-gate] ${label} FAILED — the work is not done until this is green:\n${tail(res.output, 50)}`,
    );
  }
}
rmSync(stateFile, { force: true });
