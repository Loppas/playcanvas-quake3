import { f } from './cm/q-math';
import type { Level } from './level';

/**
 * `crandom()` (`q_shared.h:678`) as the game module's QVM computes it: `2.0 * (random() - 0.5)`,
 * every value a float, since q3lcc's `double` is one. The draw is the game's own `random()`, not
 * Quake 3's `rand()`.
 *
 * @param random - The game's `random()`, a fraction in [0, 1).
 * @returns a float in [−1, 1)
 */
export function qvmCrandom(random: () => number): number {
  return f(2 * f(f(random()) - 0.5));
}

/**
 * When a timed entity next fires: `level.time + (wait + random * crandom()) * 1000`, as
 * `trigger_multiple`, `func_timer` and `target_delay` each work it out (`g_trigger.c:66, 428`,
 * `g_target.c:99`).
 *
 * The sum is the QVM's: the time is made a float, every product and sum is a float's, and C's
 * store truncates it into an int. So a `wait` of 0.7 is 700 ms, where doubles would make it 699.
 * `crandom()` is drawn even when `random` is 0, as C evaluates it.
 *
 * @param level - Whose clock, and whose `random()`.
 * @param wait - Seconds, a float.
 * @param random - How far either way the wait may wander, in seconds, a float.
 */
export function thinkTimeAfter(level: Level, wait: number, random: number): number {
  const spread = f(random * qvmCrandom(level.itemMatch.random));
  return Math.trunc(f(f(level.time) + f(f(wait + spread) * 1000)));
}

/**
 * When a mover next thinks: `level.time + ent->wait`, its wait already in milliseconds, as a
 * binary mover works it out (`g_mover.c:601, 666`). The sum is the QVM's, as for
 * {@link thinkTimeAfter}: past 2^24 ms the time loses units, as Quake 3's does.
 *
 * @param msec - Milliseconds, a float.
 */
export function thinkTimeAfterMsec(level: Level, msec: number): number {
  return Math.trunc(f(f(level.time) + msec));
}
