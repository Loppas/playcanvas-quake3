import { beforeAll, describe, expect, it } from 'vitest';

import { parseBspCollision } from '../formats/bsp';
import { retailMaps } from '../formats/bsp-test-fixtures';
import { entityTokens, type SpawnVar } from '../formats/entity-text';
import { MAX_CLIENTS } from '../net/protocol';
import { havePak } from '../pak/pak-test-fixtures';
import { createClipTrace } from './clip-trace';
import { entityString, loadMap } from './cm/cm-load';
import { floodAreaConnections } from './cm/cm-test';
import type { ClipMap } from './cm/cm-local';
import { FL, GT } from './constants';
import { MOVER, type GameEntity } from './game-entity';
import { runItem } from './item-run';
import { FRAMETIME } from './item-spawn';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { findItem } from './items';
import { Level, Q3_FRAME_MSEC } from './level';
import { entityText, mapOf, spawnSpot } from './map-test-fixtures';
import { runMover } from './mover-push';
import type { Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import {
  checkWorldspawn,
  inGametype,
  newString,
  spawnEntitiesFromString,
  spawnEntityFromVars
} from './spawn';
import { findTeams } from './targets';
import type { TraceFn } from './types';
import { vec3 } from './vec3';

/** A level with these entities spawned into it, in this gametype, and what was printed. */
function spawned(
  text: string,
  gametype: number = GT.FFA,
  rules?: Readonly<Rules>,
  clipMap?: ClipMap
) {
  const level = new Level({ rules, clipMap });
  const prints: string[] = [];
  const worlds: SpawnVar[][] = [];
  spawnEntitiesFromString(
    entityTokens(text),
    (vars) => worlds.push([...vars]),
    (vars) => spawnEntityFromVars(level, vars, gametype, (line) => prints.push(line))
  );
  const inUse = level.gentities.filter(
    (entity, i) => i >= MAX_CLIENTS && entity.inuse && !entity.neverFree
  );
  return { level, prints, worlds, entities: inUse };
}

/**
 * A map a second in, as `G_InitGame` and the frames after it leave one: its entities spawned, its
 * teams chained, and its frames run, items falling and movers moving, with what the game printed.
 */
function settle(
  text: string,
  cm: ClipMap,
  gametype: number = GT.FFA
): { level: Level; prints: string[] } {
  // `trap_Trace`, as the game hands an item's fall: the map's, then the level's entities.
  const trace: TraceFn = (...args) => level.trace(...args);
  const level: Level = new Level({
    handlers: {
      trace: createClipTrace(cm),
      runItem: (item) => runItem(level, item, trace),
      runMover: (mover) => runMover(level, mover)
    },
    clipMap: cm
  });
  const prints: string[] = [];
  level.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0, print: (t) => prints.push(t) };
  spawnEntitiesFromString(
    entityTokens(text),
    () => {},
    (vars) => spawnEntityFromVars(level, vars, gametype, (line) => prints.push(line))
  );
  findTeams(level, (line) => prints.push(line));
  for (let time = 8; time <= 1000; time += 8) level.runFrame(time);
  return { level, prints };
}

/** The one entity a map of a world and this entity spawns, or undefined if it was freed. */
function only(
  entity: Record<string, string>,
  gametype: number = GT.FFA,
  rules?: Readonly<Rules>
): GameEntity | undefined {
  const { entities } = spawned(mapOf(entity), gametype, rules);
  expect(entities.length).toBeLessThanOrEqual(1);
  return entities[0];
}

describe('spawnEntitiesFromString', () => {
  it('hands the first block to the world and spawns the rest in order', () => {
    const { worlds, entities } = spawned(
      mapOf(spawnSpot(vec3(1, 2, 3), 90), { classname: 'target_position', origin: '4 5 6' })
    );
    expect(worlds).toEqual([[['classname', 'worldspawn']]]);
    expect(entities.map((entity) => entity.classname)).toEqual([
      'info_player_deathmatch',
      'target_position'
    ]);
  });

  it("refuses a text with no entities, with G_Error's words", () => {
    expect(() => spawned('')).toThrow('SpawnEntities: no entities');
    expect(() => spawned('// only a comment\n')).toThrow('SpawnEntities: no entities');
  });
});

