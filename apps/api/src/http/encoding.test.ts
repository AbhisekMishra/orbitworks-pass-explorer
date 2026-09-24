import { describe, expect, it } from 'vitest';

import { negotiateEncoding } from './encoding.js';

describe('negotiateEncoding', () => {
  it.each([
    [undefined, 'identity'], // no header: only identity is guaranteed to be understood
    ['', 'identity'],
    ['gzip, deflate, br, zstd', 'br'],
    ['gzip', 'gzip'],
    ['GZIP', 'gzip'],
    ['br;q=0.5, gzip;q=0.8', 'gzip'], // higher quality value wins
    ['br;q=0.001', 'br'], // any listed compression beats the implicit identity fallback
    ['gzip;q=0.5, identity', 'identity'], // …but an explicitly preferred identity wins
    ['gzip;q=1, br;q=1', 'br'], // ties go to the smaller representation
    ['*', 'br'],
    ['br;q=0, *', 'gzip'],
    ['br;q=abc', 'identity'], // malformed q counts as refused
    ['deflate', 'identity'],
    ['identity', 'identity'],
    ['br ;q=0, *', 'gzip'], // optional whitespace before ';' (RFC 9110)
  ] as const)('%j → %s', (header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected);
  });

  it.each([['identity;q=0'], ['*;q=0'], ['gzip;q=0, identity;q=0'], ['identity ; q=0']])(
    'returns null when nothing we have is acceptable (%s)',
    (header) => {
      expect(negotiateEncoding(header)).toBeNull();
    },
  );
});
