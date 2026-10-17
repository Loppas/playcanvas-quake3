import type { EntityState, PlayerState } from '../net/protocol';
import { GT, PERS, STAT, TEAM } from './constants';
import { ID_RULES, type Rules, type SysteminfoRules } from './rules';
import { evaluateTrajectory } from './trajectory';
import { WP } from './weapons/constants';

/**
 * `bg_itemlist` and the two tests a pickup runs first (`bg_misc.c`): what each item is, and
 * whether a player may take it. Shared with prediction in Quake 3 and stateless here, so it reads
 * only the states the wire carries.
 */

/** `itemType_t` (`bg_public.h:615–627`). */
export const IT = {
  BAD: 0,
  WEAPON: 1,
  AMMO: 2,
  ARMOR: 3,
  HEALTH: 4,
  POWERUP: 5,
  HOLDABLE: 6,
  /** Team Arena's; baseq3 has no item of it, and it is carried so the numbering stays Q3's. */
  PERSISTANT_POWERUP: 7,
  TEAM: 8
} as const;

/** `powerup_t` (`bg_public.h:271–294`), baseq3's half: 1 is the first powerup, 7 and 8 the flags. */
export const PW = {
  NONE: 0,
  QUAD: 1,
  BATTLESUIT: 2,
  HASTE: 3,
  INVIS: 4,
  REGEN: 5,
  FLIGHT: 6,
  REDFLAG: 7,
  BLUEFLAG: 8,
  /**
   * `PW_NUM_POWERUPS` (`bg_public.h:294`): one past the last slot a `playerState_t` carries, and
   * the bound the death toss walks. Slots 9 to 15 are Team Arena's and have no baseq3 item.
   */
  NUM_POWERUPS: 16
} as const;

/**
 * `BG_PlayerStateToEntityState`'s `powerups` (`bg_misc.c:1221–1224`): the slots a player state
 * holds, as the bitmask an entity state carries — which is what the shells are read from.
 */
export function powerupMask(powerups: readonly number[]): number {
  let mask = 0;
  for (let i = 0; i < powerups.length; i++) {
    if (powerups[i]) mask |= 1 << i;
  }
  return mask;
}

/** `holdable_t` (`bg_public.h:296–306`), baseq3's half. */
export const HI = {
  NONE: 0,
  TELEPORTER: 1,
  MEDKIT: 2
} as const;

/** `HI_NUM_HOLDABLE` (`bg_public.h:305`): one past the last holdable a `CG_UseItem` knows. */
export const HI_NUM_HOLDABLE = 6;

/**
 * The medkit heals to this far over the max (`g_active.c:631`), and is refused at that line
 * (`bg_pmove.c:1559–1561`) — so a full-health player can never take one it has no room for.
 */
export const MEDKIT_HEAL = 25;

/** The health limit under `g_fixedHealthLimits`, whatever the handicap. */
export const FIXED_HEALTH_LIMIT = 100;

/**
 * The health the pickups, the medkit, regeneration and the decay measure from: the max health,
 * which the handicap lowers, or {@link FIXED_HEALTH_LIMIT} under `g_fixedHealthLimits`.
 */
export function healthLimit(rules: Readonly<SysteminfoRules>, stats: readonly number[]): number {
  return rules.g_fixedHealthLimits ? FIXED_HEALTH_LIMIT : stats[STAT.MAX_HEALTH];
}

/**
 * The armour's tiers, as `STAT_ARMOR_TIER` holds them. YA is 0 and id's one armour, so a player
 * state that never took a tier holds it.
 */
export const ARMOR_TIER = { YA: 0, GA: 1, RA: 2 } as const;

/** Each tier's suffix on its rules, by its number. */
const TIER_SUFFIX = ['ya', 'ga', 'ra'] as const;

/** A tier's rule: `armor_<name>_<tier>`. */
export function tierRule(
  rules: Readonly<SysteminfoRules>,
  name: 'protection' | 'pickup' | 'max' | 'decayTime',
  tier: number
): number {
  return rules[`armor_${name}_${TIER_SUFFIX[tier]}`];
}

