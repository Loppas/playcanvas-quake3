import { ENTITYNUM_NONE } from '../net/protocol';
import { CON } from './client';
import {
  CONTENTS,
  DEFAULT_GRAVITY,
  EF_NODRAW,
  FL,
  GT,
  PERS,
  PLAYEREVENT,
  STAT
} from './constants';
import { addPredictableEvent, EV } from './events';
import { addEvent, SVF, type GameEntity } from './game-entity';
import type { GItem } from './items';
import {
  AMMO_SUFFIX,
  ARMOR_TIER,
  armorCap,
  armorKind,
  canItemBeGrabbed,
  healthLimit,
  IT,
  itemIndex,
  maxAmmo,
  pickupAmount,
  PW,
  rescaleArmor,
  tierRule,
  weaponQuantity
} from './items';
import type { Level } from './level';
import { angleVectors } from './pmove-math';
import { ID_RULES, type Rules } from './rules';
import { tempEntity } from './temp-entity';
import { useTargets } from './targets';
import { dot, length, normalize, sub, vec3, type Vec3 } from './vec3';
import { WP } from './weapons/constants';

/**
 * `g_items.c`'s touch half: what happens when a player walks into an item, and how the item comes
 * back afterwards.
 *
 * `item-spawn.ts` is the other half and calls into this one; nothing here calls back into it, so
 * the two are one way round. The table itself and the grab rules are `items.ts`, shared with the
 * client's prediction in Quake 3 and stateless here.
 *
 * How long a taken item is gone is the server's answer, not the item's, so it lives here rather
 * than in the table: the rules time each kind but the weapons, which `g_weaponrespawn` times.
 */

/** `RESPAWN_HOLDABLE` (`g_items.c:42`): seconds until a holdable returns. */
export const RESPAWN_HOLDABLE = 60;

/** How often a megahealth that wears off looks at its taker, in milliseconds. */
const WEAR_OFF_POLL = 1000;

/** `g_weaponrespawn` (`g_main.c:145`) and `g_weaponTeamRespawn`: what a weapon comes back in. */
export const WEAPON_RESPAWN_DEFAULT = 5;
export const WEAPON_TEAM_RESPAWN_DEFAULT = 30;

/**
 * What an item's or a trigger's callbacks read from the match around them.
 *
 * Quake 3's game half is a singleton: `g_gametype.integer`, the respawn cvars, `G_Printf` and the
 * seeded `rand()` are all globals any function may reach. The port passes what a callback needs
 * instead, and this is the shape an item's needs take — and a jump pad's, whose apex is solved
 * against `g_gravity`, and `G_Damage`'s, which asks whose side the two of them are on.
 * Every part is read at the *call*, so a cvar an operator changes lands on the next pickup rather
 * than the next map.
 */
export interface ItemMatch {
  /** `g_gametype`, which the grab rules, the weapon respawn and `OnSameTeam` read. */
  gametype: () => number;
  /** `g_friendlyFire` (`g_main.c:122`): whether a hit on a team mate lands at all. */
  friendlyFire: () => number;
  /** The game module's seeded `rand()` (`G_InitGame`'s `srand`). */
  random: () => number;
  /** `g_weaponrespawn`, in seconds. */
  weaponRespawn: () => number;
  /** `g_weaponTeamRespawn`, in seconds. */
  weaponTeamRespawn: () => number;
  /**
   * `g_gravity.value`, a C float, as the game last took it up, which a jump pad's aim and a
   * pendulum's swing are solved against.
   */
  gravity: () => number;
  /** `G_Printf`. */
  print: (text: string) => void;
  /** `G_SoundIndex`: a sound's slot in the match's `CS_SOUNDS`, which an event carries. */
  soundIndex: (name: string) => number;
  /** `G_ModelIndex`: a model's slot in the match's `CS_MODELS`, which `s.modelindex2` carries. */
  modelIndex: (name: string) => number;
  /** `AddScore` (`g_combat.c:52–67`), which a flag's return and its capture are worth. */
  addScore: (entity: GameEntity, origin: Vec3, score: number) => void;
  /** `CalculateRanks` (`g_main.c:686–768`), which a capture ends with. */
  calculateRanks: () => void;
  /**
   * `Pickup_Team` (`g_team.c:836–895`): the flags' own pickup, which lives in `team.ts` because
   * it is `g_team.c`'s.
   *
   * Quake 3's `g_items.c` and `g_team.c` call each other, which two modules cannot, so the item
   * half is the leaf and the flag half reaches it from here. A level with no match has no flag
   * rules and answers 0, which is `Touch_Item`'s "nothing happened".
   */
  pickupTeam: (entity: GameEntity, other: GameEntity) => number;
}

