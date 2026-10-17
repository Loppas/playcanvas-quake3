// @vitest-environment jsdom
import {
  ASPECT_AUTO,
  ASPECT_MANUAL,
  BLEND_ADDITIVE,
  Layer,
  type AppBase,
  type Entity,
  type MeshInstance,
  type StandardMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AssetLibrary } from '../formats/asset-library';
import { findShader } from '../formats/shader-script';
import { PW } from '../sim/items';
import { vec3 } from '../sim/vec3';
import { WP } from '../sim/weapons/constants';
import { worldToSim } from '../coords';
import { SceneLights } from '../view/dynamic-lights';
import { entityLightAt } from '../view/entity-light';
import { WEAPON_SHELL_SHADERS } from '../view/powerup-passes';
import { VIEW_WEAPON_PART, viewWeaponEntity } from '../view/scene-sort';
import { SceneShaders } from '../view/scene-shaders';
import { IDLE_HAND } from '../view/viewmodel';
import { NO_SCENE_FOGS } from './bsp-fog';
import { createTestApp, expectClose, held, lightUniform, uniform } from './engine-test-fixtures';
import { deformView } from './deform-view';
import { DEFORM_SLOTS, writeDeforms, writeView } from './model-chunks';
import { frameTexture } from './model-frames';
import { playerLibrary } from './player-test-fixtures';
import { DEPTH_HACK_DEFINE, SceneDraws, sceneDraw } from './scene-draws';
import { lightInEntity } from './staged-model';
import { ViewmodelRig, type ViewmodelInput } from './viewmodel-rig';
import { WARM_TIMES } from './warm-up';

/** The view weapon, on the null device with the synthetic machinegun and railgun. */

const GUN = 'models/weapons2/machinegun/machinegun.md3';
const RAIL = 'models/weapons2/railgun/railgun.md3';

/** Standing still with the railgun up, 3 s in, its last shot 2 s ago, at a 90° view. */
function input(overrides: Partial<ViewmodelInput> = {}): ViewmodelInput {
  return {
    weapon: WP.RAILGUN,
    hand: IDLE_HAND,
    xyspeed: 0,
    bobCycle: 0,
    viewAngles: vec3(),
    landChange: 0,
    landTime: 0,
    time: 3000,
    lastFireTime: 1000,
    railFireTime: 1000,
    firing: false,
    powerups: 0,
    fov: 90,
    ...overrides
  };
}

const BARREL = 'models/weapons2/machinegun/machinegun_barrel.md3';
const FLASH = 'models/weapons2/machinegun/machinegun_flash.md3';

/** A draw's emissive colour. */
function emissive(instance: MeshInstance): number[] {
  const { r, g, b } = (instance.material as StandardMaterial).emissive;
  return [r, g, b];
}

