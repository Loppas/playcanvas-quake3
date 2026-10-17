import { describe, expect, it, vi } from 'vitest';

import {
  ENTITYNUM_MAX_NORMAL,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  MAX_CLIENTS
} from '../net/protocol';
import { BODY_QUEUE_SIZE } from './body-queue';
import { box, createBoxWorldTrace } from './box-world';
import { createGameClient } from './client';
import { triggerBsp } from './cm/collision-test-fixtures';
import { loadMap } from './cm/cm-load';
import { CONTENTS, MASK, TEAM } from './constants';
import { ET, type GameEntity } from './game-entity';
import { EVENT_VALID_MSEC, Level, Q3_FRAME_MSEC, type LevelHandlers } from './level';
import type { PointContentsFn } from './types';
import { vec3, type Vec3 } from './vec3';

/** A level with every handler recorded, so a frame's calls can be read back in order. */
function tracedLevel(options: { startTime?: number; maxclients?: number } = {}) {
  const calls: string[] = [];
  const handlers: LevelHandlers = {
    updateCvars: () => void calls.push('updateCvars'),
    runMissile: (e) => void calls.push(`missile:${e.s.number}`),
    runItem: (e) => void calls.push(`item:${e.s.number}`),
    runMover: (e) => void calls.push(`mover:${e.s.number}`),
    runClient: (e) => void calls.push(`client:${e.s.number}`),
    endClientFrame: (_entity, n) => void calls.push(`endFrame:${n}`),
    checkRules: () => void calls.push('checkRules'),
    unlinkEntity: (e) => void calls.push(`unlink:${e.s.number}`)
  };
  return { level: new Level({ ...options, handlers }), calls };
}

/** Put an entity in a client's slot, in use and of the given kind. */
function occupy(level: Level, index: number, eType = ET.PLAYER): GameEntity {
  const entity = level.gentities[index];
  entity.inuse = true;
  entity.s.eType = eType;
  return entity;
}

describe('the clock', () => {
  it('advances to whatever time it is handed, and counts the frame', () => {
    const level = new Level({ startTime: 1000 });
    expect(level.time).toBe(1000);

    level.runFrame(1008);
    expect(level.framenum).toBe(1);
    expect(level.previousTime).toBe(1000);
    expect(level.time).toBe(1008);

    level.runFrame(1016);
    expect(level.framenum).toBe(2);
    expect(level.previousTime).toBe(1008);
    expect(level.time).toBe(1016);
  });

  it('does not care about the cadence, so 8 ms and 50 ms steps are alike to it', () => {
    const fast = new Level();
    const slow = new Level();
    for (let t = 8; t <= 400; t += 8) fast.runFrame(t);
    for (let t = 50; t <= 400; t += 50) slow.runFrame(t);

    expect(fast.time).toBe(400);
    expect(slow.time).toBe(400);
    // The one thing that does differ, which is why nothing should time by it.
    expect(fast.framenum).toBe(50);
    expect(slow.framenum).toBe(8);
  });

  it('does nothing at all while a restart is pending', () => {
    const { level, calls } = tracedLevel();
    level.restarted = true;
    level.runFrame(100);

    expect(level.framenum).toBe(0);
    expect(level.time).toBe(0);
    expect(calls).toEqual([]);
  });

  it('keeps the clock even with no handlers at all', () => {
    const level = new Level();
    level.runFrame(8);
    expect(level.time).toBe(8);
  });

  it("knows which of Quake 3's 50 ms frames it is in, counted from the level's start", () => {
    const level = new Level({ startTime: 410 });
    expect(Q3_FRAME_MSEC).toBe(50);
    const frames: number[] = [];
    for (let t = 418; t <= 530; t += 8) {
      level.runFrame(t);
      frames.push(level.q3FrameTime());
    }
    // 418 to 458 are in the frame at 410, 466 to 506 in 460's, and from 514 in 510's.
    expect(frames).toEqual([...Array(6).fill(410), ...Array(6).fill(460), ...Array(3).fill(510)]);
  });
});

