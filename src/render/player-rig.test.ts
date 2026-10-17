// @vitest-environment jsdom
import {
  BLEND_ADDITIVE,
  Entity,
  Layer,
  StandardMaterial,
  Vec3,
  type AppBase,
  type Texture
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAssets, type AssetLibrary } from '../formats/asset-library';
import { findShader } from '../formats/shader-script';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { ANIM } from '../sim/animations';
import { PW } from '../sim/items';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { SceneLights } from '../view/dynamic-lights';
import { LIGHT_HEADROOM, entityLight, entityLightAt } from '../view/entity-light';
import { BODY_SHELL_SHADERS } from '../view/powerup-passes';
import { PLAYER_PART, packetEntity } from '../view/scene-sort';
import { SceneShaders } from '../view/scene-shaders';
import { lerpMeshVertexes } from '../view/vertex-morph';
import { LIGHTMAP_NONE } from '../view/world-shaders';
import { deformView } from './deform-view';
import { createTestApp, expectClose, held, lightUniform, uniform } from './engine-test-fixtures';
import { DEFORM_SLOTS, writeDeforms, writeView } from './model-chunks';
import { frameTexture } from './model-frames';
import { PlayerRig } from './player-rig';
import {
  playerLibrary as library,
  rigState as state,
  shownShells
} from './player-test-fixtures';
import { SceneDraws, sceneDraw } from './scene-draws';
import { lightInEntity } from './staged-model';
import { ResourceScope, TextureCache } from './texture-cache';
import { WARM_TIMES } from './warm-up';
import { WHITE_IMAGE_PATH } from './white-image';

const FLASH = 'models/weapons2/machinegun/machinegun_flash.md3';

function piece(rig: PlayerRig, name: string): Entity {
  const entity = rig.root.findByName(name);
  if (!entity) throw new Error(`no ${name}`);
  return entity as Entity;
}

/** Each part's model in the test player. */
const PART_MODELS: Record<string, string> = {
  legs: 'models/players/test/lower.md3',
  torso: 'models/players/test/upper.md3',
  head: 'models/players/test/head.md3'
};

/**
 * Where a part's first surface stands this frame: the blend its `q3_anim` names, which the chunks
 * morph by, worked through their twin (`lerpMeshVertexes`).
 */
function positions(rig: PlayerRig, part: string): number[] {
  const [oldFrame, frame, backlerp] = uniform(piece(rig, part).render!.meshInstances[0], 'q3_anim');
  const surface = library().model(PART_MODELS[part]).surfaces[0];
  const out = new Float32Array(surface.numVerts * 3);
  lerpMeshVertexes(surface, oldFrame, frame, backlerp, out, new Float32Array(out.length));
  return [...out];
}

function material(entity: Entity, index = 0): StandardMaterial {
  return entity.render!.meshInstances[index].material as StandardMaterial;
}

