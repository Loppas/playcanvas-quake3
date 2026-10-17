import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, type PlayerState } from '../net/protocol';
import { ANIM, ANIM_TOGGLEBIT, TIMER_GESTURE, TIMER_LAND, animOf } from './animations';
import { box, createFlatWorldTrace } from './box-world';
import { STAT } from './constants';
import {
  BUTTON_ATTACK,
  BUTTON_GESTURE,
  BUTTON_TALK,
  BUTTON_USE_HOLDABLE,
  DEAD_VIEWHEIGHT,
  EF_FIRING,
  EF_TALK,
  PMF_BACKWARDS_JUMP,
  PMF_BACKWARDS_RUN,
  PMF_RESPAWNED,
  PMOVE_MSEC,
  PM_DEAD
} from './constants';
import { EV, eventsSince } from './events';
import { HI, findItem, itemIndex } from './items';
import { pmove } from './pmove';
import { createArmedPlayerState, createUserCmd, type TraceFn, type UserCmd } from './types';
import { vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * The animations the sim chooses, at `bg_pmove.c`'s own call sites: the legs from the
 * move, the torso from the weapon. The rig only plays what these pick, so every state a
 * body can be seen in is pinned here.
 */

const flat = createFlatWorldTrace();

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = 24;

const FORWARD = { forwardmove: 127 };
const BACK = { forwardmove: -127 };
const CROUCH = { upmove: -127 };
const JUMP = { upmove: 127 };

let state: PlayerState;

beforeEach(() => {
  state = createArmedPlayerState({ origin: vec3(0, 0, GROUND_Z), weapon: WP.MACHINEGUN });
});

/**
 * Advance the simulation a tick at a time, collecting the events each tick left in the ring. The
 * weapon asked for is the one in hand unless the input says otherwise.
 */
function run(ticks: number, input: Partial<UserCmd> = {}, trace: TraceFn = flat): number[] {
  const events: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const cmd = createUserCmd({
      weapon: state.weapon,
      ...input,
      serverTime: state.commandTime + PMOVE_MSEC
    });
    const before = state.eventSequence;
    pmove(state, cmd, trace);
    events.push(...eventsSince(state, before).map(({ event }) => event));
  }
  return events;
}

/** Run until the player is on the ground again, returning the ticks it took. */
function untilLanded(input: Partial<UserCmd> = {}): number {
  for (let tick = 1; tick <= 500; tick++) {
    run(1, input);
    if (state.groundEntityNum !== ENTITYNUM_NONE) return tick;
  }
  throw new Error('never landed');
}

const legs = () => animOf(state.legsAnim);
const torso = () => animOf(state.torsoAnim);

describe('legs on the ground (PM_Footsteps)', () => {
  it('idle standing still, and crouched idle when ducked', () => {
    // A state made standing on the floor lands on its first tick, and the landing holds the
    // legs for 17 ticks.
    run(10);
    expect(legs()).toBe(ANIM.LEGS_LAND);
    run(10);
    expect(legs()).toBe(ANIM.LEGS_IDLE);
    run(10, CROUCH);
    expect(legs()).toBe(ANIM.LEGS_IDLECR);
  });

  it('run forward, and backpedal moving back', () => {
    run(30, FORWARD);
    expect(legs()).toBe(ANIM.LEGS_RUN);

    run(30, BACK);
    expect(legs()).toBe(ANIM.LEGS_BACK);
    expect(state.pmFlags & PMF_BACKWARDS_RUN).toBeTruthy();
  });

  it('crouch-walk forward and back', () => {
    run(30, { ...FORWARD, ...CROUCH });
    expect(legs()).toBe(ANIM.LEGS_WALKCR);
    run(30, { ...BACK, ...CROUCH });
    expect(legs()).toBe(ANIM.LEGS_BACKCR);
  });

  it('turn forwards again on a pure strafe', () => {
    run(30, BACK);
    run(10, { rightmove: 127 });
    expect(state.pmFlags & PMF_BACKWARDS_RUN).toBeFalsy();
    expect(legs()).toBe(ANIM.LEGS_RUN);
  });

  it('play no footstep while crouched, as Q3 never does', () => {
    run(5);
    expect(run(250, { ...FORWARD, ...CROUCH }).filter((event) => event === EV.FOOTSTEP)).toHaveLength(0);
    expect(run(250, FORWARD).filter((event) => event === EV.FOOTSTEP).length).toBeGreaterThan(2);
  });
});

