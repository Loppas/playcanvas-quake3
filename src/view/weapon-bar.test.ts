import { describe, expect, it } from 'vitest';

import { ALL_WEAPONS, AMMO_INFINITE, MAX_WEAPONS, WP } from '../sim/weapons/constants';
import { fadeAlpha, weaponBar } from './weapon-bar';

/** `STAT_WEAPONS` with every weapon, the hook among them. */
const OWNED = ALL_WEAPONS.reduce<number>((bits, weapon) => bits | (1 << weapon), 0);

/** The ammo a player spawns with: infinite for everything. */
const INFINITE = new Array<number>(MAX_WEAPONS).fill(AMMO_INFINITE);

describe('fadeAlpha', () => {
  it('holds at 1, fades over the last 200 ms, and is gone at the end', () => {
    expect(fadeAlpha(1000, 1400, 1000)).toBe(1);
    expect(fadeAlpha(1000, 1400, 2200)).toBe(1);
    expect(fadeAlpha(1000, 1400, 2300)).toBe(0.5);
    expect(fadeAlpha(1000, 1400, 2399.9)).toBe(1 / 200);
    expect(fadeAlpha(1000, 1400, 2400)).toBeNull();
  });

  it('never starts from −∞', () => {
    expect(fadeAlpha(Number.NEGATIVE_INFINITY, 1400, 5000)).toBeNull();
  });
});

describe('weaponBar', () => {
  it('shows nothing before a switch is asked for', () => {
    expect(weaponBar(OWNED, INFINITE, WP.MACHINEGUN, Number.NEGATIVE_INFINITY, 5000)).toBeNull();
  });

  it('lays out nine icons 40 apart about the middle: the gauntlet, not the hook', () => {
    const bar = weaponBar(OWNED, INFINITE, WP.ROCKET_LAUNCHER, 1000, 1000)!;
    expect(bar.slots.map((slot) => slot.weapon)).toEqual(
      ALL_WEAPONS.filter((weapon) => weapon !== WP.GRAPPLING_HOOK)
    );
    expect(bar.slots.map((slot) => slot.x)).toEqual([140, 180, 220, 260, 300, 340, 380, 420, 460]);
    expect(bar.slots.filter((slot) => slot.selected).map((slot) => slot.weapon)).toEqual([
      WP.ROCKET_LAUNCHER
    ]);
  });

  it("names the weapon asked for, centred 22 above the icons", () => {
    expect(weaponBar(OWNED, INFINITE, WP.ROCKET_LAUNCHER, 1000, 1000)!.name).toEqual({
      text: 'Rocket Launcher',
      x: 200,
      y: 358
    });
    expect(weaponBar(OWNED, INFINITE, WP.MACHINEGUN, 1000, 1000)!.name!.x).toBe(240);
    expect(weaponBar(OWNED, INFINITE, WP.NONE, 1000, 1000)!.name).toBeNull();
  });

  it('crosses out a weapon with no ammo, not one with infinite', () => {
    const ammo = [...INFINITE];
    ammo[WP.RAILGUN] = 0;
    const bar = weaponBar(OWNED, ammo, WP.MACHINEGUN, 1000, 1000)!;
    expect(bar.slots.filter((slot) => slot.noAmmo).map((slot) => slot.weapon)).toEqual([WP.RAILGUN]);
  });

  it('fades out over its last 200 ms, gone 1.4 s after the switch', () => {
    expect(weaponBar(OWNED, INFINITE, WP.MACHINEGUN, 1000, 2300)!.alpha).toBe(0.5);
    expect(weaponBar(OWNED, INFINITE, WP.MACHINEGUN, 1000, 2400)).toBeNull();
  });
});
