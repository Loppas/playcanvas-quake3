import { spawnFloat, type SpawnVars } from '../formats/entity-text';
import { isSpectator } from './client';
import { f } from './cm/q-math';
import { DAMAGE_NO_PROTECTION, damage } from './combat';
import { CONTENTS, MOD, STAT, TEAM } from './constants';
import { ET, setMovedir, SVF, type GameEntity } from './game-entity';
import { FRAMETIME } from './item-spawn';
import { playerTouchesItem } from './items';
import type { Level } from './level';
import { doorTriggerTouch } from './movers';
import { useTargets } from './targets';
import { entitySound } from './temp-entity';
import { thinkTimeAfter } from './think-time';
import type { TraceResult } from './types';
import { vec3, vtos, type Vec3 } from './vec3';

/**
 * Triggers: `g_trigger.c`'s brushes that fire when a player walks into them, its timer, and
 * `G_TouchTriggers` (`g_active.c:236–310`), the pass that finds what a player walked into on the
 * frame that just moved them. The jump pad and the teleporter have files of their own.
 *
 * Quake 3 runs the pass from `ClientThink_real` right after the player is linked, so what it finds
 * is the world as the move left it. Two things are told apart. An *item* is picked up by a range
 * about the player rather than by contact, which is why a pickup can happen a step before the box
 * would touch — `BG_PlayerTouchesItem` is the same test the client predicts its own pickups with.
 * Everything else must really touch the player's box: a trigger by its brushes, which the host
 * answers through {@link Level.entityContact}.
 *
 * A spectators' pass is nearly empty: they work teleporters and the doors, and nothing else. A
 * dead player's is empty outright.
 */

/** `trigger_multiple`'s spawnflags (`g_trigger.c:87`): fired only by one side's players. */
export const MULTIPLE_RED_ONLY = 1;
export const MULTIPLE_BLUE_ONLY = 2;

/**
 * How long a `trigger_always` waits before it fires, in milliseconds (`g_trigger.c:130`): "we must
 * have some delay to make sure our use targets are present".
 */
export const TRIGGER_ALWAYS_DELAY = 300;

/** `sound/world/electro.wav`: what a hurt sounds like, unless it is silent. */
export const HURT_SOUND = 'sound/world/electro.wav';

/** A hurt's `dmg` when the map gives none, or 0 (`g_trigger.c:389–391`). */
export const HURT_DAMAGE = 5;

/** `trigger_hurt`'s spawnflags (`g_trigger.c:334`); 2 is unused. */
export const HURT_START_OFF = 1;
export const HURT_SILENT = 4;
export const HURT_NO_PROTECTION = 8;
export const HURT_SLOW = 16;

/** How long a slow hurt waits between hits, in milliseconds (`g_trigger.c:366`). */
export const HURT_SLOW_WAIT = 1000;

/** `func_timer`'s spawnflag 1: it starts on. */
export const TIMER_START_ON = 1;

/**
 * `InitTrigger` (`g_trigger.c:26–33`): a trigger, shaped by the brush model its `model` key names
 * and hidden from the clients. An angle on a trigger becomes its {@link GameEntity.movedir}, and
 * its angles are cleared.
 *
 * @param level - The level it is spawning into.
 * @param self - The trigger.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function initTrigger(level: Level, self: GameEntity): void {
  const { angles } = self.s;
  if (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) setMovedir(angles, self.movedir);

  level.setBrushModel(self, self.model);
  // "Replaces the -1 from trap_SetBrushModel."
  self.r.contents = CONTENTS.TRIGGER;
  self.r.svFlags = SVF.NOCLIENT;
}

/** `range` (`g_active.c:242`): the box about the player that is searched, 40 flanks and 52 up. */
const TOUCH_RANGE: Vec3 = vec3(40, 40, 52);

/**
 * A trace as Q3's `memset` leaves one before a touch: zeroed, which is fraction 0 and the world
 * as the entity it hit. Nothing that has a touch reads it here, but the shape is the caller's.
 */
