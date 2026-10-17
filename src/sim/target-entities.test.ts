import { describe, expect, it } from 'vitest';

import { CONFIGSTRING } from '../net/commands';
import { CON } from './client';
import { CONTENTS, FL, MOD, TEAM } from './constants';
import { EV, eventNumber } from './events';
import { ET, SVF, type GameEntity } from './game-entity';
import { PW } from './items';
import type { Level } from './level';
import type { TestEntity } from './map-test-fixtures';
import {
  LASER_DAMAGE,
  LASER_START_ON,
  LOCATION_LINKUP_DELAY,
  PRINT_BLUE_TEAM,
  PRINT_PRIVATE,
  PRINT_RED_TEAM,
  RELAY_BLUE_ONLY,
  RELAY_RANDOM,
  RELAY_RED_ONLY,
  SPEAKER_ACTIVATOR,
  SPEAKER_GLOBAL,
  SPEAKER_LOOPED_OFF,
  SPEAKER_LOOPED_ON
} from './target-entities';
import {
  clientAt,
  newRecord,
  recordingLevel,
  runUntil,
  spawnedLevel,
  spawnInto,
  useRecorder,
  type LevelRecord
} from './trigger-test-fixtures';
import type { TraceFn, TraceResult } from './types';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * `g_target.c`'s targets, each spawned from a map's pairs and fired as a map fires them. The
 * laser's aim is ioquake3's C in q3lcc's floats, compiled and printed (scratchpad `m3c/twin.c`).
 */

/** The first entity of a classname in a level. */
function first(world: Level, classname: string): GameEntity {
  return world.find(null, 'classname', classname)!;
}

/** Fire an entity as a trigger would: from a stand-in, for `activator`, or for no one. */
function fire(world: Level, target: GameEntity, activator: GameEntity | null): void {
  target.use!(target, world.gentities[world.numEntities - 1], activator);
}

/** Something that is not a player, to set a target off. */
function thing(world: Level): GameEntity {
  const entity = world.spawnEntity();
  entity.classname = 'test_thing';
  return entity;
}

describe('target_give', () => {
  /** A target giving a quad that stands hidden, its item spawned and finished. */
  function giving() {
    const world = spawnedLevel([
      { classname: 'target_give', target: 'g1' },
      // Suspended, so it finishes without a floor to fall to; named, so it is not in the world.
      { classname: 'item_quad', targetname: 'g1', origin: '0 0 64', spawnflags: '1' },
      { classname: 'target_position', targetname: 'g1', origin: '0 0 0' }
    ]);
    runUntil(world, 304);
    return { world, give: first(world, 'target_give'), quad: first(world, 'item_quad') };
  }

  it('gives a player the items it names, as a pickup, and takes each out for good', () => {
    const { world, give, quad } = giving();
    expect(quad.s.eFlags).not.toBe(0);
    const walker = clientAt(world, 0, vec3(500, 0, 0));

    fire(world, give, walker);
    expect(walker.client!.ps.powerups[PW.QUAD]).toBeGreaterThan(0);
    // Picked up: hidden from the clients, and never back.
    expect(quad.r.svFlags & SVF.NOCLIENT).toBe(SVF.NOCLIENT);
    expect(quad.nextthink).toBe(0);
    expect(quad.r.linked).toBe(false);
  });

  it('gives nothing to what is not a player', () => {
    const { world, give, quad } = giving();
    fire(world, give, thing(world));
    expect(quad.r.svFlags & SVF.NOCLIENT).toBe(0);
  });
});

describe('target_remove_powerups', () => {
  it('takes every powerup, flight and all', () => {
    const world = spawnedLevel([{ classname: 'target_remove_powerups' }]);
    const walker = clientAt(world, 0, vec3());
    const { powerups } = walker.client!.ps;
    powerups[PW.FLIGHT] = 30000;
    powerups[PW.QUAD] = 20000;
    powerups[15] = 1;
    fire(world, first(world, 'target_remove_powerups'), walker);
    expect(powerups.every((p) => p === 0)).toBe(true);
  });

  it.each([
    ['red', PW.REDFLAG, 'RED'],
    ['blue', PW.BLUEFLAG, 'BLUE']
  ])('sends a carried %s flag home first', (_name, flag, team) => {
    const record = newRecord();
    const world = spawnedLevel([{ classname: 'target_remove_powerups' }], record);
    const walker = clientAt(world, 0, vec3());
    walker.client!.ps.powerups[flag] = 1;
    fire(world, first(world, 'target_remove_powerups'), walker);
    const returned = `The ${team} flag has returned!`;
    expect(record.commands.some(([, text]) => text.includes(returned))).toBe(true);
    expect(walker.client!.ps.powerups[flag]).toBe(0);
  });

  it('does nothing to what is not a player', () => {
    const world = spawnedLevel([{ classname: 'target_remove_powerups' }]);
    expect(() => fire(world, first(world, 'target_remove_powerups'), thing(world))).not.toThrow();
  });
});

