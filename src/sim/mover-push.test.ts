import { describe, expect, it } from 'vitest';

import { ENTITYNUM_NONE, ENTITYNUM_WORLD, TR } from '../net/protocol';
import type { Vec3f } from './cm/q-math';
import { CONTENTS, FL, MOD, STAT } from './constants';
import { ET, MOVER, setEntityOrigin, type GameEntity } from './game-entity';
import type { Level } from './level';
import { moverPush, moverTeam, runMover, testEntityPosition } from './mover-push';
import { moverLevel } from './mover-test-fixtures';
import { setMoverState } from './movers';
import { clientAt } from './trigger-test-fixtures';
import { vec3, type Vec3 } from './vec3';

/** A platform 128 square and 16 thick on the floor, which every test here pushes with. */
const PLATFORM: readonly [Vec3f, Vec3f] = [
  [-64, -64, 0],
  [64, 64, 16]
];

/** The platform, and a solid block of these bounds that never moves, both fired by name. */
function scene(block?: readonly [Vec3f, Vec3f]) {
  const boxes = block ? [PLATFORM, block] : [PLATFORM];
  const level = moverLevel(
    boxes,
    boxes.map((_, i) => ({ classname: 'func_door', model: `*${i + 1}`, targetname: `m${i}` }))
  );
  return { level, platform: level.find(null, 'targetname', 'm0')! };
}

/** A player standing at a point, as the move leaves one, on what they stand on. */
function player(level: Level, slot: number, origin: Vec3, ground: number): GameEntity {
  const entity = clientAt(level, slot, origin);
  entity.s.eType = ET.PLAYER;
  entity.s.pos.trBase = vec3(origin.x, origin.y, origin.z);
  entity.s.groundEntityNum = ground;
  return entity;
}

/** An item of a 30-unit box at a point, on what it lies on. */
function item(level: Level, origin: Vec3, ground: number): GameEntity {
  const entity = level.spawnEntity();
  entity.s.eType = ET.ITEM;
  entity.r.mins = vec3(-15, -15, -15);
  entity.r.maxs = vec3(15, 15, 15);
  entity.r.contents = CONTENTS.TRIGGER;
  setEntityOrigin(entity, origin);
  entity.s.groundEntityNum = ground;
  level.linkEntity(entity);
  return entity;
}

