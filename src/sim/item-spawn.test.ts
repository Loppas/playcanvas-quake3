import { describe, expect, it } from 'vitest';

import type { SpawnVar } from '../formats/entity-text';
import { ENTITYNUM_WORLD, TR } from '../net/protocol';
import { box, createBoxWorldTrace, createFlatWorldTrace } from './box-world';
import { CONTENTS, EF_BOUNCE_HALF, EF_NODRAW, FL, GT, STAT } from './constants';
import { ET, type GameEntity } from './game-entity';
import { findItem, ITEMS, itemIndex, NUM_ITEMS } from './items';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import {
  clearRegisteredItems,
  dropItem,
  finishSpawningItem,
  ITEM_RADIUS,
  launchItem,
  registerItem,
  saveRegisteredItems,
  spawnItem
} from './item-spawn';
import { Level } from './level';
import { ID_RULES, type Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { FLAG } from './team';
import { clearTrace } from './types';
import { vec3 } from './vec3';
import { WP } from './weapons/constants';

/** A level with these handlers, as a map that is not running a host has. */
function level(): Level {
  return new Level();
}

/** The pairs a map would write, as {@link spawnItem} takes them. */
function vars(pairs: Record<string, string>): SpawnVar[] {
  return Object.entries(pairs);
}

describe('itemIndex', () => {
  it('gives the slot a pointer to the table would name', () => {
    expect(itemIndex(findItem('item_quad')!)).toBe(28);
    expect(itemIndex(findItem('weapon_railgun')!)).toBe(14);
  });

  it('refuses the placeholder slot and anything not in the table', () => {
    expect(() => itemIndex(ITEMS[0])).toThrow('itemIndex: the item is not in the table');
    expect(() => itemIndex({ classname: 'item_nope' } as never)).toThrow(
      'itemIndex: the item is not in the table'
    );
  });
});

describe('the item registry', () => {
  it('starts empty and takes whichever item the map spawns', () => {
    const world = level();
    expect(world.itemsRegistered.length).toBe(NUM_ITEMS);
    expect(world.itemsRegistered.some(Boolean)).toBe(false);
    registerItem(world, findItem('item_quad')!);
    expect(world.itemsRegistered[28]).toBe(true);
  });

  it('clears to the two weapons every player starts with', () => {
    const world = level();
    registerItem(world, findItem('item_quad')!);
    clearRegisteredItems(world);
    expect(world.itemsRegistered.flatMap((on, i) => (on ? [i] : []))).toEqual([8, 10]);
  });

  it('writes the 0s and 1s of CS_ITEMS and says how many', () => {
    const world = level();
    clearRegisteredItems(world);
    registerItem(world, findItem('item_quad')!);
    const prints: string[] = [];
    const string = saveRegisteredItems(world, (text) => prints.push(text));
    expect(string).toHaveLength(NUM_ITEMS);
    expect(string[0]).toBe('0');
    expect(string[10]).toBe('1');
    expect(string[28]).toBe('1');
    expect(string.split('1')).toHaveLength(4);
    expect(prints).toEqual(['3 items registered']);
  });
});

describe('spawnItem', () => {
  it("takes the map's wait and random, which Q3 reads again on the entity", () => {
    const world = level();
    const entity = world.spawnEntity();
    const item = findItem('item_quad')!;
    spawnItem(world, entity, item, vars({ wait: '30', random: '5' }));
    expect(entity.item).toBe(item);
    expect(entity.wait).toBe(30);
    expect(entity.random).toBe(5);
  });

  it('defers standing it two frames, leaves it bouncy, and puts it on the registry', () => {
    const world = level();
    world.time = 1000;
    const entity = world.spawnEntity();
    spawnItem(world, entity, findItem('weapon_railgun')!, []);
    expect(entity.nextthink).toBe(1200);
    expect(entity.think).not.toBeNull();
    expect(entity.physicsBounce).toBe(0.5);
    expect(world.itemsRegistered[14]).toBe(true);
  });

  it('reads noglobalsound into speed for a powerup, and only for a powerup', () => {
    const world = level();
    const quad = world.spawnEntity();
    spawnItem(world, quad, findItem('item_quad')!, vars({ noglobalsound: '1' }));
    expect(quad.speed).toBe(1);

    // The powerup's read has a default of 0, so it throws away whatever a `speed` key left.
    const clobbered = world.spawnEntity();
    clobbered.speed = 3;
    spawnItem(world, clobbered, findItem('item_quad')!, vars({ speed: '3' }));
    expect(clobbered.speed).toBe(0);

    // Anything that is not a powerup never reads the key, and keeps its `speed`.
    const railgun = world.spawnEntity();
    railgun.speed = 3;
    spawnItem(world, railgun, findItem('weapon_railgun')!, vars({ noglobalsound: '1' }));
    expect(railgun.speed).toBe(3);
  });

  it("names a powerup's arrival sound in CS_SOUNDS as it spawns, and nothing for any other", () => {
    const world = level();
    const named: string[] = [];
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, soundIndex: (name) => named.push(name) };
    spawnItem(world, world.spawnEntity(), findItem('weapon_railgun')!, []);
    spawnItem(world, world.spawnEntity(), findItem('item_quad')!, []);
    expect(named).toEqual(['sound/items/poweruprespawn.wav']);
  });
});