describe('target_delay', () => {
  it.each([
    [{ wait: '2' }, 2],
    [{ delay: '3', wait: '2' }, 3],
    [{ delay: '0' }, 1],
    [{}, 1]
  ])('waits by delay before wait, a second for none: %j is %f', (keys, wait) => {
    const delay = first(spawnedLevel([{ classname: 'target_delay', ...keys }]), 'target_delay');
    expect(delay.wait).toBe(wait);
  });

  it('fires its targets for whoever set it off, its wait after, a second use the later', () => {
    const world = spawnedLevel([{ classname: 'target_delay', target: 't1', wait: '0.7' }]);
    const fired = useRecorder(world, 't1');
    const delay = first(world, 'target_delay');
    const walker = clientAt(world, 4, vec3());

    runUntil(world, 96);
    fire(world, delay, walker);
    expect(delay.nextthink).toBe(796);
    runUntil(world, 400);
    fire(world, delay, walker);
    expect(delay.nextthink).toBe(1100);
    runUntil(world, 1096);
    expect(fired).toEqual([]);
    runUntil(world, 1104);
    expect(fired).toEqual([{ other: delay.s.number, activator: 4 }]);
  });
});

describe('target_score', () => {
  it('scores its count for whoever set it off, 1 when it has none', () => {
    const record = newRecord();
    const world = spawnedLevel(
      [
        { classname: 'target_score', targetname: 'a' },
        { classname: 'target_score', targetname: 'b', count: '5' }
      ],
      record
    );
    const walker = clientAt(world, 2, vec3());
    fire(world, world.find(null, 'targetname', 'a')!, walker);
    fire(world, world.find(null, 'targetname', 'b')!, walker);
    expect(record.scores).toEqual([
      [2, 1],
      [2, 5]
    ]);
  });
});

describe('target_print', () => {
  /** A print with these spawnflags, fired by `activator` in a level of three connected players. */
  function printed(spawnflags: number, by: 'player' | 'thing', message = 'Hello\\nthere') {
    const record = newRecord();
    const world = spawnedLevel(
      [{ classname: 'target_print', message, spawnflags: String(spawnflags) }],
      record
    );
    const red = clientAt(world, 0, vec3());
    red.client!.sess.sessionTeam = TEAM.RED;
    clientAt(world, 1, vec3()).client!.sess.sessionTeam = TEAM.BLUE;
    clientAt(world, 2, vec3()).client!.sess.sessionTeam = TEAM.RED;
    // A red player still connecting is not sent a team's print.
    const late = clientAt(world, 3, vec3());
    late.client!.sess.sessionTeam = TEAM.RED;
    late.client!.pers.connected = CON.CONNECTING;
    fire(world, first(world, 'target_print'), by === 'player' ? red : thing(world));
    return record.commands;
  }

  it('prints to everyone, its \\n a line break', () => {
    expect(printed(0, 'player')).toEqual([[null, 'cp "Hello\nthere"']]);
  });

  it('prints to the player who set it off alone when private', () => {
    expect(printed(PRINT_PRIVATE, 'player')).toEqual([[0, 'cp "Hello\nthere"']]);
  });

  it('prints to the connected players of a side, or of both', () => {
    expect(printed(PRINT_RED_TEAM, 'player')).toEqual([
      [0, 'cp "Hello\nthere"'],
      [2, 'cp "Hello\nthere"']
    ]);
    expect(printed(PRINT_RED_TEAM | PRINT_BLUE_TEAM, 'player').map(([to]) => to)).toEqual([
      0, 2, 1
    ]);
  });

  it('prints a private print set off by no player by its other flags', () => {
    expect(printed(PRINT_PRIVATE, 'thing')).toEqual([[null, 'cp "Hello\nthere"']]);
    expect(printed(PRINT_PRIVATE | PRINT_BLUE_TEAM, 'thing')).toEqual([[1, 'cp "Hello\nthere"']]);
  });

  it('prints <NULL> with no message, as the QVM writes a null string', () => {
    const record = newRecord();
    const world = spawnedLevel([{ classname: 'target_print' }], record);
    fire(world, first(world, 'target_print'), thing(world));
    expect(record.commands).toEqual([[null, 'cp "<NULL>"']]);
  });
});