describe('the frame', () => {
  it('runs each entity by its kind', () => {
    const { level, calls } = tracedLevel({ maxclients: 1 });
    occupy(level, 0); // a client slot

    const missile = level.spawnEntity();
    missile.s.eType = ET.MISSILE;
    const item = level.spawnEntity();
    item.s.eType = ET.ITEM;
    const mover = level.spawnEntity();
    mover.s.eType = ET.MOVER;
    const thinker = level.spawnEntity();
    thinker.s.eType = ET.GENERAL;
    thinker.nextthink = 1;
    thinker.think = () => void calls.push(`think:${thinker.s.number}`);

    level.runFrame(8);

    expect(calls).toEqual([
      'updateCvars',
      'client:0',
      `missile:${missile.s.number}`,
      `item:${item.s.number}`,
      `mover:${mover.s.number}`,
      `think:${thinker.s.number}`,
      'endFrame:0',
      'checkRules'
    ]);
  });

  it('runs anything that falls and can be pushed as an item, whatever its kind', () => {
    const { level, calls } = tracedLevel({ maxclients: 0 });
    const crate = level.spawnEntity();
    crate.s.eType = ET.GENERAL;
    crate.physicsObject = true;

    level.runFrame(8);
    expect(calls).toContain(`item:${crate.s.number}`);
  });

  it('gives a missile to the missile runner even when it is a physics object too', () => {
    const { level, calls } = tracedLevel({ maxclients: 0 });
    const rocket = level.spawnEntity();
    rocket.s.eType = ET.MISSILE;
    rocket.physicsObject = true;

    level.runFrame(8);
    expect(calls).toContain(`missile:${rocket.s.number}`);
    expect(calls).not.toContain(`item:${rocket.s.number}`);
  });

  it('ends every occupied client slot after every entity has moved', () => {
    const { level, calls } = tracedLevel({ maxclients: 3 });
    occupy(level, 0);
    occupy(level, 2);

    level.runFrame(8);
    expect(calls.filter((call) => call.startsWith('endFrame'))).toEqual(['endFrame:0', 'endFrame:2']);
    expect(calls.indexOf('endFrame:0')).toBeGreaterThan(calls.indexOf('client:0'));
    expect(calls.indexOf('checkRules')).toBe(calls.length - 1);
  });

  it('says which slot is ending, rather than leaving the entity to say what it is numbered', () => {
    const { level, calls } = tracedLevel({ maxclients: 3 });
    occupy(level, 0);
    // The number on a client's entity is written by the entity state built out of its player
    // state, and a client that has connected without beginning has one full of zeroes — so the
    // entity in slot 2 can be sitting there numbered 0. Quake 3 has the slot in `ent->client`.
    occupy(level, 2).s.number = 0;

    level.runFrame(8);
    expect(calls.filter((call) => call.startsWith('endFrame'))).toEqual(['endFrame:0', 'endFrame:2']);
  });

  it('leaves alone an entity that is unlinked and may never be freed', () => {
    const { level, calls } = tracedLevel({ maxclients: 0 });
    const corpse = level.spawnEntity();
    corpse.s.eType = ET.GENERAL;
    corpse.neverFree = true;
    corpse.r.linked = false;
    corpse.nextthink = 1;
    corpse.think = () => void calls.push('thought');

    level.runFrame(8);
    expect(calls).not.toContain('thought');
  });
});

