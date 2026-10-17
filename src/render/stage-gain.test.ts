import { StandardMaterial } from 'playcanvas';
import { describe, expect, it } from 'vitest';

import type { Wave } from '../formats/shader-script';
import { animateEffect } from './effect-material';
import {
  cloneMaterial,
  drawsInFramebuffer,
  setFramebuffer,
  setGain,
  tintGain
} from './stage-gain';

/** A material's emissive colour. */
const colour = (material: StandardMaterial) => {
  const { r, g, b } = material.emissive;
  return [r, g, b];
};

/** One channel, where all three are alike. */
const grey = (material: StandardMaterial) => {
  const [r, g, b] = colour(material);
  expect([g, b]).toEqual([r, r]);
  return r;
};

const IDENTITY = { rgbGen: 'identity', blend: 'add' } as const;
const DEFAULT = { rgbGen: 'identityLighting', blend: 'blend' } as const;
const LIT = { rgbGen: 'lightingDiffuse', blend: 'opaque' } as const;
const FILTER = { rgbGen: 'identity', blend: 'filter' } as const;

describe('a stage\'s colour, kept for a change of basis', () => {
  it("is its brightness on screen until it is drawn in a scene, then the framebuffer's", () => {
    const material = new StandardMaterial();
    setGain(material, IDENTITY);
    expect(drawsInFramebuffer(material)).toBe(false);
    expect(grey(material)).toBe(2);
    setFramebuffer(material, true);
    expect(drawsInFramebuffer(material)).toBe(true);
    expect(grey(material)).toBe(1);
    setFramebuffer(material, false);
    expect(grey(material)).toBe(2);
  });

  it("draws a default stage at the framebuffer's byte, a lit one whole, and a filter at 1", () => {
    const at = (stage: Parameters<typeof setGain>[1], lit = false) => {
      const material = new StandardMaterial();
      setGain(material, stage, { lit });
      const screen = grey(material);
      setFramebuffer(material, true);
      return [screen, grey(material)];
    };
    expect(at(DEFAULT)).toEqual([1, 127 / 255]);
    // On screen its vertex colours hold half the shade, for the material to double back.
    expect(at(LIT, true)).toEqual([2, 1]);
    expect(at(FILTER)).toEqual([1, 1]);
  });

  it("takes a colour of the port's own as given on screen, under the ramp's factor in one", () => {
    const material = new StandardMaterial();
    setGain(material, null, { color: [1, 0.5, 0] });
    expect(colour(material)).toEqual([1, 0.5, 0]);
    setFramebuffer(material, true);
    expect(colour(material)).toEqual([0.5, 0.25, 0]);
  });

  it('gives a played stage its colour in the basis it draws in, and keeps its last play', () => {
    const bolt: Wave = { func: 'sin', base: 1, amplitude: 0.8, phase: 0, frequency: 8.1 };
    const animation = {
      texMods: [],
      rgbGen: 'wave' as const,
      rgbWave: bolt,
      blend: 'add' as const
    };
    const material = new StandardMaterial();
    animateEffect(material, animation, 0.25 / 8.1, { brightness: 0.5, color: [1, 1, 0] });
    // 1.8 at the peak, halved into the framebuffer and doubled by the ramp: 1.8 on screen, at half.
    expect(colour(material)[0]).toBeCloseTo(0.9, 6);
    setFramebuffer(material, true);
    // The framebuffer's byte, 229, at half.
    expect(colour(material)[0]).toBeCloseTo(229 / 255 / 2, 6);
    expect(colour(material)[2]).toBe(0);
  });

  it("copies with a drawing's clone of a stage, and multiplies by a model's tint", () => {
    const material = new StandardMaterial();
    setGain(material, IDENTITY, { color: [1, 0.5, 1] });
    const clone = cloneMaterial(material);
    expect(colour(clone)).toEqual([2, 1, 2]);
    tintGain(clone, [0.5, 1, 0]);
    expect(colour(clone)).toEqual([1, 1, 0]);
    setFramebuffer(clone, true);
    expect(colour(clone)).toEqual([0.5, 0.5, 0]);
    // The original is its own.
    expect(colour(material)).toEqual([2, 1, 2]);
  });
});
