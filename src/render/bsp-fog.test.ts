// @vitest-environment jsdom
import {
  BLEND_ADDITIVE,
  BLENDMODE_ONE,
  BLENDMODE_ONE_MINUS_SRC_ALPHA,
  BLENDMODE_SRC_ALPHA,
  BLENDMODE_ZERO,
  CULLFACE_BACK,
  CULLFACE_NONE,
  FUNC_EQUAL,
  FUNC_LESSEQUAL,
  PIXELFORMAT_RGBA8,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
  Texture,
  type AppBase
} from 'playcanvas';
import { Preprocessor } from 'playcanvas/build/playcanvas/src/core/preprocessor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { anglesToAxis } from '../view/hand-pose';
import {
  WORLD_FRAME,
  fogFactor,
  fogImage,
  fogTexCoords,
  fogVectors,
  loadFogs,
  type FogFrame,
  type WorldFog
} from '../view/world-fog';
import { fogParts, testBsp } from '../view/world-test-fixtures';
import {
  FOG_ADJUSTMENT_CHUNKS,
  FOG_PASS_CHUNKS,
  FogUniforms,
  NO_FOG_DATA,
  NO_SCENE_FOGS,
  SceneFogs,
  applyFogAdjustment,
  dimEffectStages,
  fogPassMaterial,
  modelFogPassMaterial
} from './bsp-fog';
import { MULTITEXTURE_CHUNKS } from './effect-material';
import { assembledShaders, createTestApp, expectInOrder } from './engine-test-fixtures';
import { FOG_UNIFORM } from './fog-chunks';
import { TextureCache } from './texture-cache';

type Vec3 = [number, number, number];

const f = Math.fround;

/** What a material holds for a parameter. */
const parameterOf = (material: StandardMaterial, name: string) =>
  (material.getParameter(name) as { data: unknown } | undefined)?.data;

/** A fog 256 deep for opaque, its top at height 0 and showing, or showing nothing. */
function pool(visibleSide?: number): WorldFog {
  const bsp = testBsp(
    fogParts([{ mins: [-512, -512, -256], maxs: [512, 512, 0], shader: 'pool', visibleSide }])
  );
  return loadFogs(bsp, () => ({ fogParms: { color: [1, 0, 0], depthForOpaque: 256 } }))[0];
}

/** What the chunks' `q3FogTexCoords` gives a vertex from `q3_fog`: the twin of their code. */
function chunkTexCoords(fog: Float32Array, v: readonly number[]): [number, number] {
  const s = v[0] * fog[0] + v[1] * fog[1] + v[2] * fog[2] + fog[3];
  let t = v[0] * fog[4] + v[1] * fog[5] + v[2] * fog[6] + fog[7];
  const eyeT = fog[8];
  if (eyeT < 0) {
    if (t < 1) {
      t = 1 / 32;
    } else {
      t = 1 / 32 + ((30 / 32) * t) / (t - eyeT);
    }
  } else if (t < 0) {
    t = 1 / 32;
  } else {
    t = 31 / 32;
  }
  return [s, t];
}

/** What the chunks' `q3FogFactor` gives a point on the fog image, in floats as a GPU has them. */
function chunkFactor(s: number, t: number): number {
  let d = f(f(s) - 1 / 512);
  if (d < 0) return 0;
  const depth = f(t);
  if (depth < 1 / 32) return 0;
  if (depth < 31 / 32) d = f(d * f(f(depth - 1 / 32) / (30 / 32)));
  d = Math.min(f(d * 8), 1);
  return Math.sqrt(f(Math.floor(f(d * 255)) / 255));
}

