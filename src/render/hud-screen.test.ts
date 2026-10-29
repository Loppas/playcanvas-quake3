// @vitest-environment jsdom
import {
  BLEND_NORMAL,
  CULLFACE_NONE,
  LAYERID_UI,
  PROJECTION_ORTHOGRAPHIC,
  Vec3,
  type AppBase,
  type Entity,
  type Layer,
  type MeshInstance,
  type StandardMaterial
} from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { NUMBER_NAMES, WEAPON_ASSETS } from '../formats/asset-manifest';
import { ALL_WEAPONS, AMMO_INFINITE, MAX_WEAPONS, WEAPON_READY, WP } from '../sim/weapons/constants';
import { GT, SCORE_NOT_PRESENT, TEAM } from '../sim/constants';
import { ITEMS } from '../sim/items';
import type { HudInput, HudSettings } from '../view/hud';
import { createCenterPrint } from '../view/center-print';
import { ConsoleBuffer } from '../view/console-buffer';
import { createRewardState } from '../view/rewards';
import { createAttacker } from '../view/attacker';
import { addToTeamChat, createTeamChat } from '../view/team-chat';
import { screenRect, type HudAnchor, type HudRect } from '../view/hud-layout';
import { Lagometer } from '../view/lagometer';
import { notifyRows, type NotifyRow } from '../view/notify-lines';
import { createTestApp } from './engine-test-fixtures';
import { HUD_CAMERA_PRIORITY, HudScreen } from './hud-screen';
import type { GammaVertexColorMaterial } from './md3-mesh';
import { encode, whiteTga } from './player-test-fixtures';
import { TextureCache } from './texture-cache';

/**
 * The HUD's 2D half on the null device, with its shaders in the shapes this install's
 * `gfx.shader` gives them, and a crosshair b as the retail scripts write b–j, which ignores the
 * colour. What each picture is, where on the grid and in what colour, is `view/hud-draw.test.ts`'s;
 * this reads the quads the batch was given, in the canvas's pixels, and the draws they make.
 */

