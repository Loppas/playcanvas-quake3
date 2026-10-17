import { describe, expect, it } from 'vitest';

import { ENTITYNUM_WORLD, type PlayerState } from '../net/protocol';
import { ANIM, animOf } from './animations';
import { createFlatWorldTrace } from './box-world';
import { CA_LOADOUT } from './clan-arena';
import { DAMAGE_RADIUS, damage } from './combat';
import {
  BUTTON_ATTACK,
  CONTENTS,
  DF_NO_FALLING,
  EF_AWARDS,
  EF_AWARD_EXCELLENT,
  EF_AWARD_GAUNTLET,
  FL,
  GT,
  MOD,
  PERS,
  PLAYEREVENT,
  PM_DEAD,
  PM_NORMAL,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  PMOVE_MSEC,
  REWARD_SPRITE_TIME,
  STAT,
  TEAM
} from './constants';
import { tossClientItems } from './drops';
import { EV, addPredictableEvent, eventNumber } from './events';
import { runItem } from './item-run';
import { ET, SVF, type GameEntity } from './game-entity';
import { ARMOR_TIER, findItem, HI, PW } from './items';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { Level } from './level';
import { spawnClient } from './life-test-fixtures';
import {
  FALL_DAMAGE_FAR,
  FALL_DAMAGE_MEDIUM,
  FALL_PAIN_DEBOUNCE,
  FORCE_RESPAWN,
  PlayerLife,
  PAIN_DEBOUNCE,
  RESPAWN_DELAY,
  SPAWN_HEALTH_BONUS,
  SPAWN_KNOCKBACK_TIME,
  type ArenaLoadout
} from './player-life';
import { defaultRules, type Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { CTF_FRAG_CARRIER_BONUS, FLAG, FLAG_NEVER_EXPIRES } from './team';
import { vec3, type Vec3 } from './vec3';
import { ALL_WEAPONS, AMMO_INFINITE, WP } from './weapons/constants';
import { radiusDamage } from './weapons/splash';

/**
 * The player's life, driven through the client's own calls around a move that does nothing, and
 * hurt through `G_Damage` as anything in the world hurts them. `view/player-view-life.test.ts`
 * runs the same client inside the real loop.
 */

const flat = createFlatWorldTrace();
const NO_BUTTONS = { buttons: 0 };
const ATTACK = { buttons: BUTTON_ATTACK };

/** A client spawned into a world, and what a test reaches it through. */
interface Lived {
  life: PlayerLife;
  state: PlayerState;
  entity: GameEntity;
  level: Level;
}

/**
 * What the life told the client this tick, as a client reads it.
 *
 * `G_AddEvent` puts a client's events on `ps.externalEvent`, which holds **one at a time**: a tick
 * that raises two leaves only the second, and the counter in the top two bits is what makes the
 * same event twice running readable as two.
 *
 * @param state - The player state the life writes to.
 * @param before - What `externalEvent` held before the tick.
 */
function raised(state: PlayerState, before: number): { event: number; parm: number }[] {
  if (!state.externalEvent || state.externalEvent === before) return [];
  return [{ event: eventNumber(state.externalEvent), parm: state.externalEventParm }];
}

/** `PERS_SPAWN_COUNT`, which is how a client knows a player came back. */
const spawnCount = (state: PlayerState) => state.persistant[PERS.SPAWN_COUNT];

/** A client and the player it has just spawned, at (100, 0, 24) facing yaw 90. */
function spawned(
  options: {
    handicap?: number;
    god?: boolean;
    armor?: number;
    weapons?: boolean;
    arena?: ArenaLoadout;
    gametype?: number;
    forceRespawn?: () => number;
    respawnHeld?: () => boolean;
    rules?: Rules;
  } = {}
): Lived {
  const level = new Level({
    handlers: { runItem: (entity) => runItem(level, entity, flat) }
  });
  const { life, state, entity } = spawnClient({
    level,
    origin: vec3(100, 0, 24),
    yaw: 90,
    handicap: options.handicap,
    god: options.god,
    loadout: { armor: options.armor, weapons: options.weapons, arena: options.arena },
    gametype: options.gametype === undefined ? undefined : () => options.gametype!,
    forceRespawn: options.forceRespawn,
    respawnHeld: options.respawnHeld,
    rules: options.rules
  });
  return { life, state, entity, level };
}

/** Another client in the same world, in `slot`, standing at `origin`. */
function other(world: Lived, slot: number, origin: Vec3): Lived {
  const { life, state, entity } = spawnClient({ level: world.level, slot, origin });
  return { life, state, entity, level: world.level };
}

/**
 * A world where `AddScore` is recorded rather than applied, for the tests that ask only what the
 * death scored. The real path through the match is `game.test.ts`'s.
 */
let scores: { client: number; score: number }[] = [];
/** The boards a death sent, in the order the deaths sent them. */
let boards: number[] = [];
/** What a death called on the match, in order, so a test can pin what came first. */
let calls: string[] = [];

function scored(gametype: number = GT.FFA): Lived {
  scores = [];
  boards = [];
  calls = [];
  const level = new Level({
    handlers: { runItem: (entity) => runItem(level, entity, flat) }
  });
  const { life, state, entity } = spawnClient({
    level,
    origin: vec3(100, 0, 24),
    yaw: 90,
    gametype: () => gametype,
    addScore: (target, _origin, score) => {
      scores.push({ client: target.s.number, score });
      calls.push(`score ${target.s.number} ${score}`);
    },
    sendScoreboard: (clientNum) => {
      boards.push(clientNum);
      calls.push(`board ${clientNum}`);
    },
    tossItems: () => {
      calls.push('toss');
      tossClientItems(level, entity);
    }
  });
  return { life, state, entity, level };
}

/** A CTF world whose scoring is recorded, as {@link scored} does it. */
function ctf(): Lived {
  const world = scored(GT.CTF);
  world.level.itemMatch = {
    ...DEFAULT_ITEM_MATCH,
    gametype: () => GT.CTF,
    // The same `AddScore` the life is given: one function in Quake 3, and two doors to it
    // in the port.
    addScore: (target, _origin, score) => {
      scores.push({ client: target.s.number, score });
      calls.push(`score ${target.s.number} ${score}`);
    }
  };
  return world;
}

/** A flag standing on its base, already taken, as one a carrier is holding has been left. */
function flagAt(level: Level, classname: string): GameEntity {
  const base = level.spawnEntity();
  base.classname = classname;
  base.item = findItem(classname)!;
  base.r.contents = 0;
  return base;
}

/** Everything lying on the floor that somebody dropped. */
function dropped(level: Level): GameEntity[] {
  return level.gentities.filter((e) => e.inuse && (e.flags & FL.DROPPED_ITEM) !== 0);
}

/** The corpses in the world: the body slots something has been copied into and not retired. */
function corpses(level: Level): GameEntity[] {
  return level.bodyQue.filter((body) => body.r.linked);
}

/** The temp entities carrying one event, as a client would find them in a snapshot. */
function tempEvents(level: Level, event: number): GameEntity[] {
  return level.gentities.filter((e) => e.inuse && e.s.eType === ET.EVENTS + event);
}

/** Move the match's clock to `time`, as a frame does. */
function at(level: Level, time: number): void {
  level.previousTime = level.time;
  level.time = time;
}

/** One tick of the client's half of the loop, around a move that did nothing. */
function idle(world: Lived, time: number, cmd: { buttons: number } = NO_BUTTONS) {
  const before = world.state.externalEvent;
  at(world.level, time);
  world.life.beginTick();
  world.life.endTick(cmd, PMOVE_MSEC);
  world.life.endFrame();
  return raised(world.state, before);
}

/** A hit on the player: `G_Damage`'s arguments, reduced to whose it is. */
interface Hit {
  points: number;
  /** Which way it pushes, or null for none. */
  dir: Vec3 | null;
  dflags: number;
  /** The player's own, as their blast is; otherwise the world's. */
  self: boolean;
}

/** `G_Damage` on the player, as their own blast or the world would call it. */
function hurt(world: Lived, { points, dir, dflags, self }: Hit): void {
  const attacker = self ? world.entity : null;
  const mod = self ? MOD.ROCKET_SPLASH : MOD.FALLING;
  damage(world.level, world.entity, null, attacker, dir, points, dflags, mod);
}

/** One hit inside a tick, with its feedback: what the view would see from the tick. */
function hit(world: Lived, time: number, request: Hit) {
  const before = world.state.externalEvent;
  at(world.level, time);
  world.life.beginTick();
  hurt(world, request);
  world.life.endTick(NO_BUTTONS, PMOVE_MSEC);
  world.life.endFrame();
  return raised(world.state, before);
}

/** The player's own splash, pushing straight up. */
const selfSplash = (points: number): Hit => ({
  points,
  dir: vec3(0, 0, 1),
  dflags: DAMAGE_RADIUS,
  self: true
});

/** A hit from the world, with no direction: a fall. */
const worldHit = (points: number): Hit => ({ points, dir: null, dflags: 0, self: false });

/**
 * Kill the player without gibbing them, at `time`.
 *
 * The frame is closed as well, because that is where `ClientEndFrame` rebuilds the entity state
 * out of the player state — and the corpse a respawn leaves is a copy of *that*.
 */
function kill(world: Lived, time: number) {
  const before = world.state.externalEvent;
  world.state.stats[STAT.HEALTH] = 5;
  at(world.level, time);
  world.life.beginTick();
  hurt(world, worldHit(10));
  world.life.endFrame();
  return raised(world.state, before);
}

describe('ClientSpawn', () => {
  it("pins Q3's numbers", () => {
    expect(SPAWN_HEALTH_BONUS).toBe(25);
    expect(SPAWN_KNOCKBACK_TIME).toBe(100);
    expect(RESPAWN_DELAY).toBe(1700);
    expect(FORCE_RESPAWN).toBe(20_000);
    expect(PAIN_DEBOUNCE).toBe(700);
    expect(FALL_PAIN_DEBOUNCE).toBe(200);
    expect(FALL_DAMAGE_MEDIUM).toBe(5);
    expect(FALL_DAMAGE_FAR).toBe(10);
  });

  it('starts health 25 over the max, with Quake 3’s two weapons and the machinegun up', () => {
    const { state, entity } = spawned();
    expect(state.stats[STAT.HEALTH]).toBe(125);
    expect(entity.health).toBe(125);
    expect(state.stats[STAT.MAX_HEALTH]).toBe(100);
    expect(state.stats[STAT.ARMOR]).toBe(0);
    expect(state.weapon).toBe(WP.MACHINEGUN);
    expect(state.stats[STAT.WEAPONS]).toBe((1 << WP.MACHINEGUN) | (1 << WP.GAUNTLET));
    expect(state.ammo[WP.MACHINEGUN]).toBe(100);
    expect(state.ammo[WP.GAUNTLET]).toBe(-1);
    expect(state.origin).toEqual(vec3(100, 0, 24));
    expect(state.viewangles).toEqual(vec3(0, 90, 0));
    expect(state.pmType).toBe(PM_NORMAL);
  });

  it('hands out the whole rack when the testing loadout asks for it', () => {
    const { state } = spawned({ weapons: true });
    for (const weapon of ALL_WEAPONS) {
      expect(state.stats[STAT.WEAPONS] & (1 << weapon), String(weapon)).toBeTruthy();
    }
    expect(state.ammo[WP.MACHINEGUN]).toBe(AMMO_INFINITE);
    expect(state.weapon).toBe(WP.MACHINEGUN);
  });

  it('holds fire and jumping until attack is let go, and full speed for 100 ms', () => {
    const { state } = spawned();
    expect(state.pmFlags & PMF_RESPAWNED).toBeTruthy();
    expect(state.pmFlags & PMF_TIME_KNOCKBACK).toBeTruthy();
    expect(state.pmTime).toBe(100);
  });

  it('stands the player idle', () => {
    const { state } = spawned();
    expect(state.legsAnim).toBe(ANIM.LEGS_IDLE);
    expect(state.torsoAnim).toBe(ANIM.TORSO_STAND);
  });

  it('takes the max health from the handicap, 1 to 100', () => {
    const { state } = spawned({ handicap: 50 });
    expect(state.stats[STAT.MAX_HEALTH]).toBe(50);
    expect(state.stats[STAT.HEALTH]).toBe(75);
    expect(spawned({ handicap: 0 }).state.stats[STAT.MAX_HEALTH]).toBe(100);
    expect(spawned({ handicap: 101 }).state.stats[STAT.MAX_HEALTH]).toBe(100);
  });

  it('starts with the spawn armor', () => {
    expect(spawned({ armor: 50 }).state.stats[STAT.ARMOR]).toBe(50);
  });

  it("hands a mode's own rack out in place of Quake 3's, with the weapon it names up", () => {
    const { state, entity } = spawned({ arena: CA_LOADOUT });
    let owned = 1 << WP.GAUNTLET;
    for (const [weapon, ammo] of CA_LOADOUT.ammo) {
      owned |= 1 << weapon;
      expect(state.ammo[weapon], String(weapon)).toBe(ammo);
    }
    expect(state.stats[STAT.WEAPONS]).toBe(owned);
    expect(state.stats[STAT.WEAPONS] & (1 << WP.BFG)).toBe(0);
    expect(state.ammo[WP.GAUNTLET]).toBe(AMMO_INFINITE);
    expect(state.weapon).toBe(WP.ROCKET_LAUNCHER);
    expect(state.stats[STAT.HEALTH]).toBe(100);
    expect(entity.health).toBe(100);
    expect(state.stats[STAT.ARMOR]).toBe(150);
  });

  it("leaves the port's testing loadout out of a mode's own", () => {
    const { state } = spawned({ arena: CA_LOADOUT, weapons: true, armor: 50 });
    expect(state.stats[STAT.WEAPONS] & (1 << WP.BFG)).toBe(0);
    expect(state.ammo[WP.ROCKET_LAUNCHER]).toBe(50);
    expect(state.stats[STAT.ARMOR]).toBe(150);
  });

  it('gives the entity a body that can be hurt, and a death of its own', () => {
    const { entity } = spawned();
    expect(entity.takedamage).toBe(true);
    expect(entity.die).not.toBeNull();
  });
});

describe('ClientUserinfoChanged', () => {
  it('sets the max health from a new handicap at once, 1 to 100', () => {
    const { life, state } = spawned();
    life.setHandicap(50);
    expect(life.handicap).toBe(50);
    expect(state.stats[STAT.MAX_HEALTH]).toBe(50);
    expect(state.stats[STAT.HEALTH]).toBe(125);
    life.setHandicap(101);
    expect(state.stats[STAT.MAX_HEALTH]).toBe(100);
  });

  it('drains the health down to the new max, and spawns 25 over it', () => {
    const world = spawned();
    world.life.setHandicap(50);
    for (let time = PMOVE_MSEC; time <= 80_000; time += PMOVE_MSEC) idle(world, time);
    expect(world.state.stats[STAT.HEALTH]).toBe(50);
    world.life.spawn();
    expect(world.state.stats[STAT.MAX_HEALTH]).toBe(50);
    expect(world.state.stats[STAT.HEALTH]).toBe(75);
  });
});

describe("G_Damage's order, on a player", () => {
  it("halves the player's own splash, after its full push", () => {
    const world = spawned();
    hurt(world, selfSplash(100));
    expect(world.state.velocity).toEqual(vec3(0, 0, 500));
    expect(world.state.stats[STAT.HEALTH]).toBe(125 - 50);
  });

  it('pushes a player in god mode just as hard, and hurts them not at all', () => {
    const world = spawned({ god: true });
    hurt(world, selfSplash(100));
    expect(world.state.velocity).toEqual(vec3(0, 0, 500));
    expect(world.state.stats[STAT.HEALTH]).toBe(125);

    hurt(world, worldHit(10));
    expect(world.state.stats[STAT.HEALTH]).toBe(125);
  });

  it('soaks two thirds into the armor, rounded up', () => {
    const world = spawned({ armor: 100 });
    hurt(world, selfSplash(100));
    expect(world.state.stats[STAT.ARMOR]).toBe(100 - 33);
    expect(world.state.stats[STAT.HEALTH]).toBe(125 - 17);
  });

  it('costs at least a point, even from a blast whose falloff truncated to nothing', () => {
    const world = spawned();
    hurt(world, selfSplash(0));
    expect(world.state.velocity).toEqual(vec3());
    expect(world.state.stats[STAT.HEALTH]).toBe(124);
  });

  it('truncates the half of an odd hit, as the int it is in Q3', () => {
    const world = spawned();
    hurt(world, selfSplash(7));
    expect(world.state.stats[STAT.HEALTH]).toBe(125 - 3);
  });

  it('does not push a hit with no direction', () => {
    const world = spawned();
    hurt(world, worldHit(10));
    expect(world.state.velocity).toEqual(vec3());
    expect(world.state.stats[STAT.HEALTH]).toBe(115);
  });

  it('takes the full hit from someone else, scaled by their handicap', () => {
    const world = spawned();
    const shooter = other(world, 1, vec3(-100, 0, 24));
    shooter.life.setHandicap(50);
    damage(world.level, world.entity, shooter.entity, shooter.entity, null, 50, 0, MOD.RAILGUN);
    expect(world.state.stats[STAT.HEALTH]).toBe(125 - 25);
  });
});

describe('P_DamageFeedback', () => {
  it('sends where a hit came from as bytes, and how much it was', () => {
    const world = spawned();
    hit(world, 1000, { ...selfSplash(40), dir: vec3(0, 1, 0) });
    // vectoangles gives yaw 90, a quarter of 256; the pitch is level.
    expect(world.state.damageYaw).toBe(64);
    expect(world.state.damagePitch).toBe(0);
    expect(world.state.damageCount).toBe(20);

    // Straight up is a pitch of −90, which the byte wraps to 192.
    hit(world, 2000, selfSplash(40));
    expect(world.state.damagePitch).toBe(192);
    expect(world.state.damageYaw).toBe(0);
  });

  it('counts what the armor soaked in how much the hit was', () => {
    const world = spawned({ armor: 100 });
    hit(world, 1000, selfSplash(100));
    // Half of 100 is 50: 33 into the armor and 17 into health, and the view is shown all 50.
    expect(world.state.damageCount).toBe(50);
  });

  it('sends 255 and 255 for a hit from the world, which centres the blood', () => {
    const world = spawned();
    hit(world, 1000, worldHit(5));
    expect([world.state.damagePitch, world.state.damageYaw]).toEqual([255, 255]);
  });

  it('plays a pain sound at most every 700 ms, carrying the health', () => {
    const world = spawned();
    expect(hit(world, 1000, selfSplash(20))).toEqual([{ event: EV.PAIN, parm: 115 }]);
    expect(hit(world, 1696, selfSplash(20))).toEqual([]);
    expect(hit(world, 1704, selfSplash(20))).toEqual([{ event: EV.PAIN, parm: 95 }]);
    // Each hit still shows; only the sound is held off.
    expect(world.state.damageEvent).toBe(2);
    expect(world.state.damageCount).toBe(10);
  });

  it('plays no pain for a fall, whose landing makes its own sound', () => {
    const world = spawned();
    const { life, state } = world;
    const before = state.externalEvent;
    at(world.level, 1000);
    life.beginTick();
    addPredictableEvent(state, EV.FALL_MEDIUM);
    life.clientEvents(state.eventSequence - 1);
    life.endTick(NO_BUTTONS, PMOVE_MSEC);

    expect(state.stats[STAT.HEALTH]).toBe(120);
    expect(raised(state, before)).toEqual([]);
    expect(state.damageEvent).toBe(0);
  });

  it('plays no pain for the hit that kills', () => {
    const world = spawned();
    world.state.stats[STAT.HEALTH] = 20;
    const events = hit(world, 1000, selfSplash(60));
    // The killer of a player killed by their own splash is themselves.
    expect(events).toEqual([{ event: EV.DEATH1, parm: world.state.clientNum }]);
  });
});

describe('ClientEvents', () => {
  it('charges 5 for a medium fall and 10 for a far one, and nothing for a short one', () => {
    const { life, state, entity } = spawned();
    life.beginTick();
    // Read straight out of the ring, so the two-deep limit applies: a medium and a far landing
    // in one tick is already as many as a player state can carry.
    const since = state.eventSequence;
    addPredictableEvent(state, EV.FALL_MEDIUM);
    addPredictableEvent(state, EV.FALL_FAR);
    life.clientEvents(since);
    expect(state.stats[STAT.HEALTH]).toBe(125 - 5 - 10);
    // A fall is the world's, as `G_Damage( ent, NULL, NULL, … )` makes it.
    expect(state.persistant[PERS.ATTACKER]).toBe(ENTITYNUM_WORLD);
    expect(entity.client!.lasthurtMod).toBe(MOD.FALLING);
  });

  it('charges nothing for a fall in Clan Arena', () => {
    const { life, state } = spawned({ gametype: GT.CA });
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.FALL_FAR);
    life.clientEvents(since);
    expect(state.stats[STAT.HEALTH]).toBe(125);
  });

  it('charges nothing for a fall under dmflags 8', () => {
    const { life, state } = spawned({ rules: { ...defaultRules(), dmflags: DF_NO_FALLING } });
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.FALL_MEDIUM);
    addPredictableEvent(state, EV.FALL_FAR);
    life.clientEvents(since);
    expect(state.stats[STAT.HEALTH]).toBe(125);
  });

  it('charges nothing for a short landing or a footstep', () => {
    const { life, state } = spawned();
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.FALL_SHORT);
    addPredictableEvent(state, EV.FOOTSTEP);
    life.clientEvents(since);
    expect(state.stats[STAT.HEALTH]).toBe(125);
  });

  it('fires the weapon, which is what a fire event in the ring means', () => {
    // The move decides a shot went off; what the shot *does* happens here, because it needs the
    // world the move has no access to.
    const fired: PlayerState[] = [];
    const { life, state } = spawnClient({ fireWeapon: (firing) => fired.push(firing) });
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.FIRE_WEAPON);
    life.clientEvents(since);

    expect(fired).toEqual([state]);
  });

  it('fires once per event, so a tick that raised two shots fires twice', () => {
    let shots = 0;
    const { life, state } = spawnClient({ fireWeapon: () => shots++ });
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.FIRE_WEAPON);
    addPredictableEvent(state, EV.FIRE_WEAPON);
    life.clientEvents(since);

    expect(shots).toBe(2);
  });

  it('heals the medkit to 25 over the max, from wherever the health was', () => {
    // `EV_USE_ITEM2` (`g_active.c:630–633`): more than a top-up, and not clamped to the max —
    // the ceiling is exactly why `PM_Weapon` refuses a use at it.
    const { life, state, entity } = spawned();
    state.stats[STAT.HEALTH] = 40;
    entity.health = 40;
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.USE_ITEM0 + HI.MEDKIT);
    life.clientEvents(since);

    expect(state.stats[STAT.HEALTH]).toBe(125);
    // The entity's copy follows the player state's, as `player_die` reads it.
    expect(entity.health).toBe(125);
  });

  it('hands the teleporter to the lifecycle, which is where the map is', () => {
    // `EV_USE_ITEM1` (`g_active.c:577–628`) selects a spawn point and moves the player; the port
    // keeps that in the game module, so the life only passes it on.
    let uses = 0;
    const { life, state } = spawnClient({ teleportPlayer: () => uses++ });
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.USE_ITEM0 + HI.TELEPORTER);
    life.clientEvents(since);

    expect(uses).toBe(1);
  });

  it('leaves the other use-item events alone', () => {
    // `EV_USE_ITEM0` is handled by the client alone ("No item to use"), and the tags past
    // baseq3's two exist in `baseq3`'s event list without a meaning here.
    const { life, state } = spawned();
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.USE_ITEM0);
    addPredictableEvent(state, EV.USE_ITEM0 + 5);
    life.clientEvents(since);

    expect(state.stats[STAT.HEALTH]).toBe(125);
  });
});

