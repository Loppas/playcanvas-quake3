import { gametypeMaps, shownMapName } from '../formats/arena-list';
import { atof, atoi } from '../formats/c-scan';
import { cleanStr } from '../formats/color-codes';
import { infoValueForKey } from '../net/info';
import type { GameConfig } from '../settings/game-config';
import { PRESET_DIR } from '../settings/presets';
import { GT } from '../sim/constants';
import { GRAPPLE_TYPES } from '../sim/weapons/grapple';
import type { Menu, MenuItem, MenuPage } from './menu';
import { DEFAULT_SKILL, SKILLS, stricmp } from './menu-bots';
import type { MenuActions } from './menu-pages';
import { ARMOR_STEPS, GRAPPLE_STATUS, nearest, settingOptions } from './menu-settings';
import { back, radioButton, spinControl, textField } from './menu-widgets';

/** `MAX_MAPSPERPAGE` (`ui_startserver.c:52`). */
export const MAPS_PER_PAGE = 4;

/** `PLAYER_SLOTS` (`ui_startserver.c:622`): Server Options' slots, the human's first. */
export const PLAYER_SLOTS = 12;

/** `MAX_MODELSPERPAGE` (`ui_startserver.c:1538`): Bot Select's portraits, four by four. */
export const PORTRAITS_PER_PAGE = 16;

/** A game on offer: the name the pages give it, and its `g_gametype`. */
export interface GameType {
  readonly name: string;
  readonly value: number;
}

/**
 * `gametype_items` and `gametype_remap` (`ui_startserver.c:91–99`): the games Quake 3 offers, in
 * the order it offers them, which is not the order their numbers run in. CPMA's Clan Arena follows.
 */
export const GAME_TYPES: readonly GameType[] = [
  { name: 'Free For All', value: GT.FFA },
  { name: 'Team Deathmatch', value: GT.TEAM },
  { name: 'Tournament', value: GT.TOURNAMENT },
  { name: 'Capture the Flag', value: GT.CTF },
  { name: 'Clan Arena', value: GT.CA }
];

/** What the map's line reads with no map to choose (`StartServer_Update`). */
export const NO_MAPS = 'NO MAPS FOUND';

/** `playerType_list` (`ui_startserver.c:672–677`): a slot's types, by their numbers. */
export const SLOT_TYPES: readonly string[] = ['Open', 'Bot', '----'];
const OPEN = 0;
const BOT = 1;
const CLOSED = 2;

/** `playerTeam_list` (`ui_startserver.c:679–683`): the sides, by their numbers, as `addbot` takes them. */
export const SLOT_TEAMS: readonly string[] = ['Blue', 'Red'];

/** `playerNameBuffers`' 16, their NUL aside: a name as a slot holds it. */
const NAME_LENGTH = 15;

/** What a slot past the arena's bots is named (`ServerOptions_InitBotNames`). */
export const NO_BOT = '--------';

/** What a limit's field says while the cursor is on it (`ServerOptions_StatusBar`). */
export const NO_LIMIT = '0 = NO LIMIT';

/** What the preset row says here, where the preset runs at FIGHT. */
const PRESET_STATUS = "A ruleset's settings, run from its cfg at FIGHT";

/**
 * Where a multiplayer game is listed, in q3_ui's Dedicated row's place, by the `dedicated` each
 * writes: on this network's list alone, or heartbeating to the Internet's master too. The host
 * plays in either, as a tab's server always has its player.
 */
const LISTINGS: readonly { name: string; dedicated: number }[] = [
  { name: 'LAN', dedicated: 0 },
  { name: 'Internet', dedicated: 2 }
];

/** What the listing's row says. */
const LISTED_STATUS = 'Where the server is listed: on this network, or on the Internet too';

/** The Hostname field's room and its most (`ui_startserver.c:1344–1350`). */
const HOSTNAME_SHOWN = 18;
const HOSTNAME_LENGTH = 64;

/** q3_ui's red, which Bot Select names a bot in that a slot already has (`color_red`). */
const RED: readonly [number, number, number] = [1, 0, 0];

/** One of the bots the bot files name. */
export interface BotInfo {
  readonly name: string;
  /** Its model, with its skin after a slash where it has one. */
  readonly model: string;
}

