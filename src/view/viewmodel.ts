import { WP, type WeaponId } from '../sim/weapons/constants';
import type { Animation } from '../formats/animation-config';
import { ANIM } from '../sim/animations';
import type { FrameBlend } from './player-animation';

/**
 * First-person weapon presentation maths — `CG_CalculateWeaponPosition` and
 * `CG_MapTorsoToWeaponFrame` (`cgame/cg_weapons.c:908, 1356`).
 *
 * Engine-free like the rest of `src/view/`, so the two things most likely to look wrong —
 * which animation frame is showing, and how much the gun sways — can be tested without a
 * graphics device.
 *
 * The rig this feeds is unusual: `<w>_hand.md3` has **no geometry at all**.
 * It is a pure animated tag rig, so "animating the viewmodel" means interpolating the
 * `tag_weapon` transform between frames of a model that draws nothing. There is no hand
 * mesh in Quake 3's first-person view.
 */

/** `MUZZLE_FLASH_TIME` — how long a one-shot flash is drawn (`cg_weapons.c`). */
export const MUZZLE_FLASH_MS = 20;

/**
 * Whether a weapon's muzzle flash shows this frame — `CG_AddPlayerWeapon`.
 *
 * The lightning gun, the gauntlet and the grapple flash continuously while `EF_FIRING` is set;
 * everything else flashes for 20 ms after a shot. The lightning bolt is drawn exactly when its
 * gun's flash is, because Q3 draws it straight after the flash, on the same path.
 *
 * @param firing - `EF_FIRING`.
 * @param msSinceFire - Milliseconds since the last shot.
 */
export function flashVisible(weapon: WeaponId, firing: boolean, msSinceFire: number): boolean {
  const continuous =
    weapon === WP.LIGHTNING || weapon === WP.GAUNTLET || weapon === WP.GRAPPLING_HOOK;
  return (continuous && firing) || (msSinceFire >= 0 && msSinceFire < MUZZLE_FLASH_MS);
}

/** Which pair of hand-rig frames to interpolate, and how far between them. */
export interface ViewmodelFrames {
  from: number;
  to: number;
  /** 0 gives `from`, 1 gives `to`. */
  frac: number;
}

/** The torso frames the hand follows from `TORSO_DROP`'s first: the drop and the raise (`cg_weapons.c:882–883`). */
const HAND_CHANGE_FRAMES = 9;

/** ...and from either attack's first (`cg_weapons.c:888–897`). */
const HAND_ATTACK_FRAMES = 6;

/**
 * `CG_MapTorsoToWeaponFrame` (`cg_weapons.c:879–900`): the hand-rig frame a torso frame stands for.
 * The nine frames from `TORSO_DROP`'s first, which the retail models give to the drop and
 * the raise after it, are the hand's 6–14; either attack's six are its 1–6. Any other torso frame
 * holds the hand at rest, on 0.
 */
export function torsoToHandFrame(animations: readonly Animation[], frame: number): number {
  const drop = animations[ANIM.TORSO_DROP].firstFrame;
  if (frame >= drop && frame < drop + HAND_CHANGE_FRAMES) return frame - drop + 6;
  for (const row of [ANIM.TORSO_ATTACK, ANIM.TORSO_ATTACK2]) {
    const first = animations[row].firstFrame;
    if (frame >= first && frame < first + HAND_ATTACK_FRAMES) return 1 + frame - first;
  }
  return 0;
}

/**
 * The hand's frames for this moment, taken from the torso's as `CG_AddViewWeapon` takes them
 * (`cg_weapons.c:1424–1430`), so the chosen model's `animation.cfg` times the gun's drop, raise
 * and recoil.
 *
 * @param torso - The player's own torso, as its lerp frame last left it.
 */
export function handFrames(animations: readonly Animation[], torso: FrameBlend): ViewmodelFrames {
  return {
    from: torsoToHandFrame(animations, torso.oldFrame),
    to: torsoToHandFrame(animations, torso.frame),
    frac: 1 - torso.backlerp
  };
}

/** The hand at rest, for a view weapon with no body to follow yet. */
export const IDLE_HAND: Readonly<ViewmodelFrames> = { from: 0, to: 0, frac: 0 };

/** Angular offsets added to the view angles, in degrees. */
export interface ViewmodelSway {
  pitch: number;
  yaw: number;
  roll: number;
}

/** Inputs `CG_CalculateWeaponPosition` reads, all already tracked by the simulation. */
export interface SwayInput {
  /** Horizontal speed in units per second (`cg.xyspeed`). */
  xyspeed: number;
  /** Walk cycle 0..255 (`ps.bobCycle`); the top bit selects which foot leads. */
  bobCycle: number;
  /** Absolute time in milliseconds, for the idle drift. */
  time: number;
}

/**
 * Weapon bob and idle drift — `CG_CalculateWeaponPosition` (`cg_weapons.c:908`).
 *
 * Two effects stacked. The bob scales with speed and inverts on alternate footfalls, which
 * is what makes running feel like running rather than gliding. The idle drift is a slow
 * sine on all three axes that never stops — it is why a Quake weapon is subtly alive even
 * when you stand perfectly still, and why removing it makes the gun look pasted onto the
 * screen.
 */