describe('target_speaker', () => {
  /** A speaker with these keys, and what its level registered. */
  function speaker(keys: Record<string, string>) {
    const record = newRecord();
    const world = spawnedLevel(
      [{ classname: 'target_speaker', origin: '8 16 24', noise: 'sound/world/x', ...keys }],
      record
    );
    return { world, record, speaker: first(world, 'target_speaker') };
  }

  it("stops a map whose speaker has no noise, in G_Error's words", () => {
    expect(() =>
      spawnedLevel([{ classname: 'target_speaker', origin: '8.5 16 -24' }])
    ).toThrow('target_speaker without a noise key at (8 16 -24)');
  });

  it('registers its sound, with .wav added by a case-sensitive search', () => {
    expect(speaker({ noise: 'sound/world/x' }).record.sounds).toEqual(['sound/world/x.wav']);
    expect(speaker({ noise: 'sound/world/x.wav' }).record.sounds).toEqual(['sound/world/x.wav']);
    expect(speaker({ noise: 'sound/world/X.WAV' }).record.sounds).toEqual([
      'sound/world/X.WAV.wav'
    ]);
  });

  it('cuts a path to 63 characters, saying so when it added the .wav', () => {
    const long = `sound/${'a'.repeat(60)}`;
    const { record } = speaker({ noise: long });
    expect(record.sounds).toEqual([`${long}.wav`.slice(0, 63)]);
    expect(record.prints).toEqual(['Com_sprintf: Output length 64 too short, require 71 bytes.']);
  });

  it('is sent to the clients as a speaker carrying its sound, its repeat in tenths, linked', () => {
    const { speaker: entity } = speaker({ wait: '0.7', random: '0.9' });
    expect(entity.s.eType).toBe(ET.SPEAKER);
    expect(entity.s.eventParm).toBe(1);
    // As the QVM's floats make them: (int)(0.7f * 10) and (int)(0.9f * 10), where doubles would
    // make 6 and 8.
    expect(entity.s.frame).toBe(7);
    expect(entity.s.clientNum).toBe(9);
    expect(entity.s.loopSound).toBe(0);
    expect(entity.s.pos.trBase).toEqual(vec3(8, 16, 24));
    expect(entity.r.linked).toBe(true);
    expect(entity.r.svFlags).toBe(0);
    expect(entity.r.contents).toBe(0);
  });

  it('loops from the start when LOOPED_ON, and is heard everywhere when GLOBAL', () => {
    expect(speaker({ spawnflags: String(SPEAKER_LOOPED_ON) }).speaker.s.loopSound).toBe(1);
    expect(speaker({ spawnflags: String(SPEAKER_GLOBAL) }).speaker.r.svFlags).toBe(SVF.BROADCAST);
  });

  it("is the activator's for a player's own * sound", () => {
    expect(speaker({ noise: '*falling1.wav' }).speaker.spawnflags).toBe(SPEAKER_ACTIVATOR);
  });

  it('turns a loop on and off at each use, global and activator alike', () => {
    for (const flags of [SPEAKER_LOOPED_ON, SPEAKER_LOOPED_OFF | SPEAKER_GLOBAL]) {
      const { world, speaker: entity } = speaker({ spawnflags: String(flags) });
      const before = entity.s.loopSound;
      fire(world, entity, thing(world));
      expect(entity.s.loopSound, `spawnflags ${flags}`).toBe(before ? 0 : 1);
      expect(entity.s.event).toBe(0);
      fire(world, entity, thing(world));
      expect(entity.s.loopSound).toBe(before);
    }
  });

  it('plays once where it stands, everywhere, or on the activator when fired', () => {
    const plain = speaker({});
    fire(plain.world, plain.speaker, thing(plain.world));
    expect(eventNumber(plain.speaker.s.event)).toBe(EV.GENERAL_SOUND);
    expect(plain.speaker.s.eventParm).toBe(1);

    const global = speaker({ spawnflags: String(SPEAKER_GLOBAL) });
    fire(global.world, global.speaker, thing(global.world));
    expect(eventNumber(global.speaker.s.event)).toBe(EV.GLOBAL_SOUND);

    const own = speaker({ spawnflags: String(SPEAKER_ACTIVATOR | SPEAKER_GLOBAL) });
    const walker = clientAt(own.world, 0, vec3());
    fire(own.world, own.speaker, walker);
    expect(own.speaker.s.event).toBe(0);
    expect(eventNumber(walker.client!.ps.externalEvent)).toBe(EV.GENERAL_SOUND);
    expect(walker.client!.ps.externalEventParm).toBe(1);
  });
});

