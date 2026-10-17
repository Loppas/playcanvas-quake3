import { describe, expect, it } from 'vitest';

import { WEAPON_ASSETS } from '../formats/asset-manifest';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { playsFireSound, weaponLoop } from './weapon-sounds';

/**
 * The weapon loops and fire sounds of `CG_AddPlayerWeapon` and `CG_FireWeapon`,
 * checked against the manifest's own entries.
 */

const sounds = (weapon: WeaponId) => WEAPON_ASSETS.find((asset) => asset.id === weapon);

describe('weaponLoop', () => {
  it('hums the lightning gun with fsthum in the hand, and lg_hum only while it fires', () => {
    expect(weaponLoop(sounds(WP.LIGHTNING), false)).toBe('sound/weapons/melee/fsthum.wav');
    expect(weaponLoop(sounds(WP.LIGHTNING), true)).toBe('sound/weapons/lightning/lg_hum.wav');
  });

  it('runs the gauntlet while fire is held, and loops nothing in the hand', () => {
    // `CG_RegisterWeapon` gives the gauntlet a firing sound and no ready sound
    // (`cg_weapons.c:675-679`), so it has no idle hum.
    expect(weaponLoop(sounds(WP.GAUNTLET), false)).toBeUndefined();
    expect(weaponLoop(sounds(WP.GAUNTLET), true)).toBe('sound/weapons/melee/fstrun.wav');
  });

  it('keeps the ready sound through fire for the weapons with no firing sound', () => {
    expect(weaponLoop(sounds(WP.RAILGUN), true)).toBe('sound/weapons/railgun/rg_hum.wav');
    expect(weaponLoop(sounds(WP.BFG), true)).toBe('sound/weapons/bfg/bfg_hum.wav');
  });

  it('loops nothing for a weapon with neither', () => {
    expect(weaponLoop(sounds(WP.MACHINEGUN), false)).toBeUndefined();
    expect(weaponLoop(sounds(WP.MACHINEGUN), true)).toBeUndefined();
  });
});

describe('playsFireSound', () => {
  it('plays lg_fire on the first shot of a burst only', () => {
    expect(playsFireSound(WP.LIGHTNING, false)).toBe(true);
    expect(playsFireSound(WP.LIGHTNING, true)).toBe(false);
  });

  it("plays every other weapon's shot every time", () => {
    for (const weapon of [WP.MACHINEGUN, WP.RAILGUN, WP.GAUNTLET]) {
      expect(playsFireSound(weapon, true)).toBe(true);
    }
  });
});

describe('the off-hand hook', () => {
  it("is silent while held: CorkScrew's has no ready, firing or fire sound", () => {
    const hook = sounds(WP.GRAPPLING_HOOK);
    expect(hook?.readySound).toBeUndefined();
    expect(hook?.firingSound).toBeUndefined();
    expect(hook?.fireSounds).toEqual([]);
  });

  it('sounds like a lightning hit where it catches', () => {
    // The catch names no weapon, so it falls to `CG_MissileHitWall`'s default, which is the
    // lightning gun's case. CorkScrew plays its own `hit.wav` there, which only its pk3 has.
    expect(sounds(WP.LIGHTNING)?.impactSounds).toEqual([
      'sound/weapons/lightning/lg_hit.wav',
      'sound/weapons/lightning/lg_hit2.wav',
      'sound/weapons/lightning/lg_hit3.wav'
    ]);
  });
});
