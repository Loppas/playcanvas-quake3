// @vitest-environment jsdom
import {
  BLEND_NONE,
  SORTMODE_MANUAL,
  Vec3,
  Vec4,
  type AppBase,
  type Entity,
  type StandardMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { AMMO_MODELS, ARMOR_MODEL } from '../formats/asset-manifest';
import { buildMd3 } from '../formats/md3-test-fixtures';
import {
  ALL_WEAPONS,
  AMMO_INFINITE,
  MAX_WEAPONS,
  WEAPON_READY,
  WP
} from '../sim/weapons/constants';
import { GT, SCORE_NOT_PRESENT, TEAM } from '../sim/constants';
import { ARMOR_TIER, GREEN_ARMOR_TINT, findItemForArmorTier } from '../sim/items';
import { createCenterPrint } from '../view/center-print';
import { createRewardState } from '../view/rewards';
import { DAMAGE_TIME } from '../view/damage-feedback';
import { anglesToAxis } from '../view/hand-pose';
import { Lagometer } from '../view/lagometer';
import {
  createHudState,
  hudFrame,
  type HudInput,
  type HudSettings,
  type StatusBar
} from '../view/hud';
import { screenRect, type HudAnchor, type HudRect } from '../view/hud-layout';
import { AMMO_X, ARMOR_X, iconRect } from '../view/hud-status';
import { createTestApp, expectClose, uniform } from './engine-test-fixtures';
import { HudIcons, ICON_CAMERA_PRIORITY } from './hud-icons';
import { HUD_CAMERA_PRIORITY } from './hud-screen';
import { encode, whiteTga } from './player-test-fixtures';
import { TextureCache } from './texture-cache';
import { WARM_TIMES } from './warm-up';

/**
 * The HUD's 3D icons on the null device: synthetic ammo boxes, an armor whose energy
 * adds over its body as armor_yel's does, mirroring, and two heads to swap between.
 */

const SHADERS = `
models/powerups/armor/energy_yel1
{
  { map models/powerups/armor/energy_yel3.tga blendFunc GL_ONE GL_ONE tcGen environment
    tcMod scroll 7.4 1.3
      }
}
`;

/** The views, in the order the status bar draws them. */
const VIEWS = ['hud-ammo', 'hud-head', 'hud-armor'];

/** The red armour's model, which the table names. */
const RED_ARMOR = findItemForArmorTier(ARMOR_TIER.RA)!.worldModel[0]!;

/** Every ammo box, the armours unless left out, and heads for models `test` and `other`. */
function library({ armor = true } = {}): AssetLibrary {
  const box = buildMd3({ surfaces: [{ name: 'box', shader: 'models/powerups/ammo/ammo.tga' }] });
  const files = new Map<string, Uint8Array>([
    ['scripts/models.shader', encode(SHADERS)],
    ['models/powerups/ammo/ammo.tga', whiteTga()],
    ...[...AMMO_MODELS.values()].map((path): [string, Uint8Array] => [path, box]),
    ['models/powerups/armor/newyellow.tga', whiteTga()],
    ['models/powerups/armor/energy_yel3.tga', whiteTga()]
  ]);
  if (armor) {
    files.set(
      ARMOR_MODEL,
      buildMd3({
        surfaces: [
          { name: 'armor', shader: 'models/powerups/armor/newyellow.tga' },
          { name: 'energy', shader: 'models/powerups/armor/energy_yel1' }
        ]
      })
    );
    files.set(
      RED_ARMOR,
      buildMd3({ surfaces: [{ name: 'armor', shader: 'models/powerups/armor/newyellow.tga' }] })
    );
  }
  for (const model of ['test', 'other']) {
    const dir = `models/players/${model}/`;
    files.set(`${dir}head.md3`, buildMd3({ surfaces: [{ name: 'h_head' }] }));
    files.set(`${dir}skin.tga`, whiteTga());
    files.set(`${dir}head_default.skin`, encode(`h_head,${dir}skin.tga\n`));
  }
  return new AssetLibrary(files);
}

/** `STAT_WEAPONS` with every weapon the player spawns with. */
const OWNED = ALL_WEAPONS.reduce<number>((bits, weapon) => bits | (1 << weapon), 0);

/** The status bar the 2D HUD draws for a fresh spawn 5 s in, as `hud-screen.test.ts` has it. */
function statusBar(
  overrides: Partial<HudInput> = {},
  settings: Partial<HudSettings> = {}
): StatusBar | null {
  const input: HudInput = {
    health: 125,
    armor: 0,
    armorTier: 0,
    weapon: WP.MACHINEGUN,
    weapons: OWNED,
    ammo: new Array<number>(MAX_WEAPONS).fill(AMMO_INFINITE),
    lowAmmo: [],
    weaponState: WEAPON_READY,
    weaponTime: 0,
    weaponSelect: WP.MACHINEGUN,
    weaponSelectTime: Number.NEGATIVE_INFINITY,
    damage: { time: Number.NEGATIVE_INFINITY, x: 0 },
    thirdPerson: false,
    speed: 0,
    peak: 0,
    time: 5000,
    realTime: 0,
    gametype: GT.FFA,
    scores1: SCORE_NOT_PRESENT,
    scores2: SCORE_NOT_PRESENT,
    score: 0,
    team: TEAM.FREE,
    clientNum: 0,
    pmFlags: 0,
    pmType: 0,
    fraglimit: 20,
    capturelimit: 8,
    roundlimit: 0,
    redflag: -1,
    blueflag: -1,
    warmup: 0,
    clientInfo: () => null,
    showScores: false,
    powerups: [],
    powerupActive: 0,
    powerupTime: 0,
    holdable: 0,
    pickup: 0,
    pickupTime: 0,
    centerPrint: createCenterPrint(),
    rewards: createRewardState(),
    interrupted: false,
    localServer: true,
    lagometer: new Lagometer(),
    ...overrides
  };
  return hudFrame(createHudState(() => 0.5), input, {
    draw2D: true,
    draw3dIcons: true,
    drawCrosshair: 4,
    crosshairSize: 24,
    drawFPS: false,
    lagometer: true,
    noPredict: false,
    speedometer: 0,
    centerTime: 3,
    drawRewards: true,
    ...settings
  }).statusBar;
}

describe('HudIcons', () => {
  let app: AppBase;
  let eye: Entity;
  let cache: TextureCache;
  let icons: HudIcons;

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    eye = test.camera;
    app.graphicsDevice.resizeCanvas(1920, 1080);
    cache = new TextureCache(app.graphicsDevice);
    icons = await HudIcons.create(app, library(), eye, cache);
  });

  afterEach(() => {
    icons.destroy();
    app.destroy();
  });

  const cameraOf = (view: string) => app.root.findByName(`${view}-camera`) as Entity;
  /** The views drawing now. */
  const drawing = () => VIEWS.filter((view) => cameraOf(view).enabled);
  /** The models a view shows now. */
  const shown = (view: string) =>
    (app.root.findByName(`${view}-models`) as Entity).children.filter(
      (child) => child.enabled
    ) as Entity[];
  const position = (entity: Entity) => [...entity.getLocalPosition().toArray()];
  /** Where an entity's forward points, in its parent's frame. */
  const forward = (entity: Entity) =>
    entity.getLocalRotation().transformVector(new Vec3(1, 0, 0)).toArray();

  it('shows every model through its own camera for the warm-up, then puts them back', async () => {
    await icons.setPlayerModel('test');
    const models = (view: string) => (app.root.findByName(`${view}-models`) as Entity).children;
    const rect = (view: string) => [...cameraOf(view).camera!.rect.toArray()];
    cameraOf('hud-ammo').camera!.rect = new Vec4(0.1, 0.2, 0.05, 0.08);
    const drawnIn = VIEWS.map(rect);
    const warmed = icons.warm();
    warmed.at(0);
    expect(drawing()).toEqual(VIEWS);
    for (const view of VIEWS) expect(shown(view), view).toHaveLength(models(view).length);
    expect(shown('hud-ammo')).toHaveLength(AMMO_MODELS.size);
    // Over the middle of the screen, whatever box the view last drew in, and short of the whole,
    // so its clear is drawn as in play.
    for (const view of VIEWS) expect(rect(view), view).toEqual([0.25, 0.25, 0.5, 0.5]);

    warmed.at(WARM_TIMES[1]);
    warmed.end();
    expect(drawing()).toEqual([]);
    expect(VIEWS.map((view) => shown(view))).toEqual([[], [], []]);
    expect(VIEWS.map(rect)).toEqual(drawnIn);
  });

  it("draws each icon from a camera of its own, after the view weapon's and before the HUD's", () => {
    expect(ICON_CAMERA_PRIORITY).toBeGreaterThan(1);
    expect(ICON_CAMERA_PRIORITY).toBeLessThan(HUD_CAMERA_PRIORITY);
    const layers = VIEWS.map((view) => {
      const camera = cameraOf(view).camera!;
      expect(camera.priority).toBe(eye.camera!.priority + ICON_CAMERA_PRIORITY);
      // Depth cleared over the box, and the world left showing through.
      expect(camera.clearDepthBuffer).toBe(true);
      expect(camera.clearColorBuffer).toBe(false);
      expect(camera.fov).toBe(30);
      expect(camera.layers).toHaveLength(1);
      return camera.layers[0];
    });
    expect(new Set(layers).size).toBe(3);
    for (const layer of layers) expect(eye.camera!.layers).not.toContain(layer);
  });

  it("sets each view over its icon's box, as the 2D HUD lays it out", async () => {
    await icons.setPlayerModel('test');
    const bar = statusBar({ armor: 50 })!;
    icons.update(bar, 5000);
    expect(drawing()).toEqual(VIEWS);

    const expectRect = (view: string, rect: HudRect, anchor: HudAnchor) => {
      const pixels = screenRect(rect, anchor, 1920, 1080);
      const expected = [
        pixels.x / 1920,
        1 - (pixels.y + pixels.h) / 1080,
        pixels.w / 1920,
        pixels.h / 1080
      ];
      const actual = [...cameraOf(view).camera!.rect.toArray()];
      actual.forEach((value, i) => expect(value, view).toBeCloseTo(expected[i], 9));
    };
    // The ammo box keeps to the left edge, the head and the armor to the middle.
    expectRect('hud-ammo', iconRect(AMMO_X), 'left');
    const { head } = bar;
    expectRect('hud-head', { x: head.x, y: head.y, w: head.size, h: head.size }, 'centre');
    expectRect('hud-armor', iconRect(ARMOR_X), 'centre');
    // Square on screen, so the 30° view is 30° both ways.
    const [, , w, h] = [...cameraOf('hud-ammo').camera!.rect.toArray()];
    expect(w * 1920).toBeCloseTo(h * 1080, 9);
  });

  it('keeps the flinching head on the canvas, where WebGPU needs its scissor', async () => {
    // At 1280x720 some of the flinch's boxes sum a hair past the bottom edge. Floored, as the
    // engine turns a rect into pixels, that is a row below the canvas.
    app.graphicsDevice.resizeCanvas(1280, 720);
    await icons.setPlayerModel('test');
    let past = 0;
    for (let t = 0; t < DAMAGE_TIME; t++) {
      const bar = statusBar({ damage: { time: 5000, x: 0 }, time: 5000 + t })!;
      const { head } = bar;
      const box = { x: head.x, y: head.y, w: head.size, h: head.size };
      const pixels = screenRect(box, 'centre', 1280, 720);
      if (1 - (pixels.y + pixels.h) / 720 < 0) past++;
      icons.update(bar, 5000 + t);
      const [, y, , h] = [...cameraOf('hud-head').camera!.rect.toArray()];
      expect(Math.floor(y * 720), `${t} ms in`).toBeGreaterThanOrEqual(0);
      expect(Math.floor(y * 720) + Math.floor(h * 720), `${t} ms in`).toBeLessThanOrEqual(720);
    }
    // Frames that would have left the canvas, so the check above had something to hold.
    expect(past).toBeGreaterThan(0);
  });

  it('draws no view on a canvas with no area, and draws each again once it has one', async () => {
    await icons.setPlayerModel('test');
    const bar = statusBar({ armor: 50 })!;
    for (const [width, height] of [[0, 0], [0, 1080], [1920, 0]]) {
      app.graphicsDevice.resizeCanvas(width, height);
      icons.update(bar, 5000);
      expect(drawing(), `${width}x${height}`).toEqual([]);
      for (const view of VIEWS) {
        expect(cameraOf(view).camera!.rect.toArray().every(Number.isFinite), view).toBe(true);
      }

      app.graphicsDevice.resizeCanvas(1920, 1080);
      icons.update(bar, 5000);
      expect(drawing()).toEqual(VIEWS);
    }
  });

  it("spins the held weapon's ammo box and the armor where CG_Draw3DModel sets them", () => {
    const bar = statusBar({ weapon: WP.ROCKET_LAUNCHER, armor: 50 })!;
    icons.update(bar, 5000);

    const boxes = shown('hud-ammo');
    expect(boxes.map((box) => box.name)).toEqual([AMMO_MODELS.get(WP.ROCKET_LAUNCHER)]);
    expect(position(boxes[0])).toEqual([70, 0, 0]);
    const [look] = anglesToAxis(...bar.ammoModel!.angles);
    forward(boxes[0]).forEach((value, i) => expect(value).toBeCloseTo(look[i], 5));

    const [armor] = shown('hud-armor');
    expect(armor.name).toBe('item_armor_combat');
    expect(position(armor)).toEqual([90, 0, -10]);
  });

  it("shows the armour its tier's item is drawn as, the green in its tint", () => {
    const shownFor = (armorTier: number) => {
      icons.update(statusBar({ armor: 50, armorTier }), 5000);
      return shown('hud-armor').map((model) => model.name);
    };
    expect(shownFor(ARMOR_TIER.GA)).toEqual(['item_armor_jacket']);
    expect(shownFor(ARMOR_TIER.RA)).toEqual(['item_armor_body']);
    expect(shownFor(3)).toEqual([]);
    expect(shownFor(ARMOR_TIER.YA)).toEqual(['item_armor_combat']);

    // The green is the yellow's model: its body and its energy, played or not, in the tint.
    const colours = (name: string) =>
      (app.root.findByName(name) as Entity).render!.meshInstances.map((draw) => {
        const { r, g, b } = (draw.material as StandardMaterial).emissive;
        return [r, g, b];
      });
    const yellow = colours('item_armor_combat');
    expect(yellow).toHaveLength(2);
    expect(colours('item_armor_jacket')).toEqual(
      yellow.map((colour) => colour.map((value, i) => value * GREEN_ARMOR_TINT[i]))
    );
  });

  it('draws a view only while it has something to show', async () => {
    // The gauntlet has no ammo box, there is no armor, and no head is built yet.
    icons.update(statusBar({ weapon: WP.GAUNTLET }), 5000);
    expect(drawing()).toEqual([]);
    icons.update(statusBar(), 5000);
    expect(drawing()).toEqual(['hud-ammo']);
    await icons.setPlayerModel('test');
    icons.update(statusBar(), 5000);
    expect(drawing()).toEqual(['hud-ammo', 'hud-head']);

    // Icons in 2D draw no models; dead, or with cg_draw2D 0, there is no status bar at all.
    icons.update(statusBar({}, { draw3dIcons: false }), 5000);
    expect(drawing()).toEqual([]);
    icons.update(statusBar({ health: 0 }), 5000);
    expect(drawing()).toEqual([]);
    expect(shown('hud-ammo')).toEqual([]);
    expect(shown('hud-head')).toEqual([]);
  });

  it("frames the head from its frame-0 bounds and the model's headoffset, turned as it looks", async () => {
    await icons.setPlayerModel('test', 'default', [1, 2, 3]);
    const bar = statusBar()!;
    icons.update(bar, 5000);
    const [head] = shown('hud-head');
    // buildMd3 bounds every frame by ±1: 0.7 of its 2 units, backed off to fill the 30° view.
    const expected = [(0.7 * 2) / 0.268 + 1, 2, 3];
    position(head).forEach((value, i) => expect(value).toBeCloseTo(expected[i], 5));
    const [look] = anglesToAxis(bar.head.pitch, bar.head.yaw, 0);
    forward(head).forEach((value, i) => expect(value).toBeCloseTo(look[i], 5));
  });

  it('gives back the old head when the model changes, and a head that lands too late', async () => {
    const items = cache.size;
    await icons.setPlayerModel('test');
    expect(cache.size).toBe(items + 1);
    await icons.setPlayerModel('other');
    // The old skin's texture is gone, and the new one's held.
    expect(cache.size).toBe(items + 1);
    expect(app.root.find((node) => node.name === 'head')).toHaveLength(1);
    icons.update(statusBar(), 5000);
    const [head] = shown('hud-head');
    const material = head.render!.meshInstances[0].material as StandardMaterial;
    expect(material.emissiveMap!.name).toBe('models/players/other/skin.tga');

    // Asked for twice at once, the last asked for wins, and the other goes as it lands.
    await Promise.all([icons.setPlayerModel('test'), icons.setPlayerModel('other')]);
    expect(app.root.find((node) => node.name === 'head')).toHaveLength(1);
    expect(cache.size).toBe(items + 1);

    // One still building when the icons go is given back as it lands.
    const late = icons.setPlayerModel('test');
    icons.destroy();
    await late;
    expect(cache.size).toBe(0);
  });

  it("draws the armor's additive energy over its body, in the order its surfaces come", () => {
    const armor = app.root.findByName('item_armor_combat') as Entity;
    const layer = app.scene.layers.getLayerById(armor.render!.layers[0])!;
    expect(layer.name).toBe('hud-armor');
    expect(layer.transparentSortMode).toBe(SORTMODE_MANUAL);
    const [body, energy] = armor.render!.meshInstances;
    expect(energy.drawOrder).toBeGreaterThan(body.drawOrder);
    expect(body.material!.blendType).toBe(BLEND_NONE);
    expect(energy.material!.blendType).not.toBe(BLEND_NONE);

    // Its scroll plays on the game clock while the armor shows.
    icons.update(statusBar({ armor: 50 }), 5000);
    const before = uniform(energy, 'q3_coords[0]')[6];
    icons.update(statusBar({ armor: 50, time: 5100 }), 5100);
    expect(uniform(energy, 'q3_coords[0]')[6]).not.toBeCloseTo(before, 5);
  });

  it("mirrors the armor's energy by where its view's own camera is", () => {
    icons.update(statusBar({ armor: 50 }), 5000);
    const armor = app.root.findByName('item_armor_combat') as Entity;
    const [, energy] = armor.render!.meshInstances;
    const at = cameraOf('hud-armor').getPosition();
    const eye = armor.getWorldTransform().clone().invert().transformPoint(at);
    expectClose(uniform(energy, 'q3_viewer'), [eye.x, eye.y, eye.z, 1]);
  });

  it('leaves out a model the install lacks, and draws nothing for it', async () => {
    icons.destroy();
    icons = await HudIcons.create(app, library({ armor: false }), eye, cache);
    icons.update(statusBar({ armor: 50 }), 5000);
    expect(drawing()).toEqual(['hud-ammo']);
  });

  it('takes its views away and gives back every texture', async () => {
    await icons.setPlayerModel('test');
    icons.destroy();
    for (const view of VIEWS) {
      expect(app.root.findByName(`${view}-camera`)).toBeNull();
      expect(app.root.findByName(`${view}-models`)).toBeNull();
      expect(app.scene.layers.getLayerByName(view)).toBeFalsy();
    }
    expect(cache.size).toBe(0);
  });
});
