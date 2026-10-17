import { ENTITYNUM_NONE, MAX_GENTITIES, TR } from '../net/protocol';
import { f, qvmAngleVectors } from './cm/q-math';
import { damage } from './combat';
import { FL, MASK, MOD } from './constants';
import { ET, copyVec, type GameEntity } from './game-entity';
import type { Level } from './level';
import { radiusFromBounds } from './server-world';
import { qvmEvaluateTrajectory } from './trajectory';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * The push (`g_mover.c:36-492`): how a mover moves, and what it carries with it.
 *
 * A mover is never moved by integrating anything: each frame its trajectory says where it should
 * be, and the push tries to put it there. What stands on it, or what it would end inside, goes
 * with it, and if any of that cannot go, nothing does: everything the team's move pushed is put
 * back, the whole team's clock is held back a frame, and its master is told what blocked it.
 *
 * Everything here is the game module's arithmetic, in the QVM's floats, so a mover's place and a
 * rider's push are Quake 3's to the bit.
 */

/**
 * `pushed_t` (`g_mover.c:36-41`): where something a push moved was before it, to put it back. A
 * team's move keeps a list of them, in order, which is Quake 3's `pushed` and `pushed_p`.
 */
export interface Pushed {
  ent: GameEntity;
  origin: Vec3;
  angles: Vec3;
  deltayaw: number;
}

const AXES = ['x', 'y', 'z'] as const;

/** `ANGLE2SHORT` (`q_shared.h:1072`) in the QVM's floats: degrees to a 16-bit angle, truncated. */
function angleToShort(degrees: number): number {
  return Math.trunc(f(f(degrees * 65536) / 360)) & 65535;
}

/**
 * `G_TestEntityPosition` (`g_mover.c:51-70`): what an entity is stuck in where it stands, by a
 * trace that goes nowhere, a client at its player state's origin and anything else at its
 * trajectory's base. An entity with no clip mask of its own is tested as solid.
 *
 * @returns what it starts inside, or null if it is free
 */
export function testEntityPosition(level: Level, ent: GameEntity): GameEntity | null {
  const mask = ent.clipmask ? ent.clipmask : MASK.SOLID;
  const at = ent.client ? ent.client.ps.origin : ent.s.pos.trBase;
  const tr = level.trace(at, ent.r.mins, ent.r.maxs, at, ent.s.number, mask);
  if (tr.startsolid) return level.gentities[tr.entityNum];
  return null;
}

/** `AngleVectors`' three axes, into which the push's turn is worked out. */
const forward = [0, 0, 0];
const right = [0, 0, 0];
const up = [0, 0, 0];

/**
 * The move a turn adds to a point: `G_CreateRotationMatrix`, `G_TransposeMatrix` and
 * `G_RotatePoint` (`g_mover.c:77-108`), the point about the pusher turned by the transpose of the
 * turn's axes, less where it was. cgame's `CG_` copies of the three are the same arithmetic.
 *
 * @param amove - The turn, in degrees.
 * @param org - The point, from the pusher's origin.
 * @param move2 - What the turn moves it by, written in place.
 */
export function turnMove(amove: Vec3, org: Vec3, move2: Vec3): void {
  qvmAngleVectors([amove.x, amove.y, amove.z], forward, right, up);
  // `VectorInverse( matrix[1] )`, then each row of the transpose is a column of the axes.
  const x = f(f(f(forward[0] * org.x) + f(-right[0] * org.y)) + f(up[0] * org.z));
  const y = f(f(f(forward[1] * org.x) + f(-right[1] * org.y)) + f(up[1] * org.z));
  const z = f(f(f(forward[2] * org.x) + f(-right[2] * org.y)) + f(up[2] * org.z));
  move2.x = f(x - org.x);
  move2.y = f(y - org.y);
  move2.z = f(z - org.z);
}

/** `VectorAdd( v, move, v )`, in place, in floats. */
function addInto(v: Vec3, move: Vec3): void {
  v.x = f(v.x + move.x);
  v.y = f(v.y + move.y);
  v.z = f(v.z + move.z);
}

/**
 * `G_TryPushingEntity` (`g_mover.c:117-199`): move one entity with the pusher, by its move and by
 * its turn about the pusher's new origin, and turn a client's view with it.
 *
 * What the push left free is linked where it went. What it left stuck is put back where it was,
 * and if that is free it is left behind, as a sliding trapdoor leaves its rider; the turn of a
 * client's view is not taken back, as it is not in Quake 3. Anything not riding this pusher is
 * off the ground, so a pushed item falls.
 *
 * `EF_MOVER_STOP`'s refusal is not here: nothing in baseq3 sets it.
 *
 * @returns whether the push may go on: the entity was moved, or left where it was
 */
