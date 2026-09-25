# How this project was built with a coding agent

The brief allows coding agents and asks for the instructions and strategy to be documented. This
project was built with **Claude Code** (Anthropic, Opus model) driving the terminal, the browser
and the GitHub, Railway and Vercel APIs. A human, the project owner, set the goals and made the
product and budget decisions. This page describes the strategy, the harness that kept the agent
honest, the prompts, and what worked and what did not, with evidence from the PRs.

## Strategy

1. **Plan before code.** The session began in plan mode. The agent analysed the dataset first:
   - no time gaps;
   - consecutive segments share endpoints;
   - about 113 antimeridian crossings per satellite;
   - `local_time_h` is unwrapped;
   - the orbits are sun-synchronous.

   It then wrote a build plan: architecture, a testing matrix mapping every feature to unit and E2E
   tests, performance budgets, and seven phases. The owner approved the plan and chose the public
   repository, the full pre-push gate and the four review agents.

2. **Guardrails first.** Phase 0 built the harness below before any feature code. Each hook was
   proven with a deliberately failing sample. Every later line of code was written under it.
3. **One phase, one branch, one PR.** Each phase followed the same loop:
   - implement with tests;
   - `pnpm verify` green locally;
   - `/review` with four agents in parallel;
   - fix every Critical/High finding and the cheap Mediums;
   - open a PR whose body lists what was deliberately not done ("Review notes");
   - CI green;
   - the owner says "merge", and the next phase starts.

   The phases were: harness (P0), shared core (#1), API (#2), map explorer (#3), passes over a
   place (#4), performance gates (#5), Docker and deploy (#6), a production fix found while
   verifying the deploy (#9), and this documentation with a final whole-repository review (Phase 7).

4. **Measure, then decide.** Design choices went into `docs/DECISIONS.md` with the numbers that
   decided them. Several of those numbers overturned the first plan:
   - dropping DuckDB's R-tree (ADR-003);
   - dropping the pass paths from the API response (ADR-004);
   - replacing a Lighthouse score target with per-metric budgets (ADR-010).

## The harness

Everything lives in the repository (`CLAUDE.md`, `.claude/`, `lefthook.yml`, `.github/`), so a
reviewer can see and run exactly what constrained the agent. The harness guardrails have their own
tests (`tests/harness`, 73 tests).

**`CLAUDE.md`** gives the agent the stack, commands and conventions:

- no `any`, and no casts on external data;
- UTC everywhere;
- units in names;
- parameterized SQL only;
- nothing on the web hot path.

It also sets a Definition of Done:

- unit tests for new logic, including edge cases;
- an E2E test for every user-facing feature;
- `pnpm verify` green;
- a four-agent review with no open Critical/High findings;
- docs updated.

It carries the performance budgets and a testing matrix that must stay in sync with the code.

**Hooks** (`.claude/settings.json`, Node scripts so they run on Windows and Linux):

| Hook               | When                    | What it does                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-bash.mjs`   | before every shell call | Blocks `--no-verify` and `commit -n`, force-push, `reset --hard`, `clean -f`, changing `core.hooksPath`, uninstalling git hooks, recursive deletes outside build output, piping a download into an interpreter, and any shell write to the dataset, the lockfile or `.git`. |
| `guard-files.mjs`  | before every file edit  | Blocks writes to `data/`, `.env*`, `.git/` and the lockfile, and content that looks like a secret (private keys, AWS, GitHub, Slack, Google and API keys).                                                                                                                  |
| `lint-file.mjs`    | after every file edit   | Runs Prettier on the file, then ESLint or Stylelint. Errors go straight back to the agent, which must fix them before moving on.                                                                                                                                            |
| `quality-gate.mjs` | when the agent stops    | Runs the typecheck and the tests related to the changed files. The agent cannot end its turn with a red tree. A loop guard releases the block after three failed attempts, so a stuck situation is escalated to the human instead of looping forever.                       |

**Review agents** (`.claude/agents/`) are read-only, run in parallel, and each returns
severity-ranked findings with file and line:

- `code-reviewer`: correctness, smells, conventions;
- `security-reviewer`: input validation, SQL, HTTP hardening, Docker, supply chain;
- `qa-auditor`: maps each feature to its tests and finds untested branches;
- `perf-auditor`: budgets, the render hot path, caching.

**Commands** (`.claude/commands/`):

- `/verify` runs the full gate.
- `/review` runs the four agents and consolidates their findings. Every Critical/High finding must
  be verified by reading the code before it is fixed or dismissed.
- `/ship` runs gate, review, commit, PR and CI.

**Outside the agent**, the same rules apply to any contributor:

- lefthook runs Prettier, ESLint, Stylelint and secretlint on commit, and the full gate on push;
- commitlint enforces Conventional Commits;
- CI repeats everything, adds CodeQL, dependency review, gitleaks, Trivy and hadolint, and requires
  every review thread to be resolved before merging.

## Prompts

The owner's instructions were deliberately short and outcome-focused, with detail pushed into
`CLAUDE.md` and the plan:

- "merge it and go ahead with phase 4"
- "Vercel for web, Railway for API — go ahead with phase 2"
- "yes merge and deploy"

When a decision belonged to the owner, the agent asked a multiple-choice question and gave a
recommendation instead of deciding alone. Examples:

- the hosting split;
- whether to gate on the Lighthouse score or on per-metric budgets;
- whether to set web budgets from the CI runner when the first CI run missed them.

Review agents are launched with a fixed brief. This is the one used for the QA audit of Phase 5:

> You are the project's `qa-auditor`. First read and follow exactly the role definition and output
> format in `.claude/agents/qa-auditor.md`, and the conventions, Definition of Done and testing
> matrix in `CLAUDE.md`. You are READ-ONLY. Change set: … Audit: test coverage of the new logic and
> edge cases, whether the new E2E assertion is meaningful and robust (flakiness risk under
> SwiftShader in CI), whether the testing matrix is in sync, and whether any user-facing feature
> from earlier phases still lacks E2E coverage.

## What the harness caught

These are real findings from the PRs; most would have shipped without the harness.

| Found by                  | What                                                                                                                                                                   | Outcome                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / property tests     | Unwrapped longitudes cast to Float32 on the GPU lost about 217 m of precision                                                                                          | Longitudes wrapped before upload (ADR-002)                                                                                                               |
| Review (code, security)   | A decoder that allocated before validating the header; a content-negotiation bug that served 2 MB uncompressed; request-id sanitising that never ran                   | Fixed in the API phase (ADR-007)                                                                                                                         |
| Measurement               | DuckDB's spatial R-tree costing up to 28 ms on large circles                                                                                                           | Replaced by a numeric scan at about 3 ms (ADR-003)                                                                                                       |
| E2E (Phase 4)             | Pin, radius and dates were not written to the shareable URL: an earlier edit had silently failed                                                                       | Fixed, with a regression test                                                                                                                            |
| Lighthouse gate (Phase 5) | Score about 65 against a target of 85. Profiling showed the blocking time was WebGL start-up inside MapLibre and deck.gl                                               | Async shader linking tried, measured and rejected; budgets moved to per-metric, decided by the owner (ADR-010)                                           |
| Mutation test (Phase 5)   | A new E2E assertion still passed with the feature disabled                                                                                                             | The async-shader change was dropped rather than shipped untested                                                                                         |
| CodeQL (Phase 5)          | URL checks matching hosts by substring                                                                                                                                 | Parsed hostname and path matching, with spoofing tests                                                                                                   |
| CI history (Phase 5)      | 7–9 E2E tests per run passed only on retry, keeping the job green; `main` had been red since Phase 4                                                                   | Serial E2E on CI, full Chromium, and `failOnFlakyTests` so a retry can no longer hide a flaky test                                                       |
| Browser smoke (Phase 6)   | Zod's JIT feature probe (`Function('')`) violated the production CSP. A manual browser check had missed it                                                             | Zod runs jitless; the smoke test runs on every PR and after every deploy                                                                                 |
| Trivy (Phase 6)           | 63 fixable HIGH/CRITICAL vulnerabilities in the web image and 6 in the API image (end-of-life base images)                                                             | Current, digest-pinned bases; 0 remaining                                                                                                                |
| Security review (Phase 6) | The CI job running a third-party scanner shared a build cache with the release workflow                                                                                | Separate release cache; release only after CI passes                                                                                                     |
| Deploy check (after #6)   | On Railway, rate limits keyed on the edge node, not the client (the client is in `X-Real-IP`)                                                                          | #9: configurable client-IP header, checked live against spoofing                                                                                         |
| Final review (Phase 7)    | On the live API, 2,500 km queries at the poles took 48–83 ms of server compute, over the 60 ms budget. The CI p95, over pins spread across the sphere, hid this tail   | Pass engine keeps only the pieces a summary needs and formats timestamps without a `Date`: polar geometry 13.2 → 9.0 ms; the live numbers are documented |
| Final review (Phase 7)    | Docs claims checked against the code: a few were broader than the tests ("zero network" where only API requests are counted, one E2E test that did not check playback) | Wording corrected; the missing assertions added to the tests rather than the claims softened                                                             |

## What did not work, and what changed

- **Retries hid flaky tests for two phases.** The CI job was green, so nobody looked. The lesson:
  a gate that tolerates retries is not a gate. `failOnFlakyTests` is now on.
- **A laptop is not the CI runner.** The first web budgets came from a laptop. The CI runner
  renders WebGL in software about twice as slowly, and the first CI run missed two budgets. The
  budgets now come from CI (ADR-010), a change the owner approved rather than a quiet threshold
  bump.
- **Manual checks are not tests.** The strict CSP looked fine in a manual browser check but
  violated `eval` on every load. Only an automated check (listening for `securitypolicyviolation`
  events) found it.
- **Shell quoting on Windows.** Heredocs and `sed` in Git Bash mangled backslashes and `$1` in
  multi-line edits. The agent switched to writing small Node edit scripts to a temp file, each
  failing loudly when its anchor text is missing, so edits are never applied silently to the wrong
  place.
- **The guardrails occasionally blocked the agent**, as designed: for example `curl … | node` to
  parse a download, and a shell write under a path containing `data/`. Each time the agent took the
  safe route (download to a file first; rename the `src/data` folder) instead of weakening a rule.
- **Session and usage limits** interrupted two review rounds. The reviews were re-run from scratch
  rather than skipped.

## Reproducing the workflow

Open the repository in Claude Code. `CLAUDE.md` and `.claude/` load automatically: the hooks are
active, and the commands are available.

- `/verify`: the full local gate (the same as `pnpm verify` and the pre-push hook).
- `/review`: the four review agents on the current change set.
- `/ship <summary>`: gate, review, commit, PR and CI, for one phase.
