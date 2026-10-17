import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { CROUCH_VIEWHEIGHT, DEFAULT_SPEED, DEFAULT_VIEWHEIGHT } from '../sim/constants';
import { EV, type Event } from '../sim/events';
import { createIdlePlayerState } from '../sim/types';
import { vec3 } from '../sim/vec3';
import {
  CG_BOBUP,
  CG_RUNPITCH,
  CG_RUNROLL,
  DUCK_TIME,
  LAND_DEFLECT_TIME,
  LAND_RETURN_TIME,
  MAX_BOB_UP,
  MAX_STEP_CHANGE,
  STEP_TIME,
  createCameraFeel,
  firstPersonView,
  transitionCameraFeel,
  type CameraFeel,
  type ViewSample
} from './camera-feel';

/**
 * The camera-feel maths in isolation: each glide's shape over time, and the view lean.
 *
 * These are the numbers behind "stairs glide instead of pop"; `player-view.test.ts` proves
 * they hold when driven by the real simulation.
 */

/** Bob cycle position at the midpoint of a stride, where the bob is at its largest. */
const BOB_PEAK = 63;

/** Bob cycle position at a footfall, where the bob is zero. */
const BOB_FOOTFALL = 0;

/**
 * @param overrides - Fields to override on a standing player at the origin.
 */
function sample(overrides: Partial<ViewSample> = {}): ViewSample {
  return {
    origin: vec3(),
    velocity: vec3(),
    viewangles: vec3(),
    viewheight: DEFAULT_VIEWHEIGHT,
    bobCycle: BOB_FOOTFALL,
    ducked: false,
    ...overrides
  };
}

/**
 * @param feel - Camera state.
 * @param time - Time to evaluate at.
 * @param overrides - Fields to override on the sampled player.
 */
function eyeZ(feel: CameraFeel, time: number, overrides: Partial<ViewSample> = {}): number {
  return firstPersonView(feel, sample(overrides), time).origin.z;
}

/**
 * @param state - Player state after the tick.
 * @param events - Events the tick raised.
 * @param time - Time the tick ended at.
 * @param feel - Camera state to fold into; a fresh one by default.
 */
function transition(
  state: PlayerState,
  events: Event[],
  time: number,
  feel = createCameraFeel(DEFAULT_VIEWHEIGHT)
): CameraFeel {
  transitionCameraFeel(feel, state, events, time);
  return feel;
}

describe('at rest', () => {
  it('puts the eye at viewheight above the origin', () => {
    const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);
    expect(eyeZ(feel, 0, { origin: vec3(0, 0, 24) })).toBe(24 + DEFAULT_VIEWHEIGHT);
  });

  it('adds no lean when standing still', () => {
    const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);
    expect(firstPersonView(feel, sample(), 0).angles).toEqual(vec3());
  });

  it('is not mid-glide at time zero', () => {
    // The glide start times begin at -Infinity for exactly this reason: a camera created at
    // time zero must not think a step or a landing just happened.
    const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);
    expect(eyeZ(feel, 0)).toBe(DEFAULT_VIEWHEIGHT);
  });
});

describe('step glide', () => {
  const stepped = () =>
    transition(createIdlePlayerState(), [{ event: EV.STEP_16, parm: 0 }], 1000);

  it('starts by cancelling the whole step and ends having paid it all back', () => {
    const feel = stepped();
    expect(eyeZ(feel, 1000)).toBe(DEFAULT_VIEWHEIGHT - 16);
    expect(eyeZ(feel, 1000 + STEP_TIME)).toBe(DEFAULT_VIEWHEIGHT);
  });

  it('pays it back linearly', () => {
    const feel = stepped();
    expect(eyeZ(feel, 1000 + STEP_TIME / 2)).toBe(DEFAULT_VIEWHEIGHT - 8);
    expect(eyeZ(feel, 1000 + STEP_TIME / 4)).toBe(DEFAULT_VIEWHEIGHT - 12);
  });

  it('carries the unpaid remainder into a step taken mid-glide', () => {
    // Halfway through the first glide 8 units are still owed, so a second 16-unit step
    // starts from 24 rather than restarting at 16 and jolting the view upward.
    const feel = stepped();
    transitionCameraFeel(feel, createIdlePlayerState(), [{ event: EV.STEP_16, parm: 0 }], 1100);
    expect(eyeZ(feel, 1100)).toBe(DEFAULT_VIEWHEIGHT - 24);
  });

  it('caps the accumulated glide so a staircase cannot sink the camera', () => {
    const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);
    for (let i = 0; i < 10; i++) {
      transitionCameraFeel(feel, createIdlePlayerState(), [{ event: EV.STEP_16, parm: 0 }], 1000 + i);
    }
    expect(feel.stepChange).toBe(MAX_STEP_CHANGE);
  });

  it('leaves a step alone while the player is drawn between snapshots', () => {
    // "if we are interpolating, we don't need to smooth steps" (`cg_event.c:633–636`).
    const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);
    const step = [{ event: EV.STEP_16, parm: 0 }];
    transitionCameraFeel(feel, createIdlePlayerState(), step, 1000, false);
    expect(eyeZ(feel, 1000)).toBe(DEFAULT_VIEWHEIGHT);
    expect(feel.stepChange).toBe(0);
  });

  it("glides CPMA's step by the rise it carries", () => {
    const feel = transition(createIdlePlayerState(), [{ event: EV.STEP, parm: 18 }], 1000);
    expect(eyeZ(feel, 1000)).toBe(DEFAULT_VIEWHEIGHT - 18);
    expect(eyeZ(feel, 1000 + STEP_TIME / 2)).toBe(DEFAULT_VIEWHEIGHT - 9);

    // Carried into the next as id's are, and capped the same.
    transitionCameraFeel(feel, createIdlePlayerState(), [{ event: EV.STEP, parm: 18 }], 1000 + STEP_TIME / 2);
    expect(feel.stepChange).toBe(27);
    transitionCameraFeel(feel, createIdlePlayerState(), [{ event: EV.STEP, parm: 18 }], 1000 + STEP_TIME / 2);
    expect(feel.stepChange).toBe(MAX_STEP_CHANGE);
  });

  it('leaves the eye where it was before the step, given the sim moved the origin too', () => {
    // The point of the whole exercise: origin +16 and eye -16 cancel, so the camera holds
    // still at the moment of the step and rises over the next 200 ms instead.
    const feel = stepped();
    expect(eyeZ(feel, 1000, { origin: vec3(0, 0, 16) })).toBe(DEFAULT_VIEWHEIGHT);
  });
});

