import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { box, createFlatWorldTrace } from './box-world';
import { BOB_MOVE_RUN, PMOVE_MSEC } from './constants';
import { EV, eventsSince } from './events';
import { pmove, type PmoveOptions } from './pmove';
import { createIdlePlayerState, createUserCmd, type TraceFn, type UserCmd } from './types';
import { vec3 } from './vec3';

/**
 * The simulation's output to the view layer: step, landing and footstep events, and the walk
 * cycle. Nothing here changes how the player moves — it is what the camera-feel layer needs
 * in order to smooth what the movement does abruptly.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

/** Full forward input. */
const FORWARD = { forwardmove: 127 };

/**
 * `PM_CrashLand` scores an impact as `v * v * 0.0001`, and a fall from `d` units reaches
 * `v = sqrt(2 * g * d)`, so the score is `2 * g * 0.0001 * d`.
 *
 * `g` here is **750, not the configured 800**: the integer velocity snap rounds each tick's
 * 6.4 ups of gravity down to 6, which is the same mechanism that makes the jump apex 48.53
 * rather than 45.56. Falls therefore score 6% under the textbook figure, putting
 * the severity bands (7 / 40 / 60) at 47, 267 and 400 units of fall rather than 44, 250, 375.
 */
const SCORE_PER_UNIT_FALLEN = 0.15;

let state: PlayerState;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
});

/** The landings, by the name this file grades them with. */
const LANDINGS: Record<number, string> = {
  [EV.FALL_SHORT]: 'short',
  [EV.FALL_MEDIUM]: 'medium',
  [EV.FALL_FAR]: 'far',
  [EV.FOOTSTEP]: 'footstep'
};

/**
 * Advance the simulation, collecting the events each tick left in the ring.
 *
 * The move raises no event that carries an argument, so what comes back is the event numbers
 * alone.
 *
 * @param trace - World to move through.
 * @param ticks - Number of {@link PMOVE_MSEC} ticks to run.
 * @param input - Input held for every tick.
 * @param options - The move's options.
 */
function run(
  trace: TraceFn,
  ticks: number,
  input: Partial<UserCmd> = {},
  options: PmoveOptions = {}
): number[] {
  const events: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const cmd = createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC });
    const before = state.eventSequence;
    pmove(state, cmd, trace, options);
    events.push(...eventsSince(state, before).map(({ event }) => event));
  }
  return events;
}

/**
 * Drop the player and report how the landing was scored.
 *
 * @param height - Height above the floor to start the fall from.
 * @param input - Input held during the fall, e.g. a held crouch.
 */
function fallFrom(height: number, input: Partial<UserCmd> = {}): number[] {
  const trace = createFlatWorldTrace();
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + height) });
  return run(trace, 200, input).filter((event) => event in LANDINGS);
}

/**
 * How hard a fall from `height` was felt: a severity; `'footstep'` if it scored under 7, which
 * Q3 does not treat as a fall; or `'none'` if it scored under 1, which Q3 does not hear at all.
 *
 * @param height - Height above the floor to start the fall from.
 * @param input - Input held during the fall, e.g. a held crouch.
 */
function landingFrom(height: number, input: Partial<UserCmd> = {}): string {
  const landing = fallFrom(height, input)[0];
  return landing === undefined ? 'none' : LANDINGS[landing];
}

