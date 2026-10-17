import { spawnFloat, type SpawnVars } from '../formats/entity-text';
import { f, vectorNormalize, vectorSubtract } from './cm/q-math';
import { dirToByte } from './dir-byte';
import { ET, setMovedir, SVF, type GameEntity } from './game-entity';
import type { Level } from './level';
import { pickTarget } from './targets';
import { copy, vec3 } from './vec3';

/**
 * Portals (`g_misc.c:158–238`): a `misc_portal_surface` beside a map's portal shader says where the
 * view through it is from — the `misc_portal_camera` it targets, or itself, a mirror, when it
 * targets nothing.
 *
 * The surface is sent to the clients as an `ET_PORTAL` with the camera's place and aim, and the
 * server adds what the camera sees to what a client near the surface is sent. Both are linked
 * with no size, so they are in the world as points.
 */

/** How long a surface waits before finding its camera, in milliseconds (`g_misc.c:220`). */
export const LOCATE_CAMERA_DELAY = 100;

/** A camera's spawnflags (`g_misc.c:224`). */
export const CAMERA_SLOW_ROTATE = 1;
export const CAMERA_FAST_ROTATE = 2;
export const CAMERA_NO_SWING = 4;

/** The speeds a turning camera's surface sends in `s.frame` (`g_misc.c:172–176`). */
export const SLOW_ROTATE_FRAME = 25;
export const FAST_ROTATE_FRAME = 75;

/**
 * `SP_misc_portal_surface` (`g_misc.c:208–222`): a point in the world that is a portal, a mirror
 * until it finds the camera its `target` names a moment after the map has spawned.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 */
export function spawnPortalSurface(level: Level, self: GameEntity): void {
  self.r.mins = vec3();
  self.r.maxs = vec3();
  level.linkEntity(self);

  self.r.svFlags = SVF.PORTAL;
  self.s.eType = ET.PORTAL;

  if (self.target === null) {
    self.s.origin2 = copy(self.s.origin);
  } else {
    self.think = (it) => locateCamera(level, it);
    self.nextthink = level.time + LOCATE_CAMERA_DELAY;
  }
}

/**
 * `locateCamera` (`g_misc.c:158–202`): take the camera's place, its turning, its roll and its aim:
 * at whatever the camera targets, or along its angles, which are cleared. A surface whose camera
 * is not there is printed, in id's own spelling, and freed.
 */
function locateCamera(level: Level, self: GameEntity): void {
  const { print, random } = level.itemMatch;
  const owner = pickTarget(level, self.target, random, print);
  if (!owner) {
    print("Couldn't find target for misc_partal_surface");
    level.freeEntity(self);
    return;
  }
  self.r.ownerNum = owner.s.number;

  // "frame holds the rotate speed".
  if (owner.spawnflags & CAMERA_SLOW_ROTATE) {
    self.s.frame = SLOW_ROTATE_FRAME;
  } else if (owner.spawnflags & CAMERA_FAST_ROTATE) {
    self.s.frame = FAST_ROTATE_FRAME;
  }

  // "swing camera ?", 0 for no rotation at all.
  self.s.powerups = owner.spawnflags & CAMERA_NO_SWING ? 0 : 1;

  // "clientNum holds the rotate offset".
  self.s.clientNum = owner.s.clientNum;

  self.s.origin2 = copy(owner.s.origin);

  // "see if the portal_camera has a target".
  const dir = vec3();
  const target = pickTarget(level, owner.target, random, print);
  if (target) {
    const toward = [0, 0, 0];
    const to = target.s.origin;
    const from = owner.s.origin;
    vectorSubtract([to.x, to.y, to.z], [from.x, from.y, from.z], toward);
    vectorNormalize(toward);
    dir.x = toward[0];
    dir.y = toward[1];
    dir.z = toward[2];
  } else {
    setMovedir(owner.s.angles, dir);
  }

  self.s.eventParm = dirToByte(dir);
}

/**
 * `SP_misc_portal_camera` (`g_misc.c:228–238`): where a portal's view is from, with its `roll`
 * sent as a 256th of a turn.
 *
 * @param level - The level it is spawning into.
 * @param self - The entity the map's pairs filled in.
 * @param vars - The pairs, for `roll`.
 */
export function spawnPortalCamera(level: Level, self: GameEntity, vars: SpawnVars): void {
  self.r.mins = vec3();
  self.r.maxs = vec3();
  level.linkEntity(self);

  const roll = spawnFloat(vars, 'roll', '0');
  self.s.clientNum = Math.trunc(f(f(roll / 360) * 256));
}
