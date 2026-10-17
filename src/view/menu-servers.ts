import { atoi } from '../formats/c-scan';
import { cleanStr, COLOR_TABLE } from '../formats/color-codes';
import { K } from '../formats/q3-keys';
import { tokenize } from '../formats/q3config';
import type { ClientStatic, StatusReply } from '../net/client-static';
import { CONFIGSTRING } from '../net/commands';
import { favoriteAddress, type Favorites } from '../net/favorites';
import { infoValueForKey } from '../net/info';
import { compareAdr, NA, netadr, PORT_SERVER, stringToAdr, type NetAdr } from '../net/net';
import { MAX_CLIENTS } from '../net/protocol';
import { AS, MAX_PINGREQUESTS, type ServerLists, type ServerSource } from '../net/server-lists';
import type { GameConfig } from '../settings/game-config';
import { GT } from '../sim/constants';
import { newClientInfo, type ClientInfo } from './client-info';
import type { ColoredText, DetailRow, Menu, MenuItem, MenuPage, PageDetail } from './menu';
import { stricmp } from './menu-bots';
import type { MenuActions } from './menu-pages';
import { GAME_TYPES, type StartServerMenu } from './menu-start-server';
import {
  back,
  LIST_ARROWS,
  radioButton,
  scrollList,
  spinControl,
  textField,
  type ListState
} from './menu-widgets';
import { spectatorBoard, type Scoreboard } from './scoreboard';
import { parseScores, type Scores } from './scores';

/**
 * ARENA SERVERS and SPECIFY SERVER: q3_ui's server browser (`ui_servers2.c`) and the page that
 * names a server by hand (`ui_specifyserver.c`), over the client's lists and pings as q3_ui reads
 * the engine's through `trap_LAN_*`. Engine-free: the lists come in, and the commands go out as
 * q3_ui's `trap_Cmd_ExecuteText` sends them.
 *
 * The browser is q3_ui's: its sources, its filters and sort, its refresh driven from the page's
 * frame, and its status lines. Where the port differs:
 * - The favourites are Team Arena's: kept with names in their own file, added from the list and
 *   from SPECIFY as well as from the in-game SERVER INFO, and each standing in the list from the
 *   start of a refresh as its address and "...", filled in as it answers.
 * - The chosen server stays chosen by its address across a refresh and a re-sort, where q3_ui's
 *   goes back to the top at every update, and the window holds where it is.
 * - A ping that went through the masters reads with a tilde, until the highlighted server's
 *   own ping comes down a channel opened to it.
 * - SERVER INFO opens Team Arena's Server Information box over the page, with the highlighted
 *   server's settings and board from its status. The status is fetched as the server is
 *   highlighted, and again only by the box's REFRESH, so an idle page sends nothing.
 * - Internet is the one master, `sv_master1`, where ioq3 has five more slots. Local asks the LAN
 *   master, as a page can't broadcast.
 */

/** `MAX_GLOBALSERVERS` and `MAX_LOCALSERVERS` (`ui_servers2.c:35–41`): the most a source lists. */
const MAX_LISTED = 128;
/** `MAX_HOSTNAMELENGTH` and `MAX_MAPNAMELENGTH`, their NULs aside, which a row keeps of each. */
const HOSTNAME_KEPT = 21;
const MAPNAME_KEPT = 15;
/** A mod's name as a row keeps it (`servernode_t.gamename`). */
const GAMENAME_KEPT = 11;
/** The list's rows (`ui_servers2.c:1421`). */
export const LIST_HEIGHT = 11;
/**
 * How long a refresh waits for the master before it pings what it has, and how often Local asks
 * again while no server has answered (`ui_servers2.c:850–857, 1009`).
 */
const REFRESH_WAIT_MSEC = 5000;
/** How often the refresh reads its pings (`ui_servers2.c:866`). */
const PING_STEP_MSEC = 10;
/**
 * How long an unanswered status waits to be asked for again (`UI_BuildServerStatus`,
 * `ui_main.c:4205`).
 */
const STATUS_RETRY_MSEC = 500;

/** The line under the page while a refresh runs (`ui_servers2.c:425, 453`). */
export const STOP_STATUS = 'Press SPACE to stop';

/**
 * The sources by q3_ui's numbers (`UIAS_*`), which `ui_browserMaster` keeps: Local, the first
 * Internet slot, and Favorites.
 */
const UIAS = { LOCAL: 0, GLOBAL: 1, FAVORITES: 7 } as const;
type UiSource = (typeof UIAS)[keyof typeof UIAS];

/** The Servers spin's choices (`master_items`), and the list each reads. */
export const SOURCES: readonly { name: string; value: UiSource; lan: ServerSource }[] = [
  { name: 'Local', value: UIAS.LOCAL, lan: AS.LOCAL },
  { name: 'Internet', value: UIAS.GLOBAL, lan: AS.GLOBAL },
  { name: 'Favorites', value: UIAS.FAVORITES, lan: AS.FAVORITES }
];

