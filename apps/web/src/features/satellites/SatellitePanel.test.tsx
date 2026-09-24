/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { appStore } from '../../state/store';
import { COLORS, SATELLITES, resetStore } from '../../testing/fixtures';

import { SatellitePanel } from './SatellitePanel';

const renderPanel = () => render(<SatellitePanel satellites={SATELLITES} colors={COLORS} />);

beforeEach(() => {
  resetStore();
});

describe('SatellitePanel', () => {
  it('lists every satellite with its altitude range and shortcut digit', () => {
    renderPanel();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText('490–540 km')).toBeInTheDocument();
    expect(screen.getByTestId('satellite-count')).toHaveTextContent('3/3');
    expect(screen.getByText('3', { selector: 'kbd' })).toBeInTheDocument();
  });

  it('toggles a satellite from its checkbox and updates the count', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('checkbox', { name: 'YAM21' }));
    expect(appStore.getState().hidden.has('YAM21')).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'YAM21' })).not.toBeChecked();
    expect(screen.getByTestId('satellite-count')).toHaveTextContent('2/3');
  });

  it('shows only one satellite, then all, then none', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Show only YAM22' }));
    expect([...appStore.getState().hidden]).toEqual(['YAM20', 'YAM21']);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(appStore.getState().hidden.size).toBe(0);
    expect(screen.getByRole('button', { name: 'All' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(appStore.getState().hidden.size).toBe(3);
    expect(screen.getByRole('button', { name: 'None' })).toBeDisabled();
  });

  it('focuses the hovered visible satellite on the map, and clears it on leave', async () => {
    renderPanel();
    const row = screen.getByRole('checkbox', { name: 'YAM20' }).closest('li')!;
    await userEvent.hover(row);
    expect(appStore.getState().focusedSatellite).toBe('YAM20');
    await userEvent.unhover(screen.getByRole('list'));
    expect(appStore.getState().focusedSatellite).toBeNull();
  });

  it('does not focus a hidden satellite', async () => {
    appStore.getState().toggleSatellite('YAM20');
    renderPanel();
    await userEvent.hover(screen.getByRole('checkbox', { name: 'YAM20' }).closest('li')!);
    expect(appStore.getState().focusedSatellite).toBeNull();
  });

  it('offers digit shortcuts for the first ten satellites only', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...SATELLITES[0]!,
      id: `S${String(i).padStart(2, '0')}`,
    }));
    render(<SatellitePanel satellites={many} colors={COLORS} />);
    expect(screen.getByText('0', { selector: 'kbd' })).toBeInTheDocument(); // 10th satellite
    expect(screen.getAllByRole('button', { name: /Show only/ }).at(-1)).toHaveAttribute(
      'title',
      'Show only S10',
    );
    expect(screen.getAllByRole('button', { name: /Show only/ })[0]).toHaveAttribute(
      'title',
      'Show only S00 (Shift+1)',
    );
  });

  it('collapses and expands', async () => {
    renderPanel();
    const header = screen.getByRole('button', { name: /Satellites/ });
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    await userEvent.click(header);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });
});
