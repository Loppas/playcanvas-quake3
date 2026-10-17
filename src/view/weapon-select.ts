import { ALL_WEAPONS, MAX_WEAPONS, WP, type WeaponId } from '../sim/weapons/constants';

/**
 * Which weapon the player is asking for — `CG_NextWeapon_f`, `CG_PrevWeapon_f` and
 * `CG_Weapon_f` (`cgame/cg_weapons.c:1101-1180`).
 *
 * Selection is a **client** concern in Quake 3, not a simulation one: the cgame picks an id
 * and puts it in `cmd.weapon`, and `PM_Weapon` decides when the change actually happens. So
 * this is view code that emits a request, and the 450 ms drop/raise stays authoritative — a
 * weapon key never moves `ps.weapon` directly.
 *
 * Engine-free, so every cycling rule can be pinned without a keyboard.
 */

/** Display names, as the original HUD spells them. */
export const WEAPON_NAMES: Record<WeaponId, string> = {
  [WP.NONE]: 'none',
  [WP.GAUNTLET]: 'Gauntlet',
  [WP.MACHINEGUN]: 'Machinegun',
  [WP.SHOTGUN]: 'Shotgun',
  [WP.GRENADE_LAUNCHER]: 'Grenade Launcher',
  [WP.ROCKET_LAUNCHER]: 'Rocket Launcher',
  [WP.LIGHTNING]: 'Lightning Gun',
  [WP.RAILGUN]: 'Railgun',
  [WP.PLASMAGUN]: 'Plasma Gun',
  [WP.BFG]: 'BFG10K',
  [WP.GRAPPLING_HOOK]: 'Grappling Hook'
};

/** What selection needs to know about the player: which weapons are owned, and their ammo. */
export interface Loadout {
  /** `STAT_WEAPONS` — bit `n` set means weapon `n` is owned. */
  weapons: number;
  /** Ammo per weapon id. `0` blocks selection; `-1` is the infinite sentinel. */
  ammo: readonly number[];
}

/**
 * `CG_WeaponSelectable` (`cg_weapons.c:1090`) — owned, and not out of ammo.
 *
 * The ammo test is `!ps.ammo[i]`, so Q3's `-1` sentinel passes it exactly as a full clip
 * does. The spawn loadout gives every weapon that sentinel, so ownership is the only real gate.
 */
export function weaponSelectable(loadout: Loadout, weapon: number): boolean {
  if (weapon <= WP.NONE || weapon >= MAX_WEAPONS) return false;
  if ((loadout.ammo[weapon] ?? 0) === 0) return false;
  return (loadout.weapons & (1 << weapon)) !== 0;
}

/**
 * Weapons the cycle refuses to stop on.
 *
 * The gauntlet is Q3's own rule — `CG_NextWeapon_f` says "never cycle to gauntlet", because
 * scrolling into a melee weapon mid-fight is a death sentence. The grappling hook is ours:
 * it is **off-hand**, held on a key of its own while the real weapon stays up, so it is
 * never something you have in your hands and never something the cycle should offer. Q3's
 * own CTF build has the same exclusion for the same reason.
 */
const NEVER_CYCLED: readonly number[] = [WP.GAUNTLET, WP.GRAPPLING_HOOK];

/**
 * Step to the next or previous selectable weapon — `CG_NextWeapon_f` / `CG_PrevWeapon_f`.
 *
 * Ported with its exact shape rather than rewritten as a filtered list, because two details
 * fall out of that shape: the skipped gauntlet still costs an iteration (so a player owning
 * only the gauntlet keeps it rather than looping forever), and the search gives up and
 * restores the original selection after a full pass instead of leaving the player unarmed.
 *
 * @param current - Weapon selected now.
 * @param loadout - Owned weapons and ammo.
 * @param direction - `+1` for next, `-1` for previous.
 */
export function cycleWeapon(current: number, loadout: Loadout, direction: 1 | -1): number {
  let candidate = current;
  for (let i = 0; i < MAX_WEAPONS; i++) {
    candidate += direction;
    if (candidate === MAX_WEAPONS) candidate = 0;
    if (candidate < 0) candidate = MAX_WEAPONS - 1;
    if (NEVER_CYCLED.includes(candidate)) continue;
    if (weaponSelectable(loadout, candidate)) return candidate;
  }
  return current;
}

/**
 * Weapon on a number key — Q3's default `bind 1 "weapon 1"` … `bind 9 "weapon 9"`, where the
 * argument is the weapon id itself.
 *
 * The row therefore stops at 9 (the BFG). Q3 binds nothing to `0`; the only id past 9 is the
 * grappling hook, which has its own button and is never held.
 *
 * @param slot - Digit pressed, 1..9.
 * @param loadout - Owned weapons and ammo.
 * @returns The weapon to request, or `null` if that slot is empty or unavailable.
 */
export function weaponForSlot(slot: number, loadout: Loadout): WeaponId | null {
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) return null;
  if (!weaponSelectable(loadout, slot)) return null;
  return slot as WeaponId;
}

/** What a weapon command did: the weapon now asked for, and whether the weapon bar shows. */
export interface WeaponCommandResult {
  weapon: WeaponId;
  /** Whether it set `cg.weaponSelectTime`, which shows the bar. */
  shown: boolean;
}

/**
 * A weapon command, as cgame runs it. `weapon N` asks for weapon N if the player can
 * use it (`CG_Weapon_f`, `cg_weapons.c:1616`), and `weapnext` and `weapprev` step round the
 * loadout (`CG_NextWeapon_f` and `CG_PrevWeapon_f`, `cg_weapons.c:1544, 1580`). Each shows the
 * weapon bar, whatever it asked for, except a `weapon` whose number is no weapon's
 * (`cg_weapons.c:1628–1632`).
 *
 * @param argv - The command and its argument, as a bind gives them.
 * @param current - The weapon asked for so far: `cg.weaponSelect`.
 * @param loadout - Owned weapons and ammo.
 * @returns What it did, or `null` for a command that is not a weapon command.
 */
export function weaponCommand(
  argv: readonly string[],
  current: WeaponId,
  loadout: Loadout
): WeaponCommandResult | null {
  switch (argv[0]?.toLowerCase()) {
    case 'weapon': {
      // `atoi`: "5x" is 5, and anything that isn't a number is 0.
      const slot = Number.parseInt(argv[1] ?? '', 10);
      if (!(slot >= 1 && slot <= MAX_WEAPONS - 1)) return { weapon: current, shown: false };
      return { weapon: weaponForSlot(slot, loadout) ?? current, shown: true };
    }
    case 'weapnext':
      return { weapon: cycleWeapon(current, loadout, 1) as WeaponId, shown: true };
    case 'weapprev':
      return { weapon: cycleWeapon(current, loadout, -1) as WeaponId, shown: true };
    default:
      return null;
  }
}

/** Every weapon a player can hold, in HUD order — the cycle's full circuit. */
export const SELECTABLE_WEAPONS: WeaponId[] = ALL_WEAPONS.filter(
  (weapon) => !NEVER_CYCLED.includes(weapon)
);
