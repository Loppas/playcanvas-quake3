import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import {
  BUTTON_AFFIRMATIVE,
  BUTTON_ATTACK,
  PMF_GRAPPLE_PULL,
  PMOVE_MSEC
} from '../sim/constants';
import { EV, eventNumber } from '../sim/events';
import type { UserCmd } from '../sim/types';
import { length, vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { GRAPPLE_TYPES, Q3_GRAPPLE_SPEED, type GrappleMode } from '../sim/weapons/grapple';
import { firingSolution } from '../sim/weapons/hitscan';
import type { WorldEffect } from './entity-events';
import type { PlayerView } from './player-view';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';

/**
 * The off-hand hook through the frame loop, the seam that puts the hook's
 * simulation into the game. `grapple.test.ts` drives the hook a tick at a time; these drive it as
 * the app does, through `PlayerView.advance`, with the key held or not.
 */

/** A wall across the view, its near face 500 units ahead. */
const room = createFlatWorldTrace([box(500, -400, 0, 520, 400, 600)]);

/** A 60 Hz frame. */
const FRAME_MSEC = 1000 / 60;

let world: ViewWorld;
let state: PlayerState;
let view: PlayerView;

/** `g_allowGrapple`'s value for a style, as CorkScrew's server menu numbers them. */
function grappleType(mode: GrappleMode): number {
  return GRAPPLE_TYPES.findIndex((type) => type.mode === mode);
}

/** Stand the player at the origin, facing the wall, with a hook and the weapon given. */
function setup(mode: GrappleMode = 'q3pull', weapon: WeaponId = WP.MACHINEGUN): void {
  world = new ViewWorld({
    origin: vec3(0, 0, 24),
    trace: room,
    cvars: { g_allowGrapple: String(grappleType(mode)) }
  });
  state = world.state;
  state.weapon = weapon;
  view = world.view;
  // One tick with nothing held, to clear the `PMF_RESPAWNED` that stops a fresh spawn firing
  // before it has let go of everything (`bg_pmove.c:1543–1546`).
  view.advance(PMOVE_MSEC, cmd(false));
}

/** How the hook is doing, read off the world as a client reads it. */
function phase(): 'idle' | 'flying' | 'attached' {
  return world.hookPhase();
}

/**
 * One frame's input: standing still with the weapon in hand, the grapple key held or not and
 * attack held or not.
 *
 * Both are bits of one number, which is the whole of what a user command says about keys:
 * `+attack` is bit 0 and CorkScrew's `+button5` is bit 5.
 */
function cmd(held: boolean, attack = false): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: (held ? BUTTON_AFFIRMATIVE : 0) | (attack ? BUTTON_ATTACK : 0),
    weapon: state.weapon
  };
}

/** Run frames with the grapple key held or not, and collect what the world showed. */
function frames(count: number, held: boolean, attack = false): WorldEffect[] {
  const effects: WorldEffect[] = [];
  for (let i = 0; i < count; i++) {
    view.advance(FRAME_MSEC, cmd(held, attack));
    effects.push(...view.effects);
  }
  return effects;
}

/**
 * Hold the key until the hook catches the wall, and then until the view has drawn the catch.
 *
 * @param drawn - Wait for the view; without it, only for the match, whose own state is read.
 */
function catchWall(drawn = true): WorldEffect[] {
  const effects: WorldEffect[] = [];
  for (let i = 0; i < 120; i++) {
    effects.push(...frames(1, true));
    if (phase() !== 'attached') continue;
    return drawn ? [...effects, ...frames(CATCH_UP, true)] : effects;
  }
  throw new Error('the hook never caught the wall');
}

describe('the grapple key', () => {
  it('does nothing while it is up', () => {
    setup();
    expect(frames(60, false)).toEqual([]);
    expect(view.grappleHooks()).toEqual([]);
    expect(state.pmFlags & PMF_GRAPPLE_PULL).toBeFalsy();
  });

  it('fires the hook, which catches the wall and pulls the player to it', () => {
    setup();
    frames(1, true);
    expect(phase()).toBe('flying');
    catchWall();
    expect(state.pmFlags & PMF_GRAPPLE_PULL).toBeTruthy();

    const before = state.origin.x;
    frames(10, true);
    expect(state.origin.x).toBeGreaterThan(before);
    expect(state.velocity.x).toBeGreaterThan(0);
  });

  it('lets go the moment it comes up', () => {
    setup();
    catchWall();
    frames(1 + CATCH_UP, false);
    expect(phase()).toBe('idle');
    expect(state.pmFlags & PMF_GRAPPLE_PULL).toBeFalsy();
    expect(view.grappleHooks()).toEqual([]);
  });

  it('leaves the weapon in hand, still firing, while the hook pulls', () => {
    setup();
    catchWall();
    let shots = 0;
    for (let i = 0; i < 30; i++) {
      shots += view
        .advance(FRAME_MSEC, cmd(true, true))
        .filter(({ event }) => eventNumber(event) === EV.FIRE_WEAPON).length;
    }
    expect(shots).toBeGreaterThan(0);
    expect(state.weapon).toBe(WP.MACHINEGUN);
    expect(state.pmFlags & PMF_GRAPPLE_PULL).toBeTruthy();
  });
});

