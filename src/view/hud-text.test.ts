import { describe, expect, it } from 'vitest';

import {
  BIGCHAR_WIDTH,
  smallCharHeight,
  smallCharWidth,
  stringGlyphs,
  stringLength,
  stringWidth
} from './hud-text';

describe('stringGlyphs', () => {
  it("cuts each character's cell out of the 16 × 16 grid by its code", () => {
    // 'A' is 65, row 4 column 1; 'f' is 102, row 6 column 6.
    expect(stringGlyphs('Af', 10, BIGCHAR_WIDTH)).toEqual([
      { x: 10, row: 4, col: 1 },
      { x: 26, row: 6, col: 6 }
    ]);
  });

  it('keeps a space its place and draws nothing there', () => {
    expect(stringGlyphs('a b', 0, 8).map((glyph) => glyph.x)).toEqual([0, 16]);
  });

  it('colours what a ^ code follows, and gives the code no place of its own', () => {
    expect(stringGlyphs('a^1b', 0, 8)).toEqual([
      { x: 0, row: 6, col: 1 },
      { x: 8, row: 6, col: 2, color: 1 }
    ]);
  });

  it('reads a ^ that starts no code as text', () => {
    // `Q_IsColorString`: a caret before anything but a letter or digit is text (`q_shared.c:27–46`).
    expect(stringGlyphs('a^ b', 0, 8).map((glyph) => [glyph.x, glyph.color])).toEqual([
      [0, undefined],
      [8, undefined],
      [24, undefined]
    ]);
  });
});

describe('stringLength and stringWidth', () => {
  it('count a character width a character, spaces included and colour codes not', () => {
    expect(stringWidth('Rocket Launcher', BIGCHAR_WIDTH)).toBe(240);
    expect(stringWidth('^1Rocket', BIGCHAR_WIDTH)).toBe(96);
    expect(stringLength('^4Tied for ^41st^7')).toBe(12);
  });
});

describe('smallCharWidth and smallCharHeight', () => {
  it("are 8 by 16 under con_scale, cut to whole pixels as ioquake3's ints are", () => {
    expect([smallCharWidth(1), smallCharHeight(1)]).toEqual([8, 16]);
    expect([smallCharWidth(2), smallCharHeight(2)]).toEqual([16, 32]);
    expect([smallCharWidth(1.3), smallCharHeight(1.3)]).toEqual([10, 20]);
    expect([smallCharWidth(1.45), smallCharHeight(1.45)]).toEqual([11, 23]);
  });
});