/**
 * What a level with no game module offers: free-for-all with friendly fire off, the two cvar
 * defaults, the runtime's `Math.random`, and a console that prints nothing. It is what a
 * callback reads when a test builds a level on its own, and what {@link Level} starts with
 * before a match says otherwise.
 */
export const DEFAULT_ITEM_MATCH: ItemMatch = {
  gametype: () => GT.FFA,
  friendlyFire: () => 0,
  random: Math.random,
  weaponRespawn: () => WEAPON_RESPAWN_DEFAULT,
  weaponTeamRespawn: () => WEAPON_TEAM_RESPAWN_DEFAULT,
  gravity: () => DEFAULT_GRAVITY,
  print: () => {},
  // No match, no sound block: an event that names a sound names slot 0, which is no sound.
  soundIndex: () => 0,
  modelIndex: () => 0,
  addScore: () => {},
  calculateRanks: () => {},
  pickupTeam: () => 0
};

/** `sound/items/poweruprespawn.wav` (`g_items.c:395`): a powerup arriving is announced. */
export const POWERUP_RESPAWN_SOUND = 'sound/items/poweruprespawn.wav';

/**
 * `Q_crandom` (`q_shared.c`): a fraction in [-1, 1), twice a uniform fraction less one.
 *
 * The same shape as `Q3Random.crandom` in the weapons, for the places that draw from the match's
 * own seeded generator rather than from a per-shot one.
 */
export function crandom(random: () => number): number {
  return 2 * (random() - 0.5);
}

/** @throws when the entity is not an item, which every caller here knows it is */
function itemOf(entity: GameEntity): GItem {
  if (!entity.item) throw new Error('item-touch: the entity has no item');
  return entity.item;
}

/**
 * `Add_Ammo` (`g_items.c:209–215`): give a weapon ammo, up to the most it may hold: id's 200, or
 * the rules' maximum, which also cuts back ammo held over it.
 *
 * The cap is on the *player* rather than on any item, so a map's `count` cannot overfill either.
 */
export function addAmmo(
  entity: GameEntity,
  weapon: number,
  count: number,
  rules: Readonly<Rules> = ID_RULES
): void {
  const ps = entity.client!.ps;
  ps.ammo[weapon] += count;
  const max = maxAmmo(rules, weapon);
  if (ps.ammo[weapon] > max) ps.ammo[weapon] = max;
}

/**
 * `Pickup_Weapon` (`g_items.c:235–273`): grant the weapon, and ammo by the respawning rules.
 *
 * A *dropped* weapon, or any in a team game, carries its whole amount, which is what makes a
 * dropped rocket launcher worth crossing the map for and why TDM's weapon respawns are so slow.
 * Otherwise a weapon a player already has is worth one shot rather than its whole box. With the
 * top-up on, outside free-for-all, CPMA's rule stands instead: the whole amount for a weapon not
 * held, and for one held only what tops it up, and nothing once there.
 *
 * A map's `count` stands in for the amount but under the top-up, and a negative one is "none for
 * you, sir". A pack, while the rules drop them, gives the weapon and the ammo it carries instead.
 */
