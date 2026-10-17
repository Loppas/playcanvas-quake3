import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { box, createFlatWorldTrace } from './box-world';
import {
  BUTTON_ATTACK,
  BUTTON_TALK,
  BUTTON_USE_HOLDABLE,
  EF_FIRING,
  MINS_Z,
  OVERCLIP,
  PM_DEAD,
  PMF_CROUCH_SLIDE,
  PMF_DUCKED,
  PMF_GRAPPLE_PULL,
  PMF_RESPAWNED,
  PMF_TIME_KNOCKBACK,
  PMOVE_MSEC,
  STAT
} from './constants';
import { EV, eventNumber, eventsSince, isStepEvent, type Event } from './events';
import { PW } from './items';
import { pmove } from './pmove';
import { CpmaPmove } from './pmove-cpma';
import { clipVelocity } from './pmove-math';
import type { Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { createIdlePlayerState, createUserCmd, type TraceFn, type UserCmd } from './types';
import { length, vec3, type Vec3 } from './vec3';
import { WEAPON_DROPPING, WP } from './weapons/constants';

/**
 * CPMA's move, run with each ruleset's shipped preset. The goldens are measured here and held to
 * CPMA's arithmetic: with no snap, a jump's arc and a fall's impact are exact, so `v² / 2g` is
 * the answer to the last digit the tick allows.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

const VQ3 = presetRules('vq3');
const PMC = presetRules('pmc');
const CPM = presetRules('cpm');
const CQ3 = presetRules('cq3');
const DEV = presetRules('dev');

let state: PlayerState;
let trace: TraceFn;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
  trace = createFlatWorldTrace();
});

/**
 * Run ticks of {@link PMOVE_MSEC} of CPMA's move under `rules`.
 *
 * @returns The events the ticks raised.
 */
function run(rules: Rules, ticks: number, input: Partial<UserCmd> = {}): number[] {
  const since = state.eventSequence;
  for (let i = 0; i < ticks; i++) {
    const cmd = createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC });
    pmove(state, cmd, trace, { core: CpmaPmove, rules });
  }
  return eventsSince(state, since).map(({ event }) => eventNumber(event));
}

/** Run ticks until the player is on the ground, and return the highest their feet went. */
function apex(rules: Rules): number {
  let highest = state.origin.z;
  for (let i = 0; i < 500 && state.groundEntityNum === ENTITYNUM_NONE; i++) {
    run(rules, 1);
    highest = Math.max(highest, state.origin.z);
  }
  return highest - GROUND_Z;
}

/** Put the player in the air at `height` above the floor, moving at `velocity`. */
function airborne(height: number, velocity: Vec3 = vec3()): void {
  state.origin = vec3(0, 0, GROUND_Z + height);
  state.velocity = velocity;
  state.groundEntityNum = ENTITYNUM_NONE;
}

const horizontalSpeed = () => Math.hypot(state.velocity.x, state.velocity.y);

/** CPMA's move with its steps in reach. */
class Probe extends CpmaPmove {
  step(gravity = false) {
    this.frametime = PMOVE_MSEC / 1000;
    this.stepSlideMove(gravity);
  }
  clip(normal: Vec3) {
    this.clipToGround(normal);
  }
  rise() {
    return this.stepRise;
  }
}

/** A probe over the player state, the world and `rules`. */
function probe(rules: Rules): Probe {
  return new Probe(state, createUserCmd({ serverTime: state.commandTime + PMOVE_MSEC }), trace, {
    rules
  });
}

