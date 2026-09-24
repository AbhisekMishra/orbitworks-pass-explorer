import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiRequestError, apiUrl, errorFromResponse, getJson } from './client';

const Schema = z.object({ ok: z.literal(true) });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('location', { href: 'https://app.example/explore?x=1' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiUrl', () => {
  it('resolves routes under the API prefix against the page origin by default', () => {
    expect(apiUrl('/dataset')).toBe('https://app.example/api/v1/dataset');
  });
});

describe('getJson', () => {
  it('returns the validated body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true })));
    await expect(getJson('/x', Schema)).resolves.toEqual({ ok: true });
  });

  it('rejects a body that breaks the contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: 'yes' })));
    await expect(getJson('/x', Schema)).rejects.toThrow('unexpected response');
  });

  it('surfaces the API error message and request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(
            { statusCode: 400, error: 'Bad Request', message: 'radiusKm too large', requestId: 'r-1' },
            400,
          ),
        ),
    );
    const err: unknown = await getJson('/x', Schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      message: 'radiusKm too large',
      status: 400,
      requestId: 'r-1',
      retryable: false,
    });
  });

  it('reports network failures as retryable status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(getJson('/x', Schema)).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it('rethrows aborts untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(getJson('/x', Schema, controller.signal)).rejects.toBe(abort);
  });
});

describe('errorFromResponse', () => {
  it('falls back to the status line for non-JSON bodies', async () => {
    const err = await errorFromResponse(
      new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    expect(err).toMatchObject({ message: 'Request failed (502 Bad Gateway)', status: 502, retryable: true });
  });

  it('treats rate limiting as retryable', async () => {
    const err = await errorFromResponse(new Response('', { status: 429 }));
    expect(err.retryable).toBe(true);
  });
});
