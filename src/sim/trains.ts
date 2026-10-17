import type { SpawnVars } from '../formats/entity-text';
import { TR } from '../net/protocol';
import { f, vectorLength } from './cm/q-math';
import { MOVER, SVF, copyVec, type GameEntity } from './game-entity';
import { FRAMETIME } from './item-spawn';
import type { Level } from './level';
import { initMover, setMoverState } from './movers';
import { useTargets } from './targets';
import { thinkTimeAfterMsec } from './think-time';
import { vtos } from './vec3';

/**
 * Trains (`g_mover.c:1246-1457`): a mover that runs from one `path_corner` to the next, round a
 * chain the map names, for ever.
 *
 * A train starts at the world's origin and jumps to its first corner a frame after the map spawns,
 * once every corner is there to be found. Each leg runs at the corner's `speed`, or the train's,
 * and a corner with a `wait` holds the train there that long. Reaching a corner fires the corner's
 * other targets, as no one. Nothing stops a train but what it cannot push, and it has no word for
 * that: it waits until it can go on.
 */

/** `func_train`'s spawnflag 4 (`g_mover.c:1257`): no damage, which no train reads either way. */
const TRAIN_BLOCK_STOPS = 4;

/** A train's speed and damage when the map gives none (`g_mover.c:1433-1440`). */
const TRAIN_SPEED = 100;
const TRAIN_DAMAGE = 2;

/** `Think_BeginMoving` (`g_mover.c:1266-1269`): the wait at a corner is over, so go on. */
function thinkBeginMoving(level: Level, ent: GameEntity): void {
  ent.s.pos.trTime = level.time;
  ent.s.pos.trType = TR.LINEAR_STOP;
}

/**
 * `Reached_Train` (`g_mover.c:1276-1344`), ioquake3's: a train has got to a corner, so it fires
 * the corner's targets and sets off along the next leg, in the QVM's floats.
 *
 * A leg shorter than a millisecond is made one and the train goes unsent for it, as ioquake3 has
 * it; id's divided by its length of 0. The leg's loop sound is the corner's, which nothing sets,
 * so a train's `noise` stops at its first corner.
 */
export function reachedTrain(level: Level, ent: GameEntity): void {
  // "Copy the appropriate values."
  const next = ent.nextTrain;
  if (!next || !next.nextTrain) return; // "just stop"

  // "Fire all other targets."
  useTargets(level, next, null, level.itemMatch.print);

  // "Set the new trajectory."
  ent.nextTrain = next.nextTrain;
  copyVec(next.s.origin, ent.pos1);
  copyVec(next.nextTrain.s.origin, ent.pos2);

  // "If the path_corner has a speed, use that", "otherwise use the train's speed".
  let speed = next.speed ? next.speed : ent.speed;
  if (speed < 1) speed = 1;

  // "Calculate duration."
  const { pos1, pos2 } = ent;
  const length = vectorLength([f(pos2.x - pos1.x), f(pos2.y - pos1.y), f(pos2.z - pos1.z)]);
  ent.s.pos.trDuration = Math.trunc(f(f(length * 1000) / speed));

  // "Be sure to send to clients after any fast move case."
  ent.r.svFlags &= ~SVF.NOCLIENT;
  // "Fast move case."
  if (ent.s.pos.trDuration < 1) {
    ent.s.pos.trDuration = 1;
    // "Don't send entity to clients so it becomes really invisible."
    ent.r.svFlags |= SVF.NOCLIENT;
  }

  // "Looping sound."
  ent.s.loopSound = next.soundLoop;

  // "Start it going."
  setMoverState(level, ent, MOVER.ONE_TO_TWO, level.time);

  // "If there is a "wait" value on the target, don't start moving yet."
  if (next.wait) {
    ent.nextthink = thinkTimeAfterMsec(level, f(next.wait * 1000));
    ent.think = (self) => thinkBeginMoving(level, self);
    ent.s.pos.trType = TR.STATIONARY;
  }
}

/**
 * `Think_SetupTrainTargets` (`g_mover.c:1354-1394`): link a train's corners, then set it going
 * from the first.
 *
 * The first is whatever the train's `target` names first, of any class; each after it is the first
 * `path_corner` among what the one before it names. A chain that ends, or names nothing, is printed
 * and the train stays where it is. A chain that comes round to some corner other than its first is
 * walked for ever, as in Quake 3; none in the install does.
 */
function thinkSetupTrainTargets(level: Level, ent: GameEntity): void {
  const { print } = level.itemMatch;
  const first = level.find(null, 'targetname', ent.target!);
  ent.nextTrain = first;
  if (!first) {
    print(`func_train at ${vtos(ent.r.absmin)} with an unfound target`);
    return;
  }

  let path = first;
  do {
    const target = path.target;
    if (target === null) {
      print(`Train corner at ${vtos(path.s.origin)} without a target`);
      return;
    }

    // "Find a path_corner among the targets. There may also be other targets that get fired when
    // the corner is reached."
    let next: GameEntity | null = null;
    do {
      next = level.find(next, 'targetname', target);
      if (!next) {
        print(`Train corner at ${vtos(path.s.origin)} without a target path_corner`);
        return;
      }
    } while (next.classname !== 'path_corner');

    path.nextTrain = next;
    path = next;
  } while (path !== first);

  // "Start the train moving from the first corner."
  reachedTrain(level, ent);
}

/**
 * `SP_path_corner` (`g_mover.c:1404-1411`): a corner of a train's path, found by its name and
 * never linked. One with no name is printed and freed.
 */
export function spawnPathCorner(level: Level, ent: GameEntity): void {
  if (ent.targetname === null) {
    level.itemMatch.print(`path_corner with no targetname at ${vtos(ent.s.origin)}`);
    level.freeEntity(ent);
  }
}

/**
 * `SP_func_train` (`g_mover.c:1427-1457`): a train, at `speed`, 100 by default, from the corner its
 * `target` names. Its angles are cleared, and one with no target is printed where it has no
 * bounds yet, at the world's origin, and freed.
 *
 * Its use is a binary mover's, as every mover's is, so one fired by name runs its present leg as a
 * door would.
 *
 * @param vars - The map's pairs, for `InitMover`'s.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncTrain(level: Level, ent: GameEntity, vars: SpawnVars): void {
  ent.s.angles.x = ent.s.angles.y = ent.s.angles.z = 0;

  if (ent.spawnflags & TRAIN_BLOCK_STOPS) {
    ent.damage = 0;
  } else if (!ent.damage) {
    ent.damage = TRAIN_DAMAGE;
  }

  if (!ent.speed) ent.speed = TRAIN_SPEED;

  if (ent.target === null) {
    level.itemMatch.print(`func_train without a target at ${vtos(ent.r.absmin)}`);
    level.freeEntity(ent);
    return;
  }

  level.setBrushModel(ent, ent.model);
  initMover(level, ent, vars);

  ent.reached = (self) => reachedTrain(level, self);

  // "Start trains on the second frame, to make sure their targets have had a chance to spawn."
  ent.nextthink = level.time + FRAMETIME;
  ent.think = (self) => thinkSetupTrainTargets(level, self);
}
