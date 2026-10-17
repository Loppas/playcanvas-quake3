import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { ANIM, animOf } from './animations';
import { box, createFlatWorldTrace } from './box-world';
import { createClipTrace } from './clip-trace';
import { loadMap } from './cm/cm-load';
import { cubeBsp } from './cm/collision-test-fixtures';
import {
  CONTENTS,
  MINS_Z,
  PM_DEAD,
  PMF_GRAPPLE_PULL,
  PMF_TIME_KNOCKBACK,
  PMF_TIME_LAND,
  PMF_TIME_WATERJUMP,
  PMOVE_MSEC,
  STAT,
  SURF
} from './constants';
import { EV, eventNumber, eventsSince } from './events';
import { PW } from './items';
import { pmove, type PmoveOptions, type PmoveResults } from './pmove';
import { CpmaPmove } from './pmove-cpma';
import type { Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import {
  NO_CONTENTS,
  createIdlePlayerState,
  createUserCmd,
  type PointContentsFn,
  type TraceFn,
  type UserCmd
} from './types';
import { vec3 } from './vec3';

/**
 * The move in a liquid and on a BSP's surfaces: `bg_pmove.c`'s water level, swim, water jump and
 * water events, its slick and no-damage floors and its footsteps by surface, then CPMA's water by
 * its rules. A liquid is point contents laid over the world, which is all the move asks of one.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

let state: PlayerState;
let trace: TraceFn;
let contents: PointContentsFn;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
  trace = createFlatWorldTrace();
  contents = NO_CONTENTS;
});

/** A liquid filling the world below `surface`. */
function pool(surface: number, liquid: number = CONTENTS.WATER): PointContentsFn {
  return (point) => (point.z < surface ? liquid : 0);
}

/** What some ticks raised, and the water the last left the player in. */
interface Ran {
  events: number[];
  results: PmoveResults;
}

/** Run ticks of {@link PMOVE_MSEC} holding `input`, in the world's contents. */
function run(ticks: number, input: Partial<UserCmd> = {}, options: PmoveOptions = {}): Ran {
  const events: number[] = [];
  let results: PmoveResults = { waterlevel: 0, watertype: 0, touchents: [] };
  for (let i = 0; i < ticks; i++) {
    const since = state.eventSequence;
    const cmd = createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC });
    results = pmove(state, cmd, trace, { pointContents: contents, ...options });
    events.push(...eventsSince(state, since).map(({ event }) => eventNumber(event)));
  }
  return { events, results };
}

/** Horizontal speed. */
function flatSpeed(): number {
  return Math.hypot(state.velocity.x, state.velocity.y);
}

/** Put the player deep in water, well clear of the floor. */
function deep(): void {
  contents = pool(1000);
  state.origin = vec3(0, 0, 500);
}

/** Put the player a unit above the floor, falling at `speed`. */
function falling(speed: number): void {
  state.origin = vec3(0, 0, GROUND_Z + 1);
  state.velocity = vec3(0, 0, -speed);
}

/**
 * A BSP's floor, through collision: the collision tests' cube made a slab whose top is z = 0 and
 * which runs 1024 units each way, its faces' surface flags these. A player stands on it at
 * {@link GROUND_Z} and the clip's epsilon.
 */
function floorOf(surfaceFlags: number): TraceFn {
  const cube = cubeBsp();
  const dists = [1024, 1024, 1024, 1024, 64, 0];
  const planes = cube.planes.map((plane, i) => (i < 6 ? { ...plane, dist: dists[i] } : plane));
  const shaders = cube.shaders.map((shader, i) => (i === 1 ? { ...shader, surfaceFlags } : shader));
  state.origin = vec3(0, 0, GROUND_Z + 0.125);
  return createClipTrace(loadMap(cubeBsp({ planes, shaders }), 'maps/test.bsp'));
}

