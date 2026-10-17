import { describe, expect, it, vi } from 'vitest';

import { K } from '../formats/q3-keys';
import { GT } from '../sim/constants';
import { GameConfig, type GameConfigOptions } from '../settings/game-config';
import type { ClientInfo } from './client-info';
import { Menu, type MenuItem, type MenuSound } from './menu';
import {
  errorPage,
  inGamePage,
  mainPage,
  setupPage,
  type MenuActions,
  type MenuContext
} from './menu-pages';
import { startServerPage } from './menu-start-server';

/** The main menu, the in-game menu and Setup's pages, used as a player would. */

const KEY_Y = 'y'.charCodeAt(0);

function actions(): MenuActions {
  return {
    resume: vi.fn(),
    restart: vi.fn(),
    vidRestart: vi.fn(),
    exportConfig: vi.fn(),
    importConfig: vi.fn(),
    exit: vi.fn(),
    addBot: vi.fn(),
    removeBot: vi.fn(),
    setTeam: vi.fn(),
    command: vi.fn(),
    addFavorite: vi.fn()
  };
}

/** The presets on offer: the shipped five, then the home folder's. */
const PRESETS = ['vq3', 'pmc', 'cpm', 'cq3', 'dev', 'mine'];

/** The models and skins the paks offer. */
const MODELS = [
  { model: 'sarge', skin: 'default' },
  { model: 'xaero', skin: 'blue' }
];

/**
 * The in-game menu, open over a config of its own.
 *
 * @param playing - `cgs.gametype`: what the match is playing, which the pages read rather than
 *   the latched cvar. A free-for-all unless a test says otherwise, and settable while it runs.
 * @param running - `sv_running`: whether the client is its own server's, which the host's items
 *   are greyed without.
 * @param launchVsync - The shell's launch's vertical sync; none for a browser.
 */
function opened(
  options: GameConfigOptions = {},
  playing: number = GT.FFA,
  running = true,
  launchVsync?: boolean
) {
  const config = new GameConfig({ warn: () => {}, ...options });
  const menu = new Menu();
  const done = actions();
  const match: { gametype: number } = { gametype: playing };
  const context: MenuContext = {
    menu,
    config,
    actions: done,
    models: () => MODELS,
    bots: () => [],
    presets: () => PRESETS,
    clientInfo: () => null,
    gametype: () => match.gametype,
    maxClients: () => 8,
    serverinfo: () => '\\mapname\\garage_rats\\sv_hostname\\Arena',
    serverRunning: () => running,
    launchVsync
  };
  menu.open(inGamePage(context, setupPage(context)));
  return { menu, config, actions: done, match };
}

const labels = (menu: Menu) => menu.page!.items.map((item) => item.label);

/** The in-game menu's items under `DEBUG_MODE`. */
const IN_GAME = [
  'RESUME GAME',
  'START',
  'ADD BOTS',
  'REMOVE BOTS',
  'SETUP',
  'SERVER INFO',
  'SERVER OPTIONS',
  'DEBUG',
  'RESTART ARENA',
  'LEAVE ARENA',
  'EXIT GAME'
];

/** The item on the page with this label. */
function item(menu: Menu, label: string): MenuItem {
  const found = menu.page!.items.find((each) => each.label === label);
  expect(found, label).toBeDefined();
  return found!;
}

/** Point at an item by its label, and press a key; a click by default. */
function press(menu: Menu, label: string, key: number = K.MOUSE1): void {
  const index = labels(menu).indexOf(label);
  expect(index, label).toBeGreaterThanOrEqual(0);
  menu.hover(index, { x: 0.5 });
  menu.key(key);
}

/** Go through pages by their items' labels. */
function go(menu: Menu, ...path: string[]): void {
  for (const label of path) press(menu, label);
}

