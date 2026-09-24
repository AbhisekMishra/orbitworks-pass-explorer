// Shared I/O helpers for hook entrypoints. Claude Code passes the event as JSON on stdin; exit code 2
// blocks the action and feeds stderr back to the agent.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function readEvent() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Run a node CLI from node_modules directly (no shell, no .cmd shims: identical on Windows/Linux). */
export function runNodeBin(relBin, args, opts = {}) {
  const res = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'node_modules', relBin), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

export function runPnpm(args, opts = {}) {
  const res = spawnSync('pnpm', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

/** Keep feedback to the agent short and focused on the end of the output (where errors are). */
export function tail(text, maxLines = 60) {
  const lines = text.split(/\r?\n/);
  return lines.length > maxLines ? ['…', ...lines.slice(-maxLines)].join('\n') : text;
}