describe('ClientTimerActions', () => {
  it('drains health over the max a point a second, down to the max', () => {
    const world = spawned();
    const tickTo = (from: number, to: number) => {
      for (let time = from; time <= to; time += PMOVE_MSEC) idle(world, time);
    };

    tickTo(8, 992);
    expect(world.state.stats[STAT.HEALTH]).toBe(125);
    tickTo(1000, 1000);
    expect(world.state.stats[STAT.HEALTH]).toBe(124);
    tickTo(1008, 25_000);
    expect(world.state.stats[STAT.HEALTH]).toBe(100);
    tickTo(25_008, 27_000);
    expect(world.state.stats[STAT.HEALTH]).toBe(100);
  });

  it('drains armor over the max the same way', () => {
    const world = spawned({ armor: 150 });
    for (let time = 8; time <= 1000; time += PMOVE_MSEC) idle(world, time);
    expect(world.state.stats[STAT.ARMOR]).toBe(149);
  });

  it('heals 15 a second under regeneration, and says so', () => {
    const world = spawned();
    world.state.powerups[PW.REGEN] = 1;
    world.state.stats[STAT.HEALTH] = 40;

    const events: { event: number; parm: number }[] = [];
    for (let time = 8; time <= 1000; time += PMOVE_MSEC) events.push(...idle(world, time));

    expect(world.state.stats[STAT.HEALTH]).toBe(55);
    // Each heal raises `EV_POWERUP_REGEN`, which is what plays the sound and pulses the icon.
    expect(events).toContainEqual({ event: EV.POWERUP_REGEN, parm: 0 });
  });

  it('steps the heal down to 5 between a tenth and twice the max, and stops there', () => {
    const world = spawned();
    world.state.powerups[PW.REGEN] = 1;
    world.state.stats[STAT.HEALTH] = 130;
    const tickTo = (from: number, to: number) => {
      for (let time = from; time <= to; time += PMOVE_MSEC) idle(world, time);
    };

    // Above 1.1 × max the 15 falls to 5 (`g_active.c:445–453`).
    tickTo(8, 1000);
    expect(world.state.stats[STAT.HEALTH]).toBe(135);
    tickTo(1008, 2000);
    expect(world.state.stats[STAT.HEALTH]).toBe(140);

    // The cap is twice the max: a heal that would pass it stops on it, and the next does nothing.
    world.state.stats[STAT.HEALTH] = 196;
    tickTo(2008, 3000);
    expect(world.state.stats[STAT.HEALTH]).toBe(200);
    tickTo(3008, 4000);
    expect(world.state.stats[STAT.HEALTH]).toBe(200);

    // And the big heal stops at a tenth over the max: from 97 it takes 13 of its 15.
    world.state.stats[STAT.HEALTH] = 97;
    tickTo(4008, 5000);
    expect(world.state.stats[STAT.HEALTH]).toBe(110);
  });

  it('leaves health over the max alone while regeneration runs, and still drains armor', () => {
    const world = spawned({ armor: 150 });
    world.state.powerups[PW.REGEN] = 1;
    world.state.stats[STAT.HEALTH] = 130;

    for (let time = 8; time <= 1000; time += PMOVE_MSEC) idle(world, time);

    // The drain is the `else` of the heal (`g_active.c:455–461`); the armor's is outside it.
    expect(world.state.stats[STAT.HEALTH]).toBe(135);
    expect(world.state.stats[STAT.ARMOR]).toBe(149);
  });
});