describe('the in-game menu', () => {
  it('offers Resume game first, with the cursor on it, then the rest in q3_ui\'s order, with no title', () => {
    const { menu } = opened();
    expect(menu.page!.title).toBeUndefined();
    expect(labels(menu)).toEqual(IN_GAME);
    expect(menu.cursor).toBe(0);
    expect(labels(opened({ debugMode: false }).menu)).toEqual(IN_GAME.filter((label) => label !== 'DEBUG'));
  });

  it('exits once confirmed, and not when declined', () => {
    const { menu, actions: done } = opened();
    go(menu, 'EXIT GAME');
    expect(menu.page!.title).toBe('EXIT GAME?');
    menu.key(K.ENTER);
    expect(done.exit).not.toHaveBeenCalled();
    expect(labels(menu)).toEqual(IN_GAME);

    go(menu, 'EXIT GAME');
    menu.key(KEY_Y);
    expect(done.exit).toHaveBeenCalledOnce();
  });

  it('resumes out of the menu', () => {
    const { menu, actions: done } = opened();
    vi.mocked(done.resume).mockImplementation(() => expect(menu.isOpen).toBe(false));
    go(menu, 'RESUME GAME');
    expect(done.resume).toHaveBeenCalledOnce();
  });

  it("leaves the arena at once, by the console's disconnect, with no question", () => {
    const { menu, actions: done } = opened();
    go(menu, 'LEAVE ARENA');
    expect(done.command).toHaveBeenCalledExactlyOnceWith(['disconnect']);
    expect(labels(menu)).toEqual(IN_GAME);
  });

  it('restarts once confirmed, out of the menu, and not when declined', () => {
    const { menu, actions: done } = opened();
    go(menu, 'RESTART ARENA');
    expect(menu.page!.title).toBe('RESTART ARENA?');
    menu.key(K.ENTER);
    expect(done.restart).not.toHaveBeenCalled();
    expect(labels(menu)).toContain('RESUME GAME');

    go(menu, 'RESTART ARENA');
    vi.mocked(done.restart).mockImplementation(() => expect(menu.isOpen).toBe(false));
    menu.key(KEY_Y);
    expect(done.restart).toHaveBeenCalledOnce();
  });

  it('gives Add bots the sides the match is being played on', () => {
    const { menu, match } = opened({}, GT.FFA);
    go(menu, 'ADD BOTS');
    expect(item(menu, 'Team').value).toBe('Free');
    expect(item(menu, 'Team').grayed).toBe(true);

    match.gametype = GT.TEAM;
    expect(item(menu, 'Team').value).toBe('Red');
    expect(item(menu, 'Team').grayed).toBe(false);
  });

  it("greys the host's items without a local server, and shows them with one", () => {
    const remote = opened({}, GT.FFA, false);
    for (const label of ['ADD BOTS', 'REMOVE BOTS', 'SERVER OPTIONS', 'RESTART ARENA']) {
      expect(item(remote.menu, label).grayed, label).toBe(true);
    }
    // Server info is the client's own, read-only, and stays open either way.
    expect(item(remote.menu, 'SERVER INFO').grayed).toBeFalsy();

    const host = opened();
    for (const label of ['ADD BOTS', 'REMOVE BOTS', 'SERVER OPTIONS', 'RESTART ARENA']) {
      expect(item(host.menu, label).grayed, label).toBeFalsy();
    }
  });

  it('greys START while no match is played, as over a map\'s preview', () => {
    const config = new GameConfig({ warn: () => {} });
    const menu = new Menu();
    let playing = false;
    const context: MenuContext = {
      menu,
      config,
      actions: actions(),
      models: () => MODELS,
      bots: () => [],
      presets: () => PRESETS,
      clientInfo: () => null,
      gametype: () => GT.FFA,
      maxClients: () => 0,
      serverinfo: () => '',
      serverRunning: () => false,
      matchRunning: () => playing
    };
    menu.open(inGamePage(context, setupPage(context)));
    expect(item(menu, 'START').grayed).toBe(true);
    playing = true;
    expect(item(menu, 'START').grayed).toBe(false);
    // Without the question, a match is taken to be running.
    expect(item(opened().menu, 'START').grayed).toBe(false);
  });

  it("shows the match's serverinfo read-only, in q3_ui's rows", () => {
    const { menu } = opened();
    go(menu, 'SERVER INFO');

    expect(menu.page!.title).toBe('SERVER INFO');
    // A settings page's rows, which draw a value beside each key.
    expect(menu.page!.layout).toBe('form');
    const rows = menu.page!.items.filter((each) => each.value !== undefined);
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['mapname:', 'garage_rats'],
      ['sv_hostname:', 'Arena']
    ]);
    // Every pair is a row the cursor passes by: there is nothing to change.
    expect(rows.every((row) => row.inactive === true)).toBe(true);
    expect(labels(menu).slice(-2)).toEqual(['ADD TO FAVORITES', 'BACK']);
  });

  it("adds the server connected to as a favourite, under its sv_hostname, and goes back", () => {
    const { menu, config, actions: done } = opened({}, GT.FFA, false);
    config.cvars.set('cl_currentServerAddress', 'quake.example.com');
    go(menu, 'SERVER INFO');
    const depth = menu.depth;
    go(menu, 'ADD TO FAVORITES');
    expect(done.addFavorite).toHaveBeenCalledWith('quake.example.com', 'Arena');
    expect(menu.depth).toBe(depth - 1);

    // With no server connected to, it only goes back (`Favorites_Add`).
    config.cvars.set('cl_currentServerAddress', '');
    go(menu, 'SERVER INFO', 'ADD TO FAVORITES');
    expect(done.addFavorite).toHaveBeenCalledOnce();
    expect(menu.depth).toBe(depth - 1);
  });

  it('greys ADD TO FAVORITES on a server this client runs', () => {
    const { menu } = opened();
    go(menu, 'SERVER INFO');
    expect(item(menu, 'ADD TO FAVORITES').grayed).toBe(true);
  });

  it("looks for Remove bots' bots through the match's slots, which a skirmish may make more than the cvar's", () => {
    const config = new GameConfig({ warn: () => {} });
    const menu = new Menu();
    const context: MenuContext = {
      menu,
      config,
      actions: actions(),
      models: () => MODELS,
      bots: () => [],
      presets: () => PRESETS,
      clientInfo: (clientNum) => (clientNum === 10 ? ({ name: '^1Sarge', botSkill: 2 } as ClientInfo) : null),
      gametype: () => GT.FFA,
      maxClients: () => 12,
      serverinfo: () => '\\mapname\\garage_rats\\sv_maxclients\\12',
      serverRunning: () => true
    };
    menu.open(inGamePage(context, setupPage(context)));
    expect(config.cvars.settings.maxClients).toBe(8);
    go(menu, 'REMOVE BOTS');
    expect(labels(menu)[0]).toBe('Sarge');
  });
});

/**
 * The main menu, open where q3_ui puts it, over a config of its own, with the sounds it makes.
 *
 * @param debug - A config to hand the page, with `DEBUG_MODE` on or off; with none, it has none.
 */
function mainMenu(debug?: { debugMode: boolean }) {
  const config = new GameConfig({ warn: () => {}, ...debug });
  const sounds: MenuSound[] = [];
  const closed = vi.fn();
  const menu = new Menu({ sound: (sound) => sounds.push(sound), closed });
  const done = actions();
  const setup = setupPage({ menu, config, actions: done, models: () => MODELS });
  const startServer = startServerPage({
    menu,
    config,
    arenas: [],
    bots: () => [],
    presets: () => [],
    actions: done
  });
  const servers = { open: vi.fn() };
  const page = mainPage(menu, setup, startServer, servers, done, debug ? config : undefined);
  menu.open(page, 'q3ui');
  return { menu, page, actions: done, sounds, closed, servers };
}

