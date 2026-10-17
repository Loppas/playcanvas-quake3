import { beforeEach, describe, expect, it } from 'vitest';
import type { PlayerState } from '../../net/protocol';
import { createFlatWorldTrace } from '../box-world';
import { BUTTON_ATTACK, FL, PMF_TIME_KNOCKBACK, STAT } from '../constants';
import { EV, eventNumber, eventsSince } from '../events';
import { pmove } from '../pmove';
import { createArmedPlayerState, createUserCmd, type UserCmd } from '../types';
import { vec3 } from '../vec3';
import { WP } from './constants';
import { linkPlayer, weaponWorld, type WeaponWorld } from './weapon-test-fixtures';

/**
 * The integration test: `pmove` and the weapon system driving each other through the
 * real trace, exactly as the game wires them.
 *
 * Every number here is **measured from the port and pinned**.
 * The analytic figures (a +500 z kick against a 270 jump) are what the
 * physics should produce before the movement sim gets hold of it; what the player actually
 * experiences is what these tests record, because the integer velocity snap and the 8 ms
 * tick both bite (cf. the 48.53 unit jump apex).
 */

const TICK = 8;
const flat = createFlatWorldTrace();

let world: WeaponWorld;

beforeEach(() => {
  world = weaponWorld({ trace: flat });
});

/**
 * Player standing on the floor with the rocket launcher out, looking wherever asked.
 *
 * It is the client slot's own state, because that is whose rocket it is: the blast reaches the
 * player through the entity that fired it, linked where they stand, as `G_RadiusDamage` reaches
 * anyone.
 */
function shooter(pitch = 0, yaw = 0): PlayerState {
  const state = world.owner.client!.ps;
  Object.assign(
    state,
    createArmedPlayerState({
      origin: vec3(0, 0, 24),
      viewangles: vec3(pitch, yaw, 0),
      weapon: WP.ROCKET_LAUNCHER
    })
  );
  linkPlayer(world.level, world.owner);
  return state;
}

/**
 * One tick of the whole pipeline: the world's frame, then the command against it.
 *
 * `G_RunFrame` before `ClientThink` is the server's order, and it is what puts a rocket's flight
 * on the tick before the one that resolves what it hit.
 */
function tick(state: PlayerState, time: number, input: Partial<UserCmd> = {}): void {
  world.level.runFrame(time);
  const cmd = createUserCmd({
    serverTime: time,
    weapon: state.weapon,
    angles: state.viewangles,
    ...input
  });
  const before = state.eventSequence;
  pmove(state, cmd, flat);
  // `ClientEvents`: the fire events the move raised, turned into shots.
  for (const { event } of eventsSince(state, before)) {
    if (eventNumber(event) === EV.FIRE_WEAPON) world.weapons.fire(state);
  }
  linkPlayer(world.level, world.owner);
}

/**
 * Run the pipeline and report how high the player got and how far they travelled.
 *
 * @param state - Player state, mutated.
 * @param ticks - Ticks to simulate.
 * @param input - Input held on the first tick, and (without attack) thereafter.
 */
function simulate(
  state: PlayerState,
  ticks: number,
  input: Partial<UserCmd> = {}
): { apex: number; distance: number; peakSpeed: number } {
  const startZ = state.origin.z;
  let apex = 0;
  let peakSpeed = 0;

  for (let i = 1; i <= ticks; i++) {
    // Attack is only held on the first tick — one rocket, not a stream.
    const held = i === 1 ? input : { ...input, buttons: 0 };
    tick(state, i * TICK, held);
    apex = Math.max(apex, state.origin.z - startZ);
    peakSpeed = Math.max(peakSpeed, Math.hypot(state.velocity.x, state.velocity.y));
  }

  return { apex, distance: Math.hypot(state.origin.x, state.origin.y), peakSpeed };
}