describe('checkWorldspawn', () => {
  it('takes a world, its classname matched without regard to case', () => {
    expect(() => checkWorldspawn([['classname', 'WorldSpawn']])).not.toThrow();
  });

  it("refuses anything else first, with G_Error's words", () => {
    expect(() => checkWorldspawn([['classname', 'info_player_deathmatch']])).toThrow(
      "SP_worldspawn: The first entity isn't 'worldspawn'"
    );
    expect(() => checkWorldspawn([])).toThrow("SP_worldspawn: The first entity isn't 'worldspawn'");
  });
});

describe('the fields', () => {
  it('copies the keys it knows onto the entity, whatever their case', () => {
    const entity = only({
      CLASSNAME: 'info_player_deathmatch',
      Origin: '-4 -4 43',
      spawnflags: '1',
      target: 'aim',
      targetname: 'spot'
    })!;
    expect(entity.classname).toBe('info_player_deathmatch');
    expect(entity.s.origin).toEqual(vec3(-4, -4, 43));
    expect(entity.spawnflags).toBe(1);
    expect([entity.target, entity.targetname]).toEqual(['aim', 'spot']);
  });

  it('moves the editor origin to where the entity is', () => {
    const entity = only({ classname: 'info_player_deathmatch', origin: '1 2 3' })!;
    expect(entity.s.pos.trBase).toEqual(vec3(1, 2, 3));
    expect(entity.r.currentOrigin).toEqual(vec3(1, 2, 3));
  });

  it('takes the last of a key given twice, as each pair is copied in turn', () => {
    const text = entityText([
      { classname: 'worldspawn' },
      { classname: 'info_player_deathmatch', origin: '1 1 1' }
    ]).replace('"origin" "1 1 1"', '"origin" "1 1 1"\n"origin" "2 2 2"');
    expect(spawned(text).entities[0].s.origin).toEqual(vec3(2, 2, 2));
  });

  it("reads angle as a yaw alone, throwing away an angles' pitch and roll before it", () => {
    const yawOnly = only({ classname: 'info_player_deathmatch', angles: '10 20 30', angle: '90' })!;
    expect(yawOnly.s.angles).toEqual(vec3(0, 90, 0));
    const both = only({ classname: 'info_player_deathmatch', angle: '90', angles: '10 20 30' })!;
    expect(both.s.angles).toEqual(vec3(10, 20, 30));
    // Each a C float, as `F_ANGLEHACK` and `F_VECTOR` store them, and the origin too.
    const fine = only({ classname: 'info_player_deathmatch', angle: '22.7', origin: '0.1 0 0' })!;
    expect(fine.s.angles.y).toBe(Math.fround(22.7));
    expect(fine.s.origin.x).toBe(Math.fround(0.1));
  });

  it('reads a short vector with the rest 0', () => {
    expect(only({ classname: 'info_player_deathmatch', origin: '5 6' })!.s.origin).toEqual(
      vec3(5, 6, 0)
    );
  });

  it("copies an item's own keys: wait, random, count, team and speed", () => {
    const entity = only({
      classname: 'weapon_railgun',
      wait: '30',
      random: '5',
      count: '2',
      team: 'rail1',
      speed: '3'
    })!;
    expect([entity.wait, entity.random, entity.count, entity.team, entity.speed]).toEqual([
      30,
      5,
      2,
      'rail1',
      3
    ]);
  });

  it("copies the rest of Q3's fields: the models, message, health, dmg and the shader pair", () => {
    const entity = only({
      classname: 'target_position',
      model: '*3',
      model2: 'models/mapobjects/pad.md3',
      message: 'the pad',
      health: '50',
      dmg: '9999',
      targetShaderName: 'textures/a/b',
      TARGETSHADERNEWNAME: 'textures/a/c'
    })!;
    expect(entity.model).toBe('*3');
    expect(entity.model2).toBe('models/mapobjects/pad.md3');
    expect(entity.message).toBe('the pad');
    expect(entity.health).toBe(50);
    expect(entity.damage).toBe(9999);
    expect(entity.targetShaderName).toBe('textures/a/b');
    expect(entity.targetShaderNewName).toBe('textures/a/c');
  });

  it('stores speed, wait and random as C floats, so 0.7 is 0.699999988', () => {
    const fields = { speed: '0.7', wait: '0.7', random: '0.1' };
    const entity = only({ classname: 'target_position', ...fields })!;
    expect(entity.speed).toBe(0.699999988079071);
    expect(entity.wait).toBe(0.699999988079071);
    expect(entity.random).toBe(0.10000000149011612);
  });
});

