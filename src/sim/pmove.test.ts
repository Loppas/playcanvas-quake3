import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, ENTITYNUM_WORLD, type PlayerState } from '../net/protocol';
import { box, createFlatWorldTrace } from './box-world';
import {
  CONTENTS,
  CROUCH_VIEWHEIGHT,
  DEFAULT_SPEED,
  DEFAULT_VIEWHEIGHT,
  JUMP_VELOCITY,
  MASK,
  MINS_Z,
  PMF_DUCKED,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  PMOVE_MSEC,
  PM_DEAD,
  STAT,
  STEPSIZE
} from './constants';
import { SPAWN_KNOCKBACK_TIME } from './player-life';
import { MAXTOUCH, Pmove, pmove } from './pmove';
import { createIdlePlayerState, createUserCmd, type TraceFn, type UserCmd } from './types';
import { distinctAsks, recordingTrace } from './trace-test-fixtures';
import { vec3 } from './vec3';

/**
 * Integration tests: the whole simulation driven tick by tick against the reference box
 * world, checking the behaviours that define Quake's movement feel.
 *
 * Golden values are the ideal-maths figures, allowing for the integer velocity snap, which is
 * why several are ranges rather than exact.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

let state: PlayerState;
let trace: TraceFn;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
  trace = createFlatWorldTrace();
});

/**
 * Advance the simulation.
 *
 * @param ticks - Number of {@link PMOVE_MSEC} ticks to run.
 * @param input - Input held for every tick.
 */
function run(ticks: number, input: Partial<UserCmd> = {}) {
  for (let i = 0; i < ticks; i++) {
    const cmd = createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC });
    pmove(state, cmd, trace);
  }
}

/** Horizontal speed, which is what every Quake speed figure refers to. */
function horizontalSpeed(): number {
  return Math.hypot(state.velocity.x, state.velocity.y);
}

describe('ground movement', () => {
  it('settles on the ground and stays there', () => {
    run(20);
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
    expect(state.origin.z).toBeCloseTo(GROUND_Z, 1);
    expect(state.velocity.z).toBe(0);
  });

  it('reaches exactly the configured top speed and holds it', () => {
    run(125, { forwardmove: 127 });

    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);
    expect(state.velocity.x).toBe(DEFAULT_SPEED);
    expect(state.velocity.y).toBe(0);
  });

  it('accelerates to full speed in about 0.15 s', () => {
    // Acceleration alone would reach 320 in 12.5 ticks, but friction is applied first every
    // tick and eats into the gain, so the real figure is a little over half again as long.
    run(10, { forwardmove: 127 });
    expect(horizontalSpeed()).toBeLessThan(DEFAULT_SPEED);

    run(10, { forwardmove: 127 });
    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);
  });

  it('tops out at the same speed running diagonally', () => {
    run(125, { forwardmove: 127, rightmove: 127 });
    expect(horizontalSpeed()).toBeCloseTo(DEFAULT_SPEED, 0);
  });

  it('runs in the direction it is facing', () => {
    run(125, { forwardmove: 127, angles: vec3(0, 90, 0) });

    expect(state.velocity.x).toBeCloseTo(0, 0);
    expect(state.velocity.y).toBe(DEFAULT_SPEED);
  });

  it('comes to a complete stop when input is released', () => {
    run(125, { forwardmove: 127 });
    run(60);

    expect(horizontalSpeed()).toBe(0);
  });

  it('decays speed by the friction curve on the first tick', () => {
    run(125, { forwardmove: 127 });
    run(1);

    // 320 - (320 * 6 * 0.008) = 304.64, snapped to an integer.
    expect(state.velocity.x).toBe(305);
  });

  it('keeps velocity on integers every tick', () => {
    run(40, { forwardmove: 127, rightmove: 63 });

    expect(state.velocity.x).toBe(Math.trunc(state.velocity.x));
    expect(state.velocity.y).toBe(Math.trunc(state.velocity.y));
    expect(state.velocity.z).toBe(Math.trunc(state.velocity.z));
  });
});