describe("the rules' health", () => {
  const PRESETS = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
  const fixed = { ...defaultRules(), g_fixedHealthLimits: 1 };
  const tickTo = (world: Lived, from: number, to: number) => {
    for (let time = from; time <= to; time += PMOVE_MSEC) idle(world, time);
  };

  it('spawns each preset at its limit and its bonus, the handicap aside under fixed limits', () => {
    const spawns = (handicap: number) =>
      PRESETS.map((name) => {
        const { state } = spawned({ handicap, rules: presetRules(name) });
        return state.stats[STAT.HEALTH];
      });
    expect(spawns(100)).toEqual([125, 100, 100, 125, 100]);
    expect(spawns(60)).toEqual([85, 100, 100, 125, 100]);

    // The max health keeps the handicap, which scales what the player deals.
    const { state } = spawned({ handicap: 60, rules: presetRules('cpm') });
    expect(state.stats[STAT.MAX_HEALTH]).toBe(60);
  });

  it('drains health and armour to a fixed 100, whatever the handicap', () => {
    const world = spawned({ handicap: 50, armor: 102, rules: fixed });
    world.state.stats[STAT.HEALTH] = 103;
    tickTo(world, 8, 5000);
    expect(world.state.stats[STAT.HEALTH]).toBe(100);
    expect(world.state.stats[STAT.ARMOR]).toBe(100);
  });

  it('heals regeneration in the fixed bands, to 110 and then by 5 to 200', () => {
    const world = spawned({ handicap: 50, rules: fixed });
    world.state.powerups[PW.REGEN] = 1;
    // Under id's the handicap's 50 would make 97 a small heal, stopped at 100.
    world.state.stats[STAT.HEALTH] = 97;
    tickTo(world, 8, 1000);
    expect(world.state.stats[STAT.HEALTH]).toBe(110);
    tickTo(world, 1008, 2000);
    expect(world.state.stats[STAT.HEALTH]).toBe(115);
  });

  it('heals the medkit to 125, whatever the handicap', () => {
    const { life, state } = spawned({ handicap: 50, rules: fixed });
    state.stats[STAT.HEALTH] = 40;
    life.beginTick();
    const since = state.eventSequence;
    addPredictableEvent(state, EV.USE_ITEM0 + HI.MEDKIT);
    life.clientEvents(since);
    expect(state.stats[STAT.HEALTH]).toBe(125);
  });

  it("drains armour by each preset's time for its tier", () => {
    const drained = (rules: Rules, tier: number) => {
      const world = spawned({ armor: 150, rules });
      world.state.stats[STAT.ARMOR_TIER] = tier;
      tickTo(world, 8, 3000);
      return 150 - world.state.stats[STAT.ARMOR];
    };
    const { GA, YA, RA } = ARMOR_TIER;
    const byTier = (name: string) => [GA, YA, RA].map((tier) => drained(presetRules(name), tier));
    expect(PRESETS.map(byTier)).toEqual([
      [3, 3, 3],
      [0, 0, 0],
      [0, 0, 0],
      [2, 3, 6],
      [0, 0, 0]
    ]);
  });

  it("drains armour on a clock of its own, which a round's countdown does not hold", () => {
    const world = spawned({ armor: 110, rules: presetRules('cq3') });
    world.level.roundTime = 1;
    tickTo(world, 8, 2000);
    expect(world.state.stats[STAT.HEALTH]).toBe(125);
    expect(world.state.stats[STAT.ARMOR]).toBe(108);
  });

  it('spawns with the yellow tier, whatever was held', () => {
    const { life, state } = spawned({ rules: presetRules('cpm') });
    state.stats[STAT.ARMOR_TIER] = ARMOR_TIER.RA;
    life.spawn();
    expect(state.stats[STAT.ARMOR_TIER]).toBe(ARMOR_TIER.YA);
  });

  it("passes a round's countdown with nothing done in it, under g_countdownHold", () => {
    // A countdown from 500 to 1300. The second at 1000 passes with nothing done, and the next
    // still falls at 2000 rather than a second on from where the countdown began.
    const count = (rules: Rules) => {
      const world = spawned({ rules });
      const health: number[] = [];
      for (let time = 8; time <= 2000; time += PMOVE_MSEC) {
        world.level.roundTime = time > 500 && time <= 1300 ? 1 : -1;
        idle(world, time);
        if ([1000, 1992, 2000].includes(time)) health.push(world.state.stats[STAT.HEALTH]);
      }
      return health;
    };
    expect(count({ ...defaultRules(), g_countdownHold: 1 })).toEqual([125, 125, 124]);
    expect(count(defaultRules())).toEqual([124, 124, 123]);
  });
});