describe('the chunks against their twins', () => {
  const points: Vec3[] = [
    [0, 0, 5],
    [100, 0, -0.5],
    [100, 20, -10],
    [400, -30, -200],
    [-50, 10, -1]
  ];

  it('find each vertex where RB_CalcFogTexCoords does, the eye in, out or faceless', () => {
    for (const [fog, eye] of [
      [pool(), [0, 0, -50]],
      [pool(), [0, 0, 40]],
      [pool(-1), [0, 0, 40]]
    ] as [WorldFog, Vec3][]) {
      const [forward] = anglesToAxis(30, -40, 0);
      const uniforms = new FogUniforms([fog]);
      const data = uniforms.data(0, 0, WORLD_FRAME);
      uniforms.view(eye, forward);
      const vectors = fogVectors(fog, eye, forward);
      for (const v of points) {
        const [s, t] = chunkTexCoords(data, v);
        const [ported, depth] = fogTexCoords(vectors, v);
        // The uniform holds floats.
        expect(s, `${eye} ${v}`).toBeCloseTo(ported, 6);
        expect(t, `${eye} ${v}`).toBeCloseTo(depth, 6);
      }
    }
  });

  it('thin the fog where R_FogFactor does, entry for entry', () => {
    for (let i = 0; i <= 64; i++) {
      for (const t of [-0.5, 0, 0.02, 1 / 32, 0.04, 0.3, 0.5, 30 / 32, 31 / 32, 1]) {
        const s = i / 48;
        expect(chunkFactor(s, t), `${s} ${t}`).toBeCloseTo(fogFactor(s, t), 6);
      }
    }
  });

  it('are written as the twins are, in both languages', () => {
    for (const language of ['glsl', 'wgsl'] as const) {
      const prefix = language === 'glsl' ? '' : 'uniform.';
      for (const chunks of [FOG_PASS_CHUNKS, FOG_ADJUSTMENT_CHUNKS]) {
        const text = chunks[language].get('litUserDeclarationVS')!;
        for (const line of [
          `dot(v, ${prefix}q3_fog[0].xyz) + ${prefix}q3_fog[0].w;`,
          `dot(v, ${prefix}q3_fog[1].xyz) + ${prefix}q3_fog[1].w;`,
          `eyeT = ${prefix}q3_fog[2].x;`,
          'if (eyeT < 0.0) {',
          'if (t < 1.0) {',
          't = 1.0 / 32.0 + 30.0 / 32.0 * t / (t - eyeT);',
          '} else if (t < 0.0) {',
          't = 31.0 / 32.0;'
        ]) {
          expect(text, `${language} ${line}`).toContain(line);
        }
      }
      const adjusting = FOG_ADJUSTMENT_CHUNKS[language].get('litUserDeclarationVS')!;
      for (const line of [
        'st.x - 1.0 / 512.0;',
        'if (depth < 1.0 / 32.0)',
        'if (depth < 31.0 / 32.0)',
        '(depth - 1.0 / 32.0) / (30.0 / 32.0)',
        'd = min(d * 8.0, 1.0);',
        'return sqrt(floor(d * 255.0) / 255.0);'
      ]) {
        expect(adjusting, `${language} ${line}`).toContain(line);
      }
      expect(FOG_PASS_CHUNKS[language].get('uv0VS')).toContain(
        'return q3FogTexCoords(vertex_position.xyz);'
      );
      expect(FOG_ADJUSTMENT_CHUNKS[language].get('litUserMainEndVS')).toContain(
        'q3FogKeep = 1.0 - q3FogFactor(q3FogTexCoords(vertex_position.xyz));'
      );
    }
  });

  it('dim what a stage writes by the defines its adjustment sets', () => {
    for (const language of ['glsl', 'wgsl'] as const) {
      const chunks = FOG_ADJUSTMENT_CHUNKS[language];
      for (const [rgb, alpha] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true]
      ]) {
        const defines = [rgb && '#define Q3_FOG_RGB\n', alpha && '#define Q3_FOG_ALPHA\n'];
        const source = defines.filter(Boolean).join('') + [...chunks.values()].join('\n');
        const out = Preprocessor.run(source, new Map(), { stripDefines: true })!;
        const label = `${language} ${rgb} ${alpha}`;
        expect(out, label).not.toContain('#');
        const dimsColour =
          language === 'glsl' ? 'gl_FragColor.rgb *= q3FogKeep;' : 'rgb * q3FogKeep';
        const dimsAlpha =
          language === 'glsl' ? 'gl_FragColor.a *= q3FogKeep;' : 'output.color.a * q3FogKeep';
        expect(out.includes(dimsColour), label).toBe(rgb);
        expect(out.includes(dimsAlpha), label).toBe(alpha);
      }
    }
  });
});