/** An armour item's tier, known by its quantity as CPMA knows it; null for the shard. */
export function armorKind(quantity: number): number | null {
  if (quantity === 25) return ARMOR_TIER.GA;
  if (quantity === 50) return ARMOR_TIER.YA;
  if (quantity === 100) return ARMOR_TIER.RA;
  return null;
}

/**
 * What an armour item stops at: its tier's max, or twice the health limit where that is 0 and for
 * the shard.
 */
export function armorCap(
  rules: Readonly<SysteminfoRules>,
  kind: number | null,
  stats: readonly number[]
) {
  const max = kind === null ? 0 : tierRule(rules, 'max', kind);
  return max > 0 ? max : healthLimit(rules, stats) * 2;
}

/**
 * The armour held in one tier as the same protection in another, as CPMA's pickup and grab check
 * make it: truncated, in the VM's single precision, where a double loses a point at every 22 of
 * red turned yellow.
 */
export function rescaleArmor(
  rules: Readonly<SysteminfoRules>,
  armor: number,
  from: number,
  to: number
) {
  const share = (tier: number) => Math.fround(tierRule(rules, 'protection', tier));
  const ratio = Math.fround(share(from) / share(to));
  return Math.trunc(Math.fround(armor * ratio));
}

/** A weapon's suffix on its ammo rules, `<family>_<w>`. */
type AmmoSuffix = 'mg' | 'sg' | 'gl' | 'rl' | 'lg' | 'rg' | 'pg' | 'bfg';

/** The weapons with ammo rules, by their suffixes. */
export const AMMO_SUFFIX: ReadonlyMap<number, AmmoSuffix> = new Map<number, AmmoSuffix>([
  [WP.MACHINEGUN, 'mg'],
  [WP.SHOTGUN, 'sg'],
  [WP.GRENADE_LAUNCHER, 'gl'],
  [WP.ROCKET_LAUNCHER, 'rl'],
  [WP.LIGHTNING, 'lg'],
  [WP.RAILGUN, 'rg'],
  [WP.PLASMAGUN, 'pg'],
  [WP.BFG, 'bfg']
]);

/** The most ammo a weapon holds: its `g_maxAmmo_<w>`, or id's 200 for one without ammo rules. */
export function maxAmmo(rules: Readonly<SysteminfoRules>, weapon: number): number {
  const suffix = AMMO_SUFFIX.get(weapon);
  return suffix ? rules[`g_maxAmmo_${suffix}`] : 200;
}

/**
 * What a box or a weapon of `item`'s gives by the table: its `<family>_<w>`, or its `_tdm` in team
 * deathmatch. A weapon without ammo rules gives the item's quantity.
 */
export function pickupAmount(
  rules: Readonly<Rules>,
  family: 'g_ammoPickup' | 'g_weaponPickup',
  item: GItem,
  gametype: number
): number {
  const suffix = AMMO_SUFFIX.get(item.giTag);
  if (!suffix) return item.quantity;
  return gametype === GT.TEAM ? rules[`${family}_${suffix}_tdm`] : rules[`${family}_${suffix}`];
}

/** What id's rule tops a weapon of `item`'s up to: its `g_weaponQuantity_<w>`, or its quantity. */
export function weaponQuantity(rules: Readonly<Rules>, item: GItem): number {
  const suffix = AMMO_SUFFIX.get(item.giTag);
  return suffix ? rules[`g_weaponQuantity_${suffix}`] : item.quantity;
}

/** `MAX_ITEM_MODELS` (`bg_public.h:629`). */
export const MAX_ITEM_MODELS = 4;

/** One `gitem_t` (`bg_public.h:631–646`). */
export interface GItem {
  /** The name a map spawns it by. */
  classname: string;
  /** The sound a pickup plays; the flags have none. */
  pickupSound: string | null;
  /** Up to four world models; the second is the health's sphere or the powerup's ring. */
  worldModel: (string | null)[];
  icon: string;
  /** Printed on pickup. */
  pickupName: string;
  /** For ammo how much, or a powerup's duration in seconds. */
  quantity: number;
  /** One of {@link IT}. */
  giType: number;
  /** A `WP` value, a {@link PW} value or an {@link HI} value, by type. */
  giTag: number;
  /** Files beyond the models this item will use — empty for every baseq3 item. */
  precaches: string;
  /** The sounds a client registers with the item, space separated. */
  sounds: string;
  /**
   * A colour the client multiplies the item's models and icon by, for an item drawn with another's
   * art. baseq3's items have none.
   */
  tint?: readonly [number, number, number];
}

