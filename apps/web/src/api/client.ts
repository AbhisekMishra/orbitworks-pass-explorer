/**
 * Typed API access. Every response is validated against the shared zod contract, so a server/web
 * mismatch fails loudly at the boundary instead of as a confusing rendering bug.
 */
import { API_PREFIX, ApiErrorSchema } from '@ow/shared';
import type { z } from 'zod';

/** API origin: empty means same origin (dev proxy, nginx). Vercel sets the Railway origin. */
export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Absolute URL of an API route (absolute so the decode worker can fetch it too). */
export const apiUrl = (route: string): string =>
  new URL(`${API_BASE_URL}${API_PREFIX}${route}`, globalThis.location.href).toString();

export class ApiRequestError extends Error {
  override name = 'ApiRequestError';

  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** 5xx and network-level failures are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

/** Turns a non-2xx response into an ApiRequestError, using the API's error body when present. */
export async function errorFromResponse(res: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (proxy error page, empty body): fall back to the status text below.
  }
  const parsed = ApiErrorSchema.safeParse(body);
  return parsed.success
    ? new ApiRequestError(parsed.data.message, res.status, parsed.data.requestId)
    : new ApiRequestError(`Request failed (${res.status} ${res.statusText})`.trim(), res.status);
}

export async function getJson<T>(route: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(route), { headers: { accept: 'application/json' }, signal: signal ?? null });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiRequestError('The server could not be reached. Check your connection.', 0);
  }
  if (!res.ok) throw await errorFromResponse(res);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new ApiRequestError('The server sent an unexpected response.', res.status);
  return parsed.data;
}