describe('the jump', () => {
  it("leaves at 275 and keeps the fraction, and peaks at 275² / 2g under CPM", () => {
    run(CPM, 1, { upmove: 127 });
    expect(state.velocity.z).toBeCloseTo(275 - 800 * 0.008, 10);
    expect(apex(CPM)).toBeCloseTo(275 ** 2 / (2 * 800), 2);
  });

  it('chains off one inside the window: 380, peaking at 90.25', () => {
    state.stats[STAT.JUMP_TIME] = 200;
    run(CPM, 1, { upmove: 127 });

    expect(state.velocity.z).toBeCloseTo(380 - 6.4, 10);
    expect(state.stats[STAT.CHAIN_JUMPED]).toBe(1);
    expect(state.stats[STAT.JUMP_TIME]).toBe(400);
    expect(apex(CPM)).toBeCloseTo(90.25, 1);
  });

  it('opens no window and chains nothing under VQ3', () => {
    state.stats[STAT.JUMP_TIME] = 200;
    run(VQ3, 1, { upmove: 127 });
    expect(state.velocity.z).toBe(264);
    expect(state.stats[STAT.CHAIN_JUMPED]).toBe(0);
    expect(state.stats[STAT.JUMP_TIME]).toBe(192);
  });

  it('opens the window for the step jump alone, and chains nothing', () => {
    state.stats[STAT.JUMP_TIME] = 200;
    run({ ...VQ3, pmove_StepJump: 1 }, 1, { upmove: 127 });
    expect(state.velocity.z).toBe(264);
    expect(state.stats[STAT.JUMP_TIME]).toBe(400);
    expect(state.stats[STAT.CHAIN_JUMPED]).toBe(0);
  });

  it("adds CQ3's late 45 with 180 ms of the window left, and 105 with more", () => {
    state.stats[STAT.JUMP_TIME] = 188;
    run(CQ3, 1, { upmove: 127 });
    expect(state.velocity.z).toBeCloseTo(275 + 45 - 6.4, 10);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    state.stats[STAT.JUMP_TIME] = 189;
    run(CQ3, 1, { upmove: 127 });
    expect(state.velocity.z).toBeCloseTo(275 + 105 - 6.4, 10);
  });

  it('adds the rise to a jump taken while rising', () => {
    // Any faster than 10 away from the floor and the ground trace has the player leave it.
    run(CPM, 2);
    state.velocity = vec3(0, 0, 8);
    run(CPM, 1, { upmove: 127 });
    expect(state.velocity.z).toBeCloseTo(275 + 8 - 6.4, 10);
  });

  it('runs the window down, and takes the mark off a move after it closes', () => {
    state.stats[STAT.JUMP_TIME] = 8;
    state.stats[STAT.CHAIN_JUMPED] = 1;

    run(CPM, 1);
    expect(state.stats[STAT.JUMP_TIME]).toBe(0);
    expect(state.stats[STAT.CHAIN_JUMPED]).toBe(1);

    run(CPM, 1);
    expect(state.stats[STAT.JUMP_TIME]).toBe(0);
    expect(state.stats[STAT.CHAIN_JUMPED]).toBe(0);
  });

  it("steps onto a 40-unit ledge while rising, in time to chain the next jump off it", () => {
    trace = createFlatWorldTrace([box(40, -1000, 0, 1000, 1000, 40)]);

    // id's move cannot step up while rising with nothing underfoot, so it hangs on the face.
    state = createIdlePlayerState({ origin: vec3(-7, 0, GROUND_Z) });
    state.velocity = vec3(320, 0, 0);
    run(VQ3, 1, { forwardmove: 127, upmove: 127 });
    run(VQ3, 12, { forwardmove: 127 });
    expect(state.groundEntityNum).toBe(ENTITYNUM_NONE);

    state = createIdlePlayerState({ origin: vec3(-7, 0, GROUND_Z) });
    state.velocity = vec3(320, 0, 0);
    run(CPM, 1, { forwardmove: 127, upmove: 127 });
    run(CPM, 12, { forwardmove: 127 });
    expect(state.groundEntityNum).not.toBe(ENTITYNUM_NONE);
    expect(state.origin.z).toBeCloseTo(40 + GROUND_Z, 0);

    run(CPM, 1, { forwardmove: 127, upmove: 127 });
    expect(state.velocity.z).toBeCloseTo(380 - 6.4, 0);
    expect(state.stats[STAT.CHAIN_JUMPED]).toBe(1);
  });
});

