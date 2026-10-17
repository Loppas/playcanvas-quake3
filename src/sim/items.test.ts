import { describe, expect, it } from 'vitest';

import {
  createEntityState,
  createPlayerState,
  type EntityState,
  type PlayerState
} from '../net/protocol';
import { havePak, havePak0, openPak } from '../pak/pak-test-fixtures';
import type { ZipArchive } from '../pak/zip';
import { GT, PERS, STAT, TEAM } from './constants';
import {
  AMMO_SUFFIX,
  ARMOR_TIER,
  GREEN_ARMOR_TINT,
  HI,
  IT,
  ITEMS,
  NUM_ITEMS,
  PW,
  armorKind,
  canItemBeGrabbed,
  findItem,
  findItemForArmorTier,
  findItemForPowerup,
  findItemForWeapon,
  itemIndex,
  maxAmmo,
  pickupAmount,
  playerTouchesItem,
  weaponQuantity,
  type GItem
} from './items';
import { ID_RULES, type Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { vec3 } from './vec3';
import { MAX_WEAPONS, WP } from './weapons/constants';

/**
 * `bg_itemlist` and the two tests `Touch_Item` runs first (`bg_misc.c`), pinned entry by entry
 * against the source: a table this long is only as good as what it holds.
 */

/** The item a classname names, refused loudly so a typo in a test is not a missing item. */
function itemAt(classname: string): GItem {
  const item = findItem(classname);
  if (!item) throw new Error(`no item ${classname}`);
  return item;
}

/** The slot a classname's item occupies, which is what `s.modelindex` carries. */
function slotOf(classname: string): number {
  return ITEMS.indexOf(itemAt(classname));
}

/** An entity state for the item in a slot, as a map's spawned item carries it. */
function itemState(classname: string, overrides: Partial<EntityState> = {}): EntityState {
  const state = createEntityState();
  state.modelindex = slotOf(classname);
  return { ...state, ...overrides };
}

/** A player state on a team, which only team items read. */
function onTeam(team: number): PlayerState {
  const ps = createPlayerState();
  ps.persistant[PERS.TEAM] = team;
  return ps;
}

/**
 * Every entry after slot 0, in table order: classname, pickup name, quantity, type, tag, pickup
 * sound, icon, world models (`bg_misc.c:44–655`).
 */
const EXPECTED: [string, string, number, number, number, string | null, string, (string | null)[]][] = [
  ['item_armor_shard', 'Armor Shard', 5, IT.ARMOR, 0, 'sound/misc/ar1_pkup.wav', 'icons/iconr_shard',
    ['models/powerups/armor/shard.md3', 'models/powerups/armor/shard_sphere.md3', null, null]],
  ['item_armor_combat', 'Armor', 50, IT.ARMOR, 0, 'sound/misc/ar2_pkup.wav', 'icons/iconr_yellow',
    ['models/powerups/armor/armor_yel.md3', null, null, null]],
  ['item_armor_body', 'Heavy Armor', 100, IT.ARMOR, 0, 'sound/misc/ar2_pkup.wav', 'icons/iconr_red',
    ['models/powerups/armor/armor_red.md3', null, null, null]],
  ['item_health_small', '5 Health', 5, IT.HEALTH, 0, 'sound/items/s_health.wav', 'icons/iconh_green',
    ['models/powerups/health/small_cross.md3', 'models/powerups/health/small_sphere.md3', null, null]],
  ['item_health', '25 Health', 25, IT.HEALTH, 0, 'sound/items/n_health.wav', 'icons/iconh_yellow',
    ['models/powerups/health/medium_cross.md3', 'models/powerups/health/medium_sphere.md3', null, null]],
  ['item_health_large', '50 Health', 50, IT.HEALTH, 0, 'sound/items/l_health.wav', 'icons/iconh_red',
    ['models/powerups/health/large_cross.md3', 'models/powerups/health/large_sphere.md3', null, null]],
  ['item_health_mega', 'Mega Health', 100, IT.HEALTH, 0, 'sound/items/m_health.wav', 'icons/iconh_mega',
    ['models/powerups/health/mega_cross.md3', 'models/powerups/health/mega_sphere.md3', null, null]],
  ['weapon_gauntlet', 'Gauntlet', 0, IT.WEAPON, WP.GAUNTLET, 'sound/misc/w_pkup.wav', 'icons/iconw_gauntlet',
    ['models/weapons2/gauntlet/gauntlet.md3', null, null, null]],
  ['weapon_shotgun', 'Shotgun', 10, IT.WEAPON, WP.SHOTGUN, 'sound/misc/w_pkup.wav', 'icons/iconw_shotgun',
    ['models/weapons2/shotgun/shotgun.md3', null, null, null]],
  ['weapon_machinegun', 'Machinegun', 40, IT.WEAPON, WP.MACHINEGUN, 'sound/misc/w_pkup.wav', 'icons/iconw_machinegun',
    ['models/weapons2/machinegun/machinegun.md3', null, null, null]],
  ['weapon_grenadelauncher', 'Grenade Launcher', 10, IT.WEAPON, WP.GRENADE_LAUNCHER, 'sound/misc/w_pkup.wav', 'icons/iconw_grenade',
    ['models/weapons2/grenadel/grenadel.md3', null, null, null]],
  ['weapon_rocketlauncher', 'Rocket Launcher', 10, IT.WEAPON, WP.ROCKET_LAUNCHER, 'sound/misc/w_pkup.wav', 'icons/iconw_rocket',
    ['models/weapons2/rocketl/rocketl.md3', null, null, null]],
  ['weapon_lightning', 'Lightning Gun', 100, IT.WEAPON, WP.LIGHTNING, 'sound/misc/w_pkup.wav', 'icons/iconw_lightning',
    ['models/weapons2/lightning/lightning.md3', null, null, null]],
  ['weapon_railgun', 'Railgun', 10, IT.WEAPON, WP.RAILGUN, 'sound/misc/w_pkup.wav', 'icons/iconw_railgun',
    ['models/weapons2/railgun/railgun.md3', null, null, null]],
  ['weapon_plasmagun', 'Plasma Gun', 50, IT.WEAPON, WP.PLASMAGUN, 'sound/misc/w_pkup.wav', 'icons/iconw_plasma',
    ['models/weapons2/plasma/plasma.md3', null, null, null]],
  ['weapon_bfg', 'BFG10K', 20, IT.WEAPON, WP.BFG, 'sound/misc/w_pkup.wav', 'icons/iconw_bfg',
    ['models/weapons2/bfg/bfg.md3', null, null, null]],
  ['weapon_grapplinghook', 'Grappling Hook', 0, IT.WEAPON, WP.GRAPPLING_HOOK, 'sound/misc/w_pkup.wav', 'icons/iconw_grapple',
    ['models/weapons2/grapple/grapple.md3', null, null, null]],
  ['ammo_shells', 'Shells', 10, IT.AMMO, WP.SHOTGUN, 'sound/misc/am_pkup.wav', 'icons/icona_shotgun',
    ['models/powerups/ammo/shotgunam.md3', null, null, null]],
  ['ammo_bullets', 'Bullets', 50, IT.AMMO, WP.MACHINEGUN, 'sound/misc/am_pkup.wav', 'icons/icona_machinegun',
    ['models/powerups/ammo/machinegunam.md3', null, null, null]],
  ['ammo_grenades', 'Grenades', 5, IT.AMMO, WP.GRENADE_LAUNCHER, 'sound/misc/am_pkup.wav', 'icons/icona_grenade',
    ['models/powerups/ammo/grenadeam.md3', null, null, null]],
  ['ammo_cells', 'Cells', 30, IT.AMMO, WP.PLASMAGUN, 'sound/misc/am_pkup.wav', 'icons/icona_plasma',
    ['models/powerups/ammo/plasmaam.md3', null, null, null]],
  ['ammo_lightning', 'Lightning', 60, IT.AMMO, WP.LIGHTNING, 'sound/misc/am_pkup.wav', 'icons/icona_lightning',
    ['models/powerups/ammo/lightningam.md3', null, null, null]],
  ['ammo_rockets', 'Rockets', 5, IT.AMMO, WP.ROCKET_LAUNCHER, 'sound/misc/am_pkup.wav', 'icons/icona_rocket',
    ['models/powerups/ammo/rocketam.md3', null, null, null]],
  ['ammo_slugs', 'Slugs', 10, IT.AMMO, WP.RAILGUN, 'sound/misc/am_pkup.wav', 'icons/icona_railgun',
    ['models/powerups/ammo/railgunam.md3', null, null, null]],
  ['ammo_bfg', 'Bfg Ammo', 15, IT.AMMO, WP.BFG, 'sound/misc/am_pkup.wav', 'icons/icona_bfg',
    ['models/powerups/ammo/bfgam.md3', null, null, null]],
  ['holdable_teleporter', 'Personal Teleporter', 60, IT.HOLDABLE, HI.TELEPORTER, 'sound/items/holdable.wav', 'icons/teleporter',
    ['models/powerups/holdable/teleporter.md3', null, null, null]],
  ['holdable_medkit', 'Medkit', 60, IT.HOLDABLE, HI.MEDKIT, 'sound/items/holdable.wav', 'icons/medkit',
    ['models/powerups/holdable/medkit.md3', 'models/powerups/holdable/medkit_sphere.md3', null, null]],
  ['item_quad', 'Quad Damage', 30, IT.POWERUP, PW.QUAD, 'sound/items/quaddamage.wav', 'icons/quad',
    ['models/powerups/instant/quad.md3', 'models/powerups/instant/quad_ring.md3', null, null]],
  ['item_enviro', 'Battle Suit', 30, IT.POWERUP, PW.BATTLESUIT, 'sound/items/protect.wav', 'icons/envirosuit',
    ['models/powerups/instant/enviro.md3', 'models/powerups/instant/enviro_ring.md3', null, null]],
  ['item_haste', 'Speed', 30, IT.POWERUP, PW.HASTE, 'sound/items/haste.wav', 'icons/haste',
    ['models/powerups/instant/haste.md3', 'models/powerups/instant/haste_ring.md3', null, null]],
  ['item_invis', 'Invisibility', 30, IT.POWERUP, PW.INVIS, 'sound/items/invisibility.wav', 'icons/invis',
    ['models/powerups/instant/invis.md3', 'models/powerups/instant/invis_ring.md3', null, null]],
  ['item_regen', 'Regeneration', 30, IT.POWERUP, PW.REGEN, 'sound/items/regeneration.wav', 'icons/regen',
    ['models/powerups/instant/regen.md3', 'models/powerups/instant/regen_ring.md3', null, null]],
  ['item_flight', 'Flight', 60, IT.POWERUP, PW.FLIGHT, 'sound/items/flight.wav', 'icons/flight',
    ['models/powerups/instant/flight.md3', 'models/powerups/instant/flight_ring.md3', null, null]],
  ['team_CTF_redflag', 'Red Flag', 0, IT.TEAM, PW.REDFLAG, null, 'icons/iconf_red1',
    ['models/flags/r_flag.md3', null, null, null]],
  ['team_CTF_blueflag', 'Blue Flag', 0, IT.TEAM, PW.BLUEFLAG, null, 'icons/iconf_blu1',
    ['models/flags/b_flag.md3', null, null, null]],
  ['item_armor_jacket', 'Green Armor', 25, IT.ARMOR, 0, 'sound/misc/ar2_pkup.wav',
    'icons/iconr_yellow', ['models/powerups/armor/armor_yel.md3', null, null, null]]
];

describe('the item table', () => {
  it("leaves slot 0 as Q3 leaves it, and counts Q3's 35 items and CPMA's Green Armor", () => {
    expect(ITEMS[0].giType).toBe(IT.BAD);
    expect(ITEMS[0].classname).toBe('');
    expect(ITEMS.length).toBe(37);
    expect(NUM_ITEMS).toBe(37);
    expect(ITEMS.slice(1).length).toBe(36);
    expect(itemIndex(itemAt('team_CTF_blueflag'))).toBe(35);
    expect(itemIndex(itemAt('item_armor_jacket'))).toBe(36);
  });

  it("tints the Green Armor alone, which borrows the yellow armour's art", () => {
    expect(ITEMS.filter((item) => item.tint).map((item) => item.classname)).toEqual([
      'item_armor_jacket'
    ]);
    expect(itemAt('item_armor_jacket').tint).toBe(GREEN_ARMOR_TINT);
    // It turns the yellow's red and green, and its icon's flat yellow, green.
    const [r, g, b] = GREEN_ARMOR_TINT;
    expect(g).toBeGreaterThan(2 * Math.max(r, b));
    expect(armorKind(itemAt('item_armor_jacket').quantity)).toBe(ARMOR_TIER.GA);
  });

  it('finds the armour item that gives each tier, and none for another number', () => {
    expect(findItemForArmorTier(ARMOR_TIER.YA)).toBe(itemAt('item_armor_combat'));
    expect(findItemForArmorTier(ARMOR_TIER.GA)).toBe(itemAt('item_armor_jacket'));
    expect(findItemForArmorTier(ARMOR_TIER.RA)).toBe(itemAt('item_armor_body'));
    expect(findItemForArmorTier(3)).toBeNull();
  });

  it("pins every entry, in order, against bg_misc.c and CPMA's item list", () => {
    const actual = ITEMS.slice(1).map((item) => [
      item.classname,
      item.pickupName,
      item.quantity,
      item.giType,
      item.giTag,
      item.pickupSound,
      item.icon,
      item.worldModel
    ]);
    expect(actual).toEqual(EXPECTED);
  });

  it('carries the precache and sounds strings Q3 gives the entries that have them', () => {
    expect(itemAt('item_quad').sounds).toBe(
      'sound/items/damage2.wav sound/items/damage3.wav'
    );
    expect(itemAt('item_enviro').sounds).toBe('sound/items/airout.wav sound/items/protect3.wav');
    expect(itemAt('item_regen').sounds).toBe('sound/items/regen.wav');
    expect(itemAt('item_flight').sounds).toBe('sound/items/flight.wav');
    expect(itemAt('holdable_medkit').sounds).toBe('sound/items/use_medkit.wav');
    expect(itemAt('weapon_grenadelauncher').sounds).toBe(
      'sound/weapons/grenade/hgrenb1a.wav sound/weapons/grenade/hgrenb2a.wav'
    );
    expect(itemAt('item_quad').precaches).toBe('');
  });
});

describe('findItem', () => {
  it('finds an item by its classname, exactly as Q3 compares it', () => {
    expect(findItem('item_quad')?.classname).toBe('item_quad');
    expect(findItem('team_CTF_blueflag')?.classname).toBe('team_CTF_blueflag');
    expect(findItem('ITEM_QUAD')).toBeNull();
    expect(findItem('item_nothing')).toBeNull();
  });
});

describe('findItemForWeapon', () => {
  it('finds the item each weapon picks up', () => {
    expect(findItemForWeapon(WP.RAILGUN)?.classname).toBe('weapon_railgun');
    expect(findItemForWeapon(WP.GAUNTLET)?.classname).toBe('weapon_gauntlet');
    expect(findItemForWeapon(WP.GRAPPLING_HOOK)?.classname).toBe('weapon_grapplinghook');
  });

  it("throws where Q3 errors when no item carries the weapon", () => {
    expect(() => findItemForWeapon(99)).toThrow(/Couldn't find item for weapon/);
  });
});

describe('findItemForPowerup', () => {
  it('finds a powerup and a flag alike, since Q3 counts IT_TEAM among them', () => {
    expect(findItemForPowerup(PW.QUAD)?.classname).toBe('item_quad');
    expect(findItemForPowerup(PW.FLIGHT)?.classname).toBe('item_flight');
    expect(findItemForPowerup(PW.REDFLAG)?.classname).toBe('team_CTF_redflag');
    expect(findItemForPowerup(PW.BLUEFLAG)?.classname).toBe('team_CTF_blueflag');
    expect(findItemForPowerup(PW.NONE)).toBeNull();
  });
});

describe('the ammo rules', () => {
  const weapons = [...AMMO_SUFFIX.keys()];
  const ammoItem = (weapon: number) =>
    ITEMS.find((item) => item.giType === IT.AMMO && item.giTag === weapon)!;

  it("default to id's items' quantities, and the maximum to 200", () => {
    for (const item of ITEMS.slice(1)) {
      if (item.giType === IT.AMMO) {
        expect(pickupAmount(ID_RULES, 'g_ammoPickup', item, GT.FFA)).toBe(item.quantity);
        expect(pickupAmount(ID_RULES, 'g_ammoPickup', item, GT.TEAM)).toBe(item.quantity);
      }
      if (item.giType === IT.WEAPON) {
        expect(pickupAmount(ID_RULES, 'g_weaponPickup', item, GT.FFA)).toBe(item.quantity);
        expect(pickupAmount(ID_RULES, 'g_weaponPickup', item, GT.TEAM)).toBe(item.quantity);
        expect(weaponQuantity(ID_RULES, item)).toBe(item.quantity);
      }
    }
    for (let weapon = 0; weapon < MAX_WEAPONS; weapon++) {
      expect(maxAmmo(ID_RULES, weapon)).toBe(200);
    }
  });

  it("read each weapon's own, and its team deathmatch amounts there", () => {
    const cpm = presetRules('cpm');
    const box = (gametype: number) =>
      weapons.map((weapon) => pickupAmount(cpm, 'g_ammoPickup', ammoItem(weapon), gametype));
    const gun = (gametype: number) =>
      weapons.map((weapon) =>
        pickupAmount(cpm, 'g_weaponPickup', findItemForWeapon(weapon), gametype)
      );
    expect(box(GT.FFA)).toEqual([50, 5, 5, 5, 50, 5, 50, 5]);
    expect(box(GT.TEAM)).toEqual([50, 10, 10, 10, 50, 10, 50, 10]);
    expect(box(GT.CTF)).toEqual(box(GT.FFA));
    expect(gun(GT.TOURNAMENT)).toEqual([50, 10, 5, 10, 50, 5, 50, 5]);
    expect(gun(GT.TEAM)).toEqual([50, 10, 10, 10, 100, 10, 100, 10]);
    expect(weapons.map((weapon) => weaponQuantity(cpm, findItemForWeapon(weapon)))).toEqual([
      40, 10, 10, 10, 100, 10, 50, 5
    ]);
    expect(weapons.map((weapon) => maxAmmo(cpm, weapon))).toEqual([
      100, 25, 25, 25, 150, 25, 100, 25
    ]);
  });

  it("give each preset its own low-ammo marks, and id's none", () => {
    const marks = (name: string) => {
      const rules = presetRules(name);
      return [
        rules.g_lowAmmo_mg,
        rules.g_lowAmmo_sg,
        rules.g_lowAmmo_gl,
        rules.g_lowAmmo_rl,
        rules.g_lowAmmo_lg,
        rules.g_lowAmmo_rg,
        rules.g_lowAmmo_pg,
        rules.g_lowAmmo_bfg
      ];
    };
    expect(['vq3', 'pmc', 'cpm', 'cq3', 'dev'].map(marks)).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [25, 5, 5, 5, 50, 5, 25, 5],
      [25, 5, 3, 5, 25, 3, 25, 3],
      [25, 3, 3, 5, 25, 3, 10, 5],
      [25, 5, 3, 5, 25, 3, 25, 3]
    ]);
  });

  it('leave the gauntlet and the grapple to their items and 200', () => {
    const cpm = presetRules('cpm');
    for (const weapon of [WP.GAUNTLET, WP.GRAPPLING_HOOK]) {
      const item = findItemForWeapon(weapon);
      expect(pickupAmount(cpm, 'g_weaponPickup', item, GT.TEAM)).toBe(item.quantity);
      expect(weaponQuantity(cpm, item)).toBe(item.quantity);
      expect(maxAmmo(cpm, weapon)).toBe(200);
    }
  });
});

