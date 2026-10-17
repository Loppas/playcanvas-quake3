import { atoi } from '../formats/c-scan';
import { cleanStr } from '../formats/color-codes';
import { entityTokens, parseSpawnVars, spawnString } from '../formats/entity-text';
import { CONFIGSTRING } from '../net/commands';
import { CA } from '../net/connection';
import { infoValueForKey } from '../net/info';
import { GT } from '../sim/constants';
import { serverInfo } from './server-info';

/**
 * What Q3 says while a client is on its way into a match: q3_ui's connect screen
 * (`UI_DrawConnectScreen`, `ui_connect.c:162–253`), and cgame's lines about the server and the
 * match over a map's load (`CG_DrawInformation`, `cg_info.c:147–295`). Engine-free: the load
 * screen draws them, and draws no colours, so each line comes cleaned.
 */

/** The line naming the server, which q3_ui draws over a map's load too (`ui_connect.c:183`). */
export function connectingTo(server: string): string {
  return `Connecting to ${server}`;
}

/**
 * The connect screen's state line (`ui_connect.c:224–250`), with how many times it has asked.
 * Nothing once the gamestate is in, nor while the server is still being looked up.
 *
 * @param state - `clc.state`, one of {@link CA}.
 * @param packets - `clc.connectPacketCount`.
 */
export function connectState(state: number, packets: number): string {
  switch (state) {
    case CA.CONNECTING:
      return `Awaiting challenge...${packets}`;
    case CA.CHALLENGING:
      return `Awaiting connection...${packets}`;
    case CA.CONNECTED:
      return 'Awaiting gamestate...';
    default:
      return '';
  }
}

/**
 * What the server printed, such as a refusal, which the screen shows only until the connection
 * is up (`ui_connect.c:190–193`).
 *
 * @param state - `clc.state`.
 * @param message - `clc.serverMessage`.
 */
export function connectMessage(state: number, message: string): string {
  return state < CA.CONNECTED ? cleanStr(message) : '';
}

/** What cgame's lines are read from. */
export interface MatchInfo {
  /** Whether the server is elsewhere, `sv_running` 0 here: only then are its own lines shown. */
  remote: boolean;
  /** `sv_hostname`. */
  hostname: string;
  /** `CS_MOTD`: the server's `g_motd`. */
  motd: string;
  /** `CS_MESSAGE`: the worldspawn's `message`, the map's longer name for itself. */
  message: string;
  /** `sv_cheats`, as the systeminfo carries it. */
  cheats: string;
  gametype: number;
  timelimit: number;
  fraglimit: number;
  capturelimit: number;
  /** Clan Arena's limit, the port's own. */
  roundlimit: number;
}

/** cgame's lines, in the two groups it draws 10 apart (`cg_info.c:217`). */
export interface MatchLines {
  /** The server's name and its message of the day, for a server elsewhere; else none. */
  server: readonly string[];
  /** The map's message, the cheats, the game type and each limit that is set. */
  match: readonly string[];
}

/** `CG_DrawInformation`'s game type names (`cg_info.c:237–266`), and CPMA's for its own. */
const GAMETYPE_NAMES: Readonly<Record<number, string>> = {
  [GT.FFA]: 'Free For All',
  [GT.SINGLE_PLAYER]: 'Single Player',
  [GT.TOURNAMENT]: 'Tournament',
  [GT.TEAM]: 'Team Deathmatch',
  [GT.CTF]: 'Capture The Flag',
  [GT.CA]: 'Clan Arena'
};

/**
 * `CG_DrawInformation`'s lines (`cg_info.c:188–294`). "Pure Server" is never among them, since
 * no server of the port's is pure.
 */
export function matchLines(info: MatchInfo): MatchLines {
  const server: string[] = [];
  if (info.remote) {
    server.push(cleanStr(info.hostname));
    if (info.motd !== '') server.push(cleanStr(info.motd));
  }

  const match: string[] = [];
  if (info.message !== '') match.push(cleanStr(info.message));
  if (info.cheats[0] === '1') match.push('CHEATS ARE ENABLED');
  match.push(GAMETYPE_NAMES[info.gametype] ?? 'Unknown Gametype');
  if (info.timelimit !== 0) match.push(`timelimit ${info.timelimit}`);
  // Clan Arena's rounds stand where Q3's captures would, as the port's other limits read them.
  if (info.gametype === GT.CA) {
    if (info.roundlimit !== 0) match.push(`roundlimit ${info.roundlimit}`);
  } else if (info.gametype >= GT.CTF) {
    if (info.capturelimit !== 0) match.push(`capturelimit ${info.capturelimit}`);
  } else if (info.fraglimit !== 0) {
    match.push(`fraglimit ${info.fraglimit}`);
  }
  return { server, match };
}

/**
 * cgame's reading, from a gamestate's strings (`cg_info.c:157–158`).
 *
 * @param configstring - The gamestate's strings, by index.
 * @param remote - Whether the server is elsewhere.
 */
export function gamestateInfo(
  configstring: (index: number) => string,
  remote: boolean
): MatchInfo {
  const info = configstring(CONFIGSTRING.SERVERINFO);
  const { gametype, timelimit, fraglimit, capturelimit, roundlimit } = serverInfo(info);
  return {
    remote,
    hostname: infoValueForKey(info, 'sv_hostname'),
    motd: configstring(CONFIGSTRING.MOTD),
    message: configstring(CONFIGSTRING.MESSAGE),
    cheats: infoValueForKey(configstring(CONFIGSTRING.SYSTEMINFO), 'sv_cheats'),
    gametype,
    timelimit,
    fraglimit,
    capturelimit,
    roundlimit
  };
}

/**
 * The same, ahead of a server in this page, which the port starts only once the client's world is
 * in: the cvars it will start with, and the map's own entity text, whose worldspawn gives the
 * message (`SP_worldspawn`, `g_spawn.c:580–581`).
 *
 * @param cvar - The page's cvars, by name.
 * @param entities - The map's entity text.
 * @param cheats - Whether the server will start with cheats on.
 */
export function localInfo(
  cvar: (name: string) => string,
  entities: string,
  cheats: boolean
): MatchInfo {
  return {
    remote: false,
    hostname: '',
    motd: '',
    message: worldMessage(entities),
    cheats: cheats ? '1' : '0',
    gametype: atoi(cvar('g_gametype')),
    timelimit: atoi(cvar('timelimit')),
    fraglimit: atoi(cvar('fraglimit')),
    capturelimit: atoi(cvar('capturelimit')),
    roundlimit: atoi(cvar('roundlimit'))
  };
}

/**
 * A map's preview's lines: its message alone, since no server runs and no game is played, so there
 * is neither a server's line nor a game's.
 *
 * @param entities - The map's entity text.
 */
export function previewLines(entities: string): MatchLines {
  const message = worldMessage(entities);
  return { server: [], match: message === '' ? [] : [cleanStr(message)] };
}

/** The worldspawn's `message`, or none where the text doesn't read: the server says why itself. */
function worldMessage(entities: string): string {
  try {
    const world = parseSpawnVars(entityTokens(entities));
    return world ? spawnString(world, 'message', '') : '';
  } catch {
    return '';
  }
}