describe('the fog materials', () => {
  let app: AppBase;
  let cache: TextureCache;
  beforeEach(() => {
    ({ app } = createTestApp());
    cache = new TextureCache(app.graphicsDevice);
  });
  afterEach(() => {
    app.destroy();
  });

  const image = () =>
    new Texture(app.graphicsDevice, { width: 256, height: 32, format: PIXELFORMAT_RGBA8 });

  it("draws a pass in its fog's colour, the image's alpha, writing no depth", () => {
    const scope = cache.scope();
    const fogImage = image();
    const equal = fogPassMaterial(fogImage, [127, 25, 0, 255], 'equal', CULLFACE_BACK, scope);
    const { r, g, b } = equal.emissive;
    expect([r, g, b]).toEqual([127 / 255, 25 / 255, 0]);
    expect(equal.opacity).toBe(1);
    expect(equal.emissiveMap).toBeNull();
    expect([equal.opacityMap, equal.opacityMapChannel, equal.opacityMapUv]).toEqual([
      fogImage,
      'a',
      0
    ]);
    const { blendState } = equal;
    expect([
      blendState.colorSrcFactor,
      blendState.colorDstFactor,
      blendState.alphaSrcFactor,
      blendState.alphaDstFactor
    ]).toEqual([BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA, BLENDMODE_ZERO, BLENDMODE_ONE]);
    expect([equal.depthTest, equal.depthWrite, equal.depthFunc, equal.cull]).toEqual([
      true,
      false,
      FUNC_EQUAL,
      CULLFACE_BACK
    ]);
    expect(equal.useLighting).toBe(false);
    for (const [language, chunks] of [
      [SHADERLANGUAGE_GLSL, FOG_PASS_CHUNKS.glsl],
      [SHADERLANGUAGE_WGSL, FOG_PASS_CHUNKS.wgsl]
    ] as const) {
      for (const [name, code] of chunks) {
        expect(equal.getShaderChunks(language).get(name)).toBe(code);
      }
    }
    const lessEqual = fogPassMaterial(fogImage, [0, 0, 0, 255], 'lessEqual', CULLFACE_BACK, scope);
    expect(lessEqual.depthFunc).toBe(FUNC_LESSEQUAL);
    scope.dispose();
    fogImage.destroy();
  });

  it('dims a stage by the defines its adjustment calls for', () => {
    for (const [adjustment, rgb, alpha] of [
      ['rgb', true, false],
      ['alpha', false, true],
      ['rgba', true, true]
    ] as const) {
      const material = new StandardMaterial();
      applyFogAdjustment(material, adjustment);
      expect([material.defines.get('Q3_FOG_RGB'), material.defines.get('Q3_FOG_ALPHA')]).toEqual([
        rgb ? true : undefined,
        alpha ? true : undefined
      ]);
      for (const [name, code] of FOG_ADJUSTMENT_CHUNKS.wgsl) {
        expect(material.getShaderChunks(SHADERLANGUAGE_WGSL).get(name)).toBe(code);
      }
    }
  });

  it("keeps what a stage's shaders already declare and its vertex shader ends with, then its own", () => {
    const material = new StandardMaterial();
    for (const [language, mine] of [
      [SHADERLANGUAGE_GLSL, 'q3Mine'],
      [SHADERLANGUAGE_WGSL, 'q3MineToo']
    ] as const) {
      for (const name of ['litUserDeclarationVS', 'litUserMainEndVS', 'litUserDeclarationPS']) {
        material.getShaderChunks(language).set(name, `\n${mine} ${name}\n`);
      }
    }
    applyFogAdjustment(material, 'rgb');
    for (const [language, chunks, mine] of [
      [SHADERLANGUAGE_GLSL, FOG_ADJUSTMENT_CHUNKS.glsl, 'q3Mine'],
      [SHADERLANGUAGE_WGSL, FOG_ADJUSTMENT_CHUNKS.wgsl, 'q3MineToo']
    ] as const) {
      for (const name of ['litUserDeclarationVS', 'litUserMainEndVS', 'litUserDeclarationPS']) {
        expect(material.getShaderChunks(language).get(name), name).toBe(`\n${mine} ${name}\n${chunks.get(name)}`);
      }
    }
  });

  /** The shaders the engine assembles for a fogged draw of a material. */
  const assembled = (material: StandardMaterial, language: 'glsl' | 'wgsl') =>
    assembledShaders(app, material, language, { [FOG_UNIFORM]: new Float32Array(12) });

  it.each(['glsl', 'wgsl'] as const)(
    "samples the pass's image on its fog's coordinates, in %s",
    (language) => {
      const scope = cache.scope();
      const fogImage = image();
      const material = fogPassMaterial(fogImage, [255, 0, 0, 255], 'equal', CULLFACE_BACK, scope);
      const { vertex, fragment } = assembled(material, language);
      const glsl = language === 'glsl';
      expectInOrder(vertex, [
        glsl ? 'vec2 q3FogTexCoords(vec3 v)' : 'fn q3FogTexCoords(v: vec3f)',
        glsl ? 'vec2 getUv0()' : 'fn getUv0()',
        'return q3FogTexCoords(vertex_position.xyz);',
        glsl ? 'gl_Position = getPosition();' : 'output.position = getPosition();',
        glsl ? 'vec2 uv0 = getUv0();' : 'var uv0: vec2f = getUv0();'
      ]);
      expect(vertex).not.toContain('return vertex_texCoord0;');
      expect(fragment).toContain('vUv0');
      scope.dispose();
      fogImage.destroy();
    }
  );

  it.each(['glsl', 'wgsl'] as const)(
    'dims what a stage writes by how much of it each vertex keeps, in %s',
    (language) => {
      const material = new StandardMaterial();
      material.useLighting = false;
      material.blendType = BLEND_ADDITIVE;
      applyFogAdjustment(material, 'rgb');
      material.update();
      const { vertex, fragment } = assembled(material, language);
      const glsl = language === 'glsl';
      expectInOrder(vertex, [
        glsl ? 'float q3FogFactor(vec2 st)' : 'fn q3FogFactor(st: vec2f)',
        glsl ? 'gl_Position = getPosition();' : 'output.position = getPosition();',
        glsl ? 'q3FogKeep = 1.0 - q3FogFactor(' : 'output.q3FogKeep = 1.0 - q3FogFactor('
      ]);
      expectInOrder(fragment, [
        'q3FogKeep',
        glsl ? 'evaluateBackend();' : 'var output: FragmentOutput = evaluateBackend();',
        glsl ? 'gl_FragColor.rgb *= q3FogKeep;' : 'output.color.rgb * q3FogKeep'
      ]);
      expect(fragment).not.toContain(glsl ? 'gl_FragColor.a *= q3FogKeep' : 'output.color.a *');
      material.destroy();
    }
  );

  it.each(['glsl', 'wgsl'] as const)(
    "dims a merged stage's colour before its second texture is added, in %s",
    (language) => {
      const material = new StandardMaterial();
      material.useLighting = false;
      material.blendType = BLEND_ADDITIVE;
      const second = image();
      material.diffuseMap = second;
      for (const [name, code] of MULTITEXTURE_CHUNKS.glsl) {
        material.getShaderChunks(SHADERLANGUAGE_GLSL).set(name, code);
      }
      for (const [name, code] of MULTITEXTURE_CHUNKS.wgsl) {
        material.getShaderChunks(SHADERLANGUAGE_WGSL).set(name, code);
      }
      material.setDefine('Q3_MULTITEXTURE_ADD', true);
      applyFogAdjustment(material, 'rgb');
      material.update();
      const ending = (chunks: { glsl: Map<string, string>; wgsl: Map<string, string> }) =>
        chunks[language].get('litUserMainEndPS')!;
      const lang = language === 'glsl' ? SHADERLANGUAGE_GLSL : SHADERLANGUAGE_WGSL;
      expect(material.getShaderChunks(lang).get('litUserMainEndPS')).toBe(
        ending(FOG_ADJUSTMENT_CHUNKS) + ending(MULTITEXTURE_CHUNKS)
      );
      const { fragment } = assembled(material, language);
      const glsl = language === 'glsl';
      expectInOrder(fragment, [
        glsl ? 'gl_FragColor.rgb *= q3FogKeep;' : 'output.color.rgb * q3FogKeep',
        glsl ? 'gl_FragColor.rgb += q3Texel;' : 'output.color.rgb + q3Texel'
      ]);
      material.destroy();
      second.destroy();
    }
  );
});

