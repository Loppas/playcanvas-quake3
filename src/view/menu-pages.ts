import { GAME_NAME } from '../config';
import type { PlayerModelSkin } from '../formats/asset-manifest';
import type { GameDataContext } from '../pak/game-data';
import type { Backend } from '../render/backend';
import { COLOR_TABLE, colorRuns } from '../formats/color-codes';
import { K } from '../formats/q3-keys';
import { vsyncInForce, vsyncWaits } from '../frame-pacer';
import { infoPairs, infoValueForKey } from '../net/info';
import type { GameConfig } from '../settings/game-config';
import { PRESET_DIR } from '../settings/presets';
import { SETTINGS, SETTING_KEYS } from '../settings/registry';
import { GT } from '../sim/constants';
import { GRAPPLE_TYPES } from '../sim/weapons/grapple';
import type { ClientInfo } from './client-info';
import type { ColoredText, Menu, MenuItem, MenuPage } from './menu';
import { addBotsPage, removeBotsPage, type BotActions } from './menu-bots';
import { controlsPage } from './menu-controls';
import { gameDataMenu, PENDING } from './menu-game-data';
import { modelPage } from './menu-models';
import type { ServersMenu } from './menu-servers';
import {
  ARMOR_STEPS,
  FROM_ADDRESS,
  GRAPPLE_STATUS,
  nearest,
  pending,
  settingChoice,
  settingNumberField,
  settingOptions,
  settingSlider,
  settingSwitch
} from './menu-settings';
import { GAME_TYPES, type StartServerMenu } from './menu-start-server';
import { back, radioButton, slider, spinControl, tab, textField } from './menu-widgets';
import type { Renderer } from './overbright';
import { colorFromString } from './player-color';
import { playerLook } from './player-model';

/**
 * The menu's pages: Q3's main menu, in-game menu and Setup tree, trimmed to what
 * the port has. Every setting is written as it changes. A row the tab's address set is
 * marked, and says so under the page. Engine-free; `view/menu.ts` runs them.
 */

/** What the menu does beyond the menu. */
export interface MenuActions extends BotActions {
  /** RESUME GAME: back to play. The click asks for the mouse back in its own handler. */
  resume(): void;
  /** RESTART ARENA, once confirmed: `map_restart 0`. */
  restart(): void;
  /** `vid_restart`: the settings saved, and the page reloaded to take up the latched ones. */
  vidRestart(): void;
  /** Hand the player `q3config.cfg` to keep. */
  exportConfig(): void;
  /** Ask the player for a config, and run it. */
  importConfig(): void;
  /** EXIT GAME, once confirmed: the shell quits, and a browser closes the tab where it may. */
  exit(): void;
  /**
   * A row of the team page: `cmd team <what>`, which is a client command to the match
   * (`TeamMain_MenuEvent`, `ui_team.c:54–79`).
   *
   * @param team - Quake 3's own word: `free`, `spectator`, `red` or `blue`.
   */
  setTeam(team: string): void;
  /** `trap_Cmd_ExecuteText`: a console command, run where a bind's would run. */
  command(argv: readonly string[]): void;
  /**
   * A server added to the favourites under a name, with a word printed on how it went, as Team
   * Arena's `addFavorite` does (`ui_main.c:3416–3440`).
   */
  addFavorite(address: string, name: string): void;
}

/**
 * What Setup's pages are made from: the player's own settings and nothing of a match, so one set
 * of them serves any menu that offers Setup.
 */
export interface SetupContext {
  menu: Menu;
  config: GameConfig;
  actions: Pick<MenuActions, 'vidRestart' | 'exportConfig' | 'importConfig'>;
  /** The models and skins the paks offer; none until the assets have come. */
  models: () => readonly PlayerModelSkin[];
  /** Where the game data came from, for GAME DATA; none until the assets have come. */
  gameData?: () => GameDataContext | undefined;
  /**
   * The shell's: the vertical sync its launch started Chromium with, which a change waits for the
   * next launch to take up. None in a browser.
   */
  launchVsync?: boolean;
}

/** What the in-game pages are made from: Setup's, and the match being played. */
export interface MenuContext extends SetupContext {
  actions: MenuActions;
  /** Every bot the bot files name, for Add bots; none where the install has no bots. */
  bots: () => readonly string[];
  /** The presets on offer, by name: the shipped ones, then the home folder's. */
  presets: () => readonly string[];
  /** `CS_PLAYERS + n` as the client has it, for Remove bots to find the bots among them. */
  clientInfo: (clientNum: number) => ClientInfo | null;
  /**
   * `cgs.gametype`: the game the match is *playing*, out of `CS_SERVERINFO`.
   *
   * Not `settings.gametype`, which is latched and so holds whatever the page started with — a
   * match restarted into another game would leave that reading the old one for ever.
   */
  gametype: () => number;
  /**
   * The match's `sv_maxclients`, out of `CS_SERVERINFO`, for Remove bots to look through: the
   * latched setting holds what the page started with, and a skirmish's FIGHT moves the cvar on.
   */
  maxClients: () => number;
  /**
   * `CS_SERVERINFO` as the client has it, for Server info to show read-only, as q3_ui does a
   * client of a remote server.
   */
  serverinfo: () => string;
  /**
   * `sv_running`: whether this client is its own server's, which a remote one's is not.
   * The page's own server where the host runs here, its channel's where the host is a worker's
   * — the store is no longer where a server says so.
   */
  serverRunning: () => boolean;
  /**
   * Whether a match is being played, for START to join; a map's preview plays none. Without it,
   * there always is.
   */
  matchRunning?: () => boolean;
}

