import { describe, expect, it } from 'vitest';

import { NUDGE_SPANS, shortcutFor, type KeyInput } from './shortcuts';

const key = (over: Partial<KeyInput>): KeyInput => ({
  key: '',
  code: '',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  targetTag: 'body',
  targetEditable: false,
  ...over,
});

describe('shortcutFor', () => {
  it.each([
    [key({ key: ' ' }), { type: 'togglePlay' }],
    [key({ key: '1', code: 'Digit1' }), { type: 'toggleSatellite', index: 0 }],
    [key({ key: '0', code: 'Digit0' }), { type: 'toggleSatellite', index: 9 }],
    [key({ key: '!', code: 'Digit1', shiftKey: true }), { type: 'soloSatellite', index: 0 }],
    [key({ key: 'a' }), { type: 'showAllSatellites' }],
    [key({ key: 'G', shiftKey: true }), { type: 'toggleProjection' }],
    [key({ key: '?', shiftKey: true }), { type: 'openHelp' }],
    [key({ key: 'Escape', targetTag: 'button' }), { type: 'clearPin' }],
    [key({ key: 'ArrowRight' }), { type: 'nudgeWindow', spans: NUDGE_SPANS }],
    [key({ key: 'ArrowLeft', shiftKey: true }), { type: 'nudgeWindow', spans: -1 }],
  ])('maps %o', (input, action) => {
    expect(shortcutFor(input)).toEqual(action);
  });

  it.each([
    ['typing in an input', key({ key: 'a', targetTag: 'input' })],
    ['typing in an editable element', key({ key: ' ', targetEditable: true })],
    ['a modifier combination', key({ key: '1', code: 'Digit1', ctrlKey: true })],
    ['an unmapped key', key({ key: 'x' })],
    ['Space on a focused button', key({ key: ' ', targetTag: 'button' })],
    ['arrows on the focused map', key({ key: 'ArrowLeft', targetTag: 'canvas' })],
  ])('ignores %s', (_label, input) => {
    expect(shortcutFor(input)).toBeNull();
  });
});
