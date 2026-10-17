// @vitest-environment jsdom
import {
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  LAYERID_WORLD,
  Layer,
  Texture,
  Vec3 as EngineVec3,
  type AppBase,
  type Entity,
  type MeshInstance,
  type StandardMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wave } from '../formats/shader-script';
import { AssetLibrary } from '../formats/asset-library';
import { CONTENTS } from '../sim/constants';
import type { PointContentsFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import { TR, type EntityState } from '../net/protocol';
import { ET, createGameEntity, type GameEntity } from '../sim/game-entity';
import { evaluateTrajectory } from '../sim/trajectory';
import { MISSILES, WP, type WeaponId } from '../sim/weapons/constants';
import { simToWorld, worldToSim } from '../coords';
import { SceneLights } from '../view/dynamic-lights';
import { entityLight, entityLightAt } from '../view/entity-light';
import type { WorldEffect } from '../view/entity-events';
import { ID_MISSILE_LOOKS, explosionRadius, type DrawnLaser } from '../view/effects';
import { Explosions } from '../view/explosions';
import { LocalEntities, MAX_LOCAL_ENTITIES } from '../view/local-entities';
import { colorFromString, type Rgb } from '../view/player-color';
import type { MissileCentity } from '../view/player-view';
import { localEntity, packetEntity } from '../view/scene-sort';
import { SceneShaders } from '../view/scene-shaders';
import { evalWave } from '../view/shader-animation';
import { loadFogs } from '../view/world-fog';
import { LIGHTMAP_2D, LIGHTMAP_NONE } from '../view/world-shaders';
import { fogParts, testBsp } from '../view/world-test-fixtures';
import { NO_SCENE_FOGS, SceneFogs } from './bsp-fog';
import { deformView } from './deform-view';
import { ORDER_STEP } from './draw-order';
import { EFFECTS_LAYER_NAME } from './effects-layer';
import { createTestApp, expectClose, held, lightUniform, uniform } from './engine-test-fixtures';
import { FOG_UNIFORM } from './fog-chunks';
import { writeView } from './model-chunks';
import { mergedBucket, type MergedShader } from './merged-sprites';
import { SceneDraws, sceneDraw } from './scene-draws';
import { lightInEntity } from './staged-model';
import { WARM_TIMES } from './warm-up';
import { WorldEffects, type DrawnBolt, type DrawnHook } from './world-effects';

/**
 * Which layer each world effect draws in, and how its
 * shader plays, on a real app with synthetic assets shaped like pak0's. A
 * projectile's depthless parts, every beam with the lightning's crackle, and bullet impacts
 * belong in the effects layer, which draws after the splat map; bodies stay in World. Every stage
 * of a shader is a draw of its own. Asserted against each layer's own draw list, so a clone that
 * lost its layer shows up here.
 */

/** The blood's five frames, as pak0 names them. */
const BLOOD_FRAMES = [1, 2, 3, 4, 5].map((n) => `models/weaphits/blood20${n}.tga`);

/** Shaders for the synthetic models, staged and blended as their pak0 namesakes are. */
const SHADERS = `
rockfls1 { cull disable { map models/ammo/rocket/rockfls1.tga blendFunc GL_ONE GL_ONE } }
rockflar { cull disable { map models/ammo/rocket/rockflar.tga blendFunc GL_ONE GL_ONE } }
bfg01 { deformVertexes autosprite
  { clampmap models/weaphits/bfg01.tga blendFunc GL_ONE GL_ONE tcMod rotate 333
    rgbGen identity }
  { clampmap models/weaphits/bfg01.tga blendFunc GL_ONE GL_ONE tcMod rotate -100
    rgbGen identity } }
bfg02 { { map models/weaphits/bfg03.tga blendFunc GL_ONE GL_ONE tcmod scroll 2 0
  rgbGen identity }
  { map models/weaphits/bfg02.tga blendFunc GL_ONE GL_ONE tcmod scroll 3 0
    tcMod turb 0 .25 0 1.6
      rgbGen identity } }
models/ammo/grenade { { map models/ammo/grenade.tga }
  { AnimMap 7 models/ammo/grenade_r.tga models/ammo/grenade_g.tga
    blendfunc GL_ONE GL_ONE } }
smokePuff { cull none entityMergable { map gfx/misc/smokepuff3.tga
  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbGen vertex alphaGen vertex } }
hasteSmokePuff { cull none entityMergable { map gfx/misc/smokepuff3.tga
  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbGen vertex alphaGen vertex } }
waterBubble { sort underwater cull none entityMergable { map sprites/bubble.tga
  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbGen vertex alphaGen vertex } }
models/weaphits/electric { { map models/weaphits/electric.tga blendFunc GL_ONE GL_ONE
  tcMod rotate 360
    } }
sprites/plasma1 { cull disable { clampmap sprites/plasmaa.tga blendfunc GL_ONE GL_ONE tcMod rotate 931
  } }
railCore { { map gfx/misc/railcorethin_mono.tga blendFunc GL_ONE GL_ONE rgbGen vertex tcMod scroll -1 0
  } }
lightningBoltNew { cull none
  { map gfx/misc/lightning3new.tga blendFunc GL_ONE GL_ONE rgbgen wave sin 1 0.5 0 7.1
    tcmod scale 2 1
      tcMod scroll -5 0
        }
  { map gfx/misc/lightning3new.tga blendFunc GL_ONE GL_ONE rgbgen wave sin 1 0.8 0 8.1
    tcmod scale -1.3 -1
      tcMod scroll -7.2 0
        } }
plasmaExplosion { cull disable { clampmap models/weaphits/plasmaboom.tga blendfunc add
  tcMod stretch triangle .6 0.1 0 8
    tcmod rotate 999
      rgbGen wave inversesawtooth 0 1 0 1.5 } }
bulletExplosion { cull disable
  { animmap 5 models/weaphits/bullet1.tga models/weaphits/bullet2.tga
    rgbGen wave inversesawtooth 0 1 0 5 blendfunc add }
  { animmap 5 models/weaphits/bullet2.tga gfx/colors/black.tga
    rgbGen wave sawtooth 0 1 0 5 blendfunc add } }
rocketExplosion { cull disable
  { animmap 8 models/weaphits/rlboom/rlboom_1.tga models/weaphits/rlboom/rlboom_2.tga
    rgbGen wave inversesawtooth 0 1 0 8 blendfunc add }
  { animmap 8 models/weaphits/rlboom/rlboom_2.tga gfx/colors/black.tga
    rgbGen wave sawtooth 0 1 0 8 blendfunc add } }
railExplosion { cull disable
  { animmap 5 models/weaphits/ring02_1.tga models/weaphits/ring02_2.tga
    alphaGen wave inversesawtooth 0 1 0 5 blendfunc blend }
  { animmap 5 models/weaphits/ring02_2.tga models/weaphits/ring02_3.tga
    alphaGen wave sawtooth 0 1 0 5 blendfunc blend } }
models/mapobjects/gratelamp/gratelamp_flare { deformVertexes autoSprite cull none
  { map models/mapobjects/gratelamp/gratelamp_flare.tga blendFunc GL_ONE GL_ONE } }
bloodExplosion { cull disable
  { animmap 5 ${BLOOD_FRAMES.join(' ')}
    blendfunc blend } }
`;

/** A 2 × 2 white 32-bit TGA, top-left origin. */
function tga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 0x28];
  return new Uint8Array([...header, ...new Array(2 * 2 * 4).fill(255)]);
}

/** A single-frame MD3 with one triangle per surface, each surface naming one shader. */
function md3(...surfaces: Array<[name: string, shader: string]>): Uint8Array {
  const HEADER = 108;
  const FRAME = 56;
  const SURFACE_HEADER = 108;
  const SHADER = 68;
  const ofsTriangles = SURFACE_HEADER + SHADER;
  const ofsSt = ofsTriangles + 12;
  const ofsXyz = ofsSt + 3 * 8;
  const surfaceSize = ofsXyz + 3 * 8;
  const ofsSurfaces = HEADER + FRAME;

  const bytes = new Uint8Array(ofsSurfaces + surfaces.length * surfaceSize);
  const view = new DataView(bytes.buffer);
  const writeName = (at: number, text: string) => bytes.set(new TextEncoder().encode(text), at);

  view.setUint32(0, 0x33504449, true); // "IDP3"
  view.setInt32(4, 15, true);
  view.setInt32(76, 1, true); // numFrames
  view.setInt32(84, surfaces.length, true);
  view.setInt32(92, HEADER, true); // ofsFrames
  view.setInt32(96, ofsSurfaces, true); // ofsTags; there are none
  view.setInt32(100, ofsSurfaces, true);

  surfaces.forEach(([name, shader], index) => {
    const s = ofsSurfaces + index * surfaceSize;
    view.setUint32(s, 0x33504449, true);
    writeName(s + 4, name);
    view.setInt32(s + 72, 1, true); // numFrames
    view.setInt32(s + 76, 1, true); // numShaders
    view.setInt32(s + 80, 3, true); // numVerts
    view.setInt32(s + 84, 1, true); // numTriangles
    view.setInt32(s + 88, ofsTriangles, true);
    view.setInt32(s + 92, SURFACE_HEADER, true); // ofsShaders
    view.setInt32(s + 96, ofsSt, true);
    view.setInt32(s + 100, ofsXyz, true);
    view.setInt32(s + 104, surfaceSize, true);
    writeName(s + SURFACE_HEADER, shader);
    for (let v = 0; v < 3; v++) view.setInt32(s + ofsTriangles + v * 4, v, true);
    // A one-unit triangle in the Y–Z plane; positions are stored in 1/64 units.
    view.setInt16(s + ofsXyz + 8 + 2, 64, true);
    view.setInt16(s + ofsXyz + 16 + 4, 64, true);
  });
  return bytes;
}

/**
 * The weapon assets the tests draw: a rocket, a BFG ball, a grenade, the lightning's crackle,
 * the rail's impact ring and the bullet impact, plus shaders. Surface and shader names follow
 * pak0's.
 */
function syntheticLibrary(extra: [string, Uint8Array][] = []): AssetLibrary {
  const body = 'models/ammo/rocket/rocket';
  return new AssetLibrary(
    new Map([
      ...extra,
      ['scripts/effects.shader', new TextEncoder().encode(SHADERS)],
      [
        'models/ammo/rocket/rocket.md3',
        md3(['flash', 'rockfls1'], ['flare', 'rockflar'], ['rocket', body], ['fins', body])
      ],
      ['models/weaphits/bfg.md3', md3(['bfg01', 'bfg01'], ['bfg02', 'bfg02'])],
      ['models/ammo/grenade1.md3', md3(['grenade', 'models/ammo/grenade'])],
      ['models/weaphits/crackle.md3', md3(['crackle01', 'models/weaphits/electric.tga'])],
      ['models/weaphits/bullet.md3', md3(['Sphere02', 'models/weaphits/bullet1.tga'])],
      ['models/weaphits/ring02.md3', md3(['ring06', 'models/weaphits/ring01_1.tga'])],
      ['models/weaphits/boom01.md3', md3(['boom', 'models/weaphits/boom01.tga'])],
      ['gfx/misc/smokepuff3.tga', tga()],
      ['sprites/bubble.tga', tga()],
      ...BLOOD_FRAMES.map((frame): [string, Uint8Array] => [frame, tga()])
    ])
  );
}

