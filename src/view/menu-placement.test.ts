import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { fakeInstallFolder, memoryKeptStore } from '../pak/folder-test-fixtures';
import { GameData } from '../pak/game-data';
import { memoryCacheStore } from '../pak/pak-test-fixtures';
import { GameConfig } from '../settings/game-config';
import { Menu, type MenuPage } from './menu';
import { PENDING, gameDataPage } from './menu-game-data';
import { errorPage, mainPage, setupPage } from './menu-pages';
import {
  BACK_CORNER,
  BIG_SIZE,
  CHAR_SIZE,
  CUT_FRAME,
  FORWARD_CORNER,
  RING,
  SMALL_SIZE,
  placePage,
  type PagePlacement,
  type PlacedItem
} from './menu-placement';
import { ServerLists } from '../net/server-lists';
import { serversMenu } from './menu-servers';
import { startServerPage } from './menu-start-server';
import { LIST_ARROWS } from './menu-widgets';

/**
 * The main menu's, Setup's and Start Server's pages where q3_ui puts them, each checked against
 * q3_ui's own numbers.
 */

/** BACK and the way on: each a button 28 high across the middle of q3_ui's corner art, 434 to 462. */
const BACK_BUTTON = { ...BACK_CORNER, y: 434, height: 28 };
const FORWARD_BUTTON = { ...FORWARD_CORNER, y: 434, height: 28 };

/** Setup, opened as a player would open it, with a pair of models on offer. */
function setup(): Menu {
  const menu = new Menu();
  const config = new GameConfig({ warn: () => {} });
  const actions = { vidRestart: vi.fn(), exportConfig: vi.fn(), importConfig: vi.fn() };
  const models = () => [
    { model: 'sarge', skin: 'default' },
    { model: 'xaero', skin: 'blue' }
  ];
  menu.open(setupPage({ menu, config, actions, models }), 'q3ui');
  return menu;
}

/** Click an item by its label. */
function press(menu: Menu, label: string): void {
  const index = menu.page!.items.findIndex((item) => item.label === label);
  expect(index, label).toBeGreaterThanOrEqual(0);
  menu.hover(index, { x: 0.5 });
  menu.key(K.MOUSE1);
}

/** The page at the top of the stack after going through `path`, and its placement. */
function at(...path: string[]): { page: MenuPage; placed: PagePlacement } {
  const menu = setup();
  for (const label of path) press(menu, label);
  return { page: menu.page!, placed: placePage(menu.page!) };
}

/** An item's placement, by its label. */
function item({ page, placed }: { page: MenuPage; placed: PagePlacement }, label: string): PlacedItem {
  const index = page.items.findIndex((each) => each.label === label);
  expect(index, label).toBeGreaterThanOrEqual(0);
  return placed.items[index];
}