/** What a latched row says. */
const AT_APPLY = 'Takes effect at APPLY, which reloads the page';

/** What the game type row says, whose APPLY loads the map again rather than the page. */
const AT_RESTART = 'Takes effect at APPLY, which restarts the match';

/** What the preset row says. */
const PRESET_STATUS = "A ruleset's settings, run from its cfg at once";

/** `cg_fov`, which no q3_ui page offers: on a range the port chose about its default. */
const FOV_RANGE = { min: 60, max: 130 };
/** What the Vertical sync row says, but where a change of it waits for the shell's next launch. */
const VSYNC_STATUS = "A frame at each of the display's; off, Max FPS paces them";
/** What the Max FPS row says. */
const MAX_FPS_STATUS = 'The most frames a second while vertical sync is off';
/**
 * `com_maxfps`'s choices, which no q3_ui page offers either: displays' rates and Quake 3's own,
 * then 0, no cap. A value the console set stands among them while it is set.
 */
const MAX_FPS_CHOICES: readonly number[] = [
  30, 60, 75, 85, 100, 120, 125, 144, 165, 200, 240, 250, 333, 360, 500, 0
];
/** `cg_crosshairSize`, which no q3_ui page offers either, about its default of 24. */
const CROSSHAIR_SIZE_RANGE = { min: 8, max: 64 };
/**
 * `Effects Volume` and `Music Volume`, 0 to 10, for `s_volume` and `s_musicvolume` 0 to 1
 * (`ui_sound.c:140-143, 312–332`).
 */
const VOLUME_STEPS = 10;
/** The crosshairs as `Preferences_SetMenuItems` offers them: `cg_drawCrosshair` modulo 10, none then b to j (`ui_preferences.c:93`). */
const CROSSHAIRS = ['none', ...'bcdefghij'];
/** `cg_speedometer`'s modes. */
const SPEEDOMETER_MODES = ['off', 'graph', 'number and graph', 'number'];
/** `r_glDriver`'s backends, and their names on the Backend row. */
const BACKENDS: readonly Backend[] = ['webgpu', 'webgl2'];
const BACKEND_NAMES = ['WebGPU', 'WebGL2'];
const RENDERERS: readonly Renderer[] = ['opengl1', 'opengl2'];
const OVERBRIGHT_BITS = ['0', '1', '2'];

/** `MAX_NAMELENGTH` (`ui_playersettings.c:46`), the name's most and its room (`:391–392`). */
const MAX_NAME_LENGTH = 20;
/** The handicap's choices: none, then 95 down to 5 (`handicap_items`, `ui_playersettings.c:77–99`). */
const HANDICAPS = ['None', ...Array.from({ length: 19 }, (_, i) => String(95 - 5 * i))];
/**
 * The effects colours in the spin control's order, by the `color1` each writes (`uitogamecode`,
 * `ui_playersettings.c:75`). They are named for the colours `CG_ColorFromString` makes of them;
 * Q3's art files call 3 teal and 5, which is red and blue, cyan.
 */
const EFFECTS: readonly { color1: number; name: string }[] = [
  { color1: 4, name: 'red' },
  { color1: 6, name: 'yellow' },
  { color1: 2, name: 'green' },
  { color1: 3, name: 'cyan' },
  { color1: 1, name: 'blue' },
  { color1: 5, name: 'magenta' },
  { color1: 7, name: 'white' }
];

/** The Debug section's settings. */
const DEBUG_KEYS = SETTING_KEYS.filter((key) => SETTINGS[key].section === 'debug');

/** An item that opens a page over this one. */
function opens(menu: Menu, label: string, page: MenuPage): MenuItem {
  return { label, activate: () => menu.push(page) };
}

/**
 * The in-game menu: the items of `UI_InGameMenu` the port has (`ui_ingame.c:158–321`), with
 * Resume game first, where the cursor starts:
 * - Resume game;
 * - Start, which is Q3's word for the team page and where Q3 puts it (`ui_ingame.c:181–189`):
 *   the only way in and out of a match, since the port has no console to type `team` at;
 * - Add bots and Remove bots, which Q3 hangs under it (`ui_ingame.c:192–217`);
 * - Setup, which holds the player's own settings;
 * - Server options, in Server info's place, and Debug under `DEBUG_MODE`: the game's settings,
 *   beside Setup rather than in it;
 * - Restart arena, which asks first;
 * - Leave arena, which doesn't: `disconnect`, which leaves the match for the main menu
 *   (`ID_LEAVEARENA`, `ui_ingame.c`);
 * - Exit game, which asks first ({@link exitItem}).
 *
 * @param setup - Setup's first page, {@link setupPage}'s, which any other menu may share.
 */