describe('the main menu', () => {
  it("offers SINGLE PLAYER, MULTIPLAYER, SETUP and EXIT under its name, the cursor first", () => {
    const { menu } = mainMenu();
    expect(menu.page!.id).toBe('main');
    expect(menu.page!.title).toBe('playcanvas-quake3');
    expect(labels(menu)).toEqual(['SINGLE PLAYER', 'MULTIPLAYER', 'SETUP', 'EXIT']);
    expect(item(menu, 'SINGLE PLAYER').grayed ?? false).toBe(false);
    expect(menu.cursor).toBe(0);
  });

  it('offers DEBUG before EXIT under DEBUG_MODE, opening Debug, as the in-game menu does, and none without it', () => {
    const { menu } = mainMenu({ debugMode: true });
    expect(labels(menu)).toEqual(['SINGLE PLAYER', 'MULTIPLAYER', 'SETUP', 'DEBUG', 'EXIT']);
    go(menu, 'DEBUG');
    expect(menu.page!.title).toBe('DEBUG');
    expect(labels(mainMenu({ debugMode: false }).menu)).toEqual([
      'SINGLE PLAYER',
      'MULTIPLAYER',
      'SETUP',
      'EXIT'
    ]);
  });

  it('opens the server browser at MULTIPLAYER', () => {
    const { menu, servers } = mainMenu();
    go(menu, 'MULTIPLAYER');
    expect(servers.open).toHaveBeenCalledOnce();
  });

  it('opens Start Server at SINGLE PLAYER, and BACK comes back to it', () => {
    const { menu } = mainMenu();
    go(menu, 'SINGLE PLAYER');
    expect(menu.page!.id).toBe('startserver');
    expect(menu.placement).toBe('q3ui');
    go(menu, 'BACK');
    expect(menu.page!.id).toBe('main');
  });

  it('opens the Setup every menu shares, and BACK comes back to it', () => {
    const { menu } = mainMenu();
    go(menu, 'SETUP');
    expect(menu.page!.id).toBe('setup');
    expect(menu.placement).toBe('q3ui');
    go(menu, 'BACK');
    expect(menu.page!.id).toBe('main');
  });

  it('asks before it exits, with the cursor on NO, as the in-game menu asks', () => {
    const { menu, actions: done } = mainMenu();
    go(menu, 'EXIT');
    expect(menu.page!.title).toBe('EXIT GAME?');
    expect(menu.page!.items[menu.cursor].label).toBe('NO');
    menu.key(K.ENTER);
    expect(done.exit).not.toHaveBeenCalled();
    expect(menu.page!.id).toBe('main');

    go(menu, 'EXIT');
    menu.key(KEY_Y);
    expect(done.exit).toHaveBeenCalledOnce();
  });

  it.each([
    ['Escape', K.ESCAPE],
    ['the right button', K.MOUSE2]
  ])('stays up at %s, and comes back as new, with the cursor on its first item', (_, key) => {
    const { menu, page, sounds, closed } = mainMenu();
    menu.hover(2);
    sounds.length = 0;

    expect(menu.key(key)).toBe(true);

    expect(menu.page).toBe(page);
    expect(menu.depth).toBe(1);
    expect(menu.cursor).toBe(0);
    expect(menu.placement).toBe('q3ui');
    // `UI_PopMenu`'s out, then the new menu's in.
    expect(sounds.sort()).toEqual(['in', 'out']);
    expect(closed).not.toHaveBeenCalled();
  });

  it('goes back to itself from Setup at Escape, as from any page over it', () => {
    const { menu } = mainMenu();
    go(menu, 'SETUP');
    menu.key(K.ESCAPE);
    expect(menu.page!.id).toBe('main');
    expect(menu.depth).toBe(1);
  });
});

describe('the error screen', () => {
  it("shows the message under the game's name, with nothing to choose", () => {
    const page = errorPage("Couldn't load maps/backyard.sog", () => {});
    expect(page.id).toBe('error');
    expect(page.title).toBe('playcanvas-quake3');
    expect(page.message).toBe("Couldn't load maps/backyard.sog");
    expect(page.items).toEqual([]);
  });

  it.each([
    ['a key', 'a'.charCodeAt(0)],
    ['Escape', K.ESCAPE],
    ['a click', K.MOUSE1],
    ['the right button', K.MOUSE2]
  ])('goes at %s, quietly, and the main menu comes up in its place', (_, key) => {
    const { menu, page: main, sounds } = mainMenu();
    const dismiss = vi.fn(() => menu.open(main, 'q3ui'));
    menu.open(errorPage('Disconnected', dismiss), 'q3ui');
    sounds.length = 0;

    expect(menu.key(key)).toBe(true);

    expect(dismiss).toHaveBeenCalledOnce();
    expect(menu.page).toBe(main);
    // The main menu's in, and nothing of the error screen's own.
    expect(sounds).toEqual(['in']);
  });
});

describe('the team page', () => {
  it("offers Q3's four rows and a way back, with the sides greyed in a game without them", () => {
    const { menu } = opened();
    go(menu, 'START');

    expect(menu.page!.title).toBe('TEAM');
    expect(labels(menu)).toEqual(['JOIN RED', 'JOIN BLUE', 'JOIN GAME', 'SPECTATE', 'BACK']);
    expect(item(menu, 'JOIN RED').grayed).toBe(true);
    expect(item(menu, 'JOIN BLUE').grayed).toBe(true);
    expect(item(menu, 'JOIN GAME').grayed).toBe(false);
    // Anyone can stop playing, whatever the match is.
    expect(item(menu, 'SPECTATE').grayed).toBe(false);
  });

  it('greys Join game instead in a game of sides, which has nowhere to join', () => {
    const { menu } = opened({}, GT.TEAM);
    go(menu, 'START');

    expect(item(menu, 'JOIN GAME').grayed).toBe(true);
    expect(item(menu, 'JOIN RED').grayed).toBe(false);
    expect(item(menu, 'JOIN BLUE').grayed).toBe(false);
  });

  it('follows the game being played, not the latched cvar the page started with', () => {
    // `g_gametype` latches, so a match restarted into another game leaves the setting reading
    // the old one for ever; the rows have to ask the match itself.
    const { menu, match, config } = opened({}, GT.FFA);
    go(menu, 'START');
    expect(item(menu, 'JOIN RED').grayed).toBe(true);

    config.cvars.set('g_gametype', String(GT.CTF));
    expect(config.cvars.settings.gametype).toBe(GT.FFA);
    expect(item(menu, 'JOIN RED').grayed).toBe(true);

    // The restart the setting was waiting for: now the match is playing it.
    match.gametype = GT.CTF;
    expect(item(menu, 'JOIN RED').grayed).toBe(false);
    expect(item(menu, 'JOIN GAME').grayed).toBe(true);
  });

  it('sends the row\'s word to the match and takes the whole menu away', () => {
    const { menu, actions: done } = opened();
    go(menu, 'START');
    vi.mocked(done.setTeam).mockImplementation(() => expect(menu.isOpen).toBe(true));

    go(menu, 'SPECTATE');

    expect(done.setTeam).toHaveBeenCalledWith('spectator');
    // Not back to the in-game menu it was asked from: the player is watching the game now.
    expect(menu.isOpen).toBe(false);
    expect(done.resume).toHaveBeenCalledOnce();
  });

  it('joins the match with the free team, which is what a game without sides has', () => {
    const { menu, actions: done } = opened();

    go(menu, 'START', 'JOIN GAME');

    expect(done.setTeam).toHaveBeenCalledWith('free');
  });

  it('does nothing from a greyed row, which the cursor passes by', () => {
    const { menu, actions: done } = opened();
    go(menu, 'START', 'JOIN RED');

    expect(done.setTeam).not.toHaveBeenCalled();
    expect(menu.isOpen).toBe(true);
  });

  it('goes back to the in-game menu from BACK', () => {
    const { menu, actions: done } = opened();

    go(menu, 'START', 'BACK');

    expect(labels(menu)).toEqual(IN_GAME);
    expect(done.setTeam).not.toHaveBeenCalled();
  });
});

