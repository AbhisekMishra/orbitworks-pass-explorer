/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadText } from './download';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('downloadText', () => {
  it('clicks a temporary link to an object URL, then revokes it', async () => {
    vi.useFakeTimers();
    const create = vi.fn((_blob: Blob) => 'blob:csv');
    const revoke = vi.fn();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    downloadText('passes.csv', 'a,b\r\n', 'text/csv');
    expect(click).toHaveBeenCalledOnce();
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('passes.csv');
    expect(link.href).toBe('blob:csv');
    expect(document.querySelector('a[download]')).toBeNull();
    const blob = create.mock.calls[0]![0];
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('a,b\r\n');
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:csv');
  });
});