describe('newString', () => {
  it('turns \\n into a line break, and a backslash before anything else into a lone backslash', () => {
    expect(newString('two\\nlines')).toBe('two\nlines');
    expect(newString('a\\tb')).toBe('a\\b');
    expect(newString('end\\')).toBe('end\\');
    expect(newString('plain')).toBe('plain');
  });
});

describe('the gametype keys', () => {
  const vars = (pairs: Record<string, string>): SpawnVar[] => Object.entries(pairs);

  it('takes notfree out of FFA, Tournament and Single Player, and notteam out of the team games', () => {
    for (const gametype of [GT.FFA, GT.TOURNAMENT, GT.SINGLE_PLAYER]) {
      expect(inGametype(vars({ notfree: '1' }), gametype)).toBe(false);
      expect(inGametype(vars({ notteam: '1' }), gametype)).toBe(true);
    }
    for (const gametype of [GT.TEAM, GT.CTF, GT.CA]) {
      expect(inGametype(vars({ notteam: '1' }), gametype)).toBe(false);
      expect(inGametype(vars({ notfree: '1' }), gametype)).toBe(true);
    }
  });

  it('takes notsingle out of Single Player alone, and notq3a out of every gametype', () => {
    expect(inGametype(vars({ notsingle: '1' }), GT.SINGLE_PLAYER)).toBe(false);
    expect(inGametype(vars({ notsingle: '1' }), GT.FFA)).toBe(true);
    expect(inGametype(vars({ notq3a: '1' }), GT.CTF)).toBe(false);
  });

  it('reads the keys as numbers, so 0 keeps the entity', () => {
    expect(inGametype(vars({ notfree: '0' }), GT.FFA)).toBe(true);
    expect(inGametype(vars({ notfree: 'yes' }), GT.FFA)).toBe(true);
  });

  it("keeps an entity only in the gametypes gametype names, found by substring", () => {
    expect(inGametype(vars({ gametype: 'ffa tournament' }), GT.FFA)).toBe(true);
    expect(inGametype(vars({ gametype: 'ffa tournament' }), GT.TOURNAMENT)).toBe(true);
    expect(inGametype(vars({ gametype: 'ffa tournament' }), GT.TEAM)).toBe(false);
    expect(inGametype(vars({ gametype: 'xffax' }), GT.FFA)).toBe(true);
    // Present and empty names nothing, so it keeps the entity nowhere.
    expect(inGametype(vars({ gametype: '' }), GT.FFA)).toBe(false);
    expect(inGametype(vars({}), GT.FFA)).toBe(true);
  });

  it('reads gametype for Clan Arena as for team deathmatch', () => {
    expect(inGametype(vars({ gametype: 'ffa team' }), GT.CA)).toBe(true);
    expect(inGametype(vars({ gametype: 'ctf' }), GT.CA)).toBe(false);
  });

  it('frees every item in Clan Arena, and nothing else', () => {
    expect(only({ classname: 'weapon_railgun' }, GT.CA)).toBeUndefined();
    expect(only({ classname: 'item_health_mega' }, GT.CA)).toBeUndefined();
    expect(only({ classname: 'weapon_railgun' }, GT.TEAM)).toBeDefined();
    expect(only({ classname: 'info_player_deathmatch' }, GT.CA)).toBeDefined();
  });

  it('stands the green armour only under the presets with tiers', () => {
    const jacket = { classname: 'item_armor_jacket' };
    expect(only(jacket)).toBeUndefined();
    const stands = (['vq3', 'pmc', 'cpm', 'cq3', 'dev'] as const).map(
      (name) => only(jacket, GT.FFA, presetRules(name)) !== undefined
    );
    expect(stands).toEqual([false, true, true, true, true]);
    expect(only(jacket, GT.CA, presetRules('cpm'))).toBeUndefined();
    expect(only({ classname: 'item_armor_combat' }, GT.FFA, presetRules('vq3'))).toBeDefined();
  });

  it("frees the green armour without tiers with baseq3's message, as baseq3 has none", () => {
    const jacket = mapOf({ classname: 'item_armor_jacket' });
    expect(spawned(jacket).prints).toEqual(["item_armor_jacket doesn't have a spawn function"]);
    expect(spawned(jacket, GT.FFA, presetRules('cpm')).prints).toEqual([]);
  });

  it('frees an entity the keys take out', () => {
    expect(only({ classname: 'info_player_deathmatch', notfree: '1' })).toBeUndefined();
    expect(only({ classname: 'info_player_deathmatch', notfree: '1' }, GT.TEAM)).toBeDefined();
  });
});

