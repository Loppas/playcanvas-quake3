import { describe, expect, it } from 'vitest';

import { WP } from '../sim/weapons/constants';
import { colorFromString, flashColor, gunColor, hookColor, railCoreColor } from './player-color';

describe('colorFromString', () => {
  it("reads color1's bits as CG_ColorFromString does: 1 blue, 2 green, 4 red", () => {
    expect(colorFromString(4)).toEqual([1, 0, 0]);
    expect(colorFromString(1)).toEqual([0, 0, 1]);
    expect(colorFromString(2)).toEqual([0, 1, 0]);
    expect(colorFromString(6)).toEqual([1, 1, 0]);
    expect(colorFromString(7)).toEqual([1, 1, 1]);
  });

  it('makes anything outside 1–7 white', () => {
    for (const value of [0, 8, -1, 12]) expect(colorFromString(value), String(value)).toEqual([1, 1, 1]);
  });
});

describe('the colours drawn from color1', () => {
  it('starts the rail core at three-quarters of it, as LE_FADE_RGB does', () => {
    expect(railCoreColor([1, 0, 0])).toEqual([0.75, 0, 0]);
    expect(railCoreColor([1, 1, 1])).toEqual([0.75, 0.75, 0.75]);
  });

  it('draws the hook in it, with green and blue at three-quarters, as CorkScrew does', () => {
    expect(hookColor([1, 0, 0])).toEqual([1, 0, 0]);
    expect(hookColor([1, 1, 1])).toEqual([1, 0.75, 0.75]);
  });

  it("colours the railgun's flash, and no other weapon's", () => {
    expect(flashColor(WP.RAILGUN, [0, 1, 0])).toEqual([0, 1, 0]);
    expect(flashColor(WP.MACHINEGUN, [0, 1, 0])).toBeUndefined();
  });
});

describe('gunColor', () => {
  it("gives the railgun its owner's color1, black at a shot and back up across the 1.5 s after", () => {
    expect(gunColor(WP.RAILGUN, [1, 0, 0], 5000, Number.NEGATIVE_INFINITY)).toEqual([1, 0, 0]);
    expect(gunColor(WP.RAILGUN, [1, 0, 0], 1000, 1000)).toEqual([0, 0, 0]);
    // Halfway, the scale is cut to 127, and 255 × 127 shifted down by 8 is 126.
    expect(gunColor(WP.RAILGUN, [1, 1, 0], 1750, 1000)).toEqual([126 / 255, 126 / 255, 0]);
    expect(gunColor(WP.RAILGUN, [1, 0, 0], 2499, 1000)).toEqual([253 / 255, 0, 0]);
    expect(gunColor(WP.RAILGUN, [1, 0, 0], 2500, 1000)).toEqual([1, 0, 0]);
  });

  it('leaves any other gun black, as its cleared refEntity does', () => {
    expect(gunColor(WP.MACHINEGUN, [1, 1, 1], 5000, 1000)).toEqual([0, 0, 0]);
  });
});
