// Pure guardrail policies used by the Claude Code hooks. No I/O here so every rule is unit-tested
// (tests/harness/policy.test.mjs). Each evaluator returns null when allowed, or a reason string.
//
// Shell commands are tokenized (statements → pipeline stages → words) and checked with small
// predicates instead of large regexes over the raw command: linear time (no ReDoS on hostile input)
// and far easier to reason about.

/** Directory names whose recursive removal is harmless: build output, caches, reports. */
const DISPOSABLE_DIRS = new Set([
  'dist',
  'coverage',
  'node_modules',
  'test-results',
  'playwright-report',
  '.cache',
  '.vite',
  'tmp',
]);
const SCRATCH_MARKERS = ['temp/claude', 'scratchpad'];

/**
 * Files Claude must never modify: immutable input data, secrets, git internals, the lockfile.
 * The harness itself (.claude/, lefthook.yml, scripts/verify.mjs) is agent-editable by project
 * decision; changes to it go through /review, the harness tests and CI like any other code.
 */
const PROTECTED_FILES = [
  {
    test: (rel) => rel.startsWith('data/'),
    why: 'data/ holds the immutable challenge dataset; derive new files elsewhere.',
  },
  {
    test: (rel) => isEnvFile(basename(rel)),
    why: '.env files may contain secrets; edit .env.example instead.',
  },
  { test: (rel) => rel.startsWith('.git/'), why: 'Never write into .git internals.' },
  {
    test: (rel) => basename(rel) === 'pnpm-lock.yaml',
    why: 'The lockfile is generated; change package.json and run pnpm install.',
  },
];

/** Paths that must not be rewritten or deleted by shell commands either. */
const SHELL_PROTECTED = ['pnpm-lock.yaml', 'data/', '.git/'];
const SHELL_WRITE_MARKERS = new Set([
  '>',
  '>>',
  'tee',
  'cp',
  'mv',
  'rm',
  'del',
  'copy',
  'move',
  'unlink',
  'set-content',
  'add-content',
  'out-file',
  'remove-item',
  'copy-item',
  'move-item',
]);

/** High-signal secret patterns (kept intentionally narrow to avoid false positives). */
const SECRET_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, what: 'a private key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36}/, what: 'a GitHub token' },
  { re: /\bgithub_pat_\w{60}/, what: 'a GitHub fine-grained token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10}/, what: 'a Slack token' },
  { re: /\bsk-(?:ant-)?[\w-]{32}/, what: 'an API secret key' },
  { re: /\bAIza[\w-]{35}/, what: 'a Google API key' },
];

const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'iex', 'invoke-expression', 'node', 'python', 'python3']);

