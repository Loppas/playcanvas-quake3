// @vitest-environment jsdom
import { CULLFACE_FRONT, Layer, type AppBase, type Entity, type MeshInstance } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { buildMd3 } from '../formats/md3-test-fixtures';
import { simToWorld } from '../coords';
import { createFlatWorldTrace } from '../sim/box-world';
import { CONTENTS } from '../sim/constants';
import { vec3, type Vec3 } from '../sim/vec3';
import { SceneLights } from '../view/dynamic-lights';
import { entityLightAt, lightInEntityFrame } from '../view/entity-light';
import {
  GIB_LIFETIME,
  GIB_LIFETIME_SPREAD,
  SINK_DEPTH,
  SINK_TIME,
  type GibPiece,
  type GibSound
} from '../view/fragments';
import { LocalEntities, MAX_LOCAL_ENTITIES } from '../view/local-entities';
import { IDENTITY_AXIS } from '../view/q-math';
import { SceneShaders } from '../view/scene-shaders';
import { BLOB_ENTITY } from '../view/scene-sort';
import { LIGHTMAP_2D } from '../view/world-shaders';
import { createTestApp, expectClose, held, lightUniform, uniform } from './engine-test-fixtures';
import { GibEffects, gibModelPath, type GibEffectsInput } from './gib-effects';
import { deformView } from './deform-view';
import { DEFORM_SLOTS, writeDeforms, writeView } from './model-chunks';
import { frameTexture } from './model-frames';
import { encode, whiteTga } from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { WARM_TIMES } from './warm-up';

/**
 * The gibs and the blood blob, on the null device with synthetic pieces and
 * pak0's two blood shaders, over a floor whose surface is z = 0.
 */

const SHADERS = `
bloodTrail { nopicmip entityMergable
  { clampmap gfx/damage/blood_spurt.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
    rgbGen vertex alphaGen vertex } }
viewBloodBlend { sort nearest
  { map gfx/damage/blood_screen.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
    rgbGen identityLighting alphaGen vertex } }
models/gibs/rising { deformVertexes move 0 0 1 sin 0 1 0 1 { map models/gibs/gibs.tga } }
models/gibs/turning { deformVertexes autosprite2 { map models/gibs/gibs.tga } }
`;

const PIECES: readonly GibPiece[] = [
  'skull',
  'brain',
  'abdomen',
  'arm',
  'chest',
  'fist',
  'foot',
  'forearm',
  'intestine',
  'leg'
];

/**
 * The ten pieces, each one triangle, and the blood's shaders and images.
 *
 * @param shader - What the pieces draw with: pak0's texture, or a shader that moves or turns
 *   them.
 */
function library(shader = 'models/gibs/gibs.tga'): AssetLibrary {
  return new AssetLibrary(
    new Map<string, Uint8Array>([
      ['scripts/gfx.shader', encode(SHADERS)],
      ['models/gibs/gibs.tga', whiteTga()],
      ['gfx/damage/blood_spurt.tga', whiteTga()],
      ['gfx/damage/blood_screen.tga', whiteTga()],
      ...PIECES.map((piece): [string, Uint8Array] => [
        gibModelPath(piece),
        buildMd3({ surfaces: [{ name: piece, shader }] })
      ])
    ])
  );
}

const floor = createFlatWorldTrace();

/** Far above anything thrown, so no puff is let go for the view being inside it. */
const FAR_EYE = vec3(0, 0, 100_000);

/** A frame with nothing new thrown and no blob. */
function frame(time: number, overrides: Partial<GibEffectsInput> = {}): GibEffectsInput {
  return { gibOrigins: [], allPieces: true, time, eye: FAR_EYE, blob: null, ...overrides };
}

