export type ContentCoding = 'br' | 'gzip' | 'identity';

/** Server preference: brotli (0.52 MB), then gzip (0.90 MB), then identity (2.1 MB). */
const PREFERENCE: readonly ContentCoding[] = ['br', 'gzip', 'identity'];
/** Below the smallest q a client can express (q has at most 3 decimals: 0.001). */
const IDENTITY_FALLBACK_WEIGHT = 0.0001;

/**
 * Picks the best precompressed representation for an Accept-Encoding header (RFC 9110 §12.5.3):
 * codings with q=0 are refused, "*" covers codings not listed, and identity is acceptable unless
 * explicitly refused. Returns null when nothing acceptable is available (→ 406).
 */
export function negotiateEncoding(header: string | undefined): ContentCoding | null {
  const q = new Map<string, number>();
  for (const part of (header ?? '').split(',')) {
    const [rawName = '', ...params] = part.toLowerCase().split(';');
    const name = rawName.trim(); // RFC 9110 allows optional whitespace around ';'
    if (!name) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const value = qParam ? Number(qParam.slice(2)) : 1;
    q.set(name, Number.isFinite(value) ? value : 0);
  }
  const wildcard = q.get('*');
  const weight = (coding: ContentCoding): number => {
    const explicit = q.get(coding);
    if (explicit !== undefined) return explicit;
    // Unlisted identity is acceptable (unless "*;q=0") but only as a last resort: it must never
    // beat a compression the client asked for, even with a low q (e.g. "br;q=0.5" → br, not 2 MB).
    if (coding === 'identity') return wildcard === 0 ? 0 : IDENTITY_FALLBACK_WEIGHT;
    return wildcard ?? 0;
  };

  let best: ContentCoding | null = null;
  for (const coding of PREFERENCE) {
    if (weight(coding) > 0 && (best === null || weight(coding) > weight(best))) best = coding;
  }
  return best;
}