describe('the water level', () => {
  it.each([
    [0.5, 0],
    [1.5, 1],
    [24.9, 1],
    [25.5, 2],
    [49.9, 2],
    [50.5, 3]
  ])('is the feet, the waist and the eye in a liquid up to %s: %s', (surface, level) => {
    contents = pool(surface);
    const watertype = level ? CONTENTS.WATER : 0;
    expect(run(1).results).toMatchObject({ waterlevel: level, watertype });
  });

  it('takes the waist halfway from the feet to the eye, so a crouch takes it lower', () => {
    contents = pool(20);
    expect(run(1).results.waterlevel).toBe(1);
    expect(run(2, { upmove: -127 }).results.waterlevel).toBe(2);
  });

  it('takes its type from the feet, whatever is above them', () => {
    contents = (point) => (point.z < 10 ? CONTENTS.SLIME : point.z < 100 ? CONTENTS.LAVA : 0);
    expect(run(1).results).toMatchObject({ waterlevel: 3, watertype: CONTENTS.SLIME });
  });

  it('is no liquid at all in fog, and has no type', () => {
    contents = pool(100, CONTENTS.FOG);
    expect(run(1).results).toMatchObject({ waterlevel: 0, watertype: 0 });
  });

  it('is asked past the player themselves', () => {
    const asked = new Set<number>();
    contents = (_point, passEntityNum) => {
      asked.add(passEntityNum);
      return CONTENTS.WATER;
    };
    state.clientNum = 3;
    run(1);
    expect(asked).toEqual(new Set([3]));
  });

  it('is none for a command that does not move the player', () => {
    contents = pool(100);
    run(1);
    const stale = createUserCmd({ serverTime: state.commandTime - PMOVE_MSEC });
    expect(pmove(state, stale, trace, { pointContents: contents })).toEqual({
      touchents: [],
      waterlevel: 0,
      watertype: 0
    });
  });
});

describe('the swim', () => {
  it('goes along the view at half the speed, and nothing pulls it down', () => {
    deep();
    run(375, { forwardmove: 127 });
    expect(state.velocity).toEqual(vec3(160, 0, 0));
  });

  it('goes up the view where the player looks up', () => {
    deep();
    run(375, { forwardmove: 127, angles: vec3(-30, 0, 0) });
    // 160 along the view, as the snap settles it.
    expect(state.velocity).toEqual(vec3(138, 0, 81));
  });

  it('goes straight up on the jump key', () => {
    deep();
    run(375, { upmove: 127 });
    expect(state.velocity).toEqual(vec3(0, 0, 160));
  });

  it('sinks at 60 with no keys held, and so does a corpse', () => {
    deep();
    run(375);
    expect(state.velocity).toEqual(vec3(0, 0, -60));

    deep();
    state.velocity = vec3();
    state.pmType = PM_DEAD;
    state.stats[STAT.HEALTH] = 0;
    run(375);
    expect(state.velocity).toEqual(vec3(0, 0, -60));
  });

  it("slides along the bottom it is pushed into, keeping the speed the slope's clip takes", () => {
    contents = pool(1000);
    run(1);
    state.velocity = vec3();
    run(1, { forwardmove: 127, angles: vec3(45, 0, 0) });
    // 5.12 along the view, all of it turned along the floor; the clip alone would leave 3.6.
    expect(state.velocity).toEqual(vec3(5, 0, 0));
  });

  it('swims its legs while off the ground in it, and not wading', () => {
    deep();
    run(1);
    expect(animOf(state.legsAnim)).toBe(ANIM.LEGS_SWIM);

    state.legsAnim = ANIM.LEGS_IDLE;
    contents = pool(480);
    state.origin = vec3(0, 0, 500);
    run(1);
    expect(animOf(state.legsAnim)).toBe(ANIM.LEGS_IDLE);
  });

  it("follows CorkScrew's pull, as the move it runs on top of", () => {
    deep();
    state.pmFlags |= PMF_GRAPPLE_PULL;
    state.grapplePoint = vec3(1000, 0, 500);
    run(1, {}, { grappleMode: 'corkscrew' });
    // The swim's sink, where the air's gravity would take 6.
    expect(state.velocity.z).toBe(-2);
  });
});

describe('friction in water', () => {
  /** The player on the floor in a liquid up to `surface`, coasting at 300 for a tick. */
  function coast(surface: number): number {
    contents = pool(surface);
    run(1);
    state.velocity = vec3(300, 0, 0);
    run(1);
    return state.velocity.x;
  }

  it("takes the water's term with the ground's while wading", () => {
    expect(coast(0)).toBe(286);
    expect(coast(10)).toBe(283);
  });

  it("drops the ground's waist deep, and takes the water's harder the deeper", () => {
    expect(coast(30)).toBe(295);
    expect(coast(60)).toBe(293);
  });
});

