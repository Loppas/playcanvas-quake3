import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { GameConfig } from '../settings/game-config';
import { GT } from '../sim/constants';
import { Menu, type MenuItem, type MenuSound } from './menu';
import { mainPage, setupPage } from './menu-pages';
import {
  NO_BOT,
  NO_LIMIT,
  NO_MAPS,
  seedSlots,
  startServerPage,
  type BotInfo,
  type StartServerContext
} from './menu-start-server';

/** Start Server and the pages it leads to, used as a player would, from the main menu. */

/** An arena's info string, with the bots it names where it names any. */
const arena = (map: string, type: string, bots?: string) =>
  `\\type\\${type}\\map\\${map}` + (bots === undefined ? '' : `\\bots\\${bots}`);

/**
 * Nine free-for-all maps, one for teams, one for both, one for Clan Arena alone, and one of Single
 * Player's, which Free For All lists: eleven, in three pages, for Free For All. The first names
 * three bots, one of them unknown.
 */
const ARENAS = [
  arena('dm1', 'ffa', 'ranger  nobody sarge'),
  ...Array.from({ length: 8 }, (_, i) => arena(`dm${i + 2}`, 'ffa')),
  arena('team1', 'team'),
  arena('both', 'ffa team'),
  arena('ca1', 'clanarena'),
  arena('sp1', 'single')
];

/**
 * Twenty bots, in the order the files name them, which is not their names' order. The fourth's
 * name has colours, which sort it first, and runs long.
 */
const BOTS: readonly BotInfo[] = [
  { name: 'Sarge', model: 'sarge' },
  { name: 'grunt', model: 'grunt' },
  { name: 'Major', model: 'major/red' },
  { name: '^1Visor^7TheWatcherOfAll', model: 'visor' },
  { name: 'Ranger', model: 'ranger' },
  { name: 'Phobos', model: 'doom/phobos' },
  { name: 'Mynx', model: 'mynx' },
  { name: 'Orbb', model: 'orbb' },
  { name: 'Bitterman', model: 'bitterman' },
  { name: 'Anarki', model: 'anarki' },
  { name: 'Biker', model: 'biker/hossman' },
  { name: 'Bones', model: 'bones' },
  { name: 'Cadavre', model: 'bones/bones' },
  { name: 'Crash', model: 'crash' },
  { name: 'Daemia', model: 'major/daemia' },
  { name: 'Doom', model: 'doom' },
  { name: 'Gorre', model: 'lucy' },
  { name: 'Hunter', model: 'hunter' },
  { name: 'Klesk', model: 'klesk' },
  { name: 'Xaero', model: 'xaero' }
];

/** Their names in the order Bot Select shows them, cut to 15 and then cleaned. */
const SORTED = [
  'VisorTheWat',
  'Anarki',
  'Biker',
  'Bitterman',
  'Bones',
  'Cadavre',
  'Crash',
  'Daemia',
  'Doom',
  'Gorre',
  'grunt',
  'Hunter',
  'Klesk',
  'Major',
  'Mynx',
  'Orbb',
  'Phobos',
  'Ranger',
  'Sarge',
  'Xaero'
];

/** The main menu, with SINGLE PLAYER chosen, over a config of its own. */
function opened(context: Partial<StartServerContext> = {}) {
  const config = new GameConfig({ warn: () => {} });
  const sounds: MenuSound[] = [];
  const menu = new Menu({ sound: (sound) => sounds.push(sound) });
  const command = vi.fn();
  const startServer = startServerPage({
    menu,
    config,
    arenas: ARENAS,
    bots: () => BOTS,
    presets: () => ['vq3', 'cpm', 'mine'],
    actions: { command },
    ...context
  });
  const setupActions = { vidRestart: vi.fn(), exportConfig: vi.fn(), importConfig: vi.fn() };
  const setup = setupPage({ menu, config, actions: setupActions, models: () => [] });
  const main = mainPage(menu, setup, startServer, { open: vi.fn() }, { exit: vi.fn() });
  menu.open(main, 'q3ui');
  go(menu, 'SINGLE PLAYER');
  return { menu, config, command, sounds, main, startServer: startServer.page };
}

/** An item's place on the page, by its label. */
function index(menu: Menu, label: string): number {
  const at = menu.page!.items.findIndex((item) => item.label === label);
  expect(at, label).toBeGreaterThanOrEqual(0);
  return at;
}

/** Click an item by its label. */
function go(menu: Menu, label: string): void {
  menu.hover(index(menu, label), { x: 0.5 });
  menu.key(K.MOUSE1);
}

/** Click the `tile`th map on the page. */
function choose(menu: Menu, tile: number): void {
  const cells = menu.page!.items.flatMap((item, at) => (item.cell ? [at] : []));
  menu.hover(cells[tile]);
  menu.key(K.MOUSE1);
}

/** The maps the page shows, by name, `null` for an empty slot. */
const tiles = (menu: Menu) =>
  menu.page!.items.filter((item) => item.cell).map((item) => (item.hidden ? null : item.label));
/** The tile shown as chosen, or −1. */
const chosen = (menu: Menu) => menu.page!.items.filter((item) => item.cell).findIndex((item) => item.selected);
const gameType = (menu: Menu) => menu.page!.items[0].value;

