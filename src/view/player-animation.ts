import type { Animation, AnimationConfig } from '../formats/animation-config';
import { ANIM, animOf } from '../sim/animations';
import type { Vec3 } from '../sim/vec3';
import { anglesToAxis, type Axis } from './hand-pose';
import { createLerpFrame, runLerpFrame, type LerpFrame } from './lerp-frame';
import { angleMod, angleSubtract } from './q-math';

/**
 * A player model's angles and frames: `CG_PlayerAngles` and `CG_PlayerAnimation`
 * (`cg_players.c:1238–1491`).
 *
 * Engine-free, like the rest of `src/view/`: the sim's animation numbers, `movementDir` and
 * velocity go in, and each part's axis and frames come out, for the rig to draw.
 *
 * The three parts turn separately. The head looks exactly where the view does. The torso and the
 * legs *swing* after it, each once the view has got far enough ahead of it, so a player standing
 * still can look about without the whole body following. Moving, all three stay lined up, with
 * the legs turned toward the way they are going and leaning into it.
 */

/** Index of each angle in a `[pitch, yaw, roll]` triple, as Q3's `vec3_t` angles. */
const PITCH = 0;
const YAW = 1;
const ROLL = 2;

/** How long a hurt twists the torso (`PAIN_TWITCH_TIME`, `cg_local.h:46`), in milliseconds. */
export const PAIN_TWITCH_TIME = 200;

/** `cg_swingSpeed`'s default (`cg_main.c:249`): degrees per millisecond, before scaling. */
export const SWING_SPEED = 0.3;

/**
 * `movementOffsets` (`cg_players.c:1387`): how far the legs turn from the view for each
 * `movementDir`, 0 ahead and counter-clockwise from there. Backwards is 0, so a player walking
 * backwards faces the view and plays the legs in reverse.
 */
const MOVEMENT_OFFSETS = [0, 22, 45, -22, 0, 22, -45, -22] as const;

/** `playerEntity_t`'s part that animates the model (`cg_local.h:144–148`). */
export interface PlayerEntity {
  legs: LerpFrame;
  torso: LerpFrame;
  /** When the last pain event came, in milliseconds. */
  painTime: number;
  /** Which way the torso twists: flipped by every pain event (`cg_event.c:507–508`). */
  painDirection: number;
}

/**
 * A player just come into view: `CG_ResetPlayerEntity`'s animation state
 * (`cg_players.c:2606–2634`). Both parts face the view's yaw and the torso its pitch; neither is
 * swinging, and neither has a frame yet.
 *
 * Q3 clears each part's frames to its animation's first, then zeroes them straight after, so what
 * it leaves is the zeroes.
 *
 * No hurt has happened: Q3's zero is a moment long gone by the time a client draws, where the
 * port's clock can start at 0.
 *
 * @param angles - The view's pitch, yaw and roll.
 */
export function createPlayerEntity(angles: Readonly<Vec3>): PlayerEntity {
  const legs = createLerpFrame();
  legs.yawAngle = angles.y;
  const torso = createLerpFrame();
  torso.yawAngle = angles.y;
  torso.pitchAngle = angles.x;
  return { legs, torso, painTime: Number.NEGATIVE_INFINITY, painDirection: 0 };
}

/**
 * `CG_SwingAngles` (`cg_players.c:1290–1344`): move a part's angle after its destination.
 *
 * A swing starts once the angle is more than `swingTolerance` away, and runs until it arrives. It
 * moves at `speed`, halved while within half the tolerance and doubled beyond the whole of it, so
 * a big turn catches up fast and settles gently. However it moves, the part never lags by more
 * than `clampTolerance`: past that it is pulled to a degree inside it.
 *
 * @param frametime - `cg.frametime`: milliseconds since the last frame.
 * @returns the part's new angle, and whether it is still swinging
 */