describe('the walk in water, and on a BSP floor', () => {
  it('holds a wade to five sixths of the speed', () => {
    contents = pool(10);
    run(125, { forwardmove: 127 });
    expect(flatSpeed()).toBe(267);
  });

  it("takes a slick floor at the air's acceleration, with gravity, and no friction", () => {
    trace = floorOf(SURF.SLICK);
    run(1);
    state.velocity = vec3();
    run(1, { forwardmove: 127 });
    // 2.56 of the air's, and the fall's 6.4 turned along the floor by the clip.
    expect(state.velocity).toEqual(vec3(7, 0, 0));

    state.velocity = vec3(300, 0, 0);
    run(10);
    expect(state.velocity.x).toBe(300);

    trace = floorOf(0);
    run(1);
    state.velocity = vec3();
    run(1, { forwardmove: 127 });
    expect(state.velocity).toEqual(vec3(26, 0, 0));
  });

  it('lands on a floor that never hurts with no sound, and starts the stride over', () => {
    trace = floorOf(SURF.NODAMAGE);
    falling(1000);
    state.bobCycle = 100;
    const { events } = run(1, { forwardmove: 127 });
    expect(events).toEqual([]);
    expect(state.bobCycle).toBe(3);

    trace = floorOf(0);
    falling(1000);
    expect(run(1).events).toEqual([EV.FALL_FAR]);
  });

  it('clanks on a metal floor, and makes event 0 on a silent one', () => {
    trace = floorOf(SURF.METALSTEPS);
    const metal = run(40, { forwardmove: 127 }).events;
    expect(metal).toContain(EV.FOOTSTEP_METAL);
    expect(metal).not.toContain(EV.FOOTSTEP);

    trace = floorOf(SURF.NOSTEPS);
    const silent = run(40, { forwardmove: 127 }).events;
    expect(silent).toContain(EV.NONE);
    expect(silent).not.toContain(EV.FOOTSTEP);

    trace = floorOf(0);
    expect(run(40, { forwardmove: 127 }).events).toContain(EV.FOOTSTEP);
  });

  it('splashes a stride at the feet, crouched or not, swims at the waist, quiet under', () => {
    contents = pool(10);
    const wading = run(40, { forwardmove: 127 }).events;
    expect(wading).toContain(EV.FOOTSPLASH);
    expect(wading).not.toContain(EV.FOOTSTEP);
    expect(run(40, { forwardmove: 127, upmove: -127 }).events).toContain(EV.FOOTSPLASH);
    expect(run(40, { forwardmove: 127 }, { noFootsteps: true }).events).toContain(EV.FOOTSPLASH);

    contents = pool(30);
    expect(run(40, { forwardmove: 127 }).events).toContain(EV.SWIM);

    contents = pool(60);
    expect(run(40, { forwardmove: 127 }).events).toEqual([]);
  });

  it.each([
    [0, [EV.FALL_FAR]],
    [10, [EV.FALL_MEDIUM]],
    [30, [EV.FALL_SHORT]],
    [60, []]
  ])('breaks a fall in a liquid up to %s, as the feet, the waist and the eye are in it', (
    surface,
    events
  ) => {
    contents = pool(surface);
    falling(1000);
    expect(run(1).events).toEqual(events);
  });

  it("ends a water jump on solid ground, and the landing's hold with it", () => {
    run(1);
    state.pmFlags |= PMF_TIME_WATERJUMP | PMF_TIME_LAND;
    state.pmTime = 1500;
    // Rising too slowly to leave the floor, so the move is the walk's and not the jump's fall.
    state.velocity = vec3(0, 0, 5);
    run(1);
    expect(state.pmFlags & (PMF_TIME_WATERJUMP | PMF_TIME_LAND)).toBe(0);
    expect(state.pmTime).toBe(0);
    expect(state.velocity.z).toBe(5);
  });
});

