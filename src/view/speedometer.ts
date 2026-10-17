import { DEFAULT_SPEED } from '../sim/constants';
import type { HudAnchor, HudRect } from './hud-layout';
import { BIGCHAR_HEIGHT, SMALLCHAR_HEIGHT } from './hud-text';

/**
 * Quake Live's `cg_speedometer`: the player's horizontal speed, as a number under
 * the crosshair, as a graph drawn the way the lagometer draws its own, or both. Neither ioq3 nor
 * CorkScrew has one, so the layout is the port's, in Q3's text and lagometer style:
 *
 * - 0: off.
 * - 1: the graph, in the lagometer's box at the bottom right, which Q3 leaves empty on a local
 *   server or with `cg_lagometer 0` (`CG_DrawLagometer`, `cg_draw.c:1641`); the box to its left,
 *   under the scores, while the lagometer has its own.
 * - 2: the number, and the graph under it, below the crosshair.
 * - 3: the number alone.
 *
 * The number has a peak line: the fastest since the player last stood still on the ground.
 * Engine-free.
 */

/** `cg_speedometer`, as Quake Live numbers its settings. */
export type SpeedometerMode = 0 | 1 | 2 | 3;

/** The lagometer's box (`cg_draw.c:1653–1654`), where mode 1 draws. */
export const LAGOMETER_BOX: HudRect = { x: 592, y: 432, w: 48, h: 48 };

/**
 * The box to its left, where mode 1 draws while the lagometer is drawn: the bottom row, under the
 * scores, which fill the column over the lagometer.
 */
export const BESIDE_LAGOMETER: HudRect = { ...LAGOMETER_BOX, x: LAGOMETER_BOX.x - LAGOMETER_BOX.w };

/** Under the crosshair: the speed, then the peak line, then mode 2's graph. */
export const SPEED_Y = 264;
export const PEAK_Y = SPEED_Y + BIGCHAR_HEIGHT + 2;
export const CENTRE_GRAPH: HudRect = { x: 296, y: PEAK_Y + SMALLCHAR_HEIGHT + 4, w: 48, h: 48 };

/** The graph's top: twice `g_speed`, so a run on the ground fills half the box. */
export const SPEED_GRAPH_TOP = 2 * DEFAULT_SPEED;

/** `COLOR_YELLOW`, the lagometer's frame graph (`cg_draw.c:1680`). */
export const SPEED_GRAPH_COLOR = [1, 1, 0, 1] as const;

/** Frames the graph remembers: enough for one a pixel across its box on any screen. */
export const SPEED_SAMPLES = 1024;

/** A mode's parts. */
export interface SpeedometerLayout {
  /** The number and its peak line, centred under the crosshair. */
  readout: boolean;
  /** The graph's box, and the edge it keeps to. */
  graph: { rect: HudRect; anchor: HudAnchor } | null;
}

/**
 * What a mode draws, or `null` for off.
 *
 * @param lagometer - Whether the lagometer is drawn in its box: `cg_lagometer` on, and the server
 *   elsewhere.
 */
export function speedometerLayout(
  mode: SpeedometerMode,
  lagometer: boolean
): SpeedometerLayout | null {
  switch (mode) {
    case 1:
      return {
        readout: false,
        graph: { rect: lagometer ? BESIDE_LAGOMETER : LAGOMETER_BOX, anchor: 'right' }
      };
    case 2:
      return { readout: true, graph: { rect: CENTRE_GRAPH, anchor: 'centre' } };
    case 3:
      return { readout: true, graph: null };
    default:
      return null;
  }
}

/** The number's two lines. */
export function speedReadout(speed: number, peak: number): { speed: string; peak: string } {
  return { speed: String(Math.round(speed)), peak: `peak ${Math.round(peak)}` };
}

/** The speeds of recent frames: the graph's history, as the lagometer keeps its own. */
export class SpeedGraph {
  private readonly samples = new Float64Array(SPEED_SAMPLES);
  private count = 0;

  /** Record this frame's speed, once a frame, as `CG_AddLagometerFrameInfo` records its own. */
  add(speed: number): void {
    this.samples[this.count % SPEED_SAMPLES] = speed;
    this.count++;
  }

  /** The speed `age` frames ago, 0 for this frame; `null` before the history reaches so far back. */
  sample(age: number): number | null {
    if (age >= Math.min(this.count, SPEED_SAMPLES)) return null;
    return this.samples[(this.count - 1 - age) % SPEED_SAMPLES];
  }
}

/** One of the graph's columns, on Q3's grid. */
export interface SpeedColumn {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The graph's columns: one a pixel wide, the newest at the right, each rising from the bottom by
 * its frame's speed, as `CG_DrawLagometer` draws its frame graph (`cg_draw.c:1672–1697`). A speed
 * past the top stops at the top.
 *
 * @param scale - Pixels to a unit of Q3's grid (`hudScale`).
 */
export function speedColumns(graph: SpeedGraph, box: HudRect, scale: number): SpeedColumn[] {
  const pixel = 1 / scale;
  const columns: SpeedColumn[] = [];
  const count = Math.floor(box.w * scale);
  for (let age = 0; age < count; age++) {
    const speed = graph.sample(age);
    if (speed === null) break;
    const h = Math.min(box.h, (speed * box.h) / SPEED_GRAPH_TOP);
    if (h <= 0) continue;
    columns.push({ x: box.x + box.w - (age + 1) * pixel, y: box.y + box.h - h, w: pixel, h });
  }
  return columns;
}
