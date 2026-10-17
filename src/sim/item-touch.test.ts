import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../net/protocol';
import { box, createBoxWorldTrace } from './box-world';
import { CON } from './client';
import { CONTENTS, EF_NODRAW, FL, GT, PERS, PLAYEREVENT, STAT, TEAM } from './constants';
import { eventNumber, eventsSince, EV } from './events';
import { ET, SVF, type GameEntity } from './game-entity';
import { createIdlePlayerState } from './types';
import {
  addAmmo,
  crandom,
  DEFAULT_ITEM_MATCH,
  megaHealthWearOff,
  pickupAmmo,
  pickupArmor,
  pickupHealth,
  pickupHoldable,
  pickupPowerup,
  pickupWeapon,
  respawnItem,
  touchItem,
  useItem
} from './item-touch';
import { ARMOR_TIER, findItem, itemIndex, PW } from './items';
import { Level } from './level';
import { ID_RULES, type Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { findTeams } from './targets';
import { vec3 } from './vec3';
import { WP } from './weapons/constants';

/** A level with the links a map that is not running a host has, under `rules` or id's. */
function level(rules?: Rules): Level {
  return new Level({ rules });
}

/** A client in slot 0 with a standing player state, as `ClientSpawn` leaves one. */
function picker(world: Level, overrides: Partial<PlayerState> = {}): GameEntity {
  const entity = world.gentities[0];
  entity.inuse = true;
  entity.client = world.clients[0];
  entity.client.ps = createIdlePlayerState(overrides);
  return entity;
}

/** An item standing where the map put it, as `FinishSpawningItem` leaves one. */
function placed(world: Level, classname: string, overrides: Partial<GameEntity> = {}): GameEntity {
  const entity = world.spawnEntity();
  entity.item = findItem(classname)!;
  entity.s.eType = ET.ITEM;
  entity.s.modelindex = itemIndex(entity.item);
  entity.r.contents = CONTENTS.TRIGGER;
  return Object.assign(entity, overrides);
}

describe('crandom', () => {
  it('is Q3’s crandom: twice the fraction, less one', () => {
    expect(crandom(() => 0.5)).toBe(0);
    expect(crandom(() => 0)).toBe(-1);
    expect(crandom(() => 0.75)).toBe(0.5);
  });
});

describe('addAmmo', () => {
  it('adds to the weapon’s ammo, capped at 200', () => {
    const world = level();
    const player = picker(world);
    addAmmo(player, WP.ROCKET_LAUNCHER, 10);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(10);
    addAmmo(player, WP.ROCKET_LAUNCHER, 1000);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(200);
  });

  it("caps at the rules' maximum, and cuts back ammo held over it", () => {
    const cpm = presetRules('cpm');
    const player = picker(level());
    addAmmo(player, WP.ROCKET_LAUNCHER, 30, cpm);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(25);
    player.client!.ps.ammo[WP.LIGHTNING] = 190;
    addAmmo(player, WP.LIGHTNING, 5, cpm);
    expect(player.client!.ps.ammo[WP.LIGHTNING]).toBe(150);
  });
});

describe('pickupAmmo', () => {
  it('gives the table’s quantity and returns its respawn time', () => {
    const world = level();
    const player = picker(world);
    const bullets = placed(world, 'ammo_bullets');
    expect(pickupAmmo(world, bullets, player)).toBe(40);
    expect(player.client!.ps.ammo[WP.MACHINEGUN]).toBe(50);
  });

  it('lets a map’s count stand in for the quantity', () => {
    const world = level();
    const player = picker(world);
    const shells = placed(world, 'ammo_shells', { count: 3 });
    pickupAmmo(world, shells, player);
    expect(player.client!.ps.ammo[WP.SHOTGUN]).toBe(3);
  });
});

describe("pickupAmmo's rules", () => {
  it("gives the rules' box, and its team deathmatch box there, up to the maximum", () => {
    const world = level(presetRules('cpm'));
    const player = picker(world);
    pickupAmmo(world, placed(world, 'ammo_shells'), player);
    expect(player.client!.ps.ammo[WP.SHOTGUN]).toBe(5);
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => GT.TEAM };
    pickupAmmo(world, placed(world, 'ammo_shells'), player);
    expect(player.client!.ps.ammo[WP.SHOTGUN]).toBe(15);
    pickupAmmo(world, placed(world, 'ammo_shells'), player);
    expect(player.client!.ps.ammo[WP.SHOTGUN]).toBe(25);
  });
});

describe('pickupArmor', () => {
  it('adds the shard’s five and returns its respawn time', () => {
    const world = level();
    const player = picker(world);
    const shard = placed(world, 'item_armor_shard');
    expect(pickupArmor(shard, player)).toBe(25);
    expect(player.client!.ps.stats[STAT.ARMOR]).toBe(5);
  });

  it('caps armor at twice the health limit', () => {
    const world = level();
    const player = picker(world, { stats: armorAt(199, 100) });
    pickupArmor(placed(world, 'item_armor_combat'), player);
    expect(player.client!.ps.stats[STAT.ARMOR]).toBe(200);
  });

  it('caps armor at a fixed 200 under the fixed limits, whatever the handicap', () => {
    const world = level();
    const player = picker(world, { stats: armorAt(180, 50) });
    const fixed = { ...ID_RULES, g_fixedHealthLimits: 1 };
    pickupArmor(placed(world, 'item_armor_combat'), player, fixed);
    expect(player.client!.ps.stats[STAT.ARMOR]).toBe(200);
  });

  it('leaves armor alone while it is under the limit, over the health or not', () => {
    const world = level();
    const player = picker(world, { stats: armorAt(60, 100) });
    pickupArmor(placed(world, 'item_armor_combat'), player);
    // 110 is over the health limit and under twice it: the cap is the latter.
    expect(player.client!.ps.stats[STAT.ARMOR]).toBe(110);
  });
});

