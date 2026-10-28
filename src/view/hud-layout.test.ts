import { describe, expect, it } from 'vitest';

import { hudScale, screenRect } from './hud-layout';

/** Three of Q3's boxes: the ammo count, the head, and the lagometer's. */
const AMMO = { x: 2, y: 432, w: 96, h: 48 };
const HEAD = { x: 285, y: 420, w: 60, h: 60 };
const LAGOMETER = { x: 592, y: 432, w: 48, h: 48 };

describe('screenRect', () => {
  it("is Q3's own stretch at 4:3, whatever the anchor", () => {
    for (const anchor of ['left', 'centre', 'right', 'stretch'] as const) {
      expect(screenRect(HEAD, anchor, 1024, 768)).toEqual({ x: 456, y: 672, w: 96, h: 96 });
    }
  });

  it('keeps boxes square at 16:9, with each group at its edge', () => {
    // 1920 × 1080: 2.25 pixels a unit, and 480 pixels over.
    expect(hudScale(1080)).toBe(2.25);
    expect(screenRect(AMMO, 'left', 1920, 1080)).toEqual({ x: 4.5, y: 972, w: 216, h: 108 });
    expect(screenRect(HEAD, 'centre', 1920, 1080)).toEqual({ x: 881.25, y: 945, w: 135, h: 135 });
    const lagometer = screenRect(LAGOMETER, 'right', 1920, 1080);
    expect(lagometer.x + lagometer.w).toBe(1920);
  });

  it('keeps the middle group about the middle at 21:9', () => {
    // The head's box is centred 5 units left of Q3's middle, and stays so.
    const head = screenRect(HEAD, 'centre', 2560, 1080);
    expect(head.x + head.w / 2).toBe(1280 - 5 * 2.25);
    expect(screenRect(AMMO, 'left', 2560, 1080).x).toBe(4.5);
    expect(screenRect(LAGOMETER, 'right', 2560, 1080).x).toBe(2560 - 48 * 2.25);
  });

  it('stretches a band across the whole width, as Q3 does, its height scaled by the height', () => {
    const BAND = { x: 0, y: 404, w: 640, h: 16 };
    expect(screenRect(BAND, 'stretch', 1920, 1080)).toEqual({ x: 0, y: 909, w: 1920, h: 36 });
    expect(screenRect(BAND, 'stretch', 2560, 1080)).toEqual({ x: 0, y: 909, w: 2560, h: 36 });
    expect(screenRect({ ...BAND, x: 320, w: 320 }, 'stretch', 1920, 1080)).toMatchObject({
      x: 960,
      w: 960
    });
  });
});