describe('finishSpawningItem', () => {
  /** A level with a floor at z = 0. */
  function floored(): Level {
    return new Level({ handlers: { trace: createFlatWorldTrace() } });
  }

  /** A level with that floor, counting how many times its collision is asked. */
  function traced(): { world: Level; calls: () => number } {
    let calls = 0;
    const floor = createFlatWorldTrace();
    const world = new Level({
      handlers: {
        trace: (...args) => {
          calls++;
          return floor(...args);
        }
      }
    });
    return { world, calls: () => calls };
  }

  it('gives it the trigger box, its slot, and the floor under it', () => {
    const world = floored();
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.item = findItem('weapon_railgun')!;
    finishSpawningItem(world, entity);

    expect(entity.r.mins).toEqual(vec3(-15, -15, -15));
    expect(entity.r.maxs).toEqual(vec3(15, 15, 15));
    expect(entity.s.eType).toBe(ET.ITEM);
    expect(entity.s.modelindex).toBe(14);
    expect(entity.s.modelindex2).toBe(0);
    expect(entity.r.contents).toBe(CONTENTS.TRIGGER);
    // The box's bottom rests on the floor, a trace's own epsilon above it.
    const bottom = entity.s.origin.z - ITEM_RADIUS;
    expect(bottom).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThan(0.2);
    expect(entity.s.origin.x).toBe(10);
    expect(entity.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(entity.r.linked).toBe(true);
  });

  it('leaves a suspended item where the map put it, without tracing', () => {
    const { world, calls } = traced();
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.spawnflags = 1;
    entity.item = findItem('weapon_railgun')!;
    finishSpawningItem(world, entity);

    expect(calls()).toBe(0);
    expect(entity.s.origin).toEqual(vec3(10, 20, 50));
    // Whatever the entity was allocated with stands: Q3 sets no ground for a suspended item.
    expect(entity.s.groundEntityNum).toBe(0);
    expect(entity.r.linked).toBe(true);
  });

  it('takes an item that starts inside something out of the world, saying where', () => {
    const locked = box(5, 15, 45, 15, 25, 55);
    const world = new Level({
      handlers: { trace: createBoxWorldTrace([locked]) }
    });
    const prints: string[] = [];
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, print: (text) => prints.push(text) };
    const entity = world.spawnEntity();
    entity.classname = 'item_quad';
    entity.s.origin = vec3(10.5, 20, 50.75);
    entity.item = findItem('item_quad')!;
    finishSpawningItem(world, entity);

    expect(entity.inuse).toBe(false);
    expect(entity.r.linked).toBe(false);
    expect(prints).toEqual(['FinishSpawningItem: item_quad startsolid at (10 20 50)']);
  });

  it('holds a targeted item back, hidden and untouchable, until something fires it', () => {
    const world = floored();
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.targetname = 'hidden';
    entity.item = findItem('item_quad')!;
    finishSpawningItem(world, entity);

    expect(entity.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    expect(entity.r.contents).toBe(0);
    expect(entity.r.linked).toBe(false);
    // Named before powerup: a held-back item has no first appearance to wait for.
    expect(entity.nextthink).toBe(0);
    expect(entity.think).toBeNull();
  });

  it('holds an empty targetname back too, as a name key with no value still names it', () => {
    const world = floored();
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.targetname = '';
    entity.item = findItem('item_quad')!;
    finishSpawningItem(world, entity);

    expect(entity.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    expect(entity.r.linked).toBe(false);
  });

  it('holds a team member back the same way, which is what a group leaves but its first', () => {
    const world = floored();
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.flags = FL.TEAMMEMBER;
    entity.item = findItem('item_quad')!;
    finishSpawningItem(world, entity);

    expect(entity.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    expect(entity.r.contents).toBe(0);
    expect(entity.r.linked).toBe(false);
  });

  it('holds a powerup out of the world until its first appearance, 45 ± 15 seconds in', () => {
    const world = floored();
    world.time = 1_000;
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0.5 };
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.item = findItem('item_quad')!;
    finishSpawningItem(world, entity);

    expect(entity.s.eFlags & EF_NODRAW).toBe(EF_NODRAW);
    expect(entity.r.contents).toBe(0);
    expect(entity.r.linked).toBe(false);
    expect(entity.nextthink).toBe(1_000 + 45_000);
    expect(entity.think).not.toBeNull();

    // What the first appearance's timer is: the item coming back like any other.
    entity.nextthink = 0;
    entity.think!(entity);
    expect(entity.r.contents).toBe(CONTENTS.TRIGGER);
    expect(entity.s.eFlags & EF_NODRAW).toBe(0);
    expect(entity.r.linked).toBe(true);
  });

  it('gives an item the touch that picks it up and the use that brings it back', () => {
    const world = floored();
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.item = findItem('weapon_railgun')!;
    finishSpawningItem(world, entity);

    expect(entity.touch).not.toBeNull();
    expect(entity.use).not.toBeNull();

    entity.r.contents = 0;
    entity.s.eFlags |= EF_NODRAW;
    entity.use!(entity, entity, entity);
    expect(entity.r.contents).toBe(CONTENTS.TRIGGER);
    expect(entity.s.eFlags & EF_NODRAW).toBe(0);
  });

  it('stands an item the frame has come round to, two frames after the map spawned it', () => {
    const world = floored();
    world.time = 0;
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    spawnItem(world, entity, findItem('weapon_railgun')!, []);

    world.runFrame(100);
    expect(entity.s.eType).toBe(0);
    world.runFrame(200);
    expect(entity.s.eType).toBe(ET.ITEM);
    expect(entity.r.linked).toBe(true);
    expect(entity.s.origin.z - ITEM_RADIUS).toBeLessThan(0.2);
  });
});

describe('the first powerups, by the rules', () => {
  /** A floored level at 1 s under the rules, whose match draws these fractions in turn. */
  function ruled(rules: Rules, draws: number[]): { world: Level; drawn: () => number } {
    const world = new Level({ handlers: { trace: createFlatWorldTrace() }, rules });
    world.time = 1_000;
    let drawn = 0;
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => draws[drawn++] };
    return { world, drawn: () => drawn };
  }

  /** When a powerup finished on the level first appears. */
  function first(world: Level, classname = 'item_quad'): number {
    const entity = world.spawnEntity();
    entity.s.origin = vec3(10, 20, 50);
    entity.item = findItem(classname)!;
    finishSpawningItem(world, entity);
    return entity.nextthink;
  }

  it('come the delay in, give or take the random part', () => {
    const rules = { ...ID_RULES, g_spawnDelay_powerup: 22.5, g_spawnDelayRandom_powerup: 7.5 };
    expect(first(ruled(rules, [0.75]).world)).toBe(1_000 + 26_250);
  });

  it('are drawn for each powerup, or together once for the level', () => {
    const each = ruled(ID_RULES, [0.75, 0.25]);
    expect([first(each.world), first(each.world, 'item_haste')]).toEqual([53_500, 38_500]);
    expect(each.drawn()).toBe(2);

    const together = { ...ID_RULES, g_spawnDelayTogether_powerup: 1 };
    const once = ruled(together, [0.75, 0.25]);
    expect([first(once.world), first(once.world, 'item_haste')]).toEqual([53_500, 53_500]);
    expect(once.drawn()).toBe(1);

    // A level of its own, as every map and restart has, draws afresh.
    expect(first(ruled(together, [0.25]).world)).toBe(38_500);
  });

  it("span each preset's range", () => {
    const spans = ['vq3', 'pmc', 'cpm', 'cq3', 'dev'].map((name) => {
      const rules = presetRules(name);
      return [
        first(ruled(rules, [0]).world),
        first(ruled(rules, [0.75]).world),
        rules.g_spawnDelayTogether_powerup
      ];
    });
    expect(spans).toEqual([
      [31_000, 53_500, 0],
      [16_000, 27_250, 1],
      [16_000, 27_250, 1],
      [31_000, 42_250, 0],
      [16_000, 27_250, 1]
    ]);
  });
});

describe('launchItem', () => {
  it('makes the item entity a map item is, but falling and marked dropped', () => {
    const world = level();
    world.time = 700;
    const item = findItem('weapon_rocketlauncher')!;
    const dropped = launchItem(world, item, vec3(10, 20, 30), vec3(1, 2, 3));

    expect(dropped.s.eType).toBe(ET.ITEM);
    expect(dropped.s.modelindex).toBe(itemIndex(item));
    expect(dropped.s.modelindex2).toBe(1);
    expect(dropped.classname).toBe(item.classname);
    expect(dropped.item).toBe(item);
    expect(dropped.r.mins).toEqual(vec3(-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS));
    expect(dropped.r.maxs).toEqual(vec3(ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS));
    expect(dropped.r.contents).toBe(CONTENTS.TRIGGER);
    expect(dropped.s.origin).toEqual(vec3(10, 20, 30));
    expect(dropped.s.pos.trType).toBe(TR.GRAVITY);
    expect(dropped.s.pos.trTime).toBe(700);
    expect(dropped.s.pos.trDelta).toEqual(vec3(1, 2, 3));
    expect(dropped.s.eFlags & EF_BOUNCE_HALF).toBe(EF_BOUNCE_HALF);
    expect(dropped.flags & FL.DROPPED_ITEM).toBe(FL.DROPPED_ITEM);
    expect(dropped.r.linked).toBe(true);
  });

  it('is freed after thirty seconds rather than put back', () => {
    const world = level();
    world.time = 700;
    const dropped = launchItem(world, findItem('item_quad')!, vec3(), vec3());
    // "auto-remove after 30 seconds" (`g_items.c:604`), written out rather than read back off
    // the constant, so a change to the constant is a failure and not a tautology.
    expect(dropped.nextthink).toBe(700 + 30_000);

    dropped.think!(dropped);
    expect(dropped.inuse).toBe(false);
  });

  it('sends a dropped flag home rather than freeing it, and says where it is', () => {
    // "Special case for CTF flags" (`g_items.c:596–606`): the same thirty seconds, but what
    // happens at the end of them is a flag back on its stand, not a flag gone.
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, gametype: () => GT.CTF };
    world.time = 700;
    const base = world.spawnEntity();
    base.classname = 'team_CTF_redflag';
    base.item = findItem('team_CTF_redflag')!;

    const dropped = launchItem(world, findItem('team_CTF_redflag')!, vec3(), vec3());

    expect(world.teamgame.redStatus).toBe(FLAG.DROPPED);
    expect(dropped.nextthink).toBe(700 + 30_000);

    dropped.think!(dropped);

    expect(world.teamgame.redStatus).toBe(FLAG.ATBASE);
    expect(base.r.contents).toBe(CONTENTS.TRIGGER);
  });

  it('frees a flag dropped in a match that has no flags in it', () => {
    // The branch asks the gametype as well as the item, so a flag left over from a CTF map in a
    // free-for-all is an ordinary dropped item and simply goes.
    const world = level();
    world.time = 700;
    const dropped = launchItem(world, findItem('team_CTF_redflag')!, vec3(), vec3());

    dropped.think!(dropped);

    expect(dropped.inuse).toBe(false);
  });

  it('can be walked into like a map item, and goes for good once taken', () => {
    const world = level();
    const dropped = launchItem(world, findItem('weapon_railgun')!, vec3(10, 20, 30), vec3());
    const player = world.gentities[0];
    player.client = world.clients[0];
    player.inuse = true;
    player.classname = 'player';
    player.client.ps.stats[STAT.HEALTH] = 100;

    dropped.touch!(dropped, player, clearTrace(vec3(10, 20, 30)));

    expect(player.client.ps.stats[STAT.WEAPONS] & (1 << WP.RAILGUN)).toBe(1 << WP.RAILGUN);
    expect(dropped.freeAfterEvent).toBe(true);
    expect(dropped.r.contents).toBe(0);
  });
});

