import { describe, expect, it } from 'vitest';

import type { Wave } from '../formats/shader-script';
import { NOISE, fillNoise, noise4 } from './noise';
import {
  CLASSIC_FULLSCREEN,
  framebufferAlpha,
  framebufferColor,
  framebufferGain,
  identityLight,
  multipliesColor,
  overbrightFactor,
  rendererStyle,
  sceneStyle,
  setRendererStyle,
  stageGain,
  type RendererStyle
} from './overbright';

/** The lightning's second bolt (pak6 `lightningnew.shader`): 0.2 to 1.8. */
const BOLT: Wave = { func: 'sin', base: 1, amplitude: 0.8, phase: 0, frequency: 8.1 };

/** The crackle's first stage (`models/weaphits/electric`): −1.2 to 2.8. */
const CRACKLE: Wave = { func: 'triangle', base: 0.8, amplitude: 2, phase: 0, frequency: 9 };

/** An explosion's fade, `inversesawtooth 0 1 0 5`: 1 down to 0. */
const BOOM: Wave = { func: 'inversesawtooth', base: 0, amplitude: 1, phase: 0, frequency: 5 };

/** Q3 in a window, where `opengl1` never overbrights. */
const WINDOW: RendererStyle = { renderer: 'opengl1', overBrightBits: 0 };

const OPENGL2: RendererStyle = { renderer: 'opengl2', overBrightBits: 1 };

describe('stageGain in classic Q3, fullscreen', () => {
  it("draws a default stage at its texture's own brightness, however it blends", () => {
    for (const blend of ['opaque', 'add', 'blend'] as const) {
      expect(stageGain({ rgbGen: 'identityLighting', blend }, 0), blend).toBe(1);
    }
    // The fraction it is drawn at, and the ramp's multiplier, cancel.
    expect(identityLight(CLASSIC_FULLSCREEN) * overbrightFactor(CLASSIC_FULLSCREEN)).toBe(1);
  });

  it('draws rgbGen identity at twice a default stage, unless it is a filter', () => {
    expect(stageGain({ rgbGen: 'identity', blend: 'add' }, 0)).toBe(2);
    expect(stageGain({ rgbGen: 'identity', blend: 'opaque' }, 0)).toBe(2);
    // A filter multiplies a framebuffer already at half, and the ramp restores the product.
    expect(stageGain({ rgbGen: 'identity', blend: 'filter' }, 0)).toBe(1);
  });

  it('holds any stage that multiplies colour by colour to 1, whatever its mode, in either renderer', () => {
    // A player skin's shine: its texture times the framebuffer's colour, and a highlight.
    const shine = {
      rgbGen: 'identity',
      blend: 'blend',
      blendFactors: ['gl_dst_color', 'gl_src_alpha']
    } as const;
    expect(stageGain(shine, 0)).toBe(1);
    expect(stageGain(shine, 0, OPENGL2)).toBe(1);
    expect(stageGain({ ...shine, blendFactors: ['gl_src_alpha', 'gl_one_minus_src_alpha'] }, 0)).toBe(2);
    // `ComputeShaderColors`' four: the framebuffer's colour as the source's factor, or the stage's
    // as the framebuffer's.
    for (const pair of [
      'gl_dst_color gl_one',
      'gl_one_minus_dst_color gl_zero',
      'gl_one gl_src_color',
      'gl_zero gl_one_minus_src_color'
    ]) {
      const [source, framebuffer] = pair.split(' ');
      expect(multipliesColor({ blend: 'blend', blendFactors: [source, framebuffer] }), pair).toBe(true);
    }
    expect(multipliesColor({ blend: 'add', blendFactors: ['gl_one', 'gl_one'] })).toBe(false);
    // With no factors, only a filter does.
    expect(multipliesColor({ blend: 'filter' })).toBe(true);
  });

  it('lets a wave climb past 1 to twice a default stage, halving it before the clamp', () => {
    const bolt = { rgbGen: 'wave', rgbWave: BOLT, blend: 'add' } as const;
    expect(stageGain(bolt, 0.25 / 8.1)).toBeCloseTo(1.8, 10);
    expect(stageGain(bolt, 0.75 / 8.1)).toBeCloseTo(0.2, 10);
    // 2.8 stops at 2, and below 0 the stage is dark.
    const crackle = { rgbGen: 'wave', rgbWave: CRACKLE, blend: 'add' } as const;
    expect(stageGain(crackle, 0.25 / 9)).toBe(2);
    expect(stageGain(crackle, 0.75 / 9)).toBe(0);
  });

  it('leaves a wave that stays within 1 as it was: the explosions', () => {
    expect(stageGain({ rgbGen: 'wave', rgbWave: BOOM, blend: 'add' }, 0.1)).toBeCloseTo(0.5, 10);
  });

  it('draws the vertex colour at itself, and an exact one at twice', () => {
    expect(stageGain({ rgbGen: 'vertex', blend: 'add' }, 0)).toBe(1);
    expect(stageGain({ rgbGen: 'exactVertex', blend: 'add' }, 0)).toBe(2);
  });

  it('draws rgbGen entity as it draws identity: the colour as it is, for the ramp to double', () => {
    // `RB_CalcColorFromEntity` copies the entity's colour, unscaled by `identityLight`.
    expect(stageGain({ rgbGen: 'entity', blend: 'add' }, 0)).toBe(2);
    expect(stageGain({ rgbGen: 'entity', blend: 'filter' }, 0)).toBe(1);
  });

  it("holds a scripted lightingDiffuse at a default stage's brightness, as the port draws it flat", () => {
    expect(stageGain({ rgbGen: 'lightingDiffuse', blend: 'opaque' }, 0)).toBe(1);
  });
});