function tryPushingEntity(
  level: Level,
  check: GameEntity,
  pusher: GameEntity,
  move: Vec3,
  amove: Vec3,
  pushed: Pushed[]
): boolean {
  // "Save off the old position."
  if (pushed.length > MAX_GENTITIES) throw new Error('pushed_p > &pushed[MAX_GENTITIES]');
  const { client } = check;
  const saved: Pushed = {
    ent: check,
    origin: copy(client ? client.ps.origin : check.s.pos.trBase),
    angles: copy(check.s.apos.trBase),
    deltayaw: client ? client.ps.deltaAngles.y : 0
  };
  pushed.push(saved);

  // "Figure movement due to the pusher's amove."
  const from = client ? client.ps.origin : check.s.pos.trBase;
  const pivot = pusher.r.currentOrigin;
  const org = vec3(f(from.x - pivot.x), f(from.y - pivot.y), f(from.z - pivot.z));
  const move2 = vec3();
  turnMove(amove, org, move2);

  // "Add movement."
  addInto(check.s.pos.trBase, move);
  addInto(check.s.pos.trBase, move2);
  if (client) {
    addInto(client.ps.origin, move);
    addInto(client.ps.origin, move2);
    // "Make sure the client's view rotates when on a rotating mover."
    client.ps.deltaAngles.y += angleToShort(amove.y);
  }

  // "May have pushed them off an edge."
  if (check.s.groundEntityNum !== pusher.s.number) check.s.groundEntityNum = ENTITYNUM_NONE;

  if (!testEntityPosition(level, check)) {
    // "Pushed ok."
    copyVec(client ? client.ps.origin : check.s.pos.trBase, check.r.currentOrigin);
    level.linkEntity(check);
    return true;
  }

  // "If it is ok to leave in the old position, do it. This is only relevant for riding entities,
  // not pushed. Sliding trapdoors can cause this."
  copyVec(saved.origin, check.s.pos.trBase);
  if (client) copyVec(saved.origin, client.ps.origin);
  copyVec(saved.angles, check.s.apos.trBase);
  if (!testEntityPosition(level, check)) {
    check.s.groundEntityNum = ENTITYNUM_NONE;
    pushed.pop();
    return true;
  }

  // "Blocked."
  return false;
}

/**
 * `G_MoverPush` (`g_mover.c:264-412`): move a pusher by `move` and turn it by `amove`, and push
 * whatever it carries or runs into.
 *
 * The pusher goes to its new place first, and then each item, player, corpse and anything else
 * that falls is tried, in the world's order: one riding it always, anything else only if its box
 * is inside the pusher's new one, strictly, and it is stuck where it stands. The first that cannot
 * be pushed stops the move, and everything the team's move pushed goes back, last first. A
 * bobbing or swinging mover is never stopped: it kills what is in its way and goes on.
 *
 * The box the move sweeps is the pusher's bounds, grown along the move; a pusher turned at all, or
 * turning, sweeps a cube of its radius instead.
 *
 * Missiles are not pushed, and Team Arena's proximity mines, which are, are not ported.
 *
 * @param pushed - What the team's move has pushed so far, which this push adds to.
 * @returns what blocked the move, or null if nothing did
 */
export function moverPush(
  level: Level,
  pusher: GameEntity,
  move: Vec3,
  amove: Vec3,
  pushed: Pushed[]
): GameEntity | null {
  // "mins/maxs are the bounds at the destination, totalMins / totalMaxs are the bounds for the
  // entire move."
  const mins = vec3();
  const maxs = vec3();
  const totalMins = vec3();
  const totalMaxs = vec3();
  const { absmin, absmax, currentOrigin, currentAngles } = pusher.r;
  if (
    currentAngles.x !== 0 ||
    currentAngles.y !== 0 ||
    currentAngles.z !== 0 ||
    amove.x !== 0 ||
    amove.y !== 0 ||
    amove.z !== 0
  ) {
    const radius = radiusFromBounds(pusher.r.mins, pusher.r.maxs);
    for (const axis of AXES) {
      mins[axis] = f(f(currentOrigin[axis] + move[axis]) - radius);
      maxs[axis] = f(f(currentOrigin[axis] + move[axis]) + radius);
      totalMins[axis] = f(mins[axis] - move[axis]);
      totalMaxs[axis] = f(maxs[axis] - move[axis]);
    }
  } else {
    for (const axis of AXES) {
      mins[axis] = f(absmin[axis] + move[axis]);
      maxs[axis] = f(absmax[axis] + move[axis]);
      totalMins[axis] = absmin[axis];
      totalMaxs[axis] = absmax[axis];
      if (move[axis] > 0) totalMaxs[axis] = f(totalMaxs[axis] + move[axis]);
      else totalMins[axis] = f(totalMins[axis] + move[axis]);
    }
  }

  // "Unlink the pusher so we don't get it in the entityList."
  level.unlinkEntity(pusher);
  const listed = level.entitiesInBox(totalMins, totalMaxs);

  // "Move the pusher to its final position."
  addInto(currentOrigin, move);
  addInto(currentAngles, amove);
  level.linkEntity(pusher);

  // "See if any solid entities are inside the final position."
  for (const number of listed) {
    const check = level.gentities[number];

    // "Only push items and players."
    if (check.s.eType !== ET.ITEM && check.s.eType !== ET.PLAYER && !check.physicsObject) continue;

    // "If the entity is standing on the pusher, it will definitely be moved."
    if (check.s.groundEntityNum !== pusher.s.number) {
      // "See if the ent needs to be tested."
      const { absmin: cmin, absmax: cmax } = check.r;
      if (
        cmin.x >= maxs.x ||
        cmin.y >= maxs.y ||
        cmin.z >= maxs.z ||
        cmax.x <= mins.x ||
        cmax.y <= mins.y ||
        cmax.z <= mins.z
      ) {
        continue;
      }
      // "See if the ent's bbox is inside the pusher's final position. This does allow a fast
      // moving object to pass through a thin entity..."
      if (!testEntityPosition(level, check)) continue;
    }

    // "The entity needs to be pushed."
    if (tryPushingEntity(level, check, pusher, move, amove, pushed)) continue;

    // "Bobbing entities are instant-kill and never get blocked."
    if (pusher.s.pos.trType === TR.SINE || pusher.s.apos.trType === TR.SINE) {
      damage(level, check, pusher, pusher, null, 99999, 0, MOD.CRUSH);
      continue;
    }

    // "Move back any entities we already moved. Go backwards, so if the same entity was pushed
    // twice, it goes back to the original position." Each is linked again with the
    // `currentOrigin` the push gave it, which is not put back.
    for (let i = pushed.length - 1; i >= 0; i--) {
      const p = pushed[i];
      copyVec(p.origin, p.ent.s.pos.trBase);
      copyVec(p.angles, p.ent.s.apos.trBase);
      if (p.ent.client) {
        p.ent.client.ps.deltaAngles.y = p.deltayaw;
        copyVec(p.origin, p.ent.client.ps.origin);
      }
      level.linkEntity(p.ent);
    }
    return check;
  }

  return null;
}