describe('the spawn table', () => {
  it('makes an info_player_start an info_player_deathmatch', () => {
    expect(only({ classname: 'info_player_start' })!.classname).toBe('info_player_deathmatch');
  });

  it('closes a spawn spot to bots or to humans', () => {
    expect(only({ classname: 'info_player_deathmatch', nobots: '1' })!.flags).toBe(FL.NO_BOTS);
    expect(only({ classname: 'info_player_start', nohumans: '1' })!.flags).toBe(FL.NO_HUMANS);
    expect(only({ classname: 'info_player_deathmatch' })!.flags).toBe(0);
  });

  it('keeps the points something aims at where the map put them', () => {
    for (const classname of ['target_position', 'info_notnull', 'info_camp']) {
      const entity = only({ classname, origin: '7 8 9' })!;
      expect(entity.s.pos.trBase, classname).toEqual(vec3(7, 8, 9));
      expect(entity.r.currentOrigin, classname).toEqual(vec3(7, 8, 9));
    }
    expect(only({ classname: 'info_player_intermission', origin: '1 2 3' })!.s.origin).toEqual(
      vec3(1, 2, 3)
    );
  });

  it('frees what the compiler has already used, without a word', () => {
    for (const classname of ['info_null', 'func_group', 'light', 'misc_model']) {
      const { entities, prints } = spawned(mapOf({ classname }));
      expect(entities, classname).toEqual([]);
      expect(prints, classname).toEqual([]);
    }
  });

  it("makes an item the table's entry for its classname, deferred for two frames", () => {
    const entity = only({ classname: 'weapon_rocketlauncher', origin: '1 2 3' })!;
    expect(entity.item).toBe(findItem('weapon_rocketlauncher'));
    expect(entity.classname).toBe('weapon_rocketlauncher');
    expect(entity.nextthink).toBe(FRAMETIME * 2);
    expect(entity.think).not.toBeNull();
    expect(entity.physicsBounce).toBe(0.5);
  });

  it("frees a classname it has no spawn function for, with Q3's message", () => {
    const { entities, prints } = spawned(
      mapOf(
        { classname: 'func_breakable' },
        { classname: 'INFO_PLAYER_DEATHMATCH' },
        { origin: '0 0 0' }
      )
    );
    expect(entities).toEqual([]);
    expect(prints).toEqual([
      "func_breakable doesn't have a spawn function",
      "INFO_PLAYER_DEATHMATCH doesn't have a spawn function",
      "noclass doesn't have a spawn function"
    ]);
  });
});