describe('stageGain in a window, at r_overBrightBits 0', () => {
  it("draws every stage at its texture's brightness, and stops waves at 1", () => {
    expect(stageGain({ rgbGen: 'identity', blend: 'add' }, 0, WINDOW)).toBe(1);
    expect(stageGain({ rgbGen: 'identityLighting', blend: 'add' }, 0, WINDOW)).toBe(1);
    expect(stageGain({ rgbGen: 'wave', rgbWave: BOLT, blend: 'add' }, 0.25 / 8.1, WINDOW)).toBe(1);
  });
});

describe('stageGain in opengl2', () => {
  it('doubles rgbGen identity, as classic Q3 shows it, but not a filter', () => {
    expect(stageGain({ rgbGen: 'identity', blend: 'add' }, 0, OPENGL2)).toBe(2);
    expect(stageGain({ rgbGen: 'identity', blend: 'filter' }, 0, OPENGL2)).toBe(1);
    expect(stageGain({ rgbGen: 'identityLighting', blend: 'add' }, 0, OPENGL2)).toBe(1);
  });

  it('halves every wave: it keeps identityLight, with no ramp to take it back', () => {
    const bolt = { rgbGen: 'wave', rgbWave: BOLT, blend: 'add' } as const;
    expect(stageGain(bolt, 0.25 / 8.1, OPENGL2)).toBeCloseTo(0.9, 10);
    const boom = { rgbGen: 'wave', rgbWave: BOOM, blend: 'add' } as const;
    expect(stageGain(boom, 0.1, OPENGL2)).toBeCloseTo(0.25, 10);
    // The crackle's 2.8 halves to 1.4, and stops at 1.
    const crackle = { rgbGen: 'wave', rgbWave: CRACKLE, blend: 'add' } as const;
    expect(stageGain(crackle, 0.25 / 9, OPENGL2)).toBe(1);
  });

  it('draws entity and vertex at their colour, unmultiplied', () => {
    expect(stageGain({ rgbGen: 'entity', blend: 'add' }, 0, OPENGL2)).toBe(1);
    expect(stageGain({ rgbGen: 'vertex', blend: 'add' }, 0, OPENGL2)).toBe(1);
  });

  it('draws everything at 1 at r_overBrightBits 0, with waves stopped at 1', () => {
    const off: RendererStyle = { renderer: 'opengl2', overBrightBits: 0 };
    expect(stageGain({ rgbGen: 'identity', blend: 'add' }, 0, off)).toBe(1);
    expect(stageGain({ rgbGen: 'wave', rgbWave: BOLT, blend: 'add' }, 0.25 / 8.1, off)).toBe(1);
  });
});