describe("Setup's pages in q3_ui's placement", () => {
  it('stands Setup in a column of buttons 34 apart, centred at 320 and down the ring, with BACK across its corner', () => {
    const setupAt = at();
    const tops = ['PLAYER', 'CONTROLS', 'SYSTEM', 'GAME OPTIONS'].map((label) => item(setupAt, label).bar.y);
    expect(tops).toEqual([110, 144, 178, 212]);
    // GAME DATA in CD Key's place, and DEFAULTS in its own; the port's own items take the next.
    const rest = ['GAME DATA', 'DEFAULTS', 'EXPORT CONFIG', 'IMPORT CONFIG'].map((label) => item(setupAt, label).bar.y);
    expect(rest).toEqual([246, 280, 314, 348]);
    const last = item(setupAt, 'IMPORT CONFIG').bar;
    expect((tops[0] + last.y + last.height) / 2).toBe(RING.y + RING.height / 2);
    const player = item(setupAt, 'PLAYER');
    expect(player.bar.x + player.bar.width / 2).toBe(320);
    expect([player.bar.width, player.bar.height]).toEqual([256, 28]);
    expect(player.text).toEqual({ kind: 'line', x: 320, align: 'centre', size: 17 });
    // Each fitted to its word, 8 round it, once it is drawn.
    expect(player.fit).toBe(8);
    expect(item(setupAt, 'BACK')).toEqual({
      bar: { x: 0, y: 434, width: 128, height: 28 },
      text: { kind: 'line', x: 64, align: 'centre', size: 17 },
      fit: 8
    });
    expect(setupAt.placed.frame).toEqual({ x: 0, y: 76, width: 632, height: 334 });
    // Its panel stands in the middle of the span under the banner and over BACK.
    expect(setupAt.placed.band).toEqual({ top: 34 + 15, bottom: 434 });
    expect(setupAt.placed.figure).toBeNull();
    expect(setupAt.placed.title).toMatchObject({ x: 320, y: 34 });
  });

  it("stands Player's rows at x=192 from y=144, 81 apart, each value under its label, and MODEL in the right corner", () => {
    const player = at('PLAYER');
    const rows = ['Name', 'Handicap', 'Effects'].map((label) => item(player, label));
    expect(rows.map(({ bar }) => bar.y)).toEqual([144, 225, 306]);
    expect(rows[0].text).toMatchObject({ kind: 'stacked', x: 192, valueX: 256, valueY: 171 });
    // q3_ui's hit box until the two are drawn, and then fitted to them, a character's width round.
    expect(rows[0].bar.x).toBe(184);
    expect(rows[0].bar.x + rows[0].bar.width).toBe(392);
    expect(rows.map(({ fit }) => fit)).toEqual([8, 8, 8]);
    expect(item(player, 'MODEL').bar).toEqual(FORWARD_BUTTON);
    expect(player.placed.preview).toEqual({ x: 400, y: -40, width: 320, height: 560 });
  });

  it("lays Model's cells 64 across, 70 apart from (50,88), and its arrows at x 125 and 186, 29 under q3_ui's and inside the ring", () => {
    const model = at('PLAYER', 'MODEL');
    const cells = model.page.items.flatMap((each, index) => (each.cell ? [model.placed.items[index].bar] : []));
    expect(cells).toHaveLength(16);
    expect(cells[0]).toEqual({ x: 50, y: 88, width: 64, height: 64 });
    const first = model.placed.items[model.page.items.findIndex((each) => each.cell)];
    expect(first.text).toEqual({
      kind: 'cell',
      picture: { x: 54, y: 92, width: 56, height: 56 },
      strip: null,
      name: null
    });
    expect(cells[5]).toMatchObject({ x: 120, y: 158 });
    expect(cells[15]).toMatchObject({ x: 260, y: 298 });
    expect(item(model, 'PREVIOUS PAGE')).toMatchObject({
      bar: { x: 125, y: 371, width: 61, height: 28 },
      text: { glyph: '<', size: 17 },
      fit: 8
    });
    expect(item(model, 'NEXT PAGE')).toMatchObject({ bar: { x: 186, y: 371, width: 64, height: 28 }, text: { glyph: '>' } });
    // The grid and the arrows centred down the ring, 12 under its top and 11 over its foot.
    expect(cells[0].y - RING.y).toBe(12);
    expect(RING.y + RING.height - (item(model, 'NEXT PAGE').bar.y + 28)).toBe(11);
    expect(item(model, 'BACK').bar).toEqual(BACK_BUTTON);
    // The name on the arrows' line, their art's middle at 369 + 16.
    expect(model.placed.caption).toEqual({ x: 497, y: 385, size: SMALL_SIZE });
    // The panel holds the player's model, where q3's own stand in the preview.
    expect(model.placed.figure).toEqual({ x: 408, y: 82, width: 216, height: 322 });
  });

  it("stands Controls' tabs at x=152, 28 apart from 186, and centres each section's rows", () => {
    const look = at('CONTROLS');
    // A button's height apart, so no tab's bar reaches the next.
    const tabs = ['LOOK', 'MOVE', 'SHOOT', 'MISC'].map((label) => item(look, label).bar.y);
    expect(tabs).toEqual([186, 214, 242, 270]);
    expect(item(look, 'MOVE')).toEqual({
      bar: { x: 16, y: 214, width: 136, height: 28 },
      text: { kind: 'line', x: 152, align: 'right', size: 17 },
      fit: 8
    });
    const rows = (controls: typeof look) =>
      controls.placed.items.filter((_, index) => {
        const each = controls.page.items[index];
        return each.tab === undefined && !each.role;
      });
    // y₀ = (480 − 16n) / 2, rows 16 apart, at x=320, where each bar runs from 168 to 488.
    const lookRows = rows(look);
    expect(lookRows.map(({ bar }) => bar.y)).toEqual([224, 240]);
    expect(lookRows[0].text).toMatchObject({ kind: 'row', x: 320 });
    // Each fitted to its label and value, 3 round them, once they are drawn.
    expect(lookRows[0].fit).toBe(3);
    expect([lookRows[0].bar.x, lookRows[0].bar.x + lookRows[0].bar.width]).toEqual([160, 480]);
    const move = at('CONTROLS', 'MOVE');
    const moveRows = rows(move);
    expect(moveRows[0].bar.y).toBe((480 - 16 * moveRows.length) / 2);
    expect(item(move, 'BACK').bar).toEqual(BACK_BUTTON);
  });

  it("stands System's tabs at x=216 from 186, and Graphics' rows at x=400 from GL Driver's 168, APPLY R@512", () => {
    const graphics = at('SYSTEM');
    const labels = ['GRAPHICS', 'DISPLAY', 'SOUND', 'NETWORK'];
    const tabs = labels.map((label) => item(graphics, label).bar);
    expect(tabs.map(({ y }) => y)).toEqual([186, 214, 242, 270]);
    expect(tabs.map(({ height }) => height)).toEqual([28, 28, 28, 28]);
    expect(item(graphics, 'GRAPHICS')).toMatchObject({ text: { x: 216, align: 'right', size: 17 }, fit: 8 });
    const rows = ['Backend', 'Lighting style', 'Overbright bits', 'Normal mapping', 'Specular mapping'].map((label) =>
      item(graphics, label)
    );
    expect(rows.map(({ bar }) => bar.y)).toEqual([168, 186, 204, 222, 240]);
    expect(rows[0].text).toMatchObject({ kind: 'row', x: 400 });
    expect(item(graphics, 'APPLY').bar).toEqual(FORWARD_BUTTON);
    expect(item(graphics, 'BACK').bar).toEqual(BACK_BUTTON);
  });

  it("stands Display's rows from 222 and Sound's from 213, their tabs where Graphics' are", () => {
    const display = at('SYSTEM', 'DISPLAY');
    const tab = item(display, 'DISPLAY');
    expect(tab).toMatchObject({ bar: { y: 214 }, text: { x: 216, align: 'right' } });
    expect(item(display, 'SOUND').bar.y).toBe(242);
    expect(item(display, 'Field of view')).toMatchObject({ bar: { y: 222 }, text: { kind: 'row', x: 400 } });
    const sound = at('SYSTEM', 'SOUND');
    expect(item(sound, 'Effects volume')).toMatchObject({ bar: { y: 213 }, text: { kind: 'row', x: 400 } });
    const music = item(sound, 'Music volume');
    expect(music).toMatchObject({ bar: { y: 231 }, text: { kind: 'row', x: 400 } });
  });

  it("stands Network's Data rate at x=400 and y=222, a row above the middle, as q3_ui does", () => {
    const rate = item(at('SYSTEM', 'NETWORK'), 'Data rate');
    expect(rate).toMatchObject({ bar: { y: 222 }, text: { kind: 'row', x: 400 } });
  });

  it("stands Game Options' rows at x=360 on q3_ui's places: 144, 166, 182, then 18 apart", () => {
    const options = at('GAME OPTIONS');
    const rows = options.placed.items.filter((_, index) => !options.page.items[index].role);
    expect(rows.map(({ bar }) => bar.y)).toEqual([144, 166, 182, 200, 218, 236, 254, 272, 290]);
    expect(rows[0].text).toMatchObject({ kind: 'row', x: 360 });
  });

  it("stands GAME DATA in CD Key's place: its rows at x=256 from 172 inside cut_frame, the pending line at 352 with the status line", async () => {
    const menu = new Menu();
    const page = await gameDataPage(menu, {
      source: { kind: 'cache', paks: 3, cache: { version: 'v', playerModels: [], paks: [], size: 1 } },
      record: new GameData(memoryKeptStore(fakeInstallFolder('ioquake')), memoryCacheStore()),
      picker: vi.fn()
    });
    const placed = placePage(page);
    const rows = ['Files from', 'Folder', 'Paks', 'Cache', 'Clear cache'].map((label) => item({ page, placed }, label));
    expect(rows.map(({ bar }) => bar.y)).toEqual([172, 190, 208, 226, 244]);
    expect(rows[0].text).toEqual({ kind: 'row', x: 256, size: CHAR_SIZE });
    for (const { bar } of [...rows, item({ page, placed }, PENDING)]) {
      expect(bar.x).toBeGreaterThanOrEqual(CUT_FRAME.x);
      expect(bar.x + bar.width).toBeLessThanOrEqual(CUT_FRAME.x + CUT_FRAME.width);
    }
    const pending = item({ page, placed }, PENDING);
    expect(pending.bar.y).toBe(352);
    expect(pending.text).toMatchObject({ kind: 'line', x: 320, align: 'centre' });
    expect(pending.withStatus).toBe(true);
    expect(item({ page, placed }, 'BACK').bar).toEqual(BACK_BUTTON);
    expect(placed.frame).toEqual(CUT_FRAME);
    expect(placed.title).toMatchObject({ x: 320, y: 34 });
  });

  it("asks a confirm's question at y=204 in the small ring, its answers buttons from 264 either side of 320, its warning under them", () => {
    const defaults = at('DEFAULTS');
    expect(defaults.page.layout).toBe('confirm');
    expect(defaults.placed.frame).toEqual(CUT_FRAME);
    // With no banner and no corner, down the whole screen.
    expect(defaults.placed.band).toEqual({ top: 0, bottom: 480 });
    expect(defaults.placed.title.y).toBeGreaterThan(204);
    expect(defaults.placed.title.y).toBeLessThan(204 + 27);
    const [yes, no] = defaults.placed.items;
    expect([yes.bar.y, no.bar.y]).toEqual([264, 264]);
    expect([yes.bar.width, yes.bar.height]).toEqual([80, 28]);
    expect(yes.text).toEqual({ kind: 'line', x: yes.bar.x + 40, align: 'centre', size: 17 });
    expect(yes.fit).toBe(8);
    const middle = (bar: PlacedItem['bar']) => bar.x + bar.width / 2;
    expect(middle(yes.bar)).toBeLessThan(320);
    expect(middle(no.bar)).toBeGreaterThan(320);
    expect(middle(yes.bar) + middle(no.bar)).toBe(640);
    // A button's margin under the answers.
    expect(defaults.placed.warning).toMatchObject({ x: 320, y: 264 + 28 + 8 });
  });
});

