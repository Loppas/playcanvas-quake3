import { MAX_POWERUPS } from '../net/protocol';
import { ICON_SIZE, CHAR_WIDTH, fieldDigits, type Digit } from './hud-status';
import { SCORES_Y } from './hud-scores';
import { SCREEN_WIDTH, type HudRect } from './hud-layout';

/**
 * The powerups a player holds: `CG_DrawPowerups` (`cg_draw.c:1171–1268`) on the HUD, and
 * `CG_PowerupTimerSounds` (`cg_view.c:699–718`), the tick the wear-off sound runs on.
 *
 * Engine-free, like the rest of `src/view/`: this says which timers are up and where they go, and
 * the render layer draws them. The wear-off sound is a rule rather than a state, so the sound bus
 * can ask it once a frame.
 */

/** `POWERUP_BLINKS` and `POWERUP_BLINK_TIME` (`cg_local.h:34, 36`): the last five seconds blink. */
export const POWERUP_BLINKS = 5;
export const POWERUP_BLINK_TIME = 1000;

/** `PULSE_TIME` and `PULSE_SCALE` (`cg_local.h:38, 56`): the jump of an icon just taken up. */
export const PULSE_TIME = 200;
export const PULSE_SCALE = 1.5;

/** `INT_MAX` (`q_shared.h:81`): an endless timer, which is a CTF flag's and is not drawn. */
const NO_END = 0x7fffffff;

/** Where the stack starts: `CG_DrawLowerRight`'s row, less what `CG_DrawScores` hands back. */
export const POWERUPS_Y = SCORES_Y - 8;

/** The timer's field starts two digits in from the icon's left, as `CG_DrawField` lays it out. */
const FIELD_X = SCREEN_WIDTH - ICON_SIZE - CHAR_WIDTH * 2;

/** One powerup with time left on it. */
export interface PowerupTimer {
  /** The `PW` value, whose item's icon draws. */
  powerup: number;
  /** Milliseconds left, which is what the list is ordered by. */
  remaining: number;
  /** The whole seconds left, in a two-digit field at (x, y). */
  digits: Digit[];
  x: number;
  y: number;
  /** The icon's box: 48 square, scaled by the pulse about the same centre. */
  icon: HudRect;
  /** The icon's modulate alpha, or `null` for none — the blink of the last five seconds. */
  alpha: number | null;
}

/**
 * The powerups running, soonest to run out first.
 *
 * The ordering is Q3's insertion sort rather than a comparator, so that two timers that are equal
 * to the millisecond — two powerups taken in the same second — come out in the same order round.
 *
 * @param powerups - `ps.powerups`: the end time of each powerup, by its `PW` value.
 * @param active - `cg.powerupActive`: the powerup just taken up, whose icon pulses.
 * @param activeTime - `cg.powerupTime`: when it was taken.
 * @param time - Game time in milliseconds.
 */
export function powerupTimers(
  powerups: readonly number[],
  active: number,
  activeTime: number,
  time: number
): PowerupTimer[] {
  const sorted: number[] = [];
  const remaining: number[] = [];

  for (let i = 0; i < MAX_POWERUPS; i++) {
    const end = powerups[i] ?? 0;
    if (!end || end === NO_END) continue;
    const left = end - time;
    if (left <= 0) continue;

    let j = 0;
    for (; j < sorted.length; j++) {
      if (remaining[j] >= left) {
        for (let k = sorted.length - 1; k >= j; k--) {
          sorted[k + 1] = sorted[k];
          remaining[k + 1] = remaining[k];
        }
        break;
      }
    }
    sorted[j] = i;
    remaining[j] = left;
  }

  const timers: PowerupTimer[] = [];
  let y = POWERUPS_Y;
  for (let i = 0; i < sorted.length; i++) {
    const left = remaining[i];
    y -= ICON_SIZE;

    const pulsing = sorted[i] === active && time - activeTime < PULSE_TIME;
    const size = pulsing
      ? ICON_SIZE * (1 + (PULSE_SCALE - 1) * (1 - (time - activeTime) / PULSE_TIME))
      : ICON_SIZE;
    // Over the last five seconds the icon blinks: its alpha is the fraction of a second it is in.
    let alpha: number | null = null;
    if (left < POWERUP_BLINKS * POWERUP_BLINK_TIME) {
      const f = left / POWERUP_BLINK_TIME;
      alpha = f - Math.floor(f);
    }

    timers.push({
      powerup: sorted[i],
      remaining: left,
      digits: fieldDigits(FIELD_X, 2, Math.trunc(left / 1000)),
      x: FIELD_X,
      y,
      icon: { x: SCREEN_WIDTH - size, y: y + ICON_SIZE / 2 - size / 2, w: size, h: size },
      alpha
    });
  }
  return timers;
}

/**
 * `CG_PowerupTimerSounds` (`cg_view.c:699–718`): whether a powerup crossed a whole second while
 * under five seconds from its end, which is the tick that plays the wear-off sound.
 *
 * The comparison is against the second *before* this one (`cg.oldTime`), so a frame that crosses a
 * boundary ticks once and the frames after it do not.
 *
 * @param powerups - `ps.powerups`.
 * @param time - Game time in milliseconds, now.
 * @param oldTime - Game time at the frame before.
 */
export function powerupsWearingOff(
  powerups: readonly number[],
  time: number,
  oldTime: number
): boolean {
  for (let i = 0; i < MAX_POWERUPS; i++) {
    const end = powerups[i] ?? 0;
    if (end <= time) continue;
    const left = end - time;
    if (left >= POWERUP_BLINKS * POWERUP_BLINK_TIME) continue;
    if (
      Math.floor(left / POWERUP_BLINK_TIME) !==
      Math.floor((end - oldTime) / POWERUP_BLINK_TIME)
    ) {
      return true;
    }
  }
  return false;
}