export function swingAngles(
  destination: number,
  swingTolerance: number,
  clampTolerance: number,
  speed: number,
  frametime: number,
  angle: number,
  swinging: boolean
): { angle: number; swinging: boolean } {
  if (!swinging) {
    const swing = angleSubtract(angle, destination);
    if (swing > swingTolerance || swing < -swingTolerance) swinging = true;
  }
  if (!swinging) return { angle, swinging };

  let swing = angleSubtract(destination, angle);
  const distance = Math.abs(swing);
  const scale = distance < swingTolerance * 0.5 ? 0.5 : distance < swingTolerance ? 1.0 : 2.0;

  if (swing >= 0) {
    let move = frametime * scale * speed;
    if (move >= swing) {
      move = swing;
      swinging = false;
    }
    angle = angleMod(angle + move);
  } else if (swing < 0) {
    let move = frametime * scale * -speed;
    if (move <= swing) {
      move = swing;
      swinging = false;
    }
    angle = angleMod(angle + move);
  }

  swing = angleSubtract(destination, angle);
  if (swing > clampTolerance) angle = angleMod(destination - (clampTolerance - 1));
  else if (swing < -clampTolerance) angle = angleMod(destination + (clampTolerance - 1));
  return { angle, swinging };
}

/**
 * `CG_AddPainTwitch` (`cg_players.c:1351–1367`): the torso's roll after a hurt, 20° fading to
 * nothing over {@link PAIN_TWITCH_TIME}, to one side or the other by the pain's direction.
 */
export function painTwitch(time: number, painTime: number, painDirection: number): number {
  const t = time - painTime;
  if (t >= PAIN_TWITCH_TIME) return 0;
  const f = 1 - t / PAIN_TWITCH_TIME;
  return painDirection ? 20 * f : -20 * f;
}

/** What `CG_PlayerAngles` reads from the entity, all of it the sim's. */
export interface PlayerAnglesInput {
  /** `cent->lerpAngles`: where the player looks, pitch, yaw and roll. */
  angles: Readonly<Vec3>;
  legsAnim: number;
  torsoAnim: number;
  /** `movementDir`, 0–7. */
  movementDir: number;
  /** `EF_DEAD`, which Q3 sets on the entity of any player at 0 health or below (`bg_misc.c`). */
  dead: boolean;
  /** `pos.trDelta`: the velocity, in units per second. */
  velocity: Readonly<Vec3>;
  /** `cg.time`, in milliseconds. */
  time: number;
  /** `cg.frametime`: milliseconds since the last frame. */
  frametime: number;
}

/**
 * The three parts' axes. The legs are in the world's frame; the torso is measured in the legs',
 * and the head in the torso's, as the tag chain hangs them.
 */
export interface PlayerAxes {
  legs: Axis;
  torso: Axis;
  head: Axis;
}

/**
 * `CG_PlayerAngles` (`cg_players.c:1384–1491`): turn the parts after the view, each by its own
 * rules, and lean the legs into the way they move.
 *
 * Standing idle, the torso lets the view get 25° ahead and the legs 40° before they follow;
 * doing anything else, both stay centred. The torso takes three quarters of the view's pitch, and
 * the head the rest. The legs lean 0.05° per unit per second of the velocity: 16° into a 320 ups
 * strafe.
 *
 * @param entity - The swing state, updated in place.
 * @param config - The model's `fixedlegs` and `fixedtorso`.
 */