const SHADERS = `
white { { map *white blendfunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbgen vertex } }
${NUMBER_NAMES.map(
  (name) =>
    `gfx/2d/numbers/${name}_32b { nopicmip { map gfx/2d/numbers/${name}_32b.tga ` +
    'blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbgen vertex } }'
).join('\n')}
gfx/2d/bigchars { nopicmip nomipmaps { map gfx/2d/bigchars.tga
  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbgen vertex } }
gfx/2d/crosshaire { nopicmip { map gfx/2d/crosshaire.tga blendFunc blend rgbGen exactVertex } }
gfx/2d/crosshairb { nopicmip { map gfx/2d/crosshairb.tga blendFunc blend rgbGen identity } }
gfx/2d/select { nopicmip { map gfx/2d/select.tga
  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA rgbGen identity rgbgen vertex } }
lagometer { nopicmip { map gfx/2d/lag.tga } }
${WEAPON_ASSETS.map(
  (asset) =>
    `${asset.icon} { nopicmip { map ${asset.icon}.tga blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA } }`
).join('\n')}
`;

/** Every image the HUD draws, white; `icons/noammo`, the net icon and sarge's have no script. */
function library(): AssetLibrary {
  const images = [
    ...NUMBER_NAMES.map((name) => `gfx/2d/numbers/${name}_32b.tga`),
    'gfx/2d/bigchars.tga',
    'gfx/2d/crosshaire.tga',
    'gfx/2d/crosshairb.tga',
    'gfx/2d/select.tga',
    'icons/noammo.tga',
    ...WEAPON_ASSETS.map((asset) => `${asset.icon}.tga`),
    ...ITEMS.slice(1).map((item) => `${item.icon}.tga`),
    'models/players/sarge/icon_default.tga',
    'gfx/2d/net.tga',
    'gfx/2d/lag.tga',
    'gfx/2d/colorbar.tga'
  ];
  return new AssetLibrary(
    new Map<string, Uint8Array>([
      ['scripts/gfx.shader', encode(SHADERS)],
      ...images.map((path): [string, Uint8Array] => [path, whiteTga()])
    ])
  );
}

/** `STAT_WEAPONS` with every weapon the player spawns with. */
const OWNED = ALL_WEAPONS.reduce<number>((bits, weapon) => bits | (1 << weapon), 0);

/** Ammo per weapon, the same for all. */
const ammoOf = (count: number) => new Array<number>(MAX_WEAPONS).fill(count);

/** A fresh spawn 5 s in, as `view/hud.test.ts` has it. */
function input(overrides: Partial<HudInput> = {}): HudInput {
  return {
    health: 125,
    armor: 0,
    armorTier: 0,
    weapon: WP.MACHINEGUN,
    weapons: OWNED,
    ammo: ammoOf(AMMO_INFINITE),
    lowAmmo: [],
    weaponState: WEAPON_READY,
    weaponTime: 0,
    weaponSelect: WP.MACHINEGUN,
    weaponSelectTime: Number.NEGATIVE_INFINITY,
    damage: { time: Number.NEGATIVE_INFINITY, x: 0 },
    attacker: createAttacker(),
    attackerNum: 0,
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
    teamChat: createTeamChat(),
    ownTeam: TEAM.FREE,
    interrupted: false,
    localServer: true,
    lagometer: new Lagometer(),
    ...overrides
  };
}

const SETTINGS: HudSettings = {
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
  teamChatHeight: 0,
  teamChatTime: 3000
};

const CHARSET = 'gfx/2d/bigchars.tga';

/**
 * A quad as the batch was given it: its image, its rectangle in the canvas's pixels, its texture's
 * corners and its colour in bytes.
 */
interface Quad {
  image: string;
  rect: [number, number, number, number];
  st: [number, number, number, number];
  color: number[];
}

/** The notify lines of a print, a second in. */
function printed(text: string): NotifyRow[] {
  const buffer = new ConsoleBuffer();
  buffer.print(text, 1000);
  return notifyRows(buffer, { notifyLines: 3, notifyTime: 3, conXOffset: 0, conScale: 1 }, 1000, false);
}

describe('HudScreen', () => {
  let app: AppBase;
  let eye: Entity;
  let layer: Layer;
  let hud: HudScreen;

  /** A HUD with its own settings. */
  async function create(settings: Partial<HudSettings> = {}): Promise<HudScreen> {
    hud?.destroy();
    hud = await HudScreen.create(
      app,
      library(),
      eye,
      new TextureCache(app.graphicsDevice),
      { ...SETTINGS, ...settings },
      () => 0.5
    );
    return hud;
  }

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    eye = test.camera;
    layer = app.scene.layers.getLayerById(LAYERID_UI)!;
    app.graphicsDevice.resizeCanvas(1024, 768);
    await create();
  });

  afterEach(() => {
    hud.destroy();
    app.destroy();
  });

  /** The HUD's draws in its layer, shown or not. */
  function allDraws(): MeshInstance[] {
    const node = app.root.findByName('hud');
    return layer.meshInstances.filter((instance) => node && instance.node === node);
  }

  /** The HUD's draws shown, in the order the layer draws them. */
  function draws(): MeshInstance[] {
    return allDraws()
      .filter((instance) => instance.visible)
      .sort((a, b) => a.drawOrder - b.drawOrder);
  }

  /** A draw's image. */
  const imageOf = (draw: MeshInstance) => (draw.material as StandardMaterial).emissiveMap!.name;

  /** Every quad shown, in drawing order. */
  function quads(): Quad[] {
    const written: Quad[] = [];
    for (const draw of draws()) {
      const { base, count } = draw.mesh!.primitive[0];
      const storage = draw.mesh!.vertexBuffer.storage;
      const floats = new Float32Array(storage);
      const bytes = new Uint8Array(storage);
      for (let quad = base / 6; quad < (base + count) / 6; quad++) {
        // The top-left corner and the bottom-right, 6 floats a corner.
        const a = quad * 4 * 6;
        const c = (quad * 4 + 2) * 6;
        written.push({
          image: imageOf(draw),
          rect: [floats[a], floats[a + 1], floats[c] - floats[a], floats[c + 1] - floats[a + 1]],
          st: [floats[a + 3], floats[a + 4], floats[c + 3], floats[c + 4]],
          color: [...bytes.subarray(quad * 96 + 20, quad * 96 + 24)]
        });
      }
    }
    return written;
  }

  /** The quads of an image. */
  const of = (image: string) => quads().filter((quad) => quad.image === image);

  /** The speed graph's columns: `white` pictures a pixel wide. */
  const columns = () => of('*white').filter((quad) => quad.rect[2] < 1.01);

  /** Assert a quad lies where a rectangle on Q3's grid lands on this canvas. */
  function expectAt(quad: Quad, rect: HudRect, anchor: HudAnchor): void {
    const { width, height } = app.graphicsDevice;
    const { x, y, w, h } = screenRect(rect, anchor, width, height);
    [x, y, w, h].forEach((value, i) => expect(quad.rect[i]).toBeCloseTo(value, 3));
  }

  /** The ranges the engine draws in a frame, in its order. */
  function rendered(): number {
    let count = 0;
    const draw = vi.spyOn(app.graphicsDevice, 'draw').mockImplementation(() => {
      count++;
    });
    app.render();
    draw.mockRestore();
    return count;
  }

  it("draws from an orthographic camera of its own after the view weapon's, and takes the UI off the eye", () => {
    const camera = (app.root.findByName('hud-camera') as Entity).camera!;
    expect(camera.layers).toEqual([LAYERID_UI]);
    expect(camera.priority).toBe(eye.camera!.priority + HUD_CAMERA_PRIORITY);
    expect(camera.projection).toBe(PROJECTION_ORTHOGRAPHIC);
    expect(eye.camera!.layers).not.toContain(LAYERID_UI);

    hud.update(input(), []);
    expect(draws().length).toBeGreaterThan(0);
    hud.destroy();
    expect(app.root.findByName('hud')).toBeNull();
    expect(app.root.findByName('hud-camera')).toBeNull();
    expect(layer.meshInstances).toEqual([]);
    expect(eye.camera!.layers).toContain(LAYERID_UI);
  });

  it("sees the canvas's pixels from the top left, as Q3's 2D does, on any canvas", () => {
    const camera = (app.root.findByName('hud-camera') as Entity).camera!;
    const node = app.root.findByName('hud') as Entity;
    for (const [width, height] of [
      [1024, 768],
      [2560, 1080]
    ]) {
      app.graphicsDevice.resizeCanvas(width, height);
      hud.update(input(), []);
      app.render();
      for (const [x, y] of [
        [0, 0],
        [width, height],
        [100, 700]
      ]) {
        const world = node.getWorldTransform().transformPoint(new Vec3(x, y, 0));
        const screen = camera.camera.worldToScreen(world, width, height);
        expect(screen.x, `${width}×${height}`).toBeCloseTo(x, 3);
        expect(screen.y).toBeCloseTo(y, 3);
      }
    }
  });

  it("lays the status bar out on Q3's grid, scaled by the height, at 4:3, 16:9 and 21:9", async () => {
    await create({ speedometer: 1 });
    for (const [width, height] of [
      [1024, 768],
      [1920, 1080],
      [2560, 1080]
    ]) {
      app.graphicsDevice.resizeCanvas(width, height);
      for (let frame = 0; frame < 3; frame++) hud.update(input({ ammo: ammoOf(50), speed: 320 }), []);

      // The ammo count keeps to the left edge, the health to the middle; a digit keeps its shape.
      const [ammo] = of('gfx/2d/numbers/five_32b.tga');
      expectAt(ammo, { x: 34, y: 432, w: 32, h: 48 }, 'left');
      const [health] = of('gfx/2d/numbers/one_32b.tga');
      expectAt(health, { x: 187, y: 432, w: 32, h: 48 }, 'centre');
      // The speed graph's newest column, a `white` picture, ends at the right edge.
      const [newest] = columns();
      expect(newest.rect[0] + newest.rect[2], `${width}×${height}`).toBeCloseTo(width, 3);
    }
  });

  it("draws each shader in a material of its own, at its stage's brightness, times the vertex colour", async () => {
    // `rgbGen exactVertex`: the health's colour, at twice the brightness in classic Q3.
    hud.update(input({ health: 45 }), []);
    const tinted = draws().find((draw) => imageOf(draw) === 'gfx/2d/crosshaire.tga')!;
    const material = tinted.material as GammaVertexColorMaterial;
    expect([material.emissive.r, material.emissive.g, material.emissive.b]).toEqual([2, 2, 2]);
    expect(material.opacityMap).toBe(material.emissiveMap);
    expect(material.opacityMapChannel).toBe('a');
    expect(material.emissiveVertexColor).toBe(true);
    expect(material.opacityVertexColor).toBe(true);
    expect(material.vertexColorGamma).toBe(true);
    // `RB_SetGL2D`'s state: blended, no depth test, both faces.
    expect(material.blendType).toBe(BLEND_NORMAL);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.cull).toBe(CULLFACE_NONE);
    expect(material.useLighting).toBe(false);
    const [cross] = of('gfx/2d/crosshaire.tga');
    expect(cross.color).toEqual([255, 128, 0, 255]);
    expectAt(cross, { x: 308, y: 228, w: 24, h: 24 }, 'centre');

    // A default stage at its texture's own brightness, the same material frame after frame.
    const digits = draws().find((draw) => imageOf(draw) === 'gfx/2d/numbers/four_32b.tga')!;
    const { emissive } = digits.material as StandardMaterial;
    expect([emissive.r, emissive.g, emissive.b]).toEqual([1, 1, 1]);
    hud.update(input({ health: 44 }), []);
    expect(draws().find((draw) => imageOf(draw) === 'gfx/2d/numbers/four_32b.tga')!.material).toBe(
      digits.material
    );

    // Retail's crosshair b, `rgbGen identity`: white in the vertex, its brightness the stage's.
    await create({ drawCrosshair: 1 });
    hud.update(input({ health: 45 }), []);
    const [plain] = of('gfx/2d/crosshairb.tga');
    expect(plain.color).toEqual([255, 255, 255, 255]);
  });

  it("draws the graphs' columns and the score boxes in `white`, the image Q3 makes for itself", () => {
    hud.update(input({ scores1: 12, score: 9 }), []);
    const fills = of('*white');
    // The player's box in red, the leader's in grey, each at a third.
    expect(fills.map((fill) => fill.color)).toEqual([
      [255, 0, 0, 84],
      [128, 128, 128, 84]
    ]);
    expectAt(fills[0], { x: 600, y: 404, w: 40, h: 24 }, 'right');
    // `CG_FillRect`'s texture coordinates, all at one corner.
    expect(fills[0].st).toEqual([0, 0, 0, 0]);
    // White through and through, opaque.
    const white = draws().find((draw) => imageOf(draw) === '*white')!;
    const image = (white.material as StandardMaterial).emissiveMap!;
    expect([...(image.lock() as Uint8Array)]).toEqual([255, 255, 255, 255]);
    image.unlock();
  });

  it("writes each picture's colour as the list hands it: the weapon bar's marker faded, its icons not", () => {
    const ammo = ammoOf(AMMO_INFINITE);
    ammo[WP.RAILGUN] = 0;
    // 1300 ms after the switch: half faded.
    hud.update(input({ ammo, weaponSelectTime: 3700 }), []);
    const icons = WEAPON_ASSETS.filter((asset) => asset.id !== WP.GRAPPLING_HOOK).flatMap((asset) =>
      of(`${asset.icon}.tga`)
    );
    expect(icons).toHaveLength(9);
    expect(icons.every((icon) => icon.color[3] === 255)).toBe(true);
    // The marker round the gun and the score box's frame: the bar's is half faded.
    expect(of('gfx/2d/select.tga').map((select) => select.color[3])).toEqual([128, 255]);
    expect(of('icons/noammo.tga').map((cross) => cross.color[3])).toEqual([128]);
  });

  it('cuts each character from its bigchars cell, down from the top of the image', () => {
    hud.update(input({ ammo: ammoOf(1) }), []);
    // "LOW AMMO WARNING", its shadows first: 'L' is 76, row 4 and column 12.
    const warning = of(CHARSET).filter((char) => char.rect[1] < 200);
    expect(warning).toHaveLength(2 * 'LOWAMMOWARNING'.length);
    const [shadow] = warning;
    const char = warning['LOWAMMOWARNING'.length];
    expect(char.st).toEqual([12 / 16, 4 / 16, 13 / 16, 5 / 16]);
    expect(shadow.st).toEqual(char.st);
    expect(shadow.color).toEqual([0, 0, 0, 255]);
    // The shadow 2 right and 2 down on the grid, 1.6 pixels a unit here.
    expect(shadow.rect[0] - char.rect[0]).toBeCloseTo(2 * 1.6, 4);
    expect(shadow.rect[1] - char.rect[1]).toBeCloseTo(2 * 1.6, 4);
  });

  it('draws a run of pictures in one shader as one draw, in the order the list wrote them', () => {
    hud.update(input({ ammo: ammoOf(50), health: 100 }), []);
    const runs = draws().map((draw) => ({ image: imageOf(draw), count: draw.mesh!.primitive[0].count / 6 }));
    // The ammo's 5 and 0, then the health's 1, 0 and 0, the noughts one draw.
    expect(runs.slice(0, 4)).toEqual([
      { image: 'gfx/2d/numbers/five_32b.tga', count: 1 },
      { image: 'gfx/2d/numbers/zero_32b.tga', count: 1 },
      { image: 'gfx/2d/numbers/one_32b.tga', count: 1 },
      { image: 'gfx/2d/numbers/zero_32b.tga', count: 2 }
    ]);
    // No two draws in a row share a shader.
    runs.slice(1).forEach((run, i) => expect(run.image).not.toBe(runs[i].image));
    expect(runs.reduce((sum, run) => sum + run.count, 0)).toBe(quads().length);
  });

  it('makes nothing frame after frame once its draws are made', async () => {
    await create({ speedometer: 1 });
    const frame = () =>
      hud.update(input({ ammo: ammoOf(5), speed: 300, weaponSelectTime: 4000, scores1: 3 }), printed('hi\n'));
    frame();
    frame();
    const added = vi.spyOn(layer, 'addMeshInstances');
    const assigned = allDraws().map((draw) => vi.spyOn(draw, 'material', 'set'));
    for (let i = 0; i < 3; i++) frame();
    expect(added).not.toHaveBeenCalled();
    for (const spy of assigned) expect(spy).not.toHaveBeenCalled();
  });

  it("shows the model's icon for the head only in 2D, and gives its last image back", async () => {
    await hud.setPlayerIcon('sarge');
    hud.update(input(), []);
    expect(of('models/players/sarge/icon_default.tga')).toEqual([]);

    await create({ draw3dIcons: false });
    await hud.setPlayerIcon('sarge');
    hud.update(input(), []);
    const [head] = of('models/players/sarge/icon_default.tga');
    expect(head.rect[2]).toBeCloseTo(60 * 1.6, 4);
    expect(head.rect[3]).toBeCloseTo(60 * 1.6, 4);
    const material = draws().find((draw) => imageOf(draw) === head.image)!.material as StandardMaterial;
    const icon = material.emissiveMap!;
    const released = vi.spyOn(icon, 'destroy');
    const drawn = quads().length;

    // A model with no icon: no head, the same material holding no icon of a model's.
    await hud.setPlayerIcon('grunt');
    hud.update(input(), []);
    expect(quads()).toHaveLength(drawn - 1);
    expect(quads().some((quad) => quad.image.startsWith('models/'))).toBe(false);
    expect(material.emissiveMap!.name).toBe('*white');
    await vi.waitFor(() => expect(released).toHaveBeenCalled());
  });

  it('draws nothing but the notify lines with cg_draw2D 0', async () => {
    await create({ draw2D: false, drawFPS: true, speedometer: 2 });
    hud.update(input({ weaponSelectTime: 4900, speed: 300 }), printed('over\n'));
    // All of it in `bigchars`, one draw.
    expect(draws()).toHaveLength(1);
    expect(quads().map((quad) => quad.image)).toEqual(new Array('over'.length).fill(CHARSET));
  });

  it("draws the notify lines in the canvas's own pixels, at the top left, on any screen", () => {
    for (const [width, height] of [
      [1024, 768],
      [2560, 1440]
    ]) {
      app.graphicsDevice.resizeCanvas(width, height);
      hud.update(input({ health: 100 }), printed('Sarge was railed\nby Visor\n'));

      // After the rest of the HUD; the spaces are not drawn.
      const lines = quads().slice(-'SargewasrailedbyVisor'.length);
      expect(lines.every((char) => char.image === CHARSET)).toBe(true);
      const [first] = lines;
      // 8 by 16 of the canvas's pixels, however tall it is, the second line 16 pixels down.
      [8, 0, 8, 16].forEach((value, i) => expect(first.rect[i], `${width}×${height}`).toBeCloseTo(value, 3));
      expect(lines['Sargewasrailed'.length].rect[1]).toBeCloseTo(16, 3);
    }
  });

  it('draws each notify character in its own colour, cut from its cell, with no shadow', () => {
    hud.update(input(), printed('^1Sarge^7 was railed\n'));
    const chars = quads().slice(-'Sargewasrailed'.length);
    expect(chars[0].color).toEqual([255, 0, 0, 255]);
    expect(chars[5].color).toEqual([255, 255, 255, 255]);
    // 'S' is 83: row 5, column 3.
    expect(chars[0].st).toEqual([3 / 16, 5 / 16, 4 / 16, 6 / 16]);
  });

  it('comes off the screen, the notify lines with it, while no match runs', () => {
    hud.update(input(), printed('hello\n'));
    expect(rendered()).toBe(draws().length);
    hud.shown = false;
    expect(rendered()).toBe(0);
    hud.shown = true;
    expect(rendered()).toBe(draws().length);
  });

  it("forgets the last match's frames as it goes, the speed graph's among them", async () => {
    await create({ speedometer: 1 });
    for (const speed of [100, 200, 300]) hud.update(input({ speed }), []);
    expect(columns()).toHaveLength(3);
    hud.clear();
    hud.update(input({ speed: 100, time: 16 }), []);
    expect(columns()).toHaveLength(1);
  });

  it('keeps the right-hand groups to the right edge and the middle to the middle on a wide screen', () => {
    app.graphicsDevice.resizeCanvas(1920, 1080);
    hud.update(input({ interrupted: true, time: 5120, localServer: false, scores1: 12, score: 9 }), []);
    const [lagometer] = of('gfx/2d/lag.tga');
    expectAt(lagometer, { x: 592, y: 432, w: 48, h: 48 }, 'right');
    expect(lagometer.rect[0] + lagometer.rect[2]).toBeCloseTo(1920, 3);
    const [net] = of('gfx/2d/net.tga');
    expectAt(net, { x: 592, y: 432, w: 48, h: 48 }, 'right');
    // "Connection Interrupted", in the middle, after its shadow.
    const line = of(CHARSET).filter((char) => char.rect[1] < 300);
    expectAt(line['ConnectionInterrupted'.length], { x: 144, y: 100, w: 16, h: 16 }, 'centre');
  });

  it("lays the team chat's band across a wide screen, its lines from the left edge", async () => {
    await create({ teamChatHeight: 4 });
    app.graphicsDevice.resizeCanvas(1920, 1080);
    const teamChat = createTeamChat();
    addToTeamChat(teamChat, 'Hi', { teamChatHeight: 4, teamChatTime: 3000 }, 4000);
    hud.update(input({ gametype: GT.TEAM, ownTeam: TEAM.RED, teamChat }), []);
    const [band] = of('gfx/2d/colorbar.tga');
    expect(band.rect).toEqual([0, 412 * 2.25, 1920, 8 * 2.25]);
    const [first] = of(CHARSET).filter((char) => char.rect[1] === 412 * 2.25);
    expectAt(first, { x: 8, y: 412, w: 8, h: 8 }, 'left');
  });

  it("gives the menu a crosshair's image by its shader's name", () => {
    expect(hud.image('gfx/2d/crosshairb')!.name).toBe('gfx/2d/crosshairb.tga');
    expect(hud.image('gfx/2d/crosshairz')).toBeNull();
  });

  it('draws a picture in every material, the head among them, through its camera for the warm-up', () => {
    hud.shown = false;
    const warmed = hud.warm();
    warmed.at(0);
    const drawn = draws();
    const materials = new Set(drawn.map((draw) => draw.material));
    expect(materials.size).toBe(drawn.length);
    expect(drawn.every((draw) => draw.mesh!.primitive[0].count === 6)).toBe(true);
    const images = drawn.map(imageOf);
    for (const image of [CHARSET, '*white', 'gfx/2d/crosshairb.tga', 'gfx/2d/lag.tga', 'gfx/2d/net.tga']) {
      expect(images).toContain(image);
    }
    // The head's, with no icon yet, and every item's.
    expect(images.filter((image) => image === '*white')).toHaveLength(2);
    for (const item of ITEMS.slice(1)) expect(images).toContain(`${item.icon}.tga`);
    expect(rendered()).toBe(drawn.length);

    warmed.at(0.1234);
    expect(draws()).toHaveLength(drawn.length);
    warmed.end();
    expect(draws()).toEqual([]);
    expect(hud.shown).toBe(false);
  });
});
