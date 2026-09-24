// End-to-end: run the real hook entrypoints with Claude Code-shaped JSON on stdin.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = (name, event) =>
  spawnSync(process.execPath, [path.join(root, '.claude', 'hooks', name)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });

describe('guard-bash hook', () => {
  it('exits 2 with a reason for a blocked command', () => {
    const res = hook('guard-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'git push --force' } });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('[guard-bash] Blocked');
  });

  it('exits 0 for a safe command', () => {
    const res = hook('guard-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    expect(res.status).toBe(0);
  });
});

describe('guard-files hook', () => {
  it('blocks writes into data/', () => {
    const res = hook('guard-files.mjs', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(root, 'data', 'x.json'), content: '{}' },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('immutable');
  });

  it('blocks secrets in MultiEdit payloads', () => {
    const res = hook('guard-files.mjs', {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(root, 'apps', 'api', 'src', 'x.ts'),
        edits: [{ old_string: 'a', new_string: '-----BEGIN ' + 'PRIVATE KEY-----' }],
      },
    });
    expect(res.status).toBe(2);
  });

  it('allows normal source edits', () => {
    const res = hook('guard-files.mjs', {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(root, 'apps', 'api', 'src', 'x.ts'), new_string: 'const a = 1;' },
    });
    expect(res.status).toBe(0);
  });
});
