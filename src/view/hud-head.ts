import { DAMAGE_TIME } from './damage-feedback';
import { SCREEN_HEIGHT } from './hud-layout';
import { CHAR_WIDTH, FIELD_WIDTH, HEALTH_X, ICON_SIZE, TEXT_ICON_SPACE } from './hud-status';

/**
 * The HUD's head: where `CG_DrawHead` stands it in its own 30° view
 * (`cg_draw.c:312–350`), and how `CG_DrawStatusBarHead` moves it (`cg_draw.c:421–470`).
 *
 * Engine-free, like the rest of `src/view/`. The view looks along +X, so the head is backed off
 * along X until its height nearly fills the box, and centred across the other two axes.
 */

/** `tan 15°`, as Q3 writes it: half of the head's 30° field of view (`cg_draw.c:336`). */
const TAN_HALF_FOV = 0.268;

/** How much of the box's height the head fills (`cg_draw.c:335`). */
const HEAD_FILL = 0.7;

/** The head's box at rest: 1.25 icons square (`cg_draw.c:455`). */
export const HEAD_SIZE = ICON_SIZE * 1.25;

/** Where the box starts, just right of the health number (`cg_draw.c:557`). */
export const HEAD_X = HEALTH_X + CHAR_WIDTH * FIELD_WIDTH + TEXT_ICON_SPACE;

/**
 * The head's origin in the head view, from its frame-0 bounds (`trap_R_ModelBounds`), with the
 * model's `headoffset` added (`cg_draw.c:327–339`). Sarge's is (19.83, −0.03, −2.42).
 *
 * Q3 assumes heads are taller than wide, and frames the height alone.
 */
export function headFraming(
  mins: readonly number[],
  maxs: readonly number[],
  headOffset: readonly number[]
): [number, number, number] {
  return [
    (HEAD_FILL * (maxs[2] - mins[2])) / TAN_HALF_FOV + headOffset[0],
    0.5 * (mins[1] + maxs[1]) + headOffset[1],
    -0.5 * (mins[2] + maxs[2]) + headOffset[2]
  ];
}

/** The head's look-around: from one yaw and pitch to the next, eased (`cg.head*`, `cg_local.h:612–622`). */
export interface HeadMotion {
  startYaw: number;
  endYaw: number;
  startPitch: number;
  endPitch: number;
  startTime: number;
  endTime: number;
}

/** As cgame starts it, zeroed with the rest of `cg`: the first frame picks where to look next. */
export function createHeadMotion(): HeadMotion {
  return { startYaw: 0, endYaw: 0, startPitch: 0, endPitch: 0, startTime: 0, endTime: 0 };
}

/** The head this frame: its box on Q3's grid, and which way it looks, in degrees. */
export interface StatusBarHead {
  x: number;
  y: number;
  size: number;
  pitch: number;
  yaw: number;
}

/**
 * `CG_DrawStatusBarHead` (`cg_draw.c:421–470`) for one frame, moving `motion` on.
 *
 * At rest the head looks around: every 0.1 to 2.1 s it picks a yaw of 160–200° and a pitch of ±5°,
 * and eases there. Yaw 180 faces the view. `crandom()` feeds a cosine, so the extremes are likeliest.
 * For 500 ms after a hurt it flinches instead: the box grows to 90 and back to 60, rising off the
 * bottom edge and pushed sideways by the hurt's `damageX`, and the head is held turned 45° by it.
 *
 * @param damage - The last hurt: when, and `damageX`.
 * @param time - Game time in milliseconds, which `cg.time` counts whole.
 * @param random - `random()`, uniform in 0..1.
 */
export function statusBarHead(
  motion: HeadMotion,
  damage: { time: number; x: number },
  time: number,
  random: () => number
): StatusBarHead {
  const now = Math.floor(time);
  const crandom = () => 2 * (random() - 0.5);
  let x = HEAD_X;
  let size = HEAD_SIZE;

  if (now - damage.time < DAMAGE_TIME) {
    const frac = (now - damage.time) / DAMAGE_TIME;
    size = HEAD_SIZE * (1.5 - frac * 0.5);
    const stretch = size - HEAD_SIZE;
    // "kick in the direction of damage"
    x -= stretch * 0.5 + damage.x * stretch * 0.5;
    motion.startYaw = 180 + damage.x * 45;
    motion.endYaw = 180 + 20 * Math.cos(crandom() * Math.PI);
    motion.endPitch = 5 * Math.cos(crandom() * Math.PI);
    motion.startTime = now;
    motion.endTime = Math.trunc(now + 100 + random() * 2000);
  } else if (now >= motion.endTime) {
    motion.startYaw = motion.endYaw;
    motion.startPitch = motion.endPitch;
    motion.startTime = motion.endTime;
    motion.endTime = Math.trunc(now + 100 + random() * 2000);
    motion.endYaw = 180 + 20 * Math.cos(crandom() * Math.PI);
    motion.endPitch = 5 * Math.cos(crandom() * Math.PI);
  }

  // A start in the future, as a frozen server can leave, starts now.
  if (motion.startTime > now) motion.startTime = now;
  let frac = (now - motion.startTime) / (motion.endTime - motion.startTime);
  frac = frac * frac * (3 - 2 * frac);
  return {
    x,
    y: SCREEN_HEIGHT - size,
    size,
    pitch: motion.startPitch + (motion.endPitch - motion.startPitch) * frac,
    yaw: motion.startYaw + (motion.endYaw - motion.startYaw) * frac
  };
}