describe('an entity event', () => {
  it('survives until every client has had time to see it', () => {
    const level = new Level();
    const entity = level.spawnEntity();
    entity.s.event = 7;
    entity.eventTime = 0;

    level.runFrame(EVENT_VALID_MSEC);
    expect(entity.s.event).toBe(7);

    level.runFrame(EVENT_VALID_MSEC + 1);
    expect(entity.s.event).toBe(0);
  });

  it("takes the client's external event with it", () => {
    const level = new Level({ maxclients: 1 });
    const entity = occupy(level, 0);
    const client = createGameClient();
    entity.client = client;
    client.ps.externalEvent = 3;
    entity.s.event = 7;

    level.runFrame(EVENT_VALID_MSEC + 1);
    expect(entity.s.event).toBe(0);
    expect(client.ps.externalEvent).toBe(0);
  });

  it('frees an entity that was only there to carry it', () => {
    const { level, calls } = tracedLevel({ maxclients: 0 });
    const entity = level.spawnEntity();
    entity.s.eType = ET.GENERAL;
    entity.freeAfterEvent = true;
    entity.nextthink = 1;
    entity.think = () => void calls.push('thought');

    level.runFrame(EVENT_VALID_MSEC + 1);
    expect(entity.inuse).toBe(false);
    expect(entity.classname).toBe('freed');
    expect(calls).not.toContain('thought');
  });

  it('holds an entity waiting to be freed out of the frame until the event expires', () => {
    const { level, calls } = tracedLevel({ maxclients: 0 });
    const entity = level.spawnEntity();
    entity.s.eType = ET.GENERAL;
    entity.freeAfterEvent = true;
    entity.eventTime = 100;
    entity.nextthink = 1;
    entity.think = () => void calls.push('thought');

    level.runFrame(200);
    expect(entity.inuse).toBe(true);
    expect(calls).not.toContain('thought');
  });

  it('unlinks an entity that keeps its slot, and only once', () => {
    const { level, calls } = tracedLevel({ maxclients: 0 });
    const entity = level.spawnEntity();
    entity.s.eType = ET.GENERAL;
    entity.unlinkAfterEvent = true;

    level.runFrame(EVENT_VALID_MSEC + 1);
    expect(entity.inuse).toBe(true);
    expect(entity.unlinkAfterEvent).toBe(false);
    expect(calls.filter((call) => call.startsWith('unlink'))).toHaveLength(1);

    level.runFrame(EVENT_VALID_MSEC + 9);
    expect(calls.filter((call) => call.startsWith('unlink'))).toHaveLength(1);
  });

  it('unlinks it from its own world when it has no host', () => {
    const level = new Level();
    const entity = level.spawnEntity();
    entity.s.eType = ET.GENERAL;
    level.linkEntity(entity);
    entity.unlinkAfterEvent = true;

    level.runFrame(EVENT_VALID_MSEC + 1);
    expect(entity.r.linked).toBe(false);
    expect(level.entitiesInBox(vec3(-1, -1, -1), vec3(1, 1, 1))).toEqual([]);
  });
});

describe('a think', () => {
  it('fires once when its time comes, and not again unless it asks', () => {
    const level = new Level();
    const think = vi.fn();
    const entity = level.spawnEntity();
    entity.nextthink = 100;
    entity.think = think;

    level.runFrame(50);
    expect(think).not.toHaveBeenCalled();

    level.runFrame(100);
    expect(think).toHaveBeenCalledTimes(1);
    expect(entity.nextthink).toBe(0);

    level.runFrame(150);
    expect(think).toHaveBeenCalledTimes(1);
  });

  it('never fires at a think time of zero', () => {
    const level = new Level();
    const think = vi.fn();
    const entity = level.spawnEntity();
    entity.nextthink = 0;
    entity.think = think;

    level.runFrame(1000);
    expect(think).not.toHaveBeenCalled();
  });

  it('refuses an entity whose time has come with nothing to do', () => {
    const level = new Level();
    const entity = level.spawnEntity();
    entity.nextthink = 1;

    expect(() => level.runFrame(8)).toThrow(/no think/);
  });
});

