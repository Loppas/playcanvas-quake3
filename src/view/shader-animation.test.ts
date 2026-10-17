import { describe, expect, it } from 'vitest';

import type { TexMod, Wave } from '../formats/shader-script';
import {
  IDENTITY_TRANSFORM,
  applyTransform,
  environmentUvs,
  evalWave,
  scaleTransform,
  tableForFunc,
  texModsAt,
  waveColor,
  waveFunc,
  waveGlow
} from './shader-animation';

/** A waveform, defaulting to Q3's unit shape: base 0, amplitude 1, phase 0, 1 Hz. */
function wave(func: Wave['func'], base = 0, amplitude = 1, phase = 0, frequency = 1): Wave {
  return { func, base, amplitude, phase, frequency };
}

describe('evalWave', () => {
  it("reads each function the way Q3's tables hold it", () => {
    expect(evalWave(wave('sin'), 0.25)).toBeCloseTo(1, 10);
    expect(evalWave(wave('sin'), 0.75)).toBeCloseTo(-1, 10);
    expect(evalWave(wave('square'), 0.2)).toBe(1);
    expect(evalWave(wave('square'), 0.7)).toBe(-1);
    expect(evalWave(wave('sawtooth'), 0.3)).toBeCloseTo(0.3, 10);
    expect(evalWave(wave('inversesawtooth'), 0.3)).toBeCloseTo(0.7, 10);
    // Up to 1 over the first quarter, down through 0 at the half, to −1 at three quarters.
    const triangle: Array<[number, number]> = [
      [0, 0],
      [0.125, 0.5],
      [0.25, 1],
      [0.375, 0.5],
      [0.5, 0],
      [0.625, -0.5],
      [0.75, -1],
      [0.875, -0.5]
    ];
    for (const [x, y] of triangle) expect(evalWave(wave('triangle'), x), `x = ${x}`).toBeCloseTo(y, 10);
  });

  it('applies base, amplitude, phase and frequency, and repeats every period', () => {
    const shaped = wave('sawtooth', 2, 3, 0.1, 4); // 2 + 3 · frac(0.1 + 4t)
    expect(evalWave(shaped, 0.05)).toBeCloseTo(2 + 3 * 0.3, 10);
    expect(evalWave(shaped, 0.3)).toBeCloseTo(2 + 3 * 0.3, 10);
  });

  it('drops the map for noise and for a wave with no function, as TableForFunc does', () => {
    expect(() => evalWave(wave('noise'), 0)).toThrow(
      new Error("TableForFunc called with invalid function '6'")
    );
    expect(() => waveFunc('none', 0)).toThrow(
      new Error("TableForFunc called with invalid function '0'")
    );
    expect(() => tableForFunc('sin')).not.toThrow();
    expect(() => tableForFunc('noise')).toThrow();
    // The world's draws name their shader, as Q3's message does.
    expect(() => tableForFunc('none', 'textures/sfx/x')).toThrow(
      new Error("TableForFunc called with invalid function '0' in shader 'textures/sfx/x'")
    );
  });
});

describe('waveColor', () => {
  it("scales a wave by identityLight before its clamp, as RB_CalcWaveColor does", () => {
    expect(waveColor(wave('sin', 1, 0.8), 0.25, 0.5)).toBeCloseTo(0.9, 10);
    expect(waveColor(wave('sin', 1, 0.8), 0.25, 1)).toBe(1);
    expect(waveColor(wave('sin', 0, 1), 0.75, 0.5)).toBe(0);
  });
});

describe('waveGlow', () => {
  it('clamps to [0, 1], as rgbGen wave does', () => {
    expect(waveGlow(wave('sin', 0, 2), 0.25)).toBe(1);
    expect(waveGlow(wave('sin', 0, 2), 0.75)).toBe(0);
  });

  it('fades a plasma impact linearly from full to a tenth over its 600 ms', () => {
    const plasma = wave('inversesawtooth', 0, 1, 0, 1.5);
    expect(waveGlow(plasma, 0)).toBeCloseTo(1, 10);
    expect(waveGlow(plasma, 0.3)).toBeCloseTo(0.55, 10);
    expect(waveGlow(plasma, 0.6)).toBeCloseTo(0.1, 10);
  });
});

