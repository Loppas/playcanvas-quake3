import { describe, expect, it } from 'vitest';

import { MAX_POWERUPS } from '../net/protocol';
import { PW } from '../sim/items';
import { CHAR_WIDTH, ICON_SIZE } from './hud-status';
import { SCORES_Y } from './hud-scores';
import { SCREEN_WIDTH } from './hud-layout';
import {
  POWERUP_BLINK_TIME,
  POWERUPS_Y,
  powerupTimers,
  powerupsWearingOff
} from './powerup-timers';

/**
 * `CG_DrawPowerups` and `CG_PowerupTimerSounds`: the timers of the powerups a player holds, and
 * the tick of the sound as one runs out.
 */

/** A `ps.powerups` array with a few powerups running. */
function holding(entries: readonly (readonly [number, number])[]): number[] {
  const powerups = new Array<number>(MAX_POWERUPS).fill(0);
  for (const [powerup, end] of entries) powerups[powerup] = end;
  return powerups;
}

describe('powerupTimers', () => {
  it('lists them soonest first, at the lower right', () => {
    const timers = powerupTimers(
      holding([
        [PW.QUAD, 10_000],
        [PW.HASTE, 4_000],
        [PW.BATTLESUIT, 7_000]
      ]),
      0,
      0,
      1_000
    );

    expect(timers.map((timer) => timer.powerup)).toEqual([PW.HASTE, PW.BATTLESUIT, PW.QUAD]);
    // The first sits one icon up from where the scores leave off, and each next one above it.
    expect(POWERUPS_Y).toBe(SCORES_Y - 8);
    expect(timers.map((timer) => timer.y)).toEqual([
      POWERUPS_Y - ICON_SIZE,
      POWERUPS_Y - 2 * ICON_SIZE,
      POWERUPS_Y - 3 * ICON_SIZE
    ]);
    // The field is two digits at the left of the icon; the icon hangs from the right edge.
    expect(timers[0].x).toBe(SCREEN_WIDTH - ICON_SIZE - CHAR_WIDTH * 2);
    expect(timers[0].icon).toMatchObject({ x: SCREEN_WIDTH - ICON_SIZE, w: ICON_SIZE });
    expect(timers[0].icon.y + timers[0].icon.h / 2).toBe(timers[0].y + ICON_SIZE / 2);
  });

  it('shows whole seconds left, truncated', () => {
    const [timer] = powerupTimers(holding([[PW.QUAD, 1_000 + 11_900]]), 0, 0, 1_000);
    expect(timer.remaining).toBe(11_900);
    expect(timer.digits.map(({ frame }) => frame)).toEqual([1, 1]);
  });

  it('leaves out what has run out, and what never will', () => {
    // An expired powerup, one at the very instant, an empty slot, and a flag's `INT_MAX`.
    const timers = powerupTimers(
      holding([
        [PW.QUAD, 999],
        [PW.HASTE, 1_000],
        [PW.INVIS, 0x7fffffff]
      ]),
      0,
      0,
      1_000
    );
    expect(timers).toEqual([]);
  });

  it('blinks the icon over the last five seconds, and not before', () => {
    const [last] = powerupTimers(holding([[PW.QUAD, 6_000]]), 0, 0, 1_000);
    expect(last.alpha).toBeNull();

    // 3.25 seconds left: the icon's alpha is the fraction of the second it is in.
    const [blinking] = powerupTimers(holding([[PW.QUAD, 4_250]]), 0, 0, 1_000);
    expect(blinking.alpha).toBeCloseTo(0.25, 6);
    const [dark] = powerupTimers(holding([[PW.QUAD, 3_001]]), 0, 0, 1_000);
    expect(dark.alpha).toBeCloseTo(0.001, 6);
  });

  it('pulses the icon of one just taken, and only while it is fresh', () => {
    const powerups = holding([[PW.QUAD, 30_000]]);
    // Taken this instant: half again as big.
    const [fresh] = powerupTimers(powerups, PW.QUAD, 1_000, 1_000);
    expect(fresh.icon.w).toBeCloseTo(ICON_SIZE * 1.5, 6);
    // Halfway through the pulse: three quarters of the way out to it.
    const [half] = powerupTimers(powerups, PW.QUAD, 1_000, 1_100);
    expect(half.icon.w).toBeCloseTo(ICON_SIZE * 1.25, 6);
    // Over: plain.
    const [plain] = powerupTimers(powerups, PW.QUAD, 1_000, 1_200);
    expect(plain.icon.w).toBe(ICON_SIZE);
    // And a pulse is for the powerup it is about.
    const [other] = powerupTimers(powerups, PW.HASTE, 1_000, 1_000);
    expect(other.icon.w).toBe(ICON_SIZE);
  });
});

describe('powerupsWearingOff', () => {
  const time = 10_000;

  it('ticks once for each whole second left under five', () => {
    // 4.5 seconds left, then 4.4: both are the second numbered 4, so the tick has not come.
    const powerups = holding([[PW.QUAD, time + 4_500]]);
    expect(powerupsWearingOff(powerups, time, time - 100)).toBe(false);
    // 4.5 to 3.5: the second changes, and with it the tick.
    expect(powerupsWearingOff(holding([[PW.QUAD, time + 4_500]]), time, time - 1_000)).toBe(true);
  });

  it('says nothing while there is more than five seconds left, or none at all', () => {
    const secondsLeft = (left: number) => holding([[PW.QUAD, time + left]]);
    expect(powerupsWearingOff(secondsLeft(5_000), time, time - 1_000)).toBe(false);
    expect(powerupsWearingOff(secondsLeft(30_000), time, time - 1_000)).toBe(false);
    expect(powerupsWearingOff(secondsLeft(0), time, time - 1_000)).toBe(false);
    expect(powerupsWearingOff(holding([]), time, time - 1_000)).toBe(false);
    // The flag's endless timer has no end to tick down.
    expect(powerupsWearingOff(holding([[PW.REDFLAG, 0x7fffffff]]), time, time - 1_000)).toBe(false);
  });

  it('ticks for any one of several', () => {
    const powerups = holding([
      [PW.QUAD, time + 30_000],
      [PW.HASTE, time + 4_500]
    ]);
    expect(powerupsWearingOff(powerups, time, time - POWERUP_BLINK_TIME)).toBe(true);
  });
});