export function pickupWeapon(level: Level, entity: GameEntity, other: GameEntity): number {
  const item = itemOf(entity);
  const match = level.itemMatch;
  const gametype = match.gametype();
  const { rules } = level;
  const ps = other.client!.ps;
  const ammo = ps.ammo[item.giTag];
  const respawn = gametype === GT.TEAM ? match.weaponTeamRespawn() : match.weaponRespawn();
  let quantity: number;

  if (entity.pack && rules.g_dropWeaponAmmo) {
    ps.stats[STAT.WEAPONS] |= 1 << item.giTag;
    takePack(other, entity.pack, rules);
    return respawn;
  }

  if (entity.count < 0) {
    quantity = 0;
  } else if (entity.flags & FL.DROPPED_ITEM || gametype === GT.TEAM) {
    quantity = entity.count ? entity.count : pickupAmount(rules, 'g_weaponPickup', item, gametype);
  } else if (rules.g_weaponPickupTopUp && gametype !== GT.FFA) {
    const amount = pickupAmount(rules, 'g_weaponPickup', item, gametype);
    const held = ps.stats[STAT.WEAPONS] & (1 << item.giTag);
    quantity = held ? Math.max(amount - ammo, 0) : amount;
  } else {
    const full = entity.count ? entity.count : weaponQuantity(rules, item);
    quantity = ammo < full ? full - ammo : 1;
  }

  ps.stats[STAT.WEAPONS] |= 1 << item.giTag;
  addAmmo(other, item.giTag, quantity, rules);
  // The hook is not a weapon with ammo: it is out or it is not, and −1 is Q3's way of saying so.
  if (item.giTag === WP.GRAPPLING_HOOK) ps.ammo[item.giTag] = -1;

  return respawn;
}

/**
 * `Pickup_Ammo` (`g_items.c:217–230`): the map's `count`, or the box's amount by the rules,
 * which in team deathmatch is its own. A pack, while the rules drop them, gives what it carries.
 */
export function pickupAmmo(level: Level, entity: GameEntity, other: GameEntity): number {
  const item = itemOf(entity);
  const { rules } = level;
  if (entity.pack && rules.g_dropWeaponAmmo) {
    takePack(other, entity.pack, rules);
    return rules.g_ammoRespawn;
  }
  const gametype = level.itemMatch.gametype();
  const box = pickupAmount(rules, 'g_ammoPickup', item, gametype);
  const quantity = entity.count ? entity.count : box;
  addAmmo(other, item.giTag, quantity, rules);
  return rules.g_ammoRespawn;
}

/** A pack's ammo, each weapon's added up to its maximum. */
function takePack(other: GameEntity, pack: readonly number[], rules: Readonly<Rules>): void {
  for (const weapon of AMMO_SUFFIX.keys()) addAmmo(other, weapon, pack[weapon], rules);
}

/**
 * `Pickup_Armor` (`g_items.c:317–341`): armor goes on and stops at twice the health limit — one
 * hundred over a hundred-health player, which is what an armor pickup is worth.
 *
 * The rules give each armour its amount and its cap. Tiered, the item sets the player's tier, the
 * shard keeping it or giving the green from none; with the rescale on too, a change of tier first
 * rescales the armour held. Untiered, the tier is the yellow.
 */
export function pickupArmor(
  entity: GameEntity,
  other: GameEntity,
  rules: Readonly<Rules> = ID_RULES
): number {
  const item = itemOf(entity);
  const { stats } = other.client!.ps;
  const kind = armorKind(item.quantity);
  const held = stats[STAT.ARMOR_TIER];

  let tier: number = ARMOR_TIER.YA;
  if (rules.armor_tiered) {
    tier = kind ?? (stats[STAT.ARMOR] > 0 ? held : ARMOR_TIER.GA);
    if (rules.armor_rescale && tier !== held) {
      stats[STAT.ARMOR] = rescaleArmor(rules, stats[STAT.ARMOR], held, tier);
    }
  }

  const cap = armorCap(rules, kind, stats);
  stats[STAT.ARMOR] += kind === null ? item.quantity : tierRule(rules, 'pickup', kind);
  if (stats[STAT.ARMOR] > cap) stats[STAT.ARMOR] = cap;
  stats[STAT.ARMOR_TIER] = tier;
  return rules.g_armorRespawn;
}

/**
 * `RespawnItem` (`g_items.c:350–418`): put an item back in the world.
 *
 * An item in a `team` is part of a set the map placed at one spot — several healths by a lift, the
 * armour and the shard on a ledge — and only ever *one* of them is present: this brings back one
 * of the set at random rather than the one whose timer expired. The chosen member is the one the
 * rest of this works on, which is why the entity name is reassigned before anything is restored.
 *
 * A powerup is announced to the whole match as it arrives — through the sound block, because that
 * is how Q3 names a sound on an event — unless the map's `noglobalsound` keeps it where it
 * stands. Everything else arrives with `EV_ITEM_RESPAWN` alone, which the client plays where it
 * can hear it.
 *
 * @throws with Q3's `G_Error` when a member of a team has no master
 */