describe('Start Server', () => {
  it('opens on Free For All, its first page and its first map, with the cursor on Game type', () => {
    const { menu } = opened();
    expect(menu.page!.id).toBe('startserver');
    expect(menu.page!.title).toBe('GAME SERVER');
    expect(menu.placement).toBe('q3ui');
    expect(menu.cursor).toBe(0);
    expect(gameType(menu)).toBe('Free For All');
    expect(tiles(menu)).toEqual(['DM1', 'DM2', 'DM3', 'DM4']);
    expect(chosen(menu)).toBe(0);
    expect(menu.page!.caption).toBe('DM1');
    expect(menu.page!.items[1].icon).toBe('levelshots/DM1');
  });

  it('opens on Free For All whatever g_gametype holds', () => {
    const config = new GameConfig({ warn: () => {} });
    config.cvars.set('g_gametype', String(GT.CTF));
    const menu = new Menu();
    startServerPage({
      menu,
      config,
      arenas: ARENAS,
      bots: () => [],
      presets: () => [],
      actions: { command: vi.fn() }
    }).open();
    expect(gameType(menu)).toBe('Free For All');
  });

  it("lists the maps each game type is made for, Free For All taking Single Player's too", () => {
    const { menu } = opened();
    const lists: (string | null)[][] = [];
    const captions: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      menu.key(K.RIGHTARROW);
      lists.push(tiles(menu));
      captions.push(menu.page!.caption);
    }
    expect(lists).toEqual([
      ['TEAM1', 'BOTH', null, null],
      [null, null, null, null],
      [null, null, null, null],
      ['CA1', null, null, null],
      ['DM1', 'DM2', 'DM3', 'DM4']
    ]);
    expect(captions).toEqual(['TEAM1', NO_MAPS, NO_MAPS, 'CA1', 'DM1']);
    go(menu, 'NEXT PAGE');
    go(menu, 'NEXT PAGE');
    expect(tiles(menu)).toEqual(['DM9', 'BOTH', 'SP1', null]);
  });

  it('can go on to NEXT only with a map to choose', () => {
    const { menu } = opened();
    menu.key(K.RIGHTARROW);
    menu.key(K.RIGHTARROW);
    expect(gameType(menu)).toBe('Tournament');
    const next = menu.page!.items[index(menu, 'NEXT')];
    expect(next.grayed).toBe(true);
    menu.hover(index(menu, 'NEXT'));
    menu.key(K.MOUSE1);
    expect(menu.page!.id).toBe('startserver');
  });

  it('goes back to the first page and the first map when the game type changes', () => {
    const { menu } = opened();
    go(menu, 'NEXT PAGE');
    choose(menu, 2);
    expect(menu.page!.caption).toBe('DM7');
    menu.hover(0);
    menu.key(K.RIGHTARROW);
    menu.key(K.LEFTARROW);
    expect(tiles(menu)).toEqual(['DM1', 'DM2', 'DM3', 'DM4']);
    expect(menu.page!.caption).toBe('DM1');
  });

  it('turns its pages with the arrows, which do nothing at the ends but sound, and never hide', () => {
    const { menu, sounds } = opened();
    go(menu, 'PREVIOUS PAGE');
    expect(tiles(menu)).toEqual(['DM1', 'DM2', 'DM3', 'DM4']);
    for (let i = 0; i < 3; i++) go(menu, 'NEXT PAGE');
    expect(tiles(menu)).toEqual(['DM9', 'BOTH', 'SP1', null]);
    sounds.length = 0;
    go(menu, 'NEXT PAGE');
    expect(sounds).toEqual(['move']);
    const arrows = ['PREVIOUS PAGE', 'NEXT PAGE'].map((label) => menu.page!.items[index(menu, label)]);
    expect(arrows.map((arrow) => arrow.hidden ?? false)).toEqual([false, false]);
  });

  it('chooses a map by a click or Enter, which stays chosen as the pages turn, shown on its own page', () => {
    const { menu } = opened();
    choose(menu, 2);
    expect(menu.page!.caption).toBe('DM3');
    expect(chosen(menu)).toBe(2);
    go(menu, 'NEXT PAGE');
    expect(chosen(menu)).toBe(-1);
    expect(menu.page!.caption).toBe('DM3');
    menu.hover(index(menu, 'DM6'));
    menu.key(K.ENTER);
    expect(menu.page!.caption).toBe('DM6');
    go(menu, 'PREVIOUS PAGE');
    expect(chosen(menu)).toBe(-1);
  });

  it('goes round Game type, the maps, the arrows, BACK and NEXT, passing an empty slot by', () => {
    const { menu } = opened();
    const labels: string[] = [];
    for (let i = 0; i < 9; i++) {
      menu.key(K.DOWNARROW);
      labels.push(menu.page!.items[menu.cursor].label);
    }
    expect(labels).toEqual(['DM1', 'DM2', 'DM3', 'DM4', 'PREVIOUS PAGE', 'NEXT PAGE', 'BACK', 'NEXT', 'Game type']);
    menu.key(K.UPARROW);
    expect(menu.page!.items[menu.cursor].label).toBe('NEXT');
    menu.key(K.TAB);
    expect(menu.cursor).toBe(0);

    for (let i = 0; i < 3; i++) go(menu, 'NEXT PAGE');
    menu.hover(index(menu, 'SP1'));
    menu.key(K.DOWNARROW);
    expect(menu.page!.items[menu.cursor].label).toBe('PREVIOUS PAGE');
  });

  it('steps only the game type with left and right', () => {
    const { menu } = opened();
    choose(menu, 1);
    const cursor = menu.cursor;
    expect(menu.key(K.RIGHTARROW)).toBe(false);
    expect(menu.key(K.LEFTARROW)).toBe(false);
    expect(menu.cursor).toBe(cursor);
    expect(gameType(menu)).toBe('Free For All');
    expect(menu.page!.caption).toBe('DM2');
  });

  it.each([
    ['BACK', (menu: Menu) => go(menu, 'BACK')],
    ['Escape', (menu: Menu) => menu.key(K.ESCAPE)]
  ])('goes back to the main menu at %s', (_, leave) => {
    const { menu, main } = opened();
    leave(menu);
    expect(menu.page).toBe(main);
    expect(menu.depth).toBe(1);
  });

  it('opens as new at each visit', () => {
    const { menu } = opened();
    menu.key(K.RIGHTARROW);
    go(menu, 'NEXT PAGE');
    go(menu, 'BACK');
    go(menu, 'SINGLE PLAYER');
    expect(gameType(menu)).toBe('Free For All');
    expect(tiles(menu)).toEqual(['DM1', 'DM2', 'DM3', 'DM4']);
    expect(menu.page!.caption).toBe('DM1');
    expect(menu.cursor).toBe(0);
  });
});