describe('the landing', () => {
  /** The fall events of a drop from `height`, crouched or not. */
  function fall(rules: Rules, height: number, crouched = false): number[] {
    airborne(height);
    const events: number[] = [];
    for (let i = 0; i < 500 && (i === 0 || state.groundEntityNum === ENTITYNUM_NONE); i++) {
      events.push(...run(rules, 1, crouched ? { upmove: -127 } : {}));
    }
    return events.filter((event) => event >= EV.FALL_SHORT && event <= EV.FALL_FAR);
  }

  it('hurts from a drop over 262.5 under CPM, where the impact is exact: 0.16 × the height', () => {
    expect(fall(CPM, 260)).toEqual([EV.FALL_SHORT]);
    expect(fall(CPM, 265)).toEqual([EV.FALL_MEDIUM]);
  });

  it("does not double a crouched landing under CPM, as id's does", () => {
    expect(fall(VQ3, 150, true)).toEqual([EV.FALL_MEDIUM]);
    expect(fall(CPM, 150, true)).toEqual([EV.FALL_SHORT]);
  });
});

describe('the walk', () => {
  it("accelerates at 15 under CPM and 10.5 under CQ3, with no snap", () => {
    run(CPM, 1, { forwardmove: 127 });
    expect(state.velocity.x).toBeCloseTo(15 * 0.008 * 320, 10);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    run(CQ3, 1, { forwardmove: 127 });
    expect(state.velocity.x).toBeCloseTo(10.5 * 0.008 * 320, 10);
  });

  it('slows by 6 under CPM and 5.6 under CQ3', () => {
    run(CPM, 1);
    state.velocity = vec3(320, 0, 0);
    run(CPM, 1);
    expect(state.velocity.x).toBeCloseTo(320 - 320 * 6 * 0.008, 10);

    state.velocity = vec3(320, 0, 0);
    run(CQ3, 1);
    expect(state.velocity.x).toBeCloseTo(320 - 320 * 5.6 * 0.008, 10);
  });

  it("leaves a slope its share of the speed, where id's keeps it all", () => {
    const uphill = vec3(-0.6, 0, 0.8);
    state.velocity = vec3(320, 0, 0);
    probe(CPM).clip(uphill);
    expect(state.velocity).toEqual(clipVelocity(vec3(320, 0, 0), uphill, OVERCLIP));
    expect(length(state.velocity)).toBeLessThan(260);

    state.velocity = vec3(320, 0, 0);
    probe(VQ3).clip(uphill);
    expect(length(state.velocity)).toBeCloseTo(320, 10);
  });
});

describe('the air', () => {
  it('turns toward the view with forward alone under CPM', () => {
    const turn = (rules: Rules, forwardmove = 127): number => {
      airborne(500, vec3(320 * Math.sign(forwardmove), 0, 0));
      run(rules, 1, { forwardmove, angles: vec3(0, 45, 0) });
      const angle = (Math.atan2(state.velocity.y, state.velocity.x) * 180) / Math.PI;
      return forwardmove > 0 ? angle : angle + 180;
    };
    // k = 32 × 150 × cos²45° × 0.008 turns it 2.33°, and the accelerate adds 0.31°.
    expect(turn(CPM)).toBeCloseTo(2.64, 1);
    expect(turn(CPM, -127)).toBeCloseTo(2.64, 1);
    expect(turn({ ...CPM, pmove_AirControlStrength: 0 })).toBeCloseTo(0.32, 1);
    expect(turn(VQ3)).toBeLessThan(0.5);
  });

  it('strafes up to 30 at an accelerate of 70 under CPM', () => {
    airborne(500);
    run(CPM, 1, { rightmove: 127 });
    expect(horizontalSpeed()).toBeCloseTo(70 * 0.008 * 30, 10);
    run(CPM, 5, { rightmove: 127 });
    expect(horizontalSpeed()).toBeCloseTo(30, 10);
  });

  it('stops at an accelerate of 2.5 under CPM', () => {
    airborne(500, vec3(320, 0, 0));
    run(CPM, 1, { forwardmove: -127 });
    expect(state.velocity.x).toBeCloseTo(320 - 2.5 * 0.008 * 320, 10);
  });

  it("holds a flag carrier to 1.5 × the speed under CPM, dragging by the excess squared", () => {
    const carrying = (rules: Rules): number => {
      airborne(500, vec3(600, 0, 0));
      state.powerups[PW.REDFLAG] = 1;
      run(rules, 1);
      return state.velocity.x;
    };
    expect(carrying(CPM)).toBeCloseTo(600 * (1 - ((600 - 480) / 480) ** 2 * 0.008), 10);
    expect(carrying(PMC)).toBe(600);

    state = createIdlePlayerState();
    airborne(500, vec3(600, 0, 0));
    run(CPM, 1);
    expect(state.velocity.x).toBe(600);
  });
});

