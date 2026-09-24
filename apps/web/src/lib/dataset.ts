import { MS_PER_SECOND, type Dataset } from '@ow/shared';

import type { DatasetMeta } from '../state/store';

import { formatDay } from './time';

const toEpochS = (iso: string): number => Date.parse(iso) / MS_PER_SECOND;

/** Store metadata from the /dataset response: span in epoch seconds, satellites in API order. */
export const datasetMeta = (dataset: Dataset): DatasetMeta => ({
  bounds: { startS: toEpochS(dataset.start), endS: toEpochS(dataset.end) },
  satellites: dataset.satellites.map((s) => s.id),
});

/** "Altair-2P5S · 10 satellites · Mon 01 Mar – Sun 07 Mar" */
export function summarizeDataset(dataset: Dataset): string {
  const { bounds } = datasetMeta(dataset);
  const count = dataset.satellites.length;
  return `${dataset.name} · ${count} satellite${count === 1 ? '' : 's'} · ${formatDay(bounds.startS)} – ${formatDay(bounds.endS)}`;
}
