import { PITCH_LIMIT_DEGREES } from '../sim/constants';

/**
 * Mouse-look angle maths. Pure — no engine or DOM types — so it survives every rewrite of
 * the camera around it.
 */

/** Euler yaw/pitch pair in degrees. Roll is always zero for a first-person view. */
export interface LookAngles {
  /** Rotation about the world up axis, normalised to [0, 360). */
  yaw: number;
  /**
   * Rotation about the view-right axis; positive looks up. A camera's stays within the pitch
   * limit. A client's, {@link clientLook}'s, has no bound, as Q3's `cl.viewangles` has none.
   */
  pitch: number;
}

/**
 * How far a client's pitch may move in one frame, in degrees: `CL_CreateCmd`'s check "to make sure
 * the angles haven't wrapped" (`cl_input.c:600–605`).
 */
export const MAX_PITCH_CHANGE = 90;

/** The mouse settings `CL_MouseMove` reads. */
export interface MouseSettings {
  /** `sensitivity`: a movement's counts are multiplied by it first. */
  sensitivity: number;
  /** `m_yaw`: degrees a count, side to side. */
  mYaw: number;
  /** `m_pitch`: degrees a count, up and down. Below 0 inverts the mouse. */
  mPitch: number;
}

/**
 * Turn a mouse movement into look, as `CL_MouseMove` does (`cl_input.c:436–517`): the counts
 * times `sensitivity`, then `m_yaw` degrees a count side to side and `m_pitch` up and down.
 * With Q3's `m_yaw` and `m_pitch` of 0.022, the port's default sensitivity of 6.8 turns 0.1496° a
 * count.
 *
 * Both axes are inverted: moving the mouse right (+dx) decreases yaw and moving it away
 * (-dy in DOM coordinates) increases pitch, which is what "look right" and "look up" mean
 * in a Y-up left-handed view.
 *
 * @param angles - Current look direction, read whole before anything is written.
 * @param dx - Horizontal mouse movement in counts.
 * @param dy - Vertical mouse movement in counts, DOM-style (positive is downward).
 * @param pitchLimit - Maximum absolute pitch in degrees.
 * @param into - Where the new look direction is written, which may be `angles` itself.
 * @returns The new look direction.
 */
export function mouseLook(
  angles: LookAngles,
  dx: number,
  dy: number,
  mouse: MouseSettings,
  pitchLimit: number = PITCH_LIMIT_DEGREES,
  into: LookAngles = { yaw: 0, pitch: 0 }
): LookAngles {
  const yaw = wrapDegrees(angles.yaw - dx * mouse.sensitivity * mouse.mYaw);
  const pitch = clamp(
    angles.pitch - dy * mouse.sensitivity * mouse.mPitch,
    -pitchLimit,
    pitchLimit
  );
  into.yaw = yaw;
  into.pitch = pitch;
  return into;
}

/**
 * Turn a client's own view angles, `cl.viewangles`, as `CL_CreateCmd` does
 * (`cl_input.c:578–605`): {@link mouseLook}'s turn, with no bound on the pitch, but at most
 * {@link MAX_PITCH_CHANGE} of it in one frame.
 *
 * The pitch a player sees is the server's. `PM_UpdateViewAngles` holds the view within the limit
 * by moving `delta_angles` under these angles (`Game.clientThink`), and a spawn faces the player
 * the same way. Clamping these as well would pin them wherever a spawn caught them: a player who
 * died looking down would respawn looking level, unable to look down at all.
 *
 * @param angles - Current angles; not mutated.
 * @param dx - Horizontal mouse movement in counts.
 * @param dy - Vertical mouse movement in counts, DOM-style (positive is downward).
 * @returns The new angles.
 */
export function clientLook(
  angles: LookAngles,
  dx: number,
  dy: number,
  mouse: MouseSettings
): LookAngles {
  const pitch = angles.pitch - dy * mouse.sensitivity * mouse.mPitch;
  return {
    yaw: wrapDegrees(angles.yaw - dx * mouse.sensitivity * mouse.mYaw),
    pitch: clamp(pitch, angles.pitch - MAX_PITCH_CHANGE, angles.pitch + MAX_PITCH_CHANGE)
  };
}

/**
 * Apply a relative mouse movement to a look direction, at one rate on both axes: the fly
 * camera's.
 *
 * @param angles - Current look direction; not mutated.
 * @param dx - Horizontal mouse movement in pixels.
 * @param dy - Vertical mouse movement in pixels, DOM-style (positive is downward).
 * @param sensitivity - Degrees of rotation per pixel of movement.
 * @param pitchLimit - Maximum absolute pitch in degrees.
 * @returns The new look direction.
 */
export function applyLookDelta(
  angles: LookAngles,
  dx: number,
  dy: number,
  sensitivity: number,
  pitchLimit: number = PITCH_LIMIT_DEGREES
): LookAngles {
  return mouseLook(angles, dx, dy, { sensitivity, mYaw: 1, mPitch: 1 }, pitchLimit);
}

/**
 * Normalise an angle to [0, 360). Yaw accumulates without bound over a session, and letting
 * it grow costs float precision.
 *
 * @param degrees - Angle to normalise.
 */
export function wrapDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * @param value - Value to constrain.
 * @param min - Lower bound.
 * @param max - Upper bound.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
