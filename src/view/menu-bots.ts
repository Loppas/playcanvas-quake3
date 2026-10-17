import { cleanStr } from '../formats/color-codes';
import type { ClientInfo } from './client-info';
import type { Menu, MenuItem, MenuPage } from './menu';
import { back, spinControl } from './menu-widgets';

/**
 * Add bots and Remove bots: q3_ui's two pages (`ui_addbots.c` and `ui_removebots.c`), which the
 * in-game menu hangs under the team item. They are the port's only way to a second client, since
 * `addbot` and `clientkick` are console commands and the port has no console.
 *
 * Both are a list of seven names with a pick, the pick drawn in the accent colour where Q3 draws
 * it white among orange (`ui_addbots.c:121–123`). Q3 scrolls the list a name at a time on a pair
 * of arrows; the port turns it a page at a time, as its own Model page turns Q3's arrows into
 * pages (`menu-models.ts`), and greys the turn that would go nowhere. A row with no name to show
 * keeps its place, so the panel is the same height whatever page it is on, as Q3's frame is.
 *
 * Engine-free: the names come in, and the commands go out through {@link BotActions}.
 */

/** The names one page holds: the rows Q3 draws (`ui_addbots.c:70`, `ui_removebots.c:67`). */
export const BOTS_PER_PAGE = 7;

/** `skillNames` (`ui_addbots.c:229–236`). */
export const SKILLS: readonly string[] = [
  'I Can Win',
  'Bring It On',
  'Hurt Me Plenty',
  'Hardcore',
  'Nightmare!'
];

/**
 * Where the skill starts: `Com_Clamp( 0, 4, g_spSkill - 1 )` (`ui_addbots.c:332`), for the `2`
 * `g_spSkill` holds until a single-player game moves it. The port has no single player, so it has
 * no `g_spSkill` either, and the page opens here every time, as Q3's does with the cvar untouched.
 */
export const DEFAULT_SKILL = 1;

/** `teamNames1` (`ui_addbots.c:238–241`): the only team a free-for-all has. */
export const FREE_TEAMS: readonly string[] = ['Free'];

/** `teamNames2` (`ui_addbots.c:243–247`): the sides a team game puts a bot on. */
export const TEAMS: readonly string[] = ['Red', 'Blue'];

/** The delay the first bot is asked to wait, and what each one after it adds (`:107, 262`). */
export const FIRST_DELAY = 1000;
export const DELAY_STEP = 1500;

/**
 * What the pages do beyond themselves: the two commands Q3's send through `trap_Cmd_ExecuteText`.
 */
export interface BotActions {
  /**
   * `addbot <name> <skill> <team> <delay>` (`UI_AddBotsMenu_FightEvent`, `ui_addbots.c:104–105`).
   */
  addBot(name: string, skill: number, team: string, delay: number): void;
  /** `clientkick <clientNum>` (`UI_RemoveBotsMenu_DeleteEvent`, `ui_removebots.c:110`). */
  removeBot(clientNum: number): void;
}

/** A page, and the way into it, which fills what it lists. */
export interface BotsPage {
  page: MenuPage;
  open(): void;
}

/** One of the bots in the match, as Remove bots lists them. */
interface BotInGame {
  clientNum: number;
  /** `n`, its colours taken out, as `Q_CleanStr` takes them (`ui_removebots.c:94`). */
  name: string;
}

/** `Q_stricmp`'s order, which sorts the names without regard to case (`ui_addbots.c:196–211`). */
export function stricmp(a: string, b: string): number {
  const one = a.toLowerCase();
  const other = b.toLowerCase();
  return one < other ? -1 : one > other ? 1 : 0;
}

/**
 * The rows of a list, and the two that turn its pages.
 *
 * @param names - What the list holds now, by each name's place in it.
 * @param state - Which page is shown, and which name is picked.
 */
function listRows(
  names: () => readonly string[],
  state: { page: number; selected: number }
): MenuItem[] {
  const at = (row: number) => state.page * BOTS_PER_PAGE + row;
  const pages = () => Math.max(1, Math.ceil(names().length / BOTS_PER_PAGE));
  const rows: MenuItem[] = Array.from({ length: BOTS_PER_PAGE }, (_, row) => ({
    get label() {
      return names()[at(row)] ?? '';
    },
    // A row past the last name is neither drawn nor used, as Q3's is never added to its page.
    get hidden() {
      return at(row) >= names().length;
    },
    get selected() {
      return at(row) === state.selected;
    },
    activate: () => {
      if (at(row) < names().length) state.selected = at(row);
    }
  }));
  return [
    ...rows,
    {
      label: 'PREVIOUS PAGE',
      get grayed() {
        return state.page === 0;
      },
      activate: () => {
        if (state.page > 0) state.page--;
      }
    },
    {
      label: 'NEXT PAGE',
      get grayed() {
        return state.page >= pages() - 1;
      },
      activate: () => {
        if (state.page < pages() - 1) state.page++;
      }
    }
  ];
}