describe("framebufferColor: a world stage's colour in opengl1's framebuffer", () => {
  const TWO_BITS: RendererStyle = { renderer: 'opengl1', overBrightBits: 2 };
  /** One channel, where all three are alike. */
  const grey = (...args: Parameters<typeof framebufferColor>) => {
    const [red, green, blue] = framebufferColor(...args);
    expect([green, blue]).toEqual([red, red]);
    return red;
  };

  it('draws identity, exactVertex and oneMinusEntity at 1, at any bits, filter or not', () => {
    for (const style of [WINDOW, CLASSIC_FULLSCREEN, TWO_BITS]) {
      expect(grey({ rgbGen: 'identity' }, 0, style)).toBe(1);
      expect(grey({ rgbGen: 'exactVertex' }, 0, style)).toBe(1);
      // The world entity's colour is 0, so its inverse is white.
      expect(grey({ rgbGen: 'oneMinusEntity' }, 0, style)).toBe(1);
    }
  });

  it('draws identityLighting at identityLightByte, truncated to a byte', () => {
    const lighting = (style: RendererStyle) => grey({ rgbGen: 'identityLighting' }, 0, style);
    expect([WINDOW, CLASSIC_FULLSCREEN, TWO_BITS].map(lighting)).toEqual([1, 127 / 255, 63 / 255]);
  });

  it('draws the vertex colour, and its inverse, at identityLight', () => {
    expect(grey({ rgbGen: 'vertex' }, 0, WINDOW)).toBe(1);
    expect(grey({ rgbGen: 'vertex' }, 0)).toBe(0.5);
    expect(grey({ rgbGen: 'vertex' }, 0, TWO_BITS)).toBe(0.25);
    expect(grey({ rgbGen: 'oneMinusVertex' }, 0)).toBe(0.5);
    expect(grey({ rgbGen: 'oneMinusVertex' }, 0, TWO_BITS)).toBe(0.25);
  });

  it('clamps a wave after identityLight multiplies it, and truncates it to a byte', () => {
    const bolt = { rgbGen: 'wave', rgbWave: BOLT } as const;
    // 1.8 at the sine table's step, halved: 229.49 of 255, truncated as `ri.ftol` truncates.
    expect(grey(bolt, 0.25 / 8.1)).toBe(229 / 255);
    expect(grey(bolt, 0.25 / 8.1, WINDOW)).toBe(1);
    const crackle = { rgbGen: 'wave', rgbWave: CRACKLE } as const;
    // 2.8 halves to 1.4 and stops at 1; −1.2 stops at 0.
    expect(grey(crackle, 0.25 / 9)).toBe(1);
    expect(grey(crackle, 0.75 / 9)).toBe(0);
  });

  it('reads a noise wave from its phase on, unscaled by identityLight, clamped', () => {
    const flicker: Wave = { func: 'noise', base: 0.5, amplitude: 0.5, phase: 0.25, frequency: 2 };
    const at = (seconds: number, noise = NOISE) =>
      Math.min(1, Math.max(0, 0.5 + noise4(0, 0, 0, (seconds + 0.25) * 2, noise) * 0.5));
    for (const seconds of [0, 0.3, 1.7]) {
      const byte = Math.trunc(255 * at(seconds));
      expect(grey({ rgbGen: 'wave', rgbWave: flicker }, seconds)).toBe(byte / 255);
    }
    // Where the noise is, the phase taken before the frequency differs from after it. Read on a
    // table from a fixed sequence: the port's own is random, and about one in 140 puts the two
    // within the margin.
    let draw = 0;
    const fixed = fillNoise(() => (draw++ * 0.618034) % 1);
    expect(at(0.3, fixed)).not.toBeCloseTo(0.5 + noise4(0, 0, 0, 0.3 * 2 + 0.25, fixed) * 0.5, 3);
  });

  it('drops the map for a wave with no function, as TableForFunc does', () => {
    const none: Wave = { func: 'none', base: 0, amplitude: 0, phase: 0, frequency: 0 };
    expect(() => framebufferColor({ rgbGen: 'wave', rgbWave: none }, 0)).toThrow(
      "TableForFunc called with invalid function '0'"
    );
  });

  it('draws const at its colour, a channel each', () => {
    const constant = { rgbGen: 'const', constantColor: [255, 127, 0, 0] } as const;
    expect(framebufferColor(constant, 0)).toEqual([1, 127 / 255, 0]);
    // Into the array given.
    const out: [number, number, number] = [9, 9, 9];
    expect(framebufferColor(constant, 0, WINDOW, out)).toBe(out);
    expect(out).toEqual([1, 127 / 255, 0]);
  });

  it("draws entity black, the world entity's colour unset, and lightingDiffuse as lit", () => {
    expect(grey({ rgbGen: 'entity' }, 0)).toBe(0);
    // Its vertices' colours are its entity's light: a brush model's, or the world entity's 0.
    expect(grey({ rgbGen: 'lightingDiffuse' }, 0)).toBe(1);
  });

  it('draws the same under opengl2, by its overbright bits', () => {
    expect(grey({ rgbGen: 'identityLighting' }, 0, OPENGL2)).toBe(127 / 255);
    expect(grey({ rgbGen: 'identity' }, 0, OPENGL2)).toBe(1);
  });
});