describe('FogUniforms', () => {
  it("holds one array for each fog in each frame, and writes each for a view in its frame", () => {
    const fogs = [pool(), pool(-1)];
    const uniforms = new FogUniforms(fogs);
    const frame: FogFrame = { origin: [100, -20, 30], axis: anglesToAxis(10, 70, 5) };
    const world = uniforms.data(0, 3, WORLD_FRAME);
    expect(uniforms.data(0, 3, WORLD_FRAME)).toBe(world);
    const model = uniforms.data(0, 1, frame);
    const faceless = uniforms.data(1, 3, WORLD_FRAME);
    expect(new Set([world, model, faceless]).size).toBe(3);
    const eye: Vec3 = [0, 0, 40];
    const forward: Vec3 = [0, 1, 0];
    uniforms.view(eye, forward);
    const packed = (fog: WorldFog, at: FogFrame) => {
      const { distance, depth, eyeT } = fogVectors(fog, eye, forward, at);
      return [...distance, ...depth, eyeT, 0, 0, 0].map(f);
    };
    expect([...world]).toEqual(packed(fogs[0], WORLD_FRAME));
    expect([...model]).toEqual(packed(fogs[0], frame));
    expect([...faceless]).toEqual(packed(fogs[1], WORLD_FRAME));
    expect(faceless[8]).toBe(1);
  });
});