/**
 * The Green Armor's colour: the yellow armour's art turned green. It takes the yellow's body near
 * CPMA's green one, and its flat yellow icon near CPMA's flat green.
 */
export const GREEN_ARMOR_TINT = [0.2, 0.9, 0.2] as const;

/**
 * `bg_itemlist` (`bg_misc.c:44–655`), baseq3's 35 items with slot 0 left as Q3 leaves it — a
 * `gitem_t` whose strings are NULL and whose type is `IT_BAD`, so nothing ever finds it and the
 * index check below is the only thing that keeps it from being grabbed.
 *
 * After them comes CPMA's Green Armor, which baseq3 has no art for: it is drawn as the yellow
 * armour, tinted. Last, so every baseq3 item keeps Q3's slot.
 *
 * The slot is the item's identity: an item entity carries it in `s.modelindex`, and it is what
 * `BG_CanItemBeGrabbed` indexes by.
 */
export const ITEMS: readonly GItem[] = [
  {
    classname: '',
    pickupSound: null,
    worldModel: [null, null, null, null],
    icon: '',
    pickupName: '',
    quantity: 0,
    giType: IT.BAD,
    giTag: 0,
    precaches: '',
    sounds: ''
  },

  {
    classname: 'item_armor_shard',
    pickupSound: 'sound/misc/ar1_pkup.wav',
    worldModel: ['models/powerups/armor/shard.md3', 'models/powerups/armor/shard_sphere.md3', null, null],
    icon: 'icons/iconr_shard',
    pickupName: 'Armor Shard',
    quantity: 5,
    giType: IT.ARMOR,
    giTag: 0,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_armor_combat',
    pickupSound: 'sound/misc/ar2_pkup.wav',
    worldModel: ['models/powerups/armor/armor_yel.md3', null, null, null],
    icon: 'icons/iconr_yellow',
    pickupName: 'Armor',
    quantity: 50,
    giType: IT.ARMOR,
    giTag: 0,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_armor_body',
    pickupSound: 'sound/misc/ar2_pkup.wav',
    worldModel: ['models/powerups/armor/armor_red.md3', null, null, null],
    icon: 'icons/iconr_red',
    pickupName: 'Heavy Armor',
    quantity: 100,
    giType: IT.ARMOR,
    giTag: 0,
    precaches: '',
    sounds: ''
  },

  {
    classname: 'item_health_small',
    pickupSound: 'sound/items/s_health.wav',
    worldModel: ['models/powerups/health/small_cross.md3', 'models/powerups/health/small_sphere.md3', null, null],
    icon: 'icons/iconh_green',
    pickupName: '5 Health',
    quantity: 5,
    giType: IT.HEALTH,
    giTag: 0,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_health',
    pickupSound: 'sound/items/n_health.wav',
    worldModel: ['models/powerups/health/medium_cross.md3', 'models/powerups/health/medium_sphere.md3', null, null],
    icon: 'icons/iconh_yellow',
    pickupName: '25 Health',
    quantity: 25,
    giType: IT.HEALTH,
    giTag: 0,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_health_large',
    pickupSound: 'sound/items/l_health.wav',
    worldModel: ['models/powerups/health/large_cross.md3', 'models/powerups/health/large_sphere.md3', null, null],
    icon: 'icons/iconh_red',
    pickupName: '50 Health',
    quantity: 50,
    giType: IT.HEALTH,
    giTag: 0,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_health_mega',
    pickupSound: 'sound/items/m_health.wav',
    worldModel: ['models/powerups/health/mega_cross.md3', 'models/powerups/health/mega_sphere.md3', null, null],
    icon: 'icons/iconh_mega',
    pickupName: 'Mega Health',
    quantity: 100,
    giType: IT.HEALTH,
    giTag: 0,
    precaches: '',
    sounds: ''
  },

  {
    classname: 'weapon_gauntlet',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/gauntlet/gauntlet.md3', null, null, null],
    icon: 'icons/iconw_gauntlet',
    pickupName: 'Gauntlet',
    quantity: 0,
    giType: IT.WEAPON,
    giTag: WP.GAUNTLET,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_shotgun',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/shotgun/shotgun.md3', null, null, null],
    icon: 'icons/iconw_shotgun',
    pickupName: 'Shotgun',
    quantity: 10,
    giType: IT.WEAPON,
    giTag: WP.SHOTGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_machinegun',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/machinegun/machinegun.md3', null, null, null],
    icon: 'icons/iconw_machinegun',
    pickupName: 'Machinegun',
    quantity: 40,
    giType: IT.WEAPON,
    giTag: WP.MACHINEGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_grenadelauncher',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/grenadel/grenadel.md3', null, null, null],
    icon: 'icons/iconw_grenade',
    pickupName: 'Grenade Launcher',
    quantity: 10,
    giType: IT.WEAPON,
    giTag: WP.GRENADE_LAUNCHER,
    precaches: '',
    sounds: 'sound/weapons/grenade/hgrenb1a.wav sound/weapons/grenade/hgrenb2a.wav'
  },
  {
    classname: 'weapon_rocketlauncher',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/rocketl/rocketl.md3', null, null, null],
    icon: 'icons/iconw_rocket',
    pickupName: 'Rocket Launcher',
    quantity: 10,
    giType: IT.WEAPON,
    giTag: WP.ROCKET_LAUNCHER,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_lightning',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/lightning/lightning.md3', null, null, null],
    icon: 'icons/iconw_lightning',
    pickupName: 'Lightning Gun',
    quantity: 100,
    giType: IT.WEAPON,
    giTag: WP.LIGHTNING,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_railgun',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/railgun/railgun.md3', null, null, null],
    icon: 'icons/iconw_railgun',
    pickupName: 'Railgun',
    quantity: 10,
    giType: IT.WEAPON,
    giTag: WP.RAILGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_plasmagun',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/plasma/plasma.md3', null, null, null],
    icon: 'icons/iconw_plasma',
    pickupName: 'Plasma Gun',
    quantity: 50,
    giType: IT.WEAPON,
    giTag: WP.PLASMAGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_bfg',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/bfg/bfg.md3', null, null, null],
    icon: 'icons/iconw_bfg',
    pickupName: 'BFG10K',
    quantity: 20,
    giType: IT.WEAPON,
    giTag: WP.BFG,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'weapon_grapplinghook',
    pickupSound: 'sound/misc/w_pkup.wav',
    worldModel: ['models/weapons2/grapple/grapple.md3', null, null, null],
    icon: 'icons/iconw_grapple',
    pickupName: 'Grappling Hook',
    quantity: 0,
    giType: IT.WEAPON,
    giTag: WP.GRAPPLING_HOOK,
    precaches: '',
    sounds: ''
  },

  {
    classname: 'ammo_shells',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/shotgunam.md3', null, null, null],
    icon: 'icons/icona_shotgun',
    pickupName: 'Shells',
    quantity: 10,
    giType: IT.AMMO,
    giTag: WP.SHOTGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_bullets',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/machinegunam.md3', null, null, null],
    icon: 'icons/icona_machinegun',
    pickupName: 'Bullets',
    quantity: 50,
    giType: IT.AMMO,
    giTag: WP.MACHINEGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_grenades',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/grenadeam.md3', null, null, null],
    icon: 'icons/icona_grenade',
    pickupName: 'Grenades',
    quantity: 5,
    giType: IT.AMMO,
    giTag: WP.GRENADE_LAUNCHER,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_cells',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/plasmaam.md3', null, null, null],
    icon: 'icons/icona_plasma',
    pickupName: 'Cells',
    quantity: 30,
    giType: IT.AMMO,
    giTag: WP.PLASMAGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_lightning',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/lightningam.md3', null, null, null],
    icon: 'icons/icona_lightning',
    pickupName: 'Lightning',
    quantity: 60,
    giType: IT.AMMO,
    giTag: WP.LIGHTNING,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_rockets',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/rocketam.md3', null, null, null],
    icon: 'icons/icona_rocket',
    pickupName: 'Rockets',
    quantity: 5,
    giType: IT.AMMO,
    giTag: WP.ROCKET_LAUNCHER,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_slugs',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/railgunam.md3', null, null, null],
    icon: 'icons/icona_railgun',
    pickupName: 'Slugs',
    quantity: 10,
    giType: IT.AMMO,
    giTag: WP.RAILGUN,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'ammo_bfg',
    pickupSound: 'sound/misc/am_pkup.wav',
    worldModel: ['models/powerups/ammo/bfgam.md3', null, null, null],
    icon: 'icons/icona_bfg',
    pickupName: 'Bfg Ammo',
    quantity: 15,
    giType: IT.AMMO,
    giTag: WP.BFG,
    precaches: '',
    sounds: ''
  },

  {
    classname: 'holdable_teleporter',
    pickupSound: 'sound/items/holdable.wav',
    worldModel: ['models/powerups/holdable/teleporter.md3', null, null, null],
    icon: 'icons/teleporter',
    pickupName: 'Personal Teleporter',
    quantity: 60,
    giType: IT.HOLDABLE,
    giTag: HI.TELEPORTER,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'holdable_medkit',
    pickupSound: 'sound/items/holdable.wav',
    worldModel: ['models/powerups/holdable/medkit.md3', 'models/powerups/holdable/medkit_sphere.md3', null, null],
    icon: 'icons/medkit',
    pickupName: 'Medkit',
    quantity: 60,
    giType: IT.HOLDABLE,
    giTag: HI.MEDKIT,
    precaches: '',
    sounds: 'sound/items/use_medkit.wav'
  },

  {
    classname: 'item_quad',
    pickupSound: 'sound/items/quaddamage.wav',
    worldModel: ['models/powerups/instant/quad.md3', 'models/powerups/instant/quad_ring.md3', null, null],
    icon: 'icons/quad',
    pickupName: 'Quad Damage',
    quantity: 30,
    giType: IT.POWERUP,
    giTag: PW.QUAD,
    precaches: '',
    sounds: 'sound/items/damage2.wav sound/items/damage3.wav'
  },
  {
    classname: 'item_enviro',
    pickupSound: 'sound/items/protect.wav',
    worldModel: ['models/powerups/instant/enviro.md3', 'models/powerups/instant/enviro_ring.md3', null, null],
    icon: 'icons/envirosuit',
    pickupName: 'Battle Suit',
    quantity: 30,
    giType: IT.POWERUP,
    giTag: PW.BATTLESUIT,
    precaches: '',
    sounds: 'sound/items/airout.wav sound/items/protect3.wav'
  },
  {
    classname: 'item_haste',
    pickupSound: 'sound/items/haste.wav',
    worldModel: ['models/powerups/instant/haste.md3', 'models/powerups/instant/haste_ring.md3', null, null],
    icon: 'icons/haste',
    pickupName: 'Speed',
    quantity: 30,
    giType: IT.POWERUP,
    giTag: PW.HASTE,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_invis',
    pickupSound: 'sound/items/invisibility.wav',
    worldModel: ['models/powerups/instant/invis.md3', 'models/powerups/instant/invis_ring.md3', null, null],
    icon: 'icons/invis',
    pickupName: 'Invisibility',
    quantity: 30,
    giType: IT.POWERUP,
    giTag: PW.INVIS,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'item_regen',
    pickupSound: 'sound/items/regeneration.wav',
    worldModel: ['models/powerups/instant/regen.md3', 'models/powerups/instant/regen_ring.md3', null, null],
    icon: 'icons/regen',
    pickupName: 'Regeneration',
    quantity: 30,
    giType: IT.POWERUP,
    giTag: PW.REGEN,
    precaches: '',
    sounds: 'sound/items/regen.wav'
  },
  {
    classname: 'item_flight',
    pickupSound: 'sound/items/flight.wav',
    worldModel: ['models/powerups/instant/flight.md3', 'models/powerups/instant/flight_ring.md3', null, null],
    icon: 'icons/flight',
    pickupName: 'Flight',
    quantity: 60,
    giType: IT.POWERUP,
    giTag: PW.FLIGHT,
    precaches: '',
    sounds: 'sound/items/flight.wav'
  },

  {
    classname: 'team_CTF_redflag',
    pickupSound: null,
    worldModel: ['models/flags/r_flag.md3', null, null, null],
    icon: 'icons/iconf_red1',
    pickupName: 'Red Flag',
    quantity: 0,
    giType: IT.TEAM,
    giTag: PW.REDFLAG,
    precaches: '',
    sounds: ''
  },
  {
    classname: 'team_CTF_blueflag',
    pickupSound: null,
    worldModel: ['models/flags/b_flag.md3', null, null, null],
    icon: 'icons/iconf_blu1',
    pickupName: 'Blue Flag',
    quantity: 0,
    giType: IT.TEAM,
    giTag: PW.BLUEFLAG,
    precaches: '',
    sounds: ''
  },

  {
    classname: 'item_armor_jacket',
    pickupSound: 'sound/misc/ar2_pkup.wav',
    worldModel: ['models/powerups/armor/armor_yel.md3', null, null, null],
    icon: 'icons/iconr_yellow',
    pickupName: 'Green Armor',
    quantity: 25,
    giType: IT.ARMOR,
    giTag: 0,
    precaches: '',
    sounds: '',
    tint: GREEN_ARMOR_TINT
  }
];

