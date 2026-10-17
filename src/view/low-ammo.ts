import { WP } from '../sim/weapons/constants';

/** The guns whose rounds count for a second of fire each; every other round counts a fifth. */
const SLOW_GUNS: ReadonlySet<number> = new Set([
  WP.SHOTGUN,
  WP.GRENADE_LAUNCHER,
  WP.ROCKET_LAUNCHER,
  WP.RAILGUN
]);

/** Below this many milliseconds of fire, the ammo is low (`cg_playerstate.c:67`). */
const LOW_AMMO_MSEC = 5000;

/**
 * `CG_CheckAmmo` (`cg_playerstate.c:37–85`): how short of ammo the player is, for the HUD's
 * warning.
 *
 * Q3 adds up roughly how long the guns can fire — a second for each rocket, grenade, slug or
 * shell, a fifth of one for each bullet, cell or bolt — and warns below five seconds. It skips
 * a gun at the infinite sentinel, so a loadout with nothing else would add up to nothing and
 * print OUT OF AMMO for good; the port counts such a gun as plenty instead. The off-hand
 * hook is left out, as it is not a weapon slot.
 *
 * @param weapons - `STAT_WEAPONS`.
 * @param ammo - Ammo per weapon.
 * @returns `cg.lowAmmoWarning`: 0 for plenty, 1 for low, 2 for none left.
 */
export function lowAmmoWarning(weapons: number, ammo: readonly number[]): 0 | 1 | 2 {
  let total = 0;
  for (let weapon: number = WP.MACHINEGUN; weapon <= WP.BFG; weapon++) {
    if (!(weapons & (1 << weapon))) continue;
    if (ammo[weapon] < 0) return 0;

    total += ammo[weapon] * (SLOW_GUNS.has(weapon) ? 1000 : 200);
    if (total >= LOW_AMMO_MSEC) return 0;
  }
  return total === 0 ? 2 : 1;
}

/**
 * CPMA's `CG_CheckAmmo`: the weapon in hand alone, low under its mark and out with none. Ammo of
 * −1, and a mark of 0, never warn.
 *
 * @param ammo - The weapon in hand's ammo.
 * @param mark - Its `g_lowAmmo_<w>`.
 */
export function markedAmmoWarning(ammo: number, mark: number): 0 | 1 | 2 {
  if (ammo < 0 || ammo >= mark) return 0;
  return ammo > 0 ? 1 : 2;
}

/**
 * The warning the serverinfo's marks call for: by the weapon in hand while any is set, and by
 * {@link lowAmmoWarning} with none.
 *
 * @param weapons - `STAT_WEAPONS`.
 * @param ammo - Ammo per weapon.
 * @param weapon - The weapon in hand.
 * @param marks - `g_lowAmmo_<w>` by weapon.
 */
export function ammoWarningLevel(
  weapons: number,
  ammo: readonly number[],
  weapon: number,
  marks: readonly number[]
): 0 | 1 | 2 {
  if (!marks.some((mark) => mark > 0)) return lowAmmoWarning(weapons, ammo);
  return markedAmmoWarning(ammo[weapon], marks[weapon] ?? 0);
}
