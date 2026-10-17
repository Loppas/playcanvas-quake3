import { describe, expect, it } from 'vitest';

import type { Deform, ShaderStage, TexMod, Wave } from '../formats/shader-script';
import { noise4 } from './noise';
import {
  COORDINATES_LENGTH,
  FUNCTABLE_SIZE,
  MAX_TURBS,
  SIN_TABLE,
  animMapFrame,
  coordinatesAt,
  coordinatesMove,
  firstDrop,
  functionTableFor,
  shaderTime,
  tableStep,
  waveAlphaByte,
  waveColorByte,
  waveValue,
  writeCoordinates
} from './stage-motion';

/** A waveform, defaulting to Q3's unit shape: base 0, amplitude 1, phase 0, 1 Hz. */
function wave(func: Wave['func'], base = 0, amplitude = 1, phase = 0, frequency = 1): Wave {
  return { func, base, amplitude, phase, frequency };
}

const f = Math.fround;

describe("Q3's function tables", () => {
  it('fills the sine over 1,023 steps, its angle a float taken to double precision', () => {
    for (const i of [0, 1, 255, 256, 511, 767, 1022, 1023]) {
      const degrees = f(f(i * 360) / 1023);
      expect(SIN_TABLE[i], `${i}`).toBe(f(Math.sin((degrees * Math.PI) / 180)));
    }
    // So its top is just past the quarter, and its last step short of a whole turn's 0.
    expect(SIN_TABLE[256]).toBeLessThan(1);
    expect(SIN_TABLE[256]).toBeGreaterThan(SIN_TABLE[255]);
    expect(SIN_TABLE[1023]).toBeCloseTo(0, 6);
  });

  it('fills the others as tr_init.c does', () => {
    const at = (func: Wave['func'], i: number) => functionTableFor(func, 's')[i];
    expect([at('square', 511), at('square', 512)]).toEqual([1, -1]);
    expect([at('sawtooth', 0), at('sawtooth', 512), at('sawtooth', 1023)]).toEqual([0, 0.5, 1023 / 1024]);
    expect([at('inversesawtooth', 0), at('inversesawtooth', 512)]).toEqual([1, 0.5]);
    expect([at('triangle', 0), at('triangle', 128), at('triangle', 256), at('triangle', 384)]).toEqual([
      0, 0.5, 1, 0.5
    ]);
    expect([at('triangle', 512), at('triangle', 640), at('triangle', 768)]).toEqual([-0, -0.5, -1]);
  });

  it('drops the map for noise and a wave with no function, naming the shader', () => {
    expect(() => functionTableFor('noise', 'textures/sfx/x')).toThrow(
      new Error("TableForFunc called with invalid function '6' in shader 'textures/sfx/x'")
    );
    expect(() => functionTableFor('none', 'textures/sfx/x')).toThrow(
      new Error("TableForFunc called with invalid function '0' in shader 'textures/sfx/x'")
    );
  });

  it('steps a period in 1,024, truncating towards zero, a negative step taken from the end', () => {
    expect(tableStep(0.25)).toBe(256);
    expect(tableStep(0.25 + 0.9 / 1024)).toBe(256);
    expect(tableStep(3.5)).toBe(512);
    // -0.1 of a step truncates to 0, where a floor would take the last step.
    expect(tableStep(-0.1 / 1024)).toBe(0);
    expect(tableStep(-1.5 / 1024)).toBe(1023);
    expect(tableStep(-0.5)).toBe(512);
  });
});

describe('shaderTime', () => {
  it("is the refdef's time in seconds, held at a clampTime once it reaches it", () => {
    expect(shaderTime(12345, 0)).toBeCloseTo(12.345, 12);
    expect(shaderTime(1500, 2)).toBe(1.5);
    expect(shaderTime(2500, 2)).toBe(2);
  });

  it("starts at a swap's timeOffset, in doubles, before the clampTime holds it", () => {
    const offset = Math.fround(1.24);
    expect(shaderTime(3000, 0, offset)).toBe(3000 * 0.001 - offset);
    expect(shaderTime(1000, 0, offset)).toBeLessThan(0);
    expect(shaderTime(3500, 2, offset)).toBe(2);
    expect(shaderTime(3000, 2, offset)).toBe(3000 * 0.001 - offset);
  });
});