export function inGamePage(context: MenuContext, setup: MenuPage): MenuPage {
  const { menu, actions } = context;
  /** `sv_running`: whether this client is its own server's, which a remote one's is 0. */
  const running = context.serverRunning;
  const addBots = addBotsPage(menu, actions, context.bots, () => context.gametype() >= GT.TEAM);
  const removeBots = removeBotsPage(menu, actions, context.clientInfo, context.maxClients);
  return {
    items: [
      {
        label: 'RESUME GAME',
        activate: () => {
          menu.pop();
          actions.resume();
        }
      },
      {
        ...opens(menu, 'START', teamPage(context)),
        get grayed() {
          return !(context.matchRunning?.() ?? true);
        }
      },
      // q3_ui greys the bot rows and the restart without a local server (`ui_ingame.c:201–217,
      // 273–275`); the port has no `bot_enable` or single-player gametype to add to that.
      {
        label: 'ADD BOTS',
        get grayed() {
          return !running();
        },
        activate: addBots.open
      },
      {
        label: 'REMOVE BOTS',
        get grayed() {
          return !running();
        },
        activate: removeBots.open
      },
      opens(menu, 'SETUP', setup),
      // q3_ui reads `CS_SERVERINFO` as the page opens (`ui_serverinfo.c:249`); the page is built at
      // the click here for the same reason, since the in-game menu itself is built once.
      { label: 'SERVER INFO', activate: () => menu.push(serverInfoPage(context)) },
      {
        ...opens(menu, 'SERVER OPTIONS', serverOptionsPage(context)),
        get grayed() {
          return !running();
        }
      },
      ...debugItems(context),
      {
        label: 'RESTART ARENA',
        get grayed() {
          return !running();
        },
        // `InGame_RestartAction`: out of the menu, then `map_restart 0` (`ui_ingame.c:75–82`).
        activate: () =>
          menu.confirm('RESTART ARENA?', () => {
            menu.pop();
            actions.restart();
          })
      },
      { label: 'LEAVE ARENA', activate: () => actions.command(['disconnect']) },
      exitItem(menu, actions, 'EXIT GAME')
    ]
  };
}

/** How many of `CS_SERVERINFO`'s pairs Server info shows, which q3_ui caps at 16. */
const SERVER_INFO_LINES = 16;

/**
 * Server info: the match's own string, read-only, as q3_ui shows it (`ui_serverinfo.c:126–151,
 * 249–262`). Every pair is a row the cursor passes by. Built as it opens, so the rows are the
 * string the gamestate and every `cs` left.
 *
 * ADD TO FAVORITES adds the server as `connect` was given it, under its `sv_hostname`, and goes
 * back (`Favorites_Add`, `ui_serverinfo.c:62–112`). It is greyed on a server this client runs.
 */
function serverInfoPage(context: MenuContext): MenuPage {
  const { menu, config, actions } = context;
  const info = context.serverinfo();
  const pairs = infoPairs(info).slice(0, SERVER_INFO_LINES);
  return {
    title: 'SERVER INFO',
    layout: 'form',
    items: [
      ...pairs.map(([key, value]) => ({ label: `${key}:`, value, inactive: true })),
      {
        label: 'ADD TO FAVORITES',
        grayed: context.serverRunning(),
        activate: () => {
          const address = config.cvars.get('cl_currentServerAddress');
          if (address !== '') actions.addFavorite(address, infoValueForKey(info, 'sv_hostname'));
          menu.pop();
        }
      },
      back(menu)
    ]
  };
}

/**
 * EXIT, which asks "EXIT GAME?", then stops (`MainMenu_ExitAction`, `InGame_QuitAction`). Q3 shows
 * its credits, then quits; the port goes straight out, with the game still paused under the menu
 * until it has gone.
 *
 * @param label - What it reads: q3_ui's EXIT on the main menu, and EXIT GAME in game.
 */
export function exitItem(menu: Menu, actions: Pick<MenuActions, 'exit'>, label: string): MenuItem {
  return { label, activate: () => menu.confirm('EXIT GAME?', () => actions.exit()) };
}