describe('rocket jump', () => {
  it('reaches a 165.87 unit apex from a rocket at the feet', () => {
    // Measured from the port and pinned, against a plain jump's 48.53. The analytic
    // figure behind it is the +500 ups knockback in `splash.ts`; what this records is what
    // survives the 8 ms tick and the integer velocity snap, which is the number a player
    // actually experiences.
    const state = shooter(90);
    expect(simulate(state, 200, { buttons: BUTTON_ATTACK }).apex).toBeCloseTo(165.87, 1);
  });

  it('leaves the plain jump apex untouched', () => {
    // Adding weapons must not move a single movement golden.
    expect(simulate(shooter(), 200, { upmove: 20 }).apex).toBeCloseTo(48.53, 1);
  });

  it('stacks with a jump to 390.05 units', () => {
    // Jumping and firing on the same tick adds 270 to the 500, and apex goes as the square
    // of the launch speed — so it more than doubles rather than merely adding.
    const state = shooter(90);
    const { apex } = simulate(state, 300, { buttons: BUTTON_ATTACK, upmove: 20 });
    expect(apex).toBeCloseTo(390.05, 1);
  });

  it('drifts sideways even when aimed straight down, because of the pitch clamp', () => {
    // Not a defect: Quake clamps pitch to +-87.89 degrees, so "straight down" is really 2.11
    // degrees off vertical. The rocket lands in front of the player and the blast pushes them
    // back at 11 ups. Pinning it guards the clamp and the splash direction at once — if either
    // changed, this would be the first thing to move.
    const state = shooter(90);
    // Two ticks: the rocket is fired on the first and flies on the second, because the world's
    // frame runs before the command rather than inside it. The prestep is what makes that first
    // flight long enough to reach the floor.
    tick(state, TICK, { buttons: BUTTON_ATTACK });
    tick(state, 2 * TICK);
    expect(state.velocity.x).toBeCloseTo(-11, 1);
    expect(state.velocity.z).toBeCloseTo(493, 1);
  });

  it('sets the friction-free window when the rocket connects', () => {
    const state = shooter(90);
    for (let i = 1; i <= 12; i++) {
      tick(state, i * TICK, i === 1 ? { buttons: BUTTON_ATTACK } : {});
    }
    expect(state.pmFlags & PMF_TIME_KNOCKBACK).toBeTruthy();
    expect(state.pmTime).toBeGreaterThan(0);
  });

  it('trades height for distance when angled', () => {
    // The move that matters in play: aim down and behind rather than at your feet. Measured
    // at 70 degrees — 227 units of travel against 15 straight down, for 21 units less
    // height.
    const angled = simulate(shooter(70), 300, { buttons: BUTTON_ATTACK });
    expect(angled.distance).toBeCloseTo(226.78, 0);
    expect(angled.apex).toBeCloseTo(144.02, 1);

    const straight = simulate(shooter(90), 300, { buttons: BUTTON_ATTACK });
    expect(straight.distance).toBeCloseTo(14.75, 0);
  });

  it('adds to running speed instead of replacing it', () => {
    // Rocket-jumping out of a run keeps the run — the property that makes it a movement
    // technique rather than just a way to get high. Measured over the same 300 ticks as the
    // standing case above: 729 units of travel against 227, at the 320 ups ground cap. The blast
    // pushes from where the runner really is, not from the whole unit they are linked at
    // (`g_active.c:979`), which a runner is between; pushed from the snapped origin they went 727.
    const running = shooter(70);
    running.velocity = vec3(320, 0, 0);
    const result = simulate(running, 300, { buttons: BUTTON_ATTACK, forwardmove: 127 });
    expect(result.distance).toBeCloseTo(729.5, 0);
    expect(result.peakSpeed).toBeCloseTo(320, 0);
  });

  it('does not fire and does not launch without the attack button', () => {
    const state = shooter(90);
    const { apex } = simulate(state, 200, {});
    expect(apex).toBe(0);
    expect(state.pmFlags & PMF_TIME_KNOCKBACK).toBeFalsy();
  });

  it('costs the shooter half the blast, after its full push', () => {
    const state = shooter(90);
    const { apex } = simulate(state, 200, { buttons: BUTTON_ATTACK });
    expect(state.stats[STAT.HEALTH]).toBe(100 - 50);
    expect(apex).toBeCloseTo(165.87, 1);
  });

  it('launches a player in god mode just as high, and hurts them not at all', () => {
    // `G_Damage` pushes before it checks god, which is what a rocket jump in god mode is.
    world.owner.flags |= FL.GODMODE;
    const state = shooter(90);
    expect(simulate(state, 200, { buttons: BUTTON_ATTACK }).apex).toBeCloseTo(165.87, 1);
    expect(state.stats[STAT.HEALTH]).toBe(100);
  });
});

describe('plasma climb', () => {
  it('lifts the player with repeated small blasts', () => {
    // Plasma's 15 damage / 20 unit radius is tiny, but at 100 ms intervals it accumulates —
    // the basis of the plasma climb.
    const state = shooter(90);
    state.weapon = WP.PLASMAGUN;
    let apex = 0;
    for (let i = 1; i <= 120; i++) {
      tick(state, i * TICK, { buttons: BUTTON_ATTACK });
      apex = Math.max(apex, state.origin.z - 24);
    }
    // Tiny: 15 damage over a 20 unit radius barely reaches. Measured 7.04 units of lift
    // over 300 ticks of continuous fire — enough to climb, nothing like a rocket jump.
    expect(apex).toBeGreaterThan(0);
    expect(apex).toBeLessThan(20);
  });
});

describe('grenade jump', () => {
  it('launches the player when a grenade detonates at their feet', () => {
    // A grenade dropped at your feet has to wait out its 2.5 second fuse, which is what
    // makes grenade jumps a planned move rather than a reflex.
    const state = shooter(90);
    state.weapon = WP.GRENADE_LAUNCHER;

    let apex = 0;
    for (let i = 1; i <= 500; i++) {
      tick(state, i * TICK, i === 1 ? { buttons: BUTTON_ATTACK } : {});
      apex = Math.max(apex, state.origin.z - 24);
    }
    // Measured 55.61 units: a grenade dropped at your feet rolls a little before its 2.5
    // second fuse ends it, so it lifts noticeably less than a rocket for the same 100
    // damage — and you have to wait for it.
    expect(apex).toBeCloseTo(55.61, 1);
    // The fuse's blast is the thrower's own, so they take half of it: 50 at the most.
    expect(state.stats[STAT.HEALTH]).toBeGreaterThanOrEqual(50);
  });

  it('is matched by the BFG, which shares the rocket splash numbers', () => {
    // Vanilla baseq3's BFG: 100 splash over 120 units, exactly the rocket's, so it
    // rocket-jumps identically. Team Arena's ray version would not.
    const bfg = shooter(90);
    bfg.weapon = WP.BFG;
    expect(simulate(bfg, 200, { buttons: BUTTON_ATTACK }).apex).toBeCloseTo(165.87, 1);
  });
});