describe('target_laser', () => {
  /**
   * A level whose map is empty, so a beam meets only the entities linked in it, and the traces
   * asked of the map.
   */
  function lasered(entities: TestEntity[]) {
    const record: LevelRecord = newRecord();
    const asked: { start: Vec3; end: Vec3; pass: number; mask: number }[] = [];
    const trace: TraceFn = (start, _mins, _maxs, end, pass, mask) => {
      asked.push({ start, end, pass, mask });
      return { ...MISS, endpos: copy(end) };
    };
    const world = spawnInto(recordingLevel(record, () => 0.5, { trace }), entities, record);
    return { world, record, asked, laser: first(world, 'target_laser') };
  }

  const MISS: TraceResult = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    normal: vec3(),
    contents: 0,
    surfaceFlags: 0,
    entityNum: 1023
  };

  it('starts a frame after the map, off, as a beam that hurts 1 a hit', () => {
    const { world, laser } = lasered([{ classname: 'target_laser', angle: '90' }]);
    expect(laser.nextthink).toBe(100);
    runUntil(world, 104);
    expect(laser.s.eType).toBe(ET.BEAM);
    expect(laser.damage).toBe(LASER_DAMAGE);
    expect(laser.r.linked).toBe(false);
    expect(laser.nextthink).toBe(0);
    // Its angle made its direction, and was cleared.
    expect(laser.s.angles).toEqual(vec3());
    expect(laser.movedir.y).toBe(1);
  });

  it('hurts what it falls on, with no knock, and is sent from where it stands to its end', () => {
    const { world, asked, laser } = lasered([
      { classname: 'target_laser', origin: '0 0 64', angle: '0', dmg: '4', spawnflags: '1' }
    ]);
    const victim = clientAt(world, 5, vec3(300, 0, 64));
    const velocity = { ...victim.client!.ps.velocity };
    runUntil(world, 104);

    expect(asked[0]).toEqual({
      start: vec3(0, 0, 64),
      end: vec3(2048, 0, 64),
      pass: laser.s.number,
      mask: CONTENTS.SOLID | CONTENTS.BODY | CONTENTS.CORPSE
    });
    expect(victim.health).toBe(96);
    expect(victim.client!.lasthurtMod).toBe(MOD.TARGET_LASER);
    // Its own doing, as nobody turned it on.
    expect(victim.client!.lasthurtClient).toBe(laser.s.number);
    expect(victim.client!.ps.velocity).toEqual(velocity);
    expect(laser.r.linked).toBe(true);
    // Stopped on the near face of the victim's box, at x 285, short of it as a trace stops.
    expect(laser.s.origin2).toEqual(vec3(284.875, 0, 64));
    expect(laser.s.pos.trBase).toEqual(vec3(0, 0, 64));
  });

  it('never hurts the first client, as Quake 3 hurts only a non-zero entity', () => {
    const { world } = lasered([
      { classname: 'target_laser', origin: '0 0 64', spawnflags: String(LASER_START_ON) }
    ]);
    const victim = clientAt(world, 0, vec3(300, 0, 64));
    runUntil(world, 104);
    expect(victim.health).toBe(100);
  });

  it('hurts every 100 ms on Quake 3’s frames at the port’s 8 ms tick', () => {
    const { world, laser } = lasered([
      { classname: 'target_laser', origin: '0 0 64', spawnflags: '1' }
    ]);
    const victim = clientAt(world, 5, vec3(300, 0, 64));
    const times: number[] = [];
    for (let time = 8; time <= 600; time += 8) {
      const before = victim.health;
      world.runFrame(time);
      if (victim.health < before) times.push(time);
    }
    // At 100 when it starts, then on each Quake 3 frame of 100 ms after.
    expect(times).toEqual([104, 200, 304, 400, 504, 600]);
    expect(laser.nextthink).toBe(700);
  });

  it('aims at the middle of its target’s box where it spawned, in the QVM’s floats', () => {
    const { world, record, asked, laser } = lasered([
      { classname: 'target_laser', origin: '100.5 20 30', target: 'eye', spawnflags: '1' },
      { classname: 'info_notnull', targetname: 'eye', origin: '300 -40 64' }
    ]);
    const eye = world.find(null, 'targetname', 'eye')!;
    eye.r.mins = vec3(-15, -15, -24);
    eye.r.maxs = vec3(15, 15, 32);
    // Moved since it spawned, which the aim does not follow.
    eye.r.currentOrigin = vec3(0, 0, 0);
    runUntil(world, 104);

    expect(laser.enemy).toBe(eye);
    expect(laser.movedir).toEqual(
      vec3(0.94208377599716187, -0.28333348035812378, 0.17944453656673431)
    );
    expect(asked[0].end).toEqual(vec3(2029.8875732421875, -560.2669677734375, 397.50241088867188));
    expect(record.prints).toEqual([]);
  });

  it('says so of a target that names nothing, and reaches nowhere', () => {
    const { world, record, asked } = lasered([
      { classname: 'target_laser', origin: '1 2 3', target: 'gone', spawnflags: '1' }
    ]);
    runUntil(world, 104);
    expect(record.prints).toEqual(['target_laser at (1 2 3): gone is a bad target']);
    expect(asked[0].end).toEqual(vec3(1, 2, 3));
  });

  it('turns off and on at a use, on for whoever set it off', () => {
    const { world, laser } = lasered([{ classname: 'target_laser' }]);
    runUntil(world, 104);
    const walker = clientAt(world, 3, vec3());

    fire(world, laser, walker);
    expect(laser.activator).toBe(walker);
    expect(laser.r.linked).toBe(true);
    expect(laser.nextthink).toBe(200);
    fire(world, laser, walker);
    expect(laser.r.linked).toBe(false);
    expect(laser.nextthink).toBe(0);
  });
});

