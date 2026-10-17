// @vitest-environment jsdom
import {
  ADDRESS_CLAMP_TO_EDGE,
  ADDRESS_REPEAT,
  ASPECT_AUTO,
  ASPECT_MANUAL,
  BLENDMODE_DST_COLOR,
  BLENDMODE_ONE,
  BLENDMODE_ZERO,
  CULLFACE_FRONT,
  CULLFACE_NONE,
  FILTER_LINEAR,
  FUNC_EQUAL,
  FUNC_LESSEQUAL,
  LAYERID_WORLD,
  PIXELFORMAT_RGBA8,
  SEMANTIC_COLOR,
  SEMANTIC_NORMAL,
  SEMANTIC_POSITION,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  TEXTURELOCK_READ,
  Vec3,
  type AppBase,
  type Entity,
  type MeshInstance,
  type Shader,
  type StandardMaterial,
  type Texture
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MST_PATCH,
  MST_TRIANGLE_SOUP,
  type Bsp,
  type BspLeaf,
  type BspSurface
} from '../formats/bsp';
import { readEntities } from '../formats/entity-text';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { parseShaderScripts } from '../formats/shader-script';
import { decodeTga } from '../formats/tga';
import { resolveImageIn } from '../pak/vfs';
import { angleVectors } from '../sim/pmove-math';
import { brushModelsAtRest, type BrushModelPose } from '../view/brush-models';
import type { FirstPersonView } from '../view/camera-feel';
import type { DynamicLight } from '../view/dynamic-lights';
import {
  NO_WORLD,
  entityLight,
  entityLightAt,
  lightInEntityFrame
} from '../view/entity-light';
import { anglesToAxis } from '../view/hand-pose';
import type { LightGrid } from '../view/light-grid';
import { ScenePolys, polyVerts } from '../view/scene-polys';
import { SceneShaders, type SortedShader } from '../view/scene-shaders';
import { packetEntity, rampKey } from '../view/scene-sort';
import {
  Tess,
  anglesToAxes,
  projectionShadow,
  type DeformEntity,
  type DeformScene
} from '../view/world-deforms';
import {
  fogImage,
  fogVectors,
  loadFogs,
  type FogFrame,
  type WorldFog
} from '../view/world-fog';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { SkyIndexes, boxTexCoords, cloudTexCoords, skyPoints } from '../view/world-sky';
import { fogParts, leaf, model, node, surface, testBsp } from '../view/world-test-fixtures';
import { OPEN_AREAS } from '../view/world-vis';
import { FOG_ADJUSTMENT_CHUNKS } from './bsp-fog';
import { FOG_UNIFORM } from './fog-chunks';
import { SKY_POINTS_UNIFORM, VERTEX_COLOR_EMISSION } from './world-stages';
import { BspWorld, WORLD_LAYER_NAME, defaultImageTga, type BspWorldOptions } from './bsp-world';
import { MULTITEXTURE_CHUNKS } from './effect-material';
import { createTestApp, expectInOrder, held, uniform } from './engine-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { lightInEntity } from './staged-model';
import { TextureCache } from './texture-cache';
import { EYE_UNIFORM, VIEW_TERM_DECLARATIONS } from './view-term-chunks';
import { warmUp } from './warm-up';

/** A scene to place a world's movers' `model2`s in. */
const testScene = () =>
  new SceneDraws(new SceneShaders(), { models: [], effects: [], gun: [], screen: [] });

/** Whether draws are keyed in the order given, each after the last. */
const keyedInOrder = (draws: readonly MeshInstance[]): boolean =>
  draws.every((draw, i) => i === 0 || draw.drawOrder > draws[i - 1].drawOrder);

/** A TGA of `width` by `height`, every byte `value`. */
function tga(width = 2, height = 2, value = 255): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, width, 0, height, 0, 32, 0x28];
  return new Uint8Array([...header, ...new Array(width * height * 4).fill(value)]);
}

/** A search path holding these files. */
function searchPath(files: Record<string, Uint8Array>): BspWorldOptions['fs'] {
  const held = new Map(Object.entries(files).map(([path, bytes]) => [path.toLowerCase(), bytes]));
  return {
    resolveImage: (reference) => resolveImageIn((path) => held.has(path), reference),
    read: async (path) => held.get(path.toLowerCase())
  };
}

/** A lightmap page of three-byte texels, its first texels these and the rest 0. */
function lightmapPage(first: number[] = []): Uint8Array {
  const texels = new Uint8Array(128 * 128 * 3);
  texels.set(first);
  return texels;
}

/** A texture's texels, as uploaded. */
function texels(texture: Texture): Uint8Array {
  const data = texture.lock({ mode: TEXTURELOCK_READ }) as Uint8Array;
  texture.unlock();
  return data;
}

/** Each surface its own three vertices and three indexes, in this shader, lit by page 0. */
function surfaces(...shaderNums: number[]) {
  return shaderNums.map((shaderNum, i) =>
    surface({ shaderNum, firstVert: 3 * i, firstIndex: 3 * i, lightmapNum: 0 })
  );
}

const SCRIPTS = `
  textures/s/glass { { map g.tga blendFunc add } }
  textures/s/lit { { map $lightmap } { map g.tga blendFunc filter } }
`;

/** A mark's shader, as cgame's are: a decal by its `polygonOffset`, darkening what it is over. */
const MARK = `
  textures/s/mark {
    polygonOffset
    { map g.tga blendFunc GL_ZERO GL_ONE_MINUS_SRC_COLOR rgbGen exactVertex }
  }
`;

/** An adding shader whose texture scrolls, half a texture a second. */
const GLOW = `
  textures/s/glow {
    { map g.tga blendFunc add tcMod scroll 0.5 0
    }
  }
`;

/** A frame's polys: one triangle in `shader`, at `at`. */
function triangle(shader: SortedShader, at = 0): ScenePolys<SortedShader> {
  const polys = new ScenePolys<SortedShader>(() => {});
  const verts = polyVerts(3);
  verts.xyz.fill(at);
  polys.add(shader, 3, verts, 0);
  return polys;
}

/** A preview's hand-in: the map's brush models where its entity text stands them. */
function placeAtRest(world: BspWorld, bsp: Bsp): void {
  world.placeModels(brushModelsAtRest(readEntities(bsp.entityString), bsp.models));
}

/** The visible set's cvars at their defaults. */
const VISIBLE = {
  noVis: false,
  noCull: false,
  lockPvs: false,
  showCluster: false,
  facePlaneCull: true,
  drawEntities: true,
  zNear: 4,
  lodCurveError: 250
};

const IMAGES = {
  'textures/s/wall.tga': tga(),
  'textures/s/floor.tga': tga(),
  'g.tga': tga()
};