describe('G_MoverPush', () => {
  it('carries what rides it by its move, and links it there', () => {
    const { level, platform } = scene();
    const rider = player(level, 0, vec3(0, 0, 40.125), platform.s.number);
    const thing = item(level, vec3(32, 32, 31.125), platform.s.number);

    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(), [])).toBeNull();
    expect(platform.r.currentOrigin).toEqual(vec3(0, 0, 4));
    expect(rider.client!.ps.origin).toEqual(vec3(0, 0, 44.125));
    expect(rider.s.pos.trBase).toEqual(vec3(0, 0, 44.125));
    expect(rider.r.currentOrigin).toEqual(vec3(0, 0, 44.125));
    expect(thing.s.pos.trBase).toEqual(vec3(32, 32, 35.125));
    expect(thing.r.currentOrigin).toEqual(vec3(32, 32, 35.125));
    expect(thing.r.absmin.z).toBe(19.125);
    // Riders are still on it.
    expect(rider.s.groundEntityNum).toBe(platform.s.number);
  });

  it('pushes what it would end inside, and takes it off whatever it stood on', () => {
    const { level, platform } = scene();
    // Standing on the floor beside it, as it slides into them.
    const standing = player(level, 0, vec3(80, 0, 24.125), ENTITYNUM_WORLD);
    expect(moverPush(level, platform, vec3(4, 0, 0), vec3(), [])).toBeNull();
    expect(standing.client!.ps.origin).toEqual(vec3(84, 0, 24.125));
    expect(standing.s.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('passes what its new box only touches, however stuck that is', () => {
    const { level, platform } = scene();
    // Half in the floor, its box's near side where the platform's ends after the move.
    const buried = item(level, vec3(86, 32, 0), ENTITYNUM_WORLD);
    expect(testEntityPosition(level, buried)).toBe(level.gentities[ENTITYNUM_WORLD]);
    expect(moverPush(level, platform, vec3(4, 0, 0), vec3(), [])).toBeNull();
    expect(buried.s.pos.trBase).toEqual(vec3(86, 32, 0));
  });

  it("puts back everything it pushed when one can't go, but not where each was linked", () => {
    // A ceiling over the platform's south half, which a rider there is pushed into.
    const { level, platform } = scene([
      [-64, -64, 76],
      [64, 0, 92]
    ]);
    const trapped = player(level, 0, vec3(0, -32, 40.125), platform.s.number);
    const free = item(level, vec3(0, 32, 31.125), platform.s.number);
    const pushed: Parameters<typeof moverPush>[4] = [];

    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(), pushed)).toBe(trapped);
    expect(pushed.map(({ ent }) => ent)).toEqual([free, trapped]);
    expect(free.s.pos.trBase).toEqual(vec3(0, 32, 31.125));
    expect(free.r.currentOrigin).toEqual(vec3(0, 32, 35.125));
    expect(trapped.client!.ps.origin).toEqual(vec3(0, -32, 40.125));
    expect(trapped.s.pos.trBase).toEqual(vec3(0, -32, 40.125));
  });

  it('leaves a rider behind where it was, off the ground, if that is free', () => {
    // A wall the rider is pushed into as the platform slides under them.
    const { level, platform } = scene([
      [57, 0, 24],
      [67, 64, 80]
    ]);
    const rider = player(level, 0, vec3(40, 32, 40.125), platform.s.number);
    const pushed: Parameters<typeof moverPush>[4] = [];

    expect(moverPush(level, platform, vec3(4, 0, 0), vec3(), pushed)).toBeNull();
    expect(pushed).toEqual([]);
    expect(rider.client!.ps.origin).toEqual(vec3(40, 32, 40.125));
    expect(rider.s.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('kills what blocks a bobbing mover, and goes on', () => {
    const { level, platform } = scene([
      [-64, -64, 76],
      [64, 0, 92]
    ]);
    platform.s.pos.trType = TR.SINE;
    const trapped = player(level, 0, vec3(0, -32, 40.125), platform.s.number);

    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(), [])).toBeNull();
    expect(trapped.client!.ps.stats[STAT.HEALTH]).toBeLessThanOrEqual(0);
    expect(trapped.client!.lasthurtMod).toBe(MOD.CRUSH);
  });

  it('pushes items, players and anything that falls, and nothing else', () => {
    const { level, platform } = scene();
    const missile = item(level, vec3(0, 0, 31.125), platform.s.number);
    missile.s.eType = ET.MISSILE;
    const corpse = item(level, vec3(32, 0, 31.125), platform.s.number);
    corpse.s.eType = ET.GENERAL;
    corpse.physicsObject = true;

    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(), [])).toBeNull();
    expect(missile.s.pos.trBase.z).toBe(31.125);
    expect(corpse.s.pos.trBase.z).toBe(35.125);
  });
});

describe('G_MoverTeam and G_RunMover', () => {
  /** The platform rising 2 units a frame from 0, its clock at `from`, under a low ceiling. */
  function rising(from: number) {
    const { level, platform } = scene([
      [-64, -64, 73],
      [64, 0, 92]
    ]);
    platform.pos2 = vec3(0, 0, 50);
    platform.s.pos.trDuration = 200;
    setMoverState(level, platform, MOVER.ONE_TO_TWO, from);
    return { level, platform };
  }

  it("holds every part back a frame when blocked, and tells the master what did it", () => {
    const { level, platform } = rising(0);
    const trapped = player(level, 0, vec3(0, -32, 40.125), platform.s.number);
    const blocked: GameEntity[] = [];
    platform.blocked = (_self, other) => blocked.push(other);
    platform.reached = () => blocked.push(platform);

    level.previousTime = 0;
    level.time = 8;
    moverTeam(level, platform);
    expect(blocked).toEqual([trapped]);
    expect(platform.s.pos.trTime).toBe(8);
    expect(platform.r.currentOrigin).toEqual(vec3(0, 0, 0));
  });

  it('moves a part exactly where its trajectory is, and its rider as far', () => {
    const { level, platform } = rising(0);
    // On the north half, clear of the ceiling.
    const rider = player(level, 0, vec3(0, 32, 40.125), platform.s.number);
    level.previousTime = 0;
    level.time = 8;
    moverTeam(level, platform);
    expect(platform.r.currentOrigin).toEqual(vec3(0, 0, 2));
    expect(rider.client!.ps.origin).toEqual(vec3(0, 32, 42.125));
  });

  it("tells each part that has arrived, and runs the master's think after", () => {
    const { level, platform } = rising(-200);
    const order: string[] = [];
    platform.reached = () => order.push('reached');
    platform.think = () => order.push('think');
    platform.nextthink = 8;
    level.time = 8;
    runMover(level, platform);
    expect(order).toEqual(['reached', 'think']);
  });

  it("does nothing for a team's other members, and only thinks at rest", () => {
    const { level, platform } = scene();
    platform.flags |= FL.TEAMMEMBER;
    platform.think = () => {
      throw new Error('a member thought');
    };
    platform.nextthink = 8;
    level.time = 8;
    runMover(level, platform);

    platform.flags &= ~FL.TEAMMEMBER;
    let thought = false;
    platform.think = () => (thought = true);
    platform.reached = () => {
      throw new Error('a mover at rest arrived');
    };
    runMover(level, platform);
    expect(thought).toBe(true);
  });
});