/**
 * Add bots: every bot the bot files name, sorted without regard to case, with the skill and the
 * team the next one joins on.
 *
 * ADD leaves the page up, as Q3's does, so a second press adds a second bot. Each is asked to
 * wait longer than the last, so they do not all arrive in one frame. The menu is a pause, so none
 * of them arrives until the player is back in the game. Q3's button is the accept art
 * (`ART_FIGHT0`, `ui_addbots.c:350`); the port names it ADD.
 *
 * @param bots - Every bot's name, as `UI_GetBotInfoByNumber` reads them off the files.
 * @param teamGame - Whether the match being played has sides, which decides what Team offers.
 */
export function addBotsPage(
  menu: Menu,
  actions: BotActions,
  bots: () => readonly string[],
  teamGame: () => boolean = () => false
): BotsPage {
  const state = {
    page: 0,
    selected: 0,
    skill: DEFAULT_SKILL,
    team: 0,
    delay: FIRST_DELAY,
    names: [] as readonly string[]
  };
  const names = () => state.names;
  const teams = () => (teamGame() ? TEAMS : FREE_TEAMS);
  // A side is picked for the match being played, so a game that ends a team game leaves a pick
  // its list no longer has.
  const team = () => Math.min(state.team, teams().length - 1);
  const page: MenuPage = {
    title: 'ADD BOTS',
    // A settings page's rows, since Skill and Team show a value, which only those rows draw. A
    // name, having none, is centred in its row as every other row without one is.
    layout: 'form',
    items: [
      ...listRows(names, state),
      spinControl({
        label: 'Skill',
        names: SKILLS,
        get: () => state.skill,
        set: (index) => {
          state.skill = index;
        }
      }),
      spinControl({
        label: 'Team',
        names: teams,
        get: team,
        set: (index) => {
          state.team = index;
        },
        // Greyed outside a team game, where the only side to be on is the one everyone is on
        // (`ui_addbots.c:341–347`).
        grayed: () => !teamGame()
      }),
      {
        label: 'ADD',
        get grayed() {
          return names().length === 0;
        },
        activate: () => {
          const name = names()[state.selected];
          if (name === undefined) return;
          actions.addBot(name, state.skill + 1, teams()[team()], state.delay);
          state.delay += DELAY_STEP;
        }
      },
      back(menu)
    ]
  };
  return {
    page,
    open: () => {
      // The files are read once at boot, and named here in the order the page shows them.
      state.names = [...bots()].sort(stricmp);
      state.page = 0;
      state.selected = 0;
      state.delay = FIRST_DELAY;
      menu.push(page);
    }
  };
}

/**
 * Remove bots: everyone in the match whose `CS_PLAYERS` string carries a `skill`, which is how
 * Q3's UI knows a bot from a player (`UI_RemoveBotsMenu_GetBots`, `ui_removebots.c:182–203`).
 *
 * The list is read afresh every frame rather than once at the open, so a bot goes from it as it is
 * kicked; Q3's stays as it was until the page is opened again.
 *
 * @param clientInfo - `CS_PLAYERS + n`, as the client has it.
 * @param maxClients - `sv_maxclients`: the slots to look through.
 */
export function removeBotsPage(
  menu: Menu,
  actions: BotActions,
  clientInfo: (clientNum: number) => ClientInfo | null,
  maxClients: () => number
): BotsPage {
  const state = { page: 0, selected: 0 };
  const inGame = (): BotInGame[] => {
    const found: BotInGame[] = [];
    for (let clientNum = 0; clientNum < maxClients(); clientNum++) {
      const info = clientInfo(clientNum);
      if (!info || info.botSkill === 0) continue;
      found.push({ clientNum, name: cleanStr(info.name) });
    }
    return found;
  };
  const names = () => inGame().map((bot) => bot.name);
  const page: MenuPage = {
    title: 'REMOVE BOTS',
    layout: 'form',
    items: [
      ...listRows(names, state),
      {
        label: 'DELETE',
        get grayed() {
          return inGame().length === 0;
        },
        activate: () => {
          const bot = inGame()[state.selected];
          if (!bot) return;
          actions.removeBot(bot.clientNum);
          // The list is about to lose it, so the pick goes back to the first rather than to
          // whoever moves up into its place.
          state.page = 0;
          state.selected = 0;
        }
      },
      back(menu)
    ]
  };
  return {
    page,
    open: () => {
      state.page = 0;
      state.selected = 0;
      menu.push(page);
    }
  };
}
