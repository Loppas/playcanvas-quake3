import type { Vec3 } from '../sim/vec3';
import type { ViewmodelSway } from './viewmodel';

/**
 * Where the first-person weapon's hand sits relative to the view — the rest of
 * `CG_AddViewWeapon` (`cgame/cg_weapons.c:1411-1417`) once `CG_CalculateWeaponPosition` has run.
 *
 * Engine-free like the rest of `src/view/`: the rig turns the result into a node's transform.
 */

/** Three directions — forward, left and up — as rows, the layout MD3 tags store. */
export type Axis = [[number, number, number], [number, number, number], [number, number, number]];

/**
 * `AnglesToAxis` (`q_math.c`), from degrees.
 *
 * Positive pitch looks down, positive yaw turns left, and positive roll lowers the right side.
 * Yaw turns about the world's up, pitch about the right it leaves, and roll about the forward
 * that results.
 *
 * @param out - Written and returned, for a caller that keeps its axis; a new one by default.
 */
export function anglesToAxis(pitch: number, yaw: number, roll: number, out?: Axis): Axis {
  const radians = Math.PI / 180;
  const sp = Math.sin(pitch * radians);
  const cp = Math.cos(pitch * radians);
  const sy = Math.sin(yaw * radians);
  const cy = Math.cos(yaw * radians);
  const sr = Math.sin(roll * radians);
  const cr = Math.cos(roll * radians);
  const axis: Axis = out ?? [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const [forward, left, up] = axis;
  forward[0] = cp * cy;
  forward[1] = cp * sy;
  forward[2] = -sp;
  // `AngleVectors` gives right; the axis keeps left, its negation.
  left[0] = sr * sp * cy - cr * sy;
  left[1] = sr * sp * sy + cr * cy;
  left[2] = sr * cp;
  up[0] = cr * sp * cy + sr * sy;
  up[1] = cr * sp * sy - sr * cy;
  up[2] = cr * cp;
  return axis;
}

/** The hand's place relative to the view, in Quake units. */
export interface HandPose {
  /** Offset from the eye, along the view's forward, left and up. */
  origin: [number, number, number];
  /** The hand's forward, left and up, each measured along the view's forward, left and up. */
  axis: Axis;
}

/**
 * Place the hand as Q3 does, relative to the view.
 *
 * Two things set Q3's placement apart from turning the gun in the view's own frame:
 * - It adds the sway to the view's angles and builds the hand's axis from the sum. So its yaw
 *   turns the gun about the world's up, not the view's: looking down, part of a yaw sway becomes
 *   a roll.
 * - It turns the gun about the hand's origin, which the fov drop has already lowered along the
 *   view's up, rather than about the eye.
 *
 * Turning the sway in the view's frame, about the eye, would put the gun up to 8 units from Q3's
 * at grapple speed, looking down.
 *
 * A landing lowers the origin along the world's up, not the view's: Q3 adds the gun's dip to the
 * eye's height, before the fov drop.
 *
 * @param viewAngles - The view's pitch, yaw and roll in degrees, as the camera uses them: the run
 *   and bob tilts included (`cg.refdefViewAngles`).
 * @param sway - The weapon's sway, from `viewmodelSway`.
 * @param fovOffset - The drop for a wide fov, from `viewmodelFovOffset`, along the view's up.
 * @param landOffset - The gun's own landing dip, from `viewmodelLandOffset`, along the world's up.
 */
export function handPose(
  viewAngles: Readonly<Vec3>,
  sway: ViewmodelSway,
  fovOffset: number,
  landOffset: number
): HandPose {
  const view = anglesToAxis(viewAngles.x, viewAngles.y, viewAngles.z);
  const hand = anglesToAxis(
    viewAngles.x + sway.pitch,
    viewAngles.y + sway.yaw,
    viewAngles.z + sway.roll
  );
  const alongView = ([x, y, z]: Axis[number]): Axis[number] => [
    x * view[0][0] + y * view[0][1] + z * view[0][2],
    x * view[1][0] + y * view[1][1] + z * view[1][2],
    x * view[2][0] + y * view[2][1] + z * view[2][2]
  ];
  // The world's up, measured along the view's axes, is each axis's height.
  return {
    origin: [landOffset * view[0][2], landOffset * view[1][2], fovOffset + landOffset * view[2][2]],
    axis: [alongView(hand[0]), alongView(hand[1]), alongView(hand[2])]
  };
}
