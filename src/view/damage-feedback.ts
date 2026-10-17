import { angleVectors } from '../sim/pmove-math';
import { vec3, type Vec3 } from '../sim/vec3';
import { anglesToAxis } from './hand-pose';

/**
 * How a hurt shows in the view: `CG_DamageFeedback` (`cg_playerstate.c:92–182`), the
 * kick in `CG_OffsetFirstPersonView` (`cg_view.c:343–357`) and `CG_DamageBlendBlob`
 * (`cg_view.c:559–603`).
 *
 * A hurt that plays a pain sound bumps `damageEvent`, and the client then kicks the view away
 * from where it came from, splashes a blot of blood toward that side, and has the HUD's head
 * flinch that way.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `DAMAGE_DEFLECT_TIME` (`cg_local.h:39`): the kick takes this long to reach its depth. */
export const DAMAGE_DEFLECT_TIME = 100;

/** `DAMAGE_RETURN_TIME` (`cg_local.h:40`): and this long to come back. */
export const DAMAGE_RETURN_TIME = 400;

/** `DAMAGE_TIME` (`cg_local.h:41`): the blob fades, and the HUD's head flinches, over this long. */
export const DAMAGE_TIME = 500;

/** The kick is held between these, in degrees (`cg_playerstate.c:114–117`). */
export const DAMAGE_KICK_MIN = 5;
export const DAMAGE_KICK_MAX = 10;

/** At or under this health a hurt kicks by its damage; over it, by 40/health of it (`cg_playerstate.c:107–111`). */
const KICK_HEALTH = 40;

/** The byte a hurt with no direction, such as a fall, sends for both angles (`g_active.c:62–63`). */
const NO_DIRECTION = 255;

/** The blob sits this far ahead of the eye, and up to this far out toward the hurt (`cg_view.c:592–594`). */
export const BLOB_DISTANCE = 8;

/** The blob's opacity when fresh, as a byte (`cg_view.c:601`). */
const BLOB_ALPHA = 200;

/** `cg.damage*` and `cg.v_dmg_*`: the view's reaction to the last hurt. */
export interface DamageFeedback {
  /** `cg.damageTime`: when the last hurt that kicked the view landed; −∞ before any. */
  time: number;
  /** `cg.damageX`: where it came from across the view, −1 from the left to 1 from the right. */
  x: number;
  /** `cg.damageY`: and up it, −1 from below to 1 from above. */
  y: number;
  /** `cg.damageValue`: the kick's size in degrees, which sizes the blob; 0 before any hurt. */
  value: number;
  /** `cg.v_dmg_pitch` and `cg.v_dmg_roll`: the kick at its deepest, in degrees. */
  pitch: number;
  roll: number;
}

/** No hurt yet. */
export function createDamageFeedback(): DamageFeedback {
  return { time: Number.NEGATIVE_INFINITY, x: 0, y: 0, value: 0, pitch: 0, roll: 0 };
}

/** One of an axis' rows against a vector. */
function along(v: Vec3, row: readonly number[]): number {
  return v.x * row[0] + v.y * row[1] + v.z * row[2];
}

/** @param value - Held to −1…1. */
function unit(value: number): number {
  return Math.min(Math.max(value, -1), 1);
}

/**
 * `CG_DamageFeedback`: a hurt has landed, so kick the view away from it and mark where it came
 * from.
 *
 * The lower the health, the harder the kick: at 40 or less a hurt kicks by its damage in degrees,
 * above that by 40/health of it, and either way by 5–10°. A hurt from ahead tips the view back
 * and one from the side rolls it; a fall, which comes from no direction, tips it back and marks
 * the centre.
 *
 * @param yawByte - `ps.damageYaw`: which way the hurt travelled, a 256th of a turn.
 * @param pitchByte - `ps.damagePitch`.
 * @param damage - `ps.damageCount`: health and armor taken together.
 * @param health - The health the hurt left.
 * @param viewAngles - The view it is measured against: `cg.refdef.viewaxis`.
 * @param time - When it landed: `cg.damageTime`.
 */
