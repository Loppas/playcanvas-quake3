import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { createFlatWorldTrace } from './box-world';
import { BUTTON_ATTACK, EF_FIRING, PMOVE_MSEC } from './constants';
import { pmove } from './pmove';
import { createArmedPlayerState } from './types';
import { vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * `EF_FIRING`, the flag every continuous effect of a held trigger is drawn from:
 * `PmoveSingle` sets it at the start of each move while attack is held with ammo.
 */

const flat = createFlatWorldTrace();

/** One tick, with or without attack held. */
function tick(state: PlayerState, attack: boolean): void {
  pmove(
    state,
    {
      serverTime: state.commandTime + PMOVE_MSEC,
      forwardmove: 0,
      rightmove: 0,
      upmove: 0,
      angles: vec3(),
      buttons: attack ? BUTTON_ATTACK : 0,
      weapon: state.weapon
    },
    flat
  );
}

describe('EF_FIRING', () => {
  it('is set while attack is held, and cleared the tick it is released', () => {
    const state = createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.LIGHTNING });
    tick(state, false);
    expect(state.eFlags & EF_FIRING).toBe(0);
    tick(state, true);
    expect(state.eFlags & EF_FIRING).toBe(EF_FIRING);
    tick(state, true);
    expect(state.eFlags & EF_FIRING).toBe(EF_FIRING);
    tick(state, false);
    expect(state.eFlags & EF_FIRING).toBe(0);
  });

  it('is not set with an empty clip', () => {
    const state = createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.LIGHTNING });
    state.ammo[WP.LIGHTNING] = 0;
    tick(state, true);
    expect(state.eFlags & EF_FIRING).toBe(0);
  });

  it('follows the trigger, not the shot: it is set mid-cooldown too', () => {
    // `PM_Weapon` fires nothing while the weapon is busy, but the trigger is still held.
    const state = createArmedPlayerState({
      origin: vec3(0, 0, 24),
      weapon: WP.RAILGUN,
      weaponTime: 1000
    });
    tick(state, true);
    expect(state.eFlags & EF_FIRING).toBe(EF_FIRING);
  });
});