describe('where the hook leaves from', () => {
  it('is the muzzle the tick ended at, because `FireWeapon` runs after the move', () => {
    // `Weapon_GrapplingHook_Fire` is one of `FireWeapon`'s cases, so a hook is thrown from
    // where the move left the player rather than from where it found them.
    setup();
    state.velocity = vec3(400, 0, 0);
    const before = firingSolution(state.origin, state.viewangles, state.viewheight).muzzle;

    // One tick exactly, so the origin the assertion reads is that tick's own.
    view.advance(8, cmd(true));
    const after = firingSolution(state.origin, state.viewangles, state.viewheight).muzzle;

    expect(state.origin.x).toBeGreaterThan(1);
    expect(world.hook()!.s.pos.trBase).toEqual(after);
    expect(world.hook()!.s.pos.trBase).not.toEqual(before);
  });
});

describe('the catch as the client reads it', () => {
  it('arrives as an impact in the world, drawn as the lightning gun draws its own', () => {
    setup();
    const effects = catchWall();
    const impacts = effects.filter((effect) => effect.type === 'impact');

    expect(impacts).toHaveLength(1);
    const [impact] = impacts;
    if (impact.type !== 'impact') throw new Error('not an impact');
    // The catch names no weapon, and `CG_MissileHitWall`'s default is the lightning gun's case.
    expect(impact.weapon).toBe(WP.LIGHTNING);
    // Against the wall, facing back down −X, where the anchor is.
    expect(impact.origin.x).toBe(499);
    expect(impact.normal.x).toBeLessThan(-0.98);
    expect(length(impact.normal)).toBeCloseTo(1, 1);
  });

  it('says nothing more for as long as the hook is held', () => {
    setup();
    catchWall();
    expect(frames(60, true)).toEqual([]);
  });
});

describe('the hook as drawn', () => {
  it("follows the hook, and carries the shot's muzzle point for the pointer", () => {
    setup();
    frames(1 + CATCH_UP, true);
    const [launched] = view.grappleHooks();
    expect(launched.owner).toBe(state.clientNum);
    // `CalcMuzzlePoint`: 14 units along the view from the eye, truncated.
    expect(launched.muzzle).toEqual(vec3(14, 0, 50));

    frames(10, true);
    expect(view.grappleHooks()[0].position.x).toBeGreaterThan(launched.position.x);
  });

  it('is not drawn for a rocket, which is a missile like it and is not one', () => {
    // A hook is an `ET_MISSILE` while it flies, so what tells one from a rocket is the weapon on
    // its entity state - the same field that decides which impact a client draws.
    setup('q3pull', WP.ROCKET_LAUNCHER);
    frames(1 + CATCH_UP, false, true);
    expect(view.missiles().length).toBeGreaterThan(0);
    expect(view.grappleHooks()).toEqual([]);
  });

  it('stays where it caught', () => {
    setup();
    catchWall();
    expect(view.grappleHooks()[0].position.x).toBeCloseTo(499, 0);
  });

  it('is drawn whoever threw it, from where the hook is while they are not drawn', () => {
    setup();
    frames(1 + CATCH_UP, true);

    // `fire_grapple` writes the thrower into `s.otherEntityNum`, "use to match beam in client":
    // a hook from a slot nobody is in has no body for its pointer to start on.
    world.hook()!.s.otherEntityNum = 5;
    frames(1 + CATCH_UP, true);
    const [theirs] = view.grappleHooks();
    expect(theirs.owner).toBe(5);
    expect(theirs.muzzle).toEqual(theirs.position);
  });
});

describe("CorkScrew's own style", () => {
  it('accelerates the player toward the anchor, where Quake III sets the speed outright', () => {
    const speedOnCatching = (mode: GrappleMode) => {
      setup(mode);
      catchWall(false);
      // The hook catches inside the frame, and the move that acts on the pull it set up is the
      // next think's: a command runs against the world as the last frame left it.
      frames(1, true);
      return length(state.velocity);
    };
    // The first move under the pull: Quake III is already at its full 800; CorkScrew has had the
    // two ticks a 60 Hz frame covers of `PM_Accelerate`, at most 128 a tick, and so is nowhere
    // near it.
    expect(speedOnCatching('q3pull')).toBeGreaterThan(700);
    expect(speedOnCatching('corkscrew')).toBeLessThan(Q3_GRAPPLE_SPEED / 2);
  });

  it('still draws the player all the way to the wall', () => {
    setup('corkscrew');
    catchWall();
    const x = state.origin.x;
    frames(60, true);
    expect(state.origin.x).toBeGreaterThan(x + 200);
  });
});

describe('the Q2 winch', () => {
  it('hard-sets 650 toward the hook after the move, sagging by one tick of gravity', () => {
    setup('q2winch');
    catchWall(false);
    frames(1, true);
    // `CTFGrapplePull`: 650 along the line to the hook, then one 8 ms tick of gravity off z.
    const { x, y, z } = state.velocity;
    expect(length(vec3(x, y, z + state.gravity * 0.008))).toBeCloseTo(650, 6);
    expect(x).toBeGreaterThan(600);
  });
});
