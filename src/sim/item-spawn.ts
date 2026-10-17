import { spawnFloat, type SpawnVars } from '../formats/entity-text';
import { TR } from '../net/protocol';
import { CONTENTS, EF_BOUNCE_HALF, EF_NODRAW, FL, GT, MASK } from './constants';
import { ET, setEntityOrigin, type GameEntity } from './game-entity';
import { findItemForWeapon, IT, itemIndex, NUM_ITEMS, type GItem } from './items';
import { POWERUP_RESPAWN_SOUND, crandom, respawnItem, touchItem, useItem } from './item-touch';
import type { Level } from './level';
import { angleVectors } from './pmove-math';
import { teamCheckDroppedItem, teamDroppedFlagThink } from './team';
import { copy, scale, vec3, vtos, type Vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * `g_items.c`'s game half: what puts an item in the world from a map's data. The table and the
 * grab rules are shared with prediction and live in `items.ts`; everything here is the server's.
 *
 * The pieces arrive with their stages. Spawning and standing are here; touch, pickup and the
 * return are `item-touch.ts`, which this module's standing calls into and never the other way.
 */

/** `ITEM_RADIUS` (`bg_public.h:41`): half the box an item is, for touch and for its drop. */
export const ITEM_RADIUS = 15;

/** `FRAMETIME` (`g_local.h:38`): how long a frame lasts, as a map's spawning counts frames. */
export const FRAMETIME = 100;

/** `ent->physicsBounce = 0.50` (`g_items.c:902`): items are bouncy. */
const ITEM_BOUNCE = 0.5;

/** How far down an item looks for the floor: far past any map's own floor (`g_items.c:679`). */
const FLOOR_DROP = 4096;

/** `spawnflags & 1`: the item stays where the map put it, hanging in the air. */
const SUSPENDED = 1;

/** How long a dropped item lasts before it is freed (`LaunchItem`, `g_items.c:604`). */
export const DROPPED_ITEM_LIFE = 30000;

/** `Drop_Item`'s throw (`g_items.c:630–631`): 150 ups along the thrower's facing, 200 up. */
export const DROP_SPEED = 150;
export const DROP_LIFT = 200;
export const DROP_LIFT_VARIANCE = 50;

/**
 * `RegisterItem` (`g_items.c:829–834`): the item goes on the list the map's clients are told to
 * precache.
 *
 * Quake 3's `G_Error`s for a null item, which is a programming mistake rather than a map's: the
 * table itself is what callers take the item from.
 */
export function registerItem(level: Level, item: GItem): void {
  level.itemsRegistered[itemIndex(item)] = true;
}

/**
 * `ClearRegisteredItems` (`g_items.c:808–820`): the map has loaded, so the list starts again. The
 * gauntlet and the machinegun are on it from the start, because every player spawns holding them.
 *
 * Quake 3 also registers the two harvest cubes for Team Arena's Harvest; retail baseq3, which this
 * port is, has neither the gametype nor the items.
 *
 * @param level - The level whose registry is cleared.
 */
export function clearRegisteredItems(level: Level): void {
  level.itemsRegistered.fill(false);
  registerItem(level, findItemForWeapon(WP.MACHINEGUN));
  registerItem(level, findItemForWeapon(WP.GAUNTLET));
}

/**
 * `SaveRegisteredItems` (`g_items.c:845–863`): the list as the `CS_ITEMS` string of `0`s and
 * `1`s, one per table slot.
 *
 * @param level - Whose registry to write out.
 * @param print - Where `G_Printf` goes.
 * @returns the string, `bg_numItems` characters long
 */
export function saveRegisteredItems(level: Level, print: (text: string) => void): string {
  let string = '';
  let count = 0;
  for (let i = 0; i < NUM_ITEMS; i++) {
    if (level.itemsRegistered[i]) {
      count++;
      string += '1';
    } else {
      string += '0';
    }
  }
  print(`${count} items registered`);
  return string;
}

/**
 * `G_SpawnItem` (`g_items.c:888–914`): a map named one of the table's items, so the entity is
 * that item — but not yet in the world.
 *
 * Standing it is deferred two frames, because some movers spawn on the second and an item the map
 * put on one would otherwise drop through it (`g_items.c:897–900`). Until then the entity is not
 * an item to the frame at all: it is an ordinary thinker, and what it thinks is its finishing.
 *
 * @param level - The level it is spawning into.
 * @param entity - The entity the map's pairs filled in.
 * @param item - The table entry its classname named.
 * @param vars - The map's pairs, for the item's own keys.
 */
export function spawnItem(level: Level, entity: GameEntity, item: GItem, vars: SpawnVars): void {
  entity.random = spawnFloat(vars, 'random', '0');
  entity.wait = spawnFloat(vars, 'wait', '0');

  registerItem(level, item);
  // `G_ItemDisabled` reads a `disable_<classname>` cvar here and leaves the item unstaged when it
  // is set. The port registers no such cvar, so nothing is disabled (noted for polish).

  entity.item = item;
  entity.nextthink = level.time + FRAMETIME * 2;
  entity.think = (self) => finishSpawningItem(level, self);

  entity.physicsBounce = ITEM_BOUNCE;

  if (item.giType === IT.POWERUP) {
    // Its arrival's sound takes its `CS_SOUNDS` slot here, in the map's order; `noglobalsound` is
    // kept on `speed`.
    level.itemMatch.soundIndex(POWERUP_RESPAWN_SOUND);
    entity.speed = spawnFloat(vars, 'noglobalsound', '0');
  }
}

/**
 * `FinishSpawningItem` (`g_items.c:658–714`): put the item where it is, and into the world.
 *
 * The item's box is made, its place in the table goes on as `s.modelindex`, and it is dropped to
 * the floor unless the map suspended it — a single 4096-unit trace, so an item on a ledge stands
 * on the ledge rather than falling off it. An item that starts inside something is taken away
 * instead, because a map's brush cannot be got out of.
 *
 * The last part is who may see it yet: one a `targetname` holds back, or one that is not the
 * first of its team, stays out of the world with no model until something puts it in. A powerup
 * waits out of the world too, for its first appearance.
 *
 * @param level - The level it is standing in.
 * @param entity - The item, as {@link spawnItem} left it.
 */
export function finishSpawningItem(level: Level, entity: GameEntity): void {
  const item = entity.item;
  if (!item) throw new Error('finishSpawningItem: the entity has no item');

  entity.r.mins = vec3(-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS);
  entity.r.maxs = vec3(ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS);

  entity.s.eType = ET.ITEM;
  entity.s.modelindex = itemIndex(item);
  // Zero marks an item the map placed; `LaunchItem` marks a dropped one with a 1, which the flag
  // rule reads.
  entity.s.modelindex2 = 0;

  entity.r.contents = CONTENTS.TRIGGER;
  // What a player walking into it runs, and what firing it by name runs. Both are the item's for
  // as long as it exists, which is why Q3 hangs them here rather than at the touch pass.
  entity.touch = (self, other) => touchItem(level, self, other);
  entity.use = (self) => useItem(level, self);

  if (entity.spawnflags & SUSPENDED) {
    setEntityOrigin(entity, entity.s.origin);
  } else {
    const start = entity.s.origin;
    const dest = vec3(start.x, start.y, start.z - FLOOR_DROP);
    const tr = level.trace(start, entity.r.mins, entity.r.maxs, dest, entity.s.number, MASK.SOLID);
    if (tr.startsolid) {
      level.itemMatch.print(
        `FinishSpawningItem: ${entity.classname} startsolid at ${vtos(entity.s.origin)}`
      );
      level.freeEntity(entity);
      return;
    }
    entity.s.groundEntityNum = tr.entityNum;
    setEntityOrigin(entity, tr.endpos);
  }

  // A member of a team is not its first, and a named item is waiting for something to fire it:
  // neither is in the world until `RespawnItem` puts one back.
  if (entity.flags & FL.TEAMMEMBER || entity.targetname !== null) {
    entity.s.eFlags |= EF_NODRAW;
    entity.r.contents = 0;
    return;
  }

  // Powerups do not spawn in for a while, so that a map's quad is not taken in the first seconds
  // of every match. The wait is the same machinery as a respawn's, only its first wind is longer.
  if (item.giType === IT.POWERUP) {
    const respawn = firstPowerupDelay(level);
    entity.s.eFlags |= EF_NODRAW;
    entity.r.contents = 0;
    entity.nextthink = level.time + respawn * 1000;
    entity.think = (self) => respawnItem(level, self);
    return;
  }

  level.linkEntity(entity);
}

/**
 * `45 + crandom() * 15` (`g_items.c:704`), by the rules: when a powerup first appears, in seconds.
 * Drawn together, the first powerup's draw is every other's on the level.
 */
function firstPowerupDelay(level: Level): number {
  const { rules } = level;
  const together = rules.g_spawnDelayTogether_powerup !== 0;
  if (together && level.firstPowerupDelay !== null) return level.firstPowerupDelay;
  const delay =
    rules.g_spawnDelay_powerup +
    crandom(level.itemMatch.random) * rules.g_spawnDelayRandom_powerup;
  if (together) level.firstPowerupDelay = delay;
  return delay;
}

/**
 * `LaunchItem` (`g_items.c:571–612`): an item thrown into the world rather than placed by a map.
 *
 * It is the same kind of entity a map's item is, with three differences: its trajectory is a
 * fall under gravity rather than a stand, `s.modelindex2` is 1 — "this is non-zero is it's a
 * dropped item", which is how the flag rule tells a dropped flag from one on its stand — and it
 * is freed after thirty seconds rather than put back, because a dropped item is nobody's to
 * bring back.
 *
 * @param level - The level it is thrown into.
 * @param item - The table entry it is.
 * @param origin - Where it starts, which is the thrower's own place.
 * @param velocity - How it is thrown.
 */
export function launchItem(level: Level, item: GItem, origin: Vec3, velocity: Vec3): GameEntity {
  const dropped = level.spawnEntity();

  dropped.s.eType = ET.ITEM;
  dropped.s.modelindex = itemIndex(item);
  // "This is non-zero is it's a dropped item" (`:578`): the flag rule reads it, and it is why a
  // dropped flag may be taken back by the team that dropped it.
  dropped.s.modelindex2 = 1;

  dropped.classname = item.classname;
  dropped.item = item;
  dropped.r.mins = vec3(-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS);
  dropped.r.maxs = vec3(ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS);
  dropped.r.contents = CONTENTS.TRIGGER;

  dropped.touch = (self, other) => touchItem(level, self, other);

  setEntityOrigin(dropped, origin);
  dropped.s.pos.trType = TR.GRAVITY;
  dropped.s.pos.trTime = level.time;
  dropped.s.pos.trDelta = copy(velocity);

  dropped.s.eFlags |= EF_BOUNCE_HALF;

  // "Special case for CTF flags" (`:596–606`): a dropped flag goes home rather than away, and
  // the base it belongs to is told at once that it is on the floor. Everything else is
  // auto-removed after its thirty seconds. Both wait the same thirty — `CTF_FLAG_RETURN_TIME` is
  // 40 seconds and nothing in baseq3 reads it.
  if (level.itemMatch.gametype() === GT.CTF && item.giType === IT.TEAM) {
    dropped.think = (self) => teamDroppedFlagThink(level, self);
    dropped.nextthink = level.time + DROPPED_ITEM_LIFE;
    teamCheckDroppedItem(level, dropped);
  } else {
    dropped.think = (self) => level.freeEntity(self);
    dropped.nextthink = level.time + DROPPED_ITEM_LIFE;
  }

  dropped.flags = FL.DROPPED_ITEM;

  level.linkEntity(dropped);
  return dropped;
}

/**
 * `Drop_Item` (`g_items.c:621–634`): throw an item from where its owner stands, along their yaw
 * plus a fan angle — a death fans the powerups out 45° a step — always level, at 150 ups, with a
 * random 200 ± 50 of lift.
 *
 * @param level - The level it is thrown into.
 * @param entity - Who is throwing it: its place and its facing are theirs.
 * @param item - The table entry.
 * @param angle - Degrees to turn the throw from the thrower's yaw.
 */
export function dropItem(level: Level, entity: GameEntity, item: GItem, angle: number): GameEntity {
  const angles = copy(entity.s.apos.trBase);
  angles.y += angle;
  angles.x = 0; // always forward

  const velocity = scale(angleVectors(angles).forward, DROP_SPEED);
  velocity.z += DROP_LIFT + crandom(level.itemMatch.random) * DROP_LIFT_VARIANCE;

  return launchItem(level, item, entity.s.pos.trBase, velocity);
}