/**
 * The main menu: q3_ui's `UI_MainMenu` (`ui_menu.c`), with the items the port has. SINGLE PLAYER
 * opens Start Server, as q3_ui's SKIRMISH does; MULTIPLAYER, second as q3_ui has it, the server
 * browser; SETUP opens the Setup every menu shares; DEBUG, as the in-game menu's; EXIT asks, then
 * stops. The banner strip across the top reads the game's name.
 *
 * Escape and the right button would pop the only page, and the client would raise the menu again
 * at its next frame (`UI_PopMenu`, then `UI_SetActiveMenu( UIMENU_MAIN )`). The page does both at
 * once: the menu stays up, and comes back as new, the cursor on its first item.
 *
 * @param setup - Setup's first page, {@link setupPage}'s.
 * @param startServer - Start Server, which SINGLE PLAYER opens as new.
 * @param servers - ARENA SERVERS, which MULTIPLAYER opens.
 * @param config - The game's, whose `DEBUG_MODE` shows DEBUG; with none, there is no DEBUG.
 */
export function mainPage(
  menu: Menu,
  setup: MenuPage,
  startServer: Pick<StartServerMenu, 'open'>,
  servers: Pick<ServersMenu, 'open'>,
  actions: Pick<MenuActions, 'exit'>,
  config?: GameConfig
): MenuPage {
  const page: MenuPage = {
    id: 'main',
    title: GAME_NAME,
    items: [
      { label: 'SINGLE PLAYER', activate: () => startServer.open() },
      { label: 'MULTIPLAYER', activate: () => servers.open() },
      opens(menu, 'SETUP', setup),
      ...(config ? debugItems({ menu, config }) : []),
      exitItem(menu, actions, 'EXIT')
    ],
    key: (key) => {
      if (key !== K.ESCAPE && key !== K.MOUSE2) return key;
      menu.open(page, menu.placement);
      return 'out';
    }
  };
  return page;
}

/**
 * The main menu's error screen: what a dropped match leads to (`Com_Error`'s `ERR_DROP`), with the
 * error under the banner and no items (`UI_MainMenu`, `ui_menu.c`). Any key or click puts the main
 * menu up in its place (`ErrorMessage_Key`).
 *
 * @param dismiss - Forget the error and open the main menu.
 */
export function errorPage(message: string, dismiss: () => void): MenuPage {
  return {
    id: 'error',
    title: GAME_NAME,
    message,
    items: [],
    key: () => {
      dismiss();
      return 'silent';
    }
  };
}

/**
 * The team page: `ui_team.c`, which is how a player joins a match or leaves it to watch.
 *
 * Every row is there whatever the gametype, and the ones the match has no use for are greyed
 * rather than taken away (`TeamMain_MenuInit`, `ui_team.c:154–171`): a game without sides
 * greys the two sides, and a game of sides greys Join game, which would leave a player nowhere.
 * Spectate is never greyed, because anyone can stop playing.
 *
 * Each row sends its word to the match as a client command and takes the whole menu away, so the
 * player is looking at what they asked for rather than at the page they asked from.
 */
function teamPage(context: MenuContext): MenuPage {
  const { menu, actions } = context;
  // The page is built once and read every frame, so the greying asks the match afresh: a restart
  // into another game changes which rows are of any use.
  const sides = () => context.gametype() >= GT.TEAM;
  const row = (label: string, team: string, grayed: () => boolean): MenuItem => ({
    label,
    get grayed() {
      return grayed();
    },
    activate: () => {
      actions.setTeam(team);
      menu.forceOff();
      actions.resume();
    }
  });
  return {
    title: 'TEAM',
    items: [
      row('JOIN RED', 'red', () => !sides()),
      row('JOIN BLUE', 'blue', () => !sides()),
      row('JOIN GAME', 'free', sides),
      row('SPECTATE', 'spectator', () => false),
      back(menu)
    ]
  };
}

/**
 * Setup: Q3's pages (`ui_setup.c:289–302`), each of them the player's own, so the pages are built
 * once and any menu can open them. GAME DATA stands in CD Key's place, greyed until the game data
 * has come. Defaults stays while the game is paused, where Q3 hides it (`ui_setup.c:299–301`).
 * Export and import keep and bring back `q3config.cfg`. BACK goes back, as Q3's corner button does.
 */
export function setupPage(context: SetupContext): MenuPage {
  const { menu, config, actions } = context;
  const system = systemPages(context);
  const found = () => context.gameData?.();
  const gameData = gameDataMenu(menu, found);
  const page: MenuPage = {
    id: 'setup',
    title: 'SETUP',
    items: [
      opens(menu, 'PLAYER', playerPage(context)),
      opens(menu, 'CONTROLS', controlsPage(menu, config)),
      opens(menu, 'SYSTEM', system.graphics),
      opens(menu, 'GAME OPTIONS', gameOptionsPage(context)),
      {
        label: 'GAME DATA',
        get grayed() {
          return found() === undefined;
        },
        activate: () => gameData.open(page)
      },
      {
        label: 'DEFAULTS',
        // `Setup_ResetDefaults_Action`: `exec default.cfg`, `cvar_restart` and `vid_restart`,
        // after Q3's warning (`ui_setup.c:78–96`).
        activate: () =>
          menu.confirm(
            'SET TO DEFAULTS?',
            () => {
              config.restoreDefaults();
              actions.vidRestart();
            },
            'WARNING: This will reset *ALL* options to their default values.'
          )
      },
      { label: 'EXPORT CONFIG', activate: () => actions.exportConfig() },
      { label: 'IMPORT CONFIG', activate: () => actions.importConfig() },
      back(menu)
    ]
  };
  return page;
}

