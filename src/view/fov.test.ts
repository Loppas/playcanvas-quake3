import { describe, expect, it } from 'vitest';

import { CONTENTS } from '../sim/constants';
import {
  WAVE_AMPLITUDE,
  WAVE_FREQUENCY,
  fovAspect,
  fovForVertical,
  horizontalFov,
  underwaterWarp,
  verticalFov,
  viewFov
} from './fov';

describe('cg_fov, as Quake Live defines it', () => {
  it('gives a 73° vertical at its default of 89.2, and back', () => {
    expect(verticalFov(89.2)).toBeCloseTo(73, 1);
    expect(fovForVertical(73)).toBeCloseTo(89.2, 1);
  });

  it('is the horizontal angle itself on a 4:3 screen', () => {
    expect(horizontalFov(89.2, 4 / 3)).toBeCloseTo(89.2, 10);
    expect(horizontalFov(110, 4 / 3)).toBeCloseTo(110, 10);
  });

  it('keeps the vertical angle as the screen widens, so 16:9 sees 105.5° across', () => {
    expect(horizontalFov(89.2, 16 / 9)).toBeCloseTo(105.5, 1);
    expect(horizontalFov(89.2, 21 / 9)).toBeGreaterThan(horizontalFov(89.2, 16 / 9));
  });

  it('turns round exactly', () => {
    for (const fov of [30, 90, 120, 160]) expect(fovForVertical(verticalFov(fov)), String(fov)).toBeCloseTo(fov, 10);
  });
});

describe("CG_CalcFov's warp under water", () => {
  it('is a degree each way, a cycle every 2.5 s of the game clock', () => {
    expect([WAVE_AMPLITUDE, WAVE_FREQUENCY]).toEqual([1, 0.4]);
    const water = CONTENTS.WATER;
    expect(underwaterWarp(water, 0)).toBe(0);
    expect(underwaterWarp(water, 625)).toBeCloseTo(1, 12);
    expect(underwaterWarp(water, 1875)).toBeCloseTo(-1, 12);
    expect(underwaterWarp(water, 2500 + 625)).toBeCloseTo(1, 12);
    // `cg.time / 1000.0 * WAVE_FREQUENCY * M_PI * 2`, a sine of it.
    expect(underwaterWarp(water, 300)).toBe(Math.sin((300 / 1000) * 0.4 * Math.PI * 2));
  });

  it('comes in water, slime and lava, whatever else is there, and nowhere else', () => {
    for (const contents of [CONTENTS.WATER, CONTENTS.SLIME, CONTENTS.LAVA]) {
      expect(underwaterWarp(contents, 625), String(contents)).toBeCloseTo(1, 12);
      expect(underwaterWarp(contents | CONTENTS.FOG, 625)).toBeCloseTo(1, 12);
    }
    for (const contents of [0, CONTENTS.SOLID, CONTENTS.FOG, CONTENTS.NODROP, CONTENTS.BODY]) {
      expect(underwaterWarp(contents, 625), String(contents)).toBe(0);
    }
  });

  it('widens the view across and narrows it up and down by the same degrees', () => {
    const still = viewFov(89.2, 16 / 9, 0);
    expect(still).toEqual({ x: horizontalFov(89.2, 16 / 9), y: verticalFov(89.2) });
    expect(viewFov(89.2, 16 / 9, 0.75)).toEqual({ x: still.x + 0.75, y: still.y - 0.75 });
    expect(viewFov(89.2, 16 / 9, -1)).toEqual({ x: still.x - 1, y: still.y + 1 });
  });

  it("gives a projection the aspect of its angles' tangents, the screen's when unwarped", () => {
    expect(fovAspect(viewFov(89.2, 16 / 9, 0))).toBeCloseTo(16 / 9, 12);
    expect(fovAspect(viewFov(110, 21 / 9, 0))).toBeCloseTo(21 / 9, 12);
    const warped = viewFov(89.2, 16 / 9, 1);
    expect(fovAspect(warped)).toBeCloseTo(
      Math.tan((warped.x * Math.PI) / 360) / Math.tan((warped.y * Math.PI) / 360),
      12
    );
    expect(fovAspect(warped)).toBeGreaterThan(16 / 9);
  });
});
