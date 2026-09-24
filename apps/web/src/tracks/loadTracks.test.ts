import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../api/client';

import { loadTracks } from './loadTracks';
import type { WorkerResponse } from './protocol';

/** The most recently created worker double. */
let last: FakeWorker | undefined;

/** Minimal Worker double: records posted messages and lets the test emit events. */
class FakeWorker extends EventTarget {
  terminated = false;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test needs the instance loadTracks creates
    last = this;
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: WorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const worker = () => last!;
const tracks = { t0S: 0, t1S: 0, stepS: 10, tracks: [] };
const stats = { rawBytes: 1, transferBytes: null, fetchMs: 1, decodeMs: 1 };

beforeEach(() => {
  last = undefined;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadTracks', () => {
  it('starts a module worker and resolves with the decoded tracks', async () => {
    const promise = loadTracks();
    expect(worker().options).toMatchObject({ type: 'module' });
    expect(worker().url.pathname).toMatch(/tracks\.worker/);
    worker().reply({ type: 'done', tracks, stats });
    await expect(promise).resolves.toEqual({ tracks, stats });
    expect(worker().terminated).toBe(true);
  });

  it('rejects with an ApiRequestError carrying the status', async () => {
    const promise = loadTracks();
    worker().reply({ type: 'error', status: 503, message: 'down' });
    const err: unknown = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 503, message: 'down', retryable: true });
    expect(worker().terminated).toBe(true);
  });

  it('rejects when the worker cannot start', async () => {
    const promise = loadTracks();
    // Browsers fire an ErrorEvent; its (empty) message is all loadTracks reads.
    worker().dispatchEvent(Object.assign(new Event('error'), { message: '' }));
    await expect(promise).rejects.toThrow('failed to start');
    expect(worker().terminated).toBe(true);
  });

  it('terminates the worker when aborted', async () => {
    const controller = new AbortController();
    const promise = loadTracks(controller.signal);
    controller.abort(new Error('navigated away'));
    await expect(promise).rejects.toThrow('navigated away');
    expect(worker().terminated).toBe(true);
    // A late reply after the abort changes nothing.
    worker().reply({ type: 'done', tracks, stats });
  });

  it('uses a DOMException when aborted without an Error reason', async () => {
    const controller = new AbortController();
    const promise = loadTracks(controller.signal);
    controller.abort('why');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