describe('player_die', () => {
  it("moves as a corpse, plays the first death and turns the view to the spawn's yaw", () => {
    const world = spawned();
    const { state } = world;
    state.viewangles = vec3(30, 10, 0);
    state.legsAnim = ANIM.LEGS_RUN;
    state.stats[STAT.HEALTH] = 20;
    at(world.level, 1000);
    hurt(world, selfSplash(60));

    expect(state.stats[STAT.HEALTH]).toBe(-10);
    expect(state.pmType).toBe(PM_DEAD);
    expect(raised(state, 0)).toEqual([{ event: EV.DEATH1, parm: state.clientNum }]);
    expect(animOf(state.legsAnim)).toBe(ANIM.BOTH_DEATH1);
    expect(animOf(state.torsoAnim)).toBe(ANIM.BOTH_DEATH1);
    expect(state.viewangles).toEqual(vec3(0, 90, 0));
    // `LookAtKiller`: their own blast has no inflictor but the world's entity, at the map's
    // origin, so from (100, 0, 24) the camera looks along yaw 180.
    expect(state.stats[STAT.DEAD_YAW]).toBe(180);
  });

  it('leaves the weapon in hand and the running powerups on the floor', () => {
    const world = scored();
    const { state, entity } = world;
    entity.s.weapon = WP.ROCKET_LAUNCHER;
    state.stats[STAT.WEAPONS] |= 1 << WP.ROCKET_LAUNCHER;
    state.ammo[WP.ROCKET_LAUNCHER] = 5;
    state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    state.powerups[PW.QUAD] = world.level.time + 30_000;

    damage(world.level, entity, entity, entity, null, 50, 0, MOD.SUICIDE);

    const thrown = world.level.gentities.filter(
      (e) => e.inuse && (e.flags & FL.DROPPED_ITEM) !== 0
    );
    expect(thrown.map((e) => e.item?.classname)).toEqual([
      'weapon_rocketlauncher',
      'item_quad'
    ]);
    // The quad keeps its thirty seconds, and the body is left with none of it: the toss ran
    // before the death cleared the powerups, which is what `g_combat.c:564` is placed for.
    expect(thrown[1].count).toBe(30);
    expect(state.powerups[PW.QUAD]).toBe(0);
    // The drop is thrown before the board is sent, as the C orders them.
    expect(calls).toEqual(['score 0 -1', 'toss', 'board 0']);
  });

  it('sends the flag home rather than dropping it when the carrier kills themselves', () => {
    // "If I committed suicide, the flag does not fall, it returns" (`g_combat.c:547–561`): the
    // clearing is what stops `TossClientItems`, a few lines later, tossing a flag that has
    // already gone back to its stand.
    const world = ctf();
    const base = flagAt(world.level, 'team_CTF_blueflag');
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    world.state.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;

    damage(world.level, world.entity, world.entity, world.entity, null, 50, 0, MOD.SUICIDE);

    expect(world.state.powerups[PW.BLUEFLAG]).toBe(0);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
    expect(world.level.teamgame.blueStatus).toBe(FLAG.ATBASE);
    expect(dropped(world.level).map((e) => e.item?.classname)).toEqual([]);
  });

  it('drops the flag on the floor when somebody else does the killing', () => {
    const world = ctf();
    flagAt(world.level, 'team_CTF_blueflag');
    const killer = other(world, 3, vec3(100, 100, 24));
    // Opposite sides, or the friendly-fire rule refuses the shot and nobody dies.
    world.entity.client!.sess.sessionTeam = TEAM.RED;
    killer.entity.client!.sess.sessionTeam = TEAM.BLUE;
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    world.state.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;

    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.ROCKET);

    expect(dropped(world.level).map((e) => e.item?.classname)).toEqual(['team_CTF_blueflag']);
    expect(world.level.teamgame.blueStatus).toBe(FLAG.DROPPED);
  });

  it('says "holy shit" to a carrier killed a step from their own flag, and to the killer', () => {
    const world = ctf();
    const home = flagAt(world.level, 'team_CTF_redflag');
    home.s.origin = vec3(150, 0, 24);
    const killer = other(world, 3, vec3(100, 100, 24));
    world.entity.client!.sess.sessionTeam = TEAM.RED;
    killer.entity.client!.sess.sessionTeam = TEAM.BLUE;
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    world.state.powerups[PW.BLUEFLAG] = FLAG_NEVER_EXPIRES;

    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.ROCKET);

    // Asked before the flag falls, while the one killed is still carrying it.
    expect(world.state.persistant[PERS.PLAYEREVENTS]).toBe(PLAYEREVENT.HOLYSHIT);
    expect(killer.state.persistant[PERS.PLAYEREVENTS]).toBe(PLAYEREVENT.HOLYSHIT);
  });

  it('pays the team bonus for killing whoever was carrying the flag', () => {
    const world = ctf();
    const carrier = other(world, 3, vec3(100, 100, 24));
    world.entity.client!.sess.sessionTeam = TEAM.RED;
    carrier.entity.client!.sess.sessionTeam = TEAM.BLUE;
    carrier.state.powerups[PW.REDFLAG] = FLAG_NEVER_EXPIRES;
    carrier.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);

    damage(world.level, carrier.entity, world.entity, world.entity, null, 50, 0, MOD.ROCKET);

    // `Team_FragBonuses` runs after the frag's own scoring, which belongs to the *dying*
    // client's life — and this fixture wires only slot 0's, so what is left to see is the
    // bonus, which the flag rules score through the level's match.
    expect(scores).toEqual([{ client: 0, score: CTF_FRAG_CARRIER_BONUS }]);
    expect(world.entity.client!.pers.teamState.fragcarrier).toBe(1);
  });

  it('tells everyone, with an obituary naming the dead, the killer and the means', () => {
    const world = spawned();
    const killer = other(world, 3, vec3(100, 100, 24));
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.RAILGUN);

    const [obituary] = tempEvents(world.level, EV.OBITUARY);
    expect(obituary.s).toMatchObject({
      eventParm: MOD.RAILGUN,
      otherEntityNum: world.entity.s.number,
      otherEntityNum2: 3
    });
    expect(obituary.r.svFlags).toBe(SVF.BROADCAST);
    expect(obituary.s.pos.trBase).toEqual(vec3(100, 0, 24));
  });

  it("names the killer in the death, and turns the dead player's camera to them", () => {
    const world = spawned();
    const killer = other(world, 3, vec3(100, 100, 24));
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    damage(world.level, world.entity, killer.entity, killer.entity, null, 30, 0, MOD.RAILGUN);

    expect(raised(world.state, 0)).toEqual([{ event: EV.DEATH1, parm: 3 }]);
    // From (100, 0, 24) to (100, 100, 24): yaw 90.
    expect(world.state.stats[STAT.DEAD_YAW]).toBe(90);
    expect(world.entity.enemy).toBe(killer.entity);
    expect(killer.entity.client!.lastkilledClient).toBe(world.entity.s.number);
    expect(world.state.persistant[PERS.KILLED]).toBe(1);
  });

  it('names the world as the killer of anything that is not a client', () => {
    const world = spawned();
    const rocket = world.level.spawnEntity();
    world.state.stats[STAT.HEALTH] = 10;
    damage(world.level, world.entity, rocket, rocket, null, 30, 0, MOD.ROCKET);

    expect(raised(world.state, 0)).toEqual([{ event: EV.DEATH1, parm: ENTITYNUM_WORLD }]);
    expect(tempEvents(world.level, EV.OBITUARY)[0].s.otherEntityNum2).toBe(ENTITYNUM_WORLD);
  });

  it('scores a kill for the killer', () => {
    const world = scored();
    const killer = other(world, 3, vec3(100, 100, 24));
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.RAILGUN);

    expect(scores).toEqual([{ client: 3, score: 1 }]);
  });

  it('scores the dead −1 for a death nobody is credited with', () => {
    const world = scored();
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    hurt(world, { points: 50, dir: null, dflags: 0, self: false });

    expect(scores).toEqual([{ client: 0, score: -1 }]);
  });

  it('scores the dead −1 when they do it to themselves', () => {
    const world = scored();
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    hurt(world, { points: 80, dir: null, dflags: 0, self: true });

    expect(scores).toEqual([{ client: 0, score: -1 }]);
  });

  it('scores a teammate −1 for the teamkill', () => {
    const world = scored(GT.TEAM);
    const mate = other(world, 3, vec3(100, 100, 24));
    world.entity.client!.sess.sessionTeam = TEAM.RED;
    mate.entity.client!.sess.sessionTeam = TEAM.RED;
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    damage(world.level, world.entity, mate.entity, mate.entity, null, 50, 0, MOD.RAILGUN);

    expect(scores).toEqual([{ client: 3, score: -1 }]);
  });

  it('sends the dead their own board, once the score has moved', () => {
    const world = scored();
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    hurt(world, worldHit(50));

    // `Cmd_Score_f( self )` (`g_combat.c:571`), after `AddScore` and after `TossClientItems`, and
    // before the corpse is dressed: the −1 the death scored is on the board the player is shown.
    expect(calls).toEqual(['score 0 -1', 'toss', 'board 0']);
    expect(boards).toEqual([0]);
  });

  it('counts a gauntlet kill for the humiliation counter', () => {
    const world = scored();
    const killer = other(world, 3, vec3(100, 100, 24));
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.GAUNTLET);

    expect(killer.state.persistant[PERS.GAUNTLET_FRAG_COUNT]).toBe(1);
  });

  it("floats the gauntlet's sprite over the killer, and flips the one killed's humiliation", () => {
    const world = scored();
    const killer = other(world, 3, vec3(100, 100, 24));
    world.state.stats[STAT.HEALTH] = 10;
    // The last humiliation's bit is still up, beside a denial's.
    world.state.persistant[PERS.PLAYEREVENTS] =
      PLAYEREVENT.GAUNTLETREWARD | PLAYEREVENT.DENIEDREWARD;
    // Past the excellent's window from a `lastKillTime` of 0, whose sprite would take the place.
    at(world.level, 10_000);
    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.GAUNTLET);

    expect(killer.state.eFlags & EF_AWARDS).toBe(EF_AWARD_GAUNTLET);
    expect(killer.entity.client!.rewardTime).toBe(10_000 + REWARD_SPRITE_TIME);
    // Flipped, not set, so that every one is a change the client hears; the other bit is kept.
    expect(world.state.persistant[PERS.PLAYEREVENTS]).toBe(PLAYEREVENT.DENIEDREWARD);
    expect(killer.state.persistant[PERS.PLAYEREVENTS]).toBe(0);
  });

  it("swaps the killer's sprite for the excellent's when a second kill comes quickly", () => {
    const world = scored();
    const killer = other(world, 3, vec3(100, 100, 24));
    const victim = other(world, 4, vec3(200, 0, 24));
    victim.state.stats[STAT.HEALTH] = 10;
    at(world.level, 10_000);
    damage(world.level, victim.entity, killer.entity, killer.entity, null, 50, 0, MOD.GAUNTLET);
    expect(killer.state.eFlags & EF_AWARDS).toBe(EF_AWARD_GAUNTLET);

    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 11_000);
    damage(world.level, world.entity, killer.entity, killer.entity, null, 50, 0, MOD.RAILGUN);

    expect(killer.state.eFlags & EF_AWARDS).toBe(EF_AWARD_EXCELLENT);
    expect(killer.entity.client!.rewardTime).toBe(11_000 + REWARD_SPRITE_TIME);
  });

  it('counts a second kill inside 3 s as an excellent, and not one after', () => {
    const world = scored();
    const killer = other(world, 3, vec3(100, 100, 24));
    const kill = (victim: Lived, time: number): void => {
      victim.state.stats[STAT.HEALTH] = 10;
      at(world.level, time);
      damage(world.level, victim.entity, killer.entity, killer.entity, null, 50, 0, MOD.RAILGUN);
    };

    // Late enough that the first kill is not itself inside the window `lastKillTime` starts at 0.
    kill(other(world, 4, vec3(200, 0, 24)), 10_000);
    expect(killer.state.persistant[PERS.EXCELLENT_COUNT]).toBe(0);

    // 3 s exactly is not inside; Q3 tests `< CARNAGE_REWARD_TIME`.
    kill(world, 13_000);
    expect(killer.state.persistant[PERS.EXCELLENT_COUNT]).toBe(0);

    kill(other(world, 5, vec3(300, 0, 24)), 15_999);
    expect(killer.state.persistant[PERS.EXCELLENT_COUNT]).toBe(1);
  });

  it("makes the dead a corpse holding nothing, respawnable 1.7 s after the level's time", () => {
    const world = spawned();
    const { entity, state } = world;
    entity.s.weapon = WP.RAILGUN;
    entity.s.powerups = 4;
    entity.s.loopSound = 7;
    entity.s.angles = vec3(30, 90, 15);
    // The quad, any powerup at all: the point is only that the dead hold none. Not index 2 —
    // that is the battle suit, which would refuse the blast below.
    state.powerups[PW.QUAD] = 30_000;
    // Killed outside their own tick, by someone else's blast in the frame: the time is the
    // level's, whatever the player last thought.
    at(world.level, 5000);
    state.stats[STAT.HEALTH] = 10;
    radiusDamage(world.level, flat, vec3(100, 0, 0), null, 30, 120, null, MOD.ROCKET_SPLASH);

    expect(state.pmType).toBe(PM_DEAD);
    expect(entity.r.contents).toBe(CONTENTS.CORPSE);
    expect(entity.s.weapon).toBe(WP.NONE);
    expect(entity.s.powerups).toBe(0);
    expect(entity.s.loopSound).toBe(0);
    expect(state.powerups[PW.QUAD]).toBe(0);
    expect(entity.client!.respawnTime).toBe(5000 + RESPAWN_DELAY);
    // Level, and along the yaw it had.
    expect(state.viewangles).toEqual(vec3(0, 90, 0));
    // Linked again at a corpse's height, a unit over its box, for a blast to measure to.
    expect(entity.r.absmax.z).toBe(24 - 8 + 1);
  });

  it('dies only once, and not at all at the intermission', () => {
    const world = spawned();
    world.level.intermissiontime = 1000;
    world.state.stats[STAT.HEALTH] = 10;
    hurt(world, worldHit(50));
    expect(world.state.pmType).toBe(PM_NORMAL);
    expect(tempEvents(world.level, EV.OBITUARY)).toHaveLength(0);
  });

  it('plays the three deaths in turn, across lives', () => {
    const world = spawned();
    const deaths: number[] = [];
    let time = 1000;
    for (let life = 0; life < 4; life++) {
      for (const { event } of kill(world, time)) {
        if (event >= EV.DEATH1 && event <= EV.DEATH3) deaths.push(event - EV.DEATH1 + 1);
      }
      time += RESPAWN_DELAY + PMOVE_MSEC;
      idle(world, time, ATTACK);
      time += PMOVE_MSEC;
    }
    expect(deaths).toEqual([1, 2, 3, 1]);
  });

  it('gibs a death at −40 or below instead, and takes no more damage', () => {
    const world = spawned();
    const { state } = world;
    state.stats[STAT.HEALTH] = 10;
    hurt(world, selfSplash(100));

    expect(state.stats[STAT.HEALTH]).toBe(-40);
    expect(raised(state, 0)).toEqual([{ event: EV.GIB_PLAYER, parm: state.clientNum }]);
    expect(animOf(state.legsAnim)).toBe(ANIM.LEGS_IDLE);

    hurt(world, worldHit(50));
    expect(state.stats[STAT.HEALTH]).toBe(-40);
  });

  it('always gibs a suicide', () => {
    const world = spawned();
    world.state.stats[STAT.HEALTH] = 10;
    damage(world.level, world.entity, world.entity, world.entity, null, 50, 0, MOD.SUICIDE);
    expect(raised(world.state, 0)).toEqual([{ event: EV.GIB_PLAYER, parm: 0 }]);
  });

  it('gibs a corpse hurt past −40, crediting nobody, without pushing it', () => {
    const world = spawned();
    const killer = other(world, 3, vec3(100, 100, 24));
    kill(world, 1000);
    expect(world.state.stats[STAT.HEALTH]).toBe(-5);

    // A later tick, because `ps.externalEvent` carries one event at a time: the gib would
    // otherwise land on top of the death and the client would never hear it.
    const death = world.state.externalEvent;
    at(world.level, 2000);
    world.life.beginTick();
    const push = vec3(0, 0, 1);
    damage(world.level, world.entity, killer.entity, killer.entity, push, 35, 0, MOD.SHOTGUN);
    expect(world.state.velocity).toEqual(vec3());
    expect(world.state.stats[STAT.HEALTH]).toBe(-40);
    // `body_die` gibs with no killer, whoever did it.
    expect(raised(world.state, death)).toEqual([{ event: EV.GIB_PLAYER, parm: 0 }]);
  });

  it('never lets health fall below −999', () => {
    const world = spawned();
    hurt(world, worldHit(5000));
    expect(world.state.stats[STAT.HEALTH]).toBe(-999);
  });
});

