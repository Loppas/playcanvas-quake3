import { describe, expect, it } from 'vitest';

import { ENTITYNUM_WORLD } from '../net/protocol';
import { box, createFlatWorldTrace, type Box } from './box-world';
import { CONTENTS, EF_CONNECTION, MASK, SURFACE_CLIP_EPSILON } from './constants';
import { playerStateToEntityState, type GameEntity } from './game-entity';
import { PW } from './items';
import { Level } from './level';
import { spawnClient } from './life-test-fixtures';
import { SMOOTH_MSEC, smoothClient } from './smooth-clients';
import { distinctAsks, recordingTrace } from './trace-test-fixtures';
import { clearTrace, type TraceFn } from './types';
import { dot, length, madd, sub, vec3, type Vec3 } from './vec3';

/**
 * Unlagged's smoothing at a client's frame end: a player whose last command is a frame or two
 * behind is slid on by the velocity their entity carries, and one further behind stands still under
 * the connection-trouble sprite.
 */

/** The level's clock at the last frame, so no time here is a zero. */
const LAST_FRAME = 1000;

/** `g_gravity`'s own. */
const GRAVITY = 800;

/**
 * A player at `origin` in a world of a floor at z = 0 and `solids`, with the frame's end come round
 * and their entity state built: moving by `velocity`, their last command `late` ms before the last
 * frame.
 */
function player(
  options: { origin?: Vec3; velocity?: Vec3; late?: number; solids?: Box[]; trace?: TraceFn } = {}
) {
  const trace = options.trace ?? createFlatWorldTrace(options.solids);
  const level = new Level({ handlers: { trace }, startTime: LAST_FRAME });
  const { entity } = spawnClient({ level, origin: options.origin ?? vec3(0, 0, 24) });
  const client = entity.client!;
  // The spawn's knockback has run out, or the slide would hand back the velocity it began with.
  client.ps.pmTime = 0;
  level.time = LAST_FRAME + 50;
  client.lastUpdateTime = LAST_FRAME - (options.late ?? 0);
  if (options.velocity) client.ps.velocity = options.velocity;
  playerStateToEntityState(client.ps, entity.s, true);
  return { level, entity, client };
}

/** The frame's end, with `g_smoothClients` on and `g_gravity` its own, unless they are given. */
function endFrame(
  { level, entity }: { level: Level; entity: GameEntity },
  options: { enabled?: boolean; gravity?: number } = {}
): void {
  smoothClient(level, entity, options.enabled ?? true, options.gravity ?? GRAVITY);
}

/** On the player state and on the entity, in that order. */
const sprite = (entity: GameEntity) => [
  entity.client!.ps.eFlags & EF_CONNECTION,
  entity.s.eFlags & EF_CONNECTION
];

/** Ground rising 3 in 4 toward +x, which a player can stand on. */
const WALKABLE = vec3(-0.6, 0, 0.8);

/** Ground falling 4 in 3 toward +x, too steep to stand on. */
const STEEP = vec3(0.8, 0, 0.6);

/**
 * A world that is one plane facing `normal`, solid beneath, which the player's box rests on at
 * the spot it rests on the flat floor. As in the box world, resting on it is clear, and a sweep
 * into it stops short by Quake 3's epsilon.
 */
function slope(normal: Vec3): TraceFn {
  const rest = vec3(0, 0, 24);
  return (start, _mins, _maxs, end) => {
    // The plane grown by the box runs through `rest`, so this is how far clear the box is.
    const clearance = (point: Vec3) => dot(normal, sub(point, rest));
    const from = clearance(start);
    const to = clearance(end);
    if (from < 0) {
      return { ...clearTrace(start), startsolid: true, allsolid: to < 0, fraction: 0 };
    }
    if (to >= 0) return clearTrace(end);
    const delta = sub(end, start);
    const fraction = Math.max(0, from / (from - to) - SURFACE_CLIP_EPSILON / length(delta));
    return {
      allsolid: false,
      startsolid: false,
      fraction,
      endpos: madd(start, fraction, delta),
      normal,
      contents: CONTENTS.SOLID,
      surfaceFlags: 0,
      entityNum: ENTITYNUM_WORLD
    };
  };
}

describe('a player whose last command came since the last frame', () => {
  it('is left where the snapshot has them, with no sprite', () => {
    const world = player({ velocity: vec3(320, 0, 0) });
    endFrame(world);
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));
    expect(sprite(world.entity)).toEqual([0, 0]);
  });

  it('is never late as a bot, whose command runs inside the frame', () => {
    const world = player({ velocity: vec3(320, 0, 0) });
    world.client.lastUpdateTime = world.level.time;
    endFrame(world);
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));
  });
});