const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('spawning the 36 retail maps', () => {
  /**
   * Every map's entity text, and its collision with every portal shut, as a map load leaves it;
   * by name. A load is 65 ms, so each level takes the map's one clip map with its portals shut
   * again, which is all a level changes of it.
   */
  let maps: Map<string, { text: string; load: () => ClipMap }>;
  beforeAll(async () => {
    maps = await retailMaps((bytes, path) => {
      const cm = loadMap(parseBspCollision(bytes, path), path, { print: () => {} });
      const load = () => {
        cm.areaPortals.fill(0);
        floodAreaConnections(cm);
        return cm;
      };
      return { text: entityString(cm), load };
    });
  }, 60_000);

  it('spawns every map in every gametype, and keeps the spawn spots of each', () => {
    const spots = new Map<number, number>();
    for (const gametype of [GT.FFA, GT.TOURNAMENT, GT.TEAM, GT.CTF]) {
      let count = 0;
      for (const [name, { text, load }] of maps) {
        const { level } = spawned(text, gametype, undefined, load());
        for (let spot = level.find(null, 'classname', 'info_player_deathmatch'); spot; ) {
          count++;
          spot = level.find(spot, 'classname', 'info_player_deathmatch');
        }
        expect(checkWorldspawnOf(text), name).toBe(true);
      }
      spots.set(gametype, count);
    }
    // Nine of the 350 carry `notteam`, so the team games keep 341. None carries `notfree`.
    expect(Object.fromEntries(spots)).toEqual({
      [GT.FFA]: 350,
      [GT.TOURNAMENT]: 350,
      [GT.TEAM]: 341,
      [GT.CTF]: 341
    });
  });

  it("numbers the movers and their triggers as Quake 3's entitylist does", () => {
    const numbered: Record<string, string[]> = {};
    const quake3: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(QUAKE3_MOVER_NUMBERS)) {
      const { text, load } = maps.get(name)!;
      const { level } = settle(text, load());
      numbered[name] = level.gentities
        .filter((entity) => entity.inuse && MOVERS.has(entity.classname))
        .map(({ s, classname, model }) => {
          const kind = classname.replace('func_', '');
          return `${s.number}:${kind}${classname.startsWith('func_') ? model : ''}`;
        });
      quake3[name] = list.trim().split(/\s+/);
    }
    expect(numbered).toEqual(quake3);
  });

  it('settles every map as Quake 3 does', () => {
    const settled: Record<string, [number, string[]]> = {};
    for (const [name, { text, load }] of maps) {
      const { level, prints } = settle(text, load());

      const kept = level.gentities.filter(
        (entity, i) => i >= MAX_CLIENTS && entity.inuse && !entity.neverFree
      );
      settled[name] = [kept.length, prints];
    }
    expect(settled).toEqual(QUAKE3_SETTLED);
  });

  it('stands every pad on its own brush', () => {
    let pads = 0;
    for (const [name, { text, load }] of maps) {
      const { entities } = spawned(text, GT.FFA, undefined, load());
      for (const pad of entities.filter((entity) => entity.classname === 'trigger_push')) {
        pads++;
        expect(pad.r.bmodel, name).toBe(true);
        expect(pad.s.modelindex, name).toBeGreaterThan(0);
        expect(pad.s.modelindex, name).toBe(Number(pad.model!.slice(1)));
      }
    }
    expect(pads).toBe(172);
  });

  it('opens and shuts the portals of every binary mover, in every gametype, back to none', () => {
    const opened: Record<number, number> = {};
    for (const gametype of [GT.FFA, GT.TOURNAMENT, GT.TEAM, GT.CTF]) {
      opened[gametype] = 0;
      for (const [name, { text, load }] of maps) {
        const cm = load();
        const { level } = settle(text, cm, gametype);
        const masters = level.gentities.filter(
          (entity) =>
            entity.inuse && BINARY_MOVERS.has(entity.classname) && !(entity.flags & FL.TEAMMEMBER)
        );
        for (const mover of masters) mover.use!(mover, mover, mover);
        opened[gametype] += cm.areaPortals.reduce((sum, count) => sum + count, 0) / 2;

        // Each runs back to rest, one that never returns used again at the top to send it.
        let time = level.time;
        while (masters.some((mover) => mover.moverState !== MOVER.POS1)) {
          for (const mover of masters) {
            if (mover.moverState === MOVER.POS2 && mover.wait < 0) mover.use!(mover, mover, mover);
          }
          time += Q3_FRAME_MSEC;
          level.runFrame(time);
          if (time > 60_000) throw new Error(`${name}: a mover never came to rest`);
        }
        expect(cm.areaPortals.every((count) => count === 0), name).toBe(true);
      }
    }
    // The masters across two areas, the same in each gametype: q3dm12's 14, q3tourney4's and
    // pro-q3tourney4's 6, q3ctf2's 4, q3dm14's 3, q3dm8's 2, and q3dm0's and q3dm2's one.
    expect(opened).toEqual({ [GT.FFA]: 37, [GT.TOURNAMENT]: 37, [GT.TEAM]: 37, [GT.CTF]: 37 });
  });

  it("spawns q3dm17's items, its jump pads and its points, with no word for any", () => {
    const { text, load } = maps.get('q3dm17')!;
    const { level, prints } = spawned(text, GT.FFA, undefined, load());
    const classnames = new Set(prints.map((line) => line.replace(" doesn't have a spawn function", '')));
    expect(classnames.has('weapon_railgun')).toBe(false);
    expect(classnames.has('trigger_push')).toBe(false);
    // The pad stands as a trigger, waiting for its think to solve the apex from its target.
    expect(level.find(null, 'classname', 'trigger_push')).not.toBeNull();
    // The railgun stands by its table entry, waiting for the third frame to be put in the world.
    const railgun = level.find(null, 'classname', 'weapon_railgun')!;
    expect(railgun.item).toBe(findItem('weapon_railgun'));
    expect(railgun.nextthink).toBe(FRAMETIME * 2);
    expect(level.itemsRegistered[14]).toBe(true);
    for (const classname of ['info_player_deathmatch', 'info_player_intermission', 'target_position']) {
      expect(classnames.has(classname), classname).toBe(false);
    }
  });
});