describe('jumping', () => {
  it('launches at the jump velocity, less the tick of gravity it is integrated with', () => {
    // The jump is resolved inside the walk move and the air move runs in the same tick, so
    // the first velocity an observer sees is already one tick of gravity down from 270:
    // 270 - 800 * 0.008 = 263.6, snapped to 264.
    run(1, { upmove: 127 });
    expect(state.velocity.z).toBe(JUMP_VELOCITY - 6);
  });

  it('leaves the ground', () => {
    run(2, { upmove: 127 });
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(false);
  });

  it('reaches the 125 Hz apex height, above the continuous-maths figure', () => {
    // Continuous maths gives JUMP_VELOCITY^2 / (2 * gravity) = 45.5625 units, but the
    // integer velocity snap raises it. Gravity removes 6.4 ups per 8 ms tick and the snap
    // rounds 263.6 up to 264, so vertical speed actually falls by 6 per tick: an effective
    // gravity of 750 rather than 800, and an apex of 48.53.
    //
    // This is the mechanism behind Q3's famous frame-rate-dependent jump heights, and it is
    // why 125 fps was the competitive standard — at 60 fps the same rounding goes the other
    // way and the apex drops below 45. Pinned here so any future change to the snap, the
    // tick length or the integration order shows up immediately.
    let apex = state.origin.z;
    run(1, { upmove: 127 });
    for (let i = 0; i < 200 && state.velocity.z > 0; i++) {
      run(1, { upmove: 127 });
      apex = Math.max(apex, state.origin.z);
    }

    expect(apex - GROUND_Z).toBeCloseTo(48.53, 2);
  });

  it('lands back on the ground', () => {
    run(1, { upmove: 127 });
    run(200, { upmove: 127 });

    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
    // Landing settles a surface epsilon above the floor rather than exactly on it — the
    // trace deliberately stops short so the result is never penetrating.
    expect(state.origin.z).toBeGreaterThanOrEqual(GROUND_Z);
    expect(state.origin.z).toBeLessThan(GROUND_Z + 0.2);
  });

  it('does not auto-hop while jump is held', () => {
    run(1, { upmove: 127 });
    run(200, { upmove: 127 });

    // Landed with jump still held: vanilla Q3 requires a release before the next jump.
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
    run(1, { upmove: 127 });
    expect(state.velocity.z).not.toBe(JUMP_VELOCITY);
  });

  it('jumps again once jump is released and pressed', () => {
    run(1, { upmove: 127 });
    run(200, { upmove: 127 });

    run(1);
    run(1, { upmove: 127 });
    expect(state.velocity.z).toBe(JUMP_VELOCITY - 6);
  });

  it('does not slow the run down while jumping', () => {
    run(125, { forwardmove: 127 });
    const before = horizontalSpeed();
    run(1, { forwardmove: 127, upmove: 127 });

    expect(horizontalSpeed()).toBe(before);
  });
});

describe('strafe jumping', () => {
  it('gains speed beyond the ground cap', () => {
    // The classic technique: hold forward and strafe, and turn steadily into the strafe.
    // Speed climbs because PM_Accelerate only ever measures the projection onto wishdir.
    run(125, { forwardmove: 127 });
    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);

    let yaw = 0;
    run(1, { forwardmove: 127, upmove: 127, angles: vec3(0, yaw, 0) });
    for (let i = 0; i < 40; i++) {
      yaw += 0.7;
      run(1, {
        forwardmove: 127,
        rightmove: 127,
        upmove: 127,
        angles: vec3(0, yaw, 0)
      });
    }

    expect(horizontalSpeed()).toBeGreaterThan(DEFAULT_SPEED);
  });

  it('gains nothing from holding forward alone in the air', () => {
    run(125, { forwardmove: 127 });
    run(1, { forwardmove: 127, upmove: 127 });
    const afterJump = horizontalSpeed();
    run(30, { forwardmove: 127, upmove: 127 });

    // wishdir lines up with velocity, so the projection is already at the cap: no air control.
    expect(horizontalSpeed()).toBeCloseTo(afterJump, 0);
  });

  it('preserves horizontal momentum in the air, since there is no air friction', () => {
    run(125, { forwardmove: 127 });
    const before = horizontalSpeed();

    run(1, { upmove: 127 });
    run(20, { upmove: 127 });

    expect(horizontalSpeed()).toBe(before);
  });
});