describe('duck glide', () => {
  it('slides the eye down over DUCK_TIME rather than dropping it', () => {
    const ducked = createIdlePlayerState({ viewheight: CROUCH_VIEWHEIGHT });
    const feel = transition(ducked, [], 1000);
    const drop = DEFAULT_VIEWHEIGHT - CROUCH_VIEWHEIGHT;

    expect(eyeZ(feel, 1000, { viewheight: CROUCH_VIEWHEIGHT })).toBe(DEFAULT_VIEWHEIGHT);
    expect(eyeZ(feel, 1000 + DUCK_TIME / 2, { viewheight: CROUCH_VIEWHEIGHT })).toBe(
      DEFAULT_VIEWHEIGHT - drop / 2
    );
    expect(eyeZ(feel, 1000 + DUCK_TIME, { viewheight: CROUCH_VIEWHEIGHT })).toBe(
      CROUCH_VIEWHEIGHT
    );
  });

  it('slides back up on standing', () => {
    const feel = transition(createIdlePlayerState({ viewheight: CROUCH_VIEWHEIGHT }), [], 1000);
    transitionCameraFeel(feel, createIdlePlayerState(), [], 2000);

    expect(eyeZ(feel, 2000)).toBe(CROUCH_VIEWHEIGHT);
    expect(eyeZ(feel, 2000 + DUCK_TIME)).toBe(DEFAULT_VIEWHEIGHT);
  });

  it('ignores a tick that did not change the eye height', () => {
    const feel = transition(createIdlePlayerState(), [], 1000);
    expect(feel.duckTime).toBe(-Infinity);
  });
});

describe('landing dip', () => {
  const landed = (fall: number) =>
    transition(createIdlePlayerState(), [{ event: fall, parm: 0 }], 1000);

  it('dips deeper the harder the landing', () => {
    expect(eyeZ(landed(EV.FALL_SHORT), 1000 + LAND_DEFLECT_TIME)).toBe(DEFAULT_VIEWHEIGHT - 8);
    expect(eyeZ(landed(EV.FALL_MEDIUM), 1000 + LAND_DEFLECT_TIME)).toBe(DEFAULT_VIEWHEIGHT - 16);
    expect(eyeZ(landed(EV.FALL_FAR), 1000 + LAND_DEFLECT_TIME)).toBe(DEFAULT_VIEWHEIGHT - 24);
  });

  it('drops for 150 ms then recovers over 300 ms', () => {
    const feel = landed(EV.FALL_MEDIUM);

    expect(eyeZ(feel, 1000)).toBe(DEFAULT_VIEWHEIGHT);
    expect(eyeZ(feel, 1000 + LAND_DEFLECT_TIME / 2)).toBe(DEFAULT_VIEWHEIGHT - 8);
    expect(eyeZ(feel, 1000 + LAND_DEFLECT_TIME)).toBe(DEFAULT_VIEWHEIGHT - 16);
    expect(eyeZ(feel, 1000 + LAND_DEFLECT_TIME + LAND_RETURN_TIME / 2)).toBe(
      DEFAULT_VIEWHEIGHT - 8
    );
    expect(eyeZ(feel, 1000 + LAND_DEFLECT_TIME + LAND_RETURN_TIME)).toBe(DEFAULT_VIEWHEIGHT);
  });

  it('is over once the return time has passed', () => {
    expect(eyeZ(landed(EV.FALL_FAR), 5000)).toBe(DEFAULT_VIEWHEIGHT);
  });
});