describe('the entity pool', () => {
  /**
   * The first slot a map's own spawning can have: the client slots are reserved, and `G_InitGame`
   * takes the eight corpses before anything else.
   */
  const FIRST_FREE = MAX_CLIENTS + BODY_QUEUE_SIZE;

  it('starts with the client slots reserved and the corpses behind them', () => {
    const level = new Level();
    expect(level.numEntities).toBe(FIRST_FREE);
    expect(level.gentities[5].inuse).toBe(false);
  });

  it('never hands out a slot a client could want', () => {
    const level = new Level();
    const entity = level.spawnEntity();

    expect(entity.s.number).toBeGreaterThanOrEqual(FIRST_FREE);
    expect(entity.inuse).toBe(true);
    expect(entity.classname).toBe('noclass');
    expect(entity.r.ownerNum).toBe(ENTITYNUM_NONE);
    expect(level.numEntities).toBe(FIRST_FREE + 1);
  });

  it('numbers each slot by where it sits', () => {
    const level = new Level();
    for (let i = 0; i < 5; i++) expect(level.spawnEntity().s.number).toBe(FIRST_FREE + i);
  });

  it('clears a freed slot but leaves it knowing which slot it is', () => {
    const level = new Level({ startTime: 0 });
    const entity = level.spawnEntity();
    const { number } = entity.s;
    entity.s.eType = ET.MISSILE;
    entity.physicsObject = true;
    entity.client = createGameClient();

    level.runFrame(500);
    level.freeEntity(entity);

    expect(entity.inuse).toBe(false);
    expect(entity.classname).toBe('freed');
    expect(entity.freetime).toBe(500);
    expect(entity.s.eType).toBe(0);
    expect(entity.physicsObject).toBe(false);
    expect(entity.client).toBeNull();
    expect(entity.s.number).toBe(number);
  });

  it("clears a trigger's and a target's fields with the rest, keeping its movedir's vector", () => {
    const level = new Level({ startTime: 0 });
    const entity = level.spawnEntity();
    const { movedir } = entity;
    Object.assign(entity, {
      model: '*1',
      model2: 'models/a.md3',
      message: 'hello',
      targetShaderName: 'a',
      targetShaderNewName: 'b',
      noiseIndex: 3,
      flySoundDebounceTime: 1500,
      activator: entity,
      nextTrain: entity
    });
    movedir.z = 1;

    level.freeEntity(entity);

    expect([entity.model, entity.model2, entity.message]).toEqual([null, null, null]);
    expect([entity.targetShaderName, entity.targetShaderNewName]).toEqual([null, null]);
    expect([entity.noiseIndex, entity.flySoundDebounceTime]).toEqual([0, 0]);
    expect([entity.activator, entity.nextTrain]).toEqual([null, null]);
    expect(entity.movedir).toBe(movedir);
    expect(movedir).toEqual(vec3());
  });

  it('only unlinks an entity that may never be freed', () => {
    const { level, calls } = tracedLevel();
    const corpse = level.spawnEntity();
    corpse.neverFree = true;
    corpse.classname = 'bodyque';

    level.freeEntity(corpse);
    expect(corpse.inuse).toBe(true);
    expect(corpse.classname).toBe('bodyque');
    expect(calls).toContain(`unlink:${corpse.s.number}`);
  });

  it('passes over a slot freed within the last second, once the level has settled', () => {
    const level = new Level({ startTime: 0 });
    const first = level.spawnEntity();
    level.runFrame(5000);
    level.freeEntity(first);

    const second = level.spawnEntity();
    expect(second.s.number).not.toBe(first.s.number);
    expect(level.numEntities).toBe(FIRST_FREE + 2);
  });

  it('takes it back once a second has passed', () => {
    const level = new Level({ startTime: 0 });
    const first = level.spawnEntity();
    level.runFrame(5000);
    level.freeEntity(first);
    level.runFrame(6000);

    expect(level.spawnEntity().s.number).toBe(first.s.number);
  });

  it('gives a slot its number back when it is taken again', () => {
    const level = new Level({ startTime: 0 });
    const entity = level.spawnEntity();
    const { number } = entity.s;
    // `BG_PlayerStateToEntityState` writes a player state's `clientNum` over the number wherever
    // it is used, which is Quake 3's own doing and the reason `G_InitGentity` sets it at all.
    entity.s.number = 0;
    level.runFrame(5000);
    level.freeEntity(entity);
    level.runFrame(6000);

    expect(level.spawnEntity().s.number).toBe(number);
  });

  it("reuses at once during the level's first two seconds, when spawning churns", () => {
    const level = new Level({ startTime: 0 });
    const first = level.spawnEntity();
    level.runFrame(1000);
    level.freeEntity(first);

    expect(level.spawnEntity().s.number).toBe(first.s.number);
  });

  it('takes a recently freed slot anyway when there is nowhere left to grow', () => {
    const level = new Level({ startTime: 0 });
    level.runFrame(5000);
    while (level.numEntities < ENTITYNUM_MAX_NORMAL) level.spawnEntity();

    const victim = level.gentities[500];
    level.freeEntity(victim);
    expect(victim.freetime).toBe(5000);

    // The first pass refuses it for being a second old; the second pass has no choice.
    expect(level.spawnEntity().s.number).toBe(victim.s.number);
  });

  it('refuses when the world is genuinely full', () => {
    const level = new Level();
    while (level.numEntities < ENTITYNUM_MAX_NORMAL) level.spawnEntity();

    expect(() => level.spawnEntity()).toThrow(/no free entities/);
  });
});

