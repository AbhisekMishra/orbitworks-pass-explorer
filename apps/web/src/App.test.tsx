/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { appStore } from './state/store';
import { SATELLITES, resetStore } from './testing/fixtures';
import { loadTracks } from './tracks/loadTracks';

// WebGL and Worker glue are covered by the Playwright suite; here they are stand-ins.
vi.mock('./map/MapView', () => ({ MapView: () => <div data-testid="map" /> }));
vi.mock('./tracks/loadTracks', () => ({ loadTracks: vi.fn() }));

const dataset = {
  name: 'Altair-2P5S',
  start: '2027-03-01T00:00:00.000Z',
  end: '2027-03-08T00:00:00.000Z',
  stepS: 10,
  satellites: SATELLITES,
};
const tracks = {
  tracks: { t0S: 0, t1S: 0, stepS: 10, tracks: [] },
  stats: { rawBytes: 1, transferBytes: null, fetchMs: 1, decodeMs: 1 },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetStore({ initialized: false });
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  window.history.replaceState(null, '', '/?sats=YAM21&proj=flat');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(loadTracks).mockReset();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

describe('App', () => {
  it('loads the dataset, applies the link state and shows the tracks once decoded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(dataset)));
    vi.mocked(loadTracks).mockResolvedValue(tracks);
    renderApp();
    expect(screen.getByTestId('loading')).toBeInTheDocument();
    expect(await screen.findByTestId('dataset-summary')).toHaveTextContent(
      'Altair-2P5S · 3 satellites · Mon 01 Mar – Mon 08 Mar',
    );
    expect(await screen.findByTestId('first-run-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
    expect([...appStore.getState().hidden]).toEqual(['YAM20', 'YAM22']);
    expect(screen.getByRole('checkbox', { name: 'YAM21' })).toBeChecked();
  });

  it('retries both requests when both failed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ statusCode: 404, error: 'Not Found', message: 'Gone' }, 404))
      .mockResolvedValue(json(dataset));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(loadTracks).mockRejectedValueOnce(new Error('tracks down'));
    vi.mocked(loadTracks).mockResolvedValue(tracks);
    renderApp();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('first-run-hint')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loadTracks).toHaveBeenCalledTimes(2);
  });

  it('shows the failure and retries on demand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ statusCode: 503, error: 'Service Unavailable', message: 'Warming up' }, 503),
      )
      .mockResolvedValue(json(dataset));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(loadTracks).mockRejectedValueOnce(new Error('Could not load the satellite tracks (HTTP 502).'));
    vi.mocked(loadTracks).mockResolvedValue(tracks);
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('Warming up');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('first-run-hint')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(loadTracks).toHaveBeenCalledTimes(2);
  });
});