describe("framebufferAlpha: a world stage's alpha in opengl1's framebuffer", () => {
  const alpha = (stage: Parameters<typeof framebufferAlpha>[0], style?: RendererStyle) =>
    framebufferAlpha(stage, style);

  it("gives 1 at alphaGen identity, but the vertices' at rgbGen vertex with no overbright", () => {
    expect(alpha({ rgbGen: 'identityLighting' })).toBe(1);
    expect(alpha({ rgbGen: 'identityLighting', alphaGen: 'identity' })).toBe(1);
    expect(alpha({ rgbGen: 'entity', alphaGen: 'identity' })).toBe(1);
    expect(alpha({ rgbGen: 'vertex', alphaGen: 'identity' })).toBe(1);
    expect(alpha({ rgbGen: 'vertex', alphaGen: 'identity' }, WINDOW)).toBe('vertex');
  });

  it("takes its rgbGen's at skip: the world entity's 0, and lightingDiffuse's as lit", () => {
    expect(alpha({ rgbGen: 'identity', alphaGen: 'skip' })).toBe(1);
    // The world entity's light's byte's 0, and a brush model's 255.
    expect(alpha({ rgbGen: 'lightingDiffuse', alphaGen: 'skip' })).toBe('vertex');
    expect(alpha({ rgbGen: 'exactVertex', alphaGen: 'skip' })).toBe('vertex');
    expect(alpha({ rgbGen: 'identityLighting', alphaGen: 'skip' })).toBe(127 / 255);
    expect(alpha({ rgbGen: 'identityLighting', alphaGen: 'skip' }, WINDOW)).toBe(1);
    expect(alpha({ rgbGen: 'entity', alphaGen: 'skip' })).toBe(0);
    expect(alpha({ rgbGen: 'oneMinusEntity', alphaGen: 'skip' })).toBe(1);
    expect(alpha({ rgbGen: 'wave', alphaGen: 'skip' })).toBe(1);
    expect(alpha({ rgbGen: 'const', alphaGen: 'skip', constantColor: [0, 0, 0, 51] })).toBe(0.2);
  });

  it("gives the world entity's 0 and its inverse's 1, and const's alpha", () => {
    expect(alpha({ rgbGen: 'identity', alphaGen: 'entity' })).toBe(0);
    expect(alpha({ rgbGen: 'identity', alphaGen: 'oneMinusEntity' })).toBe(1);
    expect(alpha({ rgbGen: 'identity', alphaGen: 'const', constantColor: [0, 0, 0, 51] })).toBe(
      0.2
    );
    expect(alpha({ rgbGen: 'vertex', alphaGen: 'vertex' })).toBe('vertex');
  });

  it('gives none where it moves or differs a vertex', () => {
    for (const alphaGen of ['wave', 'lightingSpecular', 'oneMinusVertex', 'portal'] as const) {
      expect(alpha({ rgbGen: 'identity', alphaGen }), alphaGen).toBeUndefined();
    }
  });
});

