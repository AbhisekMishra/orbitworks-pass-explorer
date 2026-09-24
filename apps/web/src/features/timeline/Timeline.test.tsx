/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appStore } from '../../state/store';
import { H, T0, WEEK, resetStore } from '../../testing/fixtures';

import { Timeline } from './Timeline';

const TRACK_WIDTH_PX = 700;

beforeEach(() => {
  resetStore();
  // jsdom has no layout: give the track a width so pointer positions map to times.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: TRACK_WIDTH_PX,
    height: 48,
    right: TRACK_WIDTH_PX,
    bottom: 48,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  // Pointer capture is not implemented by jsdom.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Client x for a time on the mocked 700 px track. */
const xAt = (tS: number) => ((tS - WEEK.startS) / (WEEK.endS - WEEK.startS)) * TRACK_WIDTH_PX;
const state = () => appStore.getState();

describe('Timeline', () => {
  it('renders a placeholder until the dataset is known', () => {
    resetStore({ initialized: false });
    render(<Timeline />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('shows the window as UTC inputs, a duration and the active preset', () => {
    render(<Timeline />);
    expect(screen.getByLabelText('Window start (UTC)')).toHaveValue('2027-03-01T00:00');
    expect(screen.getByLabelText('Window end (UTC)')).toHaveValue('2027-03-01T06:00');
    expect(screen.getByTestId('window-duration')).toHaveTextContent('6 h');
    expect(screen.getByRole('button', { name: '6 h' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '2027-03-01 00:00 to 2027-03-01 06:00 UTC',
    );
  });

  it('applies presets', async () => {
    render(<Timeline />);
    await userEvent.click(screen.getByRole('button', { name: '1 d' }));
    expect(state().timeWindow).toEqual({ startS: T0, endS: T0 + 24 * H });
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(state().timeWindow).toEqual(WEEK);
  });

  it('edits the window edges from the UTC inputs, ignoring incomplete values', () => {
    render(<Timeline />);
    fireEvent.change(screen.getByLabelText('Window end (UTC)'), { target: { value: '2027-03-02T12:00' } });
    expect(state().timeWindow).toEqual({ startS: T0, endS: T0 + 36 * H });
    fireEvent.change(screen.getByLabelText('Window start (UTC)'), { target: { value: '2027-03-01T12:00' } });
    expect(state().timeWindow).toEqual({ startS: T0 + 12 * H, endS: T0 + 36 * H });
    fireEvent.change(screen.getByLabelText('Window start (UTC)'), { target: { value: '' } });
    expect(state().timeWindow.startS).toBe(T0 + 12 * H);
  });

  it('keeps the minimum span and the dataset bounds when typed times cross or overflow', () => {
    render(<Timeline />);
    fireEvent.change(screen.getByLabelText('Window start (UTC)'), { target: { value: '2027-03-01T09:00' } });
    expect(state().timeWindow.endS - state().timeWindow.startS).toBe(10 * 60); // MIN_WINDOW_S
    fireEvent.change(screen.getByLabelText('Window end (UTC)'), { target: { value: '2027-04-01T00:00' } });
    expect(state().timeWindow.endS).toBe(WEEK.endS);
  });

  it('plays, pauses and changes speed', async () => {
    render(<Timeline />);
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(state().playing).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Playback speed'), '3600');
    expect(state().speed).toBe(3600);
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(state().playing).toBe(false);
  });

  it('jumps to a clicked time and drags the window body', () => {
    render(<Timeline />);
    const track = screen.getByTestId('timeline-track');
    const middle = T0 + 3.5 * 24 * H;
    fireEvent.pointerDown(track, { button: 0, clientX: xAt(middle), pointerId: 1 });
    expect(state().timeWindow.startS + 3 * H).toBeCloseTo(middle, -2);
    fireEvent.pointerMove(track, { clientX: xAt(middle + 24 * H), pointerId: 1 });
    expect(state().timeWindow.startS + 3 * H).toBeCloseTo(middle + 24 * H, -2);
    fireEvent.pointerUp(track, { pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: xAt(middle), pointerId: 1 });
    expect(state().timeWindow.startS + 3 * H).toBeCloseTo(middle + 24 * H, -2); // drag ended
  });

  it('resizes from either handle', () => {
    render(<Timeline />);
    const track = screen.getByTestId('timeline-track');
    fireEvent.pointerDown(screen.getByTestId('timeline-handle-end'), {
      button: 0,
      clientX: xAt(T0 + 6 * H),
      pointerId: 2,
    });
    fireEvent.pointerMove(track, { clientX: xAt(T0 + 48 * H), pointerId: 2 });
    fireEvent.pointerUp(track, { pointerId: 2 });
    expect(state().timeWindow.startS).toBe(T0);
    expect(state().timeWindow.endS).toBeCloseTo(T0 + 48 * H, -3);

    fireEvent.pointerDown(screen.getByTestId('timeline-handle-start'), {
      button: 0,
      clientX: xAt(T0),
      pointerId: 3,
    });
    fireEvent.pointerMove(track, { clientX: xAt(T0 + 24 * H), pointerId: 3 });
    fireEvent.pointerCancel(track, { pointerId: 3 });
    expect(state().timeWindow.startS).toBeCloseTo(T0 + 24 * H, -3);
  });

  it('pauses playback when the user drags, and ignores non-primary buttons', () => {
    render(<Timeline />);
    state().setPlaying(true);
    const windowEl = screen.getByTestId('timeline-window');
    fireEvent.pointerDown(windowEl, { button: 2, clientX: xAt(T0 + H), pointerId: 4 });
    expect(state().playing).toBe(true);
    fireEvent.pointerDown(windowEl, { button: 0, clientX: xAt(T0 + H), pointerId: 4 });
    expect(state().playing).toBe(false);
  });
});