/** The Game Type spin's choices (`servertype_items`): all, then the games Start Server offers. */
export const GAMES: readonly { name: string; value: number | null }[] = [
  { name: 'All', value: null },
  ...GAME_TYPES
];

/** The Sort By spin's choices (`sortkey_items`), by their numbers. */
export const SORT_KEYS: readonly string[] = [
  'Server Name',
  'Map Name',
  'Open Player Spots',
  'Game Type',
  'Ping Time'
];
const SORT = { HOST: 0, MAP: 1, CLIENTS: 2, GAME: 3, PING: 4 } as const;

/**
 * `gamenames` (`ui_servers2.c:139–154`), a game's short name by its number, the port's clan arena
 * at 8 where q3_ui names another mod's game. Past 11, the last.
 */
const GAME_NAMES: readonly string[] = [
  'DM',
  '1v1',
  'SP',
  'Team DM',
  'CTF',
  'One Flag CTF',
  'OverLoad',
  'Harvester',
  'CA',
  'Q3F',
  'Urban Terror',
  'OSP',
  '???'
];

/** What a row's ping reads while a favourite hasn't answered, as Team Arena's does. */
export const NO_ANSWER = '...';

/** The box's settings, in the rows they stand in. */
export const SETTINGS_LABELS: readonly string[] = [
  'Host',
  'Address',
  'Map',
  'Game',
  'Preset',
  'Limit',
  'Time',
  'Players',
  'Password',
  'Version'
];

/** q3_ui's ping colours (`ui_servers2.c:549–563`). */
const PING_BLUE = COLOR_TABLE[4];
const PING_GREEN = COLOR_TABLE[2];
const PING_YELLOW = COLOR_TABLE[3];
const PING_RED = COLOR_TABLE[1];

/**
 * `MAX_ADDRESSLENGTH` and Team Arena's `MAX_NAME_LENGTH`, their NULs aside (`ui_main.c:3458`):
 * the name's most, and its room in SPECIFY.
 */
const ADDRESS_KEPT = 63;
const FAVORITE_NAME_KEPT = 31;

/** `servernode_t` (`ui_servers2.c:179–193`): a server in a source's list. */
interface ServerNode {
  adr: NetAdr;
  /** The address as `connect` takes it. */
  adrstr: string;
  /** The server's own `hostname`, as ADD TO FAVORITES names it. */
  name: string;
  /** Its name as the row shows it: cut, cleaned of colours and upper-cased; or its address. */
  hostname: string;
  mapname: string;
  numclients: number;
  maxclients: number;
  pingtime: number;
  gametype: number;
  gamename: string;
  minPing: number;
  maxPing: number;
  /** Whether its ping went through the masters. */
  estimate: boolean;
  /** Whether it has answered; a favourite that hasn't reads as its address and "...". */
  answered: boolean;
  /** Its answer to the ping, which the box reads until its status comes. */
  info: string;
}

/** What the browser pages are made from. */
export interface ServersContext {
  menu: Menu;
  config: GameConfig;
  actions: Pick<MenuActions, 'command'>;
  /** The client's lists and pings. */
  servers: ServerLists;
  /** The client's own questions to one server: its status, and a channel opened to it. */
  status: Pick<ClientStatic, 'getServerStatus' | 'probe' | 'probeOpen'>;
  /** The favourites, which the pages add to and take from. */
  favorites: Pick<Favorites, 'add' | 'remove'>;
  /** CREATE's Start Server. */
  startServer: Pick<StartServerMenu, 'open'>;
  /** The protocol `globalservers` asks the master for. */
  protocol: number;
  /** `Sys_Milliseconds`, which the refresh is timed by. */
  now: () => number;
}

/** The browser, and the way into it. */
export interface ServersMenu {
  page: MenuPage;
  /** Open it, as `UI_ArenaServersMenu` does: the page afresh over the lists it keeps. */
  open(): void;
}

/** `Com_Clamp`. */
const clamp = (min: number, max: number, value: number) => Math.min(max, Math.max(min, value));

/**
 * ARENA SERVERS, reached from MULTIPLAYER (`ui_servers2.c:1356–1531`):
 * - Servers, Game Type, Sort By, Show Full and Show Empty, each kept in its `ui_browser*` cvar;
 * - the highlighted server's levelshot;
 * - the list, 11 rows, and its arrows, which the pointer alone reaches;
 * - ADD TO FAVORITES, or DELETE on Favorites, in q3_ui's corner, and SERVER INFO under it, which
 *   opens the highlighted server's box;
 * - the count line, and a status line of the page's own while a refresh runs;
 * - BACK, SPECIFY, REFRESH, CREATE and FIGHT.
 *
 * Its keys (`ArenaServers_MenuKey`): SPACE stops a refresh; DEL on the list removes a favourite;
 * Escape and the right button stop a refresh on the way back. The favourites need no save.
 */