describe('rendererStyle', () => {
  it('starts as classic Q3 in fullscreen, and takes the style it is set to', () => {
    expect(rendererStyle()).toEqual(CLASSIC_FULLSCREEN);
    setRendererStyle(OPENGL2);
    try {
      expect(rendererStyle()).toEqual(OPENGL2);
      // What everything drawn without a style of its own picks up.
      expect(stageGain({ rgbGen: 'wave', rgbWave: BOOM, blend: 'add' }, 0.1)).toBeCloseTo(0.25, 10);
    } finally {
      setRendererStyle(CLASSIC_FULLSCREEN);
    }
  });
});

describe("framebufferGain: a model's or an effect's stage in opengl1's framebuffer", () => {
  const TWO_BITS: RendererStyle = { renderer: 'opengl1', overBrightBits: 2 };

  it('draws identity, exactVertex, entity and lightingDiffuse at 1: their colours whole', () => {
    for (const style of [WINDOW, CLASSIC_FULLSCREEN, TWO_BITS, OPENGL2]) {
      for (const rgbGen of ['identity', 'exactVertex', 'entity', 'lightingDiffuse'] as const) {
        expect(framebufferGain({ rgbGen }, 0, style), rgbGen).toBe(1);
      }
    }
  });

  it('draws a default stage at identityLightByte, and the vertex colour at identityLight', () => {
    const lighting = (style: RendererStyle) =>
      framebufferGain({ rgbGen: 'identityLighting' }, 0, style);
    expect([WINDOW, CLASSIC_FULLSCREEN, TWO_BITS].map(lighting)).toEqual([1, 127 / 255, 63 / 255]);
    expect(framebufferGain({ rgbGen: 'vertex' }, 0)).toBe(0.5);
    expect(framebufferGain({ rgbGen: 'vertex' }, 0, TWO_BITS)).toBe(0.25);
    // A colour a model draws none of, as on screen: a default stage's.
    for (const rgbGen of ['const', 'oneMinusEntity', 'oneMinusVertex'] as const) {
      expect(framebufferGain({ rgbGen }, 0), rgbGen).toBe(127 / 255);
    }
  });

  it('clamps a wave in the framebuffer and truncates it to a byte, for the ramp to double', () => {
    const bolt = { rgbGen: 'wave', rgbWave: BOLT, blend: 'add' } as const;
    expect(framebufferGain(bolt, 0.25 / 8.1)).toBe(229 / 255);
    // The crackle's 2.8, halved, past 1: the framebuffer's byte stops at 255, which the ramp
    // doubles to the 2 the screen's gain has.
    const crackle = { rgbGen: 'wave', rgbWave: CRACKLE, blend: 'add' } as const;
    expect(framebufferGain(crackle, 0.25 / 9)).toBe(1);
    expect(stageGain(crackle, 0.25 / 9)).toBe(2);
    // No wave given draws as a default stage.
    expect(framebufferGain({ rgbGen: 'wave' }, 0)).toBe(127 / 255);
  });

  it("draws opengl1's values under opengl2's style, as a map's scene draws its models", () => {
    expect(framebufferGain({ rgbGen: 'identityLighting' }, 0, OPENGL2)).toBe(127 / 255);
    expect(sceneStyle(OPENGL2)).toEqual({ renderer: 'opengl1', overBrightBits: 1 });
    expect(sceneStyle(CLASSIC_FULLSCREEN)).toBe(CLASSIC_FULLSCREEN);
  });

  it("differs from the screen's by the ramp's factor where nothing is clamped or cut", () => {
    for (const rgbGen of ['identity', 'vertex', 'entity'] as const) {
      const stage = { rgbGen, blend: 'add' } as const;
      expect(framebufferGain(stage, 0) * 2, rgbGen).toBe(stageGain(stage, 0));
    }
  });
});