/**
 * A name in its colours, as the Player page draws it while the cursor is off it: its codes taken
 * out, and `^0` drawn white rather than black (`PlayerSettings_DrawName`,
 * `ui_playersettings.c:132–151`).
 */
function nameColors(name: string): ColoredText[] {
  return colorRuns(name).map(({ text, color }) =>
    color === undefined ? { text } : { text, color: COLOR_TABLE[color === 0 ? 7 : color] }
  );
}

/**
 * Player settings: Q3's page (`ui_playersettings.c`), each item written as it changes,
 * where Q3 writes them on leaving the page (`PlayerSettings_SaveChanges`).
 * - The name, drawn in its colour codes' colours while the cursor is off it.
 * - The handicap, none or 95 down to 5, which sets the max health.
 * - The effects colour, `color1`, drawn as its colour.
 * - MODEL, the page of models.
 *
 * The player's model stands beside it, animated.
 */
function playerPage(context: SetupContext): MenuPage {
  const { menu, config } = context;
  const { cvars } = config;
  const models = modelPage(menu, config, context.models);
  return {
    id: 'player',
    title: 'PLAYER SETTINGS',
    layout: 'form',
    // q3_ui draws `model` alone, its head from the body's folder (`UI_RegisterClientModelname`,
    // `ui_players.c:1111–1175`), where the game wears `headmodel`.
    preview: () => playerLook(cvars.settings.model, cvars.settings.model),
    items: [
      textField({
        ...settingOptions(cvars, 'name', 'Name'),
        maxchars: MAX_NAME_LENGTH,
        widthInChars: MAX_NAME_LENGTH,
        get: () => cvars.settings.name,
        set: (text) => cvars.set('name', text),
        colored: nameColors
      }),
      spinControl({
        ...settingOptions(cvars, 'handicap', 'Handicap'),
        names: HANDICAPS,
        // The handicap held to 5–100, a choice every 5 (`ui_playersettings.c:315–316`).
        get: () => 20 - Math.trunc(Math.min(100, Math.max(5, cvars.settings.handicap)) / 5),
        set: (index) => cvars.setValue('handicap', 100 - 5 * index)
      }),
      spinControl({
        ...settingOptions(cvars, 'color1', 'Effects'),
        names: EFFECTS.map((effect) => effect.name),
        // `gamecodetoui`, a colour outside 1–7 reading as white (`ui_playersettings.c:298–302`).
        get: () => {
          const at = EFFECTS.findIndex((effect) => effect.color1 === cvars.settings.color1);
          return at < 0 ? EFFECTS.length - 1 : at;
        },
        set: (index) => cvars.setValue('color1', EFFECTS[index].color1),
        swatch: (index) => colorFromString(EFFECTS[index].color1)
      }),
      { label: 'MODEL', role: 'forward', activate: () => models.open() },
      back(menu)
    ]
  };
}

/** System's pages, in its tabs' order. */
const SYSTEM_PAGES = ['graphics', 'display', 'sound', 'network'] as const;
type SystemPage = (typeof SYSTEM_PAGES)[number];

/**
 * Network's Data Rate, by the `rate` each writes (`ui_network.c:105–121`). A rate reads as the
 * first whose own it does not pass, and anything above 5000 as the last (`ui_network.c:240–255`).
 */
const DATA_RATES: readonly { rate: number; name: string }[] = [
  { rate: 2500, name: '<= 28.8K' },
  { rate: 3000, name: '33.6K' },
  { rate: 4000, name: '56K' },
  { rate: 5000, name: 'ISDN' },
  { rate: 25000, name: 'LAN/Cable/xDSL' }
];

/**
 * System: Q3's Graphics, Display, Sound and Network pages, each with a tab for the others, switched
 * as Q3 switches them, by going back a page and opening the other (`ui_sound.c:108–122`). Each
 * opens with the cursor on its own tab (`Menu_SetCursorToItem`, `ui_video.c:1313`,
 * `ui_display.c:264`, `ui_sound.c:449`, `ui_network.c:280`). SYSTEM opens Graphics
 * (`ui_setup.c:118–119`).
 */