describe("pickupArmor's tiers", () => {
  const { GA, YA, RA } = ARMOR_TIER;

  /** The armour and the tier after `classname` is taken with `armor` of `tier`. */
  function taken(rules: Rules, classname: string, armor: number, tier: number): number[] {
    const world = level();
    const stats = armorAt(armor, 100);
    stats[STAT.ARMOR_TIER] = tier;
    const player = picker(world, { stats });
    pickupArmor(placed(world, classname), player, rules);
    return [player.client!.ps.stats[STAT.ARMOR], player.client!.ps.stats[STAT.ARMOR_TIER]];
  }

  it('rescales the armour held into the tier taken, then adds its amount up to its cap', () => {
    const cpm = presetRules('cpm');
    expect(taken(cpm, 'item_armor_body', 0, YA)).toEqual([150, RA]);
    // 30 yellow is 26 red; 100 yellow is 88 red, and 238 stops at 200.
    expect(taken(cpm, 'item_armor_body', 30, YA)).toEqual([176, RA]);
    expect(taken(cpm, 'item_armor_body', 100, YA)).toEqual([200, RA]);
    // 22 red is 25 yellow in the VM's single precision, where a double makes 24.
    expect(taken(cpm, 'item_armor_combat', 22, RA)).toEqual([125, YA]);
    expect(taken(cpm, 'item_armor_combat', 140, YA)).toEqual([150, YA]);
  });

  it('lets the shard keep the tier, up to twice the limit, or give the green from none', () => {
    const cpm = presetRules('cpm');
    expect(taken(cpm, 'item_armor_shard', 150, RA)).toEqual([155, RA]);
    expect(taken(cpm, 'item_armor_shard', 150, YA)).toEqual([155, YA]);
    expect(taken(cpm, 'item_armor_shard', 0, YA)).toEqual([5, GA]);
    expect(taken(presetRules('cq3'), 'item_armor_shard', 0, RA)).toEqual([5, GA]);
  });

  it('sets the tier without the rescale, and the yellow untiered', () => {
    const cq3 = presetRules('cq3');
    expect(taken(cq3, 'item_armor_combat', 100, RA)).toEqual([150, YA]);
    expect(taken(cq3, 'item_armor_body', 180, YA)).toEqual([200, RA]);
    const vq3 = presetRules('vq3');
    expect(taken(vq3, 'item_armor_body', 0, YA)).toEqual([100, YA]);
    expect(taken(vq3, 'item_armor_shard', 0, YA)).toEqual([5, YA]);
    // A tier held from before the armour was untiered goes back to the yellow.
    expect(taken(vq3, 'item_armor_body', 0, RA)).toEqual([100, YA]);
  });

  it("takes each preset's armour by its tiers", () => {
    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
    const fingerprint = (name: string) => [
      taken(presetRules(name), 'item_armor_body', 30, YA),
      taken(presetRules(name), 'item_armor_combat', 22, RA)
    ];
    expect(presets.map(fingerprint)).toEqual([
      [[130, YA], [72, YA]],
      [[176, RA], [125, YA]],
      [[176, RA], [125, YA]],
      [[130, RA], [72, YA]],
      [[176, RA], [125, YA]]
    ]);
  });
});

describe('pickupWeapon', () => {
  it('grants the weapon and drops the ammo to the amount it is short', () => {
    const world = level();
    const player = picker(world);
    const launcher = placed(world, 'weapon_rocketlauncher');
    expect(pickupWeapon(world, launcher, player)).toBe(5);
    expect(player.client!.ps.stats[STAT.WEAPONS] & (1 << WP.ROCKET_LAUNCHER)).toBeTruthy();
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(10);
  });

  it('gives only a single shot when the player already has the item’s quantity', () => {
    const world = level();
    const player = picker(world);
    player.client!.ps.ammo[WP.ROCKET_LAUNCHER] = 10;
    pickupWeapon(world, placed(world, 'weapon_rocketlauncher'), player);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(11);
  });

  it('gives full ammo from a dropped weapon however much the player carries', () => {
    const world = level();
    const player = picker(world);
    player.client!.ps.ammo[WP.ROCKET_LAUNCHER] = 10;
    const dropped = placed(world, 'weapon_rocketlauncher', { flags: FL.DROPPED_ITEM });
    pickupWeapon(world, dropped, player);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(20);
  });

  it('keeps the weapon but no ammo when a map wrote a negative count', () => {
    const world = level();
    const player = picker(world);
    pickupWeapon(world, placed(world, 'weapon_railgun', { count: -1 }), player);
    expect(player.client!.ps.stats[STAT.WEAPONS] & (1 << WP.RAILGUN)).toBeTruthy();
    expect(player.client!.ps.ammo[WP.RAILGUN]).toBe(0);
  });

  it('takes the map’s count as the quantity when it wrote one', () => {
    const world = level();
    const player = picker(world);
    pickupWeapon(world, placed(world, 'weapon_railgun', { count: 3 }), player);
    expect(player.client!.ps.ammo[WP.RAILGUN]).toBe(3);
  });

  it('still caps at 200 for a player already there', () => {
    const world = level();
    const player = picker(world);
    player.client!.ps.ammo[WP.ROCKET_LAUNCHER] = 200;
    pickupWeapon(world, placed(world, 'weapon_rocketlauncher'), player);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(200);
  });

  it('is the team respawn in a team game, where weapons come back full', () => {
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => GT.TEAM };
    const player = picker(world);
    player.client!.ps.ammo[WP.ROCKET_LAUNCHER] = 10;
    const launcher = placed(world, 'weapon_rocketlauncher');
    expect(pickupWeapon(world, launcher, player)).toBe(30);
    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(20);
  });
});