/** What Start Server and the pages after it are made from. */
export interface StartServerContext {
  menu: Menu;
  config: GameConfig;
  actions: Pick<MenuActions, 'command'>;
  /** Every arena, as info strings, in q3_ui's order (`menuArenas`). */
  arenas: readonly string[];
  /** Every bot, in the order the files were read, which numbers them (`UI_LoadBots`). */
  bots: () => readonly BotInfo[];
  /** The presets on offer, by name: the shipped ones, then the home folder's. */
  presets: () => readonly string[];
  /** Look for the presets again, so one put in the home folder since is offered. */
  refreshPresets?: () => void;
  /**
   * Whether a picture is known to be missing from the paks, as `trap_R_RegisterShaderNoMip` finds
   * it, so a portrait can fall back to the model's default skin's.
   */
  missing?: (icon: string) => boolean;
  /**
   * Whether the port can draw a map, which FIGHT asks of the chosen one. Without it, FIGHT takes
   * any map.
   */
  canDraw?: (map: string) => boolean;
  /**
   * Whether a map loads as a preview, with no game to play its settings: FIGHT starts it with
   * `map` alone.
   */
  preview?: (map: string) => boolean;
}

/** Start Server, and the way into it. */
export interface StartServerMenu {
  page: MenuPage;
  /**
   * Open it as new, as `UI_StartServerMenu` builds it afresh each time: Free For All, its first
   * page, and its first map chosen.
   *
   * @param multiplayer - The server browser's CREATE, where SINGLE PLAYER's is a skirmish: the
   *   slots open for players, and Server Options says where the server is listed and names it.
   */
  open(multiplayer?: boolean): void;
}

/**
 * Start Server: q3_ui's page (`ui_startserver.c:161–603`), where a game on this machine begins.
 * - The game type, which lists the maps made for it, from the first page and the first map.
 * - The maps, four to a page, each a levelshot over its name. A click, or Enter, chooses one.
 * - The arrows turn the page, and do nothing at its ends, where q3_ui never hides them. The chosen
 *   map stays chosen, and shows as chosen on its own page.
 * - The chosen map's name, under the arrows, whichever page is shown.
 * - NEXT writes `g_gametype` and opens Server Options; with no maps, it can't be used.
 *
 * The cursor goes round the game type, the maps, the arrows, BACK and NEXT, as q3_ui's does.
 */
export function startServerPage(context: StartServerContext): StartServerMenu {
  const { menu, config } = context;
  const state = {
    gametype: 0,
    maps: [] as readonly string[],
    page: 0,
    current: 0,
    multiplayer: false
  };
  const at = (tile: number) => state.page * MAPS_PER_PAGE + tile;
  const pages = () => Math.ceil(state.maps.length / MAPS_PER_PAGE);
  // `StartServer_GametypeEvent` (`ui_startserver.c:248–281`).
  const list = (gametype: number) => {
    state.gametype = gametype;
    state.maps = gametypeMaps(context.arenas, GAME_TYPES[gametype].value);
    state.page = 0;
    state.current = 0;
  };

  const tiles: MenuItem[] = Array.from({ length: MAPS_PER_PAGE }, (_, tile) => ({
    cell: true,
    get label() {
      const map = state.maps[at(tile)];
      return map === undefined ? '' : shownMapName(map);
    },
    get icon() {
      const map = state.maps[at(tile)];
      return map && `levelshots/${shownMapName(map)}`;
    },
    // A slot past the last map is dead (`StartServer_Update`, `ui_startserver.c:190–201`).
    get hidden() {
      return at(tile) >= state.maps.length;
    },
    get selected() {
      return at(tile) === state.current;
    },
    // `StartServer_MapEvent` (`ui_startserver.c:233–241`).
    activate: () => {
      if (at(tile) < state.maps.length) state.current = at(tile);
    }
  }));

  // `StartServer_MenuEvent` (`ui_startserver.c:289–318`).
  const previous: MenuItem = {
    label: 'PREVIOUS PAGE',
    role: 'previous',
    activate: () => {
      if (state.page > 0) state.page--;
    }
  };
  const next: MenuItem = {
    label: 'NEXT PAGE',
    role: 'next',
    activate: () => {
      if (state.page < pages() - 1) state.page++;
    }
  };
  const forward: MenuItem = {
    label: 'NEXT',
    role: 'forward',
    get grayed() {
      return state.maps.length === 0;
    },
    activate: () => {
      const gametype = GAME_TYPES[state.gametype];
      config.cvars.setValue('g_gametype', gametype.value);
      menu.push(serverOptionsPage(context, state.maps[state.current], gametype, state.multiplayer));
    }
  };

  const page: MenuPage = {
    id: 'startserver',
    title: 'GAME SERVER',
    layout: 'grid',
    items: [
      spinControl({
        label: 'Game type',
        names: GAME_TYPES.map((type) => type.name),
        get: () => state.gametype,
        set: list
      }),
      ...tiles,
      previous,
      next,
      back(menu),
      forward
    ],
    get caption() {
      const map = state.maps[state.current];
      return map === undefined ? NO_MAPS : shownMapName(map);
    }
  };

  return {
    page,
    open: (multiplayer = false) => {
      state.multiplayer = multiplayer;
      list(0);
      menu.push(page);
    }
  };
}

