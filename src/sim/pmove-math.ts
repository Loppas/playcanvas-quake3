import {
  PM_FLIGHTFRICTION,
  PM_FRICTION,
  PM_SPECTATORFRICTION,
  PM_STOPSPEED
} from './constants';
import type { UserCmd } from './types';
import { dot, length, madd, scale, vec3, type Vec3 } from './vec3';

/**
 * The pure, stateless parts of pmove. Separated from `pmove.ts` so the equations that define
 * the feel can be exercised directly, without a world or a player.
 */

/**
 * Remove the component of `velocity` heading into a plane, with a slight overbounce.
 *
 * Port of `PM_ClipVelocity` (bg_pmove.c:144). The overbounce leaves the result pointing
 * marginally away from the plane, which is what stops the mover re-colliding with the plane
 * it just slid along — and why you do not stick to walls.
 *
 * @param velocity - Velocity to clip.
 * @param normal - Unit plane normal.
 * @param overbounce - Overbounce factor; `OVERCLIP` (1.001) in normal use.
 */
export function clipVelocity(velocity: Vec3, normal: Vec3, overbounce: number): Vec3 {
  let backoff = dot(velocity, normal);
  backoff = backoff < 0 ? backoff * overbounce : backoff / overbounce;
  return madd(velocity, -backoff, normal);
}

/**
 * Accelerate towards `wishdir`, capped at `wishspeed`.
 *
 * Port of `PM_Accelerate` (bg_pmove.c:239) — the equation the whole game's movement rests on.
 * Current speed is measured as the *projection* of velocity onto `wishdir`, so velocity
 * perpendicular to the wish direction is invisible to the cap. Angling the wish direction
 * away from your current velocity therefore lets you keep gaining speed indefinitely: this
 * single line is strafe jumping and air control. id documented the "correct" alternative in
 * the source and kept this one because it feels better.
 *
 * @param velocity - Current velocity.
 * @param wishdir - Unit vector the player wants to move along.
 * @param wishspeed - Desired speed along `wishdir`.
 * @param accel - Acceleration coefficient: ground 10, air 1.
 * @param frametime - Tick length in seconds.
 */
export function accelerate(
  velocity: Vec3,
  wishdir: Vec3,
  wishspeed: number,
  accel: number,
  frametime: number
): Vec3 {
  const currentspeed = dot(velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) {
    return velocity;
  }

  const accelspeed = Math.min(accel * frametime * wishspeed, addspeed);
  return madd(velocity, accelspeed, wishdir);
}

/**
 * `PM_Friction`'s ground term (`bg_pmove.c:200–201`): the speed a second that walkable ground takes
 * off, which is proportional to the speed down to {@link PM_STOPSPEED} and constant below it.
 *
 * @param speed - The horizontal speed.
 * @param friction - `pm_friction`.
 */
export function groundDrop(speed: number, friction = PM_FRICTION): number {
  return Math.max(speed, PM_STOPSPEED) * friction;
}

/**
 * Apply friction.
 *
 * Port of `PM_Friction` (bg_pmove.c:171). Every move runs it, the air move as well as the walk
 * move. On walkable ground, above {@link PM_STOPSPEED}, this is exponential decay; below it, a
 * constant 600 ups deceleration, which is what makes stopping feel crisp rather than floaty. In the
 * air, and on the ground during the knockback window, nothing is removed — that is why air momentum
 * is preserved and why bunny hopping works — except that a speed under 1 ups stops dead.
 *
 * Water, flight and the spectator are terms of their own, each added to whatever else applies: a
 * flying player is slowed on the ground by the ground and flight coefficients together, and in the
 * air by flight alone. What suspends the ground term never suspends the others.
 *
 * @param velocity - Current velocity.
 * @param walking - Whether the player is on walkable ground. Only then is the speed measured
 *   flat, and only then does ground friction apply.
 * @param groundless - Whether the ground term is suspended though the player walks: in the
 *   knockback window (`PMF_TIME_KNOCKBACK`), on a slick floor, or waist deep in water.
 * @param frametime - Tick length in seconds.
 * @param flight - Whether the flight powerup is held (`pm->ps->powerups[PW_FLIGHT]`).
 * @param spectator - Whether this is a spectator's move (`pm_type == PM_SPECTATOR`), which is a
 *   heavier term than flight's and is read off the move type rather than a powerup.
 * @param ground - The ground term, as speed a second for a speed: {@link groundDrop} unless a
 *   move has its own.
 * @param water - The water term's coefficient, `pm_waterfriction` × the water level: 0 out of
 *   water, and wading or deeper it slows the whole speed.
 */
export function applyFriction(
  velocity: Vec3,
  walking: boolean,
  groundless: boolean,
  frametime: number,
  flight = false,
  spectator = false,
  ground: (speed: number) => number = groundDrop,
  water = 0
): Vec3 {
  // Only horizontal speed is measured while walking; in the air the fall counts too.
  const measured = walking ? vec3(velocity.x, velocity.y, 0) : velocity;
  const speed = length(measured);

  // Below 1 ups, stop dead rather than creeping. Z is preserved so falling is unaffected.
  if (speed < 1) {
    return vec3(0, 0, velocity.z);
  }

  let drop = 0;
  if (walking && !groundless) {
    drop += ground(speed) * frametime;
  }
  if (water) {
    drop += speed * water * frametime;
  }
  if (flight) {
    drop += speed * PM_FLIGHTFRICTION * frametime;
  }
  if (spectator) {
    drop += speed * PM_SPECTATORFRICTION * frametime;
  }
  if (drop === 0) {
    return velocity;
  }

  const newspeed = Math.max(speed - drop, 0);
  return scale(velocity, newspeed / speed);
}

