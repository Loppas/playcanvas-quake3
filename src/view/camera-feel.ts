import type { PlayerState } from '../net/protocol';
import { angleVectors } from '../sim/pmove-math';
import { EV, eventNumber, isStepEvent, type Event } from '../sim/events';
import { dot, vec3, type Vec3 } from '../sim/vec3';
import { damageKick, type DamageFeedback } from './damage-feedback';

/**
 * The client-side half of Quake 3's movement feel: the eye offsets and view lean that hide
 * what the simulation does abruptly.
 *
 * Port of the first-person parts of `cg_view.c` / `cg_event.c`. None of this touches the
 * simulation — the player's origin, velocity and collision are identical with it switched
 * off — but without it the game does not feel like Quake. Stairs are the clearest case: the
 * sim teleports the origin up to 18 units in one tick, and only the step glide turns that
 * into a climb rather than a jolt.
 *
 * Pure maths, no engine imports, so it is testable headless like the sim it sits on.
 */

// --- cg_local.h:39-58 -------------------------------------------------------

/** Duration of the stair-step glide, in milliseconds. */
export const STEP_TIME = 200;

/** Duration of the crouch/stand eye glide, in milliseconds. */
export const DUCK_TIME = 100;

/** How long the eye takes to reach the bottom of a landing dip, in milliseconds. */
export const LAND_DEFLECT_TIME = 150;

/** How long the eye takes to come back up from a landing dip, in milliseconds. */
export const LAND_RETURN_TIME = 300;

/** Ceiling on accumulated step glide, so a fast staircase cannot sink the camera. */
export const MAX_STEP_CHANGE = 32;

// --- cg_main.c:244-248 ------------------------------------------------------

/** Degrees of forward lean per unit per second of velocity along the view axis. */
export const CG_RUNPITCH = 0.002;

/** Degrees of bank per unit per second of sideways velocity. */
export const CG_RUNROLL = 0.005;

/** Units of eye rise per unit per second of ground speed, at the peak of the bob. */
export const CG_BOBUP = 0.005;

/** Degrees of pitch bob per unit per second of ground speed. */
export const CG_BOBPITCH = 0.002;

/** Degrees of roll bob per unit per second of ground speed. */
export const CG_BOBROLL = 0.002;

// --- cg_view.c:648 ----------------------------------------------------------

/** Ceiling on the vertical bob, in units. Reached at about 1200 ups. */
export const MAX_BOB_UP = 6;

/** Speed the angular bob is computed at when moving slower, so it stays visible. */
export const BOB_MIN_SPEED = 200;

/** Crouched bob is exaggerated: a shorter stride with more of it showing in the view. */
export const DUCKED_BOB_MULTIPLIER = 3;

/** How far the eye dips on landing, by which of the three falls it was (cg_event.c:585–609). */
const LAND_CHANGE: Record<number, number> = {
  [EV.FALL_SHORT]: -8,
  [EV.FALL_MEDIUM]: -16,
  [EV.FALL_FAR]: -24
};

/**
 * The player state a frame is drawn from.
 *
 * Distinct from {@link PlayerState} because `origin` and `velocity` may be interpolated
 * between two simulation ticks — see `player-view.ts`.
 */
export interface ViewSample {
  /** Player origin in Q3 units, 24 above the feet. */
  origin: Vec3;
  /** Velocity in units per second. */
  velocity: Vec3;
  /** View angles in degrees: pitch, yaw, roll. */
  viewangles: Vec3;
  /** Eye height above the origin, before any of the glides below. */
  viewheight: number;
  /** Walk cycle position, 0..255. */
  bobCycle: number;
  /** Whether the player is crouched. */
  ducked: boolean;
}

/** Where to put the camera this frame. */
export interface FirstPersonView {
  /** Eye position in Q3 units, Z-up. */
  origin: Vec3;
  /** View angles in degrees: pitch, yaw, roll. */
  angles: Vec3;
}