/** One of Server Options' slots: its type and side by their numbers, and the name it holds. */
export interface Slot {
  type: number;
  name: string;
  team: number;
}

/** `Q_stricmp`: two names alike without regard to case. */
function sameName(a: string, b: string): boolean {
  return stricmp(a, b) === 0;
}

/**
 * The slots as Server Options opens them: `ServerOptions_InitPlayerItems` and
 * `ServerOptions_InitBotNames` (`ui_startserver.c:835–880, 1037–1128`), for a game on this machine.
 * - The first is the human's: an Open slot holding the player's name, cut and cleaned of colours.
 * - The rest start as Bots in a skirmish, and Open in a multiplayer game, where a game without
 *   sides also closes the last four.
 * - A team game puts slots 0–5 on Blue and 6–11 on Red, with grunt, major and visor (in team
 *   deathmatch) on the human's side, and sarge, grunt, major and visor on the other. The rest are
 *   closed.
 * - Any other game gives the slots from the second the bots the arena names, each found by name or
 *   else by the slot's number (ioq3's), then "--------" in the rest. The slots up to the eighth are
 *   then Open, and the rest closed.
 *
 * @param arena - The chosen map's arena, as an info string.
 * @param human - The player's `name`.
 */
export function seedSlots(
  bots: readonly BotInfo[],
  arena: string | undefined,
  gametype: number,
  human: string,
  multiplayer = false
): Slot[] {
  const slots: Slot[] = Array.from({ length: PLAYER_SLOTS }, (_, n) => ({
    type: multiplayer ? OPEN : BOT,
    name: '',
    team: n < PLAYER_SLOTS / 2 ? 0 : 1
  }));
  if (multiplayer && gametype < GT.TEAM) {
    for (let n = 8; n < PLAYER_SLOTS; n++) slots[n].type = CLOSED;
  }
  slots[0] = { type: OPEN, name: cleanStr(human.slice(0, NAME_LENGTH)), team: 0 };

  if (gametype >= GT.TEAM) {
    const deathmatch = gametype === GT.TEAM;
    const side = (first: number, names: readonly string[]) =>
      names.forEach((name, n) => (slots[first + n].name = name));
    side(1, deathmatch ? ['grunt', 'major', 'visor'] : ['grunt', 'major']);
    side(6, deathmatch ? ['sarge', 'grunt', 'major', 'visor'] : ['sarge', 'grunt', 'major']);
    for (const n of deathmatch ? [4, 5, 10, 11] : [3, 4, 5, 9, 10, 11]) slots[n].type = CLOSED;
    return slots;
  }

  let count = 1;
  const named = infoValueForKey(arena ?? '', 'bots').split(' ').filter((word) => word !== '');
  for (const word of named) {
    if (count >= PLAYER_SLOTS) break;
    const bot = bots.find((candidate) => sameName(candidate.name, word)) ?? bots[count];
    slots[count].name = (bot?.name ?? '').slice(0, NAME_LENGTH);
    count++;
  }
  for (let n = count; n < PLAYER_SLOTS; n++) slots[n].name = NO_BOT;
  for (; count < 8; count++) slots[count].type = OPEN;
  for (; count < PLAYER_SLOTS; count++) if (slots[count].type === BOT) slots[count].type = CLOSED;
  return slots;
}

/**
 * The cvars Server Options keeps each game's limits in, and the live ones FIGHT writes: q3_ui's
 * (`ui_startserver.c:757–780, 1141–1164`), and Clan Arena's, which rounds end, after them.
 */