describe('the step-up', () => {
  it('needs the whole step clear above it under CPM', () => {
    // A step of 8 under a ceiling 70 up: 14 of room over a standing player, not 18.
    trace = createFlatWorldTrace([
      box(30, -1000, 0, 1000, 1000, 8),
      box(-1000, -1000, 70, 1000, 1000, 200)
    ]);
    const walk = (rules: Rules): number => {
      state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
      run(rules, 40, { forwardmove: 127 });
      return state.origin.x;
    };
    expect(walk(VQ3)).toBeGreaterThan(40);
    expect(walk(CPM)).toBeLessThan(16);
  });

  /** A box 40 high ahead, and the player against its face with their feet 25 up, rising. */
  function againstLedge(rise: number, jumpTime: number): void {
    trace = createFlatWorldTrace([box(30, -1000, 0, 1000, 1000, 40)]);
    state.origin = vec3(13, 0, GROUND_Z + 25);
    state.velocity = vec3(320, 0, rise);
    state.groundEntityNum = ENTITYNUM_NONE;
    state.stats[STAT.JUMP_TIME] = jumpTime;
  }

  it('takes a player still rising, inside the window and under 380', () => {
    againstLedge(300, 200);
    const stepper = probe(CPM);
    stepper.step();
    expect(state.origin.z).toBeCloseTo(40 + GROUND_Z, 0);
    expect(stepper.rise()).toBe(15);

    for (const [rise, jumpTime] of [
      [400, 200],
      [300, 0]
    ]) {
      state = createIdlePlayerState();
      againstLedge(rise, jumpTime);
      probe(CPM).step();
      expect(state.origin.z, `${rise} ${jumpTime}`).toBeLessThan(40 + GROUND_Z);
    }

    state = createIdlePlayerState();
    againstLedge(300, 200);
    probe(VQ3).step();
    expect(state.origin.z).toBeLessThan(40 + GROUND_Z);
  });

  it('leaves the fall alone as it settles after a chained jump', () => {
    againstLedge(300, 200);
    probe(CPM).step();
    expect(state.velocity.z).toBeLessThan(1);

    state = createIdlePlayerState();
    againstLedge(300, 200);
    state.stats[STAT.CHAIN_JUMPED] = 1;
    probe(CPM).step();
    expect(state.velocity.z).toBe(300);
  });

  it('is not taken while the grapple pulls under CPM', () => {
    trace = createFlatWorldTrace([box(30, -1000, 0, 1000, 1000, 16)]);
    const pulled = (rules: Rules): number => {
      state = createIdlePlayerState({ origin: vec3(13, 0, GROUND_Z) });
      state.velocity = vec3(320, 0, 0);
      state.pmFlags |= PMF_GRAPPLE_PULL;
      probe(rules).step();
      return state.origin.z;
    };
    expect(pulled(VQ3)).toBeCloseTo(16 + GROUND_Z, 0);
    expect(pulled(CPM)).toBe(GROUND_Z);
  });
});

