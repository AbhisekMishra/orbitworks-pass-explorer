---
description: Run the full local quality gate (format, lint, secrets, types, tests + coverage, build, size budgets, E2E)
argument-hint: '[--fast]'
---

Run the project quality gate and make it green.

1. Run `pnpm verify $ARGUMENTS` (`--fast` skips build, size and E2E).
2. If a step fails, find the **root cause** and fix it in source. Never weaken a check: don't disable
   lint rules inline without a written justification, don't lower thresholds, don't skip or `.only`
   tests, and don't bypass hooks.
3. Re-run until the whole gate is green.
4. Report each step's result and the timing summary. If something can't be fixed, say exactly what
   is failing and why. Never report success on a red gate.