interface GameLimits {
  /** The limit's row, and the cvar the match reads it from. */
  readonly label: string;
  readonly live: 'fraglimit' | 'capturelimit' | 'roundlimit';
  /** What the field is held to as the page opens. */
  readonly max: number;
  readonly limit: string;
  readonly time: string;
  /** Where the game has friendly fire to set. */
  readonly friendly?: string;
}

function gameLimits(gametype: number): GameLimits {
  const frags = { label: 'Frag limit', live: 'fraglimit', max: 999 } as const;
  switch (gametype) {
    case GT.TOURNAMENT:
      return { ...frags, limit: 'ui_tourney_fraglimit', time: 'ui_tourney_timelimit' };
    case GT.TEAM:
      return {
        ...frags,
        limit: 'ui_team_fraglimit',
        time: 'ui_team_timelimit',
        friendly: 'ui_team_friendly'
      };
    case GT.CTF:
      return {
        label: 'Capture limit',
        live: 'capturelimit',
        max: 100,
        limit: 'ui_ctf_capturelimit',
        time: 'ui_ctf_timelimit',
        friendly: 'ui_ctf_friendly'
      };
    case GT.CA:
      return {
        label: 'Round limit',
        live: 'roundlimit',
        max: 999,
        limit: 'ui_ca_roundlimit',
        time: 'ui_ca_timelimit'
      };
    default:
      return { ...frags, limit: 'ui_ffa_fraglimit', time: 'ui_ffa_timelimit' };
  }
}

/**
 * A bot's portrait, by its shader's name, from its `model` (`ServerPlayerIcon`,
 * `ui_startserver.c:1622–1640`).
 */
function portrait(model: string, missing: (icon: string) => boolean): string {
  const slash = model.lastIndexOf('/');
  const [base, skin] = slash < 0 ? [model, 'default'] : [model.slice(0, slash), model.slice(slash + 1)];
  const own = `models/players/${base}/icon_${skin}`;
  return skin.toLowerCase() !== 'default' && missing(own) ? `models/players/${base}/icon_default` : own;
}

/**
 * Server Options: q3_ui's page after Start Server (`ui_startserver.c:1243–1488`), built afresh each
 * time NEXT opens it, as q3_ui builds it, with its slots seeded again. The cursor starts on Bot
 * skill.
 * - **Bot skill**, which every bot is added at, from Bring It On.
 * - **The slots.** The human's first, then eleven, each Open, a Bot or closed. A Bot slot's name
 *   opens Bot Select to change it. In a team game, each slot not closed has a side, the human's
 *   too, which is where the player plays.
 * - **The limits**, as each game keeps them in its `ui_<game>_*` cvars, in fields that say "0 = NO
 *   LIMIT"; friendly fire where the game has it. Pure Server and Punkbuster are left out.
 * - **In a multiplayer game**, in q3_ui's Dedicated and Hostname rows' place: where the server is
 *   listed, from LAN, and its name, from `sv_hostname`.
 * - **The port's rows**: the preset, the grapple and the spawn armor, from the values in force.
 * - The chosen map's levelshot, named with its game type.
 *
 * Nothing is written until FIGHT, so BACK leaves everything as it was. FIGHT can't be used on a map
 * the port can't draw.
 */