export function damageFeedback(
  feedback: DamageFeedback,
  yawByte: number,
  pitchByte: number,
  damage: number,
  health: number,
  viewAngles: Readonly<Vec3>,
  time: number
): void {
  const scale = health < KICK_HEALTH ? 1 : KICK_HEALTH / health;
  const kick = Math.min(Math.max(damage * scale, DAMAGE_KICK_MIN), DAMAGE_KICK_MAX);

  if (yawByte === NO_DIRECTION && pitchByte === NO_DIRECTION) {
    feedback.x = 0;
    feedback.y = 0;
    feedback.roll = 0;
    feedback.pitch = -kick;
  } else {
    // A 256th of a turn going out, read back as a 255th: Q3's own mismatch.
    const pitch = (pitchByte / 255) * 360;
    const yaw = (yawByte / 255) * 360;
    // Toward where the hurt came from.
    const travel = angleVectors(vec3(pitch, yaw, 0)).forward;
    const dir = vec3(-travel.x, -travel.y, -travel.z);

    const axis = anglesToAxis(viewAngles.x, viewAngles.y, viewAngles.z);
    let front = along(dir, axis[0]);
    const left = along(dir, axis[1]);
    const up = along(dir, axis[2]);
    const distance = Math.max(Math.hypot(front, left), 0.1);

    feedback.roll = kick * left;
    feedback.pitch = -kick * front;
    if (front <= 0.1) front = 0.1;
    feedback.x = -left / front;
    feedback.y = up / distance;
  }

  feedback.x = unit(feedback.x);
  feedback.y = unit(feedback.y);
  feedback.value = kick;
  feedback.time = time;
}

/**
 * The kick's pitch and roll at `time`: in over 100 ms, back over 400 (`cg_view.c:343–357`).
 *
 * @param time - On the clock {@link DamageFeedback.time} was stamped on.
 */
export function damageKick(
  feedback: Readonly<DamageFeedback>,
  time: number
): { pitch: number; roll: number } {
  const elapsed = time - feedback.time;
  const ratio =
    elapsed < DAMAGE_DEFLECT_TIME
      ? elapsed / DAMAGE_DEFLECT_TIME
      : 1 - (elapsed - DAMAGE_DEFLECT_TIME) / DAMAGE_RETURN_TIME;
  if (!(ratio > 0)) return { pitch: 0, roll: 0 };
  return { pitch: ratio * feedback.pitch, roll: ratio * feedback.roll };
}

/** The blood blob: a sprite in front of the eye (`RT_SPRITE`, `RF_FIRST_PERSON`). */
export interface DamageBlob {
  /** Its place from the eye, along the view's forward, left and up, in units. */
  forward: number;
  left: number;
  up: number;
  /** Half the sprite's side, in units. */
  radius: number;
  /** Its opacity: 200/255 fresh, fading to nothing. */
  alpha: number;
}

/**
 * `CG_DamageBlendBlob`: the blob of blood after a hurt, 8 units ahead of the eye and toward where
 * the hurt came from, three units across per degree of kick, fading over 500 ms. Drawn in first
 * person only (`cg_view.c:811–813`).
 *
 * @returns the blob, or `null` while there is none
 */
export function damageBlob(feedback: Readonly<DamageFeedback>, time: number): DamageBlob | null {
  if (!feedback.value) return null;
  const t = time - feedback.time;
  if (t <= 0 || t >= DAMAGE_TIME) return null;
  return {
    forward: BLOB_DISTANCE,
    left: -BLOB_DISTANCE * feedback.x,
    up: BLOB_DISTANCE * feedback.y,
    radius: feedback.value * 3,
    alpha: Math.trunc(BLOB_ALPHA * (1 - t / DAMAGE_TIME)) / 255
  };
}