function emptyTrace(): TraceResult {
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

/**
 * @param level - The world the player is in.
 * @param entity - The client's entity, with the box the move left it in.
 */
export function touchTriggers(level: Level, entity: GameEntity): void {
  const client = entity.client;
  if (!client) return;
  // Dead clients don't activate triggers.
  if (client.ps.stats[STAT.HEALTH] <= 0) return;

  const origin = client.ps.origin;
  const found = level.entitiesInBox(
    vec3(origin.x - TOUCH_RANGE.x, origin.y - TOUCH_RANGE.y, origin.z - TOUCH_RANGE.z),
    vec3(origin.x + TOUCH_RANGE.x, origin.y + TOUCH_RANGE.y, origin.z + TOUCH_RANGE.z)
  );

  // "Can't use ent->absmin, because that has a one unit pad": the player's own box about the
  // origin, which is what a contact test is measured with.
  const mins = vec3(origin.x + entity.r.mins.x, origin.y + entity.r.mins.y, origin.z + entity.r.mins.z);
  const maxs = vec3(origin.x + entity.r.maxs.x, origin.y + entity.r.maxs.y, origin.z + entity.r.maxs.z);

  for (const number of found) {
    const hit = level.gentities[number];

    if (!hit.touch && !entity.touch) continue;
    if (!(hit.r.contents & CONTENTS.TRIGGER)) continue;

    // A spectator works teleporters and doors and nothing else, the door known by its touch, as
    // "adding a new ET_? type will most likely cause network incompatibilities".
    if (
      isSpectator(client) &&
      hit.s.eType !== ET.TELEPORT_TRIGGER &&
      hit.touch !== doorTriggerTouch(level)
    ) {
      continue;
    }

    if (hit.s.eType === ET.ITEM) {
      if (!playerTouchesItem(client.ps, hit.s, level.time, level.rules)) continue;
    } else if (!level.entityContact(mins, maxs, hit)) {
      continue;
    }

    const trace = emptyTrace();
    hit.touch?.(hit, entity, trace);
    if (entity.r.svFlags & SVF.BOT && entity.touch) entity.touch(entity, hit, trace);
  }

  // A jump pad the move did not touch this frame is not the one it is riding.
  if (client.ps.jumppadFrame !== client.ps.pmoveFramecount) {
    client.ps.jumppadFrame = 0;
    client.ps.jumppadEnt = 0;
  }
}

/**
 * `ClientImpacts` (`g_active.c:198-224`): touch what the player's move stood on or ran into, each
 * once, in the order the move met it. Only a brush with a touch has anything to do: a plat holding
 * up under a living player, and a button pressed by walking into it. A dead player's move touches
 * too.
 *
 * @param entity - The client's entity.
 * @param touchents - The move's touch list, `pm->touchents`.
 */
export function clientImpacts(
  level: Level,
  entity: GameEntity,
  touchents: readonly number[]
): void {
  const trace = emptyTrace();
  for (let i = 0; i < touchents.length; i++) {
    // "Duplicated."
    if (touchents.indexOf(touchents[i]) !== i) continue;
    const other = level.gentities[touchents[i]];

    if (entity.r.svFlags & SVF.BOT && entity.touch) entity.touch(entity, other, trace);
    if (!other.touch) continue;
    other.touch(other, entity, trace);
  }
}

/**
 * `SP_trigger_multiple` (`g_trigger.c:94–108`): a brush that fires its targets when a player walks
 * into it or something fires it, then waits `wait` seconds, give or take `random`, before it will
 * again. A `wait` of 0 or less fires once.
 *
 * A `random` as long as the wait is cut to the wait less `FRAMETIME`, id's fix in milliseconds
 * where the wait is in seconds.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @param vars - The pairs, for `wait` and `random` with their defaults.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnTriggerMultiple(level: Level, self: GameEntity, vars: SpawnVars): void {
  self.wait = spawnFloat(vars, 'wait', '0.5');
  self.random = spawnFloat(vars, 'random', '0');
  if (self.random >= self.wait && self.wait >= 0) {
    self.random = f(self.wait - FRAMETIME);
    level.itemMatch.print('trigger_multiple has random >= wait');
  }

  // `Touch_Multi` and `Use_Multi` (`g_trigger.c:76–85`): a player who walks in sets it off.
  self.touch = (it, other) => {
    if (other.client) multiTrigger(level, it, other);
  };
  self.use = (it, _other, activator) => multiTrigger(level, it, activator);

  initTrigger(level, self);
  level.linkEntity(self);
}

/**
 * `multi_trigger` (`g_trigger.c:45–74`): fire, unless still waiting from the last time or set off
 * by a player of the wrong side. The wait is the think time, which `multi_wait` clears.
 */
function multiTrigger(level: Level, self: GameEntity, activator: GameEntity | null): void {
  self.activator = activator;
  // "can't retrigger until the wait is over".
  if (self.nextthink) return;

  const client = activator?.client;
  if (client) {
    if (self.spawnflags & MULTIPLE_RED_ONLY && client.sess.sessionTeam !== TEAM.RED) return;
    if (self.spawnflags & MULTIPLE_BLUE_ONLY && client.sess.sessionTeam !== TEAM.BLUE) return;
  }

  useTargets(level, self, activator, level.itemMatch.print);

  if (self.wait > 0) {
    self.think = (it) => {
      it.nextthink = 0;
    };
    self.nextthink = thinkTimeAfter(level, self.wait, self.random);
  } else {
    // "we can't just remove (self) here, because this is a touch function called while looping
    // through area links".
    self.touch = null;
    self.nextthink = level.time + FRAMETIME;
    self.think = (it) => level.freeEntity(it);
  }
}

/**
 * `SP_trigger_always` (`g_trigger.c:128–132`): fires its targets once, as the world, a moment
 * after the map has spawned, and goes. It has no brush and is never linked.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 */
export function spawnTriggerAlways(level: Level, self: GameEntity): void {
  self.nextthink = level.time + TRIGGER_ALWAYS_DELAY;
  // `trigger_always_think` (`g_trigger.c:120–123`).
  self.think = (it) => {
    useTargets(level, it, it, level.itemMatch.print);
    level.freeEntity(it);
  };
}

/**
 * `SP_trigger_hurt` (`g_trigger.c:383–402`), ioquake3's: a brush that hurts whatever walks into it
 * by `dmg`, one toucher at a time and at most every `FRAMETIME`, or every second if it is slow.
 * Any use turns it off or on again, and one that starts off is out of the world until then.
 *
 * id's took a use only with spawnflag 2, and left one that starts off in the world, where the
 * brush model's link had put it; no map in the install sets either flag or names a hurt.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnTriggerHurt(level: Level, self: GameEntity): void {
  initTrigger(level, self);

  self.noiseIndex = level.itemMatch.soundIndex(HURT_SOUND);
  self.touch = (it, other) => touchHurt(level, it, other);
  if (!self.damage) self.damage = HURT_DAMAGE;

  // `hurt_use` (`g_trigger.c:346–352`).
  self.use = (it) => {
    if (it.r.linked) {
      level.unlinkEntity(it);
    } else {
      level.linkEntity(it);
    }
  };

  // "link in to the world if starting active".
  if (self.spawnflags & HURT_START_OFF) {
    level.unlinkEntity(self);
  } else {
    level.linkEntity(self);
  }
}

/**
 * `hurt_touch` (`g_trigger.c:354–381`): hurt whatever can be hurt, unless the trigger hurt anyone
 * too recently, with its sound unless it is silent.
 *
 * Quake 3 re-arms it at `level.time` plus its wait, which at its 50 ms frame hurts every 100 ms
 * and at a finer tick a little less often. The re-arm is judged on Quake 3's frames instead
 * ({@link Level.q3FrameTime}), so it hurts every 100 ms at any `sv_fps`.
 */
function touchHurt(level: Level, self: GameEntity, other: GameEntity): void {
  if (!other.takedamage) return;

  const frameTime = level.q3FrameTime();
  if (self.timestamp > frameTime) return;
  self.timestamp = frameTime + (self.spawnflags & HURT_SLOW ? HURT_SLOW_WAIT : FRAMETIME);

  // "play sound".
  if (!(self.spawnflags & HURT_SILENT)) entitySound(level, other, self.noiseIndex);

  const dflags = self.spawnflags & HURT_NO_PROTECTION ? DAMAGE_NO_PROTECTION : 0;
  damage(level, other, self, self, null, self.damage, dflags, MOD.TRIGGER_HURT);
}

/**
 * `SP_func_timer` (`g_trigger.c:444–462`): fires its targets every `wait` seconds, give or take
 * `random`, while it is on. A use turns it on, firing at once, or off. It is never linked.
 *
 * `random` defaults to 1, whatever the editor's note says, and a `random` as long as the wait is
 * cut to the wait less `FRAMETIME`, id's fix in milliseconds where the wait is in seconds. So a
 * timer with `wait 3` and `random 4` waits anywhere from 94 seconds in the past to 100 in the
 * future, and one whose time falls at or before 0 never fires again, as in Quake 3.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @param vars - The pairs, for `wait` and `random` with their defaults.
 */
export function spawnFuncTimer(level: Level, self: GameEntity, vars: SpawnVars): void {
  self.random = spawnFloat(vars, 'random', '1');
  self.wait = spawnFloat(vars, 'wait', '1');

  self.use = (it, _other, activator) => useFuncTimer(level, it, activator);
  self.think = (it) => funcTimerThink(level, it);

  if (self.random >= self.wait) {
    self.random = f(self.wait - FRAMETIME);
    level.itemMatch.print(`func_timer at ${vtos(self.s.origin)} has random >= wait`);
  }

  if (self.spawnflags & TIMER_START_ON) {
    self.nextthink = level.time + FRAMETIME;
    self.activator = self;
  }

  self.r.svFlags = SVF.NOCLIENT;
}

/**
 * `func_timer_think` (`g_trigger.c:425–429`): fire, and set the next time. Its activator is the
 * timer itself or whoever turned it on, which is no one for a train's corner.
 */
function funcTimerThink(level: Level, self: GameEntity): void {
  useTargets(level, self, self.activator, level.itemMatch.print);
  // "set time before next firing".
  self.nextthink = thinkTimeAfter(level, self.wait, self.random);
}

/** `func_timer_use` (`g_trigger.c:431–442`): a timer that is on goes off; one that is off fires. */
function useFuncTimer(level: Level, self: GameEntity, activator: GameEntity | null): void {
  self.activator = activator;

  // "if on, turn it off".
  if (self.nextthink) {
    self.nextthink = 0;
    return;
  }

  // "turn it on".
  funcTimerThink(level, self);
}