describe('dropItem', () => {
  /**
   * A thrower at the origin facing `yaw` and looking `pitch` down, in Q3's own angle order. The
   * pitch is 30 by default: a throw is always level whatever the thrower was looking at.
   */
  function thrower(world: Level, yaw: number, pitch = 30): GameEntity {
    const entity = world.spawnEntity();
    entity.s.pos.trBase = vec3(10, 20, 30);
    entity.s.apos.trBase = vec3(pitch, yaw, 0);
    return entity;
  }

  it("throws level along the thrower's yaw, at 150 ups, with 200 ± 50 of lift", () => {
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0.5 };
    const dropped = dropItem(world, thrower(world, 90), findItem('weapon_rocketlauncher')!, 0);

    // "always forward" (`g_items.c:627`): yaw 90 is +Y, the pitch of 30 is thrown away, and the
    // numbers are `VectorScale( velocity, 150 )` and `velocity[2] += 200 + crandom() * 50`.
    expect(dropped.s.pos.trDelta.x).toBeCloseTo(0);
    expect(dropped.s.pos.trDelta.y).toBeCloseTo(150);
    expect(dropped.s.pos.trDelta.z).toBeCloseTo(200);
    expect(dropped.s.origin).toEqual(vec3(10, 20, 30));
  });

  it('turns the throw by the fan angle a death fans its powerups out by', () => {
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0.5 };
    const first = dropItem(world, thrower(world, 0), findItem('item_quad')!, 45);
    const second = dropItem(world, thrower(world, 0), findItem('item_haste')!, 90);

    expect(first.s.pos.trDelta.x).toBeCloseTo(150 * Math.SQRT1_2);
    expect(first.s.pos.trDelta.y).toBeCloseTo(150 * Math.SQRT1_2);
    expect(second.s.pos.trDelta.x).toBeCloseTo(0);
    expect(second.s.pos.trDelta.y).toBeCloseTo(150);
  });

  it("draws its lift from the match's own generator, ± 50 about 200", () => {
    const world = level();
    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 1 };
    const high = dropItem(world, thrower(world, 0), findItem('item_quad')!, 0);
    expect(high.s.pos.trDelta.z).toBeCloseTo(250);

    world.itemMatch = { ...DEFAULT_ITEM_MATCH, random: () => 0 };
    const low = dropItem(world, thrower(world, 0), findItem('item_quad')!, 0);
    expect(low.s.pos.trDelta.z).toBeCloseTo(150);
  });
});
