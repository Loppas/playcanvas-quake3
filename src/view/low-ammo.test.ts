import { describe, expect, it } from 'vitest';

import { ALL_WEAPONS, AMMO_INFINITE, MAX_WEAPONS, WP } from '../sim/weapons/constants';
import { ammoWarningLevel, lowAmmoWarning, markedAmmoWarning } from './low-ammo';

/** `STAT_WEAPONS` for the given weapons. */
const owning = (...weapons: number[]) => weapons.reduce((bits, weapon) => bits | (1 << weapon), 0);

/** An ammo table with the given counts and zero elsewhere. */
function ammo(counts: Partial<Record<number, number>>): number[] {
  const table = new Array<number>(MAX_WEAPONS).fill(0);
  for (const [weapon, count] of Object.entries(counts)) table[Number(weapon)] = count ?? 0;
  return table;
}

describe('lowAmmoWarning', () => {
  it('counts infinite ammo as plenty, where Q3 would warn for good', () => {
    const infinite = ammo(Object.fromEntries(ALL_WEAPONS.map((weapon) => [weapon, AMMO_INFINITE])));
    expect(lowAmmoWarning(owning(...ALL_WEAPONS), infinite)).toBe(0);
  });

  it('warns that every gun is empty', () => {
    expect(lowAmmoWarning(owning(...ALL_WEAPONS), ammo({}))).toBe(2);
  });

  it('counts a second per rocket and a fifth per bullet, and warns below five seconds', () => {
    expect(lowAmmoWarning(owning(WP.ROCKET_LAUNCHER), ammo({ [WP.ROCKET_LAUNCHER]: 5 }))).toBe(0);
    expect(lowAmmoWarning(owning(WP.ROCKET_LAUNCHER), ammo({ [WP.ROCKET_LAUNCHER]: 4 }))).toBe(1);
    expect(lowAmmoWarning(owning(WP.MACHINEGUN), ammo({ [WP.MACHINEGUN]: 25 }))).toBe(0);
    expect(lowAmmoWarning(owning(WP.MACHINEGUN), ammo({ [WP.MACHINEGUN]: 24 }))).toBe(1);
  });

  it('ignores guns the player does not own', () => {
    expect(lowAmmoWarning(owning(WP.MACHINEGUN), ammo({ [WP.RAILGUN]: 100 }))).toBe(2);
  });

  it('leaves out the gauntlet and the off-hand hook', () => {
    const weapons = owning(WP.GAUNTLET, WP.MACHINEGUN, WP.GRAPPLING_HOOK);
    const table = ammo({ [WP.GAUNTLET]: AMMO_INFINITE, [WP.GRAPPLING_HOOK]: AMMO_INFINITE });
    expect(lowAmmoWarning(weapons, table)).toBe(2);
  });
});

describe('markedAmmoWarning', () => {
  it('is low under the mark and out at none, and never with infinite ammo or no mark', () => {
    expect(markedAmmoWarning(4, 5)).toBe(1);
    expect(markedAmmoWarning(1, 5)).toBe(1);
    expect(markedAmmoWarning(5, 5)).toBe(0);
    expect(markedAmmoWarning(0, 5)).toBe(2);
    expect(markedAmmoWarning(AMMO_INFINITE, 5)).toBe(0);
    expect(markedAmmoWarning(0, 0)).toBe(0);
  });
});

describe('ammoWarningLevel', () => {
  const marks = ammo({ [WP.ROCKET_LAUNCHER]: 5, [WP.RAILGUN]: 3 });
  const weapons = owning(WP.GAUNTLET, WP.MACHINEGUN, WP.ROCKET_LAUNCHER, WP.RAILGUN);

  it('warns by the weapon in hand alone while any mark is set', () => {
    const table = ammo({ [WP.ROCKET_LAUNCHER]: 4, [WP.RAILGUN]: 100 });
    expect(ammoWarningLevel(weapons, table, WP.ROCKET_LAUNCHER, marks)).toBe(1);
    expect(ammoWarningLevel(weapons, table, WP.RAILGUN, marks)).toBe(0);
    expect(ammoWarningLevel(weapons, ammo({}), WP.RAILGUN, marks)).toBe(2);
  });

  it('never warns for a weapon without a mark', () => {
    const table = ammo({ [WP.GAUNTLET]: AMMO_INFINITE });
    expect(ammoWarningLevel(weapons, table, WP.GAUNTLET, marks)).toBe(0);
    expect(ammoWarningLevel(weapons, table, WP.MACHINEGUN, marks)).toBe(0);
  });

  it("warns by id's rule, over every weapon owned, with every mark 0", () => {
    const table = ammo({ [WP.ROCKET_LAUNCHER]: 4 });
    const none = ammo({});
    expect(ammoWarningLevel(owning(WP.ROCKET_LAUNCHER), table, WP.RAILGUN, none)).toBe(1);
    expect(ammoWarningLevel(owning(WP.ROCKET_LAUNCHER), table, WP.RAILGUN, [])).toBe(1);
  });
});
