/**
 * The clock a map's preview plays its stages on, as `refdef.time` runs under a game: 0 at the
 * preview's first frame, on by each frame's milliseconds after, read in whole milliseconds as
 * `cg.time` is. `pcq_previewTime` holds it, as `fixedtime` holds Quake 3 for a capture: at any
 * value but 0 the clock stands there, and back at 0 it runs on from where it stood.
 *
 * Engine-free, like the rest of `src/view/`.
 */
export class PreviewClock {
  /** The milliseconds run, kept whole and fractional. */
  private elapsed: number;
  private started = false;

  /** @param hold - `pcq_previewTime` as the preview loads: where the clock starts, held or not. */
  constructor(hold: number) {
    this.elapsed = hold;
  }

  /** The clock as the last frame left it, in whole milliseconds. */
  get time(): number {
    return Math.floor(this.elapsed);
  }

  /**
   * A frame: the clock moved on by its milliseconds, or held where `pcq_previewTime` holds it. The
   * first frame is the clock's start, and moves it nowhere.
   *
   * @param ms - The frame's length, in milliseconds.
   * @param hold - `pcq_previewTime`, read at each frame.
   * @returns {@link time}
   */
  frame(ms: number, hold: number): number {
    if (hold !== 0) this.elapsed = hold;
    else if (this.started) this.elapsed += ms;
    this.started = true;
    return this.time;
  }
}