/** Server Options for a game type, by its place in Start Server's list, and a map on its first page. */
function serverOptions(gametype = 0, tile = 0, context: Partial<StartServerContext> = {}) {
  const opening = opened(context);
  for (let i = 0; i < gametype; i++) opening.menu.key(K.RIGHTARROW);
  choose(opening.menu, tile);
  go(opening.menu, 'NEXT');
  return opening;
}

/** An item by the place its page names. */
function at(menu: Menu, place: string): MenuItem {
  const item = menu.page!.items.find((candidate) => candidate.place === place);
  expect(item, place).toBeDefined();
  return item!;
}

/** Click an item by the place its page names. */
function click(menu: Menu, place: string): void {
  menu.hover(menu.page!.items.indexOf(at(menu, place)), { x: 0.5 });
  menu.key(K.MOUSE1);
}

/** The slots as the page shows them: each type, name and side, or `null` for a hidden one. */
function slots(menu: Menu) {
  const shown = (item: MenuItem | undefined) => (item === undefined || item.hidden ? null : item.value);
  return Array.from({ length: 12 }, (_, n) =>
    [`type ${n}`, `name ${n}`, `team ${n}`].map((place) =>
      shown(menu.page!.items.find((item) => item.place === place))
    )
  );
}

/** The right column's rows, by label and value. */
const column = (menu: Menu) =>
  menu.page!.items
    .filter((item) => item.place === undefined && item.role === undefined)
    .map((item) => [item.label, item.value]);

