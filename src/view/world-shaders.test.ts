import { describe, expect, it } from 'vitest';

import { MST_BAD, MST_FLARE, MST_PATCH, MST_PLANAR, MST_TRIANGLE_SOUP } from '../formats/bsp';
import {
  SS_BLEND0,
  SS_BLEND1,
  SS_DECAL,
  SS_ENVIRONMENT,
  SS_FOG,
  SS_OPAQUE,
  SS_PORTAL,
  SS_SEE_THROUGH,
  parseShaderScripts,
  type ShaderStage
} from '../formats/shader-script';
import { fogParts, surface, testBsp, testSources, type TestFog } from './world-test-fixtures';
import {
  DEFAULT_IMAGE,
  DEFAULT_SHADER,
  LIGHTMAP_2D,
  LIGHTMAP_BY_VERTEX,
  LIGHTMAP_NONE,
  LIGHTMAP_WHITEIMAGE,
  collapseMultitexture,
  loadWorldShaders,
  type FinishSwitches,
  type WorldShader,
  type WorldShaders
} from './world-shaders';
import { SKY_SUFFIXES } from './world-sky';

/** The registry's names, in the order they were registered. */
function names(shaders: WorldShaders): string[] {
  return shaders.shaders.map((shader) => shader.name);
}

/** The lightmap index each shader was made at, in the order they were registered. */
function lightmapIndexes(shaders: WorldShaders): number[] {
  return shaders.shaders.map((shader) => shader.lightmapIndex);
}

/** A box of fog 8 units across filled with this shader. */
const fogBox = (shader: string): TestFog => ({ mins: [0, 0, 0], maxs: [8, 8, 8], shader });

/** Both switches on, as Q3's defaults have them. */
const MERGING: FinishSwitches = { multitexture: true, textureEnvAdd: true };

/** Stages as the parser reads them. */
function stagesOf(stages: string): ShaderStage[] {
  return parseShaderScripts([`stages { ${stages} }`]).get('stages')!.stages;
}

/** The stage two merge into, or `null` where they stay two. */
function merged(stages: string, switches = MERGING): ShaderStage | null {
  const parsed = stagesOf(stages);
  const result = collapseMultitexture(parsed, switches);
  return result.length < parsed.length ? result[0] : null;
}

