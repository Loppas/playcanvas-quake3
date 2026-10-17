import { infoSetValueForKey, infoValueForKey } from '../net/info';
import { GT } from '../sim/constants';
import { comParseExt, parseCursor } from './com-parse';

/**
 * The menus' maps: q3_ui's arenas in its order, and the ones a game type lists, as Start Server
 * shows them (`ui_gameinfo.c`, `ui_startserver.c`). Engine-free, like the readers.
 */

/** `ARENAS_PER_TIER` (`bg_public.h:714`): Single Player's arenas come four to a tier. */
export const ARENAS_PER_TIER = 4;

/** `MAX_NAMELENGTH` (`ui_startserver.c:54`): a map's name as the page shows it, its NUL aside. */
export const MAP_NAME_LENGTH = 15;

/**
 * `UI_LoadArenas`' numbering (`ui_gameinfo.c:207–261`), which the menus list maps in: the Single
 * Player arenas first, then the specials from that count cut down to a whole tier, then the rest
 * as read. An arena counts as Single Player where `single` is anywhere in its `type`, and as special
 * where it has a `special` as well.
 *
 * Where the count of Single Player arenas is not a whole number of tiers, the last of them share
 * their numbers with the arenas after them. q3_ui then lists only the first arena of each number;
 * every arena is kept here, in number order, the first read first.
 *
 * @param infos - The arenas as `loadArenas` reads them, in the order read.
 * @param print - Where q3_ui's console messages go.
 * @returns the arenas with q3_ui's `num`, in its order
 */
export function menuArenas(infos: readonly string[], print: (message: string) => void): string[] {
  const kinds = infos.map((info) => {
    const type = infoValueForKey(info, 'type');
    // No type, which the game module treats as `ffa`.
    if (!type.includes('single')) return 'other';
    return infoValueForKey(info, 'special') ? 'special' : 'single';
  });
  let singles = kinds.filter((kind) => kind === 'single').length;
  const specials = kinds.filter((kind) => kind === 'special').length;
  const cut = singles % ARENAS_PER_TIER;
  if (cut !== 0) {
    singles -= cut;
    print(`${cut} arenas ignored to make count divisible by ${ARENAS_PER_TIER}`);
  }

  const next = { single: 0, special: singles, other: singles + specials };
  const numbered = infos.map((info, read) => ({ num: next[kinds[read]]++, read, info }));
  numbered.sort((a, b) => a.num - b.num || a.read - b.read);
  return numbered.map(({ num, info }) => infoSetValueForKey(info, 'num', String(num), print));
}

/**
 * `GametypeBits` (`ui_startserver.c:113–150`): the games an arena's `type` names, a bit for each
 * by its `GT_` number, its words matched without regard to case. `clanarena` names Clan Arena.
 */
export function gametypeBits(type: string): number {
  const cursor = parseCursor(type);
  let bits = 0;
  for (;;) {
    const token = comParseExt(cursor, false).toLowerCase();
    if (!token) break;
    const gametype = TYPE_WORDS[token];
    if (gametype !== undefined) bits |= 1 << gametype;
  }
  return bits;
}

const TYPE_WORDS: Readonly<Record<string, number>> = {
  ffa: GT.FFA,
  tourney: GT.TOURNAMENT,
  single: GT.SINGLE_PLAYER,
  team: GT.TEAM,
  ctf: GT.CTF,
  clanarena: GT.CA
};

/**
 * `StartServer_GametypeEvent` (`ui_startserver.c:257–286`): the maps a game type lists, in the
 * arenas' order. Free For All lists Single Player's as well, and an arena with no `type` is listed
 * under none.
 *
 * @param arenas - As {@link menuArenas} orders them.
 * @returns each map's name as its arena gives it
 */
export function gametypeMaps(arenas: readonly string[], gametype: number): string[] {
  let match = 1 << gametype;
  if (gametype === GT.FFA) match |= 1 << GT.SINGLE_PLAYER;
  return arenas
    .filter((info) => (gametypeBits(infoValueForKey(info, 'type')) & match) !== 0)
    .map((info) => infoValueForKey(info, 'map'));
}

/**
 * A map's name as the page shows it and looks its levelshot up by: cut to
 * {@link MAP_NAME_LENGTH}, in capitals (`Q_strncpyz`, `Q_strupr`).
 */
export function shownMapName(map: string): string {
  return map.slice(0, MAP_NAME_LENGTH).replace(/[a-z]+/g, (run) => run.toUpperCase());
}
