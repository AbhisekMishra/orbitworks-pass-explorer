// The single quality gate. Used by the git pre-push hook, the `/verify` Claude command and CI parity.
//   node scripts/verify.mjs          full gate (format, lint, types, tests+coverage, build, size, e2e)
//   node scripts/verify.mjs --fast   skips build, size budgets and e2e
import { spawnSync } from 'node:child_process';

const fast = process.argv.includes('--fast');

const steps = [
  ['Format', 'format:check'],
  ['Lint (eslint + stylelint)', 'lint'],
  ['Secrets', 'lint:secrets'],
  ['Typecheck', 'typecheck'],
  ['Unit + integration tests (coverage thresholds)', 'test:coverage'],
  ...(fast
    ? []
    : [
        ['Build', 'build'],
        ['Size budgets', 'size'],
        ['E2E (Playwright)', 'e2e'],
      ]),
];

const started = Date.now();
for (const [label, script] of steps) {
  const t0 = Date.now();
  process.stdout.write(`\n▶ ${label}\n`);
  // No --silent: it propagates to nested `pnpm -r` runs and would hide *why* a step failed.
  const res = spawnSync('pnpm', ['run', script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`\n✖ ${label} failed (pnpm ${script}). Gate is RED.`);
    process.exit(res.status ?? 1);
  }
  console.log(`✔ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(
  `\n✅ Quality gate GREEN in ${((Date.now() - started) / 1000).toFixed(1)}s${fast ? ' (fast mode)' : ''}`,
);