describe('SceneFogs', () => {
  const fogs = [pool(), pool(-1)];
  const eye: Vec3 = [0, 0, 40];
  const forward: Vec3 = [0, 1, 0];
  const packed = (fog: WorldFog, at: FogFrame = WORLD_FRAME) => {
    const { distance, depth, eyeT } = fogVectors(fog, eye, forward, at);
    return [...distance, ...depth, eyeT, 0, 0, 0].map(f);
  };

  it("writes each fog's vectors in the world's frame at each view, and nothing for none", () => {
    const scene = new SceneFogs(fogs, [
      [255, 0, 0, 255],
      [0, 0, 0, 255]
    ]);
    scene.view(eye, forward);
    expect([...scene.worldData(1)]).toEqual(packed(fogs[0]));
    expect([...scene.worldData(2)]).toEqual(packed(fogs[1]));
    expect(scene.worldData(0)).toBe(NO_FOG_DATA);
    // Nothing along the view: a stage dimmed by it keeps all its colour.
    const none = [...NO_FOG_DATA];
    expect(none).toEqual(new Array(12).fill(0));
    expect(fogFactor(...chunkTexCoords(NO_FOG_DATA as Float32Array, [100, -40, 12]))).toBe(0);
  });

  it("writes an entity's in its own frame, a model's eye measured as Q3 measures it", () => {
    const scene = new SceneFogs(fogs, [
      [255, 0, 0, 255],
      [0, 0, 0, 255]
    ]);
    scene.view(eye, forward);
    const [a, b, c] = anglesToAxis(10, 70, 5).map((along) => along.map((x) => x * 2) as Vec3);
    const frame: FogFrame = { origin: [100, -20, -30], axis: [a, b, c], nonNormalizedAxes: true };
    const data = new Float32Array(12);
    scene.writeEntityData(1, frame, data, true);
    expect([...data]).toEqual(packed(fogs[0], frame));
    scene.writeEntityData(1, frame, data, false);
    // The rest keep the world's eye.
    const worldEye = f(packed(fogs[0])[8]);
    expect([...data]).toEqual([...packed(fogs[0], frame).slice(0, 8), worldEye, 0, 0, 0]);
    data.fill(7);
    scene.writeEntityData(0, frame, data, true);
    expect([...data]).toEqual(new Array(12).fill(0));
  });

  it('finds fogs by the three tests, and none with no fogs', () => {
    const scene = new SceneFogs(fogs, [
      [255, 0, 0, 255],
      [0, 0, 0, 255]
    ]);
    expect(scene.modelFog([0, 0, -100], [0, 0, 0], 8)).toBe(1);
    expect(scene.spriteFog([0, 0, 8], 8)).toBe(0);
    expect(scene.polyFog([[0, 0, 0], [8, 8, 8]])).toBe(1);
    for (const none of [NO_SCENE_FOGS, new SceneFogs([], [])]) {
      expect(none.modelFog([0, 0, -100], [0, 0, 0], 8)).toBe(0);
      expect(none.spriteFog([0, 0, -100], 8)).toBe(0);
      expect(none.polyFog([[0, 0, 0]])).toBe(0);
    }
  });

  it("gives each fog's colour as a material's emissive uniform holds it", () => {
    const scene = new SceneFogs(fogs, [
      [255, 127, 0, 255],
      [0, 0, 0, 255]
    ]);
    const [r, g, b] = scene.passColor(1);
    expect(r).toBeCloseTo(1, 6);
    expect(g).toBeCloseTo((127 / 255) ** 2.2, 6);
    expect(b).toBe(0);
  });
});

