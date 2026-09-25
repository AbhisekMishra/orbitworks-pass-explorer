import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_ROOT, dataFiles, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies safe defaults (production unless told otherwise: fail-safe)', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 3000,
      CORS_ORIGINS: [],
      DATA_DIR: path.join(API_ROOT, 'data'),
      TRUST_PROXY_HOPS: 0,
      validateResponses: false,
    });
    expect(loadConfig({ NODE_ENV: 'development' }).validateResponses).toBe(true);
  });

  it('parses and validates values from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      CORS_ORIGINS: 'https://a.example, https://b.example ,',
      TRUST_PROXY_HOPS: '1',
      CLIENT_IP_HEADER: 'x-real-ip',
    });
    expect(config).toMatchObject({
      CLIENT_IP_HEADER: 'x-real-ip',
      PORT: 8080,
      CORS_ORIGINS: ['https://a.example', 'https://b.example'],
      TRUST_PROXY_HOPS: 1,
      validateResponses: false, // response validation costs CPU per request; off in production
    });
  });

  it.each([
    [{ PORT: 'eighty' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ CORS_ORIGINS: 'not a url' }, /CORS_ORIGINS/],
    [{ CORS_ORIGINS: 'https://app.example/' }, /bare origins/], // a trailing slash never matches Origin
    [{ CORS_ORIGINS: 'https://app.example/path' }, /bare origins/],
    [{ NODE_ENV: 'staging' }, /NODE_ENV/],
    [{ DUCKDB_POOL_SIZE: '0' }, /DUCKDB_POOL_SIZE/],
    [{ CLIENT_IP_HEADER: 'x-real-ip' }, /TRUST_PROXY_HOPS/], // spoofable without a proxy in front
    [{ CLIENT_IP_HEADER: 'X Real IP', TRUST_PROXY_HOPS: '1' }, /header name/],
  ])('fails fast with a readable message for %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe('dataFiles', () => {
  it('lays out every artifact inside the data directory', () => {
    const files = dataFiles('/srv/data');
    expect(Object.values(files).every((f) => f.replaceAll('\\', '/').startsWith('/srv/data/'))).toBe(true);
    expect(path.basename(files.database)).toBe('tracks.duckdb');
  });
});
