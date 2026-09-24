/**
 * One error shape for every failure (the shared ApiError contract): validation issues are listed
 * field by field; server errors never leak internals (stack, SQL) — only a request id to correlate
 * with the logs.
 */
import { STATUS_CODES } from 'node:http';

import type { ApiError } from '@ow/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const body = (
  statusCode: number,
  message: string,
  requestId: string,
  issues?: ApiError['issues'],
): ApiError => ({
  statusCode,
  error: STATUS_CODES[statusCode] ?? 'Error',
  message,
  requestId,
  ...(issues ? { issues } : {}),
});

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((v) => ({
        // instancePath is the zod issue path ("/end"); empty for object-level issues.
        path: v.instancePath.replace(/^\//, '').replaceAll('/', '.') || '(request)',
        message: v.message ?? 'Invalid value',
      }));
      return reply.status(400).send(body(400, 'Invalid request parameters', request.id, issues));
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply.status(500).send(body(500, 'Something went wrong on our side.', request.id));
    }
    return reply.status(statusCode).send(body(statusCode, error.message, request.id));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send(body(404, `No route for ${request.method} ${request.url.split('?')[0] ?? ''}`, request.id)),
  );
}
