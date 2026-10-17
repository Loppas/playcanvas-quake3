import { describe, expect, it } from 'vitest';

import { findItem, HI } from '../sim/items';
import {
  itemAt,
  pickupSound,
  useItemSound,
  MEDKIT_SOUND,
  N_HEALTH_SOUND,
  RESPAWN_SOUND,
  USE_NOTHING_SOUND,
  WEAR_OFF_SOUND
} from './item-sounds';

/**
 * What an item sounds like: the path each pickup is heard as, and the sounds the client supplies
 * itself rather than reading off the table.
 */

describe('pickupSound', () => {
  it('plays an item’s own sound, as the table names it', () => {
    expect(pickupSound(findItem('ammo_bullets')!)).toBe('sound/misc/am_pkup.wav');
    expect(pickupSound(findItem('weapon_railgun')!)).toBe('sound/misc/w_pkup.wav');
    expect(pickupSound(findItem('item_armor_combat')!)).toBe('sound/misc/ar2_pkup.wav');
  });

  it('plays a powerup or a flag as the health sound, and its own when the world says it', () => {
    // Q3 plays the health sound at prediction time so the owner hears it at once, and the item's
    // own sound from the global event; a map's `noglobalsound` leaves only the first.
    expect(pickupSound(findItem('item_quad')!)).toBe(N_HEALTH_SOUND);
    expect(pickupSound(findItem('team_CTF_redflag')!)).toBe(N_HEALTH_SOUND);
    expect(pickupSound(findItem('item_quad')!, true)).toBe('sound/items/quaddamage.wav');
  });

  it('has nothing for a flag announced to the world, which has no sound of its own', () => {
    expect(pickupSound(findItem('team_CTF_redflag')!, true)).toBeNull();
  });

  it('names the sounds the client supplies itself', () => {
    expect(RESPAWN_SOUND).toBe('sound/items/respawn1.wav');
    expect(WEAR_OFF_SOUND).toBe('sound/items/wearoff.wav');
  });
});

describe('useItemSound', () => {
  it('plays the medkit on the medkit and the nothing sound on nothing', () => {
    expect(useItemSound(HI.MEDKIT)).toBe(MEDKIT_SOUND);
    expect(useItemSound(HI.NONE)).toBe(USE_NOTHING_SOUND);
  });

  it('leaves the teleporter silent, as Q3 does', () => {
    // `CG_UseItem`'s `HI_TELEPORTER` case is empty: the teleport's own two effects are the
    // feedback (`cg_event.c:373–374`).
    expect(useItemSound(HI.TELEPORTER)).toBeNull();
  });

  it('takes a tag it has no item for as nothing', () => {
    expect(useItemSound(5)).toBe(USE_NOTHING_SOUND);
    expect(useItemSound(-1)).toBe(USE_NOTHING_SOUND);
  });
});

describe('itemAt', () => {
  it('reads the table by slot, and nothing outside it', () => {
    expect(itemAt(28)?.classname).toBe('item_quad');
    expect(itemAt(0)).toBeNull();
    expect(itemAt(999)).toBeNull();
    expect(itemAt(-1)).toBeNull();
  });
});