describe("the main menu in q3_ui's placement", () => {
  const main = () => {
    const menu = setup();
    const opens = () => ({ open: vi.fn() });
    const page = mainPage(menu, menu.page!, opens(), opens(), { exit: vi.fn() });
    return { page, placed: placePage(page) };
  };

  it('stands its buttons 34 apart from y=134, centred at 320, with no frame and no corner', () => {
    const mainAt = main();
    const labels = ['SINGLE PLAYER', 'MULTIPLAYER', 'SETUP', 'EXIT'];
    const tops = labels.map((label) => item(mainAt, label).bar.y);
    expect(tops).toEqual([134, 168, 202, 236]);
    const exit = item(mainAt, 'EXIT');
    expect(exit.bar).toEqual({ x: 192, y: 236, width: 256, height: 28 });
    expect(exit.text).toEqual({ kind: 'line', x: 320, align: 'centre', size: 17 });
    expect(mainAt.placed.frame).toBeNull();
  });

  it("writes the game's name in the middle of the strip across the top, where q3_ui turns its banner", () => {
    const { placed } = main();
    expect(placed.title).toMatchObject({ x: 320, y: 60 });
    // Bigger than a page's banner, and inside the 120-high strip.
    expect(placed.title.size).toBeGreaterThan(at().placed.title.size);
    expect(placed.title.size).toBeLessThan(120);
  });

  it('writes an error under the strip, wrapped to 600 from (320,192), 20 a line, in the small size', () => {
    const page = errorPage("Couldn't load maps/backyard.sog", () => {});
    const placed = placePage(page);
    expect(placed.message).toEqual({ x: 320, y: 192, size: SMALL_SIZE, width: 600, lineHeight: 20 });
    expect(placed.frame).toBeNull();
    expect(placed.title).toEqual(main().placed.title);
    expect(placed.items).toEqual([]);
  });

  it("steps a confirm's warning 27 a line from y=300, as Defaults draws its two, inside the small ring", () => {
    const { warning } = at('DEFAULTS').placed;
    expect(warning).toMatchObject({ x: 320, y: 300, size: SMALL_SIZE, lineHeight: 27 });
    // Its two lines end over the ring's foot.
    expect(warning!.y + 2 * warning!.lineHeight).toBeLessThan(CUT_FRAME.y + CUT_FRAME.height);
  });

  it("gives Setup and a confirm no message's place", () => {
    expect(at().placed.message).toBeNull();
    expect(at('DEFAULTS').placed.message).toBeNull();
  });
});