export function respawnItem(level: Level, entity: GameEntity): void {
  if (entity.team !== null) {
    if (!entity.teammaster) throw new Error('RespawnItem: bad teammaster');

    let count = 0;
    for (let member: GameEntity | null = entity.teammaster; member; member = member.teamchain) count++;
    const choice = Math.floor(level.itemMatch.random() * count);

    let chosen: GameEntity | null = entity.teammaster;
    for (let i = 0; chosen && i < choice; i++) chosen = chosen.teamchain;
    if (!chosen) return;
    entity = chosen;
  }

  entity.r.contents = CONTENTS.TRIGGER;
  entity.s.eFlags &= ~EF_NODRAW;
  entity.r.svFlags &= ~SVF.NOCLIENT;
  level.linkEntity(entity);

  // A powerup's arrival is announced to the whole match, so that it is heard wherever it is being
  // waited for. `noglobalsound` keeps it where the powerup stands instead: Q3 sends the same sound
  // as a general one, and the client plays a general sound from the entity that carries it.
  if (itemOf(entity).giType === IT.POWERUP) {
    const announcement = tempEntity(
      level,
      entity.s.pos.trBase,
      entity.speed ? EV.GENERAL_SOUND : EV.GLOBAL_SOUND
    );
    announcement.s.eventParm = level.itemMatch.soundIndex(POWERUP_RESPAWN_SOUND);
    announcement.r.svFlags |= SVF.BROADCAST;
  }

  // `EV_ITEM_RESPAWN` is the pop: the client shows the item scaling up over a second.
  addEvent(entity, EV.ITEM_RESPAWN, 0, level.time);
  entity.nextthink = 0;
}

/** `Use_Item` (`g_items.c:644–646`): firing an item by its `targetname` puts it back. */
export function useItem(level: Level, entity: GameEntity): void {
  respawnItem(level, entity);
}

/**
 * `Touch_Item` (`g_items.c:426–559`): a player walked into an item, so take it if they may.
 *
 * The order is the whole of it. The guards come first — only a live client picks anything up, and
 * only a pack or what `BG_CanItemBeGrabbed` allows — then the item's own pickup, which answers
 * how long it is gone for; a pickup that answers zero takes nothing and the touch ends there.
 * Then the two announcements: the picker's own event (predictable when their client asked for
 * that, which a powerup never is because its sound is the world's rather than theirs), and for a
 * powerup or a flag the global one, which is a temp entity so that every client hears it wherever
 * they are.
 *
 * What is left is the item's own disappearance: named targets fire, a `wait` of −1 removes it for
 * good — a rune or a flag that something else will bring back — and otherwise the map's `wait`
 * and `random` decide when it returns. Even while it is gone the entity stays *linked*, with no
 * contents and nothing to draw, because an item may be standing on a mover that has to carry it.
 *
 * `Pickup_Team` is the flags' and lives in `team.ts`, reached through {@link ItemMatch} so that
 * the item half and `g_team.c`'s stay one way round. `G_LogPrintf`'s "Item: %i %s" line is the
 * game log's, which the port does not write.
 */