/** The movers `Use_BinaryMover` runs, which open and close their portals. */
const BINARY_MOVERS = new Set(['func_door', 'func_plat', 'func_button']);

/** The classes of `g_mover.c`, and the triggers its movers spawn. */
const MOVERS = new Set([
  'func_door',
  'func_plat',
  'func_button',
  'func_train',
  'path_corner',
  'func_static',
  'func_rotating',
  'func_bobbing',
  'func_pendulum',
  'door_trigger',
  'plat_trigger'
]);

/**
 * Where Quake 3's `entitylist` numbers each mover and trigger, a second into a free-for-all, on
 * every retail map with a mover (scratchpad `m4/d-q3-numbers.txt`). A door's trigger is spawned a
 * frame in, after every entity of the map.
 */
const QUAKE3_MOVER_NUMBERS: Record<string, string> = {
  'pro-q3tourney4': `
    99:door*2 100:door*3 102:door*4 103:door*5 104:door*6 105:door*7 106:door*8 107:door*9
    108:door*10 109:door*11 110:door*12 111:door*13 200:door_trigger 201:door_trigger
    202:door_trigger 203:door_trigger 204:door_trigger 205:door_trigger
  `,
  q3ctf1: `
    98:door*2 99:door*3 100:door*4 101:door*5 237:door_trigger 238:door_trigger
  `,
  q3ctf2: `
    84:static*5 85:static*6 86:static*7 87:static*8 88:static*9 89:static*10 90:static*11
    91:static*12 92:static*13 93:static*14 94:static*15 148:door*19 151:door*20 152:door*21
    153:door*22 154:door*23 155:door*24 167:door*25 168:door*26 238:door*32 241:door*33
    242:door*34 243:door*35 244:door*36 245:door*37 257:door*38 258:door*39 364:static*41
    365:static*42 366:static*43 367:static*44 368:static*45 369:static*46 370:static*47
    371:static*48 372:static*49 410:door_trigger 411:door_trigger 412:door_trigger
    413:door_trigger 414:door_trigger 415:door_trigger 416:door_trigger 417:door_trigger
  `,
  q3ctf4: `
    90:bobbing*13
  `,
  q3dm0: `
    131:rotating*10 134:rotating*11 146:door*12 147:door*13 148:door_trigger
  `,
  q3dm10: `
    74:static*1
  `,
  q3dm11: `
    73:static*1 75:static*2 81:door*4 82:door*5 83:rotating*6 86:static*7 100:door*10
    101:door*11 105:static*14 106:static*15 122:button*18 169:door*20 321:rotating*27
    335:door_trigger 336:door_trigger
  `,
  q3dm12: `
    100:door*3 101:door*4 102:static*5 103:static*6 104:static*7 150:door*9 163:door*10
    164:door*11 165:door*12 166:door*13 167:door*14 175:door*18 177:door*20 178:door*21
    220:door*41 221:door*42 222:door*43 223:door*44 225:door*45 226:door*46 227:door*47
    228:door*48 229:door*49 230:door*50 231:door*51 232:door*52 233:door*53 234:door*54
    235:door*55 236:door*56 237:door*57 238:door*58 239:door*59 314:door*60 315:door*61
    316:door*62 317:door*63 329:door_trigger 330:door_trigger 331:door_trigger 332:door_trigger
    333:door_trigger 334:door_trigger 335:door_trigger 336:door_trigger 337:door_trigger
    338:door_trigger 339:door_trigger 340:door_trigger 341:door_trigger 342:door_trigger
    343:door_trigger 344:door_trigger 345:door_trigger
  `,
  q3dm14: `
    77:bobbing*2 133:door*9 134:door*10 136:door*11 137:door*12 138:door*13 139:door*14
    177:door*15 178:door*16 276:door_trigger 277:door_trigger 278:door_trigger 279:door_trigger
  `,
  q3dm15: `
    165:pendulum*12 166:pendulum*13 171:pendulum*15
  `,
  q3dm19: `
    72:bobbing*1 73:bobbing*2 74:bobbing*3 75:bobbing*4 76:bobbing*5 77:bobbing*6 78:bobbing*7
    79:bobbing*8 80:bobbing*9 81:bobbing*10 82:bobbing*11 83:bobbing*12
  `,
  q3dm2: `
    96:door*1 97:door*2 119:door_trigger
  `,
  q3dm7: `
    140:door*5 167:door*6 168:button*7
  `,
  q3dm8: `
    72:static*1 73:static*3 74:static*4 75:static*5 76:static*6 77:static*7 84:static*8
    85:static*9 86:static*10 87:static*11 141:door*17 147:door*18 148:door*19 149:door*20
    150:door*21 151:door*22 179:door*23 180:door*24 227:static*25 228:static*26 230:door_trigger
    231:door_trigger 232:door_trigger 233:door_trigger
  `,
  q3tourney3: `
    78:static*1 79:static*2 80:static*3 81:static*4
  `,
  q3tourney4: `
    95:door*2 96:door*3 98:door*4 99:door*5 100:door*6 101:door*7 102:door*8 103:door*9
    104:door*10 105:door*11 106:door*12 107:door*13 188:door_trigger 189:door_trigger
    190:door_trigger 191:door_trigger 192:door_trigger 193:door_trigger
  `,
  q3tourney6: `
    78:door*3 79:door*4 82:door*5 83:bobbing*6 87:button*7 127:bobbing*18 142:bobbing*20
    147:static*21
  `,
  q3tourney6_ctf: `
    87:door*3 88:door*4 91:door*5 92:bobbing*6 95:button*7 127:bobbing*18 135:bobbing*20
    140:static*21
  `
};

