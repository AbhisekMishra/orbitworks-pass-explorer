import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Database } from '../db/database.js';

const Status = z.object({ status: z.string() });

/**
 * Liveness (process is up) and readiness (DuckDB answers) probes for Docker/Railway. Probes run
 * every few seconds, so they are exempt from rate limiting and only logged when something is wrong.
 */
export const healthRoutes: FastifyPluginCallbackZod<{ db: Database }> = (app, { db }, done) => {
  app.get(
    '/healthz',
    { config: { rateLimit: false }, logLevel: 'warn', schema: { hide: true, response: { 200: Status } } },
    () => ({ status: 'ok' }),
  );

  app.get(
    '/readyz',
    {
      config: { rateLimit: false },
      logLevel: 'warn',
      schema: { hide: true, response: { 200: Status, 503: Status } },
    },
    async (request, reply) => {
      try {
        await db.ping();
        return { status: 'ready' };
      } catch (err) {
        request.log.error({ err }, 'Readiness check failed');
        return reply.status(503).send({ status: 'unavailable' });
      }
    },
  );
  done();
};
