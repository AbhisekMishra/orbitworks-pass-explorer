import { decodeTracks, encodeTracks } from '@ow/shared';
import { describe, expect, it } from 'vitest';

import { buildTrackBuffers } from '../tracks/trackBuffers';

import { assignColors } from './colors';
import {
  HEADS_LAYER_ID,
  buildLayers,
  hoverFromPick,
  renderChunksOf,
  satelliteHeads,
  trackLayerId,
  type LayerInput,
} from './layers';

const T0 = 2_000_000;
// A: due north along lon 10, 1° per 10 s for 60 s. B: starts 20 s later, along the equator.
const tracks = buildTrackBuffers(
  decodeTracks(
    encodeTracks(
      [
        {
          satellite: 'A',
          startS: T0,
          lon: [10, 10, 10, 10, 10, 10, 10],
          lat: [0, 1, 2, 3, 4, 5, 6],
          altKm: Array(7).fill(500),
        },
        { satellite: 'B', startS: T0 + 20, lon: [0, 1, 2], lat: [0, 0, 0], altKm: [510, 510, 510] },
      ],
      { stepS: 10 },
    ),
  ),
);

const input = (over: Partial<LayerInput> = {}): LayerInput => ({
  tracks,
  colors: assignColors(['A', 'B']),
  timeWindow: { startS: T0 + 10, endS: T0 + 30 },
  hidden: new Set(),
  focusedSatellite: null,
  ...over,
});

const A0 = trackLayerId('A', 0);
const B0 = trackLayerId('B', 0);

const propsOf = (layers: ReturnType<typeof buildLayers>, id: string) =>
  layers.find((l) => l.id === id)!.props as Record<string, unknown>;

describe('buildLayers', () => {
  it('creates one track layer per satellite plus the heads layer', () => {
    expect(buildLayers(input()).map((l) => l.id)).toEqual([A0, B0, HEADS_LAYER_ID]);
  });

  it('passes the window as GPU uniforms relative to the dataset epoch', () => {
    const a = propsOf(buildLayers(input()), A0);
    expect(a).toMatchObject({ windowStartRelS: 10, windowEndRelS: 30, visible: true, opacity: 1 });
  });

  it('hides satellites and dims all but the focused one', () => {
    const layers = buildLayers(input({ hidden: new Set(['B']), focusedSatellite: 'A' }));
    expect(propsOf(layers, B0)).toMatchObject({ visible: false });
    expect(propsOf(layers, A0)).toMatchObject({ opacity: 1, widthScale: 1.75 });
    const dimmed = buildLayers(input({ focusedSatellite: 'B' }));
    expect((propsOf(dimmed, A0).opacity as number) < 0.5).toBe(true);
  });

  it('never dims the others for a hidden focused satellite', () => {
    const layers = buildLayers(input({ hidden: new Set(['A']), focusedSatellite: 'A' }));
    expect(propsOf(layers, B0)).toMatchObject({ opacity: 1, widthScale: 1 });
  });

  it('gives hidden chunks constant window uniforms so deck.gl skips their updates', () => {
    const a = buildLayers(input({ hidden: new Set(['A']) }));
    const b = buildLayers(input({ hidden: new Set(['A']), timeWindow: { startS: T0, endS: T0 + 50 } }));
    expect(propsOf(a, A0)).toMatchObject({ windowStartRelS: 0, windowEndRelS: 0 });
    expect(propsOf(b, A0)).toMatchObject({ windowStartRelS: 0, windowEndRelS: 0 });
  });

  it('shows only the chunks that overlap the window', () => {
    const outside = buildLayers(input({ timeWindow: { startS: T0 + 3600, endS: T0 + 7200 } }));
    expect(propsOf(outside, A0)).toMatchObject({ visible: false });
    expect(renderChunksOf(tracks.tracks[0]!)).toHaveLength(1);
  });

  it('reuses the same binary data object across rebuilds (no re-tessellation)', () => {
    const first = propsOf(buildLayers(input()), A0).data;
    const second = propsOf(buildLayers(input({ timeWindow: { startS: T0, endS: T0 + 60 } })), A0).data;
    expect(second).toBe(first);
  });

  it('places layers beneath the given basemap layer when provided', () => {
    expect(propsOf(buildLayers(input({ beforeId: 'labels' })), HEADS_LAYER_ID).beforeId).toBe('labels');
    expect(propsOf(buildLayers(input()), HEADS_LAYER_ID)).not.toHaveProperty('beforeId');
  });
});

describe('satelliteHeads', () => {
  it('puts each visible satellite at the end of the window, clamped to its own span', () => {
    const heads = satelliteHeads(input({ timeWindow: { startS: T0, endS: T0 + 15 } }));
    expect(heads.map((h) => [h.satellite, h.timeS])).toEqual([
      ['A', T0 + 15],
      ['B', T0 + 20], // B starts at T0+20
    ]);
    expect(heads[0]!.position[1]).toBeCloseTo(1.5, 5);
    const late = satelliteHeads(input({ timeWindow: { startS: T0, endS: T0 + 999 } }));
    expect(late.find((h) => h.satellite === 'B')!.timeS).toBe(T0 + 40);
  });

  it('skips hidden satellites and satellites without a color', () => {
    expect(satelliteHeads(input({ hidden: new Set(['A']) })).map((h) => h.satellite)).toEqual(['B']);
    expect(satelliteHeads(input({ colors: assignColors(['A']) })).map((h) => h.satellite)).toEqual(['A']);
  });
});

describe('hoverFromPick', () => {
  const timeWindow = { startS: T0, endS: T0 + 60 };
  const pick = (over: Partial<Parameters<typeof hoverFromPick>[0]>) => ({
    layerId: A0,
    index: 0,
    coordinate: [10.1, 2.5],
    object: undefined,
    x: 5,
    y: 6,
    ...over,
  });

  it('resolves a track pick to the nearest instant, with its position and altitude', () => {
    const hover = hoverFromPick(pick({}), tracks, timeWindow);
    expect(hover).toMatchObject({ satellite: 'A', x: 5, y: 6 });
    expect(hover!.timeS).toBeCloseTo(T0 + 25, 3);
    expect(hover!.lat).toBeCloseTo(2.5, 3);
    expect(hover!.altKm).toBeCloseTo(500, 3);
  });

  it('resolves a satellite head pick', () => {
    const head = satelliteHeads(input())[0]!;
    expect(hoverFromPick(pick({ layerId: HEADS_LAYER_ID, object: head }), tracks, timeWindow)).toMatchObject({
      satellite: 'A',
      timeS: head.timeS,
      lon: head.position[0],
    });
  });

  it.each([
    ['another layer', { layerId: 'basemap' }],
    ['no layer', { layerId: undefined }],
    ['no coordinate', { coordinate: undefined }],
    ['a negative index', { index: -1 }],
    ['an unknown satellite', { layerId: trackLayerId('Z', 0) }],
    ['an unknown path', { index: 9 }],
    ['an unknown chunk', { layerId: trackLayerId('A', 7) }],
    ['a track layer id without a chunk', { layerId: 'track:A' }],
    ['a track layer id with a bad chunk', { layerId: 'track:A:x' }],
    ['a head layer without a head object', { layerId: HEADS_LAYER_ID, object: { foo: 1 } }],
  ])('returns null for %s', (_label, over) => {
    expect(hoverFromPick(pick(over), tracks, timeWindow)).toBeNull();
  });
});
