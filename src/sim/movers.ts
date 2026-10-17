import {
  spawnFloat,
  spawnInt,
  spawnVar,
  spawnVector,
  type SpawnVars
} from '../formats/entity-text';
import { TR } from '../net/protocol';
import { isSpectator } from './client';
import { f, vectorLength } from './cm/q-math';
import { damage } from './combat';
import { CONTENTS, FL, MOD, STAT } from './constants';
import { EV } from './events';
import {
  ET,
  MOVER,
  SVF,
  addEvent,
  copyVec,
  setMovedir,
  type GameEntity
} from './game-entity';
import { FRAMETIME } from './item-spawn';
import { IT } from './items';
import { Q3_FRAME_MSEC, type Level } from './level';
import { useTargets } from './targets';
import { teamDroppedFlagThink } from './team';
import { teleportPlayer } from './teleport';
import { tempEntity } from './temp-entity';
import { thinkTimeAfterMsec } from './think-time';
import { qvmEvaluateTrajectory } from './trajectory';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * The binary movers (`g_mover.c:504-1242`): doors, plats and buttons, each a brush model that
 * moves between two places, `pos1` at rest and `pos2` activated, and back; and `func_static`, one
 * that stands still (`:1474-1479`).
 *
 * A mover's move is a trajectory the push follows (`mover-push.ts`). A use starts it 50 ms on,
 * when the frame after a player's touch has come round. At either end it is told so and sits; at
 * `pos2` it fires its targets and waits to go back. A team of movers moves as one: its master is
 * used, and every member is given the same state at the same time.
 *
 * The arithmetic is the game module's, in the QVM's floats, so each mover's wire state is Quake
 * 3's to the bit.
 */

/** `func_door`'s spawnflags (`g_mover.c:932`): it starts at `pos2`, and it does not turn back. */
export const DOOR_START_OPEN = 1;
export const DOOR_CRUSHER = 4;

/** The doors' sounds (`g_mover.c:954-955`), at either end of a move and as it leaves one. */
export const DOOR_START_SOUND = 'sound/movers/doors/dr1_strt.wav';
export const DOOR_END_SOUND = 'sound/movers/doors/dr1_end.wav';

/** The plats' sounds (`g_mover.c:1121-1122`). */
export const PLAT_START_SOUND = 'sound/movers/plats/pt1_strt.wav';
export const PLAT_END_SOUND = 'sound/movers/plats/pt1_end.wav';

/** The buttons' one sound (`g_mover.c:1206`), as one leaves `pos1`. */
export const BUTTON_SOUND = 'sound/movers/switches/butn2.wav';

/**
 * How far into the world a door's trigger reaches past the door's thinnest side, either way
 * (`g_mover.c:909-910`), and how far past the door a spectator must stand to be put through it,
 * from the trigger's edge (`:836-837`).
 */
const DOOR_TRIGGER_REACH = 120;
const SPECTATOR_REACH = 100;

/** How far past the door a spectator is put (`g_mover.c:844-846`). */
const SPECTATOR_PAST = 10;

/** `tv( 10000000.0, 0, 0 )` (`g_mover.c:849`): a destination with no facing, kept as it is. */
const NO_ANGLES: Vec3 = vec3(10000000, 0, 0);

/** How long a plat a living player stands on stays up after the touch (`g_mover.c:1040`). */
const PLAT_HOLD = 1000;

/** How far in from a plat's sides its trigger stands (`g_mover.c:1083-1088`), and how high. */
const PLAT_TRIGGER_INSET = 33;
const PLAT_TRIGGER_RISE = 8;

/**
 * `SetMoverState` (`g_mover.c:509-542`): put a mover at an end, or on its way from one, from
 * `time`, and link it where that puts it now.
 *
 * Its speed is its distance over `trDuration`, in floats; at rest its last speed stays on the
 * wire.
 */
