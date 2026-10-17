import { describe, expect, it } from 'vitest';
import { STAT } from '../sim/constants';
import { createArmedPlayerState } from '../sim/types';
import { AMMO_INFINITE, MAX_WEAPONS, WP } from '../sim/weapons/constants';
import {
  SELECTABLE_WEAPONS,
  WEAPON_NAMES,
  cycleWeapon,
  weaponCommand,
  weaponForSlot,
  weaponSelectable,
  type Loadout
} from './weapon-select';

/** A {@link Loadout} whose ammo the tests can still edit, to take a weapon away. */
type MutableLoadout = Loadout & { ammo: number[] };

/** The loadout the player actually spawns with: everything owned, infinite ammo. */
function fullLoadout(): MutableLoadout {
  const state = createArmedPlayerState();
  return { weapons: state.stats[STAT.WEAPONS], ammo: state.ammo };
}

/** A loadout holding only the listed weapons, each with infinite ammo. */
function holding(...weapons: number[]): MutableLoadout {
  const ammo = new Array<number>(MAX_WEAPONS).fill(0);
  let bits = 0;
  for (const weapon of weapons) {
    bits |= 1 << weapon;
    ammo[weapon] = AMMO_INFINITE;
  }
  return { weapons: bits, ammo };
}

describe('weaponSelectable', () => {
  it('accepts the infinite-ammo sentinel exactly as a full clip', () => {
    // `CG_WeaponSelectable` tests `!ps.ammo[i]`, and -1 is truthy. The spawn loadout leans on this.
    expect(weaponSelectable(fullLoadout(), WP.RAILGUN)).toBe(true);
  });

  it('rejects a weapon that is owned but empty', () => {
    const loadout = holding(WP.RAILGUN);
    loadout.ammo[WP.RAILGUN] = 0;
    expect(weaponSelectable(loadout, WP.RAILGUN)).toBe(false);
  });

  it('rejects a weapon that is not owned, and ids outside the table', () => {
    expect(weaponSelectable(holding(WP.SHOTGUN), WP.RAILGUN)).toBe(false);
    expect(weaponSelectable(fullLoadout(), WP.NONE)).toBe(false);
    expect(weaponSelectable(fullLoadout(), MAX_WEAPONS)).toBe(false);
  });
});

describe('cycleWeapon', () => {
  it('walks the full loadout in order and wraps', () => {
    const loadout = fullLoadout();
    const seen: number[] = [];
    let weapon: number = WP.MACHINEGUN;
    for (let i = 0; i < SELECTABLE_WEAPONS.length; i++) {
      seen.push(weapon);
      weapon = cycleWeapon(weapon, loadout, 1);
    }
    expect(seen).toEqual([
      WP.MACHINEGUN,
      WP.SHOTGUN,
      WP.GRENADE_LAUNCHER,
      WP.ROCKET_LAUNCHER,
      WP.LIGHTNING,
      WP.RAILGUN,
      WP.PLASMAGUN,
      WP.BFG
    ]);
    // One more step is back to the start: the hook and the gauntlet are both stepped over.
    expect(weapon).toBe(WP.MACHINEGUN);
  });

  it('runs the same circuit backwards', () => {
    const loadout = fullLoadout();
    expect(cycleWeapon(WP.MACHINEGUN, loadout, -1)).toBe(WP.BFG);
    expect(cycleWeapon(WP.ROCKET_LAUNCHER, loadout, -1)).toBe(WP.GRENADE_LAUNCHER);
  });

  it('never stops on the gauntlet or the off-hand hook', () => {
    const loadout = fullLoadout();
    for (const direction of [1, -1] as const) {
      let weapon: number = WP.MACHINEGUN;
      for (let i = 0; i < 40; i++) {
        weapon = cycleWeapon(weapon, loadout, direction);
        expect(weapon).not.toBe(WP.GAUNTLET);
        expect(weapon).not.toBe(WP.GRAPPLING_HOOK);
      }
    }
  });

  it('leaves the selection alone when nothing else is available', () => {
    // A full pass finds no candidate, so `CG_NextWeapon_f` restores the original rather than
    // leaving the player holding nothing.
    expect(cycleWeapon(WP.SHOTGUN, holding(WP.SHOTGUN), 1)).toBe(WP.SHOTGUN);
    // Owning only excluded weapons is the same case, not an infinite loop.
    expect(cycleWeapon(WP.GAUNTLET, holding(WP.GAUNTLET, WP.GRAPPLING_HOOK), 1)).toBe(
      WP.GAUNTLET
    );
  });

  it('skips over weapons that are out of ammo', () => {
    const loadout = fullLoadout();
    loadout.ammo[WP.SHOTGUN] = 0;
    expect(cycleWeapon(WP.MACHINEGUN, loadout, 1)).toBe(WP.GRENADE_LAUNCHER);
  });
});