function systemPages(context: SetupContext): Record<SystemPage, MenuPage> {
  const { menu, config } = context;
  const { cvars } = config;
  const tabs = (shown: SystemPage): MenuItem[] =>
    SYSTEM_PAGES.map((name) =>
      tab(name.toUpperCase(), name === shown, () => {
        menu.pop();
        menu.push(pages[name]);
      })
    );
  const graphics = [...tabs('graphics'), ...graphicsRows(context)];
  // Display and Sound are laid out for Graphics' rows, so the panel holds still as the tabs switch.
  const rows = graphics.filter((item) => item.tab === undefined).length;
  const sections: MenuPage[] = [];
  const pages: Record<SystemPage, MenuPage> = {
    graphics: {
      id: 'system.graphics',
      title: 'SYSTEM SETUP',
      layout: 'form',
      sections,
      cursor: SYSTEM_PAGES.indexOf('graphics'),
      items: graphics
    },
    display: {
      id: 'system.display',
      title: 'SYSTEM SETUP',
      layout: 'form',
      rows,
      sections,
      cursor: SYSTEM_PAGES.indexOf('display'),
      items: [...tabs('display'), ...displayRows(context), back(menu)]
    },
    sound: {
      id: 'system.sound',
      title: 'SYSTEM SETUP',
      layout: 'form',
      rows,
      sections,
      cursor: SYSTEM_PAGES.indexOf('sound'),
      items: [
        ...tabs('sound'),
        // Each written as it moves, where Q3's are written on leaving the page
        // (`ui_sound.c:139–145`).
        slider({
          ...settingOptions(cvars, 'volume', 'Effects volume'),
          min: 0,
          max: VOLUME_STEPS,
          // Rounded, so 0.7 reads 7 and not 7.000000000000001.
          get: () => Math.round(cvars.settings.volume * VOLUME_STEPS * 1e6) / 1e6,
          set: (value) => cvars.setValue('s_volume', value / VOLUME_STEPS)
        }),
        slider({
          ...settingOptions(cvars, 'musicVolume', 'Music volume'),
          min: 0,
          max: VOLUME_STEPS,
          get: () => Math.round(cvars.settings.musicVolume * VOLUME_STEPS * 1e6) / 1e6,
          set: (value) => cvars.setValue('s_musicvolume', value / VOLUME_STEPS)
        }),
        back(menu)
      ]
    },
    network: {
      id: 'system.network',
      title: 'SYSTEM SETUP',
      layout: 'form',
      rows,
      sections,
      cursor: SYSTEM_PAGES.indexOf('network'),
      items: [
        ...tabs('network'),
        spinControl({
          ...settingOptions(cvars, 'rate', 'Data rate'),
          names: DATA_RATES.map((choice) => choice.name),
          get: () => {
            const at = DATA_RATES.findIndex((choice) => cvars.settings.rate <= choice.rate);
            return at < 0 ? DATA_RATES.length - 1 : at;
          },
          set: (index) => cvars.setValue('rate', DATA_RATES[index].rate)
        }),
        back(menu)
      ]
    }
  };
  sections.push(...SYSTEM_PAGES.map((name) => pages[name]));
  return pages;
}

/**
 * Display's rows, under its tabs: the field of view, then the frame's pace, which q3_ui leaves to
 * the console. Max FPS is grayed while vertical sync is in force, which lifts it. In the shell a
 * change of vertical sync waits for the next launch, and its row says so.
 */
function displayRows(context: SetupContext): MenuItem[] {
  const { cvars } = context.config;
  const { launchVsync } = context;
  const { settings } = cvars;
  return [
    settingSlider(cvars, 'fov', 'Field of view', FOV_RANGE),
    settingSwitch(cvars, 'swapInterval', 'Vertical sync', () =>
      vsyncWaits(settings.swapInterval, launchVsync) ? PENDING : VSYNC_STATUS
    ),
    spinControl({
      ...settingOptions(cvars, 'maxFps', 'Max FPS', MAX_FPS_STATUS),
      names: () => maxFpsChoices(settings.maxFps).names,
      get: () => maxFpsChoices(settings.maxFps).values.indexOf(settings.maxFps),
      set: (index) => {
        cvars.setValue(SETTINGS.maxFps.cvar, maxFpsChoices(settings.maxFps).values[index]);
      },
      grayed: () => vsyncInForce(settings.swapInterval, launchVsync)
    })
  ];
}

/** Max FPS's choices about a value, kept for the value they were made for. */
let maxFpsShown: { value: number; values: readonly number[]; names: readonly string[] } | undefined;

/**
 * {@link MAX_FPS_CHOICES}, with `value` among them where it isn't one: in its place, or after no
 * cap for 0 or less.
 */
function maxFpsChoices(value: number): { values: readonly number[]; names: readonly string[] } {
  if (maxFpsShown?.value === value) return maxFpsShown;
  const values = [...MAX_FPS_CHOICES];
  if (!values.includes(value)) {
    const at = values.findIndex((fps) => fps <= 0 || fps > value);
    values.splice(value <= 0 || at < 0 ? values.length : at, 0, value);
  }
  maxFpsShown = { value, values, names: values.map((fps) => (fps === 0 ? 'none' : String(fps))) };
  return maxFpsShown;
}

/**
 * Graphics' rows, under its tabs (`ui_video.c:833–1004`): the backend, in GL Driver's place, then
 * the renderer's settings. Each shows what `vid_restart` will take up, and APPLY runs it, shown
 * only once one of them has changed (`GraphicsOptions_UpdateMenuItems`, `ui_video.c:567–642`). A
 * change is kept as it is made, where q3_ui's BACK drops it.
 */