describe('waveValue', () => {
  it("reads the wave's table at its phase now, with no blending between steps, as a float", () => {
    const pulse = wave('sin', 0.5, 0.5, 0, 1);
    expect(waveValue(pulse, 0.25)).toBe(f(0.5 + f(SIN_TABLE[256] * 0.5)));
    // The same step until the next.
    expect(waveValue(pulse, 0.25 + 0.9 / 1024)).toBe(waveValue(pulse, 0.25));
    expect(waveValue(pulse, 0.25 + 1.1 / 1024)).toBe(f(0.5 + f(SIN_TABLE[257] * 0.5)));
    // The phase moves the step along, and the frequency scales the time.
    expect(waveValue(wave('sawtooth', 0, 1, 0.5, 2), 0.125)).toBe(0.75);
  });
});

describe('waveColorByte and waveAlphaByte', () => {
  it("truncate a wave's colour to a byte after tr.identityLight, clamped", () => {
    // 1.8 at the step, halved, is 229.49 of 255.
    const bolt = wave('sin', 1, 0.8, 0, 8.1);
    expect(waveColorByte(bolt, 0.25 / 8.1, 0.5)).toBe(229);
    expect(waveColorByte(bolt, 0.25 / 8.1, 1)).toBe(255);
    expect(waveColorByte(wave('sin', -0.5, 0.2), 0, 1)).toBe(0);
    expect(waveColorByte(wave('sawtooth', 0, 1, 0, 1), 0.5, 1)).toBe(127);
  });

  it('read a noise colour from its phase on, unscaled by tr.identityLight', () => {
    const flicker = wave('noise', 0.5, 0.5, 0.25, 2);
    for (const time of [0, 0.3, 1.7]) {
      const glow = f(0.5 + f(noise4(0, 0, 0, (time + 0.25) * 2) * 0.5));
      expect(waveColorByte(flicker, time, 0.5), `${time}`).toBe(Math.trunc(f(255 * Math.min(1, glow))));
    }
  });

  it("truncate a wave's alpha to a byte, clamped first, and drop the map for noise there", () => {
    expect(waveAlphaByte(wave('sawtooth', 0, 1, 0, 1), 0.5)).toBe(127);
    expect(waveAlphaByte(wave('sin', 0, 2), 0.25)).toBe(255);
    expect(waveAlphaByte(wave('sin', 0, 2), 0.75)).toBe(0);
    expect(() => waveAlphaByte(wave('noise'), 0, 'textures/x')).toThrow(
      "TableForFunc called with invalid function '6' in shader 'textures/x'"
    );
  });
});

describe('animMapFrame', () => {
  it('runs a flipbook on the sine table steps, shifted down and wrapped to its frames', () => {
    expect(animMapFrame(0.25, 10, 8)).toBe(2);
    expect(animMapFrame(0.2999, 10, 8)).toBe(2);
    expect(animMapFrame(1, 10, 8)).toBe(2);
    expect(animMapFrame(0.75, 4, 4)).toBe(3);
    // Before the clock starts, and for a texture of one image, the first.
    expect(animMapFrame(-0.5, 10, 8)).toBe(0);
    expect(animMapFrame(3, 10, 1)).toBe(0);
  });
});

/**
 * `ComputeTexCoords`' loop over one vertex, as opengl1 runs it (`tr_shade.c:878-930`), each
 * modifier's function in `tr_shade_calc.c` applied in turn to coordinates held in floats.
 */
