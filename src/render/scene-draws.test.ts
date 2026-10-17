// @vitest-environment jsdom
import {
  BLEND_ADDITIVE,
  BLEND_NONE,
  BLEND_NORMAL,
  Entity,
  FUNC_EQUAL,
  FUNC_LESSEQUAL,
  LAYERID_WORLD,
  Layer,
  Mesh,
  MeshInstance,
  SHADERLANGUAGE_GLSL,
  StandardMaterial,
  Vec3,
  type AppBase
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseShaderScripts } from '../formats/shader-script';
import { resolveImageIn } from '../pak/vfs';
import { CLASSIC_FULLSCREEN, setRendererStyle } from '../view/overbright';
import { SceneShaders } from '../view/scene-shaders';
import {
  HYPERSPACE_KEY,
  VIEW_WEAPON_PART,
  WORLD_ENTITY,
  localEntity,
  overHyperspaceKey,
  packetEntity,
  predictedEntity,
  rampKey,
  sceneKey,
  viewWeaponEntity
} from '../view/scene-sort';
import { WORLD_FRAME, fogTexCoords, fogVectors, loadFogs } from '../view/world-fog';
import { LIGHTMAP_2D, LIGHTMAP_NONE, loadWorldShaders } from '../view/world-shaders';
import { fogParts, surface, testBsp } from '../view/world-test-fixtures';
import { NO_SCENE_FOGS, SceneFogs } from './bsp-fog';
import { BspWorld, type BspWorldOptions } from './bsp-world';
import { createTestApp, held } from './engine-test-fixtures';
import { FOG_UNIFORM } from './fog-chunks';
import { applyQuakeTransform } from './md3-mesh';
import { applyModelChunks } from './model-chunks';
import {
  DEPTH_HACK_DEFINE,
  SceneDraws,
  sceneDraw,
  sceneEntity,
  surfaceShader,
  tagDraw,
  type LayeredDraws,
  type SceneWorld
} from './scene-draws';
import { drawsInFramebuffer, setGain } from './stage-gain';
import { TextureCache } from './texture-cache';
import { OPAQUE_BLEND } from './world-stages';

type V3 = [number, number, number];

/** A TGA of 2 by 2, every byte 255. */
function tga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 0x28];
  return new Uint8Array([...header, ...new Array(16).fill(255)]);
}

/** A search path holding these files. */
function searchPath(files: Record<string, Uint8Array>): BspWorldOptions['fs'] {
  const held = new Map(Object.entries(files).map(([path, bytes]) => [path.toLowerCase(), bytes]));
  return {
    resolveImage: (reference) => resolveImageIn((path) => held.has(path), reference),
    read: async (path) => held.get(path.toLowerCase())
  };
}

const SCRIPTS = `
  textures/s/water { { map g.tga blendFunc blend } }
  textures/s/glass { { map g.tga blendFunc add } }
  smokePuff { { map g.tga blendFunc blend } }
  rocketExplosion { { map g.tga blendFunc add } }
  gfx/damage/bullet_mrk { polygonOffset { map g.tga blendFunc filter } }
  models/s/foggy { surfaceparm fog { map g.tga blendFunc blend } }
`;

const IMAGES = {
  'textures/s/wall.tga': tga(),
  'g.tga': tga(),
  'models/s/skin.tga': tga(),
  'models/s/item.tga': tga(),
  'models/s/gun.tga': tga()
};