function graphicsRows(context: SetupContext): MenuItem[] {
  const { menu, config, actions } = context;
  const { cvars } = config;
  return [
    spinControl({
      ...settingOptions(cvars, 'glDriver', 'Backend', AT_APPLY),
      names: BACKEND_NAMES,
      get: () => BACKENDS.indexOf(pending(cvars, 'glDriver')),
      set: (index) => cvars.set('r_glDriver', BACKENDS[index])
    }),
    spinControl({
      ...settingOptions(cvars, 'renderer', 'Lighting style', AT_APPLY),
      names: RENDERERS,
      get: () => RENDERERS.indexOf(pending(cvars, 'renderer')),
      set: (index) => cvars.set('cl_renderer', RENDERERS[index])
    }),
    spinControl({
      ...settingOptions(cvars, 'overBrightBits', 'Overbright bits', AT_APPLY),
      names: OVERBRIGHT_BITS,
      get: () => pending(cvars, 'overBrightBits'),
      set: (index) => cvars.setValue('r_overBrightBits', index)
    }),
    settingSwitch(cvars, 'normalMapping', 'Normal mapping', AT_APPLY),
    settingSwitch(cvars, 'specularMapping', 'Specular mapping', AT_APPLY),
    {
      label: 'APPLY',
      role: 'forward',
      get hidden() {
        // Only this page's own: the match's latched pair wait for a map load, not a reload.
        return !cvars.waiting().some((key) => SETTINGS[key].section === 'graphics');
      },
      activate: () => actions.vidRestart()
    },
    back(menu)
  ];
}

/**
 * Game options: the crosshair, as `Preferences_Event` writes it (`ui_preferences.c:113–115`),
 * then the HUD's settings q3_ui leaves to the console: the crosshair's size, the 3D icons, 2D
 * drawing, the frame rate and Quake Live's speedometer. Marks on walls and Dynamic lights sit after
 * the crosshair's two, as q3_ui has them after its crosshair (`ui_preferences.c:274–299`), and
 * High quality sky after them, as q3_ui has it after Identify Target (`:302–317`).
 */
function gameOptionsPage(context: SetupContext): MenuPage {
  const { menu, config } = context;
  const { cvars } = config;
  return {
    id: 'options',
    title: 'GAME OPTIONS',
    layout: 'form',
    items: [
      spinControl({
        ...settingOptions(cvars, 'drawCrosshair', 'Crosshair'),
        names: CROSSHAIRS,
        // `Preferences_SetMenuItems`, so crosshair a, which is 10, reads as none (`ui_preferences.c:93`).
        get: () => Math.max(0, Math.trunc(cvars.settings.drawCrosshair) % CROSSHAIRS.length),
        set: (index) => cvars.setValue('cg_drawCrosshair', index),
        // `Crosshair_Draw` draws the picture, and nothing for none (`ui_preferences.c:210–213`).
        icon: (index) => (index > 0 ? `gfx/2d/crosshair${CROSSHAIRS[index]}` : undefined)
      }),
      settingSlider(cvars, 'crosshairSize', 'Crosshair size', CROSSHAIR_SIZE_RANGE),
      settingSwitch(cvars, 'marks', 'Marks on walls'),
      settingSwitch(cvars, 'dynamicLight', 'Dynamic lights'),
      // On while `r_fastsky` is off, and writing the other way round (`ui_preferences.c:99, 121–123`).
      radioButton({
        ...settingOptions(cvars, 'fastSky', 'High quality sky'),
        get: () => !cvars.settings.fastSky,
        set: (on) => cvars.setValue('r_fastsky', on ? 0 : 1)
      }),
      settingSwitch(cvars, 'draw3dIcons', '3D icons'),
      settingSwitch(cvars, 'draw2D', 'Draw 2D'),
      settingSwitch(cvars, 'drawFPS', 'Draw FPS'),
      settingChoice(cvars, 'speedometer', 'Speedometer', SPEEDOMETER_MODES),
      back(menu)
    ]
  };
}

/**
 * Server options, where CorkScrew puts its grapple type, in the words of its
 * menu, with the port's spawn armor. The preset row shows the preset `g_gamepreset` names, and
 * runs the one picked.
 */