describe('Server Options', () => {
  it('writes g_gametype at NEXT, and shows the chosen map and its game type, the cursor on Bot skill', () => {
    const { menu, config } = serverOptions(1, 1);
    expect(config.cvars.string('g_gametype')).toBe(String(GT.TEAM));
    expect(menu.page!.id).toBe('serveroptions');
    expect(menu.page!.title).toBe('GAME SERVER');
    expect(menu.page!.picture).toEqual({ icon: 'levelshots/BOTH', lines: ['BOTH', 'Team Deathmatch'] });
    expect(menu.page!.items[menu.cursor].label).toBe('Bot skill');
    expect(menu.page!.items[menu.cursor].value).toBe('Bring It On');
  });

  it("keeps each slot's name to the room of q3_ui's 15 characters, the human's and a bot's", () => {
    const { menu } = serverOptions(1);
    expect(['name 0', 'name 1'].map((place) => at(menu, place).widthInChars)).toEqual([15, 15]);
  });

  it("seeds a free-for-all with the arena's bots, found by name or else by the slot's number", () => {
    const { menu, config } = opened();
    config.cvars.set('name', '^1Unnamed^7PlayerOne');
    go(menu, 'NEXT');
    const open = ['Open', null, null];
    const closed = ['----', null, null];
    expect(slots(menu)).toEqual([
      ['Human', 'UnnamedPlay', null],
      ['Bot', 'Ranger', null],
      ['Bot', 'Major', null],
      ['Bot', 'Sarge', null],
      open,
      open,
      open,
      open,
      closed,
      closed,
      closed,
      closed
    ]);
    // Made a Bot, a slot past the arena's bots names none.
    click(menu, 'type 4');
    expect(at(menu, 'type 4').value).toBe('Bot');
    expect(at(menu, 'name 4').value).toBe(NO_BOT);
  });

  it('seeds team deathmatch four a side, and the other team games three', () => {
    const shut = ['----', null, null];
    const teams = (gametype: number) => slots(serverOptions(gametype, 0).menu);
    expect(teams(1)).toEqual([
      ['Human', 'UnnamedPlayer', 'Blue'],
      ['Bot', 'grunt', 'Blue'],
      ['Bot', 'major', 'Blue'],
      ['Bot', 'visor', 'Blue'],
      shut,
      shut,
      ['Bot', 'sarge', 'Red'],
      ['Bot', 'grunt', 'Red'],
      ['Bot', 'major', 'Red'],
      ['Bot', 'visor', 'Red'],
      shut,
      shut
    ]);
    const three = [
      ['Human', 'UnnamedPlayer', 'Blue'],
      ['Bot', 'grunt', 'Blue'],
      ['Bot', 'major', 'Blue'],
      shut,
      shut,
      shut,
      ['Bot', 'sarge', 'Red'],
      ['Bot', 'grunt', 'Red'],
      ['Bot', 'major', 'Red'],
      shut,
      shut,
      shut
    ];
    // A name as the files give it, cut to what a slot holds and not cleaned.
    const long = seedSlots(BOTS, arena('x', 'ffa', '^1visor^7thewatcherofall'), GT.FFA, 'x');
    expect(long[1].name).toBe('^1Visor^7TheWat');
    // A closed slot holds no name, so a Bot made there later has none until one is chosen.
    expect(seedSlots(BOTS, undefined, GT.CTF, 'x').map((slot) => slot.name)[3]).toBe('');
    // Clan Arena, seeded as Capture the Flag is.
    expect(teams(4)).toEqual(three);
    expect(seedSlots(BOTS, undefined, GT.CA, 'x')).toEqual(seedSlots(BOTS, undefined, GT.CTF, 'x'));
  });

  it('shows a Bot slot its name and side, an Open one its side, and a closed one neither', () => {
    const { menu } = serverOptions(1, 0);
    click(menu, 'type 1');
    expect(slots(menu)[1]).toEqual(['----', null, null]);
    click(menu, 'type 1');
    expect(slots(menu)[1]).toEqual(['Open', null, 'Blue']);
    click(menu, 'type 1');
    expect(slots(menu)[1]).toEqual(['Bot', 'grunt', 'Blue']);
    click(menu, 'team 0');
    expect(slots(menu)[0]).toEqual(['Human', 'UnnamedPlayer', 'Red']);
  });

  it("opens each game's limits from its ui_ cvars, held in range, and friendly fire where it has it", () => {
    expect(column(serverOptions(0).menu)).toEqual([
      ['Frag limit', '20'],
      ['Time limit', '0'],
      ['Preset', 'none'],
      ['Offhand grapple', 'CorkScrew'],
      ['Spawn armor', '0']
    ]);
    expect(column(serverOptions(1).menu).slice(0, 3)).toEqual([
      ['Frag limit', '0'],
      ['Time limit', '20'],
      ['Friendly fire', 'on']
    ]);
    const ctf = opened({ arenas: [arena('ctf1', 'ctf')] });
    ctf.config.cvars.set('ui_ctf_capturelimit', '500');
    ctf.config.cvars.set('ui_ctf_timelimit', '-4');
    ctf.menu.key(K.RIGHTARROW);
    ctf.menu.key(K.RIGHTARROW);
    ctf.menu.key(K.RIGHTARROW);
    go(ctf.menu, 'NEXT');
    expect(column(ctf.menu).slice(0, 3)).toEqual([
      ['Capture limit', '100'],
      ['Time limit', '0'],
      ['Friendly fire', 'off']
    ]);
    const duel = opened({ arenas: [arena('duel1', 'tourney')] });
    duel.menu.key(K.RIGHTARROW);
    duel.menu.key(K.RIGHTARROW);
    go(duel.menu, 'NEXT');
    expect(column(duel.menu).slice(0, 3)).toEqual([
      ['Frag limit', '0'],
      ['Time limit', '15'],
      ['Preset', 'none']
    ]);
    expect(column(serverOptions(4).menu).slice(0, 3)).toEqual([
      ['Round limit', '5'],
      ['Time limit', '0'],
      ['Preset', 'none']
    ]);
  });

  it("opens the port's rows on the values in force, and writes nothing until FIGHT", () => {
    const { menu, config, command } = opened();
    config.cvars.set('g_gamepreset', 'CPM');
    config.cvars.set('g_allowGrapple', '2');
    config.cvars.set('pcq_spawnArmor', '60');
    go(menu, 'NEXT');
    expect(column(menu).slice(2)).toEqual([
      ['Preset', 'CPM'],
      ['Offhand grapple', 'Quake III'],
      ['Spawn armor', '50']
    ]);
    // Found among the presets without regard to case, so the next is the one after it.
    menu.hover(index(menu, 'Preset'));
    menu.key(K.RIGHTARROW);
    expect(menu.page!.items[index(menu, 'Preset')].value).toBe('MINE');
    menu.hover(index(menu, 'Offhand grapple'));
    menu.key(K.RIGHTARROW);
    menu.hover(index(menu, 'Frag limit'));
    menu.key(K.BACKSPACE);
    menu.char('5');
    expect(config.cvars.string('g_allowGrapple')).toBe('2');
    expect(config.cvars.string('ui_ffa_fraglimit')).toBe('20');
    go(menu, 'BACK');
    expect(command).not.toHaveBeenCalled();
    go(menu, 'NEXT');
    expect(column(menu).slice(0, 4)).toEqual([
      ['Frag limit', '20'],
      ['Time limit', '0'],
      ['Preset', 'CPM'],
      ['Offhand grapple', 'Quake III']
    ]);
  });

  it('names a preset g_gamepreset names none of after the presets, and looks for them at each build', () => {
    const refreshPresets = vi.fn();
    const { menu, config } = opened({ refreshPresets });
    config.cvars.set('g_gamepreset', 'odd');
    go(menu, 'NEXT');
    expect(refreshPresets).toHaveBeenCalledOnce();
    const preset = menu.page!.items[index(menu, 'Preset')];
    expect(preset.value).toBe('odd');
    menu.hover(index(menu, 'Preset'));
    menu.key(K.RIGHTARROW);
    expect(preset.value).toBe('VQ3');
    menu.key(K.LEFTARROW);
    menu.key(K.LEFTARROW);
    expect(preset.value).toBe('MINE');
  });

  it('says "0 = NO LIMIT" while a limit has the cursor', () => {
    const { menu } = serverOptions(0);
    expect(menu.page!.items[index(menu, 'Frag limit')].status).toBe(NO_LIMIT);
    expect(menu.page!.items[index(menu, 'Time limit')].status).toBe(NO_LIMIT);
    expect(menu.page!.items[index(menu, 'Bot skill')].status).toBeUndefined();
  });

  it("starts a free-for-all at FIGHT: the cvars now, then the map, then each bot at the skill", () => {
    const { menu, config, command } = opened();
    // A skirmish is listed as a LAN game, whatever a CREATE before it chose.
    config.cvars.set('dedicated', '2');
    go(menu, 'NEXT');
    click(menu, 'skill');
    // Slot 4 is made a Bot named "--------", which counts but joins no bot, and slot 9 is opened.
    click(menu, 'type 4');
    click(menu, 'type 9');
    menu.hover(index(menu, 'Time limit'));
    menu.key(K.BACKSPACE);
    menu.char('1');
    menu.char('5');
    go(menu, 'FIGHT');
    const { cvars } = config;
    expect(cvars.string('sv_maxclients')).toBe('9');
    expect(cvars.string('dedicated')).toBe('0');
    expect([cvars.string('ui_ffa_fraglimit'), cvars.string('ui_ffa_timelimit')]).toEqual(['20', '15']);
    expect(['timelimit', 'fraglimit', 'capturelimit', 'g_friendlyfire'].map((name) => cvars.get(name))).toEqual([
      '15',
      '20',
      '0',
      '0'
    ]);
    expect(cvars.get('g_localTeamPref')).toBe('');
    expect(command.mock.calls.map(([argv]) => argv)).toEqual([
      ['set', 'g_allowGrapple', '1'],
      ['set', 'pcq_spawnArmor', '0'],
      ['wait'],
      ['wait'],
      ['map', 'dm1'],
      ['wait', '3'],
      ['addbot', 'Ranger', '3'],
      ['addbot', 'Major', '3'],
      ['addbot', 'Sarge', '3']
    ]);
  });

  it("runs a changed preset's cfg before the grapple and the armor, which have the last word", () => {
    const { menu, command } = opened();
    go(menu, 'NEXT');
    menu.hover(index(menu, 'Preset'));
    menu.key(K.RIGHTARROW);
    menu.hover(index(menu, 'Spawn armor'));
    menu.key(K.RIGHTARROW);
    go(menu, 'FIGHT');
    expect(command.mock.calls.slice(0, 3).map(([argv]) => argv)).toEqual([
      ['exec', 'presets/vq3'],
      ['set', 'g_allowGrapple', '1'],
      ['set', 'pcq_spawnArmor', '25']
    ]);
  });

  it("leaves the preset in force be at FIGHT, found without regard to case", () => {
    const { menu, config, command } = opened();
    config.cvars.set('g_gamepreset', 'CPM');
    go(menu, 'NEXT');
    go(menu, 'FIGHT');
    expect(command.mock.calls.map(([argv]) => argv[0])).not.toContain('exec');
  });

  it('starts a team game with the human on their side from the start, and each bot on its own', () => {
    const { menu, config, command } = serverOptions(1, 0);
    click(menu, 'team 0');
    click(menu, 'type 3');
    // Opened twice, a closed slot is a Bot with no name, which is neither counted nor added.
    click(menu, 'type 4');
    click(menu, 'type 4');
    expect(slots(menu)[4]).toEqual(['Bot', '', 'Blue']);
    menu.hover(index(menu, 'Friendly fire'));
    menu.key(K.ENTER);
    go(menu, 'FIGHT');
    const { cvars } = config;
    expect(cvars.string('sv_maxclients')).toBe('7');
    expect(cvars.get('g_localTeamPref')).toBe('Red');
    expect(cvars.get('g_friendlyfire')).toBe('0');
    expect(cvars.string('ui_team_friendly')).toBe('0');
    expect(command.mock.calls.slice(2).map(([argv]) => argv)).toEqual([
      ['wait'],
      ['wait'],
      ['map', 'team1'],
      ['wait', '3'],
      ['addbot', 'grunt', '2', 'Blue'],
      ['addbot', 'major', '2', 'Blue'],
      ['addbot', 'sarge', '2', 'Red'],
      ['addbot', 'grunt', '2', 'Red'],
      ['addbot', 'major', '2', 'Red'],
      ['addbot', 'visor', '2', 'Red'],
      ['wait', '5'],
      ['team', 'Red']
    ]);
  });

  it("writes a capture limit and Clan Arena's rounds where the game has them, and 0 for the rest", () => {
    const ctf = opened({ arenas: [arena('ctf1', 'ctf')] });
    for (let i = 0; i < 3; i++) ctf.menu.key(K.RIGHTARROW);
    go(ctf.menu, 'NEXT');
    go(ctf.menu, 'FIGHT');
    expect(['fraglimit', 'capturelimit', 'timelimit'].map((name) => ctf.config.cvars.get(name))).toEqual([
      '0',
      '8',
      '30'
    ]);
    expect(ctf.config.cvars.string('ui_ctf_capturelimit')).toBe('8');

    const ca = serverOptions(4);
    ca.menu.hover(index(ca.menu, 'Round limit'));
    ca.menu.key(K.BACKSPACE);
    ca.menu.char('7');
    go(ca.menu, 'FIGHT');
    expect(['fraglimit', 'capturelimit', 'roundlimit'].map((name) => ca.config.cvars.get(name))).toEqual([
      '0',
      '0',
      '7'
    ]);
    expect(ca.config.cvars.string('ui_ca_roundlimit')).toBe('7');
  });

  it('keeps each limit as typed in its ui_ cvar, and takes a negative one as 0 for the match', () => {
    const { menu, config } = opened();
    go(menu, 'NEXT');
    menu.hover(index(menu, 'Frag limit'));
    menu.key(K.BACKSPACE);
    menu.key(K.BACKSPACE);
    menu.char('-');
    menu.char('3');
    go(menu, 'FIGHT');
    expect(config.cvars.string('ui_ffa_fraglimit')).toBe('-3');
    expect(config.cvars.get('fraglimit')).toBe('0');
    go(menu, 'BACK');
    go(menu, 'NEXT');
    expect(menu.page!.items[index(menu, 'Frag limit')].value).toBe('0');
  });

  it('goes round Bot skill, the slots, the rows, BACK and FIGHT, passing the hidden and the human by', () => {
    const { menu } = serverOptions(0);
    const places: string[] = [];
    for (let i = 0; i < 29; i++) {
      menu.key(K.DOWNARROW);
      const item = menu.page!.items[menu.cursor];
      places.push(item.place ?? item.label);
    }
    expect(places).toEqual([
      'type 1',
      'name 1',
      'type 2',
      'name 2',
      'type 3',
      'name 3',
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((n) => `type ${n}`),
      'Frag limit',
      'Time limit',
      'Preset',
      'Offhand grapple',
      'Spawn armor',
      'BACK',
      'FIGHT',
      'skill',
      'type 1',
      'name 1',
      'type 2',
      'name 2',
      'type 3',
      'name 3',
      'type 4'
    ]);
    const team = serverOptions(1);
    team.menu.key(K.DOWNARROW);
    expect(team.menu.page!.items[team.menu.cursor].place).toBe('team 0');
  });

  it("can't FIGHT on a map the port can't draw", () => {
    const { menu, command } = serverOptions(0, 0, { canDraw: (map) => map !== 'dm1' });
    const fight = menu.page!.items[index(menu, 'FIGHT')];
    expect(fight.grayed).toBe(true);
    expect(menu.page!.items[menu.cursor].label).toBe('Bot skill');
    menu.hover(index(menu, 'FIGHT'));
    menu.key(K.MOUSE1);
    expect(command).not.toHaveBeenCalled();

    go(menu, 'BACK');
    choose(menu, 1);
    go(menu, 'NEXT');
    expect(menu.page!.items[index(menu, 'FIGHT')].grayed).toBe(false);
  });

  it('starts a preview map with map alone, as no game takes its settings', () => {
    const { menu, command } = serverOptions(0, 0, { preview: (map) => map === 'dm1' });
    go(menu, 'FIGHT');
    expect(command.mock.calls.map(([argv]) => argv)).toEqual([['map', 'dm1']]);
  });

  it("starts the game by the map's whole name", () => {
    const long = 'a_very_long_map_name';
    const { menu, command } = opened({ arenas: [arena(long, 'ffa')] });
    expect(menu.page!.caption).toBe('A_VERY_LONG_MAP');
    go(menu, 'NEXT');
    expect(menu.page!.picture?.icon).toBe('levelshots/A_VERY_LONG_MAP');
    go(menu, 'FIGHT');
    expect(command.mock.calls.map(([argv]) => argv)).toContainEqual(['map', long]);
  });

  it('goes BACK to Start Server as it was left, and is built afresh at the next NEXT', () => {
    const { menu, startServer } = opened();
    go(menu, 'NEXT PAGE');
    choose(menu, 3);
    go(menu, 'NEXT');
    const options = menu.page;
    click(menu, 'type 4');
    go(menu, 'BACK');
    expect(menu.page).toBe(startServer);
    expect(tiles(menu)).toEqual(['DM5', 'DM6', 'DM7', 'DM8']);
    expect(chosen(menu)).toBe(3);
    expect(menu.page!.items[menu.cursor].label).toBe('NEXT');

    choose(menu, 0);
    go(menu, 'NEXT');
    expect(menu.page).not.toBe(options);
    expect(menu.page!.picture?.lines[0]).toBe('DM5');
    expect(at(menu, 'type 4').value).toBe('Open');
    expect(at(menu, 'type 1').value).toBe('Open');
  });
});

