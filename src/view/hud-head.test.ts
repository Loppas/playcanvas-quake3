import { describe, expect, it } from 'vitest';
import { parseMd3 } from '../formats/md3';
import { havePak0, openPak } from '../pak/pak-test-fixtures';
import { createHeadMotion, headFraming, statusBarHead } from './hud-head';

describe('headFraming', () => {
  it('backs the head off until 70% of its height fills the 30° view, centred, plus the offset', () => {
    // 0.7 × 10 / 0.268 = 26.12 away, less the offset's 22; centred at y 1 and z −4, less 3.
    const [x, y, z] = headFraming([-4, -2, -1], [6, 4, 9], [-22, 0, -3]);
    expect(x).toBeCloseTo(4.12, 2);
    expect(y).toBe(1);
    expect(z).toBe(-7);
  });
});

describe.skipIf(!havePak0)("sarge's head (pak0)", () => {
  it('frames at the golden (19.83, −0.03, −2.42)', async () => {
    const pak0 = await openPak('pak0.pk3');
    const head = parseMd3((await pak0.read('models/players/sarge/head.md3'))!);
    const { mins, maxs } = head.frames[0];
    const [x, y, z] = headFraming(mins, maxs, [0, 0, 0]);
    expect(x).toBeCloseTo(19.83, 2);
    expect(y).toBeCloseTo(-0.03, 2);
    expect(z).toBeCloseTo(-2.42, 2);
  });
});

/** No hurt yet. */
const UNHURT = { time: Number.NEGATIVE_INFINITY, x: 0 };

/** `random()` giving each of `values` in turn, then the last for good. */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** Q3's ease, `frac²(3 − 2 frac)`. */
const ease = (frac: number) => frac * frac * (3 - 2 * frac);

describe('statusBarHead', () => {
  it('sits in its 60 box on the bottom edge, right of the health', () => {
    const head = statusBarHead(createHeadMotion(), UNHURT, 1000, () => 0.5);
    expect(head).toMatchObject({ x: 285, y: 420, size: 60 });
  });

  it('picks where to look next as it gets there, and eases toward it', () => {
    const motion = createHeadMotion();
    // The next pick 1100 ms on; then crandom 0.5 and 1, so yaw 180 + 20 cos(π/2) and pitch 5 cos(π).
    const head = statusBarHead(motion, UNHURT, 1000, sequence(0.5, 0.75, 1));
    expect(motion).toEqual({
      startYaw: 0,
      endYaw: 180 + 20 * Math.cos(Math.PI / 2),
      startPitch: 0,
      endPitch: -5,
      startTime: 0,
      endTime: 2100
    });
    // Zeroed at the start, as Q3's is, so it turns in from yaw 0.
    expect(head.yaw).toBeCloseTo(180 * ease(1000 / 2100), 9);
    expect(head.pitch).toBeCloseTo(-5 * ease(1000 / 2100), 9);

    // There at 2100, and off to the next.
    const next = statusBarHead(motion, UNHURT, 2100, sequence(0, 0.5, 0.5));
    expect(next.yaw).toBeCloseTo(180, 9);
    expect(next.pitch).toBe(-5);
    expect(motion).toMatchObject({ startTime: 2100, endTime: 2200, endYaw: 200, endPitch: 5 });
  });

  it('flinches for 500 ms after a hurt: 90 at the hit, pushed along and turned 45°', () => {
    const motion = createHeadMotion();
    const hurt = { time: 1000, x: 1 };
    const hit = statusBarHead(motion, hurt, 1000, () => 0.5);
    expect(hit).toMatchObject({ x: 255, y: 390, size: 90, yaw: 225 });

    // Halfway: 75, rising off the bottom edge.
    expect(statusBarHead(motion, hurt, 1250, () => 0.5)).toMatchObject({ x: 270, y: 405, size: 75 });

    // Over at 1500: back in its box, easing from 225 toward the pick the 1250 frame made, which
    // runs to 2350.
    const after = statusBarHead(motion, hurt, 1500, () => 0.5);
    expect(after).toMatchObject({ x: 285, y: 420, size: 60 });
    expect(after.yaw).toBeCloseTo(225 + (200 - 225) * ease(250 / 1100), 9);
  });

  it('starts an ease no later than now', () => {
    const motion = { ...createHeadMotion(), startTime: 5000, endTime: 6000, endYaw: 180 };
    const head = statusBarHead(motion, UNHURT, 3000, () => 0.5);
    expect(motion.startTime).toBe(3000);
    expect(head.yaw).toBe(0);
  });
});