describe("the step's rise", () => {
  /** Walk into a step `height` high, and return the step events the walk raised. */
  function stepUp(rules: Rules, height: number): Event[] {
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    trace = createFlatWorldTrace([box(64, -256, 0, 4096, 256, height)]);
    const steps: Event[] = [];
    for (let i = 0; i < 60; i++) {
      const since = state.eventSequence;
      run(rules, 1, { forwardmove: 127 });
      steps.push(...eventsSince(state, since).filter(({ event }) => isStepEvent(event)));
    }
    return steps;
  }

  it('is one event carrying the rise in whole units under CPM, where VQ3 bands it', () => {
    expect(stepUp(VQ3, 12.8)).toEqual([{ event: EV.STEP_12, parm: 0 }]);
    expect(stepUp(CPM, 12.8)).toEqual([{ event: EV.STEP, parm: 12 }]);
    expect(stepUp(VQ3, 17.5)).toEqual([{ event: EV.STEP_16, parm: 0 }]);
    expect(stepUp(CPM, 17.5)).toEqual([{ event: EV.STEP, parm: 17 }]);
    // Over 2, then cut to a whole number.
    expect(stepUp(CPM, 2.5)).toEqual([{ event: EV.STEP, parm: 2 }]);
    expect(stepUp(CPM, 1.5)).toEqual([]);
  });

  it("comes after the move's own events under CPM", () => {
    // Against a step 12 high, firing: the shot is raised after the step within id's move.
    const fireIntoStep = (rules: Rules): number[] => {
      state = createIdlePlayerState({ origin: vec3(48.8, 0, GROUND_Z) });
      state.velocity = vec3(320, 0, 0);
      state.weapon = WP.MACHINEGUN;
      state.stats[STAT.WEAPONS] = 1 << WP.MACHINEGUN;
      state.ammo[WP.MACHINEGUN] = 50;
      trace = createFlatWorldTrace([box(64, -256, 0, 4096, 256, 12)]);
      return run(rules, 1, { forwardmove: 127, buttons: BUTTON_ATTACK });
    };
    expect(fireIntoStep(VQ3)).toEqual([EV.STEP_12, EV.FIRE_WEAPON]);
    expect(fireIntoStep(CPM)).toEqual([EV.FIRE_WEAPON, EV.STEP]);
  });

  it('is raised only for a step-up that settles onto something', () => {
    // Rising 5 up against a wall 2 thick and 15 high: fast enough, the raised move carries the
    // player past the wall, and the settle finds nothing under them.
    const overWall = (rules: Rules, speed: number): Probe => {
      state = createIdlePlayerState({ origin: vec3(14.8, 0, GROUND_Z + 5) });
      state.velocity = vec3(speed, 0, 300);
      state.groundEntityNum = ENTITYNUM_NONE;
      trace = createFlatWorldTrace([box(30, -1000, 0, 32, 1000, 15)]);
      const stepper = probe(rules);
      stepper.step();
      return stepper;
    };
    expect(overWall(CPM, 320).rise()).toBe(10);
    expect(overWall(CPM, 5000).rise()).toBe(0);
    expect(state.origin.z).toBeCloseTo(GROUND_Z + 5 + 2.4, 6);

    // id's raises its event whether the step settled or not.
    overWall({ ...CPM, pmove_StepRise: 0 }, 5000);
    expect(eventsSince(state, 0)).toEqual([{ event: EV.STEP_4, parm: 0 }]);
  });
});