const MUZZLE: Vec3 = { x: 0, y: 64, z: 0 };
const WALL: Vec3 = { x: 512, y: 0, z: 0 };
const FACING_BACK: Vec3 = { x: -1, y: 0, z: 0 };
const UP: Vec3 = { x: 0, y: 0, z: 1 };

let nextId = 1;

/**
 * A missile's entity leaving the muzzle along +X, as `fire_rocket` makes one.
 *
 * The client is only ever sent `s`, so that is all the renderer is given; the trajectory on it
 * is what answers where the rocket is on any frame.
 */
function missile(weapon: WeaponId): GameEntity {
  const spec = MISSILES[weapon]!;
  const entity = createGameEntity();
  entity.inuse = true;
  entity.s.number = nextId++;
  entity.s.eType = ET.MISSILE;
  entity.s.weapon = weapon;
  entity.s.pos.trType = spec.motion === 'gravity' ? TR.GRAVITY : TR.LINEAR;
  entity.s.pos.trTime = 0;
  entity.s.pos.trBase = { ...MUZZLE };
  entity.s.pos.trDelta = { x: spec.speed, y: 0, z: 0 };
  entity.r.currentOrigin = { ...MUZZLE };
  return entity;
}

/** The entities whose draws a layer shows, by name, sorted. */
function drawnBy(layer: Layer): string[] {
  return layer.meshInstances
    .filter((instance) => instance.visible)
    .map((instance) => instance.node.name)
    .sort();
}

/** A puff as its batch drew it: its corners in Quake units, and its colour's bytes. */
interface Stamp {
  corners: Vec3[];
  color: number[];
}

/** Where a puff is centred. */
function centre({ corners }: Stamp): Vec3 {
  const sum = corners.reduce((a, b) => vec3(a.x + b.x, a.y + b.y, a.z + b.z), vec3());
  return vec3(sum.x / 4, sum.y / 4, sum.z / 4);
}

/** A puff's radius: its first two corners are twice its left apart. */
function radiusOf({ corners: [a, b] }: Stamp): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / 2;
}

