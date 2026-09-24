/** @vitest-environment jsdom */
import type { AccessesResponse, Pass } from '@ow/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as download from '../../lib/download';
import { useDebounced } from '../../lib/useDebounced';
import { appStore } from '../../state/store';
import { COLORS, T0, resetStore } from '../../testing/fixtures';

import { AccessPanel } from './AccessPanel';
import { REQUEST_DEBOUNCE_MS, useAccessRequest, useAccesses } from './useAccesses';

const pass = (over: Partial<Pass>): Pass => ({
  id: 'YAM20-1',
  satellite: 'YAM20',
  start: '2027-03-01T06:58:16Z',
  end: '2027-03-01T06:59:58Z',
  durationS: 102,
  tca: '2027-03-01T06:59:07Z',
  minDistanceKm: 161,
  maxElevationDeg: 70.7,
  sunElevationDeg: 50,
  daylight: true,
  direction: 'descending',
  localSolarTimeH: 10.61,
  altitudeKm: 496.7,
  ...over,
});

const response = (passes: Pass[]): AccessesResponse => ({
  query: {
    lat: 24.45,
    lon: 54.38,
    radiusKm: 400,
    start: '2027-03-01T00:00:00Z',
    end: '2027-03-08T00:00:00Z',
    satellites: [],
    daylightOnly: false,
    includePath: false,
  },
  passes,
  stats: {
    passCount: passes.length,
    totalDurationS: 212,
    bySatellite: {},
    meanRevisitS: passes.length > 1 ? 11_200 : null,
    maxGapS: passes.length > 1 ? 40_000 : null,
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** App owns the accesses state; this harness does the same for the panel alone. */
function Harness() {
  return <AccessPanel colors={COLORS} accesses={useAccesses()} />;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

/** Lets the request debounce elapse and the mocked fetch resolve. */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(REQUEST_DEBOUNCE_MS + 10);
    await Promise.resolve();
  });
}

const state = () => appStore.getState();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetStore();
  // jsdom has no layout, hence no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AccessPanel', () => {
  it('invites a click on the map while there is no pin', () => {
    renderPanel();
    expect(screen.getByTestId('access-prompt')).toHaveTextContent('Click anywhere on the map');
  });

  it('lists passes by day with stats, and syncs hover and focus with the store', async () => {
    const passes = [
      pass({}),
      pass({
        id: 'YAM25-1',
        satellite: 'YAM21',
        start: '2027-03-01T10:07:12Z',
        end: '2027-03-01T10:09:02Z',
        daylight: false,
      }),
      pass({ id: 'YAM20-2', start: '2027-03-02T07:02:12Z', end: '2027-03-02T07:04:03Z' }),
    ];
    const fetchMock = vi.fn((_url: string) => Promise.resolve(json(response(passes))));
    vi.stubGlobal('fetch', fetchMock);
    state().setPin({ lat: 24.45, lon: 54.38 });
    renderPanel();
    expect(screen.getByTestId('access-pin')).toHaveTextContent('24.45° N, 54.38° E');
    await settle();

    expect(await screen.findByRole('region', { name: '2027-03-01' })).toHaveTextContent('Mon 01 Mar2 passes');
    expect(screen.getByRole('region', { name: '2027-03-02' })).toHaveTextContent('1 pass');
    expect(screen.getByTestId('access-stats')).toHaveTextContent('Passes3');
    expect(screen.getByLabelText('night')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/v1/accesses?lat=24.45000&lon=54.38000&radiusKm=400');

    const row = screen.getByRole('button', { name: /06:58:16/ });
    fireEvent.mouseEnter(row);
    expect(state().hoveredPassId).toBe('YAM20-1');
    fireEvent.click(row);
    expect(state().selectedPassId).toBe('YAM20-1');
    expect(row).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerLeave(row.closest('ol')!.parentElement!.parentElement!);
    expect(state().hoveredPassId).toBeNull();
  });

  it('scrolls the row into view when a pass is highlighted elsewhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(response([pass({})])))),
    );
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    state().setPin({ lat: 1, lon: 2 });
    renderPanel();
    await settle();
    await screen.findByRole('button', { name: /06:58:16/ });
    act(() => {
      state().setHoveredPass('YAM20-1');
    });
    expect(scroll).toHaveBeenCalled();
  });

  it('updates radius, days and daylight from its controls', async () => {
    // The API echoes the query: mirror the daylight flag of each request.
    const echo = (url: string) => {
      const body = response([]);
      body.query.daylightOnly = url.includes('daylightOnly=true');
      return Promise.resolve(json(body));
    };
    vi.stubGlobal('fetch', vi.fn(echo));
    state().setPin({ lat: 1, lon: 2 });
    renderPanel();
    fireEvent.change(screen.getByRole('slider', { name: 'Radius' }), { target: { value: '0' } });
    expect(state().access.radiusKm).toBe(10);
    expect(screen.getByTestId('access-radius')).toHaveTextContent('10 km');
    fireEvent.change(screen.getByLabelText('First day (UTC)'), { target: { value: '2027-03-03' } });
    expect(state().access.startS).toBe(T0 + 2 * 86_400);
    fireEvent.change(screen.getByLabelText('Last day (UTC)'), { target: { value: '2027-03-02' } });
    // A last day before the first day moves the first day back with it.
    expect(state().access).toMatchObject({ startS: T0 + 86_400, endS: T0 + 2 * 86_400 });
    fireEvent.change(screen.getByLabelText('Last day (UTC)'), { target: { value: '' } });
    expect(state().access.endS).toBe(T0 + 2 * 86_400);
    await userEvent.click(screen.getByText('Daylight passes only'));
    expect(state().access.daylightOnly).toBe(true);
    await settle();
    // The previous (all passes) result stays on screen until the daylight-only one arrives.
    expect(await screen.findByText(/or include night passes/)).toBeInTheDocument();
  });

  it('downloads the list as CSV and removes the pin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(response([pass({})])))),
    );
    const save = vi.spyOn(download, 'downloadText').mockImplementation(() => undefined);
    state().setPin({ lat: 1, lon: 2 });
    renderPanel();
    const csv = screen.getByRole('button', { name: 'Download passes as CSV' });
    expect(csv).toBeDisabled();
    await settle();
    await screen.findByRole('button', { name: /06:58:16/ });
    fireEvent.click(csv);
    expect(save).toHaveBeenCalledWith(
      'passes_24.45N_54.38E_400km_2027-03-01_2027-03-07.csv',
      expect.stringContaining('YAM20,2027-03-01T06:58:16Z'),
      'text/csv;charset=utf-8',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove the pin' }));
    expect(state().access.pin).toBeNull();
  });

  it('shows errors with a retry, and asks for a satellite when none is selected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ statusCode: 500, error: 'Internal Server Error', message: 'Boom' }, 500))
      .mockImplementation(() => Promise.resolve(json(response([]))));
    vi.stubGlobal('fetch', fetchMock);
    state().setPin({ lat: 1, lon: 2 });
    renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('Finding passes');
    await settle();
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('access-empty')).toBeInTheDocument();

    act(() => {
      state().hideAllSatellites();
    });
    expect(screen.getByText(/Select at least one satellite/)).toBeInTheDocument();
  });
});

