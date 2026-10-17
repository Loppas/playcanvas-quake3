import type { PlayerState } from '../net/protocol';

/**
 * What the powerups do to a player while they run (`g_active.c`, `bg_pmove.c`): the rules that are
 * not the item table's and not any one weapon's.
 *
 * `items.ts` says what each powerup *is* and how it is taken; this is what holding one means.
 * The battle suit's rule lives with the damage it cuts (`combat.ts`), and regeneration's with
 * the once-a-second actions that run it (`player-life.ts`), because each is one line in a place
 * that already exists. What is here is what two separate places share — haste quickens the legs
 * and the gun — the numbers the rules take as their defaults, and the frame's expiry, which
 * belongs to the frame.
 */

/**
 * Haste's 1.3: the ground speed is multiplied by it (`g_active.c:851–853`) and every fire interval
 * is divided by it (`bg_pmove.c:1700–1702`), so a hasted player runs faster and shoots faster.
 */
export const HASTE_RATE = 1.3;

/** Share of a hit the battle suit lets through, truncated (`g_combat.c:953`). */
export const BATTLESUIT_FACTOR = 0.5;

/**
 * `ClientEndFrame`'s expiry (`g_active.c:1118–1123`): every powerup whose end time has passed is
 * cleared. The test is strictly less than, so a powerup ending exactly on this frame runs one
 * more — and since it is the frame's work, a powerup goes on expiring at the intermission.
 *
 * @param ps - The player's state; the array is cleared in place.
 * @param time - `level.time`, in milliseconds.
 */
export function expirePowerups(ps: PlayerState, time: number): void {
  for (let i = 0; i < ps.powerups.length; i++) {
    if (ps.powerups[i] < time) ps.powerups[i] = 0;
  }
}