describe('Setup', () => {
  it("lists Q3's pages, each the player's own, and export and import", () => {
    const { menu } = opened();
    go(menu, 'SETUP');
    expect(menu.page!.title).toBe('SETUP');
    expect(labels(menu)).toEqual([
      'PLAYER',
      'CONTROLS',
      'SYSTEM',
      'GAME OPTIONS',
      'GAME DATA',
      'DEFAULTS',
      'EXPORT CONFIG',
      'IMPORT CONFIG',
      'BACK'
    ]);
  });

  it('opens Controls', () => {
    const { menu } = opened();
    go(menu, 'SETUP', 'CONTROLS');
    expect(menu.page!.title).toBe('CONTROLS');
    expect(item(menu, 'LOOK').tab).toBe('current');
  });

  it('exports and imports the config, and goes back from BACK', () => {
    const { menu, actions: done } = opened();
    go(menu, 'SETUP', 'EXPORT CONFIG', 'IMPORT CONFIG');
    expect(done.exportConfig).toHaveBeenCalledOnce();
    expect(done.importConfig).toHaveBeenCalledOnce();
    go(menu, 'BACK');
    expect(labels(menu)).toEqual(IN_GAME);
  });

  it('sets every option and bind to its default once confirmed, with Q3\'s warning, then restarts', () => {
    const { menu, config, actions: done } = opened();
    config.command(['cg_fov', '110']);
    config.command(['bind', 'x', '+attack']);
    go(menu, 'SETUP', 'DEFAULTS');
    expect(menu.page).toMatchObject({
      title: 'SET TO DEFAULTS?',
      warning: 'WARNING: This will reset *ALL* options to their default values.'
    });
    menu.key(KEY_Y);
    expect(config.cvars.settings.fov).toBe(89.2);
    expect(config.binds.get('x'.charCodeAt(0))).toBeUndefined();
    expect(done.vidRestart).toHaveBeenCalledOnce();
  });
});

describe('Player settings', () => {
  it('shows `model` alone beside the page, as q3_ui draws it, and opens Model at it', () => {
    const { menu, config } = opened();
    config.cvars.set('model', 'xaero/blue');
    config.cvars.set('headmodel', 'sarge');
    go(menu, 'SETUP', 'PLAYER');
    const xaero = { model: 'xaero', skin: 'blue' };
    expect(menu.page!.preview!()).toEqual({ body: xaero, head: xaero });
    press(menu, 'MODEL');
    expect(menu.page!.title).toBe('PLAYER MODEL');
    expect(menu.page!.items.find((each) => each.selected)?.icon).toBe('models/players/xaero/icon_blue');
  });

  it("offers Q3's name, handicap and effects colour, each written as it changes", () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'PLAYER');
    expect(menu.page!.title).toBe('PLAYER SETTINGS');
    expect(labels(menu)).toEqual(['Name', 'Handicap', 'Effects', 'MODEL', 'BACK']);

    const name = item(menu, 'Name');
    expect([name.value, name.caret, name.widthInChars]).toEqual(['UnnamedPlayer', 13, 20]);
    press(menu, 'Name', K.BACKSPACE);
    for (const ch of 'Q3') menu.char(ch);
    expect(config.cvars.settings.name).toBe('UnnamedPlayeQ3');

    expect(item(menu, 'Handicap').value).toBe('None');
    press(menu, 'Handicap', K.RIGHTARROW);
    expect(config.cvars.settings.handicap).toBe(95);
    config.command(['handicap', '37']);
    expect(item(menu, 'Handicap').value).toBe('35');

    const effects = item(menu, 'Effects');
    expect([effects.value, effects.swatch]).toEqual(['red', [1, 0, 0]]);
    press(menu, 'Effects', K.RIGHTARROW);
    expect(config.cvars.settings.color1).toBe(6);
    config.command(['color1', '9']);
    expect(effects.value).toBe('white');
  });

  it('draws the name in its colour codes while the cursor is off it, ^0 as white', () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'PLAYER');
    config.command(['name', '^1Sar^3ge^0!']);
    expect(item(menu, 'Name').colored).toEqual([
      { text: 'Sar', color: [1, 0, 0] },
      { text: 'ge', color: [1, 1, 0] },
      { text: '!', color: [1, 1, 1] }
    ]);
    config.command(['name', 'Sarge']);
    expect(item(menu, 'Name').colored).toEqual([{ text: 'Sarge' }]);
  });
});

describe('persistence', () => {
  it('brings back across a reload what the menu set, from the file it writes', () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'GAME OPTIONS');
    press(menu, 'Draw FPS', K.ENTER);
    go(menu, 'BACK', 'CONTROLS', 'MOVE');
    press(menu, 'walk forward', K.ENTER);
    menu.key('i'.charCodeAt(0));

    const reloaded = new GameConfig({ config: config.text(), warn: () => {} });
    expect(reloaded.cvars.settings.drawFPS).toBe(true);
    expect(reloaded.binds.get('i'.charCodeAt(0))).toBe('+forward');
    expect(reloaded.text()).toBe(config.text());
  });
});

