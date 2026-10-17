// @vitest-environment jsdom
import {
  ADDRESS_CLAMP_TO_EDGE,
  ADDRESS_REPEAT,
  BLEND_ADDITIVE,
  BLEND_NONE,
  BLEND_NORMAL,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDMODE_SRC_ALPHA,
  BLENDMODE_ZERO,
  CULLFACE_BACK,
  PIXELFORMAT_RGBA8,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  ShaderChunks,
  StandardMaterial,
  Texture,
  type AppBase
} from 'playcanvas';
import { Preprocessor } from 'playcanvas/build/playcanvas/src/core/preprocessor.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Multitexture, ShaderStage, TexMod, Wave } from '../formats/shader-script';
import { AssetLibrary } from '../formats/asset-library';
import { evalWave, scaleTransform } from '../view/shader-animation';
import {
  MULTITEXTURE_CHUNKS,
  animateEffect,
  blendOver,
  createEffectStages,
  createStage,
  exactBlend,
  isAnimated,
  playMultitexture,
  playStage,
  type ImageSource,
  type StageAnimation
} from './effect-material';
import {
  assembledShaders,
  createTestApp,
  expectClose,
  expectInOrder
} from './engine-test-fixtures';

/**
 * Effect materials against the engine they drive: that a shader builds one material per stage,
 * each blended as its stage says; that a `clampMap` stage uploads clamped; and that the map
 * transform {@link animateEffect} sets is the one Q3's texture modifiers produce — read back
 * through PlayCanvas' own uniform, so the test fails if the engine's convention moves.
 */

const STRETCH: Wave = { func: 'triangle', base: 0.6, amplitude: 0.1, phase: 0, frequency: 8 };
const PLASMA: TexMod[] = [
  { type: 'stretch', wave: STRETCH },
  { type: 'rotate', degreesPerSecond: 999 }
];

/** A plain additive stage's colour: what a `blendFunc add` stage with no `rgbGen` parses to. */
const ADD = { rgbGen: 'identityLighting', blend: 'add' } as const;

/** The lightning's two bolts (pak6 `lightningnew.shader`): a scale, then a scroll. */
const BOLTS = [
  { scale: [2, 1], scroll: [-5, 0] },
  { scale: [-1.3, -1], scroll: [-7.2, 0] }
] as const;

/**
 * Q3's own sequence for `plasmaExplosion`: `RB_CalcStretchTexCoords`, then
 * `RB_CalcRotateTexCoords`, each through `RB_CalcTransformTexCoords`'s
 * `s' = s·m00 + t·m10 + tx`, `t' = s·m01 + t·m11 + ty`.
 */
function q3Plasma(u: number, v: number, seconds: number): [number, number] {
  const p = 1 / evalWave(STRETCH, seconds);
  const s1 = u * p + (0.5 - 0.5 * p);
  const t1 = v * p + (0.5 - 0.5 * p);

  const radians = (-999 * seconds * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return [
    s1 * cos + t1 * -sin + (0.5 - 0.5 * cos + 0.5 * sin),
    s1 * sin + t1 * cos + (0.5 - 0.5 * sin - 0.5 * cos)
  ];
}

/** `x − floor(x)`, as `RB_CalcScrollTexCoords` keeps a scroll. */
function frac(x: number): number {
  return x - Math.floor(x);
}

/** A typed property of a material, as the engine writes it into the material's uniform buffer. */
interface BufferProperty {
  backingName: string;
  convert(value: unknown, storage: Float32Array, offset: number, material: StandardMaterial): void;
}

/** A uniform of the material's uniform buffer, as PlayCanvas converts its property into it. */
function bufferUniform(material: StandardMaterial, name: string, size: number): number[] {
  const property = (
    material as unknown as { getUniformBufferProperty(name: string): BufferProperty | null }
  ).getUniformBufferProperty(name);
  expect(property, name).not.toBeNull();
  const value = (material as unknown as Record<string, unknown>)[property!.backingName];
  const out = new Float32Array(size);
  property!.convert(value, out, 0, material);
  return [...out];
}

/** The two rows PlayCanvas samples a map through: `uv' = (dot((u, v, 1), T0), dot(…, T1))`. */
function mapTransform(material: StandardMaterial, map: 'emissive' | 'opacity'): number[][] {
  return [0, 1].map((half) => bufferUniform(material, `texture_${map}MapTransform${half}`, 3));
}

/** A material with a colour map: the engine keeps a map's transform only while it has the map. */
function mappedMaterial(app: AppBase): StandardMaterial {
  const material = new StandardMaterial();
  material.emissiveMap = new Texture(app.graphicsDevice, { width: 1, height: 1 });
  return material;
}

/** A 2 × 2 white 32-bit TGA, top-left origin. */
function tga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 0x28];
  return new Uint8Array([...header, ...new Array(2 * 2 * 4).fill(255)]);
}