export function setMoverState(
  level: Level,
  ent: GameEntity,
  moverState: number,
  time: number
): void {
  ent.moverState = moverState;

  const { pos } = ent.s;
  pos.trTime = time;
  switch (moverState) {
    case MOVER.POS1:
      copyVec(ent.pos1, pos.trBase);
      pos.trType = TR.STATIONARY;
      break;
    case MOVER.POS2:
      copyVec(ent.pos2, pos.trBase);
      pos.trType = TR.STATIONARY;
      break;
    case MOVER.ONE_TO_TWO:
      copyVec(ent.pos1, pos.trBase);
      scaleMove(ent.pos2, ent.pos1, f(1000 / pos.trDuration), pos.trDelta);
      pos.trType = TR.LINEAR_STOP;
      break;
    case MOVER.TWO_TO_ONE:
      copyVec(ent.pos2, pos.trBase);
      scaleMove(ent.pos1, ent.pos2, f(1000 / pos.trDuration), pos.trDelta);
      pos.trType = TR.LINEAR_STOP;
      break;
  }
  qvmEvaluateTrajectory(pos, level.time, ent.r.currentOrigin);
  level.linkEntity(ent);
}

/** `VectorSubtract( to, from, delta )` then `VectorScale( delta, scale, out )`, in floats. */
function scaleMove(to: Vec3, from: Vec3, scale: number, out: Vec3): void {
  out.x = f(f(to.x - from.x) * scale);
  out.y = f(f(to.y - from.y) * scale);
  out.z = f(f(to.z - from.z) * scale);
}

/**
 * `MatchTeam` (`g_mover.c:552-558`): every member of a mover team to the same state at the same
 * time, "so all entities in a mover team will move from pos1 to pos2 in the same amount of time".
 *
 * @param teamLeader - The first to set, and each after it along its chain.
 */
export function matchTeam(
  level: Level,
  teamLeader: GameEntity,
  moverState: number,
  time: number
): void {
  for (let member: GameEntity | null = teamLeader; member; member = member.teamchain) {
    setMoverState(level, member, moverState, time);
  }
}

/** `ReturnToPos1` (`g_mover.c:567-577`): a mover's wait at `pos2` is over. */
function returnToPos1(level: Level, ent: GameEntity): void {
  matchTeam(level, ent, MOVER.TWO_TO_ONE, level.time);

  // "Looping sound", which nothing in baseq3 sets.
  ent.s.loopSound = ent.soundLoop;

  // "Starting sound."
  if (ent.sound2to1) addEvent(ent, EV.GENERAL_SOUND, ent.sound2to1, level.time);
}

/**
 * `Reached_BinaryMover` (`g_mover.c:585-624`): a mover has got to an end. At `pos2` it waits its
 * `wait`, then goes back, and fires its targets as whoever used it, or as itself; at `pos1` its
 * master closes the areaportal its use opened. Each member of a team reaches its end itself, with
 * its own sound and its own targets.
 *
 * A `wait` of −1 is −1000 ms from now, so a mover that arrives more than a second into the level
 * goes back the frame it arrives, and one that arrives sooner never does: its think time is not
 * after 0.
 *
 * @throws in Q3's words for a mover that is not on its way anywhere
 */
export function reachedBinaryMover(level: Level, ent: GameEntity): void {
  // "Stop the looping sound."
  ent.s.loopSound = ent.soundLoop;

  if (ent.moverState === MOVER.ONE_TO_TWO) {
    // "Reached pos2."
    setMoverState(level, ent, MOVER.POS2, level.time);
    if (ent.soundPos2) addEvent(ent, EV.GENERAL_SOUND, ent.soundPos2, level.time);

    // "Return to pos1 after a delay."
    ent.think = (self) => returnToPos1(level, self);
    ent.nextthink = thinkTimeAfterMsec(level, ent.wait);

    // "Fire targets."
    if (!ent.activator) ent.activator = ent;
    useTargets(level, ent, ent.activator, level.itemMatch.print);
  } else if (ent.moverState === MOVER.TWO_TO_ONE) {
    // "Reached pos1."
    setMoverState(level, ent, MOVER.POS1, level.time);
    if (ent.soundPos1) addEvent(ent, EV.GENERAL_SOUND, ent.soundPos1, level.time);

    // "Close areaportals."
    if (ent.teammaster === ent || !ent.teammaster) level.adjustAreaPortalState(ent, false);
  } else {
    throw new Error('Reached_BinaryMover: bad moverState');
  }
}