describe('ViewmodelRig', () => {
  let app: AppBase;
  let camera: Entity;
  let library: AssetLibrary;
  let rig: ViewmodelRig;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    camera = test.camera;
    library = playerLibrary();
    rig = new ViewmodelRig(app, library, camera);
  });

  afterEach(() => {
    rig.destroy();
    app.destroy();
  });

  const guns = (name = GUN) => rig.root.find((node) => node.name === name) as Entity[];

  it('builds a weapon ahead of its first use, hidden, and shows that one when it is chosen', async () => {
    await rig.load(WP.MACHINEGUN);
    const [gun] = guns();
    expect([guns().length, gun.enabled]).toEqual([1, false]);

    await rig.select(WP.MACHINEGUN);
    expect(guns()).toEqual([gun]);
    expect(gun.enabled).toBe(true);
  });

  it('fails to load a weapon the install lacks, as choosing it would', async () => {
    await expect(rig.load(WP.PLASMAGUN)).rejects.toThrow();
    await expect(rig.select(WP.PLASMAGUN)).rejects.toThrow();
  });

  it("draws every stage of the gun's shader: lit, in color1, and mirroring the eye", async () => {
    await rig.select(WP.RAILGUN);
    rig.playerColor = [0, 1, 0];
    rig.update(input());
    const [gun] = guns(RAIL);
    const [base, glow, mirror] = gun.render!.meshInstances;
    expect((base.material as StandardMaterial).emissiveVertexColor).toBe(true);
    // `rgbGen entity` shows at twice color1, as classic Q3's ramp doubles it.
    expect(emissive(glow)).toEqual([0, 2, 0]);

    // The mirror's coordinates are made from where the eye is in the gun's own frame.
    expect((mirror.material as StandardMaterial).defines.get('Q3_TCGEN_ENV')).toBe(true);
    const eye = gun.getWorldTransform().clone().invert().transformPoint(camera.getPosition());
    expectClose(uniform(mirror, 'q3_viewer'), [eye.x, eye.y, eye.z, 1]);

    // Black at a shot.
    rig.update(input({ time: 5000, railFireTime: 5000 }));
    expect(emissive(glow)).toEqual([0, 0, 0]);
  });

  it("draws in a scene through the eye, its depth squeezed, and its own camera off", async () => {
    rig.destroy();
    const own = new Layer({ name: 'scene' });
    app.scene.layers.push(own);
    const scene = new SceneDraws(new SceneShaders(), {
      models: [],
      effects: [],
      gun: [],
      screen: []
    });
    rig = new ViewmodelRig(app, library, camera, undefined, scene);
    await rig.select(WP.MACHINEGUN);
    const view = camera.findByName('viewmodel-camera') as Entity;
    const [gun] = guns();
    const [rigLayer] = gun.render!.layers;
    scene.enter({ layer: own, fog: NO_SCENE_FOGS, key: () => {} });
    rig.visible = true;
    expect(view.enabled).toBe(false);
    expect(gun.render!.layers).toEqual([own.id]);
    rig.update(input({ weapon: WP.MACHINEGUN }));
    const [draw] = gun.render!.meshInstances;
    expect(sceneDraw(draw)!.depthHack).toBe(true);
    expect(sceneDraw(draw)!.entity.value).toBe(viewWeaponEntity(VIEW_WEAPON_PART.gun));
    const barrel = rig.root.findByName(BARREL) as Entity;
    expect(sceneDraw(barrel.render!.meshInstances[0])!.entity.value).toBe(
      viewWeaponEntity(VIEW_WEAPON_PART.barrel)
    );
    scene.order();
    expect((draw.material as StandardMaterial).getDefine(DEPTH_HACK_DEFINE)).toBe(true);
    // A splat map's: its own layer and camera again.
    scene.enter(null);
    rig.visible = true;
    expect(view.enabled).toBe(true);
    expect(gun.render!.layers).toEqual([rigLayer]);
    expect((draw.material as StandardMaterial).getDefine(DEPTH_HACK_DEFINE)).toBe(false);
  });

  it("spins the barrel on the next match's clock once the last match has gone", async () => {
    await rig.select(WP.MACHINEGUN);
    rig.update(input({ weapon: WP.MACHINEGUN, time: 90000, firing: false }));
    const barrel = rig.root.findByName(BARREL) as Entity;
    const rest = barrel.getLocalRotation().clone();
    rig.update(input({ weapon: WP.MACHINEGUN, time: 90100, firing: true }));
    rig.update(input({ weapon: WP.MACHINEGUN, time: 90400, firing: true }));
    expect(barrel.getLocalRotation().equals(rest)).toBe(false);

    rig.clear();
    await rig.settled();
    rig.update(input({ weapon: WP.MACHINEGUN, time: 16, firing: false }));
    expect(barrel.getLocalRotation().equalsApprox(rest, 1e-6)).toBe(true);
  });

  it("draws through the eye's projection, warp and all, and drops for cg_fov alone", async () => {
    await rig.select(WP.RAILGUN);
    const eye = camera.camera!;
    const view = (camera.findByName('viewmodel-camera') as Entity).camera!;
    const hand = rig.root.findByName('viewmodel-hand') as Entity;
    rig.update(input({ fov: 90 }));
    const level = hand.getLocalPosition().z;

    // Under water: the eye's angle and aspect its own, which the gun's camera takes.
    eye.fov = 72;
    eye.aspectRatioMode = ASPECT_MANUAL;
    eye.aspectRatio = 1.9;
    try {
      rig.update(input({ fov: 110 }));
      expect([view.fov, view.aspectRatioMode, view.aspectRatio]).toEqual([72, ASPECT_MANUAL, 1.9]);
      // `-0.2 * (cg_fov - 90)`, whatever the eye's warped angles.
      expect(hand.getLocalPosition().z).toBeCloseTo(level - 4, 5);
      rig.update(input({ fov: 90 }));
      expect(hand.getLocalPosition().z).toBeCloseTo(level, 5);
    } finally {
      eye.aspectRatioMode = ASPECT_AUTO;
    }
    rig.update(input());
    expect(view.aspectRatioMode).toBe(ASPECT_AUTO);
  });

  /** One of the rig's entities by name. */
  const piece = (name: string) => {
    const entity = rig.root.findByName(name);
    if (!entity) throw new Error(`no ${name}`);
    return entity as Entity;
  };

  it('shows every weapon and each gun shell for the warm-up, through its own camera', async () => {
    await rig.load(WP.MACHINEGUN);
    await rig.load(WP.RAILGUN);
    // Out of view, as under a load screen.
    rig.visible = false;
    const layer = app.scene.layers.getLayerByName('viewmodel')!;
    const view = camera.findByName('viewmodel-camera') as Entity;
    const shells = WEAPON_SHELL_SHADERS.map((shader) => `${shader}/gun`);

    const warmed = await rig.warm();
    warmed.at(0);
    expect(view.enabled).toBe(true);
    const drawn = layer.meshInstances.map((instance) => instance.node.name);
    // The shells on the first gun built.
    for (const name of [GUN, BARREL, FLASH, RAIL, ...shells]) expect(drawn, name).toContain(name);
    expect(piece(shells[0]).parent).toBe(piece(GUN));

    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect([view.enabled, rig.visible, layer.meshInstances]).toEqual([false, false, []]);
    // Each piece as it was: the guns and the shells kept, hidden.
    rig.visible = true;
    expect([GUN, RAIL, FLASH, ...shells].map((name) => piece(name).enabled)).toEqual(
      new Array(shells.length + 3).fill(false)
    );
  });

  /**
   * The machinegun up with these powerups held: a frame to ask for the shells, and a frame after
   * they land, which is the first they draw on.
   */
  async function holding(powerups: number, overrides: Partial<ViewmodelInput> = {}) {
    await rig.select(WP.MACHINEGUN);
    rig.update(input({ weapon: WP.MACHINEGUN, powerups, ...overrides }));
    await rig.settled();
    rig.update(input({ weapon: WP.MACHINEGUN, powerups, time: 3100, ...overrides }));
  }

  it("dresses the gun and barrel in the quad's weapon shell, each under its piece", async () => {
    await holding(1 << PW.QUAD);

    const gun = piece(GUN);
    const barrel = piece(BARREL);
    const onGun = piece('powerups/quadWeapon/gun');
    const onBarrel = piece('powerups/quadWeapon/barrel');
    expect([onGun.enabled, onBarrel.enabled]).toEqual([true, true]);
    // Under the piece at no offset, so the tag, the sway and the barrel's spin carry it.
    expect([onGun.parent, onBarrel.parent]).toEqual([gun, barrel]);
    const shellAt = onBarrel.getWorldTransform().data;
    const barrelAt = barrel.getWorldTransform().data;
    for (let i = 0; i < 16; i++) expect(shellAt[i]).toBeCloseTo(barrelAt[i], 6);
    // Additive, as `powerups/quadWeapon` is, over the gun's own shared mesh, in the rig's own
    // layer, so it shares the gun's depth and never the world's.
    const [shellDraw] = onGun.render!.meshInstances;
    const shellMaterial = shellDraw.material as StandardMaterial;
    expect(shellMaterial.blendType).toBe(BLEND_ADDITIVE);
    expect(shellDraw.mesh).toBe(gun.render!.meshInstances[0].mesh);
    expect(onGun.render!.layers).toEqual(gun.render!.layers);
    // The gun itself still draws.
    expect([gun.render!.enabled, barrel.render!.enabled]).toEqual([true, true]);

    // It stands half a unit off the gun, as `powerups/quadWeapon` swells, and mirrors the eye
    // off that swollen shape, the eye taken into the shell's own frame. The swell has no
    // frequency, so it packs alike at any moment.
    const packed = new Float32Array(DEFORM_SLOTS * 8);
    writeDeforms(findShader(library.shaders, 'powerups/quadWeapon')!.deforms, 0, packed);
    expect(uniform(shellDraw, 'q3_deform[0]')).toEqual([...packed]);
    expect(shellMaterial.defines.get('Q3_TCGEN_ENV')).toBe(true);
    const eye = onGun.getWorldTransform().clone().invert().transformPoint(camera.getPosition());
    expectClose(uniform(shellDraw, 'q3_viewer'), [eye.x, eye.y, eye.z, 1]);

    // And its stages play on the game clock: the shader's scroll moves on.
    const before = uniform(shellDraw, 'q3_coords[0]')[6];
    rig.update(input({ weapon: WP.MACHINEGUN, powerups: 1 << PW.QUAD, time: 3350 }));
    expect(uniform(shellDraw, 'q3_coords[0]')[6]).not.toBeCloseTo(before, 5);

    // Once the quad runs out, the shells go with it.
    rig.update(input({ weapon: WP.MACHINEGUN, time: 3400 }));
    expect([onGun.enabled, onBarrel.enabled]).toEqual([false, false]);
  });

  it("wears the battle suit's weapon shell, and the quad's too when both are held", async () => {
    await holding((1 << PW.QUAD) | (1 << PW.BATTLESUIT));
    expect(piece('powerups/battleWeapon/gun').enabled).toBe(true);
    expect(piece('powerups/battleWeapon/barrel').enabled).toBe(true);
    expect(piece('powerups/quadWeapon/gun').enabled).toBe(true);

    // The suit alone keeps its shell and lets the quad's go.
    rig.update(input({ weapon: WP.MACHINEGUN, powerups: 1 << PW.BATTLESUIT, time: 3200 }));
    expect(piece('powerups/battleWeapon/gun').enabled).toBe(true);
    expect(piece('powerups/quadWeapon/gun').enabled).toBe(false);
  });

  it('draws an invisible gun and barrel as their shells alone, and the flash as always', async () => {
    // A shot this instant, so the flash is due.
    await holding(1 << PW.INVIS, { lastFireTime: 3100 });

    const gun = piece(GUN);
    const barrel = piece(BARREL);
    // Their own surfaces are not drawn; what hangs under them still is.
    expect([gun.render!.enabled, barrel.render!.enabled]).toEqual([false, false]);
    expect([gun.enabled, barrel.enabled]).toEqual([true, true]);
    expect(piece('powerups/invisibility/gun').enabled).toBe(true);
    expect(piece('powerups/invisibility/barrel').enabled).toBe(true);
    expect(piece(FLASH).enabled).toBe(true);

    // Seen again once it wears off.
    rig.update(input({ weapon: WP.MACHINEGUN, time: 3200 }));
    expect([gun.render!.enabled, barrel.render!.enabled]).toEqual([true, true]);
    expect(piece('powerups/invisibility/gun').enabled).toBe(false);
  });

  it("binds the flash's draws, lit by how it is turned and facing the eye", async () => {
    rig.destroy();
    rig = new ViewmodelRig(app, library, camera);
    await rig.select(WP.MACHINEGUN);
    // Looking up and to the side, a shot this instant, where the flash's move is at its crest.
    rig.update(
      input({ weapon: WP.MACHINEGUN, viewAngles: vec3(-30, 45, 0), time: 3250, lastFireTime: 3250 })
    );
    const flash = piece(FLASH);
    expect(flash.enabled).toBe(true);
    const [draw] = flash.render!.meshInstances;
    const surface = library.model(FLASH).surfaces[0];
    expect(held(draw, 'q3_frames')).toBe(frameTexture(app.graphicsDevice, surface));
    expectClose(uniform(draw, 'q3_light[0]'), lightUniform(lightInEntity(flash)));
    // Its deform moves on the game clock, as its stages do.
    const packed = new Float32Array(DEFORM_SLOTS * 8);
    writeDeforms(library.shaders.get('models/weapons2/machinegun/flash')!.deforms, 3.25, packed);
    expect(packed[6]).toBeCloseTo(1, 5);
    expect(uniform(draw, 'q3_deform[0]')).toEqual([...packed]);
    // Its pivot by where the eye looks, once the flash is placed and rolled.
    const view = new Float32Array(16);
    writeView(deformView(flash, camera), view);
    expectClose(uniform(draw, 'q3_view[0]'), view);
  });

  it('lights the gun, the barrel and the flash each at its own origin, the scene’s lights folded in', async () => {
    rig.destroy();
    const lights = new SceneLights();
    rig = new ViewmodelRig(app, library, camera, lights);
    await rig.select(WP.MACHINEGUN);
    // A quad's light at the player's origin, below the eye. The hand has no lighting origin, so
    // each piece takes it where the piece is.
    const eye = camera.getPosition();
    const at = worldToSim(eye.x, eye.y, eye.z);
    lights.add({ x: at.x, y: at.y, z: at.z - 26 }, 216, [0.2, 0.2, 1]);
    rig.update(input({ weapon: WP.MACHINEGUN, time: 3250, lastFireTime: 3250 }));
    const drawn = [GUN, BARREL, FLASH].map((name) => {
      const part = piece(name);
      const where = part.getPosition();
      const lit = entityLightAt(worldToSim(where.x, where.y, where.z), lights);
      const light = uniform(part.render!.meshInstances[0], 'q3_light[0]');
      expectClose(light, lightUniform(lightInEntity(part, lit)));
      return light;
    });
    // The gun and the barrel stand at different distances from it.
    expect(drawn[0][6]).not.toBeCloseTo(drawn[1][6], 3);
  });

  it("gives off its flash's light where it places the flash, while the gun is drawn", async () => {
    rig.destroy();
    const lights = new SceneLights();
    rig = new ViewmodelRig(app, library, camera, lights);
    await rig.select(WP.MACHINEGUN);
    rig.visible = true;
    rig.pose(input({ weapon: WP.MACHINEGUN, time: 3250, lastFireTime: 3250 }));
    const where = piece(FLASH).getPosition();
    expect(rig.flashDlight()).toEqual({
      origin: worldToSim(where.x, where.y, where.z),
      weapon: WP.MACHINEGUN
    });
    // A light added after the pose lights the gun when it is drawn.
    const at = worldToSim(where.x, where.y, where.z);
    lights.add(at, 300, [1, 1, 0]);
    rig.draw();
    const gun = piece(GUN);
    const placed = gun.getPosition();
    const lit = entityLightAt(worldToSim(placed.x, placed.y, placed.z), lights);
    const drawn = uniform(gun.render!.meshInstances[0], 'q3_light[0]');
    expectClose(drawn, lightUniform(lightInEntity(gun, lit)));
    // None once the flash is out, nor while the gun is not drawn.
    expect(rig.flashDlight()).toBeNull();
    rig.pose(input({ weapon: WP.MACHINEGUN, time: 3300, lastFireTime: 3250 }));
    expect(rig.flashDlight()).toBeNull();
    rig.visible = false;
    rig.pose(input({ weapon: WP.MACHINEGUN, time: 3310, lastFireTime: 3310 }));
    expect(rig.flashDlight()).toBeNull();
  });

  it('puts no shell on the view weapon for regeneration, a body-only shell', async () => {
    // 3.1 s in is regeneration's tenth of a second, when a body's shell would show.
    await holding(1 << PW.REGEN);
    expect(rig.root.find((node) => node.name.startsWith('powerups/'))).toEqual([]);
  });
});