describe('jumps and landings', () => {
  it('raise the jump event once, and force the jump', () => {
    run(5);
    const events = run(1, JUMP);
    expect(events.filter((event) => event === EV.JUMP)).toHaveLength(1);
    expect(legs()).toBe(ANIM.LEGS_JUMP);
    expect(state.pmFlags & PMF_BACKWARDS_JUMP).toBeFalsy();
  });

  it('land with LEGS_LAND, held for 130 ms against anything else', () => {
    run(5);
    run(1, JUMP);
    untilLanded();
    expect(legs()).toBe(ANIM.LEGS_LAND);
    expect(state.legsTimer).toBe(TIMER_LAND);

    // The hold drops 8 ms a tick, so it holds 16 ticks and gives way on the 17th.
    run(16);
    expect(legs()).toBe(ANIM.LEGS_LAND);
    run(1);
    expect(legs()).toBe(ANIM.LEGS_IDLE);
  });

  it('jump backwards moving back, and land backwards from it', () => {
    run(5);
    run(1, { ...JUMP, ...BACK });
    expect(legs()).toBe(ANIM.LEGS_JUMPB);
    expect(state.pmFlags & PMF_BACKWARDS_JUMP).toBeTruthy();

    untilLanded(BACK);
    expect(legs()).toBe(ANIM.LEGS_LANDB);
  });

  it('flip the toggle bit at every change of the legs, so the client restarts each one', () => {
    run(20);
    const seen = [state.legsAnim];
    run(1, JUMP);
    seen.push(state.legsAnim);
    untilLanded();
    seen.push(state.legsAnim);
    run(1, JUMP);
    seen.push(state.legsAnim);

    expect(seen.map(animOf)).toEqual([
      ANIM.LEGS_IDLE,
      ANIM.LEGS_JUMP,
      ANIM.LEGS_LAND,
      ANIM.LEGS_JUMP
    ]);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] ^ seen[i - 1], String(i)).toBe(ANIM_TOGGLEBIT | (animOf(seen[i]) ^ animOf(seen[i - 1])));
    }
  });

  it('go into the jump when knocked off the ground, with no jump event', () => {
    run(5);
    state.velocity = vec3(0, 0, 300);
    const events = run(1);
    expect(legs()).toBe(ANIM.LEGS_JUMP);
    expect(events).not.toContain(EV.JUMP);
  });

  /**
   * Walk off a platform of the given height, returning the legs' row on the tick the player
   * leaves it.
   */
  function walkOff(height: number): number {
    state = createArmedPlayerState({ origin: vec3(0, 0, height + GROUND_Z), weapon: WP.MACHINEGUN });
    const trace = createFlatWorldTrace([box(-512, -256, 0, 64, 256, height)]);
    run(5, {}, trace);
    for (let tick = 0; tick < 200; tick++) {
      run(1, FORWARD, trace);
      if (state.groundEntityNum === ENTITYNUM_NONE) return legs();
    }
    throw new Error('never left the platform');
  }

  it('go into the jump off a drop of more than 64 units, but keep running down a smaller one', () => {
    expect(walkOff(128)).toBe(ANIM.LEGS_JUMP);
    expect(walkOff(32)).toBe(ANIM.LEGS_RUN);
  });
});

describe('the direction the legs face (PM_SetMovementDir)', () => {
  it('takes one of eight, counter-clockwise from ahead', () => {
    const cases: [number, number, number][] = [
      [127, 0, 0],
      [127, -127, 1],
      [0, -127, 2],
      [-127, -127, 3],
      [-127, 0, 4],
      [-127, 127, 5],
      [0, 127, 6],
      [127, 127, 7]
    ];
    for (const [forwardmove, rightmove, dir] of cases) {
      state = createArmedPlayerState({ origin: vec3(0, 0, GROUND_Z), weapon: WP.MACHINEGUN });
      run(3, { forwardmove, rightmove });
      expect(state.movementDir, `${forwardmove} ${rightmove}`).toBe(dir);
    }
  });

  it('settles a pure strafe onto the forward diagonal when the keys go', () => {
    run(3, { rightmove: -127 });
    run(1);
    expect(state.movementDir).toBe(1);

    run(3, { rightmove: 127 });
    run(1);
    expect(state.movementDir).toBe(7);
  });
});

