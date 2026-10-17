import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, ENTITYNUM_WORLD, TR } from '../net/protocol';
import { createFlatWorldTrace } from './box-world';
import { createClipTrace } from './clip-trace';
import { loadMap } from './cm/cm-load';
import { cubeBsp } from './cm/collision-test-fixtures';
import { CONTENTS, EF_NODRAW, PMOVE_MSEC } from './constants';
import { ET, type GameEntity } from './game-entity';
import { findItem } from './items';
import { ITEM_STOP_SPEED, runItem } from './item-run';
import { ITEM_RADIUS, launchItem } from './item-spawn';
import { Level } from './level';
import { distinctAsks, recordingTrace } from './trace-test-fixtures';
import type { TraceFn } from './types';
import { vec3 } from './vec3';

/**
 * `G_RunItem`, as the frame reaches it: the fall of a dropped item, the bounce of a map item, and
 * the think of one standing still. A corpse's own fall is exercised in `body-queue.test.ts`,
 * through the same function — this is what a *dropped* item does differently, and it differs by
 * one number: `physicsBounce`.
 */

const flat = createFlatWorldTrace();

/** A level whose frame runs its items, standing in for a host with its links. */
function match(trace: TraceFn = flat): Level {
  const level: Level = new Level({
    handlers: { runItem: (entity) => runItem(level, entity, trace) }
  });
  return level;
}

/** Run the level a tick at a time, as the host does. */
function ticks(level: Level, from: number, to: number): void {
  for (let time = from; time <= to; time += PMOVE_MSEC) level.runFrame(time);
}

/**
 * A dropped item falling from 200, as `LaunchItem` leaves one. Its box is the item's own 15-unit
 * one, so it comes to rest a unit above the floor, its bottom on it.
 */
function falling(trace: TraceFn = flat, bounce = 0): { level: Level; dropped: GameEntity } {
  const level = match(trace);
  const dropped = launchItem(level, findItem('weapon_rocketlauncher')!, vec3(0, 0, 200), vec3());
  dropped.physicsBounce = bounce;
  dropped.s.pos.trTime = 0;
  return { level, dropped };
}