/**
 * Convert raw input deflection into a speed scale.
 *
 * Port of `PM_CmdScale` (bg_pmove.c:289). Dividing by the total magnitude is what stops
 * diagonal input being faster than cardinal input. `upmove` participates, which is why
 * `PM_CheckJump` zeroes it once the jump is consumed.
 *
 * @param cmd - Input for this tick.
 * @param speed - The player's maximum ground speed.
 */
export function cmdScale(cmd: UserCmd, speed: number): number {
  const max = Math.max(Math.abs(cmd.forwardmove), Math.abs(cmd.rightmove), Math.abs(cmd.upmove));
  if (max === 0) {
    return 0;
  }

  const total = Math.sqrt(
    cmd.forwardmove * cmd.forwardmove +
      cmd.rightmove * cmd.rightmove +
      cmd.upmove * cmd.upmove
  );
  return (speed * max) / (127 * total);
}

/**
 * Round each velocity component to an integer.
 *
 * Port of `trap_SnapVector` (q_shared.h:467). In Q3 this exists because velocity is
 * networked as integers, but it is load-bearing for feel: it is the source of the
 * frame-rate-dependent jump heights, and it suppresses slow-speed creep. C's `round()`
 * breaks ties away from zero, which JavaScript's `Math.round` does not, so that is done
 * explicitly here.
 *
 * @param velocity - Velocity to snap.
 */
export function snapVector(velocity: Vec3): Vec3 {
  return vec3(roundHalfAwayFromZero(velocity.x), roundHalfAwayFromZero(velocity.y), roundHalfAwayFromZero(velocity.z));
}

/**
 * Derive the view basis from Euler angles.
 *
 * Port of `AngleVectors` (q_shared.c) for Q3's Z-up space, with roll fixed at zero: a
 * first-person view never rolls the collision basis, only the camera.
 *
 * @param angles - Pitch, yaw and roll in degrees. Roll is ignored.
 * @param into - Written in place, and returned; a new basis by default.
 */
export function angleVectors(
  angles: Vec3,
  into: ViewBasis = { forward: vec3(), right: vec3(), up: vec3() }
): ViewBasis {
  const pitch = (angles.x * Math.PI) / 180;
  const yaw = (angles.y * Math.PI) / 180;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);

  const { forward, right, up } = into;
  forward.x = cp * cy;
  forward.y = cp * sy;
  forward.z = -sp;
  right.x = sy;
  right.y = -cy;
  right.z = 0;
  up.x = sp * cy;
  up.y = sp * sy;
  up.z = cp;
  return into;
}

/** A view's forward, right and up axes. */
export interface ViewBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

/**
 * The pitch and yaw that point along a vector.
 *
 * Port of `vectoangles` (`q_math.c`). Yaw comes back in [0, 360). Pitch is Q3's, positive
 * looking down, but wrapped the way `vectoangles` wraps it: in (−360, 0], so a vector 10°
 * below the horizon gives −350 rather than 10.
 *
 * @param v - Direction; need not be unit length.
 */
export function vectorToAngles(v: Vec3): Vec3 {
  let yaw: number;
  let pitch: number;
  if (v.x === 0 && v.y === 0) {
    yaw = 0;
    pitch = v.z > 0 ? 90 : 270;
  } else {
    yaw = vectorToYaw(v);
    pitch = (Math.atan2(v.z, Math.hypot(v.x, v.y)) * 180) / Math.PI;
    if (pitch < 0) pitch += 360;
  }
  return vec3(-pitch, yaw, 0);
}

/**
 * The yaw that points along a vector's horizontal part, in [0, 360); 0 for a vertical one.
 * Port of `vectoyaw` (`g_utils.c`).
 *
 * @param v - Direction; its Z is ignored.
 */
export function vectorToYaw(v: Vec3): number {
  if (v.x === 0 && v.y === 0) return 0;
  let yaw: number;
  if (v.x) yaw = (Math.atan2(v.y, v.x) * 180) / Math.PI;
  else yaw = v.y > 0 ? 90 : 270;
  if (yaw < 0) yaw += 360;
  return yaw;
}

/**
 * An angle brought into [0, 360). Port of `AngleNormalize360` (`q_math.c`), which quantizes to a
 * sixteen-bit turn; the port keeps the angle continuous, since nothing on the wire carries one.
 *
 * @param angle - Angle in degrees.
 */
export function angleNormalize360(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * An angle brought into (−180, 180]. Port of `AngleNormalize180` (`q_math.c`).
 *
 * @param angle - Angle in degrees.
 */
export function angleNormalize180(angle: number): number {
  const normalized = angleNormalize360(angle);
  return normalized > 180 ? normalized - 360 : normalized;
}

/**
 * Round half away from zero, matching C's `round()`.
 *
 * @param value - Value to round.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
