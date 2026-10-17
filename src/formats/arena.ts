import { infoSetValueForKey, infoValueForKey } from '../net/info';
import type { PakFileSystem } from '../pak/vfs';
import { comParse, comParseExt, parseCursor, textOfBytes } from './com-parse';

/**
 * Arena files: Quake 3's `scripts/arenas.txt` and `scripts/*.arena`, which say what each map is
 * called and which gametypes it is made for, so that the menus can list a map without loading it.
 *
 * Each block of pairs between braces becomes an info string (`G_ParseInfos`, `g_bot.c:68–117`).
 * A splat map carries one block, in `scripts/<n>.arena` (`splat-maps/docs/map-format.md` §4).
 * Nothing refuses a gametype on an arena's account: the server starts any map in any
 * gametype, and only Single Player reads a block back.
 *
 * Engine-free, like the other readers.
 */

/** `MAX_ARENAS` (`bg_public.h:715`): the arenas that may be loaded together. */
export const MAX_ARENAS = 1024;

/** `MAX_ARENAS_TEXT` (`bg_public.h:716`): an arena file's size, and one for its NUL. */
export const MAX_ARENAS_TEXT = 8192;

/** The arena file read first, where the cvar `g_arenasFile` names none (`g_bot.c:163–169`). */
export const ARENAS_FILE = 'scripts/arenas.txt';

/**
 * The room for `.arena` names in the game module's read, `G_LoadArenas`: its `dirlist`, in bytes
 * (`g_bot.c:156`). Only bots and Single Player use that read.
 */
export const GAME_ARENA_LIST = 1024;

/**
 * The room for `.arena` names in q3_ui's read, `UI_LoadArenas` (`ui_gameinfo.c:172`), four times
 * the game module's. This is the read the menus list maps from.
 */
export const MENU_ARENA_LIST = 4096;

/**
 * An info file as read: its path, for messages, and its text, or `undefined` if it is missing.
 * Arenas and bots are both kept in these.
 */
export interface InfoFile {
  path: string;
  text: string | undefined;
}

/**
 * Info files, read through a search path as the game module and q3_ui read theirs: one named file,
 * then every `scripts/*<extension>` as `trap_FS_GetFileList` lists them. Arenas are read this way
 * by `G_LoadArenas` (`g_bot.c:152–177`) and `UI_LoadArenas` (`ui_gameinfo.c:168–198`), from
 * {@link ARENAS_FILE} and `.arena`; bots by `G_LoadBots` (`g_bot.c:932–965`).
 *
 * The list stops at the first name it has no room for. The port's own map pk3s are the bottom of
 * the search path, so theirs are listed last and are the first lost from a full list.
 *
 * The cvars that name another file to read first, `g_arenasFile` and `g_botsFile`, are not kept.
 * They are read-only and set only from the command line.
 *
 * @param fs - The search path.
 * @param file - The file read first.
 * @param extension - The extension of the files listed from `scripts/`, dot and all.
 * @param listSize - The room for their names, in bytes: {@link MENU_ARENA_LIST} or
 *   {@link GAME_ARENA_LIST} for arenas.
 */
export async function readInfoFiles(
  fs: Pick<PakFileSystem, 'getFileList' | 'read'>,
  file: string,
  extension: string,
  listSize: number
): Promise<InfoFile[]> {
  const listed = fs.getFileList('scripts', extension, listSize).map((name) => `scripts/${name}`);
  return Promise.all(
    [file, ...listed].map(async (path) => {
      const bytes = await fs.read(path);
      return { path, text: bytes && textOfBytes(bytes) };
    })
  );
}

/**
 * Every block of these files as an info string, as `G_LoadArenasFromFile` and
 * `G_LoadBotsFromFile` load them (`g_bot.c:124–145, 904–925`). A missing file and one too large
 * are each skipped with Q3's line.
 *
 * @param files - The files, in the order Q3 loads them.
 * @param max - How many infos there is room for.
 * @param maxText - A file's size limit, one for its NUL included.
 * @param print - Where Q3's console messages go.
 */
export function loadInfos(
  files: readonly InfoFile[],
  max: number,
  maxText: number,
  print: (message: string) => void
): string[] {
  const infos: string[] = [];
  for (const { path, text } of files) {
    if (text === undefined) {
      print(`file not found: ${path}`);
      continue;
    }
    if (text.length >= maxText) {
      print(`file too large: ${path} is ${text.length}, max allowed is ${maxText}`);
      continue;
    }
    infos.push(...parseInfos(text, max - infos.length, print));
  }
  return infos;
}

/**
 * `G_ParseInfos` (`g_bot.c:68–117`): each block of a file as an info string.
 *
 * A key runs across line breaks, but its value does not: a key with nothing after it on its line
 * gets the value `<NULL>`. A block cut short by the end of the file is kept as far as it went.
 *
 * @param text - The file, a byte to a character.
 * @param max - How many more there is room for.
 * @param print - Where Q3's console messages go.
 */
export function parseInfos(text: string, max: number, print: (message: string) => void): string[] {
  const cursor = parseCursor(text);
  const infos: string[] = [];
  for (;;) {
    let token = comParse(cursor);
    if (!token) break;
    if (token !== '{') {
      print('Missing { in info file');
      break;
    }
    if (infos.length === max) {
      print('Max infos exceeded');
      break;
    }

    let info = '';
    for (;;) {
      token = comParseExt(cursor, true);
      if (!token) {
        print('Unexpected end of info file');
        break;
      }
      if (token === '}') break;
      const key = token;
      const value = comParseExt(cursor, false) || '<NULL>';
      info = infoSetValueForKey(info, key, value, print);
    }
    infos.push(info);
  }
  return infos;
}

/**
 * `G_LoadArenas` (`g_bot.c:152–185`) over files already read: `scripts/arenas.txt`, then every
 * `scripts/*.arena` in the order the file system lists them. Each arena is then given its number,
 * as the key `num`.
 *
 * q3_ui's `UI_LoadArenas` parses and counts the same way, then numbers them again for the menus,
 * Single Player's first (`menuArenas`, `formats/arena-list.ts`).
 *
 * @param files - The files, in the order Q3 loads them.
 * @param print - Where Q3's console messages go.
 */
export function loadArenas(files: readonly InfoFile[], print: (message: string) => void): string[] {
  const infos = loadInfos(files, MAX_ARENAS, MAX_ARENAS_TEXT, print);
  print(`${infos.length} arenas parsed`);
  return infos.map((info, n) => infoSetValueForKey(info, 'num', String(n), print));
}

/**
 * `G_GetArenaInfoByMap` (`g_bot.c:193–203`): the arena whose `map` is this one, matched without
 * regard to case.
 *
 * @returns the first such arena's info string, or `null`
 */
export function arenaInfoByMap(infos: readonly string[], map: string): string | null {
  const wanted = map.toLowerCase();
  return infos.find((info) => infoValueForKey(info, 'map').toLowerCase() === wanted) ?? null;
}
