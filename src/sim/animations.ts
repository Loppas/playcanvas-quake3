import type { PlayerState } from '../net/protocol';
import { PM_DEAD } from './constants';

/**
 * Player animation numbers, and the calls that choose them — `animNumber_t`
 * (`bg_public.h:478–530`) and the `PM_StartTorsoAnim` family (`bg_pmove.c:93–134`).
 *
 * Q3 chooses a player's animation inside the movement code, so the client predicting its own
 * player and the server agree on it frame for frame. The port does the same: the sim
 * picks the rows and the rig only plays them.
 *
 * Every change of animation flips {@link ANIM_TOGGLEBIT}, so restarting the animation already
 * running (a second shot, a second jump) still reads as a change on the client, which restarts
 * it from its first frame.
 */

/**
 * `animNumber_t`. The numbers index an `animation.cfg`'s rows, so they are Q3's own. The six
 * Team Arena torso rows sit before `MAX_ANIMATIONS`; the backwards crouch and walk after it are
 * derived by the loader, not listed in the file.
 */
export const ANIM = {
  BOTH_DEATH1: 0,
  BOTH_DEAD1: 1,
  BOTH_DEATH2: 2,
  BOTH_DEAD2: 3,
  BOTH_DEATH3: 4,
  BOTH_DEAD3: 5,
  TORSO_GESTURE: 6,
  TORSO_ATTACK: 7,
  TORSO_ATTACK2: 8,
  TORSO_DROP: 9,
  TORSO_RAISE: 10,
  TORSO_STAND: 11,
  TORSO_STAND2: 12,
  LEGS_WALKCR: 13,
  LEGS_WALK: 14,
  LEGS_RUN: 15,
  LEGS_BACK: 16,
  LEGS_SWIM: 17,
  LEGS_JUMP: 18,
  LEGS_LAND: 19,
  LEGS_JUMPB: 20,
  LEGS_LANDB: 21,
  LEGS_IDLE: 22,
  LEGS_IDLECR: 23,
  LEGS_TURN: 24,
  TORSO_GETFLAG: 25,
  TORSO_GUARDBASE: 26,
  TORSO_PATROL: 27,
  TORSO_FOLLOWME: 28,
  TORSO_AFFIRMATIVE: 29,
  TORSO_NEGATIVE: 30,
  MAX_ANIMATIONS: 31,
  LEGS_BACKCR: 32,
  LEGS_BACKWALK: 33,
  FLAG_RUN: 34,
  FLAG_STAND: 35,
  FLAG_STAND2RUN: 36,
  MAX_TOTALANIMATIONS: 37
} as const;

/** Flipped on every change of animation (`bg_public.h:546`). */
export const ANIM_TOGGLEBIT = 128;

/** How long a landing holds the legs before anything else may replace it (`bg_local.h:31`). */
export const TIMER_LAND = 130;

/** How long a gesture holds the torso: 34 frames at 15 fps, plus 50 ms (`bg_local.h:32`). */
export const TIMER_GESTURE = 34 * 66 + 50;

/** The animation an `legsAnim` or `torsoAnim` value holds, without the toggle bit. */
export function animOf(value: number): number {
  return value & ~ANIM_TOGGLEBIT;
}

/**
 * The value that starts `anim` after `previous`: the new row, with the toggle bit flipped from
 * the old one. `player_die` sets it directly (`g_combat.c:642–645`); everything else goes
 * through the calls below.
 */
export function nextAnim(previous: number, anim: number): number {
  return ((previous & ANIM_TOGGLEBIT) ^ ANIM_TOGGLEBIT) | anim;
}

/** `PM_StartTorsoAnim`: start a torso animation, unless the player is dead. */
export function startTorsoAnim(state: PlayerState, anim: number): void {
  if (state.pmType >= PM_DEAD) return;
  state.torsoAnim = nextAnim(state.torsoAnim, anim);
}

/**
 * `PM_StartLegsAnim`: start a legs animation, unless the player is dead or a landing or
 * another timed animation still holds the legs.
 */
export function startLegsAnim(state: PlayerState, anim: number): void {
  if (state.pmType >= PM_DEAD) return;
  if (state.legsTimer > 0) return;
  state.legsAnim = nextAnim(state.legsAnim, anim);
}

/** `PM_ContinueLegsAnim`: switch to `anim` only if it is not already playing. */
export function continueLegsAnim(state: PlayerState, anim: number): void {
  if (animOf(state.legsAnim) === anim) return;
  if (state.legsTimer > 0) return;
  startLegsAnim(state, anim);
}

/** `PM_ContinueTorsoAnim`: switch to `anim` only if it is not already playing. */
export function continueTorsoAnim(state: PlayerState, anim: number): void {
  if (animOf(state.torsoAnim) === anim) return;
  if (state.torsoTimer > 0) return;
  startTorsoAnim(state, anim);
}

/** `PM_ForceLegsAnim`: clear the legs timer, then start `anim`. Jumps and landings use it. */
export function forceLegsAnim(state: PlayerState, anim: number): void {
  state.legsTimer = 0;
  startLegsAnim(state, anim);
}
