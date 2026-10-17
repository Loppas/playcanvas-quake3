import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, TR } from '../net/protocol';
import { EF_NODRAW, GT, STAT } from './constants';
import { tossClientItems } from './drops';
import type { GameEntity } from './game-entity';
import { DEFAULT_ITEM_MATCH, touchItem } from './item-touch';
import { findItemForWeapon, PW } from './items';
import { Level } from './level';
import type { Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { createIdlePlayerState } from './types';
import { vec3 } from './vec3';
import { WEAPON_DROPPING, WEAPON_READY, WP } from './weapons/constants';

/**
 * `TossClientItems`: what a dying or departing player leaves behind.
 *
 * The drops are entities in the level's own pool, so what a test reads is what a client would see
 * in a snapshot: which items were thrown, from where, how hard, and what they carry.
 */

/** A level whose item callbacks read the defaults, as a match with no module does. */
function match(gametype: number = GT.FFA, rules?: Rules): Level {
  const level = new Level({ rules });
  level.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => gametype, random: () => 0.5 };
  return level;
}

/** A player in slot 0 holding `weapon`, facing +Y. */
function player(level: Level, weapon: number, ammo = 10): GameEntity {
  const entity = level.gentities[0];
  entity.client = level.clients[0];
  entity.inuse = true;
  entity.classname = 'player';
  Object.assign(
    entity.client.ps,
    createIdlePlayerState({
      origin: vec3(10, 20, 30),
      viewangles: vec3(0, 90, 0),
      groundEntityNum: ENTITYNUM_NONE
    })
  );
  entity.s.pos.trBase = vec3(10, 20, 30);
  entity.s.apos.trBase = vec3(0, 90, 0);
  entity.s.weapon = weapon;
  entity.client.ps.weapon = weapon;
  entity.client.ps.stats[STAT.WEAPONS] = 1 << weapon;
  entity.client.ps.ammo[weapon] = ammo;
  return entity;
}

/** Everything thrown, as the level holds it: the pool is walked, so this is what a client sees. */
function drops(level: Level): GameEntity[] {
  return level.gentities.filter((entity) => entity.inuse && (entity.flags & 0x1000) !== 0);
}

describe('the weapon a player drops', () => {
  it('throws the weapon in hand from their own place, along their facing', () => {
    const level = match();
    const owner = player(level, WP.ROCKET_LAUNCHER);

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item).toBe(findItemForWeapon(WP.ROCKET_LAUNCHER));
    expect(dropped[0].s.origin).toEqual(vec3(10, 20, 30));
    // Yaw 90 is +Y, and the throw is level.
    expect(dropped[0].s.pos.trDelta.y).toBeCloseTo(150);
    expect(dropped[0].s.pos.trDelta.z).toBeCloseTo(200);
  });

  it('never drops the gauntlet or the machinegun', () => {
    for (const weapon of [WP.GAUNTLET, WP.MACHINEGUN]) {
      const level = match();
      tossClientItems(level, player(level, weapon));
      expect(drops(level)).toHaveLength(0);
    }
  });

  it('never drops the hook, and never a weapon with no ammo in it', () => {
    const hooked = match();
    tossClientItems(hooked, player(hooked, WP.GRAPPLING_HOOK, -1));
    expect(drops(hooked)).toHaveLength(0);

    const empty = match();
    tossClientItems(empty, player(empty, WP.RAILGUN, 0));
    expect(drops(empty)).toHaveLength(0);
  });

  it('drops what a player killed mid-switch was raising, and only if they own it', () => {
    const level = match();
    const owner = player(level, WP.MACHINEGUN);
    owner.client!.ps.weaponstate = WEAPON_DROPPING;
    owner.client!.pers.cmd.weapon = WP.RAILGUN;
    owner.client!.ps.stats[STAT.WEAPONS] |= 1 << WP.RAILGUN;
    owner.client!.ps.ammo[WP.RAILGUN] = 5;

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item).toBe(findItemForWeapon(WP.RAILGUN));

    // The same switch to a weapon they never picked up drops nothing: the machinegun stays home,
    // even though there is ammo for the weapon they were raising.
    const unowned = match();
    const other = player(unowned, WP.MACHINEGUN);
    other.client!.ps.weaponstate = WEAPON_DROPPING;
    other.client!.pers.cmd.weapon = WP.BFG;
    other.client!.ps.ammo[WP.BFG] = 5;
    tossClientItems(unowned, other);
    expect(drops(unowned)).toHaveLength(0);
  });

  it('drops the weapon in hand while ready, without consulting the command', () => {
    const level = match();
    const owner = player(level, WP.PLASMAGUN);
    owner.client!.ps.weaponstate = WEAPON_READY;
    owner.client!.pers.cmd.weapon = WP.BFG;

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item).toBe(findItemForWeapon(WP.PLASMAGUN));
  });
});