function serverOptionsPage(context: MenuContext): MenuPage {
  const { menu, config, actions } = context;
  const { cvars } = config;
  /** The game the next match will be: the stored `g_gametype`, which a restart takes up. */
  const wanted = () => pending(cvars, 'gametype');
  /**
   * The preset `g_gamepreset` names, by its place among those on offer; one past their end where
   * it names none of them.
   */
  const preset = () => {
    const named = cvars.get('g_gamepreset').toUpperCase();
    const at = context.presets().findIndex((name) => name.toUpperCase() === named);
    return at < 0 ? context.presets().length : at;
  };
  /**
   * The score limit is one of three cvars, and which one follows the game being *played*: the
   * limits are not latched, so a new one reaches the match at once and the row must say what it
   * is doing now, not what a restart would do. It is the same test the HUD draws the limit by
   * (`cg_draw.c:1086–1090`) and the same one the match ends on (`CheckExitRules`).
   */
  const limit = () => {
    const gametype = context.gametype();
    if (gametype === GT.CA) {
      return { setting: 'roundLimit', cvar: 'roundlimit', status: 'Rounds to win' } as const;
    }
    if (gametype >= GT.CTF) {
      return { setting: 'captureLimit', cvar: 'capturelimit', status: 'Captures to win' } as const;
    }
    return { setting: 'fragLimit', cvar: 'fraglimit', status: 'Frags to win' } as const;
  };
  return {
    title: 'SERVER OPTIONS',
    layout: 'form',
    items: [
      spinControl({
        ...settingOptions(cvars, 'gametype', 'Game type', AT_RESTART),
        names: GAME_TYPES.map((type) => type.name),
        get: () => Math.max(0, GAME_TYPES.findIndex((type) => type.value === wanted())),
        set: (index) => cvars.setValue('g_gametype', GAME_TYPES[index].value)
      }),
      {
        label: 'APPLY',
        // Only while the match is playing something else: `map_restart` finds `g_gametype`
        // changed and loads the map again from the beginning, which takes it up.
        get hidden() {
          return wanted() === context.gametype();
        },
        activate: () => {
          menu.forceOff();
          actions.restart();
        }
      },
      spinControl({
        label: 'Preset',
        status: () => PRESET_STATUS,
        // After the presets, the label itself where it names none of them.
        names: () => [
          ...context.presets().map((name) => name.toUpperCase()),
          ...(preset() < context.presets().length ? [] : [cvars.get('g_gamepreset') || 'none'])
        ],
        get: preset,
        // Run at once, with no restart: the values take effect as they are read.
        set: (index) => {
          const name = context.presets()[index];
          if (name !== undefined) actions.command(['exec', `${PRESET_DIR}/${name}`]);
        }
      }),
      settingNumberField(cvars, {
        label: 'Score limit',
        // The row is built once and read every frame, so these ask afresh.
        marked: () => cvars.fromUrl(limit().setting),
        status: () =>
          cvars.fromUrl(limit().setting) ? FROM_ADDRESS : `${limit().status}; 0 for no limit`,
        cvar: () => limit().cvar
      }),
      settingNumberField(cvars, {
        ...settingOptions(cvars, 'timeLimit', 'Time limit', 'Minutes; 0 for no limit'),
        cvar: () => 'timelimit'
      }),
      settingChoice(
        cvars,
        'allowGrapple',
        'Offhand grapple',
        GRAPPLE_TYPES.map((type) => type.name),
        GRAPPLE_STATUS
      ),
      spinControl({
        ...settingOptions(cvars, 'spawnArmor', 'Spawn armor'),
        names: ARMOR_STEPS.map(String),
        get: () => nearest(ARMOR_STEPS, cvars.settings.spawnArmor),
        set: (index) => cvars.setValue('pcq_spawnArmor', ARMOR_STEPS[index])
      }),
      back(menu)
    ]
  };
}

/** DEBUG, which opens Debug, under `DEBUG_MODE` only: without it the section's switches are locked. */
function debugItems(context: Pick<MenuContext, 'menu' | 'config'>): MenuItem[] {
  return context.config.cvars.debugMode ? [opens(context.menu, 'DEBUG', debugPage(context))] : [];
}

/** Debug, under `DEBUG_MODE`. The section has its own reset, which asks first. */
function debugPage(context: Pick<MenuContext, 'menu' | 'config'>): MenuPage {
  const { menu, config } = context;
  const { cvars } = config;
  return {
    title: 'DEBUG',
    layout: 'form',
    items: [
      settingSwitch(cvars, 'god', 'God'),
      settingSwitch(cvars, 'thirdPerson', 'Third person'),
      settingSwitch(cvars, 'drawCollision', 'Collision overlay'),
      settingSwitch(cvars, 'drawBBox', 'Hit boxes', "Each player's box, where they are drawn"),
      settingSwitch(
        cvars,
        'debugDelag',
        'Rewind report',
        "Prints where the server and the view put each rail's target"
      ),
      settingSwitch(cvars, 'drawStatusLine', 'Status line'),
      settingSwitch(cvars, 'flyCamera', 'Fly camera', 'Flies out of the eyes through the binds, with the game paused'),
      settingSwitch(cvars, 'botPause', 'Pause bots', 'Sends every bot an empty command each frame'),
      {
        label: 'RESET DEBUG OPTIONS',
        activate: () =>
          menu.confirm('RESET DEBUG OPTIONS?', () => {
            for (const key of DEBUG_KEYS) cvars.reset(SETTINGS[key].cvar);
          })
      },
      back(menu)
    ]
  };
}