describe('PlayerRig', () => {
  let app: AppBase;
  let cache: TextureCache;
  let blended: Layer;
  /** One library for every body, as the game has: its models are parsed once, and shared. */
  let assets: AssetLibrary;
  const create = (skin = 'default') =>
    PlayerRig.create(app, assets, cache, 'test', skin, { blendedLayers: [blended.id] });

  beforeEach(() => {
    app = createTestApp().app;
    assets = library();
    cache = new TextureCache(app.graphicsDevice);
    blended = new Layer({ name: 'blended' });
    app.scene.layers.push(blended);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    app.destroy();
  });

  it('draws each surface once per stage of the shader its skin names', async () => {
    const rig = await create();

    // An unscripted image: Q3's default shader, one lit stage.
    const legs = material(piece(rig, 'legs'));
    expect(legs.emissiveVertexColor).toBe(true);
    expect(legs.emissive.r).toBe(LIGHT_HEADROOM);
    expect(legs.emissiveMap).not.toBeNull();

    // The lit white base draws the white image with the torso; the blended skin over it, in the
    // blended layer.
    const torso = piece(rig, 'torso');
    const base = material(torso);
    expect(base.emissiveVertexColor).toBe(true);
    expect(base.emissiveMap?.name).toBe(WHITE_IMAGE_PATH);
    const over = torso.findByName('blended') as Entity;
    expect(over.render!.layers).toEqual([blended.id]);
    expect(material(over).emissiveVertexColor).toBe(false);
    expect(over.render!.meshInstances[0].mesh).toBe(torso.render!.meshInstances[0].mesh);

    // The head is matched in lower case; its ripple is the chunks' own.
    const head = piece(rig, 'head');
    expect(material(head).defines.get('Q3_TCMOD')).toBe(true);
    expect(material(head.findByName('blended') as Entity).emissiveVertexColor).toBe(true);
    expect(head.render!.meshInstances[0].mesh!.vertexBuffer!.format.hasColor).toBe(true);
  });

  it("numbers its parts in a scene as CG_Player adds them, each by its shader", async () => {
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [blended],
      gun: [],
      screen: []
    });
    const rig = await PlayerRig.create(app, assets, cache, 'test', 'default', {
      blendedLayers: [blended.id],
      scene
    });
    await rig.selectWeapon(WP.MACHINEGUN);
    rig.update(state({ weapon: WP.MACHINEGUN, entity: packetEntity(3) }));
    const tag = (name: string) => sceneDraw(piece(rig, name).render!.meshInstances[0])!;
    expect(tag('legs').entity.value).toBe(packetEntity(3, PLAYER_PART.legs));
    expect(tag('torso').entity.value).toBe(packetEntity(3, PLAYER_PART.torso));
    expect(tag('head').entity.value).toBe(packetEntity(3, PLAYER_PART.head));
    const gun = 'models/weapons2/machinegun/machinegun.md3';
    expect(tag(gun).entity.value).toBe(packetEntity(3, PLAYER_PART.gun));
    // A skin's surface sorts by the skin's shader, registered as a model's at LIGHTMAP_NONE.
    expect(tag('legs').shader.lightmapIndex).toBe(LIGHTMAP_NONE);
    expect(tag('legs').depthHack).toBe(false);
    // Unnumbered, as the HUD's and the menu's bodies are drawn, its parts keep what they had.
    rig.update(state({ weapon: WP.MACHINEGUN }));
    expect(tag('legs').entity.value).toBe(packetEntity(3, PLAYER_PART.legs));
  });

  it('morphs every body by a blend of its own, over the one mesh they share', async () => {
    const one = await create();
    const other = await create();
    one.update(state({ time: 1050 }));
    one.update(state({ time: 1075 }));
    other.update(state({ time: 1050 }));
    const [mine, theirs] = [one, other].map((rig) => piece(rig, 'legs').render!.meshInstances[0]);
    expect(mine.mesh).toBe(theirs.mesh);
    expect(held(mine, 'q3_anim')).not.toBe(held(theirs, 'q3_anim'));
    // Halfway from frame 0 to frame 1, the triangle has climbed half a unit; the other body is
    // still on frame 0.
    expect(positions(one, 'legs')).toEqual([0, 0, 0.5, 0, 1, 0.5, 0, 0, 1.5]);
    expect(positions(other, 'legs')).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('hangs the torso on the legs’ tag and the head on the torso’s, from the body’s origin', async () => {
    const rig = await create();
    rig.update(state({ origin: vec3(100, 0, 0) }));
    expect([...piece(rig, 'torso').getLocalPosition().toArray()]).toEqual([100, 0, 10]);
    expect([...piece(rig, 'head').getLocalPosition().toArray()]).toEqual([100, 0, 26]);
  });

  it('comes into view facing where it looks, with no shuffle round to it', async () => {
    const rig = await create();
    rig.update(state({ angles: vec3(0, 90, 0) }));
    // Quake +X, turned 90° left: the legs face the world's +Y at once.
    const forward = piece(rig, 'legs').getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(0, 5);
    expect(forward.y).toBeCloseTo(1, 5);
  });

  it("plays the skin's animated stages on the game clock", async () => {
    const rig = await create();
    const blended = piece(rig, 'torso').findByName('blended') as Entity;
    const offsets = () =>
      blended.render!.meshInstances.map((instance) => uniform(instance, 'q3_coords[0]')[6]);
    rig.update(state({ time: 1000 }));
    const before = offsets();
    rig.update(state({ time: 1500 }));
    // A moving stage's `q3_coords` offset advances on the clock; a still stage's stays.
    expect(offsets()).not.toEqual(before);
  });

  it('puts the weapon on the torso’s tag_weapon, flashing only just after a shot', async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    rig.update(state({ weapon: WP.MACHINEGUN }));
    const gun = piece(rig, 'models/weapons2/machinegun/machinegun.md3');
    expect(gun.enabled).toBe(true);
    expect([...gun.getLocalPosition().toArray()]).toEqual([6, -4, 10]);
    expect([...piece(rig, 'models/weapons2/machinegun/machinegun_barrel.md3').getLocalPosition().toArray()]).toEqual([14, -4, 10]);

    const flash = piece(rig, 'models/weapons2/machinegun/machinegun_flash.md3');
    expect(flash.enabled).toBe(false);
    rig.update(state({ weapon: WP.MACHINEGUN, time: 1060, lastFireTime: 1055 }));
    expect(flash.enabled).toBe(true);
    rig.update(state({ weapon: WP.MACHINEGUN, time: 1100, lastFireTime: 1055 }));
    expect(flash.enabled).toBe(false);
  });

  it('puts the flash out with its gun, when the gun is put away mid-flash', async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    rig.update(state({ weapon: WP.MACHINEGUN, time: 1060, lastFireTime: 1055 }));
    const flash = piece(rig, FLASH);
    expect(flash.enabled).toBe(true);
    rig.update(state({ weapon: WP.RAILGUN, time: 1065, lastFireTime: 1055 }));
    expect(flash.enabled).toBe(false);
  });

  it("binds the flash's draws, lit by how it is turned and facing the camera", async () => {
    const weapons = library();
    const camera = new Entity('camera');
    camera.setEulerAngles(-20, 50, 0);
    let rig: PlayerRig;
    try {
      rig = await PlayerRig.create(app, weapons, cache, 'test', 'default', {
        blendedLayers: [blended.id],
        camera
      });
      await rig.selectWeapon(WP.MACHINEGUN);
    } finally {
    }
    // Turned, and just after a shot.
    rig.update(state({ weapon: WP.MACHINEGUN, angles: vec3(20, 60, 0), time: 1060, lastFireTime: 1055 }));
    const flash = piece(rig, FLASH);
    const [draw] = (flash.findByName('blended') as Entity).render!.meshInstances;
    const surface = weapons.model(FLASH).surfaces[0];
    expect(held(draw, 'q3_frames')).toBe(frameTexture(app.graphicsDevice, surface));
    expectClose(uniform(draw, 'q3_light[0]'), lightUniform(lightInEntity(flash)));
    // Its deform moves on the game clock: `CG_AddPlayerWeapon` gives the flash no `shaderTime`.
    const packed = new Float32Array(DEFORM_SLOTS * 8);
    writeDeforms(weapons.shaders.get('models/weapons2/machinegun/flash')!.deforms, 1.06, packed);
    expect(uniform(draw, 'q3_deform[0]')).toEqual([...packed]);
    // Its pivot by where the camera looks, once the flash is placed.
    const view = new Float32Array(16);
    writeView(deformView(flash, camera), view);
    expectClose(uniform(draw, 'q3_view[0]'), view);
  });

  it("lights every part and the gun at the player's origin, the scene's lights folded in", async () => {
    // A rocket's light beside the body: Q3 folds it in once, at the body's origin, for the legs,
    // the torso, the head and all they hold, wherever each part is.
    const lights = new SceneLights();
    lights.add({ x: 140, y: 0, z: 24 }, 200, [1, 0.75, 0]);
    const rig = await PlayerRig.create(app, assets, cache, 'test', 'default', {
      blendedLayers: [blended.id],
      lights
    });
    await rig.selectWeapon(WP.MACHINEGUN);
    rig.update(state({ origin: vec3(100, 0, 0), weapon: WP.MACHINEGUN }));
    const lit = entityLightAt({ x: 100, y: 0, z: 0 }, lights);
    expect(lit.directed[0]).toBeGreaterThan(entityLight().directed[0]);
    for (const name of ['legs', 'torso', 'head', 'models/weapons2/machinegun/machinegun.md3']) {
      const part = piece(rig, name);
      expectClose(uniform(part.render!.meshInstances[0], 'q3_light[0]'), lightUniform(lightInEntity(part, lit)));
    }
  });

  it("draws every stage of the gun's shader, its glow in color1 and coming back after a shot", async () => {
    const rig = await create();
    await rig.selectWeapon(WP.RAILGUN);
    const draw = (time: number) =>
      rig.update(state({ weapon: WP.RAILGUN, time, color: [1, 0, 0], railFireTime: 1000 }));
    draw(1000);
    const gun = piece(rig, 'models/weapons2/railgun/railgun.md3');
    // The lit base draws with the gun; the glow and the mirror over it, in the blended layer.
    expect(material(gun).emissiveVertexColor).toBe(true);
    const over = gun.findByName('blended') as Entity;
    expect(over.render!.layers).toEqual([blended.id]);
    const [glow, mirror] = [material(over, 0), material(over, 1)];
    expect(mirror.defines.get('Q3_TCGEN_ENV')).toBe(true);

    // Black at the shot, then back up to color1, which classic Q3's ramp doubles.
    const color = () => [glow.emissive.r, glow.emissive.g, glow.emissive.b];
    expect(color()).toEqual([0, 0, 0]);
    draw(1750);
    expect(glow.emissive.r).toBeCloseTo((2 * 126) / 255, 5);
    draw(2500);
    expect(color()).toEqual([2, 0, 0]);
  });

  it('shares textures and meshes between bodies, and gives the rest back when destroyed', async () => {
    const one = await create();
    await one.selectWeapon(WP.MACHINEGUN);
    const textures = cache.size;
    expect(textures).toBe(5); // band, skin and white, the gun's and the flash's
    // Every surface's one shared mesh, kept for the session.
    const buffers = app.graphicsDevice.buffers.size;
    const other = await create();
    await other.selectWeapon(WP.MACHINEGUN);
    expect(cache.size).toBe(textures);
    expect(app.graphicsDevice.buffers.size).toBe(buffers);

    const band = material(piece(one, 'legs')).emissiveMap as Texture;
    const destroyed = vi.spyOn(StandardMaterial.prototype, 'destroy');
    const materials = one.materialCount;
    await one.destroy();
    expect(destroyed).toHaveBeenCalledTimes(materials);
    expect(band.device).not.toBeNull();

    await other.destroy();
    await Promise.resolve();
    expect(cache.size).toBe(0);
    expect(band.device).toBeNull();
    expect(app.graphicsDevice.buffers.size).toBe(buffers);
  });

  it('refuses a skin the model lacks, leaving nothing behind', async () => {
    const children = app.root.children.length;
    await expect(create('red')).rejects.toThrow('test/red: no models/players/test/lower_red.skin');
    expect(cache.size).toBe(0);
    expect(app.root.children.length).toBe(children);
  });

  it('animates a hidden body without drawing it, so the view weapon can follow its torso', async () => {
    const rig = await create();
    rig.update(state({ time: 1050, hidden: true }));
    rig.update(state({ time: 1075, hidden: true }));
    expect(rig.root.enabled).toBe(false);
    // Halfway from frame 0 to frame 1, as a drawn body would be; its vertices stay as built.
    expect(rig.torsoFrames).toEqual({ oldFrame: 0, frame: 1, backlerp: 0.5 });
    expect(positions(rig, 'legs')).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 1]);

    rig.update(state({ time: 1100 }));
    expect(rig.root.enabled).toBe(true);
  });

  it('twists the torso for 200 ms after a pain, to the side the pain gives', async () => {
    const rig = await create();
    const up = () => piece(rig, 'torso').getLocalRotation().transformVector(new Vec3(0, 0, 1));
    rig.update(state({ time: 1050 }));
    expect(up().y).toBeCloseTo(0, 5);
    // 50 ms into the twitch: three quarters of its 20° of roll.
    rig.update(state({ time: 1100, painTime: 1050, painDirection: 1 }));
    expect(up().y).toBeCloseTo(-Math.sin((15 * Math.PI) / 180), 5);
    rig.update(state({ time: 1250, painTime: 1050, painDirection: 1 }));
    expect(up().y).toBeCloseTo(0, 5);
  });

  it("gives off its flash's light where its pose puts the flash, lit only once drawn", async () => {
    const lights = new SceneLights();
    const rig = await PlayerRig.create(app, assets, cache, 'test', 'default', {
      blendedLayers: [blended.id],
      lights
    });
    await rig.selectWeapon(WP.MACHINEGUN);
    const shot = { origin: vec3(100, 0, 0), weapon: WP.MACHINEGUN, time: 1060, lastFireTime: 1055 };
    rig.pose(state(shot));
    expect(rig.flashDlight()).toEqual({ origin: vec3(126, -4, 11), weapon: WP.MACHINEGUN });
    // A light added after the pose lights the body, as Q3 lights nothing until every light is in.
    lights.add({ x: 140, y: 0, z: 24 }, 200, [1, 0.75, 0]);
    rig.draw();
    const lit = entityLightAt({ x: 100, y: 0, z: 0 }, lights);
    const legs = piece(rig, 'legs');
    const drawn = uniform(legs.render!.meshInstances[0], 'q3_light[0]');
    expectClose(drawn, lightUniform(lightInEntity(legs, lit)));
    // Drawn, it gives none till posed again; none once the flash is out, nor hidden.
    expect(rig.flashDlight()).toBeNull();
    rig.pose(state({ ...shot, time: 1100 }));
    expect(rig.flashDlight()).toBeNull();
    rig.pose(state({ ...shot, time: 1110, lastFireTime: 1105, hidden: true }));
    expect(rig.flashDlight()).toBeNull();
  });

  it('starts its beams at the weapon’s tag_flash, whether the flash shows or not', async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    rig.update(state({ weapon: WP.MACHINEGUN }));
    // tag_weapon at (6, −4) on the torso 10 up, then tag_flash 20 ahead and 1 up.
    expect(rig.muzzleOrigin()).toEqual(vec3(26, -4, 11));
    rig.update(state({ weapon: WP.MACHINEGUN, hidden: true, time: 1100 }));
    expect(rig.muzzleOrigin()).toBeNull();
  });

  it('comes into view afresh after a reset, as a respawn brings it', async () => {
    const rig = await create();
    rig.update(state({ angles: vec3(0, 90, 0) }));
    rig.reset();
    rig.update(state({ angles: vec3(0, 180, 0), time: 1100 }));
    const forward = piece(rig, 'legs').getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(-1, 5);
    expect(forward.y).toBeCloseTo(0, 5);
  });

  it("draws a shell over each part a powerup names, over the part's own mesh", async () => {
    const rig = await create();
    rig.update(state({ powerups: 1 << PW.QUAD }));
    // The shell is built when it is first asked for, so the frame after the build is the first
    // it draws on.
    await rig.settled();
    rig.update(state({ powerups: 1 << PW.QUAD, time: 1100 }));

    const shell = piece(rig, 'powerups/quad/legs');
    expect(shell.enabled).toBe(true);
    // An additive stage writes no depth, so it draws in the blended layer, as the skin's do.
    const over = shell.findByName('blended') as Entity;
    expect(material(over).blendType).toBe(BLEND_ADDITIVE);
    expect(material(over).emissiveMap).not.toBeNull();
    // The part's own mesh, under uniforms of its own.
    const [shellDraw] = over.render!.meshInstances;
    const [legsDraw] = piece(rig, 'legs').render!.meshInstances;
    expect(shellDraw.mesh).toBe(legsDraw.mesh);
    expect(held(shellDraw, 'q3_anim')).not.toBe(held(legsDraw, 'q3_anim'));
    // The body itself is still drawn.
    expect(piece(rig, 'legs').enabled).toBe(true);
    expect(piece(rig, 'powerups/quad/torso').enabled).toBe(true);
    expect(piece(rig, 'powerups/quad/head').enabled).toBe(true);

    // Once the quad runs out, the shell goes with it.
    rig.update(state({ time: 1200 }));
    expect(piece(rig, 'powerups/quad/legs').enabled).toBe(false);
    expect(piece(rig, 'powerups/quad/torso').enabled).toBe(false);
  });

  it('draws an invisible player as the invisibility shell alone', async () => {
    const rig = await create();
    rig.update(state({ powerups: 1 << PW.INVIS }));
    await rig.settled();
    rig.update(state({ powerups: 1 << PW.INVIS, time: 1100 }));

    expect(piece(rig, 'legs').enabled).toBe(false);
    expect(piece(rig, 'torso').enabled).toBe(false);
    expect(piece(rig, 'head').enabled).toBe(false);
    expect(piece(rig, 'powerups/invisibility/torso').enabled).toBe(true);
  });

  it('dresses the gun in the quad’s weapon shell, and hides it under invisibility', async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    rig.update(state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD }));
    await rig.settled();
    rig.update(state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD, time: 1100 }));

    expect(piece(rig, 'powerups/quadWeapon/gun').enabled).toBe(true);
    // The machinegun has a barrel, and `CG_AddWeaponWithPowerups` draws it too.
    expect(piece(rig, 'powerups/quadWeapon/barrel').enabled).toBe(true);

    // Invisibility draws the gun's own invisibility shell, and nothing else of it.
    rig.update(state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.INVIS, time: 1200 }));
    await rig.settled();
    rig.update(state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.INVIS, time: 1300 }));
    expect(piece(rig, 'models/weapons2/machinegun/machinegun.md3').enabled).toBe(false);
    expect(piece(rig, 'powerups/invisibility/gun').enabled).toBe(true);
    // And the quad's weapon shell goes with the quad.
    expect(piece(rig, 'powerups/quadWeapon/gun').enabled).toBe(false);
  });

  it('draws each shell where its part is drawn', async () => {
    const rig = await create();
    const quad = state({ powerups: 1 << PW.QUAD });
    rig.update(quad);
    await rig.settled();
    rig.update({ ...quad, time: 1100 });

    // The torso rides the legs' tag and the head the torso's, so each shell must too.
    for (const part of ['legs', 'torso', 'head']) {
      const shell = piece(rig, `powerups/quad/${part}`).getWorldTransform().data;
      const body = piece(rig, part).getWorldTransform().data;
      for (let i = 0; i < 16; i++) expect(shell[i]).toBeCloseTo(body[i], 5);
    }

    // And stands off it, on the legs' frames: `powerups/quad` swells 3 units along the normals.
    // The swell has no frequency, so it packs alike at any moment.
    const over = piece(rig, 'powerups/quad/legs').findByName('blended') as Entity;
    const [shellDraw] = over.render!.meshInstances;
    const [legsDraw] = piece(rig, 'legs').render!.meshInstances;
    expect(uniform(shellDraw, 'q3_anim')).toEqual(uniform(legsDraw, 'q3_anim'));
    const packed = new Float32Array(DEFORM_SLOTS * 8);
    writeDeforms(findShader(library().shaders, 'powerups/quad')!.deforms, 0, packed);
    expect(uniform(shellDraw, 'q3_deform[0]')).toEqual([...packed]);
    expect(packed[4]).toBe(3);
  });

  it('wears its own shells and its gun’s together, each let go by its own', async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    const quad = state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD });
    rig.update(quad);
    await rig.settled();
    rig.update({ ...quad, time: 1100 });

    // The gun's shells are let go before the gun draws; the body's must not go with them.
    expect(piece(rig, 'powerups/quad/legs').enabled).toBe(true);
    expect(piece(rig, 'powerups/quadWeapon/gun').enabled).toBe(true);
  });

  it("puts a gun's shells away with it under the quad, the next gun wearing its own", async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    const quad = state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD });
    rig.update(quad);
    await rig.settled();
    rig.update({ ...quad, time: 1100 });
    const body = ['powerups/quad/head', 'powerups/quad/legs', 'powerups/quad/torso'];
    expect(shownShells(rig)).toEqual([
      ...body,
      'powerups/quadWeapon/barrel',
      'powerups/quadWeapon/gun'
    ]);

    // While the railgun builds, nothing of the machinegun's is left where it was last drawn.
    const rail = { ...quad, weapon: WP.RAILGUN };
    rig.update({ ...rail, time: 1200 });
    expect(shownShells(rig)).toEqual(body);
    await rig.settled();
    rig.update({ ...rail, time: 1300 });
    await rig.settled();
    rig.update({ ...rail, time: 1400 });
    // The railgun's own shell, and it has no barrel.
    expect(shownShells(rig)).toEqual([...body, 'powerups/quadWeapon/gun']);
  });

  it("puts a gun's shells away at a death, whose snapshot takes the gun and the quad", async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    const quad = state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD });
    rig.update(quad);
    await rig.settled();
    rig.update({ ...quad, time: 1100 });

    // `player_die` takes the weapon and the powerups together (`g_combat.c:592–593`).
    rig.update(state({ dead: true, time: 1200 }));
    expect(shownShells(rig)).toEqual([]);
  });

  it("waits, when settling, for the gun's shells as well as the body's", async () => {
    const rig = await create();
    // The body's quad shells land first, so the gun's are all that is left to wait for.
    rig.update(state({ powerups: 1 << PW.QUAD }));
    await rig.settled();
    await rig.selectWeapon(WP.MACHINEGUN);

    // From here every texture comes a macrotask late, as a decode does in the browser.
    const texture = ResourceScope.prototype.texture;
    vi.spyOn(ResourceScope.prototype, 'texture').mockImplementation(async function (
      this: ResourceScope,
      ...args: Parameters<ResourceScope['texture']>
    ) {
      const loaded = await texture.apply(this, args);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return loaded;
    });
    const quad = state({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD, time: 1100 });
    rig.update(quad);
    await rig.settled();
    rig.update({ ...quad, time: 1200 });
    expect(piece(rig, 'powerups/quadWeapon/gun').enabled).toBe(true);
  });

  it('shows the body, its gun and each body shell for the warm-up, then hides them', async () => {
    const rig = await create();
    await rig.selectWeapon(WP.MACHINEGUN);
    // In first person: the body plays, and is not drawn.
    rig.update(state({ weapon: WP.MACHINEGUN, hidden: true }));
    const warmed = await rig.warm();
    warmed.at(0);
    const shells = BODY_SHELL_SHADERS.map((shader) => `${shader}/legs`);
    const shown = ['legs', 'models/weapons2/machinegun/machinegun.md3', FLASH, ...shells];
    for (const name of shown) expect(piece(rig, name).enabled, name).toBe(true);
    // A shell's additive stages, in the blended layer.
    const over = blended.meshInstances.map((instance) => instance.node.parent?.name);
    for (const name of shells) expect(over, name).toContain(name);

    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect(rig.root.enabled).toBe(false);
    // Each piece as it was: the shells built and kept, hidden, and the flash out.
    rig.root.enabled = true;
    expect([FLASH, ...shells].map((name) => piece(rig, name).enabled)).toEqual(
      new Array(shells.length + 1).fill(false)
    );
    expect(piece(rig, 'models/weapons2/machinegun/machinegun.md3').enabled).toBe(true);
  });

  it('plays the body half again as fast under haste', async () => {
    const slow = await create();
    const quick = await create();
    // The test model's rows are two frames fifty milliseconds apart, so the frame the clock
    // lands on shows which scale it was played at (`cg_players.c:1251–1270`).
    for (const time of [1000, 1025, 1050, 1075, 1100]) {
      slow.update(state({ time }));
      quick.update(state({ time, powerups: 1 << PW.HASTE }));
    }
    expect(slow.torsoFrames!.frame).toBe(0);
    expect(quick.torsoFrames!.frame).toBe(1);
  });

  it('answers with a haste puff while the legs run, one per hundred milliseconds', async () => {
    const rig = await create();
    const haste = { powerups: 1 << PW.HASTE, legsAnim: ANIM.LEGS_RUN, origin: vec3(10, 20, 30) };
    // `cent->trailTime` starts at 0: the first frame passes it.
    expect(rig.update(state({ ...haste, time: 0 }))).toEqual(vec3(10, 20, 14));
    expect(rig.update(state({ ...haste, time: 50 }))).toBeNull();
    expect(rig.update(state({ ...haste, time: 100 }))).toEqual(vec3(10, 20, 14));
    // A body without haste lays nothing, and its clock does not run.
    expect(rig.update(state({ ...haste, time: 150, powerups: 0 }))).toBeNull();
    expect(rig.update(state({ ...haste, time: 200 }))).not.toBeNull();
  });

  it("lays the next match's haste puffs on its own clock, which starts again", async () => {
    const rig = await create();
    const haste = { powerups: 1 << PW.HASTE, legsAnim: ANIM.LEGS_RUN, origin: vec3(10, 20, 30) };
    expect(rig.update(state({ ...haste, time: 90000 }))).not.toBeNull();
    expect(rig.torsoFrames).not.toBeNull();

    rig.clear();
    expect(rig.torsoFrames).toBeNull();
    expect(rig.update(state({ ...haste, time: 16 }))).toEqual(vec3(10, 20, 14));
  });

  it("comes into the next match's view afresh, with no swing round from the last", async () => {
    const rig = await create();
    rig.update(state({ angles: vec3(0, 90, 0), time: 90000 }));
    rig.clear();
    rig.update(state({ angles: vec3(0, 180, 0), time: 16 }));
    const forward = piece(rig, 'legs').getLocalRotation().transformVector(new Vec3(1, 0, 0));
    expect(forward.x).toBeCloseTo(-1, 5);
    expect(forward.y).toBeCloseTo(0, 5);
  });

  it('lays no haste puff for a player who is not running, or one not drawn at all', async () => {
    const rig = await create();
    const haste = { powerups: 1 << PW.HASTE, origin: vec3(10, 20, 30) };
    expect(rig.update(state({ ...haste, time: 0, legsAnim: ANIM.LEGS_IDLE }))).toBeNull();
    // The player's own body in first person still lays its trail (`CG_Player` runs its
    // powerups for the local player), and the puff is the only thing it answers with.
    expect(
      rig.update(state({ ...haste, time: 0, legsAnim: ANIM.LEGS_RUN, hidden: true }))
    ).toEqual(vec3(10, 20, 14));
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('sarge (the retail paks)', () => {
  it('draws his default skin from three textures, and frees them when destroyed', async () => {
    const { app } = createTestApp();
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const cache = new TextureCache(app.graphicsDevice);
    const rig = await PlayerRig.create(app, await extractAssets(fs), cache, 'sarge');
    rig.update(state());
    // band.tga on four surfaces, and the cigar's two stages: its lit leaf and its glow.
    expect(cache.size).toBe(3);
    expect(rig.materialCount).toBe(6);
    await rig.destroy();
    await Promise.resolve();
    expect(cache.size).toBe(0);
    app.destroy();
  }, 30000);
});
