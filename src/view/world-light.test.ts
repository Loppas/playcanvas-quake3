import { describe, expect, it } from 'vitest';

import {
  colorShiftLightingBytes,
  lightmapCount,
  lightmapPages,
  shiftedVertexColors
} from './world-light';

/** One colour shifted. */
function shift(rgb: number[], by: number): number[] {
  const out = new Uint8Array(3);
  colorShiftLightingBytes(Uint8Array.from(rgb), 0, out, 0, by);
  return [...out];
}

/** A page of three-byte texels, its first texels these and the rest `fill`. */
function page(first: number[], fill = 0): Uint8Array {
  const texels = new Uint8Array(128 * 128 * 3).fill(fill);
  texels.set(first);
  return texels;
}

describe('colorShiftLightingBytes', () => {
  it('shifts each channel left, by 1 and by 2', () => {
    expect(shift([100, 50, 20], 1)).toEqual([200, 100, 40]);
    expect(shift([60, 30, 1], 2)).toEqual([240, 120, 4]);
  });

  it('leaves a colour at 255 or below as it is, and white white', () => {
    expect(shift([127, 0, 63], 1)).toEqual([254, 0, 126]);
    expect(shift([255, 255, 255], 0)).toEqual([255, 255, 255]);
  });

  it('scales all three by 255 over the largest where one passes 255, in integers', () => {
    // 400, 200 and 80: the green is 127.5 and the blue 51, truncated as C's division is.
    expect(shift([100, 50, 20], 2)).toEqual([255, 127, 51]);
    // The hue kept, where saturating would have gone yellow.
    expect(shift([200, 100, 0], 1)).toEqual([255, 127, 0]);
    expect(shift([10, 255, 128], 1)).toEqual([10, 255, 128]);
  });

  it('shifts right for a shift below zero', () => {
    expect(shift([101, 50, 3], -1)).toEqual([50, 25, 1]);
  });

  it('reads and writes at the offsets it is given, and touches nothing else', () => {
    const input = Uint8Array.from([9, 9, 1, 2, 3, 9]);
    const output = new Uint8Array(8).fill(7);
    colorShiftLightingBytes(input, 2, output, 4, 1);
    expect([...output]).toEqual([7, 7, 7, 7, 2, 4, 6, 7]);
  });
});

describe('shiftedVertexColors', () => {
  it('shifts every vertex, its alpha kept', () => {
    const colors = Uint8Array.from([100, 50, 20, 77, 200, 100, 0, 255]);
    expect([...shiftedVertexColors(colors, 1)]).toEqual([200, 100, 40, 77, 255, 127, 0, 255]);
  });
});

describe('lightmapPages', () => {
  it('counts a single page as two, and none as none', () => {
    expect([0, 1, 2, 3].map(lightmapCount)).toEqual([0, 2, 2, 3]);
  });

  it('expands each texel to four bytes, shifted and opaque', () => {
    const [first] = lightmapPages([page([100, 50, 20, 200, 100, 0]), page([])], 1);
    expect(first).toHaveLength(128 * 128 * 4);
    expect([...first.subarray(0, 8)]).toEqual([200, 100, 40, 255, 255, 127, 0, 255]);
  });

  it('makes a single page two, the second black', () => {
    const pages = lightmapPages([page([], 10)], 2);
    expect(pages).toHaveLength(2);
    expect([...pages[0].subarray(0, 4)]).toEqual([40, 40, 40, 255]);
    const texels = pages[1];
    expect(texels.every((value, i) => value === (i % 4 === 3 ? 255 : 0))).toBe(true);
  });

  it('makes none for a map with no lightmaps, and one for each of several', () => {
    expect(lightmapPages([], 1)).toEqual([]);
    expect(lightmapPages([page([]), page([]), page([])], 1)).toHaveLength(3);
  });
});
