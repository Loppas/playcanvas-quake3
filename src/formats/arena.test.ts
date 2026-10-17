import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { infoValueForKey } from '../net/info';
import { memorySource } from '../pak/byte-source';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import {
  ARENAS_FILE,
  GAME_ARENA_LIST,
  MAX_ARENAS_TEXT,
  MENU_ARENA_LIST,
  arenaInfoByMap,
  loadArenas,
  parseInfos,
  readInfoFiles,
  type InfoFile
} from './arena';

/** The garage's arena block, as `splat-maps/docs/map-format.md` §4 writes it. */
const GARAGE = '{\nmap "garage_rats"\nlongname "The Garage"\ntype "ffa tourney team"\n}\n';

/** A pak holding these files, as text or as bytes. */
function pak(label: string, files: Record<string, string | Uint8Array>): Promise<ZipArchive> {
  const entries = Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      typeof body === 'string' ? new TextEncoder().encode(body) : body
    ])
  );
  return ZipArchive.open(memorySource(label, zipSync(entries)));
}

describe('parseInfos', () => {
  it('makes each block an info string, the last key read first, as Info_SetValueForKey adds', () => {
    const print = vi.fn();
    expect(parseInfos(GARAGE, 10, print)).toEqual([
      '\\type\\ffa tourney team\\longname\\The Garage\\map\\garage_rats'
    ]);
    expect(print).not.toHaveBeenCalled();
  });

  it('reads every block of a file', () => {
    const infos = parseInfos(`${GARAGE}{ map "q3dm17" }`, 10, vi.fn());
    expect(infos.map((info) => infoValueForKey(info, 'map'))).toEqual(['garage_rats', 'q3dm17']);
  });

  it('gives a key with nothing after it on its line the value <NULL>', () => {
    // The value is read without crossing a line break, so the next line's word is the next key.
    const [info] = parseInfos('{\nmap\n"q3dm17" "x"\n}', 10, vi.fn());
    expect(infoValueForKey(info, 'map')).toBe('<NULL>');
    expect(infoValueForKey(info, 'q3dm17')).toBe('x');
  });

  it("stops at text that is not a block, with Q3's message", () => {
    const print = vi.fn();
    expect(parseInfos(`${GARAGE}map "q3dm17"`, 10, print)).toHaveLength(1);
    expect(print).toHaveBeenCalledWith('Missing { in info file');
  });

  it('keeps a block cut short by the end of the file, as far as it went', () => {
    const print = vi.fn();
    expect(parseInfos('{ map "q3dm17"', 10, print)).toEqual(['\\map\\q3dm17']);
    expect(print).toHaveBeenCalledWith('Unexpected end of info file');
  });

  it('stops at the room it is given', () => {
    const print = vi.fn();
    expect(parseInfos(`${GARAGE}${GARAGE}`, 1, print)).toHaveLength(1);
    expect(print).toHaveBeenCalledWith('Max infos exceeded');
  });

  it('leaves out a value Info_SetValueForKey refuses, and says so', () => {
    const print = vi.fn();
    const [info] = parseInfos('{ map "garage_rats" longname "a;b" }', 10, print);
    expect(info).toBe('\\map\\garage_rats');
    expect(print).toHaveBeenCalledWith("Can't use keys or values with a ';': longname = a;b");
  });
});

describe('loadArenas', () => {
  it('loads the files in order and numbers every arena', () => {
    const print = vi.fn();
    const files: InfoFile[] = [
      { path: 'scripts/arenas.txt', text: '{ map "q3dm17" }' },
      { path: 'scripts/garage_rats.arena', text: GARAGE }
    ];
    const infos = loadArenas(files, print);
    expect(infos.map((info) => [infoValueForKey(info, 'map'), infoValueForKey(info, 'num')])).toEqual([
      ['q3dm17', '0'],
      ['garage_rats', '1']
    ]);
    expect(print).toHaveBeenLastCalledWith('2 arenas parsed');
  });

  it("passes over a missing file and one too large, with Q3's messages", () => {
    const print = vi.fn();
    const infos = loadArenas(
      [
        { path: 'scripts/arenas.txt', text: undefined },
        { path: 'scripts/big.arena', text: ' '.repeat(MAX_ARENAS_TEXT) },
        { path: 'scripts/garage_rats.arena', text: GARAGE }
      ],
      print
    );
    expect(infos).toHaveLength(1);
    expect(print).toHaveBeenCalledWith('file not found: scripts/arenas.txt');
    expect(print).toHaveBeenCalledWith('file too large: scripts/big.arena is 8192, max allowed is 8192');
  });
});