describe('animateEffect', () => {
  it("samples where Q3's stretch and rotate put each coordinate", () => {
    const { app } = createTestApp();
    const material = mappedMaterial(app);
    for (const seconds of [0, 0.02, 1 / 32, 0.1, 0.37]) {
      animateEffect(material, { ...ADD, texMods: PLASMA }, seconds);
      const [row0, row1] = mapTransform(material, 'emissive');
      for (const [u, v] of [[0, 0], [1, 0], [0.3, 0.8], [0.5, 0.5], [1, 1]]) {
        const [q3u, q3v] = q3Plasma(u, v, seconds);
        const at = `t = ${seconds}, uv = (${u}, ${v})`;
        expect(row0[0] * u + row0[1] * v + row0[2], at).toBeCloseTo(q3u, 5);
        expect(row1[0] * u + row1[1] * v + row1[2], at).toBeCloseTo(q3v, 5);
      }
    }
    app.destroy();
  });

  it("samples where Q3's scale and scroll put a beam's coordinates, mirrored ones included", () => {
    const { app } = createTestApp();
    const repeats = 3.5; // `len / 256` for an 896-unit beam
    for (const bolt of BOLTS) {
      const mods: TexMod[] = [
        { type: 'scale', s: bolt.scale[0], t: bolt.scale[1] },
        { type: 'scroll', s: bolt.scroll[0], t: bolt.scroll[1] }
      ];
      for (const seconds of [0, 0.13, 1.7]) {
        const material = mappedMaterial(app);
        animateEffect(material, { ...ADD, texMods: mods }, seconds, {
          base: scaleTransform(repeats, 1)
        });
        const [row0, row1] = mapTransform(material, 'emissive');
        for (const [u, v] of [[0, 0], [1, 0], [0.3, 0.8], [1, 1]]) {
          // `DoRailCore`'s coordinates, then `RB_CalcScaleTexCoords` and
          // `RB_CalcScrollTexCoords`.
          const s = u * repeats * bolt.scale[0] + frac(bolt.scroll[0] * seconds);
          const t = v * bolt.scale[1] + frac(bolt.scroll[1] * seconds);
          const at = `scale ${bolt.scale[0]}, t = ${seconds}, uv = (${u}, ${v})`;
          expect(row0[0] * u + row0[1] * v + row0[2], at).toBeCloseTo(s, 5);
          expect(row1[0] * u + row1[1] * v + row1[2], at).toBeCloseTo(t, 5);
        }
      }
    }
    app.destroy();
  });

  it("repeats a beam's texture along its length, though its stage has no modifiers", () => {
    const { app } = createTestApp();
    const material = mappedMaterial(app);
    animateEffect(material, { ...ADD, texMods: [] }, 0, { base: scaleTransform(3.5, 1) });
    const [row0, row1] = mapTransform(material, 'emissive');
    expect(row0[0]).toBeCloseTo(3.5, 6);
    expect(row1[1]).toBeCloseTo(1, 6);
    app.destroy();
  });

  it('moves an opacity map with the colour, where a blended stage has one', () => {
    const { app } = createTestApp();
    const material = mappedMaterial(app);
    material.opacityMap = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    animateEffect(material, { ...ADD, texMods: PLASMA }, 0.1);
    expect(mapTransform(material, 'opacity')).toEqual(mapTransform(material, 'emissive'));
    app.destroy();
  });

  it('fades by rgbGen wave, and leaves the transform alone without texture modifiers', () => {
    const material = new StandardMaterial();
    const bullet: Wave = { func: 'inversesawtooth', base: 0, amplitude: 1, phase: 0, frequency: 5 };
    animateEffect(material, { ...ADD, rgbGen: 'wave', texMods: [], rgbWave: bullet }, 0.1);
    expect(material.emissive.r).toBeCloseTo(0.5, 6);
    expect(material.emissive.g).toBeCloseTo(0.5, 6);
    expect(material.emissiveMapRotation).toBe(0);
    expect(material.emissiveMapTiling.x).toBe(1);
  });

  it('lets a wave climb past 1, to twice a default stage, as fullscreen Q3 shows it', () => {
    const material = new StandardMaterial();
    // The lightning's second bolt, `sin 1 0.8 0 8.1`, at its peak.
    const bolt: Wave = { func: 'sin', base: 1, amplitude: 0.8, phase: 0, frequency: 8.1 };
    animateEffect(material, { ...ADD, rgbGen: 'wave', texMods: [], rgbWave: bolt }, 0.25 / 8.1);
    expect(material.emissive.r).toBeCloseTo(1.8, 6);
  });

  it('fades a blended stage by alphaGen wave, and dims by a brightness fed in', () => {
    const material = new StandardMaterial();
    const ring: Wave = { func: 'sawtooth', base: 0, amplitude: 1, phase: 0, frequency: 5 };
    animateEffect(
      material,
      { rgbGen: 'identityLighting', blend: 'blend', texMods: [], alphaWave: ring },
      0.1,
      { brightness: 0.25 }
    );
    expect(material.opacity).toBeCloseTo(0.5, 6);
    // No `rgbGen wave`, so the colour is the brightness alone.
    expect(material.emissive.r).toBeCloseTo(0.25, 6);
  });

  it('leaves a material alone when a play gives it what it has, update and all', () => {
    const material = new StandardMaterial();
    const update = vi.spyOn(material, 'update');
    const pulse: Wave = { func: 'sin', base: 1, amplitude: 0.5, phase: 0, frequency: 1 };
    const animation: StageAnimation = { ...ADD, rgbGen: 'wave', texMods: [], rgbWave: pulse };
    animateEffect(material, animation, 0.25);
    animateEffect(material, animation, 0.25);
    expect(update).toHaveBeenCalledTimes(1);
    animateEffect(material, animation, 0.5);
    expect(update).toHaveBeenCalledTimes(2);
    expect(material.emissive.r).toBeCloseTo(evalWave(pulse, 0.5), 6);
    // Back to the first: what it was given last is what counts.
    animateEffect(material, animation, 0.25);
    expect(update).toHaveBeenCalledTimes(3);
    expect(material.emissive.r).toBeCloseTo(evalWave(pulse, 0.25), 6);
  });

  it('moves a map through its setters, so the engine walks the maps only when one moves', () => {
    const { app } = createTestApp();
    const material = mappedMaterial(app);
    material.opacityMap = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    animateEffect(material, { ...ADD, texMods: PLASMA }, 0.1);
    // Reading a map's tiling or offset would mark them changing, and every update would walk
    // every map a material could have.
    const transforms = (material as unknown as { _mapTransforms: { _mutable: boolean } })
      ._mapTransforms;
    expect(transforms._mutable).toBe(false);
    app.destroy();
  });

  it("leaves the engine's map transform at identity where the draw owns the transform", () => {
    const { app } = createTestApp();
    const material = mappedMaterial(app);
    // A staged model's stage: the port's own `q3_coords` moves its coordinates in the vertex
    // shader, so the engine's tiling, rotation and offset are never touched.
    for (const seconds of [0.1, 0.2, 0.3]) {
      animateEffect(material, { ...ADD, texMods: PLASMA }, seconds, { ownsTransform: true });
    }
    const [row0, row1] = mapTransform(material, 'emissive');
    expectClose(row0, [1, 0, 0]);
    expectClose(row1, [0, 1, 0]);
    app.destroy();
  });

  it('counts a stage as animated only when it has something to play', () => {
    const frame = {} as Texture;
    const still = {
      animation: { ...ADD, texMods: [] as TexMod[] },
      animFps: 0,
      frames: [] as Texture[]
    };
    expect(isAnimated(still)).toBe(false);
    expect(isAnimated({ ...still, animation: { ...ADD, texMods: PLASMA } })).toBe(true);
    expect(
      isAnimated({ ...still, animation: { ...ADD, rgbGen: 'wave', texMods: [], rgbWave: STRETCH } })
    ).toBe(true);
    expect(isAnimated({ ...still, animation: { ...ADD, texMods: [], alphaWave: STRETCH } })).toBe(
      true
    );
    // A flipbook plays only with two frames or more to flip between.
    expect(isAnimated({ ...still, animFps: 5, frames: [frame, frame] })).toBe(true);
    expect(isAnimated({ ...still, animFps: 5, frames: [frame] })).toBe(false);
  });
});