export function playerAngles(
  entity: PlayerEntity,
  config: Pick<AnimationConfig, 'fixedLegs' | 'fixedTorso'>,
  input: PlayerAnglesInput
): PlayerAxes {
  const { legs, torso } = entity;
  const headAngles = [input.angles.x, angleMod(input.angles.y), input.angles.z];
  const legsAngles = [0, 0, 0];
  const torsoAngles = [0, 0, 0];

  // Yaw. Anything but standing idle keeps every part centred on the view.
  const torsoAnim = animOf(input.torsoAnim);
  if (
    animOf(input.legsAnim) !== ANIM.LEGS_IDLE ||
    (torsoAnim !== ANIM.TORSO_STAND && torsoAnim !== ANIM.TORSO_STAND2)
  ) {
    torso.yawing = true;
    torso.pitching = true;
    legs.yawing = true;
  }

  // A dead body lies as it fell, with no turn for the way it was going.
  let dir = 0;
  if (!input.dead) {
    dir = input.movementDir;
    if (dir < 0 || dir > 7) throw new Error('Bad player movement angle');
  }
  legsAngles[YAW] = headAngles[YAW] + MOVEMENT_OFFSETS[dir];
  torsoAngles[YAW] = headAngles[YAW] + 0.25 * MOVEMENT_OFFSETS[dir];

  const torsoYaw = swingAngles(
    torsoAngles[YAW], 25, 90, SWING_SPEED, input.frametime, torso.yawAngle, torso.yawing
  );
  torso.yawAngle = torsoYaw.angle;
  torso.yawing = torsoYaw.swinging;
  const legsYaw = swingAngles(
    legsAngles[YAW], 40, 90, SWING_SPEED, input.frametime, legs.yawAngle, legs.yawing
  );
  legs.yawAngle = legsYaw.angle;
  legs.yawing = legsYaw.swinging;
  torsoAngles[YAW] = torso.yawAngle;
  legsAngles[YAW] = legs.yawAngle;

  // Pitch: the torso shows only three quarters of it.
  const pitch = headAngles[PITCH] > 180 ? -360 + headAngles[PITCH] : headAngles[PITCH];
  const torsoPitch = swingAngles(
    pitch * 0.75, 15, 30, 0.1, input.frametime, torso.pitchAngle, torso.pitching
  );
  torso.pitchAngle = torsoPitch.angle;
  torso.pitching = torsoPitch.swinging;
  torsoAngles[PITCH] = torso.pitchAngle;
  if (config.fixedTorso) torsoAngles[PITCH] = 0;

  // Roll: lean into the direction of travel.
  const { x, y, z } = input.velocity;
  const speed = Math.hypot(x, y, z);
  if (speed) {
    const lean = speed * 0.05;
    const axis = anglesToAxis(legsAngles[PITCH], legsAngles[YAW], legsAngles[ROLL]);
    const along = (row: Axis[number]) => (x * row[0] + y * row[1] + z * row[2]) / speed;
    legsAngles[ROLL] -= lean * along(axis[1]);
    legsAngles[PITCH] += lean * along(axis[0]);
  }

  if (config.fixedLegs) {
    legsAngles[YAW] = torsoAngles[YAW];
    legsAngles[PITCH] = 0;
    legsAngles[ROLL] = 0;
  }

  torsoAngles[ROLL] += painTwitch(input.time, entity.painTime, entity.painDirection);

  // Pull the angles back out of the chain: each part is hung off the one below.
  const relative = (child: number[], parent: number[]): Axis =>
    anglesToAxis(
      angleSubtract(child[PITCH], parent[PITCH]),
      angleSubtract(child[YAW], parent[YAW]),
      angleSubtract(child[ROLL], parent[ROLL])
    );
  return {
    legs: anglesToAxis(legsAngles[PITCH], legsAngles[YAW], legsAngles[ROLL]),
    torso: relative(torsoAngles, legsAngles),
    head: relative(headAngles, torsoAngles)
  };
}

/** The frames a part shows: `refEntity_t`'s `oldframe`, `frame` and `backlerp`. */
export interface FrameBlend {
  oldFrame: number;
  frame: number;
  backlerp: number;
}

/**
 * `CG_PlayerAnimation` (`cg_players.c:1238–1275`): run both parts' frames to `time`.
 *
 * While the legs swing to catch up with the view during `LEGS_IDLE`, they play `LEGS_TURN`
 * instead: the shuffle of a player turning on the spot. Q3 runs it after the angles, so the swing
 * this frame's angles started shows at once.
 *
 * @param time - `cg.time`, in whole milliseconds.
 * @param speedScale - 1.5 under haste, for both parts (`cg_players.c:1251–1270`).
 */
export function playerAnimation(
  entity: PlayerEntity,
  animations: readonly Animation[],
  legsAnim: number,
  torsoAnim: number,
  time: number,
  speedScale = 1
): { legs: FrameBlend; torso: FrameBlend } {
  const { legs, torso } = entity;
  const turning = legs.yawing && animOf(legsAnim) === ANIM.LEGS_IDLE;
  runLerpFrame(animations, legs, turning ? ANIM.LEGS_TURN : legsAnim, time, speedScale);
  runLerpFrame(animations, torso, torsoAnim, time, speedScale);
  return {
    legs: { oldFrame: legs.oldFrame, frame: legs.frame, backlerp: legs.backlerp },
    torso: { oldFrame: torso.oldFrame, frame: torso.frame, backlerp: torso.backlerp }
  };
}
