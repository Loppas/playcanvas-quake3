import { SNAPFLAG } from '../net/commands';
import type { HudText } from './hud';
import type { HudRect } from './hud-layout';
import type { Rgba } from './hud-status';
import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH } from './hud-text';
import { LAGOMETER_BOX } from './speedometer';

/**
 * `CG_DrawLagometer`'s two graphs (`cg_draw.c:1525–1739`), a column a pixel with the newest at the
 * right: how each drawn frame's clock sat against the newest snapshot, and how each snapshot came.
 * Engine-free.
 *
 * - The frame graph, about a third down: yellow up while the clock is past the newest snapshot, so
 *   the frame is extrapolated; blue down while it is behind it, interpolating. 300 ms fills it.
 * - The snapshot graph, up from the foot: each snapshot's ping, green, or yellow where the server
 *   held it back for the client's rate; a lost one red, half the box high. 900 ms fills it.
 */

/**
 * Samples kept of each: enough for one a pixel across the box on any screen. Q3 keeps 128
 * (`LAG_SAMPLES`), and a box wider than that in pixels repeats the newest at its left.
 */
export const LAG_SAMPLES = 1024;

/** `MAX_LAGOMETER_RANGE` (`cg_draw.c:1627`): the frame offset that fills its graph, in ms. */
export const MAX_LAGOMETER_RANGE = 300;

/** `MAX_LAGOMETER_PING` (`cg_draw.c:1626`): the ping that fills its graph, in ms. */
export const MAX_LAGOMETER_PING = 900;

/** `g_color_table`'s colours the graphs are drawn in (`q_math.c:55–65`). */
export const LAG_YELLOW: Rgba = [1, 1, 0, 1];
export const LAG_BLUE: Rgba = [0, 0, 1, 1];
export const LAG_GREEN: Rgba = [0, 1, 0, 1];
export const LAG_RED: Rgba = [1, 0, 0, 1];

/** A snapshot as the lagometer reads it: `snap->ping` and `snap->snapFlags`. */
export interface LagSnapshot {
  ping: number;
  snapFlags: number;
}

/** `lagometer_t` (`cg_draw.c:1533–1539`): the samples, each a ring the newest written over. */
export class Lagometer {
  private readonly frameSamples = new Float64Array(LAG_SAMPLES);
  private frameCount = 0;
  private readonly snapshotSamples = new Float64Array(LAG_SAMPLES);
  private readonly snapshotFlags = new Int32Array(LAG_SAMPLES);
  private snapshotCount = 0;

  /**
   * `CG_AddLagometerFrameInfo` (`cg_draw.c:1550–1556`), once a drawn frame.
   *
   * @param offset - `cg.time` less `cg.latestSnapshotTime`: past the newest snapshot if positive.
   */
  addFrame(offset: number): void {
    this.frameSamples[this.frameCount % LAG_SAMPLES] = offset;
    this.frameCount++;
  }

  /**
   * `CG_AddLagometerSnapshotInfo` (`cg_draw.c:1568–1580`): a snapshot read, or `null` for one that
   * never came or could not be read, which is kept as a ping of −1.
   */
  addSnapshot(snap: LagSnapshot | null): void {
    const i = this.snapshotCount % LAG_SAMPLES;
    this.snapshotSamples[i] = snap === null ? -1 : snap.ping;
    if (snap !== null) this.snapshotFlags[i] = snap.snapFlags;
    this.snapshotCount++;
  }

  /** The offset `age` frames ago, 0 for the newest; `null` before the history reaches back. */
  frame(age: number): number | null {
    if (age >= Math.min(this.frameCount, LAG_SAMPLES)) return null;
    return this.frameSamples[(this.frameCount - 1 - age) % LAG_SAMPLES];
  }

  /** The snapshot `age` snapshots ago, 0 for the newest; `null` before the history reaches back. */
  snapshot(age: number): LagSnapshot | null {
    if (age >= Math.min(this.snapshotCount, LAG_SAMPLES)) return null;
    const i = (this.snapshotCount - 1 - age) % LAG_SAMPLES;
    return { ping: this.snapshotSamples[i], snapFlags: this.snapshotFlags[i] };
  }
}

/** The lagometer this frame. */
export interface HudLagometer {
  /** Its box, which the `lagometer` picture fills, kept to the right edge. */
  rect: HudRect;
  /** What its columns are drawn from, by `lagometerBars`. */
  samples: Lagometer;
  /** "snc" over the box's corner while nothing is predicted, or none. */
  snc: HudText | null;
}

/**
 * The lagometer in its box (`cg_draw.c:1649–1736`), and "snc" over it under `cg_nopredict`, which
 * Q3 draws for `cg_synchronousClients` too; the port has no such setting.
 */
export function lagometerFrame(samples: Lagometer, noPredict: boolean): HudLagometer {
  return {
    rect: LAGOMETER_BOX,
    samples,
    snc: noPredict
      ? {
          text: 'snc',
          x: LAGOMETER_BOX.x,
          y: LAGOMETER_BOX.y,
          charWidth: BIGCHAR_WIDTH,
          charHeight: BIGCHAR_HEIGHT,
          color: [1, 1, 1, 1],
          shadow: true,
          anchor: 'right'
        }
      : null
  };
}

/** One of the graphs' columns, on Q3's grid, in the colour `trap_R_SetColor` gives it. */
export interface LagBar {
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgba;
}

/**
 * The graphs' columns over `box`: the frame graph's first, then the snapshot graph's, as
 * `CG_DrawLagometer` draws them (`cg_draw.c:1672–1730`). A column with no sample draws nothing, nor
 * does a sample of 0. Q3 puts the newest column a pixel past the box, off the screen's edge; here
 * it is the box's last, as the speedometer's graph has it.
 *
 * @param scale - Pixels to a unit of Q3's grid (`hudScale`).
 */
export function lagometerBars(lagometer: Lagometer, box: HudRect, scale: number): LagBar[] {
  const pixel = 1 / scale;
  const count = Math.floor(box.w * scale);
  const columnX = (age: number) => box.x + box.w - (age + 1) * pixel;
  const bars: LagBar[] = [];

  let range = box.h / 3;
  const mid = box.y + range;
  let vscale = range / MAX_LAGOMETER_RANGE;
  for (let age = 0; age < count; age++) {
    const offset = lagometer.frame(age);
    if (offset === null) break;
    const v = offset * vscale;
    if (v > 0) {
      const h = Math.min(v, range);
      bars.push({ x: columnX(age), y: mid - h, w: pixel, h, color: LAG_YELLOW });
    } else if (v < 0) {
      bars.push({ x: columnX(age), y: mid, w: pixel, h: Math.min(-v, range), color: LAG_BLUE });
    }
  }

  range = box.h / 2;
  vscale = range / MAX_LAGOMETER_PING;
  const foot = box.y + box.h;
  for (let age = 0; age < count; age++) {
    const snap = lagometer.snapshot(age);
    if (snap === null) break;
    if (snap.ping > 0) {
      const h = Math.min(snap.ping * vscale, range);
      const color = snap.snapFlags & SNAPFLAG.RATE_DELAYED ? LAG_YELLOW : LAG_GREEN;
      bars.push({ x: columnX(age), y: foot - h, w: pixel, h, color });
    } else if (snap.ping < 0) {
      bars.push({ x: columnX(age), y: foot - range, w: pixel, h: range, color: LAG_RED });
    }
  }
  return bars;
}
