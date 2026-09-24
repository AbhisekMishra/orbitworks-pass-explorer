import fc from 'fast-check';

// Deterministic property tests: CI always explores the same inputs, and any failure is replayable.
// Explore new inputs locally with e.g. `FC_SEED=123 pnpm test` (fast-check prints the seed it used).
declare const process: { env: Record<string, string | undefined> };
const DEFAULT_SEED = 20_270_301;

fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? DEFAULT_SEED) });
