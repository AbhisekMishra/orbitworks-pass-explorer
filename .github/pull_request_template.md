## Summary

<!-- What changes and why. Link the phase of the build plan. -->

## Feature → tests

| Feature | Unit / integration | E2E |
| ------- | ------------------ | --- |
|         |                    |     |

## Definition of Done

- [ ] Unit tests for all new logic, including edge cases (bounds, antimeridian, empty, invalid input)
- [ ] Every user-facing feature has a Playwright E2E test
- [ ] `pnpm verify` green locally (format, lint, secrets, types, coverage gates, build, size, e2e)
- [ ] `/review` run with all 4 agents (code, security, QA, performance); no open Critical/High findings
- [ ] Docs updated (`README.md`, `docs/DECISIONS.md`) if behaviour or decisions changed

## Review notes

<!-- Findings intentionally not fixed, with justification. -->

## Performance

<!-- Payload, bundle, latency numbers when relevant. -->