describe('a player whose last command is late', () => {
  it('is slid on by their velocity for the time since, and nothing else moves', () => {
    const world = player({ velocity: vec3(320, 0, 0), late: 50 });
    endFrame(world);
    expect(world.entity.s.pos.trBase).toEqual(vec3(16, 0, 24));
    expect(world.entity.s.pos.trDelta).toEqual(vec3(320, 0, 0));
    expect(world.client.ps.origin).toEqual(vec3(0, 0, 24));
    expect(world.entity.r.currentOrigin).toEqual(vec3(0, 0, 24));
    expect(sprite(world.entity)).toEqual([0, 0]);
  });

  it("is slid on from the snapshot's whole units, not the player state's fraction", () => {
    const world = player({ origin: vec3(0.75, 0, 24), velocity: vec3(-320, 0, 0), late: 50 });
    endFrame(world);
    // From the player state's 0.75 the slide would end at -15.25, which truncates to -15.
    expect(world.entity.s.pos.trBase).toEqual(vec3(-16, 0, 24));
  });

  it(`is slid up to ${SMOOTH_MSEC} ms late, and past that stands still under the sprite`, () => {
    // At \`sv_fps\` 125's 8 ms frames, 96 is the last time slid and 104 the first not.
    const slid = player({ velocity: vec3(320, 0, 0), late: 96 });
    endFrame(slid);
    expect(slid.entity.s.pos.trBase.x).toBe(Math.trunc(320 * 0.096));
    expect(sprite(slid.entity)).toEqual([0, 0]);

    const stood = player({ velocity: vec3(320, 0, 0), late: 104 });
    endFrame(stood);
    expect(stood.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));
    expect(sprite(stood.entity)).toEqual([EF_CONNECTION, EF_CONNECTION]);
  });

  it('keeps the sprite on the entity a frame after the player state drops it', () => {
    const world = player({ late: 150 });
    endFrame(world);
    world.client.lastUpdateTime = LAST_FRAME;
    playerStateToEntityState(world.client.ps, world.entity.s, true);
    endFrame(world);
    expect(sprite(world.entity)).toEqual([0, EF_CONNECTION]);

    playerStateToEntityState(world.client.ps, world.entity.s, true);
    endFrame(world);
    expect(sprite(world.entity)).toEqual([0, 0]);
  });

  it('is not slid with g_smoothClients 0, though the sprite still goes up past the limit', () => {
    const slid = player({ velocity: vec3(320, 0, 0), late: 50 });
    endFrame(slid, { enabled: false });
    expect(slid.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));

    const stood = player({ late: 150 });
    endFrame(stood, { enabled: false });
    expect(sprite(stood.entity)).toEqual([EF_CONNECTION, EF_CONNECTION]);
  });

  it('is left as they are standing still, velocity and all', () => {
    const world = player({ late: 50 });
    endFrame(world);
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));
    expect(world.entity.s.pos.trDelta).toEqual(vec3(0, 0, 0));
  });

  it("falls in the air by g_gravity, not by the player state's, at half a step's speed", () => {
    const world = player({ origin: vec3(0, 0, 200), late: 50 });
    world.client.ps.gravity = 400;
    endFrame(world, { gravity: 1000 });
    // 1000 for 50 ms is 50 down by the end, and 25 on average: 1.25 units.
    expect(world.entity.s.pos.trDelta).toEqual(vec3(0, 0, -50));
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, Math.trunc(200 - 1.25)));
  });

  it('flies under flight with no gravity at all', () => {
    const world = player({ origin: vec3(0, 0, 200), velocity: vec3(0, 0, 100), late: 50 });
    world.client.ps.powerups[PW.FLIGHT] = LAST_FRAME + 10_000;
    endFrame(world);
    expect(world.entity.s.pos.trDelta).toEqual(vec3(0, 0, 100));
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, 205));
  });

  it('stops at a wall, and slides along it', () => {
    // A wall at x = 30 the box reaches at x = 15, met at 45 degrees.
    const world = player({
      velocity: vec3(320, 320, 0),
      late: 100,
      solids: [box(30, -500, 0, 40, 500, 200)]
    });
    endFrame(world);
    const { trBase, trDelta } = world.entity.s.pos;
    expect(trBase.x).toBe(14);
    expect(trBase.y).toBe(32);
    expect(Math.abs(trDelta.x)).toBe(0);
    expect(trDelta.y).toBe(320);
  });

  it('steps up a stair, raising no event', () => {
    const world = player({
      velocity: vec3(320, 0, 0),
      late: 100,
      solids: [box(20, -500, 0, 500, 500, 8)]
    });
    const events = world.client.ps.eventSequence;
    endFrame(world);
    expect(world.entity.s.pos.trBase).toEqual(vec3(32, 0, 32));
    expect(world.client.ps.eventSequence).toBe(events);
  });

  it('gives back the velocity it started with while the pain timer runs', () => {
    // Excessive Plus tests its own frozen bodies' knockback timer for everyone.
    const wall = [box(30, -500, 0, 40, 500, 200)];
    const hurt = player({ velocity: vec3(320, 0, 0), late: 100, solids: wall });
    hurt.entity.painDebounceTime = hurt.level.time + 1;
    endFrame(hurt);
    expect(hurt.entity.s.pos.trBase.x).toBe(14);
    expect(hurt.entity.s.pos.trDelta).toEqual(vec3(320, 0, 0));

    const timed = player({ velocity: vec3(320, 0, 0), late: 100, solids: wall });
    timed.client.ps.pmTime = 100;
    endFrame(timed);
    expect(timed.entity.s.pos.trDelta).toEqual(vec3(320, 0, 0));
  });

  it('stops giving it back on the ms the pain timer runs out', () => {
    const world = player({
      velocity: vec3(320, 0, 0),
      late: 100,
      solids: [box(30, -500, 0, 40, 500, 200)]
    });
    world.entity.painDebounceTime = world.level.time;
    endFrame(world);
    expect(Math.abs(world.entity.s.pos.trDelta.x)).toBe(0);
  });

  it("traces with the entity's box, number and clipmask", () => {
    const traced = recordingTrace(createFlatWorldTrace());
    const world = player({ velocity: vec3(320, 0, 0), late: 50, trace: traced.trace });
    traced.asked.length = 0;
    endFrame(world);
    expect(distinctAsks(traced.asked)).toEqual([
      { passEntityNum: world.entity.s.number, contentmask: MASK.PLAYERSOLID }
    ]);
  });
});