function q3TexCoords(
  mods: readonly TexMod[],
  time: number,
  start: readonly [number, number],
  xyz: readonly [number, number, number]
): [number, number] {
  let [s, t] = [f(start[0]), f(start[1])];
  const transform = (m00: number, m10: number, t0: number, m01: number, m11: number, t1: number) => {
    [s, t] = [f(f(f(s * m00) + f(t * m10)) + t0), f(f(f(s * m01) + f(t * m11)) + t1)];
  };
  const step = (x: number) => {
    const scaled = Math.trunc(x * FUNCTABLE_SIZE);
    return (scaled & (FUNCTABLE_SIZE - 1)) >>> 0;
  };
  for (const mod of mods) {
    switch (mod.type) {
      case 'none':
        return [s, t];
      case 'turb': {
        const now = mod.wave.phase + time * mod.wave.frequency;
        const across = f(xyz[0] + xyz[2]);
        s = f(s + f(SIN_TABLE[step((across * 1.0) / 128 * 0.125 + now)] * mod.wave.amplitude));
        t = f(t + f(SIN_TABLE[step((xyz[1] * 1.0) / 128 * 0.125 + now)] * mod.wave.amplitude));
        break;
      }
      case 'scale':
        [s, t] = [f(s * mod.s), f(t * mod.t)];
        break;
      case 'scroll': {
        const ds = mod.s * time;
        const dt = mod.t * time;
        [s, t] = [f(s + (ds - Math.floor(ds))), f(t + (dt - Math.floor(dt)))];
        break;
      }
      case 'transform': {
        const [m00, m01, m10, m11] = mod.matrix;
        transform(m00, m10, mod.translate[0], m01, m11, mod.translate[1]);
        break;
      }
      case 'rotate': {
        const degrees = -mod.degreesPerSecond * time;
        const index = Math.trunc(degrees * f(1024 / 360));
        const sin = SIN_TABLE[index & 1023];
        const cos = SIN_TABLE[(index + 256) & 1023];
        transform(cos, -sin, f(0.5 - 0.5 * cos + 0.5 * sin), sin, cos, f(0.5 - 0.5 * sin - 0.5 * cos));
        break;
      }
      case 'stretch': {
        const p = f(1 / waveValue(mod.wave, time));
        transform(p, 0, f(0.5 - f(0.5 * p)), 0, p, f(0.5 - f(0.5 * p)));
        break;
      }
      case 'entityTranslate':
        break;
    }
  }
  return [s, t];
}

const RIPPLE: Wave = wave('sin', 0, 0.25, 0.1, 1.6);
const STRETCH: Wave = wave('triangle', 0.6, 0.1, 0, 8);

/** Vertexes on both sides of the origin, one whose step a floor would take one short. */
const VERTEXES: readonly (readonly [readonly [number, number], readonly [number, number, number]])[] = [
  [
    [0.1, 0.2],
    [0, 0, 0]
  ],
  [
    [0.7, -0.3],
    [120.5, 40.25, 300.75]
  ],
  [
    [1.3, 2.9],
    [-1000.75, -333.5, 700.25]
  ],
  [
    [-0.4, 0.6],
    [-300.7, -512.3, 0]
  ]
];

/** Every vertex of {@link VERTEXES} through `mods` at `time`, both ways. */
function bothWays(mods: readonly TexMod[], time: number): void {
  const pieces = new Float32Array(COORDINATES_LENGTH);
  writeCoordinates(mods, time, pieces);
  const out: [number, number] = [0, 0];
  for (const [st, xyz] of VERTEXES) {
    const expected = q3TexCoords(mods, time, st, xyz);
    coordinatesAt(pieces, st[0], st[1], xyz[0], xyz[1], xyz[2], out);
    const label = `${mods.map((mod) => mod.type).join(' ')} at ${time}, ${st}`;
    expect(out[0], label).toBeCloseTo(expected[0], 4);
    expect(out[1], label).toBeCloseTo(expected[1], 4);
  }
}

