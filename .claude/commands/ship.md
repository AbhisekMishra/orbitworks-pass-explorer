---
description: Ship the current phase — full gate, multi-agent review, conventional commit, push, PR, and watch CI to green
argument-hint: '<short summary of the change>'
---

Ship the current work: $ARGUMENTS

1. **Branch**: if on `main`, create a branch `<type>/<scope>-<slug>` (for example `feat/api-accesses`).
2. **Gate**: run `/verify` (full). Everything must be green.
3. **Review**: run `/review`. Every Critical/High finding must be fixed, then run `/verify` again.
4. **Commit**: use Conventional Commits with a scope from `commitlint.config.js`. Group logically and
   write the _why_ in the body. Never use `--no-verify`; the pre-commit and pre-push hooks must run.
5. **Push and PR**: `git push -u origin HEAD`, then
   `gh pr create --fill --body-file <generated body>`. The body contains:
   - a summary and the feature → tests list,
   - the review verdicts (4 agents) and the "Review notes",
   - performance numbers when relevant.
6. **CI**: watch the checks (`gh pr checks --watch`). On a failure, read the logs
   (`gh run view --log-failed`), fix the root cause, commit and push. Never skip or disable a check.
7. When all checks are green, squash-merge (`gh pr merge --squash --delete-branch`) and pull `main`.
8. Report the PR URL, the CI status, and anything deferred.
