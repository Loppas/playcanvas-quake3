import { zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';

import { memorySource } from '../pak/byte-source';
import { havePak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import { vec3 } from '../sim/vec3';
import { bspEntityText } from './bsp';
import { retailMaps } from './bsp-test-fixtures';
import { textOfBytes } from './com-parse';
import {
  MAX_SPAWN_VARS,
  MAX_SPAWN_VARS_CHARS,
  entityTokens,
  parseSpawnVars,
  parseVector,
  readEntities,
  readEntityText,
  spawnFloat,
  spawnInt,
  spawnString,
  spawnVector,
  type SpawnVar
} from './entity-text';

/**
 * The garage's entities as `splat-maps/docs/map-format.md` §3.5 shows them, saved the way
 * NetRadiant saves a map: CRLF, a layer line, and a comment over each entity.
 */
const GARAGE = [
  '',
  '//@$& layerdef "0" -1 0 0 0',
  '// entity 0',
  '{',
  '"classname" "worldspawn"',
  '"message" "The Garage"',
  '"_pcq_format" "1"',
  '}',
  '// entity 1',
  '{',
  '"classname" "info_player_deathmatch"',
  '"origin" "-4 -4 43"',
  '"angle" "0"',
  '"spawnflags" "1"',
  '}',
  '// entity 2',
  '{',
  '"classname" "info_player_intermission"',
  '"origin" "1056 2016 868"',
  '"target" "intermission_view"',
  '}',
  '{',
  '"classname" "target_position"',
  '"targetname" "intermission_view"',
  '"origin" "0 0 100"',
  '}',
  ''
].join('\r\n');

/** An entity block of these pairs. */
const block = (pairs: readonly SpawnVar[]) =>
  `{\n${pairs.map(([key, value]) => `"${key}" "${value}"`).join('\n')}\n}\n`;

describe('readEntities', () => {
  it('reads each block as its pairs, in order, past the comments and CRLFs', () => {
    expect(readEntities(GARAGE)).toEqual([
      [
        ['classname', 'worldspawn'],
        ['message', 'The Garage'],
        ['_pcq_format', '1']
      ],
      [
        ['classname', 'info_player_deathmatch'],
        ['origin', '-4 -4 43'],
        ['angle', '0'],
        ['spawnflags', '1']
      ],
      [
        ['classname', 'info_player_intermission'],
        ['origin', '1056 2016 868'],
        ['target', 'intermission_view']
      ],
      [
        ['classname', 'target_position'],
        ['targetname', 'intermission_view'],
        ['origin', '0 0 100']
      ]
    ]);
  });

  it('reads an empty text as no entities, and an empty block as one with no pairs', () => {
    expect(readEntities('')).toEqual([]);
    expect(readEntities('// nothing\n')).toEqual([]);
    expect(readEntities('{ }')).toEqual([[]]);
  });

  it('looks only at a token\'s first character for a brace, as Q3 does', () => {
    expect(readEntities('{x "a" "1" }y')).toEqual([[['a', '1']]]);
  });

  it("stops with G_Error's words for text that is not blocks of pairs", () => {
    expect(() => readEntities('"classname" "worldspawn"')).toThrow(
      'G_ParseSpawnVars: found classname when expecting {'
    );
    expect(() => readEntities('{ "a" "1"')).toThrow('G_ParseSpawnVars: EOF without closing brace');
    expect(() => readEntities('{ "a"')).toThrow('G_ParseSpawnVars: EOF without closing brace');
    expect(() => readEntities('{ "a" }')).toThrow('G_ParseSpawnVars: closing brace without data');
  });

  it(`holds an entity to ${MAX_SPAWN_VARS} pairs`, () => {
    const pairs = (n: number) => Array.from({ length: n }, (_, i): SpawnVar => [`k${i}`, 'v']);
    expect(readEntities(block(pairs(MAX_SPAWN_VARS)))[0]).toHaveLength(MAX_SPAWN_VARS);
    expect(() => readEntities(block(pairs(MAX_SPAWN_VARS + 1)))).toThrow(
      'G_ParseSpawnVars: MAX_SPAWN_VARS'
    );
  });

  it(`holds an entity to ${MAX_SPAWN_VARS_CHARS} bytes, each key and value with its NUL`, () => {
    // A token is cut to 1023 bytes, so the limit takes several. Four pairs of a one-byte key and
    // a thousand-byte value take 4 × (2 + 1001) = 4012 bytes, and a fifth key 2 more.
    const thousand = 'x'.repeat(1000);
    const pairs = (last: number): SpawnVar[] => [
      ['a', thousand],
      ['b', thousand],
      ['c', thousand],
      ['d', thousand],
      ['e', 'x'.repeat(last)]
    ];
    expect(readEntities(block(pairs(81)))[0]).toHaveLength(5);
    expect(() => readEntities(block(pairs(82)))).toThrow(
      'G_AddSpawnVarToken: MAX_SPAWN_VARS_CHARS'
    );
  });
});

describe('entityTokens', () => {
  it('hands over an empty quoted string as a token, and null only at the end', () => {
    const next = entityTokens('{ "message" "" }');
    expect([next(), next(), next(), next(), next()]).toEqual(['{', 'message', '', '}', null]);
  });

  it('lets the game read one entity at a time', () => {
    const next = entityTokens(GARAGE);
    expect(spawnString(parseSpawnVars(next)!, 'classname', '')).toBe('worldspawn');
    expect(spawnString(parseSpawnVars(next)!, 'classname', '')).toBe('info_player_deathmatch');
  });
});

describe('the G_Spawn* readers', () => {
  const vars: SpawnVar[] = [
    ['classname', 'info_player_deathmatch'],
    ['Origin', '-4 -4 43'],
    ['origin', '1 2 3'],
    ['spawnflags', '1'],
    ['wait', '2.5'],
    ['height', '12 units']
  ];

  it('takes the first of a key given twice, matched without regard to case', () => {
    expect(spawnString(vars, 'ORIGIN', '')).toBe('-4 -4 43');
    expect(spawnString(vars, 'target', 'none')).toBe('none');
  });

  it('reads numbers as atoi and atof do', () => {
    expect(spawnInt(vars, 'spawnflags', '0')).toBe(1);
    expect(spawnInt(vars, 'height', '0')).toBe(12);
    expect(spawnInt(vars, 'nobots', '0')).toBe(0);
    expect(spawnFloat(vars, 'wait', '0')).toBe(2.5);
    expect(spawnFloat(vars, 'gravity', '800')).toBe(800);
    // Into a C float, as `G_SpawnFloat`'s `float *out` takes it.
    expect(spawnFloat(vars, 'lip', '0.7')).toBe(0.699999988079071);
  });

  it('reads a vector as sscanf does, keeping a component the text does not give', () => {
    const into = vec3(7, 8, 9);
    expect(spawnVector(vars, 'origin', '0 0 0', into)).toBe(true);
    expect(into).toEqual(vec3(-4, -4, 43));
    expect(spawnVector([['origin', '5']], 'origin', '0 0 0', into)).toBe(true);
    expect(into).toEqual(vec3(5, -4, 43));
    expect(spawnVector([], 'origin', '1 1 1', into)).toBe(false);
    expect(into).toEqual(vec3(1, 1, 1));
    expect(parseVector('10 -20')).toEqual(vec3(10, -20, 0));
    // `%f` into a `vec3_t`: each a C float.
    expect(parseVector('0.1 -0.7 22.5')).toEqual(vec3(Math.fround(0.1), Math.fround(-0.7), 22.5));
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('readEntities against the 36 retail maps', () => {
  /** Every map's entities, by name. */
  let maps: Map<string, SpawnVar[][]>;
  beforeAll(async () => {
    maps = await retailMaps((bytes, path) => readEntities(bspEntityText(bytes, path)));
  }, 60_000);

  /** How many entities of each classname, over every map. */
  function classnames(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entities of maps.values()) {
      for (const vars of entities) {
        const name = spawnString(vars, 'classname', '');
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }

  it('reads every map, within the limits, worldspawn first', () => {
    expect(maps.size).toBe(36);
    let entities = 0;
    let mostPairs = 0;
    let mostBytes = 0;
    for (const [name, list] of maps) {
      expect(spawnString(list[0], 'classname', ''), name).toBe('worldspawn');
      entities += list.length;
      for (const vars of list) {
        mostPairs = Math.max(mostPairs, vars.length);
        const bytes = vars.reduce((sum, [key, value]) => sum + key.length + value.length + 2, 0);
        mostBytes = Math.max(mostBytes, bytes);
      }
    }
    // The count a script apart from the port's parser made from the paks.
    expect(entities).toBe(11_110);
    // Far inside both limits, 64 pairs and 4096 bytes, which that count left unmeasured.
    expect([mostPairs, mostBytes]).toEqual([11, 166]);
  });

  it('counts the spawn points of the maps Q3 would load', () => {
    // A count over every pak has 361, 37 and 37: it also takes pak0's q3dm9, which pak2's
    // replaces. Counted per map, they sum to these.
    const counts = classnames();
    expect(counts.get('info_player_deathmatch')).toBe(350);
    expect(counts.get('info_player_intermission')).toBe(36);
    expect(counts.get('info_player_start')).toBe(1);
    expect(counts.get('worldspawn')).toBe(36);
  });

  it('reads q3dm17 as it is: 153 entities, 11 spawn spots and two intermission points', () => {
    const list = maps.get('q3dm17')!;
    const named = (classname: string) =>
      list.filter((vars) => spawnString(vars, 'classname', '') === classname);
    expect(list).toHaveLength(153);
    expect(named('info_player_deathmatch')).toHaveLength(11);
    expect(named('info_player_intermission')).toHaveLength(2);
  });
});

describe('textOfBytes and the entity reader', () => {
  it('reads a file given as bytes', () => {
    const bytes = Uint8Array.from('{ "a" "1" }', (c) => c.charCodeAt(0));
    expect(readEntities(textOfBytes(bytes))).toEqual([[['a', '1']]]);
  });
});

describe('readEntityText', () => {
  /** A search path of one pak holding these files. */
  async function searchPathOf(files: Record<string, Uint8Array>): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    fs.mount(await ZipArchive.open(memorySource('map-garage_rats.pk3', zipSync(files))));
    return fs;
  }

  it('reads maps/<n>.ent through the search path, a byte to a character', async () => {
    const text = '{ "classname" "worldspawn" "message" "Caf\xe9" }';
    const fs = await searchPathOf({
      'maps/garage_rats.ent': Uint8Array.from(text, (c) => c.charCodeAt(0))
    });
    expect(await readEntityText(fs, 'garage_rats')).toBe(text);
    expect(await readEntityText(fs, 'GARAGE_RATS')).toBe(text);
  });

  it('stops a map that has none, with the path it looked for', async () => {
    const fs = await searchPathOf({ 'maps/garage_rats.sog': new Uint8Array(4) });
    await expect(readEntityText(fs, 'backyard')).rejects.toThrow(
      "Can't find map maps/backyard.ent"
    );
  });
});