/**
 * Camera state that outlives a frame: three glides, each a magnitude and the time it started.
 *
 * Q3 keeps these as loose `cg.*` fields; they are gathered here because they are exactly the
 * layer's memory.
 */
export interface CameraFeel {
  /** Height still to be glided away after a step up. */
  stepChange: number;
  /** When the current step glide started. */
  stepTime: number;
  /** Change in eye height the current duck glide is covering. */
  duckChange: number;
  /** When the current duck glide started. */
  duckTime: number;
  /** Depth of the current landing dip; negative. */
  landChange: number;
  /** When the current landing dip started. */
  landTime: number;
  /** Eye height as of the last transition, so a change in it can be detected. */
  viewheight: number;
}

/**
 * Create camera state with no glide in progress.
 *
 * The start times are `-Infinity` rather than zero so that nothing is mid-glide at time zero;
 * every glide below is guarded by an elapsed-time test.
 *
 * @param viewheight - The player's current eye height, so the first frame does not glide.
 */
export function createCameraFeel(viewheight: number): CameraFeel {
  return {
    stepChange: 0,
    stepTime: -Infinity,
    duckChange: 0,
    duckTime: -Infinity,
    landChange: 0,
    landTime: -Infinity,
    viewheight
  };
}

/**
 * Fold one simulation tick's outcome into the camera state.
 *
 * Port of the camera parts of `CG_TransitionPlayerState` (cg_playerstate.c) and the `EV_STEP_*`
 * / `EV_FALL_*` cases of `CG_EntityEvent` (cg_event.c), with CPMA's step event beside id's four.
 * Call once per tick, before drawing.
 *
 * Quake 3 runs one `CG_EntityEvent` and lets each case write whatever it needs to, camera and
 * sound alike. The port reads the same list twice instead, because the camera's state is its own
 * thing and is tested without a sound in sight; the list itself is built once, by
 * `CG_CheckPlayerstateEvents`.
 *
 * @param feel - Camera state; mutated in place.
 * @param state - Player state after the tick.
 * @param events - What `CG_CheckPlayerstateEvents` found this tick.
 * @param time - `cg.time` as the snapshot or the move was read, in milliseconds.
 * @param smoothSteps - Whether a step up glides. It does not while the player is drawn between
 *   snapshots, which draw the step like the rest of the move.
 */
export function transitionCameraFeel(
  feel: CameraFeel,
  state: PlayerState,
  events: readonly Event[],
  time: number,
  smoothSteps = true
) {
  // Ducking is instant in the simulation — the box changes size on the tick the key goes
  // down. Only the eye is smoothed, which is why you can duck under something the moment
  // you ask to and still see the movement.
  if (state.viewheight !== feel.viewheight) {
    feel.duckChange = state.viewheight - feel.viewheight;
    feel.duckTime = time;
    feel.viewheight = state.viewheight;
  }

  for (const { event, parm } of events) {
    const number = eventNumber(event);
    if (isStepEvent(number)) {
      if (!smoothSteps) continue;
      // `4 * (event - EV_STEP_4 + 1)` (`cg_event.c:646`): id's four step events are four heights,
      // so how far the player rose is which event it is. CPMA's one carries the rise.
      const height = number === EV.STEP ? parm : 4 * (number - EV.STEP_4 + 1);
      // A second step landing mid-glide inherits whatever the first has left to travel, so
      // running up a staircase glides continuously instead of restarting every step.
      feel.stepChange = Math.min(remainingStep(feel, time) + height, MAX_STEP_CHANGE);
      feel.stepTime = time;
    } else if (number in LAND_CHANGE) {
      feel.landChange = LAND_CHANGE[number];
      feel.landTime = time;
    }
  }
}

