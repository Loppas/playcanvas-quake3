import { describe, expect, it } from 'vitest';

import { CONTENTS } from '../sim/constants';
import { clearTrace, type PointContentsFn, type TraceFn } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import {
  BUBBLE_LIFETIME,
  BUBBLE_RADIUS,
  MISSILE_BUBBLE_SPACING,
  PELLET_BUBBLE_SPACING,
  WATER_BUBBLE_SHADER,
  bubbleAlpha,
  bubbleOrigin,
  bubbleTrail,
  pelletBubbleLine
} from './bubbles';

/** `random()` handing out these, in turn. */
const draws = (...values: number[]) => () => values.shift()!;

describe('CG_BubbleTrail', () => {
  it("draws cgame's sprite at a radius of 3, every 8 units of a trail and 32 of a pellet", () => {
    expect([WATER_BUBBLE_SHADER, BUBBLE_RADIUS]).toEqual(['waterBubble', 3]);
    expect([MISSILE_BUBBLE_SPACING, PELLET_BUBBLE_SPACING]).toEqual([8, 32]);
  });

  it('starts a random whole number of units in, then one every spacing to the end', () => {
    // `rand() % 8` is 3, then each bubble draws its life and its three drifts.
    const bubbles = bubbleTrail(vec3(10, 0, 0), vec3(30, 0, 0), 8, 1000, () => 0.4);
    expect(bubbles.map(({ base }) => base.x)).toEqual([13, 21, 29]);
    expect(bubbles.every(({ base }) => base.y === 0 && base.z === 0)).toBe(true);
    // `rand() % 8` is whole: 0.45 of the way is 3.6, which is 3, never 4.
    const most = bubbleTrail(vec3(10, 0, 0), vec3(30, 0, 0), 8, 1000, () => 0.45);
    expect(most.map(({ base }) => base.x)).toEqual([13, 21, 29]);
    // Along the line whichever way it runs.
    const down = bubbleTrail(vec3(0, 0, 0), vec3(0, 0, -20), 8, 1000, () => 0);
    expect(down.map(({ base }) => base)).toEqual([vec3(), vec3(0, 0, -8), vec3(0, 0, -16)]);
  });

  it('lays none along no line, and none past its end', () => {
    expect(bubbleTrail(vec3(5, 5, 5), vec3(5, 5, 5), 8, 1000, () => 0)).toEqual([]);
    // Seven units in, along a line of six.
    expect(bubbleTrail(vec3(), vec3(6, 0, 0), 8, 1000, () => 0.9)).toEqual([]);
  });

  it('gives each a second and up to a quarter more, and a drift up of 1 to 11 a second', () => {
    const [bubble] = bubbleTrail(vec3(), vec3(4, 0, 0), 8, 1000, draws(0, 0.999, 0, 0.5, 1));
    // `cg.time + 1000 + random() * 250`, truncated into an int.
    expect([bubble.startTime, bubble.endTime]).toEqual([1000, 1000 + BUBBLE_LIFETIME + 249]);
    // `crandom() * 5`, and `+ 6` up.
    expect(bubble.delta).toEqual(vec3(-5, 0, 11));
    const [still] = bubbleTrail(vec3(), vec3(4, 0, 0), 8, 1000, draws(0, 0, 0.5, 0.5, 0.5));
    expect([still.endTime, still.delta]).toEqual([2000, vec3(0, 0, 6)]);
  });

  it('drifts in a line from where it was laid, and fades by the byte to nothing', () => {
    const [bubble] = bubbleTrail(vec3(10, 0, 0), vec3(14, 0, 0), 8, 1000, draws(0, 0, 1, 0.5, 0));
    expect(bubble.delta).toEqual(vec3(5, 0, 1));
    expect(bubbleOrigin(bubble, 1000)).toEqual(vec3(10, 0, 0));
    expect(bubbleOrigin(bubble, 1500)).toEqual(vec3(12.5, 0, 0.5));
    expect(bubbleAlpha(bubble, 1000)).toBe(1);
    // `0xff * c`, c a quarter of the way through: 191.25 kept as 191.
    expect(bubbleAlpha(bubble, 1250)).toBe(191 / 255);
    expect(bubbleAlpha(bubble, 2000)).toBe(0);
  });
});