describe('the crouch slide', () => {
  const CROUCH = { upmove: -127 };
  const CQ3_NO_SLIDE = { ...CQ3, pmove_CrouchSlide: 0 };

  /** Drop the player 10 units at `speed` along x, and run until they land. */
  function land(rules: Rules, speed: number, crouched = true): void {
    airborne(10, vec3(speed, 0, 0));
    for (let i = 0; i < 500 && (i === 0 || state.groundEntityNum === ENTITYNUM_NONE); i++) {
      run(rules, 1, crouched ? CROUCH : {});
    }
  }

  const sliding = () => (state.pmFlags & PMF_CROUCH_SLIDE) !== 0;

  it('starts on a crouched landing over 480 under CQ3, for 500 ms, or 5,000 under DEV', () => {
    land(CQ3, 600);
    expect(sliding()).toBe(true);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(500);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    land(DEV, 600);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(5000);
  });

  it('starts on no landing that is upright, at 480 or under, or under CPM', () => {
    land(CQ3, 600, false);
    expect(sliding()).toBe(false);
    land(CQ3, 470);
    expect(sliding()).toBe(false);
    land(CPM, 600);
    expect(sliding()).toBe(false);
  });

  it('counts the fall in the landing speed', () => {
    state.origin = vec3(0, 0, GROUND_Z + 0.1);
    state.velocity = vec3(470, 0, -200);
    state.groundEntityNum = ENTITYNUM_NONE;
    run(CQ3, 1, CROUCH);
    expect(sliding()).toBe(true);
  });

  it('slows by a constant 500 a second, where a crouch alone slows by 5.6 × the speed', () => {
    land(CQ3, 600);
    run(CQ3, 1, CROUCH);
    expect(state.velocity.x).toBeCloseTo(600 - 500 * 0.008, 10);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    land(CQ3_NO_SLIDE, 600);
    run(CQ3_NO_SLIDE, 1, CROUCH);
    expect(state.velocity.x).toBeCloseTo(600 * (1 - 5.6 * 0.008), 10);
  });

  it('accelerates at 4 toward a crouched wish of the whole speed, knocked back or not', () => {
    const sideways = { ...CROUCH, rightmove: 127 };

    // The crouch takes a share of the command, so the wish is 320 / √2 before the slide raises it.
    land(CQ3, 600);
    run(CQ3, 1, sideways);
    expect(Math.abs(state.velocity.y)).toBeCloseTo(4 * 0.008 * 320, 10);

    land(CQ3, 600);
    state.pmFlags |= PMF_TIME_KNOCKBACK;
    state.pmTime = 100;
    run(CQ3, 1, sideways);
    expect(Math.abs(state.velocity.y)).toBeCloseTo(4 * 0.008 * 320, 10);

    // id's crouch: a quarter of the speed, at the walk's accelerate.
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    land(CQ3_NO_SLIDE, 600);
    run(CQ3_NO_SLIDE, 1, sideways);
    expect(Math.abs(state.velocity.y)).toBeCloseTo(10.5 * 0.008 * 80, 10);
  });

  it('runs out after 63 moves under CQ3, the last taking its time below zero', () => {
    land(CQ3, 600);
    run(CQ3, 63, CROUCH);
    expect(sliding()).toBe(true);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(-4);
    expect(state.velocity.x).toBeCloseTo(600 - 63 * 4, 8);

    run(CQ3, 1, CROUCH);
    expect(sliding()).toBe(false);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(0);
    expect(state.velocity.x).toBeCloseTo(348 * (1 - 5.6 * 0.008), 8);
  });

  it('ends at 321 with the crouch held', () => {
    land(DEV, 600);
    run(DEV, 70, CROUCH);
    expect(sliding()).toBe(true);
    expect(state.velocity.x).toBeCloseTo(320, 8);

    run(DEV, 1, CROUCH);
    expect(sliding()).toBe(false);
  });

  it('ends on standing up, or rising', () => {
    land(CQ3, 600);
    run(CQ3, 1);
    expect(sliding()).toBe(false);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(0);
    expect(state.velocity.x).toBeCloseTo(600 * (1 - 5.6 * 0.008), 10);

    land(CQ3, 600);
    state.velocity = vec3(600, 0, 5);
    run(CQ3, 1, CROUCH);
    expect(sliding()).toBe(false);
  });

  it('ends in the air, so the next landing starts a fresh one', () => {
    land(CQ3, 600);
    run(CQ3, 12, CROUCH);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(404);

    land(CQ3, 600);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(500);
  });

  it('runs on its time when ducked under a ceiling, until the switch goes off', () => {
    trace = createFlatWorldTrace([box(-1000, -1000, 48, 1000, 1000, 100)]);
    state.pmFlags |= PMF_DUCKED | PMF_CROUCH_SLIDE;
    state.stats[STAT.SLIDE_TIME] = 100;
    state.velocity = vec3(600, 0, 0);

    run(CQ3, 1);
    expect(sliding()).toBe(true);
    expect(state.stats[STAT.SLIDE_TIME]).toBe(92);
    expect(state.velocity.x).toBeCloseTo(596, 10);

    run(CQ3_NO_SLIDE, 1);
    expect(sliding()).toBe(false);
    expect(state.velocity.x).toBeCloseTo(596 * (1 - 5.6 * 0.008), 10);
  });

  it('does not carry a corpse, which lands ducked', () => {
    state.pmType = PM_DEAD;
    state.stats[STAT.HEALTH] = 0;
    state.pmFlags |= PMF_DUCKED;
    state.origin = vec3(0, 0, GROUND_Z + 0.1);
    state.velocity = vec3(600, 0, 0);
    state.groundEntityNum = ENTITYNUM_NONE;

    run(CQ3, 1);
    expect(sliding()).toBe(false);
    // The dead move's 20, then CQ3's friction, where a slide would take 4.
    expect(state.velocity.x).toBeCloseTo(580 * (1 - 5.6 * 0.008), 10);
  });
});

