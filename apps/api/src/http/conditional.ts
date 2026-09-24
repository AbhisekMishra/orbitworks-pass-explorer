import { z } from 'zod';

/** 304 responses carry no body; declared so the docs and the reply typing are honest. */
export const NotModifiedSchema = z.undefined().describe('Not modified: the cached copy (ETag) is current');

/**
 * RFC 9110 §13.1.2 If-None-Match: a list of entity tags (or "*"), compared weakly — a W/ prefix
 * added by an intermediary must still match our strong tag.
 */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
}