/**
 * `Use_BinaryMover` (`g_mover.c:632-701`): set a mover going, as a team's master.
 *
 * At `pos1` it leaves "50 msec later, because if this was player triggered, level.time hasn't
 * been advanced yet", and its master opens the areaportal it stands in. At `pos2` it waits its
 * `wait` again. On its way it turns back, timed so it reverses from where it is.
 *
 * @param other - What fired it.
 * @param activator - Who set that off, whose its targets will be, or no one, whose are its own.
 */
export function useBinaryMover(
  level: Level,
  ent: GameEntity,
  other: GameEntity,
  activator: GameEntity | null
): void {
  // "Only the master should be used."
  if (ent.flags & FL.TEAMMEMBER) {
    useBinaryMover(level, ent.teammaster!, other, activator);
    return;
  }

  ent.activator = activator;

  if (ent.moverState === MOVER.POS1) {
    // "Start moving 50 msec later, because if this was player triggered, level.time hasn't been
    // advanced yet."
    matchTeam(level, ent, MOVER.ONE_TO_TWO, level.time + 50);
    if (ent.sound1to2) addEvent(ent, EV.GENERAL_SOUND, ent.sound1to2, level.time);
    ent.s.loopSound = ent.soundLoop;
    // "Open areaportal."
    if (ent.teammaster === ent || !ent.teammaster) level.adjustAreaPortalState(ent, true);
    return;
  }

  // "If all the way up, just delay before coming down."
  if (ent.moverState === MOVER.POS2) {
    ent.nextthink = thinkTimeAfterMsec(level, ent.wait);
    return;
  }

  // "Only partway down before reversing."
  if (ent.moverState === MOVER.TWO_TO_ONE) {
    matchTeam(level, ent, MOVER.ONE_TO_TWO, reversalTime(level, ent));
    if (ent.sound1to2) addEvent(ent, EV.GENERAL_SOUND, ent.sound1to2, level.time);
    return;
  }

  // "Only partway up before reversing."
  if (ent.moverState === MOVER.ONE_TO_TWO) {
    matchTeam(level, ent, MOVER.TWO_TO_ONE, reversalTime(level, ent));
    if (ent.sound2to1) addEvent(ent, EV.GENERAL_SOUND, ent.sound2to1, level.time);
  }
}

/**
 * When a mover turning back must have set out from its far end to be where it is now: as long
 * before now as it has left to go, which is no more than the whole move.
 */
function reversalTime(level: Level, ent: GameEntity): number {
  const total = ent.s.pos.trDuration;
  const partial = Math.min(level.time - ent.s.pos.trTime, total);
  return level.time - (total - partial);
}

/**
 * `InitMover` (`g_mover.c:713-781`): what every mover shares, once its two ends are set: what it
 * draws besides its brushes, its loop sound, its light, its use, and its speed and duration from
 * `pos1` to `pos2`.
 *
 * It is linked at `pos1`, by its current origin, as an `ET_MOVER`. Its `speed` defaults to 100,
 * and its duration is the distance over it in floats, cut to whole milliseconds, and at least one.
 *
 * @param vars - The map's pairs, for `noise`, `light` and `color`.
 */