describe('a colour fed in, and blendOver', () => {
  it('tints a stage channel by channel by the vertex colour, times its brightness', () => {
    // `rgbGen vertex` multiplies in the whole vertex colour, not just its brightness.
    const material = new StandardMaterial();
    animateEffect(material, { ...ADD, texMods: [] }, 0, {
      color: [0.2, 0.4, 0.8],
      brightness: 0.5
    });
    expect(material.emissive.r).toBeCloseTo(0.1, 6);
    expect(material.emissive.g).toBeCloseTo(0.2, 6);
    expect(material.emissive.b).toBeCloseTo(0.4, 6);
  });

  it("draws a stage over what is behind it, the texture's brightness its opacity", () => {
    const { app } = createTestApp();
    const texture = new Texture(app.graphicsDevice, { width: 1, height: 1 });
    const material = new StandardMaterial();
    material.emissiveMap = texture;
    material.blendType = BLEND_ADDITIVE;
    blendOver(material);
    expect(material.blendType).toBe(BLEND_NORMAL);
    expect(material.opacityMap).toBe(texture);
    expect(material.opacityMapChannel).toBe('g');
    // The colour is the emissive alone, so over black the stage is the additive one, tinted.
    expect(material.emissiveMap).toBeNull();
    app.destroy();
  });

  it('fades a stage a fog dimmed by its colour by its opacity once it draws over', () => {
    const material = new StandardMaterial();
    material.blendType = BLEND_ADDITIVE;
    material.setDefine('Q3_FOG_RGB', true);
    blendOver(material);
    expect([material.defines.has('Q3_FOG_RGB'), material.defines.has('Q3_FOG_ALPHA')]).toEqual([
      false,
      true
    ]);
    // One never dimmed is left so.
    const plain = new StandardMaterial();
    blendOver(plain);
    expect(plain.defines.has('Q3_FOG_ALPHA')).toBe(false);
  });
});