/**
 * Start Server as the server browser's CREATE opens it, over a config of its own, on a game type
 * by its place in the list, with NEXT pressed.
 */
function created(gametype = 0) {
  const config = new GameConfig({ warn: () => {} });
  const menu = new Menu();
  const command = vi.fn();
  const startServer = startServerPage({
    menu,
    config,
    arenas: ARENAS,
    bots: () => BOTS,
    presets: () => ['vq3', 'cpm', 'mine'],
    actions: { command }
  });
  menu.open({ id: 'arenaservers', items: [] }, 'q3ui');
  startServer.open(true);
  for (let i = 0; i < gametype; i++) menu.key(K.RIGHTARROW);
  return { menu, config, command, next: () => go(menu, 'NEXT'), startServer };
}

describe('CREATE', () => {
  it('opens the slots to players, closing the last four in a game without sides', () => {
    const ffa = created();
    ffa.next();
    const open = ['Open', null, null];
    const closed = ['----', null, null];
    expect(slots(ffa.menu)).toEqual([
      ['Human', 'UnnamedPlayer', null],
      ...Array.from({ length: 7 }, () => open),
      ...Array.from({ length: 4 }, () => closed)
    ]);
    // The arena's bots are there all the same, for a slot made a Bot.
    click(ffa.menu, 'type 1');
    expect([at(ffa.menu, 'type 1').value, at(ffa.menu, 'name 1').value]).toEqual(['Bot', 'Ranger']);

    const team = created(1);
    team.next();
    const side = (name: string) => ['Open', null, name];
    const shut = ['----', null, null];
    expect(slots(team.menu)).toEqual([
      ['Human', 'UnnamedPlayer', 'Blue'],
      side('Blue'),
      side('Blue'),
      side('Blue'),
      shut,
      shut,
      side('Red'),
      side('Red'),
      side('Red'),
      side('Red'),
      shut,
      shut
    ]);
    expect(seedSlots(BOTS, undefined, GT.TOURNAMENT, 'x', true)).toEqual(
      seedSlots(BOTS, undefined, GT.FFA, 'x', true)
    );
  });

  it("says where the server is listed and names it, where q3_ui has Dedicated and Hostname", () => {
    const { menu, config, next } = created();
    config.cvars.set('sv_hostname', 'Rats Nest');
    next();
    expect(column(menu)).toEqual([
      ['Frag limit', '20'],
      ['Time limit', '0'],
      ['Listed', 'LAN'],
      ['Hostname', 'Rats Nest'],
      ['Preset', 'none'],
      ['Offhand grapple', 'CorkScrew'],
      ['Spawn armor', '0']
    ]);
    expect(menu.page!.items[index(menu, 'Listed')].values).toEqual(['LAN', 'Internet']);
    // Nothing is written until FIGHT.
    menu.hover(index(menu, 'Listed'));
    menu.key(K.RIGHTARROW);
    expect(config.cvars.get('dedicated')).toBe('0');
  });

  it("keeps q3_ui's room of 18 for a long name, and keeps 64 of it", () => {
    const { menu, config, next } = created();
    config.cvars.set('sv_hostname', 'The Longest Yard, Home of the Rail');
    next();
    const hostname = () => menu.page!.items[index(menu, 'Hostname')];
    // The whole name, its cursor at the end, for the menu to scroll within its room.
    const name = 'The Longest Yard, Home of the Rail';
    expect([hostname().value, hostname().caret]).toEqual([name, name.length]);
    expect(hostname().widthInChars).toBe(18);
    for (let i = 0; i < 40; i++) hostname().char!('x');
    menu.hover(index(menu, 'FIGHT'));
    menu.key(K.MOUSE1);
    expect(config.cvars.get('sv_hostname')).toHaveLength(64);
  });

  it('writes the listing and the name at FIGHT, and keeps the team line: the host plays', () => {
    const { menu, config, command, next } = created(1);
    next();
    menu.hover(index(menu, 'Listed'));
    menu.key(K.RIGHTARROW);
    const hostname = menu.page!.items[index(menu, 'Hostname')];
    hostname.key!(K.END);
    for (const ch of ' 2') hostname.char!(ch);
    go(menu, 'FIGHT');
    expect(config.cvars.get('dedicated')).toBe('2');
    expect(config.cvars.get('sv_hostname')).toBe('noname 2');
    expect(config.cvars.get('g_localTeamPref')).toBe('Blue');
    expect(command.mock.calls.map(([argv]) => argv).slice(-2)).toEqual([
      ['wait', '5'],
      ['team', 'Blue']
    ]);
  });

  it('opens SINGLE PLAYER as a skirmish again after it', () => {
    const { menu, startServer } = created();
    startServer.open();
    go(menu, 'NEXT');
    expect(slots(menu)[1]).toEqual(['Bot', 'Ranger', null]);
    expect(column(menu).map(([label]) => label)).not.toContain('Listed');
  });
});