/** `bg_numItems` (`bg_misc.c:923`): the table's length, slot 0 included, as Q3 counts it. */
export const NUM_ITEMS = ITEMS.length;

/**
 * `item - bg_itemlist` (`g_items.c:666`): the slot an item's pointer names, which is what an
 * item entity carries in `s.modelindex`.
 *
 * Quake 3 gets this by subtracting a pointer; the port looks the entry up, which is the same
 * answer for the one table there is.
 *
 * @throws where the item is the table's placeholder slot or is not in the table at all
 */
export function itemIndex(item: GItem): number {
  const index = ITEMS.indexOf(item);
  if (index < 1) throw new Error('itemIndex: the item is not in the table');
  return index;
}

/** `G_CallSpawn`'s item lookup (`g_spawn.c:277–283`): a map's classname to its item, or none. */
export function findItem(classname: string): GItem | null {
  for (let i = 1; i < ITEMS.length; i++) {
    if (ITEMS[i].classname === classname) return ITEMS[i];
  }
  return null;
}

/** `BG_FindItemForWeapon` (`bg_misc.c:973–984`), which errors where no item carries the weapon. */
export function findItemForWeapon(weapon: number): GItem {
  for (let i = 1; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    if (item.giType === IT.WEAPON && item.giTag === weapon) return item;
  }
  throw new Error(`Couldn't find item for weapon ${weapon}`);
}

