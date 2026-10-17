import { MASK } from '../sim/constants';

/**
 * `cg_fov` as Quake Live defines it: the horizontal angle on a 4:3 screen, with the
 * vertical angle kept as the screen widens. ioq3's is the horizontal angle on the screen itself
 * (`cg_view.c:489, 520–521`), which would narrow a wide view. PlayCanvas takes the vertical angle.
 * Under water, `CG_CalcFov` warps both. Engine-free.
 */

/** The screen `cg_fov` is measured across: 4:3, as Q3's 640×480. */
const FOV_ASPECT = 4 / 3;

/** `WAVE_AMPLITUDE` and `WAVE_FREQUENCY` (`cg_view.c:467–468`): degrees, and cycles a second. */
export const WAVE_AMPLITUDE = 1;
export const WAVE_FREQUENCY = 0.4;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/** The vertical angle a `cg_fov` gives, in degrees. */
export function verticalFov(cgFov: number): number {
  return toDegrees(2 * Math.atan(Math.tan(toRadians(cgFov) / 2) / FOV_ASPECT));
}

/** The `cg_fov` that gives a vertical angle: {@link verticalFov} turned round. */
export function fovForVertical(vertical: number): number {
  return toDegrees(2 * Math.atan(Math.tan(toRadians(vertical) / 2) * FOV_ASPECT));
}

/** The horizontal angle a `cg_fov` gives on a screen of the given aspect, in degrees. */
export function horizontalFov(cgFov: number, aspect: number): number {
  return toDegrees(2 * Math.atan(Math.tan(toRadians(verticalFov(cgFov)) / 2) * aspect));
}

/**
 * `CG_CalcFov`'s warp (`cg_view.c:524–535`): the degrees a view whose eye is in water, slime or
 * lava gains across and loses up and down, a sine of the game clock; 0 for an eye in none.
 *
 * @param contents - What the eye is in: `CG_PointContents( cg.refdef.vieworg, -1 )`.
 * @param time - `cg.time`, in milliseconds.
 */
export function underwaterWarp(contents: number, time: number): number {
  if (!(contents & MASK.WATER)) return 0;
  return WAVE_AMPLITUDE * Math.sin((time / 1000) * WAVE_FREQUENCY * Math.PI * 2);
}

/** A view's two angles, in degrees: `cg.refdef.fov_x` and `fov_y`. */
export interface ViewFov {
  x: number;
  y: number;
}

/**
 * The view's angles: those a `cg_fov` gives on a screen of the given aspect, the warp added
 * across and taken from up and down, as `CG_CalcFov` sets them (`cg_view.c:529–530`).
 *
 * @param warp - {@link underwaterWarp}'s degrees.
 */
export function viewFov(cgFov: number, aspect: number, warp: number): ViewFov {
  return { x: horizontalFov(cgFov, aspect) + warp, y: verticalFov(cgFov) - warp };
}

/** The aspect a projection with these two angles has: their tangents' ratio. */
export function fovAspect({ x, y }: ViewFov): number {
  return Math.tan(toRadians(x) / 2) / Math.tan(toRadians(y) / 2);
}
