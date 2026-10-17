import { describe, expect, it } from 'vitest';

import { DEFAULT_SPEED, OVERCLIP, PMOVE_MSEC, PM_ACCELERATE, PM_AIRACCELERATE } from './constants';
import {
  accelerate,
  angleVectors,
  applyFriction,
  clipVelocity,
  cmdScale,
  snapVector
} from './pmove-math';
import { createUserCmd } from './types';
import { dot, length, vec3, type Vec3 } from './vec3';

const TICK = PMOVE_MSEC / 1000;
const UP = vec3(0, 0, 1);

describe('clipVelocity', () => {
  it('removes the component heading into the plane', () => {
    const clipped = clipVelocity(vec3(100, 0, -100), UP, OVERCLIP);
    expect(clipped.x).toBe(100);
    expect(clipped.z).toBeGreaterThan(0);
  });

  it('leaves velocity along the plane untouched', () => {
    expect(clipVelocity(vec3(320, 0, 0), UP, OVERCLIP)).toEqual(vec3(320, 0, 0));
  });

  it('overbounces away from the plane so the mover cannot re-collide with it', () => {
    // The residual is tiny — 0.1% of the incoming normal component — but its sign is what
    // stops the mover sticking to walls and floors.
    const clipped = clipVelocity(vec3(0, 0, -1000), UP, OVERCLIP);
    expect(clipped.z).toBeCloseTo(1, 5);
  });

  it('divides rather than multiplies when already moving away from the plane', () => {
    // Both branches leave the mover on the outside, but the sign of the backoff decides
    // which: heading in, the normal component is scaled up; heading out, it is scaled down.
    const clipped = clipVelocity(vec3(0, 0, 1000), UP, OVERCLIP);
    expect(clipped.z).toBeCloseTo(1000 - 1000 / OVERCLIP, 5);
    expect(clipped.z).toBeGreaterThan(0);
  });
});

describe('accelerate', () => {
  const forward = vec3(1, 0, 0);

  it('accelerates towards the wish direction', () => {
    const v = accelerate(vec3(), forward, DEFAULT_SPEED, PM_ACCELERATE, TICK);
    // accelspeed = accel * frametime * wishspeed = 10 * 0.008 * 320
    expect(v.x).toBeCloseTo(25.6);
  });

  it('never overshoots the wish speed', () => {
    const v = accelerate(vec3(319, 0, 0), forward, DEFAULT_SPEED, PM_ACCELERATE, TICK);
    expect(v.x).toBe(DEFAULT_SPEED);
  });

  it('does nothing once at the wish speed', () => {
    const v = accelerate(vec3(320, 0, 0), forward, DEFAULT_SPEED, PM_ACCELERATE, TICK);
    expect(v).toEqual(vec3(320, 0, 0));
  });

  it('does nothing when the wish direction is unwanted', () => {
    expect(accelerate(vec3(100, 0, 0), forward, 0, PM_ACCELERATE, TICK)).toEqual(vec3(100, 0, 0));
  });

  it('measures speed as the projection onto the wish direction, not the true speed', () => {
    // Moving at 320 along +X, but wishing along +Y: the cap sees a current speed of 0, so
    // the full acceleration lands and total speed rises above 320. This is the loophole.
    const v = accelerate(vec3(320, 0, 0), vec3(0, 1, 0), DEFAULT_SPEED, PM_AIRACCELERATE, TICK);
    expect(v.y).toBeCloseTo(2.56);
    expect(length(v)).toBeGreaterThan(DEFAULT_SPEED);
  });

  it('gains speed in the air at any angle where the projection is below the cap', () => {
    // 500 ups along +X with the wish direction 60 degrees off: projection is 250 < 320, so
    // the move still accelerates despite already being far over the nominal top speed.
    const wishdir = vec3(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3), 0);
    const before = vec3(500, 0, 0);
    const after = accelerate(before, wishdir, DEFAULT_SPEED, PM_AIRACCELERATE, TICK);

    expect(dot(before, wishdir)).toBeCloseTo(250);
    expect(length(after)).toBeGreaterThan(length(before));
  });

  it('refuses to accelerate when the wish direction is already saturated', () => {
    // Same speed, but wishing straight ahead: projection is 500 > 320, so nothing is added.
    // Holding only forward in mid-air therefore gives no air control at all in vanilla Q3.
    const before = vec3(500, 0, 0);
    expect(accelerate(before, vec3(1, 0, 0), DEFAULT_SPEED, PM_AIRACCELERATE, TICK)).toEqual(before);
  });
});