/** The ammo box for a weapon, or none for a weapon without one. */
export function findItemForAmmo(weapon: number): GItem | null {
  for (let i = 1; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    if (item.giType === IT.AMMO && item.giTag === weapon) return item;
  }
  return null;
}

/** `BG_FindItemForPowerup` (`bg_misc.c:931–944`), the flags included. */
export function findItemForPowerup(powerup: number): GItem | null {
  for (let i = 1; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    if (
      (item.giType === IT.POWERUP ||
        item.giType === IT.TEAM ||
        item.giType === IT.PERSISTANT_POWERUP) &&
      item.giTag === powerup
    ) {
      return item;
    }
  }
  return null;
}

/** The armour item that gives a tier: the yellow, the green or the red; none for another number. */
export function findItemForArmorTier(tier: number): GItem | null {
  for (let i = 1; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    if (item.giType === IT.ARMOR && armorKind(item.quantity) === tier) return item;
  }
  return null;
}

/**
 * `BG_FindItemForHoldable` (`bg_misc.c:952–964`), which errors where no item carries the
 * holdable. The client asks this for the name of the item being used, so a table that has none
 * gives none rather than stopping a frame.
 */
export function findItemForHoldable(holdable: number): GItem | null {
  for (let i = 1; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    if (item.giType === IT.HOLDABLE && item.giTag === holdable) return item;
  }
  return null;
}