/**
 * `G_MoverTeam` (`g_mover.c:420-470`): move every part of a mover team to where its trajectory
 * says it is now, or none of them.
 *
 * Blocked, every part's clock is held back by the frame, so each goes back to where it was and
 * stays there until it can go on, and the master's {@link GameEntity.blocked} is told what did it.
 * Otherwise each part whose move has ended is told so, by its {@link GameEntity.reached}.
 *
 * @param ent - The team's master.
 */
export function moverTeam(level: Level, ent: GameEntity): void {
  const origin = vec3();
  const angles = vec3();
  const move = vec3();
  const amove = vec3();
  let obstacle: GameEntity | null = null;

  // "Make sure all team members can move before committing any moves or calling any think
  // functions. If the move is blocked, all moved objects will be backed out."
  const pushed: Pushed[] = [];
  let part: GameEntity | null;
  for (part = ent; part; part = part.teamchain) {
    // "Get current position."
    qvmEvaluateTrajectory(part.s.pos, level.time, origin);
    qvmEvaluateTrajectory(part.s.apos, level.time, angles);
    const { currentOrigin, currentAngles } = part.r;
    move.x = f(origin.x - currentOrigin.x);
    move.y = f(origin.y - currentOrigin.y);
    move.z = f(origin.z - currentOrigin.z);
    amove.x = f(angles.x - currentAngles.x);
    amove.y = f(angles.y - currentAngles.y);
    amove.z = f(angles.z - currentAngles.z);
    obstacle = moverPush(level, part, move, amove, pushed);
    if (obstacle) break;
  }

  if (obstacle) {
    // "Go back to the previous position."
    for (part = ent; part; part = part.teamchain) {
      part.s.pos.trTime += level.time - level.previousTime;
      part.s.apos.trTime += level.time - level.previousTime;
      qvmEvaluateTrajectory(part.s.pos, level.time, part.r.currentOrigin);
      qvmEvaluateTrajectory(part.s.apos, level.time, part.r.currentAngles);
      level.linkEntity(part);
    }
    // "If the pusher has a "blocked" function, call it."
    ent.blocked?.(ent, obstacle);
    return;
  }

  // "The move succeeded."
  for (part = ent; part; part = part.teamchain) {
    // "Call the reached function if time is at or past end point."
    const { pos } = part.s;
    if (pos.trType === TR.LINEAR_STOP && level.time >= pos.trTime + pos.trDuration) {
      part.reached?.(part);
    }
  }
}

/**
 * `G_RunMover` (`g_mover.c:478-492`): a mover's frame. A team's master moves the whole team, and
 * only while it is going somewhere; then it thinks, as the frame thinks for anything else, so a
 * think set where the move ended runs in the same frame.
 *
 * A team's other members do nothing, their thinks included: "the captain will handle everything".
 */
export function runMover(level: Level, ent: GameEntity): void {
  if (ent.flags & FL.TEAMMEMBER) return;

  // "If stationary at one of the positions, don't move anything."
  if (ent.s.pos.trType !== TR.STATIONARY || ent.s.apos.trType !== TR.STATIONARY) {
    moverTeam(level, ent);
  }

  level.runThink(ent);
}