describe('WorldEffects layers', () => {
  let app: AppBase;
  let effects: WorldEffects | null;
  let world: Layer;
  let effectsLayer: Layer;
  let camera: Entity;
  /** The impacts' explosions, kept as the game keeps them; each starts as its impact strikes. */
  let explosions: Explosions;

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    explosions = new Explosions(() => 0);
    effects = await WorldEffects.create(app, syntheticLibrary(), test.camera);
    world = app.scene.layers.getLayerById(LAYERID_WORLD)!;
    effectsLayer = app.scene.layers.getLayerByName(EFFECTS_LAYER_NAME)!;
  });

  afterEach(() => {
    effects?.destroy();
    app.destroy();
  });

  /**
   * One frame, as the game runs it: this frame's impacts start their explosions, and then the
   * world effects draw everything, those explosions among it.
   */
  function play(...args: Parameters<WorldEffects['update']>): void {
    const [list, , time] = args;
    explosions.update(list, time, args[8]);
    // Any argument left out takes its default, as it would in a call of its own.
    args[7] = explosions.live;
    effects!.update(...args);
  }

  /**
   * Missiles as the view hands them over at `time`: each where its trajectory has it, and come into
   * view then if this is its first frame.
   */
  function drawn(time: number, ...states: EntityState[]): MissileCentity[] {
    return states.map((state) => ({
      state,
      origin: evaluateTrajectory(state.pos, time),
      trailTime: time
    }));
  }

  /** Put missiles in the world and draw their first frame. */
  function launch(...missiles: GameEntity[]): void {
    play([], drawn(0, ...missiles.map((launched) => launched.s)), 0);
  }

  /**
   * The player's own rail beam, from the gun to the wall, with or without something at the far
   * end, in the colour it was fired in: Q3's default red, unless it says otherwise.
   */
  function railBeam(hit: boolean, color = colorFromString(4)): WorldEffect {
    return {
      type: 'beam',
      weapon: WP.RAILGUN,
      start: MUZZLE,
      end: WALL,
      hit,
      own: true,
      color
    };
  }

  /** Another player's rail beam, from where their shot started to the wall, in their colour. */
  function theirRail(start: Vec3, color: Rgb): WorldEffect {
    return { type: 'beam', weapon: WP.RAILGUN, start, end: WALL, hit: false, own: false, color };
  }

  /** The player's own lightning bolt, from a gun's flash to where it ended. */
  function bolt(muzzle: Vec3, end: Vec3, hit: boolean): DrawnBolt {
    return { key: 0, muzzle, end, hit };
  }

  /** The impact event a shot of this weapon leaves, as the client reads it off an entity. */
  function impact(weapon: WeaponId, origin = WALL, normal = FACING_BACK): WorldEffect {
    return { type: 'impact', weapon, origin, normal };
  }

  /** The puffs drawn in a shader, in the order drawn. */
  function puffs(shader: MergedShader = 'smokePuff'): Stamp[] {
    const stamps: Stamp[] = [];
    const draws = effectsLayer.meshInstances
      .filter((draw) => draw.visible && draw.drawBucket === mergedBucket(shader))
      .sort((a, b) => a.drawOrder - b.drawOrder);
    for (const draw of draws) {
      const { base, count } = draw.mesh!.primitive[0];
      const storage = draw.mesh!.vertexBuffer.storage;
      const floats = new Float32Array(storage);
      const bytes = new Uint8Array(storage);
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

  /** The ranges the engine draws in a frame, in its order. */
  function rendered(): { base: number; count: number }[] {
    const ranges: { base: number; count: number }[] = [];
    const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation((primitive) => {
      ranges.push({ base: primitive.base, count: primitive.count });
    });
    app.render();
    draw.mockRestore();
    return ranges;
  }

  it('numbers its drawings in a scene: a missile as its entity, an impact as local', async () => {
    effects!.destroy();
    const scene = new SceneDraws(new SceneShaders(), {
      models: [world],
      effects: [],
      gun: [],
      screen: []
    });
    const library = syntheticLibrary();
    const pool = new LocalEntities();
    // One made before, so the impact's number is its own, not the one a drawing starts at.
    pool.alloc();
    explosions = new Explosions(() => 0, pool);
    effects = await WorldEffects.create(app, library, camera, undefined, pool, undefined, scene);
    const stand = new Layer({ name: 'scene' });
    app.scene.layers.push(stand);
    scene.enter({ layer: stand, fog: NO_SCENE_FOGS, key: () => {} });
    const rocket = missile(WP.ROCKET_LAUNCHER);
    play([impact(WP.ROCKET_LAUNCHER)], drawn(100, rocket.s), 100);
    // Every drawing in the scene, the effects' own layer standing empty.
    expect(effectsLayer.meshInstances).toEqual([]);
    const tagged = stand.meshInstances.map((instance) => sceneDraw(instance)!);
    expect(tagged.every((tag) => tag !== undefined)).toBe(true);
    const missileTags = tagged.filter((tag) => tag.entity.value === packetEntity(rocket.s.number));
    expect(missileTags.length).toBeGreaterThan(0);
    // The rocket's surfaces sort by their own shaders, a model's, at LIGHTMAP_NONE.
    expect(missileTags.every((tag) => tag.shader.lightmapIndex === LIGHTMAP_NONE)).toBe(true);
    // The impact's sprite in cgame's `customShader` for it, registered by name.
    const [exploded] = explosions.live;
    const impactTags = tagged.filter((tag) => tag.entity.value === localEntity(exploded.serial));
    expect([exploded.serial, impactTags.length > 0]).toEqual([1, true]);
    expect(impactTags.map((tag) => [tag.shader.name, tag.shader.lightmapIndex])).toEqual(
      impactTags.map(() => ['rocketExplosion', LIGHTMAP_2D])
    );
  });

  it("finds a model's fog by frame, a sprite's by radius, a beam's by its start", async () => {
    effects!.destroy();
    const own = { models: [world], effects: [], gun: [], screen: [] };
    const scene = new SceneDraws(new SceneShaders(), own);
    const lib = syntheticLibrary();
    effects = await WorldEffects.create(app, lib, camera, undefined, undefined, undefined, scene);
    const stand = new Layer({ name: 'scene' });
    app.scene.layers.push(stand);
    // One fog over all of it.
    const fogs = loadFogs(
      testBsp(fogParts([{ mins: [-4096, -4096, -4096], maxs: [4096, 4096, 4096], shader: 'fog' }])),
      () => ({ fogParms: { color: [1, 1, 1], depthForOpaque: 512 } })
    );
    const sceneFogs = new SceneFogs(fogs, [[255, 255, 255, 255]]);
    sceneFogs.view([0, 0, 0], [1, 0, 0]);
    scene.enter({ layer: stand, fog: sceneFogs, key: () => {} });
    play(
      [impact(WP.ROCKET_LAUNCHER), impact(WP.PLASMAGUN), railBeam(false)],
      drawn(100, missile(WP.ROCKET_LAUNCHER).s, missile(WP.PLASMAGUN).s),
      100
    );
    scene.order();
    const tags = stand.meshInstances.map((instance) => sceneDraw(instance)!);
    const by = (name: string) => tags.find((tag) => tag.shader.name === name)!.entity;
    expect(by('models/ammo/rocket/rocket').fogBy).toMatchObject({ kind: 'model', frame: 0 });
    expect(by('rocketExplosion').fogBy).toMatchObject({ kind: 'sprite' });
    expect((by('rocketExplosion').fogBy as { radius: number }).radius).toBeGreaterThan(0);
    expect(by('sprites/plasma1').fogBy).toMatchObject({ kind: 'sprite', radius: 16 });
    // The plasma's impact is its ring's model, found by that model's frame.
    const ring = by('plasmaExplosion').fogBy;
    expect(ring).toMatchObject({ kind: 'model', frame: 0 });
    expect(ring?.kind === 'model' && ring.frames.length).toBeGreaterThan(0);
    expect(by('railCore').fogBy).toEqual({ kind: 'sprite', radius: 0 });
    // Each is in the fog, keyed by it, its blended stages dimmed.
    for (const tag of tags) {
      if (tag.entity.fogBy) expect(tag.entity.fog, tag.shader.name).toBe(1);
    }
    const named = (draw: MeshInstance) => sceneDraw(draw)!.shader.name === 'rocketExplosion';
    const explosion = stand.meshInstances.find(named)!;
    expect((explosion.material as StandardMaterial).defines.has('Q3_FOG_RGB')).toBe(true);
    expect(held(explosion, FOG_UNIFORM)).toBe(by('rocketExplosion').fogData);
  });

  it("draws a rocket's glow in the effects layer and keeps its body in World", () => {
    launch(missile(WP.ROCKET_LAUNCHER));
    // `flash` and `flare` on the body's depthless child; `rocket` and `fins` on the body.
    expect(drawnBy(effectsLayer)).toEqual(['blended', 'blended']);
    expect(drawnBy(world)).toEqual([
      'models/ammo/rocket/rocket.md3',
      'models/ammo/rocket/rocket.md3'
    ]);
  });

  it('carries the split to every clone', () => {
    launch(missile(WP.BFG), missile(WP.BFG));
    // Two stages each for the glow and the shell, on each of the two balls.
    expect(drawnBy(effectsLayer)).toEqual(new Array(8).fill('blended'));
    expect(drawnBy(world)).toEqual([]);
  });

  it('draws the plasma bolt in the effects layer', () => {
    launch(missile(WP.PLASMAGUN));
    expect(drawnBy(effectsLayer)).toEqual(['plasma-bolt']);
    expect(drawnBy(world)).toEqual([]);
  });

  it("keeps a grenade's body in World, and draws its blinking light over it", () => {
    launch(missile(WP.GRENADE_LAUNCHER));
    expect(drawnBy(world)).toEqual(['models/ammo/grenade1.md3']);
    // `models/ammo/grenade`'s second stage: additive, over the body, in the effects layer.
    expect(drawnBy(effectsLayer)).toEqual(['blended']);
  });

  it('lays smoke trails in the effects layer, every puff in one draw', () => {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    play([], drawn(200, rocket.s), 200);
    // One puff per 50 ms mark after the first frame: 50, 100, 150 and 200.
    expect(puffs()).toHaveLength(4);
    expect(drawnBy(effectsLayer).filter((name) => name === 'world-effects')).toHaveLength(1);
    expect(drawnBy(world)).not.toContain('world-effects');
  });

  it("lays a missile's first smoke from the time the view reset it, as CG_RocketTrail does", () => {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    // First drawn 200 ms into its flight, come into view with a snapshot of 120.
    play([], [{ ...drawn(200, rocket.s)[0], trailTime: 120 }], 200);
    expect(puffs().map((puff) => Math.round(centre(puff).x))).toEqual([135, 180]);
    // From then on, from the last frame.
    play([], [{ ...drawn(250, rocket.s)[0], trailTime: 120 }], 250);
    expect(puffs().map((puff) => Math.round(centre(puff).x))).toEqual([135, 180, 225]);
  });

  it('draws the puffs before every other effect, smoke before haste’s', () => {
    // Q3 sorts by shader first, and cgame registers `smokePuff` and `hasteSmokePuff` before the
    // rocket's own shaders, so its glow draws over its smoke wherever the eye is.
    // Looking along +y from behind the muzzle, the rocket in view ahead of the eye: the puffs sort
    // at the eye, so their buckets alone put them before it.
    camera.setPosition(...simToWorld(vec3(100, -300, 0)));
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    play([{ type: 'hastePuff', origin: vec3(0, 400, 0) }], drawn(100, rocket.s), 100);
    // The body's two one-triangle surfaces in World; then the trail's two puffs, haste's puff, and
    // the glow's two surfaces.
    expect(rendered()).toEqual([
      { base: 0, count: 3 },
      { base: 0, count: 3 },
      { base: 0, count: 12 },
      { base: 0, count: 6 },
      { base: 0, count: 3 },
      { base: 0, count: 3 }
    ]);
  });

  it('turns each puff at random as it is thrown, and keeps the turn, as CG_SmokePuff does', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    play([{ type: 'puff', origin: vec3(0, 0, 24) }], [], 0);
    random.mockReturnValue(0.5);
    play([], [], 100);
    random.mockRestore();
    // A quarter turn in the view's plane: the eye looks along +y, so its left is −x and its up
    // +z, and the image's top left, at its left and up, is turned to its left and down.
    const [puff] = puffs();
    const { x, y, z } = centre(puff);
    const [topLeft] = puff.corners;
    expectClose([topLeft.x - x, topLeft.y - y, topLeft.z - z], [-32, 0, -32]);
  });

  it("lays each puff on the missile's real path, not where it was first seen", () => {
    // The trail is what makes the analytic trajectory visible: each mark is the point the
    // formula gives for that instant, so the smoke lies along the arc rather than along a chord
    // between two frames.
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    play([], drawn(200, rocket.s), 200);

    // 900 ups from the muzzle, at 50, 100, 150 and 200 ms, drawn in the order laid.
    const xs = puffs().map((puff) => centre(puff).x);
    expect(xs).toHaveLength(4);
    for (const [i, x] of xs.entries()) {
      expect(x).toBeCloseTo(MUZZLE.x + 0.9 * 50 * (i + 1), 4);
    }
  });

  it('throws a jump pad puff that does not grow, drifting up as it fades', () => {
    // `EV_JUMP_PAD`'s `CG_SmokePuff(cent->lerpOrigin, up, 32, 1, 1, 1, 0.33f, 1000, cg.time, 0,
    // LEF_PUFF_DONT_SCALE, smokePuffShader)` (`cg_event.c:662–668`), whose `up` is the velocity.
    play([{ type: 'puff', origin: vec3(0, 0, 24) }], [], 0);

    expect(puffs()).toHaveLength(1);
    expect(radiusOf(puffs()[0])).toBeCloseTo(32, 4);
    expect(centre(puffs()[0]).z).toBeCloseTo(24, 4);
    // White, at `0xff * 0.33` cut to a byte.
    expect(puffs()[0].color).toEqual([255, 255, 255, 84]);

    play([], [], 500);
    // `LEF_PUFF_DONT_SCALE`: the radius is 32 for its whole life, where a trail's puff grows.
    expect(radiusOf(puffs()[0])).toBeCloseTo(32, 4);
    expect(centre(puffs()[0]).z).toBeCloseTo(24.5, 4);
    expect(puffs()[0].color).toEqual([255, 255, 255, 42]);
  });

  it('throws a haste puff at the runner’s feet, growing as it fades', () => {
    // `CG_HasteTrail`'s `CG_SmokePuff(origin, vec3_origin, 8, 1, 1, 1, 1, 500, cg.time, 0, 0,
    // hastePuffShader)` with `leType = LE_SCALE_FADE` (`cg_players.c:1522–1532`): its colour
    // alpha is 1, where a trail's puff is thrown at 0.33.
    play([{ type: 'hastePuff', origin: vec3(0, 0, 8) }], [], 0);

    // In `hasteSmokePuff`, not `smokePuff` (`cg_main.c:882`).
    const haste = () => puffs('hasteSmokePuff');
    expect(puffs()).toEqual([]);
    expect(haste()).toHaveLength(1);
    // `radius * (1 - c) + 8`: 8 at birth and 16 as it dies.
    expect(radiusOf(haste()[0])).toBeCloseTo(8, 4);
    expect(haste()[0].color[3]).toBe(255);

    play([], [], 250);
    expect(radiusOf(haste()[0])).toBeCloseTo(12, 4);
    expect(haste()[0].color[3]).toBe(127);

    play([], [], 500);
    expect(haste()).toHaveLength(0);
  });

  it('lets a puff go when the view is inside it, as CG_AddScaleFade does', () => {
    // The pad's puff is thrown at the player's own feet, so in first person the view is inside
    // it and it is never drawn; from behind the body it is.
    const puff: WorldEffect = { type: 'puff', origin: vec3(0, 0, 24) };
    play([puff], [], 0, null, [], [], vec3(0, 0, 26));
    expect(puffs()).toHaveLength(0);

    play([puff], [], 0, null, [], [], vec3(0, 0, 200));
    expect(puffs()).toHaveLength(1);
  });

  it("measures the cull against a trail puff's base radius, not its grown one", () => {
    // `CG_AddScaleFade` compares the view's distance to `le->radius`, the style's, so a rocket
    // puff 40 units away goes even though it has only grown to a fraction of 64.
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    play([], drawn(200, rocket.s), 200, null, [], [], vec3(85, MUZZLE.y, 0));

    // Four puffs at x = 45, 90, 135 and 180, along the muzzle's own height: everything within
    // 64 of the eye goes but the last.
    const left = puffs();
    expect(left).toHaveLength(1);
    expect(centre(left[0]).x).toBeCloseTo(180, 4);
  });

  it('draws a missile where the view places it, and lays its smoke on its trajectory', () => {
    // The view can draw a missile ahead of its trajectory, as the projectile nudge does. Its
    // smoke runs to the trajectory at the frame's time, as `CG_RocketTrail` lays it.
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    const [flying] = drawn(200, rocket.s);
    const { x, y, z } = flying.origin;
    play([], [{ ...flying, origin: vec3(x + 50, y, z) }], 200);

    const body = world.meshInstances.find((instance) =>
      instance.node.name.includes('rocket')
    )!;
    expect(body.node.getLocalPosition().x).toBeCloseTo(MUZZLE.x + 0.9 * 200 + 50, 4);
    const xs = puffs().map((puff) => centre(puff).x);
    expect(Math.max(...xs)).toBeCloseTo(MUZZLE.x + 0.9 * 200, 4);
  });

  it('ends a projectile in an explosion in the effects layer', () => {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    // The missile is gone from the world and its impact is in its place, which is exactly what
    // the snapshot says: the entity stopped being a missile and became the event.
    play([impact(WP.ROCKET_LAUNCHER)], [], 100);
    expect(drawnBy(effectsLayer)).toEqual(['explosion', 'explosion']);
    expect(drawnBy(world)).toEqual([]);
  });

  it('draws an explosion from its start, set back as the list set it', () => {
    // `rand() & 63` at its most: the fireball begins 63 ms along its growth.
    const skewed = new Explosions(() => 0.999);
    skewed.update([impact(WP.ROCKET_LAUNCHER)], 1000);
    effects!.update([], [], 1000, null, [], [], null, skewed.live);
    const sprite = effectsLayer.meshInstances.find((i) => i.node.name === 'explosion')!.node;
    expect(sprite.getLocalScale().x).toBeCloseTo(explosionRadius(63 / 1000) * 2, 6);
    // And it goes when the list lets it go.
    effects!.update([], [], 1100, null, [], [], null, []);
    expect(effectsLayer.meshInstances.filter((i) => i.node.name === 'explosion')).toEqual([]);
  });

  it('points the explosion of a missile that ran out of time straight up', () => {
    // It struck nothing, so `G_ExplodeMissile` has no surface to face and points it up
    // (`g_missile.c:75`): the sprite rises 16 units above where the missile went off.
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    play([impact(WP.ROCKET_LAUNCHER, WALL, UP)], [], 100);
    const explosion = effectsLayer.meshInstances.find((i) => i.node.name === 'explosion')!;
    const position = explosion.node.getLocalPosition();
    expect([position.x, position.y, position.z]).toEqual([WALL.x, WALL.y, WALL.z + 16]);
  });

  /** A grappling hook out at the wall, thrown by slot 0 from the muzzle, in Q3's default red. */
  const hook: DrawnHook = { key: 0, position: WALL, start: MUZZLE, color1: colorFromString(4) };

  /** The node a layer draws under a name. */
  const nodeIn = (layer: Layer, name: string) =>
    layer.meshInstances.find((instance) => instance.node.name === name)!.node;

  /** Every node a layer draws under a name. */
  const nodesIn = (layer: Layer, name: string) =>
    layer.meshInstances.filter((instance) => instance.node.name === name).map(({ node }) => node);

  it('draws the hook as a rail-core pointer with a flare at its end, in the effects layer', () => {
    // CorkScrew's `CG_GrappleTrail`: no model at all, the rail core from the gun to the
    // hook, and the grate lamp's flare where the hook is.
    play([], [], 0, null, [], [hook]);
    expect(drawnBy(world)).toEqual([]);
    expect(drawnBy(effectsLayer)).toEqual(['grapple-flare', 'grapple-pointer']);

    const pointer = nodeIn(effectsLayer, 'grapple-pointer');
    const start = pointer.getLocalPosition();
    expect([start.x, start.y, start.z]).toEqual([MUZZLE.x, MUZZLE.y, MUZZLE.z]);
    expect(pointer.getLocalScale().x).toBeCloseTo(
      Math.hypot(WALL.x - MUZZLE.x, WALL.y - MUZZLE.y),
      4
    );
  });

  it("draws everybody's hook at once, each from its thrower's flash in their colour", () => {
    // `CG_GrappleTrail` runs for every hook entity, whoever threw it.
    const theirs: DrawnHook = {
      key: 3,
      position: { x: 512, y: 128, z: 0 },
      start: { x: 8, y: -4, z: -6 },
      color1: colorFromString(2)
    };
    play([], [], 0, null, [], [hook, theirs]);
    const starts = nodesIn(effectsLayer, 'grapple-pointer').map((node) => {
      const { x, y, z } = node.getLocalPosition();
      return [x, y, z];
    });
    expect(starts).toEqual([
      [MUZZLE.x, MUZZLE.y, MUZZLE.z],
      [8, -4, -6]
    ]);
    expect(nodesIn(effectsLayer, 'grapple-flare')).toHaveLength(2);
    // Red's, then green's, green and blue at three-quarters of each.
    const tints = ['grapple-pointer', 'grapple-flare'].flatMap((name) =>
      materialsOf(name).map(({ emissive }) =>
        [emissive.r, emissive.g, emissive.b].map((channel) => Math.round(channel * 100) / 100)
      )
    );
    expect(tints).toEqual([
      [1, 0, 0],
      [0, 0.75, 0],
      [1, 0, 0],
      [0, 0.75, 0]
    ]);

    // Theirs comes in, and only its pointer and flare go.
    play([], [], 8, null, [], [hook]);
    expect(drawnBy(effectsLayer)).toEqual(['grapple-flare', 'grapple-pointer']);
  });

  it('holds the flare 16 units in front of the hook, 9 to 11 units in radius', () => {
    play([], [], 0, null, [], [hook]);
    const flare = nodeIn(effectsLayer, 'grapple-flare');
    const at = flare.getLocalPosition();
    expect(Math.hypot(at.x - WALL.x, at.y - WALL.y, at.z - WALL.z)).toBeCloseTo(16, 4);
    // A sprite is sized by its edge: twice the radius.
    expect(flare.getLocalScale().x).toBeGreaterThanOrEqual(18);
    expect(flare.getLocalScale().x).toBeLessThanOrEqual(22);
  });

  it('puts the pointer and its flare away once the hook is in', () => {
    play([], [], 0, null, [], [hook]);
    play([], [], 8, null, [], []);
    expect(drawnBy(effectsLayer)).toEqual([]);
  });

  /** A laser at (0 0 64) whose beam stops 300 along +X. */
  const laser: DrawnLaser = { key: 70, start: vec3(0, 0, 64), end: vec3(300, 0, 64) };

  /** One frame with these lasers sent, and nothing else. */
  const playLasers = (time: number, ...lasers: DrawnLaser[]) =>
    play([], [], time, null, [], [], null, [], undefined, lasers);

  it('draws a laser as a red tube from the laser to where its beam stopped', () => {
    playLasers(0, laser);
    expect(drawnBy(world)).toEqual([]);
    expect(drawnBy(effectsLayer)).toEqual(['target-laser']);

    const tube = nodeIn(effectsLayer, 'target-laser');
    const at = tube.getLocalPosition();
    expect([at.x, at.y, at.z]).toEqual([0, 0, 64]);
    expect(tube.getLocalScale().x).toBeCloseTo(300, 4);
    // Along the beam, its first corner along `PerpendicularVector` of it, here +Y.
    const along = tube.getLocalRotation().transformVector(new EngineVec3(1, 0, 0));
    const corner = tube.getLocalRotation().transformVector(new EngineVec3(0, 1, 0));
    expect([along.x, along.y, along.z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0]);
    expect([corner.x, corner.y, corner.z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      0, 1, 0
    ]);

    const [material] = materialsOf('target-laser');
    expect([material.emissive.r, material.emissive.g, material.emissive.b]).toEqual([1, 0, 0]);
    expect(material.blendType).toBe(BLEND_ADDITIVE);
    expect(material.depthWrite).toBe(false);
  });

  it("lays a hexagon four units out at either end, its faces out", () => {
    playLasers(0, laser);
    const mesh = effectsLayer.meshInstances.find((i) => i.node.name === 'target-laser')!.mesh!;
    const positions: number[] = [];
    mesh.getPositions(positions);
    const radii = [];
    for (let i = 0; i < positions.length; i += 3) {
      radii.push(Math.round(Math.hypot(positions[i + 1], positions[i + 2]) * 1e6) / 1e6);
    }
    expect(radii).toEqual(Array(12).fill(4));
    const xs = positions.filter((_, i) => i % 3 === 0);
    expect(xs).toEqual([...Array(6).fill(0), ...Array(6).fill(1)]);
    // Each side's first triangle turns from a corner to the next, then to the far end: outward.
    const indices: number[] = [];
    mesh.getIndices(indices);
    const [a, b, c] = indices
      .slice(0, 3)
      .map((i) => new EngineVec3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
    const normal = new EngineVec3().cross(new EngineVec3().sub2(b, a), new EngineVec3().sub2(c, a));
    const outward = new EngineVec3(0, (a.y + b.y) / 2, (a.z + b.z) / 2);
    expect(normal.dot(outward)).toBeGreaterThan(0);
  });

  it('draws every laser sent, and puts away one no longer sent', () => {
    const other: DrawnLaser = { key: 71, start: vec3(10, 10, 10), end: vec3(10, 10, 500) };
    playLasers(0, laser, other);
    expect(nodesIn(effectsLayer, 'target-laser')).toHaveLength(2);
    playLasers(8, other);
    expect(nodesIn(effectsLayer, 'target-laser')).toHaveLength(1);
    expect(nodeIn(effectsLayer, 'target-laser').getLocalScale().x).toBeCloseTo(490, 4);
  });

  it('draws no beam of no length, as Quake 3 draws none', () => {
    playLasers(0, { key: 70, start: vec3(1, 2, 3), end: vec3(1, 2, 3) });
    expect(drawnBy(effectsLayer)).toEqual([]);
  });

  it("draws the pointer and its flare in the hook's colour, over what is behind them", () => {
    // Added light cannot show on a white map, so both draw over it instead, with the colour
    // as a flat emissive and the texture's brightness as the opacity. The colour is `color1`'s,
    // green and blue at three-quarters: red by default, and pale where `color1` is white.
    const cases = [
      [4, [1, 0, 0]],
      [7, [1, 0.75, 0.75]]
    ] as const;
    for (const [color1, expected] of cases) {
      play([], [], 0, null, [], [{ ...hook, color1: colorFromString(color1) }]);
      for (const name of ['grapple-pointer', 'grapple-flare']) {
        const materials = materialsOf(name);
        expect(materials, name).not.toHaveLength(0);
        for (const material of materials) {
          expect(material.blendType, name).toBe(BLEND_NORMAL);
          expect(material.emissiveMap, name).toBeNull();
          const { r, g, b } = material.emissive;
          [r, g, b].forEach((channel, i) => expect(channel, `${name}, color1 ${color1}`).toBeCloseTo(expected[i], 6));
        }
      }
    }
  });

  it("keeps the rail's own trail added, in its own colour, while the pointer is out", () => {
    // The pointer draws its own clones of the rail core's materials.
    const white = { ...hook, color1: colorFromString(7) };
    play([], [], 0, null, [], [white]);
    play([railBeam(false, colorFromString(7))], [], 8, null, [], [white]);
    const [core] = materialsOf('beam');
    expect(core.blendType).toBe(BLEND_ADDITIVE);
    // White `color1`: the core grey at three-quarters, where the pointer is pale red.
    const { r, g, b } = core.emissive;
    expect([r, g, b]).toEqual([0.75, 0.75, 0.75]);
  });

  it('draws the rail core at three-quarters of color1 as it fades, in the colour it was fired in', () => {
    // `CG_RailTrail` starts `LE_FADE_RGB` at three-quarters of `color1`: red by default.
    play([railBeam(false)], [], 0);
    const [core] = materialsOf('beam');
    expect([core.emissive.r, core.emissive.g, core.emissive.b]).toEqual([0.75, 0, 0]);

    // Half its 400 ms later it is still red, at half.
    play([], [], 200);
    expect(core.emissive.r).toBeCloseTo(0.375, 6);
    expect([core.emissive.g, core.emissive.b]).toEqual([0, 0]);
  });

  it('draws a rail beam and its impact, and no beam at all for a lightning shot', () => {
    // `EV_RAILTRAIL` is one event that says both things; the lightning gun sends no beam, because
    // its bolt is drawn from the gun every frame instead.
    play(
      [railBeam(true), impact(WP.RAILGUN), impact(WP.LIGHTNING)],
      [],
      0
    );
    // The rail's one-stage core and the ring's two stages. The lightning gun's impact draws
    // nothing at all: `CG_MissileHitWall` gives it no explosion, only a mark and a sound.
    expect(drawnBy(effectsLayer)).toEqual([
      'beam',
      'models/weaphits/ring02.md3',
      'models/weaphits/ring02.md3'
    ]);
    expect(drawnBy(world)).toEqual([]);
  });

  it('takes every impact, beam and puff away, as a restart does', () => {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    const haste: WorldEffect = { type: 'hastePuff', origin: UP };
    play([railBeam(true), impact(WP.RAILGUN), haste], drawn(200, rocket.s), 200);
    expect(drawnBy(effectsLayer)).toEqual(
      expect.arrayContaining(['beam', 'models/weaphits/ring02.md3', 'world-effects'])
    );

    explosions.clear();
    effects!.clear();
    // At once, though no frame may follow it.
    expect([puffs(), puffs('hasteSmokePuff')]).toEqual([[], []]);
    // The rocket goes with the simulation's, at the next update.
    play([], [], 210);
    expect(drawnBy(effectsLayer)).toEqual([]);
    expect(drawnBy(world)).toEqual([]);
  });

  /** The world effects again, in a world whose contents these are. */
  async function inWorld(contents: PointContentsFn, pool?: LocalEntities): Promise<void> {
    effects!.destroy();
    effects = await WorldEffects.create(app, syntheticLibrary(), camera, undefined, pool, contents);
    effectsLayer = app.scene.layers.getLayerByName(EFFECTS_LAYER_NAME)!;
  }

  /**
   * A rocket from the muzzle, drawn at its launch and 200 ms on, 180 units along, `random()`
   * handing out `draw` for that second frame's effects.
   */
  function rocketFor200(draw?: number): void {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    // Not for the launch's: the engine draws each entity's guid from it.
    const random = draw === undefined ? null : vi.spyOn(Math, 'random').mockReturnValue(draw);
    play([], drawn(200, rocket.s), 200);
    random?.mockRestore();
  }

  it('lays no smoke from a missile in water, but bubbles 8 apart from its last frame', async () => {
    await inWorld(() => CONTENTS.WATER);
    // `rand() % 8` is 0: the first at the last frame's place.
    rocketFor200(0);
    expect(puffs()).toEqual([]);
    const bubbles = puffs('waterBubble');
    expectClose(
      bubbles.map((bubble) => centre(bubble).x),
      Array.from({ length: 23 }, (_, i) => i * 8)
    );
    for (const bubble of bubbles) {
      expect(radiusOf(bubble)).toBeCloseTo(3, 4);
      expect(centre(bubble).y).toBeCloseTo(MUZZLE.y, 4);
      expect(bubble.color).toEqual([255, 255, 255, 255]);
    }
  });

  it('lays neither in slime or lava, nor where its last frame was out of the water', async () => {
    for (const contents of [CONTENTS.SLIME, CONTENTS.LAVA]) {
      await inWorld(() => contents);
      rocketFor200();
      expect([puffs(), puffs('waterBubble')], String(contents)).toEqual([[], []]);
    }
    // In the water 180 out, and not where it was at its launch.
    await inWorld((point) => (point.x > 100 ? CONTENTS.WATER : 0));
    rocketFor200();
    expect([puffs(), puffs('waterBubble')]).toEqual([[], []]);
  });

  it('lays smoke as ever from a missile out of the water, at marks in it and all', async () => {
    // `CG_RocketTrail` asks only where the missile is now.
    await inWorld((point) => (point.x < 100 ? CONTENTS.WATER : 0));
    rocketFor200();
    expect(puffs().map((puff) => Math.round(centre(puff).x))).toEqual([45, 90, 135, 180]);
    expect(puffs('waterBubble')).toEqual([]);
  });

  it('lays no smoke from a grenade at rest, as one in flight lays it', () => {
    const resting = missile(WP.GRENADE_LAUNCHER);
    resting.s.pos.trType = TR.STATIONARY;
    resting.s.pos.trBase = vec3(-500, 0, 0);
    const flying = missile(WP.GRENADE_LAUNCHER);
    launch(resting, flying);
    play([], drawn(200, resting.s, flying.s), 200);
    expect(puffs()).toHaveLength(4);
    for (const puff of puffs()) expect(centre(puff).x).toBeGreaterThan(0);
  });

  it("draws a pellet's bubbles, rising and fading for a second and a bit, the view in them", () => {
    // `rand() % 32` is 16, each lives 1125 ms and drifts straight up at 6.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const line: WorldEffect = { type: 'bubbles', start: vec3(), end: vec3(100, 0, 0), spacing: 32 };
    // The view at the first: no bubble is let go for it, as `le->radius` is never set.
    play([line], [], 1000, null, [], [], vec3(16, 0, 0));
    random.mockRestore();
    const at = () => puffs('waterBubble').map((bubble) => centre(bubble));
    expectClose(at().flatMap(({ x, y, z }) => [x, y, z]), [16, 0, 0, 48, 0, 0, 80, 0, 0]);
    const [first] = puffs('waterBubble');
    expect(radiusOf(first)).toBeCloseTo(3, 4);
    expect(first.color).toEqual([255, 255, 255, 255]);
    // Unturned: the eye looks along +y, so its top left is to the left, −x, and up.
    const { x, y, z } = centre(first);
    const [topLeft] = first.corners;
    expectClose([topLeft.x - x, topLeft.y - y, topLeft.z - z], [-3, 0, 3]);

    play([], [], 1500, null, [], [], vec3(16, 0, 3));
    expectClose(at().map(({ z: height }) => height), [3, 3, 3]);
    // `0xff * c`, c 625 of the 1125 left.
    expect(puffs('waterBubble')[0].color).toEqual([255, 255, 255, 141]);
    play([], [], 2124);
    expect(at()).toHaveLength(3);
    play([], [], 2125);
    expect(at()).toEqual([]);
  });

  it('holds a place for each bubble, gives it up for a newer, and clears it', async () => {
    const pool = new LocalEntities();
    await inWorld(() => 0, pool);
    const line: WorldEffect = { type: 'bubbles', start: vec3(), end: vec3(100, 0, 0), spacing: 32 };
    play([line], [], 0);
    expect(pool.count).toBe(puffs('waterBubble').length);
    const laid = pool.count;
    expect(laid).toBeGreaterThan(1);
    for (let i = laid; i <= MAX_LOCAL_ENTITIES; i++) pool.alloc();
    play([], [], 10);
    expect(puffs('waterBubble')).toHaveLength(laid - 1);
    effects!.clear();
    expect(puffs('waterBubble')).toEqual([]);
    expect(pool.count).toBe(MAX_LOCAL_ENTITIES - (laid - 1));
  });

  it('draws the lightning bolt and its crackle in the effects layer', () => {
    play([], [], 0, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    // The bolt's two stages, and the crackle's one additive surface on its depthless child.
    expect(drawnBy(effectsLayer)).toEqual(['blended', 'lightning-bolt', 'lightning-bolt']);
    expect(drawnBy(world)).toEqual([]);
  });

  it('turns a rail impact out of the surface it struck', () => {
    play([impact(WP.RAILGUN)], [], 0);
    const ring = effectsLayer.meshInstances.find(
      (instance) => instance.node.name === 'models/weaphits/ring02.md3'
    )!.node;
    // `CG_MakeExplosion` lays the model's forward axis along the normal, then rolls it.
    const axis = ring.getLocalRotation().transformVector(new EngineVec3(1, 0, 0));
    expect(axis.x).toBeCloseTo(-1, 6);
    expect(axis.y).toBeCloseTo(0, 6);
    expect(axis.z).toBeCloseTo(0, 6);
  });

  it("draws a rail ring's two blends in its shader's order, both sorted at the impact", () => {
    play([impact(WP.RAILGUN)], [], 0);
    const [under, over] = effectsLayer.meshInstances.filter(
      (instance) => instance.node.name === 'models/weaphits/ring02.md3'
    );
    expect([under.drawOrder, over.drawOrder]).toEqual([0, 1]);
    const eye = camera.getPosition();
    const forward = camera.forward;
    const along = new EngineVec3().sub2(under.node.getPosition(), eye).dot(forward);
    expect(under.calculateSortDistance!(under, eye, forward)).toBeCloseTo(along, 9);
    expect(over.calculateSortDistance!(over, eye, forward)).toBeCloseTo(along - ORDER_STEP, 9);
  });

  it('leaves no impact where a beam missed', () => {
    play([railBeam(false)], [], 0);
    expect(drawnBy(effectsLayer)).toEqual(['beam']);
  });

  /** The materials of every draw an entity of this name holds, in draw-list order. */
  function materialsOf(name: string): StandardMaterial[] {
    return [...effectsLayer.meshInstances, ...world.meshInstances]
      .filter((instance) => instance.node.name === name)
      .map((instance) => instance.material as StandardMaterial);
  }

  /** The material of the crackle's draw, drawn apart from its model in the effects layer. */
  function crackleMaterial(): StandardMaterial {
    return effectsLayer.meshInstances.find(
      (instance) => instance.node.parent?.name === 'models/weaphits/crackle.md3'
    )!.material as StandardMaterial;
  }

  /** The material of the first draw of the impact with this name. */
  function impactMaterial(name: string): StandardMaterial {
    return materialsOf(name)[0];
  }

  it('draws a plasma impact as the ring model, in the effects layer', () => {
    const plasma = missile(WP.PLASMAGUN);
    launch(plasma);
    play([impact(WP.PLASMAGUN)], [], 100);
    expect(drawnBy(effectsLayer)).toEqual(['models/weaphits/ring02.md3']);
    expect(drawnBy(world)).toEqual([]);
  });

  it('plays a model impact through its shader: the plasma fades, breathes and spins', () => {
    const plasma = missile(WP.PLASMAGUN);
    launch(plasma);
    play([impact(WP.PLASMAGUN)], [], 100);
    const material = impactMaterial('models/weaphits/ring02.md3');
    expect(material.emissive.r).toBeCloseTo(1, 6);
    expect(material.emissiveMapTiling.x).toBeCloseTo(1 / 0.6, 6);

    play([], [], 400);
    // 300 ms in: rgbGen wave inversesawtooth at 1.5 Hz, tcMod rotate 999.
    expect(material.emissive.r).toBeCloseTo(0.55, 6);
    // −299.7°, which reaches PlayCanvas as the same turn: 60.3°.
    expect(material.emissiveMapRotation).toBeCloseTo(60.3, 6);
  });

  it("cross-fades a bullet impact's two stages, as its shader does", () => {
    play([impact(WP.MACHINEGUN)], [], 0);
    const [first, second] = materialsOf('models/weaphits/bullet.md3');
    // `inversesawtooth` and `sawtooth` at 5 Hz: one frame fades out as the next fades in, so
    // the two always add up to full.
    for (const [time, out] of [[0, 1], [100, 0.5], [150, 0.25]]) {
      play([], [], time);
      expect(first.emissive.r, `${time} ms`).toBeCloseTo(out, 6);
      expect(second.emissive.r, `${time} ms`).toBeCloseTo(1 - out, 6);
    }
  });

  it.each([
    ['machinegun', WP.MACHINEGUN],
    ['shotgun', WP.SHOTGUN]
  ])('draws a %s impact in the effects layer, after the splat map', (_name, weapon) => {
    play([impact(weapon)], [], 0);
    expect(drawnBy(effectsLayer)).toEqual([
      'models/weaphits/bullet.md3',
      'models/weaphits/bullet.md3'
    ]);
    expect(drawnBy(world)).toEqual([]);
  });

  it('lights a sprite explosion by its shader alone, not by the 0.33 taper', () => {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    launch(rocket);
    play([impact(WP.ROCKET_LAUNCHER)], [], 100);
    const [first, second] = materialsOf('explosion');
    // Full brightness at impact, where the taper would have started at a third.
    expect(first.emissive.r).toBeCloseTo(1, 6);
    expect(second.emissive.r).toBeCloseTo(0, 6);
    // 8 Hz: half-way through the first frame, the two meet at half each.
    play([], [], 162.5);
    expect(first.emissive.r).toBeCloseTo(0.5, 6);
    expect(second.emissive.r).toBeCloseTo(0.5, 6);
  });

  it("fades a rail impact's two blended stages by alphaGen wave, and draws them in order", () => {
    play([impact(WP.RAILGUN)], [], 0);
    const [first, second] = materialsOf('models/weaphits/ring02.md3');
    expect(first.opacity).toBeCloseTo(1, 6);
    expect(second.opacity).toBeCloseTo(0, 6);
    play([], [], 100);
    expect(first.opacity).toBeCloseTo(0.5, 6);
    expect(second.opacity).toBeCloseTo(0.5, 6);

    // Blending doesn't commute, so the order has to be the shader's. The engine sorts the two
    // by one key, since they share a mesh and a transform, and keeps the order they came in.
    camera.setPosition(0, 0, 0);
    camera.lookAt(16, 0, 0); // the wall, in metres
    app.render();
    const sorted = (
      effectsLayer as unknown as {
        getCulledInstances(camera: unknown): { transparent: MeshInstance[] };
      }
    )
      .getCulledInstances(camera.camera!.camera)
      .transparent.map((instance) => instance.material);
    expect(sorted).toContain(first);
    expect(sorted.indexOf(first)).toBeLessThan(sorted.indexOf(second));
  });

  it("draws the BFG's impact bare, its model in the rail's shader, where it has no blast", () => {
    const bare = { ...ID_MISSILE_LOOKS, bfgSplashRadius: 0 };
    play([impact(WP.BFG)], [], 0, null, [], [], null, [], bare);
    const drawn = effectsLayer.meshInstances.filter(
      (instance) => instance.node.name === 'models/weaphits/boom01.md3'
    );
    // `railExplosion`'s two stages, over the model's one surface.
    expect(drawn).toHaveLength(2);
    expect(materialsOf('models/weaphits/boom01.md3')[0].opacity).toBeCloseTo(1, 6);
    expect(drawnBy(effectsLayer)).not.toContain('explosion');

    // id's is not.
    play([impact(WP.BFG)], [], 700);
    expect(drawnBy(effectsLayer)).not.toContain('models/weaphits/boom01.md3');
  });

  it("draws the plasma's ring at the serverinfo's mark over 16", () => {
    play([impact(WP.PLASMAGUN)], [], 0, null, [], [], null, [], {
      ...ID_MISSILE_LOOKS,
      plasmaMarkSize: 8
    });
    play([impact(WP.PLASMAGUN)], [], 0);
    const rings = effectsLayer.meshInstances
      .filter((instance) => instance.node.name === 'models/weaphits/ring02.md3')
      .map((instance) => instance.node.getLocalScale().x);
    expect(rings.sort()).toEqual([0.5, 1]);
  });

  it("draws the plasma bolt at the serverinfo's size", () => {
    const bolt = missile(WP.PLASMAGUN);
    play([], drawn(0, bolt.s), 0, null, [], [], null, [], { ...ID_MISSILE_LOOKS, plasmaSize: 8 });
    const sprite = effectsLayer.meshInstances.find((i) => i.node.name === 'plasma-bolt')!.node;
    expect(sprite.getLocalScale().x).toBeCloseTo(16, 6);
    play([], drawn(8, bolt.s), 8);
    expect(sprite.getLocalScale().x).toBeCloseTo(32, 6);
  });

  it('spins every plasma bolt on the game clock, together', () => {
    const first = missile(WP.PLASMAGUN);
    const second = missile(WP.PLASMAGUN);
    launch(first);
    play([], drawn(500, first.s, second.s), 500);
    const [a, b] = materialsOf('plasma-bolt');
    // One material at one moment: `CG_Missile` sets no `shaderTime`.
    expect(a).toBe(b);
    // `tcMod rotate 931` half a second into the game: −465.5°, the same turn as −105.5°.
    expect(a.emissiveMapRotation).toBeCloseTo(-105.5, 6);
  });

  it('plays the stages every copy shares only while a copy is drawn', () => {
    launch(missile(WP.PLASMAGUN));
    const [plasma] = materialsOf('plasma-bolt');
    // Gone: `tcMod rotate 931` stays as its last draw, at the game's start, left it.
    play([], [], 500);
    expect(plasma.emissiveMapRotation).toBe(0);
    // Another, half a second into the game, turns it to that moment.
    play([], drawn(500, missile(WP.PLASMAGUN).s), 500);
    expect(plasma.emissiveMapRotation).toBeCloseTo(-105.5, 6);
  });

  it("swirls the BFG ball: its glow's two stages turn opposite ways", () => {
    const ball = missile(WP.BFG);
    launch(ball);
    play([], drawn(250, ball.s), 250);
    const [turning, back] = materialsOf('blended').filter((material) =>
      material.defines.has('Q3_DEFORM_SPRITE')
    );
    // `tcMod rotate 333` and `-100`, a quarter of a second in.
    expect(turning.emissiveMapRotation).toBeCloseTo(-83.25, 6);
    expect(back.emissiveMapRotation).toBeCloseTo(25, 6);
  });

  it('draws the BFG ball at twice a default stage, as fullscreen Q3 does', () => {
    const ball = missile(WP.BFG);
    launch(ball);
    play([], drawn(250, ball.s), 250);
    // Its glow and its trail are all `rgbGen identity`, which escapes the half that Q3's gamma
    // ramp doubles back.
    const stages = materialsOf('blended');
    expect(stages).toHaveLength(4);
    for (const material of stages) expect(material.emissive.r).toBe(2);
  });

  /** A rocket fired up and to the side, so that it is turned from the world's own frame. */
  function climbing(): GameEntity {
    const rocket = missile(WP.ROCKET_LAUNCHER);
    rocket.s.pos.trDelta = { x: 0, y: 600, z: 600 };
    return rocket;
  }

  /** The draws of the rockets' lit bodies, in World. */
  function rocketBodies(): MeshInstance[] {
    return world.meshInstances.filter(
      (instance) => instance.node.name === 'models/ammo/rocket/rocket.md3'
    );
  }

  it('lights each missile by a light of its own, by how it is turned, as Q3 lights every entity', () => {
    play([], drawn(50, climbing().s, missile(WP.ROCKET_LAUNCHER).s), 50);
    const bodies = rocketBodies();
    expect(bodies).toHaveLength(4);
    // Each rocket's own, which both its surfaces draw by.
    expect(new Set(bodies.map((body) => held(body, 'q3_light[0]'))).size).toBe(2);
    for (const body of bodies) {
      expect(held(body, 'q3_frames')).toBeInstanceOf(Texture);
      expectClose(uniform(body, 'q3_light[0]'), lightUniform(lightInEntity(body.node as Entity)));
      expect((body.material as StandardMaterial).emissive.r).toBe(2);
    }
    // And the glow over it, drawn apart.
    const glow = effectsLayer.meshInstances.find(
      (instance) => instance.node.parent === bodies[0].node
    )!;
    expect(held(glow, 'q3_light[0]')).toBe(held(bodies[0], 'q3_light[0]'));
  });

  it("lights a missile where it flies, the scene's lights folded in", async () => {
    effects!.destroy();
    const lights = new SceneLights();
    lights.add({ x: 0, y: 0, z: 100 }, 200, [1, 0.75, 0]);
    effects = await WorldEffects.create(app, syntheticLibrary(), camera, lights);
    effects.update([], drawn(50, climbing().s), 50);
    for (const body of rocketBodies()) {
      const node = body.node as Entity;
      const at = node.getPosition();
      const lit = entityLightAt(worldToSim(at.x, at.y, at.z), lights);
      expect(lit.directed[0]).toBeGreaterThan(entityLight().directed[0]);
      expectClose(uniform(body, 'q3_light[0]'), lightUniform(lightInEntity(node, lit)));
    }
  });

  it('stamps the BFG glow by where the camera looks, each ball by its own view', () => {
    camera.setEulerAngles(10, 60, 0);
    const [one, two] = [missile(WP.BFG), missile(WP.BFG)];
    launch(one, two);
    play([], drawn(16, one.s, two.s), 16);
    const stamps = effectsLayer.meshInstances.filter(
      (instance) => (instance.material as StandardMaterial).defines.has('Q3_DEFORM_SPRITE')
    );
    expect(stamps).toHaveLength(4);
    expect(new Set(stamps.map((stamp) => held(stamp, 'q3_view[0]'))).size).toBe(2);
    for (const stamp of stamps) {
      const view = new Float32Array(16);
      writeView(deformView(stamp.node, camera), view);
      expectClose(uniform(stamp, 'q3_view[0]'), view);
    }
  });

  it("ripples the BFG trail by its uniform, and binds the crackle's copy", () => {
    const ball = missile(WP.BFG);
    launch(ball);
    play([], drawn(250, ball.s), 250);
    // The trail's two stages, drawn apart with the glow's.
    const [still, rippling] = effectsLayer.meshInstances.filter(
      (instance) =>
        instance.node.name === 'blended' &&
        instance.node.parent!.name === 'models/weaphits/bfg.md3' &&
        !(instance.material as StandardMaterial).defines.has('Q3_DEFORM_SPRITE')
    );
    const material = rippling.material as StandardMaterial;
    expect([material.defines.get('Q3_TCMOD'), material.emissiveMapUv]).toEqual([true, 0]);
    // `turb 0 .25 0 1.6` at 0.25 s, and a still stage's coordinates as the surface hands them.
    expectClose(uniform(rippling, 'q3_coords[0]').slice(0, 15), [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.25, 0.4, 0]);
    expect(uniform(still, 'q3_coords[0]')[0]).toBe(0);

    play([], [], 300, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    const crackle = effectsLayer.meshInstances.find(
      (instance) => instance.node.parent?.name === 'models/weaphits/crackle.md3'
    )!;
    expect(held(crackle, 'q3_frames')).toBeInstanceOf(Texture);
    // Lit as it is turned, whichever way it was thrown this frame.
    const turned = lightInEntity(crackle.node.parent as Entity);
    expectClose(uniform(crackle, 'q3_light[0]'), lightUniform(turned));
  });

  it('scrolls the rail core from its own start, and dims it as it fades', () => {
    play([railBeam(false)], [], 1000);
    const [core] = materialsOf('beam');
    play([], [], 1250);
    // `tcMod scroll -1 0` since the trail appeared: a quarter of a repeat, backwards.
    expect(core.emissiveMapOffset.x).toBeCloseTo(0.75, 6);
    // The texture still repeats every 256 units of the beam.
    expect(core.emissiveMapTiling.x).toBeCloseTo(Math.hypot(512, 64) / 256, 6);
    // `LE_FADE_RGB`, 250 ms into a 400 ms trail, from three-quarters of the default red `color1`.
    expect(core.emissive.r).toBeCloseTo(0.75 * 0.375, 6);
    expect(core.emissive.g).toBe(0);
  });

  it("plays the lightning's two bolts on the game clock", () => {
    play([], [], 1000, MUZZLE, [bolt(MUZZLE, WALL, false)]);
    const [first, second] = materialsOf('lightning-bolt');
    // `tcMod scroll -5 0` and `-7.2 0` one second into the game, though the bolt is brand new.
    expect(first.emissiveMapOffset.x).toBeCloseTo(0, 6);
    expect(second.emissiveMapOffset.x).toBeCloseTo(0.8, 6);
    // `tcmod scale -1.3 -1` mirrors the second bolt: a half turn, in PlayCanvas' terms.
    expect(Math.abs(second.emissiveMapRotation)).toBeCloseTo(180, 6);
  });

  it("turns the crackle on the game clock only while a bolt's crackle shows", () => {
    play([], [], 1100, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    const crackle = crackleMaterial();
    // `tcMod rotate 360`, 1.1 s into the game: −396°, the same turn as −36°.
    expect(crackle.emissiveMapRotation).toBeCloseTo(-36, 6);
    // A miss shows no crackle, and its stage holds where it was.
    play([], [], 1200, MUZZLE, [bolt(MUZZLE, WALL, false)]);
    expect(crackle.emissiveMapRotation).toBeCloseTo(-36, 6);
    play([], [], 1250, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    expect(crackle.emissiveMapRotation).toBeCloseTo(-90, 6);
  });

  it('keeps one lightning bolt, laid from the gun afresh every frame', () => {
    play([], [], 1000, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    // Strafed to the side: the next frame's bolt starts at the gun's new place at once, not
    // where a shot left it.
    const moved: Vec3 = { x: 0, y: -64, z: 0 };
    const struck: Vec3 = { x: 512, y: -128, z: 0 };
    play([], [], 1016, moved, [bolt(moved, struck, true)]);

    const bolts = effectsLayer.meshInstances.filter(
      (instance) => instance.node.name === 'lightning-bolt'
    );
    expect(bolts).toHaveLength(2);
    expect(bolts[0].node.getLocalPosition().y).toBeCloseTo(-64, 6);
    expect(bolts[0].node.getLocalScale().x).toBeCloseTo(Math.hypot(512, 64), 6);
    // At full strength: Q3's bolt has no fade. Both waves climb past 1 at this moment, and
    // fullscreen Q3 shows them there.
    const waves: Wave[] = [
      { func: 'sin', base: 1, amplitude: 0.5, phase: 0, frequency: 7.1 },
      { func: 'sin', base: 1, amplitude: 0.8, phase: 0, frequency: 8.1 }
    ];
    const materials = materialsOf('lightning-bolt');
    expect(materials).toHaveLength(2);
    materials.forEach((material, index) => {
      const glow = evalWave(waves[index], 1.016);
      expect(glow).toBeGreaterThan(1);
      expect(material.emissive.r).toBeCloseTo(glow, 6);
    });
  });

  it("draws each gun's lightning bolt from its own flash, and hides one whose flash is out", () => {
    const theirs: Vec3 = { x: 0, y: -64, z: 0 };
    const other: DrawnBolt = { key: 1, muzzle: theirs, end: WALL, hit: false };
    play([], [], 1000, MUZZLE, [bolt(MUZZLE, WALL, true), other]);
    const from = () =>
      effectsLayer.meshInstances
        .filter((instance) => instance.node.name === 'lightning-bolt')
        .map((instance) => instance.node.getLocalPosition().y);
    expect(from().sort((a, b) => a - b)).toEqual([-64, -64, 64, 64]);

    // The player lets go, and the other player's bolt stays where it was.
    play([], [], 1016, MUZZLE, [other]);
    expect(from()).toEqual([-64, -64]);
  });

  it("draws another player's rail from where their shot started, in their colour", () => {
    // `CG_RailTrail` from the shot's `origin2`, in the shooter's `color1`. Only the player's own
    // is drawn from the gun on screen.
    const theirs: Vec3 = { x: 0, y: -64, z: 0 };
    const green = colorFromString(2);
    play([theirRail(theirs, green)], [], 0, MUZZLE);
    const beam = effectsLayer.meshInstances.find((instance) => instance.node.name === 'beam')!;
    expect(beam.node.getLocalPosition().y).toBeCloseTo(-64, 6);
    const { r, g, b } = (beam.material as StandardMaterial).emissive;
    expect([r, g, b]).toEqual([0, 0.75, 0]);
  });

  it("draws the player's own rail from the gun on screen", () => {
    play([railBeam(false)], [], 0, { x: 0, y: 32, z: 0 });
    const beam = effectsLayer.meshInstances.find((instance) => instance.node.name === 'beam')!;
    expect(beam.node.getLocalPosition().y).toBeCloseTo(32, 6);
  });

  it('hides the bolt and its crackle the frame the flash goes out', () => {
    play([], [], 0, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    play([], [], 16, MUZZLE, []);
    expect(drawnBy(effectsLayer)).toEqual([]);
  });

  it('sets the crackle 16 units back along the bolt from where it landed', () => {
    play([], [], 0, MUZZLE, [bolt(MUZZLE, WALL, true)]);
    const crackle = effectsLayer.meshInstances.find(
      (instance) => instance.node.name === 'blended'
    )!.node.parent!;
    const at = crackle.getLocalPosition();
    const length = Math.hypot(512, 64);
    // `VectorMA( trace.endpos, -16, dir, beam.origin )`, `dir` running from the gun to the end.
    expect(at.x).toBeCloseTo(512 - (512 * 16) / length, 6);
    expect(at.y).toBeCloseTo((64 * 16) / length, 6);
  });

  /** A spurt of blood where a shot struck someone. */
  function blood(origin = WALL): WorldEffect {
    return { type: 'blood', origin };
  }

  /** The drawn spurts of blood. */
  function spurts(): Entity[] {
    return effectsLayer.meshInstances
      .filter((instance) => instance.node.name === 'blood')
      .map((instance) => instance.node as Entity);
  }

  it('draws blood as a sprite 48 units across, in the effects layer, facing the camera', () => {
    camera.setEulerAngles(10, 60, 0);
    play([blood()], [], 0);

    expect(drawnBy(effectsLayer)).toEqual(['blood']);
    expect(drawnBy(world)).toEqual([]);
    const [spurt] = spurts();
    const at = spurt.getLocalPosition();
    expect([at.x, at.y, at.z]).toEqual([WALL.x, WALL.y, WALL.z]);
    expect(spurt.getLocalScale().x).toBe(48);
    const normal = spurt.getRotation().transformVector(new EngineVec3(0, 0, 1));
    expect(Math.abs(normal.dot(camera.forward))).toBeCloseTo(1, 6);
  });

  it("turns each spurt a random whole number of degrees in the screen's plane", () => {
    // `rand() % 360`: whole degrees, so a shade past a quarter of the way round is 90, which lays
    // its x along the up.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.2525);
    try {
      play([blood()], [], 0);
    } finally {
      random.mockRestore();
    }
    const [spurt] = spurts();
    const across = spurt.getRotation().transformVector(new EngineVec3(1, 0, 0));
    expect(across.dot(camera.up)).toBeCloseTo(1, 6);
  });

  it('shows a spurt for half a second, then lets it go', () => {
    play([blood()], [], 100);
    play([], [], 599);
    expect(spurts()).toHaveLength(1);
    play([], [], 600);
    expect(spurts()).toEqual([]);
  });

  it('runs every spurt through the same frame of the game clock', () => {
    // `CG_Bleed` sets no `shaderTime`: `animmap 5` from the game's start, not the spurt's.
    play([blood()], [], 150);
    play([blood(UP)], [], 250);
    const [first, second] = materialsOf('blood');
    expect(first).toBe(second);
    for (const [time, frame] of [[250, 1], [399, 1], [400, 2], [640, 3]]) {
      play([], [], time);
      expect(first.emissiveMap?.name, `${time} ms`).toBe(BLOOD_FRAMES[frame]);
      expect(first.opacityMap?.name, `${time} ms`).toBe(BLOOD_FRAMES[frame]);
    }
  });

  it('stops the blood on the game clock while no spurt is drawn', () => {
    play([blood()], [], 150);
    play([], [], 640);
    const [shared] = materialsOf('blood');
    expect(shared.emissiveMap?.name).toBe(BLOOD_FRAMES[3]);
    // Its half second is up at 650 ms, and nothing plays its frames after.
    play([], [], 800);
    expect(spurts()).toEqual([]);
    expect(shared.emissiveMap?.name).toBe(BLOOD_FRAMES[3]);
    // The next spurt shows the game clock's frame at once.
    play([blood()], [], 1000);
    expect(shared.emissiveMap?.name).toBe(BLOOD_FRAMES[0]);
  });

  it('takes the blood away, as a restart does', () => {
    play([blood()], [], 0);
    effects!.clear();
    play([], [], 10);
    expect(spurts()).toEqual([]);
  });

  /** The world effects and the explosions again, taking their places among `pool`'s. */
  async function sharing(pool: LocalEntities): Promise<void> {
    effects!.destroy();
    effects = await WorldEffects.create(app, syntheticLibrary(), camera, undefined, pool);
    effectsLayer = app.scene.layers.getLayerByName(EFFECTS_LAYER_NAME)!;
    explosions = new Explosions(() => 0, pool);
  }

  /** A jump pad's puff, clear of the view. */
  const jumpPuff: WorldEffect = { type: 'puff', origin: vec3(0, 0, 24) };

  it('draws every missile, explosion, spurt and rail core again on what the last gave back', () => {
    const root = app.root.findByName('world-effects')!;
    /** A rocket, its impact, a rail shot and a spurt, each drawing taken, then all given back. */
    const round = (time: number) => {
      play([], drawn(time, missile(WP.ROCKET_LAUNCHER).s), time);
      const rocket = nodeIn(world, 'models/ammo/rocket/rocket.md3');
      const struck = [impact(WP.ROCKET_LAUNCHER), impact(WP.RAILGUN), railBeam(true), blood()];
      play(struck, [], time + 10);
      const taken = [
        rocket,
        nodeIn(effectsLayer, 'explosion'),
        nodeIn(effectsLayer, 'models/weaphits/ring02.md3'),
        nodeIn(effectsLayer, 'beam'),
        nodeIn(effectsLayer, 'blood')
      ];
      play([], [], time + 2000);
      expect([drawnBy(effectsLayer), drawnBy(world)]).toEqual([[], []]);
      return taken;
    };
    const first = round(0);
    const made = root.children.length;
    const second = round(5000);
    second.forEach((node, index) => expect(node).toBe(first[index]));
    expect(root.children.length).toBe(made);
  });

  it('shows no rail core with no length, not even where the last one lay', () => {
    play([railBeam(false)], [], 0);
    play([], [], 450);
    // From the wall to the wall.
    play([theirRail(WALL, colorFromString(4))], [], 500);
    expect(drawnBy(effectsLayer)).not.toContain('beam');
  });

  it('holds a place among the local entities for each spurt, rail core and puff it draws', async () => {
    const pool = new LocalEntities();
    await sharing(pool);
    play([blood(), railBeam(false), jumpPuff], [], 0);
    expect(pool.count).toBe(3);
    // The rail core goes after its 400 ms, the spurt after its 500 and the puff after its second.
    play([], [], 450);
    expect(pool.count).toBe(2);
    play([], [], 1000);
    expect(pool.count).toBe(0);
    play([blood(), railBeam(false), jumpPuff], [], 2000);
    effects!.clear();
    expect(pool.count).toBe(0);
  });

  it('lets the oldest go, whatever its kind, when the pool frees its place for a newer one', async () => {
    const pool = new LocalEntities();
    await sharing(pool);
    play([blood(), railBeam(false), jumpPuff], [], 0);
    for (let i = 3; i < MAX_LOCAL_ENTITIES; i++) pool.alloc();
    // Full: the next frees the spurt, made first.
    pool.alloc();
    play([], [], 10);
    expect(spurts()).toEqual([]);
    expect(drawnBy(effectsLayer)).toContain('beam');
    expect(puffs()).toHaveLength(1);
    pool.alloc();
    pool.alloc();
    play([], [], 20);
    expect(drawnBy(effectsLayer)).not.toContain('beam');
    expect(puffs()).toEqual([]);
  });

  it("destroys its explosions' and rail cores' materials, given back or not, as it goes", () => {
    play([impact(WP.RAILGUN), railBeam(false)], [], 0);
    const materials = [...materialsOf('models/weaphits/ring02.md3'), ...materialsOf('beam')];
    // The core given back after its 400 ms; the ring still playing.
    play([], [], 450);
    const destroyed = materials.map((material) => vi.spyOn(material, 'destroy'));
    effects!.destroy();
    effects = null;
    for (const spy of destroyed) expect(spy).toHaveBeenCalled();
  });

  it("destroys the puffs' and the bubbles' materials as it goes", () => {
    const line: WorldEffect = { type: 'bubbles', start: vec3(), end: vec3(100, 0, 0), spacing: 32 };
    play([jumpPuff, { type: 'hastePuff', origin: UP }, line], [], 0);
    const shaders: MergedShader[] = ['smokePuff', 'hasteSmokePuff', 'waterBubble'];
    const destroyed = shaders.map((shader) => {
      const draw = effectsLayer.meshInstances.find(
        (instance) => instance.visible && instance.drawBucket === mergedBucket(shader)
      );
      if (!draw?.material) throw new Error(`no ${shader} drawn`);
      return vi.spyOn(draw.material, 'destroy');
    });
    effects!.destroy();
    effects = null;
    for (const spy of destroyed) expect(spy).toHaveBeenCalled();
  });

  it('takes the effects layer out of the scene when destroyed, and every draw out of it', () => {
    play([{ type: 'puff', origin: vec3(0, 0, 24) }, { type: 'hastePuff', origin: UP }], [], 0);
    effects!.destroy();
    effects = null;
    expect(app.scene.layers.getLayerByName(EFFECTS_LAYER_NAME)).toBeNull();
    expect(effectsLayer.meshInstances).toEqual([]);
  });

  it('draws one of everything for the warm-up, each in its own layer, then takes it away', () => {
    const warmed = effects!.warm();
    warmed.at(0);
    const shown = drawnBy(effectsLayer);
    for (const name of [
      'plasma-bolt',
      'explosion',
      'models/weaphits/ring02.md3',
      'beam',
      'lightning-bolt',
      'grapple-pointer',
      'grapple-flare',
      'target-laser',
      'blood'
    ]) {
      expect(shown, name).toContain(name);
    }
    // A puff of each smoke and a bubble, each its own draw.
    expect(puffs()).toHaveLength(1);
    expect(puffs('hasteSmokePuff')).toHaveLength(1);
    expect(puffs('waterBubble')).toHaveLength(1);
    // The crackle where the bolt lands, and the projectiles' glows over their bodies, which keep
    // World.
    const over = (name: string) =>
      effectsLayer.meshInstances.some((instance) => instance.node.parent?.name === name);
    expect([over('models/weaphits/crackle.md3'), over('models/ammo/rocket/rocket.md3')]).toEqual([
      true,
      true
    ]);
    expect(drawnBy(world)).toEqual([
      'models/ammo/grenade1.md3',
      'models/ammo/rocket/rocket.md3',
      'models/ammo/rocket/rocket.md3'
    ]);

    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect([drawnBy(effectsLayer), drawnBy(world)]).toEqual([[], []]);
  });

  it('plays each of its warm-up drawings on its own clock, at zero and then away from it', () => {
    const warmed = effects!.warm();
    warmed.at(0);
    // The plasma bolt on the game clock, `tcMod rotate 931`: unturned at zero.
    const [plasma] = materialsOf('plasma-bolt');
    expect(plasma.emissiveMapRotation).toBe(0);
    // And the crackle, `tcMod rotate 360`.
    const crackle = crackleMaterial();
    expect(crackle.emissiveMapRotation).toBe(0);
    // The rail's impact from its own start: `alphaGen wave inversesawtooth` and `sawtooth`.
    const ring = () =>
      materialsOf('models/weaphits/ring02.md3')
        .filter((material) => material.blendType === BLEND_NORMAL)
        .map((material) => material.opacity)
        .sort();
    expect(ring()).toEqual([0, 1]);

    warmed.at(WARM_TIMES[1]);
    expect(plasma.emissiveMapRotation).not.toBe(0);
    expect(crackle.emissiveMapRotation).not.toBe(0);
    const [out, inn] = ring();
    expect(out).toBeGreaterThan(0);
    expect(out + inn).toBeCloseTo(1, 6);
    warmed.end();
  });

  it('lends the warm-up its pools, so the first missile, impact, rail core and spurt make nothing', () => {
    const root = app.root.findByName('world-effects')!;
    const warmed = effects!.warm();
    warmed.at(0);
    warmed.end();
    const made = root.children.length;
    launch(missile(WP.ROCKET_LAUNCHER), missile(WP.PLASMAGUN), missile(WP.BFG));
    play([impact(WP.ROCKET_LAUNCHER), impact(WP.RAILGUN), railBeam(true), blood()], [], 10);
    expect(drawnBy(effectsLayer)).toEqual(
      expect.arrayContaining(['beam', 'blood', 'explosion', 'models/weaphits/ring02.md3'])
    );
    expect(root.children.length).toBe(made);
  });

  it("lays the warm-up's beams on their stretched texture, and the pointer over the map", () => {
    const warmed = effects!.warm();
    warmed.at(0);
    // `tcMod scroll -1 0` at zero leaves the beam's own stretch alone.
    const [core] = materialsOf('beam');
    expect(core.emissiveMapTiling.x).toBe(2);
    // Blended over what is behind it, where the rail's own core adds.
    const [pointer] = materialsOf('grapple-pointer');
    expect([pointer.blendType, core.blendType]).toEqual([BLEND_NORMAL, BLEND_ADDITIVE]);
    warmed.end();
  });
});

/** The teleport's effect, as pak0's `scripts/gfx.shader` has it. */
const TELEPORT_SHADER = `teleportEffect
{
  cull none
  {
    map gfx/misc/teleportEffect2.tga
    blendFunc GL_ONE GL_ONE
    rgbGen entity
    tcMod scale 1 4
    tcMod scroll 0 2
  }
}`;

/** The effect's files: its shader, its image, and its model, whose one surface names no shader. */
const TELEPORT_FILES: [string, Uint8Array][] = [
  ['scripts/gfx.shader', new TextEncoder().encode(TELEPORT_SHADER)],
  ['gfx/misc/teleportEffect2.tga', tga()],
  ['models/misc/telep.md3', md3(['telep01', ''])]
];

describe("a teleport's effect", () => {
  const MODEL = 'models/misc/telep.md3';
  let app: AppBase;
  let effects: WorldEffects;
  let effectsLayer: Layer;
  let pool: LocalEntities;

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    pool = new LocalEntities();
    const library = syntheticLibrary(TELEPORT_FILES);
    effects = await WorldEffects.create(app, library, test.camera, undefined, pool);
    effectsLayer = app.scene.layers.getLayerByName(EFFECTS_LAYER_NAME)!;
  });

  afterEach(() => {
    effects.destroy();
    app.destroy();
  });

  /** The effect's draws this frame. */
  function teleports(): MeshInstance[] {
    return effectsLayer.meshInstances.filter(
      (instance) => instance.visible && instance.node.name === MODEL
    );
  }

  const AT = vec3(100, 20, 50);
  const spawn = (time: number) => effects.update([{ type: 'teleport', origin: AT }], [], time);

  it('stands its model 24 units below the event, unturned, in its own additive shader', () => {
    spawn(1000);
    const [draw] = teleports();
    expect(draw).toBeDefined();
    const position = draw.node.getLocalPosition();
    expect([position.x, position.y, position.z]).toEqual([100, 20, 26]);
    const angles = draw.node.getLocalEulerAngles();
    expect([angles.x, angles.y, angles.z]).toEqual([0, 0, 0]);
    expect((draw.material as StandardMaterial).blendType).toBe(BLEND_ADDITIVE);
    expect(pool.count).toBe(1);
  });

  it('fades by its colour over half a second, its shader played from its own start', () => {
    spawn(1000);
    const material = teleports()[0].material as StandardMaterial;
    effects.update([], [], 1125);
    // Three-quarters of `rgbGen entity`'s white, which the classic ramp doubles.
    expect(material.emissive.r).toBeCloseTo(0.75 * 2, 6);
    // `tcMod scroll 0 2` an eighth of a second in, after `tcMod scale 1 4`.
    const scrolled = material.emissiveMapOffset.y;
    effects.update([], [], 1250);
    expect(material.emissive.r).toBeCloseTo(0.5 * 2, 6);
    expect(material.emissiveMapOffset.y).not.toBe(scrolled);
  });

  it('goes at the end of its half second, and gives its place back', () => {
    spawn(1000);
    const [first] = teleports();
    effects.update([], [], 1499);
    expect(teleports()).toHaveLength(1);
    effects.update([], [], 1500);
    expect(teleports()).toEqual([]);
    expect(pool.count).toBe(0);
    // Its drawing goes back to be taken again, so a second makes nothing new.
    spawn(2000);
    expect(teleports()).toEqual([first]);
  });

  it('goes when the pool frees its place, and at a clear', () => {
    spawn(1000);
    for (let i = 1; i < MAX_LOCAL_ENTITIES; i++) pool.alloc();
    pool.alloc();
    effects.update([], [], 1010);
    expect(teleports()).toEqual([]);

    spawn(2000);
    effects.clear();
    expect(teleports()).toEqual([]);
  });

  it('is warmed with the explosions, and given back after', () => {
    const warmed = effects.warm();
    warmed.at(0);
    expect(teleports()).toHaveLength(1);
    warmed.end();
    expect(teleports()).toEqual([]);
  });
});