describe("pickupWeapon's rules", () => {
  /**
   * The ammo after `classname` is taken in `gametype` under `rules`, with `ammo` of its weapon,
   * and the weapon held or not.
   */
  function taken(
    rules: Rules,
    gametype: number,
    classname: string,
    ammo: number,
    held: boolean,
    overrides: Partial<GameEntity> = {}
  ): number {
    const world = level(rules);
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => gametype };
    const player = picker(world);
    const weapon = findItem(classname)!.giTag;
    const { ps } = player.client!;
    ps.ammo[weapon] = ammo;
    if (held) ps.stats[STAT.WEAPONS] |= 1 << weapon;
    pickupWeapon(world, placed(world, classname, overrides), player);
    return ps.ammo[weapon];
  }

  it('gives the whole amount not held, and tops one held up to it with nothing over', () => {
    const cq3 = presetRules('cq3');
    const launcher = (ammo: number, held: boolean) =>
      taken(cq3, GT.TOURNAMENT, 'weapon_rocketlauncher', ammo, held);
    expect(launcher(0, false)).toBe(8);
    // Ammo without the weapon, as a spawn bonus leaves, takes the whole amount on top.
    expect(launcher(3, false)).toBe(11);
    expect(launcher(3, true)).toBe(8);
    expect(launcher(8, true)).toBe(8);
    expect(launcher(20, true)).toBe(20);
  });

  it("keeps id's rule in free-for-all, up to the quantity or a round", () => {
    const cpm = presetRules('cpm');
    expect(taken(cpm, GT.FFA, 'weapon_bfg', 0, false)).toBe(5);
    expect(taken(cpm, GT.FFA, 'weapon_bfg', 5, true)).toBe(6);
    expect(taken(cpm, GT.TOURNAMENT, 'weapon_bfg', 5, true)).toBe(5);
    expect(taken(presetRules('vq3'), GT.TOURNAMENT, 'weapon_bfg', 0, false)).toBe(20);
  });

  it('gives a dropped weapon, or any in team deathmatch, its amount in full', () => {
    const cpm = presetRules('cpm');
    const dropped = { flags: FL.DROPPED_ITEM };
    expect(taken(cpm, GT.FFA, 'weapon_lightning', 20, true, dropped)).toBe(70);
    expect(taken(cpm, GT.TEAM, 'weapon_lightning', 20, true)).toBe(120);
    expect(taken(cpm, GT.TEAM, 'weapon_lightning', 100, true)).toBe(150);
  });

  it("reads a map's count under id's rule and not under the top-up", () => {
    const cq3 = presetRules('cq3');
    const count = { count: 3 };
    expect(taken(cq3, GT.TOURNAMENT, 'weapon_rocketlauncher', 0, false, count)).toBe(8);
    expect(taken(cq3, GT.FFA, 'weapon_rocketlauncher', 0, false, count)).toBe(3);
    expect(taken(cq3, GT.TOURNAMENT, 'weapon_rocketlauncher', 5, false, { count: -1 })).toBe(5);
  });

  it("takes each preset's ammo by its rules", () => {
    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'];
    const fingerprint = (name: string) => {
      const rules = presetRules(name);
      const world = level(rules);
      world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => GT.TEAM };
      const player = picker(world);
      player.client!.ps.ammo[WP.PLASMAGUN] = 90;
      pickupAmmo(world, placed(world, 'ammo_lightning'), player);
      pickupAmmo(world, placed(world, 'ammo_cells'), player);
      return [
        taken(rules, GT.TOURNAMENT, 'weapon_rocketlauncher', 12, true),
        taken(rules, GT.FFA, 'weapon_bfg', 0, false),
        player.client!.ps.ammo[WP.LIGHTNING],
        player.client!.ps.ammo[WP.PLASMAGUN]
      ];
    };
    expect(presets.map(fingerprint)).toEqual([
      [13, 20, 60, 120],
      [12, 5, 60, 100],
      [12, 5, 50, 100],
      [12, 5, 50, 80],
      [12, 5, 50, 100]
    ]);
  });
});

describe('pickupPowerup', () => {
  it('starts the timer rounded to the second, and returns the powerup respawn', () => {
    const world = level();
    world.time = 12_345;
    const player = picker(world);
    const quad = placed(world, 'item_quad');
    expect(pickupPowerup(world, quad, player)).toBe(120);
    // The table's 30 seconds, from the last whole second rather than from 12,345 ms.
    expect(player.client!.ps.powerups[PW.QUAD]).toBe(12_000 + 30_000);
  });

  it('adds to a timer already running', () => {
    const world = level();
    world.time = 12_500;
    const player = picker(world);
    player.client!.ps.powerups[PW.QUAD] = 40_000;
    pickupPowerup(world, placed(world, 'item_quad'), player);
    expect(player.client!.ps.powerups[PW.QUAD]).toBe(70_000);
  });

  it('takes a map’s count as the duration', () => {
    const world = level();
    world.time = 1_000;
    const player = picker(world);
    pickupPowerup(world, placed(world, 'item_quad', { count: 10 }), player);
    expect(player.client!.ps.powerups[PW.QUAD]).toBe(11_000);
  });
});

