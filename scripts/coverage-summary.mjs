// Prints a Markdown table of per-package coverage (from vitest json-summary) for the CI job summary.
import { existsSync, readFileSync } from 'node:fs';

const packages = ['packages/shared', 'apps/api', 'apps/web'];
const rows = [];
for (const dir of packages) {
  const file = `${dir}/coverage/coverage-summary.json`;
  if (!existsSync(file)) continue;
  const { total } = JSON.parse(readFileSync(file, 'utf8'));
  const pct = (k) => `${total[k].pct.toFixed(1)} %`;
  rows.push(
    `| \`${dir}\` | ${pct('lines')} | ${pct('branches')} | ${pct('functions')} | ${pct('statements')} |`,
  );
}

console.log('### Coverage\n');
if (rows.length === 0) {
  console.log('_No coverage reports found._');
} else {
  console.log('| Package | Lines | Branches | Functions | Statements |');
  console.log('|---|---|---|---|---|');
  console.log(rows.join('\n'));
}