describe('texModsAt', () => {
  // `plasmaExplosion`'s own modifiers, in its order.
  const plasma: TexMod[] = [
    { type: 'stretch', wave: wave('triangle', 0.6, 0.1, 0, 8) },
    { type: 'rotate', degreesPerSecond: 999 }
  ];

  /** How much a transform scales, and the angle it turns through, in degrees. */
  function scaleAndTurn(seconds: number): { scale: number; degrees: number } {
    const m = texModsAt(plasma, seconds);
    return { scale: Math.hypot(m.a, m.c), degrees: (Math.atan2(m.c, m.a) * 180) / Math.PI };
  }

  it('holds still with no modifiers', () => {
    expect(texModsAt([], 1)).toEqual(IDENTITY_TRANSFORM);
  });

  it("transforms as RB_CalcTransformTexCoords does, the matrix read in the script's order", () => {
    // `tcMod transform 1 2 3 4 5 6`: s' = s + 3t + 5, t' = 2s + 4t + 6.
    const m = texModsAt(
      [{ type: 'transform', matrix: [1, 2, 3, 4], translate: [5, 6] }],
      0
    );
    expect(applyTransform(m, 0.5, 0.25)).toEqual([0.5 + 0.75 + 5, 1 + 1 + 6]);
  });

  it("stops at a slot that didn't read, and moves nothing by the world entity's own", () => {
    const scroll: TexMod = { type: 'scroll', s: 0.5, t: 0 };
    const m = texModsAt([{ type: 'scale', s: 2, t: 2 }, { type: 'none' }, scroll], 0.5);
    expect(m).toEqual(scaleTransform(2, 2));
    expect(texModsAt([{ type: 'entityTranslate' }], 3)).toEqual(IDENTITY_TRANSFORM);
  });

  it("breathes and spins the plasma impact's texture about its centre", () => {
    // triangle(8t) is 0 at t = 0, 1 at 1/32 s and −1 at 3/32 s, so the scale is 1 / 0.6,
    // 1 / 0.7 and 1 / 0.5 — `RB_CalcStretchTexCoords` divides by the wave.
    expect(scaleAndTurn(0).scale).toBeCloseTo(1 / 0.6, 10);
    expect(scaleAndTurn(1 / 32).scale).toBeCloseTo(1 / 0.7, 10);
    expect(scaleAndTurn(3 / 32).scale).toBeCloseTo(1 / 0.5, 10);
    // `RB_CalcRotateTexCoords` turns by −degreesPerSecond · t: −499.5° at half a second,
    // which is the same turn as −139.5°.
    expect(scaleAndTurn(0.5).degrees).toBeCloseTo(-139.5, 10);
    // Both about (½, ½), so the centre never moves.
    for (const seconds of [0, 1 / 32, 0.37]) {
      const [s, t] = applyTransform(texModsAt(plasma, seconds), 0.5, 0.5);
      expect(s).toBeCloseTo(0.5, 10);
      expect(t).toBeCloseTo(0.5, 10);
    }
  });

  it('scrolls by the fractional part only, so coordinates never grow', () => {
    // −6.5 repeats is half a repeat on; 0.325 stays as it is.
    const m = texModsAt([{ type: 'scroll', s: -5, t: 0.25 }], 1.3);
    expect(m.e).toBeCloseTo(0.5, 10);
    expect(m.f).toBeCloseTo(0.325, 10);
    expect([m.a, m.b, m.c, m.d]).toEqual([1, 0, 0, 1]);
  });

  it("applies modifiers in declaration order, after the geometry's own coordinates", () => {
    // The lightning's second bolt over a two-repeat beam: scaled, then scrolled, so the scroll
    // itself is not scaled.
    const m = texModsAt(
      [
        { type: 'scale', s: -1.3, t: -1 },
        { type: 'scroll', s: -7.2, t: 0 }
      ],
      1,
      scaleTransform(2, 1)
    );
    const [s, t] = applyTransform(m, 0.5, 0.25);
    expect(s).toBeCloseTo(-1.3 * (0.5 * 2) + 0.8, 10);
    expect(t).toBeCloseTo(-0.25, 10);
  });
});

describe('turb in a map transform', () => {
  it('is no part of one', () => {
    expect(texModsAt([{ type: 'turb', wave: wave('sin', 0, 0.25, 0, 1.6) }], 1)).toEqual(IDENTITY_TRANSFORM);
  });
});

describe('environmentUvs', () => {
  /** One vertex's coordinates, with `normal`, at `position`, seen from `viewer`. */
  function seen(
    normal: readonly number[],
    viewer: readonly [number, number, number],
    position: readonly number[] = [0, 0, 0]
  ): number[] {
    return [...environmentUvs(position, normal, viewer, new Float32Array(2))];
  }

  it("shows the texture's middle on a face turned forward, seen square on", () => {
    expect(seen([1, 0, 0], [64, 0, 0])).toEqual([0.5, 0.5]);
  });

  it('mirrors the view in the normal, as RB_CalcEnvironmentTexCoords does', () => {
    // Seen from the left, flat along a forward face, the view mirrors to the right: s = ½ − ½.
    expect(seen([1, 0, 0], [0, 64, 0])).toEqual([0, 0.5]);
    // Seen from above, down onto an upward face, it mirrors straight back up: t = ½ − ½.
    expect(seen([0, 0, 1], [0, 0, 64])).toEqual([0.5, 0]);
    // Seen from 45° to the left of a forward face, it mirrors 45° to the right.
    const [s, t] = seen([1, 0, 0], [64, 64, 0]);
    expect(s).toBeCloseTo(0.5 - 0.5 * Math.SQRT1_2, 6);
    expect(t).toBe(0.5);
  });

  it('looks from each vertex, and not by how far off the viewer is', () => {
    // A vertex to the left of the origin sees a viewer ahead of it off to its right.
    const [s] = seen([1, 0, 0], [64, 0, 0], [0, 64, 0]);
    expect(s).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2, 6);
    const near = seen([1, 0, 0], [64, 64, 0]);
    seen([1, 0, 0], [640, 640, 0]).forEach((value, i) => expect(value).toBeCloseTo(near[i], 6));
  });
});
