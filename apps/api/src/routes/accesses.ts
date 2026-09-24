import { AccessesQuerySchema, AccessesResponseSchema, ApiErrorSchema } from '@ow/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { Database } from '../db/database.js';
import type { TrackGeometry } from '../domain/geometry.js';
import { findAccesses } from '../services/accesses.js';
import type { DatasetInfo } from '../services/dataset.js';

interface Deps {
  db: Database;
  geometry: TrackGeometry;
  info: DatasetInfo;
  rateLimitPerMin: number;
}

export const accessRoutes: FastifyPluginCallbackZod<Deps> = (
  app,
  { db, geometry, info, rateLimitPerMin },
  done,
) => {
  app.get(
    '/accesses',
    {
      config: { rateLimit: { max: rateLimitPerMin, timeWindow: '1 minute' } },
      schema: {
        tags: ['accesses'],
        summary: 'Passes over a location',
        description: [
          'Every pass whose ground track enters the circle of `radiusKm` around (`lat`, `lon`) within the',
          'window (default: the whole dataset). Entry/exit times are computed analytically on the sphere.',
          'Each pass reports closest approach, maximum elevation, Sun elevation at the target (daylight),',
          'direction and local solar time. With `includePath=true` each pass also carries its clipped',
          'ground track (`path`) — off by default, as paths dominate the response size.',
        ].join('\n'),
        querystring: AccessesQuerySchema,
        response: { 200: AccessesResponseSchema, 400: ApiErrorSchema, 429: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const started = performance.now();
      const result = await findAccesses(db, geometry, info, request.query);
      reply.header('server-timing', `compute;dur=${(performance.now() - started).toFixed(1)}`);
      return result;
    },
  );
  done();
};