describe('a dropped item', () => {
  it('stops dead at its first floor contact, its box standing on the floor', () => {
    const { level, dropped } = falling();
    ticks(level, PMOVE_MSEC, 2000);

    // A dropped item keeps none of its speed: `LaunchItem` never sets `physicsBounce`, so the
    // reflection is scaled away and the first floor it touches stops it.
    expect(dropped.s.pos.trType).toBe(TR.STATIONARY);
    expect(dropped.s.pos.trDelta).toEqual(vec3());
    expect(dropped.s.pos.trBase).toEqual(vec3(0, 0, ITEM_RADIUS + 1));
    expect(dropped.s.origin).toEqual(dropped.s.pos.trBase);
    expect(dropped.r.currentOrigin).toEqual(dropped.s.pos.trBase);
    // Standing on the world, which is what the trace's floor is.
    expect(dropped.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
  });

  it("stops on a brush's top as on the floor, through a BSP's collision", () => {
    // The collision tests' cube, its top at z 64, under the drop.
    const cube = createClipTrace(loadMap(cubeBsp(), 'maps/test.bsp'));
    for (const bounce of [0, 0.5]) {
      const { level, dropped } = falling(cube, bounce);
      ticks(level, PMOVE_MSEC, 4000);

      expect(dropped.s.pos.trType).toBe(TR.STATIONARY);
      expect(dropped.s.pos.trBase).toEqual(vec3(0, 0, 64 + ITEM_RADIUS + 1));
      expect(dropped.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
    }
  });

  it('stays where it landed once it has, however long the frame runs', () => {
    const { level, dropped } = falling();
    ticks(level, PMOVE_MSEC, 2000);
    const landed = dropped.s.pos.trBase;

    ticks(level, 2008, 5000);
    expect(dropped.s.pos.trBase).toEqual(landed);
    expect(dropped.s.pos.trType).toBe(TR.STATIONARY);
  });
});

describe('a map item that falls', () => {
  it('keeps half its speed off the floor, so it bounces', () => {
    const { level, dropped } = falling(flat, 0.5);
    ticks(level, PMOVE_MSEC, 688);

    // 544 ups into the floor, reflected and halved: 272 up, still falling under gravity. That is
    // `G_BounceItem`'s `ent->physicsBounce`, which `G_SpawnItem` gives every map item.
    expect(dropped.s.pos.trType).toBe(TR.GRAVITY);
    expect(dropped.s.pos.trDelta.z).toBe(272);
    expect(dropped.s.pos.trDelta.z).toBeGreaterThan(ITEM_STOP_SPEED);
    expect(dropped.s.pos.trBase.z).toBeCloseTo(ITEM_RADIUS + 1, 1);
  });

  it('bounces out and comes to rest, where a dropped one would have stopped', () => {
    const { level, dropped } = falling(flat, 0.5);
    ticks(level, PMOVE_MSEC, 3000);

    expect(dropped.s.pos.trType).toBe(TR.STATIONARY);
    expect(dropped.s.pos.trBase).toEqual(vec3(0, 0, ITEM_RADIUS + 1));
    // `G_SetOrigin` leaves no velocity behind: a resting item is not drifting.
    expect(dropped.s.pos.trDelta).toEqual(vec3());
    expect(dropped.s.groundEntityNum).toBe(ENTITYNUM_WORLD);
  });
});

describe('an item that has lost its ground', () => {
  it('falls, whatever it was doing before', () => {
    const world = match();
    world.time = 500;
    const item = world.spawnEntity();
    item.s.eType = ET.ITEM;
    item.s.pos.trType = TR.STATIONARY;
    item.s.pos.trBase = vec3(0, 0, 100);
    item.r.currentOrigin = vec3(0, 0, 100);
    item.s.groundEntityNum = ENTITYNUM_NONE;

    world.runFrame(500);

    expect(item.s.pos.trType).toBe(TR.GRAVITY);
    expect(item.s.pos.trTime).toBe(500);
  });

  it('only thinks while it is standing on something', () => {
    const { trace, asked } = recordingTrace(flat);
    const world = match(trace);
    world.time = 500;
    const item = world.spawnEntity();
    item.s.eType = ET.ITEM;
    item.s.pos.trType = TR.STATIONARY;
    item.s.pos.trBase = vec3(0, 0, 100);
    item.r.currentOrigin = vec3(0, 0, 100);
    item.s.groundEntityNum = ENTITYNUM_WORLD;
    let thought = 0;
    item.think = () => {
      thought++;
    };
    item.nextthink = 500;

    world.runFrame(500);

    expect(thought).toBe(1);
    expect(asked).toHaveLength(0);
    expect(item.s.pos.trType).toBe(TR.STATIONARY);
  });
});

describe("a falling item's trace", () => {
  it('passes its owner and stops at the world alone, whatever its clip mask', () => {
    const { trace, asked } = recordingTrace(flat);
    const { level } = falling(trace);

    ticks(level, PMOVE_MSEC, 100);

    // `LaunchItem` sets no owner, so the pass entity is `ENTITYNUM_NONE` — `G_Spawn`'s own
    // value, which a trace reads as no entity at all.
    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: ENTITYNUM_NONE, contentmask: CONTENTS.SOLID | CONTENTS.PLAYERCLIP }
    ]);
  });

  it('goes when its think says so, which is how a dropped item is freed', () => {
    const { level, dropped } = falling();
    dropped.nextthink = 0;

    ticks(level, PMOVE_MSEC, 100);
    expect(dropped.s.pos.trType).toBe(TR.GRAVITY);

    // The thirty-second think is `G_FreeEntity`: the item leaves the world, not the floor.
    dropped.nextthink = 100;
    level.runFrame(100);
    expect(dropped.inuse).toBe(false);
  });

  it('starts inside something and is bounced out of it', () => {
    const { level, dropped } = falling();
    dropped.s.pos.trBase = vec3(0, 0, -5);
    dropped.r.currentOrigin = vec3(0, 0, -5);
    dropped.s.pos.trType = TR.STATIONARY;
    dropped.s.eFlags |= EF_NODRAW;

    // A trace that begins in solid reports no travel, which the bounce reads as a contact at the
    // start: it comes to rest where it was put rather than falling through the floor.
    level.runFrame(PMOVE_MSEC);
    expect(dropped.s.pos.trType).toBe(TR.STATIONARY);
  });
});
