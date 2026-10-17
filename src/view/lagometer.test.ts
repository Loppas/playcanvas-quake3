import { describe, expect, it } from 'vitest';

import { SNAPFLAG } from '../net/commands';
import { BIGCHAR_HEIGHT, BIGCHAR_WIDTH } from './hud-text';
import {
  LAG_BLUE,
  LAG_GREEN,
  LAG_RED,
  LAG_SAMPLES,
  LAG_YELLOW,
  Lagometer,
  lagometerBars,
  lagometerFrame,
  type LagBar
} from './lagometer';
import { LAGOMETER_BOX } from './speedometer';

/** The bars to a millionth of a unit, which the graphs' scales leave in their last bits. */
function rounded(bars: readonly LagBar[]): LagBar[] {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return bars.map((bar) => ({ ...bar, x: round(bar.x), y: round(bar.y), h: round(bar.h) }));
}

describe('Lagometer', () => {
  it('keeps each frame and snapshot newest first, and nothing before its first', () => {
    const lagometer = new Lagometer();
    lagometer.addFrame(-20);
    lagometer.addFrame(4);
    lagometer.addSnapshot({ ping: 50, snapFlags: SNAPFLAG.RATE_DELAYED });
    lagometer.addSnapshot(null);
    expect([lagometer.frame(0), lagometer.frame(1), lagometer.frame(2)]).toEqual([4, -20, null]);
    // A lost snapshot is a ping of −1.
    expect(lagometer.snapshot(0)?.ping).toBe(-1);
    expect(lagometer.snapshot(1)).toEqual({ ping: 50, snapFlags: SNAPFLAG.RATE_DELAYED });
    expect(lagometer.snapshot(2)).toBeNull();
  });

  it('forgets the oldest of each once full', () => {
    const lagometer = new Lagometer();
    for (let i = 0; i <= LAG_SAMPLES; i++) {
      lagometer.addFrame(i);
      lagometer.addSnapshot({ ping: i, snapFlags: 0 });
    }
    expect(lagometer.frame(0)).toBe(LAG_SAMPLES);
    expect(lagometer.frame(LAG_SAMPLES - 1)).toBe(1);
    expect(lagometer.frame(LAG_SAMPLES)).toBeNull();
    expect(lagometer.snapshot(LAG_SAMPLES - 1)?.ping).toBe(1);
    expect(lagometer.snapshot(LAG_SAMPLES)).toBeNull();
  });
});

describe('lagometerBars', () => {
  it('draws the frame graph a third down: yellow up while ahead, blue down while behind', () => {
    const lagometer = new Lagometer();
    for (const offset of [-150, 0, 75, 600]) lagometer.addFrame(offset);
    // Two pixels a unit, so half a unit a column; 300 ms fills the graph's 16.
    expect(rounded(lagometerBars(lagometer, LAGOMETER_BOX, 2))).toEqual([
      // 600 is past the top and stops at it.
      { x: 639.5, y: 432, w: 0.5, h: 16, color: LAG_YELLOW },
      { x: 639, y: 444, w: 0.5, h: 4, color: LAG_YELLOW },
      // 0 draws nothing; behind the newest snapshot draws down from the middle.
      { x: 638, y: 448, w: 0.5, h: 8, color: LAG_BLUE }
    ]);
  });

  it('draws the snapshot graph up from the foot, after the frame graph', () => {
    const lagometer = new Lagometer();
    lagometer.addFrame(-30);
    lagometer.addSnapshot({ ping: 300, snapFlags: 0 });
    lagometer.addSnapshot(null);
    lagometer.addSnapshot({ ping: 1800, snapFlags: SNAPFLAG.RATE_DELAYED });
    lagometer.addSnapshot({ ping: 0, snapFlags: 0 });
    // 900 ms fills the graph's 24, half the box.
    expect(rounded(lagometerBars(lagometer, LAGOMETER_BOX, 2))).toEqual([
      { x: 639.5, y: 448, w: 0.5, h: 1.6, color: LAG_BLUE },
      // A ping of 0 draws nothing; one the server held back for the rate is yellow.
      { x: 639, y: 456, w: 0.5, h: 24, color: LAG_YELLOW },
      // A lost one fills the graph, red.
      { x: 638.5, y: 456, w: 0.5, h: 24, color: LAG_RED },
      { x: 638, y: 472, w: 0.5, h: 8, color: LAG_GREEN }
    ]);
  });

  it('draws no more columns than the box has pixels', () => {
    const lagometer = new Lagometer();
    for (let i = 0; i < 500; i++) lagometer.addFrame(30);
    expect(lagometerBars(lagometer, LAGOMETER_BOX, 2.25)).toHaveLength(108);
  });

  it("keeps a sample for every column of a box wider than Q3's 128, repeating none", () => {
    const lagometer = new Lagometer();
    for (let offset = 1; offset <= 300; offset++) lagometer.addFrame(offset);
    // 2160 high: 216 columns, each a frame older than the one to its right.
    const bars = lagometerBars(lagometer, LAGOMETER_BOX, 4.5);
    expect(bars).toHaveLength(216);
    expect(bars.at(-1)!.x).toBeCloseTo(LAGOMETER_BOX.x, 9);
    for (let i = 1; i < bars.length; i++) expect(bars[i].h).toBeLessThan(bars[i - 1].h);
  });
});

describe('lagometerFrame', () => {
  it("is the lagometer's box, with snc over its corner only under cg_nopredict", () => {
    const samples = new Lagometer();
    expect(lagometerFrame(samples, false)).toEqual({ rect: LAGOMETER_BOX, samples, snc: null });
    expect(lagometerFrame(samples, true).snc).toEqual({
      text: 'snc',
      x: 592,
      y: 432,
      charWidth: BIGCHAR_WIDTH,
      charHeight: BIGCHAR_HEIGHT,
      color: [1, 1, 1, 1],
      shadow: true,
      anchor: 'right'
    });
  });
});
