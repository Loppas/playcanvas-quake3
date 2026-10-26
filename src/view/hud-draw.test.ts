import { describe, expect, it } from 'vitest';

import { WEAPON_ASSETS } from '../formats/asset-manifest';
import { MAX_POWERUPS } from '../net/protocol';
import { GT, SCORE_NOT_PRESENT, TEAM } from '../sim/constants';
import { ARMOR_TIER, findItem, itemIndex, PW } from '../sim/items';
import {
  ALL_WEAPONS,
  AMMO_INFINITE,
  MAX_WEAPONS,
  WEAPON_READY,
  WP
} from '../sim/weapons/constants';
import { centerPrint, createCenterPrint, USE_ITEM_CHAR_WIDTH, USE_ITEM_Y } from './center-print';
import type { ClientInfo } from './client-info';
import { ConsoleBuffer } from './console-buffer';
import { createHudState, hudFrame, type HudInput, type HudSettings } from './hud';
import {
  CHARSET_SHADER,
  drawHud,
  drawNotify,
  SELECT_SHADER,
  WHITE_SHADER,
  type HudArt,
  type PicShader,
  type PicWriter
} from './hud-draw';
import type { HudAnchor } from './hud-layout';
import { Lagometer } from './lagometer';
import { notifyRows } from './notify-lines';
import { REWARD_TIME, createRewardState, pushReward } from './rewards';

/** One picture written: its shader, rectangle on Q3's grid, anchor, texture corners and colour. */
interface Written {
  shader: string;
  rect: number[];
  anchor: HudAnchor;
  st: number[];
  color: number[];
}

/** A writer that keeps what it is handed, the colour copied. */
function writer(pics: Written[]): PicWriter {
  return {
    stretchPic(shader, x, y, w, h, anchor, s1, t1, s2, t2, color) {
      pics.push({ shader, rect: [x, y, w, h], anchor, st: [s1, t1, s2, t2], color: [...color] });
    }
  };
}

const NEITHER: PicShader = { tinted: false, faded: false };
/** Q3's stage for a picture with no script (`tr_shader.c:2622–2630`), and `rgbGen vertex`'s. */
const BOTH: PicShader = { tinted: true, faded: true };

/**
 * The shaders that take less of the colour than an unscripted picture does, as this install's
 * `gfx.shader` writes them; crosshair b as the retail scripts write b–j.
 */
const SCRIPTED: Readonly<Record<string, PicShader>> = {
  'gfx/2d/crosshaire': { tinted: true, faded: false },
  'gfx/2d/crosshairb': NEITHER,
  'icons/iconr_yellow': NEITHER,
  medal_impressive: NEITHER,
  lagometer: NEITHER,
  ...Object.fromEntries(WEAPON_ASSETS.map((asset) => [asset.icon, NEITHER]))
};

/** The HUD's art: every shader drawable but `missing`, and the player's icon if given one. */
function art(playerIcon: string | null = null, missing: readonly string[] = []): HudArt {
  return {
    shader: (name) => (missing.includes(name) ? undefined : (SCRIPTED[name] ?? BOTH)),
    playerIcon
  };
}

/** Pixels to a unit of the grid at 768 high. */
const SCALE = 1.6;
const PIXEL = 1 / SCALE;

/** `STAT_WEAPONS` with every weapon the player spawns with. */
const OWNED = ALL_WEAPONS.reduce<number>((bits, weapon) => bits | (1 << weapon), 0);

/** Ammo per weapon, the same for all. */
const ammoOf = (count: number) => new Array<number>(MAX_WEAPONS).fill(count);

/** `ps.powerups` with a few running. */
function powerupsWith(entries: readonly (readonly [number, number])[]): number[] {
  const powerups = new Array<number>(MAX_POWERUPS).fill(0);
  for (const [powerup, end] of entries) powerups[powerup] = end;
  return powerups;
}

/** A fresh spawn 5 s in, as `hud.test.ts` has it. */
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
}

/** Q3's defaults, with the speedometer off. */
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
  drawRewards: true
};

/** A HUD's frames, each written as it is drawn, with its state kept from one to the next. */
function hud(settings: Partial<HudSettings> = {}, using: HudArt = art()) {
  const state = createHudState(() => 0.5);
  return (overrides: Partial<HudInput> = {}): Written[] => {
    const frame = hudFrame(state, input(overrides), { ...SETTINGS, ...settings });
    const pics: Written[] = [];
    drawHud(frame, state.speeds, SCALE, using, writer(pics));
    return pics;
  };
}

/** One frame of a fresh HUD. */
function draw(overrides: Partial<HudInput> = {}, settings: Partial<HudSettings> = {}): Written[] {
  return hud(settings)(overrides);
}

/** The pictures in a shader. */
function of(pics: readonly Written[], shader: string): Written[] {
  return pics.filter((pic) => pic.shader === shader);
}

/** Whether a character is a shadow: black. */
const black = (pic: Written) => pic.color.slice(0, 3).every((part) => part === 0);