function serverOptionsPage(
  context: StartServerContext,
  map: string,
  gametype: GameType,
  multiplayer: boolean
): MenuPage {
  const { menu, config } = context;
  const { cvars } = config;
  context.refreshPresets?.();
  const drawable = context.canDraw?.(map) ?? true;
  const name = shownMapName(map);
  const teamGame = gametype.value >= GT.TEAM;
  const limits = gameLimits(gametype.value);
  const arena = context.arenas.find((info) => sameName(infoValueForKey(info, 'map'), name));
  const slots = seedSlots(context.bots(), arena, gametype.value, cvars.get('name'), multiplayer);
  // `ServerOptions_SetMenuItems` (`ui_startserver.c:1141–1164`): each kept value, held in range.
  const kept = (cvar: string, max: number) => Math.trunc(Math.min(max, Math.max(0, atof(cvars.get(cvar)))));
  /**
   * The preset `g_gamepreset` names, by its name among those on offer, or `null` where it names
   * none.
   */
  const inForce = () => {
    const current = cvars.get('g_gamepreset');
    return context.presets().find((preset) => sameName(preset, current)) ?? null;
  };
  const state = {
    skill: DEFAULT_SKILL,
    limit: String(kept(limits.limit, limits.max)),
    time: String(kept(limits.time, 999)),
    friendly: limits.friendly !== undefined && kept(limits.friendly, 1) === 1,
    preset: inForce(),
    grapple: cvars.settings.allowGrapple,
    armor: nearest(ARMOR_STEPS, cvars.settings.spawnArmor),
    listed: 0,
    hostname: cvars.get('sv_hostname')
  };

  const slotItems = slots.flatMap((slot, n): MenuItem[] => {
    const human = n === 0;
    const type: MenuItem = human
      ? { label: '', value: 'Human', inactive: true, place: `type ${n}` }
      : spinControl({
          label: '',
          place: `type ${n}`,
          names: SLOT_TYPES,
          get: () => slot.type,
          set: (index) => {
            slot.type = index;
          }
        });
    const botName: MenuItem = {
      label: '',
      place: `name ${n}`,
      inactive: human,
      get value() {
        return slot.name;
      },
      // The room of q3_ui's characters, cut to it, so a wide name stops short of the side's column.
      widthInChars: NAME_LENGTH,
      // `ServerOptions_SetPlayerItems` (`ui_startserver.c:888–931`).
      get hidden() {
        return !human && slot.type !== BOT;
      },
      // `ServerOptions_PlayerNameEvent` (`ui_startserver.c:978–987`).
      activate: () => menu.push(botSelectPage(context, slots, n, teamGame))
    };
    if (!teamGame) return [type, botName];
    const team = spinControl({
      label: '',
      place: `team ${n}`,
      names: SLOT_TEAMS,
      get: () => slot.team,
      set: (index) => {
        slot.team = index;
      },
      hidden: () => !human && slot.type === CLOSED
    });
    return [type, botName, team];
  });

  /** A limit's field: digits, three of them, typed in (`ui_startserver.c:1284–1312`). */
  const field = (label: string, key: 'limit' | 'time'): MenuItem =>
    textField({
      label,
      maxchars: 3,
      widthInChars: 3,
      numbersOnly: true,
      status: () => NO_LIMIT,
      get: () => state[key],
      set: (text) => {
        state[key] = text;
      }
    });
  const serverRows: MenuItem[] = [
    spinControl({
      label: 'Listed',
      status: () => LISTED_STATUS,
      names: LISTINGS.map((listing) => listing.name),
      get: () => state.listed,
      set: (index) => {
        state.listed = index;
      }
    }),
    textField({
      label: 'Hostname',
      maxchars: HOSTNAME_LENGTH,
      widthInChars: HOSTNAME_SHOWN,
      get: () => state.hostname,
      set: (text) => {
        state.hostname = text;
      }
    })
  ];
  const presetNames = () => [
    ...context.presets().map((preset) => preset.toUpperCase()),
    ...(inForce() === null ? [cvars.get('g_gamepreset') || 'none'] : [])
  ];

  const fight: MenuItem = {
    label: 'FIGHT',
    role: 'forward',
    grayed: !drawable,
    activate: () =>
      start(context, {
        map,
        gametype: gametype.value,
        multiplayer,
        limits,
        slots,
        state,
        inForce: inForce()
      })
  };

  return {
    id: 'serveroptions',
    title: 'GAME SERVER',
    items: [
      spinControl({
        label: 'Bot skill',
        place: 'skill',
        names: SKILLS,
        get: () => state.skill,
        set: (index) => {
          state.skill = index;
        }
      }),
      ...slotItems,
      field(limits.label, 'limit'),
      field('Time limit', 'time'),
      ...(limits.friendly === undefined
        ? []
        : [
            radioButton({
              label: 'Friendly fire',
              get: () => state.friendly,
              set: (on) => {
                state.friendly = on;
              }
            })
          ]),
      ...(multiplayer ? serverRows : []),
      spinControl({
        label: 'Preset',
        status: () => PRESET_STATUS,
        names: presetNames,
        get: () => {
          const at = context.presets().findIndex((preset) => preset === state.preset);
          return at < 0 ? context.presets().length : at;
        },
        set: (index) => {
          state.preset = context.presets()[index] ?? null;
        }
      }),
      spinControl({
        ...settingOptions(cvars, 'allowGrapple', 'Offhand grapple', GRAPPLE_STATUS),
        names: GRAPPLE_TYPES.map((type) => type.name),
        get: () => state.grapple,
        set: (index) => {
          state.grapple = index;
        }
      }),
      spinControl({
        ...settingOptions(cvars, 'spawnArmor', 'Spawn armor'),
        names: ARMOR_STEPS.map(String),
        get: () => state.armor,
        set: (index) => {
          state.armor = index;
        }
      }),
      back(menu),
      fight
    ],
    picture: { icon: `levelshots/${name}`, lines: [name, gametype.name] }
  };
}

