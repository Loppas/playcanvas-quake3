import { HI, IT, ITEMS, NUM_ITEMS, type GItem } from '../sim/items';

/**
 * What an item sounds like to a client: which sound each pickup is heard as, and the two the
 * client supplies itself. Engine-free, so the mapping is testable without WebAudio; the sound bus
 * plays what this says.
 */

/** `cgs.media.n_healthSound` (`cg_main.c:759`): how a powerup or team item's pickup is heard. */
export const N_HEALTH_SOUND = 'sound/items/n_health.wav';

/** `cgs.media.respawnSound` (`cg_main.c:642`): an item arriving back in the world. */
export const RESPAWN_SOUND = 'sound/items/respawn1.wav';

/** `cgs.media.wearOffSound` (`cg_main.c:616`): the tick of a powerup nearly spent. */
export const WEAR_OFF_SOUND = 'sound/items/wearoff.wav';

/** `cgs.media.useNothingSound` (`cg_main.c:617`): the use key with nothing to use. */
export const USE_NOTHING_SOUND = 'sound/items/use_nothing.wav';

/** `cgs.media.medkitSound` (`cg_main.c:728`): a medkit going off. */
export const MEDKIT_SOUND = 'sound/items/use_medkit.wav';

/** The item a pickup's parm names, or `null` for an index the table has nothing at. */
export function itemAt(index: number): GItem | null {
  if (index < 1 || index >= NUM_ITEMS) return null;
  return ITEMS[index];
}

/**
 * What an item's pickup is heard as (`cg_event.c:727–794`).
 *
 * A powerup and a team item have two: the health sound where the pickup is predicted — so that
 * the player hears something at once, from their own body — and the item's own sound from the
 * world, which is what only the global event carries.
 *
 * @param global - True for the announcement the whole match is sent, which is the item's own.
 * @returns the path, or `null` for an item with no pickup sound of its own, which a flag is.
 */
export function pickupSound(item: GItem, global = false): string | null {
  if (!global && (item.giType === IT.POWERUP || item.giType === IT.TEAM)) return N_HEALTH_SOUND;
  return item.pickupSound;
}

/**
 * What `CG_UseItem` plays for a holdable's tag (`cg_event.c:367–384`).
 *
 * The teleporter is silent here — the effects at each end are its feedback — and anything the
 * table has no holdable for is the nothing sound, which is what Q3's `default` case gives.
 *
 * @param tag - The `HI` tag the use event carried.
 * @returns the path, or `null` for a use that sounds like nothing at all.
 */
export function useItemSound(tag: number): string | null {
  if (tag === HI.MEDKIT) return MEDKIT_SOUND;
  if (tag === HI.TELEPORTER) return null;
  return USE_NOTHING_SOUND;
}
