import type { WeaponAssetSet } from '../formats/asset-manifest';
import { WP, type WeaponId } from '../sim/weapons/constants';

/**
 * Which weapon sounds play, and when — `CG_AddPlayerWeapon` and `CG_FireWeapon`
 * (`cg_weapons.c`).
 *
 * Engine-free, so the rules can be tested without WebAudio; the sound bus plays what these
 * return.
 */

/**
 * The loop a held weapon plays: its firing sound while `EF_FIRING` is set, if it has one, and
 * its ready sound otherwise. The lightning gun hums `fsthum` in the hand and `lg_hum` while it
 * fires; the gauntlet runs `fstrun` while it attacks, and is silent in the hand.
 *
 * @returns A sound path, or `undefined` for a weapon that loops nothing.
 */
export function weaponLoop(
  sounds: Pick<WeaponAssetSet, 'readySound' | 'firingSound'> | undefined,
  firing: boolean
): string | undefined {
  if (firing && sounds?.firingSound) return sounds.firingSound;
  return sounds?.readySound;
}

/**
 * Whether a shot plays its fire sound. The lightning gun plays `lg_fire` only on the first shot
 * of a burst: `CG_FireWeapon` skips it while `lightningFiring` — the firing loop — was already
 * on the frame before.
 *
 * @param loopWasFiring - Whether the firing loop was playing before this frame.
 */
export function playsFireSound(weapon: WeaponId, loopWasFiring: boolean): boolean {
  return weapon !== WP.LIGHTNING || !loopWasFiring;
}