describe('bob', () => {
  const running = { velocity: vec3(DEFAULT_SPEED, 0, 0) };
  const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);

  it('lifts the eye at mid-stride and not at a footfall', () => {
    expect(eyeZ(feel, 0, { ...running, bobCycle: BOB_FOOTFALL })).toBe(DEFAULT_VIEWHEIGHT);
    expect(eyeZ(feel, 0, { ...running, bobCycle: BOB_PEAK })).toBeCloseTo(
      DEFAULT_VIEWHEIGHT + DEFAULT_SPEED * CG_BOBUP,
      2
    );
  });

  it('scales with ground speed but not vertical speed', () => {
    const slow = eyeZ(feel, 0, { velocity: vec3(100, 0, 0), bobCycle: BOB_PEAK });
    const fast = eyeZ(feel, 0, { velocity: vec3(300, 0, 0), bobCycle: BOB_PEAK });
    const falling = eyeZ(feel, 0, { velocity: vec3(100, 0, -900), bobCycle: BOB_PEAK });

    expect(fast).toBeGreaterThan(slow);
    expect(falling).toBeCloseTo(slow, 6);
  });

  it('is capped so a rocket jump does not launch the camera', () => {
    const eye = eyeZ(feel, 0, { velocity: vec3(4000, 0, 0), bobCycle: BOB_PEAK });
    expect(eye).toBe(DEFAULT_VIEWHEIGHT + MAX_BOB_UP);
  });

  it('rolls the view opposite ways on opposite feet', () => {
    const left = firstPersonView(feel, sample({ ...running, bobCycle: BOB_PEAK }), 0);
    const right = firstPersonView(feel, sample({ ...running, bobCycle: BOB_PEAK + 128 }), 0);

    expect(left.angles.z).toBeCloseTo(-right.angles.z, 6);
    expect(left.angles.z).not.toBe(0);
  });

  it('pitches by the same amount on both feet', () => {
    const left = firstPersonView(feel, sample({ ...running, bobCycle: BOB_PEAK }), 0);
    const right = firstPersonView(feel, sample({ ...running, bobCycle: BOB_PEAK + 128 }), 0);

    expect(left.angles.x).toBeCloseTo(right.angles.x, 6);
    expect(left.angles.x).toBeGreaterThan(0);
  });

  it('is exaggerated when crouched', () => {
    const standing = firstPersonView(feel, sample({ ...running, bobCycle: BOB_PEAK }), 0);
    const crouched = firstPersonView(
      feel,
      sample({ ...running, bobCycle: BOB_PEAK, ducked: true }),
      0
    );

    expect(Math.abs(crouched.angles.x)).toBeGreaterThan(Math.abs(standing.angles.x));
  });
});

describe('velocity lean', () => {
  const feel = createCameraFeel(DEFAULT_VIEWHEIGHT);

  /**
   * @param velocity - Velocity to lean from.
   */
  function leanFrom(velocity: ReturnType<typeof vec3>) {
    // Sampled at a footfall so the bob contributes nothing and only the lean is measured.
    return firstPersonView(feel, sample({ velocity, bobCycle: BOB_FOOTFALL }), 0).angles;
  }

  it('pitches with forward speed', () => {
    expect(leanFrom(vec3(DEFAULT_SPEED, 0, 0)).x).toBeCloseTo(DEFAULT_SPEED * CG_RUNPITCH, 6);
  });

  it('pitches the other way running backwards', () => {
    expect(leanFrom(vec3(-DEFAULT_SPEED, 0, 0)).x).toBeCloseTo(-DEFAULT_SPEED * CG_RUNPITCH, 6);
  });

  it('banks with sideways speed', () => {
    // Q3 is X-forward, Y-left, Z-up, so strafing right is -Y.
    expect(leanFrom(vec3(0, -DEFAULT_SPEED, 0)).z).toBeCloseTo(DEFAULT_SPEED * CG_RUNROLL, 6);
    expect(leanFrom(vec3(0, DEFAULT_SPEED, 0)).z).toBeCloseTo(-DEFAULT_SPEED * CG_RUNROLL, 6);
  });

  it('leans along the view direction, not the world axes', () => {
    // Facing 90 degrees left, moving along world +Y is now moving forward.
    const view = firstPersonView(
      feel,
      sample({ velocity: vec3(0, DEFAULT_SPEED, 0), viewangles: vec3(0, 90, 0) }),
      0
    );
    expect(view.angles.x).toBeCloseTo(DEFAULT_SPEED * CG_RUNPITCH, 6);
  });

  it('leaves yaw untouched', () => {
    const view = firstPersonView(
      feel,
      sample({ velocity: vec3(DEFAULT_SPEED, 0, 0), viewangles: vec3(10, 45, 0) }),
      0
    );
    expect(view.angles.y).toBe(45);
  });
});