describe('arenaInfoByMap', () => {
  it('finds a map by name without regard to case, or gives null', () => {
    const infos = loadArenas([{ path: 'scripts/garage_rats.arena', text: GARAGE }], vi.fn());
    expect(infoValueForKey(arenaInfoByMap(infos, 'GARAGE_RATS')!, 'longname')).toBe('The Garage');
    expect(arenaInfoByMap(infos, 'q3dm17')).toBeNull();
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe('readInfoFiles', () => {
  it('reads arenas.txt, missing or not, then every .arena in search order', async () => {
    const fs = new PakFileSystem();
    fs.mount(await pak('map-garage_rats.pk3', { 'scripts/garage_rats.arena': GARAGE }));
    fs.mount(await pak('pak2.pk3', { 'scripts/q3tourney6_ctf.arena': '{ map "q3tourney6_ctf" }' }));
    expect(await readInfoFiles(fs, ARENAS_FILE, '.arena', MENU_ARENA_LIST)).toEqual([
      { path: 'scripts/arenas.txt', text: undefined },
      { path: 'scripts/q3tourney6_ctf.arena', text: '{ map "q3tourney6_ctf" }' },
      { path: 'scripts/garage_rats.arena', text: GARAGE }
    ]);
  });

  it("loses the bottom layer's arena first from a list with no room for it", async () => {
    // Names of 18 bytes with their NULs, the garage's among them, fill the game module's 1024
    // bytes after 56. The menu's 4096 hold all 61, so only the game module loses the map pk3's.
    const fs = new PakFileSystem();
    fs.mount(await pak('map-garage_rats.pk3', { 'scripts/garage_rats.arena': GARAGE }));
    const many = Array.from({ length: 60 }, (_, i) => [
      `scripts/m${String(i).padStart(10, '0')}.arena`,
      '{}'
    ]);
    fs.mount(await pak('zz-maps.pk3', Object.fromEntries(many)));

    const game = await readInfoFiles(fs, ARENAS_FILE, '.arena', GAME_ARENA_LIST);
    const menu = await readInfoFiles(fs, ARENAS_FILE, '.arena', MENU_ARENA_LIST);
    expect(game).toHaveLength(1 + 56);
    expect(game.map((file) => file.path)).not.toContain('scripts/garage_rats.arena');
    expect(menu).toHaveLength(1 + 61);
    expect(menu.at(-1)).toEqual({ path: 'scripts/garage_rats.arena', text: GARAGE });
  });

  it('reads each byte as a character', async () => {
    const fs = new PakFileSystem();
    fs.mount(await pak('pak0.pk3', { 'scripts/arenas.txt': new Uint8Array([0x7b, 0xe9, 0x7d]) }));
    expect((await readInfoFiles(fs, ARENAS_FILE, '.arena', MENU_ARENA_LIST))[0].text).toBe('{é}');
  });
});

describe.skipIf(!haveFullSet)('loadArenas against the retail paks', () => {
  it('reads arenas.txt and both .arena files: 35 arenas for 36 maps', async () => {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    const files = await readInfoFiles(fs, ARENAS_FILE, '.arena', GAME_ARENA_LIST);
    expect(files.map((file) => file.path)).toEqual([
      'scripts/arenas.txt',
      'scripts/promaps.arena',
      'scripts/q3tourney6_ctf.arena'
    ]);

    const print = vi.fn();
    const infos = loadArenas(files, print);
    expect(print.mock.calls).toEqual([['35 arenas parsed']]);

    // What q3dm17 and q3tourney6 declare, and q3dm15's double space kept as it is.
    const q3dm17 = arenaInfoByMap(infos, 'q3dm17')!;
    expect(infoValueForKey(q3dm17, 'type')).toBe('single ffa');
    expect(infoValueForKey(arenaInfoByMap(infos, 'q3tourney6')!, 'special')).toBe('Final');
    expect(infoValueForKey(arenaInfoByMap(infos, 'q3dm15')!, 'type')).toBe('single ffa  team');
    expect(arenaInfoByMap(infos, 'test_bigbox')).toBeNull();
  });
});