describe('step events', () => {
  /**
   * @param height - Height of the step to walk into.
   */
  function stepUp(height: number): number[] {
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    const trace = createFlatWorldTrace([box(64, -256, 0, 4096, 256, height)]);
    return run(trace, 60, FORWARD).filter((event) => event >= EV.STEP_4 && event <= EV.STEP_16);
  }

  it('reports a step when the move climbs one', () => {
    const steps = stepUp(16);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('reports nothing on flat ground', () => {
    const trace = createFlatWorldTrace();
    expect(
      run(trace, 60, FORWARD).filter((event) => event >= EV.STEP_4 && event <= EV.STEP_16)
    ).toHaveLength(0);
  });

  it('bands the height to Q3s nearest step event (thresholds 7/11/15)', () => {
    // bg_slidemove.c PM_StepSlideMove: delta < 7 -> 4, < 11 -> 8, < 15 -> 12, else 16 — banded
    // to the nearest event, NOT rounded up. A 16-unit stair reports 16 (the glide cancels it);
    // off-band rises keep a small residual, as in Q3. (Deltas are ~0.125 below the box height
    // from the trace backoff, so these values sit clear of the thresholds.)
    expect(stepUp(3)[0]).toBe(EV.STEP_4);
    expect(stepUp(6)[0]).toBe(EV.STEP_4);
    expect(stepUp(8)[0]).toBe(EV.STEP_8);
    expect(stepUp(10)[0]).toBe(EV.STEP_8);
    expect(stepUp(12)[0]).toBe(EV.STEP_12);
    expect(stepUp(12.8)[0]).toBe(EV.STEP_12); // the test room's stair rise
    expect(stepUp(16)[0]).toBe(EV.STEP_16);
  });

  it('never reports more than the largest band, even for a full 18-unit step', () => {
    expect(stepUp(18)[0]).toBe(EV.STEP_16);
  });

  it('ignores a rise too small to be worth smoothing', () => {
    expect(stepUp(1)).toHaveLength(0);
  });
});

describe('landing events', () => {
  it('treats a short drop as a footstep rather than a landing', () => {
    // Below the 43.75-unit threshold the impact scores under 7 and Q3 plays a footstep.
    const events = fallFrom(24);
    expect(events).toContain(EV.FOOTSTEP);
    expect(events.filter((event) => event !== EV.FOOTSTEP)).toHaveLength(0);
  });

  it('raises nothing for a landing that scores under 1', () => {
    // `PM_CrashLand` returns before any event (bg_pmove.c:975–977). A score of 1 is a fall of
    // about 6.7 units; this straddles it by 2.
    const edge = 1 / SCORE_PER_UNIT_FALLEN;
    expect(landingFrom(edge - 2)).toBe('none');
    expect(landingFrom(edge + 2)).toBe('footstep');
  });

  it('raises nothing for a player spawned on the floor', () => {
    // The first ground trace lands them at no speed at all, which scores 0.
    const events = run(createFlatWorldTrace(), 1);
    expect(events.filter((event) => event in LANDINGS)).toHaveLength(0);
  });

  it('grades the landing by impact speed', () => {
    expect(landingFrom(100)).toBe('short');
    expect(landingFrom(300)).toBe('medium');
    expect(landingFrom(450)).toBe('far');
  });

  it('puts the severity bands where the velocity snap leaves them', () => {
    // Pins both the quadratic that recovers the impact speed — the tick that lands has
    // already clipped the velocity, so it is reconstructed rather than read — and the
    // effective gravity the snap produces. Straddles each band edge by 20 units.
    const edge = (score: number) => score / SCORE_PER_UNIT_FALLEN;

    expect(landingFrom(edge(7) - 20)).toBe('footstep');
    expect(landingFrom(edge(7) + 20)).toBe('short');
    expect(landingFrom(edge(40) - 20)).toBe('short');
    expect(landingFrom(edge(40) + 20)).toBe('medium');
    expect(landingFrom(edge(60) - 20)).toBe('medium');
    expect(landingFrom(edge(60) + 20)).toBe('far');
  });

  it('doubles the score when landing crouched', () => {
    // 250 units alone scores 37.5 — a short landing. Ducked it scores 75, the worst band.
    expect(landingFrom(250)).toBe('short');
    expect(landingFrom(250, { upmove: -127 })).toBe('far');
  });

  it('reports the landing once, not once per tick spent on the ground', () => {
    expect(fallFrom(100).filter((event) => event !== EV.FOOTSTEP)).toHaveLength(1);
  });
});

describe('walk cycle', () => {
  const trace = createFlatWorldTrace();

  it('advances while running', () => {
    run(trace, 10, FORWARD);
    expect(state.bobCycle).toBeGreaterThan(0);
  });

  it('advances at the running rate', () => {
    run(trace, 1, FORWARD);
    // Truncated to an integer every tick, exactly as the C does with its int cast.
    expect(state.bobCycle).toBe(Math.trunc(BOB_MOVE_RUN * PMOVE_MSEC));
  });

  it('wraps rather than growing without bound', () => {
    run(trace, 500, FORWARD);
    expect(state.bobCycle).toBeGreaterThanOrEqual(0);
    expect(state.bobCycle).toBeLessThanOrEqual(255);
  });

  it('freezes in mid-stride while airborne', () => {
    run(trace, 20, FORWARD);
    const airborne = { ...FORWARD, upmove: 127 };
    run(trace, 4, airborne);
    const midJump = state.bobCycle;

    run(trace, 10, airborne);
    expect(state.groundEntityNum !== ENTITYNUM_NONE).toBe(false);
    expect(state.bobCycle).toBe(midJump);
  });

  /** One tick's advance of the cycle while running. */
  const BOB_STEP = Math.trunc(BOB_MOVE_RUN * PMOVE_MSEC);

  it('starts the stride over on a landing that counts', () => {
    run(trace, 20, FORWARD);
    run(trace, 1, { ...FORWARD, upmove: 127 });
    const midJump = state.bobCycle;
    for (let i = 0; i < 100 && state.groundEntityNum === ENTITYNUM_NONE; i++) run(trace, 1, FORWARD);

    // `PM_CrashLand` zeroes the cycle (bg_pmove.c:998–999), and the same tick's
    // `PM_Footsteps` advances it once.
    expect(midJump).toBeGreaterThan(BOB_STEP);
    expect(state.bobCycle).toBe(BOB_STEP);
  });

  it('keeps the stride through a landing too soft to count', () => {
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 3) });
    state.bobCycle = 100;
    for (let i = 0; i < 100 && state.groundEntityNum === ENTITYNUM_NONE; i++) run(trace, 1, FORWARD);
    expect(state.bobCycle).toBe(100 + BOB_STEP);
  });

  it('resets to the start of the stride once stopped', () => {
    run(trace, 40, FORWARD);
    expect(state.bobCycle).not.toBe(0);

    run(trace, 100);
    expect(state.bobCycle).toBe(0);
  });

  it('raises a footstep on each half of the stride', () => {
    // 250 ticks is two seconds of running: several strides, and none of them silent.
    const footsteps = run(trace, 250, FORWARD).filter((event) => event === EV.FOOTSTEP);
    expect(footsteps.length).toBeGreaterThan(2);
  });

  it("raises none under noFootsteps, though a short landing still raises its own", () => {
    const quiet = { noFootsteps: true };
    const stride = state.bobCycle;
    expect(run(trace, 250, FORWARD, quiet)).not.toContain(EV.FOOTSTEP);
    // The stride runs on, silently.
    expect(state.bobCycle).not.toBe(stride);

    // `PM_CrashLand` asks nothing of the flag (`bg_pmove.c:994–995`).
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 24) });
    expect(run(trace, 200, {}, quiet)).toContain(EV.FOOTSTEP);
  });
});

describe('event ordering', () => {
  it('returns events in the order the ticks raised them', () => {
    const trace = createFlatWorldTrace([box(128, -256, 0, 4096, 256, 16)]);
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 200) });

    // Dropped with no input, so the fall lands on the floor rather than air-steering onto
    // the step, and only then walked into it.
    const events = [...run(trace, 120), ...run(trace, 150, FORWARD)];
    const fallIndex = events.findIndex((event) => event in LANDINGS && event !== EV.FOOTSTEP);
    const stepIndex = events.findIndex((event) => event >= EV.STEP_4 && event <= EV.STEP_16);

    expect(fallIndex).toBeGreaterThanOrEqual(0);
    expect(stepIndex).toBeGreaterThan(fallIndex);
  });
});