export function initMover(level: Level, ent: GameEntity, vars: SpawnVars): void {
  // "If the "model2" key is set, use a separate model for drawing, but clip against the brushes."
  if (ent.model2) ent.s.modelindex2 = level.itemMatch.modelIndex(ent.model2);

  // "If the "loopsound" key is set, use a constant looping sound when moving."
  const noise = spawnVar(vars, 'noise');
  if (noise !== undefined) ent.s.loopSound = level.itemMatch.soundIndex(noise);

  // "If the "color" or "light" keys are set, setup constantLight."
  const light = spawnFloat(vars, 'light', '100');
  const lightSet = spawnVar(vars, 'light') !== undefined;
  const color = vec3();
  const colorSet = spawnVector(vars, 'color', '1 1 1', color);
  if (lightSet || colorSet) {
    const r = Math.min(Math.trunc(f(color.x * 255)), 255);
    const g = Math.min(Math.trunc(f(color.y * 255)), 255);
    const b = Math.min(Math.trunc(f(color.z * 255)), 255);
    const i = Math.min(Math.trunc(f(light / 4)), 255);
    ent.s.constantLight = r | (g << 8) | (b << 16) | (i << 24);
  }

  ent.use = (self, other, activator) => useBinaryMover(level, self, other, activator);
  ent.reached = (self) => reachedBinaryMover(level, self);

  ent.moverState = MOVER.POS1;
  ent.r.svFlags = SVF.USE_CURRENT_ORIGIN;
  ent.s.eType = ET.MOVER;
  copyVec(ent.pos1, ent.r.currentOrigin);
  level.linkEntity(ent);

  ent.s.pos.trType = TR.STATIONARY;
  copyVec(ent.pos1, ent.s.pos.trBase);

  // "Calculate time to reach second position from speed."
  const { pos1, pos2 } = ent;
  const move = [f(pos2.x - pos1.x), f(pos2.y - pos1.y), f(pos2.z - pos1.z)];
  const distance = vectorLength(move);
  if (!ent.speed) ent.speed = 100;
  const { trDelta } = ent.s.pos;
  trDelta.x = f(move[0] * ent.speed);
  trDelta.y = f(move[1] * ent.speed);
  trDelta.z = f(move[2] * ent.speed);
  ent.s.pos.trDuration = Math.trunc(f(f(distance * 1000) / ent.speed));
  if (ent.s.pos.trDuration <= 0) ent.s.pos.trDuration = 1;
}

/**
 * `Blocked_Door` (`g_mover.c:800-822`): what a door or plat does to what stops it.
 *
 * Anything but a client is taken out of the way: a dropped flag goes home, and anything else pops
 * where its entity state says it is and is freed. A client is hurt by the mover's `dmg`, and the
 * mover turns back, unless it is a crusher, which keeps pressing.
 *
 * Quake 3 hurts on every frame a crusher is blocked, 20 times a second at its frame. A crusher here
 * hurts on the first of its frames in each of Quake 3's, so as often at any frame length.
 *
 * @param ent - The team's master.
 * @param other - What stopped it.
 */
export function blockedDoor(level: Level, ent: GameEntity, other: GameEntity): void {
  // "Remove anything other than a client."
  if (!other.client) {
    // "Except CTF flags!!!!"
    if (other.s.eType === ET.ITEM && other.item?.giType === IT.TEAM) {
      teamDroppedFlagThink(level, other);
      return;
    }
    tempEntity(level, other.s.origin, EV.ITEM_POP);
    level.freeEntity(other);
    return;
  }

  if (ent.damage && crusherMayHurt(level, ent)) {
    damage(level, other, ent, ent, null, ent.damage, 0, MOD.CRUSH);
  }
  // "Crushers don't reverse."
  if (ent.spawnflags & DOOR_CRUSHER) return;

  // "Reverse direction."
  useBinaryMover(level, ent, ent, other);
}

/**
 * Whether a blocked mover may hurt this frame: always, unless it is a crusher that has already
 * hurt in this one of Quake 3's frames.
 */
function crusherMayHurt(level: Level, ent: GameEntity): boolean {
  if (!(ent.spawnflags & DOOR_CRUSHER)) return true;
  const frameTime = level.q3FrameTime();
  if (ent.crushDebounceTime > frameTime) return false;
  ent.crushDebounceTime = frameTime + Q3_FRAME_MSEC;
  return true;
}