describe('applyFriction', () => {
  it('does nothing in the air, which is what preserves momentum between jumps', () => {
    const v = vec3(500, 0, -100);
    expect(applyFriction(v, false, false, TICK)).toEqual(v);
  });

  it('stops a drift under 1 ups in the air, counting the fall in the speed', () => {
    // Off the ground `PM_Friction` measures the whole velocity (bg_pmove.c:179–190).
    expect(applyFriction(vec3(0.5, 0, 0.5), false, false, TICK)).toEqual(vec3(0, 0, 0.5));
    const falling = vec3(0.5, 0, -2);
    expect(applyFriction(falling, false, false, TICK)).toEqual(falling);
  });

  it('decays exponentially above the stop speed', () => {
    // drop = speed * friction * frametime = 320 * 6 * 0.008 = 15.36
    expect(applyFriction(vec3(320, 0, 0), true, false, TICK).x).toBeCloseTo(304.64);
  });

  it('decays at a constant rate below the stop speed', () => {
    // Control is floored at 100, so drop = 100 * 6 * 0.008 = 4.8 regardless of speed.
    expect(applyFriction(vec3(50, 0, 0), true, false, TICK).x).toBeCloseTo(45.2);
    expect(applyFriction(vec3(20, 0, 0), true, false, TICK).x).toBeCloseTo(15.2);
  });

  it('stops dead below 1 ups rather than creeping', () => {
    expect(applyFriction(vec3(0.5, 0.5, 0), true, false, TICK)).toEqual(vec3(0, 0, 0));
  });

  it('keeps vertical velocity when snapping a crawling speed to zero', () => {
    expect(applyFriction(vec3(0.5, 0, -200), true, false, TICK)).toEqual(vec3(0, 0, -200));
  });

  it('measures only horizontal speed while walking', () => {
    // A large downward velocity must not inflate the friction applied to the horizontal move.
    const withFall = applyFriction(vec3(320, 0, -400), true, false, TICK);
    const withoutFall = applyFriction(vec3(320, 0, 0), true, false, TICK);
    expect(withFall.x).toBeCloseTo(withoutFall.x);
  });

  it('removes nothing in the knockback window, but still measures flat', () => {
    // bg_pmove.c:196–201: the window skips the drop, not the walking measure.
    const v = vec3(320, 0, 0);
    expect(applyFriction(v, true, true, TICK)).toEqual(v);
    expect(applyFriction(vec3(0.5, 0, -200), true, true, TICK)).toEqual(vec3(0, 0, -200));
  });

  /** {@link applyFriction} with a water term of `water`, and neither flight nor a spectator. */
  const inWater = (v: Vec3, walking: boolean, groundless: boolean, water: number) =>
    applyFriction(v, walking, groundless, TICK, false, false, undefined, water);

  it("slows the whole speed in water by the level's share, in the air too", () => {
    // drop = speed * waterfriction * level * frametime = 500 * 2 * 0.008 = 8, of 3D speed 500.
    const swimming = inWater(vec3(300, 0, -400), false, false, 2);
    expect(swimming.x).toBeCloseTo(300 * (492 / 500), 9);
    expect(swimming.z).toBeCloseTo(-400 * (492 / 500), 9);
  });

  it("keeps the water's term where the ground's is suspended, and adds it where it is not", () => {
    const v = vec3(320, 0, 0);
    expect(inWater(v, true, true, 1).x).toBeCloseTo(317.44, 9);
    // 15.36 of the ground's and 2.56 of the water's.
    expect(inWater(v, true, false, 1).x).toBeCloseTo(302.08, 9);
  });

  it('takes about 0.4 s to stop from full speed', () => {
    let v = vec3(DEFAULT_SPEED, 0, 0);
    let ticks = 0;
    while (length(v) > 0 && ticks < 1000) {
      v = applyFriction(v, true, false, TICK);
      ticks++;
    }
    expect(ticks * TICK).toBeGreaterThan(0.3);
    expect(ticks * TICK).toBeLessThan(0.5);
  });
});