/**
 * `BG_CanItemBeGrabbed` (`bg_misc.c:1039–1187`): whether the item the entity carries may be
 * taken, by type and by what the player is already holding.
 *
 * @param rules - The rules the ammo's and the armour's caps and the health limit are read from.
 */
export function canItemBeGrabbed(
  gametype: number,
  ent: EntityState,
  ps: PlayerState,
  rules: Readonly<SysteminfoRules> = ID_RULES
): boolean {
  if (ent.modelindex < 1 || ent.modelindex >= NUM_ITEMS) {
    throw new Error('BG_CanItemBeGrabbed: index out of range');
  }
  const item = ITEMS[ent.modelindex];

  switch (item.giType) {
    case IT.WEAPON:
      return true;

    case IT.AMMO:
      return ps.ammo[item.giTag] < maxAmmo(rules, item.giTag);

    case IT.ARMOR:
      return canGrabArmor(item, ps.stats, rules);

    case IT.HEALTH: {
      // The 5 and the mega go over the limit; the rest only top it up.
      const limit = healthLimit(rules, ps.stats);
      if (item.quantity === 5 || item.quantity === 100) return ps.stats[STAT.HEALTH] < limit * 2;
      return ps.stats[STAT.HEALTH] < limit;
    }

    case IT.POWERUP:
      return true;

    case IT.TEAM:
      return canGrabTeamItem(gametype, item, ent, ps);

    case IT.HOLDABLE:
      return ps.stats[STAT.HOLDABLE_ITEM] === 0;

    default:
      return false;
  }
}

