import { describe, expect, it } from 'vitest';

import {
  BESIDE_LAGOMETER,
  CENTRE_GRAPH,
  LAGOMETER_BOX,
  SPEED_SAMPLES,
  SpeedGraph,
  speedColumns,
  speedReadout,
  speedometerLayout
} from './speedometer';

describe('speedometerLayout', () => {
  it("draws Quake Live's four modes", () => {
    expect(speedometerLayout(0, false)).toBeNull();
    expect(speedometerLayout(1, false)).toEqual({
      readout: false,
      graph: { rect: LAGOMETER_BOX, anchor: 'right' }
    });
    expect(speedometerLayout(2, false)).toEqual({
      readout: true,
      graph: { rect: CENTRE_GRAPH, anchor: 'centre' }
    });
    expect(speedometerLayout(3, false)).toEqual({ readout: true, graph: null });
  });

  it("stands mode 1's graph left of the lagometer's box, under the scores, while it draws", () => {
    expect(BESIDE_LAGOMETER).toEqual({ x: 544, y: 432, w: 48, h: 48 });
    expect(speedometerLayout(1, true)).toEqual({
      readout: false,
      graph: { rect: BESIDE_LAGOMETER, anchor: 'right' }
    });
    expect(speedometerLayout(2, true)).toEqual(speedometerLayout(2, false));
  });

  it('puts mode 2’s graph under the readout, centred, clear of the weapon name at 358', () => {
    expect(CENTRE_GRAPH.x + CENTRE_GRAPH.w / 2).toBe(320);
    expect(CENTRE_GRAPH.y + CENTRE_GRAPH.h).toBeLessThan(358);
  });
});

describe('speedReadout', () => {
  it('rounds the speed and its peak', () => {
    expect(speedReadout(320.4, 451.6)).toEqual({ speed: '320', peak: 'peak 452' });
  });
});

describe('SpeedGraph', () => {
  it('remembers speeds newest first, and nothing before its first', () => {
    const graph = new SpeedGraph();
    graph.add(100);
    graph.add(200);
    expect([graph.sample(0), graph.sample(1), graph.sample(2)]).toEqual([200, 100, null]);
  });

  it('forgets the oldest once full', () => {
    const graph = new SpeedGraph();
    for (let i = 0; i <= SPEED_SAMPLES; i++) graph.add(i);
    expect(graph.sample(0)).toBe(SPEED_SAMPLES);
    expect(graph.sample(SPEED_SAMPLES - 1)).toBe(1);
    expect(graph.sample(SPEED_SAMPLES)).toBeNull();
  });
});

describe('speedColumns', () => {
  it('draws a column a pixel, newest at the right, up from the bottom', () => {
    const graph = new SpeedGraph();
    for (const speed of [800, 0, 160, 320]) graph.add(speed);
    // Two pixels a unit, so half a unit a column.
    const columns = speedColumns(graph, LAGOMETER_BOX, 2);
    expect(columns).toEqual([
      // 320, g_speed, fills half the box.
      { x: 639.5, y: 456, w: 0.5, h: 24 },
      { x: 639, y: 468, w: 0.5, h: 12 },
      // 0 draws nothing; 800 is past the top and stops there.
      { x: 638, y: 432, w: 0.5, h: 48 }
    ]);
  });

  it('draws no more columns than the box has pixels', () => {
    const graph = new SpeedGraph();
    for (let i = 0; i < 500; i++) graph.add(300);
    expect(speedColumns(graph, LAGOMETER_BOX, 2.25)).toHaveLength(108);
  });
});