describe('createEffectStages', () => {
  let app: AppBase;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  /** A library with two textures and the given shader script. */
  function library(script: string): AssetLibrary {
    return new AssetLibrary(
      new Map([
        ['scripts/test.shader', new TextEncoder().encode(script)],
        ['gfx/glow.tga', tga()],
        ['gfx/glow2.tga', tga()]
      ])
    );
  }

  it("says how a fog dims each stage, by its blend and its shader's first stage's", async () => {
    const shaders = library(`
      added { { map gfx/glow.tga blendfunc add } { map gfx/glow.tga blendfunc blend }
        { map gfx/glow.tga blendfunc GL_ONE GL_ONE_MINUS_SRC_ALPHA }
        { map gfx/glow.tga blendfunc filter } }
      opaque { { map gfx/glow.tga } { map gfx/glow.tga blendfunc add } }
    `);
    const fogs = async (name: string) =>
      (await createEffectStages(app, shaders, name)).map((stage) => stage.fog);
    expect(await fogs('added')).toEqual(['rgb', 'alpha', 'rgba', 'none']);
    expect(await fogs('opaque')).toEqual(['none', 'none']);
    // A shader the paks lack draws as a glow, which no fog dims.
    expect(await fogs('missing')).toEqual([undefined]);
  });

  it('uploads a clampMap stage clamped, and a map stage repeating', async () => {
    const shaders = library(`
      clamped { { clampmap gfx/glow.tga blendfunc add } }
      repeated { { map gfx/glow.tga blendfunc add } }
    `);
    const [clamped] = await createEffectStages(app, shaders, 'clamped');
    const [repeated] = await createEffectStages(app, shaders, 'repeated');
    expect(clamped.frames[0].addressU).toBe(ADDRESS_CLAMP_TO_EDGE);
    expect(clamped.frames[0].addressV).toBe(ADDRESS_CLAMP_TO_EDGE);
    expect(repeated.frames[0].addressU).toBe(ADDRESS_REPEAT);
    expect(repeated.frames[0].addressV).toBe(ADDRESS_REPEAT);
  });

  it("carries each stage's animation", async () => {
    const [stage] = await createEffectStages(
      app,
      library(`
        plasmaExplosion { cull disable { clampmap gfx/glow.tga blendfunc add
          tcMod stretch triangle .6 0.1 0 8
            tcmod rotate 999
          rgbGen wave inversesawtooth 0 1 0 1.5 } }
      `),
      'plasmaExplosion'
    );
    // Each number a float, as Q3 keeps it.
    const f = Math.fround;
    expect(stage.animation.texMods).toEqual([
      { type: 'stretch', wave: { ...STRETCH, base: f(0.6), amplitude: f(0.1) } },
      { type: 'rotate', degreesPerSecond: 999 }
    ]);
    expect(stage.animation.rgbWave).toEqual({
      func: 'inversesawtooth',
      base: 0,
      amplitude: 1,
      phase: 0,
      frequency: 1.5
    });
  });

  it('builds every stage in order, each drawn the way it blends', async () => {
    const stages = await createEffectStages(
      app,
      library(`
        grenade {
          { map gfx/glow.tga }
          { animmap 7 gfx/glow.tga gfx/glow2.tga
            blendfunc GL_ONE GL_ONE }
          { map gfx/glow.tga blendfunc blend alphaGen wave sawtooth 0 1 0 5 }
        }
      `),
      'grenade'
    );
    expect(stages.map((stage) => stage.material.blendType)).toEqual([
      BLEND_NONE,
      BLEND_ADDITIVE,
      BLEND_NORMAL
    ]);
    // The opaque stage lays the surface's depth down; the passes over it write none.
    expect(stages.map((stage) => stage.material.depthWrite)).toEqual([true, false, false]);
    // Only the blended stage reads its texture's alpha.
    expect(stages.map((stage) => Boolean(stage.material.opacityMap))).toEqual([false, false, true]);
    expect(stages[1].frames).toHaveLength(2);
    expect(stages[2].animation.alphaWave?.func).toBe('sawtooth');
  });

  it('builds each stage at its brightness on screen: identity at twice a default one', async () => {
    const stages = await createEffectStages(
      app,
      library(`
        ball {
          { clampmap gfx/glow.tga blendFunc GL_ONE GL_ONE rgbGen identity }
          { map gfx/glow2.tga blendFunc GL_ONE GL_ONE }
          { map gfx/glow.tga blendFunc GL_DST_COLOR GL_ZERO }
        }
      `),
      'ball'
    );
    // The filter multiplies what is already drawn, so the ramp's doubling is not its own.
    expect(stages.map((stage) => stage.material.emissive.r)).toEqual([2, 1, 1]);
    // Every copy of an effect draws from a clone, which keeps it.
    expect(stages[0].material.clone().emissive.r).toBe(2);
  });

  it('writes depth from a blended stage that says depthWrite', async () => {
    const [grate] = await createEffectStages(
      app,
      library(`grate { { map gfx/glow.tga blendfunc blend depthWrite } }`),
      'grate'
    );
    expect(grate.material.depthWrite).toBe(true);
  });

  it('tests alpha as each alphaFunc does: above 0, below a half, or at least a half', async () => {
    const stages = await createEffectStages(
      app,
      library(`
        tests {
          { map gfx/glow.tga alphaFunc GE128 }
          { map gfx/glow.tga alphaFunc GT0 }
          { map gfx/glow.tga alphaFunc LT128 }
        }
      `),
      'tests'
    );
    const tests = stages.map(({ material }) =>
      [SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL].map((language) =>
        material.getShaderChunks(language).get('alphaTestPS')
      )
    );
    // GE128 is the engine's own test, which discards below its reference.
    expect(stages.map(({ material }) => material.alphaTest)).toEqual([0.5, 0.5, 0.5]);
    expect(tests[0]).toEqual([undefined, undefined]);
    const stock = ShaderChunks.get(app.graphicsDevice, SHADERLANGUAGE_GLSL).get('alphaTestPS');
    expect(stock).toMatch(/if \(a < alpha_ref\) discard;/);
    expect(tests[1][0]).toMatch(/if \(a <= 0\.0\) discard;/);
    expect(tests[1][1]).toMatch(/if \(a <= 0\.0\) \{/);
    expect(tests[2][0]).toMatch(/if \(a >= alpha_ref\) discard;/);
    expect(tests[2][1]).toMatch(/if \(a >= uniform\.alpha_ref\) \{/);
    // Each reads its texture's alpha.
    expect(stages.every(({ material }) => material.opacityMap)).toBe(true);
  });

  it("draws a pair of factors no mode draws exactly by its own, keeping the framebuffer's alpha", async () => {
    const [shine] = await createEffectStages(
      app,
      library(`
        patriot { { map gfx/glow.tga blendFunc GL_DST_COLOR GL_SRC_ALPHA rgbGen identity
          alphaGen lightingSpecular } }
      `),
      'patriot'
    );
    const state = shine.material.blendState;
    expect([
      state.blend,
      state.colorSrcFactor,
      state.colorDstFactor,
      state.alphaSrcFactor,
      state.alphaDstFactor
    ]).toEqual([true, BLENDMODE_DST_COLOR, BLENDMODE_SRC_ALPHA, BLENDMODE_ZERO, BLENDMODE_ONE]);
    // It multiplies what is drawn, so the ramp's doubling is not its own.
    expect(shine.material.emissive.r).toBe(1);
    // Its alpha is the texture's times the vertex colours', which carry the highlight.
    expect([
      Boolean(shine.material.opacityMap),
      shine.material.opacityVertexColor,
      shine.material.opacityVertexColorChannel
    ]).toEqual([true, true, 'a']);
  });

  it('leaves the pairs the four modes draw exactly to their modes', () => {
    const exact = [
      ['gl_one', 'gl_one'],
      ['gl_dst_color', 'gl_zero'],
      ['gl_zero', 'gl_src_color'],
      ['gl_src_alpha', 'gl_one_minus_src_alpha'],
      ['gl_one', 'gl_zero']
    ] as const;
    for (const pair of exact) expect(exactBlend(pair), pair.join(' ')).toBeUndefined();
    // A name Q3 doesn't know on that side is GL_ONE, as `NameToSrcBlendMode` makes it.
    const unknown = exactBlend(['gl_src_color', 'gl_dst_color'])!;
    expect([unknown.colorSrcFactor, unknown.colorDstFactor]).toEqual([BLENDMODE_ONE, BLENDMODE_ONE]);
  });

  it('drops the map for a source factor with no framebuffer factor, as GL_State does', () => {
    expect(() => exactBlend(['gl_one', undefined])).toThrow(
      new Error('GL_State: invalid dst blend state bits')
    );
  });

  it("finds an MD3 surface's shader through its extension, as R_FindShader does", async () => {
    const shaders = library(
      `models/glow { { map gfx/glow.tga blendfunc add } { map gfx/glow2.tga blendfunc add } }`
    );
    expect(await createEffectStages(app, shaders, 'models/glow.tga')).toHaveLength(2);
  });

  it('uploads a nomipmaps shader without mipmaps, and marks its turb stage', async () => {
    const shaders = library(`
      trail { nomipmaps
        { map gfx/glow.tga blendfunc add }
        { map gfx/glow2.tga blendfunc add tcMod turb 0 .25 0 1.6
          } }
      plain { { map gfx/glow.tga blendfunc add } }
    `);
    const trail = await createEffectStages(app, shaders, 'trail');
    const [plain] = await createEffectStages(app, shaders, 'plain');
    expect(trail.map((stage) => stage.frames[0].mipmaps)).toEqual([false, false]);
    expect(plain.frames[0].mipmaps).toBe(true);
    // Only the rippling stage reads the surface's second coordinates.
    expect(trail[0].turb).toBeUndefined();
    expect(trail[1].turb).toEqual({
      func: 'sin',
      base: 0,
      amplitude: 0.25,
      phase: 0,
      frequency: Math.fround(1.6)
    });
  });

  it('marks the stage that mirrors, for its model to give coordinates of their own', async () => {
    const [mirror, plain] = await createEffectStages(
      app,
      library(`gogs { { map gfx/glow.tga tcGen environment } { map gfx/glow2.tga blendfunc add } }`),
      'gogs'
    );
    expect([mirror.environment, plain.environment]).toEqual([true, false]);
  });

  it('draws a missing shader as one plain additive glow', async () => {
    const stages = await createEffectStages(app, library(''), 'nowhere');
    expect(stages).toHaveLength(1);
    expect(stages[0].material.blendType).toBe(BLEND_ADDITIVE);
    expect(stages[0].frames).toEqual([]);
  });

  it('plays a flipbook frame by frame', async () => {
    const [stage] = await createEffectStages(
      app,
      library(`book { { animmap 5 gfx/glow.tga gfx/glow2.tga
        blendfunc add } }`),
      'book'
    );
    const material = stage.material.clone();
    // 5 Hz: the second frame from 0.2 s, and round to the first again at 0.4 s.
    playStage(material, stage, 0.3);
    expect(material.emissiveMap).toBe(stage.frames[1]);
    playStage(material, stage, 0.45);
    expect(material.emissiveMap).toBe(stage.frames[0]);
  });

  it('updates a material as its flipbook turns, and not between', async () => {
    const [stage] = await createEffectStages(
      app,
      library(`book { { animmap 5 gfx/glow.tga gfx/glow2.tga
        blendfunc add } }`),
      'book'
    );
    const material = stage.material.clone();
    const update = vi.spyOn(material, 'update');
    playStage(material, stage, 0.1);
    playStage(material, stage, 0.15);
    expect(update).toHaveBeenCalledTimes(1);
    // The draw reads the frame's texture through what an update leaves, so a turn takes one.
    playStage(material, stage, 0.3);
    expect(update).toHaveBeenCalledTimes(2);
    expect(material.emissiveMap).toBe(stage.frames[1]);
  });
});

describe('a merged stage', () => {
  let app: AppBase;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  afterEach(() => {
    app.destroy();
  });

  const images = () =>
    new AssetLibrary(
      new Map([
        ['gfx/a.tga', tga()],
        ['gfx/b.tga', tga()],
        ['gfx/c.tga', tga()]
      ])
    );

  /** An opaque stage of `gfx/a.tga` at `identity`, with `gfx/b.tga` as its second texture. */
  function mergedStage(
    env: Multitexture['env'],
    second: Partial<Multitexture> = {},
    first: Partial<ShaderStage> = {}
  ): ShaderStage {
    return {
      maps: ['gfx/a.tga'],
      animFps: 0,
      blend: 'opaque',
      depthWrite: true,
      clamp: false,
      texMods: [],
      rgbGen: 'identity',
      ...first,
      multitexture: { maps: ['gfx/b.tga'], animFps: 0, clamp: false, texMods: [], env, ...second }
    };
  }

  it('draws its second texture from the diffuse map, by the chunks in both languages', async () => {
    for (const env of ['modulate', 'add'] as const) {
      const built = await createStage(app, images(), mergedStage(env), CULLFACE_BACK, true);
      const { material } = built;
      expect(material.emissiveMap).toBe(built.frames[0]);
      expect(built.multitexture!.frames).toHaveLength(1);
      expect(material.diffuseMap).toBe(built.multitexture!.frames[0]);
      expect(material.diffuseMap).not.toBe(material.emissiveMap);
      // Black, so the diffuse map draws nothing of its own.
      expect([material.diffuse.r, material.diffuse.g, material.diffuse.b]).toEqual([0, 0, 0]);
      expect(material.defines.get('Q3_MULTITEXTURE_ADD')).toBe(env === 'add' ? true : undefined);
      for (const [language, chunks] of [
        [SHADERLANGUAGE_GLSL, MULTITEXTURE_CHUNKS.glsl],
        [SHADERLANGUAGE_WGSL, MULTITEXTURE_CHUNKS.wgsl]
      ] as const) {
        for (const [name, code] of chunks) {
          expect(material.getShaderChunks(language).get(name), env).toBe(code);
        }
      }
    }
  });

  it('leaves the diffuse map empty for a second texture of no image, as the lightmap is', async () => {
    const built = await createStage(
      app,
      images(),
      mergedStage('modulate', { maps: ['$lightmap'] }),
      CULLFACE_BACK,
      true
    );
    expect(built.multitexture!.frames).toEqual([]);
    expect(built.material.diffuseMap).toBeNull();
  });

  it('multiplies the texel in, or adds it, as a pass of it alone writes it, white with no image', () => {
    for (const language of ['glsl', 'wgsl'] as const) {
      const ending = MULTITEXTURE_CHUNKS[language].get('litUserMainEndPS')!;
      for (const textured of [false, true]) {
        for (const add of [false, true]) {
          const defines = [
            textured && '#define STD_DIFFUSE_TEXTURE\n',
            add && '#define Q3_MULTITEXTURE_ADD\n'
          ];
          const source = defines.filter(Boolean).join('') + ending;
          const out = Preprocessor.run(source, new Map(), { stripDefines: true })!;
          const label = `${language} ${textured} ${add}`;
          const glsl = language === 'glsl';
          expect(out, label).not.toContain('#');
          expect(out.includes('gammaCorrectOutput(toneMap({STD_DIFFUSE_TEXTURE_DECODE}('), label).toBe(
            textured
          );
          expect(out.includes(glsl ? 'vec3(1.0)' : 'vec3f(1.0)'), label).toBe(!textured);
          const adds = glsl ? 'gl_FragColor.rgb += q3Texel;' : 'output.color.rgb + q3Texel';
          const multiplies = glsl ? 'gl_FragColor.rgb *= q3Texel;' : 'output.color.rgb * q3Texel';
          expect([out.includes(adds), out.includes(multiplies)], label).toEqual([add, !add]);
        }
      }
    }
  });

  it.each(['glsl', 'wgsl'] as const)(
    'samples its second texture on its own coordinates after the stage is written, in %s',
    async (language) => {
      const second = { texMods: [{ type: 'scale', s: 2, t: 2 }] as TexMod[] };
      const built = await createStage(app, images(), mergedStage('add', second), CULLFACE_BACK, true);
      playMultitexture(built.material, built.multitexture!, 0);
      const { fragment } = assembledShaders(app, built.material, language);
      const glsl = language === 'glsl';
      expectInOrder(fragment, [
        glsl ? 'uniform sampler2D texture_diffuseMap;' : 'var texture_diffuseMapSampler : sampler;',
        glsl ? 'gl_FragColor.rgb = gammaCorrectOutput(' : 'finalRgb = gammaCorrectOutput(finalRgb);',
        'q3Texel = gammaCorrectOutput(toneMap(decodeGamma(',
        'texture_diffuseMap',
        // A transform of its own: the first texture's coordinates are the plain `vUv0`.
        'vUV0_1',
        glsl ? 'gl_FragColor.rgb += q3Texel;' : 'output.color.rgb + q3Texel'
      ]);
    }
  );

  it("tests alpha after its second texture's alpha multiplies it, by each alphaFunc", async () => {
    for (const func of ['GE128', 'GT0', 'LT128'] as const) {
      const stage = mergedStage('modulate', {}, { alphaFunc: func });
      const { material } = await createStage(app, images(), stage, CULLFACE_BACK, true);
      const [glsl, wgsl] = [SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL].map(
        (language) => material.getShaderChunks(language).get('alphaTestPS')!
      );
      const discards = { GE128: 'a < ', GT0: 'a <= 0.0', LT128: 'a >= ' }[func];
      expectInOrder(glsl, [
        'void alphaTest(float a) {',
        'a *= texture2DBias({STD_DIFFUSE_TEXTURE_NAME}',
        `if (${discards}`
      ]);
      expectInOrder(wgsl, [
        'fn alphaTest(alpha: f32) {',
        'var a = alpha;',
        'a = a * textureSampleBias(',
        `if (${discards}`
      ]);
      expect(material.alphaTest).toBe(0.5);
      // With no image there, as for `$whiteimage`, nothing is sampled: its alpha is 1.
      for (const [chunk, sample] of [
        [glsl, 'texture2DBias('],
        [wgsl, 'textureSampleBias(']
      ]) {
        for (const textured of [false, true]) {
          const source = (textured ? '#define STD_DIFFUSE_TEXTURE\n' : '') + chunk;
          const out = Preprocessor.run(source, new Map(), { stripDefines: true })!;
          expect(out.includes(sample), `${func} ${sample} ${textured}`).toBe(textured);
        }
      }
    }
  });

  it("plays its second texture's flipbook and its modifiers, in the diffuse map", async () => {
    const second = {
      maps: ['gfx/b.tga', 'gfx/c.tga'],
      animFps: 5,
      texMods: [{ type: 'scale', s: 2, t: 4 }] as TexMod[]
    };
    const built = await createStage(app, images(), mergedStage('modulate', second), CULLFACE_BACK, true);
    const { material } = built;
    const { frames } = built.multitexture!;
    playMultitexture(material, built.multitexture!, 0.3);
    expect(material.diffuseMap).toBe(frames[1]);
    expect(material.emissiveMap).toBe(built.frames[0]);
    const [row0, row1] = [0, 1].map((half) =>
      bufferUniform(material, `texture_diffuseMapTransform${half}`, 3)
    );
    // `s · 2`, `t · 4`, as Q3's scale puts them.
    for (const [u, v] of [[0, 0], [1, 0], [0.3, 0.8]]) {
      expect(row0[0] * u + row0[1] * v + row0[2]).toBeCloseTo(u * 2, 5);
      expect(row1[0] * u + row1[1] * v + row1[2]).toBeCloseTo(v * 4, 5);
    }
    playMultitexture(material, built.multitexture!, 0.45);
    expect(material.diffuseMap).toBe(frames[0]);
  });
});

describe("PlayCanvas' colour path", () => {
  it('draws an emissive colour as that multiple of the texture, on screen', () => {
    const { app } = createTestApp();
    const device = app.graphicsDevice;
    // An RGBA8 map is decoded, and a material colour linearized, by the same 2.2 power the
    // output is encoded with. So (g^2.2 · t^2.2)^(1/2.2) = g · t: a gain in display space,
    // where Q3 blends. If the engine moves to another curve, the effects' brightness moves too.
    expect(new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 }).encoding).toBe(
      'srgb'
    );
    for (const language of [SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL]) {
      const chunks = ShaderChunks.get(device, language);
      expect(chunks.get('decodePS'), language).toMatch(/pow\(raw(\.xyz)?, vec3f?\(2\.2\)\)/);
      expect(chunks.get('gammaPS'), language).toMatch(/vec3f?\(1\.0 \/ 2\.2\)/);
    }
    const material = new StandardMaterial();
    material.emissive.set(2, 2, 2);
    expect(bufferUniform(material, 'material_emissive', 3)[0]).toBeCloseTo(2 ** 2.2, 5);
    app.destroy();
  });
});

describe('createStage', () => {
  it('asks its images for `$whiteimage`, and leaves `$lightmap` to its caller', async () => {
    const { app } = createTestApp();
    const asked: string[] = [];
    const images: ImageSource = {
      resolveImage: (reference) => {
        asked.push(reference);
        return 'gfx/a.tga';
      },
      read: () => tga()
    };
    const stage = (map: string): ShaderStage => ({
      maps: [map],
      animFps: 0,
      blend: 'opaque',
      depthWrite: true,
      clamp: false,
      texMods: [],
      rgbGen: 'identity'
    });
    const lightmap = await createStage(app, images, stage('$LIGHTMAP'), CULLFACE_BACK, true);
    expect([lightmap.frames, asked]).toEqual([[], []]);
    const white = await createStage(app, images, stage('$whiteimage'), CULLFACE_BACK, true);
    expect([white.frames.length, asked]).toEqual([1, ['$whiteimage']]);
    app.destroy();
  });
});
