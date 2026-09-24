import { describe, expect, it } from 'vitest';

import { matchesIfNoneMatch } from './conditional.js';

const ETAG = '"abc123"';

describe('matchesIfNoneMatch', () => {
  it.each([
    [ETAG, true],
    [`W/${ETAG}`, true], // weak comparison: an intermediary may weaken our strong tag
    [`"x", ${ETAG}`, true],
    [` "x" ,W/${ETAG} `, true],
    ['*', true],
    ['"abc1234"', false],
    ['"x", "y"', false],
    ['', false],
    [undefined, false],
  ])('%j → %s', (header, expected) => {
    expect(matchesIfNoneMatch(header, ETAG)).toBe(expected);
  });
});
