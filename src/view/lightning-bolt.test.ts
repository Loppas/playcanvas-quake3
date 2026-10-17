import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { box, createFlatWorldTrace } from '../sim/box-world';
import { BUTTON_ATTACK, MASK, PMOVE_MSEC } from '../sim/constants';
import { distinctAsks, recordingTrace } from '../sim/trace-test-fixtures';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { LIGHTNING_RANGE, MUZZLE_FORWARD, WP, type WeaponId } from '../sim/weapons/constants';
import { lightningBolt } from './effects';
import type { PlayerView } from './player-view';
import { CATCH_UP, ViewWorld } from './view-test-fixtures';
import { MUZZLE_FLASH_MS, flashVisible } from './viewmodel';

/**
 * The lightning gun's bolt: one trace a frame from the current view, drawn
 * exactly when the gun's flash is — `CG_AddPlayerWeapon` into `CG_LightningBolt`.
 */

const FRAME_MSEC = 1000 / 60;
/** A wall across the view 256 units ahead, inside the lightning's 768. */
const walled = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);

describe('lightningBolt', () => {
  it('runs from 14 units ahead of the eye to its full range when nothing is in the way', () => {
    const bolt = lightningBolt(vec3(0, 0, 24), vec3(), 26, createFlatWorldTrace(), 0);
    expect(bolt.hit).toBe(false);
    expect(bolt.end.x).toBeCloseTo(MUZZLE_FORWARD + LIGHTNING_RANGE, 6);
    expect(bolt.end.z).toBeCloseTo(50, 6);
  });

  it('stops at the first wall in the way', () => {
    const bolt = lightningBolt(vec3(0, 0, 24), vec3(), 26, walled, 0);
    expect(bolt.hit).toBe(true);
    expect(bolt.end.x).toBeCloseTo(256, 0);
  });
});

describe('flashVisible', () => {
  it('flashes the beam weapons for as long as EF_FIRING, and any weapon for 20 ms a shot', () => {
    expect(flashVisible(WP.LIGHTNING, true, 1000)).toBe(true);
    expect(flashVisible(WP.LIGHTNING, false, 1000)).toBe(false);
    expect(flashVisible(WP.ROCKET_LAUNCHER, true, 1000)).toBe(false);
    expect(flashVisible(WP.ROCKET_LAUNCHER, false, MUZZLE_FLASH_MS - 1)).toBe(true);
  });
});

describe('PlayerView.lightningBolt', () => {
  let state: PlayerState;
  let view: PlayerView;

  function arm(weapon: WeaponId = WP.LIGHTNING): void {
    const world = new ViewWorld({ origin: vec3(0, 0, 24), trace: walled });
    state = world.state;
    state.weapon = weapon;
    view = world.view;
    // One tick with nothing held, to clear the `PMF_RESPAWNED` that stops a fresh spawn firing
    // before it has let go of everything (`bg_pmove.c:1543–1546`).
    view.advance(PMOVE_MSEC, cmd(false));
  }

  /** One frame's input, holding the weapon already in hand. */
  function cmd(attack: boolean, rightmove = 0): Omit<UserCmd, 'serverTime'> {
    return {
      forwardmove: 0,
      rightmove,
      upmove: 0,
      angles: vec3(),
      buttons: attack ? BUTTON_ATTACK : 0,
      weapon: state.weapon
    };
  }

  it('is drawn only while the flash is: fire held, and a moment after the last shot', () => {
    arm();
    view.advance(FRAME_MSEC, cmd(false));
    expect(view.lightningBolt()).toBeNull();
    // Drawn once the snapshot that has the player firing is.
    for (let i = 0; i < 1 + CATCH_UP; i++) view.advance(FRAME_MSEC, cmd(true));
    expect(view.lightningBolt()?.hit).toBe(true);
    // Released: the flag drops with the snapshot that has it down, and the last shot's 20 ms flash
    // runs out.
    for (let i = 0; i < 3 + CATCH_UP; i++) view.advance(FRAME_MSEC, cmd(false));
    expect(view.lightningBolt()).toBeNull();
  });

  it('follows the player every frame, not only on the frames a shot is fired', () => {
    arm();
    // Strafing while firing: the gun fires every 50 ms, and a frame is 17.
    for (let frame = 0; frame < CATCH_UP; frame++) view.advance(FRAME_MSEC, cmd(true, 127));
    for (let frame = 0; frame < 12; frame++) {
      view.advance(FRAME_MSEC, cmd(true, 127));
      const bolt = view.lightningBolt()!;
      // Straight ahead from wherever the camera is this frame.
      expect(bolt.end.y, `frame ${frame}`).toBeCloseTo(view.sample().origin.y, 6);
    }
    // And the strafe really did move it.
    expect(view.sample().origin.y).toBeLessThan(-10);
  });

  it("is traced past the player it is drawn for, who is the view's own", () => {
    const { trace, asked } = recordingTrace(walled);
    const world = new ViewWorld({ origin: vec3(0, 0, 24), trace });
    state = world.state;
    state.weapon = WP.LIGHTNING;
    view = world.view;
    view.advance(PMOVE_MSEC, cmd(false));
    for (let i = 0; i < 1 + CATCH_UP; i++) view.advance(FRAME_MSEC, cmd(true));

    asked.length = 0;
    expect(view.lightningBolt()).not.toBeNull();

    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: world.game.clientNum, contentmask: MASK.SHOT }
    ]);
  });

  it('is never drawn for another weapon', () => {
    arm(WP.RAILGUN);
    view.advance(FRAME_MSEC, cmd(true));
    expect(view.lightningBolt()).toBeNull();
  });
});

describe("the bolt's trace", () => {
  it('passes the player firing it and stops at MASK_SHOT, as CG_LightningBolt traces', () => {
    const { trace, asked } = recordingTrace(walled);

    lightningBolt(vec3(0, 0, 24), vec3(), 26, trace, 5);

    expect(distinctAsks(asked)).toEqual([{ passEntityNum: 5, contentmask: MASK.SHOT }]);
  });
});