describe('the water jump', () => {
  /**
   * Water up to `surface` against a ledge from x = 20 whose top is z = 40, with `over` lying on
   * the ledge's top. The water stops at the ledge's face, however high it stands.
   */
  function ledge(surface = 30, over = 0): void {
    trace = createFlatWorldTrace([box(20, -512, 0, 512, 512, 40)]);
    contents = (point) => {
      if (point.z < 0 || (point.x >= 20 && point.z < 40)) return CONTENTS.SOLID;
      if (point.x < 20) return point.z < surface ? CONTENTS.WATER : 0;
      return point.z < 60 ? over : 0;
    };
  }

  const jumping = () => (state.pmFlags & PMF_TIME_WATERJUMP) !== 0;

  it('throws a player waist deep and facing a ledge up and out at it, and holds them to it', () => {
    ledge();
    run(1);
    expect(jumping()).toBe(true);
    expect(state.pmTime).toBe(2000);
    expect([state.velocity.x, state.velocity.z]).toEqual([200, 337]);
  });

  it('falls at twice the gravity, and ends coming down, to step onto the ledge', () => {
    ledge();
    run(1);
    const before = state.velocity.z;
    run(1);
    expect(before - state.velocity.z).toBe(13);

    let ticks = 0;
    while (jumping() && ticks < 100) {
      run(1);
      ticks++;
    }
    expect([jumping(), state.pmTime]).toEqual([false, 0]);
    expect(state.velocity.z).toBeLessThan(0);
    expect(state.groundEntityNum).toBe(ENTITYNUM_NONE);

    // Its 38 units fall 2 short of the top, and the air move's step makes them up.
    run(60);
    expect(state.groundEntityNum).not.toBe(ENTITYNUM_NONE);
    expect(state.origin.x).toBeGreaterThan(20);
    expect(state.origin.z).toBeCloseTo(40 + GROUND_Z, 0);
  });

  it('pushes along the whole view, so looking up throws the player less far forward', () => {
    ledge();
    run(1, { angles: vec3(-30, 0, 0) });
    expect(jumping()).toBe(true);
    expect(state.velocity.x).toBe(173);
  });

  it("is refused only by what is solid to a player over the ledge's top, in either move", () => {
    const refused = [
      CONTENTS.SOLID,
      CONTENTS.PLAYERCLIP,
      CONTENTS.BODY,
      CONTENTS.WATER | CONTENTS.BODY
    ];
    const allowed = [
      CONTENTS.WATER,
      CONTENTS.LAVA,
      CONTENTS.SLIME,
      CONTENTS.FOG,
      CONTENTS.TRIGGER,
      CONTENTS.NODROP,
      CONTENTS.MONSTERCLIP,
      CONTENTS.CORPSE
    ];
    // CPMA's move carries no test of its own, though CPMA's game module has id's.
    const moves: PmoveOptions[] = [{}, { core: CpmaPmove, rules: presetRules('cpm') }];
    for (const options of moves) {
      for (const over of [...refused, ...allowed]) {
        state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
        ledge(30, over);
        run(1, {}, options);
        expect(jumping(), `${over}`).toBe(allowed.includes(over));
      }
    }
  });

  it('is not for the feet alone, nor under, nor facing away, nor while a timer runs', () => {
    for (const surface of [10, 60]) {
      state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
      ledge(surface);
      run(1);
      expect(jumping(), `${surface}`).toBe(false);
    }

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    ledge();
    run(1, { angles: vec3(0, 180, 0) });
    expect(jumping()).toBe(false);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    state.pmFlags |= PMF_TIME_KNOCKBACK;
    state.pmTime = 100;
    ledge();
    run(1);
    expect(jumping()).toBe(false);
  });
});

describe('the water events', () => {
  /** A tick through the surface of water up to 100, from `z`, at `speed` up. */
  function through(z: number, speed: number): number[] {
    contents = pool(100);
    state.origin = vec3(0, 0, z);
    state.velocity = vec3(0, 0, speed);
    return run(1).events;
  }

  it('splashes as the feet go in and come out', () => {
    expect(through(124.5, -400)).toEqual([EV.WATER_TOUCH]);
    expect(through(122, 400)).toEqual([EV.WATER_LEAVE]);
  });

  it('sounds as the head goes under and comes up', () => {
    expect(through(74.5, -400)).toEqual([EV.WATER_UNDER]);
    expect(through(73, 400)).toEqual([EV.WATER_CLEAR]);
  });

  it('takes the starting level before the duck, so a crouch can take the head under', () => {
    contents = pool(40);
    run(1);
    expect(run(1, { upmove: -127 }).events).toEqual([EV.WATER_UNDER]);
  });
});