describe('"denied"', () => {
  /** A wall across the line between the quad and the one watching it. */
  const WALL = box(40, -50, -50, 60, 50, 100);

  /**
   * A quad at the origin, taken by slot 0, and slot 1 alive and in the game, `from` the quad along
   * +x and facing it, in a world with nothing in it but what is given.
   */
  function watched(options: { from?: number; yaw?: number; wall?: boolean; gametype?: number } = {}) {
    const world = new Level({
      handlers: {
        trace: createBoxWorldTrace(options.wall ? [WALL] : [])
      }
    });
    const gametype = options.gametype ?? GT.FFA;
    world.itemMatch = { ...world.itemMatch, gametype: () => gametype };
    const taker = picker(world, { origin: vec3(0, 0, 24) });
    taker.client!.pers.connected = CON.CONNECTED;
    const watcher = world.gentities[1];
    watcher.inuse = true;
    watcher.client = world.clients[1];
    watcher.client.ps = createIdlePlayerState({
      origin: vec3(options.from ?? 100, 0, 24),
      viewangles: vec3(0, options.yaw ?? 180, 0)
    });
    watcher.client.ps.stats[STAT.HEALTH] = 100;
    watcher.client.pers.connected = CON.CONNECTED;
    const quad = placed(world, 'item_quad');
    quad.s.pos.trBase = vec3(0, 0, 24);
    return { world, taker, watcher, quad };
  }
  const events = (entity: GameEntity) => entity.client!.ps.persistant[PERS.PLAYEREVENTS];

  it('is told to somebody alive who watched the powerup go, and flips again for the next', () => {
    const { world, taker, watcher, quad } = watched();
    pickupPowerup(world, quad, taker);
    expect(events(watcher)).toBe(PLAYEREVENT.DENIEDREWARD);
    expect(events(taker)).toBe(0);

    pickupPowerup(world, quad, taker);
    expect(events(watcher)).toBe(0);
  });

  it('is not told to whoever took it, though they are looking at it too', () => {
    const { world, taker, quad } = watched();
    // Near enough, facing it and in the clear: nothing but being the taker keeps them out.
    taker.client!.ps.origin = vec3(30, 0, 24);
    taker.client!.ps.viewangles = vec3(0, 180, 0);
    taker.client!.ps.stats[STAT.HEALTH] = 100;
    pickupPowerup(world, quad, taker);
    expect(events(taker)).toBe(0);
  });

  it('is not told past 192 units', () => {
    const { world, taker, watcher, quad } = watched({ from: 193 });
    pickupPowerup(world, quad, taker);
    expect(events(watcher)).toBe(0);
  });

  it('is not told to somebody looking more than about 66 degrees away', () => {
    expect(events(denied({ yaw: 180 + 60 }))).toBe(PLAYEREVENT.DENIEDREWARD);
    expect(events(denied({ yaw: 180 + 70 }))).toBe(0);
  });

  it('is not told through a wall', () => {
    expect(events(denied({ wall: true }))).toBe(0);
  });

  it('is not told to the dead, or to a slot nobody is in', () => {
    const dead = watched();
    dead.watcher.client!.ps.stats[STAT.HEALTH] = 0;
    pickupPowerup(dead.world, dead.quad, dead.taker);
    expect(events(dead.watcher)).toBe(0);

    const gone = watched();
    gone.watcher.client!.pers.connected = CON.DISCONNECTED;
    pickupPowerup(gone.world, gone.quad, gone.taker);
    expect(events(gone.watcher)).toBe(0);
  });

  it('is not told to a teammate in a team game, and is to the other side', () => {
    const mates = watched({ gametype: GT.TEAM });
    mates.taker.client!.sess.sessionTeam = TEAM.RED;
    mates.watcher.client!.sess.sessionTeam = TEAM.RED;
    pickupPowerup(mates.world, mates.quad, mates.taker);
    expect(events(mates.watcher)).toBe(0);

    const sides = watched({ gametype: GT.TEAM });
    sides.taker.client!.sess.sessionTeam = TEAM.RED;
    sides.watcher.client!.sess.sessionTeam = TEAM.BLUE;
    pickupPowerup(sides.world, sides.quad, sides.taker);
    expect(events(sides.watcher)).toBe(PLAYEREVENT.DENIEDREWARD);
  });

  /** The one watching, once the quad has gone, as {@link watched} sets them up. */
  function denied(options: Parameters<typeof watched>[0]): GameEntity {
    const { world, taker, watcher, quad } = watched(options);
    pickupPowerup(world, quad, taker);
    return watcher;
  }
});

describe('pickupHoldable', () => {
  it('puts the item’s slot on the player and returns the holdable respawn', () => {
    const world = level();
    const player = picker(world);
    const medkit = placed(world, 'holdable_medkit');
    expect(pickupHoldable(medkit, player)).toBe(60);
    expect(player.client!.ps.stats[STAT.HOLDABLE_ITEM]).toBe(itemIndex(findItem('holdable_medkit')!));
  });
});

describe('respawnItem', () => {
  /** An item that has been picked up: hidden, unlinked, and due back never. */
  function hidden(world: Level, classname: string, overrides: Partial<GameEntity> = {}): GameEntity {
    const entity = placed(world, classname, overrides);
    entity.r.contents = 0;
    entity.s.eFlags |= EF_NODRAW;
    entity.r.svFlags |= SVF.NOCLIENT;
    entity.nextthink = 999_999;
    world.linkEntity(entity);
    world.unlinkEntity(entity);
    return entity;
  }

  it('is back in the world, drawn, and raising the respawn event', () => {
    const world = level();
    world.time = 5_000;
    const quad = hidden(world, 'item_quad');
    respawnItem(world, quad);
    expect(quad.r.contents).toBe(CONTENTS.TRIGGER);
    expect(quad.s.eFlags & EF_NODRAW).toBe(0);
    expect(quad.r.svFlags & SVF.NOCLIENT).toBe(0);
    expect(quad.r.linked).toBe(true);
    expect(quad.nextthink).toBe(0);
    expect(eventNumber(quad.s.event)).toBe(EV.ITEM_RESPAWN);
  });

  it('brings back one of a team’s members, chosen by the match’s own random', () => {
    const world = level();
    const members = [
      hidden(world, 'item_health', { team: 'g1' }),
      hidden(world, 'item_health', { team: 'g1' }),
      hidden(world, 'item_health', { team: 'g1' })
    ];
    findTeams(world, () => {});
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0.7 };

    // 0.7 of three picks the third in the chain, which `findTeams` builds in reverse.
    respawnItem(world, members[0]);
    const back = members.filter((member) => member.r.contents === CONTENTS.TRIGGER);
    expect(back).toHaveLength(1);
    expect(back[0]).not.toBe(members[0]);
  });

  it('refuses a team member with no master, as Q3’s G_Error does', () => {
    const world = level();
    const orphan = hidden(world, 'item_health', { team: 'g1' });
    expect(() => respawnItem(world, orphan)).toThrow('RespawnItem: bad teammaster');
  });

  /** A match that names sounds: the index of each new one, from 1, and the names it was asked for. */
  function sounding(world: Level): string[] {
    const names: string[] = [];
    world.itemMatch = {
      ...DEFAULT_ITEM_MATCH,
      soundIndex: (name) => {
        names.push(name);
        return names.length;
      }
    };
    return names;
  }

  /** The sound a respawn announced, as the temp entity that carries it. */
  function announced(world: Level): GameEntity | undefined {
    return world.gentities.find(
      (entity) =>
        entity.inuse &&
        (entity.s.eType === ET.EVENTS + EV.GLOBAL_SOUND ||
          entity.s.eType === ET.EVENTS + EV.GENERAL_SOUND)
    );
  }

  it('announces a powerup to the whole match, with the sound the match named', () => {
    const world = level();
    world.time = 5_000;
    const names = sounding(world);
    const quad = hidden(world, 'item_quad');

    respawnItem(world, quad);

    expect(names).toEqual(['sound/items/poweruprespawn.wav']);
    const announcement = announced(world)!;
    expect(announcement.s.eType).toBe(ET.EVENTS + EV.GLOBAL_SOUND);
    expect(announcement.s.eventParm).toBe(1);
    expect(announcement.r.svFlags & SVF.BROADCAST).toBeTruthy();
  });

  it('keeps the announcement where the powerup stands when the map asked for quiet', () => {
    const world = level();
    const soundingNames = sounding(world);
    const quad = hidden(world, 'item_quad', { speed: 1 });
    respawnItem(world, quad);
    expect(soundingNames).toEqual(['sound/items/poweruprespawn.wav']);
    expect(announced(world)!.s.eType).toBe(ET.EVENTS + EV.GENERAL_SOUND);
  });

  it('says nothing for anything that is not a powerup', () => {
    const world = level();
    const names = sounding(world);
    respawnItem(world, hidden(world, 'item_health'));
    respawnItem(world, hidden(world, 'weapon_railgun'));
    expect(names).toEqual([]);
    expect(announced(world)).toBeUndefined();
  });
});