describe('G_MoverPush, at its edges', () => {
  it('tests a client where its player state stands, not where its entity state was sent', () => {
    const { level, platform } = scene();
    const beside = player(level, 0, vec3(80, 0, 24.125), ENTITYNUM_WORLD);
    beside.s.pos.trBase = vec3(200, 0, 24);
    expect(moverPush(level, platform, vec3(4, 0, 0), vec3(), [])).toBeNull();
    expect(beside.client!.ps.origin).toEqual(vec3(84, 0, 24.125));
  });

  it("tests an item by the world's solid alone, so a player's body does not stop it", () => {
    const { level, platform } = scene();
    const thing = item(level, vec3(80, 0, 16), ENTITYNUM_WORLD);
    player(level, 0, vec3(100, 0, 24.125), ENTITYNUM_WORLD);
    expect(moverPush(level, platform, vec3(4, 0, 0), vec3(), [])).toBeNull();
    expect(thing.s.pos.trBase).toEqual(vec3(84, 0, 16));
  });

  it('pushes what lies only in the way of its move, forward or back', () => {
    const east = scene();
    const ahead = item(east.level, vec3(90, 0, 16), ENTITYNUM_WORLD);
    expect(moverPush(east.level, east.platform, vec3(40, 0, 0), vec3(), [])).toBeNull();
    expect(ahead.s.pos.trBase.x).toBe(130);

    const west = scene();
    const behind = item(west.level, vec3(-90, 0, 16), ENTITYNUM_WORLD);
    expect(moverPush(west.level, west.platform, vec3(-40, 0, 0), vec3(), [])).toBeNull();
    expect(behind.s.pos.trBase.x).toBe(-130);
  });

  it('puts back a client it carried, origin and view, when another stops it', () => {
    const { level, platform } = scene([
      [-64, -64, 76],
      [64, 0, 92]
    ]);
    const carried = player(level, 1, vec3(0, 32, 40.125), platform.s.number);
    const trapped = player(level, 0, vec3(0, -32, 40.125), platform.s.number);

    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(0, 1, 0), [])).toBe(trapped);
    expect(carried.client!.ps.origin).toEqual(vec3(0, 32, 40.125));
    expect(carried.client!.ps.deltaAngles.y).toBe(0);
    expect(trapped.client!.ps.deltaAngles.y).toBe(0);
  });

  it('puts back what one team move pushed twice where it was before the first', () => {
    // A ceiling the rider under it meets on the second push and not the first.
    const { level, platform } = scene([
      [-64, -64, 80],
      [64, 0, 96]
    ]);
    const twice = item(level, vec3(0, 32, 31.125), platform.s.number);
    const trapped = player(level, 0, vec3(0, -32, 40.125), platform.s.number);
    const pushed: Parameters<typeof moverPush>[4] = [];

    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(), pushed)).toBeNull();
    expect(twice.s.pos.trBase.z).toBe(35.125);
    expect(moverPush(level, platform, vec3(0, 0, 4), vec3(), pushed)).toBe(trapped);
    expect(twice.s.pos.trBase).toEqual(vec3(0, 32, 31.125));
    expect(trapped.client!.ps.origin).toEqual(vec3(0, -32, 40.125));
  });
});
