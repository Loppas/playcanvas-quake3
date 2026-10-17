import type { Animation } from '../formats/animation-config';
import { ANIM, ANIM_TOGGLEBIT } from '../sim/animations';

/**
 * Frame playback for one part of a player model: `CG_RunLerpFrame` and its two helpers
 * (`cg_players.c:1110–1230`).
 *
 * The sim picks each part's animation; this plays it. A part keeps a clock: `oldFrame` was
 * exact at `oldFrameTime` and `frame` will be at `frameTime`, and the renderer draws the blend
 * between them, `backlerp` being how much of the old frame is left.
 *
 * Three of Q3's behaviours ride on the arithmetic rather than on any flag, which is why it is
 * ported line for line, in whole milliseconds as `cg.time` counts them:
 * - A new animation's first frame falls one `initialLerp` after the current frame ends, so a
 *   change crossfades from wherever the old animation had got to.
 * - The toggle bit makes a restart a change: a second shot's `TORSO_ATTACK` differs from the
 *   first's, so it plays again from its first frame.
 * - An animation with no looping frames holds its last one, and marks itself free to change at
 *   once.
 */

/** `lerpFrame_t` (`cg_local.h:124–141`). Times are in milliseconds. */
export interface LerpFrame {
  oldFrame: number;
  /** When {@link LerpFrame.oldFrame} was exact. */
  oldFrameTime: number;
  frame: number;
  /** When {@link LerpFrame.frame} will be exact. */
  frameTime: number;
  /** How much of {@link LerpFrame.oldFrame} is left: 1 draws it, 0 draws the new frame. */
  backlerp: number;
  /** The part's yaw and pitch, which `CG_SwingAngles` moves after the view's. */
  yawAngle: number;
  yawing: boolean;
  pitchAngle: number;
  pitching: boolean;
  /** The animation playing, toggle bit and all. */
  animationNumber: number;
  animation: Animation | null;
  /** When the animation's first frame is exact. */
  animationTime: number;
}

/**
 * A part with nothing played yet: the zeroes `CG_ResetPlayerEntity` leaves
 * (`cg_players.c:2619–2629`). Its first {@link runLerpFrame} shows its animation's first frame,
 * whole.
 */
export function createLerpFrame(): LerpFrame {
  return {
    oldFrame: 0,
    oldFrameTime: 0,
    frame: 0,
    frameTime: 0,
    backlerp: 0,
    yawAngle: 0,
    yawing: false,
    pitchAngle: 0,
    pitching: false,
    animationNumber: 0,
    animation: null,
    animationTime: 0
  };
}

/**
 * `CG_SetLerpFrameAnimation` (`cg_players.c:1110–1128`): start an animation, whose first frame
 * falls one `initialLerp` after the current frame.
 *
 * @param newAnimation - An `ANIM` number, with or without the toggle bit.
 * @throws for a number past the table, where Q3 stops the game (`CG_Error`)
 */
export function setLerpFrameAnimation(
  animations: readonly Animation[],
  lf: LerpFrame,
  newAnimation: number
): void {
  lf.animationNumber = newAnimation;
  const number = newAnimation & ~ANIM_TOGGLEBIT;
  if (number < 0 || number >= ANIM.MAX_TOTALANIMATIONS) {
    throw new Error(`Bad animation number: ${number}`);
  }
  const animation = animations[number];
  lf.animation = animation;
  lf.animationTime = lf.frameTime + animation.initialLerp;
}

/**
 * `CG_RunLerpFrame` (`cg_players.c:1138–1218`): advance a part's frames to `time`.
 *
 * @param newAnimation - The animation the sim has chosen, toggle bit and all.
 * @param time - `cg.time`, in whole milliseconds.
 * @param speedScale - 1.5 under haste (`cg_players.c:1251–1270`, which scales both parts).
 */
export function runLerpFrame(
  animations: readonly Animation[],
  lf: LerpFrame,
  newAnimation: number,
  time: number,
  speedScale = 1
): void {
  if (newAnimation !== lf.animationNumber || !lf.animation) {
    setLerpFrameAnimation(animations, lf, newAnimation);
  }

  // Past the frame being blended toward: it becomes the old one, and the next is worked out.
  if (time >= lf.frameTime) {
    lf.oldFrame = lf.frame;
    lf.oldFrameTime = lf.frameTime;

    const animation = lf.animation!;
    if (!animation.frameLerp) return;
    lf.frameTime =
      time < lf.animationTime ? lf.animationTime : lf.oldFrameTime + animation.frameLerp;

    // C's integer arithmetic: whole frames since the first, truncated.
    let f = Math.trunc((lf.frameTime - lf.animationTime) / animation.frameLerp);
    f = Math.trunc(f * speedScale);
    const numFrames = animation.flipflop ? animation.numFrames * 2 : animation.numFrames;
    if (f >= numFrames) {
      f -= numFrames;
      if (animation.loopFrames) {
        f %= animation.loopFrames;
        f += animation.numFrames - animation.loopFrames;
      } else {
        f = numFrames - 1;
        // Stuck at the end, so free to change to another at once.
        lf.frameTime = time;
      }
    }
    if (animation.reversed) {
      lf.frame = animation.firstFrame + animation.numFrames - 1 - f;
    } else if (animation.flipflop && f >= animation.numFrames) {
      lf.frame = animation.firstFrame + animation.numFrames - 1 - (f % animation.numFrames);
    } else {
      lf.frame = animation.firstFrame + f;
    }
    if (time > lf.frameTime) lf.frameTime = time;
  }

  if (lf.frameTime > time + 200) lf.frameTime = time;
  if (lf.oldFrameTime > time) lf.oldFrameTime = time;
  lf.backlerp =
    lf.frameTime === lf.oldFrameTime
      ? 0
      : 1 - (time - lf.oldFrameTime) / (lf.frameTime - lf.oldFrameTime);
}

/**
 * `CG_ClearLerpFrame` (`cg_players.c:1226–1230`): show an animation's first frame now, with no
 * blend from anything before.
 */
export function clearLerpFrame(
  animations: readonly Animation[],
  lf: LerpFrame,
  animationNumber: number,
  time: number
): void {
  lf.frameTime = lf.oldFrameTime = time;
  setLerpFrameAnimation(animations, lf, animationNumber);
  lf.oldFrame = lf.frame = lf.animation!.firstFrame;
}