const normalize = (p) => String(p ?? '').replaceAll('\\', '/');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const QUOTES = new Set(['"', "'"]);
/** Strip surrounding quotes with an index scan (a regex like /["']+$/ backtracks super-linearly). */
function unquote(t) {
  let start = 0;
  let end = t.length;
  while (start < end && QUOTES.has(t[start])) start++;
  while (end > start && QUOTES.has(t[end - 1])) end--;
  return t.slice(start, end);
}
const isEnvFile = (name) => (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
/** A clustered short-flag token such as -fdx or -nm. */
const isShortFlags = (t) => /^-[a-z]+$/i.test(t);
const hasShortFlag = (t, letter) => isShortFlags(t) && t.slice(1).includes(letter);

/** "a && b; c | d" → [[['a'], ['b']...]] : statements → pipeline stages → lowercase-insensitive words. */
function parse(command) {
  return command
    .split(/&&|\|\||;|\n/)
    .map((statement) =>
      statement
        .split('|')
        .map((stage) => stage.trim().split(/\s+/).filter(Boolean).map(unquote))
        .filter((words) => words.length > 0),
    )
    .filter((stages) => stages.length > 0);
}

/** Rules over a single pipeline stage (its words). Return a reason to block, or null. */
const STAGE_RULES = [
  (w) =>
    w.includes('--no-verify')
      ? 'Bypassing git hooks (--no-verify) is not allowed; fix the failing check.'
      : null,
  (w) =>
    w[0] === 'git' && w.includes('commit') && w.some((t) => hasShortFlag(t, 'n'))
      ? 'git commit -n bypasses hooks; fix the failing check.'
      : null,
  (w) =>
    w[0] === 'git' &&
    w.includes('push') &&
    w.some((t) => t === '--force' || t === '--force-with-lease' || hasShortFlag(t, 'f') || /^\+\S/.test(t))
      ? 'Force-pushing rewrites shared history; create a new commit instead.'
      : null,
  (w) =>
    w[0] === 'git' && w.includes('reset') && w.includes('--hard')
      ? 'git reset --hard discards work; use git stash or a new commit.'
      : null,
  (w) =>
    w[0] === 'git' && w.includes('clean') && w.some((t) => hasShortFlag(t, 'f'))
      ? 'git clean -f deletes untracked files irreversibly.'
      : null,
  (w) =>
    w[0] === 'git' && w.includes('config') && w.some((t) => t.toLowerCase() === 'core.hookspath')
      ? 'Changing core.hooksPath disables the git hooks.'
      : null,
  (w) =>
    w.includes('lefthook') && w.includes('uninstall') ? 'Uninstalling git hooks is not allowed.' : null,
  (w) =>
    ['npm', 'pnpm', 'yarn'].includes(w[0] ?? '') && w[1] === 'publish'
      ? 'Publishing packages is not part of this project.'
      : null,
  (w) =>
    w[0] === 'gh' && w[1] === 'repo' && w[2] === 'delete' ? 'Deleting repositories is not allowed.' : null,
  (w) =>
    w[0] === 'docker' &&
    w[1] === 'system' &&
    w[2] === 'prune' &&
    w.some((t) => ['-a', '--all', '--volumes'].includes(t))
      ? 'Aggressive docker prune affects other projects.'
      : null,
  evaluateProtectedShellWrite,
  evaluateRemoval,
];

function evaluateProtectedShellWrite(words) {
  const lower = words.map((t) => t.toLowerCase());
  const writes = lower.some(
    (t) => SHELL_WRITE_MARKERS.has(t) || t.startsWith('>') || t === '-i' || t.includes('writefile'),
  );
  if (!writes) return null;
  const target = words.map(normalize).find((t) => SHELL_PROTECTED.some((p) => t.includes(p)));
  return target
    ? `"${target}" is protected (dataset, lockfile or git internals); it cannot be rewritten or deleted from the shell either.`
    : null;
}

function recursiveRemovalTargets(words) {
  const cmd = (words[0] ?? '').toLowerCase();
  const args = words.slice(1);
  const recursive =
    (cmd === 'rm' && args.some((t) => hasShortFlag(t, 'r') || hasShortFlag(t, 'R'))) ||
    (cmd === 'remove-item' && args.some((t) => t.toLowerCase() === '-recurse')) ||
    (cmd === 'rmdir' && args.some((t) => t.toLowerCase() === '/s'));
  return recursive ? args.filter((t) => !t.startsWith('-') && t.toLowerCase() !== '/s').map(normalize) : null;
}

function isDisposable(target) {
  const lower = target.toLowerCase();
  if (SCRATCH_MARKERS.some((m) => lower.includes(m))) return true;
  return target.split('/').some((segment) => DISPOSABLE_DIRS.has(segment));
}

function evaluateRemoval(words) {
  const targets = recursiveRemovalTargets(words);
  if (targets === null) return null;
  if (targets.length === 0) return 'Recursive delete without an explicit target.';
  const unsafe = targets.find((t) => !isDisposable(t));
  return unsafe
    ? `Recursive delete of "${unsafe}" is blocked. Only build output, caches, reports and scratch dirs may be removed.`
    : null;
}

function evaluatePipeline(stages) {
  for (let i = 0; i + 1 < stages.length; i++) {
    const from = (stages[i]?.[0] ?? '').toLowerCase();
    const to = (stages[i + 1]?.[0] ?? '').toLowerCase();
    if (DOWNLOADERS.has(from) && INTERPRETERS.has(to))
      return 'Piping downloaded content into an interpreter is not allowed.';
  }
  return null;
}

/** @param {string} command */
export function evaluateShellCommand(command) {
  for (const stages of parse(String(command ?? ''))) {
    const piped = evaluatePipeline(stages);
    if (piped) return piped;
    for (const words of stages) {
      for (const rule of STAGE_RULES) {
        const reason = rule(words);
        if (reason) return reason;
      }
    }
  }
  return null;
}

/**
 * @param {string} filePath absolute or relative path being written
 * @param {string} projectRoot absolute project root
 */
export function evaluateFileTarget(filePath, projectRoot) {
  const abs = normalize(filePath);
  const root = normalize(projectRoot).replace(/\/$/, '');
  if (!abs.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null; // outside the repo: not our policy
  const rel = abs.slice(root.length + 1);
  const hit = PROTECTED_FILES.find((p) => p.test(rel));
  return hit ? `${rel}: ${hit.why}` : null;
}

/** @param {string} content text about to be written */
export function evaluateContent(content) {
  const text = String(content ?? '');
  const hit = SECRET_PATTERNS.find((p) => p.re.test(text));
  return hit ? `Content looks like it contains ${hit.what}. Secrets must never be committed.` : null;
}