describe("Setup's pages", () => {
  it("gives each of System's pages all three, in its tabs' order, to share one panel", () => {
    const { menu } = opened();
    go(menu, 'SETUP', 'SYSTEM');
    const sections = menu.page!.sections!;
    expect(sections.map((page) => page.id)).toEqual([
      'system.graphics',
      'system.display',
      'system.sound',
      'system.network'
    ]);
    expect(sections[0]).toBe(menu.page);
    go(menu, 'SOUND');
    expect(menu.page).toBe(sections[2]);
    expect(menu.page!.sections).toBe(sections);
  });

  it("opens each of System's pages with the cursor on its own tab, as q3_ui's do", () => {
    const { menu } = opened();
    go(menu, 'SETUP', 'SYSTEM');
    expect(menu.cursor).toBe(0);
    go(menu, 'SOUND');
    expect([menu.page!.id, menu.cursor, item(menu, 'SOUND').tab]).toEqual(['system.sound', 2, 'current']);
    go(menu, 'DISPLAY');
    expect([menu.page!.id, menu.cursor]).toEqual(['system.display', 1]);
    go(menu, 'NETWORK');
    expect([menu.page!.id, menu.cursor]).toEqual(['system.network', 3]);
    go(menu, 'GRAPHICS');
    expect([menu.page!.id, menu.cursor]).toEqual(['system.graphics', 0]);
  });

  it("opens SYSTEM on Graphics, with the cursor on its tab: the backend and the renderer's settings", () => {
    const { menu } = opened();
    go(menu, 'SETUP', 'SYSTEM');
    expect(menu.page!.title).toBe('SYSTEM SETUP');
    expect(labels(menu)).toEqual([
      'GRAPHICS',
      'DISPLAY',
      'SOUND',
      'NETWORK',
      'Backend',
      'Lighting style',
      'Overbright bits',
      'Normal mapping',
      'Specular mapping',
      'APPLY',
      'BACK'
    ]);
    expect(menu.cursor).toBe(0);
    expect(['Backend', 'Lighting style', 'Overbright bits', 'Normal mapping'].map((label) => item(menu, label).value)).toEqual([
      'WebGPU',
      'opengl1',
      '1',
      'on'
    ]);
    expect(item(menu, 'APPLY').hidden).toBe(true);
  });

  it('writes each Graphics row as it changes, and shows APPLY while one waits for vid_restart', () => {
    const { menu, config, actions: done } = opened();
    go(menu, 'SETUP', 'SYSTEM');
    press(menu, 'Lighting style', K.RIGHTARROW);
    const renderer = item(menu, 'Lighting style');
    expect([renderer.value, renderer.status]).toEqual(['opengl2', 'Takes effect at APPLY, which reloads the page']);
    expect(config.cvars.string('cl_renderer')).toBe('opengl2');
    expect(config.cvars.settings.renderer).toBe('opengl1');
    expect(item(menu, 'APPLY').hidden).toBe(false);
    // Set back, nothing waits.
    press(menu, 'Lighting style', K.LEFTARROW);
    expect(item(menu, 'APPLY').hidden).toBe(true);
    // Nor for the match's latched pair, which wait for a map load.
    config.command(['g_gametype', '1']);
    expect(item(menu, 'APPLY').hidden).toBe(true);

    press(menu, 'Backend', K.RIGHTARROW);
    expect(item(menu, 'Backend').value).toBe('WebGL2');
    expect(config.cvars.string('r_glDriver')).toBe('webgl2');
    expect(config.cvars.settings.glDriver).toBe('webgpu');
    press(menu, 'Overbright bits', K.RIGHTARROW);
    expect(config.cvars.string('r_overBrightBits')).toBe('2');
    press(menu, 'Normal mapping', K.ENTER);
    press(menu, 'Specular mapping', K.ENTER);
    expect([config.cvars.string('r_normalMapping'), config.cvars.string('r_specularMapping')]).toEqual(['0', '0']);
    expect(item(menu, 'Specular mapping').value).toBe('off');
    expect(config.cvars.waiting()).toEqual(['glDriver', 'overBrightBits', 'normalMapping', 'specularMapping', 'gametype']);
    go(menu, 'APPLY');
    expect(done.vidRestart).toHaveBeenCalledOnce();
  });

  it("offers the fov on Display and two volumes on Sound, each laid out for Graphics' rows", () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'SYSTEM');
    const depth = menu.depth;
    go(menu, 'DISPLAY');
    expect(menu.depth).toBe(depth);
    const tabs = ['GRAPHICS', 'DISPLAY', 'SOUND', 'NETWORK'];
    expect(labels(menu)).toEqual([...tabs, 'Field of view', 'Vertical sync', 'Max FPS', 'BACK']);
    // Graphics' five rows, APPLY and BACK, so the panel holds still as the tabs switch.
    expect(menu.page!.rows).toBe(7);
    expect(item(menu, 'Field of view').value).toBe('89.2');
    press(menu, 'Field of view', K.RIGHTARROW);
    expect(config.cvars.string('cg_fov')).toBe('90.200000');

    go(menu, 'SOUND');
    expect(menu.depth).toBe(depth);
    // Music Volume under Effects Volume, as q3_ui has them (`ui_sound.c:311–332`).
    expect(labels(menu)).toEqual([...tabs, 'Effects volume', 'Music volume', 'BACK']);
    expect(menu.page!.rows).toBe(7);
    expect(item(menu, 'Effects volume').value).toBe('8');
    press(menu, 'Effects volume', K.LEFTARROW);
    expect(config.cvars.settings.volume).toBeCloseTo(0.7);
    expect(item(menu, 'Effects volume').value).toBe('7');
    expect(item(menu, 'Music volume').value).toBe('2.5');
    press(menu, 'Music volume', K.RIGHTARROW);
    expect(config.cvars.string('s_musicvolume')).toBe('0.350000');
    expect(item(menu, 'Music volume').value).toBe('3.5');
    expect(config.cvars.settings.volume).toBeCloseTo(0.7);
  });

  it('offers vertical sync on Display, and Max FPS, grayed while vertical sync is on', () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'SYSTEM', 'DISPLAY');
    const vsync = () => item(menu, 'Vertical sync');
    const maxFps = () => item(menu, 'Max FPS');
    expect([vsync().value, vsync().status]).toEqual([
      'on',
      "A frame at each of the display's; off, Max FPS paces them"
    ]);
    expect([maxFps().value, maxFps().grayed]).toEqual(['125', true]);
    press(menu, 'Vertical sync', K.ENTER);
    expect(config.cvars.string('r_swapInterval')).toBe('0');
    expect([vsync().value, maxFps().grayed]).toEqual(['off', false]);
    expect(maxFps().status).toBe('The most frames a second while vertical sync is off');
    expect(maxFps().values).toEqual([
      ...['30', '60', '75', '85', '100', '120', '125', '144', '165', '200', '240', '250', '333'],
      ...['360', '500', 'none']
    ]);
    press(menu, 'Max FPS', K.RIGHTARROW);
    expect(config.cvars.string('com_maxfps')).toBe('144');
    press(menu, 'Max FPS', K.LEFTARROW);
    press(menu, 'Max FPS', K.LEFTARROW);
    expect([config.cvars.settings.maxFps, maxFps().value]).toEqual([120, '120']);
  });

  it("shows Max FPS's value where the console set one it doesn't offer, and none for 0", () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'SYSTEM', 'DISPLAY');
    const maxFps = () => item(menu, 'Max FPS');
    config.command(['com_maxfps', '90']);
    expect(maxFps().value).toBe('90');
    expect(maxFps().values!.slice(3, 6)).toEqual(['85', '90', '100']);
    config.command(['r_swapInterval', '0']);
    press(menu, 'Max FPS', K.RIGHTARROW);
    // Stepped off, it is gone from the choices.
    expect([config.cvars.settings.maxFps, maxFps().values!.includes('90')]).toEqual([100, false]);
    config.command(['com_maxfps', '1000']);
    expect(maxFps().values!.slice(-3)).toEqual(['500', '1000', 'none']);
    config.command(['com_maxfps', '0']);
    expect(maxFps().value).toBe('none');
    press(menu, 'Max FPS', K.RIGHTARROW);
    expect(config.cvars.string('com_maxfps')).toBe('30');
  });

  it('in the shell, says a change of vertical sync waits for the next launch, the cap held', () => {
    const pending = 'Takes effect when the game next starts';
    // Launched with vertical sync: turned off, the cap holds at once, and the rest waits.
    const paced = opened({}, GT.FFA, true, true);
    go(paced.menu, 'SETUP', 'SYSTEM', 'DISPLAY');
    expect(item(paced.menu, 'Vertical sync').status).not.toBe(pending);
    press(paced.menu, 'Vertical sync', K.ENTER);
    expect(item(paced.menu, 'Vertical sync').status).toBe(pending);
    expect(item(paced.menu, 'Max FPS').grayed).toBe(false);

    // Launched without: turned on, the cap holds until the next launch.
    const unpaced = opened({ config: 'seta r_swapInterval "0"' }, GT.FFA, true, false);
    go(unpaced.menu, 'SETUP', 'SYSTEM', 'DISPLAY');
    expect(item(unpaced.menu, 'Vertical sync').status).not.toBe(pending);
    press(unpaced.menu, 'Vertical sync', K.ENTER);
    expect(unpaced.config.cvars.settings.swapInterval).toBe(true);
    expect(item(unpaced.menu, 'Vertical sync').status).toBe(pending);
    expect(item(unpaced.menu, 'Max FPS').grayed).toBe(false);
  });

  it("offers q3_ui's Data Rate on Network, laid out for Graphics' rows, reading any rate", () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'SYSTEM', 'NETWORK');
    expect(labels(menu)).toEqual(['GRAPHICS', 'DISPLAY', 'SOUND', 'NETWORK', 'Data rate', 'BACK']);
    expect(menu.page!.rows).toBe(7);
    const rate = () => item(menu, 'Data rate');
    expect(rate().value).toBe('LAN/Cable/xDSL');
    expect(rate().values).toEqual(['<= 28.8K', '33.6K', '56K', 'ISDN', 'LAN/Cable/xDSL']);
    press(menu, 'Data rate', K.LEFTARROW);
    expect([config.cvars.string('rate'), rate().value]).toEqual(['5000', 'ISDN']);
    press(menu, 'Data rate', K.RIGHTARROW);
    expect(config.cvars.string('rate')).toBe('25000');
    // Any rate reads as the first choice it does not pass (`ui_network.c:240–255`).
    for (const [set, shown] of [
      ['1000', '<= 28.8K'],
      ['2501', '33.6K'],
      ['3001', '56K'],
      ['4000', '56K'],
      ['90000', 'LAN/Cable/xDSL']
    ]) {
      config.command(['rate', set]);
      expect(rate().value, set).toBe(shown);
    }
    // Each choice writes q3_ui's own rate, round the list from the last (`ui_network.c:105–121`).
    const written: string[] = [];
    for (let n = 0; n < 5; n++) {
      press(menu, 'Data rate', K.RIGHTARROW);
      written.push(config.cvars.get('rate'));
    }
    expect(written).toEqual(['2500', '3000', '4000', '5000', '25000']);
  });

  it("offers Q3's crosshair, drawn as its picture, and the HUD's own settings", () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'GAME OPTIONS');
    expect(labels(menu)).toEqual([
      'Crosshair',
      'Crosshair size',
      'Marks on walls',
      'Dynamic lights',
      'High quality sky',
      '3D icons',
      'Draw 2D',
      'Draw FPS',
      'Speedometer',
      'BACK'
    ]);
    const crosshair = item(menu, 'Crosshair');
    expect([crosshair.value, crosshair.icon]).toEqual(['e', 'gfx/2d/crosshaire']);
    press(menu, 'Crosshair', K.RIGHTARROW);
    expect(config.cvars.string('cg_drawCrosshair')).toBe('5');
    // Crosshair a is 10, which `Preferences_SetMenuItems` reads as none.
    config.command(['cg_drawCrosshair', '10']);
    expect([crosshair.value, crosshair.icon]).toEqual(['none', undefined]);

    press(menu, 'Draw FPS', K.ENTER);
    expect(config.cvars.string('cg_drawFPS')).toBe('1');
    expect(item(menu, 'Speedometer').value).toBe('off');
    // q3_ui's Marks on Walls, `cg_marks` (`ui_preferences.c:132-134`).
    press(menu, 'Marks on walls', K.ENTER);
    expect(config.cvars.string('cg_marks')).toBe('0');
  });

  it('shows High quality sky on while r_fastsky is off, and writes it the other way round', () => {
    const { menu, config } = opened();
    go(menu, 'SETUP', 'GAME OPTIONS');
    const sky = item(menu, 'High quality sky');
    expect(sky.value).toBe('on');
    press(menu, 'High quality sky', K.ENTER);
    expect([config.cvars.string('r_fastsky'), sky.value]).toEqual(['1', 'off']);
    press(menu, 'High quality sky', K.ENTER);
    expect([config.cvars.string('r_fastsky'), sky.value]).toEqual(['0', 'on']);
    // `Preferences_SetMenuItems` reads any number but 0 as a fast sky.
    config.command(['r_fastsky', '-2']);
    expect(sky.value).toBe('off');
  });

  it("marks High quality sky where the tab's address set r_fastsky", () => {
    const { menu } = opened({ search: '?r_fastsky=1' });
    go(menu, 'SETUP', 'GAME OPTIONS');
    const sky = item(menu, 'High quality sky');
    expect([sky.value, sky.marked, sky.status]).toEqual(['off', true, "Set by this tab's address, and not saved"]);
  });

  it("marks a row the tab's address set, and says it is not saved", () => {
    const { menu } = opened({ search: '?cg_drawFPS=1' });
    go(menu, 'SETUP', 'GAME OPTIONS');
    const fps = item(menu, 'Draw FPS');
    expect([fps.marked, fps.status]).toEqual([true, "Set by this tab's address, and not saved"]);
    expect(item(menu, 'Draw 2D').marked).toBe(false);
  });
});

