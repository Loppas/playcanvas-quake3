import type { Axis } from './hand-pose';

/**
 * The angle and axis helpers of `q_math.c` that the player model reads, with Q3's own rounding.
 * `anglesToAxis` lives with the hand (`hand-pose.ts`).
 */

/** `AxisClear`: forward, left and up along the frame's own. */
export const IDENTITY_AXIS: Axis = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

/**
 * `AngleMod` (`q_math.c:582–585`): an angle into 0..360, on Q3's circle of 65,536 steps. It
 * truncates to a step, so an angle that has been through it moves in steps of 0.0055°.
 */
export function angleMod(degrees: number): number {
  return (360 / 65536) * (Math.trunc(degrees * (65536 / 360)) & 65535);
}

/**
 * `LerpAngle` (`q_math.c:539–551`): `frac` of the way from one angle to another, the short way
 * round. Only `to` is wrapped, and only once, so the answer can fall outside 0..360.
 */
export function lerpAngle(from: number, to: number, frac: number): number {
  if (to - from > 180) to -= 360;
  if (to - from < -180) to += 360;
  return from + frac * (to - from);
}

/** `AngleSubtract` (`q_math.c:561–572`): `a1 − a2`, wrapped into −180..180. */
export function angleSubtract(a1: number, a2: number): number {
  let a = a1 - a2;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

/**
 * `MatrixMultiply` (`q_math.c:910–929`): `a × b`, row by row. An axis's rows are forward, left
 * and up, so `child × parent` takes a child's axis, measured in its parent's frame, into the
 * frame the parent is measured in.
 */
export function matrixMultiply(a: Axis, b: Axis): Axis {
  const row = ([x, y, z]: Axis[number]): Axis[number] => [
    x * b[0][0] + y * b[1][0] + z * b[2][0],
    x * b[0][1] + y * b[1][1] + z * b[2][1],
    x * b[0][2] + y * b[1][2] + z * b[2][2]
  ];
  return [row(a[0]), row(a[1]), row(a[2])];
}