describe('BspWorld', () => {
  let app: AppBase;
  let camera: Entity;
  let cache: TextureCache;
  let world: BspWorld | undefined;

  beforeEach(() => {
    ({ app, camera } = createTestApp());
    cache = new TextureCache(app.graphicsDevice);
  });

  afterEach(async () => {
    await world?.destroy();
    world = undefined;
    app.destroy();
  });

  async function load(options: Partial<BspWorldOptions> = {}): Promise<BspWorld> {
    world = await BspWorld.load(app, camera.camera!, {
      name: 'test',
      bsp: testBsp({
        shaders: ['textures/s/wall', 'textures/s/glass', 'textures/s/floor'],
        surfaces: surfaces(1, 0, 2, 0),
        lightmaps: 1
      }),
      scripts: parseShaderScripts([SCRIPTS]),
      fs: searchPath(IMAGES),
      cache,
      picmip: 0,
      mapOverBrightBits: 2,
      fullbright: false,
      subdivisions: 4,
      // Each stage its own pass, but where a test merges them.
      multitexture: false,
      textureEnvAdd: false,
      detailTextures: true,
      time: 0,
      offset: { factor: -1, units: -2 },
      warn: () => {},
      ...options
    });
    return world;
  }

  /** The draws of one frame, in the order the engine makes them, the ramp's among them. */
  function rendered(): MeshInstance[] {
    const drawn = [...world!.draws, ...world!.ramp];
    const byId = new Map(drawn.map((instance) => [instance.id, instance]));
    const order: MeshInstance[] = [];
    const id = app.graphicsDevice.scope.resolve('meshInstanceId');
    const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
      const instance = byId.get(id.value as number);
      if (instance) order.push(instance);
    });
    // The test maps are small, and near the camera rather than in front of it.
    const culling = camera.camera!.frustumCulling;
    camera.camera!.frustumCulling = false;
    app.render();
    camera.camera!.frustumCulling = culling;
    draw.mockRestore();
    return order;
  }

  /** A draw's material. */
  const material = (instance: MeshInstance) => instance.material as StandardMaterial;

  it('keys its draws again as a shader sorted in moves their places, in order', async () => {
    const loaded = await load();
    const before = loaded.draws.map((instance) => instance.drawOrder);
    const glass = loaded.draws.at(-1)!;
    const glassKey = glass.drawOrder;
    // An opaque shader cgame registers after the world's: it goes before the glass, which blends.
    loaded.registry.register('textures/s/lit', LIGHTMAP_2D, true);
    loaded.key();
    expect(glass.drawOrder).toBeGreaterThan(glassKey);
    expect(loaded.draws.slice(0, -1).map((instance) => instance.drawOrder)).toEqual(
      before.slice(0, -1)
    );
    expect(keyedInOrder(loaded.draws)).toBe(true);
  });

  it('takes the scene it is drawn in with it as it goes', async () => {
    const scene = testScene();
    const loaded = await load({ scene });
    scene.enter(loaded);
    expect(scene.inScene).toBe(true);
    await loaded.destroy();
    world = undefined;
    expect(scene.inScene).toBe(false);
  });

  it("draws each batch stage by stage, in opengl1's order, in a layer before World", async () => {
    const loaded = await load();
    // The wall's two surfaces, then the floor, both opaque, then the glass, which blends.
    const ranges = loaded.draws.map(({ mesh }) => {
      const [{ base, count }] = mesh!.primitive;
      return [base, count];
    });
    expect(ranges).toEqual([
      [0, 6],
      [0, 6],
      [6, 3],
      [6, 3],
      [9, 3]
    ]);
    expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
    // The layer sorts by hand, each draw by its key, in the order it is drawn.
    expect(keyedInOrder(loaded.draws)).toBe(true);
    const composition = app.scene.layers;
    expect(composition.getTransparentIndex(loaded.layer)).toBeLessThan(
      composition.getOpaqueIndex(composition.getLayerById(LAYERID_WORLD)!)
    );
    expect(loaded.layer.name).toBe(WORLD_LAYER_NAME);
    expect(camera.camera!.layers).toContain(loaded.layer.id);
    // Every stage blends, so the one hand-ordered list holds them all.
    expect(loaded.draws.every((instance) => instance.transparent)).toBe(true);
  });

  it("draws an implicit shader's page, then its texture multiplied over it", async () => {
    const loaded = await load();
    const [lightmap, texture] = loaded.draws.map(material);
    expect(lightmap.emissiveMap).toBe(loaded.lightmaps[0]);
    expect(lightmap.emissiveMapUv).toBe(1);
    expect([lightmap.blendState.colorSrcFactor, lightmap.blendState.colorDstFactor]).toEqual([
      BLENDMODE_ONE,
      BLENDMODE_ZERO
    ]);
    expect(lightmap.depthWrite).toBe(true);
    expect(texture.emissiveMap).not.toBeNull();
    expect(texture.emissiveMapUv).toBe(0);
    expect([texture.blendState.colorSrcFactor, texture.blendState.colorDstFactor]).toEqual([
      BLENDMODE_DST_COLOR,
      BLENDMODE_ZERO
    ]);
    expect(texture.depthWrite).toBe(false);
    expect([lightmap.cull, texture.cull]).toEqual([CULLFACE_FRONT, CULLFACE_FRONT]);
  });

  it('draws white, then the texture multiplied over it, under r_fullbright', async () => {
    const loaded = await load({ fullbright: true });
    const [white, texture] = loaded.draws.map(material);
    expect(white.emissiveMap).toBeNull();
    // `identityLighting`, for the ramp to double.
    expect(white.emissive.r).toBe(127 / 255);
    expect(texture.emissiveMap).not.toBeNull();
    expect(loaded.draws).toHaveLength(5);
  });

  it("draws a script's $lightmap stage on its page, and white with none", async () => {
    const lit = testBsp({
      shaders: ['textures/s/lit'],
      surfaces: [surface({ lightmapNum: 1 }), surface({ lightmapNum: -1 })],
      lightmaps: 2
    });
    const loaded = await load({ bsp: lit });
    const [page, texture, white] = loaded.draws.map(material);
    expect(page.emissiveMap).toBe(loaded.lightmaps[1]);
    expect(page.emissiveMapUv).toBe(1);
    expect(page.depthWrite).toBe(true);
    expect(texture.emissiveMap).not.toBeNull();
    expect(white.emissiveMap).toBeNull();
  });

  it('draws a merged stage as one draw, the lightmap second on the lightmap coordinates', async () => {
    const loaded = await load({ multitexture: true, textureEnvAdd: true });
    // The wall's batch, the floor's and the glass's, a draw each.
    expect(loaded.draws).toHaveLength(3);
    expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
    const [wall, floor] = loaded.draws.map(material);
    expect(wall).not.toBe(floor);
    for (const merged of [wall, floor]) {
      expect(merged.emissiveMap).not.toBeNull();
      expect(merged.emissiveMap).not.toBe(loaded.lightmaps[0]);
      expect(merged.emissiveMapUv).toBe(0);
      expect(merged.diffuseMap).toBe(loaded.lightmaps[0]);
      expect(merged.diffuseMapUv).toBe(1);
      // The first stage's: opaque, writing depth, at identity.
      const { blendState } = merged;
      expect([blendState.colorSrcFactor, blendState.colorDstFactor]).toEqual([
        BLENDMODE_ONE,
        BLENDMODE_ZERO
      ]);
      expect([merged.depthWrite, merged.emissive.r]).toEqual([true, 1]);
      expect(merged.defines.has('Q3_MULTITEXTURE_ADD')).toBe(false);
      expect(merged.getShaderChunks(SHADERLANGUAGE_WGSL).get('litUserMainEndPS')).toBe(
        MULTITEXTURE_CHUNKS.wgsl.get('litUserMainEndPS')
      );
    }
  });

  it("draws a merged stage's lightmap white below a page, with no map", async () => {
    const loaded = await load({
      bsp: testBsp({ shaders: ['textures/s/lit'], lightmaps: 1 }),
      scripts: parseShaderScripts([
        'textures/s/lit { { map $lightmap rgbGen identity } { map g.tga blendFunc filter } }'
      ]),
      fullbright: true,
      multitexture: true,
      textureEnvAdd: true
    });
    expect(loaded.draws).toHaveLength(1);
    const [lit] = loaded.draws.map(material);
    expect(lit.emissiveMap).not.toBeNull();
    // On the lightmap's coordinates, as its `tcGen` says.
    expect([lit.diffuseMap, lit.diffuseMapUv]).toEqual([null, 1]);
  });

  it('draws a detail stage under r_detailtextures, and drops it without', async () => {
    const detailed = {
      bsp: testBsp({ shaders: ['textures/s/detailed'] }),
      scripts: parseShaderScripts([
        'textures/s/detailed { { map g.tga } { map g.tga blendFunc filter detail } }'
      ])
    };
    expect((await load(detailed)).draws).toHaveLength(2);
    await world!.destroy();
    expect((await load({ ...detailed, detailTextures: false })).draws).toHaveLength(1);
  });

  it('draws each stage as its own under r_ext_multitexture 0, or where a pair may not merge', async () => {
    const loaded = await load({ multitexture: false, textureEnvAdd: true });
    expect(loaded.draws).toHaveLength(5);
    await loaded.destroy();
    // Under `r_fullbright` the white is at `identityLighting`, and the texture at `identity`.
    const white = await load({ fullbright: true, multitexture: true, textureEnvAdd: true });
    expect(white.draws).toHaveLength(5);
    await white.destroy();
    // So too a script's `$lightmap` with no `rgbGen`.
    const lit = testBsp({ shaders: ['textures/s/lit'], lightmaps: 1 });
    const script = await load({ bsp: lit, multitexture: true, textureEnvAdd: true });
    expect(script.draws).toHaveLength(2);
  });

  it("draws a merged stage's second texture where its modifiers put it, added", async () => {
    const loaded = await load({
      bsp: testBsp({ shaders: ['textures/s/wet'] }),
      scripts: parseShaderScripts([
        `textures/s/wet {
          { map g.tga rgbGen identity }
          { animMap 1 textures/s/wall.tga textures/s/floor.tga
            blendFunc add rgbGen identity
            tcMod scale 2 4
              } }`
      ]),
      time: 1500,
      multitexture: true,
      textureEnvAdd: true
    });
    expect(loaded.draws).toHaveLength(1);
    const [wet] = loaded.draws.map(material);
    expect(wet.defines.get('Q3_MULTITEXTURE_ADD')).toBe(true);
    // At 1.5 s, the flipbook's second frame: not the first texture's image.
    expect(wet.diffuseMap).not.toBeNull();
    expect(wet.diffuseMap).not.toBe(wet.emissiveMap);
    // The second texture on uv set 1, its coordinates the surface's own, scaled by the port's own
    // uniform; the first's as they are, and the engine's transforms left alone.
    expect(wet.diffuseMapUv).toBe(1);
    expect(['Q3_TC0', 'Q3_TC1', 'Q3_TC1_LIGHTMAP'].map((name) => wet.defines.has(name))).toEqual([
      false,
      true,
      false
    ]);
    expect([...(held(loaded.draws[0], 'q3_tc1[0]') as Float32Array).subarray(0, 12)]).toEqual([
      0, 0, 0, 0, 2, 0, 0, 0, 0, 4, 0, 0
    ]);
    expect(held(loaded.draws[0], 'q3_tc0[0]')).toBeUndefined();
    expect([wet.diffuseMapTiling.x, wet.diffuseMapTiling.y]).toEqual([1, 1]);
    expect([wet.emissiveMapTiling.x, wet.emissiveMapTiling.y]).toEqual([1, 1]);
    // Under `r_ext_texture_env_add 0`, two draws.
    await loaded.destroy();
    const two = await load({
      bsp: testBsp({ shaders: ['textures/s/wet'] }),
      scripts: parseShaderScripts([
        'textures/s/wet { { map g.tga rgbGen identity } { map g.tga blendFunc add rgbGen identity } }'
      ]),
      multitexture: true,
      textureEnvAdd: false
    });
    expect(two.draws).toHaveLength(2);
  });

  it('draws each stage in the colour opengl1 writes into its framebuffer', async () => {
    const loaded = await load({
      bsp: testBsp({ shaders: ['textures/s/colours'] }),
      scripts: parseShaderScripts([
        `textures/s/colours {
          { map g.tga rgbGen identityLighting }
          { map g.tga blendFunc filter rgbGen vertex }
          { map g.tga blendFunc filter rgbGen exactVertex }
          { map g.tga blendFunc filter rgbGen identity }
          { map g.tga blendFunc add rgbGen lightingDiffuse }
          { map g.tga blendFunc add rgbGen entity }
          { map g.tga blendFunc add rgbGen wave sin 0.5 1 0.25 1 }
          { map g.tga blendFunc add tcMod scroll 0.5 0
            }
        }`
      ])
    });
    const colours = loaded.draws.map((instance) => material(instance).emissive.r);
    // lightingDiffuse is its vertices' colours. The wave is 1.5 at the sine table's step at 0,
    // halved: 191.25 of 255, truncated. An additive stage's default is identityLighting, whatever
    // texture modifiers it plays.
    expect(colours).toEqual([127 / 255, 0.5, 1, 1, 1, 0, 191 / 255, 127 / 255]);
    // An implicit shader's lightmap and texture are both identity.
    await loaded.destroy();
    const implicit = await load({ style: { renderer: 'opengl1', overBrightBits: 2 } });
    expect(implicit.draws.slice(0, 2).map((instance) => material(instance).emissive.r)).toEqual([
      1, 1
    ]);
  });

  it("draws a const colour by its channels, and the world entity's colours and alphas", async () => {
    const loaded = await load({
      bsp: testBsp({ shaders: ['textures/s/constants'] }),
      scripts: parseShaderScripts([
        `textures/s/constants {
          { map g.tga blendFunc blend rgbGen const ( 1 0.5 0 ) alphaGen const 0.2 }
          { map g.tga blendFunc blend rgbGen oneMinusEntity alphaGen entity }
          { map g.tga blendFunc blend rgbGen lightingDiffuse }
          { map g.tga blendFunc blend rgbGen identity alphaGen oneMinusEntity }
          { map g.tga blendFunc blend rgbGen identity alphaGen vertex }
        }`
      ])
    });
    const drawn = loaded.draws.map(material);
    expect(drawn.map(({ emissive }) => [emissive.r, emissive.g, emissive.b])).toEqual([
      [1, 127 / 255, 0],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1]
    ]);
    // `alphaGen const`'s byte; the world entity's 0, and its inverse's 1; `lightingDiffuse`'s
    // light's, its alpha skipped, its vertices' as its light makes them; and the vertices' own.
    expect(drawn.map((m) => [m.opacity, m.opacityVertexColor])).toEqual([
      [51 / 255, false],
      [0, false],
      [1, true],
      [1, false],
      [1, true]
    ]);
    // The world entity's light is none, which its colour reads.
    expect([...(held(loaded.draws[2], 'q3_light[0]') as Float32Array)]).toEqual(Array(12).fill(0));
  });

  it('draws each texture on the coordinates its tcGen names', async () => {
    const loaded = await load({
      bsp: testBsp({
        shaders: ['textures/s/coords'],
        surfaces: [surface({ lightmapNum: 0 })],
        lightmaps: 1
      }),
      scripts: parseShaderScripts([
        `textures/s/coords {
          { map $lightmap rgbGen identity tcGen base }
          { map g.tga blendFunc filter tcGen lightmap }
          { map g.tga blendFunc blend }
        }`
      ])
    });
    const [page, lit, own] = loaded.draws.map(material);
    expect(page.emissiveMap).toBe(loaded.lightmaps[0]);
    expect([page.emissiveMapUv, lit.emissiveMapUv, own.emissiveMapUv]).toEqual([0, 1, 0]);
    // A blended stage reads its alpha on the same coordinates.
    expect(own.opacityMapUv).toBe(0);
  });

  it('ends the list with the ramp pass, once for each overbright bit and not at 0', async () => {
    const ramp = async (overBrightBits: number) => {
      if (world) await world.destroy();
      const loaded = await load({ style: { renderer: 'opengl1', overBrightBits } });
      expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
      return loaded.ramp;
    };
    const buffers = app.graphicsDevice.buffers.size;
    expect(await ramp(0)).toEqual([]);
    // Nothing is made for a ramp with no draws.
    await world!.destroy();
    world = undefined;
    expect(app.graphicsDevice.buffers.size).toBe(buffers);
    expect(await ramp(2)).toHaveLength(2);
    const [pass] = await ramp(1);
    // After every key a shader can have: the scene's last.
    expect(pass.drawOrder).toBe(rampKey(0));
    expect(keyedInOrder([...world!.draws, pass])).toBe(true);
    expect([pass.screenSpace, pass.cull, pass.transparent]).toEqual([true, false, true]);
    const doubled = material(pass);
    const { blendState } = doubled;
    expect([
      blendState.colorSrcFactor,
      blendState.colorDstFactor,
      blendState.alphaSrcFactor,
      blendState.alphaDstFactor
    ]).toEqual([BLENDMODE_DST_COLOR, BLENDMODE_ONE, BLENDMODE_ZERO, BLENDMODE_ONE]);
    expect([doubled.depthTest, doubled.depthWrite, doubled.cull]).toEqual([
      false,
      false,
      CULLFACE_NONE
    ]);
    expect([doubled.emissive.r, doubled.emissive.g, doubled.emissive.b]).toEqual([1, 1, 1]);
    expect(doubled.emissiveMap).toBeNull();
    // Its quad covers clip space, whatever the camera does.
    const positions: number[] = [];
    pass.mesh!.getPositions(positions);
    expect(positions).toEqual([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  });

  it('draws a soup by its vertex colours, and LIGHTMAP_2D with no depth test', async () => {
    const loaded = await load({
      bsp: testBsp({
        shaders: ['textures/s/wall', 'textures/s/floor'],
        surfaces: [
          surface({ shaderNum: 0, surfaceType: MST_TRIANGLE_SOUP, lightmapNum: 0 }),
          surface({ shaderNum: 1, lightmapNum: -4 })
        ],
        lightmaps: 1
      })
    });
    const [soup, flat] = loaded.draws.map(material);
    expect(loaded.draws).toHaveLength(2);
    expect([soup.emissiveVertexColor, soup.depthTest]).toEqual([true, true]);
    expect([flat.emissiveVertexColor, flat.opacityVertexColor, flat.depthTest]).toEqual([
      true,
      true,
      false
    ]);
  });

  /**
   * A face, or this surface, then a curve whose control points are flat but for the middle column,
   * raised 8, as a grid 3 by 2 whose middle column stands 4 off: drawn while it is within 1000 of
   * the view at `r_lodCurveError` 250. A second such curve is in no leaf, and never drawn.
   */
  function curveMap(first: Partial<BspSurface> = {}) {
    const faceVerts = first.numVerts ?? 3;
    const patch = surface({
      surfaceType: MST_PATCH,
      firstVert: faceVerts,
      numVerts: 9,
      patchWidth: 3,
      patchHeight: 3,
      lightmapNum: 0
    });
    const bsp = testBsp({
      shaders: ['textures/s/wall'],
      surfaces: [
        surface({ lightmapNum: 0, ...first }),
        patch,
        { ...patch, firstVert: faceVerts + 9 }
      ],
      leafs: [leaf(0, 2), leaf(0, 0)],
      leafSurfaces: [0, 1],
      lightmaps: 1
    });
    for (let i = 0; i < 9; i++) {
      const [column, row] = [i % 3, Math.floor(i / 3)];
      bsp.drawVerts.xyz.set([64 * column, 64 * row, column === 1 ? 8 : 0], (faceVerts + i) * 3);
    }
    return bsp;
  }

  /** A view from `depth` before the curves' group, at the origin, looking at it. */
  const before = (depth: number) => ({
    origin: { x: -depth, y: 0, z: 0 },
    angles: { x: 0, y: 0, z: 0 }
  });

  it("draws a curve's grid, its points after the map's own, coloured as it made them", async () => {
    const bsp = curveMap();
    bsp.drawVerts.color.fill(100);
    const loaded = await load({ bsp });

    // The face and the curve in one batch, drawn by its lightmap stage and its texture's.
    expect(loaded.draws).toHaveLength(2);
    const { mesh } = loaded.draws[0];
    const [{ base, count }] = mesh!.primitive;
    const indexes = new Uint32Array(mesh!.indexBuffer[0].storage as ArrayBuffer, base * 4, count);
    // The map's own 21 points, then the drawn grid's 6, 3 by 2.
    expect([...indexes]).toEqual([0, 1, 2, 21, 24, 22, 22, 24, 25, 22, 25, 23, 23, 25, 26]);
    const vertices = mesh!.vertexBuffer;
    expect(vertices.numVertices).toBe(27);
    const storage = vertices.storage as ArrayBuffer;
    const field = (semantic: string) =>
      vertices.format.elements.find(({ name }) => name === semantic)!.offset;
    const grid = Array.from({ length: 6 }, (_, i) => {
      const at = (21 + i) * vertices.format.size;
      const xyz = new Float32Array(storage, at + field(SEMANTIC_POSITION), 3);
      const rgba = new Uint8Array(storage, at + field(SEMANTIC_COLOR), 4);
      return [[...xyz], [...rgba]];
    });
    // Shifted once, at r_mapOverBrightBits 2 over 1 bit, and their alpha kept.
    const rgba = [200, 200, 200, 100];
    expect(grid).toEqual([
      [[0, 0, 0], rgba],
      [[64, 0, 4], rgba],
      [[128, 0, 0], rgba],
      [[0, 128, 0], rgba],
      [[64, 128, 4], rgba],
      [[128, 128, 0], rgba]
    ]);

    // Subdivided at r_subdivisions: 4 off its chord is more than 3.
    await loaded.destroy();
    world = await load({ bsp, subdivisions: 3 });
    expect(world.draws[0].mesh!.vertexBuffer.numVertices).toBe(21 + 5 * 2);
  });

  it("drops a curve's rows as the view moves off, uploading only its run", async () => {
    const loaded = await load({ bsp: curveMap() });
    const { mesh } = loaded.draws[0];
    const indexBuffer = mesh!.indexBuffer[0];
    const unlock = vi.spyOn(indexBuffer, 'unlock');
    const drawn = () => {
      const [{ base, count }] = mesh!.primitive;
      return [...new Uint32Array(indexBuffer.storage as ArrayBuffer, base * 4, count)];
    };
    // Within 1000 the grid stays whole.
    loaded.see(before(900), VISIBLE, OPEN_AREAS);
    expect(unlock).not.toHaveBeenCalled();
    loaded.see(before(2000), VISIBLE, OPEN_AREAS);
    expect(drawn()).toEqual([0, 1, 2, 21, 24, 23, 23, 24, 26]);
    expect(unlock.mock.calls).toEqual([[0, 9 * 4]]);
    // Both stages draw the one range.
    expect(loaded.draws[1].mesh).toBe(mesh);
    // Nothing is written while the view holds.
    loaded.see(before(2000), VISIBLE, OPEN_AREAS);
    expect(unlock).toHaveBeenCalledTimes(1);
    loaded.see(before(2000), { ...VISIBLE, lodCurveError: 1000 }, OPEN_AREAS);
    expect(drawn()).toEqual([0, 1, 2, 21, 24, 22, 22, 24, 25, 22, 25, 23, 23, 25, 26]);
    expect(unlock.mock.calls[1]).toEqual([0, 15 * 4]);
    // From the side, along the way the view looks.
    const side = { origin: { x: 0, y: -2000, z: 0 }, angles: { x: 0, y: 90, z: 0 } };
    loaded.see(side, VISIBLE, OPEN_AREAS);
    expect(drawn()).toEqual([0, 1, 2, 21, 24, 23, 23, 24, 26]);
  });

  it('draws nothing of an area the snapshot closes, and it all again as it opens', async () => {
    const loaded = await load({ bsp: curveMap() });
    const counts = () => loaded.draws.map((instance) => instance.mesh!.primitive[0].count);
    loaded.see(before(900), VISIBLE, OPEN_AREAS);
    const open = counts();
    expect(open.some((count) => count > 0)).toBe(true);
    // The map's one leaf is in area 0.
    const closed = new Uint8Array(32);
    closed[0] = 1;
    loaded.see(before(900), VISIBLE, closed);
    expect(counts().every((count) => count === 0)).toBe(true);
    expect(loaded.speeds().leafs).toBe(0);
    loaded.see(before(900), VISIBLE, OPEN_AREAS);
    expect(counts()).toEqual(open);
  });

  it('hides a batch its run no longer needs, and the warm-up draws each one whole', async () => {
    // With a soup of 994 points before it, the grid begins a batch of its own; two columns wide,
    // it fits. Under `r_fullbright` the soup and the curve ask for one shader, and its run has
    // room for a third batch, as next-fit could need.
    const soup = { surfaceType: MST_TRIANGLE_SOUP, numVerts: 994 };
    const loaded = await load({ bsp: curveMap(soup), fullbright: true });
    expect(loaded.draws).toHaveLength(6);
    const counts = () => loaded.draws.map((instance) => instance.mesh!.primitive[0].count);
    expect(counts()).toEqual([3, 3, 12, 12, 0, 0]);
    expect(rendered()).toEqual([...loaded.draws.slice(0, 4), ...loaded.ramp]);
    loaded.see(before(2000), VISIBLE, OPEN_AREAS);
    expect(rendered()).toEqual([...loaded.draws.slice(0, 2), ...loaded.ramp]);
    expect(counts()).toEqual([9, 9, 0, 0, 0, 0]);

    const seen: number[] = [];
    const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
      seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
    });
    warmUp(app, [loaded.warm()]);
    draw.mockRestore();
    // Each batch that has indexes. The spare has none, and draws with the others' materials.
    for (const [i, instance] of loaded.draws.entries()) {
      expect(seen.filter((id) => id === instance.id)).toHaveLength(i < 4 ? 2 : 0);
    }
    for (const [i, spare] of loaded.draws.slice(4).entries()) {
      expect(spare.material).toBe(loaded.draws[i].material);
    }
    expect(counts()).toEqual([3, 3, 12, 12, 0, 0]);
    // The next view finds what it sees, and the rows, again.
    expect(rendered()).toEqual([...loaded.draws.slice(0, 4), ...loaded.ramp]);
    loaded.see(before(2000), VISIBLE, OPEN_AREAS);
    expect(rendered()).toEqual([...loaded.draws.slice(0, 2), ...loaded.ramp]);
    loaded.showEntities(false);
    loaded.showEntities(true);
    expect(rendered()).toEqual([...loaded.draws.slice(0, 2), ...loaded.ramp]);
  });

  it('draws what a view sees, each run cut again where it changed', async () => {
    const loaded = await load();
    const [wall, , floor, , glass] = loaded.draws;
    const unlock = vi.spyOn(wall.mesh!.indexBuffer[0], 'unlock');
    /** A view down onto the map from `height`, its faces' planes at 0, 9, 18 and 27. */
    const above = (height: number) => ({
      origin: { x: 0, y: 0, z: height },
      angles: { x: 90, y: 0, z: 0 }
    });
    const indexes = ({ mesh }: MeshInstance) => {
      const [{ base, count }] = mesh!.primitive;
      return [...new Uint32Array(mesh!.indexBuffer[0].storage as ArrayBuffer, base * 4, count)];
    };
    // More than 8 under the second wall's plane, it is culled; 8 under the floor's, it is not.
    loaded.see(above(10), VISIBLE, OPEN_AREAS);
    expect(indexes(wall)).toEqual([3, 4, 5]);
    expect(unlock.mock.calls).toEqual([[0, 3 * 4]]);
    expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
    // Lower, the floor goes too, and its run alone is written.
    loaded.see(above(9), VISIBLE, OPEN_AREAS);
    expect(unlock.mock.calls[1]).toEqual([6 * 4, 0]);
    expect(rendered()).toEqual([...loaded.draws.slice(0, 2), glass, ...loaded.ramp]);
    expect(floor.visible).toBe(false);
    // Under `r_nocull` every face draws, as it did before the first view.
    loaded.see(above(9), { ...VISIBLE, noCull: true }, OPEN_AREAS);
    expect(indexes(wall)).toEqual([3, 4, 5, 9, 10, 11]);
    expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
    expect(unlock).toHaveBeenCalledTimes(4);
  });

  it('counts the last view as r_speeds 1 does, a triangle once a pass of its shader', async () => {
    const above = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
    const apart = await load();
    apart.see(above, VISIBLE, OPEN_AREAS);
    // The second wall is culled, as above: a batch each for the first, the floor and the glass.
    const counted = {
      shaders: 3,
      surfaces: 3,
      leafs: apart.vis.leafs,
      vertexes: 9,
      triangles: 3,
      zFar: Math.round(apart.vis.zFar)
    };
    expect(apart.speeds()).toEqual({ ...counted, passTriangles: 5 });
    await apart.destroy();
    // Merged, the wall and the floor draw a pass each.
    const merged = await load({ multitexture: true, textureEnvAdd: true });
    merged.see(above, VISIBLE, OPEN_AREAS);
    expect(merged.speeds()).toEqual({ ...counted, passTriangles: 3 });
    expect(counted.leafs).toBeGreaterThan(0);
  });

  describe('the dynamic lights', () => {
    /** The view down from 10 above, which sees the first wall, the floor and the glass. */
    const above = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
    /** A white light of radius 100 at the floor's second point, within reach of all three. */
    const lamp = (additive = false): DynamicLight => ({
      origin: { x: 7, y: 14, z: 21 },
      radius: 100,
      color: [1, 1, 1],
      additive
    });

    /** The draws of one frame, its light passes among them, in the order the engine makes them. */
    function drawnWithPasses(loaded: BspWorld): MeshInstance[] {
      const drawn = [...loaded.draws, ...loaded.spare, ...loaded.lightPasses, ...loaded.ramp];
      const byId = new Map(drawn.map((instance) => [instance.id, instance]));
      const order: MeshInstance[] = [];
      const id = app.graphicsDevice.scope.resolve('meshInstanceId');
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        const instance = byId.get(id.value as number);
        if (instance) order.push(instance);
      });
      camera.camera!.frustumCulling = false;
      app.render();
      draw.mockRestore();
      return order;
    }

    /** A draw's indexes, as its mesh draws them. */
    const indexes = ({ mesh }: MeshInstance) => {
      const [{ base, count }] = mesh!.primitive;
      return [...new Uint32Array(mesh!.indexBuffer[0].storage as ArrayBuffer, base * 4, count)];
    };

    it("draws a light's pass over each lit opaque batch, after its stages", async () => {
      const loaded = await load();
      const [wallMap, wallTexture, floorMap, floorTexture, glass] = loaded.draws;
      loaded.see(above, VISIBLE, OPEN_AREAS);
      loaded.animate(0, NO_WORLD);
      const unlit = loaded.draws.map((draw) => draw.drawOrder);
      loaded.see(above, VISIBLE, OPEN_AREAS, [lamp()]);
      loaded.animate(0, NO_WORLD);
      // Each lit batch takes the key's last bit, the glass's too, though it takes no pass.
      expect(loaded.draws.map((draw, i) => draw.drawOrder - unlit[i])).toEqual(
        new Array(5).fill(2 ** 16)
      );
      const [wallPass, floorPass] = loaded.lightPasses;
      expect(loaded.lightPasses).toHaveLength(2);
      expect(drawnWithPasses(loaded)).toEqual([
        wallMap,
        wallTexture,
        wallPass,
        floorMap,
        floorTexture,
        floorPass,
        glass,
        ...loaded.ramp
      ]);
      // `GL_DST_COLOR GL_ONE`, at the stages' depths, over the batch's own vertexes.
      const pass = material(wallPass);
      expect([pass.blendState.colorSrcFactor, pass.blendState.colorDstFactor]).toEqual([
        BLENDMODE_DST_COLOR,
        BLENDMODE_ONE
      ]);
      expect([pass.depthFunc, pass.depthWrite]).toEqual([FUNC_EQUAL, false]);
      expect(wallPass.mesh!.vertexBuffer).toBe(wallMap.mesh!.vertexBuffer);
      expect(wallPass.node).toBe(wallMap.node);
      expect(indexes(wallPass)).toEqual(indexes(wallMap));
      // The light as the pass's vertexes read it: in the batch's frame, its colour × 255 and 1/r.
      expect(uniform(wallPass, 'q3_dlight[0]')).toEqual([
        7,
        14,
        21,
        100,
        255,
        255,
        255,
        Math.fround(1 / 100)
      ]);
      // Gone with the light: the batches unlit and keyed so again.
      loaded.see(above, VISIBLE, OPEN_AREAS);
      loaded.animate(0, NO_WORLD);
      expect(loaded.lightPasses).toEqual([]);
      expect(loaded.draws.map((draw) => draw.drawOrder)).toEqual(unlit);
      expect(wallPass.visible).toBe(false);
    });

    it('draws the triangles a light reaches, and no pass where it reaches none', async () => {
      const loaded = await load();
      // Level with the floor's plane, and every point past the image's edge to one side.
      const aside = { origin: { x: 200, y: 0, z: 18 }, radius: 50, color: [1, 1, 1] as const };
      loaded.see(above, VISIBLE, OPEN_AREAS, [{ ...aside, additive: false }]);
      loaded.animate(0, NO_WORLD);
      expect(loaded.lightPasses).toEqual([]);
      // Still lit in its key, as its plane is within reach, and each batch projected.
      expect(loaded.dlightSpeeds()).toEqual({ surfaces: 3, culled: 0, vertexes: 6, triangles: 0 });
    });

    it("counts r_speeds 4's line, and the passes' triangles as r_speeds 1's passes", async () => {
      const loaded = await load();
      loaded.see(above, VISIBLE, OPEN_AREAS, [lamp(), lamp()]);
      loaded.animate(0, NO_WORLD);
      // Three surfaces lit by both, the wall's and the floor's batches drawn again for each.
      expect(loaded.dlightSpeeds()).toEqual({ surfaces: 3, culled: 0, vertexes: 12, triangles: 4 });
      expect(loaded.speeds().passTriangles).toBe(5 + 4);
      expect(loaded.lightPasses).toHaveLength(4);
    });

    it('re-keys its passes with the draws, as a shader sorted in moves their places', async () => {
      const scripts = `${SCRIPTS} textures/s/early { sort portal { map g.tga } }`;
      const loaded = await load({ scripts: parseShaderScripts([scripts]) });
      const [wallMap, wallTexture, floorMap] = loaded.draws;
      loaded.see(above, VISIBLE, OPEN_AREAS, [lamp()]);
      loaded.animate(0, NO_WORLD);
      const [wallPass] = loaded.lightPasses;
      const before = wallPass.drawOrder;
      // Sorted before every shader of the world's, it moves each one's place on.
      loaded.registry.register('textures/s/early', LIGHTMAP_2D, true);
      loaded.key();
      expect(wallPass.drawOrder).not.toBe(before);
      expect(keyedInOrder([wallMap, wallTexture, wallPass, floorMap])).toBe(true);
    });

    it('blends an additive light GL_ONE GL_ONE, which baseq3 never makes', async () => {
      const loaded = await load();
      loaded.see(above, VISIBLE, OPEN_AREAS, [lamp(true)]);
      loaded.animate(0, NO_WORLD);
      const { blendState } = material(loaded.lightPasses[0]);
      expect([blendState.colorSrcFactor, blendState.colorDstFactor]).toEqual([
        BLENDMODE_ONE,
        BLENDMODE_ONE
      ]);
    });

    it('takes no pass for a shader that is nodlight or a sky by its script', async () => {
      const scripts = `${SCRIPTS}
        textures/s/wall { surfaceparm nodlight { map $lightmap } { map g.tga blendFunc filter } }
        textures/s/floor { surfaceparm sky { map $lightmap } { map g.tga blendFunc filter } }`;
      const loaded = await load({ scripts: parseShaderScripts([scripts]) });
      loaded.see(above, VISIBLE, OPEN_AREAS, [lamp()]);
      loaded.animate(0, NO_WORLD);
      expect(loaded.lightPasses).toEqual([]);
      expect(loaded.dlightSpeeds().vertexes).toBe(0);
    });

    it("warms each pass's material with the rest, and hides it after", async () => {
      const loaded = await load();
      const seen: number[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
      });
      warmUp(app, [loaded.warm()]);
      draw.mockRestore();
      // The wall's and the floor's shaders cull alike: one material for both.
      const warmed = loaded.layer.meshInstances.filter(
        (instance) =>
          !loaded.draws.includes(instance) &&
          !loaded.spare.includes(instance) &&
          !loaded.ramp.includes(instance)
      );
      expect(warmed).toHaveLength(1);
      expect(seen).toContain(warmed[0].id);
      expect(warmed[0].visible).toBe(false);
    });

    it("keys the warm-up's pass with the draws, as the scene sorts each frame", async () => {
      const scripts = `${SCRIPTS} textures/s/early { sort portal { map g.tga } }`;
      const loaded = await load({ scripts: parseShaderScripts([scripts]) });
      const [wallMap, wallTexture, floorMap] = loaded.draws;
      loaded.warm().at(0);
      const [pass] = loaded.lightPasses;
      loaded.registry.register('textures/s/early', LIGHTMAP_2D, true);
      loaded.key();
      // Over the wall's batch, lit by its first light.
      expect(keyedInOrder([wallMap, wallTexture, pass, floorMap])).toBe(true);
    });
  });

  it("draws a run's surfaces in the order the view's walk added them", async () => {
    // Leaf 0, before the plane z = 0, is cluster 1 and holds the second wall; leaf 1, behind it,
    // is cluster 0 and holds both. Cluster 0 sees itself alone; cluster 1 sees both. Each box
    // holds the eye, so the frustum culls none of them.
    const wide: Pick<BspLeaf, 'mins' | 'maxs'> = {
      mins: [-100, -100, -100],
      maxs: [100, 100, 100]
    };
    const bsp = testBsp({
      shaders: ['textures/s/wall'],
      surfaces: surfaces(0, 0),
      // Under both eyes, so neither face is culled by its plane.
      xyz: [0, 0, -50, 1, 0, -50, 0, 1, -50, 0, 0, -50, 1, 0, -50, 0, 1, -50],
      nodes: [{ ...node(-1, -2), ...wide }],
      leafs: [
        { ...leaf(0, 1), cluster: 1, ...wide },
        { ...leaf(1, 2), cluster: 0, ...wide }
      ],
      leafSurfaces: [1, 0, 1],
      visibility: { numClusters: 2, clusterBytes: 1, data: Uint8Array.from([0b01, 0b11]) },
      lightmaps: 1
    });
    const loaded = await load({ bsp });
    const [{ mesh }] = loaded.draws;
    const drawn = () => {
      const [{ base, count }] = mesh!.primitive;
      return [...new Uint32Array(mesh!.indexBuffer[0].storage as ArrayBuffer, base * 4, count)];
    };
    // As the whole tree draws them: the second wall at the first leaf.
    expect(drawn()).toEqual([3, 4, 5, 0, 1, 2]);
    // From cluster 0, the first leaf is not marked, and the second adds them in its own order.
    const at = (z: number) => ({ origin: { x: 0, y: 0, z }, angles: { x: 0, y: 0, z: 0 } });
    loaded.see(at(-10), VISIBLE, OPEN_AREAS);
    expect(drawn()).toEqual([0, 1, 2, 3, 4, 5]);
    loaded.see(at(10), VISIBLE, OPEN_AREAS);
    expect(drawn()).toEqual([3, 4, 5, 0, 1, 2]);
  });

  it("takes a stage's vertex colours where it reads them, and plays its tcMods at 0", async () => {
    const loaded = await load({
      bsp: testBsp({ shaders: ['textures/s/lamp'] }),
      scripts: parseShaderScripts([
        `textures/s/lamp {
          { map g.tga rgbGen vertex }
          { map g.tga blendFunc blend alphaGen vertex tcMod scale 2 3
            }
        }`
      ])
    });
    const [lit, scaled] = loaded.draws.map(material);
    expect(lit.emissiveVertexColor).toBe(true);
    // Decoded once interpolated, in its own emission, as opengl1 interpolates the bytes.
    expect((lit as StandardMaterial & { vertexColorGamma: boolean }).vertexColorGamma).toBe(false);
    expect(lit.getShaderChunks(SHADERLANGUAGE_GLSL).get('emissivePS')).toBe(VERTEX_COLOR_EMISSION.glsl);
    expect(lit.getShaderChunks(SHADERLANGUAGE_WGSL).get('emissivePS')).toBe(VERTEX_COLOR_EMISSION.wgsl);
    expect(scaled.emissiveVertexColor).toBe(false);
    expect(scaled.getShaderChunks(SHADERLANGUAGE_GLSL).has('emissivePS')).toBe(false);
    expect([scaled.opacityVertexColor, scaled.opacityVertexColorChannel]).toEqual([true, 'a']);
    // Its scale in the port's own uniform, standing still, the engine's tiling left alone.
    expect([...(held(loaded.draws[1], 'q3_tc0[0]') as Float32Array).subarray(4, 12)]).toEqual([
      2, 0, 0, 0, 0, 3, 0, 0
    ]);
    expect([scaled.emissiveMapTiling.x, scaled.emissiveMapTiling.y]).toEqual([1, 1]);
  });

  it('sets each stage at the time it is given: its animMap frame, tcMods and waves', async () => {
    const loaded = await load({
      bsp: testBsp({ shaders: ['textures/s/clock'] }),
      scripts: parseShaderScripts([
        `textures/s/clock {
          { animMap 2 f/a.tga f/b.tga f/c.tga
            }
          { map g.tga blendFunc add tcMod scroll 0.5 0
            }
          { map g.tga blendFunc add rgbGen wave sin 0.5 1 0.25 1 }
        }`
      ]),
      fs: searchPath({ ...IMAGES, 'f/a.tga': tga(), 'f/b.tga': tga(), 'f/c.tga': tga() }),
      time: 1250
    });
    const [flipbook, , waved] = loaded.draws.map(material);
    // Two frames a second, so the third at 1.25 s.
    expect(flipbook.emissiveMap!.name).toBe('f/c.tga');
    expect((held(loaded.draws[1], 'q3_tc0[0]') as Float32Array)[6]).toBeCloseTo(0.625, 6);
    // A turn and a half from the peak it starts at: the table's step just past the half, a
    // little under the wave's base, halved, 63.4 of 255.
    expect(waved.emissive.r).toBe(63 / 255);
  });

  describe("cgame's polys", () => {
    const above = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };

    /** A world in a scene, its marks' shader registered as cgame's is, and its stages made. */
    async function marked() {
      const scene = testScene();
      const loaded = await load({ scene, scripts: parseShaderScripts([SCRIPTS + MARK]) });
      scene.shaders.bind(loaded.registry);
      const handle = scene.shaders.handle('textures/s/mark', LIGHTMAP_2D);
      await loaded.preparePolys([handle]);
      return { loaded, handle };
    }

    it("draws a frame's polys as the world's, after the opaque and before the glass", async () => {
      const { loaded, handle } = await marked();
      loaded.see(above, VISIBLE, OPEN_AREAS);
      const unmarked = loaded.speeds();
      loaded.drawPolys(triangle(handle));
      loaded.animate(0, NO_WORLD);
      // As the scene keys a frame, the mark having sorted in among the world's shaders.
      loaded.key();
      const [wallMap, wallTexture, floorMap, floorTexture, glass] = loaded.draws;
      const [mark] = loaded.polyDraws;
      expect(loaded.polyDraws).toHaveLength(1);
      expect(keyedInOrder([wallMap, wallTexture, floorMap, floorTexture, mark, glass])).toBe(true);
      // Pulled towards the eye by `r_offsetFactor` and `r_offsetUnits`, as `polygonOffset` pulls.
      expect([material(mark).slopeDepthBias, material(mark).depthBias]).toEqual([-1, -2]);
      expect(mark.node).toBe(loaded.root);
      // Counted as `r_speeds 1` counts any batch: one more, of one surface, its fan's triangle.
      expect(loaded.speeds()).toEqual({
        ...unmarked,
        shaders: unmarked.shaders + 1,
        surfaces: unmarked.surfaces + 1,
        vertexes: unmarked.vertexes + 3,
        triangles: unmarked.triangles + 1,
        passTriangles: unmarked.passTriangles + 1
      });
      // The next frame's has none.
      loaded.drawPolys(new ScenePolys<SortedShader>(() => {}));
      expect([loaded.polyDraws, mark.visible]).toEqual([[], false]);
    });

    it('keys its polys again with the world, as a shader sorted in moves them', async () => {
      const { loaded, handle } = await marked();
      loaded.see(above, VISIBLE, OPEN_AREAS);
      loaded.drawPolys(triangle(handle));
      loaded.key();
      const [mark] = loaded.polyDraws;
      const before = mark.drawOrder;
      loaded.registry.register('textures/s/lit', LIGHTMAP_2D, true);
      loaded.key();
      expect(mark.drawOrder).toBeGreaterThan(before);
      expect(keyedInOrder([loaded.draws[3], mark, loaded.draws[4]])).toBe(true);
    });

    it("plays a poly's moving stages while a poly draws them", async () => {
      const scene = testScene();
      const loaded = await load({ scene, scripts: parseShaderScripts([SCRIPTS + MARK + GLOW]) });
      scene.shaders.bind(loaded.registry);
      const glow = scene.shaders.handle('textures/s/glow', LIGHTMAP_2D);
      await loaded.preparePolys([glow]);
      loaded.drawPolys(triangle(glow));
      loaded.animate(1000, NO_WORLD);
      const coordinates = held(loaded.polyDraws[0], 'q3_tc0[0]') as Float32Array;
      expect(coordinates[6]).toBeCloseTo(0.5, 6);
      // Held while no poly draws it, and on with the clock once one does.
      loaded.drawPolys(new ScenePolys<SortedShader>(() => {}));
      loaded.animate(1250, NO_WORLD);
      expect(coordinates[6]).toBeCloseTo(0.5, 6);
      loaded.drawPolys(triangle(glow));
      loaded.animate(1500, NO_WORLD);
      expect(coordinates[6]).toBeCloseTo(0.75, 6);
    });

    it("makes a shader's stages anew where a registry started over places it afresh", async () => {
      const scene = testScene();
      const loaded = await load({ scene, scripts: parseShaderScripts([SCRIPTS + MARK + GLOW]) });
      scene.shaders.bind(loaded.registry);
      const mark = scene.shaders.handle('textures/s/mark', LIGHTMAP_2D);
      const glow = scene.shaders.handle('textures/s/glow', LIGHTMAP_2D);
      await loaded.preparePolys([mark]);
      const markIndex = mark.shader!.index;
      // A gamestate on the map in hand: the registry as the load left it, and cgame's registered
      // again, the glow first, in the place the mark had.
      loaded.unswap();
      scene.shaders.bind(loaded.registry);
      await loaded.preparePolys([glow, mark]);
      expect(glow.shader!.index).toBe(markIndex);
      loaded.see(above, VISIBLE, OPEN_AREAS);
      loaded.drawPolys(triangle(glow));
      loaded.animate(1000, NO_WORLD);
      // The glow's own stage, adding, and not the mark's; and played as the glow's.
      const [drawn] = loaded.polyDraws;
      expect(material(drawn).blendState.colorDstFactor).toBe(BLENDMODE_ONE);
      expect((held(drawn, 'q3_tc0[0]') as Float32Array)[6]).toBeCloseTo(0.5, 6);
    });

    it("warms each of the polys' stages with the world's, and hides them after", async () => {
      const { loaded } = await marked();
      const warmed = loaded.warm();
      warmed.at(0);
      const shownCounts = loaded.polyDraws.map((draw) => [
        draw.visible,
        draw.mesh!.primitive[0].count
      ]);
      expect(shownCounts).toEqual([[true, 3]]);
      warmed.end();
      expect(loaded.polyDraws).toEqual([]);
    });
  });

  describe('the moving stages', () => {
    const CLOCK = `
      textures/s/wall {
        { map textures/s/wall.tga rgbGen wave sin 0.5 1 0.25 1 tcMod scroll 0.5 0
        }
      }
      textures/s/floor {
        { animMap 2 f/a.tga f/b.tga f/c.tga
        }
      }
    `;
    const FLIPBOOK = { 'f/a.tga': tga(), 'f/b.tga': tga(), 'f/c.tga': tga() };

    /** The test map, its wall scrolling and pulsing and its floor flipping, with `scripts` first. */
    function clockMap(scripts = ''): Partial<BspWorldOptions> {
      return {
        scripts: parseShaderScripts([`${scripts} ${SCRIPTS} ${CLOCK}`]),
        fs: searchPath({ ...IMAGES, ...FLIPBOOK })
      };
    }

    /** A view down onto the map from `height`, its faces' planes at 0, 9, 18 and 27. */
    const above = (height: number) => ({
      origin: { x: 0, y: 0, z: height },
      angles: { x: 90, y: 0, z: 0 }
    });

    /** The first draw whose image this is, or begins so. */
    const drawOf = (loaded: BspWorld, image: string) =>
      loaded.draws.find((instance) => material(instance).emissiveMap?.name.startsWith(image))!;

    it("plays each drawn shader's stages on the clock, in place, and leaves one the view culls", async () => {
      const loaded = await load(clockMap());
      const wall = drawOf(loaded, 'textures/s/wall');
      const floor = drawOf(loaded, 'f/');
      const coordinates = held(wall, 'q3_tc0[0]') as Float32Array;
      // Every batch of the wall reads the one array, written in place.
      for (const instance of loaded.draws.filter((draw) => draw.material === wall.material)) {
        expect(held(instance, 'q3_tc0[0]')).toBe(coordinates);
      }
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(1250, NO_WORLD);
      expect(coordinates[6]).toBeCloseTo(0.625, 6);
      expect(material(wall).emissive.r).toBe(63 / 255);
      expect(material(floor).emissiveMap!.name).toBe('f/c.tga');
      // From 9 the floor is culled, and its flipbook stands while the wall plays on.
      loaded.see(above(9), VISIBLE, OPEN_AREAS);
      loaded.animate(500, NO_WORLD);
      expect(material(floor).emissiveMap!.name).toBe('f/c.tga');
      expect(coordinates[6]).toBeCloseTo(0.25, 6);
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(500, NO_WORLD);
      expect(material(floor).emissiveMap!.name).toBe('f/b.tga');
    });

    it('updates a material only where a wave changes its byte, never for a flip or a move', async () => {
      const loaded = await load(clockMap());
      const wall = material(drawOf(loaded, 'textures/s/wall'));
      const floor = material(drawOf(loaded, 'f/'));
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(1250, NO_WORLD);
      const walls = vi.spyOn(wall, 'update');
      const floors = vi.spyOn(floor, 'update');
      // The scroll moves and the wave's byte moves on; nothing flips.
      loaded.animate(1251, NO_WORLD);
      expect(walls).toHaveBeenCalledTimes(1);
      // The flipbook flips, and the wave moves on again.
      loaded.animate(1500, NO_WORLD);
      expect(floor.emissiveMap!.name).toBe('f/a.tga');
      expect(floors).not.toHaveBeenCalled();
      expect(walls).toHaveBeenCalledTimes(2);
      // Nothing changes.
      loaded.animate(1500, NO_WORLD);
      expect(walls).toHaveBeenCalledTimes(2);
    });

    it("sets a wave's alpha as Q3's byte, at the load and as it changes", async () => {
      const loaded = await load(
        clockMap('textures/s/wall { { map textures/s/wall.tga blendFunc blend alphaGen wave sawtooth 0 1 0 1 } }')
      );
      const wall = material(drawOf(loaded, 'textures/s/wall'));
      expect(wall.opacity).toBe(0);
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      // Half a period on: 127.5 of 255, truncated.
      loaded.animate(500, NO_WORLD);
      expect(wall.opacity).toBe(127 / 255);
    });

    it("drops the map at a shader's first draw where opengl1 drops it, naming it, and not before", async () => {
      const drawn = (await load(clockMap())).draws.length;
      await world!.destroy();
      world = undefined;
      for (const [script, message] of [
        [
          'textures/s/floor { { map g.tga blendFunc blend alphaGen wave noise 0.5 0.5 0 1 } }',
          "TableForFunc called with invalid function '6' in shader 'textures/s/floor'"
        ],
        // A blend whose line ends before its framebuffer factor.
        [
          `textures/s/floor { { map g.tga blendFunc gl_one
          } }`,
          'GL_State: invalid dst blend state bits'
        ]
      ]) {
        const loaded = await load(clockMap(script));
        // Its batch draws nothing, and the warm-up drops nothing.
        expect(loaded.draws).toHaveLength(drawn - 1);
        expect(() => warmUp(app, [loaded.warm()])).not.toThrow();
        loaded.see(above(9), VISIBLE, OPEN_AREAS);
        expect(() => loaded.animate(0, NO_WORLD)).not.toThrow();
        loaded.see(above(10), VISIBLE, OPEN_AREAS);
        expect(() => loaded.animate(0, NO_WORLD)).toThrow(new Error(message));
        await loaded.destroy();
        world = undefined;
      }
    });

    it('moves a turb in its place among the tcMods, through uniforms of its own', async () => {
      const loaded = await load(
        clockMap(`textures/s/wall {
          { map textures/s/wall.tga tcMod scale 2 2
            tcMod turb 0 0.25 0.5 1
            tcMod scroll 0 0.5
          }
        }`)
      );
      const wall = drawOf(loaded, 'textures/s/wall');
      const coordinates = held(wall, 'q3_tc0[0]') as Float32Array;
      // A turb after the scale, its phase now cut in two, then the scroll.
      expect([...coordinates.subarray(0, 24)]).toEqual([
        1, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0.25, 0.5, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0
      ]);
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(1750, NO_WORLD);
      expect([...coordinates.subarray(12, 24)]).toEqual([0.25, 0.25, 2, 0, 1, 0, 0, 0, 0, 1, 0.875, 0]);
      const own = material(wall);
      expect(['Q3_TC0', 'Q3_TC0_LIGHTMAP', 'Q3_TC1', 'Q3_SKY_POINTS'].map((name) => own.defines.get(name))).toEqual([
        true,
        undefined,
        undefined,
        undefined
      ]);
      expect([own.emissiveMapUv, own.diffuseMapUv]).toEqual([0, 1]);
      expect((own as StandardMaterial & { forceUv1: boolean }).forceUv1).toBe(true);
    });

    it.each(['glsl', 'wgsl'] as const)(
      "assembles a moving stage's coordinates after both of its attributes, in %s",
      async (language) => {
        if (language === 'wgsl') (app.graphicsDevice as unknown as { isWebGPU: boolean }).isWebGPU = true;
        const loaded = await load(
          clockMap(`textures/s/wall {
            { map textures/s/wall.tga tcMod turb 0 0.25 0.5 1
            }
            { map $lightmap blendFunc filter tcMod scroll 0.1 0
            }
          }`)
        );
        loaded.see(above(10), VISIBLE, OPEN_AREAS);
        rendered();
        const wall = drawOf(loaded, 'textures/s/wall');
        const variants = [...(material(wall) as unknown as { variants: Map<number, Shader> }).variants.values()];
        const vertex = variants[0].definition.vshader as string;
        const glsl = language === 'glsl';
        expectInOrder(vertex, [
          glsl ? 'attribute vec2 vertex_texCoord0;' : 'vertex_texCoord0',
          glsl ? 'attribute vec2 vertex_texCoord1;' : 'vertex_texCoord1',
          glsl ? 'float q3TurbStep(float sum, vec4 turb)' : 'fn q3TurbStep(sum: f32, turb: vec4f)',
          glsl ? 'vec2 q3Coordinates0(vec2 st, vec3 xyz)' : 'fn q3Coordinates0(given: vec2f, xyz: vec3f)',
          glsl ? 'vec2 getUv0()' : 'fn getUv0()',
          'st = q3Coordinates0(st, q3Position());',
          glsl ? 'vec2 uv0 = getUv0();' : 'getUv0()'
        ]);
        // A stage reading no second texture leaves its coordinates out.
        expect(vertex).not.toContain('q3Coordinates1');
        // The lightmap's texture reads the lightmap's coordinates, moved.
        const page = material(loaded.draws.find((draw) => material(draw).emissiveMap === loaded.lightmaps[0])!);
        expect(['Q3_TC0', 'Q3_TC0_LIGHTMAP'].map((name) => page.defines.has(name))).toEqual([true, true]);
      }
    );

    it("draws depthFunc equal at equal, and the vertex colours' inverses in its own vertex code", async () => {
      const loaded = await load(
        clockMap(`textures/s/wall {
          { map textures/s/wall.tga }
          { map g.tga blendFunc blend depthFunc equal rgbGen oneMinusVertex alphaGen oneMinusVertex }
        }`)
      );
      const [first, second] = loaded.draws.filter((instance) => instance.node === loaded.root).slice(0, 2).map(material);
      expect([first.depthFunc, second.depthFunc]).toEqual([FUNC_LESSEQUAL, FUNC_EQUAL]);
      expect([second.emissiveVertexColor, second.opacityVertexColor, second.opacityVertexColorChannel]).toEqual([
        true,
        true,
        'a'
      ]);
      expect((second as StandardMaterial & { vertexColorGamma: boolean }).vertexColorGamma).toBe(false);
      expect([second.defines.get('Q3_ONE_MINUS_VERTEX_RGB'), second.defines.get('Q3_ONE_MINUS_VERTEX_ALPHA')]).toEqual([
        true,
        true
      ]);
      expect(first.defines.has('Q3_ONE_MINUS_VERTEX_RGB')).toBe(false);
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      rendered();
      const variants = [...(second as unknown as { variants: Map<number, Shader> }).variants.values()];
      const { vshader, fshader } = variants[0].definition as { vshader: string; fshader: string };
      expectInOrder(vshader, [
        'vVertexColor = vertex_color;',
        'vVertexColor.rgb = 1.0 - vertex_color.rgb;',
        'vVertexColor.a = 1.0 - vertex_color.a;'
      ]);
      expect(vshader).not.toContain('gammaCorrectInput(vertex_color)');
      expect(fshader).toContain('dEmission *= pow(saturate(vVertexColor.rgb), vec3(2.2));');
    });

    it.each(['glsl', 'wgsl'] as const)(
      'decodes the vertex colours once interpolated, as opengl1 interpolates their bytes, in %s',
      async (language) => {
        if (language === 'wgsl') (app.graphicsDevice as unknown as { isWebGPU: boolean }).isWebGPU = true;
        const loaded = await load(
          clockMap(`textures/s/wall {
            { map textures/s/wall.tga rgbGen exactVertex }
          }`)
        );
        loaded.see(above(10), VISIBLE, OPEN_AREAS);
        rendered();
        const wall = drawOf(loaded, 'textures/s/wall');
        const variants = [...(material(wall) as unknown as { variants: Map<number, Shader> }).variants.values()];
        const { vshader, fshader } = variants[0].definition as { vshader: string; fshader: string };
        const glsl = language === 'glsl';
        expect(vshader).toContain(glsl ? 'vVertexColor = vertex_color;' : 'output.vVertexColor = vertex_color;');
        expect(vshader).not.toContain('gammaCorrectInput(vertex_color)');
        expect(fshader).toContain(
          glsl
            ? 'dEmission *= pow(saturate(vVertexColor.rgb), vec3(2.2));'
            : 'dEmission = dEmission * pow(saturate(vVertexColor.rgb), vec3f(2.2));'
        );
      }
    );

    it("binds each flipbook's frame only as it flips, a blended one's alpha with it", async () => {
      const loaded = await load({
        ...clockMap(`textures/s/floor {
          { blendFunc blend
            animMap 2 f/a.tga f/b.tga f/c.tga
          }
        }
        textures/s/wall {
          { map textures/s/wall.tga rgbGen identity }
          { blendFunc filter
            animMap 2 f/a.tga f/b.tga
          }
        }`),
        multitexture: true
      });
      const floor = material(drawOf(loaded, 'f/'));
      const wall = loaded.draws.map(material).find((own) => own.diffuseMap?.name.startsWith('f/'))!;
      const names = () => [floor.emissiveMap!.name, floor.opacityMap!.name, wall.diffuseMap!.name];
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(600, NO_WORLD);
      expect(names()).toEqual(['f/b.tga', 'f/b.tga', 'f/b.tga']);
      // Bound over, and left as it is while neither flips.
      const other = wall.emissiveMap!;
      [floor.emissiveMap, floor.opacityMap, wall.diffuseMap] = [other, other, other];
      loaded.animate(700, NO_WORLD);
      expect(names()).toEqual(Array(3).fill(other.name));
      loaded.animate(1100, NO_WORLD);
      expect(names()).toEqual(['f/c.tga', 'f/c.tga', 'f/a.tga']);
    });

    it('binds every frame of each flipbook in the warm-up, and the clock binds its own after', async () => {
      // The wall's flipbook as a merged stage's second texture, shorter than the floor's.
      const loaded = await load({
        ...clockMap(`textures/s/wall {
          { map textures/s/wall.tga rgbGen identity }
          { blendFunc filter
            animMap 2 f/a.tga f/b.tga
          }
        }`),
        multitexture: true
      });
      const floor = material(drawOf(loaded, 'f/'));
      const wall = loaded.draws.map(material).find((own) => own.diffuseMap?.name.startsWith('f/'))!;
      const bound: string[] = [];
      const render = app.render.bind(app);
      vi.spyOn(app, 'render').mockImplementation(() => {
        bound.push(`${floor.emissiveMap!.name} ${wall.diffuseMap!.name}`);
        render();
      });
      warmUp(app, [loaded.warm()]);
      vi.mocked(app.render).mockRestore();
      // Both moments in the first frame, then each of the floor's three, the wall's wrapping.
      expect(bound).toEqual([
        'f/a.tga f/a.tga',
        'f/a.tga f/a.tga',
        'f/a.tga f/a.tga',
        'f/b.tga f/b.tga',
        'f/c.tga f/a.tga'
      ]);
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(600, NO_WORLD);
      expect([floor.emissiveMap!.name, wall.diffuseMap!.name]).toEqual(['f/b.tga', 'f/b.tga']);
      loaded.animate(0, NO_WORLD);
      expect([floor.emissiveMap!.name, wall.diffuseMap!.name]).toEqual(['f/a.tga', 'f/a.tga']);
    });

    it("warms every moving stage up at the warm-up's moments, the first frame playing the clock", async () => {
      const loaded = await load(clockMap());
      const coordinates = held(drawOf(loaded, 'textures/s/wall'), 'q3_tc0[0]') as Float32Array;
      const floor = material(drawOf(loaded, 'f/'));
      warmUp(app, [loaded.warm()]);
      // Its second moment, 0.1234 s.
      expect(coordinates[6]).toBeCloseTo(0.0617, 6);
      loaded.see(above(10), VISIBLE, OPEN_AREAS);
      loaded.animate(0, NO_WORLD);
      expect([coordinates[6], floor.emissiveMap!.name]).toEqual([0, 'f/a.tga']);
    });
  });

  describe("the view's terms", () => {
    const TERMS = `
      textures/s/wall {
        { map textures/s/wall.tga
          tcGen environment
          tcMod scale 2 2
        }
        { map g.tga
          blendFunc GL_DST_COLOR GL_SRC_ALPHA
          alphaGen lightingSpecular
        }
      }
      textures/s/floor {
        { map textures/s/floor.tga
          blendFunc blend
          alphaGen portal 64
          tcGen vector ( 0.5 0 0 ) ( 0 0.25 0 )
        }
      }
    `;

    /** The test map in these shaders, which come first. */
    const termsMap = (scripts = TERMS): Partial<BspWorldOptions> => ({
      scripts: parseShaderScripts([`${scripts} ${SCRIPTS}`])
    });

    /** The first draw whose material has this define. */
    const drawWith = (loaded: BspWorld, define: string) =>
      loaded.draws.find((instance) => material(instance).defines.has(define))!;

    /** A view down onto the map. */
    const view = { origin: { x: 3, y: -4, z: 50 }, angles: { x: 90, y: 0, z: 0 } };

    it("works each out in the vertex code, from the eye in its draw's frame written at each view", async () => {
      const loaded = await load(termsMap());
      const environment = drawWith(loaded, 'Q3_TC0_ENVIRONMENT');
      const specular = drawWith(loaded, 'Q3_SPECULAR_ALPHA');
      const portal = drawWith(loaded, 'Q3_PORTAL_ALPHA');
      const glass = loaded.draws.find((instance) => material(instance).emissiveMap?.name === 'g.tga' && !material(instance).defines.has('Q3_SPECULAR_ALPHA'))!;
      // The environment's coordinates, then its tcMod.
      const coordinates = ['Q3_TC0', 'Q3_TC0_ENVIRONMENT', 'Q3_TC0_VECTOR', 'Q3_TC0_LIGHTMAP'];
      expect(coordinates.map((name) => material(environment).defines.get(name))).toEqual([true, true, undefined, undefined]);
      // tcGen vector's, from its vectors; the portal's range.
      expect(coordinates.map((name) => material(portal).defines.get(name))).toEqual([undefined, undefined, true, undefined]);
      expect([...(held(portal, 'q3_tcv0[0]') as Float32Array)]).toEqual([0.5, 0, 0, 0, 0, 0.25, 0, 0]);
      expect([...(held(portal, 'q3_portal') as Float32Array)]).toEqual([64, 0, 0, 0]);
      // The highlight and the portal's distance as the alpha the stage's opacity reads.
      for (const own of [specular, portal].map(material)) {
        expect([own.opacityVertexColor, own.opacityVertexColorChannel]).toEqual([true, 'a']);
      }
      // Each declares the view's terms before its coordinates.
      for (const own of [environment, specular, portal].map(material)) {
        expect(own.getShaderChunks(SHADERLANGUAGE_GLSL).get('litUserDeclarationVS')).toBe(VIEW_TERM_DECLARATIONS.glsl.world);
        expect(own.getShaderChunks(SHADERLANGUAGE_WGSL).get('litUserDeclarationVS')).toBe(VIEW_TERM_DECLARATIONS.wgsl.world);
      }
      // The world's draws read one eye; a stage that reads no view, none.
      const eye = held(environment, EYE_UNIFORM) as Float32Array;
      expect(held(specular, EYE_UNIFORM)).toBe(eye);
      expect(held(portal, EYE_UNIFORM)).toBe(eye);
      expect(held(glass, EYE_UNIFORM)).toBeUndefined();
      expect(material(glass).getShaderChunks(SHADERLANGUAGE_GLSL).has('litUserDeclarationVS')).toBe(false);
      loaded.see(view, VISIBLE, OPEN_AREAS);
      expect([...eye]).toEqual([3, -4, 50, 0, 3, -4, 50, 0]);
    });

    it.each(['glsl', 'wgsl'] as const)(
      "assembles the view's terms before the coordinates, and the alphas at the vertex shader's end, in %s",
      async (language) => {
        if (language === 'wgsl') (app.graphicsDevice as unknown as { isWebGPU: boolean }).isWebGPU = true;
        const loaded = await load(termsMap());
        loaded.see(view, VISIBLE, OPEN_AREAS);
        rendered();
        const vertex = (define: string) => {
          const own = material(drawWith(loaded, define)) as unknown as { variants: Map<number, Shader> };
          return [...own.variants.values()][0].definition.vshader as string;
        };
        const glsl = language === 'glsl';
        expectInOrder(vertex('Q3_TC0_ENVIRONMENT'), [
          glsl ? 'attribute vec3 vertex_normal;' : 'vertex_normal',
          glsl ? 'float q3Rsqrt(float number)' : 'fn q3Rsqrt(number: f32)',
          glsl ? 'vec2 getUv0()' : 'fn getUv0()',
          'st = q3Environment(q3Position(), q3Normal());',
          'st = q3Coordinates0(st, q3Position());',
          glsl ? 'vec2 uv0 = getUv0();' : 'getUv0()'
        ]);
        expectInOrder(vertex('Q3_SPECULAR_ALPHA'), [
          glsl ? 'float q3SpecularAlpha(vec3 xyz, vec3 normal)' : 'fn q3SpecularAlpha(xyz: vec3f, normal: vec3f)',
          glsl ? 'vec2 uv1 = getUv1();' : 'getUv1()',
          glsl ? 'vVertexColor = vertex_color;' : 'output.vVertexColor = vertex_color;',
          glsl ? 'vVertexColor.a = q3SpecularAlpha(q3Position(), q3Normal());' : 'output.vVertexColor.a = q3SpecularAlpha(q3Position(), q3Normal());'
        ]);
        expectInOrder(vertex('Q3_PORTAL_ALPHA'), [
          glsl ? 'float q3PortalAlpha(vec3 xyz)' : 'fn q3PortalAlpha(xyz: vec3f)',
          glsl ? 'vec2 getUv0()' : 'fn getUv0()',
          glsl ? 'vec2 st = vec2(dot(q3Position(), q3_tcv0[0].xyz)' : 'var st = vec2f(dot(q3Position(), uniform.q3_tcv0[0].xyz)',
          'q3PortalAlpha(q3Position());'
        ]);
      }
    );

    it.each(['glsl', 'wgsl'] as const)(
      "works a lightingDiffuse stage's colour out at each vertex from its normal and light, in %s",
      async (language) => {
        if (language === 'wgsl') {
          (app.graphicsDevice as unknown as { isWebGPU: boolean }).isWebGPU = true;
        }
        const scripts = `textures/s/wall { { map g.tga rgbGen lightingDiffuse } }`;
        const loaded = await load(termsMap(scripts));
        loaded.see(view, VISIBLE, OPEN_AREAS);
        rendered();
        const lit = material(drawWith(loaded, 'Q3_LIGHTING_DIFFUSE'));
        expect(lit.defines.get('Q3_LIGHTING_DIFFUSE')).toBe(true);
        expect([lit.emissiveVertexColor, lit.opacityVertexColor]).toEqual([true, true]);
        const own = lit as unknown as { variants: Map<number, Shader> };
        const glsl = language === 'glsl';
        expectInOrder([...own.variants.values()][0].definition.vshader as string, [
          glsl ? 'attribute vec3 vertex_normal;' : 'vertex_normal',
          glsl ? 'vec4 q3LightingDiffuse(vec3 normal)' : 'fn q3LightingDiffuse(normal: vec3f)',
          // Turned away, the ambient's byte and its alpha: the world entity's 0, an entity's 1.
          glsl ? '255.0 * q3_light[0].a' : '255.0 * uniform.q3_light[0].a',
          glsl
            ? 'vVertexColor = q3LightingDiffuse(q3Normal());'
            : 'output.vVertexColor = q3LightingDiffuse(q3Normal());'
        ]);
      }
    );

    it("gives a brush model's stages the eye in its own frame", async () => {
      const bsp = testBsp({
        shaders: ['textures/s/wall'],
        surfaces: surfaces(0, 0),
        models: [model(0, 1), model(1, 1)],
        entityString: `{ "classname" "worldspawn" }
          { "classname" "func_static" "model" "*1" "origin" "10 20 30" }`,
        lightmaps: 1
      });
      const loaded = await load({ bsp, ...termsMap() });
      const environments = loaded.draws.filter((instance) => material(instance).defines.has('Q3_TC0_ENVIRONMENT'));
      const own = environments.find((instance) => instance.node.name === '*1')!;
      const world = environments.find((instance) => instance.node === loaded.root)!;
      const [modelEye, worldEye] = [own, world].map((instance) => held(instance, EYE_UNIFORM) as Float32Array);
      expect(modelEye).not.toBe(worldEye);
      placeAtRest(loaded, bsp);
      const above = { origin: { x: 15, y: 25, z: 100 }, angles: { x: 90, y: 0, z: 0 } };
      loaded.see(above, VISIBLE, OPEN_AREAS);
      // In its frame, and in the world's for a portal.
      expect([...modelEye]).toEqual([5, 5, 70, 0, 15, 25, 100, 0]);
      expect([...worldEye]).toEqual([15, 25, 100, 0, 15, 25, 100, 0]);
    });

    it("writes each planar face's plane into the vertex buffer as its vertexes' normals", async () => {
      const plane: [number, number, number] = [0, 1, 0];
      const bsp = testBsp({
        shaders: ['textures/s/wall'],
        surfaces: [surface({ lightmapNum: 0, lightmapVecs: [[0, 0, 0], [0, 0, 0], plane] })],
        lightmaps: 1
      });
      bsp.drawVerts.normal.set([0, 0, 1, 0.6, 0, 0.8, 1, 0, 0]);
      const loaded = await load({ bsp });
      const vertices = loaded.draws[0].mesh!.vertexBuffer;
      const { offset } = vertices.format.elements.find(({ name }) => name === SEMANTIC_NORMAL)!;
      const { size } = vertices.format;
      const normals = [0, 1, 2].flatMap((i) => [...new Float32Array(vertices.storage as ArrayBuffer, i * size + offset, 3)]);
      expect(normals).toEqual([...plane, ...plane, ...plane]);
    });

    it("works a merged stage's second texture out from the view too", async () => {
      const loaded = await load({
        multitexture: true,
        ...termsMap(`textures/s/wall {
          { map textures/s/wall.tga
            rgbGen identity
          }
          { map g.tga
            blendFunc filter
            tcGen environment
          }
        }`)
      });
      const merged = drawWith(loaded, 'Q3_TC1_ENVIRONMENT');
      expect(material(merged).defines.has('Q3_TC0_ENVIRONMENT')).toBe(false);
      expect(material(merged).emissiveMap!.name).toBe('textures/s/wall.tga');
      expect(held(merged, EYE_UNIFORM)).toBeInstanceOf(Float32Array);
    });
  });

  describe('the deforms', () => {
    /** The wall moved up by 8, whatever the time. */
    const UP = `textures/s/wall {
      deformVertexes move 0 0 4 sin 2 0 0 0
      { map textures/s/wall.tga }
      { map $lightmap blendFunc filter }
    }`;

    /** The test map in these shaders, which come first. */
    const deformMap = (scripts = UP): Partial<BspWorldOptions> => ({
      scripts: parseShaderScripts([`${scripts} ${SCRIPTS}`])
    });

    /** Every surface seen, wherever the view looks. */
    const EVERYTHING = { ...VISIBLE, noCull: true };

    /** A view from above, looking along y. */
    const along = (yaw: number) => ({ origin: { x: 0, y: 0, z: 100 }, angles: { x: 0, y: yaw, z: 0 } });

    /** The points a draw draws, by its indexes, in order. */
    function drawn(instance: MeshInstance): number[][] {
      const mesh = instance.mesh!;
      const [{ base, count }] = mesh.primitive;
      const vertices = mesh.vertexBuffer;
      const floats = new Float32Array(vertices.storage as ArrayBuffer);
      const stride = vertices.format.size / 4;
      const indexes = new Uint32Array(mesh.indexBuffer[0].storage as ArrayBuffer, base * 4, count);
      return [...indexes].map((i) => [...floats.subarray(i * stride, i * stride + 3)]);
    }

    /** The draws of a shader's image. */
    const drawsOf = (loaded: BspWorld, image: string) =>
      loaded.draws.filter((instance) => material(instance).emissiveMap?.name === image);

    it("draws a deforming shader's batches from buffers of their own, deformed as the view draws them", async () => {
      const loaded = await load(deformMap());
      const [wall] = drawsOf(loaded, 'textures/s/wall.tga');
      const [floor] = drawsOf(loaded, 'textures/s/floor.tga');
      // Every stage of the wall's batch on one mesh, over buffers that are not the world's.
      expect(loaded.draws[1].mesh).toBe(wall.mesh);
      expect(wall.mesh!.vertexBuffer).not.toBe(floor.mesh!.vertexBuffer);
      // Nothing until a frame deforms it, and hidden till then, its buffers holding nothing to
      // draw. Then its two faces, each point up by 8 from (i, 2i, 3i).
      expect(wall.mesh!.primitive[0].count).toBe(0);
      expect(wall.visible).toBe(false);
      // `r_drawentities` toggled meanwhile shows it no sooner.
      loaded.showEntities(false);
      loaded.showEntities(true);
      expect(wall.visible).toBe(false);
      loaded.see(along(0), EVERYTHING, OPEN_AREAS);
      loaded.animate(1000, NO_WORLD);
      expect(wall.visible).toBe(true);
      expect(drawn(wall)).toEqual([3, 4, 5, 9, 10, 11].map((i) => [i, 2 * i, 3 * i + 8]));
      // The floor is drawn from the world's buffers, as it was.
      expect(drawn(floor)).toEqual([6, 7, 8].map((i) => [i, 2 * i, 3 * i]));
    });

    it('draws a fogged batch, its stages and its fog pass, from the same deformed vertexes', async () => {
      const bsp = testBsp({
        shaders: ['textures/s/wall', 'textures/f/grey'],
        surfaces: [surface({ fogNum: 0, lightmapNum: 0 })],
        lightmaps: 1,
        ...fogParts([{ mins: [-64, -64, -64], maxs: [64, 64, 0], shader: 'textures/f/grey' }])
      });
      const loaded = await load({
        bsp,
        ...deformMap(`${UP} textures/f/grey { surfaceparm fog fogparms ( 0.5 0.25 1 ) 512 }`)
      });
      const { draws } = loaded;
      expect(draws).toHaveLength(3);
      expect(material(draws[2]).opacityMap).toBe(loaded.fogImage);
      expect(new Set(draws.map((instance) => instance.mesh)).size).toBe(1);
      loaded.see(along(0), EVERYTHING, OPEN_AREAS);
      loaded.animate(0, NO_WORLD);
      expect(drawn(draws[2])).toEqual([0, 1, 2].map((i) => [i, 2 * i, 3 * i + 8]));
    });

    it("draws a light's pass over a deformed batch's vertexes, before its fog's", async () => {
      const bsp = testBsp({
        shaders: ['textures/s/wall', 'textures/f/grey'],
        surfaces: [surface({ fogNum: 0, lightmapNum: 0 })],
        lightmaps: 1,
        ...fogParts([{ mins: [-64, -64, -64], maxs: [64, 64, 0], shader: 'textures/f/grey' }])
      });
      const loaded = await load({
        bsp,
        ...deformMap(`${UP} textures/f/grey { surfaceparm fog fogparms ( 0.5 0.25 1 ) 512 }`)
      });
      const light = { origin: { x: 1, y: 2, z: 11 }, radius: 100, color: [1, 1, 1] as const };
      loaded.see(along(0), EVERYTHING, OPEN_AREAS, [{ ...light, additive: false }]);
      loaded.animate(0, NO_WORLD);
      const [pass] = loaded.lightPasses;
      const [first, second, fogPass] = loaded.draws;
      expect(pass.mesh!.vertexBuffer).toBe(first.mesh!.vertexBuffer);
      expect(drawn(pass)).toEqual([0, 1, 2].map((i) => [i, 2 * i, 3 * i + 8]));
      expect(keyedInOrder([first, second, pass, fogPass])).toBe(true);
      // Its vertexes as the deform left the tessellator.
      expect(loaded.dlightSpeeds().vertexes).toBe(3);
    });

    it("turns autosprite's squares to the view's axes, and keeps the counts r_speeds prints", async () => {
      const loaded = await load(
        deformMap(`textures/s/wall {
          deformVertexes autosprite
          { map textures/s/wall.tga }
          { map $lightmap blendFunc filter }
        }`)
      );
      const [wall] = drawsOf(loaded, 'textures/s/wall.tga');
      // Looking along x the squares stand across y and z; along y, across x and z.
      for (const [yaw, still] of [
        [0, 0],
        [90, 1]
      ]) {
        loaded.see(along(yaw), EVERYTHING, OPEN_AREAS);
        loaded.animate(0, NO_WORLD);
        const [first, second] = [0, 1].map((square) => drawn(wall).slice(square * 6, square * 6 + 6));
        for (const square of [first, second]) {
          const across = square.map((point) => point[still]);
          expect(across.every((value) => Math.abs(value - across[0]) < 1e-4)).toBe(true);
        }
      }
      // Its six points stamped as two squares of four, twelve indexes; Q3 counts the faces'.
      expect(wall.mesh!.primitive[0].count).toBe(12);
      const speeds = loaded.speeds();
      expect([speeds.vertexes, speeds.triangles]).toEqual([12, 4]);
    });

    it("turns a brush model's squares to the view in its own frame", async () => {
      // Two whole quads standing in y = 0, ten units a side.
      const quad = (i: number) =>
        surface({ firstVert: 4 * i, numVerts: 4, firstIndex: 6 * i, numIndexes: 6, lightmapNum: 0 });
      const bsp = testBsp({
        shaders: ['textures/s/wall'],
        surfaces: [quad(0), quad(1)],
        xyz: [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, 20, 0, 0, 30, 0, 0, 30, 0, 10, 20, 0, 10],
        drawIndexes: [0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3],
        models: [model(0, 1), model(1, 1)],
        entityString: `{ "classname" "worldspawn" }
          { "classname" "func_pendulum" "model" "*1" "angles" "0 90 0" }`,
        lightmaps: 1
      });
      const loaded = await load({
        bsp,
        ...deformMap(`textures/s/wall {
          deformVertexes autosprite
          { map textures/s/wall.tga }
          { map $lightmap blendFunc filter }
        }`)
      });
      const [own, world] = drawsOf(loaded, 'textures/s/wall.tga');
      expect([own.node.name, world.node]).toEqual(['*1', loaded.root]);
      // Looking along x the view's left is y: across y in the world's frame, and across x in the
      // frame of a pendulum turned a quarter, which rests at its angles.
      placeAtRest(loaded, bsp);
      loaded.see(along(0), EVERYTHING, OPEN_AREAS);
      loaded.animate(0, NO_WORLD);
      const across = (instance: MeshInstance, axis: number) => {
        const values = drawn(instance).map((point) => point[axis]);
        return values.every((value) => Math.abs(value - values[0]) < 1e-4);
      };
      expect([across(world, 0), across(world, 1)]).toEqual([true, false]);
      expect([across(own, 0), across(own, 1)]).toEqual([false, true]);
      // Swung back square, it is turned as the world is.
      loaded.placeModels([{ model: 1, origin: [0, 0, 0], angles: [0, 0, 0] }]);
      loaded.see(along(0), EVERYTHING, OPEN_AREAS);
      loaded.animate(0, NO_WORLD);
      expect([across(own, 0), across(own, 1)]).toEqual([true, false]);
    });

    it("casts a brush model's shadow from where it is placed, its light in its frame", async () => {
      const xyz = [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10];
      const quad = surface({ numVerts: 4, numIndexes: 6, lightmapNum: 0 });
      const bsp = testBsp({
        shaders: ['textures/s/wall'],
        surfaces: [quad, quad],
        xyz,
        drawIndexes: [0, 1, 2, 0, 2, 3],
        models: [model(0, 1), model(1, 1)],
        entityString: `{ "classname" "worldspawn" }
          { "classname" "func_static" "model" "*1" }`,
        lightmaps: 1
      });
      const shadow = `textures/s/wall {
        deformVertexes projectionShadow
        { map textures/s/wall.tga }
      }`;
      const loaded = await load({ bsp, ...deformMap(shadow) });
      const own = drawsOf(loaded, 'textures/s/wall.tga').find((draw) => draw.node.name === '*1')!;
      for (const angles of [
        [0, 0, 0],
        [0, 90, 0]
      ] as [number, number, number][]) {
        loaded.placeModels([{ model: 1, origin: [0, 0, 50], angles }]);
        loaded.see(along(0), EVERYTHING, OPEN_AREAS);
        loaded.animate(0, NO_WORLD);
        // `RB_ProjectionShadowDeform` on the quad, its entity where it was placed.
        const axis = anglesToAxes(angles[0], angles[1], angles[2], [
          new Float32Array(3),
          new Float32Array(3),
          new Float32Array(3)
        ]);
        // Lit as a scene with no grid lights it: the sun, in the model's frame.
        const framed = lightInEntityFrame(anglesToAxis(...angles), entityLight());
        const lightDir = Float32Array.from(framed.direction);
        const origin = [0, 0, 50];
        const entity: DeformEntity = { world: false, origin, axis, lightDir, shadowPlane: 0 };
        const tess = new Tess();
        tess.xyz.set(xyz);
        tess.numVertexes = 4;
        projectionShadow(tess, { entity } as Partial<DeformScene> as DeformScene);
        const cast = [0, 1, 2, 0, 2, 3].map((i) => [...tess.xyz.subarray(i * 3, i * 3 + 3)]);
        expect(drawn(own)).toEqual(cast);
      }
    });

    it('deforms nothing of a shader that drops the map, which draws nothing', async () => {
      const loaded = await load(
        deformMap(`textures/s/wall { deformVertexes wave 10 noise 0 1 0 1 { map textures/s/wall.tga } }`)
      );
      expect(drawsOf(loaded, 'textures/s/wall.tga')).toEqual([]);
      // Nothing drawn in play drops the map in the warm-up.
      const warmed = loaded.warm();
      warmed.at(0);
      warmed.end();
      loaded.see(along(0), EVERYTHING, OPEN_AREAS);
      expect(() => loaded.animate(0, NO_WORLD)).toThrow(
        "TableForFunc called with invalid function '6' in shader 'textures/s/wall'"
      );
    });

    it('warms the deformed draws up with every surface, and frees their buffers', async () => {
      const loaded = await load(deformMap());
      const [wall] = drawsOf(loaded, 'textures/s/wall.tga');
      expect(wall.visible).toBe(false);
      const warmed = loaded.warm();
      warmed.at(0);
      expect(wall.mesh!.primitive[0].count).toBe(6);
      warmed.end();
      // Deformed by the warm-up, it shows from then on, as the world's own batches do.
      expect(wall.visible).toBe(true);
      const freed = vi.spyOn(wall.mesh!.vertexBuffer, 'destroy');
      await loaded.destroy();
      world = undefined;
      expect(freed).toHaveBeenCalled();
    });
  });

  describe('the sky', () => {
    const SKY = `textures/s/sky {
      skyparms env/s 384 -
      { map g.tga tcMod scroll 0.1 0
        }
      { map g.tga blendFunc add }
    }`;
    const FACES = Object.fromEntries(
      ['rt', 'bk', 'lf', 'ft', 'up', 'dn'].map((suffix) => [`env/s_${suffix}.tga`, tga(4, 4)])
    );

    /** The sky's triangle overhead, between the wall's two, and the sky in this script. */
    function skyMap(
      script = SKY,
      files: Record<string, Uint8Array> = FACES,
      parts: Parameters<typeof testBsp>[0] = {}
    ): Partial<BspWorldOptions> {
      const bsp = testBsp({
        shaders: ['textures/s/wall', 'textures/s/sky'],
        surfaces: surfaces(0, 1, 0),
        lightmaps: 1,
        ...parts
      });
      bsp.drawVerts.xyz.set([-90, -90, 500, 90, -90, 500, 0, 90, 500], 9);
      return {
        bsp,
        scripts: parseShaderScripts([`${SCRIPTS} ${script}`]),
        fs: searchPath({ ...IMAGES, ...files })
      };
    }

    /** A view from under the triangle, which covers 2 by 2 blocks of the box's top from here. */
    const under = { origin: { x: 0, y: 0, z: 100 }, angles: { x: 0, y: 0, z: 0 } };

    /** The sky's draws, the box's six sides then the clouds' two stages, and the wall's. */
    function parts(loaded: BspWorld) {
      const { draws } = loaded;
      return { box: draws.slice(0, 6), clouds: draws.slice(6, 8), wall: draws.slice(8) };
    }

    /** Each draw's range of its index buffer. */
    const ranges = (draws: readonly MeshInstance[]) =>
      draws.map(({ mesh }) => [mesh!.primitive[0].base, mesh!.primitive[0].count]);

    /** A draw's indexes. */
    const indexes = ({ mesh }: MeshInstance) => {
      const [{ base, count }] = mesh!.primitive;
      return [...new Uint32Array(mesh!.indexBuffer[0].storage as ArrayBuffer, base * 4, count)];
    };

    it("draws a batch's box, side by side, then its clouds, in its run's place", async () => {
      const loaded = await load(skyMap());
      const { box, clouds, wall } = parts(loaded);
      expect(loaded.draws).toHaveLength(10);
      expect(keyedInOrder(loaded.draws)).toBe(true);
      // `sky_texorder`: the left face before the back.
      expect(box.map((instance) => material(instance).emissiveMap!.name)).toEqual([
        'env/s_rt.tga',
        'env/s_lf.tga',
        'env/s_bk.tga',
        'env/s_ft.tga',
        'env/s_up.tga',
        'env/s_dn.tga'
      ]);
      for (const side of box.map(material)) {
        const { emissive, emissiveMap, blendState } = side;
        // `tr.identityLight`, on the box's own coordinates.
        expect([emissive.r, emissive.g, emissive.b]).toEqual([0.5, 0.5, 0.5]);
        expect(side.emissiveMapUv).toBe(1);
        // `GL_State( 0 )`, front-sided.
        expect([blendState.colorSrcFactor, blendState.colorDstFactor]).toEqual([
          BLENDMODE_ONE,
          BLENDMODE_ZERO
        ]);
        expect([side.depthTest, side.depthWrite, side.cull]).toEqual([true, false, CULLFACE_FRONT]);
        expect([emissiveMap!.addressU, emissiveMap!.addressV, emissiveMap!.mipmaps]).toEqual([
          ADDRESS_CLAMP_TO_EDGE,
          ADDRESS_CLAMP_TO_EDGE,
          true
        ]);
      }
      // The clouds' stages are made as the world's are, on the clouds' coordinates.
      expect(clouds.map((instance) => material(instance).emissiveMapUv)).toEqual([0, 0]);
      expect(material(clouds[0]).emissiveMapOffset.x).toBe(0);
      expect(material(clouds[1]).blendState.colorDstFactor).toBe(BLENDMODE_ONE);
      // Every sky draw at the far plane, in both languages, and none of the world's.
      const atFar = (instance: MeshInstance) =>
        [SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL].map((language) =>
          material(instance).getShaderChunks(language).get('litUserMainEndVS')
        );
      for (const instance of [...box, ...clouds]) {
        const [glsl, wgsl] = atFar(instance);
        expect(glsl).toContain('gl_Position.z = gl_Position.w;');
        expect(wgsl).toContain('output.position.z = output.position.w;');
      }
      for (const instance of wall) expect(atFar(instance)).toEqual([undefined, undefined]);
      // In the one hand-ordered list, as every stage blends.
      expect(loaded.draws.every((instance) => instance.transparent)).toBe(true);

      // One buffer of every side's points, the clouds' coordinates and the box's beside them.
      const { mesh } = box[0];
      expect(clouds[0].mesh!.vertexBuffer).toBe(mesh!.vertexBuffer);
      const read = (get: (data: number[]) => void) => {
        const data: number[] = [];
        get(data);
        return data;
      };
      expect(read((data) => mesh!.getPositions(data))).toEqual([...skyPoints(1024)]);
      expect(read((data) => mesh!.getUvs(0, data))).toEqual([...cloudTexCoords(384)]);
      expect(read((data) => mesh!.getUvs(1, data))).toEqual([...boxTexCoords()]);
      // Its blocks are the view's, so the engine culls none of them.
      expect([...box, ...clouds].every((instance) => !instance.cull)).toBe(true);

      // Nothing is drawn before a view finds the blocks.
      expect(rendered()).toEqual([...wall, ...loaded.ramp]);
      loaded.drawSky(under, false);
      // The top alone, and the clouds over the same blocks.
      expect(rendered()).toEqual([box[4], ...clouds, ...wall, ...loaded.ramp]);
      expect(ranges([...box, ...clouds])).toEqual([
        [0, 0],
        [384, 0],
        [768, 0],
        [1152, 0],
        [1536, 24],
        [1920, 0],
        [2304, 24],
        [2304, 24]
      ]);
      // The top's first block, as its strip draws it, then as the clouds' quad.
      expect(indexes(box[4]).slice(0, 6)).toEqual([354, 363, 355, 355, 363, 364]);
      expect(indexes(clouds[0]).slice(0, 6)).toEqual([354, 363, 355, 363, 364, 355]);
      // About the eye, in the world's frame.
      expect(box[4].node.parent).toBe(loaded.root);
      expect(clouds[1].node).toBe(box[4].node);
      expect([...box[4].node.getLocalPosition().toArray()]).toEqual([0, 0, 100]);
    });

    it("gives a cloud stage's turb the sky's points as Q3 places them: the eye, and the far plane", async () => {
      const loaded = await load({ ...skyMap(), time: 2500 });
      const { clouds } = parts(loaded);
      const points = held(clouds[0], SKY_POINTS_UNIFORM) as Float32Array;
      expect(held(clouds[1], SKY_POINTS_UNIFORM)).toBe(points);
      expect(material(clouds[0]).defines.get('Q3_SKY_POINTS')).toBe(true);
      loaded.see(under, VISIBLE, OPEN_AREAS);
      loaded.drawSky(under, false);
      expect([...points]).toEqual([0, 0, 100, Math.fround(loaded.vis.zFar / 1024)]);
    });

    it("gives a cloud stage that reads the view the eye in the world's frame, and no normal", async () => {
      const loaded = await load(
        skyMap(`textures/s/sky {
          skyparms env/s 384 -
          { map g.tga
            tcGen environment
          }
        }`)
      );
      const cloud = loaded.draws.find((instance) => material(instance).defines.has('Q3_TC0_ENVIRONMENT'))!;
      expect(material(cloud).defines.get('Q3_SKY_POINTS')).toBe(true);
      expect(material(cloud).getShaderChunks(SHADERLANGUAGE_GLSL).get('litUserDeclarationVS')).toBe(
        VIEW_TERM_DECLARATIONS.glsl.sky
      );
      const eye = held(cloud, EYE_UNIFORM) as Float32Array;
      loaded.see(under, VISIBLE, OPEN_AREAS);
      expect([...eye]).toEqual([0, 0, 100, 0, 0, 0, 100, 0]);
    });

    it('sets its clouds at the time it is given', async () => {
      const { clouds } = parts(await load({ ...skyMap(), time: 2500 }));
      // `tcMod scroll 0.1 0`, 2.5 s on, its speed a float.
      const scroll = (held(clouds[0], 'q3_tc0[0]') as Float32Array)[6];
      expect(scroll).toBe(Math.fround(Math.fround(0.1) * 2.5));
    });

    it("draws the box at a window's tr.identityLight, and a box or clouds alone", async () => {
      const window = { renderer: 'opengl1', overBrightBits: 0 } as const;
      const boxAlone = skyMap('textures/s/sky { skyparms env/s - - }');
      let loaded = await load({ ...boxAlone, style: window });
      expect(loaded.draws).toHaveLength(8);
      const top = loaded.draws[4];
      expect(material(top).emissive.r).toBe(1);
      loaded.drawSky(under, false);
      expect(rendered()).toEqual([top, ...loaded.draws.slice(6), ...loaded.ramp]);
      await loaded.destroy();
      // With no `_rt` face, no box: the clouds alone, from their place after its sides'.
      loaded = await load(skyMap(SKY, {}));
      expect(loaded.draws).toHaveLength(4);
      expect(ranges(loaded.draws.slice(0, 2))).toEqual([
        [2304, 0],
        [2304, 0]
      ]);
      loaded.drawSky(under, false);
      expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
    });

    it('draws nothing under r_fastsky, and finds no blocks for it', async () => {
      const loaded = await load(skyMap());
      const { box, clouds, wall } = parts(loaded);
      const unlock = vi.spyOn(box[0].mesh!.indexBuffer[0], 'unlock');
      loaded.drawSky(under, true);
      expect(unlock).not.toHaveBeenCalled();
      expect(rendered()).toEqual([...wall, ...loaded.ramp]);
      loaded.drawSky(under, false);
      // The batch's box and clouds uploaded as one, from its first side to its clouds' end.
      expect(unlock.mock.calls).toEqual([[0, (2304 + 24) * 4]]);
      expect(rendered()).toEqual([box[4], ...clouds, ...wall, ...loaded.ramp]);
      loaded.drawSky(under, true);
      expect(rendered()).toEqual([...wall, ...loaded.ramp]);
      // The view holds, so nothing is written again.
      loaded.drawSky(under, false);
      expect(unlock).toHaveBeenCalledTimes(1);
      expect(rendered()).toEqual([box[4], ...clouds, ...wall, ...loaded.ramp]);
      // Nearer, the triangle covers all the top.
      loaded.drawSky({ ...under, origin: { x: 0, y: 0, z: 400 } }, false);
      expect(unlock.mock.calls[1]).toEqual([0, (2304 + 384) * 4]);
      expect(ranges([box[4], clouds[0]])).toEqual([
        [1536, 384],
        [2304, 384]
      ]);
      expect([...box[4].node.getLocalPosition().toArray()]).toEqual([0, 0, 400]);
    });

    it('warms up every sky draw over the whole box, and finds the blocks again after', async () => {
      const loaded = await load(skyMap());
      const { box, clouds, wall } = parts(loaded);
      loaded.drawSky(under, true);
      const seen: number[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
      });
      warmUp(app, [loaded.warm()]);
      draw.mockRestore();
      for (const instance of loaded.draws) {
        expect(seen.filter((id) => id === instance.id)).toHaveLength(2);
      }
      // Each side whole, and the clouds over all but the bottom.
      expect(ranges([...box, ...clouds])).toEqual([
        [0, 384],
        [384, 384],
        [768, 384],
        [1152, 384],
        [1536, 384],
        [1920, 384],
        [2304, 1920],
        [2304, 1920]
      ]);
      // Put back as `r_fastsky` has it, and found again from the same eye.
      expect(rendered()).toEqual([...wall, ...loaded.ramp]);
      loaded.drawSky(under, false);
      expect(rendered()).toEqual([box[4], ...clouds, ...wall, ...loaded.ramp]);
      expect(box[4].mesh!.primitive[0].count).toBe(24);
    });

    it("picmips the box's faces whatever the shader says, but not Q3's default image", async () => {
      const { 'env/s_dn.tga': _, ...faces } = FACES;
      const script = 'textures/s/sky { nopicmip skyparms env/s 512 - { map g.tga } }';
      const loaded = await load({ ...skyMap(script, faces), picmip: 1 });
      const sides = loaded.draws.slice(0, 6).map(material);
      expect(sides.map((side) => side.emissiveMap!.width)).toEqual([2, 2, 2, 2, 2, 16]);
      // The bottom's stand-in repeats, as Q3's default image does.
      expect(sides[5].emissiveMap!.addressU).toBe(ADDRESS_REPEAT);
      expect([...texels(sides[5].emissiveMap!)]).toEqual([...decodeTga(defaultImageTga()).pixels]);
      // The clouds' stage takes the shader's word.
      expect(material(loaded.draws[6]).emissiveMap!.width).toBe(2);
    });

    it('finds the blocks again of a sky run its curves cut again', async () => {
      const cut = vi.spyOn(SkyIndexes.prototype, 'cut');
      const loaded = await load({
        bsp: curveMap(),
        scripts: parseShaderScripts(['textures/s/wall { skyparms - 512 - { map g.tga } }'])
      });
      loaded.see(before(2000), VISIBLE, OPEN_AREAS);
      // The curve's run, the sky's second: the shader has no lightmap stage, so the face and the
      // curve, asking for it at page 0, each make it again at none (`R_FindShader`).
      expect(cut.mock.calls).toEqual([[1]]);
      cut.mockRestore();
    });

    it('narrows its blocks to the triangles a view sees', async () => {
      // A second sky triangle ahead, turned from the eye, which its plane culls; the first turned
      // to it. Each box holds the eye, so the frustum culls nothing.
      const wide: Pick<BspLeaf, 'mins' | 'maxs'> = {
        mins: [-1000, -1000, -1000],
        maxs: [1000, 1000, 1000]
      };
      const options = skyMap(SKY, FACES, {
        surfaces: surfaces(0, 1, 0, 1),
        nodes: [{ ...node(-1, -2), ...wide }],
        leafs: [{ ...leaf(0, 4), ...wide }, leaf(0, 0)]
      });
      const bsp = options.bsp!;
      bsp.drawVerts.xyz.set([500, -90, 10, 500, 90, 10, 500, 0, 190], 27);
      bsp.surfaces[1].lightmapVecs[2] = [0, 0, -1];
      bsp.surfaces[3].lightmapVecs[2] = [1, 0, 0];
      // Asked for at no page, both find the one registration, and so draw in one run.
      for (const sky of [1, 3]) bsp.surfaces[sky].lightmapNum = -1;
      const loaded = await load(options);
      const { box, clouds } = parts(loaded);
      // Each side's indexes, then the clouds'.
      const counts = () => [...box, clouds[0]].map(({ mesh }) => mesh!.primitive[0].count);
      // Before a view, both triangles: 2 by 2 blocks of the side ahead, and of the top.
      const both = [24, 0, 0, 0, 24, 0, 48];
      loaded.drawSky(under, false);
      expect(counts()).toEqual(both);
      loaded.see(under, VISIBLE, OPEN_AREAS);
      loaded.drawSky(under, false);
      expect(counts()).toEqual([0, 0, 0, 0, 24, 0, 24]);
      loaded.see(under, { ...VISIBLE, noCull: true }, OPEN_AREAS);
      loaded.drawSky(under, false);
      expect(counts()).toEqual(both);
    });

    it("hides a brush model's sky under r_drawentities 0", async () => {
      const entityString = `
        { "classname" "worldspawn" }
        { "classname" "func_static" "model" "*1" }
      `;
      const loaded = await load(
        skyMap(SKY, FACES, { models: [model(0, 1), model(1, 1)], entityString })
      );
      const { box, clouds, wall } = parts(loaded);
      loaded.drawSky(under, false);
      expect(rendered()).toEqual([box[4], ...clouds, ...wall, ...loaded.ramp]);
      loaded.showEntities(false);
      expect(rendered()).toEqual([...wall, ...loaded.ramp]);
      loaded.showEntities(true);
      expect(rendered()).toEqual([box[4], ...clouds, ...wall, ...loaded.ramp]);
    });

    it('frees none of the buffers its draws share when one is released', async () => {
      const loaded = await load(skyMap());
      const { box, wall } = parts(loaded);
      const buffers = app.graphicsDevice.buffers.size;
      // A side of the box, its mesh's one draw, and both of the wall's, which share theirs.
      for (const instance of [box[0], ...wall]) {
        loaded.layer.removeMeshInstances([instance], true);
        instance.destroy();
      }
      expect(app.graphicsDevice.buffers.size).toBe(buffers);
    });

    it('gives back its buffers and its faces', async () => {
      const buffers = app.graphicsDevice.buffers.size;
      const loaded = await load(skyMap());
      // The wall's texture, the clouds' and the six faces.
      expect(cache.size).toBe(8);
      await loaded.destroy();
      world = undefined;
      expect(cache.size).toBe(0);
      expect(app.graphicsDevice.buffers.size).toBe(buffers);
    });
  });

  describe('the light', () => {
    /** The lightmap pages and one vertex colour of a map, loaded at these bits. */
    async function light(mapOverBrightBits: number, overBrightBits: number) {
      const bsp = testBsp({ shaders: ['textures/s/wall'] });
      bsp.lightmaps = [lightmapPage([100, 50, 20, 200, 100, 0])];
      bsp.drawVerts.color.set([100, 50, 20, 77]);
      if (world) await world.destroy();
      const loaded = await load({
        bsp,
        mapOverBrightBits,
        style: { renderer: 'opengl1', overBrightBits }
      });
      const vertices = loaded.draws[0].mesh!.vertexBuffer;
      const { offset } = vertices.format.elements.find(({ name }) => name === SEMANTIC_COLOR)!;
      const color = [...new Uint8Array(vertices.storage as ArrayBuffer, offset, 4)];
      return { pages: loaded.lightmaps, color };
    }

    it('shifts each lightmap page by r_mapOverBrightBits less the overbright bits', async () => {
      const { pages } = await light(2, 1);
      expect([...texels(pages[0]).subarray(0, 8)]).toEqual([200, 100, 40, 255, 255, 127, 0, 255]);
      const atZero = await light(2, 0);
      expect([...texels(atZero.pages[0]).subarray(0, 4)]).toEqual([255, 127, 51, 255]);
      const atThree = await light(3, 1);
      expect([...texels(atThree.pages[0]).subarray(0, 4)]).toEqual([255, 127, 51, 255]);
    });

    it('makes them unmipped, filtered and clamped, one page counted as two', async () => {
      const { pages } = await light(2, 1);
      expect(pages.map((page) => page.name)).toEqual(['*lightmap0', '*lightmap1']);
      for (const page of pages) {
        expect([page.width, page.height, page.format]).toEqual([128, 128, PIXELFORMAT_RGBA8]);
        expect([page.mipmaps, page.minFilter, page.magFilter]).toEqual([
          false,
          FILTER_LINEAR,
          FILTER_LINEAR
        ]);
        expect([page.addressU, page.addressV]).toEqual([
          ADDRESS_CLAMP_TO_EDGE,
          ADDRESS_CLAMP_TO_EDGE
        ]);
      }
      expect([...texels(pages[1]).subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    });

    it('shifts the vertex colours into the vertex buffer, their alpha kept', async () => {
      expect((await light(2, 1)).color).toEqual([200, 100, 40, 77]);
      expect((await light(2, 0)).color).toEqual([255, 127, 51, 77]);
    });

    it("takes the overbright bits from the renderer's style by default", async () => {
      const bsp = testBsp({ shaders: ['textures/s/wall'] });
      bsp.lightmaps = [lightmapPage([100, 50, 20])];
      const loaded = await load({ bsp });
      // The port's default style, `r_overBrightBits 1`: a shift of 1.
      expect([...texels(loaded.lightmaps[0]).subarray(0, 4)]).toEqual([200, 100, 40, 255]);
    });
  });

  it("offsets each surface's indexes by its first vertex, the engine culling none", async () => {
    const loaded = await load();
    const indexes = new Uint32Array(loaded.draws[0].mesh!.indexBuffer[0].storage as ArrayBuffer);
    // The wall's surfaces 1 and 3, then the floor's 2, then the glass's 0.
    expect([...indexes]).toEqual([3, 4, 5, 9, 10, 11, 6, 7, 8, 0, 1, 2]);
    // What draws is what the view sees.
    expect(loaded.draws.every((instance) => !instance.cull)).toBe(true);
  });

  it("gives a surface whose shader fails Q3's default image: white lines on grey", async () => {
    const loaded = await load({ bsp: testBsp({ shaders: ['textures/s/missing'] }) });
    const [fallback] = loaded.draws.map(material);
    expect([fallback.emissiveMap?.width, fallback.emissiveMap?.height]).toEqual([16, 16]);
    const { pixels } = decodeTga(defaultImageTga());
    const at = (x: number, y: number) => [...pixels.subarray((y * 16 + x) * 4).subarray(0, 4)];
    expect([at(0, 0), at(15, 7), at(7, 15), at(1, 1), at(14, 14)]).toEqual([
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [32, 32, 32, 32],
      [32, 32, 32, 32]
    ]);
  });

  it('rounds a side down to a power of two, and halves all but nopicmip by r_picmip', async () => {
    const options = (picmip: number): Partial<BspWorldOptions> => ({
      bsp: testBsp({ shaders: ['textures/s/odd', 'textures/s/sharp'], surfaces: surfaces(0, 1) }),
      scripts: parseShaderScripts(['textures/s/sharp { nopicmip { map textures/s/odd.tga } }']),
      fs: searchPath({ 'textures/s/odd.tga': tga(6, 4) }),
      picmip
    });
    const sizes = (loaded: BspWorld) =>
      loaded.draws
        .map((instance) => material(instance).emissiveMap as Texture | null)
        .filter((texture): texture is Texture => texture !== null)
        .map((texture) => [texture.width, texture.height]);
    expect(sizes(await load(options(0)))).toEqual([
      [4, 4],
      [4, 4]
    ]);
    await world!.destroy();
    world = undefined;
    expect(sizes(await load(options(1)))).toEqual([
      [2, 2],
      [4, 4]
    ]);
  });

  it("culls as Q3's default does: a face is wound clockwise seen from its front", async () => {
    // Q3's faces wind clockwise seen from the side their normal faces, so the front PlayCanvas
    // keeps, counter-clockwise, is a face's back, and Q3's front-sided cull is PlayCanvas's front.
    const bsp = testBsp({ shaders: ['textures/s/wall'] });
    bsp.drawVerts.xyz.set([0, 0, 0, 0, 64, 0, 64, 0, 0]);
    bsp.drawVerts.normal.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const loaded = await load({ bsp });
    const transform = loaded.root.getWorldTransform();
    const [a, b, c] = [0, 1, 2].map((v) =>
      transform.transformPoint(new Vec3(...bsp.drawVerts.xyz.subarray(v * 3, v * 3 + 3)))
    );
    const normal = transform.transformVector(new Vec3(0, 0, 1)).normalize();
    const winding = new Vec3().cross(new Vec3().sub2(b, a), new Vec3().sub2(c, a));
    expect(winding.dot(normal)).toBeLessThan(0);
    expect(loaded.draws.map((instance) => material(instance).cull)).toEqual([CULLFACE_FRONT]);
  });

  it('sets the camera at r_znear and the far plane its view reached, and gives them back', async () => {
    const lens = camera.camera!;
    const before = [lens.nearClip, lens.farClip];
    const loaded = await load();
    // The test map's leafs are points at the origin, 50 units off and looked at.
    const view: FirstPersonView = {
      origin: { x: 30, y: 40, z: 0 },
      angles: { x: 0, y: (Math.atan2(-40, -30) * 180) / Math.PI, z: 0 }
    };
    loaded.see(view, { ...VISIBLE, zNear: 8 }, OPEN_AREAS);
    expect(lens.nearClip).toBe(0.25);
    expect(lens.farClip).toBeCloseTo(50 / 32, 6);
    await loaded.destroy();
    world = undefined;
    expect([lens.nearClip, lens.farClip]).toEqual(before);
  });

  it("finds a view's set through the camera's frustum, as wide as the canvas", async () => {
    const lens = camera.camera!;
    const loaded = await load();
    const { width, height } = app.graphicsDevice;
    expect(width).toBeGreaterThan(height);
    // Turned from the leafs by more than half the camera's angle up and less than half across.
    const up = lens.fov / 2;
    const across = (Math.atan(Math.tan((up * Math.PI) / 180) * (width / height)) * 180) / Math.PI;
    const facing = (Math.atan2(-40, -30) * 180) / Math.PI;
    const view: FirstPersonView = {
      origin: { x: 30, y: 40, z: 0 },
      angles: { x: 0, y: facing + (up + across) / 2, z: 0 }
    };
    loaded.see(view, { ...VISIBLE, zNear: 4 }, OPEN_AREAS);
    expect(loaded.vis.leafs).toBe(2);
    expect(lens.farClip).toBeCloseTo(50 / 32, 6);
  });

  it('or as wide as the aspect the camera was given, as under water', async () => {
    const lens = camera.camera!;
    const loaded = await load();
    const { width, height } = app.graphicsDevice;
    const up = lens.fov / 2;
    const across = (Math.atan(Math.tan((up * Math.PI) / 180) * (width / height)) * 180) / Math.PI;
    const facing = (Math.atan2(-40, -30) * 180) / Math.PI;
    const view: FirstPersonView = {
      origin: { x: 30, y: 40, z: 0 },
      angles: { x: 0, y: facing + (up + across) / 2, z: 0 }
    };
    lens.aspectRatioMode = ASPECT_MANUAL;
    try {
      // As narrow across as up and down: the leafs are out of it.
      lens.aspectRatio = 1;
      loaded.see(view, { ...VISIBLE, zNear: 4 }, OPEN_AREAS);
      expect(loaded.vis.leafs).toBe(0);
      lens.aspectRatio = width / height;
      loaded.see(view, { ...VISIBLE, zNear: 4 }, OPEN_AREAS);
      expect(loaded.vis.leafs).toBe(2);
    } finally {
      lens.aspectRatioMode = ASPECT_AUTO;
    }
  });

  it('adds the brush models placed to a view as r_drawentities has it', async () => {
    const bsp = testBsp({
      shaders: ['textures/s/wall'],
      surfaces: [surface(), surface()],
      models: [model(0, 1), model(1, 1)],
      entityString: '{ "classname" "worldspawn" }\n{ "classname" "func_static" "model" "*1" }'
    });
    const loaded = await load({ bsp });
    const view: FirstPersonView = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
    const settings = { ...VISIBLE, noCull: true, zNear: 4 };
    // None until the scene places it.
    loaded.see(view, settings, OPEN_AREAS);
    expect(loaded.vis.count).toBe(1);
    placeAtRest(loaded, bsp);
    loaded.see(view, settings, OPEN_AREAS);
    expect(loaded.vis.count).toBe(2);
    loaded.see(view, { ...settings, drawEntities: false }, OPEN_AREAS);
    expect(loaded.vis.count).toBe(1);
  });

  it('culls a brush model by its bounds where it is placed and turned', async () => {
    const bsp = testBsp({
      shaders: ['textures/s/wall'],
      surfaces: [surface(), surface()],
      models: [model(0, 1), { ...model(1, 1), mins: [900, -8, -8], maxs: [1000, 8, 8] }],
      entityString: '{ "classname" "worldspawn" }\n{ "classname" "func_static" "model" "*1" }'
    });
    const loaded = await load({ bsp });
    // At the origin looking along x, with the faces' own cull off.
    const view: FirstPersonView = { origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } };
    const added = (origin: [number, number, number], angles: [number, number, number]) => {
      loaded.placeModels([{ model: 1, origin, angles }]);
      loaded.see(view, { ...VISIBLE, facePlaneCull: false }, OPEN_AREAS);
      return loaded.vis.count - loaded.vis.worldCount;
    };
    expect(added([0, 0, 0], [0, 0, 0])).toBe(1);
    // Turned half round its origin, its box is behind the eye; and so it is placed there.
    expect(added([0, 0, 0], [0, 180, 0])).toBe(0);
    expect(added([-2000, 0, 0], [0, 0, 0])).toBe(0);
    // Turned half round from beyond, ahead again.
    expect(added([2000, 0, 0], [0, 180, 0])).toBe(1);
  });

  it("chooses a brush model's curve rows from where it is placed", async () => {
    const bsp = {
      ...curveMap(),
      models: [model(0, 2), model(2, 1)],
      entityString: '{ "classname" "worldspawn" }\n{ "classname" "func_static" "model" "*1" }'
    };
    // The model's curve the world's again, from its own points.
    const { xyz } = bsp.drawVerts;
    xyz.copyWithin(12 * 3, 3 * 3, 12 * 3);
    const loaded = await load({ bsp });
    const own = loaded.draws.find((instance) => instance.node.name === '*1')!;
    const indexes = () => own.mesh!.primitive[0].count;
    const settings = { ...VISIBLE, noCull: true };
    // 2000 off, a column goes, as the world's own curve's does.
    loaded.placeModels([{ model: 1, origin: [0, 0, 0], angles: [0, 0, 0] }]);
    loaded.see(before(2000), settings, OPEN_AREAS);
    expect(indexes()).toBe(6);
    // Placed beside the eye, the grid is whole.
    loaded.placeModels([{ model: 1, origin: [-1990, 0, 0], angles: [0, 0, 0] }]);
    loaded.see(before(2000), settings, OPEN_AREAS);
    expect(indexes()).toBe(12);
  });

  describe('fog', () => {
    const FOGS = `
      textures/s/twosided { cull none { map g.tga } }
      textures/f/grey { surfaceparm fog fogparms ( 0.5 0.25 1 ) 512
      }
      textures/f/hell { surfaceparm fog fogparms ( 1 0 0 ) 256
        { map g.tga blendFunc filter } }
      textures/s/sky { skyparms - 512 - { map g.tga } }
    `;
    const LUMP = [
      'textures/s/wall',
      'textures/s/twosided',
      'textures/f/grey',
      'textures/f/hell',
      'textures/s/glass',
      'textures/s/sky'
    ];
    /** Each surface's shader, by its place in the lump, and its fog, −1 for none. */
    const IN_FOGS = [
      [0, -1],
      [0, 0],
      [0, 1],
      [1, 0],
      // The grey fog's face, in its fog and out of it.
      [2, 0],
      [2, -1],
      [4, -1],
      [4, 0],
      [5, 0]
    ];
    /** The grey fog, its top at 0, and the hell fog beside it. */
    const VOLUMES = fogParts([
      { mins: [-64, -64, -64], maxs: [64, 64, 0], shader: 'textures/f/grey' },
      { mins: [100, 100, -64], maxs: [200, 200, 0], shader: 'textures/f/hell' }
    ]);

    function fogMap(): Partial<BspWorldOptions> {
      const bsp = testBsp({
        shaders: LUMP,
        // The glass asks with no page, so its two surfaces find one registration: asked at a page,
        // a shader with no `$lightmap` stage is kept at none, and the next asking makes another.
        surfaces: IN_FOGS.map(([shaderNum, fogNum], i) =>
          surface({
            shaderNum,
            fogNum,
            firstVert: 3 * i,
            firstIndex: 3 * i,
            lightmapNum: shaderNum === 4 ? -1 : 0
          })
        ),
        lightmaps: 1,
        ...VOLUMES
      });
      return { bsp, scripts: parseShaderScripts([`${SCRIPTS} ${FOGS}`]) };
    }

    /** The fogs as the world loads them, their depths as their shaders give them. */
    const fogs = (bsp: Bsp) =>
      loadFogs(bsp, (name) => ({
        fogParms: { color: [0, 0, 0], depthForOpaque: name === 'textures/f/grey' ? 512 : 256 }
      }));

    /** A fog's vectors for a view, as its draws hold them. */
    function vectors(fog: WorldFog, view: FirstPersonView, frame?: FogFrame): number[] {
      const { origin, angles } = view;
      const { forward } = angleVectors(angles);
      const eye: [number, number, number] = [origin.x, origin.y, origin.z];
      const along: [number, number, number] = [forward.x, forward.y, forward.z];
      const { distance, depth, eyeT } = fogVectors(fog, eye, along, frame);
      return [...distance, ...depth, eyeT, 0, 0, 0].map(Math.fround);
    }

    it('pulls a polygonOffset shader and its fog pass by r_offsetFactor and r_offsetUnits', async () => {
      const pulled = 'textures/s/wall { polygonOffset sort opaque { map g.tga } }';
      const loaded = await load({
        ...fogMap(),
        scripts: parseShaderScripts([`${pulled} ${SCRIPTS} ${FOGS}`]),
        offset: { factor: -1.5, units: -3 }
      });
      const materials = [...new Set(loaded.draws.map(material))];
      const isPass = (m: StandardMaterial) => m.opacityMap === loaded.fogImage;
      const biased = materials.filter((m) => m.depthBias !== 0);
      // The wall's stage, made again at each surface's asking, and its passes in the two fogs.
      expect(biased.filter((m) => !isPass(m))).toHaveLength(3);
      expect(biased.filter(isPass).map((m) => m.depthFunc)).toEqual([FUNC_EQUAL, FUNC_EQUAL]);
      expect(biased.map((m) => [m.slopeDepthBias, m.depthBias])).toEqual(new Array(5).fill([-1.5, -3]));
      // The two-sided wall's pass in the grey fog stays where it is.
      expect(materials.filter((m) => isPass(m) && m.depthFunc === FUNC_EQUAL && m.depthBias === 0)).toHaveLength(1);
      // Set again, as a frame reads them.
      loaded.offset({ factor: -1, units: -2 });
      expect(biased.map((m) => [m.slopeDepthBias, m.depthBias])).toEqual(new Array(5).fill([-1, -2]));
    });

    it("draws each fogged batch's pass after its stages, in its fog's colour", async () => {
      const loaded = await load(fogMap());
      const { draws } = loaded;
      // The sky's clouds; the wall out of a fog, then in each; the two-sided wall; the grey fog's
      // face in it; the glass out of it, then dimmed in it.
      expect(draws).toHaveLength(14);
      const passes = [5, 8, 10, 11].map((i) => material(draws[i]));
      // One for each fog, pass and cull.
      expect(new Set(passes).size).toBe(4);
      for (const pass of passes) expect(pass.opacityMap).toBe(loaded.fogImage);
      // Each on its batch's range; the face's, which has no stages, alone.
      for (const pass of [5, 8, 10]) expect(draws[pass].mesh, `${pass}`).toBe(draws[pass - 1].mesh);
      expect(draws[11].mesh).not.toBe(draws[10].mesh);
      // Each fog's colour at `tr.identityLight`, a byte a channel.
      const bytes = passes.map(({ emissive: { r, g, b } }) => [r, g, b].map((c) => c * 255));
      expect(bytes).toEqual([
        [63, 31, 127],
        [127, 0, 0],
        [63, 31, 127],
        [63, 31, 127]
      ]);
      expect(passes.map((pass) => pass.depthFunc)).toEqual([
        FUNC_EQUAL,
        FUNC_EQUAL,
        FUNC_EQUAL,
        FUNC_LESSEQUAL
      ]);
      expect(passes.map((pass) => pass.cull)).toEqual([
        CULLFACE_FRONT,
        CULLFACE_FRONT,
        CULLFACE_NONE,
        CULLFACE_FRONT
      ]);
      // The walls' stages are as they are out of a fog.
      expect([3, 4, 6, 7].map((i) => material(draws[i]))).toEqual(
        [1, 2, 1, 2].map((i) => material(draws[i]))
      );
      // The face out of its fog draws nothing, and the sky in it no pass.
      expect(rendered()).toEqual([...draws.slice(1), ...loaded.ramp]);
    });

    it("dims a blended stage by its fog instead, in a material made again for it", async () => {
      const { draws } = await load(fogMap());
      const [plain, dimmed] = [12, 13].map((i) => material(draws[i]));
      // One shader, its runs out of the fog and in it.
      expect(new Set([12, 13].map((i) => draws[i].mesh!.primitive[0].base)).size).toBe(2);
      expect(dimmed).not.toBe(plain);
      expect(dimmed.emissiveMap).toBe(plain.emissiveMap);
      const factors = ({ blendState: blend }: StandardMaterial) => [
        blend.colorSrcFactor,
        blend.colorDstFactor,
        blend.alphaSrcFactor,
        blend.alphaDstFactor
      ];
      expect(factors(dimmed)).toEqual(factors(plain));
      expect(dimmed.defines.get('Q3_FOG_RGB')).toBe(true);
      expect(dimmed.defines.has('Q3_FOG_ALPHA')).toBe(false);
      const ending = (stage: StandardMaterial) =>
        stage.getShaderChunks(SHADERLANGUAGE_WGSL).get('litUserMainEndPS');
      expect(ending(dimmed)).toBe(FOG_ADJUSTMENT_CHUNKS.wgsl.get('litUserMainEndPS'));
      expect(ending(plain)).toBeUndefined();
    });

    it("dims a fogged poly's blended stage by its fog, from the world's arrays", async () => {
      const scene = testScene();
      const scripts = parseShaderScripts([`${SCRIPTS} ${FOGS} ${MARK}`]);
      const loaded = await load({ ...fogMap(), scene, scripts });
      scene.shaders.bind(loaded.registry);
      const mark = scene.shaders.handle('textures/s/mark', LIGHTMAP_2D);
      await loaded.preparePolys([mark]);
      // One in the grey fog, at its top's corner, and one out of every fog.
      const polys = triangle(mark, 0);
      polys.inWorld(loaded.registry.fogs);
      const outside = triangle(mark, 1000);
      polys.add(mark, 3, outside.verts, 0);
      polys.fogs[0] = 1;
      loaded.drawPolys(polys);
      const [plain, dimmed] = loaded.polyDraws;
      expect(material(dimmed).defines.get('Q3_FOG_RGB')).toBe(true);
      expect(material(plain).defines.has('Q3_FOG_RGB')).toBe(false);
      // The world's own array for the grey fog, which its wall in it reads.
      expect(held(dimmed, FOG_UNIFORM)).toBe(held(loaded.draws[3], FOG_UNIFORM));
    });

    it("gives each fogged draw its fog's vectors, written at each view", async () => {
      const options = fogMap();
      const loaded = await load(options);
      const { draws } = loaded;
      const grey = held(draws[3], FOG_UNIFORM) as Float32Array;
      const hell = held(draws[6], FOG_UNIFORM) as Float32Array;
      expect(grey).not.toBe(hell);
      for (const i of [4, 5, 9, 10, 11, 13]) expect(held(draws[i], FOG_UNIFORM), `${i}`).toBe(grey);
      for (const i of [7, 8]) expect(held(draws[i], FOG_UNIFORM), `${i}`).toBe(hell);
      for (const i of [1, 2, 12]) expect(held(draws[i], FOG_UNIFORM), `${i}`).toBeUndefined();
      const [greyFog, hellFog] = fogs(options.bsp!);
      for (const z of [-30, 40]) {
        const view = { origin: { x: 0, y: 0, z }, angles: { x: 20, y: 45, z: 0 } };
        loaded.drawFog(view);
        expect([...grey]).toEqual(vectors(greyFog, view));
        expect([...hell]).toEqual(vectors(hellFog, view));
        // The eye under the faces' height, and over it.
        expect(Math.sign(grey[8])).toBe(z < 0 ? 1 : -1);
        // And so for the scene's models and effects, in the world's frame.
        expect([...loaded.fog.worldData(1)]).toEqual(vectors(greyFog, view));
        expect([...loaded.fog.worldData(2)]).toEqual(vectors(hellFog, view));
      }
    });

    it("takes its fogs into its scene, each pass's colour the world's pass's", async () => {
      const options = fogMap();
      const loaded = await load(options);
      const bounds = (fog: { bounds: unknown }) => fog.bounds;
      expect(loaded.fog.fogs.map(bounds)).toEqual(fogs(options.bsp!).map(bounds));
      // The grey fog's colour, as its world's pass draws it, made linear as an emissive is.
      const greyPass = material(loaded.draws[5]);
      const { r, g, b } = greyPass.emissive;
      expect([...loaded.fog.passColor(1)].map((c) => c ** (1 / 2.2))).toEqual(
        [r, g, b].map((c) => expect.closeTo(c, 6))
      );
    });

    it('fogs a merged stage by its pass, or dims it, as its first stage is fogged', async () => {
      const bsp = testBsp({
        shaders: ['textures/s/wall', 'textures/s/portal', 'textures/f/grey'],
        surfaces: [0, 1].map((shaderNum, i) =>
          surface({ shaderNum, fogNum: 0, firstVert: 3 * i, firstIndex: 3 * i, lightmapNum: 0 })
        ),
        lightmaps: 1,
        ...fogParts([{ mins: [-64, -64, -64], maxs: [64, 64, 0], shader: 'textures/f/grey' }])
      });
      const PORTAL = `textures/s/portal {
        { map g.tga blendFunc add rgbGen identity }
        { map g.tga blendFunc add rgbGen identity } }`;
      const loaded = await load({
        bsp,
        scripts: parseShaderScripts([`${SCRIPTS} ${FOGS} ${PORTAL}`]),
        multitexture: true,
        textureEnvAdd: true
      });
      // The wall's merged stage and its pass; the portal's, dimmed, with none.
      const { draws } = loaded;
      expect(draws).toHaveLength(3);
      const [wall, pass, portal] = draws.map(material);
      expect(wall.diffuseMap).toBe(loaded.lightmaps[0]);
      expect(pass.opacityMap).toBe(loaded.fogImage);
      expect(draws[1].mesh).toBe(draws[0].mesh);
      expect(wall.defines.has('Q3_FOG_RGB')).toBe(false);
      expect(portal.defines.get('Q3_FOG_RGB')).toBe(true);
      expect(portal.defines.get('Q3_MULTITEXTURE_ADD')).toBe(true);
      // Dimmed, then the second texture added.
      for (const language of ['glsl', 'wgsl'] as const) {
        const lang = language === 'glsl' ? SHADERLANGUAGE_GLSL : SHADERLANGUAGE_WGSL;
        expect(portal.getShaderChunks(lang).get('litUserMainEndPS'), language).toBe(
          FOG_ADJUSTMENT_CHUNKS[language].get('litUserMainEndPS')! +
            MULTITEXTURE_CHUNKS[language].get('litUserMainEndPS')!
        );
      }
    });

    it("works a brush model's fog out in its own frame", async () => {
      const bsp = testBsp({
        shaders: ['textures/s/wall', 'textures/f/grey'],
        surfaces: [0, 1].map((i) =>
          surface({ fogNum: 0, firstVert: 3 * i, firstIndex: 3 * i, lightmapNum: 0 })
        ),
        models: [model(0, 1), model(1, 1)],
        entityString: `{ "classname" "worldspawn" }
          { "classname" "func_static" "model" "*1" "origin" "10 20 30" }`,
        lightmaps: 1,
        ...fogParts([{ mins: [-64, -64, -64], maxs: [64, 64, 0], shader: 'textures/f/grey' }])
      });
      const loaded = await load({ bsp, scripts: parseShaderScripts([`${SCRIPTS} ${FOGS}`]) });
      // The brush model's batch first, then the world's: each its stages and its pass.
      const { draws } = loaded;
      expect(draws.map((instance) => instance.node.name)).toEqual([
        '*1',
        '*1',
        '*1',
        loaded.root.name,
        loaded.root.name,
        loaded.root.name
      ]);
      const own = held(draws[2], FOG_UNIFORM) as Float32Array;
      const world = held(draws[5], FOG_UNIFORM) as Float32Array;
      expect(own).not.toBe(world);
      const view = { origin: { x: 5, y: -5, z: 40 }, angles: { x: 30, y: 10, z: 0 } };
      placeAtRest(loaded, bsp);
      loaded.drawFog(view);
      const [fog] = fogs(bsp);
      const frame = { origin: [10, 20, 30] as const, axis: anglesToAxis(0, 0, 0) };
      expect([...own]).toEqual(vectors(fog, view, frame));
      expect([...world]).toEqual(vectors(fog, view));
      expect([...own]).not.toEqual([...world]);
      // And in the frame it is placed in next, turned.
      loaded.placeModels([{ model: 1, origin: [-3, 4, 8], angles: [10, 30, 5] }]);
      loaded.drawFog(view);
      const turned = { origin: [-3, 4, 8] as const, axis: anglesToAxis(10, 30, 5) };
      expect([...own]).toEqual(vectors(fog, view, turned));
    });

    it('makes *fog for a map with fogs, unmipped, filtered and clamped, and frees it', async () => {
      const loaded = await load(fogMap());
      const image = loaded.fogImage!;
      expect(image.name).toBe('*fog');
      expect([
        image.width,
        image.height,
        image.mipmaps,
        image.minFilter,
        image.magFilter,
        image.addressU,
        image.addressV
      ]).toEqual([
        256,
        32,
        false,
        FILTER_LINEAR,
        FILTER_LINEAR,
        ADDRESS_CLAMP_TO_EDGE,
        ADDRESS_CLAMP_TO_EDGE
      ]);
      const made = fogImage();
      const uploaded = texels(image);
      expect(uploaded).toHaveLength(made.length);
      expect(uploaded.every((value, i) => value === made[i])).toBe(true);
      await loaded.destroy();
      world = undefined;
      expect(image.device).toBeNull();
      expect((await load()).fogImage).toBeNull();
    });

    it("warms up the fogs' draws with the rest", async () => {
      const loaded = await load(fogMap());
      const seen: number[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
      });
      warmUp(app, [loaded.warm()]);
      draw.mockRestore();
      for (const instance of loaded.draws) {
        expect(seen.filter((id) => id === instance.id)).toHaveLength(2);
      }
    });
  });

  describe('brush models', () => {
    const entities = `
      { "classname" "worldspawn" }
      { "classname" "func_static" "model" "*1" "origin" "10 20 30" }
      { "classname" "func_rotating" "model" "*2" "origin" "-5 0 0" "model2" "models/x.md3" }
    `;
    const bsp = () =>
      testBsp({
        shaders: ['textures/s/wall'],
        surfaces: surfaces(0, 0, 0),
        models: [model(0, 1), model(1, 1), model(2, 1)],
        entityString: entities,
        lightmaps: 1
      });
    const files = {
      ...IMAGES,
      'models/x.md3': buildMd3({ surfaces: [{ name: 'x', shader: 'textures/s/wall' }] })
    };

    /** `*2` as the scene hands it in: where it stands, how it is turned, and what it names. */
    const rotator = (angles: [number, number, number], model2?: string): BrushModelPose => ({
      model: 2,
      origin: [-5, 0, 0],
      angles,
      ...(model2 ? { model2 } : {})
    });

    it("builds each inline model before the world, with the movers' model2s", async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const nodes = loaded.draws.map((instance) => instance.node.name);
      expect(nodes).toEqual(['*1', '*1', '*2', '*2', loaded.root.name, loaded.root.name]);
      const rotating = loaded.root.findByName('*2') as Entity;
      expect(rotating.children.map((child) => child.name)).toEqual(['models/x.md3']);
      // Shown only once a pose hands its mover in with it.
      expect(rotating.children[0].enabled).toBe(false);
    });

    it("keys each by its mover's entity, before the world's, again as it changes", async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const [one, , two, , world] = loaded.draws;
      // Unnumbered, as a preview places them, they keep their models' order.
      expect(keyedInOrder([one, two, world])).toBe(true);
      loaded.placeModels([
        { model: 1, number: 90, origin: [10, 20, 30], angles: [0, 0, 0] },
        { ...rotator([0, 0, 0], 'models/x.md3'), number: 70 }
      ]);
      loaded.key();
      // `*2`'s mover is entity 70, `*1`'s 90: Q3's sort takes `*2` first, and the world last.
      expect(keyedInOrder([two, one, world])).toBe(true);
      const model2 = (loaded.root.findByName('*2') as Entity).children[0] as Entity;
      expect(sceneDraw(model2.render!.meshInstances[0])).toBeUndefined();
      await loaded.destroy();
      const placed = await load({ bsp: bsp(), fs: searchPath(files), scene: testScene() });
      placed.placeModels([{ ...rotator([0, 0, 0], 'models/x.md3'), number: 70 }]);
      const placedModel2 = (placed.root.findByName('*2') as Entity).children[0] as Entity;
      // `CG_Mover` adds the model2 after its mover's model.
      expect(sceneDraw(placedModel2.render!.meshInstances[0])!.entity.value).toBe(
        packetEntity(70, 1)
      );
    });

    it('stands each where the scene places it, its model2 while the pose names it', async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const [one, two] = ['*1', '*2'].map((name) => loaded.root.findByName(name) as Entity);
      const model2 = two.children[0] as Entity;
      loaded.placeModels([
        { model: 1, origin: [10, 20, 30], angles: [0, 0, 0] },
        rotator([0, 90, 0], 'models/x.md3')
      ]);
      expect([...one.getLocalPosition().toArray()]).toEqual([10, 20, 30]);
      expect([...two.getLocalPosition().toArray()]).toEqual([-5, 0, 0]);
      // A quarter turn about the world's up.
      const turn = two.getLocalRotation();
      const half = Math.SQRT1_2;
      const quarter = [0, 0, half, half];
      [turn.x, turn.y, turn.z, turn.w].forEach((part, i) => expect(part).toBeCloseTo(quarter[i]));
      expect(model2.enabled).toBe(true);
      // Another name, none, or the mover left out, and its model2 goes.
      loaded.placeModels([rotator([0, 90, 0], 'models/y.md3')]);
      expect(model2.enabled).toBe(false);
      loaded.placeModels([rotator([0, 90, 0], 'models/x.md3')]);
      loaded.placeModels([rotator([0, 90, 0])]);
      expect(model2.enabled).toBe(false);
      loaded.placeModels([rotator([0, 90, 0], 'models/x.md3')]);
      loaded.placeModels([]);
      expect(model2.enabled).toBe(false);
      // Placed twice, it stands where it was first; the world's model and one the map hasn't got
      // are passed over.
      loaded.placeModels([
        { model: 0, origin: [7, 7, 7], angles: [0, 0, 0] },
        { model: 3, origin: [7, 7, 7], angles: [0, 0, 0] },
        { model: 1, origin: [1, 2, 3], angles: [0, 0, 0] },
        { model: 1, origin: [4, 5, 6], angles: [0, 0, 0] }
      ]);
      expect([...one.getLocalPosition().toArray()]).toEqual([1, 2, 3]);
    });

    it('writes nothing again for a model that has not moved', async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const two = loaded.root.findByName('*2') as Entity;
      const at = (origin: [number, number, number], yaw: number): BrushModelPose => ({
        model: 2,
        origin,
        angles: [0, yaw, 0]
      });
      loaded.placeModels([at([-5, 0, 0], 90)]);
      const moved = vi.spyOn(two, 'setLocalPosition');
      const turned = vi.spyOn(two, 'setLocalRotation');
      loaded.placeModels([at([-5, 0, 0], 90)]);
      expect([moved.mock.calls.length, turned.mock.calls.length]).toEqual([0, 0]);
      // Moved, it is placed again, and not turned.
      loaded.placeModels([at([-5, 0, 7], 90)]);
      expect([moved.mock.calls.length, turned.mock.calls.length]).toEqual([1, 0]);
      loaded.placeModels([at([-5, 0, 7], 95)]);
      expect([moved.mock.calls.length, turned.mock.calls.length]).toEqual([2, 1]);
    });

    it('draws only the brush models placed', async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const down = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
      const settings = { ...VISIBLE, noCull: true };
      const { draws, ramp } = loaded;
      const drawnWith = (poses: BrushModelPose[]) => {
        loaded.placeModels(poses);
        loaded.see(down, settings, OPEN_AREAS);
        return rendered();
      };
      const one: BrushModelPose = { model: 1, origin: [10, 20, 30], angles: [0, 0, 0] };
      expect(drawnWith([])).toEqual([...draws.slice(4), ...ramp]);
      expect(drawnWith([rotator([0, 0, 0])])).toEqual([...draws.slice(2), ...ramp]);
      expect(drawnWith([one, rotator([0, 0, 0])])).toEqual([...draws, ...ramp]);
      expect(drawnWith([one])).toEqual([draws[0], draws[1], draws[4], draws[5], ...ramp]);
    });

    it("draws a light's pass over a model's batch, the light carried into its frame", async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      loaded.placeModels([{ model: 1, origin: [10, 20, 30], angles: [0, 0, 0] }]);
      const down = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
      const light = { origin: { x: 14, y: 28, z: 42 }, radius: 100, color: [1, 1, 1] as const };
      loaded.see(down, { ...VISIBLE, noCull: true }, OPEN_AREAS, [{ ...light, additive: false }]);
      loaded.animate(0, NO_WORLD);
      const [one] = loaded.draws;
      const pass = loaded.lightPasses.find((instance) => instance.node === one.node)!;
      expect(uniform(pass, 'q3_dlight[0]').slice(0, 4)).toEqual([4, 8, 12, 100]);
      expect(pass.mesh!.vertexBuffer).toBe(one.mesh!.vertexBuffer);
    });

    it("lights a model2 in its mover's frame, turned with it", async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const model2 = loaded.root.findByName('models/x.md3') as Entity;
      const light = held(model2.render!.meshInstances[0], 'q3_light[0]') as Float32Array;
      for (const yaw of [90, 200]) {
        loaded.placeModels([rotator([0, yaw, 0], 'models/x.md3')]);
        loaded.animate(0, NO_WORLD);
        const direction = lightInEntity(model2).direction;
        for (let i = 0; i < 3; i++) expect(light[8 + i]).toBeCloseTo(direction[i], 6);
      }
    });

    it('lights a model2 by the grid and the lights at its mover, as ioquake3 does', async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const model2 = loaded.root.findByName('models/x.md3') as Entity;
      const light = held(model2.render!.meshInstances[0], 'q3_light[0]') as Float32Array;
      // Three points a side about the origin, brighter along x, and a rocket off to the side.
      const data = new Uint8Array(27 * 8);
      for (let i = 0; i < 27; i++) {
        data.set([100 + 20 * (i % 3), 100, 100, 50, 50, 50, 0, 0], i * 8);
      }
      const grid: LightGrid = {
        inverseSize: [1 / 64, 1 / 64, 1 / 128],
        origin: [-64, -64, -128],
        bounds: [3, 3, 3],
        data
      };
      const rocket = {
        origin: { x: 60, y: 0, z: 0 },
        radius: 200,
        color: [1, 0.75, 0],
        additive: false
      } as const;
      const scene = { grid, lights: [rocket], ambientScale: 0.6, directedScale: 1 };
      loaded.placeModels([rotator([0, 90, 0], 'models/x.md3')]);
      loaded.animate(0, scene);
      const standing = entityLightAt({ x: -5, y: 0, z: 0 }, scene);
      const lit = lightInEntityFrame(anglesToAxis(0, 90, 0), standing);
      expect([...light.subarray(0, 3)]).toEqual(lit.ambient.map(Math.fround));
      expect([...light.subarray(4, 7)]).toEqual(lit.directed.map(Math.fround));
      expect([...light.subarray(8, 11)]).toEqual(lit.direction.map(Math.fround));
      // Brighter than the grid alone: the rocket reaches it.
      expect(light[4]).toBeGreaterThan(50);
    });

    it("lights a mover's lightingDiffuse stage by its light, and the world's by none", async () => {
      const loaded = await load({
        bsp: bsp(),
        scripts: parseShaderScripts([`textures/s/wall { { map g.tga rgbGen lightingDiffuse } }`]),
        fs: searchPath(files)
      });
      const lightOf = (node: string) => {
        const draw = loaded.draws.find((instance) => instance.node.name === node)!;
        return held(draw, 'q3_light[0]') as Float32Array;
      };
      const [one, two, world] = ['*1', '*2', loaded.root.name].map(lightOf);
      expect([one, two, world].map((light) => light[3])).toEqual([1, 1, 0]);
      loaded.placeModels([rotator([0, 90, 0])]);
      loaded.animate(0, NO_WORLD);
      const lit = lightInEntityFrame(anglesToAxis(0, 90, 0), entityLight());
      // The directed light's w is the shade's scale, which only a model reads.
      const written = [...lit.ambient, 1, ...lit.directed, 1, ...lit.direction, 0];
      expect([...two]).toEqual(written.map(Math.fround));
      // Unplaced, `*1` is not lit again; the world never is.
      expect([...one.subarray(0, 3)]).toEqual([0, 0, 0]);
      expect([...world]).toEqual(Array(12).fill(0));
    });

    it("reads the map's grid at its gridsize, shifted, and the sun its shaders left", async () => {
      const warnings: string[] = [];
      const loadWith = (gridsize: string, points: number) =>
        load({
          bsp: testBsp({
            shaders: ['textures/s/sky'],
            models: [{ ...model(0, 1), mins: [0, 0, 0], maxs: [64, 64, 128] }],
            entityString: `{ "classname" "worldspawn" ${gridsize} }`,
            lightGrid: Uint8Array.from({ length: points * 8 }, () => 100)
          }),
          scripts: parseShaderScripts([`textures/s/sky {
            q3map_sun 1 1 1 100 0 90
            { map a.tga }
          }`]),
          fs: searchPath({ ...IMAGES, 'a.tga': IMAGES['textures/s/wall.tga'] }),
          mapOverBrightBits: 2,
          warn: (text) => warnings.push(text)
        });
      // Two points a side, shifted by one bit at r_overBrightBits 1.
      const loaded = await loadWith('', 8);
      expect(loaded.lightGrid?.bounds).toEqual([2, 2, 2]);
      expect(loaded.lightGrid?.data[0]).toBe(200);
      expect(loaded.sunDirection?.[2]).toBe(1);
      // Points 32 units apart: three a side, and a lump of eight is Quake 3's mismatch.
      expect((await loadWith('"gridsize" "32 32 64"', 27)).lightGrid?.bounds).toEqual([3, 3, 3]);
      expect(warnings).toEqual([]);
      expect((await loadWith('"gridsize" "32 32 64"', 8)).lightGrid).toBeNull();
      expect(warnings).toEqual(['WARNING: light grid mismatch\n']);
    });

    it('sets a model2 at the time it is given', async () => {
      const glow = `models/x/glow {
        { map g.tga blendFunc add rgbGen wave sin 0.5 1 0.25 1 tcMod scroll 0.5 0
          }
      }`;
      const loaded = await load({
        bsp: bsp(),
        scripts: parseShaderScripts([`${SCRIPTS} ${glow}`]),
        fs: searchPath({
          ...files,
          'models/x.md3': buildMd3({ surfaces: [{ name: 'x', shader: 'models/x/glow' }] })
        }),
        time: 1250
      });
      const model2 = loaded.root.findByName('models/x.md3') as Entity;
      const [stage] = model2.render!.meshInstances;
      // The wave's base, as a model's additive stage is drawn: doubled from the framebuffer's.
      expect(material(stage).emissive.r).toBeCloseTo(0.5, 10);
      // The scroll, in the model's own coordinates.
      const coordinates = held(stage, 'q3_coords[0]') as Float32Array;
      expect(coordinates[6]).toBeCloseTo(0.625, 6);
      // And on with the clock, frame by frame, while it is shown.
      loaded.placeModels([rotator([0, 0, 0], 'models/x.md3')]);
      loaded.animate(1500, NO_WORLD);
      expect(coordinates[6]).toBeCloseTo(0.75, 6);
      loaded.placeModels([rotator([0, 0, 0])]);
      loaded.animate(1750, NO_WORLD);
      expect(coordinates[6]).toBeCloseTo(0.75, 6);
    });

    it('hides them and model2 under r_drawentities 0, but not from the warm-up', async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      placeAtRest(loaded, bsp());
      loaded.showEntities(false);
      expect(rendered()).toEqual([...loaded.draws.slice(4), ...loaded.ramp]);
      const model2 = loaded.root.findByName('models/x.md3') as Entity;
      expect(model2.enabled).toBe(false);

      const seen: number[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
      });
      warmUp(app, [loaded.warm()]);
      draw.mockRestore();
      // Each of the world's draws and the ramp's, at each of the warm-up's two moments.
      for (const instance of [...loaded.draws, ...loaded.ramp]) {
        expect(seen.filter((id) => id === instance.id)).toHaveLength(2);
      }
      expect(rendered()).toEqual([...loaded.draws.slice(4), ...loaded.ramp]);
      expect(model2.enabled).toBe(false);
      loaded.showEntities(true);
      expect(rendered()).toEqual([...loaded.draws, ...loaded.ramp]);
      expect(model2.enabled).toBe(true);
    });

    it('warms up every model2, placed or not', async () => {
      const loaded = await load({ bsp: bsp(), fs: searchPath(files) });
      const model2 = loaded.root.findByName('models/x.md3') as Entity;
      const [stage] = model2.render!.meshInstances;
      const seen: number[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
      });
      warmUp(app, [loaded.warm()]);
      draw.mockRestore();
      expect(seen).toContain(stage.id);
      expect(model2.enabled).toBe(false);
    });
  });

  describe('shader swaps', () => {
    const SWAPS = `
      textures/s/flipped
      {
        cull none
        {
          animMap 2 f/a.tga f/b.tga f/c.tga
        }
      }
      textures/s/moved
      {
        deformVertexes move 0 0 4 sin 2 0 0 0
        {
          map g.tga
        }
      }
      textures/s/sprite
      {
        deformVertexes autosprite
        {
          map g.tga
        }
      }
      textures/s/sky
      {
        skyparms - 512 -
        {
          map g.tga
        }
      }
      textures/s/othersky
      {
        skyparms - 512 -
        {
          map g.tga
        }
      }
      textures/f/grey
      {
        surfaceparm fog
        fogparms ( 0.5 0.25 1 ) 512
      }
    `;
    const FLIPBOOK = { 'f/a.tga': tga(), 'f/b.tga': tga(), 'f/c.tga': tga() };

    /** An entity text whose entities can swap the wall for each of these. */
    const swapText = (...targets: string[]) =>
      [
        '{ "classname" "worldspawn" }',
        ...targets.map((target) => swapEntity('textures/s/wall', target))
      ].join('\n');

    /** An entity that swaps one shader for another. */
    const swapEntity = (from: string, to: string) =>
      `{ "classname" "trigger_always" "targetShaderName" "${from}" "targetShaderNewName" "${to}" }`;

    /** The test map, whose wall its entities can swap for each of these. */
    function swapMap(...targets: string[]): Partial<BspWorldOptions> {
      return {
        bsp: testBsp({
          shaders: ['textures/s/wall', 'textures/s/glass', 'textures/s/floor'],
          surfaces: surfaces(1, 0, 2, 0),
          lightmaps: 1,
          entityString: swapText(...targets)
        }),
        scripts: parseShaderScripts([`${SCRIPTS} ${SWAPS}`]),
        fs: searchPath({ ...IMAGES, ...FLIPBOOK })
      };
    }

    it("makes a run's draws for each shader it may draw instead, its own shown", async () => {
      const loaded = await load(swapMap('textures/s/flipped', 'textures/s/flipped'));
      expect(loaded.draws).toHaveLength(6);
      const [wallMap, wallTexture, flipped, ...rest] = loaded.draws;
      expect(material(flipped).emissiveMap!.name).toMatch(/^f\//);
      expect(flipped.mesh).toBe(wallMap.mesh);
      expect(keyedInOrder(loaded.draws)).toBe(true);
      expect(rendered()).toEqual([wallMap, wallTexture, ...rest, ...loaded.ramp]);
    });

    it("draws the new shader's stages in the old one's place, and its own back", async () => {
      const loaded = await load(swapMap('textures/s/flipped'));
      const [wallMap, wallTexture, flipped, ...rest] = loaded.draws;

      loaded.remapShader('textures/s/wall', 'textures/s/flipped', ' 1.00');
      expect(rendered()).toEqual([flipped, ...rest, ...loaded.ramp]);
      // A view that cuts the run again shows what it draws now: from 10 above, one of its faces.
      const above = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
      loaded.see(above, VISIBLE, OPEN_AREAS);
      expect(flipped.mesh!.primitive[0].count).toBe(3);
      expect(rendered()).toEqual([flipped, ...rest, ...loaded.ramp]);

      loaded.remapShader('textures/s/wall', 'textures/s/wall', ' 2.00');
      expect(rendered()).toEqual([wallMap, wallTexture, ...rest, ...loaded.ramp]);
      loaded.see(above, { ...VISIBLE, noCull: true }, OPEN_AREAS);
      expect(rendered()).toEqual([wallMap, wallTexture, ...rest, ...loaded.ramp]);
    });

    it("plays the new shader's stages on its own clock, from the swap's time", async () => {
      const loaded = await load(swapMap('textures/s/flipped'));
      const flipped = loaded.draws[2];
      loaded.animate(1250, NO_WORLD);
      // Not drawn, it stands at its first frame.
      expect(material(flipped).emissiveMap!.name).toBe('f/a.tga');

      loaded.remapShader('textures/s/wall', 'textures/s/flipped', ' 1.00');
      loaded.animate(2250, NO_WORLD);
      // Two frames a second from 1 s: the third at 2.25 s.
      expect(material(flipped).emissiveMap!.name).toBe('f/c.tga');
      loaded.animate(1250, NO_WORLD);
      expect(material(flipped).emissiveMap!.name).toBe('f/a.tga');
    });

    it('deforms a run as the shader it draws now deforms it', async () => {
      const loaded = await load(swapMap('textures/s/moved'));
      const [wallMap] = loaded.draws;
      // The wall's first vertex, the fourth of the map's, stands at a height of 9.
      const height = () => new Float32Array(wallMap.mesh!.vertexBuffer.lock() as ArrayBuffer)[2];
      loaded.animate(0, NO_WORLD);
      expect(height()).toBe(9);
      expect(rendered()).toContain(wallMap);

      loaded.remapShader('textures/s/wall', 'textures/s/moved', ' 0.00');
      loaded.animate(0, NO_WORLD);
      expect(height()).toBe(17);
    });

    it("counts the new shader's passes for r_speeds", async () => {
      const loaded = await load(swapMap('textures/s/flipped'));
      const down = { origin: { x: 0, y: 0, z: 10 }, angles: { x: 90, y: 0, z: 0 } };
      loaded.see(down, VISIBLE, OPEN_AREAS);
      // A face of the wall's at two passes, the floor's at two and the glass's at one.
      expect(loaded.speeds().passTriangles).toBe(5);
      loaded.remapShader('textures/s/wall', 'textures/s/flipped', ' 0.00');
      expect(loaded.speeds().passTriangles).toBe(4);
    });

    it('makes room for the squares a shader a run may draw instead stamps', async () => {
      const room = async (target: string) => {
        const loaded = await load(swapMap(target));
        const size = loaded.draws[0].mesh!.indexBuffer[0].numIndices;
        await loaded.destroy();
        world = undefined;
        return size;
      };
      expect(await room('textures/s/sprite')).toBeGreaterThan(await room('textures/s/moved'));
    });

    it('swaps no sky, nor any run to one', async () => {
      const loaded = await load({
        ...swapMap(),
        bsp: testBsp({
          shaders: ['textures/s/wall', 'textures/s/sky'],
          surfaces: surfaces(0, 1),
          lightmaps: 1,
          entityString: [
            swapText('textures/s/othersky'),
            swapEntity('textures/s/sky', 'textures/s/lit')
          ].join('\n')
        })
      });
      // The wall's two stages, and none of the other sky's.
      const [page] = loaded.lightmaps;
      const wallMap = loaded.draws.find((draw) => material(draw).emissiveMap === page)!;
      expect(loaded.draws.filter((draw) => draw.mesh === wallMap.mesh)).toHaveLength(2);
      // The sky's run draws its own clouds' one pass whatever a swap says.
      loaded.see(before(2000), { ...VISIBLE, noCull: true }, OPEN_AREAS);
      const counted = loaded.speeds().passTriangles;
      loaded.remapShader('textures/s/sky', 'textures/s/lit', ' 0.00');
      expect(loaded.speeds().passTriangles).toBe(counted);
    });

    it("fogs a swapped run by the new shader's fog pass, or dims it instead", async () => {
      const loaded = await load({
        ...swapMap('textures/s/glass'),
        bsp: testBsp({
          shaders: ['textures/s/wall', 'textures/f/grey'],
          surfaces: [surface({ shaderNum: 0, fogNum: 0, lightmapNum: 0 })],
          lightmaps: 1,
          ...fogParts([{ mins: [-64, -64, -64], maxs: [64, 64, 0], shader: 'textures/f/grey' }]),
          entityString: swapText('textures/s/glass')
        })
      });
      // The wall's two stages and its pass, then the glass, which a fog dims and gives no pass.
      expect(loaded.draws).toHaveLength(4);
      const [wallMap, wallTexture, pass, glass] = loaded.draws;
      expect(material(pass).depthFunc).toBe(FUNC_EQUAL);
      expect(material(glass).defines.get('Q3_FOG_RGB')).toBe(true);
      expect(rendered()).toEqual([wallMap, wallTexture, pass, ...loaded.ramp]);

      loaded.remapShader('textures/s/wall', 'textures/s/glass', ' 0.00');
      expect(rendered()).toEqual([glass, ...loaded.ramp]);
    });

    it('warms every shader a run may draw, and shows its own after', async () => {
      const loaded = await load(swapMap('textures/s/flipped'));
      const [wallMap, wallTexture, flipped, ...rest] = loaded.draws;
      const seen: number[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        seen.push(app.graphicsDevice.scope.resolve('meshInstanceId').value as number);
      });
      warmUp(app, [loaded.warm()]);
      draw.mockRestore();
      expect(seen).toContain(flipped.id);
      expect(rendered()).toEqual([wallMap, wallTexture, ...rest, ...loaded.ramp]);
    });

    it("draws a run's own where a swap the entities could not make reaches it", async () => {
      const loaded = await load(swapMap('textures/s/flipped'));
      const [wallMap, wallTexture, , ...rest] = loaded.draws;
      loaded.remapShader('textures/s/wall', 'textures/s/floor', ' 0.00');
      expect(rendered()).toEqual([wallMap, wallTexture, ...rest, ...loaded.ramp]);
    });

    it('unswaps everything, as a renderer started again has it', async () => {
      const loaded = await load(swapMap('textures/s/flipped'));
      const [wallMap, wallTexture, , ...rest] = loaded.draws;
      loaded.remapShader('textures/s/wall', 'textures/s/flipped', ' 1.00');
      loaded.unswap();
      expect(rendered()).toEqual([wallMap, wallTexture, ...rest, ...loaded.ramp]);
    });
  });

  it('gives back everything it made', async () => {
    const device = app.graphicsDevice;
    const buffers = device.buffers.size;
    const layers = [...camera.camera!.layers];
    const bsp = testBsp({
      shaders: ['textures/s/wall', 'textures/s/glass', 'textures/s/floor'],
      surfaces: surfaces(1, 0, 2, 0),
      lightmaps: 3
    });
    const loaded = await load({ bsp });
    expect(loaded.lightmaps).toHaveLength(3);
    expect(cache.size).toBe(3);
    await loaded.destroy();
    world = undefined;
    expect(cache.size).toBe(0);
    // The null device counts no textures, so each page is checked as destroyed: it lets go of its
    // device.
    expect(loaded.lightmaps.every((page) => page.device === null)).toBe(true);
    expect(device.buffers.size).toBe(buffers);
    expect(camera.camera!.layers).toEqual(layers);
    expect(app.scene.layers.getLayerByName(WORLD_LAYER_NAME)).toBeNull();
    expect(loaded.root.parent).toBeNull();
  });
});
