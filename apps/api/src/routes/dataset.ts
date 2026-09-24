import { ApiErrorSchema, DatasetSchema } from '@ow/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { NotModifiedSchema, matchesIfNoneMatch } from '../http/conditional.js';
import { toDatasetResponse, type DatasetInfo } from '../services/dataset.js';

export const datasetRoutes: FastifyPluginCallbackZod<{ info: DatasetInfo; etag: string }> = (
  app,
  { info, etag },
  done,
) => {
  const body = toDatasetResponse(info);

  app.get(
    '/dataset',
    {
      schema: {
        tags: ['dataset'],
        summary: 'Dataset overview: time span, sampling step and the satellites it contains',
        response: { 200: DatasetSchema, 304: NotModifiedSchema, 429: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      reply.header('etag', etag).header('cache-control', 'public, max-age=300, stale-while-revalidate=86400');
      if (matchesIfNoneMatch(request.headers['if-none-match'], etag))
        return reply.status(304).send(undefined);
      return reply.send(body);
    },
  );
  done();
};
