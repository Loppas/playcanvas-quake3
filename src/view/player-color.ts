import { WP } from '../sim/weapons/constants';

/**
 * The player's effects colour, `color1`, and the colours the effects and
 * the railgun draw from it. Engine-free.
 */

/** A colour, red, green and blue, each 0 to 1. */
export type Rgb = readonly [number, number, number];

/** `LE_FADE_RGB`'s starting colour for the rail core, as a share of `color1` (`cg_weapons.c:249–251`). */
const RAIL_CORE_SHARE = 0.75;

/** CorkScrew's share of `color1` in the hook's green and blue. */
const HOOK_SHARE = 0.75;

/**
 * `CG_ColorFromString` (`cg_players.c:621–642`): bit 1 is blue, bit 2 green and bit 4 red, and
 * anything outside 1–7 is white.
 */
export function colorFromString(value: number): Rgb {
  if (!(value >= 1 && value <= 7)) return [1, 1, 1];
  return [value & 4 ? 1 : 0, value & 2 ? 1 : 0, value & 1 ? 1 : 0];
}

/**
 * The rail core's colour: `CG_RailTrail` starts `LE_FADE_RGB` at three-quarters of `color1`, and
 * the fade takes it from there (`cg_weapons.c:249–251`).
 */
export function railCoreColor(color1: Rgb): Rgb {
  return [color1[0] * RAIL_CORE_SHARE, color1[1] * RAIL_CORE_SHARE, color1[2] * RAIL_CORE_SHARE];
}

/** The grappling hook's pointer and flare: `color1`, with green and blue at three-quarters. */
export function hookColor(color1: Rgb): Rgb {
  return [color1[0], color1[1] * HOOK_SHARE, color1[2] * HOOK_SHARE];
}

/**
 * The colour a weapon's flash takes: `color1` for the railgun, whose `rgbGen entity` stage
 * multiplies in the `shaderRGBA` `CG_AddPlayerWeapon` gives it (`cg_weapons.c:1324–1332`).
 *
 * @returns The colour, or `undefined` for a weapon whose flash is not coloured.
 */
export function flashColor(weapon: number, color1: Rgb): Rgb | undefined {
  return weapon === WP.RAILGUN ? color1 : undefined;
}

/** How long the railgun's glow takes to come back after a shot, in milliseconds (`cg_weapons.c:1222`). */
const RAIL_GLOW_RETURN = 1500;

/**
 * The colour a gun's `rgbGen entity` stages multiply in: the `shaderRGBA` `CG_AddPlayerWeapon`
 * gives it (`cg_weapons.c:1219–1232`). The railgun's is its owner's `color1`, black at a shot and
 * back up to it across the 1.5 s after. Every other gun's is left cleared, so black.
 *
 * @param time - Now, in milliseconds.
 * @param railFireTime - When this player's railgun last fired, on the same clock
 *   (`cent->pe.railFireTime`, `cg_weapons.c:1704–1706`).
 */
export function gunColor(weapon: number, color1: Rgb, time: number, railFireTime: number): Rgb {
  if (weapon !== WP.RAILGUN) return [0, 0, 0];
  const since = time - railFireTime;
  // Q3's int arithmetic: `c1RGBA`, in whole bytes (`cg_players.c:903–905`), times whole 255ths of
  // the way back, shifted down by 8.
  const scale = since < RAIL_GLOW_RETURN ? Math.trunc((255 * since) / RAIL_GLOW_RETURN) : null;
  const channel = (value: number) => {
    const byte = Math.trunc(255 * value);
    return (scale === null ? byte : (byte * scale) >> 8) / 255;
  };
  return [channel(color1[0]), channel(color1[1]), channel(color1[2])];
}