describe("Start Server and Server Options in q3_ui's placement", () => {
  /** Start Server over six maps, opened as SINGLE PLAYER opens it. */
  const startServer = () => {
    const menu = new Menu();
    const config = new GameConfig({ warn: () => {} });
    const arenas = Array.from({ length: 6 }, (_, i) => `\\type\\ffa\\map\\dm${i + 1}`);
    const opened = startServerPage({
      menu,
      config,
      arenas,
      bots: () => [],
      presets: () => [],
      actions: { command: vi.fn() }
    });
    opened.open();
    return { menu, page: opened.page, placed: placePage(opened.page) };
  };

  it("lays its maps two across, 136 apart from (188,84), 12 over q3_ui's, each a 128×96 picture over a 28-high strip", () => {
    const { page, placed } = startServer();
    const cells = placed.items.filter((_, index) => page.items[index].cell);
    expect(cells.map(({ bar }) => bar)).toEqual([
      { x: 188, y: 84, width: 128, height: 128 },
      { x: 324, y: 84, width: 128, height: 128 },
      { x: 188, y: 220, width: 128, height: 128 },
      { x: 324, y: 220, width: 128, height: 128 }
    ]);
    // The name 4 down the strip, in the 16-high characters: its middle 96 + 4 + 8 down its cell.
    expect(cells[3].text).toEqual({
      kind: 'cell',
      picture: { x: 324, y: 220, width: 128, height: 96 },
      strip: { x: 324, y: 316, width: 128, height: 28 },
      name: { x: 388, y: 328, size: CHAR_SIZE }
    });
  });

  it("stands Game type's row 8 under the maps and as wide, split at q3_ui's x=296, the arrows under it inside the ring, and the map's name at (320,440)", () => {
    const start = startServer();
    expect(item(start, 'Game type')).toEqual({
      bar: { x: 188, y: 356, width: 264, height: 16 },
      text: { kind: 'row', x: 296, size: CHAR_SIZE },
      fit: 3
    });
    expect(item(start, 'PREVIOUS PAGE')).toMatchObject({
      bar: { x: 260, y: 377, width: 64, height: 28 },
      text: { glyph: '<', size: 17 }
    });
    expect(item(start, 'NEXT PAGE')).toMatchObject({
      bar: { x: 321, y: 377, width: 64, height: 28 },
      text: { glyph: '>' }
    });
    // Between the game type's row and the ring's foot.
    const arrow = item(start, 'NEXT PAGE').bar;
    expect(arrow.y).toBeGreaterThan(356 + 16);
    expect(arrow.y + arrow.height).toBeLessThan(RING.y + RING.height);
    expect(start.placed.caption).toEqual({ x: 320, y: 440 + 27 / 2, size: BIG_SIZE });
    expect(item(start, 'BACK').bar).toEqual(BACK_BUTTON);
    expect(item(start, 'NEXT').bar).toEqual(FORWARD_BUTTON);
    expect(start.placed.frame).toEqual(RING);
    expect(start.placed.title).toMatchObject({ x: 320, y: 34 });
    expect(start.placed.picture).toBeNull();
  });

  it("shows Server Options' map 160×120 at (352,80), with its name and game type on the strip under it", () => {
    const { menu } = startServer();
    press(menu, 'NEXT');
    const options = { page: menu.page!, placed: placePage(menu.page!) };
    expect(options.page.id).toBe('serveroptions');
    expect(options.placed.picture).toEqual({
      picture: { x: 352, y: 80, width: 160, height: 120 },
      strip: { x: 352, y: 200, width: 160, height: 40 },
      lines: [
        { x: 432, y: 212, size: CHAR_SIZE },
        { x: 432, y: 228, size: CHAR_SIZE }
      ]
    });
    expect(item(options, 'BACK').bar).toEqual(BACK_BUTTON);
    expect(item(options, 'FIGHT').bar).toEqual(FORWARD_BUTTON);
    expect(options.placed.caption).toBeNull();
  });

  /** Server Options for team deathmatch, over twenty bots, placed. */
  const teamOptions = () => {
    const menu = new Menu();
    const config = new GameConfig({ warn: () => {} });
    const bots = Array.from({ length: 20 }, (_, i) => ({ name: `bot${String(i).padStart(2, '0')}`, model: 'sarge' }));
    const opened = startServerPage({
      menu,
      config,
      arenas: ['\\type\\team\\map\\team1'],
      bots: () => bots,
      presets: () => [],
      actions: { command: vi.fn() }
    });
    opened.open();
    menu.key(K.RIGHTARROW);
    press(menu, 'NEXT');
    return { menu, page: menu.page!, placed: placePage(menu.page!) };
  };
  /** An item's place by the name its page gives it. */
  const named = ({ page, placed }: { page: MenuPage; placed: PagePlacement }, place: string) =>
    placed.items[page.items.findIndex((candidate) => candidate.place === place)];
  const slotRow = (x: number, y: number, left: number, right: number): PlacedItem => ({
    bar: { x: left, y, width: right - left, height: 16 },
    text: { kind: 'row', x, size: CHAR_SIZE },
    fit: 3
  });

  it("stands Bot skill at (128,80), and each slot's type, name and side at x 32, 96 and 240 from 112, 20 apart", () => {
    const options = teamOptions();
    expect(named(options, 'skill')).toEqual(slotRow(128, 80, 40, 248));
    expect(named(options, 'type 0')).toEqual(slotRow(32, 112, 24, 72));
    expect(named(options, 'name 0')).toEqual(slotRow(96, 112, 88, 224));
    expect(named(options, 'team 0')).toEqual(slotRow(240, 112, 232, 280));
    expect(named(options, 'type 11')).toEqual(slotRow(32, 332, 24, 72));
    expect(named(options, 'name 6')).toEqual(slotRow(96, 232, 88, 224));
    expect(named(options, 'team 11')).toEqual(slotRow(240, 332, 232, 280));
  });

  it("stands Server Options' other rows at x=456 from 272, 18 apart, and its status at (320,440)", () => {
    const options = teamOptions();
    const rows = ['Frag limit', 'Time limit', 'Friendly fire', 'Preset', 'Offhand grapple', 'Spawn armor'];
    expect(rows.map((label) => item(options, label).bar.y)).toEqual([272, 290, 308, 326, 344, 362]);
    expect(rows.map((label) => item(options, label).text)).toEqual(
      rows.map(() => ({ kind: 'row', x: 456, size: CHAR_SIZE }))
    );
    expect(options.placed.status).toEqual({ x: 320, y: 448, size: CHAR_SIZE });
    expect(options.placed.frame).toEqual(RING);
  });

  it("lays Bot Select's portraits four by four from (180,80), 70 across and 86 down, each named under it", () => {
    const { menu } = teamOptions();
    menu.hover(menu.page!.items.findIndex((candidate) => candidate.place === 'name 1'));
    menu.key(K.MOUSE1);
    const select = { page: menu.page!, placed: placePage(menu.page!) };
    expect(select.page.id).toBe('botselect');
    const cells = select.placed.items.filter((_, index) => select.page.items[index].cell);
    expect(cells.map(({ bar }) => [bar.x, bar.y])).toEqual(
      [80, 166, 252, 338].flatMap((y) => [180, 250, 320, 390].map((x) => [x, y]))
    );
    expect(cells[15]).toEqual({
      bar: { x: 390, y: 338, width: 64, height: 64 },
      text: {
        kind: 'cell',
        picture: { x: 390, y: 338, width: 64, height: 64 },
        strip: null,
        name: { x: 422, y: 410, size: CHAR_SIZE }
      }
    });
    expect(item(select, 'PREVIOUS PAGE').bar).toEqual({ x: 260, y: 442, width: 64, height: 28 });
    expect(item(select, 'NEXT PAGE').bar).toEqual({ x: 321, y: 442, width: 64, height: 28 });
    expect(item(select, 'BACK').bar).toEqual(BACK_BUTTON);
    expect(item(select, 'ACCEPT').bar).toEqual(FORWARD_BUTTON);
    expect(select.placed.frame).toBeNull();
    expect(select.placed.caption).toBeNull();
    expect(select.placed.title).toMatchObject({ x: 320, y: 34 });
  });
});

