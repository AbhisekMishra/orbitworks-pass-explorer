// Installs git hooks (lefthook) after `pnpm install`, but only in a real git checkout and never in
// CI or Docker builds, where hooks are useless and `.git` may be absent.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.CI || !existsSync('.git')) {
  process.exit(0);
}
try {
  execFileSync('pnpm', ['exec', 'lefthook', 'install'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch {
  console.warn('[prepare] lefthook install failed; git hooks are not active.');
}
