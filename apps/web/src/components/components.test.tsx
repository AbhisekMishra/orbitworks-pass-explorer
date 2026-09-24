/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrackTooltip } from '../features/tooltip/TrackTooltip';
import { appStore } from '../state/store';
import { COLORS, T0, resetStore } from '../testing/fixtures';

import { FirstRunHint, HINT_STORAGE_KEY } from './FirstRunHint';
import { HelpDialog } from './HelpDialog';
import { ErrorCard, LoadingCard } from './StatusCard';
import { TopBar } from './TopBar';

beforeEach(() => {
  resetStore();
  // jsdom lacks the modal dialog API.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('TopBar', () => {
  it('shows the dataset summary and the UTC reminder', () => {
    render(<TopBar summary="Altair · 10 satellites" />);
    expect(screen.getByTestId('dataset-summary')).toHaveTextContent('Altair · 10 satellites');
    expect(screen.getByText('All times UTC')).toBeInTheDocument();
  });

  it('switches the projection and opens help', async () => {
    render(<TopBar summary={null} />);
    expect(screen.queryByTestId('dataset-summary')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Flat/ }));
    expect(appStore.getState().projection).toBe('mercator');
    expect(screen.getByRole('button', { name: /Flat/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Globe/ }));
    expect(appStore.getState().projection).toBe('globe');
    await userEvent.click(screen.getByRole('button', { name: 'Help and keyboard shortcuts' }));
    expect(appStore.getState().helpOpen).toBe(true);
  });
});

describe('TrackTooltip', () => {
  const hover = {
    kind: 'track' as const,
    satellite: 'YAM20',
    timeS: T0 + 6 * 3600 + 58 * 60,
    lon: 54.37,
    lat: 24.45,
    altKm: 512.34,
    x: 100,
    y: 80,
  };

  it('renders nothing without a hover', () => {
    const { container } = render(<TrackTooltip colors={COLORS} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('describes the instant under the pointer, in UTC', () => {
    appStore.getState().setHover(hover);
    render(<TrackTooltip colors={COLORS} />);
    const tip = screen.getByTestId('track-tooltip');
    expect(tip).toHaveTextContent('YAM20');
    expect(tip).toHaveTextContent('06:58:00 UTC');
    expect(tip).toHaveTextContent('2027-03-01');
    expect(tip).toHaveTextContent('24.45° N, 54.37° E');
    expect(tip).toHaveTextContent('512.3 km');
    // 06:58 UTC + 54.37°/15 h (3 h 37.5 min) = 10:35.5 → 10:35 local solar time; the Sun is up.
    expect(tip).toHaveTextContent('10:35');
    expect(tip).toHaveTextContent('Sunlit');
  });

  it('reports a dark ground at night and flips near the right edge', () => {
    appStore.getState().setHover({ ...hover, timeS: T0 + 22 * 3600, x: globalThis.innerWidth - 10 });
    render(<TrackTooltip colors={COLORS} />);
    const tip = screen.getByTestId('track-tooltip');
    expect(tip).toHaveTextContent('Dark');
    expect(tip.style.transform).toContain('calc(-100%');
  });
});

describe('TrackTooltip for a pass', () => {
  const pass = {
    id: 'P1',
    satellite: 'YAM20',
    start: '2027-03-01T06:58:16Z',
    end: '2027-03-01T06:59:58Z',
    durationS: 102,
    tca: '2027-03-01T06:59:07Z',
    minDistanceKm: 161.1,
    maxElevationDeg: 70.7,
    sunElevationDeg: 50,
    daylight: true,
    direction: 'descending' as const,
    localSolarTimeH: 10.61,
    altitudeKm: 496.7,
  };

  it('summarizes the hovered pass', () => {
    appStore.getState().setHover({ kind: 'pass', passId: 'P1', x: 10, y: 20 });
    render(<TrackTooltip colors={COLORS} passes={[pass]} />);
    const tip = screen.getByTestId('pass-tooltip');
    expect(tip).toHaveTextContent('YAM20 pass');
    expect(tip).toHaveTextContent('06:58:16–06:59:58 UTC');
    expect(tip).toHaveTextContent('1 min 42 s');
    expect(tip).toHaveTextContent('71°');
    expect(tip).toHaveTextContent('161 km at 06:59:07');
    expect(tip).toHaveTextContent('Sunlit');
  });

  it('renders nothing for a pass that is no longer listed', () => {
    appStore.getState().setHover({ kind: 'pass', passId: 'gone', x: 10, y: 20 });
    const { container } = render(<TrackTooltip colors={COLORS} passes={[pass]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StatusCard', () => {
  it('shows progress', () => {
    render(<LoadingCard title="Loading" detail="0.5 MB" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading0.5 MB');
  });

  it('shows an error with a retry action', async () => {
    const onRetry = vi.fn();
    render(<ErrorCard title="Failed" message="Server unreachable" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Server unreachable');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('HelpDialog', () => {
  it('opens from the store and closes with its button', async () => {
    render(<HelpDialog stats={{ rawBytes: 2_000_000, transferBytes: 524_066, fetchMs: 50, decodeMs: 16 }} />);
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).not.toHaveAttribute('open');
    appStore.getState().setHelpOpen(true);
    expect(await screen.findByRole('dialog')).toHaveAttribute('open');
    expect(dialog).toHaveTextContent('524 KB');
    expect(dialog).toHaveTextContent('Show only that satellite');
    await userEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(appStore.getState().helpOpen).toBe(false);
    expect(dialog).not.toHaveAttribute('open');
  });

  it('closes on a backdrop click and on the native close event', async () => {
    render(<HelpDialog stats={null} />);
    appStore.getState().setHelpOpen(true);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent('KB');
    await userEvent.click(dialog);
    expect(appStore.getState().helpOpen).toBe(false);
    appStore.getState().setHelpOpen(true);
    dialog.dispatchEvent(new Event('close'));
    expect(appStore.getState().helpOpen).toBe(false);
  });
});

describe('FirstRunHint', () => {
  it('shows once and remembers the dismissal', async () => {
    const { unmount } = render(<FirstRunHint />);
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('first-run-hint')).not.toBeInTheDocument();
    expect(localStorage.getItem(HINT_STORAGE_KEY)).toBe('dismissed');
    unmount();
    render(<FirstRunHint />);
    expect(screen.queryByTestId('first-run-hint')).not.toBeInTheDocument();
  });

  it('still works when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<FirstRunHint />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss hint' }));
    expect(screen.queryByTestId('first-run-hint')).not.toBeInTheDocument();
  });
});
