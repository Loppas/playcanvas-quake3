import { describe, expect, it } from 'vitest';

import { PMOVE_MSEC } from '../sim/constants';
import type { GameEntity } from '../sim/game-entity';
import { respawnItem, touchItem } from '../sim/item-touch';
import { findItem, itemIndex } from '../sim/items';
import type { UserCmd } from '../sim/types';
import { vec3 } from '../sim/vec3';
import { ViewWorld } from './view-test-fixtures';

/**
 * The map's items as the client sees them: what `CG_AddPacketEntities` hands `CG_Item`, and the
 * one thing on an item that is not in its entity state — `cent->miscTime`, the clock its scale-up
 * runs from, which `EV_ITEM_RESPAWN` sets.
 */

/** A command with nothing held and nothing pressed. */
function idle(): Omit<UserCmd, 'serverTime'> {
  return {
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: 0
  };
}

/** A world whose map places two items, both out of the player's reach. */
function worldWithItems(): ViewWorld {
  return new ViewWorld({
    origin: vec3(0, 0, 24),
    items: [
      { classname: 'item_armor_combat', origin: vec3(96, 0, 24) },
      { classname: 'weapon_railgun', origin: vec3(0, 96, 24) }
    ]
  });
}

/**
 * Ticks enough for the map's items to be finished — their spawn is deferred by `FRAMETIME * 2` —
 * and for the client to read a fresh snapshot.
 */
function ticks(world: ViewWorld, count = 30): void {
  for (let i = 0; i < count; i++) world.view.advance(PMOVE_MSEC, idle());
}

/** The item entity the map placed, by its classname. */
function placed(world: ViewWorld, classname: string): GameEntity {
  const entity = world.level.gentities.find(
    (candidate) => candidate.inuse && candidate.classname === classname
  );
  if (!entity) throw new Error(`no ${classname} on the map`);
  return entity;
}

describe("the map's items as a client sees them", () => {
  it('collects them with the table slot the server sent, where they stand', () => {
    const world = worldWithItems();
    ticks(world);

    const items = world.view.items();
    const armor = items.find((item) => item.state.modelindex === itemIndex(findItem('item_armor_combat')!));
    const railgun = items.find((item) => item.state.modelindex === itemIndex(findItem('weapon_railgun')!));

    expect(armor).toBeDefined();
    expect(armor!.origin.x).toBeCloseTo(96, 0);
    expect(armor!.origin.y).toBeCloseTo(0, 0);
    expect(railgun).toBeDefined();
    expect(railgun!.origin.y).toBeCloseTo(96, 0);
  });

  it('stops drawing one the server has taken out of the world', () => {
    const world = worldWithItems();
    ticks(world);
    const armor = placed(world, 'item_armor_combat');
    const slot = itemIndex(findItem('item_armor_combat')!);

    touchItem(world.level, armor, world.entity);
    ticks(world);

    // A taken item is `SVF_NOCLIENT`, so it is not in the snapshot at all rather than arriving
    // flagged; either way the client must not draw it.
    expect(world.view.items().some((item) => item.state.modelindex === slot)).toBe(false);
  });

  it('marks an item from the moment it respawns, and leaves the others at nothing', () => {
    const world = worldWithItems();
    ticks(world);
    const armor = placed(world, 'item_armor_combat');
    const railgun = placed(world, 'weapon_railgun');
    const before = world.view.time;

    respawnItem(world.level, armor);
    ticks(world);

    const items = world.view.items();
    const respawned = items.find((item) => item.state.number === armor.s.number)!;
    const other = items.find((item) => item.state.number === railgun.s.number)!;
    expect(respawned.respawnTime).toBeGreaterThanOrEqual(before);
    expect(respawned.respawnTime).toBeLessThanOrEqual(world.view.time);
    expect(other.respawnTime).toBe(0);
  });
});