describe('ClientRespawn', () => {
  it('respawns on attack only once the death has played for more than 1.7 s', () => {
    const world = spawned();
    kill(world, 1000);

    const spawns = spawnCount(world.state);
    idle(world, 2696, ATTACK);
    idle(world, 2700, ATTACK);
    idle(world, 2704);
    expect(spawnCount(world.state)).toBe(spawns);

    idle(world, 2704, ATTACK);
    expect(spawnCount(world.state)).toBe(spawns + 1);
    expect(world.state.stats[STAT.HEALTH]).toBe(125);
    expect(world.state.pmType).toBe(PM_NORMAL);
  });

  it('forces the respawn 20 s after that, attack or not', () => {
    const world = spawned();
    kill(world, 1000);

    const spawns = spawnCount(world.state);
    idle(world, 22_696);
    expect(spawnCount(world.state)).toBe(spawns);
    idle(world, 22_704);
    expect(spawnCount(world.state)).toBe(spawns + 1);
  });

  it('forces it after whatever g_forcerespawn says, and never at all when it is 0', () => {
    const quick = spawned({ forceRespawn: () => 5000 });
    kill(quick, 1000);
    const quickSpawns = spawnCount(quick.state);
    idle(quick, 7696);
    expect(spawnCount(quick.state)).toBe(quickSpawns);
    idle(quick, 7704);
    expect(spawnCount(quick.state)).toBe(quickSpawns + 1);

    // 0 is never: the body lies there however long, and only attack brings it back. A bot, which
    // presses nothing, stays dead for the rest of the map.
    const never = spawned({ forceRespawn: () => 0 });
    kill(never, 1000);
    const neverSpawns = spawnCount(never.state);
    idle(never, 200_000);
    expect(spawnCount(never.state)).toBe(neverSpawns);
    idle(never, 200_008, ATTACK);
    expect(spawnCount(never.state)).toBe(neverSpawns + 1);
  });

  it('stays down while the match holds the dead, and comes back by the usual rule after', () => {
    let held = true;
    const world = spawned({ respawnHeld: () => held });
    kill(world, 1000);

    const spawns = spawnCount(world.state);
    idle(world, 30_000, ATTACK);
    expect(spawnCount(world.state)).toBe(spawns);

    held = false;
    idle(world, 30_008, ATTACK);
    expect(spawnCount(world.state)).toBe(spawns + 1);
  });

  it('dies as a player again once respawned, not as the corpse it left', () => {
    const world = spawned();
    kill(world, 1000);
    idle(world, 2704, ATTACK);

    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 3000);
    hurt(world, worldHit(20));
    expect(world.state.pmType).toBe(PM_DEAD);
    expect(raised(world.state, 0)).toEqual([{ event: EV.DEATH2, parm: ENTITYNUM_WORLD }]);
  });

  it('leaves the corpse in the body queue, on its last frame', () => {
    const world = spawned();
    kill(world, 1000);
    idle(world, 2704, ATTACK);

    expect(corpses(world.level)).toHaveLength(1);
    expect(corpses(world.level)[0].s).toMatchObject({
      eType: ET.PLAYER,
      legsAnim: ANIM.BOTH_DEAD1,
      torsoAnim: ANIM.BOTH_DEAD1
    });
  });

  it("leaves it in a corpse's box, which the death gave the player", () => {
    const world = spawned();
    kill(world, 1000);
    idle(world, 2704, ATTACK);

    // `player_die` lowers the player's box to a corpse's (`g_combat.c:604`), and the corpse
    // copies it: a blast measures to it, and a shot has to come in that low to hit it.
    const [body] = corpses(world.level);
    expect(body.r.mins).toEqual(vec3(-15, -15, -24));
    expect(body.r.maxs).toEqual(vec3(15, 15, -8));
  });

  it('makes the dead a corpse to the world, and the gibbed nothing at all', () => {
    const dead = spawned();
    kill(dead, 1000);
    expect(dead.entity.r.contents).toBe(CONTENTS.CORPSE);

    const gibbed = spawned();
    gibbed.state.stats[STAT.HEALTH] = 10;
    hurt(gibbed, selfSplash(100));
    expect(gibbed.entity.r.contents).toBe(0);
  });

  it('leaves an invisible body for a gibbed player', () => {
    const world = spawned();
    world.state.stats[STAT.HEALTH] = 10;
    at(world.level, 1000);
    hurt(world, selfSplash(100));
    world.life.endFrame();
    idle(world, 2704, ATTACK);

    // `ET_INVISIBLE`, which the player's own entity was already: there is nothing left to draw.
    expect(corpses(world.level)[0].s.eType).toBe(ET.INVISIBLE);
    expect(corpses(world.level)[0].takedamage).toBe(false);
  });

  it('starts the deaths and the bodies over on a restart', () => {
    const world = spawned();
    kill(world, 1000);
    idle(world, 2704, ATTACK);
    kill(world, 3000);

    at(world.level, 3008);
    world.life.restart();
    expect(corpses(world.level)).toHaveLength(0);
    expect(world.state.stats[STAT.HEALTH]).toBe(125);
    expect(kill(world, 4000)).toEqual([{ event: EV.DEATH1, parm: ENTITYNUM_WORLD }]);
  });
});

