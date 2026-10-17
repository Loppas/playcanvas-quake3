import { describe, expect, it } from 'vitest';
import type { Animation } from '../formats/animation-config';
import { ANIM, ANIM_TOGGLEBIT } from '../sim/animations';
import { clearLerpFrame, createLerpFrame, runLerpFrame, type LerpFrame } from './lerp-frame';

/** A table with every row one frame at 20 fps, but the ones a test sets. */
function table(rows: Partial<Record<number, Partial<Animation>>>): Animation[] {
  return Array.from({ length: ANIM.MAX_TOTALANIMATIONS }, (_, i) => {
    const row = rows[i] ?? {};
    const frameLerp = row.frameLerp ?? 50;
    return {
      firstFrame: 0,
      numFrames: 1,
      loopFrames: 0,
      frameLerp,
      initialLerp: frameLerp,
      reversed: false,
      flipflop: false,
      ...row
    };
  });
}

const ANIMATIONS = table({
  [ANIM.LEGS_IDLE]: { firstFrame: 10, numFrames: 4, loopFrames: 4 },
  [ANIM.LEGS_RUN]: { firstFrame: 30, numFrames: 10, loopFrames: 10, frameLerp: 40 },
  [ANIM.LEGS_JUMP]: { firstFrame: 20, numFrames: 3 },
  [ANIM.LEGS_BACK]: { firstFrame: 60, numFrames: 4, loopFrames: 4, reversed: true },
  [ANIM.LEGS_SWIM]: { firstFrame: 10, numFrames: 4, loopFrames: 2 },
  [ANIM.TORSO_ATTACK]: { firstFrame: 40, numFrames: 3 }
});

/** Run a part at each time, collecting `[oldFrame, frame, backlerp]`. */
function play(
  lf: LerpFrame,
  animation: number,
  times: readonly number[],
  speedScale = 1
): [number, number, number][] {
  return times.map((time) => {
    runLerpFrame(ANIMATIONS, lf, animation, time, speedScale);
    return [lf.oldFrame, lf.frame, lf.backlerp];
  });
}

/** Run a part at each time, collecting the frame it blends toward. */
function frames(lf: LerpFrame, animation: number, times: readonly number[], speedScale = 1): number[] {
  return play(lf, animation, times, speedScale).map(([, frame]) => frame);
}

/** A part cleared to `animation` at `time`, as `CG_ClearLerpFrame` leaves one. */
function cleared(animation: number, time = 0): LerpFrame {
  const lf = createLerpFrame();
  clearLerpFrame(ANIMATIONS, lf, animation, time);
  return lf;
}

describe('runLerpFrame', () => {
  it('steps a frame every frameLerp, blending between them', () => {
    const lf = cleared(ANIM.LEGS_IDLE, 1000);
    expect(play(lf, ANIM.LEGS_IDLE, [1000, 1050, 1075, 1100])).toEqual([
      [10, 10, 1],
      [10, 11, 1],
      [10, 11, 0.5],
      [11, 12, 1]
    ]);
  });

  it('loops the last loopFrames frames', () => {
    const lf = cleared(ANIM.LEGS_SWIM);
    expect(frames(lf, ANIM.LEGS_SWIM, [0, 50, 100, 150, 200, 250, 300])).toEqual([
      10, 11, 12, 13, 12, 13, 12
    ]);
  });

  it('holds the last frame of an animation with no loop, free to change at once', () => {
    const lf = cleared(ANIM.LEGS_JUMP);
    expect(play(lf, ANIM.LEGS_JUMP, [0, 50, 100, 150, 200])).toEqual([
      [20, 20, 1],
      [20, 21, 1],
      [21, 22, 1],
      [22, 22, 0],
      [22, 22, 0]
    ]);
    // Stuck at the end, its clock sits at now, so the next animation's first frame is one
    // initialLerp away rather than one frame's remainder.
    expect(play(lf, ANIM.LEGS_IDLE, [200, 225, 250])).toEqual([
      [22, 10, 1],
      [22, 10, 0.5],
      [10, 11, 1]
    ]);
  });

  it('crossfades into a new animation from wherever the old one had got to', () => {
    const lf = cleared(ANIM.LEGS_IDLE);
    play(lf, ANIM.LEGS_IDLE, [0, 50]);
    // Mid-way from 10 to 11, the run is asked for. Idle finishes its step at 100, then blends
    // into the run's first frame over the run's initialLerp.
    expect(play(lf, ANIM.LEGS_RUN, [75, 100, 120, 140])).toEqual([
      [10, 11, 0.5],
      [11, 30, 1],
      [11, 30, 0.5],
      [30, 31, 1]
    ]);
  });

  it('restarts an animation whose toggle bit has flipped, and not one whose has not', () => {
    const shot = ANIM.TORSO_ATTACK;
    const again = cleared(shot);
    play(again, shot, [0, 50, 100, 150, 200, 250]);
    const held = structuredClone(again);
    expect(frames(held, shot, [300])).toEqual([42]);
    expect(frames(again, shot ^ ANIM_TOGGLEBIT, [300])).toEqual([40]);
  });

  it('counts a reversed row down from its last frame', () => {
    const lf = cleared(ANIM.LEGS_BACK);
    expect(frames(lf, ANIM.LEGS_BACK, [0, 50, 100, 150, 200])).toEqual([63, 62, 61, 60, 63]);
  });

  it('skips frames at a speed scale, as haste plays 1.5 times as fast', () => {
    const lf = cleared(ANIM.LEGS_RUN);
    expect(frames(lf, ANIM.LEGS_RUN, [0, 40, 80, 120, 160, 200], 1.5)).toEqual([
      30, 31, 33, 34, 36, 37
    ]);
  });

  it('pulls its clock back to now when the time has gone back', () => {
    const lf = cleared(ANIM.LEGS_IDLE, 10000);
    runLerpFrame(ANIMATIONS, lf, ANIM.LEGS_IDLE, 5000);
    expect(lf.frameTime).toBe(5000);
    expect(lf.oldFrameTime).toBe(5000);
    expect(lf.backlerp).toBe(0);
  });

  it("shows a fresh part's first frame whole", () => {
    // `CG_ResetPlayerEntity` leaves the part zeroed, with no animation; the first run starts one.
    const lf = createLerpFrame();
    expect(play(lf, ANIM.LEGS_IDLE, [5000])).toEqual([[0, 10, 0]]);
  });

  it('refuses an animation number past the table, toggle bit or not', () => {
    const lf = createLerpFrame();
    expect(() => runLerpFrame(ANIMATIONS, lf, ANIM.MAX_TOTALANIMATIONS, 0)).toThrow(
      'Bad animation number: 37'
    );
    expect(() =>
      runLerpFrame(ANIMATIONS, lf, ANIM.MAX_TOTALANIMATIONS | ANIM_TOGGLEBIT, 0)
    ).toThrow();
    expect(() => runLerpFrame(ANIMATIONS, lf, ANIM.FLAG_STAND2RUN | ANIM_TOGGLEBIT, 0)).not.toThrow();
  });
});

describe('clearLerpFrame', () => {
  it('shows the first frame now, blended from nothing', () => {
    const lf = cleared(ANIM.LEGS_RUN, 700);
    expect([lf.oldFrame, lf.frame, lf.oldFrameTime, lf.frameTime]).toEqual([30, 30, 700, 700]);
    expect(lf.animationTime).toBe(740);
  });
});