describe('the powerups a player drops', () => {
  it('fans them out 45° apart, each carrying the seconds it had left', () => {
    const level = match();
    level.time = 1000;
    const owner = player(level, WP.MACHINEGUN);
    owner.client!.ps.powerups[PW.QUAD] = 31_000;
    owner.client!.ps.powerups[PW.HASTE] = 46_000;

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped).toHaveLength(2);
    expect(dropped[0].item?.classname).toBe('item_quad');
    expect(dropped[1].item?.classname).toBe('item_haste');
    expect(dropped[0].count).toBe(30);
    expect(dropped[1].count).toBe(45);

    // Yaw 90 turned 45 and then 90: the first goes up-left, the second straight left.
    expect(dropped[0].s.pos.trDelta.x).toBeCloseTo(-150 * Math.SQRT1_2);
    expect(dropped[0].s.pos.trDelta.y).toBeCloseTo(150 * Math.SQRT1_2);
    expect(dropped[1].s.pos.trDelta.x).toBeCloseTo(-150);
    expect(dropped[1].s.pos.trDelta.y).toBeCloseTo(0);
  });

  it('never carries less than one second, however little was left', () => {
    const level = match();
    level.time = 1000;
    const owner = player(level, WP.MACHINEGUN);
    owner.client!.ps.powerups[PW.QUAD] = 1001;

    tossClientItems(level, owner);

    expect(drops(level)[0].count).toBe(1);
  });

  it('drops only the powerups that are still running', () => {
    const level = match();
    level.time = 1000;
    const owner = player(level, WP.MACHINEGUN);
    owner.client!.ps.powerups[PW.QUAD] = 1000;

    tossClientItems(level, owner);

    expect(drops(level)).toHaveLength(0);
  });

  it('passes over a slot with no item without spending a fan angle', () => {
    const level = match();
    level.time = 1000;
    const owner = player(level, WP.MACHINEGUN);
    // Team Arena's slot 9 has no baseq3 item; the quad after it still takes the first angle.
    owner.client!.ps.powerups[9] = 60_000;
    owner.client!.ps.powerups[PW.QUAD] = 31_000;

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].s.pos.trDelta.x).toBeCloseTo(-150 * Math.SQRT1_2);
    expect(dropped[0].s.pos.trDelta.y).toBeCloseTo(150 * Math.SQRT1_2);
  });

  it('drops a carried flag through the same loop, seconds and all', () => {
    const level = match();
    level.time = 1000;
    const owner = player(level, WP.MACHINEGUN);
    owner.client!.ps.powerups[PW.REDFLAG] = 2_147_483_647;
    owner.client!.ps.powerups[PW.BLUEFLAG] = 60_000;

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped.map((e) => e.item?.classname)).toEqual([
      'team_CTF_redflag',
      'team_CTF_blueflag'
    ]);
    expect(dropped[0].count).toBe(2_147_482);
    expect(dropped[1].count).toBe(59);
  });

  it('keeps every powerup in a team game, while the weapon still drops', () => {
    const level = match(GT.TEAM);
    level.time = 1000;
    const owner = player(level, WP.ROCKET_LAUNCHER);
    owner.client!.ps.powerups[PW.QUAD] = 31_000;

    tossClientItems(level, owner);

    const dropped = drops(level);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].item).toBe(findItemForWeapon(WP.ROCKET_LAUNCHER));
  });
});