describe('target_relay', () => {
  it('passes a firing on to its targets', () => {
    const world = spawnedLevel([{ classname: 'target_relay', target: 't1' }]);
    const fired = useRecorder(world, 't1');
    const relay = first(world, 'target_relay');
    const walker = clientAt(world, 1, vec3());
    fire(world, relay, walker);
    expect(fired).toEqual([{ other: relay.s.number, activator: 1 }]);
  });

  it.each([
    ['RED_ONLY', RELAY_RED_ONLY, TEAM.RED, TEAM.BLUE],
    ['BLUE_ONLY', RELAY_BLUE_ONLY, TEAM.BLUE, TEAM.RED]
  ])('under %s passes on for that side and for no player, not the other', (_, flag, ours, foe) => {
    const world = spawnedLevel([
      { classname: 'target_relay', target: 't1', spawnflags: String(flag) }
    ]);
    const fired = useRecorder(world, 't1');
    const relay = first(world, 'target_relay');
    const them = clientAt(world, 0, vec3());
    them.client!.sess.sessionTeam = foe;
    const us = clientAt(world, 1, vec3());
    us.client!.sess.sessionTeam = ours;
    const rock = thing(world);

    fire(world, relay, them);
    fire(world, relay, us);
    fire(world, relay, rock);
    expect(fired.map(({ activator }) => activator)).toEqual([1, rock.s.number]);
  });

  it('passes on to one of its targets at random when RANDOM, as the target was fired', () => {
    for (const [draw, picked] of [
      [0, 'a'],
      [0.75, 'b']
    ] as const) {
      const world = spawnedLevel(
        [{ classname: 'target_relay', target: 't1', spawnflags: String(RELAY_RANDOM) }],
        newRecord(),
        () => draw
      );
      const a = useRecorder(world, 't1');
      const b = useRecorder(world, 't1');
      const relay = first(world, 'target_relay');
      fire(world, relay, relay);
      expect({ a: a.length, b: b.length }, `draw ${draw}`).toEqual(
        picked === 'a' ? { a: 1, b: 0 } : { a: 0, b: 1 }
      );
      expect([...a, ...b][0].other).toBe(relay.s.number);
    }
  });
});

describe('target_kill', () => {
  it('kills whoever set it off as a telefrag, past god', () => {
    const world = spawnedLevel([{ classname: 'target_kill' }]);
    const walker = clientAt(world, 0, vec3());
    walker.flags |= FL.GODMODE;
    fire(world, first(world, 'target_kill'), walker);
    expect(walker.health).toBe(-999);
    expect(walker.client!.lasthurtMod).toBe(MOD.TELEFRAG);
  });
});

