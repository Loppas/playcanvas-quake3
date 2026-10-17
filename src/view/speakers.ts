import { MAX_GENTITIES } from '../net/protocol';
import { f } from '../sim/cm/q-math';
import { qvmCrandom } from '../sim/think-time';

/**
 * `CG_Speaker` (`cg_ents.c:206-220`): a speaker that sounds again by itself, every `wait` seconds
 * give or take `random`, played by each client from what the speaker's entity carries: `s.frame`
 * is its `wait` and `s.clientNum` its `random`, in tenths of a second. Only a `random` makes one
 * repeat, as the C tests `clientNum` ("FIXME: use something other than clientNum"), so a `wait`
 * alone never does, and a `random` alone sounds again at the first frame its draw falls behind.
 *
 * It runs only while the speaker is in the snapshot, and its first sound is at the first frame it
 * is, each entity's time starting at 0 with cgame. The sum is the QVM's, in floats.
 *
 * Engine-free, like the rest of `src/view/`.
 */
export class SpeakerSchedule {
  /** `cent->miscTime` of each entity: the time its speaker may next sound at. */
  private readonly miscTime = new Int32Array(MAX_GENTITIES);

  /** `CG_Init`'s clear of `cg_entities`: every speaker sounds at the first frame it is in. */
  clear(): void {
    this.miscTime.fill(0);
  }

  /**
   * Whether a speaker sounds this frame, its next time set if it does.
   *
   * @param frame - `s.frame`: its `wait`, in tenths of a second.
   * @param clientNum - `s.clientNum`: its `random`, in tenths of a second.
   * @param time - `cg.time`, in whole milliseconds.
   * @param random - cgame's `random()`, a fraction in [0, 1].
   */
  sounds(
    number: number,
    frame: number,
    clientNum: number,
    time: number,
    random: () => number
  ): boolean {
    if (!clientNum) return false;
    if (time < this.miscTime[number]) return false;
    const spread = f(f(clientNum * 100) * qvmCrandom(random));
    this.miscTime[number] = Math.trunc(f(f(time + frame * 100) + spread));
    return true;
  }

  /** `cent->miscTime` of an entity, for a check. */
  next(number: number): number {
    return this.miscTime[number];
  }
}