export function serversMenu(context: ServersContext): ServersMenu {
  const { menu, servers } = context;
  const { cvars } = context.config;
  const command = (...argv: string[]) => context.actions.command(argv);
  const realtime = () => Math.floor(context.now());
  const maxPing = () => Math.max(100, atoi(cvars.get('cl_maxPing')));

  // What outlives the page: each source's list, as q3_ui's are static.
  const lists: Record<UiSource, ServerNode[]> = { 0: [], 1: [], 7: [] };
  let servertype: UiSource = UIAS.GLOBAL;
  let gametype = 0;
  let sortkey: number = SORT.PING;
  let fullservers = true;
  let emptyservers = true;

  // The page's own, made afresh as it opens (`ArenaServers_MenuInit`).
  const pinglist: ({ adr: NetAdr; adrstr: string; start: number } | null)[] = Array.from(
    { length: MAX_PINGREQUESTS },
    () => null
  );
  let table: ServerNode[] = [];
  let numqueriedservers = 0;
  let currentping = 0;
  let refreshservers = false;
  let nextpingtime = 0;
  let refreshtime = 0;
  let favoriteaddresses: string[] = [];
  let status = '';
  let statusbar = '';
  /** The items q3_ui greys and ungreys as a refresh runs (`ArenaServers_UpdateMenu`). */
  const grayed = { controls: false, list: false, refresh: false, go: false };
  const listState: ListState = { curvalue: 0, top: 0 };
  /** The server chosen in the list, by its address. */
  let chosen: NetAdr | null = null;
  /** The highlighted server whose status is fetched (`serverStatusAddress`), and its answer. */
  let statusNode: ServerNode | null = null;
  let statusReply: StatusReply | null = null;
  /** When its status is next asked for, 0 for at once, or null once it has answered. */
  let nextStatus: number | null = 0;
  /** Whether its own ping has gone down the channel opened to it, and when, while it is out. */
  let retimed = false;
  let retimeStart: number | null = null;
  /** What its box shows. */
  let detail: PageDetail | null = null;

  const serverlist = () => lists[servertype];
  const lanSource = () => SOURCES.find((source) => source.value === servertype)!.lan;

  /** The favourites' addresses, as their list has them. */
  const favoriteAddresses = (): string[] =>
    Array.from({ length: servers.count(AS.FAVORITES) }, (_, n) =>
      favoriteAddress(servers.server(AS.FAVORITES, n)!.adr)
    );

  /** A favourite that hasn't answered: its address in the name's place, sorted last by ping. */
  const unanswered = (adrstr: string): ServerNode => ({
    adr: stringToAdr(adrstr) ?? netadr(NA.BAD),
    adrstr,
    name: '',
    hostname: adrstr,
    mapname: '',
    numclients: 0,
    maxclients: 0,
    pingtime: maxPing(),
    gametype: 0,
    gamename: '',
    minPing: 0,
    maxPing: 0,
    estimate: false,
    answered: false,
    info: ''
  });

  /** `ArenaServers_Compare` (`ui_servers2.c:286–341`). */
  const compare = (t1: ServerNode, t2: ServerNode): number => {
    switch (sortkey) {
      case SORT.HOST:
        return stricmp(t1.hostname, t2.hostname);
      case SORT.MAP:
        return stricmp(t1.mapname, t2.mapname);
      case SORT.CLIENTS: {
        // The most open slots first.
        const f1 = Math.max(0, t1.maxclients - t1.numclients);
        const f2 = Math.max(0, t2.maxclients - t2.numclients);
        return f1 < f2 ? 1 : f1 === f2 ? 0 : -1;
      }
      case SORT.GAME:
        return t1.gametype < t2.gametype ? -1 : t1.gametype === t2.gametype ? 0 : 1;
      default:
        if (t1.pingtime !== t2.pingtime) return t1.pingtime < t2.pingtime ? -1 : 1;
        return stricmp(t1.hostname, t2.hostname);
    }
  };
  const sortList = () => serverlist().sort(compare);

  /** Whether a server passes the filters (`ArenaServers_UpdateMenu`'s culling). */
  const shown = (node: ServerNode): boolean => {
    if (!emptyservers && !node.numclients) return false;
    if (!fullservers && node.numclients === node.maxclients) return false;
    const game = GAMES[gametype].value;
    return game === null || node.gametype === game;
  };

  /** The chosen row's server, kept by its address. */
  const choose = () => {
    chosen = table[listState.curvalue]?.adr ?? null;
  };

  /**
   * `ArenaServers_UpdateMenu` (`ui_servers2.c:411–580`): the status lines and the greyed items for
   * where the refresh stands, and the list as the filters leave it.
   */
  const updateMenu = (): void => {
    if (numqueriedservers > 0) {
      if (refreshservers && currentping <= numqueriedservers) {
        status = `${currentping} of ${numqueriedservers} Arena Servers.`;
        statusbar = STOP_STATUS;
        sortList();
      } else {
        grayed.controls = grayed.list = grayed.refresh = grayed.go = false;
        statusbar = '';
      }
    } else {
      if (refreshservers) {
        status = 'Scanning For Servers.';
        statusbar = STOP_STATUS;
        grayed.controls = grayed.list = grayed.refresh = grayed.go = true;
      } else {
        status = numqueriedservers < 0 ? 'No Response From Master Server.' : 'No Servers Found.';
        statusbar = '';
        grayed.controls = grayed.refresh = false;
        grayed.list = grayed.go = true;
      }
      table = [];
      listState.curvalue = 0;
      listState.top = 0;
      return;
    }

    table = serverlist().filter(shown);
    listState.top = clamp(0, Math.max(0, table.length - LIST_HEIGHT), listState.top);
    const at = chosen === null ? -1 : table.findIndex((node) => compareAdr(node.adr, chosen!));
    listState.curvalue = at >= 0 ? at : Math.min(listState.top, Math.max(0, table.length - 1));
    choose();
  };

  /** A row from a server's answer (`ArenaServers_Insert`'s fields). */
  const fill = (node: ServerNode, info: string, pingtime: number, estimate: boolean) => {
    const value = (key: string) => infoValueForKey(info, key);
    node.name = value('hostname');
    node.hostname = cleanStr(value('hostname').slice(0, HOSTNAME_KEPT)).toUpperCase();
    node.mapname = cleanStr(value('mapname').slice(0, MAPNAME_KEPT)).toUpperCase();
    node.numclients = atoi(value('clients'));
    node.maxclients = atoi(value('sv_maxclients'));
    node.pingtime = pingtime;
    node.minPing = atoi(value('minPing'));
    node.maxPing = atoi(value('maxPing'));
    const gametype = atoi(value('gametype'));
    node.gametype = gametype < 0 ? 0 : gametype > 11 ? 12 : gametype;
    const game = value('game');
    node.gamename = game !== '' ? game.slice(0, GAMENAME_KEPT) : GAME_NAMES[node.gametype];
    node.estimate = estimate;
    node.answered = true;
    node.info = info;
  };

  /**
   * `ArenaServers_Insert` (`ui_servers2.c:644–727`): a ping's result into the source's list. A slow
   * server is left out, and a full list's last row gives way. A favourite stands in the list
   * already, and fills in only as it answers.
   */
  const insert = (
    adr: NetAdr,
    adrstr: string,
    info: string,
    pingtime: number,
    estimate: boolean
  ) => {
    if (servertype === UIAS.FAVORITES) {
      const node = lists[UIAS.FAVORITES].find((favorite) => compareAdr(favorite.adr, adr));
      if (node && info !== '') fill(node, info, pingtime, estimate);
      return;
    }
    if (pingtime >= maxPing()) return;
    const list = serverlist();
    const node = list.length >= MAX_LISTED ? list[list.length - 1] : unanswered(adrstr);
    if (list.length < MAX_LISTED) list.push(node);
    node.adr = { ...adr };
    node.adrstr = adrstr;
    fill(node, info, pingtime, estimate);
  };

  /**
   * `ArenaServers_LoadFavorites` (`ui_servers2.c:733–793`): the favourites' rows made to match the
   * list, each keeping what it knew. With nothing known of any of them, the rows go, so the source
   * refreshes as it is shown.
   */
  const loadFavorites = () => {
    const old = lists[UIAS.FAVORITES];
    let found = false;
    const kept = favoriteAddresses().map((adrstr) => {
      const node = old.find((favorite) => stricmp(favorite.adrstr, adrstr) === 0);
      if (node) found = true;
      return node ?? unanswered(adrstr);
    });
    favoriteaddresses = kept.map((node) => node.adrstr);
    lists[UIAS.FAVORITES] = found ? kept : [];
  };

  /**
   * After these pages change the favourites: their rows kept in step, each keeping what it knew,
   * and a new one standing as its address and "...". Rows never yet refreshed stay unmade, so the
   * source still refreshes as it is shown.
   */
  const favoritesChanged = () => {
    const old = lists[UIAS.FAVORITES];
    favoriteaddresses = favoriteAddresses();
    if (old.length === 0 && servertype !== UIAS.FAVORITES) return;
    lists[UIAS.FAVORITES] = favoriteaddresses.map(
      (adrstr) =>
        old.find((favorite) => stricmp(favorite.adrstr, adrstr) === 0) ?? unanswered(adrstr)
    );
    if (servertype !== UIAS.FAVORITES || refreshservers) return;
    numqueriedservers = currentping = lists[UIAS.FAVORITES].length;
    updateMenu();
  };

  /** `ArenaServers_StopRefresh` (`ui_servers2.c:801–820`): the final tally, sorted. */
  const stopRefresh = () => {
    if (!refreshservers) return;
    refreshservers = false;
    if (numqueriedservers >= 0) currentping = numqueriedservers = serverlist().length;
    sortList();
    updateMenu();
  };

  /**
   * `ArenaServers_DoRefresh` (`ui_servers2.c:828–970`), from the page's frame: the master waited
   * for, then every 10 ms the pings read and more sent, 32 out at most, until none is out.
   */
  const doRefresh = () => {
    const now = realtime();
    if (now < refreshtime) {
      if (servertype !== UIAS.FAVORITES) {
        if (servertype === UIAS.LOCAL && !servers.count(AS.LOCAL)) return;
        // Still waiting for the master.
        if (servers.count(lanSource()) < 0) return;
      }
    } else if (servertype === UIAS.LOCAL && !servers.count(AS.LOCAL)) {
      // None found on this network: ask again.
      command('localservers');
      refreshtime = now + REFRESH_WAIT_MSEC;
      return;
    }

    if (now < nextpingtime) return;
    nextpingtime = now + PING_STEP_MSEC;

    const max = maxPing();
    for (let i = 0; i < MAX_PINGREQUESTS; i++) {
      const result = servers.getPing(i);
      if (result === null) continue;
      const j = pinglist.findIndex((entry) => entry !== null && compareAdr(entry.adr, result.adr));
      if (j >= 0) {
        const entry = pinglist[j]!;
        let time = result.time;
        if (!time) {
          time = now - entry.start;
          if (time < max) continue;
        }
        let info = '';
        if (time > max) time = max;
        else info = servers.getPingInfo(i);
        insert(entry.adr, entry.adrstr, info, time, result.estimate);
        pinglist[j] = null;
      }
      servers.clearPing(i);
    }

    // The count can grow as the master's answers come.
    numqueriedservers =
      servertype === UIAS.FAVORITES ? favoriteaddresses.length : servers.count(lanSource());

    for (let i = 0; i < MAX_PINGREQUESTS && currentping < numqueriedservers; i++) {
      if (servers.pingQueueCount() >= MAX_PINGREQUESTS) break;
      const j = pinglist.indexOf(null);
      if (j < 0) break;
      const adrstr =
        servertype === UIAS.FAVORITES
          ? favoriteaddresses[currentping]
          : favoriteAddress(servers.server(lanSource(), currentping)?.adr ?? netadr(NA.BAD));
      pinglist[j] = { adr: stringToAdr(adrstr) ?? netadr(NA.BAD), adrstr, start: now };
      command('ping', adrstr);
      currentping++;
    }

    if (!servers.pingQueueCount()) {
      stopRefresh();
      return;
    }
    updateMenu();
  };

  /**
   * `ArenaServers_StartRefresh` (`ui_servers2.c:977–1061`): the source's list cleared and asked
   * for afresh, the game type and the filters going to the Internet's master too.
   */
  const startRefresh = () => {
    lists[servertype] =
      servertype === UIAS.FAVORITES ? favoriteaddresses.map((adrstr) => unanswered(adrstr)) : [];
    pinglist.fill(null);
    for (let i = 0; i < MAX_PINGREQUESTS; i++) servers.clearPing(i);
    retimeStart = null;
    refreshservers = true;
    currentping = 0;
    nextpingtime = 0;
    numqueriedservers = 0;
    refreshtime = realtime() + REFRESH_WAIT_MSEC;
    updateMenu();

    if (servertype === UIAS.LOCAL) {
      command('localservers');
      return;
    }
    if (servertype === UIAS.GLOBAL) {
      const game = GAMES[gametype].value;
      const keywords = [
        ...(game === null ? [] : [gameKeyword(game)]),
        ...(emptyservers ? ['empty'] : []),
        ...(fullservers ? ['full'] : [])
      ];
      command('globalservers', '0', String(context.protocol), ...keywords);
    }
  };

  /**
   * `ArenaServers_SetType` (`ui_servers2.c:1101–1170`): another source shown, its kept list if it
   * has one, else a refresh.
   */
  const setType = (type: UiSource) => {
    stopRefresh();
    servertype = type;
    if (serverlist().length === 0) {
      startRefresh();
      return;
    }
    currentping = numqueriedservers = serverlist().length;
    updateMenu();
    status = 'hit refresh to update';
  };

  /**
   * The highlighted server's own ping, read from its slot. A true time takes the tilde off the
   * row, in its place; one timed out leaves the row as it was.
   */
  const readRetime = (node: ServerNode, start: number, now: number) => {
    for (let i = 0; i < MAX_PINGREQUESTS; i++) {
      const result = servers.getPing(i);
      if (result === null || !compareAdr(result.adr, node.adr)) continue;
      if (!result.time) return;
      servers.clearPing(i);
      retimeStart = null;
      if (result.time >= maxPing()) return;
      node.pingtime = result.time;
      node.estimate = result.estimate;
      return;
    }
    // Its slot is gone: a name no master found, or another ping took it.
    if (now - start >= maxPing()) retimeStart = null;
  };

  /**
   * Team Arena's `UI_BuildServerStatus` (`ui_main.c:4182–4209`), from the page's frame, for the
   * highlighted server.
   * - Newly highlighted, it is probed and asked for its status at once, every other server let
   *   go. A favourite that has never answered is neither, and shows nothing.
   * - Unanswered, it is asked again every 500 ms. Answered, the answer is taken, and it is asked
   *   no more until the box's REFRESH.
   * - While its ping is an estimate and no refresh runs, it is pinged once down the channel the
   *   probe opened, as that opens.
   */
  const followStatus = () => {
    const node = table[listState.curvalue];
    const shown = node?.answered ? node : null;
    if (shown?.adrstr !== statusNode?.adrstr) {
      context.status.getServerStatus(null);
      statusReply = null;
      nextStatus = 0;
      retimed = false;
      retimeStart = null;
      if (shown) context.status.probe(shown.adrstr);
    }
    if (shown !== statusNode) {
      statusNode = shown;
      detail = shown && serverDetail(shown, statusReply);
    }
    if (shown === null) return;

    const now = realtime();
    const retime = !retimed && shown.estimate && !refreshservers;
    if (retimeStart !== null) readRetime(shown, retimeStart, now);
    else if (retime && context.status.probeOpen(shown.adrstr)) {
      command('ping', shown.adrstr);
      retimed = true;
      retimeStart = now;
    }
    if (nextStatus === null || now < nextStatus) return;
    const reply = context.status.getServerStatus(shown.adrstr);
    if (reply === null) {
      nextStatus = now + STATUS_RETRY_MSEC;
      return;
    }
    context.status.getServerStatus(shown.adrstr, false);
    statusReply = reply;
    nextStatus = null;
    detail = serverDetail(shown, reply);
  };

  /**
   * The box's REFRESH, Team Arena's `ServerStatus` (`ui_main.c:3337–3339`): the server's status
   * asked for afresh, every server let go. The last answer stands until the new one comes.
   */
  const refreshStatus = () => {
    context.status.getServerStatus(null);
    nextStatus = 0;
  };

  /** The page's own work each frame, which goes on under the box: the refresh, and the status. */
  const work = () => {
    if (refreshservers) doRefresh();
    followStatus();
  };

  /** `ArenaServers_Remove`: the chosen favourite taken out, and its file written. */
  const remove = () => {
    const node = table[listState.curvalue];
    if (!node) return;
    context.favorites.remove(node.adrstr);
    favoritesChanged();
  };

  /** A row's cells: the name, the map, the players, the game and the ping. */
  const cells = (node: ServerNode): readonly ColoredText[] => {
    if (!node.answered) {
      const blank = { text: '' };
      return [{ text: node.hostname }, blank, blank, blank, { text: NO_ANSWER }];
    }
    return [
      { text: node.hostname },
      { text: node.mapname },
      { text: `${node.numclients}/${node.maxclients}` },
      { text: node.gamename },
      { text: `${node.estimate ? '~' : ''}${node.pingtime}`, color: pingColor(node) }
    ];
  };

  const list = scrollList({
    height: LIST_HEIGHT,
    state: listState,
    count: () => table.length,
    cells: (index) => cells(table[index]),
    initial: (index) => table[index].hostname.charAt(0),
    changed: choose,
    grayed: () => grayed.list,
    place: 'list'
  });
  /** q3_ui's arrows move the chosen row as Up and Down do (`ui_servers2.c:1245–1251`). */
  const arrow = (label: string, place: string, key: number): MenuItem => ({
    label,
    place,
    mouseOnly: true,
    activate: () => void list.key!(key)
  });

  /** Team Arena's `addFavorite` (`ui_main.c:3416–3440`), or q3_ui's DELETE on Favorites. */
  const favorite: MenuItem = {
    get label() {
      return servertype === UIAS.FAVORITES ? 'DELETE' : 'ADD TO FAVORITES';
    },
    labels: ['ADD TO FAVORITES', 'DELETE'],
    place: 'favorite',
    get grayed() {
      return grayed.go;
    },
    activate: () => {
      if (servertype === UIAS.FAVORITES) {
        remove();
        return;
      }
      const node = table[listState.curvalue];
      if (node && context.favorites.add(node.adrstr, node.name) === 1) favoritesChanged();
    }
  };

  /**
   * Team Arena's Server Information box (`serverinfo_popmenu`), over the page: the highlighted
   * server's settings and board, REFRESH and CLOSE, the cursor on CLOSE. The page's own work goes
   * on under it.
   */
  const infoPage: MenuPage = {
    id: 'serverinfo',
    title: 'Server Information',
    layout: 'popup',
    items: [
      { label: 'REFRESH', place: 'refresh', activate: refreshStatus },
      { label: 'CLOSE', place: 'close', activate: () => menu.pop() }
    ],
    cursor: 1,
    get detail() {
      return detail;
    },
    frame: work
  };

  const page: MenuPage = {
    id: 'arenaservers',
    title: 'ARENA SERVERS',
    items: [
      spinControl({
        label: 'Servers',
        names: SOURCES.map((source) => source.name),
        get: () => SOURCES.findIndex((source) => source.value === servertype),
        set: (index) => {
          setType(SOURCES[index].value);
          cvars.setValue('ui_browserMaster', servertype);
        }
      }),
      spinControl({
        label: 'Game type',
        names: GAMES.map((game) => game.name),
        get: () => gametype,
        set: (index) => {
          cvars.setValue('ui_browserGameType', index);
          gametype = index;
          updateMenu();
        },
        grayed: () => grayed.controls
      }),
      spinControl({
        label: 'Sort by',
        names: SORT_KEYS,
        get: () => sortkey,
        set: (index) => {
          cvars.setValue('ui_browserSortKey', index);
          if (sortkey !== index) {
            sortkey = index;
            sortList();
          }
          updateMenu();
        },
        grayed: () => grayed.controls
      }),
      radioButton({
        label: 'Show full',
        get: () => fullservers,
        set: (on) => {
          cvars.setValue('ui_browserShowFull', on ? 1 : 0);
          fullservers = on;
          updateMenu();
        },
        grayed: () => grayed.controls
      }),
      radioButton({
        label: 'Show empty',
        get: () => emptyservers,
        set: (on) => {
          cvars.setValue('ui_browserShowEmpty', on ? 1 : 0);
          emptyservers = on;
          updateMenu();
        },
        grayed: () => grayed.controls
      }),
      arrow(LIST_ARROWS.up, 'up', K.UPARROW),
      arrow(LIST_ARROWS.down, 'down', K.DOWNARROW),
      list,
      {
        get label() {
          return status;
        },
        inactive: true,
        place: 'count'
      },
      favorite,
      {
        label: 'SERVER INFO',
        place: 'info',
        // Greyed with nothing answered to show, as FIGHT is with nothing to join.
        get grayed() {
          return grayed.go || statusNode === null;
        },
        activate: () => menu.push(infoPage)
      },
      {
        label: 'BACK',
        role: 'back',
        activate: () => {
          stopRefresh();
          menu.pop();
        }
      },
      {
        label: 'SPECIFY',
        place: 'specify',
        activate: () => menu.push(specifyPage(context, favoritesChanged))
      },
      {
        label: 'REFRESH',
        place: 'refresh',
        get grayed() {
          return grayed.refresh;
        },
        activate: startRefresh
      },
      { label: 'CREATE', place: 'create', activate: () => context.startServer.open(true) },
      {
        label: 'FIGHT',
        role: 'forward',
        get grayed() {
          return grayed.go;
        },
        // `ArenaServers_Go`.
        activate: () => {
          const node = table[listState.curvalue];
          if (node) command('connect', node.adrstr);
        }
      }
    ],
    get status() {
      return statusbar;
    },
    // `ArenaServers_UpdatePicture`: the chosen server's levelshot, `unknownmap` where it has none.
    get picture() {
      const node = table[listState.curvalue];
      return node ? { icon: `levelshots/${node.mapname}`, lines: [] } : undefined;
    },
    frame: work,
    key: (key) => {
      if (key === K.SPACE && refreshservers) {
        stopRefresh();
        return 'move';
      }
      const onList = page.items[menu.cursor] === list;
      if ((key === K.DEL || key === K.KP_DEL) && servertype === UIAS.FAVORITES && onList) {
        remove();
        return 'move';
      }
      if (key === K.MOUSE2 || key === K.ESCAPE) stopRefresh();
      return key;
    }
  };

  return {
    page,
    open: () => {
      pinglist.fill(null);
      table = [];
      numqueriedservers = currentping = 0;
      refreshservers = false;
      nextpingtime = refreshtime = 0;
      status = statusbar = '';
      grayed.controls = grayed.list = grayed.refresh = grayed.go = false;
      listState.curvalue = listState.top = 0;
      chosen = null;
      statusNode = statusReply = detail = retimeStart = null;
      nextStatus = 0;
      retimed = false;

      loadFavorites();
      const master = clamp(0, UIAS.FAVORITES, atoi(cvars.get('ui_browserMaster')));
      gametype = clamp(0, GAMES.length - 1, atoi(cvars.get('ui_browserGameType')));
      sortkey = clamp(0, SORT_KEYS.length - 1, atoi(cvars.get('ui_browserSortKey')));
      fullservers = clamp(0, 1, atoi(cvars.get('ui_browserShowFull'))) === 1;
      emptyservers = clamp(0, 1, atoi(cvars.get('ui_browserShowEmpty'))) === 1;
      // Master1 to Master5 are the one Internet master here.
      setType(master === UIAS.LOCAL || master === UIAS.FAVORITES ? master : UIAS.GLOBAL);
      menu.push(page);
    }
  };
}