/** A line's characters, by its top, and their shadows, which are black and 2 lower. */
function chars(pics: readonly Written[], y: number): Written[] {
  return of(pics, CHARSET_SHADER).filter((pic) => pic.rect[1] === y && !black(pic));
}
function shadows(pics: readonly Written[], y: number): Written[] {
  return of(pics, CHARSET_SHADER).filter((pic) => pic.rect[1] === y + 2 && black(pic));
}

/** The shaders written, and where. */
const placed = (pics: readonly Written[]) => pics.map(({ shader, rect, anchor }) => [shader, rect, anchor]);

const WHOLE = [0, 0, 1, 1];

describe('drawHud', () => {
  it("writes the status bar's numbers on Q3's grid, 32×48 a digit, the ammo's to the left edge", () => {
    const pics = draw({ ammo: ammoOf(50) });
    expect(placed(pics.filter((pic) => pic.rect[1] === 432))).toEqual([
      ['gfx/2d/numbers/five_32b', [34, 432, 32, 48], 'left'],
      ['gfx/2d/numbers/zero_32b', [66, 432, 32, 48], 'left'],
      ['gfx/2d/numbers/one_32b', [187, 432, 32, 48], 'centre'],
      ['gfx/2d/numbers/two_32b', [219, 432, 32, 48], 'centre'],
      ['gfx/2d/numbers/five_32b', [251, 432, 32, 48], 'centre']
    ]);
    const [ammo, , health] = pics;
    expect(ammo.st).toEqual(WHOLE);
    // The ammo in amber, the health white over 100.
    expect(ammo.color).toEqual([1, 0.69, 0, 1]);
    expect(health.color).toEqual([1, 1, 1, 1]);

    // Flashing red at 25 or less, in an odd 256 ms.
    const [low] = draw({ health: 20, time: 21 * 256 });
    expect(low.color).toEqual([1, 0.2, 0.2, 1]);
  });

  it('writes the 2D status bar in its order: the head and its cross, then each number and its icon', () => {
    const drawn = hud({ draw3dIcons: false }, art('models/players/sarge/icon_default'));
    const pics = drawn({
      ammo: ammoOf(50),
      armor: 50,
      armorTier: ARMOR_TIER.YA,
      clientInfo: () => ({ deferred: true }) as ClientInfo
    });
    // The score boxes are the lower right's, kept to the right edge.
    const bar = pics.filter((pic) => pic.anchor !== 'right');
    expect(bar.map((pic) => pic.shader)).toEqual([
      'models/players/sarge/icon_default',
      'gfx/2d/defer',
      'gfx/2d/numbers/five_32b',
      'gfx/2d/numbers/zero_32b',
      'icons/iconw_machinegun',
      'gfx/2d/numbers/one_32b',
      'gfx/2d/numbers/two_32b',
      'gfx/2d/numbers/five_32b',
      'gfx/2d/numbers/five_32b',
      'gfx/2d/numbers/zero_32b',
      'icons/iconr_yellow',
      'gfx/2d/crosshaire'
    ]);
    // The head 60 square, the cross over it; the icons beside their numbers.
    expect(bar[0].rect.slice(2)).toEqual([60, 60]);
    expect(bar[1].rect).toEqual(bar[0].rect);
    expect([bar[0].anchor, bar[1].anchor]).toEqual(['centre', 'centre']);
    expect(placed([bar[4], bar[10]])).toEqual([
      ['icons/iconw_machinegun', [100, 432, 48, 48], 'left'],
      ['icons/iconr_yellow', [470, 432, 48, 48], 'centre']
    ]);
  });

  it('writes no 2D icon for the ammo or the armour while their models are drawn', () => {
    const pics = draw({ ammo: ammoOf(50), armor: 50, armorTier: ARMOR_TIER.YA });
    expect(pics.filter((pic) => pic.shader.startsWith('icons/'))).toEqual([]);
    expect(of(pics, 'gfx/2d/numbers/five_32b')).toHaveLength(3);
  });

  it("writes the head's icon only in 2D, and its cross over a model too", () => {
    const icon = 'models/players/sarge/icon_default';
    expect(of(hud({}, art(icon))(), icon)).toEqual([]);
    expect(of(hud({ draw3dIcons: false })(), icon)).toEqual([]);

    const deferred = { clientInfo: () => ({ deferred: true }) as ClientInfo };
    expect(of(draw(), 'gfx/2d/defer')).toEqual([]);
    const [cross] = of(draw(deferred), 'gfx/2d/defer');
    expect(cross.rect.slice(2)).toEqual([60, 60]);
  });

  it('tints a crosshair only where its shader takes the colour, and centres it', () => {
    const [tinted] = of(draw({ health: 45 }), 'gfx/2d/crosshaire');
    expect(placed([tinted])).toEqual([['gfx/2d/crosshaire', [308, 228, 24, 24], 'centre']]);
    // `rgbGen exactVertex`: the health's colour.
    expect(tinted.color).toEqual([1, 0.5, 0, 1]);

    // Retail's crosshair b, `rgbGen identity`: no tint at all.
    const [plain] = of(draw({ health: 45 }, { drawCrosshair: 1 }), 'gfx/2d/crosshairb');
    expect(plain.color).toEqual([1, 1, 1, 1]);
  });

  it("writes each weapon's icon, then the marker round the one asked for, then its cross", () => {
    const ammo = ammoOf(AMMO_INFINITE);
    ammo[WP.RAILGUN] = 0;
    // 1300 ms after the switch: half faded.
    const pics = draw({ ammo, weaponSelectTime: 3700 });
    const bar = pics.filter(
      (pic) => pic.anchor === 'centre' && (pic.shader.startsWith('icons/') || pic.shader === SELECT_SHADER)
    );
    expect(bar.map((pic) => pic.shader)).toEqual([
      'icons/iconw_gauntlet',
      'icons/iconw_machinegun',
      SELECT_SHADER,
      'icons/iconw_shotgun',
      'icons/iconw_grenade',
      'icons/iconw_rocket',
      'icons/iconw_lightning',
      'icons/iconw_railgun',
      'icons/noammo',
      'icons/iconw_plasma',
      'icons/iconw_bfg'
    ]);
    expect(placed(bar.slice(1, 3))).toEqual([
      ['icons/iconw_machinegun', [180, 380, 32, 32], 'centre'],
      [SELECT_SHADER, [176, 376, 40, 40], 'centre']
    ]);
    expect(bar[8].rect).toEqual(bar[7].rect);
    // An empty weapon asked for: its marker, then its cross over both.
    const empty = draw({ ammo, weaponSelect: WP.RAILGUN, weaponSelectTime: 3700 });
    const railgun = empty.findIndex((pic) => pic.shader === 'icons/iconw_railgun');
    expect(empty.slice(railgun, railgun + 3).map((pic) => pic.shader)).toEqual([
      'icons/iconw_railgun',
      SELECT_SHADER,
      'icons/noammo'
    ]);

    // The fade reaches the marker, the cross and the name, and not the icons.
    expect(bar.map((pic) => pic.color[3])).toEqual([1, 1, 0.5, 1, 1, 1, 1, 1, 0.5, 1, 1]);
    const name = chars(pics, 358);
    expect(name).toHaveLength('Machinegun'.length);
    expect(name.every((char) => char.color[3] === 0.5)).toBe(true);
    expect(shadows(pics, 358).map((shadow) => shadow.color)).toEqual(
      new Array('Machinegun'.length).fill([0, 0, 0, 0.5])
    );
  });

  it('cuts each character from its bigchars cell, every shadow written before every character', () => {
    const pics = draw({ ammo: ammoOf(1) });
    const line = of(pics, CHARSET_SHADER).filter((pic) => pic.anchor === 'centre');
    // "LOW AMMO WARNING", 16 wide, centred at 64 down: 14 characters and their shadows.
    expect(line).toHaveLength(28);
    expect(line.slice(0, 14).every(black)).toBe(true);
    expect(line.slice(14).some(black)).toBe(false);
    // 'L' is 76: row 4 and column 12.
    const [shadow] = line;
    const char = line[14];
    expect(placed([char])).toEqual([[CHARSET_SHADER, [192, 64, 16, 16], 'centre']]);
    expect(char.st).toEqual([12 / 16, 4 / 16, 13 / 16, 5 / 16]);
    expect(char.color).toEqual([1, 1, 1, 1]);
    // The shadow 2 right and 2 down, black, in the same cell.
    expect(shadow.rect).toEqual([194, 66, 16, 16]);
    expect(shadow.st).toEqual(char.st);
    expect(shadow.color).toEqual([0, 0, 0, 1]);
    // The space takes its place and draws nothing: 'A' starts the second word.
    expect(line[17].rect[0]).toBe(192 + 4 * 16);
  });

  it('colours a character by the ^ code before it, at the line\'s alpha', () => {
    const named = (n: number) =>
      n === 0
        ? ({ name: '^1Sarge^7', team: TEAM.FREE } as ClientInfo)
        : n === 2
          ? ({ name: 'Grunt', team: TEAM.FREE } as ClientInfo)
          : null;
    const pics = draw({ gametype: GT.TOURNAMENT, warmup: 9000, time: 5000, clientInfo: named });
    // The code takes no place: 'S' leads, in red, and "Grunt" is white after `^7`.
    const versus = chars(pics, 20);
    expect(versus).toHaveLength('SargevsGrunt'.length);
    expect(versus[0].color).toEqual([1, 0, 0, 1]);
    expect(versus[11].color).toEqual([1, 1, 1, 1]);

    // A fading message keeps its fade in a code's colour.
    const state = createCenterPrint();
    centerPrint(state, '^1Up', USE_ITEM_Y, USE_ITEM_CHAR_WIDTH, 5000);
    const faded = chars(draw({ centerPrint: state, time: 7900 }), 136);
    expect(faded.map((pic) => pic.color)).toEqual([
      [1, 0, 0, 0.5],
      [1, 0, 0, 0.5]
    ]);
  });

  it('writes a message in the middle of the screen, centred, with no shadow', () => {
    const state = createCenterPrint();
    centerPrint(state, 'Use Medkit', USE_ITEM_Y, USE_ITEM_CHAR_WIDTH, 5000);
    const middle = (time: number) =>
      of(draw({ centerPrint: state, time }), CHARSET_SHADER).filter((pic) => pic.anchor === 'centre');
    const pics = middle(5000);
    // Ten characters of 16: 160 wide, centred at 240; y = 144 − 16/2 = 136, 24 tall.
    expect(pics).toHaveLength('UseMedkit'.length);
    expect(placed(pics.slice(0, 1))).toEqual([[CHARSET_SHADER, [240, 136, 16, 24], 'centre']]);
    expect(pics.some(black)).toBe(false);

    expect(middle(8000)).toEqual([]);
  });

  it('writes nothing with cg_draw2D 0', () => {
    const drawn = hud({ draw2D: false, drawFPS: true, speedometer: 2 });
    for (let frame = 0; frame < 6; frame++) {
      expect(drawn({ weaponSelectTime: 4900, speed: 300, realTime: frame * 10 })).toEqual([]);
    }
  });

  it('writes nothing in a shader with no image', () => {
    const missing = ['gfx/2d/numbers/two_32b', 'gfx/2d/crosshaire', WHITE_SHADER];
    const pics = hud({}, art(null, missing))();
    expect(pics.map((pic) => pic.shader).filter((shader) => !shader.startsWith('gfx/2d/'))).toEqual([]);
    expect(pics.map((pic) => pic.shader).slice(0, 3)).toEqual([
      'gfx/2d/numbers/one_32b',
      'gfx/2d/numbers/five_32b',
      // The player's score box, with no fill.
      SELECT_SHADER
    ]);
  });

  it("writes the speedometer's graph as yellow columns, a pixel wide, the newest at the box's edge", () => {
    const drawn = hud({ speedometer: 1 });
    let pics: Written[] = [];
    for (const speed of [100, 200, 300]) pics = drawn({ speed });
    const columns = of(pics, WHITE_SHADER).filter((pic) => pic.rect[1] >= 432);
    expect(columns).toHaveLength(3);
    // 300 fills 22.5 of the box's 48 at twice `g_speed`.
    expect(placed(columns.slice(0, 1))).toEqual([
      [WHITE_SHADER, [640 - PIXEL, 480 - 22.5, PIXEL, 22.5], 'right']
    ]);
    expect(columns[0].color).toEqual([1, 1, 0, 1]);
    expect(columns[0].st).toEqual([0, 0, 0, 0]);
    expect(columns.map((column) => column.rect[0])).toEqual([1, 2, 3].map((age) => 640 - age * PIXEL));
  });

  it('writes the speed under the crosshair, then the graph under it, kept to the middle', () => {
    const pics = draw({ speed: 300, peak: 400 }, { speedometer: 2 });
    const middle = pics.filter((pic) => pic.rect[1] >= 264 && pic.rect[1] < 432 && pic.anchor === 'centre');
    // "300", then "peak 400" in small characters with no shadow, then the column.
    expect(middle.map((pic) => (black(pic) ? 'shadow' : pic.shader))).toEqual([
      ...new Array(3).fill('shadow'),
      ...new Array(3).fill(CHARSET_SHADER),
      ...new Array('peak400'.length).fill(CHARSET_SHADER),
      WHITE_SHADER
    ]);
    expect(placed(middle.slice(3, 4))).toEqual([[CHARSET_SHADER, [296, 264, 16, 16], 'centre']]);
    expect(middle.at(-1)!.anchor).toBe('centre');
    expect(middle.at(-1)!.rect[0] + PIXEL).toBeCloseTo(344, 9);
  });

  it('writes Connection Interrupted, then the net icon, over the graph', () => {
    const pics = draw({ interrupted: true, speed: 300, time: 5120 }, { speedometer: 1 });
    // The line but its space, shadowed, from 144 across and 100 down.
    expect(chars(pics, 100)).toHaveLength(21);
    expect(shadows(pics, 100)).toHaveLength(21);
    expect(placed(chars(pics, 100).slice(0, 1))).toEqual([[CHARSET_SHADER, [144, 100, 16, 16], 'centre']]);
    // An unscripted picture in the colour Q3 leaves set: white, opaque, after the line.
    const net = of(pics, 'gfx/2d/net');
    expect(net).toEqual([
      { shader: 'gfx/2d/net', rect: [592, 432, 48, 48], anchor: 'right', st: WHOLE, color: [1, 1, 1, 1] }
    ]);
    const at = (written: Written) => pics.indexOf(written);
    expect(at(net[0])).toBe(at(chars(pics, 100)[20]) + 1);
    const graph = of(pics, WHITE_SHADER).filter((pic) => pic.rect[1] >= 432);
    expect(graph).toHaveLength(1);
    expect(at(graph[0])).toBeLessThan(at(shadows(pics, 100)[0]));

    // Blinked off, the line stays.
    const off = draw({ interrupted: true, time: 5632 });
    expect(of(off, 'gfx/2d/net')).toEqual([]);
    expect(chars(off, 100)).toHaveLength(21);

    const back = draw({ time: 6144 });
    expect(chars(back, 100)).toEqual([]);
    expect(of(back, 'gfx/2d/net')).toEqual([]);
  });

  it("writes the lagometer's picture, then its columns, then the net icon over them", () => {
    const samples = new Lagometer();
    samples.addFrame(-30);
    samples.addSnapshot({ ping: 300, snapFlags: 0 });
    samples.addSnapshot(null);
    const remote = { localServer: false, lagometer: samples };
    const pics = draw({ ...remote, interrupted: true, time: 5120, speed: 300 }, { speedometer: 1 });

    const [pic] = of(pics, 'lagometer');
    expect(placed([pic])).toEqual([['lagometer', [592, 432, 48, 48], 'right']]);
    expect(pic.color).toEqual([1, 1, 1, 1]);
    // The frame graph's column, then the snapshots': the newest lost, the one before it green.
    const lag = of(pics, WHITE_SHADER).filter((column) => column.rect[0] >= 592 && column.rect[1] >= 432);
    expect(lag.map((column) => column.color)).toEqual([
      [0, 0, 1, 1],
      [1, 0, 0, 1],
      [0, 1, 0, 1]
    ]);
    // The red one fills the snapshot graph's half of the box.
    expect(placed([lag[1]])).toEqual([[WHITE_SHADER, [640 - PIXEL, 456, PIXEL, 24], 'right']]);
    const at = (written: Written) => pics.indexOf(written);
    expect(at(lag[0])).toBe(at(pic) + 1);
    expect(at(of(pics, 'gfx/2d/net')[0])).toBeGreaterThan(at(lag[2]));
    // The speed graph stands in the box to its left, before the lagometer: 300 fills 22.5 of 48.
    const [speed] = of(pics, WHITE_SHADER).filter((column) => column.rect[0] < 592 && column.rect[1] >= 432);
    expect(placed([speed])).toEqual([[WHITE_SHADER, [592 - PIXEL, 457.5, PIXEL, 22.5], 'right']]);
    expect(at(speed)).toBeLessThan(at(pic));
    expect(chars(pics, 432)).toEqual([]);

    // Nothing of it on a local server.
    const local = draw();
    expect(of(local, 'lagometer')).toEqual([]);
    expect(of(local, WHITE_SHADER).filter((column) => column.rect[1] >= 432)).toEqual([]);
  });

  it('writes snc over the lagometer under cg_nopredict', () => {
    const pics = draw({ localServer: false }, { noPredict: true });
    expect(chars(pics, 432)).toHaveLength(3);
    expect(shadows(pics, 432)).toHaveLength(3);
    expect(placed(chars(pics, 432).slice(0, 1))).toEqual([[CHARSET_SHADER, [592, 432, 16, 16], 'right']]);
    expect(pics.indexOf(shadows(pics, 432)[0])).toBeGreaterThan(pics.indexOf(of(pics, 'lagometer')[0]));
  });

  it("writes each score box in turn, its fill, the player's frame, then its number, and the limit last", () => {
    const pics = draw({ scores1: 12, score: 9, fraglimit: 20 });
    const lower = pics.filter((pic) => pic.rect[1] >= 404 && pic.rect[1] < 432);
    const kinds = lower.map((pic) =>
      pic.shader === CHARSET_SHADER ? (black(pic) ? 'shadow' : 'char') : pic.shader
    );
    expect(kinds).toEqual([
      WHITE_SHADER,
      SELECT_SHADER,
      'shadow',
      'char',
      WHITE_SHADER,
      'shadow',
      'shadow',
      'char',
      'char',
      'shadow',
      'shadow',
      'char',
      'char'
    ]);
    // The player's " 9" at the right, filled red and framed; "12" grey; the limit unboxed.
    expect(placed([lower[0], lower[1]])).toEqual([
      [WHITE_SHADER, [600, 404, 40, 24], 'right'],
      [SELECT_SHADER, [600, 404, 40, 24], 'right']
    ]);
    expect(lower[0].color).toEqual([1, 0, 0, 0.33]);
    expect(lower[0].st).toEqual([0, 0, 0, 0]);
    expect(lower[1].color).toEqual([1, 1, 1, 1]);
    expect(lower[3].rect).toEqual([620, 408, 16, 16]);
    expect(placed([lower[4]])).toEqual([[WHITE_SHADER, [560, 404, 40, 24], 'right']]);
    expect(lower[4].color).toEqual([0.5, 0.5, 0.5, 0.33]);
    expect(lower[11].rect).toEqual([524, 408, 16, 16]);
  });

  it("stands each flag's icon over its own score box in CTF, after the box's number", () => {
    const ctf = { gametype: GT.CTF, scores1: 1, scores2: 3, team: TEAM.RED, redflag: 2, blueflag: 0 };
    const pics = draw(ctf);
    const flags = pics.filter((pic) => pic.shader.startsWith('icons/iconf_'));
    // Blue's box is the rightmost, so blue's flag is; the icons say where each flag is.
    expect(placed(flags)).toEqual([
      ['icons/iconf_blu1', [600, 380, 40, 24], 'right'],
      ['icons/iconf_red3', [560, 380, 40, 24], 'right']
    ]);
    const at = (written: Written) => pics.indexOf(written);
    const [blueNumber, redNumber] = chars(pics, 408);
    expect(at(flags[0])).toBe(at(blueNumber) + 1);
    expect(at(flags[1])).toBe(at(redNumber) + 1);

    expect(draw({ ...ctf, gametype: GT.TEAM }).filter((pic) => pic.shader.startsWith('icons/iconf_'))).toEqual([]);
  });

  it('writes the warmup block: the mode, then the countdown under it', () => {
    const pics = draw({ warmup: 12_000, time: 2_500 });
    expect(chars(pics, 25)).toHaveLength('FreeForAll'.length);
    expect(chars(pics, 25)[0].rect.slice(0, 2)).toEqual([128, 25]);
    expect(chars(pics, 70)).toHaveLength('Startsin:10'.length);
    expect(chars(pics, 70)[0].rect.slice(0, 2)).toEqual([216, 70]);
    expect(pics.indexOf(chars(pics, 25)[0])).toBeLessThan(pics.indexOf(shadows(pics, 70)[0]));

    const waiting = draw({ warmup: -1 });
    expect(chars(waiting, 24)).toHaveLength('Waitingforplayers'.length);
    expect(chars(waiting, 70)).toEqual([]);
  });

  it('writes the item just taken at the lower left: its icon fading, its name at full strength', () => {
    const quad = itemIndex(findItem('item_quad')!);
    const pics = draw({ pickup: quad, pickupTime: 5_000, time: 6_000 });
    expect(placed(of(pics, 'icons/quad'))).toEqual([['icons/quad', [8, 384, 48, 48], 'left']]);
    expect(of(pics, 'icons/quad')[0].color).toEqual([1, 1, 1, 1]);
    // The space takes no character, as `CG_DrawStringExt` draws none for it.
    expect(chars(pics, 400)).toHaveLength('QuadDamage'.length);

    // The icon fades over the last 200 ms of its three seconds; the name does not.
    const fading = draw({ pickup: quad, pickupTime: 5_000, time: 7_900 });
    expect(of(fading, 'icons/quad')[0].color).toEqual([1, 1, 1, 0.5]);
    expect(chars(fading, 400).every((char) => char.color[3] === 1)).toBe(true);

    const gone = draw({ pickup: quad, pickupTime: 5_000, time: 8_000 });
    expect(of(gone, 'icons/quad')).toEqual([]);
    expect(chars(gone, 400)).toEqual([]);
  });

  it("writes the armour's icon by its tier, the Green Armor's in its tint, whatever the stage takes", () => {
    const drawn = hud({ draw3dIcons: false });
    const icon = (armorTier: number) =>
      drawn({ armor: 50, armorTier })
        .filter((pic) => pic.shader.startsWith('icons/iconr_'))
        .map(({ shader, color }) => ({ shader, color }));
    expect(icon(ARMOR_TIER.YA)).toEqual([{ shader: 'icons/iconr_yellow', color: [1, 1, 1, 1] }]);
    expect(icon(ARMOR_TIER.GA)).toEqual([{ shader: 'icons/iconr_yellow', color: [0.2, 0.9, 0.2, 1] }]);
    expect(icon(ARMOR_TIER.RA)).toEqual([{ shader: 'icons/iconr_red', color: [1, 1, 1, 1] }]);
    expect(icon(3)).toEqual([]);

    // Taken, its icon is tinted the same; in a shader that takes the colour, the fade too.
    const jacket = itemIndex(findItem('item_armor_jacket')!);
    const taken = { pickup: jacket, pickupTime: 5_000, time: 7_900 };
    expect(of(draw(taken), 'icons/iconr_yellow')[0].color).toEqual([0.2, 0.9, 0.2, 1]);
    const vertex = { ...art(), shader: (name: string) => (name === 'icons/iconr_yellow' ? BOTH : art().shader(name)) };
    const [tinted] = of(hud({}, vertex)(taken), 'icons/iconr_yellow');
    expect(tinted.color).toEqual([0.2, 0.9, 0.2, 0.5]);
    expect(chars(draw(taken), 400)).toHaveLength('GreenArmor'.length);
  });

  it("writes each powerup's timer, then its icon, soonest first, pulsing one just taken", () => {
    const pics = draw({
      powerups: powerupsWith([
        [PW.HASTE, 12_000],
        [PW.QUAD, 20_000]
      ]),
      powerupActive: PW.QUAD,
      powerupTime: 5_000,
      time: 5_000
    });
    const timers = pics.filter((pic) => pic.rect[1] < 400 && pic.anchor === 'right');
    // The haste's seven seconds, then its icon; the quad's fifteen, then its own.
    expect(placed(timers)).toEqual([
      ['gfx/2d/numbers/seven_32b', [562, 352, 32, 48], 'right'],
      ['icons/haste', [592, 352, 48, 48], 'right'],
      ['gfx/2d/numbers/one_32b', [530, 304, 32, 48], 'right'],
      ['gfx/2d/numbers/five_32b', [562, 304, 32, 48], 'right'],
      // Half again as large, about the middle of its row.
      ['icons/quad', [568, 292, 72, 72], 'right']
    ]);
    expect(timers[0].color).toEqual([1, 0.2, 0.2, 1]);
    expect(timers[1].color).toEqual([1, 1, 1, 1]);

    // Under five seconds the icon blinks: all four of its colour the fraction of the second.
    const blink = (end: number) =>
      of(draw({ powerups: powerupsWith([[PW.HASTE, end]]), time: 5_000 }), 'icons/haste')[0].color;
    expect(blink(9_500)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(blink(8_001).map((part) => part.toFixed(6))).toEqual(new Array(4).fill('0.001000'));

    const none = draw({ powerups: powerupsWith([]) });
    expect(none.filter((pic) => pic.rect[1] < 400 && pic.anchor === 'right')).toEqual([]);
  });

  it("writes a reward's medals across the top middle, unfaded, as retail's scripts draw them", () => {
    const rewards = createRewardState();
    pushReward(rewards, { sound: 'impressive', medal: 'impressive', count: 2 });
    const drawn = hud();
    expect(placed(of(drawn({ rewards, time: 5_000 }), 'medal_impressive'))).toEqual([
      ['medal_impressive', [272, 56, 44, 44], 'centre'],
      ['medal_impressive', [320, 56, 44, 44], 'centre']
    ]);
    // `CG_DrawReward` sets the fade's colour, and the medal's script takes none of it.
    const fading = of(drawn({ rewards, time: 5_000 + REWARD_TIME - 100 }), 'medal_impressive');
    expect(fading.map((medal) => medal.color)).toEqual([
      [1, 1, 1, 1],
      [1, 1, 1, 1]
    ]);
    expect(drawn({ rewards, time: 5_000 + REWARD_TIME }).filter((pic) => pic.shader.startsWith('medal'))).toEqual([]);

    // A medal scripted to take the vertex colour fades with it.
    const vertex = { ...art(), shader: (name: string) => (name === 'medal_impressive' ? BOTH : art().shader(name)) };
    const again = createRewardState();
    pushReward(again, { sound: 'impressive', medal: 'impressive', count: 1 });
    const faded = hud({}, vertex);
    faded({ rewards: again, time: 5_000 });
    const [medal] = of(faded({ rewards: again, time: 5_000 + REWARD_TIME - 100 }), 'medal_impressive');
    expect(medal.color).toEqual([1, 1, 1, 0.5]);
  });

  it('writes one medal from ten up, with its count under it, which does fade', () => {
    const rewards = createRewardState();
    pushReward(rewards, { sound: 'impressive', medal: 'impressive', count: 12 });
    const drawn = hud();
    const first = drawn({ rewards, time: 5_000 });
    expect(of(first, 'medal_impressive')).toHaveLength(1);
    expect(chars(first, 104)).toHaveLength(2);
    const fading = chars(drawn({ rewards, time: 5_000 + REWARD_TIME - 100 }), 104);
    expect(fading.map((char) => char.color[3])).toEqual([0.5, 0.5]);
  });

  it('writes the carried holdable at the right of the middle', () => {
    const medkit = itemIndex(findItem('holdable_medkit')!);
    expect(placed(of(draw({ holdable: medkit }), 'icons/medkit'))).toEqual([
      ['icons/medkit', [592, 216, 48, 48], 'right']
    ]);
    expect(of(draw({ holdable: 0 }), 'icons/medkit')).toEqual([]);
  });

  it("writes a spectator's line before the crosshair, as Q3's spectator branch does", () => {
    const pics = draw({ team: TEAM.SPECTATOR });
    // SPECTATOR along the bottom, shadowed: nine characters and their shadows, then the crosshair.
    expect(pics.slice(0, 18).map((pic) => [pic.shader, pic.rect[1] - (black(pic) ? 2 : 0)])).toEqual(
      new Array(18).fill([CHARSET_SHADER, 440])
    );
    expect(pics[18].shader).toBe('gfx/2d/crosshaire');
  });

  it("writes the HUD in CG_Draw2D's order", () => {
    const samples = new Lagometer();
    samples.addFrame(-30);
    samples.addSnapshot({ ping: 300, snapFlags: 0 });
    const rewards = createRewardState();
    pushReward(rewards, { sound: 'impressive', medal: 'impressive', count: 1 });
    const message = createCenterPrint();
    centerPrint(message, 'Fight', 200, 16, 5_000);
    const drawn = hud({ drawFPS: true, speedometer: 1 });
    const everything = (realTime: number) =>
      drawn({
        health: 100,
        ammo: ammoOf(1),
        weaponSelectTime: 4_000,
        holdable: itemIndex(findItem('holdable_medkit')!),
        rewards,
        localServer: false,
        lagometer: samples,
        interrupted: true,
        speed: 300,
        realTime,
        scores1: 12,
        score: 9,
        powerups: powerupsWith([[PW.HASTE, 12_000]]),
        pickup: itemIndex(findItem('item_quad')!),
        pickupTime: 4_500,
        warmup: 12_000,
        centerPrint: message,
        time: 5_120
      });
    // The frame rate shows from the fifth frame it counts.
    for (let frame = 0; frame < 5; frame++) everything(frame * 8);
    const pics = everything(40);

    const TEXT: Readonly<Record<number, string>> = {
      2: 'fps',
      25: 'warmup',
      64: 'warning',
      70: 'warmup',
      100: 'disconnect',
      192: 'centre',
      358: 'weapons',
      400: 'pickup',
      408: 'scores'
    };
    const part = ({ shader, rect: [x, y], color }: Written): string => {
      if (shader === CHARSET_SHADER) return TEXT[color[0] || color[1] || color[2] ? y : y - 2] ?? `text ${y}`;
      if (shader.startsWith('gfx/2d/numbers/')) return y === 432 ? 'status' : 'powerups';
      if (shader.startsWith('gfx/2d/crosshair')) return 'crosshair';
      if (shader.startsWith('icons/iconw_') || shader === 'icons/noammo') return 'weapons';
      if (shader === SELECT_SHADER) return y === 404 ? 'scores' : 'weapons';
      if (shader === WHITE_SHADER) return y < 432 ? 'scores' : x < 592 ? 'speedometer' : 'lagometer';
      const parts: Readonly<Record<string, string>> = {
        'icons/medkit': 'holdable',
        medal_impressive: 'reward',
        lagometer: 'lagometer',
        'gfx/2d/net': 'disconnect',
        'icons/haste': 'powerups',
        'icons/quad': 'pickup'
      };
      return parts[shader] ?? shader;
    };
    const order = pics.map(part).filter((name, i, names) => name !== names[i - 1]);
    expect(order).toEqual([
      'status',
      'warning',
      'crosshair',
      'weapons',
      'holdable',
      'reward',
      'speedometer',
      'lagometer',
      'disconnect',
      'fps',
      'scores',
      'powerups',
      'pickup',
      'warmup',
      'centre'
    ]);
  });
});

describe('drawNotify', () => {
  /** The notify lines of a print, a second in. */
  function printed(text: string) {
    const buffer = new ConsoleBuffer();
    buffer.print(text, 1000);
    return notifyRows(buffer, { notifyLines: 3, notifyTime: 3, conXOffset: 0 }, 1000, false);
  }

  /** The notify lines written at a scale. */
  function notify(text: string, scale = SCALE): Written[] {
    const pics: Written[] = [];
    drawNotify(printed(text), scale, art(), writer(pics));
    return pics;
  }

  it("writes the notify lines in the canvas's own pixels, from the left edge, on any screen", () => {
    for (const scale of [SCALE, 3]) {
      const pics = notify('Sarge was railed\nby Visor\n', scale);
      // 8 by 16 of the canvas's pixels, 8 in, however tall it is; the spaces are not drawn.
      expect(placed(pics.slice(0, 1))).toEqual([[CHARSET_SHADER, [8 / scale, 0, 8 / scale, 16 / scale], 'left']]);
      expect(pics.filter((pic) => pic.rect[1] === 0)).toHaveLength('Sargewasrailed'.length);
      // The second line 16 pixels down.
      expect(pics['Sargewasrailed'.length].rect[1]).toBe(16 / scale);
      expect(pics).toHaveLength('SargewasrailedbyVisor'.length);
    }
  });

  it('writes each notify character in its own colour, cut from its cell, with no shadow', () => {
    const pics = notify('^1Sarge^7 was railed\n');
    expect(pics).toHaveLength('Sargewasrailed'.length);
    expect(pics[0].color).toEqual([1, 0, 0, 1]);
    expect(pics[5].color).toEqual([1, 1, 1, 1]);
    // 'S' is 83: row 5, column 3.
    expect(pics[0].st).toEqual([3 / 16, 5 / 16, 4 / 16, 6 / 16]);
  });

  it('writes nothing with no lines', () => {
    const pics: Written[] = [];
    drawNotify([], SCALE, art(), writer(pics));
    expect(pics).toEqual([]);
  });
});