describe('Bot Select', () => {
  /** Bot Select, opened from slot `n`'s name, on the first map of a game type. */
  function botSelect(n: number, gametype = 0, context: Partial<StartServerContext> = {}) {
    const opening = serverOptions(gametype, 0, context);
    click(opening.menu, `name ${n}`);
    return opening;
  }
  const names = (menu: Menu) =>
    menu.page!.items.filter((item) => item.cell).map((item) => (item.hidden ? null : item.label));
  const picked = (menu: Menu) => menu.page!.items.filter((item) => item.cell).findIndex((item) => item.selected);
  const cell = (menu: Menu, label: string) => menu.page!.items[index(menu, label)];
  const RED = [1, 0, 0];

  it("opens from a Bot slot's name on that bot's page, every bot sorted by name, cut and cleaned", () => {
    const { menu } = botSelect(2);
    expect(menu.page!.id).toBe('botselect');
    expect(menu.page!.title).toBe('SELECT BOT');
    expect(menu.depth).toBe(4);
    expect(names(menu)).toEqual(SORTED.slice(0, 16));
    expect(picked(menu)).toBe(SORTED.indexOf('Major'));
    menu.key(K.ESCAPE);
    click(menu, 'name 3');
    expect(names(menu)).toEqual([...SORTED.slice(16), ...new Array<null>(12).fill(null)]);
    expect(picked(menu)).toBe(SORTED.indexOf('Sarge') - 16);
  });

  it('opens on the first bot for a name it has no bot for', () => {
    const { menu } = serverOptions(0);
    click(menu, 'type 4');
    click(menu, 'name 4');
    expect(names(menu)).toEqual(SORTED.slice(0, 16));
    expect(picked(menu)).toBe(0);
  });

  it("draws each bot's portrait, falling back to its model's default skin where its own is missing", () => {
    const missing = (icon: string) => icon === 'models/players/major/icon_daemia';
    const { menu } = botSelect(2, 0, { missing });
    expect(cell(menu, 'Anarki').icon).toBe('models/players/anarki/icon_default');
    expect(cell(menu, 'Biker').icon).toBe('models/players/biker/icon_hossman');
    expect(cell(menu, 'Daemia').icon).toBe('models/players/major/icon_default');
  });

  it('names in red a bot a Bot slot has, the edited one too, on its side in a team game', () => {
    const ffa = botSelect(2);
    expect(cell(ffa.menu, 'Major').color).toEqual(RED);
    expect(cell(ffa.menu, 'Anarki').color).toBeUndefined();
    go(ffa.menu, 'NEXT PAGE');
    expect(['Phobos', 'Ranger', 'Sarge'].map((name) => cell(ffa.menu, name).color ?? null)).toEqual([
      null,
      RED,
      RED
    ]);

    // Blue has grunt, major and visor; Red has sarge.
    const team = botSelect(1, 1);
    expect(['grunt', 'Major', 'VisorTheWat'].map((name) => cell(team.menu, name).color ?? null)).toEqual([
      RED,
      RED,
      null
    ]);
    go(team.menu, 'NEXT PAGE');
    expect(cell(team.menu, 'Sarge').color).toBeUndefined();
  });

  it('puts the chosen bot in the slot at ACCEPT, and leaves the slot as it was at BACK', () => {
    const { menu } = botSelect(2);
    go(menu, 'Crash');
    expect(picked(menu)).toBe(SORTED.indexOf('Crash'));
    go(menu, 'BACK');
    expect(menu.page!.id).toBe('serveroptions');
    expect(at(menu, 'name 2').value).toBe('Major');

    click(menu, 'name 2');
    menu.hover(index(menu, 'Crash'));
    menu.key(K.ENTER);
    go(menu, 'ACCEPT');
    expect(menu.page!.id).toBe('serveroptions');
    expect(at(menu, 'name 2').value).toBe('Crash');

    // The name as the grid shows it, cut and cleaned.
    click(menu, 'name 1');
    go(menu, 'PREVIOUS PAGE');
    go(menu, 'ACCEPT');
    expect(at(menu, 'name 1').value).toBe('VisorTheWat');
  });

  it('turns the page with arrows that choose its first bot, and are greyed at the ends', () => {
    const { menu } = botSelect(2);
    const arrows = () =>
      ['PREVIOUS PAGE', 'NEXT PAGE'].map((label) => menu.page!.items[index(menu, label)].grayed ?? false);
    expect(arrows()).toEqual([true, false]);
    go(menu, 'NEXT PAGE');
    expect(names(menu)[0]).toBe('Phobos');
    expect(picked(menu)).toBe(0);
    expect(arrows()).toEqual([false, true]);
    go(menu, 'PREVIOUS PAGE');
    expect(names(menu)[0]).toBe('VisorTheWat');
    expect(picked(menu)).toBe(0);

    go(menu, 'Crash');
    go(menu, 'NEXT PAGE');
    go(menu, 'ACCEPT');
    expect(at(menu, 'name 2').value).toBe('Phobos');

    const few = botSelect(1, 0, { bots: () => BOTS.slice(0, 3) });
    const turns = few.menu.page!.items.filter((item) => item.role === 'previous' || item.role === 'next');
    expect(turns.map((item) => item.grayed)).toEqual([true, true]);
  });

  it('goes round the portraits, the arrows, BACK and ACCEPT, and leaves left and right alone', () => {
    const { menu } = botSelect(2);
    expect(menu.cursor).toBe(0);
    const labels: string[] = [];
    for (let i = 0; i < 19; i++) {
      menu.key(K.DOWNARROW);
      labels.push(menu.page!.items[menu.cursor].label);
    }
    expect(labels).toEqual([...SORTED.slice(1, 16), 'NEXT PAGE', 'BACK', 'ACCEPT', SORTED[0]]);
    expect(menu.key(K.RIGHTARROW)).toBe(false);
    expect(menu.key(K.LEFTARROW)).toBe(false);
  });
});
