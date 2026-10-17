/**
 * `CG_DrawFPS`'s count (`cg_draw.c:731–768`): frames a second, averaged over the last four, on the
 * real clock, "because that will be drifting to correct for internet lag changes, timescales,
 * timedemos, etc". Engine-free.
 */

/** `FPS_FRAMES` (`cg_draw.c:731`). */
export const FPS_FRAMES = 4;

/** Where the count is drawn: its right end at 635, 2 down (`cg_draw.c:764`). */
export const FPS_RIGHT = 635;
export const FPS_Y = 2;

/** The frame times `CG_DrawFPS` keeps in its statics. */
export class FpsCounter {
  private readonly times = new Array<number>(FPS_FRAMES).fill(0);
  private index = 0;
  private previous = 0;

  /**
   * Count a frame drawn at `now`, in milliseconds of real time. Q3 counts only the frames it draws
   * the number on.
   *
   * @returns frames a second, whole; `null` for the first four, which Q3 draws nothing for
   */
  frame(now: number): number | null {
    const t = Math.floor(now);
    this.times[this.index % FPS_FRAMES] = t - this.previous;
    this.previous = t;
    this.index++;
    if (this.index <= FPS_FRAMES) return null;
    const total = this.times.reduce((sum, time) => sum + time, 0) || 1;
    return Math.trunc((1000 * FPS_FRAMES) / total);
  }
}
