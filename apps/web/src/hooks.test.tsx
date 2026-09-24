/** @vitest-environment jsdom */
import { act, render, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_FRAME_S, usePlayback } from './features/timeline/usePlayback';
import { useElementWidth } from './lib/useElementWidth';
import { handleShortcutKey, useShortcuts } from './lib/useShortcuts';
import { appStore } from './state/store';
import { URL_WRITE_DELAY_MS, urlFor, useUrlSync } from './state/useUrlSync';
import { H, T0, resetStore } from './testing/fixtures';

const state = () => appStore.getState();
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useShortcuts', () => {
  it('dispatches every shortcut to the store', () => {
    renderHook(useShortcuts);
    press({ key: '2', code: 'Digit2' });
    expect([...state().hidden]).toEqual(['YAM21']);
    press({ key: '@', code: 'Digit3', shiftKey: true });
    expect([...state().hidden]).toEqual(['YAM20', 'YAM21']);
    press({ key: 'a' });
    expect(state().hidden.size).toBe(0);
    press({ key: '9', code: 'Digit9' }); // no 9th satellite: ignored
    expect(state().hidden.size).toBe(0);
    press({ key: 'ArrowRight' });
    expect(state().timeWindow.startS).toBeCloseTo(T0 + 0.6 * H, 6);
    press({ key: 'g' });
    expect(state().projection).toBe('mercator');
    const space = press({ key: ' ' });
    expect(space.defaultPrevented).toBe(true);
    expect(state().playing).toBe(true);
    state().setPin({ lat: 1, lon: 2 });
    press({ key: 'Escape' });
    expect(state().access.pin).toBeNull();
    press({ key: '?' });
    expect(state().helpOpen).toBe(true);
  });

  it('leaves the keyboard to the help dialog and to text fields', () => {
    renderHook(useShortcuts);
    const input = document.createElement('input');
    document.body.append(input);
    expect(press({ key: 'a' }, input).defaultPrevented).toBe(false);
    input.remove();
    state().setHelpOpen(true);
    const event = new KeyboardEvent('keydown', { key: 'g' });
    expect(handleShortcutKey(event)).toBe(false);
    expect(state().projection).toBe('globe');
  });

  it('ignores events without an element target', () => {
    const event = new KeyboardEvent('keydown', { key: 'x' });
    expect(handleShortcutKey(event)).toBe(false);
  });
});

describe('useUrlSync', () => {
  it('writes the shareable state after a short delay, never while playing', () => {
    vi.useFakeTimers();
    const replace = vi.spyOn(window.history, 'replaceState');
    renderHook(useUrlSync);
    act(() => {
      state().toggleSatellite('YAM21');
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(URL_WRITE_DELAY_MS);
    });
    expect(window.location.search).toBe('?sats=YAM20,YAM22');

    act(() => {
      state().setPlaying(true);
      state().tick(1);
      vi.advanceTimersByTime(URL_WRITE_DELAY_MS);
    });
    expect(window.location.search).toBe('?sats=YAM20,YAM22');
    act(() => {
      state().setPlaying(false);
      vi.advanceTimersByTime(URL_WRITE_DELAY_MS);
    });
    expect(window.location.search).toContain('from=');
    const writes = replace.mock.calls.length;
    act(() => {
      // Same window, new object: the subscription fires but the URL would not change.
      state().setWindow({ ...state().timeWindow });
      state().setHover(null);
      vi.advanceTimersByTime(URL_WRITE_DELAY_MS);
    });
    // Unchanged URL: no redundant history write.
    expect(replace.mock.calls).toHaveLength(writes);
    window.history.replaceState(null, '', '/');
  });

  it('writes the accesses pin and filters, and drops them with the pin', () => {
    vi.useFakeTimers();
    renderHook(useUrlSync);
    act(() => {
      state().setPin({ lat: 24.4539, lon: 54.3773 });
      state().setDaylightOnly(true);
      vi.advanceTimersByTime(URL_WRITE_DELAY_MS);
    });
    // Default days (the whole dataset, snapped to UTC days) are not written.
    expect(window.location.search).toBe('?pin=24.454,54.377&daylight=1');
    act(() => {
      state().setPin(null);
      vi.advanceTimersByTime(URL_WRITE_DELAY_MS);
    });
    expect(window.location.search).toBe('');
  });

  it('has nothing to write before the dataset is known', () => {
    resetStore({ initialized: false });
    expect(urlFor(state())).toBeNull();
  });
});

describe('usePlayback', () => {
  it('advances the window on animation frames, capping long frame gaps', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    state().setSpeed(60);
    const { unmount } = renderHook(usePlayback);
    expect(frames).toHaveLength(0); // not playing
    act(() => {
      state().setPlaying(true);
    });
    act(() => {
      frames.shift()?.(1100); // 0.1 s later
    });
    expect(state().timeWindow.startS).toBeCloseTo(T0 + 0.1 * 60, 6);
    act(() => {
      frames.shift()?.(60_000); // tab was in the background for a minute
    });
    expect(state().timeWindow.startS).toBeCloseTo(T0 + (0.1 + MAX_FRAME_S) * 60, 6);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});

describe('useElementWidth', () => {
  function Probe({ onWidth }: Readonly<{ onWidth: (w: number) => void }>) {
    const ref = useRef<HTMLDivElement>(null);
    onWidth(useElementWidth(ref));
    return <div ref={ref} />;
  }

  it('reads the width and follows resizes', () => {
    let observed: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          observed = cb;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    const widths: number[] = [];
    const { unmount } = render(<Probe onWidth={(w) => widths.push(w)} />);
    expect(widths.at(-1)).toBe(320);
    act(() => {
      observed?.([{ contentRect: { width: 480 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(widths.at(-1)).toBe(480);
    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('falls back to the static width without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    const widths: number[] = [];
    render(<Probe onWidth={(w) => widths.push(w)} />);
    expect(widths.at(-1)).toBe(200);
    vi.unstubAllGlobals();
  });
});
