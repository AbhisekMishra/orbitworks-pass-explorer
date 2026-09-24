import fc from 'fast-check';

// Deterministic property tests (override with FC_SEED to explore other inputs).
fc.configureGlobal({ seed: Number(process.env.FC_SEED ?? 20_270_301) });
