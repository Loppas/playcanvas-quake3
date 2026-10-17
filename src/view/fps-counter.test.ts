import { describe, expect, it } from 'vitest';

import { FpsCounter } from './fps-counter';

describe('FpsCounter', () => {
  it('draws nothing for four frames, then the last four averaged', () => {
    const counter = new FpsCounter();
    // The first frame's time runs from 0, as Q3's static does; four more push it out.
    expect([1000, 1016, 1032, 1048].map((t) => counter.frame(t))).toEqual([null, null, null, null]);
    // Four 16 ms frames: 4000 / 64 = 62.5, counted whole.
    expect(counter.frame(1064)).toBe(62);
  });

  it('counts on whole milliseconds, as trap_Milliseconds does', () => {
    const counter = new FpsCounter();
    let fps: number | null = null;
    for (let frame = 0; frame < 10; frame++) fps = counter.frame(1000 + frame * (1000 / 144));
    // 6.94 ms frames floor to 6 and 7 ms steps: four of them take 27 or 28 ms.
    expect(fps === 142 || fps === 148).toBe(true);
  });
});
