import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { CONTENTS, FL, MOD, STAT, TEAM } from './constants';
import { SOLID_BMODEL } from './entity-solid';
import { EV } from './events';
import { ET, setEntityOrigin, SVF, type GameEntity } from './game-entity';
import { FRAMETIME } from './item-spawn';
import { findItem, itemIndex } from './items';
import { touchItem } from './item-touch';
import { Level } from './level';
import type { Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import {
  clientAt,
  newRecord,
  runUntil,
  spawnedLevel,
  useRecorder,
  type LevelRecord
} from './trigger-test-fixtures';
import { createIdlePlayerState } from './types';
import {
  HURT_DAMAGE,
  HURT_NO_PROTECTION,
  HURT_SILENT,
  HURT_SLOW,
  HURT_SOUND,
  HURT_START_OFF,
  MULTIPLE_BLUE_ONLY,
  MULTIPLE_RED_ONLY,
  TIMER_START_ON,
  TRIGGER_ALWAYS_DELAY,
  clientImpacts,
  touchTriggers
} from './triggers';
import { vec3, type Vec3 } from './vec3';
import { WP } from './weapons/constants';

/** A level with the links a map that is not running a host has, under `rules` or id's. */
function level(rules?: Rules): Level {
  return new Level({ rules });
}

/** A client in slot 0 with a standing player state, box and all. */
function player(world: Level, overrides: Partial<PlayerState> = {}): GameEntity {
  const entity = world.gentities[0];
  entity.inuse = true;
  entity.client = world.clients[0];
  entity.client.ps = createIdlePlayerState(overrides);
  entity.r.mins = vec3(-15, -15, -24);
  entity.r.maxs = vec3(15, 15, 32);
  return entity;
}

/** An item the map placed at a spot and linked into the world. */
function item(world: Level, at: Vec3, classname = 'item_quad'): GameEntity {
  const entity = world.spawnEntity();
  entity.item = findItem(classname)!;
  entity.s.eType = ET.ITEM;
  entity.s.modelindex = itemIndex(entity.item);
  entity.r.contents = CONTENTS.TRIGGER;
  // `FinishSpawningItem` is what gives an item its touch; the start of the match does it.
  entity.touch = (self, other) => touchItem(world, self, other);
  setEntityOrigin(entity, at);
  world.linkEntity(entity);
  return entity;
}

/** Something with a `touch`, as a trigger of the map's is. */
function trigger(
  world: Level,
  at: Vec3,
  touch: ((self: GameEntity, other: GameEntity) => void) | null
): GameEntity {
  const entity = world.spawnEntity();
  entity.classname = 'trigger_test';
  entity.r.mins = vec3(-30, -30, -30);
  entity.r.maxs = vec3(30, 30, 30);
  entity.r.contents = CONTENTS.TRIGGER;
  if (touch) entity.touch = (self, other) => touch(self, other);
  setEntityOrigin(entity, at);
  world.linkEntity(entity);
  return entity;
}

describe('touchTriggers', () => {
  it('picks up an item the player is standing on', () => {
    const world = level();
    const walker = player(world);
    const quad = item(world, vec3());
    touchTriggers(world, walker);
    expect(walker.client!.ps.powerups[1]).not.toBe(0);
    expect(quad.r.contents).toBe(0);
  });

  it('lets an item above the touch box alone, though the search found it', () => {
    const world = level();
    const walker = player(world);
    const high = item(world, vec3(0, 0, 40));
    touchTriggers(world, walker);
    expect(high.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it("reaches an item below the player by the rules' reach", () => {
    /** Whether a player takes a boxed item 60 below them under `rules`. */
    function takes(rules?: Rules): boolean {
      const world = level(rules);
      const walker = player(world);
      const low = item(world, vec3(0, 0, -60));
      low.r.mins = vec3(-15, -15, -15);
      low.r.maxs = vec3(15, 15, 15);
      world.linkEntity(low);
      touchTriggers(world, walker);
      return low.r.contents === 0;
    }

    expect(takes(presetRules('cpm'))).toBe(true);
    expect(takes()).toBe(false);
  });

  it('does not reach an item outside the search box', () => {
    const world = level();
    const walker = player(world);
    const far = item(world, vec3(0, 0, 60));
    touchTriggers(world, walker);
    expect(far.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('does nothing for a dead player', () => {
    const world = level();
    const walker = player(world, { stats: deadStats() });
    const quad = item(world, vec3());
    const hits: string[] = [];
    trigger(world, vec3(), (self) => hits.push(self.classname));
    touchTriggers(world, walker);
    expect(quad.r.contents).toBe(CONTENTS.TRIGGER);
    expect(hits).toEqual([]);
  });

  it('picks nothing up for a spectator', () => {
    const world = level();
    const walker = player(world);
    walker.client!.sess.sessionTeam = TEAM.SPECTATOR;
    const quad = item(world, vec3());
    touchTriggers(world, walker);
    expect(quad.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('works nothing but a teleporter for a player watching the round from a side', () => {
    const world = level();
    const walker = player(world);
    walker.client!.sess.sessionTeam = TEAM.RED;
    walker.client!.pers.roundSpectator = true;
    const hits: string[] = [];
    trigger(world, vec3(), (self) => hits.push(self.classname));
    touchTriggers(world, walker);
    expect(hits).toEqual([]);
  });

  it('fires the touch of what the player’s box is really inside', () => {
    const world = level();
    const walker = player(world);
    const hits: string[] = [];
    trigger(world, vec3(), (self, other) => hits.push(`${self.classname}<-${other.s.number}`));
    touchTriggers(world, walker);
    expect(hits).toEqual(['trigger_test<-0']);
  });

  it('counts a box that only touches the player’s as contact', () => {
    const world = level();
    const walker = player(world);
    const hits: string[] = [];
    // The trigger's box starts at x 15, where the player's box ends, and touches are inclusive.
    trigger(world, vec3(45, 0, 0), (self) => hits.push(self.classname));
    touchTriggers(world, walker);
    expect(hits).toEqual(['trigger_test']);
  });

  it('does not count a box the search pad reaches but the player does not', () => {
    const world = level();
    const walker = player(world);
    const hits: string[] = [];
    // The trigger's box starts at x 16, a unit past the player's 15 — inside the link pad the
    // search box works in, and outside the player.
    trigger(world, vec3(46, 0, 0), (self) => hits.push(self.classname));
    touchTriggers(world, walker);
    expect(hits).toEqual([]);
  });

  it('leaves alone a trigger whose box the player’s box misses', () => {
    const world = level();
    const walker = player(world);
    const hits: string[] = [];
    trigger(world, vec3(50, 0, 0), (self) => hits.push(self.classname));
    touchTriggers(world, walker);
    expect(hits).toEqual([]);
  });

  it('skips what is not made of trigger', () => {
    const world = level();
    const walker = player(world);
    const hits: string[] = [];
    const solid = trigger(world, vec3(), (self) => hits.push(self.classname));
    solid.r.contents = CONTENTS.SOLID;
    touchTriggers(world, walker);
    expect(hits).toEqual([]);
  });

  it('lets a bot run its own touch over what it walked into', () => {
    const world = level();
    const walker = player(world);
    walker.r.svFlags |= SVF.BOT;
    const walked: string[] = [];
    walker.touch = (_self, other) => walked.push(other.classname);
    trigger(world, vec3(), null);
    touchTriggers(world, walker);
    expect(walked).toEqual(['trigger_test']);
  });

  it('clears a stale jump pad frame, and only a stale one', () => {
    const world = level();
    const walker = player(world);
    walker.client!.ps.jumppadFrame = 5;
    walker.client!.ps.jumppadEnt = 12;
    walker.client!.ps.pmoveFramecount = 7;
    touchTriggers(world, walker);
    expect(walker.client!.ps.jumppadFrame).toBe(0);
    expect(walker.client!.ps.jumppadEnt).toBe(0);

    walker.client!.ps.jumppadFrame = 7;
    walker.client!.ps.jumppadEnt = 12;
    touchTriggers(world, walker);
    expect(walker.client!.ps.jumppadFrame).toBe(7);
    expect(walker.client!.ps.jumppadEnt).toBe(12);
  });
});

/** A player state that has died. */
function deadStats(): PlayerState['stats'] {
  const stats = createIdlePlayerState().stats;
  stats[STAT.HEALTH] = 0;
  return stats;
}

describe('the touch pass and weapons', () => {
  it('picks a weapon up for a client the same way any item is', () => {
    const world = level();
    const walker = player(world);
    const launcher = item(world, vec3(0, 0, 0), 'weapon_rocketlauncher');
    touchTriggers(world, walker);
    expect(walker.client!.ps.stats[STAT.WEAPONS] & (1 << WP.ROCKET_LAUNCHER)).toBeTruthy();
    expect(launcher.r.contents).toBe(0);
  });
});

describe('clientImpacts', () => {
  /** Something with no box at all, which only a move's touch list can reach, recording touches. */
  function touchable(world: Level, touched: string[], name: string): GameEntity {
    const entity = world.spawnEntity();
    entity.touch = (_self, other) => touched.push(`${name} by ${other.s.number}`);
    return entity;
  }

  it('touches what the move met, each once, in the order met, with the player', () => {
    const world = level();
    const walker = player(world);
    const touched: string[] = [];
    const plat = touchable(world, touched, 'plat');
    const button = touchable(world, touched, 'button');
    const wall = world.spawnEntity();

    clientImpacts(world, walker, [button.s.number, wall.s.number, plat.s.number, button.s.number]);
    expect(touched).toEqual(['button by 0', 'plat by 0']);
  });

  it("lets a bot's own touch go first, for whatever it met, touch or none", () => {
    const world = level();
    const bot = player(world);
    bot.r.svFlags |= SVF.BOT;
    const touched: string[] = [];
    bot.touch = (_self, other) => touched.push(`bot met ${other.s.number}`);
    const button = touchable(world, touched, 'button');
    const wall = world.spawnEntity();

    clientImpacts(world, bot, [wall.s.number, button.s.number]);
    expect(touched).toEqual([
      `bot met ${wall.s.number}`,
      `bot met ${button.s.number}`,
      'button by 0'
    ]);
  });
});

/** Where a player stands in the trigger map's brush, and where only its bounds reach. */
const IN_BRUSH = vec3(32, 32, 20);
const BY_THE_CUT = vec3(75, 75, 20);

/** The first entity of a classname in a level. */
function first(world: Level, classname: string): GameEntity {
  return world.find(null, 'classname', classname)!;
}

/** A `trigger_multiple` on the trigger brush, firing `t1`, with these keys besides. */
function multiple(keys: Record<string, string> = {}) {
  return { classname: 'trigger_multiple', model: '*1', target: 't1', ...keys };
}

describe('trigger_multiple', () => {
  it('is its brush, a trigger the clients are not sent, waiting half a second by default', () => {
    const trigger = first(spawnedLevel([multiple()]), 'trigger_multiple');
    expect(trigger.s.eType).toBe(ET.GENERAL);
    expect(trigger.s.solid).toBe(SOLID_BMODEL);
    expect(trigger.r.contents).toBe(CONTENTS.TRIGGER);
    expect(trigger.r.svFlags).toBe(SVF.NOCLIENT);
    expect(trigger.r.linked).toBe(true);
    expect(trigger.wait).toBe(0.5);
    expect(trigger.random).toBe(0);
  });

  it('cuts a random as long as its wait to the wait less FRAMETIME, and says so', () => {
    const record = newRecord();
    const world = spawnedLevel([multiple({ wait: '2', random: '2' })], record);
    expect(first(world, 'trigger_multiple').random).toBe(2 - FRAMETIME);
    expect(record.prints).toEqual(['trigger_multiple has random >= wait']);

    // A one-shot's wait is below 0, and its random is left as it is.
    const once = spawnedLevel([multiple({ wait: '-1', random: '3' })]);
    expect(first(once, 'trigger_multiple').random).toBe(3);
  });

  it('fires its targets for a player who walks in, then waits before it will again', () => {
    const world = spawnedLevel([multiple({ wait: '0.7' })]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_multiple');
    const walker = clientAt(world, 0, IN_BRUSH);

    touchTriggers(world, walker);
    expect(fired).toEqual([{ other: trigger.s.number, activator: 0 }]);
    // 0.7 s, as the QVM's floats make it.
    expect(trigger.nextthink).toBe(700);

    runUntil(world, 696);
    touchTriggers(world, walker);
    expect(fired).toHaveLength(1);
    runUntil(world, 704);
    touchTriggers(world, walker);
    expect(fired).toHaveLength(2);
  });

  it('is touched by its brush, not its bounds', () => {
    const world = spawnedLevel([multiple()]);
    const fired = useRecorder(world, 't1');
    touchTriggers(world, clientAt(world, 0, BY_THE_CUT));
    expect(fired).toEqual([]);
  });

  it('takes no touch from what is not a client', () => {
    const world = spawnedLevel([multiple()]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_multiple');
    const rock = world.spawnEntity();
    trigger.touch!(trigger, rock, touchTrace());
    expect(fired).toEqual([]);
  });

  it('is set off by what fires it, for whoever set that off', () => {
    const world = spawnedLevel([multiple()]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_multiple');
    const relay = world.spawnEntity();
    const walker = clientAt(world, 2, vec3(500, 500, 500));
    trigger.use!(trigger, relay, walker);
    expect(fired).toEqual([{ other: trigger.s.number, activator: 2 }]);
  });

  it.each([
    ['RED_ONLY', MULTIPLE_RED_ONLY, TEAM.RED, TEAM.BLUE],
    ['BLUE_ONLY', MULTIPLE_BLUE_ONLY, TEAM.BLUE, TEAM.RED]
  ])('fires under %s for that side, not the other, and for no player', (_n, flag, ours, theirs) => {
    const world = spawnedLevel([multiple({ spawnflags: String(flag) })]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_multiple');
    const them = clientAt(world, 0, IN_BRUSH);
    them.client!.sess.sessionTeam = theirs;
    touchTriggers(world, them);
    expect(fired).toEqual([]);

    const us = clientAt(world, 1, IN_BRUSH);
    us.client!.sess.sessionTeam = ours;
    touchTriggers(world, us);
    expect(fired).toEqual([{ other: trigger.s.number, activator: 1 }]);

    runUntil(world, 600);
    const relay = world.spawnEntity();
    trigger.use!(trigger, relay, relay);
    expect(fired.at(-1)).toEqual({ other: trigger.s.number, activator: relay.s.number });

    // A train's corner sets it off for no one, which has no side.
    runUntil(world, 1200);
    trigger.use!(trigger, relay, null);
    expect(fired.at(-1)).toEqual({ other: trigger.s.number, activator: null });
  });

  it('keeps the latest to set it off while it waits, though it does not fire for them', () => {
    const world = spawnedLevel([multiple()]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_multiple');
    touchTriggers(world, clientAt(world, 0, IN_BRUSH));
    touchTriggers(world, clientAt(world, 1, IN_BRUSH));
    expect(fired).toHaveLength(1);
    expect(trigger.activator!.s.number).toBe(1);
  });

  it('fires once with a wait of 0 or less, and frees itself a frame later', () => {
    const world = spawnedLevel([multiple({ wait: '-1' })]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_multiple');
    const walker = clientAt(world, 0, IN_BRUSH);

    touchTriggers(world, walker);
    expect(fired).toHaveLength(1);
    expect(trigger.touch).toBeNull();
    expect(trigger.nextthink).toBe(FRAMETIME);
    runUntil(world, 96);
    expect(trigger.inuse).toBe(true);
    runUntil(world, 104);
    expect(trigger.inuse).toBe(false);
  });
});

/** The zeroed trace a touch is handed. */
function touchTrace() {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 0,
    endpos: vec3(),
    normal: vec3(),
    contents: 0,
    surfaceFlags: 0,
    entityNum: 0
  };
}

describe('trigger_always', () => {
  it('fires its targets as itself, 300 ms after the map spawns, and goes', () => {
    const world = spawnedLevel([{ classname: 'trigger_always', target: 't1' }]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'trigger_always');
    const number = trigger.s.number;
    expect(trigger.r.linked).toBe(false);
    expect(trigger.r.bmodel).toBe(false);

    // The frames fall at 296 and 304.
    expect(TRIGGER_ALWAYS_DELAY).toBe(300);
    runUntil(world, 296);
    expect(fired).toEqual([]);
    runUntil(world, 304);
    expect(fired).toEqual([{ other: number, activator: number }]);
    expect(trigger.inuse).toBe(false);
  });
});

/** A `trigger_hurt` on the trigger brush, with these keys besides. */
function hurt(keys: Record<string, string> = {}) {
  return { classname: 'trigger_hurt', model: '*1', ...keys };
}

/** The general sounds raised as temp entities, by their sound's index. */
function soundsHeard(world: Level): number[] {
  return world.gentities
    .filter((e) => e.inuse && e.s.eType === ET.EVENTS + EV.GENERAL_SOUND)
    .map((e) => e.s.eventParm);
}

/** The times a player standing in a level's hurt is hurt, a frame every `step` ms. */
function hurtTimes(world: Level, walker: GameEntity, until: number, step = 8): number[] {
  const times: number[] = [];
  for (let time = world.time + step; time <= until; time += step) {
    world.runFrame(time);
    const before = walker.health;
    touchTriggers(world, walker);
    if (walker.health < before) times.push(time);
  }
  return times;
}

describe('trigger_hurt', () => {
  it('is its brush, a trigger the clients are not sent, in the world, its sound registered', () => {
    const record = newRecord();
    const trigger = first(spawnedLevel([hurt()], record), 'trigger_hurt');
    expect(trigger.r.contents).toBe(CONTENTS.TRIGGER);
    expect(trigger.r.svFlags).toBe(SVF.NOCLIENT);
    expect(trigger.r.linked).toBe(true);
    expect(record.sounds).toEqual([HURT_SOUND]);
    expect(trigger.noiseIndex).toBe(1);
  });

  it('hurts 5 when the map gives no dmg, or a dmg of 0', () => {
    expect(first(spawnedLevel([hurt()]), 'trigger_hurt').damage).toBe(HURT_DAMAGE);
    expect(first(spawnedLevel([hurt({ dmg: '0' })]), 'trigger_hurt').damage).toBe(HURT_DAMAGE);
    expect(first(spawnedLevel([hurt({ dmg: '9999' })]), 'trigger_hurt').damage).toBe(9999);
  });

  it('hurts a player in its brush by its dmg, with its sound on them', () => {
    const world = spawnedLevel([hurt({ dmg: '7' })]);
    const walker = clientAt(world, 0, IN_BRUSH);
    touchTriggers(world, walker);
    expect(walker.health).toBe(93);
    expect(walker.client!.lasthurtMod).toBe(MOD.TRIGGER_HURT);
    expect(soundsHeard(world)).toEqual([1]);
  });

  it('is silent when SILENT', () => {
    const world = spawnedLevel([hurt({ spawnflags: String(HURT_SILENT) })]);
    const walker = clientAt(world, 0, IN_BRUSH);
    touchTriggers(world, walker);
    expect(walker.health).toBe(100 - HURT_DAMAGE);
    expect(soundsHeard(world)).toEqual([]);
  });

  it('hurts through god with NO_PROTECTION, and not without', () => {
    for (const [flags, health] of [
      [0, 100],
      [HURT_NO_PROTECTION, 100 - HURT_DAMAGE]
    ]) {
      const world = spawnedLevel([hurt({ spawnflags: String(flags) })]);
      const walker = clientAt(world, 0, IN_BRUSH);
      walker.flags |= FL.GODMODE;
      touchTriggers(world, walker);
      expect(walker.health, `spawnflags ${flags}`).toBe(health);
    }
  });

  it('hurts on Quake 3’s frames, every 100 ms, at the port’s 8 ms tick', () => {
    const world = spawnedLevel([hurt()]);
    const walker = clientAt(world, 0, IN_BRUSH);
    // The code as written would hurt at 8, 112, 216… : every 104 ms.
    expect(hurtTimes(world, walker, 1000)).toEqual([
      8, 104, 200, 304, 400, 504, 600, 704, 800, 904, 1000
    ]);
  });

  it('hurts every 100 ms at Quake 3’s own 50 ms frame too', () => {
    const world = spawnedLevel([hurt()]);
    const walker = clientAt(world, 0, IN_BRUSH);
    expect(hurtTimes(world, walker, 500, 50)).toEqual([50, 150, 250, 350, 450]);
  });

  it('hurts once a second when SLOW', () => {
    const world = spawnedLevel([hurt({ spawnflags: String(HURT_SLOW) })]);
    const walker = clientAt(world, 0, IN_BRUSH);
    expect(hurtTimes(world, walker, 2000)).toEqual([8, 1000, 2000]);
  });

  it('hurts one of two players standing in it on one frame', () => {
    const world = spawnedLevel([hurt()]);
    const one = clientAt(world, 0, IN_BRUSH);
    const two = clientAt(world, 1, IN_BRUSH);
    touchTriggers(world, one);
    touchTriggers(world, two);
    expect([one.health, two.health]).toEqual([100 - HURT_DAMAGE, 100]);
  });

  it('passes over what cannot be hurt, without a sound', () => {
    const world = spawnedLevel([hurt()]);
    const walker = clientAt(world, 0, IN_BRUSH);
    walker.takedamage = false;
    touchTriggers(world, walker);
    expect(walker.health).toBe(100);
    expect(soundsHeard(world)).toEqual([]);
  });

  it('goes out of the world and back at any use, and starts out of it with START_OFF', () => {
    const world = spawnedLevel([hurt()]);
    const trigger = first(world, 'trigger_hurt');
    const user = world.spawnEntity();
    trigger.use!(trigger, user, user);
    expect(trigger.r.linked).toBe(false);
    trigger.use!(trigger, user, user);
    expect(trigger.r.linked).toBe(true);

    const off = first(spawnedLevel([hurt({ spawnflags: String(HURT_START_OFF) })]), 'trigger_hurt');
    expect(off.r.linked).toBe(false);
  });
});

/** A `func_timer` at (8 16 24) firing `t1`, with these keys besides. */
function timer(keys: Record<string, string> = {}) {
  return { classname: 'func_timer', target: 't1', origin: '8 16 24', ...keys };
}

describe('func_timer', () => {
  it('waits a second, give or take one, which is cut to a second less FRAMETIME', () => {
    const record: LevelRecord = newRecord();
    const trigger = first(spawnedLevel([timer()], record), 'func_timer');
    expect(trigger.wait).toBe(1);
    expect(trigger.random).toBe(1 - FRAMETIME);
    expect(record.prints).toEqual(['func_timer at (8 16 24) has random >= wait']);
  });

  it('is never in the world, nor sent', () => {
    const trigger = first(spawnedLevel([timer({ wait: '2' })]), 'func_timer');
    expect(trigger.r.linked).toBe(false);
    expect(trigger.r.svFlags).toBe(SVF.NOCLIENT);
    expect(trigger.nextthink).toBe(0);
  });

  it('starts on with START_ON, firing as itself a frame in, then every wait', () => {
    const world = spawnedLevel([timer({ wait: '2', random: '0.5', spawnflags: '1' })]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'func_timer');
    expect(trigger.spawnflags).toBe(TIMER_START_ON);
    expect(trigger.nextthink).toBe(FRAMETIME);

    runUntil(world, 104);
    expect(fired).toEqual([{ other: trigger.s.number, activator: trigger.s.number }]);
    expect(trigger.nextthink).toBe(2104);
    runUntil(world, 2104);
    expect(fired).toHaveLength(2);
  });

  it('turns on at a use, firing at once for the user, and off at the next', () => {
    const world = spawnedLevel([timer({ wait: '2' })]);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'func_timer');
    const walker = clientAt(world, 3, IN_BRUSH);

    trigger.use!(trigger, walker, walker);
    expect(fired).toEqual([{ other: trigger.s.number, activator: 3 }]);
    expect(trigger.nextthink).toBe(2000);
    trigger.use!(trigger, walker, walker);
    expect(trigger.nextthink).toBe(0);
    runUntil(world, 3000);
    expect(fired).toHaveLength(1);

    // Turned on by a train's corner, it fires for no one, then and at each wait.
    trigger.use!(trigger, walker, null);
    runUntil(world, 5000);
    expect(fired.slice(1)).toEqual([
      { other: trigger.s.number, activator: null },
      { other: trigger.s.number, activator: null }
    ]);
  });

  it('stops for good when id’s cut puts its next time at or before 0, as q3ctf2’s may', () => {
    // `wait 3`, `random 4`: the random is cut to −97, and a draw of 0.75 puts the next time 45.5 s
    // in the past.
    const record = newRecord();
    const keys = { wait: '3', random: '4', spawnflags: '1' };
    const world = spawnedLevel([timer(keys)], record, () => 0.75);
    const fired = useRecorder(world, 't1');
    const trigger = first(world, 'func_timer');
    expect(record.prints).toEqual(['func_timer at (8 16 24) has random >= wait']);

    runUntil(world, 104);
    expect(fired).toHaveLength(1);
    expect(trigger.nextthink).toBe(104 - 45500);
    runUntil(world, 60000, 50);
    expect(fired).toHaveLength(1);

    // A time before 0 is still on, so the first use turns it off and the second fires it.
    trigger.use!(trigger, trigger, trigger);
    expect(fired).toHaveLength(1);
    trigger.use!(trigger, trigger, trigger);
    expect(fired).toHaveLength(2);
  });
});