describe('Server options: the match the next one will be', () => {
  /** Type a string into the field with this label, clearing what is there first. */
  function type(menu: Menu, label: string, text: string): void {
    const index = labels(menu).indexOf(label);
    expect(index, label).toBeGreaterThanOrEqual(0);
    menu.hover(index, { x: 0.5 });
    menu.key(K.END);
    for (let i = 0; i < 4; i++) menu.key(K.BACKSPACE);
    for (const ch of text) menu.char(ch);
  }

  it("offers Quake 3's four games, in the order Quake 3 offers them, and then Clan Arena", () => {
    const { menu, config } = opened();
    go(menu, 'SERVER OPTIONS');

    // `gametype_items` (`ui_startserver.c:91–97`), whose order is not the cvar's.
    const type_ = item(menu, 'Game type');
    expect(type_.value).toBe('Free For All');
    press(menu, 'Game type', K.RIGHTARROW);
    expect(item(menu, 'Game type').value).toBe('Team Deathmatch');
    expect(config.cvars.string('g_gametype')).toBe(String(GT.TEAM));

    press(menu, 'Game type', K.RIGHTARROW);
    expect(config.cvars.string('g_gametype')).toBe(String(GT.TOURNAMENT));
    press(menu, 'Game type', K.RIGHTARROW);
    expect(config.cvars.string('g_gametype')).toBe(String(GT.CTF));
    press(menu, 'Game type', K.RIGHTARROW);
    expect(item(menu, 'Game type').value).toBe('Clan Arena');
    expect(config.cvars.string('g_gametype')).toBe(String(GT.CA));
  });

  it('shows the game type the next match will be, which latching keeps from this one', () => {
    const { menu, config } = opened();
    go(menu, 'SERVER OPTIONS');

    config.cvars.set('g_gametype', String(GT.CTF));
    // The setting in force is still the page's own; the row shows what a restart will take up.
    expect(config.cvars.settings.gametype).toBe(GT.FFA);
    expect(item(menu, 'Game type').value).toBe('Capture the Flag');
    expect(item(menu, 'Game type').status).toBe('Takes effect at APPLY, which restarts the match');
  });

  it('shows APPLY only while the match is playing something else', () => {
    const { menu, config, match } = opened();
    go(menu, 'SERVER OPTIONS');
    expect(item(menu, 'APPLY').hidden).toBe(true);

    config.cvars.set('g_gametype', String(GT.CTF));
    expect(item(menu, 'APPLY').hidden).toBe(false);

    // `map_restart` finds the latched cvar changed and loads the map again, which takes it up.
    match.gametype = GT.CTF;
    expect(item(menu, 'APPLY').hidden).toBe(true);
  });

  it('restarts the match from APPLY, and takes the menu away to show it', () => {
    const { menu, config, actions: done } = opened();
    go(menu, 'SERVER OPTIONS');
    config.cvars.set('g_gametype', String(GT.CTF));

    press(menu, 'APPLY');
    expect(done.restart).toHaveBeenCalled();
    expect(menu.isOpen).toBe(false);
  });

  it('writes the score limit to the limit the game being played goes by', () => {
    const { menu, config, match } = opened();
    go(menu, 'SERVER OPTIONS');

    expect(item(menu, 'Score limit').value).toBe('20');
    expect(item(menu, 'Score limit').status).toBe('Frags to win; 0 for no limit');
    // Three digits in room for three, as Server Options' limits are.
    const limits = [item(menu, 'Score limit'), item(menu, 'Time limit')];
    expect(limits.map((each) => each.widthInChars)).toEqual([3, 3]);
    type(menu, 'Score limit', '15');
    expect(config.cvars.string('fraglimit')).toBe('15');
    expect(config.cvars.string('capturelimit')).toBe('8');

    // Team Deathmatch scores by frags like any other, so the row does not move until CTF:
    // `gametype >= GT_CTF` is the test the HUD draws by and the match ends on.
    match.gametype = GT.TEAM;
    expect(item(menu, 'Score limit').value).toBe('15');
    expect(item(menu, 'Score limit').status).toBe('Frags to win; 0 for no limit');

    // The same row in Capture the Flag is the capture limit, as the HUD's own limit is.
    match.gametype = GT.CTF;
    expect(item(menu, 'Score limit').value).toBe('8');
    expect(item(menu, 'Score limit').status).toBe('Captures to win; 0 for no limit');
    type(menu, 'Score limit', '3');
    expect(config.cvars.string('capturelimit')).toBe('3');
    expect(config.cvars.string('fraglimit')).toBe('15');

    // Clan Arena's comes after CTF's number and is won by rounds.
    match.gametype = GT.CA;
    expect(item(menu, 'Score limit').value).toBe('5');
    expect(item(menu, 'Score limit').status).toBe('Rounds to win; 0 for no limit');
    type(menu, 'Score limit', '7');
    expect(config.cvars.string('roundlimit')).toBe('7');
    expect(config.cvars.string('capturelimit')).toBe('3');
  });

  it('takes the time limit in minutes, and buzzes at a letter', () => {
    const { menu, config } = opened();
    go(menu, 'SERVER OPTIONS');

    expect(item(menu, 'Time limit').value).toBe('0');
    expect(item(menu, 'Time limit').status).toBe('Minutes; 0 for no limit');
    type(menu, 'Time limit', '10');
    expect(config.cvars.string('timelimit')).toBe('10');

    // `QMF_NUMBERSONLY` (`ui_mfield.c:423–424`): a letter buzzes rather than going in, and only
    // a letter — Q3 asks `Q_isalpha`, so a dot reaches the field and the cvar refuses it there.
    expect(item(menu, 'Time limit').char!('x')).toBe('buzz');
    expect(item(menu, 'Time limit').char!('.')).toBe('silent');
    expect(config.cvars.string('timelimit')).toBe('10');
  });

  it('holds a limit to three places, as q3_ui holds its fields', () => {
    const { menu, config } = opened();
    go(menu, 'SERVER OPTIONS');
    type(menu, 'Score limit', '1234');
    expect(config.cvars.string('fraglimit')).toBe('123');
  });
});