describe('SceneDraws', () => {
  let app: AppBase;
  let camera: Entity;
  let world: Layer;
  let effects: Layer;
  let gun: Layer;
  let scene: SceneDraws;

  beforeEach(() => {
    ({ app, camera } = createTestApp());
    world = app.scene.layers.getLayerById(LAYERID_WORLD)!;
    effects = new Layer({ name: 'effects' });
    gun = new Layer({ name: 'gun' });
    app.scene.layers.push(effects);
    app.scene.layers.push(gun);
    scene = new SceneDraws(new SceneShaders(), {
      models: [world],
      effects: [effects],
      gun: [gun],
      screen: []
    });
  });

  afterEach(() => {
    app.destroy();
    setRendererStyle(CLASSIC_FULLSCREEN);
  });

  /** A layer standing in for a world's, keying nothing of its own. */
  const standIn = (): SceneWorld & { keyed: number } => {
    const layer = new Layer({ name: 'scene' });
    app.scene.layers.push(layer);
    const stand = {
      layer,
      fog: NO_SCENE_FOGS,
      keyed: 0,
      key: () => {
        stand.keyed++;
      }
    };
    return stand;
  };

  /** A render component of one draw, in `material`. */
  const drawing = (material: StandardMaterial): Entity => {
    const entity = new Entity('drawing');
    const mesh = Mesh.fromGeometry(app.graphicsDevice, {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    } as never);
    entity.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
    app.root.addChild(entity);
    return entity;
  };

  it('puts each group in its own layers, and every draw in the scene once a map has one', () => {
    const model = drawing(new StandardMaterial());
    const effect = drawing(new StandardMaterial());
    scene.place(model.render!, 'models');
    scene.place(effect.render!, 'effects');
    expect(model.render!.layers).toEqual([world.id]);
    expect(effect.render!.layers).toEqual([effects.id]);
    const map = standIn();
    scene.enter(map);
    expect(scene.inScene).toBe(true);
    expect([model.render!.layers, effect.render!.layers]).toEqual([[map.layer.id], [map.layer.id]]);
    // One placed while the map is in goes in its scene.
    const later = drawing(new StandardMaterial());
    scene.place(later.render!, 'gun');
    expect(later.render!.layers).toEqual([map.layer.id]);
    scene.leave(standIn());
    expect(scene.inScene).toBe(true);
    scene.leave(map);
    expect(later.render!.layers).toEqual([gun.id]);
    // One that went is forgotten.
    later.destroy();
    scene.enter(standIn());
    scene.enter(null);
    expect(model.render!.layers).toEqual([world.id]);
  });

  it("moves draws a module adds itself, and takes a group's own layers made later", () => {
    const batch: LayeredDraws & { layers: readonly Layer[] } = {
      layers: [],
      setLayers(layers) {
        this.layers = layers;
      }
    };
    scene.placeBatch(batch, 'effects');
    expect(batch.layers).toEqual([effects]);
    const later = new Layer({ name: 'later' });
    scene.keepOwn('effects', [later]);
    expect(batch.layers).toEqual([later]);
    const map = standIn();
    scene.enter(map);
    expect(batch.layers).toEqual([map.layer]);
    scene.release(batch);
    scene.enter(null);
    expect(batch.layers).toEqual([map.layer]);
  });

  it('keys every tagged draw by its shader, its entity and its step, and the world its own', () => {
    const map = standIn();
    scene.enter(map);
    const model = drawing(new StandardMaterial());
    scene.place(model.render!, 'models');
    const [instance] = model.render!.meshInstances;
    const entity = sceneEntity();
    entity.value = packetEntity(4, 2);
    tagDraw(instance, { shader: scene.shaders.handle('models/s/skin'), entity, step: 3 });
    expect(sceneDraw(instance)!.step).toBe(3);
    scene.order();
    // No registry bound: every shader at 0.
    expect(instance.drawOrder).toBe(sceneKey(0, packetEntity(4, 2), 0, false, 3));
    expect(map.keyed).toBe(1);
    entity.value = localEntity(9);
    scene.order();
    expect(instance.drawOrder).toBe(sceneKey(0, localEntity(9), 0, false, 3));
  });

  it("sorts a surface by its own shader as a model's, or by a custom one as a 2D one's", () => {
    const placement = { draws: scene, group: 'models' } as const;
    expect(surfaceShader(placement, 'models/s/skin')).toBe(
      scene.shaders.handle('models/s/skin', LIGHTMAP_NONE)
    );
    // `RE_RegisterShader` registers a shell's, as cgame names it.
    expect(surfaceShader({ ...placement, customShader: 'powerups/quad' }, 'models/s/skin')).toBe(
      scene.shaders.handle('powerups/quad', LIGHTMAP_2D)
    );
  });

  it("draws a material at the framebuffer's values, an opaque one blended, and back again", () => {
    const opaque = new StandardMaterial();
    opaque.blendType = BLEND_NONE;
    setGain(opaque, { rgbGen: 'identity', blend: 'opaque' });
    const added = new StandardMaterial();
    added.blendType = BLEND_ADDITIVE;
    setGain(added, { rgbGen: 'identity', blend: 'add' });
    const shader = scene.shaders.handle('x');
    for (const material of [opaque, added]) {
      const draw = drawing(material);
      scene.place(draw.render!, 'models');
      tagDraw(draw.render!.meshInstances[0], { shader, entity: sceneEntity(), step: 0 });
    }
    expect(opaque.emissive.r).toBe(2);
    scene.enter(standIn());
    scene.order();
    expect([drawsInFramebuffer(opaque), drawsInFramebuffer(added)]).toEqual([true, true]);
    expect([opaque.emissive.r, added.emissive.r]).toEqual([1, 1]);
    // Blended `GL_ONE GL_ZERO`, so it sorts in the one list the world's blended draws are in.
    expect(opaque.transparent).toBe(true);
    expect(opaque.blendState.equals(OPAQUE_BLEND)).toBe(true);
    expect(added.blendType).toBe(BLEND_ADDITIVE);
    scene.enter(null);
    expect([drawsInFramebuffer(opaque), opaque.emissive.r]).toEqual([false, 2]);
    expect([opaque.transparent, opaque.blendType]).toEqual([false, BLEND_NONE]);
    expect(added.blendType).toBe(BLEND_ADDITIVE);
  });

  it("squeezes the gun's depth, and keys it over the grey on a hyperspace frame", () => {
    const material = new StandardMaterial();
    const gunDraw = drawing(material);
    scene.place(gunDraw.render!, 'gun');
    const [instance] = gunDraw.render!.meshInstances;
    const entity = sceneEntity();
    entity.value = viewWeaponEntity(VIEW_WEAPON_PART.barrel);
    tagDraw(instance, { shader: scene.shaders.handle('g'), entity, step: 2, depthHack: true });
    scene.enter(standIn());
    scene.order();
    expect(material.getDefine(DEPTH_HACK_DEFINE)).toBe(true);
    expect(instance.drawOrder).toBe(sceneKey(0, entity.value, 0, false, 2));
    scene.hyperspace = true;
    scene.order();
    expect(instance.drawOrder).toBe(overHyperspaceKey(0, VIEW_WEAPON_PART.barrel, 2));
    expect(instance.drawOrder).toBeGreaterThan(HYPERSPACE_KEY);
    scene.enter(null);
    expect(material.getDefine(DEPTH_HACK_DEFINE)).toBe(false);
  });

  it("shades a model as opengl1 does in a scene under opengl2's style, its own way out", () => {
    setRendererStyle({ renderer: 'opengl2', overBrightBits: 1 });
    const material = new StandardMaterial();
    const stage = {
      lit: true,
      specular: false,
      environment: false,
      coordinates: false,
      deforms: []
    };
    applyModelChunks(material, stage);
    const shade = () => material.getShaderChunks(SHADERLANGUAGE_GLSL).get('litUserCodeVS')!;
    expect(shade()).toContain('Q3_LIT_GENERIC');
    const draw = drawing(material);
    scene.place(draw.render!, 'models');
    const shader = scene.shaders.handle('m');
    tagDraw(draw.render!.meshInstances[0], { shader, entity: sceneEntity(), step: 0 });
    scene.enter(standIn());
    scene.order();
    expect(shade()).not.toContain('Q3_LIT_GENERIC');
    expect(shade()).toContain('q3_light[1].w');
    scene.enter(null);
    expect(shade()).toContain('Q3_LIT_GENERIC');
  });

  describe("a BSP map's scene on the null device", () => {
    let loaded: BspWorld | undefined;

    afterEach(async () => {
      await loaded?.destroy();
      loaded = undefined;
    });

    it("draws the world's and cgame's in one list by Q3's key, the ramp last", async () => {
      const cache = new TextureCache(app.graphicsDevice);
      loaded = await BspWorld.load(app, camera.camera!, {
        name: 'test',
        bsp: testBsp({
          shaders: ['textures/s/wall', 'textures/s/water', 'textures/s/glass'],
          surfaces: [0, 1, 2].map((shaderNum, i) =>
            surface({ shaderNum, firstVert: 3 * i, firstIndex: 3 * i, lightmapNum: 0 })
          ),
          lightmaps: 1
        }),
        scripts: parseShaderScripts([SCRIPTS]),
        fs: searchPath(IMAGES),
        cache,
        picmip: 0,
        mapOverBrightBits: 2,
        fullbright: false,
        subdivisions: 4,
        multitexture: false,
        textureEnvAdd: false,
        detailTextures: true,
        time: 0,
        offset: { factor: -1, units: -2 },
        warn: () => {},
        scene
      });
      const map = loaded;
      scene.enter(map);
      scene.shaders.bind(map.registry);
      // cgame's media, the puff's among them, then the marks, as `CG_RegisterGraphics` has them.
      scene.shaders.registerShader('smokePuff');
      scene.shaders.registerShader('gfx/damage/bullet_mrk');

      /** A stand-in for a model's or an effect's draw: its shader, entity and blend. */
      const stand = (
        name: string,
        index: number,
        entity: number,
        blend: number,
        depthHack = false
      ) => {
        const material = new StandardMaterial();
        material.blendType = blend;
        material.depthWrite = blend === BLEND_NONE;
        const made = drawing(material);
        made.name = name;
        scene.place(made.render!, blend === BLEND_NONE ? 'models' : 'effects');
        const order = sceneEntity();
        order.value = entity;
        tagDraw(made.render!.meshInstances[0], {
          shader: scene.shaders.handle(name, index),
          entity: order,
          step: 0,
          depthHack
        });
        return made.render!.meshInstances[0];
      };
      // Their shaders first used in this order, as a frame first draws them.
      const body = stand('models/s/skin', LIGHTMAP_NONE, predictedEntity(1), BLEND_NONE);
      const item = stand('models/s/item', LIGHTMAP_NONE, packetEntity(70), BLEND_NONE);
      const gunDraw = stand('models/s/gun', LIGHTMAP_NONE, viewWeaponEntity(0), BLEND_NONE, true);
      const explosion = stand('rocketExplosion', LIGHTMAP_2D, localEntity(3), BLEND_ADDITIVE);
      const puff = stand('smokePuff', LIGHTMAP_2D, localEntity(1), BLEND_NORMAL);
      const decal = stand('gfx/damage/bullet_mrk', LIGHTMAP_2D, WORLD_ENTITY, BLEND_NORMAL);

      const drawn = [...map.draws, ...map.ramp, body, item, gunDraw, explosion, puff, decal];
      const byId = new Map(drawn.map((instance) => [instance.id, instance]));
      const id = app.graphicsDevice.scope.resolve('meshInstanceId');
      const order: MeshInstance[] = [];
      const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
        const instance = byId.get(id.value as number);
        if (instance) order.push(instance);
      });
      camera.camera!.frustumCulling = false;
      scene.order();
      app.render();
      draw.mockRestore();
      const [lightmap, wall, water, glass] = map.draws;
      // The opaque sort, by when each shader was made: the world's, then cgame's as first used.
      // Then the decal's sort, then the blended: the world's water and glass, then cgame's puff,
      // registered with its media, and the explosion first used after it. The ramp last.
      expect(order).toEqual([
        lightmap,
        wall,
        body,
        item,
        gunDraw,
        decal,
        water,
        glass,
        puff,
        explosion,
        ...map.ramp
      ]);
      expect(map.ramp[0].drawOrder).toBe(rampKey(0));

      // A splat match after it: every material back on screen, in its own layers.
      scene.enter(null);
      expect(body.material!.transparent).toBe(false);
      expect(drawsInFramebuffer(explosion.material as StandardMaterial)).toBe(false);
    });
  });

  describe("a map's fogs", () => {
    /** A fog filling x and y from 0 to 256, from 64 under to 64 over, its top showing. */
    const fogs = loadFogs(
      testBsp(fogParts([{ mins: [0, 0, -64], maxs: [256, 256, 64], shader: 'fog' }])),
      () => ({ fogParms: { color: [1, 0.5, 0], depthForOpaque: 64 } })
    );
    const eye: V3 = [-40, 128, 0];
    const forward: V3 = [1, 0, 0];

    /** A model's entity, its one frame's sphere 4 about its origin. */
    const modelEntity = () =>
      sceneEntity({ kind: 'model', frames: [{ localOrigin: [0, 0, 0], radius: 4 }], frame: 0 });

    /** A stand-in for a world with that fog, seen from `eye`. */
    const foggy = (): SceneWorld & { fog: SceneFogs } => {
      const layer = new Layer({ name: 'scene' });
      app.scene.layers.push(layer);
      const fog = new SceneFogs(fogs, [[255, 128, 0, 255]]);
      fog.view(eye, forward);
      return { layer, fog, key: () => {} };
    };

    /** A draw under a root in Quake's frame, placed by the scene in the models' group. */
    const placedDraw = (root: Entity, material = new StandardMaterial()) => {
      const made = drawing(material);
      root.addChild(made);
      scene.place(made.render!, 'models');
      return { node: made, instance: made.render!.meshInstances[0] };
    };

    const quakeRoot = () => {
      const root = new Entity('quake');
      applyQuakeTransform(root);
      app.root.addChild(root);
      return root;
    };

    /** A shader registry the scene's handles find their passes in. */
    const bindShaders = () =>
      scene.shaders.bind(
        loadWorldShaders(testBsp({}), {
          scripts: parseShaderScripts([SCRIPTS]),
          hasImage: () => true,
          warn: () => {}
        })
      );

    it("finds a model's fog each frame from where its draw is placed, and keys by it", () => {
      scene.enter(foggy());
      const { node, instance } = placedDraw(quakeRoot());
      node.setLocalPosition(100, 100, 0);
      const frames = [
        { localOrigin: [0, 0, 0] as V3, radius: 8 },
        { localOrigin: [0, 0, 500] as V3, radius: 8 }
      ];
      const entity = sceneEntity({ kind: 'model', frames, frame: 0 });
      entity.value = packetEntity(9);
      const shader = scene.shaders.handle('models/s/skin', LIGHTMAP_NONE);
      tagDraw(instance, { shader, entity, step: 3 });
      scene.order();
      expect(entity.fog).toBe(1);
      expect(instance.drawOrder).toBe(sceneKey(0, packetEntity(9), 1, false, 3));
      const at = { origin: [100, 100, 0] as V3, axis: WORLD_FRAME.axis };
      const own = fogVectors(fogs[0], eye, forward, at);
      const expected = [...own.distance, ...own.depth, own.eyeT, 0, 0, 0];
      [...entity.fogData].forEach((x, i) => expect(x, `${i}`).toBeCloseTo(expected[i], 4));
      // Drawn at a frame whose sphere sits above the fog: in none, and reading nothing.
      if (entity.fogBy?.kind === 'model') entity.fogBy.frame = 1;
      scene.order();
      expect([entity.fog, [...entity.fogData]]).toEqual([0, new Array(12).fill(0)]);
      expect(instance.drawOrder).toBe(sceneKey(0, packetEntity(9), 0, false, 3));
    });

    it("finds an entity's fog once a frame, however many draws it has", () => {
      const world = foggy();
      scene.enter(world);
      const root = quakeRoot();
      const entity = sceneEntity({ kind: 'sprite', radius: 4 });
      const shader = scene.shaders.handle('smokePuff', LIGHTMAP_2D);
      for (let step = 0; step < 3; step++) {
        tagDraw(placedDraw(root).instance, { shader, entity, step });
      }
      const tested = vi.spyOn(world.fog, 'spriteFog');
      scene.order();
      scene.order();
      expect(tested).toHaveBeenCalledTimes(2);
    });

    it('measures the eye in a scaled model as Q3 does, and a sprite in the world', () => {
      const world = foggy();
      scene.enter(world);
      const root = quakeRoot();
      // A model drawn at half again its size, as an item's weapon is.
      const scaled = placedDraw(root);
      scaled.node.setLocalPosition(100, 100, -20);
      scaled.node.setLocalScale(1.5, 1.5, 1.5);
      const model = modelEntity();
      const shader = scene.shaders.handle('models/s/skin', LIGHTMAP_NONE);
      tagDraw(scaled.instance, { shader, entity: model, step: 0 });
      // A sprite turned and sized, whose corners its draw places about it.
      const sprite = placedDraw(root);
      sprite.node.setLocalPosition(60, 30, 10);
      sprite.node.setLocalEulerAngles(10, 70, 20);
      sprite.node.setLocalScale(16, 16, 16);
      const spriteEntity = sceneEntity({ kind: 'sprite', radius: 8 });
      tagDraw(sprite.instance, { shader, entity: spriteEntity, step: 0 });
      scene.order();
      const doubled = WORLD_FRAME.axis.map((along) => along.map((x) => x * 1.5) as V3);
      const [a, b, c] = doubled;
      const frame = { origin: [100, 100, -20] as V3, axis: [a, b, c] as const };
      const flagged = fogVectors(fogs[0], eye, forward, { ...frame, nonNormalizedAxes: true });
      expect(model.fogData[8]).toBeCloseTo(flagged.eyeT, 3);
      expect(model.fogData[8]).not.toBeCloseTo(fogVectors(fogs[0], eye, forward, frame).eyeT, 1);
      // The sprite's corner is read as the world's point it stands at.
      const corner = new Vec3(0.5, 0.5, 0);
      const at = sprite.node.getWorldTransform().transformPoint(corner, new Vec3());
      const world3: V3 = [at.x * 32, -at.z * 32, at.y * 32];
      const local = (data: Float32Array) =>
        fogTexCoords(
          {
            distance: [data[0], data[1], data[2], data[3]],
            depth: [data[4], data[5], data[6], data[7]],
            eyeT: data[8]
          },
          [corner.x, corner.y, corner.z]
        );
      const inWorld = fogTexCoords(fogVectors(fogs[0], eye, forward), world3);
      expect(spriteEntity.fog).toBe(1);
      local(spriteEntity.fogData).forEach((x, i) => expect(x).toBeCloseTo(inWorld[i], 4));
      expect(spriteEntity.fogData[8]).toBe(world.fog.worldData(1)[8]);
    });

    it("finds a box's fog by its corners, touching it counted", () => {
      scene.enter(foggy());
      // From out of the fog up to its low face.
      const box = sceneEntity({ kind: 'box', mins: [-50, 0, 0], maxs: [0, 10, 10] });
      const shader = scene.shaders.handle('bbox_nocull', LIGHTMAP_2D);
      tagDraw(placedDraw(quakeRoot()).instance, { shader, entity: box, step: 0 });
      scene.order();
      expect(box.fog).toBe(1);
      if (box.fogBy?.kind === 'box') box.fogBy.maxs[0] = -1;
      scene.order();
      expect(box.fog).toBe(0);
    });

    it("binds each tagged draw to its entity's fog", () => {
      const { instance } = placedDraw(quakeRoot());
      const entity = sceneEntity();
      tagDraw(instance, { shader: scene.shaders.handle('x'), entity, step: 0 });
      expect(held(instance, FOG_UNIFORM)).toBe(entity.fogData);
    });

    it('shows a fog pass only while its entity is in a fog its shader takes one for', () => {
      bindShaders();
      const world = foggy();
      scene.enter(world);
      const root = quakeRoot();
      const passOf = (name: string, index: number) => {
        const { node, instance } = placedDraw(root);
        node.setLocalPosition(100, 100, 0);
        const entity = modelEntity();
        const shader = scene.shaders.handle(name, index);
        tagDraw(instance, { shader, entity, step: 64, fogPass: true });
        return { node, instance };
      };
      // An opaque skin's shader takes a depth-equal pass; a blended one none.
      const opaque = passOf('models/s/skin', LIGHTMAP_NONE);
      const blended = passOf('smokePuff', LIGHTMAP_2D);
      scene.order();
      expect([opaque.instance.visible, blended.instance.visible]).toEqual([true, false]);
      expect(held(opaque.instance, 'material_emissive')).toBe(world.fog.passColor(1));
      expect((opaque.instance.material as StandardMaterial).depthFunc).toBe(FUNC_EQUAL);
      // Out of the fog, it hides.
      opaque.node.setLocalPosition(100, 100, 400);
      scene.order();
      expect(opaque.instance.visible).toBe(false);
      // A warm-up shows each pass not yet drawn whose shader takes one, on a map with fogs: here a
      // second skin's, out of the fog, and not the blended one's.
      const unseen = passOf('models/s/item', LIGHTMAP_NONE);
      unseen.node.setLocalPosition(100, 100, 400);
      const shownNow = () => [opaque, blended, unseen].map(({ instance }) => instance.visible);
      scene.order();
      expect(shownNow()).toEqual([false, false, false]);
      const warmed = scene.warm();
      warmed.at(0);
      scene.order();
      expect(shownNow()).toEqual([false, false, true]);
      warmed.end();
      scene.order();
      expect(shownNow()).toEqual([false, false, false]);
      // Drawn once, it is not shown at a later one.
      warmed.at(0);
      scene.order();
      expect(shownNow()).toEqual([false, false, false]);
      warmed.end();
      // On a map with none, a pass never drawn is not shown even then.
      const another = passOf('models/s/gun', LIGHTMAP_NONE);
      scene.enter(standIn());
      warmed.at(0);
      scene.order();
      expect(another.instance.visible).toBe(false);
      warmed.end();
    });

    it('takes a less-or-equal pass for a fog shader drawn on a model', () => {
      bindShaders();
      scene.enter(foggy());
      const { node, instance } = placedDraw(quakeRoot());
      node.setLocalPosition(100, 100, 0);
      const shader = scene.shaders.handle('models/s/foggy', LIGHTMAP_NONE);
      tagDraw(instance, { shader, entity: modelEntity(), step: 64, fogPass: true });
      scene.order();
      expect([instance.visible, (instance.material as StandardMaterial).depthFunc]).toEqual([
        true,
        FUNC_LESSEQUAL
      ]);
    });

    it('takes every placed draw out of its fog when the world goes', () => {
      bindShaders();
      scene.enter(foggy());
      expect(scene.fog.fogs).toBe(fogs);
      const { node, instance } = placedDraw(quakeRoot());
      node.setLocalPosition(100, 100, 0);
      const entity = sceneEntity({ kind: 'sprite', radius: 4 });
      const puff = scene.shaders.handle('smokePuff', LIGHTMAP_2D);
      tagDraw(instance, { shader: puff, entity, step: 0 });
      const pass = placedDraw(quakeRoot()).instance;
      const skin = scene.shaders.handle('models/s/skin', LIGHTMAP_NONE);
      tagDraw(pass, { shader: skin, entity, step: 1, fogPass: true });
      scene.order();
      expect([entity.fog, pass.visible]).toEqual([1, true]);
      scene.enter(null);
      expect(scene.fog).toBe(NO_SCENE_FOGS);
      expect([entity.fog, entity.fogData.every((x) => x === 0), pass.visible]).toEqual([
        0,
        true,
        false
      ]);
    });
  });
});
