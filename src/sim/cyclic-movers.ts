import { spawnFloat, spawnInt, type SpawnVars } from '../formats/entity-text';
import { TR } from '../net/protocol';
import { f } from './cm/q-math';
import { copyVec, type GameEntity } from './game-entity';
import type { Level } from './level';
import { initMover } from './movers';

/**
 * The movers that never stop (`g_mover.c:1482-1633`): one that turns, one that bobs and one that
 * swings, each on a trajectory of its own from the level's start, which the push follows every
 * frame.
 *
 * Nothing blocks one that bobs or swings: what is in its way is killed (`mover-push.ts`). One that
 * turns does nothing about a block, and waits until it can go on. Each is a mover, so a use sets it
 * going as a binary mover from the world's origin, its own trajectory written over, as in Quake 3.
 */

/** `func_rotating`'s spawnflags (`g_mover.c:1491`): turn about x, a roll, or y, a pitch. */
export const ROTATING_X_AXIS = 4;
export const ROTATING_Y_AXIS = 8;

/** `func_bobbing`'s spawnflags (`g_mover.c:1541`): bob along x or y rather than z. */
export const BOBBING_X_AXIS = 1;
export const BOBBING_Y_AXIS = 2;

/** What a mover that turns takes when the map gives no `speed` or `dmg`. */
const ROTATING_SPEED = 100;
const ROTATING_DAMAGE = 2;

/** `1 / ( M_PI * 2 )` (`g_mover.c:1618`), which q3lcc folds into one float. */
const INVERSE_TWO_PI = f(1 / (2 * Math.PI));

/** The shortest arm a pendulum's swing is worked out for (`g_mover.c:1614-1616`). */
const PENDULUM_MIN_LENGTH = 8;

/**
 * `SP_func_rotating` (`g_mover.c:1502-1529`): a brush that turns about its origin brush at `speed`
 * degrees a second, 100 by default, about z, or x or y by its flags, from no turn at the level's
 * start. Its `angles` and its start-on flag are not read, so it turns from the first frame.
 *
 * @param vars - The map's pairs, for `InitMover`'s.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncRotating(level: Level, ent: GameEntity, vars: SpawnVars): void {
  if (!ent.speed) ent.speed = ROTATING_SPEED;

  // "Set the axis of rotation."
  const { apos } = ent.s;
  apos.trType = TR.LINEAR;
  if (ent.spawnflags & ROTATING_X_AXIS) {
    apos.trDelta.z = ent.speed;
  } else if (ent.spawnflags & ROTATING_Y_AXIS) {
    apos.trDelta.x = ent.speed;
  } else {
    apos.trDelta.y = ent.speed;
  }

  if (!ent.damage) ent.damage = ROTATING_DAMAGE;

  level.setBrushModel(ent, ent.model);
  initMover(level, ent, vars);

  copyVec(ent.s.origin, ent.s.pos.trBase);
  copyVec(ent.s.pos.trBase, ent.r.currentOrigin);
  copyVec(ent.s.apos.trBase, ent.r.currentAngles);

  level.linkEntity(ent);
}

/**
 * `SP_func_bobbing` (`g_mover.c:1551-1578`): a brush that bobs `height` units either way of where
 * the map put it, 32 by default, along z, or x or y by its flags, once every `speed` seconds, 4 by
 * default, from `phase` of the way through, in the QVM's floats.
 *
 * @param vars - The map's pairs, for `speed`, `height`, `dmg` and `phase`, and `InitMover`'s.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncBobbing(level: Level, ent: GameEntity, vars: SpawnVars): void {
  ent.speed = spawnFloat(vars, 'speed', '4');
  const height = spawnFloat(vars, 'height', '32');
  ent.damage = spawnInt(vars, 'dmg', '2');
  const phase = spawnFloat(vars, 'phase', '0');

  level.setBrushModel(ent, ent.model);
  initMover(level, ent, vars);

  copyVec(ent.s.origin, ent.s.pos.trBase);
  copyVec(ent.s.origin, ent.r.currentOrigin);

  // A `speed` of 0 is `InitMover`'s 100 by now: a bob every 100 seconds.
  const { pos } = ent.s;
  pos.trDuration = Math.trunc(f(ent.speed * 1000));
  pos.trTime = Math.trunc(f(pos.trDuration * phase));
  pos.trType = TR.SINE;

  // "Set the axis of bobbing."
  if (ent.spawnflags & BOBBING_X_AXIS) {
    pos.trDelta.x = height;
  } else if (ent.spawnflags & BOBBING_Y_AXIS) {
    pos.trDelta.y = height;
  } else {
    pos.trDelta.z = height;
  }
}

/**
 * `SP_func_pendulum` (`g_mover.c:1600-1633`): a brush that swings `speed` degrees either way of its
 * `angles`, 30 by default, about its roll, from `phase` of the way through.
 *
 * Its period is a pendulum's whose arm reaches from its origin brush down to its foot, at least 8
 * units, under `g_gravity` as the game took it up before the map set its own: `1 / 2π` times the
 * root of gravity over three arms, in the QVM's floats, the root a trap's.
 *
 * @param vars - The map's pairs, for `speed`, `dmg` and `phase`, and `InitMover`'s.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncPendulum(level: Level, ent: GameEntity, vars: SpawnVars): void {
  const speed = spawnFloat(vars, 'speed', '30');
  ent.damage = spawnInt(vars, 'dmg', '2');
  const phase = spawnFloat(vars, 'phase', '0');

  level.setBrushModel(ent, ent.model);

  // "Find pendulum length."
  let length = Math.abs(ent.r.mins.z);
  if (length < PENDULUM_MIN_LENGTH) length = PENDULUM_MIN_LENGTH;

  const root = f(Math.sqrt(f(level.itemMatch.gravity() / f(3 * length))));
  const freq = f(INVERSE_TWO_PI * root);

  // `InitMover` sets it again, to 1.
  ent.s.pos.trDuration = Math.trunc(f(1000 / freq));

  initMover(level, ent, vars);

  copyVec(ent.s.origin, ent.s.pos.trBase);
  copyVec(ent.s.origin, ent.r.currentOrigin);

  copyVec(ent.s.angles, ent.s.apos.trBase);

  const { apos } = ent.s;
  apos.trDuration = Math.trunc(f(1000 / freq));
  apos.trTime = Math.trunc(f(apos.trDuration * phase));
  apos.trType = TR.SINE;
  apos.trDelta.z = speed;
}
