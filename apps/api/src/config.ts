/**
 * Runtime configuration, validated once at startup. Invalid configuration fails fast with a clear
 * message instead of surfacing later as a confusing runtime error.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** apps/api (works from src/ under tsx and from dist/ after bundling: both are one level down). */
export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

const csv = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      // canParse: zod still runs refinements after z.url() fails; new URL() would throw.
      z.url().refine((v) => URL.canParse(v) && new URL(v).origin === v, {
        message: 'Use bare origins like https://app.example (no path or trailing slash)',
      }),
    ),
  );

const EnvSchema = z
  .object({
    /** Defaults to production (fail-safe); `pnpm dev` sets development via dev.env. */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Directory holding tracks.duckdb and the precompressed track artifacts (built by `pnpm seed`). */
    DATA_DIR: z.string().default(path.join(API_ROOT, 'data')),
    DUCKDB_POOL_SIZE: z.coerce.number().int().min(1).max(32).default(4),
    /** Browser origins allowed to call the API cross-origin (comma-separated). Empty = same-origin only. */
    CORS_ORIGINS: csv.default([]),
    /** Requests per minute per client on the expensive /accesses route. */
    RATE_LIMIT_ACCESSES_PER_MIN: z.coerce.number().int().min(1).default(120),
    /** Requests per minute per client on /tracks and /tracks/binary (the web app needs one). */
    RATE_LIMIT_TRACKS_PER_MIN: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).default(600),
    /** Number of proxy hops to trust for X-Forwarded-For (nginx in docker compose: one). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    /**
     * Header in which the trusted proxy passes the client address, when it does not use
     * X-Forwarded-For (Railway: `x-real-ip`). Keys the rate limits; see http/clientIp.ts.
     */
    CLIENT_IP_HEADER: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, 'A lowercase header name, e.g. x-real-ip')
      .optional(),
  })
  .refine((env) => !env.CLIENT_IP_HEADER || env.TRUST_PROXY_HOPS > 0, {
    // Without a proxy in front that overwrites it, the header is whatever the client sends.
    message: 'CLIENT_IP_HEADER needs TRUST_PROXY_HOPS ≥ 1: only a trusted proxy can set it',
    path: ['CLIENT_IP_HEADER'],
  });

export type Config = z.infer<typeof EnvSchema> & {
  /** Validate every response against the shared contract (dev/test only: it costs CPU per request). */
  validateResponses: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return { ...parsed.data, validateResponses: parsed.data.NODE_ENV !== 'production' };
}

export const dataFiles = (dataDir: string) => ({
  database: path.join(dataDir, 'tracks.duckdb'),
  tracks: path.join(dataDir, 'tracks.owt'),
  tracksBrotli: path.join(dataDir, 'tracks.owt.br'),
  tracksGzip: path.join(dataDir, 'tracks.owt.gz'),
  manifest: path.join(dataDir, 'manifest.json'),
});