describe('Server options: the presets', () => {
  it('offers them after the game type, showing the one g_gamepreset names', () => {
    const { menu, config } = opened();
    config.command(['seta', 'g_gamepreset', 'CPM']);
    go(menu, 'SERVER OPTIONS');

    expect(labels(menu).slice(0, 3)).toEqual(['Game type', 'APPLY', 'Preset']);
    const preset = item(menu, 'Preset');
    expect([preset.value, preset.status]).toEqual(['CPM', "A ruleset's settings, run from its cfg at once"]);
  });

  it('runs the next one, or the one before, at once and round the list', () => {
    const { menu, config, actions: done } = opened();
    config.command(['seta', 'g_gamepreset', 'CPM']);
    go(menu, 'SERVER OPTIONS');

    press(menu, 'Preset', K.RIGHTARROW);
    expect(done.command).toHaveBeenLastCalledWith(['exec', 'presets/cq3']);
    press(menu, 'Preset', K.LEFTARROW);
    expect(done.command).toHaveBeenLastCalledWith(['exec', 'presets/pmc']);

    // The home folder's own come after the shipped five, and match the label without regard to case.
    config.command(['seta', 'g_gamepreset', 'Mine']);
    expect(item(menu, 'Preset').value).toBe('MINE');
    press(menu, 'Preset', K.RIGHTARROW);
    expect(done.command).toHaveBeenLastCalledWith(['exec', 'presets/vq3']);
  });

  it('shows a label that names none of them as it is, or none, and moves from it onto the list', () => {
    const { menu, config, actions: done } = opened();
    go(menu, 'SERVER OPTIONS');
    expect(item(menu, 'Preset').value).toBe('none');

    config.command(['seta', 'g_gamepreset', 'Custom']);
    expect(item(menu, 'Preset').value).toBe('Custom');
    press(menu, 'Preset', K.RIGHTARROW);
    expect(done.command).toHaveBeenLastCalledWith(['exec', 'presets/vq3']);
    press(menu, 'Preset', K.LEFTARROW);
    expect(done.command).toHaveBeenLastCalledWith(['exec', 'presets/mine']);
    expect(done.command).toHaveBeenCalledTimes(2);
  });
});