describe('the torso (PM_Weapon, PM_TorsoAnimation, PM_Animate)', () => {
  it('stands with a gun, and in its own stance with the gauntlet', () => {
    run(5);
    expect(torso()).toBe(ANIM.TORSO_STAND);

    // 464 ms of drop and raise at the 8 ms tick.
    run(60, { weapon: WP.GAUNTLET });
    expect(torso()).toBe(ANIM.TORSO_STAND2);
  });

  it('drops, raises, then stands through a weapon switch', () => {
    const seen: number[] = [];
    for (let tick = 0; tick < 60; tick++) {
      run(1, { weapon: WP.ROCKET_LAUNCHER });
      if (seen.at(-1) !== torso()) seen.push(torso());
    }
    expect(seen).toEqual([ANIM.TORSO_DROP, ANIM.TORSO_RAISE, ANIM.TORSO_STAND]);
  });

  it('restarts the attack on every shot, then stands once attack is let go', () => {
    run(5);
    const shots: number[] = [];
    for (let tick = 0; tick < 30; tick++) {
      if (run(1, { buttons: BUTTON_ATTACK }).includes(EV.FIRE_WEAPON)) {
        shots.push(state.torsoAnim);
      }
    }
    expect(shots.length).toBeGreaterThan(2);
    for (let i = 0; i < shots.length; i++) {
      expect(animOf(shots[i])).toBe(ANIM.TORSO_ATTACK);
      if (i > 0) expect(shots[i] ^ shots[i - 1]).toBe(ANIM_TOGGLEBIT);
    }

    run(20);
    expect(torso()).toBe(ANIM.TORSO_STAND);
  });

  it('gestures on its button, holding the torso for its length', () => {
    run(5);
    const first = run(1, { buttons: BUTTON_GESTURE });
    expect(first.filter((event) => event === EV.TAUNT)).toHaveLength(1);
    expect(torso()).toBe(ANIM.TORSO_GESTURE);
    expect(state.torsoTimer).toBe(TIMER_GESTURE);

    // Held, it plays again only once the hold has run out: 2294 ms is 287 ticks.
    const held = run(286, { buttons: BUTTON_GESTURE });
    expect(held.includes(EV.TAUNT)).toBe(false);
    expect(torso()).toBe(ANIM.TORSO_GESTURE);
    expect(run(1, { buttons: BUTTON_GESTURE }).includes(EV.TAUNT)).toBe(true);
  });

  it('stands again once a gesture has run out', () => {
    run(5);
    run(1, { buttons: BUTTON_GESTURE });
    run(287);
    expect(torso()).toBe(ANIM.TORSO_STAND);
  });
});

describe('a respawned player (PMF_RESPAWNED)', () => {
  it('neither fires nor jumps until attack is let go', () => {
    run(5);
    state.pmFlags |= PMF_RESPAWNED;

    const held = run(20, { buttons: BUTTON_ATTACK, ...JUMP });
    expect(held.some((event) => event === EV.FIRE_WEAPON || event === EV.JUMP)).toBe(false);
    expect(state.eFlags & EF_FIRING).toBe(0);
    expect(state.pmFlags & PMF_RESPAWNED).toBeTruthy();

    // Let go, and the same tick can jump.
    expect(run(1, JUMP)).toContain(EV.JUMP);
    expect(state.pmFlags & PMF_RESPAWNED).toBeFalsy();
    untilLanded();
    expect(run(1, { buttons: BUTTON_ATTACK }).includes(EV.FIRE_WEAPON)).toBe(true);
  });

  it('neither uses nor lets go of the flag until the use key is up too', () => {
    // "clear the respawned flag if attack and use are cleared" (`bg_pmove.c:1872–1876`): a
    // respawn's key that is still down counts, use key and all, so the click that respawns
    // cannot also be the click that takes a medkit.
    run(5);
    state.pmFlags |= PMF_RESPAWNED;
    state.stats[STAT.HOLDABLE_ITEM] = itemIndex(findItem('holdable_medkit')!);
    state.stats[STAT.HEALTH] = 50;

    const held = run(2, { buttons: BUTTON_USE_HOLDABLE });
    expect(held).toEqual([]);
    expect(state.pmFlags & PMF_RESPAWNED).toBeTruthy();
    expect(state.stats[STAT.HOLDABLE_ITEM]).not.toBe(0);

    // With the key up the flag goes, and the next press uses the medkit.
    run(1);
    expect(state.pmFlags & PMF_RESPAWNED).toBeFalsy();
    expect(run(1, { buttons: BUTTON_USE_HOLDABLE })).toEqual([EV.USE_ITEM0 + HI.MEDKIT]);
  });
});

