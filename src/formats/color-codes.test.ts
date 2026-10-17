import { describe, expect, it } from 'vitest';

import { COLOR_TABLE, colorIndex, colorRuns, isColorCode } from './color-codes';

describe('isColorCode (Q_IsColorString)', () => {
  it('takes a ^ and an ASCII letter or digit as a code', () => {
    expect(['^1', '^0', '^9', '^a', '^Z'].map((text) => isColorCode(text, 0))).toEqual([true, true, true, true, true]);
    expect(isColorCode('Sar^1ge', 3)).toBe(true);
  });

  it('takes a ^ before anything else, or last, as text', () => {
    expect(['^^', '^ ', '^!', '^é', '^', 'a1'].map((text) => isColorCode(text, 0))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false
    ]);
  });
});

describe('colorIndex (ColorIndex)', () => {
  it("picks g_color_table's colour by the digit, with ^8, ^9 and the letters wrapping round", () => {
    expect([...'01234567'].map(colorIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...'89aAhz'].map(colorIndex)).toEqual([0, 1, 1, 1, 0, 2]);
  });

  it('holds the eight colours, black to white', () => {
    expect(COLOR_TABLE).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, 0, 1],
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 1]
    ]);
  });
});

describe('colorRuns', () => {
  it('reads text into runs, each in the colour of the code before it, the codes taken out', () => {
    expect(colorRuns('Sarge')).toEqual([{ text: 'Sarge' }]);
    expect(colorRuns('Sar^1ge^7!')).toEqual([{ text: 'Sar' }, { text: 'ge', color: 1 }, { text: '!', color: 7 }]);
  });

  it('leaves out a run with no text', () => {
    expect(colorRuns('^1^2Sarge^3')).toEqual([{ text: 'Sarge', color: 2 }]);
    expect(colorRuns('')).toEqual([]);
  });

  it('shows a ^ before anything else, or last, as itself', () => {
    expect(colorRuns('^^1a^ b^')).toEqual([{ text: '^' }, { text: 'a^ b^', color: 1 }]);
  });
});