describe('the match state', () => {
  it('starts with a score per team and a slot per client', () => {
    const level = new Level({ maxclients: 8 });
    expect(level.teamScores).toHaveLength(TEAM.NUM_TEAMS);
    expect(level.sortedClients).toHaveLength(MAX_CLIENTS);
    expect(level.maxclients).toBe(8);
    expect(level.intermissiontime).toBe(0);
    expect(level.warmupTime).toBe(0);
  });
});

describe('trap_EntitiesInBox', () => {
  /** A level that links what it is told to, with a unit box at `x` linked in it. */
  function withBox(x: number): { level: Level; entity: GameEntity } {
    const level = new Level();
    const entity = level.spawnEntity();
    entity.r.mins = vec3(-1, -1, -1);
    entity.r.maxs = vec3(1, 1, 1);
    entity.r.currentOrigin = vec3(x, 0, 0);
    level.linkEntity(entity);
    return { level, entity };
  }

  it('asks the server when it has one', () => {
    const asked: [Vec3, Vec3][] = [];
    const level = new Level({
      handlers: {
        entitiesInBox: (mins, maxs) => {
          asked.push([mins, maxs]);
          return [7];
        }
      }
    });
    expect(level.entitiesInBox(vec3(-1, -1, -1), vec3(1, 1, 1))).toEqual([7]);
    expect(asked).toEqual([[vec3(-1, -1, -1), vec3(1, 1, 1)]]);
  });

  it('looks through its own linked entities without one, by the box linking gave them', () => {
    const { level, entity } = withBox(100);
    // Linked a unit bigger each way: its box reaches from 98 to 102.
    expect(level.entitiesInBox(vec3(102, -1, -1), vec3(110, 1, 1))).toEqual([entity.s.number]);
    expect(level.entitiesInBox(vec3(102.5, -1, -1), vec3(110, 1, 1))).toEqual([]);

    level.unlinkEntity(entity);
    expect(level.entitiesInBox(vec3(90, -10, -10), vec3(110, 10, 10))).toEqual([]);
  });
});

