import type { Dataset } from '@ow/shared';
import { describe, expect, it } from 'vitest';

import { datasetMeta, summarizeDataset } from './dataset';

const sat = (id: string) => ({
  id,
  start: '2027-03-01T00:00:00.000Z',
  end: '2027-03-07T23:59:50.000Z',
  segmentCount: 1,
  minAltitudeKm: 490,
  maxAltitudeKm: 540,
});
const dataset: Dataset = {
  name: 'Altair-2P5S',
  start: '2027-03-01T00:00:00.000Z',
  end: '2027-03-07T23:59:50.000Z',
  stepS: 10,
  satellites: [sat('YAM20'), sat('YAM21')],
};

describe('dataset helpers', () => {
  it('converts the span to epoch seconds and keeps satellite order', () => {
    expect(datasetMeta(dataset)).toEqual({
      bounds: { startS: Date.UTC(2027, 2, 1) / 1000, endS: Date.UTC(2027, 2, 7, 23, 59, 50) / 1000 },
      satellites: ['YAM20', 'YAM21'],
    });
  });

  it('summarizes the dataset for the top bar', () => {
    expect(summarizeDataset(dataset)).toBe('Altair-2P5S · 2 satellites · Mon 01 Mar – Sun 07 Mar');
    expect(summarizeDataset({ ...dataset, satellites: [sat('YAM20')] })).toContain('1 satellite ·');
  });
});