/**
 * `Touch_DoorTriggerSpectator` (`g_mover.c:829-850`), ioquake3's: a spectator within
 * {@link SPECTATOR_REACH} of the door's middle, on the trigger's thin axis, is put through it, just
 * past its far side, their facing and their speed kept.
 *
 * id's took a spectator from anywhere in the trigger to past its far edge, centred in the doorway,
 * turned to face through it and thrown on at 400.
 *
 * @param ent - The door's trigger.
 * @param other - The spectator.
 */
function touchDoorTriggerSpectator(level: Level, ent: GameEntity, other: GameEntity): void {
  const axis = AXES[ent.count];
  // "The constants below relate to constants in Think_SpawnNewDoorTrigger()."
  const doorMin = f(ent.r.absmin[axis] + SPECTATOR_REACH);
  const doorMax = f(ent.r.absmax[axis] - SPECTATOR_REACH);

  const origin = copy(other.client!.ps.origin);
  origin.x = f(origin.x);
  origin.y = f(origin.y);
  origin.z = f(origin.z);
  if (origin[axis] < doorMin || origin[axis] > doorMax) return;

  if (Math.abs(f(origin[axis] - doorMax)) < Math.abs(f(origin[axis] - doorMin))) {
    origin[axis] = f(doorMin - SPECTATOR_PAST);
  } else {
    origin[axis] = f(doorMax + SPECTATOR_PAST);
  }
  teleportPlayer(level, other, origin, NO_ANGLES);
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * `Touch_DoorTrigger` (`g_mover.c:857-868`): a player in a door's trigger uses the door, unless it
 * is already opening; a spectator, as the port tells one, is put through it while it is shut or
 * shutting.
 *
 * @param ent - The trigger, whose parent is the door's master.
 */
function touchDoorTrigger(level: Level, ent: GameEntity, other: GameEntity): void {
  const door = ent.parent!;
  if (other.client && isSpectator(other.client)) {
    // "If the door is not open and not opening."
    if (door.moverState !== MOVER.ONE_TO_TWO && door.moverState !== MOVER.POS2) {
      touchDoorTriggerSpectator(level, ent, other);
    }
  } else if (door.moverState !== MOVER.ONE_TO_TWO) {
    useBinaryMover(level, door, ent, other);
  }
}

/** Each level's `Touch_DoorTrigger`: one function, as Quake 3's is, so a touch is known by it. */
const doorTriggerTouches = new WeakMap<Level, NonNullable<GameEntity['touch']>>();

/**
 * `Touch_DoorTrigger` for a level: the touch every door's trigger has, which the touch pass lets a
 * spectator reach, as it lets one reach a teleporter.
 */
export function doorTriggerTouch(level: Level): NonNullable<GameEntity['touch']> {
  let touch = doorTriggerTouches.get(level);
  if (!touch) {
    touch = (self, other) => touchDoorTrigger(level, self, other);
    doorTriggerTouches.set(level, touch);
  }
  return touch;
}

/**
 * `Think_SpawnNewDoorTrigger` (`g_mover.c:879-925`): once every part of a door has spawned, make
 * them all shootable, and put a trigger round them all, its thinnest side widened by
 * {@link DOOR_TRIGGER_REACH} each way, x before y and y before z on a tie. Then match the team at
 * this frame, which is the time a door at rest sends.
 *
 * The trigger is a box with no model, linked, and sent to clients, who draw nothing for it.
 *
 * @param ent - The door team's master.
 */
export function thinkSpawnNewDoorTrigger(level: Level, ent: GameEntity): void {
  // "Set all of the members as shootable."
  for (let other: GameEntity | null = ent; other; other = other.teamchain) other.takedamage = true;

  // "Find the bounds of everything on the team."
  const mins = copy(ent.r.absmin);
  const maxs = copy(ent.r.absmax);
  for (let other = ent.teamchain; other; other = other.teamchain) {
    addPointToBounds(other.r.absmin, mins, maxs);
    addPointToBounds(other.r.absmax, mins, maxs);
  }

  // "Find the thinnest axis, which will be the one we expand."
  let best = 0;
  for (let i = 1; i < 3; i++) {
    const a = AXES[i];
    const b = AXES[best];
    if (f(maxs[a] - mins[a]) < f(maxs[b] - mins[b])) best = i;
  }
  const axis = AXES[best];
  maxs[axis] = f(maxs[axis] + DOOR_TRIGGER_REACH);
  mins[axis] = f(mins[axis] - DOOR_TRIGGER_REACH);

  // "Create a trigger with this size."
  const other = level.spawnEntity();
  other.classname = 'door_trigger';
  other.r.mins = mins;
  other.r.maxs = maxs;
  other.parent = ent;
  other.r.contents = CONTENTS.TRIGGER;
  other.touch = doorTriggerTouch(level);
  // "Remember the thinnest axis."
  other.count = best;
  level.linkEntity(other);

  matchTeam(level, ent, ent.moverState, level.time);
}

/** `AddPointToBounds` (`q_math.c:719-740`) on the entity's vectors. */
function addPointToBounds(v: Vec3, mins: Vec3, maxs: Vec3): void {
  for (const axis of AXES) {
    if (v[axis] < mins[axis]) mins[axis] = v[axis];
    if (v[axis] > maxs[axis]) maxs[axis] = v[axis];
  }
}

/**
 * The distance between a mover's two ends along its `movedir`: its size along each axis, as far
 * as it moves along it, less the `lip` it leaves showing (`g_mover.c:980-984, 1226-1230`).
 */
function travel(ent: GameEntity, lip: number): number {
  const { mins, maxs } = ent.r;
  const { movedir } = ent;
  const x = f(Math.abs(movedir.x) * f(maxs.x - mins.x));
  const y = f(Math.abs(movedir.y) * f(maxs.y - mins.y));
  const z = f(Math.abs(movedir.z) * f(maxs.z - mins.z));
  return f(f(f(x + y) + z) - lip);
}

/** `VectorMA( from, scale, dir, out )`, in floats. */
function along(from: Vec3, scale: number, dir: Vec3, out: Vec3): void {
  out.x = f(from.x + f(dir.x * scale));
  out.y = f(from.y + f(dir.y * scale));
  out.z = f(from.z + f(dir.z * scale));
}

/**
 * `SP_func_door` (`g_mover.c:948-1016`): a door, which slides along its angle its whole length
 * less its `lip`, 8 by default, at `speed`, 400 by default, waits `wait` seconds, 2 by default,
 * and comes back. One that starts open does all of that the other way round.
 *
 * A door with a `targetname` or a `health` is opened by being fired or shot; any other, a frame
 * after it spawns, puts a trigger round its team that opens it to a touch, and makes the team
 * shootable. A door with a `health` is shootable from the start. Either kind matches its team a
 * frame after it spawns, when every part of the team is there.
 *
 * @param vars - The map's pairs, for `lip`, `dmg` and `health`.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncDoor(level: Level, ent: GameEntity, vars: SpawnVars): void {
  ent.sound1to2 = ent.sound2to1 = level.itemMatch.soundIndex(DOOR_START_SOUND);
  ent.soundPos1 = ent.soundPos2 = level.itemMatch.soundIndex(DOOR_END_SOUND);

  ent.blocked = (self, other) => blockedDoor(level, self, other);

  // "Default speed of 400."
  if (!ent.speed) ent.speed = 400;
  // "Default wait of 2 seconds."
  if (!ent.wait) ent.wait = 2;
  ent.wait = f(ent.wait * 1000);
  // "Default lip of 8 units."
  const lip = spawnFloat(vars, 'lip', '8');
  // "Default damage of 2 points."
  ent.damage = spawnInt(vars, 'dmg', '2');

  // "First position at start."
  copyVec(ent.s.origin, ent.pos1);

  // "Calculate second position."
  level.setBrushModel(ent, ent.model);
  setMovedir(ent.s.angles, ent.movedir);
  along(ent.pos1, travel(ent, lip), ent.movedir, ent.pos2);

  // "If "start_open", reverse position 1 and 2."
  if (ent.spawnflags & DOOR_START_OPEN) {
    copyVec(ent.pos2, ent.pos1);
    copyVec(ent.s.origin, ent.pos2);
  }

  initMover(level, ent, vars);

  ent.nextthink = level.time + FRAMETIME;

  // Never true at a map's spawn, as `G_FindTeams` runs after it.
  if (!(ent.flags & FL.TEAMMEMBER)) {
    const health = spawnInt(vars, 'health', '0');
    if (health) ent.takedamage = true;
    if (ent.targetname !== null || health) {
      // "Non touch/shoot doors."
      ent.think = (self) => matchTeam(level, self, self.moverState, level.time);
    } else {
      ent.think = (self) => thinkSpawnNewDoorTrigger(level, self);
    }
  }
}

/**
 * `Touch_Plat` (`g_mover.c:1033-1042`): a living player on a plat at the top keeps it there a
 * second longer, as `ClientImpacts` finds them on it.
 */
function touchPlat(level: Level, ent: GameEntity, other: GameEntity): void {
  if (!other.client || other.client.ps.stats[STAT.HEALTH] <= 0) return;

  // "Delay return-to-pos1 by one second."
  if (ent.moverState === MOVER.POS2) ent.nextthink = level.time + PLAT_HOLD;
}

/**
 * `SpawnPlatTrigger` (`g_mover.c:1071-1104`): the trigger a plat at the bottom is set going by,
 * standing {@link PLAT_TRIGGER_INSET} in from its sides at `pos1`, from its bottom to just above
 * its top, and a unit across the middle on an axis too narrow for that. Only a client sets it off,
 * and only at the bottom (`Touch_PlatCenterTrigger`, `:1051-1059`).
 *
 * @param ent - The plat.
 */
function spawnPlatTrigger(level: Level, ent: GameEntity): void {
  // "The middle trigger will be a thin trigger just above the starting position."
  const trigger = level.spawnEntity();
  trigger.classname = 'plat_trigger';
  trigger.touch = (self, other) => {
    if (!other.client) return;
    if (self.parent!.moverState === MOVER.POS1) useBinaryMover(level, self.parent!, self, other);
  };
  trigger.r.contents = CONTENTS.TRIGGER;
  trigger.parent = ent;

  const { pos1 } = ent;
  const { mins, maxs } = ent.r;
  const tmin = vec3(
    f(f(pos1.x + mins.x) + PLAT_TRIGGER_INSET),
    f(f(pos1.y + mins.y) + PLAT_TRIGGER_INSET),
    f(pos1.z + mins.z)
  );
  const tmax = vec3(
    f(f(pos1.x + maxs.x) - PLAT_TRIGGER_INSET),
    f(f(pos1.y + maxs.y) - PLAT_TRIGGER_INSET),
    f(f(pos1.z + maxs.z) + PLAT_TRIGGER_RISE)
  );
  for (const axis of ['x', 'y'] as const) {
    if (tmax[axis] <= tmin[axis]) {
      tmin[axis] = f(pos1[axis] + f(f(mins[axis] + maxs[axis]) * 0.5));
      tmax[axis] = f(tmin[axis] + 1);
    }
  }

  trigger.r.mins = tmin;
  trigger.r.maxs = tmax;
  level.linkEntity(trigger);
}

/**
 * `SP_func_plat` (`g_mover.c:1118-1159`): a lift, drawn at its top and spawned at its bottom
 * `height` below, by default its own height less its `lip`. A player who steps into its trigger
 * sends it up at `speed`, 200 by default; it waits a second at the top, whatever its `wait`, and a
 * second more while a living player stands on it; then it comes back down.
 *
 * Its trigger is spawned here, unless the plat is fired by name, so it takes the slot after the
 * plat's. It is blocked as a door is, and its `dmg` is 2 by default.
 *
 * @param vars - The map's pairs, for `speed`, `dmg`, `wait`, `lip` and `height`.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncPlat(level: Level, ent: GameEntity, vars: SpawnVars): void {
  ent.sound1to2 = ent.sound2to1 = level.itemMatch.soundIndex(PLAT_START_SOUND);
  ent.soundPos1 = ent.soundPos2 = level.itemMatch.soundIndex(PLAT_END_SOUND);

  ent.s.angles.x = ent.s.angles.y = ent.s.angles.z = 0;

  ent.speed = spawnFloat(vars, 'speed', '200');
  ent.damage = spawnInt(vars, 'dmg', '2');
  ent.wait = spawnFloat(vars, 'wait', '1');
  const lip = spawnFloat(vars, 'lip', '8');

  ent.wait = 1000;

  // "Create second position."
  level.setBrushModel(ent, ent.model);

  let height = spawnFloat(vars, 'height', '0');
  if (spawnVar(vars, 'height') === undefined) height = f(f(ent.r.maxs.z - ent.r.mins.z) - lip);

  // "pos1 is the rest (bottom) position, pos2 is the top."
  copyVec(ent.s.origin, ent.pos2);
  copyVec(ent.pos2, ent.pos1);
  ent.pos1.z = f(ent.pos1.z - height);

  initMover(level, ent, vars);

  // "Touch function keeps the plat from returning while a live player is standing on it."
  ent.touch = (self, other) => touchPlat(level, self, other);
  ent.blocked = (self, other) => blockedDoor(level, self, other);
  // "So it can be treated as a door."
  ent.parent = ent;

  // "Spawn the trigger if one hasn't been custom made."
  if (ent.targetname === null) spawnPlatTrigger(level, ent);
}

/**
 * `SP_func_static` (`g_mover.c:1474-1479`): "a bmodel that just sits there, doing nothing", a
 * mover all the same, put back where the map put it.
 *
 * `InitMover` links it at its `pos1`, which nothing set, and its origin is put back without a link,
 * so one with an origin key is filed in the world's lists about the world's origin. A use sets it
 * going from there as a binary mover, as Quake 3's does.
 *
 * @param vars - The map's pairs, for `InitMover`'s.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncStatic(level: Level, ent: GameEntity, vars: SpawnVars): void {
  level.setBrushModel(ent, ent.model);
  initMover(level, ent, vars);
  copyVec(ent.s.origin, ent.s.pos.trBase);
  copyVec(ent.s.origin, ent.r.currentOrigin);
}

/**
 * `SP_func_button` (`g_mover.c:1200-1242`): a button, which slides along its angle its whole
 * length less its `lip`, 4 by default, at `speed`, 40 by default, fires its targets, waits `wait`
 * seconds, 1 by default, and comes back. One with a `health` is shot to press it, and any other
 * is walked into, as `ClientImpacts` finds a player against it (`Touch_Button`, `:1176-1184`).
 *
 * @param vars - The map's pairs, for `lip`.
 * @throws as `trap_SetBrushModel` does, for no `model` or one the map has not got
 */
export function spawnFuncButton(level: Level, ent: GameEntity, vars: SpawnVars): void {
  ent.sound1to2 = level.itemMatch.soundIndex(BUTTON_SOUND);

  if (!ent.speed) ent.speed = 40;
  if (!ent.wait) ent.wait = 1;
  ent.wait = f(ent.wait * 1000);

  // "First position."
  copyVec(ent.s.origin, ent.pos1);

  // "Calculate second position."
  level.setBrushModel(ent, ent.model);
  const lip = spawnFloat(vars, 'lip', '4');
  setMovedir(ent.s.angles, ent.movedir);
  along(ent.pos1, travel(ent, lip), ent.movedir, ent.pos2);

  if (ent.health) {
    // "Shootable button."
    ent.takedamage = true;
  } else {
    // "Touchable button."
    ent.touch = (self, other) => {
      if (!other.client) return;
      if (self.moverState === MOVER.POS1) useBinaryMover(level, self, other, other);
    };
  }

  initMover(level, ent, vars);
}