describe('G_RadiusDamage on the corpses', () => {
  it("gibs one a player's blasts take to −40, where it lies, scaled by their handicap", () => {
    const world = spawned({ handicap: 50 });
    kill(world, 1000);
    idle(world, 2704, ATTACK);
    const [body] = corpses(world.level);
    // Out of their own blast's way, so it reaches the body alone.
    world.state.origin = vec3(1000, 0, 24);
    world.level.unlinkEntity(world.entity);

    // 60 points at the middle of the corpse's box, which the handicap halves to 30.
    const { x, y, z } = body.r.currentOrigin;
    const blast = vec3(x, y, z - 16);
    at(world.level, 3000);
    radiusDamage(world.level, flat, blast, world.entity, 60, 120, null, MOD.ROCKET_SPLASH);
    expect(body.s.event).toBe(0);

    // The corpse is its own entity, so its gib rides on its own entity state rather than on the
    // player state of whoever blew it up — which is what puts the splat where the body lies.
    radiusDamage(world.level, flat, blast, world.entity, 60, 120, null, MOD.ROCKET_SPLASH);
    expect(eventNumber(body.s.event)).toBe(EV.GIB_PLAYER);
    expect(body.s.eventParm).toBe(0);
    expect(raised(world.state, 0)).toEqual([]);
    expect(body.s.eType).toBe(ET.INVISIBLE);
  });
});