export function viewmodelSway({ xyspeed, bobCycle, time }: SwayInput): ViewmodelSway {
  // `bobfracsin` peaks mid-stride and returns to zero at each footfall.
  const bobfracsin = Math.abs(Math.sin(((bobCycle & 127) / 127) * Math.PI));
  // The top bit alternates every half cycle, flipping roll and yaw so the two feet lean
  // opposite ways.
  const oddLeg = ((bobCycle & 128) >> 7) === 1;
  const scale = oddLeg ? -xyspeed : xyspeed;

  let roll = scale * bobfracsin * 0.005;
  let yaw = scale * bobfracsin * 0.01;
  let pitch = xyspeed * bobfracsin * 0.005;

  // Idle drift, applied equally to all three axes. The +40 floor is what keeps it going
  // when standing still.
  const drift = (xyspeed + 40) * Math.sin(time * 0.001) * 0.01;
  roll += drift;
  yaw += drift;
  pitch += drift;

  return { pitch, yaw, roll };
}

/**
 * The gun's own dip after a landing — the `landChange` term of the same function.
 *
 * On top of the view's own dip (`camera-feel.ts`), with its timing: a quarter of its depth
 * again, so the gun sinks a little further than the camera. Q3 adds it to the hand's height,
 * along the world's up rather than the view's (`handPose`).
 *
 * @param landChange - Depth of the view's dip, negative, in units.
 * @param msSinceLand - Milliseconds since the landing.
 * @returns Offset along the world's up, in units; zero or negative.
 */
export function viewmodelLandOffset(landChange: number, msSinceLand: number): number {
  const DEFLECT_MS = 150;
  const RETURN_MS = 300;

  if (msSinceLand < 0) return 0;
  if (msSinceLand < DEFLECT_MS) {
    return landChange * 0.25 * (msSinceLand / DEFLECT_MS);
  }
  if (msSinceLand < DEFLECT_MS + RETURN_MS) {
    return landChange * 0.25 * ((DEFLECT_MS + RETURN_MS - msSinceLand) / RETURN_MS);
  }
  return 0;
}

/**
 * How far to drop the gun at a wide field of view — `CG_AddViewWeapon` (`cg_weapons.c:1226`).
 *
 * Not a change to the weapon's own projection, despite the name: Q3 shifts the hand's
 * **origin** along the view's up axis, in world units, because a wider fov pulls the gun
 * further into the middle of the screen and it has to be dropped back out of the way. Below
 * 90 there is nothing to correct, so most players never see this term at all.
 *
 * @param horizontalFov - `cg_fov`, in degrees. Q3's fov cvar is horizontal.
 * @returns Offset along the view's up axis, in Quake units; zero or negative.
 */
export function viewmodelFovOffset(horizontalFov: number): number {
  return horizontalFov > 90 ? -0.2 * (horizontalFov - 90) : 0;
}

/**
 * Wrap an angle into 0..360 — `AngleMod` (`q_math.c`).
 *
 * Only matters where an angle accumulates without bound, which for the viewmodel is the
 * barrel: Q3 folds it every time the spin starts or stops, so a long session cannot drift
 * into the range where a float stops resolving degrees.
 */
export function angleMod(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Barrel spin angle — `CG_MachinegunSpinAngle` (`cg_weapons.c:1130`).
 *
 * Spins at 0.9 degrees per millisecond while firing and coasts to a stop over a second
 * afterwards. Only the three weapons that ship a `_barrel.md3` have anything to spin:
 * gauntlet, machinegun and BFG.
 *
 * @param spinAngle - Angle at the last state change, in degrees.
 * @param msSinceChange - Milliseconds since the weapon started or stopped firing.
 * @param firing - Whether the weapon is currently firing.
 */
export function barrelSpinAngle(
  spinAngle: number,
  msSinceChange: number,
  firing: boolean
): number {
  const SPIN_SPEED = 0.9;
  const COAST_MS = 1000;

  if (firing) return spinAngle + msSinceChange * SPIN_SPEED;

  // Q3 clamps the elapsed time rather than freezing the angle, so the barrel holds its
  // final position instead of snapping back to where the coast started.
  const delta = Math.min(Math.max(msSinceChange, 0), COAST_MS);

  // The coast uses the **average** of the full speed and the tapering speed, not the
  // tapering speed itself. That distinction matters: multiplying elapsed time by an
  // instantaneous rate that falls linearly gives a parabola which peaks halfway through and
  // then decreases — the barrel would visibly unwind for the second half of every coast.
  const averageSpeed = 0.5 * (SPIN_SPEED + ((COAST_MS - delta) / COAST_MS) * SPIN_SPEED);
  return spinAngle + delta * averageSpeed;
}

/** `pe.barrelAngle` / `pe.barrelTime` / `pe.barrelSpinning`, per weapon. */
export interface BarrelSpin {
  /** Angle at the last start or stop, in degrees. */
  angle: number;
  /** When that change happened, in milliseconds. */
  time: number;
  /** Whether the barrel was spinning as of that change. */
  spinning: boolean;
}

/** @param time - Current time in milliseconds; the barrel starts at rest. */
export function createBarrelSpin(time: number): BarrelSpin {
  return { angle: 0, time, spinning: false };
}

/**
 * Advance the barrel and latch a start or stop — the whole of `CG_MachinegunSpinAngle`.
 *
 * The state is only rewritten on the frames where firing *changes*, so the angle is always
 * measured from the last transition rather than integrated frame by frame. That is what makes
 * it frame-rate independent: the barrel is at the same place after one second whether that
 * second was thirty frames or three hundred.
 *
 * @param state - Barrel state, mutated on a start or stop.
 * @param time - Current time in milliseconds.
 * @param firing - `EF_FIRING`: whether the weapon is firing right now.
 * @returns Roll angle in degrees, unbounded within a single spin.
 */
export function spinBarrel(state: BarrelSpin, time: number, firing: boolean): number {
  const angle = barrelSpinAngle(state.angle, time - state.time, state.spinning);
  if (state.spinning !== firing) {
    state.time = time;
    state.angle = angleMod(angle);
    state.spinning = firing;
  }
  return angle;
}
