import { describe, expect, it } from 'vitest';

import { accessesPath, accessesQuery, type AccessRequest } from './accesses';

const T0 = Date.UTC(2027, 2, 1) / 1000;
const r: AccessRequest = {
  lat: 24.4539,
  lon: 54.37731234,
  radiusKm: 400,
  startS: T0,
  endS: T0 + 7 * 86_400,
  satellites: null,
  daylightOnly: false,
};

describe('accessesPath', () => {
  it('builds the query with UTC instants and rounded coordinates, omitting defaults', () => {
    expect(accessesPath(r)).toBe(
      '/accesses?lat=24.45390&lon=54.37731&radiusKm=400&start=2027-03-01T00%3A00%3A00Z&end=2027-03-08T00%3A00%3A00Z',
    );
  });

  it('adds the satellite filter and the daylight flag when set', () => {
    const path = accessesPath({ ...r, satellites: ['YAM20', 'YAM25'], daylightOnly: true });
    expect(path).toContain('&satellites=YAM20%2CYAM25');
    expect(path).toContain('&daylightOnly=true');
  });

  it('keys the cache on the whole request', () => {
    expect(accessesQuery(r).queryKey).toEqual(['accesses', r]);
  });
});