/** What FIGHT starts the game with. */
interface Start {
  map: string;
  gametype: number;
  /** CREATE's game, where SINGLE PLAYER's is a skirmish. */
  multiplayer: boolean;
  limits: GameLimits;
  slots: readonly Slot[];
  state: {
    skill: number;
    limit: string;
    time: string;
    friendly: boolean;
    preset: string | null;
    grapple: number;
    armor: number;
    /** Where a multiplayer game is listed, by its place in {@link LISTINGS}. */
    listed: number;
    hostname: string;
  };
  /** The preset in force, by its name among those on offer. */
  inForce: string | null;
}

/**
 * `ServerOptions_Start` (`ui_startserver.c:725–827`): the cvars now, then the game through the
 * command buffer.
 * - `sv_maxclients`: every slot but a closed one or a Bot with no name, the human's included.
 * - `dedicated`: where a multiplayer game is listed, and 0 for a skirmish.
 * - The game's `ui_*` cvars, then the live limits, each negative taken as 0, and 0 for one the page
 *   has no field for. Clan Arena's rounds are the port's.
 * - A multiplayer game's `sv_hostname`.
 * - The port's rows: the preset's cfg, where another was chosen, then the grapple and the armor,
 *   which follow it through the buffer so that they have the last word.
 * - In a team game, `g_localTeamPref`, which puts the human on their side as they connect
 *   (ioq3's).
 * - `wait ; wait ; map`, `wait 3`, then `addbot` for each Bot slot with a name that doesn't start
 *   with `-`, at the skill, on its side in a team game.
 * - In a team game, `wait 5; team <side>` for the human, id's line, which q3_ui leaves out of a
 *   dedicated server's start: here the host always plays.
 */
function start(context: StartServerContext, game: Start): void {
  const { actions } = context;
  const { cvars } = context.config;
  const { limits, slots, state } = game;
  const teamGame = game.gametype >= GT.TEAM;
  const limit = atoi(state.limit);
  const time = atoi(state.time);
  const friendly = state.friendly ? 1 : 0;
  const maxclients = slots.filter(
    (slot) => slot.type !== CLOSED && !(slot.type === BOT && slot.name === '')
  ).length;

  cvars.setValue(limits.limit, limit);
  cvars.setValue(limits.time, time);
  if (limits.friendly !== undefined) cvars.setValue(limits.friendly, friendly);
  cvars.setValue('sv_maxclients', Math.min(PLAYER_SLOTS, maxclients));
  cvars.setValue('dedicated', game.multiplayer ? LISTINGS[state.listed].dedicated : 0);
  cvars.setValue('timelimit', Math.max(0, time));
  cvars.setValue('fraglimit', limits.live === 'fraglimit' ? Math.max(0, limit) : 0);
  cvars.setValue('capturelimit', limits.live === 'capturelimit' ? Math.max(0, limit) : 0);
  cvars.set('g_friendlyfire', String(limits.friendly === undefined ? 0 : friendly));
  if (limits.live === 'roundlimit') cvars.setValue('roundlimit', Math.max(0, limit));
  if (game.multiplayer) cvars.set('sv_hostname', state.hostname);

  if (context.preview?.(game.map)) {
    actions.command(['map', game.map]);
    return;
  }
  if (state.preset !== null && !sameName(state.preset, game.inForce ?? '')) {
    actions.command(['exec', `${PRESET_DIR}/${state.preset}`]);
  }
  actions.command(['set', 'g_allowGrapple', String(state.grapple)]);
  actions.command(['set', 'pcq_spawnArmor', String(ARMOR_STEPS[state.armor])]);
  const side = SLOT_TEAMS[slots[0].team];
  if (teamGame) cvars.set('g_localTeamPref', side);

  actions.command(['wait']);
  actions.command(['wait']);
  actions.command(['map', game.map]);
  actions.command(['wait', '3']);
  for (const slot of slots.slice(1)) {
    if (slot.type !== BOT || slot.name === '' || slot.name.startsWith('-')) continue;
    const skill = String(state.skill + 1);
    actions.command(['addbot', slot.name, skill, ...(teamGame ? [SLOT_TEAMS[slot.team]] : [])]);
  }
  if (teamGame) {
    actions.command(['wait', '5']);
    actions.command(['team', side]);
  }
}

