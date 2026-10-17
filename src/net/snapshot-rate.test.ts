import { describe, expect, it } from 'vitest';

import { SV_FPS, frameMsec, snapshotGap, snapshotMsec } from './snapshot-rate';

describe("a server's game frame", () => {
  it.each([
    [125, 8],
    [20, 50],
    // A thousand over an sv_fps that does not divide it, cut to the whole millisecond below.
    [30, 33],
    [300, 3],
    // Under a millisecond, held at 1.
    [2000, 1]
  ])('at an sv_fps of %i is %i ms', (svFps, msec) => {
    expect(frameMsec(svFps)).toBe(msec);
  });
});

describe("a client's snapshot interval", () => {
  it.each([
    ['', 50],
    ['20', 50],
    ['30', 33],
    ['40', 25],
    // At least one a second: a nought, a negative and a word each ask for one.
    ['0', 1000],
    ['-5', 1000],
    ['many', 1000],
    // `atoi`'s: the number the string starts with.
    ['30x', 33]
  ])("is %j's under the port's sv_fps: %i ms", (snaps, msec) => {
    expect(snapshotMsec(snaps, SV_FPS)).toBe(msec);
  });

  it('is held to sv_fps', () => {
    expect(snapshotMsec('125', 20)).toBe(50);
    expect(snapshotMsec(String(SV_FPS), SV_FPS)).toBe(8);
  });
});

describe('the gap between snapshots', () => {
  it.each([
    [50, 56],
    [33, 40],
    [25, 32],
    [8, 8]
  ])('is an interval of %i ms rounded up to whole 8 ms frames: %i', (msec, gap) => {
    expect(snapshotGap(msec, 8)).toBe(gap);
  });

  it('is the interval itself at a frame it divides, or with no frame to round to', () => {
    expect(snapshotGap(50, 50)).toBe(50);
    expect(snapshotGap(50, 0)).toBe(50);
  });
});