describe('Server options and Debug, on the in-game menu', () => {
  it("offers CorkScrew's grapple type in its own words, and the spawn armor", () => {
    const { menu, config } = opened();
    go(menu, 'SERVER OPTIONS');
    const grapple = item(menu, 'Offhand grapple');
    expect([grapple.value, grapple.status]).toEqual(['CorkScrew', 'Choose grapple type']);
    press(menu, 'Offhand grapple', K.LEFTARROW);
    expect(config.cvars.settings.allowGrapple).toBe(0);

    config.command(['pcq_spawnArmor', '30']);
    expect(item(menu, 'Spawn armor').value).toBe('25');
    press(menu, 'Spawn armor', K.RIGHTARROW);
    expect(config.cvars.settings.spawnArmor).toBe(50);
  });

  it("offers Debug's switches, with neither the renderer's settings nor an APPLY", () => {
    const { menu } = opened();
    go(menu, 'DEBUG');
    expect(labels(menu)).toEqual([
      'God',
      'Third person',
      'Collision overlay',
      'Hit boxes',
      'Rewind report',
      'Status line',
      'Fly camera',
      'Pause bots',
      'RESET DEBUG OPTIONS',
      'BACK'
    ]);
  });

  it("switches each of Debug's overlays and reports by its own setting alone", () => {
    const { menu, config } = opened();
    go(menu, 'DEBUG');
    const { settings } = config.cvars;
    const overlays = () => [settings.drawCollision, settings.drawBBox, settings.debugDelag];

    press(menu, 'Hit boxes');
    expect(overlays()).toEqual([false, true, false]);
    press(menu, 'Rewind report');
    expect(overlays()).toEqual([false, true, true]);
    press(menu, 'Collision overlay');
    expect(overlays()).toEqual([true, true, true]);
  });

  it('resets the Debug options once confirmed, and nothing else', () => {
    const { menu, config } = opened();
    config.command(['pcq_god', '1']);
    config.command(['cg_fov', '100']);
    config.command(['cl_renderer', 'opengl2']);
    go(menu, 'DEBUG', 'RESET DEBUG OPTIONS');
    expect(menu.page!.title).toBe('RESET DEBUG OPTIONS?');
    menu.key(KEY_Y);
    expect(config.cvars.settings.god).toBe(false);
    expect(config.cvars.settings.fov).toBe(100);
    expect(config.cvars.string('cl_renderer')).toBe('opengl2');
  });
});