export function touchItem(level: Level, entity: GameEntity, other: GameEntity): void {
  const item = itemOf(entity);
  const client = other.client;

  if (!client) return;
  if (client.ps.stats[STAT.HEALTH] < 1) return;
  const gametype = level.itemMatch.gametype();
  if (!entity.pack && !canItemBeGrabbed(gametype, entity.s, client.ps, level.rules)) return;

  let predict = client.pers.predictItemPickup;
  let respawn = 0;

  switch (item.giType) {
    case IT.WEAPON:
      respawn = pickupWeapon(level, entity, other);
      break;
    case IT.AMMO:
      respawn = pickupAmmo(level, entity, other);
      break;
    case IT.ARMOR:
      respawn = pickupArmor(entity, other, level.rules);
      break;
    case IT.HEALTH:
      respawn = pickupHealth(entity, other, level.rules);
      break;
    case IT.POWERUP:
      respawn = pickupPowerup(level, entity, other);
      predict = false;
      break;
    case IT.TEAM:
      respawn = level.itemMatch.pickupTeam(entity, other);
      break;
    case IT.HOLDABLE:
      respawn = pickupHoldable(entity, other);
      break;
    default:
      // `IT_BAD` and Team Arena's persistant powerup are what is left, and neither is pickable:
      // Quake 3 returns without so much as a sound, and the item stays where it was.
      return;
  }

  if (!respawn) return;

  if (predict) {
    addPredictableEvent(client.ps, EV.ITEM_PICKUP, entity.s.modelindex);
  } else {
    addEvent(other, EV.ITEM_PICKUP, entity.s.modelindex, level.time);
  }

  // A powerup or a flag is announced to the whole match, unless the map asked for quiet.
  if (item.giType === IT.POWERUP || item.giType === IT.TEAM) {
    const global = tempEntity(level, entity.s.pos.trBase, EV.GLOBAL_ITEM_PICKUP);
    global.s.eventParm = entity.s.modelindex;
    if (!entity.speed) {
      global.r.svFlags |= SVF.BROADCAST;
    } else {
      global.r.svFlags |= SVF.SINGLECLIENT;
      global.r.singleClient = other.s.number;
    }
  }

  useTargets(level, entity, other, level.itemMatch.print);

  // A wait of −1 will not respawn: something else has to fire the item to bring it back.
  if (entity.wait === -1) {
    entity.r.svFlags |= SVF.NOCLIENT;
    entity.s.eFlags |= EF_NODRAW;
    entity.r.contents = 0;
    entity.unlinkAfterEvent = true;
    return;
  }

  // The map's own times, which a weapon and a powerup take only as the rules let them. The
  // respawn is whole seconds, as Q3's `int` makes it.
  const { rules } = level;
  const weapon = item.giType === IT.WEAPON;
  const powerup = item.giType === IT.POWERUP;
  const mapWait = weapon ? rules.g_mapWeaponWait : powerup ? rules.g_mapPowerupTimes : 1;
  const mapRandom = weapon ? rules.g_mapWeaponRandom : powerup ? rules.g_mapPowerupTimes : 1;
  if (entity.wait && mapWait) respawn = Math.trunc(entity.wait);
  if (entity.random && mapRandom) {
    respawn = Math.trunc(respawn + crandom(level.itemMatch.random) * entity.random);
    if (respawn < 1) respawn = 1;
  }

  // A dropped weapon is not the map's to bring back, so it goes for good once seen.
  if (entity.flags & FL.DROPPED_ITEM) entity.freeAfterEvent = true;

  entity.r.svFlags |= SVF.NOCLIENT;
  entity.s.eFlags |= EF_NODRAW;
  entity.r.contents = 0;

  // A negative respawn time never comes back but keeps its slot; Q3's flags do that from `wait`.
  if (respawn <= 0) {
    entity.nextthink = 0;
    entity.think = null;
  } else {
    entity.nextthink = level.time + respawn * 1000;
    entity.think = (self) => respawnItem(level, self);
  }

  // A megahealth that wears off ignores the map's times, all but a wait of −1: from the pickup, it
  // looks every second for its taker to have lost the bonus.
  if (wearsOff(level, item)) {
    entity.nextthink = level.time + WEAR_OFF_POLL;
    entity.think = (self) => megaHealthWearOff(level, self);
  }
  level.linkEntity(entity);
}

/** Whether a taken megahealth waits for its bonus to wear off: by the rules, outside FFA. */
function wearsOff(level: Level, item: GItem): boolean {
  return (
    item.giType === IT.HEALTH &&
    item.quantity === 100 &&
    level.rules.g_megaHealthWearOff > 0 &&
    level.itemMatch.gametype() !== GT.FFA
  );
}

/**
 * A megahealth waiting for its bonus to wear off, once a second. While its taker is a player over
 * 100 health it waits on; once they are not, whether dead, gone, spectating or down to 100, it
 * comes back `g_megaHealthWearOff` seconds later.
 */
export function megaHealthWearOff(level: Level, entity: GameEntity): void {
  const taker = entity.enemy;
  if (taker?.classname === 'player' && taker.client && taker.client.ps.stats[STAT.HEALTH] > 100) {
    entity.nextthink = level.time + WEAR_OFF_POLL;
    return;
  }
  entity.nextthink = level.time + level.rules.g_megaHealthWearOff * 1000;
  entity.think = (self) => respawnItem(level, self);
}