/** What a game is asked of the master as: q3_ui's words, and `gametype=` for the rest. */
function gameKeyword(gametype: number): string {
  switch (gametype) {
    case GT.FFA:
      return 'ffa';
    case GT.TEAM:
      return 'team';
    case GT.TOURNAMENT:
      return 'tourney';
    case GT.CTF:
      return 'ctf';
    default:
      return `gametype=${gametype}`;
  }
}

/** A game's name: Start Server's for the games it offers, else the list's short one. */
function gameName(gametype: number): string {
  const offered = GAME_TYPES.find((type) => type.value === gametype);
  return offered?.name ?? GAME_NAMES[gametype < 0 ? 0 : gametype > 11 ? 12 : gametype];
}

/**
 * The limit that ends a match of the game, as cgame's load screen names it (`cg_info.c:272–294`):
 * captures from Capture the Flag on, the port's rounds in Clan Arena, else frags. 0 is none.
 */
function limitOf(gametype: number, value: (key: string) => string): string {
  const [key, unit] =
    gametype === GT.CA
      ? ['roundlimit', 'round']
      : gametype >= GT.CTF
        ? ['capturelimit', 'capture']
        : ['fraglimit', 'frag'];
  const limit = atoi(value(key));
  return limit ? `${limit} ${unit}${limit === 1 ? '' : 's'}` : 'None';
}