describe('useItem', () => {
  it('respawning the item is what firing it does', () => {
    const world = level();
    const shard = placed(world, 'item_armor_shard');
    shard.r.contents = 0;
    shard.s.eFlags |= EF_NODRAW;
    useItem(world, shard);
    expect(shard.r.contents).toBe(CONTENTS.TRIGGER);
    expect(shard.s.eFlags & EF_NODRAW).toBe(0);
  });
});

describe('touchItem', () => {
  it('does nothing for a non-client or a dead player', () => {
    const world = level();
    const target = placed(world, 'item_quad');
    touchItem(world, target, world.spawnEntity());
    expect(target.r.contents).toBe(CONTENTS.TRIGGER);

    const corpse = picker(world, { stats: healthAt(0, 100) });
    touchItem(world, target, corpse);
    expect(target.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('leaves alone what the grab rules refuse', () => {
    const world = level();
    const player = picker(world, { stats: armorAt(200, 100) });
    const armor = placed(world, 'item_armor_combat');
    touchItem(world, armor, player);
    expect(armor.r.contents).toBe(CONTENTS.TRIGGER);
    expect(player.client!.ps.stats[STAT.ARMOR]).toBe(200);
  });

  it("takes health and armour by the level's rules", () => {
    const rules = { ...ID_RULES, g_fixedHealthLimits: 1 };
    const world = new Level({ rules });
    const player = picker(world, { stats: healthAt(60, 50) });
    touchItem(world, placed(world, 'item_health'), player);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(85);

    player.client!.ps.stats[STAT.ARMOR] = 150;
    touchItem(world, placed(world, 'item_armor_combat'), player);
    expect(player.client!.ps.stats[STAT.ARMOR]).toBe(200);
  });

  it('grants what it picks up, then hides it until its respawn', () => {
    const world = level();
    world.time = 1_000;
    const player = picker(world);
    const launcher = placed(world, 'weapon_rocketlauncher');
    touchItem(world, launcher, player);

    expect(player.client!.ps.ammo[WP.ROCKET_LAUNCHER]).toBe(10);
    expect(launcher.r.contents).toBe(0);
    expect(launcher.s.eFlags & EF_NODRAW).toBeTruthy();
    expect(launcher.r.svFlags & SVF.NOCLIENT).toBeTruthy();
    expect(launcher.nextthink).toBe(1_000 + 5_000);
    expect(launcher.think).not.toBeNull();
  });

  it('raises the pickup on the player’s own ring when the client predicts it', () => {
    const world = level();
    const player = picker(world);
    player.client!.pers.predictItemPickup = true;
    const bullets = placed(world, 'ammo_bullets');
    touchItem(world, bullets, player);
    expect(eventsSince(player.client!.ps, 0)).toContainEqual({
      event: EV.ITEM_PICKUP,
      parm: bullets.s.modelindex
    });
  });

  it('sends it as an external event when the client does not', () => {
    const world = level();
    const player = picker(world);
    const shard = placed(world, 'item_armor_shard');
    touchItem(world, shard, player);
    expect(player.client!.ps.externalEventParm).toBe(shard.s.modelindex);
    expect(eventNumber(player.client!.ps.externalEvent)).toBe(EV.ITEM_PICKUP);
  });

  it('broadcasts a powerup pickup to everyone, or to the picker alone for noglobalsound', () => {
    const world = level();
    const player = picker(world);
    touchItem(world, placed(world, 'item_quad'), player);
    const broadcast = world.gentities.filter(
      (entity) => entity.inuse && entity.s.eType === ET.EVENTS + EV.GLOBAL_ITEM_PICKUP
    );
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0].r.svFlags & SVF.BROADCAST).toBeTruthy();
    expect(broadcast[0].s.eventParm).toBe(itemIndex(findItem('item_quad')!));

    const quiet = level();
    const other = picker(quiet);
    touchItem(quiet, placed(quiet, 'item_quad', { speed: 1 }), other);
    const single = quiet.gentities.find(
      (entity) => entity.inuse && entity.s.eType === ET.EVENTS + EV.GLOBAL_ITEM_PICKUP
    )!;
    expect(single.r.svFlags & SVF.SINGLECLIENT).toBeTruthy();
    expect(single.r.singleClient).toBe(other.s.number);
  });

  it('hands a flag to the match’s own pickup and takes its answer', () => {
    // `Pickup_Team` lives in `team.ts`, and the item half reaches it through the match so the
    // two files stay one way round. −1 is "never bring it back, but free it if it was dropped".
    const world = level();
    const asked: GameEntity[] = [];
    world.itemMatch = {
      ...DEFAULT_ITEM_MATCH,
      gametype: () => GT.CTF,
      pickupTeam: (flag, other) => {
        asked.push(flag, other);
        return -1;
      }
    };
    const player = picker(world);
    player.client!.ps.persistant[PERS.TEAM] = TEAM.RED;
    const blue = placed(world, 'team_CTF_blueflag', { flags: FL.DROPPED_ITEM });

    touchItem(world, blue, player);

    expect(asked).toEqual([blue, player]);
    expect(blue.freeAfterEvent).toBe(true);
    expect(blue.nextthink).toBe(0);
    expect(blue.think).toBeNull();
  });

  it('says nothing and touches nothing when the flag rules answer zero', () => {
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => GT.CTF, pickupTeam: () => 0 };
    const player = picker(world);
    player.client!.ps.persistant[PERS.TEAM] = TEAM.RED;
    const red = placed(world, 'team_CTF_redflag');

    touchItem(world, red, player);

    expect(red.r.contents).toBe(CONTENTS.TRIGGER);
    expect(eventNumber(player.client!.ps.externalEvent)).not.toBe(EV.ITEM_PICKUP);
  });

  it('broadcasts a flag as it broadcasts a powerup', () => {
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => GT.CTF, pickupTeam: () => -1 };
    const player = picker(world);
    player.client!.ps.persistant[PERS.TEAM] = TEAM.RED;

    touchItem(world, placed(world, 'team_CTF_blueflag'), player);

    const broadcast = world.gentities.filter(
      (entity) => entity.inuse && entity.s.eType === ET.EVENTS + EV.GLOBAL_ITEM_PICKUP
    );
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0].r.svFlags & SVF.BROADCAST).toBeTruthy();
  });

  it('never predicts a powerup, however the client is set', () => {
    const world = level();
    const player = picker(world);
    player.client!.pers.predictItemPickup = true;
    touchItem(world, placed(world, 'item_quad'), player);
    expect(eventsSince(player.client!.ps, 0)).toHaveLength(0);
    expect(eventNumber(player.client!.ps.externalEvent)).toBe(EV.ITEM_PICKUP);
  });

  it('fires what the item targets', () => {
    const world = level();
    const player = picker(world);
    const used: string[] = [];
    const receiver = world.spawnEntity();
    receiver.targetname = 'relay';
    receiver.use = (self, other) => used.push(`${self.s.number}<-${other.s.number}`);
    const quad = placed(world, 'item_quad', { target: 'relay' });
    touchItem(world, quad, player);
    expect(used).toEqual([`${receiver.s.number}<-${quad.s.number}`]);
  });

  it('keeps a wait of −1 out of the world for good', () => {
    const world = level();
    world.time = 1_000;
    const player = picker(world);
    const launcher = placed(world, 'weapon_rocketlauncher', { wait: -1 });
    touchItem(world, launcher, player);
    expect(launcher.r.svFlags & SVF.NOCLIENT).toBeTruthy();
    expect(launcher.s.eFlags & EF_NODRAW).toBeTruthy();
    expect(launcher.r.contents).toBe(0);
    expect(launcher.unlinkAfterEvent).toBe(true);
    expect(launcher.think).toBeNull();
  });

  it('lets the map’s wait stand in for the table’s, with random about it', () => {
    const world = level();
    world.time = 1_000;
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0.5 };
    const player = picker(world);
    const launcher = placed(world, 'weapon_rocketlauncher', { wait: 7 });
    touchItem(world, launcher, player);
    expect(launcher.nextthink).toBe(8_000);
  });

  it('wanders the wait by the map’s random, and never below a second', () => {
    const world = level();
    world.time = 1_000;
    // crandom(−1) of the map's 100 takes the table's 40 seconds well past zero.
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0 };
    const player = picker(world);
    const bullets = placed(world, 'ammo_bullets', { random: 100 });
    touchItem(world, bullets, player);
    expect(bullets.nextthink).toBe(2_000);
  });

  it('frees a dropped item once its event has been seen', () => {
    const world = level();
    const player = picker(world);
    const dropped = placed(world, 'weapon_rocketlauncher', { flags: FL.DROPPED_ITEM });
    touchItem(world, dropped, player);
    expect(dropped.freeAfterEvent).toBe(true);
  });
});