describe("the models' fog materials", () => {
  let app: AppBase;
  beforeEach(() => {
    ({ app } = createTestApp());
  });
  afterEach(() => {
    app.destroy();
  });

  it("draws a model's pass as the world's, through the model chunks, on one *fog a device", () => {
    const deforms = [{ type: 'normal' as const, amplitude: 1, frequency: 1 }];
    const pass = modelFogPassMaterial(app.graphicsDevice, deforms, CULLFACE_BACK);
    const again = modelFogPassMaterial(app.graphicsDevice, [], CULLFACE_NONE);
    expect(pass.opacityMap).toBe(again.opacityMap);
    expect(pass.opacityMap!.name).toBe('*fog');
    expect([pass.opacityMap!.width, pass.opacityMap!.height]).toEqual([256, 32]);
    expect(new Uint8Array(pass.opacityMap!.lock())).toEqual(fogImage());
    pass.opacityMap!.unlock();
    expect([pass.opacityMapChannel, pass.useLighting]).toEqual(['a', false]);
    const { blendState } = pass;
    expect([blendState.colorSrcFactor, blendState.colorDstFactor]).toEqual([
      BLENDMODE_SRC_ALPHA,
      BLENDMODE_ONE_MINUS_SRC_ALPHA
    ]);
    expect([pass.depthWrite, pass.depthFunc, pass.cull, again.cull]).toEqual([
      false,
      FUNC_EQUAL,
      CULLFACE_BACK,
      CULLFACE_NONE
    ]);
    const on = (name: string) => pass.defines.has(name);
    expect(['Q3_FOG_COORDS', 'Q3_FOG_PASS', 'Q3_FOG_KEEP', 'Q3_DEFORM_NOISE'].map(on)).toEqual([
      true,
      true,
      false,
      true
    ]);
    expect(parameterOf(pass, FOG_UNIFORM)).toBe(NO_FOG_DATA);
  });

  it("dims an effect's blended stages once each, reading nothing until a draw gives a fog", () => {
    const stages = [
      { material: new StandardMaterial(), fog: 'rgb' as const },
      { material: new StandardMaterial(), fog: 'alpha' as const },
      { material: new StandardMaterial(), fog: 'none' as const },
      { material: new StandardMaterial() }
    ];
    dimEffectStages(stages);
    dimEffectStages(stages);
    const [rgb, alpha, none, unsaid] = stages.map(({ material }) => material);
    const dims = (m: StandardMaterial) =>
      ['Q3_FOG_RGB', 'Q3_FOG_ALPHA'].map((name) => m.defines.has(name));
    expect([rgb, alpha].map(dims)).toEqual([
      [true, false],
      [false, true]
    ]);
    for (const [name, code] of FOG_ADJUSTMENT_CHUNKS.glsl) {
      expect(rgb.getShaderChunks(SHADERLANGUAGE_GLSL).get(name)).toBe(code);
    }
    expect(parameterOf(rgb, FOG_UNIFORM)).toBe(NO_FOG_DATA);
    for (const material of [none, unsaid]) {
      expect(material.defines.has('Q3_FOG_RGB')).toBe(false);
      expect(material.getParameter(FOG_UNIFORM)).toBeUndefined();
    }
  });
});