describe("ARENA SERVERS and SPECIFY SERVER in q3_ui's placement", () => {
  /** The browser, opened from MULTIPLAYER, and its placement. */
  const browser = () => {
    const menu = new Menu();
    const config = new GameConfig({ warn: () => {} });
    const servers = new ServerLists({ cvars: config.cvars, now: () => 0, print: () => {} });
    const opened = serversMenu({
      menu,
      config,
      actions: { command: vi.fn() },
      servers,
      status: {
        getServerStatus: vi.fn(() => null),
        probe: vi.fn(),
        probeOpen: vi.fn(() => false)
      },
      favorites: { add: vi.fn(() => 1), remove: vi.fn() },
      startServer: { open: vi.fn() },
      protocol: 71,
      now: () => 0
    });
    menu.open({ items: [] }, 'q3ui');
    opened.open();
    return { menu, page: menu.page!, placed: placePage(menu.page!) };
  };
  /** The Server Information box, opened over the browser past its greying, and its placement. */
  const infoBox = () => {
    const { menu } = browser();
    menu.page!.items.find((each) => each.label === 'SERVER INFO')!.activate!();
    return { page: menu.page!, placed: placePage(menu.page!) };
  };
  /** The list, which reads no label, by its place. */
  const listOf = ({ page, placed }: ReturnType<typeof browser>) =>
    placed.items[page.items.findIndex((each) => each.place === 'list')];

  it("stands the spins at q3_ui's x=320, 16 apart from 80, beside the levelshot at (72,80)", () => {
    const servers = browser();
    const spins = ['Servers', 'Game type', 'Sort by', 'Show full', 'Show empty'].map((label) =>
      item(servers, label)
    );
    expect(spins.map(({ bar }) => bar.y)).toEqual([80, 96, 112, 128, 144]);
    const row = { kind: 'row', x: 320, size: CHAR_SIZE };
    expect(spins.map(({ text }) => text)).toEqual(spins.map(() => row));
    expect(servers.placed.picture).toEqual({
      picture: { x: 72, y: 80, width: 128, height: 96 },
      strip: null,
      lines: []
    });
  });

  it("stands ADD TO FAVORITES in q3_ui's corner from its art's left, SERVER INFO under it", () => {
    const servers = browser();
    const favorite = item(servers, 'ADD TO FAVORITES');
    // Across the middle of DELETE's art, 96 by 48 at (450,86), until it is fitted to its text.
    expect(favorite.bar).toEqual({ x: 450, y: 96, width: 96, height: 28 });
    expect(favorite.text).toEqual({ kind: 'line', x: 458, align: 'left', size: 17 });
    expect(favorite.fit).toBe(8);
    const info = item(servers, 'SERVER INFO');
    expect(info.bar).toEqual({ ...favorite.bar, y: 130 });
    expect(info.text).toEqual(favorite.text);
    // Both above the list.
    expect(info.bar.y + info.bar.height).toBeLessThan(listOf(servers).bar.y);
  });

  it("lays the list's 11 rows at q3_ui's (72,192), its columns at q3_ui's characters", () => {
    const list = listOf(browser());
    expect(list.bar).toEqual({ x: 72, y: 192, width: 454, height: 176 });
    expect(list.text).toEqual({
      kind: 'list',
      rows: 11,
      size: CHAR_SIZE,
      columns: [
        { x: 75, align: 'left', width: 160 },
        { x: 243, align: 'left', width: 96 },
        { x: 387, align: 'right', width: 40 },
        { x: 395, align: 'left', width: 64 },
        { x: 523, align: 'right', width: 56 }
      ]
    });
    // Each column ends before the next starts, the last inside the list.
    const { columns } = list.text as Extract<PlacedItem['text'], { kind: 'list' }>;
    const spans = columns.map(({ x, align, width }) =>
      align === 'left' ? [x, x + width] : [x - width, x]
    );
    for (let n = 1; n < spans.length; n++) {
      expect(spans[n][0]).toBeGreaterThanOrEqual(spans[n - 1][1]);
    }
    expect(spans.at(-1)![1]).toBeLessThanOrEqual(72 + 454);
  });

  it("stands its arrows beside the list, top and bottom, a button's margin clear of it", () => {
    const servers = browser();
    const up = item(servers, LIST_ARROWS.up);
    // Each bar from its art's left at 526 + 8, its glyph a margin in, so fitted it keeps the gap.
    expect(up.bar).toEqual({ x: 534, y: 192, width: 28, height: 28 });
    expect(up.text).toEqual({ kind: 'line', x: 542, align: 'left', size: 17 });
    expect(up.fit).toBe(8);
    expect(item(servers, LIST_ARROWS.down).bar).toEqual({ x: 534, y: 340, width: 28, height: 28 });
  });

  it("centres the count line with the status line at q3_ui's 376, and keeps no detail", () => {
    const servers = browser();
    expect(servers.placed.detail).toBeNull();
    const at = servers.page.items.findIndex((each) => each.place === 'count');
    const count = servers.placed.items[at];
    expect(count.bar).toEqual({ x: 72, y: 376, width: 496, height: 16 });
    expect(count.text).toMatchObject({ x: 320, align: 'centre' });
    expect(count.withStatus).toBe(true);
  });

  it('stands SPECIFY, REFRESH and CREATE across the foot between BACK and FIGHT', () => {
    const servers = browser();
    expect(item(servers, 'BACK').bar).toEqual(BACK_BUTTON);
    expect(item(servers, 'FIGHT').bar).toEqual(FORWARD_BUTTON);
    const foot = ['SPECIFY', 'REFRESH', 'CREATE'].map((label) => item(servers, label));
    expect(foot.map(({ bar }) => bar)).toEqual(
      [128, 256, 384].map((x) => ({ x, y: 434, width: 128, height: 28 }))
    );
  });

  it('holds everything but the foot inside the ring, which its panel is fitted in', () => {
    const servers = browser();
    expect(servers.placed.frame).toEqual(RING);
    const inside = (bar: { x: number; y: number; width: number; height: number }) =>
      bar.x >= RING.x &&
      bar.y >= RING.y &&
      bar.x + bar.width <= RING.x + RING.width &&
      bar.y + bar.height <= RING.y + RING.height;
    const foot = new Set(['BACK', 'SPECIFY', 'REFRESH', 'CREATE', 'FIGHT']);
    servers.page.items.forEach((each, index) => {
      expect(inside(servers.placed.items[index].bar), each.label).toBe(!foot.has(each.label));
    });
  });

  it('stands the Server Information box 320 across, the screen less a row at each end', () => {
    const box = infoBox();
    expect(box.placed.frame).toEqual({ x: 160, y: 16, width: 320, height: 448 });
    // The title across its top, a panel's padding in, in a confirm's question's size.
    expect(box.placed.title).toEqual({ x: 320, y: 30 + 27 / 2, size: BIG_SIZE });
    // REFRESH and CLOSE at the foot's right, each over 88 across.
    expect(item(box, 'REFRESH').bar).toEqual({ x: 290, y: 422, width: 88, height: 28 });
    expect(item(box, 'CLOSE').bar).toEqual({ x: 378, y: 422, width: 88, height: 28 });
    expect(item(box, 'CLOSE').text).toEqual({ kind: 'line', x: 422, align: 'centre', size: 17 });
  });

  it('places no popup it has no box for, nor an item of one with no place in it', () => {
    const items = [{ label: 'CLOSE', place: 'close' }];
    expect(() => placePage({ id: 'nobox', layout: 'popup', items })).toThrow('No box');
    const page = { id: 'serverinfo', layout: 'popup' as const, items: [{ label: 'HELP' }] };
    expect(() => placePage(page)).toThrow('No place');
  });

  it("tables the box's settings in ten rows under its title, and gives the board the rest", () => {
    const { room, settings, board } = infoBox().placed.detail!;
    // Labels end a character short of 246, from the padding's edge 64 across; values run to the
    // padding's right edge.
    expect(settings).toEqual({ x: 246, y: 73, step: 16, rows: 10, right: 466, size: CHAR_SIZE });
    expect(settings.x - 8 - room.x).toBe(64);
    // The board 8 under them, down to 8 over the buttons: 181 high.
    expect(board).toEqual({ x: 174, y: 233, width: 292, height: 181 });
    expect(settings.y - settings.step / 2 + settings.rows * settings.step + 8).toBe(board.y);
    expect(board.y + board.height).toBe(room.y + room.height);
    expect(room.y + room.height + 8).toBe(422);
  });

  it("stands SPECIFY's fields at x=206, 30 apart from 220, ADD TO FAVORITES at the foot", () => {
    const { menu } = browser();
    press(menu, 'SPECIFY');
    const specify = { page: menu.page!, placed: placePage(menu.page!) };
    const fields = ['Address', 'Port', 'Name'].map((label) => item(specify, label));
    expect(fields.map(({ bar }) => bar.y)).toEqual([220, 250, 280]);
    const row = { kind: 'row', x: 206, size: CHAR_SIZE };
    expect(fields.map(({ text }) => text)).toEqual(fields.map(() => row));
    const favorite = item(specify, 'ADD TO FAVORITES');
    expect(favorite.bar).toEqual({ x: 256, y: 434, width: 128, height: 28 });
    expect(item(specify, 'FIGHT').bar).toEqual(FORWARD_BUTTON);
    expect(specify.placed.frame).toEqual(RING);
  });
});

describe('a page q3_ui has no place for', () => {
  it('stands by its layout: a column, widget rows, or a grid, with its corners still in place', () => {
    const column = placePage({ items: [{ label: 'A' }, { label: 'B' }, { label: 'BACK', role: 'back' }] });
    expect(column.items.map(({ bar }) => bar.y)).toEqual([134, 168, 434]);
    expect(column.frame).toEqual(RING);
    // A page with no corner button stands its panel down to the screen's foot.
    expect(placePage({ items: [{ label: 'A' }] }).band).toEqual({ top: 49, bottom: 480 });
    const rows = placePage({ layout: 'form', items: [{ label: 'A', value: '1' }, { label: 'NEXT', role: 'forward' }] });
    expect(rows.items[0].text).toMatchObject({ kind: 'row', x: 320 });
    expect(rows.items[1].bar).toEqual(FORWARD_BUTTON);
    const grid = placePage({ layout: 'grid', items: [{ label: '', cell: true }] });
    expect(grid.items[0].bar).toEqual({ x: 50, y: 88, width: 64, height: 64 });
  });
});