describe('the respawn rules', () => {
  /** How long each is gone under the rules: health, mega, armour, ammo, quad, suit and invis. */
  function times(rules: Rules): number[] {
    const world = level(rules);
    const taken = (classname: string, pickup: (item: GameEntity, taker: GameEntity) => number) =>
      pickup(placed(world, classname), picker(world, { stats: healthAt(50, 100) }));
    const health = (item: GameEntity, taker: GameEntity) => pickupHealth(item, taker, rules);
    const powerup = (item: GameEntity, taker: GameEntity) => pickupPowerup(world, item, taker);
    return [
      taken('item_health', health),
      taken('item_health_mega', health),
      taken('item_armor_body', (item, taker) => pickupArmor(item, taker, rules)),
      taken('ammo_bullets', (item, taker) => pickupAmmo(world, item, taker)),
      taken('item_quad', powerup),
      taken('item_enviro', powerup),
      taken('item_invis', powerup)
    ];
  }

  it("are id's by default", () => {
    expect(times(ID_RULES)).toEqual([35, 35, 25, 40, 120, 120, 120]);
  });

  it('are each read from its own rule', () => {
    const rules = {
      ...ID_RULES,
      g_healthRespawn: 11,
      g_armorRespawn: 12,
      g_ammoRespawn: 13,
      g_powerupRespawn: 14
    };
    expect(times(rules)).toEqual([11, 11, 12, 13, 14, 14, 14]);
  });

  it("are each preset's", () => {
    expect(['vq3', 'pmc', 'cpm', 'cq3', 'dev'].map((name) => times(presetRules(name)))).toEqual([
      [35, 35, 25, 40, 120, 120, 120],
      [30, 30, 25, 30, 90, 180, 180],
      [30, 30, 25, 30, 90, 180, 180],
      [35, 35, 25, 40, 90, 180, 180],
      [30, 30, 25, 30, 90, 180, 180]
    ]);
  });

  it('scale the battlesuit and the invisibility alone, to whole seconds', () => {
    const world = level({
      ...ID_RULES,
      g_powerupRespawn: 91,
      g_respawnScale_enviro: 1.5,
      g_respawnScale_invis: 0.5
    });
    expect(pickupPowerup(world, placed(world, 'item_enviro'), picker(world))).toBe(136);
    expect(pickupPowerup(world, placed(world, 'item_invis'), picker(world))).toBe(45);
    expect(pickupPowerup(world, placed(world, 'item_haste'), picker(world))).toBe(91);
  });
});