/**
 * A server's settings and board, as its box shows them: from its status once it has answered,
 * else from its answer to the ping, which has no preset, limits, version or board.
 */
function serverDetail(node: ServerNode, reply: StatusReply | null): PageDetail {
  const value = (key: string) => infoValueForKey(reply?.info ?? node.info, key);
  const password = atoi(value('g_needpass')) ? 'Yes' : 'No';
  let values: string[];
  if (reply === null) {
    const players = `${atoi(value('clients'))}/${atoi(value('sv_maxclients'))}`;
    const gametype = atoi(value('gametype'));
    const [host, map] = [cleanStr(value('hostname')), value('mapname')];
    values = [host, node.adrstr, map, gameName(gametype), '', '', '', players, password, ''];
  } else {
    const gametype = atoi(value('g_gametype'));
    const time = atoi(value('timelimit'));
    // Every server listed is this game's, so its version's first word says nothing.
    const game = `${value('com_gamename')} `;
    const version = value('version');
    values = [
      cleanStr(value('sv_hostname')),
      node.adrstr,
      value('mapname'),
      gameName(gametype),
      value('g_gamepreset'),
      limitOf(gametype, value),
      time ? `${time} min` : 'None',
      `${reply.players.length}/${atoi(value('sv_maxclients'))}`,
      password,
      version.startsWith(game) ? version.slice(game.length) : version
    ];
  }
  const settings: DetailRow[] = SETTINGS_LABELS.map((label, i) => ({ label, value: values[i] }));
  return { settings, board: reply && statusBoard(reply) };
}