/**
 * Bot Select: q3_ui's page (`ui_startserver.c:1536–1984`), which a Bot slot's name opens, built
 * afresh each time as q3_ui builds it.
 * - Every bot, sixteen to a page, sorted by name without regard to case: its portrait, and its
 *   name under it, cleaned of colours and cut as a slot holds it. The name is red where another Bot
 *   slot has that bot already, on the edited slot's side in a team game; the bot can be chosen
 *   again all the same.
 * - A click, or Enter, chooses a bot. ACCEPT puts it in the slot, and BACK leaves the slot as it
 *   was.
 * - It opens on the slot's bot, on that bot's page, or on the first.
 * - The arrows turn the page, choosing its first bot, and can't be used at the ends.
 */
function botSelectPage(
  context: StartServerContext,
  slots: Slot[],
  edited: number,
  teamGame: boolean
): MenuPage {
  const { menu } = context;
  const loaded = context.bots();
  // `UI_BotSelectMenu_BuildList`, and `UI_BotSelectMenu_Default`, which finds the slot's bot by its
  // number, then that number's place in the sorted list.
  const sorted = [...loaded].sort((a, b) => stricmp(a.name, b.name));
  const number = loaded.findIndex((bot) => sameName(bot.name, slots[edited].name));
  const selected = number < 0 ? 0 : sorted.indexOf(loaded[number]);
  const state = { selected, page: Math.floor(selected / PORTRAITS_PER_PAGE) };
  const pages = Math.ceil(sorted.length / PORTRAITS_PER_PAGE);
  const at = (cell: number) => state.page * PORTRAITS_PER_PAGE + cell;
  const shown = (bot: BotInfo | undefined) => (bot ? cleanStr(bot.name.slice(0, NAME_LENGTH)) : '');
  // `BotAlreadySelected` (`ui_startserver.c:700–717`).
  const taken = (name: string) =>
    slots.some(
      (slot, n) =>
        n > 0 &&
        slot.type === BOT &&
        (!teamGame || slot.team === slots[edited].team) &&
        sameName(slot.name, name)
    );
  const missing = context.missing ?? (() => false);

  const cells: MenuItem[] = Array.from({ length: PORTRAITS_PER_PAGE }, (_, cell) => ({
    cell: true,
    get label() {
      return shown(sorted[at(cell)]);
    },
    get icon() {
      const bot = sorted[at(cell)];
      return bot && portrait(bot.model, missing);
    },
    get color() {
      const bot = sorted[at(cell)];
      return bot && taken(shown(bot)) ? RED : undefined;
    },
    // A cell past the last bot is dead (`UI_BotSelectMenu_UpdateGrid`, `ui_startserver.c:1669–1674`).
    get hidden() {
      return at(cell) >= sorted.length;
    },
    get selected() {
      return at(cell) === state.selected;
    },
    // `UI_BotSelectMenu_BotEvent` (`ui_startserver.c:1785–1802`).
    activate: () => {
      if (at(cell) < sorted.length) state.selected = at(cell);
    }
  }));

  // `UI_BotSelectMenu_LeftEvent` and `UI_BotSelectMenu_RightEvent` (`ui_startserver.c:1751–1777`).
  const turn = (page: number) => {
    state.page = page;
    state.selected = page * PORTRAITS_PER_PAGE;
  };
  const previous: MenuItem = {
    label: 'PREVIOUS PAGE',
    role: 'previous',
    get grayed() {
      return state.page === 0;
    },
    activate: () => {
      if (state.page > 0) turn(state.page - 1);
    }
  };
  const next: MenuItem = {
    label: 'NEXT PAGE',
    role: 'next',
    get grayed() {
      return state.page >= pages - 1;
    },
    activate: () => {
      if (state.page < pages - 1) turn(state.page + 1);
    }
  };
  // `UI_BotSelectMenu_SelectEvent` (`ui_startserver.c:1823–1831`).
  const accept: MenuItem = {
    label: 'ACCEPT',
    role: 'forward',
    activate: () => {
      menu.pop();
      slots[edited].name = shown(sorted[state.selected]);
    }
  };

  return {
    id: 'botselect',
    title: 'SELECT BOT',
    layout: 'grid',
    items: [...cells, previous, next, back(menu), accept]
  };
}