describe('cmdScale', () => {
  it('is zero with no input', () => {
    expect(cmdScale(createUserCmd(), DEFAULT_SPEED)).toBe(0);
  });

  it('reaches full speed on a single axis at full deflection', () => {
    const cmd = createUserCmd({ forwardmove: 127 });
    expect(cmdScale(cmd, DEFAULT_SPEED) * 127).toBeCloseTo(DEFAULT_SPEED);
  });

  it('gives diagonals the same top speed as cardinals, not a root-two bonus', () => {
    const cmd = createUserCmd({ forwardmove: 127, rightmove: 127 });
    const wishspeed = cmdScale(cmd, DEFAULT_SPEED) * Math.hypot(127, 127);
    expect(wishspeed).toBeCloseTo(DEFAULT_SPEED);
  });

  it('lets a held jump eat into horizontal wish speed', () => {
    // The upmove term is why PM_CheckJump zeroes upmove once the jump is consumed.
    const withJump = createUserCmd({ forwardmove: 127, upmove: 127 });
    const wishspeed = cmdScale(withJump, DEFAULT_SPEED) * 127;
    expect(wishspeed).toBeLessThan(DEFAULT_SPEED);
    expect(wishspeed).toBeCloseTo(DEFAULT_SPEED / Math.SQRT2);
  });
});

describe('snapVector', () => {
  it('rounds every component to an integer', () => {
    expect(snapVector(vec3(304.64, -0.4, 6.4))).toEqual(vec3(305, -0, 6));
  });

  it('breaks ties away from zero, matching C', () => {
    expect(snapVector(vec3(2.5, -2.5, 0.5))).toEqual(vec3(3, -3, 1));
  });

  it('leaves integers alone, so a settled velocity does not drift', () => {
    expect(snapVector(vec3(320, 0, 0))).toEqual(vec3(320, 0, 0));
  });
});

describe('angleVectors', () => {
  it('faces +X at zero yaw', () => {
    const { forward, right } = angleVectors(vec3(0, 0, 0));
    expect(forward.x).toBeCloseTo(1);
    expect(forward.y).toBeCloseTo(0);
    expect(right.x).toBeCloseTo(0);
    expect(right.y).toBeCloseTo(-1);
  });

  it('yaws anticlockwise about the up axis', () => {
    const { forward } = angleVectors(vec3(0, 90, 0));
    expect(forward.x).toBeCloseTo(0);
    expect(forward.y).toBeCloseTo(1);
  });

  it('pitches so that positive pitch looks downward', () => {
    expect(angleVectors(vec3(45, 0, 0)).forward.z).toBeCloseTo(-Math.SQRT1_2);
  });

  it('returns an orthonormal basis', () => {
    const { forward, right, up } = angleVectors(vec3(30, 40, 0));
    expect(length(forward)).toBeCloseTo(1);
    expect(length(right)).toBeCloseTo(1);
    expect(length(up)).toBeCloseTo(1);
    expect(dot(forward, right)).toBeCloseTo(0);
    expect(dot(forward, up)).toBeCloseTo(0);
    expect(dot(right, up)).toBeCloseTo(0);
  });
});
