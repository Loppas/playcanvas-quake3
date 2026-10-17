import { MAX_WEAPONS, WP, type WeaponId } from '../sim/weapons/constants';
import { SCREEN_WIDTH } from './hud-layout';
import { BIGCHAR_WIDTH } from './hud-text';
import { WEAPON_NAMES } from './weapon-select';

/**
 * The weapon bar (`CG_DrawWeaponSelect`, `cg_weapons.c:1452–1520`): which icons, where
 * and how faded, for the render layer to draw. Engine-free.
 */

/** `WEAPON_SELECT_TIME` (`cg_local.h:47`): the bar shows this long after a switch is asked for. */
export const WEAPON_SELECT_TIME = 1400;

/** `FADE_TIME` (`cg_local.h:37`): a fade's last stretch. */
export const FADE_TIME = 200;

/** The icons: 32 square, 40 apart, along y 380 (`cg_weapons.c:1483–1506`). */
export const WEAPON_ICON_SIZE = 32;
export const WEAPON_ICON_STEP = 40;
export const WEAPON_BAR_Y = 380;

/** The select marker: 40 square, 4 up and left of its icon (`cg_weapons.c:1497–1499`). */
export const SELECT_SIZE = 40;
export const SELECT_INSET = 4;

/** The asked-for weapon's name: 22 above the icons (`cg_weapons.c:1510–1516`). */
export const WEAPON_NAME_Y = WEAPON_BAR_Y - 22;

/**
 * `CG_FadeColor`'s alpha (`cg_drawtools.c:328–351`): 1, then down to 0 over the last 200 ms of
 * `total`; `null` once it is over, or for a start of −∞, which the port uses for never.
 *
 * @param time - Game time in milliseconds.
 */
export function fadeAlpha(start: number, total: number, time: number): number | null {
  const t = Math.floor(time) - start;
  if (!(t < total)) return null;
  return total - t < FADE_TIME ? (total - t) / FADE_TIME : 1;
}

/** One weapon on the bar. */
export interface WeaponBarSlot {
  weapon: WeaponId;
  /** The icon's left edge; its top is {@link WEAPON_BAR_Y}. */
  x: number;
  /** Boxed by the select marker: the weapon asked for. */
  selected: boolean;
  /** Crossed out: owned, with no ammo left. */
  noAmmo: boolean;
}

/** The bar this frame. */
export interface WeaponBar {
  /** `CG_FadeColor`'s alpha, which only the stages that take the vertex colour follow. */
  alpha: number;
  slots: WeaponBarSlot[];
  /** The asked-for weapon's name, centred, or `null` for none. */
  name: { text: string; x: number; y: number } | null;
}

/**
 * The bar, for 1.4 s after a switch is asked for, or `null`.
 *
 * Q3 draws every weapon owned, in id order. The port leaves the hook out: it is an off-hand
 * tool, never in hand. The gauntlet is owned, so it shows, though the cycle skips it.
 *
 * @param weapons - `STAT_WEAPONS`.
 * @param ammo - Ammo per weapon: 0 is crossed out, and −1, infinite, is not.
 * @param selected - `cg.weaponSelect`: the weapon asked for, which may not be in hand yet.
 * @param selectTime - `cg.weaponSelectTime`, or −∞ before any switch.
 * @param time - Game time in milliseconds.
 */
export function weaponBar(
  weapons: number,
  ammo: readonly number[],
  selected: number,
  selectTime: number,
  time: number
): WeaponBar | null {
  const alpha = fadeAlpha(selectTime, WEAPON_SELECT_TIME, time);
  if (alpha === null) return null;

  const owned: WeaponId[] = [];
  for (let weapon = 1; weapon < MAX_WEAPONS; weapon++) {
    if (weapon !== WP.GRAPPLING_HOOK && weapons & (1 << weapon)) owned.push(weapon as WeaponId);
  }
  const start = SCREEN_WIDTH / 2 - owned.length * (WEAPON_ICON_STEP / 2);
  const slots = owned.map((weapon, i) => ({
    weapon,
    x: start + i * WEAPON_ICON_STEP,
    selected: weapon === selected,
    noAmmo: !ammo[weapon]
  }));

  // `cg_weapons[cg.weaponSelect].item->pickup_name`: no item, and no name, for `WP_NONE`.
  const text: string | undefined =
    selected > WP.NONE ? WEAPON_NAMES[selected as WeaponId] : undefined;
  const name = text
    ? { text, x: Math.trunc((SCREEN_WIDTH - text.length * BIGCHAR_WIDTH) / 2), y: WEAPON_NAME_Y }
    : null;
  return { alpha, slots, name };
}
