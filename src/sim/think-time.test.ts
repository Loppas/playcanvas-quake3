import { describe, expect, it } from 'vitest';

import { Level } from './level';
import { qvmCrandom, thinkTimeAfter } from './think-time';

/**
 * The timed entities' next think in the game module's floats. The answers are ioquake3's C with
 * q3lcc's floats for doubles, compiled and printed, at the draws given.
 */

/** A level at `time` whose `random()` hands out `draws` in turn, and how many it handed out. */
function levelAt(time: number, ...draws: number[]) {
  const level = new Level();
  level.time = time;
  const drawn = { count: 0 };
  level.itemMatch = {
    ...level.itemMatch,
    random: () => draws[drawn.count++ % draws.length]
  };
  return { level, drawn };
}

describe('qvmCrandom', () => {
  it('is 2 × (random − 0.5) in floats', () => {
    expect(qvmCrandom(() => 0.5)).toBe(0);
    expect(qvmCrandom(() => 0.125)).toBe(-0.75);
    expect(qvmCrandom(() => 0.987654)).toBe(0.97530794143676758);
  });
});

describe('thinkTimeAfter', () => {
  it.each([
    [400, 0.7, 0, 0.5, 1100],
    [400, 0.3, 0, 0.5, 700],
    [1234, 0.1, 0, 0.5, 1334],
    [400, 5, 2.5, 0.125, 3525],
    [400, 0.9, 0.3, 0.987654, 1592]
  ])('at %d, waits %f give or take %f, at a draw of %f, as the QVM: %d', (time, w, r, draw, at) => {
    const { level } = levelAt(time, draw);
    expect(thinkTimeAfter(level, Math.fround(w), Math.fround(r))).toBe(at);
  });

  it('makes a wait of 0.7 700 ms, where doubles would make it 699', () => {
    const { level } = levelAt(0, 0.5);
    const wait = Math.fround(0.7);
    expect(Math.trunc(wait * 1000)).toBe(699);
    expect(thinkTimeAfter(level, wait, 0)).toBe(700);
  });

  it('makes the time a float, which past 2²⁴ ms has lost its last unit', () => {
    expect(thinkTimeAfter(levelAt(20000001, 0.5).level, Math.fround(0.7), 0)).toBe(20000700);
    expect(thinkTimeAfter(levelAt(16777217, 0.5).level, 1, 0)).toBe(16778216);
  });

  it("truncates toward zero, as C's store does, so a time before 0 stays before it", () => {
    // `q3ctf2`'s timers: `wait 3`, `random 4` cut to −97.
    const random = Math.fround(3 - 100);
    expect(thinkTimeAfter(levelAt(400, 0).level, 3, random)).toBe(100400);
    expect(thinkTimeAfter(levelAt(400, 0.75).level, 3, random)).toBe(-45100);
    expect(thinkTimeAfter(levelAt(400, 0.25).level, 3, random)).toBe(51900);
  });

  it('draws even when the random is 0, as C evaluates crandom() regardless', () => {
    const { level, drawn } = levelAt(400, 0.5);
    thinkTimeAfter(level, 1, 0);
    expect(drawn.count).toBe(1);
  });
});