describe('GibEffects', () => {
  let app: AppBase;
  let camera: Entity;
  let layer: Layer;
  let effects: GibEffects;

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    layer = new Layer({ name: 'blended' });
    app.scene.layers.push(layer);
    // Every throw straight up at 250, the brain first, and no splat: 0.5 is not under a half.
    effects = await GibEffects.create(app, library(), camera, floor, [layer.id], () => 0.5);
  });

  afterEach(() => {
    effects.destroy();
    app.destroy();
  });

  /** The pieces drawn now. */
  function drawn(): Entity[] {
    const root = app.root.findByName('gibs')!;
    return (root.children as Entity[]).filter(
      (child) => child.enabled && child.name.startsWith('models/gibs/')
    );
  }

  /** The draws the layer shows. */
  function shown(): MeshInstance[] {
    return layer.meshInstances.filter((instance) => instance.visible);
  }

  /** The trail's draws shown: its puffs' batch's. */
  function trail(): MeshInstance[] {
    return shown().filter((instance) => instance.node.name === 'gibs');
  }

  /** The trail's puffs drawn now, in order: each one's corners, in Quake units, and colour. */
  function puffs(): { corners: Vec3[]; color: number[] }[] {
    const stamps: { corners: Vec3[]; color: number[] }[] = [];
    for (const draw of trail()) {
      const { base, count } = draw.mesh!.primitive[0];
      const floats = new Float32Array(draw.mesh!.vertexBuffer.storage);
      const bytes = new Uint8Array(draw.mesh!.vertexBuffer.storage);
      for (let quad = base / 6; quad < (base + count) / 6; quad++) {
        const corners = [0, 1, 2, 3].map((corner) => {
          const at = (quad * 4 + corner) * 6;
          return vec3(floats[at], floats[at + 1], floats[at + 2]);
        });
        stamps.push({ corners, color: [...bytes.subarray(quad * 96 + 20, quad * 96 + 24)] });
      }
    }
    return stamps;
  }

  it('shows every piece and both blood sprites for the warm-up, then puts them away', () => {
    const warmed = effects.warm();
    warmed.at(0);
    expect(drawn().map((entity) => entity.name).sort()).toEqual(PIECES.map(gibModelPath).sort());
    expect(shown().map((instance) => instance.node.name).sort()).toEqual(['blood-blob', 'gibs']);
    expect(puffs()).toHaveLength(1);
    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect([drawn(), shown()]).toEqual([[], []]);
  });

  it('throws ten pieces from where the player went to pieces, two of them legs', () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)] }));
    expect(drawn().map((entity) => entity.name).sort()).toEqual(
      ['brain', 'abdomen', 'arm', 'chest', 'fist', 'foot', 'forearm', 'intestine', 'leg', 'leg']
        .map((piece) => gibModelPath(piece as GibPiece))
        .sort()
    );
  });

  it('throws the brain alone with cg_gibs 0', () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)], allPieces: false }));
    expect(drawn().map((entity) => entity.name)).toEqual([gibModelPath('brain')]);
  });

  it('holds its pieces among the local entities it is given, the oldest let go when full', async () => {
    effects.destroy();
    const pool = new LocalEntities();
    effects = await GibEffects.create(
      app,
      library(),
      camera,
      floor,
      [layer.id],
      () => 0.5,
      undefined,
      pool
    );
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)], allPieces: false }));
    expect(pool.count).toBe(1);
    for (let i = 1; i <= MAX_LOCAL_ENTITIES; i++) pool.alloc();
    effects.update(frame(16));
    expect(drawn()).toEqual([]);
  });

  it('gives every piece its frames and a light of its own, unturned, since Q3 never turns one', async () => {
    effects.destroy();
    const pieces = library();
    effects = await GibEffects.create(app, pieces, camera, floor, [layer.id], () => 0.5);
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)] }));
    const legs = drawn()
      .filter((entity) => entity.name === gibModelPath('leg'))
      .map((entity) => entity.render!.meshInstances[0]);
    expect(legs).toHaveLength(2);
    expect(held(legs[0], 'q3_light[0]')).not.toBe(held(legs[1], 'q3_light[0]'));
    const surface = pieces.model(gibModelPath('leg')).surfaces[0];
    for (const leg of legs) {
      expect(held(leg, 'q3_frames')).toBe(frameTexture(app.graphicsDevice, surface));
      expectClose(uniform(leg, 'q3_light[0]'), lightUniform(lightInEntityFrame(IDENTITY_AXIS)));
    }
  });

  it("lights each piece where it is, the scene's lights folded in", async () => {
    effects.destroy();
    const lights = new SceneLights();
    lights.add({ x: 0, y: 0, z: 120 }, 300, [1, 0.75, 0]);
    effects = await GibEffects.create(app, library(), camera, floor, [layer.id], () => 0.5, lights);
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)] }));
    effects.update(frame(100));
    for (const entity of drawn()) {
      const at = entity.getLocalPosition();
      const lit = entityLightAt({ x: at.x, y: at.y, z: at.z }, lights);
      expectClose(uniform(entity.render!.meshInstances[0], 'q3_light[0]'), lightUniform(lightInEntityFrame(IDENTITY_AXIS, lit)));
    }
  });

  it('lights a sinking piece where it came to rest', async () => {
    effects.destroy();
    const lights = new SceneLights();
    lights.add({ x: 0, y: 0, z: 40 }, 300, [1, 0.75, 0]);
    effects = await GibEffects.create(app, library(), camera, floor, [layer.id], () => 0.5, lights);
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)] }));
    // Every piece lives as long at 0.5, and is halfway into its last second's sink.
    const end = GIB_LIFETIME + Math.trunc(0.5 * GIB_LIFETIME_SPREAD);
    const time = end - SINK_TIME / 2;
    for (let t = 50; t <= time; t += 50) effects.update(frame(t));
    const pieces = drawn();
    expect(pieces.length).toBeGreaterThan(0);
    for (const entity of pieces) {
      const at = entity.getLocalPosition();
      const rest = { x: at.x, y: at.y, z: at.z + SINK_DEPTH / 2 };
      const light = lightInEntityFrame(IDENTITY_AXIS, entityLightAt(rest, lights));
      expectClose(uniform(entity.render!.meshInstances[0], 'q3_light[0]'), lightUniform(light));
    }
  });

  it('moves a piece its shader deforms on the game clock', async () => {
    effects.destroy();
    const pieces = library('models/gibs/rising');
    effects = await GibEffects.create(app, pieces, camera, floor, [layer.id], () => 0.5);
    // `CG_LaunchGib` gives a piece no `shaderTime`: 1.5 s on the game clock.
    effects.update(frame(1500, { gibOrigins: [vec3(0, 0, 100)] }));
    const packed = new Float32Array(DEFORM_SLOTS * 8);
    writeDeforms(pieces.shaders.get('models/gibs/rising')!.deforms, 1.5, packed);
    for (const entity of drawn()) {
      const [draw] = entity.render!.meshInstances;
      expect(uniform(draw, 'q3_deform[0]'), entity.name).toEqual([...packed]);
    }
  });

  it('turns a piece its shader pivots to the camera, each copy by its own view', async () => {
    effects.destroy();
    const pieces = library('models/gibs/turning');
    effects = await GibEffects.create(app, pieces, camera, floor, [layer.id], () => 0.5);
    camera.setEulerAngles(-20, 50, 0);
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)] }));
    const legs = drawn()
      .filter((entity) => entity.name === gibModelPath('leg'))
      .map((entity) => entity.render!.meshInstances[0]);
    expect(new Set(legs.map((leg) => held(leg, 'q3_view[0]'))).size).toBe(2);
    for (const leg of legs) {
      const view = new Float32Array(16);
      writeView(deformView(leg.node, camera), view);
      expectClose(uniform(leg, 'q3_view[0]'), view);
    }
  });

  it('draws each piece where it has flown', () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)] }));
    effects.update(frame(100));
    // Up at 250 for a tenth of a second, under 800: 25 up, 4 back.
    for (const entity of drawn()) expect(entity.getLocalPosition().z).toBeCloseTo(121, 6);
  });

  it('lays the blood trail in the effects layer as one draw, oldest first, fading by its alpha', () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 1000)], allPieces: false }));
    for (let t = 16; t <= 1200; t += 16) effects.update(frame(t));
    // A puff at each 150 ms mark to 1200, all still fading, in white.
    expect(trail()).toHaveLength(1);
    const colors = puffs().map((puff) => puff.color);
    expect(colors).toHaveLength(8);
    expect(colors.every(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
    // The oldest, laid at 150, is 1050 ms into its 2000; the newest is fresh.
    expect(colors[0][3]).toBe(Math.trunc(255 * (950 / 2000)));
    expect(colors[7][3]).toBe(255);
  });

  it("stamps the trail's puffs as Q3's quad stamp, so they keep Q3's culling and still show", () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 1000)], allPieces: false }));
    for (let t = 16; t <= 160; t += 16) effects.update(frame(t));
    const [draw] = trail();
    expect(draw.material!.cull).toBe(CULLFACE_FRONT);

    // Turned the half turn `random()` gave it: the image's top left, at the eye's left (−x) and up
    // (+z), is to its right and down.
    const [puff] = puffs();
    const [topLeft, , bottomRight] = puff.corners;
    expect([topLeft.x > bottomRight.x, topLeft.z < bottomRight.z]).toEqual([true, true]);

    // Where the eye sees each corner: it looks along −z from the origin, +x to its right.
    const seen = puff.corners.map((corner) => simToWorld(corner));
    const indices = new Uint32Array(draw.mesh!.indexBuffer[0].storage).subarray(0, 6);
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => seen[i]);
      // The z of (b − a) × (c − a): negative is clockwise, seen from the eye on +z.
      expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeLessThan(0);
    }
  });

  it('splashes the blob in front of the eye toward the hurt, and puts it away with none', () => {
    effects.update(frame(0, { blob: { forward: 8, left: 8, up: 0, radius: 30, alpha: 100 / 255 } }));
    const blob = camera.findByName('blood-blob') as Entity;
    expect(blob.enabled).toBe(true);
    // 8 units to the left is the camera's −x, and 8 ahead its −z, in metres.
    expect([...blob.getLocalPosition().toArray()]).toEqual([-0.25, 0, -0.25]);
    expect(blob.getLocalScale().x).toBeCloseTo(60 / 32, 6);
    expect(blob.render!.layers).toEqual([layer.id]);

    effects.update(frame(16));
    expect(blob.enabled).toBe(false);
  });

  it("sorts the blob in a map's scene as the first entity a view adds", async () => {
    effects.destroy();
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [layer],
      gun: [],
      screen: []
    });
    effects = await GibEffects.create(
      app,
      library(),
      camera,
      floor,
      [layer.id],
      () => 0.5,
      undefined,
      undefined,
      undefined,
      scene
    );
    const blob = camera.findByName('blood-blob') as Entity;
    const tag = sceneDraw(blob.render!.meshInstances[0])!;
    expect(tag.entity.value).toBe(BLOB_ENTITY);
    expect(tag.shader).toBe(scene.shaders.handle('viewBloodBlend', LIGHTMAP_2D));
    // A sprite, its fog found by the radius it is drawn at.
    effects.update(frame(0, { blob: { forward: 8, left: 0, up: 0, radius: 21, alpha: 0.5 } }));
    expect(tag.entity.fogBy).toEqual({ kind: 'sprite', radius: 21 });
  });

  it("winds its sprites as Q3's quad stamp, so the blood keeps Q3's culling and still shows", () => {
    const blob = camera.findByName('blood-blob') as Entity;
    const [instance] = blob.render!.meshInstances;
    expect(instance.material!.cull).toBe(CULLFACE_FRONT);

    const positions: number[] = [];
    instance.mesh!.getPositions(positions);
    const indices: number[] = [];
    instance.mesh!.getIndices(indices);
    expect(indices).toHaveLength(6);
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => [
        positions[i * 3],
        positions[i * 3 + 1]
      ]);
      // The z of (b − a) × (c − a): negative is clockwise, seen from the eye on +z.
      expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeLessThan(0);
    }
  });

  it('plays a splat where a piece first hits', async () => {
    const splatting = await GibEffects.create(app, library(), camera, floor, [layer.id], () => 0.25);
    splatting.update(frame(0, { gibOrigins: [vec3(0, 0, 100)], allPieces: false }));
    const sounds: GibSound[] = [];
    for (let t = 16; t < 3000; t += 16) sounds.push(...splatting.update(frame(t)));
    expect(sounds.map((sound) => sound.path)).toEqual(['sound/player/gibimp2.wav']);
    splatting.destroy();
  });

  it('takes a piece away, unheard, where it lands in the nodrop the world has', async () => {
    effects.destroy();
    effects = await GibEffects.create(
      app,
      library(),
      camera,
      floor,
      [layer.id],
      () => 0.25,
      undefined,
      new LocalEntities(),
      () => CONTENTS.NODROP
    );
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 100)], allPieces: false }));
    expect(drawn()).toHaveLength(1);
    const sounds: GibSound[] = [];
    for (let t = 16; t < 3000; t += 16) sounds.push(...effects.update(frame(t)));
    expect(sounds).toEqual([]);
    expect(drawn()).toEqual([]);
  });

  it('takes every piece and puff away, as a restart does', () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 1000)] }));
    for (let t = 16; t <= 320; t += 16) effects.update(frame(t));
    expect(puffs().length).toBeGreaterThan(0);
    effects.clear();
    expect(puffs()).toEqual([]);
    effects.update(frame(336));
    expect([drawn(), puffs()]).toEqual([[], []]);
  });

  it('takes everything out of the scene when destroyed', () => {
    effects.update(frame(0, { gibOrigins: [vec3(0, 0, 1000)] }));
    for (let t = 16; t <= 320; t += 16) effects.update(frame(t));
    effects.destroy();
    expect(app.root.findByName('gibs')).toBeNull();
    expect(camera.findByName('blood-blob')).toBeNull();
    expect(layer.meshInstances).toEqual([]);
  });
});