describe('trap_Trace and trap_PointContents', () => {
  /** The map: a wall whose near face is at x = 200. */
  const WALL = createBoxWorldTrace([box(200, -512, -512, 216, 512, 512)]);
  /** The map: water below z = 0. */
  const POOL: PointContentsFn = (point) => (point.z < 0 ? CONTENTS.WATER : 0);
  const POINT = vec3();

  /** A standing player's box at `x` on the x axis, linked. */
  function body(level: Level, x: number): GameEntity {
    const entity = level.spawnEntity();
    entity.r.mins = vec3(-15, -15, -24);
    entity.r.maxs = vec3(15, 15, 32);
    entity.r.currentOrigin = vec3(x, 0, 0);
    entity.r.contents = CONTENTS.BODY;
    level.linkEntity(entity);
    return entity;
  }

  const shot = (level: Level) =>
    level.trace(vec3(), POINT, POINT, vec3(300, 0, 0), ENTITYNUM_NONE, MASK.SHOT);

  it('meet what a level with no host links, after the map, as the server does', () => {
    const level = new Level({ handlers: { trace: WALL, pointContents: POOL } });
    const player = body(level, 100);

    expect(shot(level)).toMatchObject({ entityNum: player.s.number, endpos: vec3(84.875, 0, 0) });
    expect(level.pointContents(vec3(100, 0, -10), ENTITYNUM_NONE)).toBe(
      CONTENTS.WATER | CONTENTS.BODY
    );
    expect(level.pointContents(vec3(100, 0, -10), player.s.number)).toBe(CONTENTS.WATER);

    level.unlinkEntity(player);
    expect(shot(level).entityNum).toBe(ENTITYNUM_WORLD);
    expect(level.pointContents(vec3(100, 0, -10), ENTITYNUM_NONE)).toBe(CONTENTS.WATER);
  });

  it("are the host's alone on a level the host links for", () => {
    const linked: number[] = [];
    const level = new Level({
      handlers: {
        linkEntity: (e) => void linked.push(e.s.number),
        trace: WALL,
        pointContents: POOL
      }
    });
    const player = body(level, 100);

    expect(linked).toEqual([player.s.number]);
    expect(shot(level).entityNum).toBe(ENTITYNUM_WORLD);
    expect(level.pointContents(vec3(100, 0, -10), ENTITYNUM_NONE)).toBe(CONTENTS.WATER);
  });

  it('cannot trace a level with no collision, and find nothing in it', () => {
    const level = new Level();
    expect(() => shot(level)).toThrow('level: no trace handler');
    body(level, 100);
    expect(level.pointContents(vec3(200, 0, -10), ENTITYNUM_NONE)).toBe(0);
  });
});

describe('a brush model, with no host', () => {
  /** A level over the trigger map, whose inline model 1 is a brush with a corner cut off. */
  function brushLevel(handlers: LevelHandlers = {}) {
    const level = new Level({ handlers, clipMap: loadMap(triggerBsp(), 'maps/test.bsp') });
    return { level, entity: level.spawnEntity() };
  }

  it('is set from the clip map the level was given, and linked through its links', () => {
    const { level, entity } = brushLevel();
    level.setBrushModel(entity, '*1');
    expect(entity.s.modelindex).toBe(1);
    expect(entity.r.bmodel).toBe(true);
    expect(entity.r.contents).toBe(-1);
    expect(entity.r.linked).toBe(true);
  });

  it('is touched by its brush, where its bounds would reach further', () => {
    const { level, entity } = brushLevel();
    level.setBrushModel(entity, '*1');
    entity.r.contents = CONTENTS.TRIGGER;
    expect(level.entityContact(vec3(35, 35, -4), vec3(65, 65, 52), entity)).toBe(true);
    expect(level.entityContact(vec3(60, 60, -4), vec3(90, 90, 52), entity)).toBe(false);
  });

  it('holds its brushes at a point, not its bounds', () => {
    const { level, entity } = brushLevel();
    level.setBrushModel(entity, '*1');
    entity.r.contents = CONTENTS.TRIGGER;
    expect(level.pointContents(vec3(32, 32, 8), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
    // In its bounds, in the corner its brush has cut off.
    expect(level.pointContents(vec3(62, 62, 8), ENTITYNUM_NONE)).toBe(0);
  });

  it('is no model at all on a level given no clip map', () => {
    const level = new Level();
    expect(() => level.setBrushModel(level.spawnEntity(), '*1')).toThrow(
      'CM_InlineModel: bad number'
    );
  });

  it("is the handlers' to answer when the level has them", () => {
    const asked: string[] = [];
    const { level, entity } = brushLevel({
      setBrushModel: (_entity, name) => void asked.push(`set ${name}`),
      entityContact: () => {
        asked.push('contact');
        return true;
      }
    });
    level.setBrushModel(entity, '*9');
    expect(level.entityContact(vec3(), vec3(), entity)).toBe(true);
    expect(asked).toEqual(['set *9', 'contact']);
    expect(entity.r.bmodel).toBe(false);
  });
});
