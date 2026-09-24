// PostToolUse (Edit | Write | MultiEdit): formats the touched file, then lints it. Lint errors are
// returned to the agent (exit 2) so they are fixed immediately instead of accumulating.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, block, readEvent, runNodeBin, tail } from './lib/io.mjs';

const event = await readEvent();
const filePath = event.tool_input?.file_path;
if (!filePath || !existsSync(filePath)) process.exit(0);

const rel = path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');
if (rel.startsWith('..') || /(^|\/)(node_modules|dist|coverage|data)\//.test(rel)) process.exit(0);

const ext = path.extname(filePath).toLowerCase();
const PRETTIER_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.html',
]);
const ESLINT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs']);

if (PRETTIER_EXT.has(ext)) {
  runNodeBin('prettier/bin/prettier.cjs', ['--write', '--log-level', 'warn', '--ignore-unknown', filePath]);
}

let result = null;
if (ESLINT_EXT.has(ext)) {
  result = runNodeBin('eslint/bin/eslint.js', ['--max-warnings=0', '--no-warn-ignored', filePath]);
} else if (ext === '.css') {
  result = runNodeBin('stylelint/bin/stylelint.mjs', [filePath]);
}

if (result && !result.ok) {
  block(`[lint-file] ${rel} has lint errors — fix them now:\n${tail(result.output, 40)}`);
}