describe('writeCoordinates', () => {
  it('lays out a count, then two rows for each piece, and a vec4 for each turb between them', () => {
    const pieces = new Float32Array(COORDINATES_LENGTH).fill(9);
    writeCoordinates([], 5, pieces);
    expect([...pieces.subarray(0, 12)]).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
    writeCoordinates(
      [
        { type: 'scale', s: 2, t: 3 },
        { type: 'turb', wave: wave('sin', 0, 0.25, 0.5, 2) }
      ],
      1.3,
      pieces
    );
    // One turb: the scale, then the turb's amplitude, fraction and whole periods, then identity.
    expect([...pieces.subarray(0, 24)]).toEqual(
      [1, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0, 0.25, 0.1, 3, 0, 1, 0, 0, 0, 0, 1, 0, 0].map(f)
    );
    expect(COORDINATES_LENGTH).toBe(4 * (1 + 3 * MAX_TURBS + 2));
  });

  it('moves coordinates as ComputeTexCoords does, each tcMod in its place, at chosen times', () => {
    const transform: TexMod = { type: 'transform', matrix: [1.5, 0, 1.5, 1], translate: [1, 2] };
    for (const time of [0, 0.37, 12.6, 86_400.37]) {
      bothWays([{ type: 'scale', s: 2, t: 0.5 }, { type: 'scroll', s: -5, t: 0.25 }], time);
      bothWays([{ type: 'rotate', degreesPerSecond: 999 }], time);
      bothWays([{ type: 'rotate', degreesPerSecond: -17.3 }, { type: 'stretch', wave: STRETCH }], time);
      bothWays([{ type: 'scale', s: 2, t: 2 }, transform, { type: 'scroll', s: 0.01, t: 0.03 }], time);
      // A turn then a skew, which compose differently the other way round.
      bothWays([{ type: 'rotate', degreesPerSecond: 45 }, transform], time);
      // turb after a scale and a scroll, which a ripple added before the whole transform misplaces.
      bothWays([{ type: 'scale', s: 3, t: 3 }, { type: 'scroll', s: 0.1, t: 0 }, { type: 'turb', wave: RIPPLE }], time);
      bothWays([{ type: 'turb', wave: RIPPLE }, { type: 'scale', s: 3, t: 3 }, { type: 'scroll', s: 0.1, t: 0 }], time);
      bothWays([{ type: 'rotate', degreesPerSecond: 30 }, { type: 'turb', wave: RIPPLE }, { type: 'scale', s: 1, t: 2 }, { type: 'scroll', s: 1, t: 2 }], time);
      bothWays([1, 2, 3, 4].map((n) => ({ type: 'turb', wave: wave('sin', 0, 0.1 * n, 0.3 * n, n) }) as TexMod), time);
    }
  });

  it('truncates a turb step towards zero on the side its whole sum falls', () => {
    // At 0.1 of a period, x + z of −300.7 sums to −198.3 steps: Q3 takes −198, a floor −199.
    const pieces = new Float32Array(COORDINATES_LENGTH);
    writeCoordinates([{ type: 'turb', wave: wave('sin', 0, 1, 0.1, 0) }], 0, pieces);
    const [s] = coordinatesAt(pieces, 0, 0, -300.7, 0, 0, [0, 0]);
    expect(s).toBe(SIN_TABLE[1024 - 198]);
    expect(s).not.toBe(SIN_TABLE[1024 - 199]);
  });

  it('stops at an empty slot, as tm = TR_MAX_TEXMODS breaks the loop', () => {
    const pieces = new Float32Array(COORDINATES_LENGTH);
    writeCoordinates([{ type: 'scale', s: 2, t: 2 }, { type: 'none' }, { type: 'scale', s: 5, t: 5 }], 0, pieces);
    expect([...pieces.subarray(4, 12)]).toEqual([2, 0, 0, 0, 0, 2, 0, 0]);
  });

  it('moves nothing for the world entity, whose shaderTexCoord is 0', () => {
    const pieces = new Float32Array(COORDINATES_LENGTH);
    writeCoordinates([{ type: 'entityTranslate' }], 7, pieces);
    expect([...pieces.subarray(0, 12)]).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
  });

  it("drops the map for a stretch with no table, naming the shader", () => {
    expect(() =>
      writeCoordinates([{ type: 'stretch', wave: wave('noise') }], 0, new Float32Array(COORDINATES_LENGTH), 'q')
    ).toThrow("TableForFunc called with invalid function '6' in shader 'q'");
  });
});