describe("CPMA's water, by its rules", () => {
  const VQ3 = presetRules('vq3');
  const PMC = presetRules('pmc');
  const CPM = presetRules('cpm');

  const cpma = (rules: Rules): PmoveOptions => ({ core: CpmaPmove, rules });

  it("swims at its preset's share of the speed, accelerating at 5", () => {
    deep();
    run(1, { forwardmove: 127 }, cpma(CPM));
    expect(state.velocity.x).toBeCloseTo(9.6, 9);
    run(375, { forwardmove: 127 }, cpma(CPM));
    expect(state.velocity.x).toBeCloseTo(240, 9);

    deep();
    state.velocity = vec3();
    run(1, { forwardmove: 127 }, cpma(PMC));
    expect(state.velocity.x).toBeCloseTo(5 * 0.008 * 320 * 0.54, 9);
    run(375, { forwardmove: 127 }, cpma(PMC));
    expect(state.velocity.x).toBeCloseTo(320 * 0.54, 9);

    deep();
    state.velocity = vec3();
    run(375, { forwardmove: 127 }, cpma(VQ3));
    expect(state.velocity.x).toBe(160);
  });

  it("wades at its preset's share, blended a third of the way", () => {
    contents = pool(10);
    run(125, { forwardmove: 127 }, cpma(CPM));
    expect(flatSpeed()).toBeCloseTo(320, 9);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    run(125, { forwardmove: 127 }, cpma(PMC));
    expect(flatSpeed()).toBeCloseTo(320 * (1 - (1 - 0.585) / 3), 9);
  });

  it("slows a swimmer by its water friction, and keeps no speed a slope's clip takes", () => {
    contents = pool(30);
    run(1, {}, cpma(CPM));
    state.velocity = vec3(300, 0, 0);
    run(1, {}, cpma(CPM));
    expect(state.velocity.x).toBeCloseTo(300 * (1 - 0.75 * 2 * 0.008), 9);

    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    contents = pool(1000);
    run(1, {}, cpma(CPM));
    run(1, { forwardmove: 127, angles: vec3(45, 0, 0) }, cpma(CPM));
    expect(state.velocity.x).toBeCloseTo(9.6 * Math.SQRT1_2, 3);
  });

  it("walks a slick floor at the air's acceleration, as id's does", () => {
    trace = floorOf(SURF.SLICK);
    run(1, {}, cpma(CPM));
    state.velocity = vec3();
    run(1, { forwardmove: 127 }, cpma(CPM));
    // The clip alone, with no snap: the air's 2.56, where CPM's ground would give 38.4.
    expect(state.velocity.x).toBeCloseTo(2.56, 9);
  });

  it('takes the waist at the origin, standing or crouched', () => {
    contents = pool(24.5);
    expect(run(1, {}, cpma(CPM)).results.waterlevel).toBe(2);
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    expect(run(1, {}, cpma(VQ3)).results.waterlevel).toBe(1);

    contents = pool(20);
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    expect(run(2, { upmove: -127 }, cpma(CPM)).results.waterlevel).toBe(1);
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    expect(run(2, { upmove: -127 }, cpma(VQ3)).results.waterlevel).toBe(2);
  });

  it('makes no head sounds for the dead, and no gasp in the battle suit', () => {
    /** A tick through the surface of water up to 100, as {@link rules} play it. */
    const through = (rules: Rules, z: number, speed: number, setup: () => void): number[] => {
      state = createIdlePlayerState({ origin: vec3(0, 0, z), velocity: vec3(0, 0, speed) });
      contents = pool(100);
      setup();
      return run(1, {}, cpma(rules)).events;
    };
    const dead = () => {
      state.pmType = PM_DEAD;
      state.stats[STAT.HEALTH] = 0;
    };
    const suited = () => {
      state.powerups[PW.BATTLESUIT] = 1;
    };

    expect(through(VQ3, 74.5, -400, dead)).toEqual([EV.WATER_UNDER]);
    expect(through(CPM, 74.5, -400, dead)).toEqual([]);
    expect(through(VQ3, 73, 400, suited)).toEqual([EV.WATER_CLEAR]);
    expect(through(CPM, 73, 400, suited)).toEqual([]);
    expect(through(CPM, 74.5, -400, suited)).toEqual([EV.WATER_UNDER]);
  });
});