describe('the ground under a late player', () => {
  it('walks them up a slope they can stand on along it, stepping nothing', () => {
    const world = player({ velocity: vec3(320, 0, 0), late: 50, trace: slope(WALKABLE) });
    endFrame(world);
    // Clipped to the slope, 320 across is 205 across and 154 up: 10 and 7.7 units in 50 ms.
    expect(world.entity.s.pos.trDelta).toEqual(vec3(205, 0, 154));
    expect(world.entity.s.pos.trBase).toEqual(vec3(10, 0, 31));
  });

  it('stands them on a slope they can stand on, and slides them down one too steep', () => {
    const stood = player({ late: 50, trace: slope(WALKABLE) });
    endFrame(stood);
    expect(stood.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));
    expect(stood.entity.s.pos.trDelta).toEqual(vec3(0, 0, 0));

    const slid = player({ late: 50, trace: slope(STEEP) });
    endFrame(slid);
    // The fall is clipped to the slope as it goes, but the velocity handed back is the fall's own.
    expect(slid.entity.s.pos.trBase).toEqual(vec3(0, 0, 23));
    expect(slid.entity.s.pos.trDelta).toEqual(vec3(0, 0, -40));
  });

  it('lets them leave it under a jump, rising against g_gravity', () => {
    const world = player({ velocity: vec3(0, 0, 270), late: 50 });
    endFrame(world);
    // 800 for 50 ms takes 270 to 230 by the end, and 250 on average: 12.5 units up.
    expect(world.entity.s.pos.trDelta).toEqual(vec3(0, 0, 230));
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, 36));
  });

  it('finds none under one buried in solid with no clear spot a unit away', () => {
    const world = player({
      velocity: vec3(0, 0, -100),
      late: 50,
      solids: [box(-100, -100, -100, 100, 100, 200)]
    });
    endFrame(world);
    // A fall with no ground is stopped by the solid it is in, where ground would have clipped it.
    expect(world.entity.s.pos.trBase).toEqual(vec3(0, 0, 24));
    expect(world.entity.s.pos.trDelta).toEqual(vec3(0, 0, 0));
  });
});
