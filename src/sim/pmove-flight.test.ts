import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { createFlatWorldTrace } from './box-world';
import {
  DEFAULT_SPEED,
  MINS_Z,
  PMF_DUCKED,
  PMF_GRAPPLE_PULL,
  PMF_TIME_KNOCKBACK,
  PMOVE_MSEC
} from './constants';
import { EV, eventsSince } from './events';
import { PW } from './items';
import { pmove } from './pmove';
import { createIdlePlayerState, createUserCmd, type TraceFn, type UserCmd } from './types';
import { length, vec3 } from './vec3';

/**
 * The flight powerup's move: `PM_FlyMove` and its friction (`bg_pmove.c:211, 559–591, 1975–1977`).
 *
 * Golden values are the ideal-maths figures, allowing for the integer velocity snap, as
 * `pmove.test.ts` derives its own. Flight is chosen off the powerup, never the ground, so a
 * flying player over the floor never lands and never falls.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

/** High enough that the ground is never reached in a test's run. */
const AIR_Z = GROUND_Z + 500;

let state: PlayerState;
let trace: TraceFn;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, AIR_Z) });
  state.powerups[PW.FLIGHT] = 1;
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

describe('the fly move', () => {
  it('is chosen by the powerup, not the ground: a flying player hangs where they are', () => {
    run(125);

    expect(state.origin.z).toBe(AIR_Z);
    expect(state.velocity).toEqual(vec3());
    expect(state.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('climbs at the run speed and never falls, because the fly move integrates no gravity', () => {
    run(125, { upmove: 127 });

    // 270 is a jump; 320 is flying. The fly move does not call `PM_CheckJump`, so the button
    // is a direction rather than a leap.
    expect(state.velocity.z).toBe(DEFAULT_SPEED);
    expect(eventsSince(state, 0).map(({ event }) => event)).not.toContain(EV.JUMP);
  });

  it('accelerates at the fly rate, between the ground and the air', () => {
    run(1, { forwardmove: 127 });

    // 8 * 0.008 * 320 = 20.48, snapped to 20. The air rate would give 2.56 and the ground's
    // 25.6, so one tick from rest is the whole of which acceleration the fly move uses.
    expect(horizontalSpeed()).toBe(20);
  });

  it('reaches the run speed in the air, where only flight friction holds it back', () => {
    run(125, { forwardmove: 127 });

    // Friction 3 against accelerate 8: 0.024 of the speed is dropped a tick and up to 20.48
    // added, so once past 306.9 the accelerate closes the whole gap to the wish speed of 320.
    expect(horizontalSpeed()).toBe(DEFAULT_SPEED);
    expect(state.origin.z).toBe(AIR_Z);
  });

  it('decays by the flight friction alone in the air', () => {
    state.velocity = vec3(DEFAULT_SPEED, 0, 0);
    run(1);

    // 320 − 320 * 3 * 0.008 = 312.32, snapped to an integer. Without the powerup the air move
    // removes nothing and this would still read 320.
    expect(state.velocity.x).toBe(312);
  });

  it('adds the flight friction to the ground friction underfoot', () => {
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    state.powerups[PW.FLIGHT] = 1;
    state.velocity = vec3(DEFAULT_SPEED, 0, 0);
    run(1);

    // Both terms: 320 * (1 − (6 + 3) * 0.008) = 296.96, snapped. Without flight the walk move
    // leaves 304.64, which the ground tests pin at 305.
    expect(state.velocity.x).toBe(297);
  });

  it('keeps the flight friction through a knockback window, where the ground term is suspended', () => {
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    state.powerups[PW.FLIGHT] = 1;
    state.pmFlags |= PMF_TIME_KNOCKBACK;
    state.pmTime = 100;
    state.velocity = vec3(DEFAULT_SPEED, 0, 0);
    run(1);

    // 320 − 320 * 3 * 0.008, as in the air: `PM_Friction` skips the ground term under
    // knockback but never the flight one.
    expect(state.velocity.x).toBe(312);
  });

  it('is steered in three dimensions: the view points the way', () => {
    // The pitch clamp stops at 87.890625°, so "straight up" is a hair off vertical.
    run(125, { forwardmove: 127, angles: vec3(-87.890625, 0, 0) });

    expect(state.velocity.z).toBe(DEFAULT_SPEED);
    expect(horizontalSpeed()).toBeLessThan(20);
  });

  it('is not slowed by crouching, because the fly move never scales the wish speed', () => {
    run(125, { forwardmove: 127, upmove: -127 });

    // A ducked walker is capped at 80 ups (`PM_DUCK_SCALE`); a ducked flyer is not. The
    // downward input is part of the direction, so the speed is the full 320 on the diagonal —
    // 319.6 after the integer snap.
    expect(state.pmFlags & PMF_DUCKED).toBeTruthy();
    expect(length(state.velocity)).toBeCloseTo(DEFAULT_SPEED, 0);
  });

  it('flies faster under haste, which scales the wish speed', () => {
    state.speed = 480;
    run(125, { forwardmove: 127 });

    expect(horizontalSpeed()).toBe(480);
    expect(state.origin.z).toBe(AIR_Z);
  });

  it('stops dead below one unit per second, as every friction does', () => {
    state.velocity = vec3(0.5, 0, 0);
    run(1);

    expect(state.velocity).toEqual(vec3());
  });

  it('wins over the grapple, whose pull is not run at all', () => {
    // `PmoveSingle` checks the powerup before the pull (`bg_pmove.c:1975–1978`): a flying
    // player's hook is not what moves them.
    state.pmFlags |= PMF_GRAPPLE_PULL;
    state.grapplePoint = vec3(1000, 0, AIR_Z);
    run(1);

    expect(state.velocity).toEqual(vec3());
  });
});