describe("the map's times, by the rules", () => {
  /** When an item taken at 1 s comes back, and how many draws the match made for it. */
  function returns(
    rules: Rules,
    classname: string,
    overrides: Partial<GameEntity>,
    draws: number[] = []
  ): { at: number; drawn: number } {
    const world = level(rules);
    world.time = 1_000;
    let drawn = 0;
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => draws[drawn++] };
    const item = placed(world, classname, overrides);
    touchItem(world, item, picker(world, { stats: healthAt(50, 100) }));
    return { at: item.nextthink, drawn };
  }

  const TIMED = { wait: 10, random: 4 };

  it("time a weapon and a powerup by the map's wait and random, as id's", () => {
    expect(returns(ID_RULES, 'weapon_rocketlauncher', TIMED, [0.75])).toEqual({
      at: 13_000,
      drawn: 1
    });
    expect(returns(ID_RULES, 'item_quad', TIMED, [0.75])).toEqual({ at: 13_000, drawn: 1 });
  });

  it("leave a weapon's wait and random alone, each by its switch", () => {
    const rules = { ...ID_RULES, g_mapWeaponWait: 0, g_mapWeaponRandom: 0 };
    expect(returns(rules, 'weapon_rocketlauncher', TIMED)).toEqual({ at: 6_000, drawn: 0 });
    // CQ3's: the wait stands, and the random is never drawn.
    expect(returns(presetRules('cq3'), 'weapon_rocketlauncher', TIMED)).toEqual({
      at: 11_000,
      drawn: 0
    });
  });

  it("are each preset's for a weapon and a powerup", () => {
    const at = (name: string, classname: string) =>
      returns(presetRules(name), classname, TIMED, [0.75]).at;
    expect(
      ['vq3', 'pmc', 'cpm', 'cq3', 'dev'].map((name) => [
        at(name, 'weapon_rocketlauncher'),
        at(name, 'item_quad')
      ])
    ).toEqual([
      [13_000, 13_000],
      [6_000, 91_000],
      [6_000, 91_000],
      [11_000, 91_000],
      [6_000, 91_000]
    ]);
  });

  it("leave a powerup's wait and random alone under CPMA's rules", () => {
    expect(returns(presetRules('cpm'), 'item_quad', TIMED)).toEqual({ at: 91_000, drawn: 0 });
  });

  it('keep both for every other item, under any rules', () => {
    for (const name of ['vq3', 'pmc', 'cpm', 'cq3', 'dev']) {
      expect(returns(presetRules(name), 'ammo_bullets', TIMED, [0.75]), name).toEqual({
        at: 13_000,
        drawn: 1
      });
    }
  });

  it('still keep a weapon or a powerup with a wait of −1 out for good', () => {
    for (const classname of ['weapon_rocketlauncher', 'item_quad']) {
      const world = level(presetRules('cpm'));
      const item = placed(world, classname, { wait: -1 });
      touchItem(world, item, picker(world));
      expect(item.unlinkAfterEvent, classname).toBe(true);
      expect(item.think, classname).toBeNull();
    }
  });

  it("come to whole seconds, as Q3's int respawn makes them", () => {
    expect(returns(ID_RULES, 'ammo_bullets', { wait: 7.9 }).at).toBe(8_000);
    // 40 and crandom's half of 3 is 41.5.
    expect(returns(ID_RULES, 'ammo_bullets', { random: 3 }, [0.75]).at).toBe(42_000);
  });
});

