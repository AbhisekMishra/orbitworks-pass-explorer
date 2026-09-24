import { promisify } from 'node:util';
import zlib from 'node:zlib';

import {
  ApiErrorSchema,
  MAX_FILTERED_BINARY_SPAN_HOURS,
  MAX_GEOJSON_SPAN_HOURS,
  TRACK_CODEC_MEDIA_TYPE,
  TracksBinaryQuerySchema,
  TracksGeoJsonQuerySchema,
  TracksGeoJsonSchema,
} from '@ow/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { SegmentFilter } from '../db/types.js';
import type { TrackGeometry } from '../domain/geometry.js';
import { DYNAMIC_BROTLI_QUALITY, DYNAMIC_GZIP_LEVEL } from '../http/compression.js';
import { NotModifiedSchema, matchesIfNoneMatch } from '../http/conditional.js';
import { negotiateEncoding, type ContentCoding } from '../http/encoding.js';
import { HttpError } from '../http/errors.js';
import { resolveSatellites, type DatasetInfo } from '../services/dataset.js';
import type { LoadedArtifacts } from '../services/trackArtifacts.js';
import { encodeSegments, segmentsToGeoJson, selectSegments } from '../services/tracks.js';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

interface Deps {
  geometry: TrackGeometry;
  info: DatasetInfo;
  artifacts: LoadedArtifacts;
  rateLimitPerMin: number;
}

/** The data only changes on redeploy; the ETag makes revalidation a cheap 304 after that. */
const IMMUTABLE_CACHE = 'public, max-age=3600, stale-while-revalidate=86400';
const MS_PER_HOUR = 3_600_000;

/** Clamps the request to the dataset and tells whether it asks for everything anyway. */
function resolveWindow(
  info: DatasetInfo,
  q: { satellites?: string[]; start?: number; end?: number },
): { window: Required<SegmentFilter>; coversAll: boolean } {
  const satellites = resolveSatellites(info, q.satellites);
  const startMs = q.start === undefined ? info.startMs : Math.max(q.start, info.startMs);
  const endMs = q.end === undefined ? info.endMs : Math.min(q.end, info.endMs);
  const coversAll =
    satellites.length === info.satellites.length && startMs <= info.startMs && endMs >= info.endMs;
  return { window: { satellites, startMs, endMs }, coversAll };
}

function compress(coding: ContentCoding, body: Uint8Array): Promise<Buffer> | Buffer {
  if (coding === 'br') {
    return brotli(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY } });
  }
  if (coding === 'gzip') return gzip(body, { level: DYNAMIC_GZIP_LEVEL });
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength); // a view, not a copy
}

/** Content-Encoding only accompanies a body (never a 304). */
const withEncoding = <R extends { header(name: string, value: string): R }>(
  reply: R,
  coding: ContentCoding,
): R => (coding === 'identity' ? reply : reply.header('content-encoding', coding));

const precompressed = (artifacts: LoadedArtifacts, coding: ContentCoding): Buffer => {
  if (coding === 'br') return artifacts.brotli;
  if (coding === 'gzip') return artifacts.gzip;
  return artifacts.raw;
};

export const trackRoutes: FastifyPluginCallbackZod<Deps> = (
  app,
  { geometry, info, artifacts, rateLimitPerMin },
  done,
) => {
  const rateLimit = { max: rateLimitPerMin, timeWindow: '1 minute' };

  app.get(
    '/tracks',
    {
      config: { rateLimit },
      schema: {
        tags: ['tracks'],
        summary: 'Ground tracks as GeoJSON (for GIS tools)',
        description:
          'One LineString Feature per 1-minute segment, coordinates `[lon, lat, altKm]`. Requires a ' +
          `\`start\`/\`end\` window of at most ${MAX_GEOJSON_SPAN_HOURS} hours — use \`/tracks/binary\` for the whole dataset.`,
        querystring: TracksGeoJsonQuerySchema,
        response: { 200: TracksGeoJsonSchema, 400: ApiErrorSchema, 429: ApiErrorSchema },
      },
    },
    (request) => {
      const { window } = resolveWindow(info, request.query);
      return segmentsToGeoJson(geometry, selectSegments(geometry, window));
    },
  );

  app.get(
    '/tracks/binary',
    {
      config: { rateLimit },
      // Every body here is compressed by the route itself (precompressed artifact, or on demand):
      // the plugin would otherwise recompress identity responses on the fly.
      compress: false,
      schema: {
        tags: ['tracks'],
        summary: 'Ground tracks as a compact OWT1 binary stream (used by the web map)',
        description: [
          `Media type \`${TRACK_CODEC_MEDIA_TYPE}\`; decode with \`decodeTracks\` from \`@ow/shared\`.`,
          'Without filters (or with filters covering everything) this is the whole dataset',
          '(~0.5 MB brotli vs 59 MB GeoJSON), served precompressed with a strong ETag.',
          `Filtered slices are encoded on demand and limited to ${MAX_FILTERED_BINARY_SPAN_HOURS} hours: for more, download`,
          'the full stream once and filter locally. Vertex timestamps are implicit: startS + i·stepS.',
        ].join(' '),
        querystring: TracksBinaryQuerySchema,
        response: {
          // Buffers bypass Fastify's serializer; the schema documents the body and types `send`.
          200: z.instanceof(Buffer).describe(`OWT1 stream (${TRACK_CODEC_MEDIA_TYPE})`),
          304: NotModifiedSchema,
          400: ApiErrorSchema,
          406: ApiErrorSchema,
          429: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      // Negotiate first: error responses must not carry the cache headers set below.
      const coding = negotiateEncoding(request.headers['accept-encoding']);
      if (coding === null) throw new HttpError(406, 'No acceptable content encoding (br, gzip or identity)');
      const { window, coversAll } = resolveWindow(info, request.query);

      reply
        .type(TRACK_CODEC_MEDIA_TYPE)
        .header('cache-control', IMMUTABLE_CACHE)
        .header('vary', 'Accept-Encoding');
      if (coversAll) {
        reply.header('etag', artifacts.etag);
        if (matchesIfNoneMatch(request.headers['if-none-match'], artifacts.etag)) {
          return reply.status(304).send(undefined);
        }
        return withEncoding(reply, coding).send(precompressed(artifacts, coding));
      }
      if (window.endMs - window.startMs > MAX_FILTERED_BINARY_SPAN_HOURS * MS_PER_HOUR) {
        throw new HttpError(
          400,
          `Filtered slices are limited to ${MAX_FILTERED_BINARY_SPAN_HOURS} hours; download the full stream (no filters) and filter locally`,
        );
      }
      const raw = encodeSegments(geometry, selectSegments(geometry, window), info.stepS);
      const body = await compress(coding, raw);
      return withEncoding(reply, coding).send(body);
    },
  );
  done();
};
