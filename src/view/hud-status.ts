import { ARMOR_PROTECTION } from '../sim/constants';
import { WEAPON_FIRING } from '../sim/weapons/constants';

/**
 * The status bar's numbers and colours (`CG_DrawStatusBar`, `cg_draw.c:519–644`).
 *
 * Engine-free: this says which digits go where and in what colour, and the render layer draws them
 * from the eleven number shaders.
 */

/** A status-bar digit: 32×48, drawn from a 32×32 image (`cg_local.h:67–68`). */
export const CHAR_WIDTH = 32;
export const CHAR_HEIGHT = 48;

/** An icon's size, and the gap between a number and its icon (`cg_local.h:65, 69`). */
export const ICON_SIZE = 48;
export const TEXT_ICON_SPACE = 4;

/** The number shader for a minus sign (`cg_local.h:63`). */
export const STAT_MINUS = 10;

/** The row every number and icon sits on (`cg_draw.c:553–640`). */
export const STATUS_Y = 432;

/** Each number is three digits wide. */
export const FIELD_WIDTH = 3;

/** Where the ammo, health and armor numbers start (`cg_draw.c:594, 625, 636`). */
export const AMMO_X = 0;
export const HEALTH_X = 185;
export const ARMOR_X = 370;

/** An icon sits just right of its number: the ammo box at 100, the armor at 470. */
export const ICON_OFFSET = CHAR_WIDTH * FIELD_WIDTH + TEXT_ICON_SPACE;

/** An icon's box beside the number starting at `fieldX` (`cg_draw.c:553, 572`). */
export function iconRect(fieldX: number): { x: number; y: number; w: number; h: number } {
  return { x: fieldX + ICON_OFFSET, y: STATUS_Y, w: ICON_SIZE, h: ICON_SIZE };
}

/** A colour and its alpha, as `trap_R_SetColor` takes it. */
export type Rgba = readonly [number, number, number, number];

/** `CG_DrawStatusBar`'s colours (`cg_draw.c:528–533`). Its comments say green; the normal is amber. */
export const STATUS_COLORS: Readonly<Record<'normal' | 'low' | 'firing' | 'over', Rgba>> = {
  normal: [1, 0.69, 0, 1],
  low: [1, 0.2, 0.2, 1],
  firing: [0.5, 0.5, 0.5, 1],
  over: [1, 1, 1, 1]
};

/** One digit of a number: where it starts, and which of the eleven number shaders draws it. */
export interface Digit {
  x: number;
  frame: number;
}

/** `CG_DrawField`'s clamp for each width (`cg_draw.c:220–237`); five digits are not clamped. */
const FIELD_LIMITS: Readonly<Record<number, readonly [number, number]>> = {
  1: [0, 9],
  2: [-9, 99],
  3: [-99, 999],
  4: [-999, 9999]
};

/**
 * `CG_DrawField` (`cg_draw.c:206–258`): a number's digits, right-aligned in a field `width` digits
 * wide from `x`, 2 in from its edge. The value is clamped to what fits, −99 to 999 for three
 * digits, and a field is five digits at most.
 */
export function fieldDigits(x: number, width: number, value: number): Digit[] {
  if (width < 1) return [];
  const digits = Math.min(width, 5);
  const limit = FIELD_LIMITS[digits];
  const shown = limit ? Math.min(limit[1], Math.max(limit[0], Math.trunc(value))) : value;
  const text = String(Math.trunc(shown));
  const length = Math.min(text.length, digits);

  const out: Digit[] = [];
  let at = x + 2 + CHAR_WIDTH * (digits - length);
  for (let i = 0; i < length; i++) {
    out.push({ x: at, frame: text[i] === '-' ? STAT_MINUS : text.charCodeAt(i) - 48 });
    at += CHAR_WIDTH;
  }
  return out;
}

/**
 * The health number's colour (`cg_draw.c:612–622`): white over 100, amber down to 26, then
 * flashing amber and red every 256 ms, and red at 0 or below. The bands are Q3's own, whatever the
 * handicap.
 *
 * @param time - Game time in milliseconds.
 */
export function healthColor(health: number, time: number): Rgba {
  if (health > 100) return STATUS_COLORS.over;
  if (health > 25) return STATUS_COLORS.normal;
  // `(cg.time >> 8) & 1`.
  if (health > 0) return Math.floor(time / 256) % 2 ? STATUS_COLORS.low : STATUS_COLORS.normal;
  return STATUS_COLORS.low;
}

/**
 * The ammo number's colour (`cg_draw.c:581–592`): grey while a shot holds the gun for more than
 * another 100 ms, amber otherwise. Q3's red is out of reach, since the number shows only for ammo
 * of 0 or more; CPMA's is under the weapon's low-ammo mark.
 *
 * @param ammo - The weapon's ammo.
 * @param lowMark - Its `g_lowAmmo_<w>`, where 0 is never red.
 */
export function ammoColor(weaponState: number, weaponTime: number, ammo = 0, lowMark = 0): Rgba {
  if (ammo < lowMark) return STATUS_COLORS.low;
  return weaponState === WEAPON_FIRING && weaponTime > 100
    ? STATUS_COLORS.firing
    : STATUS_COLORS.normal;
}

/**
 * `CG_GetColorForHealth` (`cg_drawtools.c:384–420`), which tints the crosshair: white at 100 or
 * more, through yellow as blue goes by 66, to red as green goes by 30. Armor counts, but no more of
 * it than could save this much health, `health · 0.66 / 0.34`. Black when dead.
 */
export function colorForHealth(health: number, armor: number): Rgba {
  if (health <= 0) return [0, 0, 0, 1];
  const saved = Math.min(armor, Math.trunc((health * ARMOR_PROTECTION) / (1 - ARMOR_PROTECTION)));
  const total = health + saved;
  const blue = total >= 100 ? 1 : total < 66 ? 0 : (total - 66) / 33;
  const green = total > 60 ? 1 : total < 30 ? 0 : (total - 30) / 30;
  return [1, green, blue, 1];
}
