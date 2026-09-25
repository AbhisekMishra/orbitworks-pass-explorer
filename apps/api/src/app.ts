import { randomUUID } from 'node:crypto';
import { constants as zlibConstants } from 'node:zlib';

import fastifyCompress from '@fastify/compress';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { API_PREFIX } from '@ow/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { Config } from './config.js';
import type { Database } from './db/database.js';
import type { TrackGeometry } from './domain/geometry.js';
import { DYNAMIC_BROTLI_QUALITY } from './http/compression.js';
import { clientIp } from './http/clientIp.js';
import { registerErrorHandling } from './http/errors.js';
import { accessRoutes } from './routes/accesses.js';
import { datasetRoutes } from './routes/dataset.js';
import { healthRoutes } from './routes/health.js';
import { trackRoutes } from './routes/tracks.js';
import type { DatasetInfo } from './services/dataset.js';
import type { LoadedArtifacts } from './services/trackArtifacts.js';

export interface AppDeps {
  config: Config;
  db: Database;
  geometry: TrackGeometry;
  info: DatasetInfo;
  artifacts: LoadedArtifacts;
  logger?: FastifyServerOptions['logger'];
}

/** Request ids from a trusted upstream are kept for log correlation, but only if well-formed. */
const REQUEST_ID = /^[\w-]{8,64}$/;
/** The API only serves GETs; anything with a real body is refused early. */
const BODY_LIMIT_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** Compressing tiny JSON bodies costs more than it saves. */
const COMPRESS_THRESHOLD_BYTES = 1024;

export async function buildApp({
  config,
  db,
  geometry,
  info,
  artifacts,
  logger = false,
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    // Trust exactly N proxy hops for X-Forwarded-For (proxy-addr semantics: hop 0 is the socket peer).
    trustProxy: (_address, hop) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // With a requestIdHeader Fastify would trust the incoming value verbatim and skip genReqId;
    // disabling it routes every id through the validation below (no log/header injection).
    requestIdHeader: false,
    genReqId: (req) => {
      const upstream = req.headers['x-request-id'];
      return typeof upstream === 'string' && REQUEST_ID.test(upstream) ? upstream : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  // Response validation catches contract drift in dev/test; production skips its per-request cost.
  app.setSerializerCompiler(
    config.validateResponses ? serializerCompiler : () => (data) => JSON.stringify(data),
  );
  registerErrorHandling(app);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(fastifyHelmet, {
    // The API returns JSON/binary; only the docs page is HTML and it brings its own CSP.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: config.CORS_ORIGINS.length > 0 ? 'cross-origin' : 'same-origin' },
  });
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    methods: ['GET', 'HEAD'],
    exposedHeaders: ['etag', 'server-timing', 'x-request-id'],
    maxAge: 600,
  });
  await app.register(fastifyRateLimit, {
    max: config.RATE_LIMIT_GLOBAL_PER_MIN,
    timeWindow: '1 minute',
    // Per client, however the proxy in front passes the client address (http/clientIp.ts).
    keyGenerator: (request) => clientIp(request, config.CLIENT_IP_HEADER),
  });
  await app.register(fastifyCompress, {
    encodings: ['br', 'gzip'],
    threshold: COMPRESS_THRESHOLD_BYTES,
    brotliOptions: {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY },
    },
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Orbitworks Pass Explorer API',
        version: '1.0.0',
        description: `Satellite ground tracks and passes over locations for the ${info.name} constellation.`,
      },
      tags: [
        { name: 'dataset', description: 'What the data covers' },
        { name: 'tracks', description: 'Ground tracks (binary for the map, GeoJSON for tools)' },
        { name: 'accesses', description: 'Passes over a point within a radius' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/api/docs', staticCSP: true });

  await app.register(healthRoutes, { db });
  await app.register(
    async (api) => {
      await api.register(datasetRoutes, { info, etag: artifacts.etag });
      await api.register(trackRoutes, {
        geometry,
        info,
        artifacts,
        rateLimitPerMin: config.RATE_LIMIT_TRACKS_PER_MIN,
      });
      await api.register(accessRoutes, {
        db,
        geometry,
        info,
        rateLimitPerMin: config.RATE_LIMIT_ACCESSES_PER_MIN,
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
