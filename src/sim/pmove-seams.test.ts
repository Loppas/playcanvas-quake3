import { beforeEach, describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { createFlatWorldTrace } from './box-world';
import {
  BUTTON_ATTACK,
  EF_FIRING,
  MINS_Z,
  PMOVE_MSEC,
  PM_DUCK_SCALE,
  PM_SPECTATOR
} from './constants';
import { Pmove, pmove } from './pmove';
import { createIdlePlayerState, createUserCmd, type UserCmd } from './types';
import { vec3, type Vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * The move's steps, which a class extending {@link Pmove} replaces. Each test shows the move takes
 * a step from where a replacement would put it, so replacing the step changes the move.
 */

/** Origin height at which a standing player rests on a floor whose surface is z = 0. */
const GROUND_Z = -MINS_Z;

const trace = createFlatWorldTrace();

let state: PlayerState;

beforeEach(() => {
  state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
});

/**
 * Run `ticks` ticks of {@link PMOVE_MSEC} with `core` as the move.
 *
 * @param core - The class to move with.
 * @param ticks - How many ticks.
 * @param input - Input held for every tick.
 */
function run(core: typeof Pmove, ticks: number, input: Partial<UserCmd> = {}): void {
  for (let i = 0; i < ticks; i++) {
    pmove(state, createUserCmd({ ...input, serverTime: state.commandTime + PMOVE_MSEC }), trace, {
      core
    });
  }
}

const horizontalSpeed = () => Math.hypot(state.velocity.x, state.velocity.y);

/** The steps a spy has been through, in order. */
const calls: string[] = [];

/** id's move, noting each step as it takes it. */
class Spy extends Pmove {
  protected buttonFlags() {
    calls.push('buttonFlags');
    super.buttonFlags();
  }
  protected moveTimers() {
    calls.push('moveTimers');
    super.moveTimers();
  }
  protected friction() {
    calls.push('friction');
    super.friction();
  }
  protected groundFriction(speed: number) {
    calls.push('groundFriction');
    return super.groundFriction(speed);
  }
  protected duckWishSpeed(wishspeed: number) {
    calls.push('duckWishSpeed');
    return super.duckWishSpeed(wishspeed);
  }
  protected walkAccelerate(knockedBack: boolean) {
    calls.push('walkAccelerate');
    return super.walkAccelerate(knockedBack);
  }
  protected clipToGround(normal: Vec3) {
    calls.push('clipToGround');
    super.clipToGround(normal);
  }
  protected airAccelerate(wishdir: Vec3, wishspeed: number) {
    calls.push('airAccelerate');
    super.airAccelerate(wishdir, wishspeed);
  }
  protected jumpVelocity() {
    calls.push('jumpVelocity');
    return super.jumpVelocity();
  }
  protected stepSlideMove(gravity: boolean) {
    calls.push('stepSlideMove');
    super.stepSlideMove(gravity);
  }
  protected weapon() {
    calls.push('weapon');
    super.weapon();
  }
  protected snap() {
    calls.push('snap');
    super.snap();
  }
}

describe('the steps', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("are taken in PmoveSingle's order on a walking tick", () => {
    run(Spy, 1);
    state.velocity = vec3(100, 0, 0);
    calls.length = 0;

    run(Spy, 1, { forwardmove: 127 });

    expect(calls).toEqual([
      'buttonFlags',
      'moveTimers',
      'friction',
      'groundFriction',
      'duckWishSpeed',
      'walkAccelerate',
      'clipToGround',
      'stepSlideMove',
      'weapon',
      'snap'
    ]);
  });

  it('take the jump and the air move on the tick a jump leaves the ground', () => {
    run(Spy, 1);
    calls.length = 0;

    run(Spy, 1, { upmove: 127 });

    expect(calls).toEqual([
      'buttonFlags',
      'moveTimers',
      'jumpVelocity',
      'friction',
      'airAccelerate',
      'stepSlideMove',
      'weapon',
      'snap'
    ]);
  });

  it("leave a spectator's move without the player's timers, the weapon or the snap", () => {
    state.pmType = PM_SPECTATOR;
    run(Spy, 1, { forwardmove: 127 });
    expect(calls).toEqual(['buttonFlags', 'friction', 'stepSlideMove']);
  });
});

describe('a class extending the move', () => {
  it('jumps at the speed its jumpVelocity gives', () => {
    class High extends Pmove {
      protected jumpVelocity() {
        return 400;
      }
    }
    run(High, 1);
    run(High, 1, { upmove: 127 });
    // One tick's gravity comes off before the snap.
    expect(state.velocity.z).toBe(Math.round(400 - state.gravity * PMOVE_MSEC * 0.001));
  });

  it('keeps the velocity its snap leaves', () => {
    class Unsnapped extends Pmove {
      protected snap() {}
    }
    run(Unsnapped, 1);
    run(Unsnapped, 1, { upmove: 127 });
    expect(Number.isInteger(state.velocity.z)).toBe(false);
  });

  it('slides for as long as its groundFriction lets it', () => {
    class Ice extends Pmove {
      protected groundFriction() {
        return 0;
      }
    }
    run(Ice, 1);
    state.velocity = vec3(200, 0, 0);
    run(Ice, 50);
    expect(horizontalSpeed()).toBe(200);
  });

  it('walks, runs in the air and crouches at what its steps say', () => {
    class Stuck extends Pmove {
      protected walkAccelerate() {
        return 0;
      }
    }
    run(Stuck, 50, { forwardmove: 127 });
    expect(horizontalSpeed()).toBe(0);

    class Grounded extends Pmove {
      protected airAccelerate() {}
    }
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z + 500) });
    run(Grounded, 20, { forwardmove: 127 });
    expect(horizontalSpeed()).toBe(0);

    class Upright extends Pmove {
      protected duckWishSpeed(wishspeed: number) {
        return wishspeed;
      }
    }
    state = createIdlePlayerState({ origin: vec3(0, 0, GROUND_Z) });
    run(Upright, 150, { forwardmove: 127, upmove: -127 });
    expect(horizontalSpeed()).toBeGreaterThan(state.speed * PM_DUCK_SCALE);
  });

  it('moves along the ground as its clipToGround leaves the velocity', () => {
    class Glued extends Pmove {
      protected clipToGround() {
        this.state.velocity = vec3();
      }
    }
    run(Glued, 50, { forwardmove: 127 });
    expect(state.origin.x).toBe(0);
  });

  it('flags the firing as its buttonFlags does', () => {
    class Unflagged extends Pmove {
      protected buttonFlags() {}
    }
    state.weapon = WP.MACHINEGUN;
    state.ammo[WP.MACHINEGUN] = 50;
    run(Unflagged, 1, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    expect(state.eFlags & EF_FIRING).toBe(0);

    run(Pmove, 1, { buttons: BUTTON_ATTACK, weapon: WP.MACHINEGUN });
    expect(state.eFlags & EF_FIRING).toBe(EF_FIRING);
  });
});