describe('weaponForSlot', () => {
  it('maps the number row onto the weapon ids themselves', () => {
    const loadout = fullLoadout();
    expect(weaponForSlot(1, loadout)).toBe(WP.GAUNTLET);
    expect(weaponForSlot(5, loadout)).toBe(WP.ROCKET_LAUNCHER);
    expect(weaponForSlot(9, loadout)).toBe(WP.BFG);
  });

  it('has no slot for the off-hand hook, or for anything off the row', () => {
    const loadout = fullLoadout();
    expect(weaponForSlot(0, loadout)).toBeNull();
    expect(weaponForSlot(10, loadout)).toBeNull();
  });

  it('refuses a slot the player cannot use', () => {
    expect(weaponForSlot(7, holding(WP.MACHINEGUN))).toBeNull();
  });

  it('reaches the gauntlet, which only the number row can select', () => {
    // The cycle skips it deliberately; slot 1 is the only way back to it, exactly as in Q3.
    expect(weaponForSlot(1, fullLoadout())).toBe(WP.GAUNTLET);
  });
});

describe('weaponCommand', () => {
  it('asks for weapon N, and shows the bar, as CG_Weapon_f does', () => {
    expect(weaponCommand(['weapon', '5'], WP.MACHINEGUN, fullLoadout())).toEqual({
      weapon: WP.ROCKET_LAUNCHER,
      shown: true
    });
  });

  it('shows the bar for a weapon the player cannot use, and keeps the one asked for', () => {
    expect(weaponCommand(['weapon', '7'], WP.MACHINEGUN, holding(WP.MACHINEGUN))).toEqual({
      weapon: WP.MACHINEGUN,
      shown: true
    });
    // The hook is weapon 10, which is never asked for.
    expect(weaponCommand(['weapon', '10'], WP.MACHINEGUN, fullLoadout())).toEqual({
      weapon: WP.MACHINEGUN,
      shown: true
    });
  });

  it('does nothing, not even the bar, for a number that is no weapon', () => {
    for (const arg of ['0', String(MAX_WEAPONS), 'rail', '']) {
      expect(weaponCommand(['weapon', arg], WP.MACHINEGUN, fullLoadout()), arg).toEqual({
        weapon: WP.MACHINEGUN,
        shown: false
      });
    }
  });

  it('steps round the loadout for weapnext and weapprev, in any case', () => {
    const loadout = fullLoadout();
    expect(weaponCommand(['weapnext'], WP.MACHINEGUN, loadout)).toEqual({ weapon: WP.SHOTGUN, shown: true });
    expect(weaponCommand(['WEAPPREV'], WP.MACHINEGUN, loadout)).toEqual({ weapon: WP.BFG, shown: true });
  });

  it('takes no other command', () => {
    expect(weaponCommand(['toggle', 'cg_gibs'], WP.MACHINEGUN, fullLoadout())).toBeNull();
  });
});

describe('WEAPON_NAMES', () => {
  it('names every weapon the player can hold', () => {
    for (const weapon of SELECTABLE_WEAPONS) {
      expect(WEAPON_NAMES[weapon]).toBeTruthy();
    }
    expect(WEAPON_NAMES[WP.BFG]).toBe('BFG10K');
  });
});
