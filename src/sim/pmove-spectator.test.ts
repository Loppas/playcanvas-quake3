import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { createFlatWorldTrace } from './box-world';
import {
  BUTTON_ATTACK,
  CROUCH_VIEWHEIGHT,
  MINS_Z,
  PM_DEAD,
  PM_FREEZE,
  PM_INTERMISSION,
  PM_SPECTATOR,
  PMF_TIME_KNOCKBACK,
  PMOVE_MSEC,
  STAT
} from './constants';
import { EV, eventsSince } from './events';
import { PW } from './items';
import { pmove } from './pmove';
import {
  createArmedPlayerState,
  createIdlePlayerState,
  createUserCmd,
  type TraceFn,
  type UserCmd
} from './types';
import { vec3 } from './vec3';

/**
 * The spectator's move, and the two move types that do not move: `PmoveSingle`'s dispatch
 * (`bg_pmove.c:1933–1952`), `PM_Friction`'s spectator term (`:46, 215–217`) and
 * `PM_UpdateViewAngles`' spectator exception (`:1800–1806`).
 *
 * A spectator makes the flight powerup's move — `PM_CheckDuck`, `PM_FlyMove`, `PM_DropTimers` and
 * nothing else — so what this file pins is the friction, the box, the view angles and what is
 * *not* run. The fly move's own arithmetic is `pmove-flight.test.ts`'s.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

/** What `SpectatorThink` sets a spectator's speed to (`g_active.c:332`). */
const SPECTATOR_SPEED = 400;

let state: PlayerState;
let trace: TraceFn;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
  state.pmType = PM_SPECTATOR;
  state.speed = SPECTATOR_SPEED;
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

describe('a free spectator', () => {
  it('flies rather than stands: no gravity, and the floor is never underfoot', () => {
    run(125);

    expect(state.origin).toEqual(vec3(0, 0, GROUND_Z));
    expect(state.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('climbs on the jump key at its own speed, which is faster than a player runs', () => {
    run(125, { upmove: 127 });

    expect(state.velocity.z).toBe(SPECTATOR_SPEED);
  });

  it("slows on its own friction term, heavier than the flight powerup's", () => {
    state.velocity = vec3(300, 0, 0);

    run(1);

    // `PM_Friction`: drop = speed × pm_spectatorfriction × frametime, and nothing else applies,
    // since no ground trace runs for a spectator. 300 × (1 − 5 × 0.008) = 288.
    expect(state.velocity.x).toBeCloseTo(288, 6);

    // The same coast under the flight powerup loses 3 rather than 5: 300 × (1 − 3 × 0.008) =
    // 292.8, which its move then snaps to a whole number on the way out.
    const flying = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 500) });
    flying.powerups[PW.FLIGHT] = 1;
    flying.velocity = vec3(300, 0, 0);
    pmove(flying, createUserCmd({ serverTime: PMOVE_MSEC }), trace);
    expect(flying.velocity.x).toBe(293);
  });

  it("keeps its velocity unsnapped, where a flying player's coast stalls on the rounding", () => {
    state.velocity = vec3(10.5, 0, 0);

    run(1);

    expect(state.velocity.x).toBeCloseTo(10.08, 6);
  });

  it('ducks its box on the crouch key, since `PM_CheckDuck` runs in the spectator branch', () => {
    run(1, { upmove: -127 });

    expect(state.viewheight).toBe(CROUCH_VIEWHEIGHT);
  });

  it('drops its timers, so a window left open by the body it had still closes', () => {
    state.pmFlags |= PMF_TIME_KNOCKBACK;
    state.pmTime = 100;

    run(5);

    expect(state.pmTime).toBe(60);
  });

  it('runs no weapon code, so holding attack fires nothing', () => {
    state = createArmedPlayerState({ origin: vec3(0, 0, GROUND_Z) });
    state.pmType = PM_SPECTATOR;
    state.speed = SPECTATOR_SPEED;

    run(10, { buttons: BUTTON_ATTACK });

    expect(eventsSince(state, 0).map(({ event }) => event)).not.toContain(EV.FIRE_WEAPON);
  });

  it("turns although its last body died, which is the health test's own exception", () => {
    state.stats[STAT.HEALTH] = 0;

    run(1, { angles: vec3(10, 45, 0) });

    expect(state.viewangles).toEqual(vec3(10, 45, 0));
  });
});

describe('a frozen client', () => {
  beforeEach(() => {
    state.pmType = PM_FREEZE;
    state.velocity = vec3(300, 0, 0);
  });

  it('does not move at all, whatever is held', () => {
    const origin = { ...state.origin };

    run(10, { forwardmove: 127, upmove: 127 });

    expect(state.origin).toEqual(origin);
    expect(state.velocity).toEqual(vec3(300, 0, 0));
  });

  it("still turns: a follower's own angles are its own until the view is copied over it", () => {
    run(1, { angles: vec3(-20, 90, 0) });

    expect(state.viewangles).toEqual(vec3(-20, 90, 0));
  });
});

describe('a client at the intermission', () => {
  beforeEach(() => {
    state.pmType = PM_INTERMISSION;
  });

  it('does not move, and is not even measured against the floor it is standing over', () => {
    const origin = { ...state.origin };

    run(10, { forwardmove: 127 });

    expect(state.origin).toEqual(origin);
    expect(state.velocity).toEqual(vec3());
    // The move returns before the ground trace, so nothing underfoot is ever found — which is
    // the whole difference between this and a live player whose input happens to be zeroed.
    expect(state.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('does not turn either: the camera holds the view it was given', () => {
    state.viewangles = vec3(0, 180, 0);

    run(1, { angles: vec3(30, 0, 0) });

    expect(state.viewangles).toEqual(vec3(0, 180, 0));
  });
});

describe('a corpse', () => {
  it('does not turn, where a spectator does', () => {
    state.pmType = PM_DEAD;
    state.stats[STAT.HEALTH] = 0;
    state.viewangles = vec3(0, 90, 0);

    run(1, { angles: vec3(10, 45, 0) });

    expect(state.viewangles).toEqual(vec3(0, 90, 0));
  });
});