/**
 * `Pickup_Powerup` (`g_items.c:49–116`): the quad and its kind, whose quantity is a *duration* in
 * seconds rather than an amount.
 *
 * The timer is rounded down to a whole second before the new time is added, so that two powerups
 * taken a moment apart count down together instead of shimmering. A map's `count` overrides the
 * table's duration but not the rounding.
 *
 * Everyone else alive who watched it go is told "denied": within 192 units of the item, facing it
 * to within about 66 degrees, with nothing solid between — but never a teammate in a team game.
 */
export function pickupPowerup(level: Level, entity: GameEntity, other: GameEntity): number {
  const item = itemOf(entity);
  const taker = other.client!;
  const ps = taker.ps;
  if (!ps.powerups[item.giTag]) {
    ps.powerups[item.giTag] = level.time - (level.time % 1000);
  }
  const quantity = entity.count ? entity.count : item.quantity;
  ps.powerups[item.giTag] += quantity * 1000;

  const at = entity.s.pos.trBase;
  for (let i = 0; i < level.maxclients; i++) {
    const client = level.clients[i];
    if (client === taker || client.pers.connected === CON.DISCONNECTED) continue;
    if (client.ps.stats[STAT.HEALTH] <= 0) continue;
    // Quake 3 compares sessions here rather than asking `OnSameTeam`, which wants entities.
    if (
      level.itemMatch.gametype() >= GT.TEAM &&
      taker.sess.sessionTeam === client.sess.sessionTeam
    ) {
      continue;
    }
    const delta = sub(at, client.ps.origin);
    if (length(delta) > 192) continue;
    if (dot(normalize(delta), angleVectors(client.ps.viewangles).forward) < 0.4) continue;
    const tr = level.trace(client.ps.origin, vec3(), vec3(), at, ENTITYNUM_NONE, CONTENTS.SOLID);
    if (tr.fraction !== 1) continue;
    client.ps.persistant[PERS.PLAYEREVENTS] ^= PLAYEREVENT.DENIEDREWARD;
  }

  const { rules } = level;
  const scale =
    item.giTag === PW.BATTLESUIT
      ? rules.g_respawnScale_enviro
      : item.giTag === PW.INVIS
        ? rules.g_respawnScale_invis
        : 1;
  return Math.trunc(rules.g_powerupRespawn * scale);
}

/**
 * `Pickup_Holdable` (`g_items.c:195–204`): the player may carry one holdable at a time, so the
 * table slot goes straight onto the state.
 *
 * Quake 3 also sets `EF_KAMIKAZE` for the kamikaze, which is Team Arena's holdable; baseq3's
 * table has none, so the branch has nothing to read here.
 */
export function pickupHoldable(entity: GameEntity, other: GameEntity): number {
  const item = itemOf(entity);
  other.client!.ps.stats[STAT.HOLDABLE_ITEM] = itemIndex(item);
  return RESPAWN_HOLDABLE;
}

/**
 * `Pickup_Health` (`g_items.c:278–313`): health goes on, and how far it may go depends on what
 * took it there. An ordinary health tops up to the limit; a *small* one (5) and the *mega* (100)
 * may go on to twice it, which is what makes them worth crossing the map for.
 *
 * Quake 3 adds to `ent->health` and mirrors it into the player state; the port keeps the one copy
 * the rest of it reads, on the state. A mega keeps its taker as its `enemy`, for its bonus to be
 * watched wearing off.
 */
export function pickupHealth(
  entity: GameEntity,
  other: GameEntity,
  rules: Readonly<Rules> = ID_RULES
): number {
  const item = itemOf(entity);
  const ps = other.client!.ps;
  const overMax = item.quantity === 5 || item.quantity === 100;
  const limit = healthLimit(rules, ps.stats);
  const max = overMax ? limit * 2 : limit;
  const quantity = entity.count ? entity.count : item.quantity;

  ps.stats[STAT.HEALTH] += quantity;
  if (ps.stats[STAT.HEALTH] > max) ps.stats[STAT.HEALTH] = max;

  if (item.quantity === 100) entity.enemy = other;
  return rules.g_healthRespawn;
}