describe('the flags', () => {
  beforeEach(() => {
    state.weapon = WP.MACHINEGUN;
    state.stats[STAT.WEAPONS] = 1 << WP.MACHINEGUN;
    state.ammo[WP.MACHINEGUN] = 50;
  });

  it('raises no firing flag while talking, or lowering the weapon, under CPM', () => {
    run(VQ3, 1, { buttons: BUTTON_TALK | BUTTON_ATTACK });
    expect(state.eFlags & EF_FIRING).toBe(EF_FIRING);
    run(CPM, 1, { buttons: BUTTON_TALK | BUTTON_ATTACK });
    expect(state.eFlags & EF_FIRING).toBe(0);

    state.weaponstate = WEAPON_DROPPING;
    state.weaponTime = 1000;
    run(CPM, 1, { buttons: BUTTON_ATTACK });
    expect(state.eFlags & EF_FIRING).toBe(0);
  });

  it('raises no firing flag while a round counts down, under g_countdownHold', () => {
    const counting = (rules: Rules): number => {
      const cmd = createUserCmd({
        buttons: BUTTON_ATTACK,
        serverTime: state.commandTime + PMOVE_MSEC
      });
      pmove(state, cmd, trace, { core: CpmaPmove, rules, countdown: true });
      return state.eFlags & EF_FIRING;
    };
    expect(counting(VQ3)).toBe(EF_FIRING);
    expect(counting(CPM)).toBe(0);
    // Whether or not the firing flag's own rule is on.
    expect(counting({ ...VQ3, g_countdownHold: 1 })).toBe(0);
  });

  it('ends a respawn once attack is up, whatever the use key, under CPM', () => {
    state.pmFlags |= PMF_RESPAWNED;
    run(VQ3, 1, { buttons: BUTTON_USE_HOLDABLE });
    expect(state.pmFlags & PMF_RESPAWNED).toBe(PMF_RESPAWNED);
    run(CPM, 1, { buttons: BUTTON_USE_HOLDABLE });
    expect(state.pmFlags & PMF_RESPAWNED).toBe(0);
  });
});

describe('the weapon', () => {
  it("runs CPMA's weapon step: under CPM a change comes up at once", () => {
    state.stats[STAT.WEAPONS] = (1 << WP.MACHINEGUN) | (1 << WP.SHOTGUN);
    state.ammo[WP.SHOTGUN] = 10;
    state.weapon = WP.MACHINEGUN;
    // The change, the raise's end, then the shot: id's drop and raise would take 58 ticks.
    const events = run(CPM, 3, { buttons: BUTTON_ATTACK, weapon: WP.SHOTGUN });
    expect(events).toEqual([EV.CHANGE_WEAPON, EV.FIRE_WEAPON]);
  });

  it("reads the weapon's times from the rules in id's move too", () => {
    state.stats[STAT.WEAPONS] = (1 << WP.MACHINEGUN) | (1 << WP.SHOTGUN);
    state.ammo[WP.SHOTGUN] = 10;
    state.weapon = WP.MACHINEGUN;
    const since = state.eventSequence;
    for (let i = 0; i < 3; i++) {
      const cmd = createUserCmd({
        buttons: BUTTON_ATTACK,
        weapon: WP.SHOTGUN,
        serverTime: state.commandTime + PMOVE_MSEC
      });
      pmove(state, cmd, trace, { rules: CPM });
    }
    const events = eventsSince(state, since).map(({ event }) => eventNumber(event));
    expect(events).toEqual([EV.CHANGE_WEAPON, EV.FIRE_WEAPON]);
  });
});