describe('coordinatesMove', () => {
  it('moves a scroll, a turn, a stretch or a ripple, and nothing else or after an empty slot', () => {
    expect(coordinatesMove([{ type: 'scroll', s: 0, t: 0.1 }])).toBe(true);
    expect(coordinatesMove([{ type: 'scroll', s: 0, t: 0 }])).toBe(false);
    expect(coordinatesMove([{ type: 'rotate', degreesPerSecond: 3 }])).toBe(true);
    expect(coordinatesMove([{ type: 'stretch', wave: STRETCH }])).toBe(true);
    expect(coordinatesMove([{ type: 'turb', wave: RIPPLE }])).toBe(true);
    expect(coordinatesMove([{ type: 'scale', s: 2, t: 2 }, { type: 'entityTranslate' }])).toBe(false);
    expect(coordinatesMove([{ type: 'none' }, { type: 'turb', wave: RIPPLE }])).toBe(false);
  });
});

/** A stage as the parser leaves one, with `rest` over it. */
function stage(rest: Partial<ShaderStage> = {}): ShaderStage {
  return { maps: ['x'], animFps: 0, blend: 'opaque', depthWrite: true, clamp: false, texMods: [], rgbGen: 'identity', ...rest };
}

describe('firstDrop', () => {
  const none = wave('none');
  const noise = wave('noise');

  it('finds none in a shader that draws, a noise colour among it', () => {
    expect(firstDrop('s', [], [stage({ rgbGen: 'wave', rgbWave: noise })])).toBeUndefined();
  });

  it("drops in opengl1's order: the deforms, then each stage's colour, coordinates and blend", () => {
    const wavy: Deform = { type: 'wave', spread: 0, wave: none };
    const moved: Deform = { type: 'move', vector: [0, 0, 1], wave: noise };
    const blendless = stage({ blendFactors: ['gl_one', undefined], blend: 'add' });
    const colour = stage({ rgbGen: 'wave', rgbWave: none });
    const alpha = stage({ alphaGen: 'wave', alphaWave: noise });
    const stretch = stage({ texMods: [{ type: 'stretch', wave: none }] });
    const table = (n: number) => `TableForFunc called with invalid function '${n}' in shader 's'`;
    expect(firstDrop('s', [{ type: 'bulge', width: 1, height: 1, speed: 1 }, wavy], [blendless])).toBe(table(0));
    expect(firstDrop('s', [moved], [colour])).toBe(table(6));
    expect(firstDrop('s', [], [blendless, colour])).toBe('GL_State: invalid dst blend state bits');
    expect(firstDrop('s', [], [colour, blendless])).toBe(table(0));
    expect(firstDrop('s', [], [alpha])).toBe(table(6));
    expect(firstDrop('s', [], [stretch])).toBe(table(0));
    // A merged stage's second texture's coordinates, after its first's.
    const merged = stage({ multitexture: { ...stage(), texMods: [{ type: 'stretch', wave: noise }], env: 'modulate' } });
    expect(firstDrop('s', [], [merged])).toBe(table(6));
    // A stretch after an empty slot is never reached.
    expect(firstDrop('s', [], [stage({ texMods: [{ type: 'none' }, { type: 'stretch', wave: none }] })])).toBeUndefined();
  });
});