describe("a firing for no one, as a train's corner fires", () => {
  it('gives, takes, scores and kills nothing, and throws nothing', () => {
    const record = newRecord();
    const world = spawnedLevel(
      [
        { classname: 'target_give', target: 'g1' },
        { classname: 'item_quad', targetname: 'g1', origin: '0 0 64', spawnflags: '1' },
        { classname: 'target_remove_powerups' },
        { classname: 'target_score' },
        { classname: 'target_kill' }
      ],
      record
    );
    runUntil(world, 304);
    for (const classname of [
      'target_give',
      'target_remove_powerups',
      'target_score',
      'target_kill'
    ]) {
      expect(() => fire(world, first(world, classname), null), classname).not.toThrow();
    }
    expect(first(world, 'item_quad').r.svFlags & SVF.NOCLIENT).toBe(0);
    expect(record.scores).toEqual([]);
  });

  it("prints a private print to everyone, and plays an activator's sound nowhere", () => {
    const record = newRecord();
    const world = spawnedLevel(
      [
        { classname: 'target_print', message: 'hi', spawnflags: String(PRINT_PRIVATE) },
        {
          classname: 'target_speaker',
          noise: 'sound/world/x',
          spawnflags: String(SPEAKER_ACTIVATOR)
        }
      ],
      record
    );
    fire(world, first(world, 'target_print'), null);
    expect(record.commands).toEqual([[null, 'cp "hi"']]);
    const speaker = first(world, 'target_speaker');
    expect(() => fire(world, speaker, null)).not.toThrow();
    expect(speaker.s.event).toBe(0);
  });

  it("passes the no one on through a side's relay and a delay", () => {
    const world = spawnedLevel([
      { classname: 'target_relay', target: 't1', spawnflags: String(RELAY_RED_ONLY) },
      { classname: 'target_delay', target: 't1', wait: '0.5' }
    ]);
    const fired = useRecorder(world, 't1');
    const relay = first(world, 'target_relay');
    const delay = first(world, 'target_delay');

    fire(world, relay, null);
    fire(world, delay, null);
    runUntil(world, 504);
    expect(fired).toEqual([
      { other: relay.s.number, activator: null },
      { other: delay.s.number, activator: null }
    ]);
  });
});

describe('target_location', () => {
  /** A level with `count` locations, every one named but the second, linked up. */
  function located(count: number) {
    const record = newRecord();
    const locations = Array.from({ length: count }, (_, i) => ({
      classname: 'target_location',
      origin: `${i} 0 0`,
      ...(i === 1 ? {} : { message: `place ${i + 1}` })
    }));
    const world = spawnedLevel(locations, record);
    runUntil(world, LOCATION_LINKUP_DELAY - 8);
    expect(record.configstrings.size).toBe(0);
    runUntil(world, LOCATION_LINKUP_DELAY);
    return { world, record };
  }

  it('numbers every location from 1 into CS_LOCATIONS once they have all spawned', () => {
    const { world, record } = located(3);
    expect(Object.fromEntries(record.configstrings)).toEqual({
      [CONFIGSTRING.LOCATIONS]: 'unknown',
      [CONFIGSTRING.LOCATIONS + 1]: 'place 1',
      [CONFIGSTRING.LOCATIONS + 2]: '',
      [CONFIGSTRING.LOCATIONS + 3]: 'place 3'
    });
    const numbers = world.gentities.filter((e) => e.classname === 'target_location');
    expect(numbers.map((e) => e.health)).toEqual([1, 2, 3]);
    expect(world.locationLinked).toBe(true);
  });

  it('chains them through nextTrain, the last at the head', () => {
    const { world } = located(3);
    const chain: number[] = [];
    for (let at = world.locationHead; at; at = at.nextTrain) chain.push(at.health);
    expect(chain).toEqual([3, 2, 1]);
  });

  it('writes past the 63 CS_LOCATIONS holds into CS_PARTICLES, as Quake 3 does', () => {
    const { record } = located(65);
    expect(CONFIGSTRING.LOCATIONS + 64).toBe(CONFIGSTRING.PARTICLES);
    expect(record.configstrings.get(CONFIGSTRING.PARTICLES)).toBe('place 64');
    expect(record.configstrings.get(CONFIGSTRING.PARTICLES + 1)).toBe('place 65');
  });

  it('stands where the map put it, out of the world', () => {
    const { world } = located(1);
    const place = first(world, 'target_location');
    expect(place.r.currentOrigin).toEqual(vec3(0, 0, 0));
    expect(place.r.linked).toBe(false);
  });
});
