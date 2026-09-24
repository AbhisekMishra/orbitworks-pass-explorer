/**
 * API URLs, zod-free so the decode worker can import them too. The API origin is build-time
 * configuration: empty means same origin (dev proxy, nginx); Vercel sets the Railway origin.
 */
import { API_PREFIX } from '@ow/shared';

export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Absolute URL of an API route (resolved against the page, or the worker script, location). */
export const apiUrl = (route: string): string =>
  new URL(`${API_BASE_URL}${API_PREFIX}${route}`, globalThis.location.href).toString();

/** The OWT1 track stream: fetched by the decode worker only. */
export const TRACKS_BINARY_ROUTE = '/tracks/binary';