describe("the megahealth's wear-off", () => {
  /** A taker of 50 health at 1 s, in a match of this mode, under CPM's rules or these. */
  function match(gametype: number = GT.TEAM, rules: Rules = presetRules('cpm')) {
    const world = level(rules);
    world.time = 1_000;
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => gametype };
    const taker = picker(world, { stats: healthAt(50, 100) });
    taker.classname = 'player';
    return { world, taker };
  }

  it('watches its taker every second from the pickup, outside free-for-all', () => {
    for (const gametype of [GT.TOURNAMENT, GT.TEAM, GT.CTF]) {
      const { world, taker } = match(gametype);
      const mega = placed(world, 'item_health_mega');
      touchItem(world, mega, taker);
      expect(mega.enemy, `${gametype}`).toBe(taker);
      expect(mega.nextthink, `${gametype}`).toBe(2_000);
    }
  });

  it("keeps the health's time in free-for-all, without the rule, and for any other health", () => {
    const ffa = match(GT.FFA);
    const mega = placed(ffa.world, 'item_health_mega');
    touchItem(ffa.world, mega, ffa.taker);
    expect(mega.nextthink).toBe(31_000);

    const id = match(GT.TEAM, ID_RULES);
    const timed = placed(id.world, 'item_health_mega');
    touchItem(id.world, timed, id.taker);
    expect(timed.nextthink).toBe(36_000);

    const team = match();
    const health = placed(team.world, 'item_health');
    touchItem(team.world, health, team.taker);
    expect(health.nextthink).toBe(31_000);
  });

  it('waits while its taker is over 100, then comes back the rule’s seconds later', () => {
    const { world, taker } = match(GT.TEAM, { ...ID_RULES, g_megaHealthWearOff: 7 });
    const mega = placed(world, 'item_health_mega');
    touchItem(world, mega, taker);
    const { stats } = taker.client!.ps;
    expect(stats[STAT.HEALTH]).toBe(150);

    world.time = 2_000;
    mega.think!(mega);
    expect(mega.nextthink).toBe(3_000);
    stats[STAT.HEALTH] = 101;
    world.time = 3_000;
    mega.think!(mega);
    expect(mega.nextthink).toBe(4_000);

    stats[STAT.HEALTH] = 100;
    world.time = 4_000;
    mega.think!(mega);
    expect(mega.nextthink).toBe(11_000);
    expect(mega.r.contents).toBe(0);

    world.time = 11_000;
    mega.think!(mega);
    expect(mega.r.contents).toBe(CONTENTS.TRIGGER);
    expect(mega.s.eFlags & EF_NODRAW).toBe(0);
  });

  it('counts a taker who died, left or is no longer there as having lost it', () => {
    const lost: [string, (taker: GameEntity, mega: GameEntity) => void][] = [
      ['died', (taker) => (taker.client!.ps.stats[STAT.HEALTH] = -20)],
      ['left', (taker) => (taker.classname = 'disconnected')],
      ['freed', (taker) => (taker.classname = 'freed')],
      ['nobody', (_taker, mega) => (mega.enemy = null)]
    ];
    for (const [name, lose] of lost) {
      const { world, taker } = match();
      const mega = placed(world, 'item_health_mega');
      touchItem(world, mega, taker);
      lose(taker, mega);
      world.time = 2_000;
      megaHealthWearOff(world, mega);
      expect(mega.nextthink, name).toBe(22_000);
    }
  });

  it('wears off under PMC, CPM and DEV', () => {
    const presets = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'].map((name) => {
      const rules = presetRules(name);
      const { world, taker } = match(GT.TEAM, rules);
      const mega = placed(world, 'item_health_mega');
      touchItem(world, mega, taker);
      return [mega.nextthink, rules.g_megaHealthWearOff];
    });
    expect(presets).toEqual([
      [36_000, 0],
      [2_000, 20],
      [2_000, 20],
      [36_000, 0],
      [2_000, 20]
    ]);
  });

  it("ignores the map's wait and random, but for a wait of −1", () => {
    const { world, taker } = match();
    const mega = placed(world, 'item_health_mega', { wait: 10, random: 5 });
    touchItem(world, mega, taker);
    expect(mega.nextthink).toBe(2_000);

    const held = match();
    const gone = placed(held.world, 'item_health_mega', { wait: -1 });
    touchItem(held.world, gone, held.taker);
    expect(gone.unlinkAfterEvent).toBe(true);
    expect(gone.think).toBeNull();
  });
});

describe('pickupHealth', () => {
  it('tops up to the limit and returns its respawn time', () => {
    const world = level();
    const player = picker(world, { stats: healthAt(60, 100) });
    const health = placed(world, 'item_health');
    expect(pickupHealth(health, player)).toBe(35);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(85);
  });

  it('caps an ordinary health at the limit', () => {
    const world = level();
    const player = picker(world, { stats: healthAt(95, 100) });
    pickupHealth(placed(world, 'item_health'), player);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(100);
  });

  it('lets a small health go over the limit, but only to twice it', () => {
    const world = level();
    const player = picker(world, { stats: healthAt(145, 100) });
    pickupHealth(placed(world, 'item_health_small'), player);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(150);

    const hurt = picker(world, { stats: healthAt(199, 100) });
    pickupHealth(placed(world, 'item_health_small'), hurt);
    expect(hurt.client!.ps.stats[STAT.HEALTH]).toBe(200);
  });

  it('gives the mega its slow respawn and lets it go to twice the limit', () => {
    const world = level();
    const player = picker(world, { stats: healthAt(150, 100) });
    const mega = placed(world, 'item_health_mega');
    expect(pickupHealth(mega, player)).toBe(35);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(200);
  });

  it('tops up to a fixed 100, or twice it, under the fixed limits, whatever the handicap', () => {
    const world = level();
    const fixed = { ...ID_RULES, g_fixedHealthLimits: 1 };
    const player = picker(world, { stats: healthAt(60, 50) });
    pickupHealth(placed(world, 'item_health'), player, fixed);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(85);

    const hurt = picker(world, { stats: healthAt(150, 50) });
    pickupHealth(placed(world, 'item_health_mega'), hurt, fixed);
    expect(hurt.client!.ps.stats[STAT.HEALTH]).toBe(200);
  });

  it('takes a map’s count where it wrote one', () => {
    const world = level();
    const player = picker(world, { stats: healthAt(30, 100) });
    pickupHealth(placed(world, 'item_health', { count: 12 }), player);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(42);
  });
});

/** A `ps.stats` array with health and limit set, as the pickups read them. */
function healthAt(health: number, max: number): PlayerState['stats'] {
  const stats = createIdlePlayerState().stats;
  stats[STAT.HEALTH] = health;
  stats[STAT.MAX_HEALTH] = max;
  return stats;
}

/** The same, for armor. */
function armorAt(armor: number, max: number): PlayerState['stats'] {
  const stats = healthAt(max, max);
  stats[STAT.ARMOR] = armor;
  return stats;
}