describe('air friction', () => {
  it('stops a drift under 1 ups in the air, where PM_AirMove runs PM_Friction', () => {
    // bg_pmove.c:609 and 185–190. Left alone, the velocity snap would round 0.5 up to 1 and
    // the player would drift for ever.
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 500) });
    state.velocity = vec3(0.5, 0, 0);
    run(1);
    expect(state.velocity.x).toBe(0);
  });

  it('counts the fall in the speed, so a slow drift while falling is kept', () => {
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 500) });
    state.velocity = vec3(0.5, 0, -100);
    run(1);
    expect(state.velocity.x).toBe(1);
  });
});

describe('knockback window', () => {
  it("walks at the air rate, under gravity, for a spawn's first 100 ms", () => {
    // The window as `ClientSpawn` opens it. Tick 1 adds the air rate's 2.56 ups, and the tick's
    // 6.4 ups of fall joins the magnitude before the clip turns it along the floor:
    // √(2.56² + 6.4²) = 6.89, snapped to 7 (bg_pmove.c:771–797). The window closes on the
    // 13th tick, and ground acceleration takes over.
    state.pmFlags |= PMF_TIME_KNOCKBACK | PMF_RESPAWNED;
    state.pmTime = SPAWN_KNOCKBACK_TIME;

    const speeds: number[] = [];
    for (let i = 0; i < 13; i++) {
      run(1, { forwardmove: 127 });
      speeds.push(horizontalSpeed());
    }
    expect(speeds).toEqual([7, 12, 16, 20, 23, 26, 29, 32, 35, 38, 41, 44, 65]);
  });
});

describe('crouching', () => {
  it('ducks instantly and lowers the eye height', () => {
    run(1, { upmove: -127 });

    expect(state.pmFlags & PMF_DUCKED).toBeTruthy();
    expect(state.viewheight).toBe(CROUCH_VIEWHEIGHT);
  });

  it('stands back up when the crouch is released', () => {
    run(1, { upmove: -127 });
    run(1);

    expect(state.pmFlags & PMF_DUCKED).toBeFalsy();
    expect(state.viewheight).toBe(DEFAULT_VIEWHEIGHT);
  });

  it('stays crouched under a low ceiling', () => {
    // Ceiling 20 units above the floor: room for the 16-unit crouched box, not the 32-unit
    // standing one.
    trace = createFlatWorldTrace([box(-512, -512, GROUND_Z + 20, 512, 512, GROUND_Z + 200)]);
    run(1, { upmove: -127 });
    run(5);

    expect(state.pmFlags & PMF_DUCKED).toBeTruthy();
  });

  it('caps crouched speed at a quarter of the run speed', () => {
    run(125, { forwardmove: 127, upmove: -127 });
    expect(horizontalSpeed()).toBeCloseTo(DEFAULT_SPEED * 0.25, 0);
  });
});