describe('loadWorldShaders', () => {
  it('registers the default first, then each name at its first use in lump order', () => {
    const bsp = testBsp({
      shaders: ['textures/a/one', 'textures/a/two', 'textures/a/three', 'textures/a/four'],
      surfaces: [
        surface({ shaderNum: 2, surfaceType: MST_FLARE, numVerts: 0, numIndexes: 0 }),
        surface({ shaderNum: 1, surfaceType: MST_PATCH, lightmapNum: 3 }),
        surface({ shaderNum: 2, lightmapNum: 0 }),
        surface({ shaderNum: 0, lightmapNum: 1 }),
        surface({ shaderNum: 1, lightmapNum: 0 })
      ]
    });
    const images = ['textures/a/one.tga', 'textures/a/two.jpg', 'textures/a/three.tga'];
    const sources = testSources('', images);
    const shaders = loadWorldShaders(bsp, sources, true);
    // Flares and patches register too, and under `r_fullbright` a name is one shader whatever
    // lightmap its surfaces ask for. The shader lump's own order counts for nothing.
    expect(names(shaders)).toEqual([
      DEFAULT_SHADER,
      'textures/a/three',
      'textures/a/two',
      'textures/a/one'
    ]);
    expect(lightmapIndexes(shaders)).toEqual([
      LIGHTMAP_NONE,
      LIGHTMAP_WHITEIMAGE,
      LIGHTMAP_WHITEIMAGE,
      LIGHTMAP_WHITEIMAGE
    ]);
    expect([...shaders.surfaceShaders]).toEqual([1, 2, 1, 3, 2]);
    expect(sources.warnings).toEqual([]);
  });

  it('finds a shader by its name and the lightmap index it was made at', () => {
    const wall = (fields: Parameters<typeof surface>[0]) => surface({ shaderNum: 0, ...fields });
    const bsp = testBsp({
      shaders: ['textures/a/wall', 'textures/a/lamp'],
      surfaces: [
        wall({ lightmapNum: 0 }),
        wall({ surfaceType: MST_PATCH, lightmapNum: 1 }),
        wall({ lightmapNum: 0 }),
        wall({ lightmapNum: -1 }),
        // Soups and flares ask by their vertices, whatever lightmap they name.
        wall({ surfaceType: MST_TRIANGLE_SOUP, lightmapNum: 0 }),
        surface({ shaderNum: 1, surfaceType: MST_FLARE, numVerts: 0, numIndexes: 0 }),
        wall({ surfaceType: MST_TRIANGLE_SOUP, lightmapNum: 1 })
      ],
      lightmaps: 2
    });
    const sources = testSources('', ['textures/a/wall.tga', 'textures/a/lamp.tga']);
    const shaders = loadWorldShaders(bsp, sources);
    expect(names(shaders)).toEqual([
      DEFAULT_SHADER,
      'textures/a/wall',
      'textures/a/wall',
      'textures/a/wall',
      'textures/a/wall',
      'textures/a/lamp'
    ]);
    expect(lightmapIndexes(shaders)).toEqual([
      LIGHTMAP_NONE,
      0,
      1,
      LIGHTMAP_NONE,
      LIGHTMAP_BY_VERTEX,
      LIGHTMAP_BY_VERTEX
    ]);
    expect([...shaders.surfaceShaders]).toEqual([1, 2, 1, 3, 4, 5, 4]);
    // One sort, so they draw in the order they were made.
    expect(shaders.shaders.map((shader) => shader.sortedIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('asks by the vertices past the last page, where a single page counts as two', () => {
    const asked = (pages: number, ...lightmapNums: number[]) =>
      lightmapIndexes(
        loadWorldShaders(
          testBsp({
            surfaces: lightmapNums.map((lightmapNum) => surface({ lightmapNum })),
            lightmaps: pages
          }),
          testSources('', ['textures/test/wall.tga'])
        )
      ).slice(1);
    expect(asked(1, 0, 1, 2)).toEqual([0, 1, LIGHTMAP_BY_VERTEX]);
    expect(asked(0, 0)).toEqual([LIGHTMAP_BY_VERTEX]);
    expect(asked(3, 2, 3)).toEqual([2, LIGHTMAP_BY_VERTEX]);
  });

  it('warns of an index below LIGHTMAP_2D, and asks by the vertices instead', () => {
    const bsp = testBsp({
      shaders: ['textures/a/wall.tga'],
      surfaces: [
        surface({ lightmapNum: -5 }),
        surface({ surfaceType: MST_TRIANGLE_SOUP }),
        surface({ lightmapNum: -4 })
      ]
    });
    const sources = testSources('', ['textures/a/wall.tga']);
    const shaders = loadWorldShaders(bsp, sources);
    expect(lightmapIndexes(shaders)).toEqual([LIGHTMAP_NONE, LIGHTMAP_BY_VERTEX, LIGHTMAP_2D]);
    expect([...shaders.surfaceShaders]).toEqual([1, 1, 2]);
    // The name as the map asks for it, extension and all.
    expect(sources.warnings).toEqual([
      "WARNING: shader 'textures/a/wall.tga' has invalid lightmap index of -5\n"
    ]);
  });

  it('keeps a script with no $lightmap stage at LIGHTMAP_NONE, so a page makes it again', () => {
    const scripts = `
      textures/s/glass { { map g.tga blendFunc add } }
      textures/s/lit { { map g.tga } { map $LIGHTMAP blendFunc filter } }
    `;
    const bsp = testBsp({
      shaders: ['textures/s/glass', 'textures/s/lit'],
      surfaces: [
        surface({ shaderNum: 0, lightmapNum: 0 }),
        surface({ shaderNum: 1, lightmapNum: 0 }),
        surface({ shaderNum: 0, lightmapNum: 0 }),
        surface({ shaderNum: 1, lightmapNum: 0 }),
        // At `LIGHTMAP_NONE` the latest is found.
        surface({ shaderNum: 0, lightmapNum: -1 })
      ],
      lightmaps: 1
    });
    const shaders = loadWorldShaders(bsp, testSources(scripts, ['g.tga']));
    expect(names(shaders)).toEqual([
      DEFAULT_SHADER,
      'textures/s/glass',
      'textures/s/lit',
      'textures/s/glass'
    ]);
    expect(lightmapIndexes(shaders)).toEqual([LIGHTMAP_NONE, LIGHTMAP_NONE, 0, LIGHTMAP_NONE]);
    expect([...shaders.surfaceShaders]).toEqual([1, 2, 3, 2, 3]);
  });

  it('answers a failed shader by its name at any index, and once', () => {
    const scripts = 'textures/f/missing { { map $lightmap } { map textures/f/gone.tga } }';
    const bsp = testBsp({
      shaders: ['textures/f/missing', 'textures/f/noimage'],
      surfaces: [0, 1].flatMap((shaderNum) =>
        [0, 1, -1].map((lightmapNum) => surface({ shaderNum, lightmapNum }))
      ),
      lightmaps: 2
    });
    const sources = testSources(scripts, []);
    const shaders = loadWorldShaders(bsp, sources);
    expect(names(shaders)).toEqual([DEFAULT_SHADER, 'textures/f/missing', 'textures/f/noimage']);
    expect([...shaders.surfaceShaders]).toEqual([0, 0, 0, 0, 0, 0]);
    // The image it can't find, and the stage that failed on it left with none.
    expect(sources.warnings).toHaveLength(2);
    // Kept as Q3 keeps them: the script by its `$lightmap` stage, the image with no stage at all.
    expect(lightmapIndexes(shaders)).toEqual([LIGHTMAP_NONE, 0, LIGHTMAP_NONE]);
  });

  it('makes a name with no script by the lightmap index it is asked at', () => {
    const asks = [0, LIGHTMAP_NONE, LIGHTMAP_2D];
    const bsp = testBsp({
      shaders: ['textures/a/wall'],
      surfaces: [
        ...asks.map((lightmapNum) => surface({ lightmapNum })),
        surface({ surfaceType: MST_TRIANGLE_SOUP })
      ],
      lightmaps: 1
    });
    const sources = testSources('', ['textures/a/wall.jpg']);
    const stages = (shader: WorldShader) =>
      shader.stages.map(({ maps, blend, blendFactors, rgbGen, depthWrite, ...rest }) => ({
        maps,
        blend,
        blendFactors,
        rgbGen,
        depthWrite,
        ...('alphaGen' in rest ? { alphaGen: rest.alphaGen } : {}),
        ...('depthTest' in rest ? { depthTest: rest.depthTest } : {})
      }));
    const [, page, none, flat, soup] = loadWorldShaders(bsp, sources).shaders;
    const [white] = loadWorldShaders(bsp, sources, true).shaders.slice(1);
    const multiplied = {
      maps: ['textures/a/wall'],
      blend: 'filter',
      blendFactors: ['gl_dst_color', 'gl_zero'],
      rgbGen: 'identity',
      depthWrite: false
    };
    const plain = (map: string, rgbGen: string) => ({
      maps: [map],
      blend: 'opaque',
      blendFactors: undefined,
      rgbGen,
      depthWrite: true
    });
    expect(stages(page)).toEqual([plain('$lightmap', 'identity'), multiplied]);
    expect(stages(white)).toEqual([plain('$whiteimage', 'identityLighting'), multiplied]);
    expect(stages(none)).toEqual([plain('textures/a/wall', 'lightingDiffuse')]);
    expect(stages(soup)).toEqual([{ ...plain('textures/a/wall', 'exactVertex'), alphaGen: 'skip' }]);
    expect(stages(flat)).toEqual([
      {
        maps: ['textures/a/wall'],
        blend: 'blend',
        blendFactors: ['gl_src_alpha', 'gl_one_minus_src_alpha'],
        rgbGen: 'vertex',
        depthWrite: false,
        alphaGen: 'vertex',
        depthTest: false
      }
    ]);
    expect([page, white, none, soup].map((shader) => shader.sort)).toEqual([
      SS_OPAQUE,
      SS_OPAQUE,
      SS_OPAQUE,
      SS_OPAQUE
    ]);
    expect(flat.sort).toBe(SS_BLEND0);
  });

  it('sorts each shader as FinishShader does', () => {
    const scripts = `
      textures/s/sky { skyparms - 512 - { map $lightmap } }
      textures/s/grate { { map g.tga blendFunc blend depthWrite alphaFunc GE128 } }
      textures/s/glass { { map g.tga blendFunc add } { map g.tga blendFunc filter } }
      textures/s/wall { { map $lightmap } { map g.tga blendFunc filter } }
      textures/s/solid { { map g.tga blendFunc GL_ONE GL_ZERO } { map g.tga blendFunc add } }
      textures/s/fog { surfaceparm fog fogparms ( 1 0 0 ) 128
      }
    `;
    const names = ['sky', 'grate', 'glass', 'wall', 'solid', 'fog'].map((n) => `textures/s/${n}`);
    const surfaces = names.map((_, shaderNum) => surface({ shaderNum }));
    const bsp = testBsp({ shaders: names, surfaces });
    const shaders = loadWorldShaders(bsp, testSources(scripts, ['g.tga'])).shaders.slice(1);
    expect(shaders.map((shader) => shader.sort)).toEqual([
      SS_ENVIRONMENT,
      SS_SEE_THROUGH,
      SS_BLEND0,
      // A blended stage after an opaque one sorts nothing, and `GL_ONE GL_ZERO` is no blend.
      SS_OPAQUE,
      SS_OPAQUE,
      SS_FOG
    ]);
  });

  it("finds a sky's faces as R_FindImageFile does, and has no box without its _rt", () => {
    const scripts = `
      textures/k/whole { skyparms env/a - - }
      textures/k/holed { skyparms env/b - - }
      textures/k/unright { skyparms env/c - - }
      textures/k/clouds { skyparms - 512 - { map c.tga } }
    `;
    const names = ['whole', 'holed', 'unright', 'clouds'].map((n) => `textures/k/${n}`);
    const bsp = testBsp({
      shaders: names,
      surfaces: names.map((_, shaderNum) => surface({ shaderNum, lightmapNum: LIGHTMAP_NONE }))
    });
    const faces = (box: string, suffixes: readonly string[], extension: string) =>
      suffixes.map((suffix) => `${box}_${suffix}${extension}`);
    const images = [
      ...faces('env/a', SKY_SUFFIXES, '.jpg'),
      ...faces('env/b', ['rt', 'lf', 'up'], '.jpg'),
      ...faces('env/c', ['bk', 'lf', 'ft', 'up', 'dn'], '.tga'),
      'c.tga'
    ];
    const sources = testSources(scripts, images);
    const [, whole, holed, unright, clouds] = loadWorldShaders(bsp, sources).shaders;
    expect(whole.sky).toEqual({ box: faces('env/a', SKY_SUFFIXES, '.tga') });
    const missing = DEFAULT_IMAGE;
    expect(holed.sky).toEqual({
      box: ['env/b_rt.tga', missing, 'env/b_lf.tga', missing, 'env/b_up.tga', missing]
    });
    expect(unright.sky).toEqual({});
    expect(clouds.sky).toEqual({});
    // A sky needs no stages.
    expect([whole, holed, unright, clouds].map((shader) => shader.defaultShader)).toEqual([
      false,
      false,
      false,
      false
    ]);
    expect([whole, holed, unright, clouds].map((shader) => shader.sort)).toEqual([
      SS_ENVIRONMENT,
      SS_ENVIRONMENT,
      SS_ENVIRONMENT,
      SS_ENVIRONMENT
    ]);
    expect(sources.warnings).toEqual([]);
  });

  it('warns where a parse reaches a skyParms short of a parameter, which makes no sky', () => {
    const scripts = `
      textures/k/short { { map c.tga } skyparms - 512
        { map c.tga blendFunc add } }
      textures/k/late { { map gone.tga } skyparms
      }
      textures/k/early { skyparms
        { map gone.tga } }
    `;
    const names = ['short', 'late', 'early'].map((n) => `textures/k/${n}`);
    const bsp = testBsp({
      shaders: names,
      surfaces: names.map((_, shaderNum) => surface({ shaderNum, lightmapNum: LIGHTMAP_NONE }))
    });
    const sources = testSources(scripts, ['c.tga']);
    const [, short] = loadWorldShaders(bsp, sources).shaders;
    expect(short.sky).toBeUndefined();
    expect(short.sort).toBe(SS_OPAQUE);
    expect(short.stages).toHaveLength(2);
    // The parse stops at the first image it can't find, so `late` never reaches its `skyParms`.
    // The stage it stopped in is finished with no image, as a failed parse is.
    expect(sources.warnings).toEqual([
      "WARNING: 'skyParms' missing parameter in shader 'textures/k/short'\n",
      "WARNING: R_FindImageFile could not find 'gone.tga' in shader 'textures/k/late'\n",
      'Shader textures/k/late has a stage with no image\n',
      "WARNING: 'skyParms' missing parameter in shader 'textures/k/early'\n",
      "WARNING: R_FindImageFile could not find 'gone.tga' in shader 'textures/k/early'\n",
      'Shader textures/k/early has a stage with no image\n'
    ]);
  });

  it('takes a later skyParms over an earlier, as ParseSkyParms writes over one shader', () => {
    const scripts = `
      textures/k/thrice { skyparms env/a 256 -
        skyparms - 64 -
        skyparms env/b 128
      }
    `;
    const bsp = testBsp({
      shaders: ['textures/k/thrice'],
      surfaces: [surface({ lightmapNum: LIGHTMAP_NONE })]
    });
    const images = ['env/a', 'env/b'].flatMap((box) => SKY_SUFFIXES.map((s) => `${box}_${s}.tga`));
    const sources = testSources(scripts, images);
    const shaders = loadWorldShaders(bsp, sources);
    // A sky still, though the last warns; the last box named, since `-` names none, and the last
    // height read.
    expect(shaders.shaders[1].sky?.box?.[0]).toBe('env/b_rt.tga');
    expect(shaders.cloudHeight).toBe(128);
    expect(sources.warnings).toEqual([
      "WARNING: 'skyParms' missing parameter in shader 'textures/k/thrice'\n"
    ]);
  });

  it("makes the clouds' table again at each cloud height a parse reads, the last one kept", () => {
    const scripts = `
      textures/k/high { skyparms - 384 - }
      textures/k/low { skyparms - 128
      }
      textures/k/failed { { map gone.tga } skyparms - 64 - }
      textures/k/before { skyparms - 32 - { map gone.tga } }
    `;
    const names = ['high', 'low', 'failed', 'before'].map((n) => `textures/k/${n}`);
    const heightAfter = (...asks: [number, number][]) =>
      loadWorldShaders(
        testBsp({
          shaders: names,
          surfaces: asks.map(([shaderNum, lightmapNum]) => surface({ shaderNum, lightmapNum })),
          lightmaps: 1
        }),
        testSources(scripts, [])
      ).cloudHeight;
    // A line short of its inner box still read its height, and a failed parse reads one only if
    // it got that far.
    expect(heightAfter([0, -1], [1, -1])).toBe(128);
    expect(heightAfter([1, -1], [0, -1], [2, -1])).toBe(384);
    expect(heightAfter([0, -1], [3, -1])).toBe(32);
    // Made again at a page, since a script without `$lightmap` is kept at `LIGHTMAP_NONE`.
    expect(heightAfter([0, 0], [1, -1], [0, 0])).toBe(384);
    // Found again, it is not parsed again.
    expect(heightAfter([0, -1], [1, -1], [0, -1])).toBe(128);
    expect(heightAfter()).toBeUndefined();
  });

  it("keeps the sun the last parse with a q3map_sun points to, as tr.sunDirection is left", () => {
    const scripts = `
      textures/k/east {
        q3map_sun 1 1 1 100 0 0
        { map a.tga }
      }
      textures/k/up {
        q3map_sunExt 1 1 1 100 0 90 2 16
        { map a.tga }
      }
      textures/k/plain { { map a.tga } }
    `;
    const names = ['east', 'up', 'plain'].map((n) => `textures/k/${n}`);
    const sunAfter = (...asks: number[]) =>
      loadWorldShaders(
        testBsp({
          shaders: names,
          surfaces: asks.map((shaderNum) => surface({ shaderNum, lightmapNum: LIGHTMAP_NONE }))
        }),
        sources
      ).sunDirection;
    const sources = testSources(scripts, ['a.tga']);
    expect(sunAfter(0, 2)).toEqual([1, 0, 0]);
    expect(sunAfter(0, 1)?.[2]).toBe(1);
    expect(sunAfter(1, 0)).toEqual([1, 0, 0]);
    expect(sunAfter(2)).toBeUndefined();
    expect(sources.warnings).toEqual([]);
  });

  it('places each shader by its sort, then by when it was first asked for', () => {
    const scripts = `
      textures/s/glass { { map g.tga blendFunc add } }
      textures/s/sky { skyparms - 512 - { map $lightmap } }
    `;
    const bsp = testBsp({
      shaders: ['textures/s/glass', 'textures/s/wall', 'textures/s/sky', 'textures/s/floor'],
      surfaces: [0, 1, 2, 3].map((shaderNum) => surface({ shaderNum }))
    });
    const images = ['g.tga', 'textures/s/wall.tga', 'textures/s/floor.tga'];
    const shaders = loadWorldShaders(bsp, testSources(scripts, images));
    expect(names(shaders)).toEqual([
      DEFAULT_SHADER,
      'textures/s/glass',
      'textures/s/wall',
      'textures/s/sky',
      'textures/s/floor'
    ]);
    // The sky first, then the opaque in order with the default ahead, then the blend.
    expect(shaders.shaders.map((shader) => shader.sortedIndex)).toEqual([1, 4, 2, 0, 3]);
  });

  it("gives Q3's default to a surface whose shader fails, warning where Q3 warns", () => {
    const scripts = `
      textures/f/missing { { map textures/f/gone.tga } }
      textures/f/stageless { surfaceparm nodraw }
    `;
    const bsp = testBsp({
      shaders: ['textures/f/noimage', 'textures/f/missing', 'textures/f/stageless', ''],
      surfaces: [0, 1, 2, 3, 0].map((shaderNum) => surface({ shaderNum }))
    });
    const sources = testSources(scripts, []);
    const shaders = loadWorldShaders(bsp, sources);
    expect([...shaders.surfaceShaders]).toEqual([0, 0, 0, 0, 0]);
    // Each failed shader is registered, once, as Q3 registers it.
    expect(names(shaders)).toEqual([
      DEFAULT_SHADER,
      'textures/f/noimage',
      'textures/f/missing',
      'textures/f/stageless'
    ]);
    expect(shaders.shaders.slice(1).every((shader) => shader.defaultShader)).toBe(true);
    expect(sources.warnings).toEqual([
      "WARNING: R_FindImageFile could not find 'textures/f/gone.tga' in shader " +
        "'textures/f/missing'\n",
      'Shader textures/f/missing has a stage with no image\n'
    ]);
    const [fallback] = shaders.shaders;
    expect(fallback.sort).toBe(SS_OPAQUE);
    expect(fallback.stages.map(({ maps, rgbGen, blend }) => ({ maps, rgbGen, blend }))).toEqual([
      { maps: [DEFAULT_IMAGE], rgbGen: 'identityLighting', blend: 'opaque' }
    ]);
  });

  it('takes two names that differ only in case for one shader, as R_FindShader does', () => {
    const bsp = testBsp({
      shaders: ['textures/a/Wall', 'textures/a/wall'],
      surfaces: [surface({ shaderNum: 0 }), surface({ shaderNum: 1 })]
    });
    const shaders = loadWorldShaders(bsp, testSources('', ['textures/a/wall.tga']));
    expect(names(shaders)).toEqual([DEFAULT_SHADER, 'textures/a/Wall']);
    expect([...shaders.surfaceShaders]).toEqual([1, 1]);
  });

  it('finds a script by its name stripped of its extension, whatever its case', () => {
    const bsp = testBsp({ shaders: ['Textures/S/Glass.tga'] });
    const sources = testSources('textures/s/glass { { map g.tga blendFunc add } }', ['g.tga']);
    const [, glass] = loadWorldShaders(bsp, sources).shaders;
    expect(glass.name).toBe('Textures/S/Glass');
    expect(glass.script?.name).toBe('textures/s/glass');
  });

  it('draws the stages before the first with no image, and warns of it', () => {
    const bsp = testBsp({ shaders: ['textures/s/odd'] });
    const sources = testSources(
      'textures/s/odd { { map g.tga } { rgbGen identity } { map g.tga blendFunc add } }',
      ['g.tga']
    );
    const [, odd] = loadWorldShaders(bsp, sources).shaders;
    expect(odd.stages).toHaveLength(1);
    expect(sources.warnings).toEqual(['Shader textures/s/odd has a stage with no image\n']);
  });

  it("checks each surface in Q3's words, its type before its shader", () => {
    const sources = testSources('', ['textures/test/wall.tga']);
    const load = (...surfaces: Parameters<typeof surface>[0][]) =>
      () => loadWorldShaders(testBsp({ surfaces: surfaces.map((s) => surface(s)) }), sources);
    expect(load({ shaderNum: 1 })).toThrow(new Error('ShaderForShaderNum: bad num 1'));
    expect(load({ shaderNum: -1 })).toThrow(new Error('ShaderForShaderNum: bad num -1'));
    expect(load({ surfaceType: MST_BAD })).toThrow(new Error('Bad surfaceType'));
    expect(load({ surfaceType: 5, shaderNum: 9 })).toThrow(new Error('Bad surfaceType'));
    const soup = { surfaceType: MST_TRIANGLE_SOUP, numVerts: 2, numIndexes: 3 };
    expect(() =>
      loadWorldShaders(testBsp({ surfaces: [surface(soup)], drawIndexes: [0, 1, 2] }), sources)
    ).toThrow(new Error('Bad index in triangle surface'));
    expect(() =>
      loadWorldShaders(testBsp({ surfaces: [surface(soup)], drawIndexes: [0, -1, 1] }), sources)
    ).toThrow(new Error('Bad index in triangle surface'));
    expect(load({ surfaceType: MST_TRIANGLE_SOUP })).not.toThrow();
  });

  describe('with fog', () => {
    const scripts = `
      textures/f/hell { surfaceparm fog fogparms ( 0.5 0 0 ) 256
        { map h.tga blendFunc filter } }
      textures/f/grey { surfaceparm fog fogparms ( 0.5 0.5 0.5 ) 512
      }
      textures/s/glass { { map g.tga blendFunc add } }
    `;
    // The glass asked for first, then each fog's face from inside it.
    const bsp = testBsp({
      shaders: ['textures/s/glass', 'textures/f/hell', 'textures/f/grey'],
      surfaces: [
        surface({ shaderNum: 0 }),
        surface({ shaderNum: 1, fogNum: 1 }),
        surface({ shaderNum: 2, fogNum: 0 })
      ],
      ...fogParts([fogBox('textures/f/grey'), fogBox('textures/f/hell')])
    });

    it("registers each fog's shader first, in lump order at LIGHTMAP_NONE, for its faces", () => {
      const sources = testSources(scripts, ['h.tga', 'g.tga']);
      const shaders = loadWorldShaders(bsp, sources);
      expect(names(shaders)).toEqual([
        DEFAULT_SHADER,
        'textures/f/grey',
        'textures/f/hell',
        'textures/s/glass'
      ]);
      expect(lightmapIndexes(shaders)).toEqual([
        LIGHTMAP_NONE,
        LIGHTMAP_NONE,
        LIGHTMAP_NONE,
        LIGHTMAP_NONE
      ]);
      expect([...shaders.surfaceShaders]).toEqual([3, 2, 1]);
      // So the hell fog's faces draw ahead of the glass, though the glass was asked for first.
      const [, grey, hell, glass] = shaders.shaders;
      expect([grey.sort, hell.sort, glass.sort]).toEqual([SS_FOG, SS_BLEND0, SS_BLEND0]);
      expect(hell.sortedIndex).toBeLessThan(glass.sortedIndex);
      expect(shaders.fogs.map((fog) => fog.parms)).toEqual([
        { color: [0.5, 0.5, 0.5], depthForOpaque: 512 },
        { color: [0.5, 0, 0], depthForOpaque: 256 }
      ]);
      expect(sources.warnings).toEqual([]);
    });

    it('makes the faces their own shaders under r_fullbright, the fogs keeping theirs', () => {
      const shaders = loadWorldShaders(bsp, testSources(scripts, ['h.tga', 'g.tga']), true);
      expect(names(shaders)).toEqual([
        DEFAULT_SHADER,
        'textures/f/grey',
        'textures/f/hell',
        'textures/s/glass',
        'textures/f/hell',
        'textures/f/grey'
      ]);
      expect(lightmapIndexes(shaders)).toEqual([
        LIGHTMAP_NONE,
        LIGHTMAP_NONE,
        LIGHTMAP_NONE,
        LIGHTMAP_WHITEIMAGE,
        LIGHTMAP_WHITEIMAGE,
        LIGHTMAP_WHITEIMAGE
      ]);
      expect([...shaders.surfaceShaders]).toEqual([3, 4, 5]);
      expect(shaders.fogs.map((fog) => fog.parms.depthForOpaque)).toEqual([512, 256]);
    });

    it('throws for a fog whose brush is out of range before any surface is checked', () => {
      const broken = testBsp({
        shaders: ['textures/f/grey'],
        surfaces: [surface({ shaderNum: 7 })],
        ...fogParts([fogBox('textures/f/grey')])
      });
      broken.fogs[0].brushNum = 1;
      expect(() => loadWorldShaders(broken, testSources(scripts, []))).toThrow(
        new Error('fog brushNumber out of range')
      );
    });

    it("throws in the port's words for a surface in a fog the map hasn't got, but a flare", () => {
      const inFog = (fogNum: number, surfaceType = MST_PLANAR) => () =>
        loadWorldShaders(
          testBsp({
            shaders: ['textures/s/glass'],
            surfaces: [surface(), surface({ fogNum, surfaceType })],
            ...fogParts([fogBox('textures/f/grey'), fogBox('textures/f/hell')])
          }),
          testSources(scripts, ['h.tga', 'g.tga'])
        );
      expect(inFog(1)).not.toThrow();
      expect(inFog(2)).toThrow(
        new Error("R_LoadSurfaces: surface 1's fog 2 lies outside the fogs")
      );
      expect(inFog(-2, MST_PATCH)).toThrow(
        new Error("R_LoadSurfaces: surface 1's fog -2 lies outside the fogs")
      );
      expect(inFog(2, MST_FLARE)).not.toThrow();
      // Its type is checked first.
      expect(inFog(2, MST_BAD)).toThrow(new Error('Bad surfaceType'));
    });
  });

  it('warns of a fogParms with no depth, and fails one short of a parenthesis or channel', () => {
    const scripts = `
      textures/f/nodepth { surfaceparm fog fogparms ( 1 0 0 )
      }
      textures/f/open { surfaceparm fog fogparms 1 0 0 ) 64 }
      textures/f/short { surfaceparm fog fogparms ( 1 0.5
        { map h.tga }
      }
      textures/f/unclosed { surfaceparm fog fogparms ( 0 0 1 64 }
    `;
    const fogNames = ['nodepth', 'open', 'short', 'unclosed'].map((n) => `textures/f/${n}`);
    const bsp = testBsp({
      shaders: fogNames,
      surfaces: fogNames.map((_, shaderNum) => surface({ shaderNum })),
      ...fogParts(fogNames.map(fogBox))
    });
    const sources = testSources(scripts, ['h.tga']);
    const shaders = loadWorldShaders(bsp, sources);
    // The parse stops at a failed colour, before the stage after it.
    expect(sources.warnings).toEqual([
      "WARNING: missing parm for 'fogParms' keyword in shader 'textures/f/nodepth'\n",
      "WARNING: missing parenthesis in shader 'textures/f/open'\n",
      "WARNING: missing vector element in shader 'textures/f/short'\n",
      "WARNING: missing parenthesis in shader 'textures/f/unclosed'\n"
    ]);
    expect(shaders.shaders.slice(1).map((shader) => shader.defaultShader)).toEqual([
      false,
      true,
      true,
      true
    ]);
    expect([...shaders.surfaceShaders]).toEqual([1, 0, 0, 0]);
    // A fog takes what its shader's parse read, failed or not.
    expect(shaders.fogs.map((fog) => fog.parms)).toEqual([
      { color: [1, 0, 0], depthForOpaque: 0 },
      { color: [0, 0, 0], depthForOpaque: 0 },
      { color: [1, 0.5, 0], depthForOpaque: 0 },
      { color: [0, 0, 1], depthForOpaque: 0 }
    ]);
  });

  it('takes the last fogParms a parse reaches, in the order written among its skyParms', () => {
    const scripts = `
      textures/f/twice { surfaceparm fog fogparms ( 1 0 0 ) 64
        fogparms ( 0 1 0 )
      }
      textures/f/late { surfaceparm fog { map gone.tga } fogparms ( 0 0 1 ) 32
      }
      textures/k/fogfirst { fogparms ( 1 0
        skyparms - 64 - }
      textures/k/skyfirst { skyparms - 32 -
        fogparms ( 1 0
      }
    `;
    const names = ['f/twice', 'f/late', 'k/fogfirst', 'k/skyfirst'].map((n) => `textures/${n}`);
    const load = (...shaderNums: number[]) => {
      const sources = testSources(scripts, []);
      const bsp = testBsp({
        shaders: names,
        surfaces: shaderNums.map((shaderNum) => surface({ shaderNum })),
        ...fogParts([fogBox(names[0]), fogBox(names[1])])
      });
      return { ...loadWorldShaders(bsp, sources), warnings: sources.warnings };
    };
    const fogged = load();
    // The second short of its depth keeps the first's; the stage before `late`'s fails first.
    expect(fogged.fogs.map((fog) => fog.parms)).toEqual([
      { color: [0, 1, 0], depthForOpaque: 64 },
      { color: [0, 0, 0], depthForOpaque: 0 }
    ]);
    expect(fogged.shaders[2].fogParms).toBeUndefined();
    expect(fogged.warnings).toEqual([
      "WARNING: missing parm for 'fogParms' keyword in shader 'textures/f/twice'\n",
      "WARNING: R_FindImageFile could not find 'gone.tga' in shader 'textures/f/late'\n",
      'Shader textures/f/late has a stage with no image\n'
    ]);
    // A failed colour stops the parse before a `skyParms` after it, which makes no clouds' table.
    const fogFirst = load(2);
    expect(fogFirst.cloudHeight).toBeUndefined();
    expect(fogFirst.warnings.slice(3)).toEqual([
      "WARNING: missing vector element in shader 'textures/k/fogfirst'\n"
    ]);
    expect(load(3).cloudHeight).toBe(32);
  });

  it('gives each shader a fog pass by its sort, and each stage an adjustment by its blend', () => {
    const scripts = `
      textures/p/sky { skyparms - 512 - }
      textures/p/wall { { map $lightmap } { map g.tga blendFunc filter } }
      textures/p/grate { { map g.tga blendFunc blend depthWrite } }
      textures/p/fog { surfaceparm fog fogparms ( 1 0 0 ) 64
      }
      textures/p/hell { surfaceparm fog fogparms ( 1 0 0 ) 64
        { map g.tga blendFunc filter } }
      textures/p/glass { { map g.tga blendFunc add } }
      textures/p/stages {
        { map g.tga blendFunc GL_ONE GL_ONE }
        { map g.tga blendFunc GL_ZERO GL_ONE_MINUS_SRC_COLOR }
        { map g.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA }
        { map g.tga blendFunc GL_ONE GL_ONE_MINUS_SRC_ALPHA }
        { map g.tga blendFunc filter }
        { map g.tga blendFunc GL_DST_COLOR GL_ONE }
        { map g.tga blendFunc GL_ONE GL_ZERO }
        { map g.tga } }
      textures/p/unknown {
        { map g.tga blendFunc GL_FOO GL_ONE }
        { map g.tga blendFunc GL_ONE GL_BAR }
        { map g.tga blendFunc GL_FOO GL_ONE_MINUS_SRC_ALPHA }
        { map g.tga blendFunc foo bar } }
      textures/p/after { { map g.tga } { map g.tga blendFunc add } }
    `;
    const kinds = ['sky', 'wall', 'grate', 'fog', 'hell', 'glass', 'stages', 'unknown', 'after'];
    const shaderNames = [...kinds.map((n) => `textures/p/${n}`), 'textures/p/plain'];
    const bsp = testBsp({
      shaders: shaderNames,
      surfaces: shaderNames.map((_, shaderNum) => surface({ shaderNum, lightmapNum: 0 })),
      lightmaps: 1
    });
    const shaders = loadWorldShaders(bsp, testSources(scripts, ['g.tga', 'textures/p/plain.tga']));
    const passes = Object.fromEntries(
      shaders.shaders.map((shader) => [shader.name, shader.fogPass])
    );
    expect(passes).toEqual({
      [DEFAULT_SHADER]: 'equal',
      'textures/p/sky': 'equal',
      'textures/p/wall': 'equal',
      'textures/p/grate': 'none',
      'textures/p/fog': 'lessEqual',
      'textures/p/hell': 'lessEqual',
      'textures/p/glass': 'none',
      'textures/p/stages': 'none',
      'textures/p/unknown': 'none',
      'textures/p/after': 'equal',
      'textures/p/plain': 'equal'
    });
    const adjustments = Object.fromEntries(
      shaders.shaders.map((shader) => [shader.name, shader.fogAdjustments])
    );
    expect(adjustments).toEqual({
      [DEFAULT_SHADER]: ['none'],
      'textures/p/sky': [],
      'textures/p/wall': ['none', 'none'],
      'textures/p/grate': ['alpha'],
      'textures/p/fog': [],
      'textures/p/hell': ['none'],
      'textures/p/glass': ['rgb'],
      'textures/p/stages': ['rgb', 'rgb', 'alpha', 'rgba', 'none', 'none', 'none', 'none'],
      // A name Q3 doesn't know is `GL_ONE`, whether or not the parser kept it.
      'textures/p/unknown': ['rgb', 'rgb', 'rgba', 'rgb'],
      // Only where the first stage blends too.
      'textures/p/after': ['none', 'none'],
      'textures/p/plain': ['none', 'none']
    });
  });

  it('warns of a face with more than 64 points, and draws it with the default', () => {
    const sources = testSources('', ['textures/test/wall.tga']);
    const shaders = loadWorldShaders(
      testBsp({ surfaces: [surface({ numVerts: 64 }), surface({ numVerts: 65 })] }),
      sources
    );
    expect([...shaders.surfaceShaders]).toEqual([1, 0]);
    expect(sources.warnings).toEqual(['WARNING: MAX_FACE_POINTS exceeded: 65\n']);
  });

  it("merges a shader's first two stages where asked, after its sort and fog adjustments", () => {
    const scripts = `
      textures/m/portal {
        { map g.tga blendFunc add rgbGen identity }
        { map h.tga blendFunc add rgbGen identity }
        { map g.tga blendFunc blend } }
      textures/m/wet { { map g.tga rgbGen identity } { map h.tga blendFunc add rgbGen identity } }
      textures/m/lit { { map $lightmap rgbGen identity } { map g.tga blendFunc filter } }
    `;
    const bsp = testBsp({
      shaders: ['textures/m/portal', 'textures/m/wet', 'textures/m/lit', 'textures/m/plain'],
      surfaces: [0, 1, 2, 3].map((shaderNum) => surface({ shaderNum, lightmapNum: 0 })),
      lightmaps: 1
    });
    const images = ['g.tga', 'h.tga', 'textures/m/plain.tga'];
    const load = (fullbright: boolean, switches?: FinishSwitches) =>
      loadWorldShaders(bsp, testSources(scripts, images), fullbright, switches).shaders.slice(1);
    const [portal, wet, lit, plain] = load(false, MERGING);
    const unmerged = load(false);
    expect(unmerged.map((shader) => shader.stages.length)).toEqual([3, 2, 2, 2]);
    expect([portal, wet, lit, plain].map((shader) => shader.stages.length)).toEqual([2, 1, 1, 1]);
    // The sort and the adjustments are found first, so the merged stage keeps its first's.
    expect(unmerged[0].fogAdjustments).toEqual(['rgb', 'rgb', 'alpha']);
    expect(portal.fogAdjustments).toEqual(['rgb', 'alpha']);
    expect(portal.stages[1].blend).toBe('blend');
    expect([portal.sort, wet.sort]).toEqual([SS_BLEND0, SS_OPAQUE]);
    expect([portal.fogPass, wet.fogPass]).toEqual(['none', 'equal']);
    expect(wet.fogAdjustments).toEqual(['none']);
    expect(lit.stages[0]).toMatchObject({ maps: ['g.tga'], multitexture: { maps: ['$lightmap'] } });
    // An implicit shader at a page: its image, the lightmap multiplied in, each on the
    // coordinates `FinishShader` gives it.
    expect(plain.stages).toEqual([
      {
        maps: ['textures/m/plain'],
        animFps: 0,
        blend: 'opaque',
        depthWrite: true,
        clamp: false,
        tcGen: 'texture',
        texMods: [],
        rgbGen: 'identity',
        multitexture: {
          maps: ['$lightmap'],
          animFps: 0,
          clamp: false,
          lightmap: true,
          tcGen: 'lightmap',
          texMods: [],
          env: 'modulate'
        }
      }
    ]);
    // Under `r_fullbright` the implicit shader's white is at `identityLighting`, and stays two
    // stages; a script's `$lightmap`, white there, still merges.
    const fullbright = load(true, MERGING);
    expect(fullbright.map((shader) => shader.stages.length)).toEqual([2, 1, 1, 2]);
  });
});

describe('loadWorldShaders: a shader finished as FinishShader finishes it', () => {
  /** Each shader asked for by one surface at the one page, as a map's faces ask. */
  function finishAll(
    scripts: string,
    names: string[],
    switches?: FinishSwitches,
    images = ['g.tga', 'h.tga']
  ) {
    const sources = testSources(scripts, images);
    const bsp = testBsp({
      shaders: names,
      surfaces: names.map((_, shaderNum) => surface({ shaderNum, lightmapNum: 0 })),
      lightmaps: 1
    });
    const loaded = loadWorldShaders(bsp, sources, false, switches);
    return { shaders: loaded.shaders.slice(1), warnings: sources.warnings };
  }

  it('sorts as its script says, by name or number, a sky whatever it says, and a decal unsaid', () => {
    const scripts = `
      t/portal { portal
        { map g.tga } }
      t/named { sort additive
        { map g.tga } }
      t/number { sort 6.5
        { map g.tga } }
      t/zero { sort 0
        { map g.tga blendFunc add } }
      t/misspelt { sort blend
        { map g.tga blendFunc add } }
      t/sky { sort nearest
        skyparms - 512 - }
      t/decal { polygonOffset
        { map g.tga blendFunc filter } }
      t/sorted { polygonOffset
        sort seeThrough
        { map g.tga } }
      t/low { sort 2.5
        { map g.tga blendFunc add } }
    `;
    const names = ['portal', 'named', 'number', 'zero', 'misspelt', 'sky', 'decal', 'sorted', 'low'];
    const { shaders } = finishAll(scripts, names.map((n) => `t/${n}`));
    // `sort 0` and a name `ParseSort` doesn't know read as no sort, and a blend sorts itself.
    expect(shaders.map((shader) => shader.sort)).toEqual([
      SS_PORTAL,
      SS_BLEND1,
      6.5,
      SS_BLEND0,
      SS_BLEND0,
      SS_ENVIRONMENT,
      SS_DECAL,
      SS_SEE_THROUGH,
      2.5
    ]);
    // The fog pass by the sort: a decal sorts above opaque, so has none.
    expect(shaders.map((shader) => shader.fogPass)).toEqual([
      'equal',
      'none',
      'none',
      'none',
      'none',
      'equal',
      'none',
      'none',
      'equal'
    ]);
    // A sort Q3 has no name for draws where its number puts it: 2.5 after the sky and before the
    // default's opaque.
    expect(shaders.map((shader) => shader.sortedIndex)).toEqual([0, 9, 6, 7, 8, 1, 4, 5, 2]);
  });

  it('drops a detail stage under r_detailtextures 0, before its coordinates, sort and merge', () => {
    const scripts = `
      t/detailed {
        { map $lightmap rgbGen identity }
        { map g.tga blendFunc add rgbGen identity detail }
        { map h.tga blendFunc filter rgbGen identity } }
      t/alldetail { { map $lightmap detail } }
    `;
    const merging: FinishSwitches = { multitexture: true, textureEnvAdd: true };
    const kept = finishAll(scripts, ['t/detailed', 't/alldetail'], merging).shaders;
    const dropped = finishAll(scripts, ['t/detailed', 't/alldetail'], {
      ...merging,
      detailTextures: false
    }).shaders;
    // Kept, the lightmap merges with the detail; dropped, with the stage after it.
    expect(kept[0].stages.map((stage) => stage.maps)).toEqual([['g.tga'], ['h.tga']]);
    expect(dropped[0].stages.map((stage) => stage.maps)).toEqual([['h.tga']]);
    expect(dropped[0].stages[0].multitexture?.maps).toEqual(['$lightmap']);
    // A shader whose stages all go is a fog's, and has no lightmap stage to keep its page by.
    expect([kept[1].sort, kept[1].lightmapIndex]).toEqual([SS_OPAQUE, 0]);
    expect([dropped[1].sort, dropped[1].lightmapIndex]).toEqual([SS_FOG, LIGHTMAP_NONE]);
  });

  it("gives each texture its coordinates where none were said: the lightmap's, or its own", () => {
    const scripts = `
      t/coords {
        { map $lightmap }
        { map g.tga blendFunc filter tcGen lightmap }
        { map $lightmap blendFunc filter tcGen base }
        { map h.tga blendFunc filter } }
      t/flagged { { map $lightmap map g.tga } }
    `;
    const [coords, flagged] = finishAll(scripts, ['t/coords', 't/flagged']).shaders;
    expect(coords.stages.map((stage) => stage.tcGen)).toEqual([
      'lightmap',
      'lightmap',
      'texture',
      'texture'
    ]);
    // `map $lightmap` makes the stage the lightmap's, whatever image it ends on, and the shader
    // keeps its page by it.
    expect(flagged.stages[0]).toMatchObject({ maps: ['g.tga'], lightmap: true, tcGen: 'lightmap' });
    expect(flagged.lightmapIndex).toBe(0);
  });

  it('reads a shader again with its images looked up, its warnings naming it as it was asked', () => {
    const scripts = `
      textures/r/clamped { { clampmap $lightmap } }
      textures/r/frames {
        { animMap 1 a.tga b.tga c.tga d.tga e.tga f.tga g.tga h.tga i.tga
        } }
    `;
    const images = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => `${n}.tga`);
    const { shaders, warnings } = finishAll(
      scripts,
      ['Textures/R/Clamped.tga', 'textures/r/frames'],
      undefined,
      images
    );
    // A clamped `$lightmap` is an image's name, and no image has it.
    expect(shaders.map((shader) => shader.defaultShader)).toEqual([true, false]);
    // A ninth frame is never looked for.
    expect(shaders[1].stages[0].maps).toEqual(images);
    expect(warnings).toEqual([
      "WARNING: R_FindImageFile could not find '$lightmap' in shader 'Textures/R/Clamped'\n",
      'Shader Textures/R/Clamped has a stage with no image\n',
      "WARNING: ignoring excess images for 'animMap' (found 9, max is 8) in shader " +
        "'textures/r/frames'\n"
    ]);
  });

  it("drops the map at a stage's fifth tcMod, as its ERR_DROP does", () => {
    const scripts = `
      textures/r/five { {
        map g.tga
        tcMod scroll 1 0
        tcMod scroll 1 0
        tcMod scroll 1 0
        tcMod scroll 1 0
        tcMod scroll 1 0
      } }
    `;
    expect(() => finishAll(scripts, ['textures/r/five'])).toThrow(
      new Error("ERROR: too many tcMod stages in shader 'textures/r/five'")
    );
  });

  it('draws a shader the same whatever its nolightmap, trans, sky or nodraw', () => {
    const stages = `
        { map $lightmap }
        { map g.tga blendFunc filter } }`;
    const scripts = `
      t/plain {${stages}
      t/parms { surfaceparm nolightmap
        surfaceparm trans
        surfaceparm sky
        surfaceparm nodraw${stages}
    `;
    const [plain, parms] = finishAll(scripts, ['t/plain', 't/parms']).shaders;
    const drawn = ({ sort, fogPass, lightmapIndex, defaultShader, stages, fogAdjustments }: WorldShader) => ({
      sort,
      fogPass,
      lightmapIndex,
      defaultShader,
      stages,
      fogAdjustments
    });
    expect(drawn(parms)).toEqual(drawn(plain));
    expect(parms.script?.surfaceParms).toEqual(['nolightmap', 'trans', 'sky', 'nodraw']);
  });
});

describe('collapseMultitexture', () => {
  const FILTER = { blend: 'filter', blendFactors: ['gl_dst_color', 'gl_zero'] };
  const ADD = { blend: 'add', blendFactors: ['gl_one', 'gl_one'] };

  it("merges each row of the table at the row's blend, the stages after moving down", () => {
    const rows: [string, string, string, object][] = [
      ['', 'blendFunc GL_ZERO GL_SRC_COLOR', 'modulate', { blend: 'opaque' }],
      ['', 'blendFunc GL_DST_COLOR GL_ZERO', 'modulate', { blend: 'opaque' }],
      ['blendFunc filter', 'blendFunc filter', 'modulate', FILTER],
      ['blendFunc GL_ZERO GL_SRC_COLOR', 'blendFunc filter', 'modulate', FILTER],
      ['blendFunc filter', 'blendFunc GL_ZERO GL_SRC_COLOR', 'modulate', FILTER],
      ['blendFunc GL_ZERO GL_SRC_COLOR', 'blendFunc GL_ZERO GL_SRC_COLOR', 'modulate', FILTER],
      ['', 'blendFunc add', 'add', { blend: 'opaque' }],
      ['blendFunc GL_ONE GL_ONE', 'blendFunc add', 'add', ADD]
    ];
    for (const [first, second, env, blend] of rows) {
      const label = `${first} | ${second}`;
      const stages = collapseMultitexture(
        stagesOf(`
          { map a.tga ${first} rgbGen identity }
          { map b.tga ${second} rgbGen identity }
          { map c.tga blendFunc blend }`),
        MERGING
      );
      expect(stages.map((stage) => stage.maps), label).toEqual([['a.tga'], ['c.tga']]);
      expect(stages[0], label).toMatchObject({
        ...blend,
        rgbGen: 'identity',
        // The first stage's, blended or not.
        depthWrite: first === '',
        multitexture: { maps: ['b.tga'], env }
      });
      if (first === '') expect(stages[0].blendFactors, label).toBeUndefined();
    }
  });

  it('puts the lightmap second, each texture keeping its images, clamp and coordinates', () => {
    expect(
      merged(`
        { map $lightmap rgbGen identity tcGen environment tcMod scale 2 2
          }
        { animMap 2 textures/b.tga textures/c.tga
          blendFunc filter tcMod scroll 1 0
            }`)
    ).toEqual({
      maps: ['textures/b.tga', 'textures/c.tga'],
      animFps: 2,
      clamp: false,
      texMods: [{ type: 'scroll', s: 1, t: 0 }],
      blend: 'opaque',
      depthWrite: true,
      rgbGen: 'identity',
      alphaGen: 'skip',
      multitexture: {
        maps: ['$lightmap'],
        animFps: 0,
        clamp: false,
        lightmap: true,
        tcGen: 'environment',
        texMods: [{ type: 'scale', s: 2, t: 2 }],
        env: 'modulate'
      }
    });
    expect(
      merged(`{ clampmap a.tga rgbGen identity tcMod rotate 10
        } { map $lightmap blendFunc filter }`)
    ).toEqual({
      maps: ['a.tga'],
      animFps: 0,
      clamp: true,
      texMods: [{ type: 'rotate', degreesPerSecond: 10 }],
      blend: 'opaque',
      depthWrite: true,
      rgbGen: 'identity',
      alphaGen: 'skip',
      multitexture: {
        maps: ['$lightmap'],
        animFps: 0,
        clamp: false,
        lightmap: true,
        texMods: [],
        env: 'modulate'
      }
    });
  });

  it('refuses a pair no row has, or one whose alpha test, colour or alpha differ', () => {
    for (const stages of [
      // No row has these.
      '{ map a.tga rgbGen identity } { map b.tga blendFunc blend rgbGen identity }',
      '{ map a.tga blendFunc add rgbGen identity } { map b.tga blendFunc filter }',
      '{ map a.tga blendFunc filter } { map b.tga blendFunc add rgbGen identity }',
      '{ map a.tga blendFunc GL_DST_COLOR GL_ONE } { map b.tga blendFunc filter }',
      // The alpha test.
      '{ map a.tga rgbGen identity alphaFunc GE128 } { map b.tga blendFunc filter }',
      '{ map a.tga rgbGen identity alphaFunc GT0 } { map b.tga blendFunc filter alphaFunc GE128 }',
      // The colour and its wave.
      '{ map a.tga } { map b.tga blendFunc filter }',
      '{ map a.tga rgbGen wave sin 0 1 0 1 } { map b.tga blendFunc filter rgbGen wave sin 0 1 0 2 }',
      // The alpha and its wave.
      '{ map a.tga rgbGen identity alphaGen wave sin 0 1 0 1 } { map b.tga blendFunc filter }',
      `{ map a.tga rgbGen identity alphaGen wave sin 0 1 0 1 }
        { map b.tga blendFunc filter alphaGen wave sin 0 1 0.5 1 }`,
      '{ map a.tga rgbGen identity alphaGen vertex } { map b.tga blendFunc filter }',
      '{ map a.tga rgbGen identity alphaGen lightingSpecular } { map b.tga blendFunc filter }',
      // A pair that adds at a colour other than identity.
      '{ map a.tga rgbGen vertex } { map b.tga blendFunc add rgbGen vertex }',
      '{ map a.tga } { map b.tga blendFunc add }',
      '{ map a.tga rgbGen identity }'
    ]) {
      expect(merged(stages), stages).toBeNull();
    }
  });

  it('merges a pair whose depth writes differ, alike in all else, and names unknown as GL_ONE', () => {
    for (const stages of [
      '{ map a.tga rgbGen identity } { map b.tga blendFunc filter depthWrite }',
      '{ map a.tga rgbGen identity alphaFunc GE128 } { map b.tga blendFunc filter alphaFunc GE128 }',
      '{ map a.tga rgbGen wave sin 0 1 0 1 } { map b.tga blendFunc filter rgbGen wave sin 0 1 0 1 }',
      `{ map a.tga rgbGen identity alphaGen wave sin 0 1 0 1 }
        { map b.tga blendFunc filter alphaGen wave sin 0 1 0 1 }`,
      // A pair that multiplies, at a colour other than identity.
      '{ map a.tga rgbGen vertex } { map b.tga blendFunc filter rgbGen vertex }',
      // `GL_ONE GL_ZERO`, and `GL_ONE GL_ONE`.
      '{ map a.tga blendFunc GL_FOO GL_ZERO rgbGen identity } { map b.tga blendFunc filter }',
      '{ map a.tga blendFunc GL_ONE GL_FOO rgbGen identity } { map b.tga blendFunc add rgbGen identity }'
    ]) {
      expect(merged(stages), stages).not.toBeNull();
    }
    // The alpha test is the first's, as it is the second's.
    expect(
      merged('{ map a.tga rgbGen identity alphaFunc GT0 } { map b.tga blendFunc filter alphaFunc GT0 }')
    ).toMatchObject({ alphaFunc: 'GT0' });
  });

  it("refuses a pair whose depth function differs, and keeps the first's const colour", () => {
    expect(
      merged('{ map a.tga rgbGen identity } { map b.tga blendFunc filter depthFunc equal }')
    ).toBeNull();
    expect(
      merged(`{ map a.tga rgbGen identity depthFunc equal }
        { map b.tga blendFunc filter depthFunc equal }`)
    ).toMatchObject({ depthFunc: 'equal' });
    expect(
      merged(`{ map a.tga rgbGen const ( 1 0 0 ) alphaGen const 0.5 }
        { map b.tga blendFunc filter rgbGen const ( 0 1 0 ) alphaGen const 1 }`)
    ).toMatchObject({ rgbGen: 'const', alphaGen: 'const', constantColor: [255, 0, 0, 127] });
  });

  it('refuses a pair whose colour or alpha are of different kinds', () => {
    for (const stages of [
      '{ map a.tga rgbGen oneMinusEntity } { map b.tga blendFunc filter rgbGen entity }',
      `{ map a.tga rgbGen identity alphaGen entity }
        { map b.tga blendFunc filter alphaGen oneMinusEntity }`,
      `{ map a.tga rgbGen identity alphaGen portal 64 }
        { map b.tga blendFunc filter }`
    ]) {
      expect(merged(stages), stages).toBeNull();
    }
  });

  it('refuses a pair one of which tests no depth', () => {
    const [a, b] = stagesOf('{ map a.tga rgbGen identity } { map b.tga blendFunc filter }');
    const untested = [{ ...a, depthTest: false }, b];
    expect(collapseMultitexture(untested, MERGING)).toHaveLength(2);
    const neither = [{ ...a, depthTest: false }, { ...b, depthTest: false }];
    expect(collapseMultitexture(neither, MERGING)).toHaveLength(1);
  });

  it('merges nothing without r_ext_multitexture, and no add without r_ext_texture_env_add', () => {
    const multiplies = '{ map a.tga rgbGen identity } { map b.tga blendFunc filter }';
    const adds = '{ map a.tga rgbGen identity } { map b.tga blendFunc add rgbGen identity }';
    const off = { multitexture: false, textureEnvAdd: true };
    expect([merged(multiplies, off), merged(adds, off)]).toEqual([null, null]);
    const noAdd = { multitexture: true, textureEnvAdd: false };
    expect(merged(multiplies, noAdd)).not.toBeNull();
    expect(merged(adds, noAdd)).toBeNull();
  });
});

describe('a registration for a place alone', () => {
  const SCRIPTS = `
    fx/warned { cull bogus { map g.tga } }
    fx/dropped { { map g.tga
${'tcMod scale 1 1\n'.repeat(5)}} }
  `;
  const load = () => {
    const sources = testSources(SCRIPTS, ['textures/a/wall.tga', 'g.tga']);
    const bsp = testBsp({ shaders: ['textures/a/wall'], surfaces: [surface({ shaderNum: 0 })] });
    return { sources, shaders: loadWorldShaders(bsp, sources) };
  };

  it('prints none of its warnings, and counts the sort it makes', () => {
    const { sources, shaders } = load();
    const printed = sources.warnings.length;
    const generation = shaders.generation;
    const warned = shaders.register('fx/warned', LIGHTMAP_2D, true);
    expect(sources.warnings).toHaveLength(printed);
    expect(warned.name).toBe('fx/warned');
    expect(shaders.generation).toBeGreaterThan(generation);
    // Found again, it sorts nothing in.
    const found = shaders.generation;
    expect(shaders.register('fx/warned', LIGHTMAP_2D, true)).toBe(warned);
    expect(shaders.generation).toBe(found);
  });

  it("leaves a shader whose parse would drop the map the default's, where a draw's throws", () => {
    const { shaders } = load();
    expect(shaders.register('fx/dropped', LIGHTMAP_2D, true).name).toBe(DEFAULT_SHADER);
    expect(() => shaders.register('fx/dropped', LIGHTMAP_2D)).toThrow(/too many tcMod/);
  });
});