/**
 * The board a port's server sends after its players: the `scores` command read as cgame reads
 * it, and each player's `cs` as the client info it sets. Null where the status carries none.
 */
function statusBoard(reply: StatusReply): Scoreboard | null {
  const gametype = atoi(infoValueForKey(reply.info, 'g_gametype'));
  let scores: Scores | null = null;
  const infos = new Map<number, ClientInfo>();
  for (const line of reply.board) {
    const argv = tokenize(line);
    if (argv[0] === 'scores') scores = parseScores(argv);
    if (argv[0] !== 'cs') continue;
    const client = atoi(argv[1] ?? '') - CONFIGSTRING.PLAYERS;
    const info = newClientInfo(argv[2] ?? '', gametype);
    if (client >= 0 && client < MAX_CLIENTS && info !== null) infos.set(client, info);
  }
  return scores && spectatorBoard(gametype, scores, (client) => infos.get(client) ?? null);
}

/**
 * A ping's colour (`ui_servers2.c:549–563`): blue outside the pings the server takes players
 * between, else green under 200, yellow under 400, and red.
 */
function pingColor(node: ServerNode): readonly [number, number, number] {
  if (node.pingtime < node.minPing) return PING_BLUE;
  if (node.maxPing && node.pingtime > node.maxPing) return PING_BLUE;
  if (node.pingtime < 200) return PING_GREEN;
  if (node.pingtime < 400) return PING_YELLOW;
  return PING_RED;
}