describe('canItemBeGrabbed', () => {
  it('takes a weapon whatever the player holds', () => {
    const ps = createPlayerState();
    ps.stats[STAT.HEALTH] = 1;
    expect(canItemBeGrabbed(GT.FFA, itemState('weapon_railgun'), ps)).toBe(true);
  });

  it('refuses ammo at the cap and takes it below', () => {
    const ps = createPlayerState();
    const ent = itemState('ammo_slugs');
    ps.ammo[WP.RAILGUN] = 199;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(true);
    ps.ammo[WP.RAILGUN] = 200;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(false);
  });

  it("refuses ammo at the rules' maximum for its weapon", () => {
    const ps = createPlayerState();
    const cpm = presetRules('cpm');
    ps.ammo[WP.ROCKET_LAUNCHER] = 24;
    expect(canItemBeGrabbed(GT.FFA, itemState('ammo_rockets'), ps, cpm)).toBe(true);
    ps.ammo[WP.ROCKET_LAUNCHER] = 25;
    expect(canItemBeGrabbed(GT.FFA, itemState('ammo_rockets'), ps, cpm)).toBe(false);
    ps.ammo[WP.LIGHTNING] = 149;
    expect(canItemBeGrabbed(GT.FFA, itemState('ammo_lightning'), ps, cpm)).toBe(true);
    ps.ammo[WP.LIGHTNING] = 150;
    expect(canItemBeGrabbed(GT.FFA, itemState('ammo_lightning'), ps, cpm)).toBe(false);
  });

  it("counts infinite ammo as below the cap, as PM_Weapon's sentinel does", () => {
    const ps = createPlayerState();
    ps.ammo[WP.RAILGUN] = -1;
    expect(canItemBeGrabbed(GT.FFA, itemState('ammo_slugs'), ps)).toBe(true);
  });

  it('refuses armour at twice the max health and takes it below', () => {
    const ps = createPlayerState();
    const ent = itemState('item_armor_body');
    ps.stats[STAT.MAX_HEALTH] = 100;
    ps.stats[STAT.ARMOR] = 199;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(true);
    ps.stats[STAT.ARMOR] = 200;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(false);
  });

  it('lowers the armour cap with a handicap', () => {
    const ps = createPlayerState();
    const ent = itemState('item_armor_shard');
    ps.stats[STAT.MAX_HEALTH] = 50;
    ps.stats[STAT.ARMOR] = 99;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(true);
    ps.stats[STAT.ARMOR] = 100;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(false);
  });

  it('lets the 5 and the mega health heal to twice the max, and the rest only to the max', () => {
    const ps = createPlayerState();
    ps.stats[STAT.MAX_HEALTH] = 100;
    const small = itemState('item_health_small');
    const mega = itemState('item_health_mega');
    const medium = itemState('item_health');

    ps.stats[STAT.HEALTH] = 199;
    expect(canItemBeGrabbed(GT.FFA, small, ps)).toBe(true);
    expect(canItemBeGrabbed(GT.FFA, mega, ps)).toBe(true);
    expect(canItemBeGrabbed(GT.FFA, medium, ps)).toBe(false);

    ps.stats[STAT.HEALTH] = 100;
    expect(canItemBeGrabbed(GT.FFA, medium, ps)).toBe(false);

    ps.stats[STAT.HEALTH] = 99;
    expect(canItemBeGrabbed(GT.FFA, medium, ps)).toBe(true);

    ps.stats[STAT.HEALTH] = 200;
    expect(canItemBeGrabbed(GT.FFA, small, ps)).toBe(false);
    expect(canItemBeGrabbed(GT.FFA, mega, ps)).toBe(false);
  });

  it('measures health and armour from 100 under the fixed limits, whatever the handicap', () => {
    const fixed = { ...ID_RULES, g_fixedHealthLimits: 1 };
    const health = itemState('item_health');
    const mega = itemState('item_health_mega');
    const shard = itemState('item_armor_shard');
    const ps = createPlayerState();
    ps.stats[STAT.MAX_HEALTH] = 50;

    ps.stats[STAT.HEALTH] = 99;
    ps.stats[STAT.ARMOR] = 199;
    expect(canItemBeGrabbed(GT.FFA, health, ps, fixed)).toBe(true);
    expect(canItemBeGrabbed(GT.FFA, shard, ps, fixed)).toBe(true);
    // id's measure from the max health, which the handicap lowers.
    expect(canItemBeGrabbed(GT.FFA, health, ps)).toBe(false);
    expect(canItemBeGrabbed(GT.FFA, shard, ps)).toBe(false);

    ps.stats[STAT.HEALTH] = 199;
    expect(canItemBeGrabbed(GT.FFA, mega, ps, fixed)).toBe(true);
    ps.stats[STAT.HEALTH] = 200;
    ps.stats[STAT.ARMOR] = 200;
    expect(canItemBeGrabbed(GT.FFA, mega, ps, fixed)).toBe(false);
    expect(canItemBeGrabbed(GT.FFA, shard, ps, fixed)).toBe(false);
  });

  it('takes armour of another tier only while the armour held, rescaled, fits its cap', () => {
    const { GA, YA, RA } = ARMOR_TIER;
    const grabs = (rules: Rules, classname: string, armor: number, tier: number) => {
      const ps = createPlayerState();
      ps.stats[STAT.MAX_HEALTH] = 100;
      ps.stats[STAT.ARMOR] = armor;
      ps.stats[STAT.ARMOR_TIER] = tier;
      return canItemBeGrabbed(GT.FFA, itemState(classname), ps, rules);
    };
    const cpm = presetRules('cpm');
    // The same tier, below its cap.
    expect(grabs(cpm, 'item_armor_combat', 149, YA)).toBe(true);
    expect(grabs(cpm, 'item_armor_combat', 150, YA)).toBe(false);
    expect(grabs(cpm, 'item_armor_body', 199, RA)).toBe(true);
    expect(grabs(cpm, 'item_armor_body', 200, RA)).toBe(false);
    // Another: 132 red is 150 yellow, 198 green is 150 yellow, and 200 yellow is 176 red.
    expect(grabs(cpm, 'item_armor_combat', 132, RA)).toBe(true);
    expect(grabs(cpm, 'item_armor_combat', 133, RA)).toBe(false);
    expect(grabs(cpm, 'item_armor_combat', 198, GA)).toBe(true);
    expect(grabs(cpm, 'item_armor_combat', 199, GA)).toBe(false);
    expect(grabs(cpm, 'item_armor_body', 200, YA)).toBe(true);
    // The shard's cap is twice the limit whatever the tier.
    expect(grabs(cpm, 'item_armor_shard', 199, YA)).toBe(true);
    expect(grabs(cpm, 'item_armor_shard', 200, YA)).toBe(false);
    // Without the rescale, any armour below 200.
    const cq3 = presetRules('cq3');
    expect(grabs(cq3, 'item_armor_combat', 199, RA)).toBe(true);
    expect(grabs(cq3, 'item_armor_combat', 200, RA)).toBe(false);
    // The rescale acts only on tiered armour.
    expect(grabs({ ...cpm, armor_tiered: 0 }, 'item_armor_combat', 133, RA)).toBe(true);

    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
    expect(presets.map((name) => grabs(presetRules(name), 'item_armor_combat', 133, RA))).toEqual(
      [true, false, false, true, false]
    );
  });

  it('refuses a second holdable', () => {
    const ps = createPlayerState();
    const ent = itemState('holdable_medkit');
    ps.stats[STAT.HOLDABLE_ITEM] = 0;
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(true);
    ps.stats[STAT.HOLDABLE_ITEM] = slotOf('holdable_medkit');
    expect(canItemBeGrabbed(GT.FFA, ent, ps)).toBe(false);
  });

  it('takes a powerup always', () => {
    const ps = createPlayerState();
    ps.powerups[PW.QUAD] = 1;
    expect(canItemBeGrabbed(GT.FFA, itemState('item_quad'), ps)).toBe(true);
  });

  it('lets red take blue\'s flag in CTF', () => {
    expect(canItemBeGrabbed(GT.CTF, itemState('team_CTF_blueflag'), onTeam(TEAM.RED))).toBe(true);
  });

  it('lets red take its own flag only dropped, or while carrying blue\'s', () => {
    const ps = onTeam(TEAM.RED);
    expect(canItemBeGrabbed(GT.CTF, itemState('team_CTF_redflag'), ps)).toBe(false);

    expect(
      canItemBeGrabbed(GT.CTF, itemState('team_CTF_redflag', { modelindex2: 1 }), ps)
    ).toBe(true);

    ps.powerups[PW.BLUEFLAG] = 1;
    expect(canItemBeGrabbed(GT.CTF, itemState('team_CTF_redflag'), ps)).toBe(true);
  });

  it("lets blue take the mirror of red's two cases", () => {
    const ps = onTeam(TEAM.BLUE);
    expect(canItemBeGrabbed(GT.CTF, itemState('team_CTF_redflag'), ps)).toBe(true);
    expect(canItemBeGrabbed(GT.CTF, itemState('team_CTF_blueflag'), ps)).toBe(false);
    expect(
      canItemBeGrabbed(GT.CTF, itemState('team_CTF_blueflag', { modelindex2: 1 }), ps)
    ).toBe(true);
    ps.powerups[PW.REDFLAG] = 1;
    expect(canItemBeGrabbed(GT.CTF, itemState('team_CTF_blueflag'), ps)).toBe(true);
  });

  it('refuses a flag outside CTF, whoever carries it', () => {
    const ps = onTeam(TEAM.RED);
    expect(canItemBeGrabbed(GT.FFA, itemState('team_CTF_blueflag'), ps)).toBe(false);
    expect(
      canItemBeGrabbed(GT.FFA, itemState('team_CTF_blueflag', { modelindex2: 1 }), ps)
    ).toBe(false);
  });

  it('errors on an item slot outside the table, as Q3 does', () => {
    const ps = createPlayerState();
    expect(() => canItemBeGrabbed(GT.FFA, itemState('item_quad', { modelindex: 0 }), ps)).toThrow(
      /index out of range/
    );
    expect(() =>
      canItemBeGrabbed(GT.FFA, itemState('item_quad', { modelindex: NUM_ITEMS }), ps)
    ).toThrow(/index out of range/);
  });
});

