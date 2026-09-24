import { describe, expect, it } from 'vitest';

import { sameItems } from './equality';

describe('sameItems', () => {
  it('compares tuples item by item, by identity', () => {
    const o = {};
    expect(sameItems([1, o, 'a'], [1, o, 'a'])).toBe(true);
    expect(sameItems([1, {}], [1, {}])).toBe(false);
    expect(sameItems([1], [1, 2])).toBe(false);
  });
});