describe('collision', () => {
  it('stops at a wall instead of passing through it', () => {
    trace = createFlatWorldTrace([box(100, -512, 0, 200, 512, 200)]);
    run(200, { forwardmove: 127 });

    // Player half-width is 15, so the box's near face stops the origin at x = 85.
    expect(state.origin.x).toBeLessThan(85.1);
    expect(state.origin.x).toBeGreaterThan(80);
  });

  it('slides along a wall met at an angle rather than stopping dead', () => {
    trace = createFlatWorldTrace([box(100, -512, 0, 200, 512, 200)]);
    run(200, { forwardmove: 127, angles: vec3(0, 30, 0) });

    expect(state.origin.y).toBeGreaterThan(50);
    expect(horizontalSpeed()).toBeGreaterThan(100);
  });

  it('does not tunnel through a thin wall at high speed', () => {
    // A 4-unit wall against a 320 ups run: at 8 ms a tick the player covers 2.56 units, but
    // the swept trace must catch it regardless.
    trace = createFlatWorldTrace([box(300, -512, 0, 304, 512, 200)]);
    run(300, { forwardmove: 127 });

    expect(state.origin.x).toBeLessThan(300);
  });

  it('steps up onto a ledge within the step height', () => {
    trace = createFlatWorldTrace([box(100, -512, 0, 600, 512, STEPSIZE)]);
    run(100, { forwardmove: 127 });

    expect(state.origin.x).toBeGreaterThan(150);
    expect(state.origin.z).toBeCloseTo(GROUND_Z + STEPSIZE, 0);
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(true);
  });

  it('is blocked by a ledge taller than the step height', () => {
    trace = createFlatWorldTrace([box(100, -512, 0, 600, 512, STEPSIZE + 8)]);
    run(100, { forwardmove: 127 });

    expect(state.origin.x).toBeLessThan(85.1);
  });

  it('keeps its speed climbing a staircase', () => {
    const stairs = Array.from({ length: 10 }, (_, i) =>
      box(100 + i * 32, -512, 0, 600, 512, (i + 1) * 12)
    );
    trace = createFlatWorldTrace(stairs);
    run(125, { forwardmove: 127 });
    const speedOnFlat = horizontalSpeed();
    run(60, { forwardmove: 127 });

    expect(state.origin.z).toBeGreaterThan(GROUND_Z + 24);
    expect(horizontalSpeed()).toBeGreaterThan(speedOnFlat * 0.8);
  });
});

describe('tick model', () => {
  it('chops a long command into fixed ticks', () => {
    const cmd = createUserCmd({ serverTime: 1000, forwardmove: 127 });
    pmove(state, cmd, trace);

    expect(state.commandTime).toBe(1000);
    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);
  });

  it('ignores commands from the past', () => {
    run(10, { forwardmove: 127 });
    const origin = { ...state.origin };

    pmove(state, createUserCmd({ serverTime: 0, forwardmove: 127 }), trace);
    expect(state.origin).toEqual(origin);
  });

  it('discards more than a second of backlog rather than simulating it', () => {
    pmove(state, createUserCmd({ serverTime: 60_000 }), trace);
    expect(state.commandTime).toBe(60_000);
  });

  it('produces the same result whether time arrives in one command or many', () => {
    const chunked = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    for (let i = 0; i < 25; i++) {
      pmove(
        chunked,
        createUserCmd({ serverTime: (i + 1) * PMOVE_MSEC, forwardmove: 127 }),
        trace
      );
    }

    const single = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    pmove(single, createUserCmd({ serverTime: 25 * PMOVE_MSEC, forwardmove: 127 }), trace);

    expect(single.origin).toEqual(chunked.origin);
    expect(single.velocity).toEqual(chunked.velocity);
  });
});

describe("the move's traces", () => {
  /** A player standing on flat ground in slot 3, and a trace that remembers what it was asked. */
  function standingIn(slot = 3) {
    const { trace, asked } = recordingTrace(createFlatWorldTrace());
    const state = createIdlePlayerState({ origin: vec3(0, 0, 24.125), clientNum: slot });
    return { trace, asked, state };
  }

  it('pass the player and stop at MASK_PLAYERSOLID when the caller names no mask', () => {
    const { trace, asked, state } = standingIn();

    pmove(state, createUserCmd({ serverTime: PMOVE_MSEC, forwardmove: 127 }), trace);

    expect(distinctAsks(asked)).toEqual([{ passEntityNum: 3, contentmask: MASK.PLAYERSOLID }]);
  });

  it("stop at the caller's mask, less the living once the player is dead", () => {
    const { trace, asked, state } = standingIn();
    const botMask = MASK.PLAYERSOLID | CONTENTS.BOTCLIP;

    pmove(state, createUserCmd({ serverTime: PMOVE_MSEC }), trace, { tracemask: botMask });
    expect(distinctAsks(asked)).toEqual([{ passEntityNum: 3, contentmask: botMask }]);

    asked.length = 0;
    state.stats[STAT.HEALTH] = 0;
    state.pmType = PM_DEAD;
    pmove(state, createUserCmd({ serverTime: 2 * PMOVE_MSEC }), trace, { tracemask: botMask });
    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: 3, contentmask: botMask & ~CONTENTS.BODY }
    ]);
  });

  it('stand the player on whatever the ground trace says it hit', () => {
    const { state } = standingIn();
    const flat = createFlatWorldTrace();
    const onSeven: TraceFn = (...args) => {
      const result = flat(...args);
      return result.fraction < 1 ? { ...result, entityNum: 7 } : result;
    };

    pmove(state, createUserCmd({ serverTime: PMOVE_MSEC }), onSeven);

    expect(state.groundEntityNum).toBe(7);
  });
});

