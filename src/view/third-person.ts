import { MASK } from '../sim/constants';
import { angleVectors } from '../sim/pmove-math';
import type { TraceFn } from '../sim/types';
import { copy, madd, sub, vec3, type Vec3 } from '../sim/vec3';
import type { FirstPersonView } from './camera-feel';

/**
 * Q3's third-person camera: `CG_OffsetThirdPersonView` (`cg_view.c:225–295`).
 *
 * It takes over from the first-person offsets whenever `cg_thirdPerson` is set or the player is
 * dead (`cg_view.c:804–805`). The camera rises 8 units above the eye and backs off 40 along the
 * view, its pitch halved so it looks down on the body rather than along the aim, then turns to
 * aim at a point 512 units ahead of the eye. An 8-unit box is traced out to it, so the camera
 * stops short of a wall, and climbs out of a low ceiling's way.
 *
 * Engine-free, like the rest of `src/view/`. The trace is the world's `TraceFn`, so the voxel
 * trace's seams reach the camera as they reach the player.
 */

/** `cg_thirdPersonRange` (`cg_main.c:262`): how far behind the eye the camera sits. */
export const THIRD_PERSON_RANGE = 40;

/** `cg_thirdPersonAngle` (`cg_main.c:263`): how far round the body the camera orbits, in degrees. */
export const THIRD_PERSON_ANGLE = 0;

/** `FOCUS_DISTANCE` (`cg_view.c:225`): the camera aims at a point this far along the view. */
export const FOCUS_DISTANCE = 512;

/** The camera starts this far above the eye (`cg_view.c:256`). */
export const CAMERA_RISE = 8;

/** A camera stopped short of its place climbs by this much of the way it lost (`cg_view.c:275`). */
export const BLOCKED_CLIMB = 32;

/** "Don't go too far overhead": the aim point lies at most this far below level (`cg_view.c:247`). */
const FOCUS_PITCH_LIMIT = 45;

/** The camera's box, 8 units on a side, so the view cannot near-clip a wall (`cg_view.c:231–232`). */
const CAMERA_MINS = vec3(-4, -4, -4);
const CAMERA_MAXS = vec3(4, 4, 4);

/** What the third-person camera is placed from. */
export interface ThirdPersonInput {
  /** `cg.refdef.vieworg` as it starts: the player's origin. */
  origin: Vec3;
  /** `cg.refdefViewAngles` as they start: where the player looks. */
  viewangles: Vec3;
  /** `ps.viewheight`: the eye's height above the origin. */
  viewheight: number;
  /**
   * `STAT_DEAD_YAW` while the player is dead, which the camera and its aim turn to; `null` while
   * alive (`cg_view.c:242–245`).
   */
  deadYaw: number | null;
  /** `cg.predictedPlayerState.clientNum`: the player, whom the camera's box passes through. */
  clientNum: number;
}

/**
 * Place the camera behind the player — `CG_OffsetThirdPersonView`.
 *
 * @param trace - `CG_Trace`, for the camera's box: at `MASK_SOLID`, the world and the brush models
 *   stop it, and nobody's body does.
 * @param range - `cg_thirdPersonRange`.
 * @param angle - `cg_thirdPersonAngle`: 0 behind the player, 90 at their left facing them.
 */
export function thirdPersonView(
  input: ThirdPersonInput,
  trace: TraceFn,
  range = THIRD_PERSON_RANGE,
  angle = THIRD_PERSON_ANGLE
): FirstPersonView {
  const eye = vec3(input.origin.x, input.origin.y, input.origin.z + input.viewheight);
  const focusAngles = copy(input.viewangles);
  const angles = copy(input.viewangles);

  // "If dead, look at killer."
  if (input.deadYaw !== null) {
    focusAngles.y = input.deadYaw;
    angles.y = input.deadYaw;
  }

  if (focusAngles.x > FOCUS_PITCH_LIMIT) focusAngles.x = FOCUS_PITCH_LIMIT;
  const focusPoint = madd(eye, FOCUS_DISTANCE, angleVectors(focusAngles).forward);

  let view = vec3(eye.x, eye.y, eye.z + CAMERA_RISE);
  angles.x *= 0.5;
  const { forward, right } = angleVectors(angles);
  const radians = (angle / 180) * Math.PI;
  view = madd(view, -range * Math.cos(radians), forward);
  view = madd(view, -range * Math.sin(radians), right);

  const blocked = trace(eye, CAMERA_MINS, CAMERA_MAXS, view, input.clientNum, MASK.SOLID);
  if (blocked.fraction !== 1) {
    view = copy(blocked.endpos);
    view.z += (1 - blocked.fraction) * BLOCKED_CLIMB;
    // "Try another trace to this position, because a tunnel may have the ceiling close enough
    // that this is poking out."
    view = copy(trace(eye, CAMERA_MINS, CAMERA_MAXS, view, input.clientNum, MASK.SOLID).endpos);
  }

  // Aim at the focus point from where the camera ended up.
  const toFocus = sub(focusPoint, view);
  const focusDistance = Math.max(Math.hypot(toFocus.x, toFocus.y), 1);
  angles.x = (-180 / Math.PI) * Math.atan2(toFocus.z, focusDistance);
  angles.y -= angle;
  return { origin: view, angles };
}