describe("CG_ShotgunPellet's bubbles", () => {
  /** A pool whose surface is z = 0: water below, air above. */
  const pool: PointContentsFn = (point) => (point.z < 0 ? CONTENTS.WATER : 0);
  /** The pool's surface, found by a trace against water alone coming down into it. */
  const traced: { start: Vec3; end: Vec3; mask: number }[] = [];
  const surface: TraceFn = (start, _mins, _maxs, end, _pass, mask) => {
    traced.push({ start, end, mask });
    if (!(mask & CONTENTS.WATER) || end.z >= 0) return clearTrace(end);
    // A sweep that never leaves the water is all in it, as cm has it: stopped where it began.
    if (start.z < 0) return { ...clearTrace(start), fraction: 0, startsolid: true, allsolid: true };
    const fraction = start.z / (start.z - end.z);
    const endpos = vec3(start.x + fraction * (end.x - start.x), 0, 0);
    return { ...clearTrace(endpos), fraction, contents: CONTENTS.WATER };
  };
  const line = (start: Vec3, end: Vec3, hit: Vec3) => {
    traced.length = 0;
    return pelletBubbleLine(start, end, hit, surface, pool);
  };

  it('runs the whole way when both ends are in the water, and nowhere when both are dry', () => {
    expect(line(vec3(0, 0, -50), vec3(800, 0, -50), vec3(100, 0, -50))).toEqual({
      start: vec3(0, 0, -50),
      end: vec3(100, 0, -50)
    });
    expect(traced).toEqual([]);
    expect(line(vec3(0, 0, 50), vec3(800, 0, 50), vec3(100, 0, 50))).toBeNull();
  });

  it('runs from a muzzle under water up to the surface, traced back from the far end', () => {
    expect(line(vec3(0, 0, -50), vec3(200, 0, 150), vec3(100, 0, 50))).toEqual({
      start: vec3(0, 0, -50),
      end: vec3(50, 0, 0)
    });
    expect(traced).toEqual([
      { start: vec3(200, 0, 150), end: vec3(0, 0, -50), mask: CONTENTS.WATER }
    ]);
  });

  it('runs from where a pellet struck under water up to the surface it came in by', () => {
    expect(line(vec3(0, 0, 50), vec3(200, 0, -150), vec3(100, 0, -50))).toEqual({
      start: vec3(100, 0, -50),
      end: vec3(50, 0, 0)
    });
    expect(traced).toEqual([
      { start: vec3(0, 0, 50), end: vec3(200, 0, -150), mask: CONTENTS.WATER }
    ]);
  });

  it('asks only for water: a pellet into slime or lava, or out of it, leaves none', () => {
    const lava: PointContentsFn = (point) => (point.z < 0 ? CONTENTS.LAVA : 0);
    const under = vec3(9, 0, -5);
    const over = vec3(9, 0, 5);
    expect(pelletBubbleLine(vec3(0, 0, -5), under, under, surface, lava)).toBeNull();
    expect(pelletBubbleLine(vec3(0, 0, 5), under, under, surface, lava)).toBeNull();
    expect(pelletBubbleLine(vec3(0, 0, -5), over, over, surface, lava)).toBeNull();
  });

  it('asks CG_PointContents what each end is in, passing entity 0', () => {
    const asked: number[] = [];
    const recording: PointContentsFn = (point, pass) => {
      asked.push(pass);
      return pool(point, pass);
    };
    pelletBubbleLine(vec3(0, 0, -5), vec3(9, 0, 5), vec3(9, 0, 5), surface, recording);
    expect(asked).toEqual([0, 0]);
  });

  it('compares the whole of the contents, so water with fog at one end is traced for', () => {
    // `sourceContentType == destContentType`: not the same, so the muzzle's water is traced back
    // from the far end, which is in it too.
    const fogged: PointContentsFn = (point) =>
      (point.z < 0 ? CONTENTS.WATER : 0) | (point.x > 50 ? CONTENTS.FOG : 0);
    traced.length = 0;
    const end = vec3(99, 0, -5);
    expect(pelletBubbleLine(vec3(0, 0, -5), end, end, surface, fogged)).toEqual({
      start: vec3(0, 0, -5),
      end
    });
    expect(traced).toEqual([{ start: end, end: vec3(0, 0, -5), mask: CONTENTS.WATER }]);
  });
});
