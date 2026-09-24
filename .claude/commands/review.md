---
description: Multi-agent review of the current change set (code quality, security, QA, performance) in parallel
argument-hint: '[base-ref, default main]'
---

Review the current change set with the four project review agents.

1. Determine the scope: `git diff ${ARGUMENTS:-main}...HEAD --stat` plus uncommitted changes
   (`git status --short`). If both are empty, review the whole repository.
2. Launch **in parallel, in a single message**, the agents `code-reviewer`, `security-reviewer`,
   `qa-auditor` and `perf-auditor`. Give each one:
   - the base ref and the list of changed files,
   - a short summary of what the change is meant to do,
   - a reminder that it is read-only and must use its strict output format.
3. Consolidate the reports:
   - Merge duplicate findings and keep the highest severity.
   - **Verify every Critical/High finding yourself** by reading the code. Drop false positives and
     say why.
   - Produce one table: | # | Severity | Area | File:line | Finding | Action |
4. Fix all verified Critical and High findings, and Medium ones when the fix is cheap and safe. Then
   run `pnpm verify:fast`.
5. Record anything intentionally not fixed (with a justification) under "Review notes" in the PR
   description.
6. Finish with the verdict: `READY TO SHIP` only if no Critical/High findings remain open.