describe('the move clock', () => {
  it('counts a frame per command, and wraps at 64', () => {
    // `pmove_framecount` is six bits (`PS_PMOVEFRAMECOUNTBITS`), and the jump pad's "is this the
    // same pad as last frame" is what it is for.
    expect(state.pmoveFramecount).toBe(0);

    run(1);
    expect(state.pmoveFramecount).toBe(1);

    // 32 is still inside six bits and outside five, so this is the width itself.
    state.pmoveFramecount = 32;
    run(1);
    expect(state.pmoveFramecount).toBe(33);

    state.pmoveFramecount = 63;
    run(1);
    expect(state.pmoveFramecount).toBe(0);
  });

  it('counts a chopped command once, not once per slice', () => {
    // A command longer than the tick is chopped into slices, but it is still one move
    // (`Pmove`, bg_pmove.c:2038).
    pmove(state, createUserCmd({ serverTime: 25 * PMOVE_MSEC, forwardmove: 127 }), trace);

    expect(state.pmoveFramecount).toBe(1);
  });
});

describe("the move's touch list", () => {
  /**
   * The flat world, its floor named `floor` and anything else it stops at named `wall`, as a
   * brush model's trace names the entity.
   */
  function naming(floor: number, wall: number, extras = [box(20, -64, 0, 40, 64, 128)]): TraceFn {
    const world = createFlatWorldTrace(extras);
    return (...args) => {
      const result = world(...args);
      if (result.fraction === 1) return result;
      return { ...result, entityNum: result.normal.z > 0.7 ? floor : wall };
    };
  }

  it('touches what it stands on and what it runs into, each once, in the order met', () => {
    const cmd = createUserCmd({ serverTime: PMOVE_MSEC, forwardmove: 127 });
    state.velocity = vec3(320, 0, 0);
    // Its box's front 2 short of the wall, which this slice's 2.56 reaches.
    state.origin = vec3(3, 0, GROUND_Z);
    expect(pmove(state, cmd, naming(100, 200)).touchents).toEqual([100, 200]);
  });

  it('never touches the world', () => {
    const cmd = createUserCmd({ serverTime: PMOVE_MSEC, forwardmove: 127 });
    state.velocity = vec3(320, 0, 0);
    // Its box's front 2 short of the wall, which this slice's 2.56 reaches.
    state.origin = vec3(3, 0, GROUND_Z);
    const world = createFlatWorldTrace([box(20, -64, 0, 40, 64, 128)]);
    expect(pmove(state, cmd, world).touchents).toEqual([]);
  });

  it("hands back the last slice's touches alone", () => {
    // Each hit named afresh, so the first slice's ground is a number the last slice never meets.
    const flat = createFlatWorldTrace();
    let hits = 0;
    const fresh: TraceFn = (...args) => {
      const result = flat(...args);
      return result.fraction < 1 ? { ...result, entityNum: 100 + hits++ } : result;
    };
    const { touchents } = pmove(state, createUserCmd({ serverTime: 2 * PMOVE_MSEC }), fresh);
    expect(touchents.length).toBeGreaterThan(0);
    expect(touchents).not.toContain(100);
  });

  it('holds 32 at most', () => {
    class Probe extends Pmove {
      fill(numbers: number[]): number[] {
        for (const number of numbers) this.addTouchEnt(number);
        return this.touchents;
      }
    }
    const probe = new Probe(state, createUserCmd(), trace);
    const numbers = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(probe.fill([7, 7, ENTITYNUM_WORLD, ...numbers])).toEqual([7, ...numbers.slice(0, 31)]);
    expect(MAXTOUCH).toBe(32);
  });
});