describe('playerTouchesItem', () => {
  it('takes the item at the player and at each box edge, and refuses one unit past', () => {
    const ps = createPlayerState();
    const ent = itemState('item_quad');
    ent.pos.trBase = vec3(0, 0, 0);

    for (const offset of [vec3(44, 36, 36), vec3(-50, -36, -36), vec3(0, 0, 0)]) {
      ps.origin = offset;
      expect(playerTouchesItem(ps, ent, 0)).toBe(true);
    }

    for (const offset of [vec3(45, 0, 0), vec3(-51, 0, 0), vec3(0, 37, 0), vec3(0, 0, -37)]) {
      ps.origin = offset;
      expect(playerTouchesItem(ps, ent, 0)).toBe(false);
    }
  });

  it("reads the item where its trajectory has it at the time asked", () => {
    const ps = createPlayerState();
    const ent = itemState('item_quad');
    ent.pos.trType = 2;
    ent.pos.trBase = vec3(0, 0, 0);
    ent.pos.trDelta = vec3(100, 0, 0);

    ps.origin = vec3(50, 0, 0);
    expect(playerTouchesItem(ps, ent, 0)).toBe(false);
    expect(playerTouchesItem(ps, ent, 1000)).toBe(true);
  });

  /** Whether a player at (x, y, z) from an item at the origin takes it under `rules`. */
  function takes(rules: Rules, x: number, y: number, z: number): boolean {
    const ps = createPlayerState();
    const ent = itemState('item_quad');
    ent.pos.trBase = vec3(0, 0, 0);
    ps.origin = vec3(x, y, z);
    return playerTouchesItem(ps, ent, 0, rules);
  }

  it("reaches the rules' distance above the item and along x, and 36 across y and below", () => {
    const rules = { ...ID_RULES, g_itemReachZ: 60, g_itemReachPlusX: 20, g_itemReachMinusX: 30 };

    expect([takes(rules, 20, 0, 0), takes(rules, 21, 0, 0)]).toEqual([true, false]);
    expect([takes(rules, -30, 0, 0), takes(rules, -31, 0, 0)]).toEqual([true, false]);
    expect([takes(rules, 0, 0, 60), takes(rules, 0, 0, 61)]).toEqual([true, false]);
    expect([takes(rules, 0, 36, -36), takes(rules, 0, -36, 0)]).toEqual([true, true]);
    expect([takes(rules, 0, 37, 0), takes(rules, 0, -37, 0)]).toEqual([false, false]);
    expect(takes(rules, 0, 0, -37)).toBe(false);
  });

  it("reaches each preset's distances: above, +x, −x, across y and below", () => {
    /** The furthest whole distance that still takes the item, along one direction. */
    function reach(rules: Rules, [x, y, z]: readonly number[]): number {
      let distance = 0;
      while (takes(rules, x * (distance + 1), y * (distance + 1), z * (distance + 1))) distance++;
      return distance;
    }
    const directions = [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, -1]];
    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];

    expect(presets.map((name) => directions.map((d) => reach(presetRules(name), d)))).toEqual([
      [36, 44, 50, 36, 36],
      [66, 36, 36, 36, 36],
      [66, 36, 36, 36, 36],
      [50, 36, 36, 36, 36],
      [66, 36, 36, 36, 36]
    ]);
  });
});

/** The one model no retail pak carries, and `CG_Item` never draws. */
const ABSENT_MODEL = 'models/powerups/holdable/medkit_sphere.md3';

describe.skipIf(!havePak0)('the retail paks hold the item assets', () => {
  it('finds every world model the game draws, and every icon', async () => {
    const archives: ZipArchive[] = [];
    for (let i = 0; i <= 8; i++) {
      if (havePak(`pak${i}.pk3`)) archives.push(await openPak(`pak${i}.pk3`));
    }
    const has = async (path: string) => {
      for (const archive of archives) {
        if (await archive.read(path)) return true;
      }
      return false;
    };

    for (const item of ITEMS.slice(1)) {
      for (const model of item.worldModel) {
        if (model === null || model === ABSENT_MODEL) continue;
        expect(await has(model), model).toBe(true);
      }
      expect(await has(`${item.icon}.tga`), item.icon).toBe(true);
    }

    // The exception is real: no pak carries it, so the table is not hiding a typo.
    expect(await has(ABSENT_MODEL)).toBe(false);
  });
});