/** The podium's spots, which baseq3's spawn table has not got. */
const PODIUM = [
  "info_firstplace doesn't have a spawn function",
  "info_secondplace doesn't have a spawn function",
  "info_thirdplace doesn't have a spawn function"
];

/** `info_spectator_start`, which baseq3's spawn table has not got either. */
const SPECTATOR_START = "info_spectator_start doesn't have a spawn function";

/** `G_FindTeams`' line (`g_main.c:315`). */
function teams(count: number, entities: number): string {
  return `${count} teams with ${entities} entities`;
}

/**
 * Each retail map a second in, in free-for-all, as Quake 3 has it: the map's entities still in use,
 * and what the game printed. Taken from Quake 3's own `entitylist` and console after a `devmap` of
 * each (scratchpad `m3c/q3-ents.mjs`), where the rest matched the port's entity for entity, in
 * order. On `q3dm0` and `q3tourney5` a player arriving sets off a one-shot `trigger_multiple`,
 * which then frees itself; with no player, it stays.
 */
const QUAKE3_SETTLED: Record<string, [number, string[]]> = {
  'pro-q3dm13': [85, [teams(0, 0)]],
  'pro-q3dm6': [153, [teams(0, 0)]],
  'pro-q3tourney2': [114, [teams(0, 0), 'G_PickTarget: target t10 not found']],
  'pro-q3tourney4': [134, [teams(6, 12)]],
  q3ctf1: [167, [teams(2, 4)]],
  q3ctf2: [
    346,
    [
      'func_timer at (1032 328 -200) has random >= wait',
      'func_timer at (-920 -888 -200) has random >= wait',
      teams(8, 16)
    ]
  ],
  q3ctf3: [267, [teams(2, 11)]],
  q3ctf4: [112, [teams(0, 0)]],
  q3dm0: [77, [teams(1, 2)]],
  q3dm1: [58, [teams(0, 0)]],
  q3dm10: [96, [PODIUM[1], PODIUM[2], PODIUM[0], teams(1, 3)]],
  q3dm11: [
    264,
    [
      teams(1, 2),
      'G_PickTarget called with NULL targetname',
      'FinishSpawningItem: ammo_rockets startsolid at (-736 -920 16)'
    ]
  ],
  q3dm12: [274, [teams(17, 34)]],
  q3dm13: [85, [teams(0, 0)]],
  q3dm14: [208, [teams(4, 8)]],
  q3dm15: [202, [teams(0, 0)]],
  q3dm16: [105, [teams(0, 0)]],
  q3dm17: [95, [teams(0, 0)]],
  q3dm18: [92, [PODIUM[1], PODIUM[2], PODIUM[0], teams(1, 2)]],
  q3dm19: [63, [teams(1, 1)]],
  q3dm2: [48, [teams(1, 2)]],
  q3dm3: [43, [...Array<string>(4).fill(SPECTATOR_START), teams(1, 3)]],
  q3dm4: [108, [PODIUM[2], PODIUM[0], PODIUM[1], teams(0, 0)]],
  q3dm5: [62, [...Array<string>(3).fill(SPECTATOR_START), teams(0, 0)]],
  q3dm6: [149, [teams(0, 0)]],
  q3dm7: [198, [...PODIUM, teams(0, 0)]],
  q3dm8: [162, [teams(5, 10)]],
  q3dm9: [150, [teams(0, 0)]],
  q3tourney1: [89, [teams(1, 2)]],
  q3tourney2: [97, [teams(0, 0)]],
  q3tourney3: [62, [teams(0, 0)]],
  q3tourney4: [122, [teams(6, 12)]],
  q3tourney5: [43, [teams(0, 0)]],
  q3tourney6: [83, [teams(2, 5), 'G_PickTarget: target t187 not found']],
  q3tourney6_ctf: [108, [teams(2, 4), 'G_PickTarget: target t187 not found']],
  test_bigbox: [1, [teams(0, 0)]]
};

/** Whether a text's first block is a world. */
function checkWorldspawnOf(text: string): boolean {
  let ok = false;
  spawnEntitiesFromString(
    entityTokens(text),
    (vars) => {
      checkWorldspawn(vars);
      ok = true;
    },
    () => {}
  );
  return ok;
}