describe('useAccessRequest', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

  it('asks for every satellite (toggles filter locally) and for nothing without a pin', async () => {
    const { result } = renderHook(useAccessRequest, { wrapper });
    expect(result.current).toEqual({ request: null, wanted: false });
    act(() => {
      state().setPin({ lat: 1, lon: 2 });
    });
    // Wanted at once; the request itself settles after the debounce.
    expect(result.current).toEqual({ request: null, wanted: true });
    await settle();
    expect(result.current.request).toMatchObject({ lat: 1, lon: 2, radiusKm: 400, satellites: null });
    const before = result.current.request;
    act(() => {
      state().toggleSatellite('YAM21');
    });
    await settle();
    // Same request: a satellite toggle must not cost a network request.
    expect(result.current.request).toEqual(before);
    act(() => {
      state().setPin(null);
    });
    expect(result.current).toEqual({ request: null, wanted: false }); // at once, not after the debounce
  });
});

describe('useAccesses', () => {
  it('restricts the result to the selected satellites and recomputes the stats', async () => {
    const passes = [
      pass({}),
      pass({ id: 'YAM21-1', satellite: 'YAM21', start: '2027-03-01T07:00:00Z', end: '2027-03-01T07:01:00Z' }),
    ];
    const fetchMock = vi.fn(() => Promise.resolve(json(response(passes))));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    state().setPin({ lat: 1, lon: 2 });
    const { result } = renderHook(useAccesses, { wrapper });
    await settle();
    await vi.waitFor(() => {
      expect(result.current.passes).toHaveLength(2);
    });
    act(() => {
      state().toggleSatellite('YAM21');
    });
    await settle();
    expect(result.current.passes?.map((p) => p.id)).toEqual(['YAM20-1']);
    expect(result.current.result?.stats).toMatchObject({ passCount: 1, bySatellite: { YAM20: 1, YAM22: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useDebounced', () => {
  it('waits for the value to settle, and treats equal values as unchanged', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 100, (a, b) => a.n === b.n), {
      initialProps: { v: { n: 1 } },
    });
    const first = result.current;
    rerender({ v: { n: 1 } });
    expect(result.current).toBe(first);
    rerender({ v: { n: 2 } });
    expect(result.current.n).toBe(1);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.n).toBe(2);
  });
});