describe('what a drop is', () => {
  it('is a falling, marked, thirty-second item rather than a map one', () => {
    const level = match();
    level.time = 1000;
    const owner = player(level, WP.ROCKET_LAUNCHER);

    tossClientItems(level, owner);

    const dropped = drops(level)[0];
    expect(dropped.s.pos.trType).toBe(TR.GRAVITY);
    expect(dropped.s.modelindex2).toBe(1);
    expect(dropped.nextthink).toBe(31_000);
    expect(dropped.s.eFlags & 0x20).toBe(0x20);
  });

  it('drops nothing at all for an entity with no client', () => {
    const level = match();
    const world = level.spawnEntity();
    world.s.weapon = WP.ROCKET_LAUNCHER;

    tossClientItems(level, world);

    expect(drops(level)).toHaveLength(0);
  });
});

describe('the packs, by the rules', () => {
  /** A dropper's ammo, the machinegun's to the BFG's. */
  const HELD = [120, 3, 0, 17, 80, 9, -1, 30];

  /** The player in slot 0, holding `weapon`, with `ammo` for the machinegun to the BFG. */
  function dropper(level: Level, weapon: number, ammo: readonly number[] = HELD): GameEntity {
    const entity = player(level, weapon, 0);
    ammo.forEach((count, i) => (entity.client!.ps.ammo[WP.MACHINEGUN + i] = count));
    return entity;
  }

  /** A player in slot 1 to take what was dropped, with no weapons and `ammo` as above. */
  function taker(level: Level, ammo: readonly number[]): GameEntity {
    const entity = level.gentities[1];
    entity.client = level.clients[1];
    entity.inuse = true;
    entity.classname = 'player';
    Object.assign(entity.client.ps, createIdlePlayerState({ clientNum: 1 }));
    ammo.forEach((count, i) => (entity.client!.ps.ammo[WP.MACHINEGUN + i] = count));
    return entity;
  }

  /** The machinegun's to the BFG's of an ammo array. */
  function byWeapon(ammo: readonly number[]): number[] {
    return ammo.slice(WP.MACHINEGUN, WP.BFG + 1);
  }

  it("packs every weapon's ammo, each up to its box, onto the weapon dropped", () => {
    const level = match(GT.TOURNAMENT, presetRules('cpm'));

    tossClientItems(level, dropper(level, WP.ROCKET_LAUNCHER));

    const dropped = drops(level);
    expect(dropped.map((entity) => entity.item?.classname)).toEqual(['weapon_rocketlauncher']);
    // CPM's boxes are 50 5 5 5 50 5 50 5, and ammo of −1 packs none.
    expect(byWeapon(dropped[0].pack!)).toEqual([50, 3, 0, 5, 50, 5, 0, 5]);
  });

  it("packs up to each weapon's own amount in team deathmatch", () => {
    const level = match(GT.TEAM, presetRules('cpm'));

    tossClientItems(level, dropper(level, WP.ROCKET_LAUNCHER));

    // CPM's team weapons are 50 10 10 10 100 10 100 10.
    expect(byWeapon(drops(level)[0].pack!)).toEqual([50, 3, 0, 10, 80, 9, 0, 10]);
  });

  it("packs nothing in free-for-all, or under id's rules", () => {
    const ffa = match(GT.FFA, presetRules('cpm'));
    tossClientItems(ffa, dropper(ffa, WP.ROCKET_LAUNCHER));
    expect(drops(ffa)[0].pack).toBeNull();

    const id = match(GT.TOURNAMENT);
    tossClientItems(id, dropper(id, WP.ROCKET_LAUNCHER));
    expect(drops(id)[0].pack).toBeNull();

    // Nor does a player with no weapon to drop leave a box.
    for (const level of [match(GT.FFA, presetRules('cpm')), match(GT.TOURNAMENT)]) {
      tossClientItems(level, dropper(level, WP.MACHINEGUN));
      expect(drops(level)).toHaveLength(0);
    }
  });

  it('sends the pack as the box of the best weapon with ammo, with no weapon to drop', () => {
    /** What a death holding `weapon` with `ammo` leaves, and its pack's rockets. */
    function left(weapon: number, ammo: readonly number[]): [string | undefined, number][] {
      const level = match(GT.TOURNAMENT, presetRules('cpm'));
      tossClientItems(level, dropper(level, weapon, ammo));
      return drops(level).map((entity) => [
        entity.item?.classname,
        entity.pack![WP.ROCKET_LAUNCHER]
      ]);
    }

    expect(left(WP.MACHINEGUN, HELD)).toEqual([['ammo_bfg', 5]]);
    expect(left(WP.MACHINEGUN, [100, 0, 0, 3, 0, 0, 0, 0])).toEqual([['ammo_rockets', 3]]);
    expect(left(WP.MACHINEGUN, [100, 0, 0, 0, 0, 0, 0, 0])).toEqual([['ammo_bullets', 0]]);
    // An empty weapon in hand is none to drop, and ammo of −1 is ammo.
    expect(left(WP.RAILGUN, [0, 0, 0, 0, 0, 0, -1, 0])).toEqual([['ammo_cells', 0]]);
    expect(left(WP.RAILGUN, [0, 0, 0, 0, 0, 0, 0, 0])).toEqual([]);
  });

  it('gives the weapon and all it carries, each up to the maximum, to whoever takes it', () => {
    const level = match(GT.TOURNAMENT, presetRules('cpm'));
    tossClientItems(level, dropper(level, WP.ROCKET_LAUNCHER));
    const [dropped] = drops(level);
    const other = taker(level, [90, 24, 0, 1, 140, 0, 0, 0]);

    touchItem(level, dropped, other);

    const ps = other.client!.ps;
    expect(ps.stats[STAT.WEAPONS] & (1 << WP.ROCKET_LAUNCHER)).toBeTruthy();
    // 50 3 0 5 50 5 0 5 onto CPM's maxima of 100 25 25 25 150 25 100 25, and nothing more for
    // the launcher itself.
    expect(byWeapon(ps.ammo)).toEqual([100, 25, 0, 6, 150, 5, 0, 5]);
    expect(dropped.freeAfterEvent).toBe(true);
  });

  it('is taken whatever the taker holds, where a box is refused', () => {
    const level = match(GT.TOURNAMENT, presetRules('cpm'));
    tossClientItems(level, dropper(level, WP.MACHINEGUN, [100, 0, 0, 3, 0, 0, 0, 0]));
    const [dropped] = drops(level);
    const other = taker(level, [0, 0, 0, 25, 0, 0, 0, 0]);

    // The same box without its pack is refused at the rockets' maximum of 25.
    const carried = dropped.pack;
    dropped.pack = null;
    touchItem(level, dropped, other);
    expect(dropped.s.eFlags & EF_NODRAW).toBe(0);

    dropped.pack = carried;
    touchItem(level, dropped, other);
    expect(dropped.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    expect(byWeapon(other.client!.ps.ammo)).toEqual([50, 0, 0, 25, 0, 0, 0, 0]);
  });

  it('is taken as a plain drop once the rules stop packing', () => {
    /** The taker's ammo once they take what a death holding `weapon` left. */
    function taken(weapon: number, ammo: readonly number[]): number[] {
      const rules = presetRules('cpm');
      const level = match(GT.TOURNAMENT, rules);
      tossClientItems(level, dropper(level, weapon, ammo));
      const [dropped] = drops(level);
      rules.g_dropWeaponAmmo = 0;
      const other = taker(level, [0, 0, 0, 0, 0, 0, 0, 0]);
      touchItem(level, dropped, other);
      return byWeapon(other.client!.ps.ammo);
    }

    // A dropped launcher's CPM amount, and a box of CPM's rockets, and nothing else.
    expect(taken(WP.ROCKET_LAUNCHER, HELD)).toEqual([0, 0, 0, 10, 0, 0, 0, 0]);
    expect(taken(WP.MACHINEGUN, [100, 0, 0, 3, 0, 0, 0, 0])).toEqual([0, 0, 0, 5, 0, 0, 0, 0]);
  });

  it("packs under every preset but VQ3's, each to its own boxes", () => {
    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
    const bullets = presets.map((name) => {
      const level = match(GT.CTF, presetRules(name));
      tossClientItems(level, dropper(level, WP.MACHINEGUN, [100, 0, 0, 0, 0, 0, 0, 0]));
      return drops(level).map((entity) => entity.pack![WP.MACHINEGUN]);
    });
    expect(bullets).toEqual([[], [25], [50], [10], [50]]);
  });

  it('leaves no pack behind in a freed slot', () => {
    const level = match(GT.TOURNAMENT, presetRules('cpm'));
    tossClientItems(level, dropper(level, WP.ROCKET_LAUNCHER));
    const [dropped] = drops(level);

    level.freeEntity(dropped);

    expect(dropped.pack).toBeNull();
  });
});
