// @vitest-environment jsdom
import { FILTER_LINEAR, Texture, type AppBase } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestApp } from './engine-test-fixtures';
import { clearTexels, inkRows, settle, textWidth, type MenuFont } from './menu-font';

/**
 * The menu font's settling, on atlases written by hand: jsdom has no canvas to draw a face on.
 */

/** RGBA texels `width` across and `height` down, clear, with `alpha` at each of `inked`. */
function texels(width: number, height: number, inked: readonly (readonly [number, number, number])[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(4 * width * height);
  for (const [x, y, alpha] of inked) out[4 * (y * width + x) + 3] = alpha;
  return out;
}

describe('inkRows', () => {
  it("finds a glyph's middle and height down its cell, each row by its most-covered texel", () => {
    // A cell 4 across and 10 down at (2,1), in texels 8 across: a half-covered row at 2 and four
    // whole ones from 3, one of them over a fainter texel, and ink outside the cell that is not its.
    const inked = [
      [3, 3, 128],
      [3, 4, 255],
      [4, 5, 255],
      [3, 6, 40],
      [4, 6, 255],
      [3, 7, 255],
      [7, 1, 255],
      [1, 9, 255]
    ] as const;
    const ink = inkRows(texels(8, 12, inked), 8, { x: 2, y: 1, width: 4, height: 10 });
    const half = 128 / 255;
    expect(ink.height).toBeCloseTo(4 + half);
    // Down from the cell's top at 1: the half row at 2.5, and the rest at 3.5 to 6.5.
    expect(ink.middle).toBeCloseTo((half * 2.5 + 3.5 + 4.5 + 5.5 + 6.5) / (4 + half));
  });

  it("stands an empty cell's middle at its own, with no height", () => {
    expect(inkRows(texels(4, 4, []), 4, { x: 0, y: 0, width: 4, height: 4 })).toEqual({ middle: 2, height: 0 });
  });
});

describe('clearTexels', () => {
  it('makes every texel white, and clear where only the atlas clear 1/255 stands', () => {
    const rgba = [10, 20, 30, 1, 0, 0, 0, 0, 255, 255, 255, 200, 90, 90, 90, 2];
    expect([...clearTexels(rgba)]).toEqual([
      255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 200, 255, 255, 255, 2
    ]);
  });
});

describe('textWidth', () => {
  it("adds each glyph's advance, recorded at 32, at the size asked for, and nothing for one the font lacks", () => {
    const font = { data: { chars: { A: { xadvance: 20 }, b: { xadvance: 12 } } } } as unknown as MenuFont;
    expect(textWidth(font, 'Ab', 32)).toBe(32);
    expect(textWidth(font, 'AAb', 16)).toBe(26);
    expect(textWidth(font, 'A~', 64)).toBe(40);
    expect(textWidth(font, '', 17)).toBe(0);
  });
});

describe('settle', () => {
  let app: AppBase;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  /**
   * A font whose atlas, 4 across and 16 down, holds an `H` in a cell 16 high, inked from row 9 to
   * row 12 over the atlas clear's 1/255, drawn at 64: 2 over 32.
   */
  function font(): { font: MenuFont; old: Texture } {
    const rgba = texels(4, 16, [9, 10, 11, 12].map((y) => [1, y, 255] as const));
    for (let i = 3; i < rgba.length; i += 4) rgba[i] ||= 1;
    const old = new Texture(app.graphicsDevice, { name: 'atlas', width: 4, height: 16, minFilter: FILTER_LINEAR });
    const glyph = (yoffset: number) => ({ x: 0, y: 0, width: 4, height: 16, yoffset, scale: 2, map: 0 });
    const atlas = {
      canvas: { width: 4, height: 16 },
      ctx: { getImageData: () => ({ data: rgba }) },
      texture: old
    };
    const made = { data: { chars: { H: glyph(0), g: glyph(-3) } }, atlases: [atlas], capitals: 0 };
    return { font: made as unknown as MenuFont, old };
  }

  it("raises every glyph by the gap from its cell's middle to its capitals'", () => {
    const { font: settled } = font();
    settle(app, settled);
    // The capitals' middle stands at 11 down the cell, 3 under its middle at 8: 3 texels, 1.5 in
    // the glyphs' own unit.
    const { chars } = settled.data as { chars: Record<string, { yoffset: number }> };
    expect(chars.H.yoffset).toBe(-1.5);
    expect(chars.g.yoffset).toBe(-4.5);
    // Four rows high, at 64, in a cell 16 high.
    expect(settled.capitals).toBe(4 / 64);
    expect(settled.cell).toBe(16 / 64);
  });

  it('draws the text from a white atlas, clear where it was empty, in place of the one it was drawn to', () => {
    const { font: settled, old } = font();
    const destroyed = vi.spyOn(old, 'destroy');
    settle(app, settled);
    const texture = (settled.atlases[0] as { texture: Texture }).texture;
    expect(texture).not.toBe(old);
    expect(destroyed).toHaveBeenCalled();
    expect([texture.width, texture.height, texture.minFilter]).toEqual([4, 16, FILTER_LINEAR]);
    const level = texture.getSource() as unknown as Uint8Array;
    expect([...level.slice(0, 8)]).toEqual([255, 255, 255, 0, 255, 255, 255, 0]);
    expect([...level.slice(4 * (9 * 4 + 1), 4 * (9 * 4 + 2))]).toEqual([255, 255, 255, 255]);
  });
});