/**
 * SPECIFY SERVER (`ui_specifyserver.c`), built afresh each time, as q3_ui's is: Address, 38 shown
 * of 80, and Port, 27960 until changed, then the Name the port adds, each taking a paste.
 * - ADD TO FAVORITES adds the address and port under the name, as Team Arena's `createFavorite`
 *   does, and only with both (`ui_main.c:3452–3474`).
 * - FIGHT connects to the address, with the port after it where one is typed.
 *
 * @param added - A favourite was added.
 */
function specifyPage(context: ServersContext, added: () => void): MenuPage {
  const { menu } = context;
  const state = { address: '', port: String(PORT_SERVER), name: '' };
  const server = () => (state.port === '' ? state.address : `${state.address}:${state.port}`);
  return {
    id: 'specifyserver',
    title: 'SPECIFY SERVER',
    items: [
      textField({
        label: 'Address',
        maxchars: 80,
        widthInChars: 38,
        get: () => state.address,
        set: (text) => (state.address = text)
      }),
      textField({
        label: 'Port',
        maxchars: 5,
        widthInChars: 6,
        numbersOnly: true,
        get: () => state.port,
        set: (text) => (state.port = text)
      }),
      textField({
        label: 'Name',
        maxchars: FAVORITE_NAME_KEPT,
        widthInChars: FAVORITE_NAME_KEPT,
        get: () => state.name,
        set: (text) => (state.name = text)
      }),
      {
        label: 'ADD TO FAVORITES',
        place: 'favorite',
        activate: () => {
          if (state.address === '' || state.name === '') return;
          if (context.favorites.add(server().slice(0, ADDRESS_KEPT), state.name) === 1) added();
        }
      },
      back(menu),
      {
        label: 'FIGHT',
        role: 'forward',
        activate: () => {
          if (state.address !== '') context.actions.command(['connect', server()]);
        }
      }
    ]
  };
}