/**
 * `BG_CanItemBeGrabbed`'s `IT_ARMOR` branch: armour below the item's cap. With the tiers rescaled,
 * an armour of another tier is taken only while the armour held, rescaled to it, is within its cap.
 */
function canGrabArmor(
  item: GItem,
  stats: readonly number[],
  rules: Readonly<SysteminfoRules>
): boolean {
  const kind = armorKind(item.quantity);
  const cap = armorCap(rules, kind, stats);
  const held = stats[STAT.ARMOR_TIER];
  if (!rules.armor_tiered || !rules.armor_rescale || kind === null || kind === held) {
    return stats[STAT.ARMOR] < cap;
  }
  return stats[STAT.ARMOR] <= rescaleArmor(rules, cap, kind, held);
}

/**
 * `BG_CanItemBeGrabbed`'s `IT_TEAM` branch (`bg_misc.c:1126–1166`): CTF's flag rules.
 *
 * `ent.modelindex2` is non-zero on a dropped item, which is how one's own flag may be taken to be
 * returned — and while carrying the other flag, one's own may be taken too.
 */
function canGrabTeamItem(
  gametype: number,
  item: GItem,
  ent: EntityState,
  ps: PlayerState
): boolean {
  if (gametype !== GT.CTF) return false;

  const team = ps.persistant[PERS.TEAM];
  if (team === TEAM.RED) {
    return (
      item.giTag === PW.BLUEFLAG ||
      (item.giTag === PW.REDFLAG && ent.modelindex2 !== 0) ||
      (item.giTag === PW.REDFLAG && ps.powerups[PW.BLUEFLAG] !== 0)
    );
  }
  if (team === TEAM.BLUE) {
    return (
      item.giTag === PW.REDFLAG ||
      (item.giTag === PW.BLUEFLAG && ent.modelindex2 !== 0) ||
      (item.giTag === PW.BLUEFLAG && ps.powerups[PW.REDFLAG] !== 0)
    );
  }
  return false;
}

/**
 * `BG_PlayerTouchesItem` (`bg_misc.c:1011–1027`): items are picked up without actually touching
 * their box, so the test is a range about the player's origin, ignoring ducked differences. It is
 * 36 across y and with the player below the item, and the rules' reach with the player above it
 * and either way along x: id's 44 on +x and 50 on −x.
 *
 * @param rules - The rules the reach is read from.
 */
export function playerTouchesItem(
  ps: PlayerState,
  item: EntityState,
  atTime: number,
  rules: Readonly<SysteminfoRules> = ID_RULES
): boolean {
  const origin = evaluateTrajectory(item.pos, atTime);
  const dx = ps.origin.x - origin.x;
  const dy = ps.origin.y - origin.y;
  const dz = ps.origin.z - origin.z;
  if (dx > rules.g_itemReachPlusX || dx < -rules.g_itemReachMinusX) return false;
  if (dy > 36 || dy < -36 || dz > rules.g_itemReachZ || dz < -36) return false;
  return true;
}