describe('a talking player (BUTTON_TALK)', () => {
  it('carries the balloon while the button is down, and takes no other key', () => {
    run(5);
    const events = run(20, { ...FORWARD, ...JUMP, buttons: BUTTON_TALK | BUTTON_ATTACK });

    expect(state.eFlags & EF_TALK).toBe(EF_TALK);
    expect(events.some((event) => event === EV.JUMP || event === EV.FIRE_WEAPON)).toBe(false);
    expect(state.velocity.x).toBe(0);
    // The firing flag is read before talking takes the keys, as `bg_pmove.c` orders the two.
    expect(state.eFlags & EF_FIRING).toBe(EF_FIRING);

    run(1, FORWARD);
    expect(state.eFlags & EF_TALK).toBe(0);
    expect(state.velocity.x).toBeGreaterThan(0);
  });

  it('keeps the button down through every tick of a long command', () => {
    run(5);
    const cmd = createUserCmd({
      ...FORWARD,
      buttons: BUTTON_TALK,
      serverTime: state.commandTime + 4 * PMOVE_MSEC
    });
    pmove(state, cmd, flat);
    expect(state.eFlags & EF_TALK).toBe(EF_TALK);
    expect(state.velocity.x).toBe(0);
  });
});

describe('a dead player (PM_DEAD)', () => {
  /** A corpse on the floor, facing yaw 45. */
  function dead(overrides: Partial<PlayerState> = {}): PlayerState {
    const ps = createArmedPlayerState({
      origin: vec3(0, 0, GROUND_Z),
      weapon: WP.MACHINEGUN,
      pmType: PM_DEAD,
      viewangles: vec3(0, 45, 0),
      legsAnim: ANIM.BOTH_DEATH1,
      torsoAnim: ANIM.BOTH_DEATH1,
      ...overrides
    });
    ps.stats[STAT.HEALTH] = -10;
    return ps;
  }

  it('takes no input, turns no view, and holds nothing', () => {
    state = dead();
    const events = run(20, {
      ...FORWARD,
      ...JUMP,
      buttons: BUTTON_ATTACK,
      angles: vec3(10, 200, 0)
    });

    expect(state.velocity.x).toBe(0);
    expect(events.some((event) => event === EV.JUMP || event === EV.FIRE_WEAPON)).toBe(false);
    expect(state.viewangles).toEqual(vec3(0, 45, 0));
    expect(state.weapon).toBe(WP.NONE);
    expect(state.eFlags & EF_FIRING).toBe(0);
  });

  it('lies at the floor, with the eye below the box', () => {
    state = dead();
    run(1, CROUCH);
    expect(state.viewheight).toBe(DEAD_VIEWHEIGHT);
  });

  it('keeps playing its death whatever the move does', () => {
    state = dead({ origin: vec3(0, 0, GROUND_Z + 100) });
    untilLanded();
    run(20);
    expect(legs()).toBe(ANIM.BOTH_DEATH1);
    expect(torso()).toBe(ANIM.BOTH_DEATH1);
  });

  it('loses 20 ups a tick on the ground, on top of friction', () => {
    state = dead();
    run(1);
    state.velocity = vec3(300, 0, 0);
    run(1);
    // 300 − 20, then ground friction takes 4.8% of the 280, and the snap rounds.
    expect(state.velocity.x).toBe(267);

    run(20);
    expect(state.velocity.x).toBe(0);
  });

  it('raises no pain grunt on a medium landing, but still the far one', () => {
    state = dead({ origin: vec3(0, 0, GROUND_Z + 300) });
    const medium = run(200);
    expect(medium).not.toContain(EV.FALL_MEDIUM);

    state = dead({ origin: vec3(0, 0, GROUND_Z + 450) });
    expect(run(200)).toContain(EV.FALL_FAR);
  });
});