/**
 * Place the camera for one frame.
 *
 * Port of `CG_OffsetFirstPersonView` (`cg_view.c:316–439`), the damage kick included. Its
 * dead view is left out: Q3 shows a dead player in third person (`cg_view.c:804–805`), so it is
 * never reached. Applied in Q3's order; they are independent offsets, so the order only matters
 * for reading it against the original.
 *
 * @param feel - Camera state, as maintained by {@link transitionCameraFeel}.
 * @param sample - The player state to draw from.
 * @param time - Render time in milliseconds, on the same clock as the transitions. May fall
 *   between ticks, which is what makes the glides smooth rather than stepped.
 * @param damage - The last hurt's feedback, whose kick tips the view; no kick without it.
 */
export function firstPersonView(
  feel: CameraFeel,
  sample: ViewSample,
  time: number,
  damage?: Readonly<DamageFeedback>
): FirstPersonView {
  const xyspeed = Math.hypot(sample.velocity.x, sample.velocity.y);

  // The stride as a 0..1 hump: zero at each footfall, one at mid-step. `bobcycle` is which
  // foot is forward, and it flips the roll so the bank alternates rather than pumping.
  const bobfracsin = Math.abs(Math.sin(((sample.bobCycle & 127) / 127) * Math.PI));
  const bobcycle = (sample.bobCycle & 128) >> 7;

  let z = sample.origin.z + sample.viewheight;

  const duckElapsed = time - feel.duckTime;
  if (duckElapsed < DUCK_TIME) {
    z -= (feel.duckChange * (DUCK_TIME - duckElapsed)) / DUCK_TIME;
  }

  z += Math.min(bobfracsin * xyspeed * CG_BOBUP, MAX_BOB_UP);

  const landElapsed = time - feel.landTime;
  if (landElapsed < LAND_DEFLECT_TIME) {
    z += feel.landChange * (landElapsed / LAND_DEFLECT_TIME);
  } else if (landElapsed < LAND_DEFLECT_TIME + LAND_RETURN_TIME) {
    z += feel.landChange * (1 - (landElapsed - LAND_DEFLECT_TIME) / LAND_RETURN_TIME);
  }

  z -= remainingStep(feel, time);

  const basis = angleVectors(sample.viewangles);
  let pitch = sample.viewangles.x;
  let roll = sample.viewangles.z;

  // The damage kick: in over 100 ms, back over 400.
  if (damage) {
    const kick = damageKick(damage, time);
    pitch += kick.pitch;
    roll += kick.roll;
  }

  // Velocity lean, always on: nose down as you run forward, bank as you strafe. Q3 writes
  // the roll term against its left axis and subtracts; against `right` the sign flips.
  pitch += dot(sample.velocity, basis.forward) * CG_RUNPITCH;
  roll += dot(sample.velocity, basis.right) * CG_RUNROLL;

  const bobSpeed = Math.max(xyspeed, BOB_MIN_SPEED);
  const bobScale = sample.ducked ? DUCKED_BOB_MULTIPLIER : 1;
  pitch += bobfracsin * CG_BOBPITCH * bobSpeed * bobScale;

  const bobRoll = bobfracsin * CG_BOBROLL * bobSpeed * bobScale;
  roll += bobcycle ? -bobRoll : bobRoll;

  return {
    origin: vec3(sample.origin.x, sample.origin.y, z),
    angles: vec3(pitch, sample.viewangles.y, roll)
  };
}

/**
 * Height of the current step glide still to be paid off, which is what the eye is lowered by.
 *
 * Port of `CG_StepOffset` (cg_view.c:1104); shared with the event handler because Q3's
 * `EV_STEP_*` case computes the same quantity to carry into the next glide.
 *
 * @param feel - Camera state.
 * @param time - Time to evaluate at, in milliseconds.
 */
function remainingStep(feel: CameraFeel, time: number): number {
  const elapsed = time - feel.stepTime;
  return elapsed < STEP_TIME ? (feel.stepChange * (STEP_TIME - elapsed)) / STEP_TIME : 0;
}
