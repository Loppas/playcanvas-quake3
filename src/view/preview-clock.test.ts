import { describe, expect, it } from 'vitest';

import { PreviewClock } from './preview-clock';

describe('PreviewClock', () => {
  it("starts at 0 on the preview's first frame, and runs on by each frame's milliseconds", () => {
    const clock = new PreviewClock(0);
    expect(clock.frame(16.7, 0)).toBe(0);
    expect(clock.frame(4.2, 0)).toBe(4);
    expect(clock.frame(4.2, 0)).toBe(8);
    // Whole milliseconds, as cg.time is, the fractions kept.
    expect(clock.frame(0.7, 0)).toBe(9);
    expect(clock.time).toBe(9);
  });

  it('holds where pcq_previewTime says, from the load on, and runs on from there at 0', () => {
    const clock = new PreviewClock(12345);
    expect(clock.time).toBe(12345);
    expect(clock.frame(4, 12345)).toBe(12345);
    expect(clock.frame(4, 12345)).toBe(12345);
    // Set again, it moves there; back at 0, it runs on from where it stood.
    expect(clock.frame(4, 20000)).toBe(20000);
    expect(clock.frame(4, 0)).toBe(20004);
    expect(clock.frame(6, 0)).toBe(20010);
  });
});
