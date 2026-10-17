import { describe, expect, it } from 'vitest';

import { previewFraming, previewTime } from './player-preview';

/** `UI_DrawPlayer`'s view of the player (`ui_players.c:714–772`). */

describe('previewFraming', () => {
  it('gives 90° for the grid\'s width, and stands the body 0.7 of its height away, 4 below the eye', () => {
    const { fovX, fovY, origin } = previewFraming(320, 560);
    expect(fovX).toBe(45);
    // The vertical follows from the box's shape: atan2(560, 320 / tan 22.5°), doubled.
    expect(fovY).toBeCloseTo(71.87, 1);
    // 0.7 × 56 units, over tan 22.5°.
    expect(origin[0]).toBeCloseTo(94.64, 1);
    expect([origin[1], origin[2]]).toEqual([0, -4]);
  });

  it('keeps the horizontal fov to whole degrees', () => {
    expect(previewFraming(240, 400).fovX).toBe(33);
  });
});

describe('previewTime', () => {
  it("runs q3_ui's clock at half the real time, in whole milliseconds", () => {
    expect(previewTime(1001.7)).toBe(500);
  });
});
