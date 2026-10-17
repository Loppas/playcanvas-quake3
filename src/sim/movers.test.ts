import { describe, expect, it } from 'vitest';

import type { SpawnVar } from '../formats/entity-text';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, TR, type Trajectory } from '../net/protocol';
import { loadMap } from './cm/cm-load';
import { areasConnected } from './cm/cm-test';
import { Digest, Seeded, stripsBsp } from './cm/collision-test-fixtures';
import { f, type Vec3f } from './cm/q-math';
import { damage } from './combat';
import { CONTENTS, FL, MOD, STAT, TEAM } from './constants';
import { SOLID_BMODEL } from './entity-solid';
import { EV, eventNumber } from './events';
import { ET, MOVER, SVF, createGameEntity, setEntityOrigin, type GameEntity } from './game-entity';
import { findItem } from './items';
import { Level, Q3_FRAME_MSEC } from './level';
import type { TestEntity } from './map-test-fixtures';
import { moverPush } from './mover-push';
import { moverLevel, moverLevelOn, newMoverRecord } from './mover-test-fixtures';
import {
  BUTTON_SOUND,
  blockedDoor,
  DOOR_CRUSHER,
  DOOR_END_SOUND,
  DOOR_START_OPEN,
  DOOR_START_SOUND,
  PLAT_END_SOUND,
  PLAT_START_SOUND,
  initMover,
  setMoverState,
  spawnFuncButton,
  spawnFuncDoor,
  spawnFuncPlat,
  thinkSpawnNewDoorTrigger
} from './movers';
import { thinkTimeAfterMsec } from './think-time';
import { qvmEvaluateTrajectory } from './trajectory';
import { clientAt, runUntil, useRecorder } from './trigger-test-fixtures';
import { touchTriggers } from './triggers';
import { createIdlePlayerState, clearTrace } from './types';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * A level with no collision whose brush models are whatever box {@link BoxLevel.bounds} holds, as
 * `SV_SetBrushModel` gives an inline model's bounds, linked into the level's own world.
 */
interface BoxLevel {
  level: Level;
  bounds: { mins: Vec3; maxs: Vec3 };
}

function boxLevel(): BoxLevel {
  const bounds = { mins: vec3(), maxs: vec3() };
  const level: Level = new Level({
    handlers: {
      trace: (_start, _mins, _maxs, end) => clearTrace(end),
      setBrushModel: (entity) => {
        entity.r.mins = copy(bounds.mins);
        entity.r.maxs = copy(bounds.maxs);
        entity.r.bmodel = true;
        entity.r.contents = -1;
        level.linkEntity(entity);
      }
    }
  });
  return { level, bounds };
}

/**
 * The twin's `corpus` mode: seeded doors, buttons, plats, door triggers, trajectories, pushes,
 * waits and lights, each kind digested as the twin digests it, every input made in floats as the
 * twin's C makes it.
 */
function corpus(seed: number, count: number): Record<string, string> {
  const random = new Seeded(seed);
  const pick = (n: number) => (random.next() >>> 8) % n;
  const uniformIn = (lo: number, hi: number) => {
    const t = ((random.next() >>> 8) % 65536) / 65536;
    return f(lo + f(f(hi - lo) * t));
  };
  const randomVec = (lo: number, hi: number) => {
    const x = uniformIn(lo, hi);
    const y = uniformIn(lo, hi);
    const z = uniformIn(lo, hi);
    return vec3(x, y, z);
  };
  /** A brush model's bounds as the server has them: a box, spread by a unit each way. */
  const randomBounds = (into: BoxLevel['bounds'], widest: number) => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const lo = uniformIn(-512, 512);
      into.mins[axis] = f(lo - 1);
      into.maxs[axis] = f(f(lo + uniformIn(1, widest)) + 1);
    }
  };
  /** A map's angles for a mover: up, down, a whole yaw, or any three. */
  const randomAngles = () => {
    const kind = pick(4);
    if (kind === 0) return vec3(0, -1, 0);
    if (kind === 1) return vec3(0, -2, 0);
    if (kind === 2) return vec3(0, pick(361), 0);
    const x = uniformIn(-90, 90);
    const y = uniformIn(-360, 360);
    const z = uniformIn(-180, 180);
    return vec3(x, y, z);
  };
  /** Unset, and so the class's default, a quarter of the time. */
  const randomOrUnset = (lo: number, hi: number) => (pick(4) === 0 ? 0 : uniformIn(lo, hi));

  const { level, bounds } = boxLevel();
  const vecInto = (digest: Digest, v: Vec3) => digest.float(v.x).float(v.y).float(v.z);
  const moverInto = (digest: Digest, ent: GameEntity) => {
    vecInto(digest, ent.pos1);
    vecInto(digest, ent.pos2);
    digest.float(ent.speed).float(ent.wait);
    vecInto(digest, ent.s.pos.trDelta);
    digest.int(ent.s.pos.trDuration);
    level.time = 1100;
    setMoverState(level, ent, MOVER.ONE_TO_TWO, 1000);
    vecInto(digest, ent.s.pos.trDelta);
    vecInto(digest, ent.r.currentOrigin);
    setMoverState(level, ent, MOVER.TWO_TO_ONE, 1000);
    vecInto(digest, ent.s.pos.trDelta);
    vecInto(digest, ent.r.currentOrigin);
    level.time = 0;
  };
  const placed = (origin: Vec3, angles: Vec3, speed: number, wait: number) => {
    const ent = level.spawnEntity();
    ent.model = '*1';
    ent.s.origin = origin;
    ent.s.angles = angles;
    ent.speed = speed;
    ent.wait = wait;
    return ent;
  };

  const doors = new Digest();
  for (let n = 0; n < count; n++) {
    const origin = randomVec(-4096, 4096);
    const angles = randomAngles();
    randomBounds(bounds, 512);
    const lip = pick(2) ? 8 : uniformIn(0, 64);
    const speed = randomOrUnset(1, 1000);
    const wait = randomOrUnset(0, 10);
    const ent = placed(origin, angles, speed, wait);
    ent.spawnflags = pick(2);
    spawnFuncDoor(level, ent, [['lip', String(lip)]]);
    moverInto(doors, ent);
    level.freeEntity(ent);
  }

  const buttons = new Digest();
  for (let n = 0; n < count; n++) {
    const origin = randomVec(-4096, 4096);
    const angles = randomAngles();
    randomBounds(bounds, 64);
    const lip = pick(2) ? 4 : uniformIn(0, 16);
    const speed = randomOrUnset(1, 200);
    const wait = randomOrUnset(0, 10);
    const ent = placed(origin, angles, speed, wait);
    spawnFuncButton(level, ent, [['lip', String(lip)]]);
    moverInto(buttons, ent);
    level.freeEntity(ent);
  }

  const plats = new Digest();
  for (let n = 0; n < count; n++) {
    const origin = randomVec(-4096, 4096);
    randomBounds(bounds, 256);
    const lip = pick(2) ? 8 : uniformIn(0, 64);
    const vars: SpawnVar[] = [['lip', String(lip)]];
    if (pick(2)) vars.push(['height', String(uniformIn(0, 512))]);
    if (pick(4) !== 0) vars.push(['speed', String(uniformIn(1, 1000))]);
    const ent = placed(origin, vec3(), 0, 0);
    spawnFuncPlat(level, ent, vars);
    const trigger = level.find(null, 'classname', 'plat_trigger')!;
    moverInto(plats, ent);
    vecInto(plats, trigger.r.mins);
    vecInto(plats, trigger.r.maxs);
    level.freeEntity(trigger);
    level.freeEntity(ent);
  }

  const triggers = new Digest();
  for (let n = 0; n < count; n++) {
    const parts = Array.from({ length: 1 + pick(3) }, () => level.spawnEntity());
    for (const [i, part] of parts.entries()) {
      for (const axis of ['x', 'y', 'z'] as const) {
        part.r.absmin[axis] = uniformIn(-4096, 4096);
        part.r.absmax[axis] = f(part.r.absmin[axis] + uniformIn(1, 512));
      }
      part.teamchain = parts[i + 1] ?? null;
    }
    thinkSpawnNewDoorTrigger(level, parts[0]);
    const trigger = level.find(null, 'classname', 'door_trigger')!;
    vecInto(triggers, trigger.r.mins);
    vecInto(triggers, trigger.r.maxs);
    triggers.int(trigger.count);
    for (const entity of [trigger, ...parts]) level.freeEntity(entity);
  }

  const paths = new Digest();
  for (let n = 0; n < count; n++) {
    const trType = pick(6);
    const trTime = pick(1 << 20);
    const trDuration = 1 + pick(10000);
    const trBase = randomVec(-4096, 4096);
    const trDelta = randomVec(-1000, 1000);
    const tr: Trajectory = { trType, trTime, trDuration, trBase, trDelta };
    const result = vec3();
    qvmEvaluateTrajectory(tr, trTime + pick(20000) - 1000, result);
    vecInto(paths, result);
  }

  const pushes = new Digest();
  for (let n = 0; n < count; n++) {
    const isClient = pick(2);
    const pusherOrigin = randomVec(-4096, 4096);
    const move = randomVec(-50, 50);
    const amove = pick(3) === 0 ? vec3() : randomVec(-10, 10);
    const trBase = vec3();
    const psOrigin = vec3();
    for (const axis of ['x', 'y', 'z'] as const) {
      trBase[axis] = f(pusherOrigin[axis] + uniformIn(-48, 48));
      psOrigin[axis] = f(pusherOrigin[axis] + uniformIn(-48, 48));
    }

    // Nothing is solid, so the rider is free wherever the push puts it.
    const pusher = level.spawnEntity();
    pusher.r.currentOrigin = pusherOrigin;
    pusher.r.mins = vec3(-64, -64, -64);
    pusher.r.maxs = vec3(64, 64, 64);
    level.linkEntity(pusher);
    const rider = isClient ? level.gentities[0] : level.spawnEntity();
    if (isClient) {
      level.initEntity(rider, 0);
      rider.client = level.clients[0];
      rider.client.ps = createIdlePlayerState({ origin: psOrigin });
      rider.s.eType = ET.PLAYER;
    } else {
      rider.s.eType = ET.ITEM;
    }
    rider.s.pos.trBase = trBase;
    rider.r.currentOrigin = copy(isClient ? psOrigin : trBase);
    rider.r.mins = vec3(-15, -15, -15);
    rider.r.maxs = vec3(15, 15, 15);
    rider.s.groundEntityNum = pusher.s.number;
    level.linkEntity(rider);

    expect(moverPush(level, pusher, move, amove, [])).toBeNull();
    vecInto(pushes, pusher.r.currentOrigin);
    vecInto(pushes, pusher.r.currentAngles);
    vecInto(pushes, rider.s.pos.trBase);
    if (isClient) {
      vecInto(pushes, rider.client!.ps.origin);
      pushes.int(rider.client!.ps.deltaAngles.y);
    }
    level.freeEntity(rider);
    level.freeEntity(pusher);
  }

  const waits = new Digest();
  for (let n = 0; n < count; n++) {
    level.time = random.next() >>> 4;
    waits.int(thinkTimeAfterMsec(level, uniformIn(-5000, 60000)));
  }
  level.time = 0;

  const lights = new Digest();
  for (let n = 0; n < count; n++) {
    const lightSet = pick(2);
    const colorSet = pick(2);
    const vars: SpawnVar[] = [];
    if (lightSet) vars.push(['light', String(uniformIn(0, 2000))]);
    if (colorSet) {
      const { x, y, z } = randomVec(0, 1.5);
      vars.push(['color', `${x} ${y} ${z}`]);
    }
    const ent = level.spawnEntity();
    initMover(level, ent, vars);
    lights.int(ent.s.constantLight);
    level.freeEntity(ent);
  }

  return {
    doors: doors.hex(),
    buttons: buttons.hex(),
    plats: plats.hex(),
    triggers: triggers.hex(),
    paths: paths.hex(),
    pushes: pushes.hex(),
    waits: waits.hex(),
    lights: lights.hex()
  };
}

describe("the movers' arithmetic, held to a twin of the QVM's", () => {
  // From `twin.exe corpus 1 2000` and `corpus 7 2000` (scratchpad `m4b/twin.c`): ioquake3's
  // g_mover.c, bg_misc.c and q_math.c compiled with every literal a float, as q3lcc's are.
  it.each([
    [
      1,
      {
        doors: '28921fd7',
        buttons: '13d837be',
        plats: '06e7b722',
        triggers: '2aace48d',
        paths: '475adf59',
        pushes: '603d6013',
        waits: '0b435df9',
        lights: '6bb1dece'
      }
    ],
    [
      7,
      {
        doors: '02b87814',
        buttons: 'e89c8577',
        plats: 'a916454b',
        triggers: '1479f152',
        paths: 'aa2ee488',
        pushes: 'e18a331c',
        waits: '45d76177',
        lights: '55d7659f'
      }
    ]
  ])('matches the twin on seed %i', (seed, digests) => {
    expect(corpus(seed, 2000)).toEqual(digests);
  });
});

/** A mover from a map: its angle, and its model's bounds as the BSP stores them. */
function fromMap(
  world: BoxLevel,
  yaw: number,
  mins: readonly [number, number, number],
  maxs: readonly [number, number, number],
  speed = 0
): GameEntity {
  // `CM_LoadSubmodels` spreads each inline model's bounds by a unit (`cm_load.c:146-149`).
  world.bounds.mins = vec3(mins[0] - 1, mins[1] - 1, mins[2] - 1);
  world.bounds.maxs = vec3(maxs[0] + 1, maxs[1] + 1, maxs[2] + 1);
  const ent = world.level.spawnEntity();
  ent.model = '*1';
  ent.s.angles = vec3(0, yaw, 0);
  ent.speed = speed;
  return ent;
}

/** A mover's two ends and its three trajectories, as the twin's `hand` prints them. */
function legs(level: Level, ent: GameEntity) {
  const rest = { trDelta: copy(ent.s.pos.trDelta), trDuration: ent.s.pos.trDuration };
  level.time = 1100;
  setMoverState(level, ent, MOVER.ONE_TO_TWO, 1000);
  const up = { trDelta: copy(ent.s.pos.trDelta), at: copy(ent.r.currentOrigin) };
  setMoverState(level, ent, MOVER.TWO_TO_ONE, 1000);
  const down = { trDelta: copy(ent.s.pos.trDelta), at: copy(ent.r.currentOrigin) };
  return { pos1: ent.pos1, pos2: ent.pos2, rest, up, down };
}

/** A vector of the twin's printed floats. */
const fv = (x: number, y: number, z: number) => vec3(f(x), f(y), f(z));

describe("the movers' hand cases, as the twin has them", () => {
  it("opens q3dm12's *4 at 400 exactly, where doubles open it at 400.0000305", () => {
    const world = boxLevel();
    const door = fromMap(world, 360, [608, -1384, -208], [688, -1368, -64]);
    spawnFuncDoor(world.level, door, []);
    expect(legs(world.level, door)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(74, 1.29385708e-5, 0),
      rest: { trDelta: fv(29600, 0.00517542847, 0), trDuration: 185 },
      up: { trDelta: fv(400, 6.99382217e-5, 0), at: fv(40, 6.99382235e-6, 0) },
      down: { trDelta: fv(-400, -6.99382217e-5, 0), at: fv(34, 5.94474841e-6, 0) }
    });
  });

  it("slides cpma3's d3 pair apart, each along its angle's float residue", () => {
    const world = boxLevel();
    const south = fromMap(world, 270, [1040, -1216, -288], [1064, -1144, -112], 500);
    spawnFuncDoor(world.level, south, []);
    expect(legs(world.level, south)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(7.87042097e-7, -66, 0),
      rest: { trDelta: fv(0.000393521041, -33000, 0), trDuration: 132 },
      up: { trDelta: fv(5.9624399e-6, -500, 0), at: fv(5.96243979e-7, -50, 0) },
      down: { trDelta: fv(-5.9624399e-6, 500, 0), at: fv(1.90798119e-7, -16, 0) }
    });
    const north = fromMap(world, 90, [1040, -1144, -288], [1064, -1072, -112], 500);
    spawnFuncDoor(world.level, north, []);
    expect(legs(world.level, north)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(-2.88495153e-6, 66, 0),
      rest: { trDelta: fv(-0.00144247571, 33000, 0), trDuration: 132 },
      up: { trDelta: fv(-2.18556925e-5, 500, 0), at: fv(-2.1855692e-6, 50, 0) },
      down: { trDelta: fv(2.18556925e-5, -500, 0), at: fv(-6.99382326e-7, 16, 0) }
    });
  });

  it("starts cpma3's sliding floor open, by its lip of 4, and its crusher walls at 30", () => {
    const world = boxLevel();
    const floor = fromMap(world, 90, [-1704, 1800, 116], [-1360, 2016, 124]);
    floor.spawnflags = 5;
    spawnFuncDoor(world.level, floor, [['lip', '4']]);
    expect(legs(world.level, floor)).toEqual({
      pos1: fv(-9.35423759e-6, 214.000015, 0),
      pos2: vec3(0, 0, 0),
      rest: { trDelta: fv(0.00374169508, -85600.0078, 0), trDuration: 535 },
      up: { trDelta: fv(1.74845554e-5, -400.000031, 0), at: fv(-7.60578223e-6, 174.000015, 0) },
      down: { trDelta: fv(-1.74845554e-5, 400.000031, 0), at: fv(-1.74845559e-6, 40.0000038, 0) }
    });
    const wall = fromMap(world, 90, [-1800, 2800, 256], [-1248, 2880, 384], 30);
    wall.spawnflags = 4;
    spawnFuncDoor(world.level, wall, []);
    expect(legs(world.level, wall)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(-3.23464383e-6, 74.0000229, 0),
      rest: { trDelta: fv(-9.70393157e-5, 2220.00073, 0), trDuration: 2466 },
      up: { trDelta: fv(-1.31169668e-6, 30.0081196, 0), at: fv(-1.31169671e-7, 3.00081205, 0) },
      down: { trDelta: fv(1.31169668e-6, -30.0081196, 0), at: fv(-3.10347423e-6, 70.9992142, 0) }
    });
  });

  it("presses cpma3's buttons by their lip of 4, at 40", () => {
    const world = boxLevel();
    const east = fromMap(world, 360, [-1748, 1660, 148], [-1736, 1696, 184]);
    spawnFuncButton(world.level, east, []);
    expect(legs(world.level, east)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(10.0000067, 1.74845673e-6, 0),
      rest: { trDelta: fv(400.000275, 6.99382654e-5, 0), trDuration: 250 },
      up: { trDelta: fv(40.0000267, 6.9938269e-6, 0), at: fv(4.00000286, 6.99382724e-7, 0) },
      down: { trDelta: fv(-40.0000267, -6.9938269e-6, 0), at: fv(6.00000381, 1.04907394e-6, 0) }
    });
    const west = fromMap(world, 180, [-1328, 2048, 152], [-1316, 2084, 188]);
    spawnFuncButton(world.level, west, []);
    expect(legs(world.level, west)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(-10.0000029, -8.74228022e-7, 0),
      rest: { trDelta: fv(-400.000122, -3.49691218e-5, 0), trDuration: 250 },
      up: { trDelta: fv(-40.0000114, -3.49691209e-6, 0), at: fv(-4.00000143, -3.4969122e-7, 0) },
      down: { trDelta: fv(40.0000114, 3.49691209e-6, 0), at: fv(-6.00000143, -5.24536802e-7, 0) }
    });
  });

  it("lifts cpma3's plat 290 at 600, its trigger inset from its sides at the bottom", () => {
    const world = boxLevel();
    const plat = fromMap(world, 0, [2332, -888, -344], [2468, -776, -48]);
    spawnFuncPlat(world.level, plat, [['speed', '600']]);
    const trigger = world.level.find(null, 'classname', 'plat_trigger')!;
    expect(trigger.s.number).toBe(plat.s.number + 1);
    expect([trigger.r.mins, trigger.r.maxs]).toEqual([
      vec3(2364, -856, -635),
      vec3(2436, -808, -329)
    ]);
    expect(legs(world.level, plat)).toEqual({
      pos1: vec3(0, 0, -290),
      pos2: vec3(0, 0, 0),
      rest: { trDelta: vec3(0, 0, 174000), trDuration: 483 },
      up: { trDelta: fv(0, 0, 600.414062), at: fv(0, 0, -229.958588) },
      down: { trDelta: fv(0, 0, -600.414062), at: fv(0, 0, -60.0414085) }
    });
  });

  it("collapses a narrow plat's trigger to a unit across its middle", () => {
    const world = boxLevel();
    const plat = fromMap(world, 0, [0, 0, 0], [40, 200, 8]);
    spawnFuncPlat(world.level, plat, [['height', '64.5']]);
    const trigger = world.level.find(null, 'classname', 'plat_trigger')!;
    expect([trigger.r.mins, trigger.r.maxs]).toEqual([fv(20, 32, -65.5), fv(21, 168, -47.5)]);
    expect(legs(world.level, plat)).toEqual({
      pos1: vec3(0, 0, -64.5),
      pos2: vec3(0, 0, 0),
      rest: { trDelta: vec3(0, 0, 12900), trDuration: 322 },
      up: { trDelta: fv(0, 0, 200.310562), at: fv(0, 0, -44.4689407) },
      down: { trDelta: fv(0, 0, -200.310562), at: fv(0, 0, -20.0310574) }
    });
  });

  it('takes 870 ms over 8.7 at 10, where doubles take 869', () => {
    const world = boxLevel();
    const door = fromMap(world, -1, [0, 0, 0], [8, 8, 8], 10);
    spawnFuncDoor(world.level, door, [['lip', '1.3']]);
    expect(legs(world.level, door)).toEqual({
      pos1: vec3(0, 0, 0),
      pos2: fv(0, 0, 8.69999981),
      rest: { trDelta: vec3(0, 0, 87), trDuration: 870 },
      up: { trDelta: vec3(0, 0, 10), at: vec3(0, 0, 1) },
      down: { trDelta: vec3(0, 0, -10), at: fv(0, 0, 7.69999981) }
    });
  });

  it('waits 0.7 s as 700 ms, and loses units past 2^24 ms as the QVM does', () => {
    const { level } = boxLevel();
    level.time = 400;
    expect(thinkTimeAfterMsec(level, f(f(0.7) * 1000))).toBe(1100);
    level.time = 16777217;
    expect(thinkTimeAfterMsec(level, f(f(0.7) * 1000))).toBe(16777916);
  });

  it('turns a rider about the pusher, and its view by a whole short of the turn', () => {
    const { level } = boxLevel();
    const pusher = level.spawnEntity();
    pusher.r.mins = vec3(-64, -64, -64);
    pusher.r.maxs = vec3(64, 64, 64);
    level.linkEntity(pusher);
    const rider = level.gentities[0];
    level.initEntity(rider, 0);
    rider.client = level.clients[0];
    rider.client.ps = createIdlePlayerState({ origin: vec3(100, 0, 24) });
    rider.s.eType = ET.PLAYER;
    rider.s.pos.trBase = vec3(100, 0, 24);
    rider.r.currentOrigin = vec3(100, 0, 24);
    rider.r.mins = vec3(-15, -15, -24);
    rider.r.maxs = vec3(15, 15, 32);
    rider.s.groundEntityNum = pusher.s.number;
    level.linkEntity(rider);

    expect(moverPush(level, pusher, vec3(), vec3(0, 1, 0), [])).toBeNull();
    expect(rider.s.pos.trBase).toEqual(fv(99.9847717, 1.74524057, 24));
    expect(rider.client.ps.origin).toEqual(fv(99.9847717, 1.74524057, 24));
    expect(rider.client.ps.deltaAngles.y).toBe(182);
    expect(pusher.r.currentAngles).toEqual(vec3(0, 1, 0));
  });

  it("bobs q3dm19's *9 through its period in floats", () => {
    const tr: Trajectory = {
      trType: TR.SINE,
      trTime: 1980,
      trDuration: 6000,
      trBase: vec3(0, 0, 128),
      trDelta: vec3(0, 0, 405)
    };
    const at = (time: number) => {
      const result = vec3();
      qvmEvaluateTrajectory(tr, time, result);
      return result.z;
    };
    expect([1980, 2646, 3480, 4314, 10000, 600000].map(at)).toEqual(
      [128, 388.112335, 533, 388.112335, 474.422333, -226.899628].map(f)
    );
  });
});

/** A block on the floor, 64 square and 96 high: a door that rises its height less its lip. */
const BLOCK: readonly [Vec3f, Vec3f] = [
  [-32, -32, 0],
  [32, 32, 96]
];

/** A door rising from {@link BLOCK}, 90 units in 225 ms, and its keys. */
function riser(keys: Record<string, string> = {}): TestEntity {
  return { classname: 'func_door', model: '*1', angle: '-1', ...keys };
}

/** The first entity of a class, which a test's map spawned. */
function first(level: Level, classname: string): GameEntity {
  return level.find(null, 'classname', classname)!;
}

/** A player standing on the floor at x and y, as the move leaves one: an eighth of a unit up. */
function standing(level: Level, slot: number, x: number, y: number): GameEntity {
  const player = clientAt(level, slot, vec3(x, y, 24.125));
  player.s.eType = ET.PLAYER;
  player.s.groundEntityNum = ENTITYNUM_WORLD;
  player.client!.ps.groundEntityNum = ENTITYNUM_WORLD;
  return player;
}

/** The event an entity carries, without its toggle bits, and its parameter. */
function eventOf(entity: GameEntity): [number, number] {
  return [eventNumber(entity.s.event), entity.s.eventParm];
}

describe('func_door', () => {
  it('rises along an angle of −1 its height less its lip, at 400, linked as a mover', () => {
    const level = moverLevel([BLOCK], [riser()]);
    const door = first(level, 'func_door');
    expect(door.pos1).toEqual(vec3(0, 0, 0));
    expect(door.pos2).toEqual(vec3(0, 0, 90));
    expect([door.speed, door.wait, door.damage]).toEqual([400, 2000, 2]);
    expect(door.s.eType).toBe(ET.MOVER);
    expect(door.r.svFlags).toBe(SVF.USE_CURRENT_ORIGIN);
    expect(door.s.solid).toBe(SOLID_BMODEL);
    expect(door.r.linked).toBe(true);
    expect(door.moverState).toBe(MOVER.POS1);
    expect(door.s.pos).toMatchObject({
      trType: TR.STATIONARY,
      trBase: vec3(0, 0, 0),
      trDelta: vec3(0, 0, 36000),
      trDuration: 225
    });
    expect(door.nextthink).toBe(100);
  });

  it("registers its sounds in Quake 3's order, then its loop's, and its second model", () => {
    const record = newMoverRecord();
    const level = moverLevel(
      [BLOCK],
      [riser({ noise: 'sound/test/hum.wav', model2: 'models/test/frame.md3' })],
      record
    );
    const door = first(level, 'func_door');
    expect(record.sounds).toEqual([DOOR_START_SOUND, DOOR_END_SOUND, 'sound/test/hum.wav']);
    expect([door.sound1to2, door.sound2to1, door.soundPos1, door.soundPos2]).toEqual([1, 1, 2, 2]);
    expect(door.s.loopSound).toBe(3);
    expect(record.models).toEqual(['models/test/frame.md3']);
    expect(door.s.modelindex2).toBe(1);
  });

  it("puts a trigger round its team a frame in, its thinnest side 120 wider, x on a tie", () => {
    const level = moverLevel([BLOCK], [riser()]);
    const door = first(level, 'func_door');
    expect(level.find(null, 'classname', 'door_trigger')).toBeNull();
    expect(door.takedamage).toBe(false);

    runUntil(level, 104);
    const trigger = first(level, 'door_trigger');
    expect(trigger.s.number).toBe(door.s.number + 1);
    expect([trigger.r.mins, trigger.r.maxs]).toEqual([vec3(-154, -34, -2), vec3(154, 34, 98)]);
    expect(trigger.count).toBe(0);
    expect(trigger.parent).toBe(door);
    expect(trigger.r.contents).toBe(CONTENTS.TRIGGER);
    expect(trigger.r.linked).toBe(true);
    // Sent to clients, and drawn as nothing.
    expect(trigger.r.svFlags).toBe(0);
    expect(trigger.s.modelindex).toBe(0);
    // Every member shootable, and the team matched at this frame, which a door at rest sends.
    expect(door.takedamage).toBe(true);
    expect(door.s.pos.trTime).toBe(104);
  });

  it('opens 50 ms after a player walks in, holds open while touched, and closes its portal', () => {
    const record = newMoverRecord();
    const level = moverLevel([BLOCK], [riser()], record);
    runUntil(level, 104);
    const door = first(level, 'func_door');
    const player = standing(level, 0, -100, 0);

    touchTriggers(level, player);
    expect(door.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(door.s.pos).toMatchObject({ trType: TR.LINEAR_STOP, trTime: 154 });
    // 90 over 225 ms, in floats.
    expect(door.s.pos.trDelta).toEqual(vec3(0, 0, f(90 * f(1000 / 225))));
    expect(eventOf(door)).toEqual([EV.GENERAL_SOUND, door.sound1to2]);
    expect(door.activator).toBe(player);
    expect(record.portals).toEqual([{ number: door.s.number, open: true }]);

    // Touched on its way up, it goes on.
    runUntil(level, 200);
    touchTriggers(level, player);
    expect(door.s.pos.trTime).toBe(154);

    // 225 ms on from 154 is reached on the first frame at or after 379.
    runUntil(level, 376);
    expect(door.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(door.r.currentOrigin.z).toBeCloseTo(88.8, 4);
    runUntil(level, 384);
    expect(door.moverState).toBe(MOVER.POS2);
    expect(door.r.currentOrigin).toEqual(vec3(0, 0, 90));
    expect(eventOf(door)).toEqual([EV.GENERAL_SOUND, door.soundPos2]);
    expect(door.nextthink).toBe(2384);

    // A touch at the top waits the whole wait again.
    runUntil(level, 1000);
    touchTriggers(level, player);
    expect(door.nextthink).toBe(3000);
    runUntil(level, 2992);
    expect(door.moverState).toBe(MOVER.POS2);
    runUntil(level, 3000);
    expect(door.moverState).toBe(MOVER.TWO_TO_ONE);
    expect(door.s.pos.trTime).toBe(3000);
    expect(eventOf(door)).toEqual([EV.GENERAL_SOUND, door.sound2to1]);

    runUntil(level, 3232);
    expect(door.moverState).toBe(MOVER.POS1);
    expect(door.r.currentOrigin).toEqual(vec3(0, 0, 0));
    expect(eventOf(door)).toEqual([EV.GENERAL_SOUND, door.soundPos1]);
    expect(record.portals).toEqual([
      { number: door.s.number, open: true },
      { number: door.s.number, open: false }
    ]);
  });

  it('turns back from where it is, either way, timed as if it had left from the far end', () => {
    const level = moverLevel([BLOCK], [riser({ targetname: 'gate' })]);
    const door = first(level, 'func_door');
    const player = standing(level, 0, -100, 0);

    runUntil(level, 104);
    door.use!(door, player, player);
    runUntil(level, 200);
    // 46 ms of its 225 out, so back down as if it had left the top 179 ms ago.
    door.use!(door, player, player);
    expect(door.moverState).toBe(MOVER.TWO_TO_ONE);
    expect(door.s.pos.trTime).toBe(21);
    expect(door.r.currentOrigin.z).toBeCloseTo(18.4, 4);
    expect(eventOf(door)).toEqual([EV.GENERAL_SOUND, door.sound2to1]);

    runUntil(level, 232);
    door.use!(door, player, player);
    expect(door.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(door.s.pos.trTime).toBe(232 - 225 + (232 - 21));
    expect(eventOf(door)).toEqual([EV.GENERAL_SOUND, door.sound1to2]);
  });

  it('turns back at once from a move whose time has run, before the frame finds it there', () => {
    const level = moverLevel([BLOCK], [riser({ targetname: 'gate' })]);
    const door = first(level, 'func_door');
    runUntil(level, 104);
    door.use!(door, door, door);
    runUntil(level, 376);
    // Used in the frame at 384 by something numbered before it, which runs first: 230 ms out of
    // its 225.
    level.time = 384;
    door.use!(door, door, door);
    expect(door.moverState).toBe(MOVER.TWO_TO_ONE);
    expect(door.s.pos.trTime).toBe(384);
  });

  it('links a mover where its new state puts it', () => {
    const level = moverLevel([BLOCK], [riser({ targetname: 'gate' })]);
    const door = first(level, 'func_door');
    setMoverState(level, door, MOVER.POS2, level.time);
    expect([door.r.absmin.z, door.r.absmax.z]).toEqual([88, 188]);
  });

  it('with a targetname or a health is fired or shot, and spawns no trigger', () => {
    const named = moverLevel([BLOCK], [riser({ targetname: 'gate' })]);
    runUntil(named, 104);
    expect(named.find(null, 'classname', 'door_trigger')).toBeNull();
    expect(first(named, 'func_door').takedamage).toBe(false);
    // `Think_MatchTeam`, at the same frame.
    expect(first(named, 'func_door').s.pos.trTime).toBe(104);

    const shot = moverLevel([BLOCK], [riser({ health: '5' })]);
    expect(first(shot, 'func_door').takedamage).toBe(true);
    runUntil(shot, 104);
    expect(shot.find(null, 'classname', 'door_trigger')).toBeNull();
  });

  it('starts open with START_OPEN, its two ends the other way round', () => {
    const level = moverLevel([BLOCK], [riser({ spawnflags: String(DOOR_START_OPEN) })]);
    const door = first(level, 'func_door');
    expect(door.pos1).toEqual(vec3(0, 0, 90));
    expect(door.pos2).toEqual(vec3(0, 0, 0));
    expect(door.r.currentOrigin).toEqual(vec3(0, 0, 90));
  });

  it("is used through its team's master, and moves with its team in step", () => {
    const record = newMoverRecord();
    const level = moverLevel(
      [
        [
          [0, 0, 0],
          [8, 64, 96]
        ],
        [
          [0, -64, 0],
          [8, 0, 96]
        ]
      ],
      [
        { classname: 'func_door', model: '*1', angle: '90', team: 'pair' },
        { classname: 'func_door', model: '*2', angle: '270', team: 'pair', target: 'beyond' }
      ],
      record
    );
    const fired = useRecorder(level, 'beyond');
    const [master, member] = [72, 73].map((n) => level.gentities[n]);
    expect(member.teammaster).toBe(master);
    expect(record.prints).toContain('1 teams with 2 entities');

    runUntil(level, 104);
    // One trigger, round both, and only the master's think ran.
    const trigger = first(level, 'door_trigger');
    expect([trigger.r.mins, trigger.r.maxs]).toEqual([vec3(-122, -66, -2), vec3(130, 66, 98)]);
    expect(level.find(trigger, 'classname', 'door_trigger')).toBeNull();
    expect(member.nextthink).toBe(100);

    member.use!(member, trigger, level.gentities[0]);
    expect([master.moverState, member.moverState]).toEqual([MOVER.ONE_TO_TWO, MOVER.ONE_TO_TWO]);
    expect([master.s.pos.trTime, member.s.pos.trTime]).toEqual([154, 154]);
    expect(eventNumber(member.s.event)).toBe(0);
    expect(record.portals).toEqual([{ number: master.s.number, open: true }]);

    // Each reaches its end itself, with its own sound.
    runUntil(level, 312);
    expect([master.moverState, member.moverState]).toEqual([MOVER.POS2, MOVER.POS2]);
    expect(eventOf(member)).toEqual([EV.GENERAL_SOUND, member.soundPos2]);
    // Its own targets, as itself, since nobody used it.
    expect(fired).toEqual([{ other: member.s.number, activator: member.s.number }]);

    // Back after the master's wait, its portal closed by the master alone.
    runUntil(level, 2464);
    expect([master.moverState, member.moverState]).toEqual([MOVER.POS1, MOVER.POS1]);
    expect(record.portals).toEqual([
      { number: master.s.number, open: true },
      { number: master.s.number, open: false }
    ]);
  });

  it('never returning, turns back the frame it arrives a second into the level, else never', () => {
    const late = moverLevel([BLOCK], [riser({ targetname: 'gate', wait: '-1' })]);
    const door = first(late, 'func_door');
    expect(door.wait).toBe(-1000);
    runUntil(late, 1000);
    door.use!(door, door, door);
    runUntil(late, 1280);
    expect(door.moverState).toBe(MOVER.TWO_TO_ONE);
    expect(door.s.pos.trTime).toBe(1280);

    const early = moverLevel([BLOCK], [riser({ targetname: 'gate', wait: '-1' })]);
    const stuck = first(early, 'func_door');
    runUntil(early, 104);
    stuck.use!(stuck, stuck, stuck);
    runUntil(early, 5000);
    expect(stuck.moverState).toBe(MOVER.POS2);
    expect(stuck.nextthink).toBe(384 - 1000);
  });
});

describe("a door's portal", () => {
  /** Two doors over the portal between area 0, x up to 64, and area 1 past it. */
  const PORTAL_DOORS: readonly (readonly [Vec3f, Vec3f])[] = [
    [
      [56, -64, 0],
      [72, -8, 96]
    ],
    [
      [56, 8, 0],
      [72, 64, 96]
    ]
  ];

  /** A level whose doors open and close its clip map's portal, used by name. */
  function portalLevel(entities: readonly TestEntity[]) {
    const strips = [
      { cluster: 0, area: 0 },
      { cluster: 1, area: 1 }
    ];
    const cm = loadMap(stripsBsp(strips, PORTAL_DOORS), 'maps/test.bsp');
    const level = moverLevelOn(cm, entities);
    runUntil(level, 104);
    const [a, b] = [72, 73].map((n) => level.gentities[n]);
    return { cm, level, a, b };
  }

  const gate = (model: string, keys: Record<string, string> = {}): TestEntity => ({
    classname: 'func_door',
    model,
    angle: '-1',
    targetname: 'gate',
    ...keys
  });

  it('opens its portal as it leaves its rest, and closes it as it comes back', () => {
    const { cm, level, a } = portalLevel([gate('*1')]);
    const [here, there] = [vec3(32, 0, 0), vec3(96, 0, 0)];
    expect(level.inPVS(here, there)).toBe(false);
    a.use!(a, a, a);
    expect(Array.from(cm.areaPortals)).toEqual([0, 1, 1, 0]);
    expect(areasConnected(cm, 0, 1)).toBe(true);
    expect(level.inPVS(here, there)).toBe(true);
    runUntil(level, 2608);
    expect(a.moverState).toBe(MOVER.TWO_TO_ONE);
    expect(areasConnected(cm, 0, 1)).toBe(true);
    runUntil(level, 2616);
    expect(a.moverState).toBe(MOVER.POS1);
    expect(Array.from(cm.areaPortals)).toEqual([0, 0, 0, 0]);
    expect(areasConnected(cm, 0, 1)).toBe(false);
  });

  it("opens it by the team's master alone", () => {
    const { cm, level, a, b } = portalLevel([
      gate('*1', { team: 'pair' }),
      gate('*2', { team: 'pair' })
    ]);
    expect(b.teammaster).toBe(a);
    b.use!(b, b, b);
    expect(Array.from(cm.areaPortals)).toEqual([0, 1, 1, 0]);
    runUntil(level, 2616);
    expect(Array.from(cm.areaPortals)).toEqual([0, 0, 0, 0]);
  });

  it('keeps a portal two doors stand over open until both have closed', () => {
    const { cm, level, a, b } = portalLevel([gate('*1'), gate('*2', { targetname: 'other' })]);
    a.use!(a, a, a);
    runUntil(level, 1000);
    b.use!(b, b, b);
    expect(Array.from(cm.areaPortals)).toEqual([0, 2, 2, 0]);
    runUntil(level, 3000);
    expect([a.moverState, b.moverState]).toEqual([MOVER.POS1, MOVER.POS2]);
    expect(areasConnected(cm, 0, 1)).toBe(true);
    runUntil(level, 4000);
    expect(Array.from(cm.areaPortals)).toEqual([0, 0, 0, 0]);
    expect(areasConnected(cm, 0, 1)).toBe(false);
  });
});

describe('a door blocked', () => {
  /** A door that starts open, closed by name at 104, over a player standing under it or not. */
  function closingOn(flags: number, player = true) {
    const level = moverLevel([BLOCK], [riser({ targetname: 'gate', spawnflags: String(flags) })]);
    const door = first(level, 'func_door');
    const under = player ? standing(level, 0, 0, 0) : null;
    runUntil(level, 104);
    door.use!(door, door, door);
    return { level, door, player: under! };
  }

  /** The level times its frames hurt the player at, through `until`. */
  function hurtAt(level: Level, player: GameEntity, until: number): number[] {
    const times: number[] = [];
    let health = player.client!.ps.stats[STAT.HEALTH];
    for (let time = level.time + 8; time <= until; time += 8) {
      level.runFrame(time);
      const now = player.client!.ps.stats[STAT.HEALTH];
      if (now < health) times.push(time);
      health = now;
    }
    return times;
  }

  it('hurts a player it closes on by its dmg, once, and turns back for them', () => {
    const { level, door, player } = closingOn(DOOR_START_OPEN);
    const hurt = hurtAt(level, player, 600);
    expect(hurt).toHaveLength(1);
    expect(player.client!.ps.stats[STAT.HEALTH]).toBe(98);
    expect(player.client!.lasthurtMod).toBe(MOD.CRUSH);
    // Turned back open, which is its first end.
    expect(door.moverState).toBe(MOVER.POS1);
    expect(door.activator).toBe(player);
  });

  it("holds a crusher's team back a frame at a time, and hurts once in each of Quake 3's", () => {
    const { level, door, player } = closingOn(DOOR_START_OPEN | DOOR_CRUSHER);
    const hurt = hurtAt(level, player, 800);
    const frames = hurt.map((time) => time - (time % Q3_FRAME_MSEC));
    expect(frames.length).toBeGreaterThan(8);
    expect(frames).toEqual(frames.map((_, i) => frames[0] + i * Q3_FRAME_MSEC));
    expect(door.moverState).toBe(MOVER.ONE_TO_TWO);
    // Held where it stopped, its clock shifted by every frame it stayed.
    const { trTime } = door.s.pos;
    level.runFrame(808);
    expect(door.s.pos.trTime).toBe(trTime + 8);
  });

  it('hurts every player a door that is no crusher closes on, however soon after another', () => {
    const level = moverLevel([BLOCK], [riser({ targetname: 'gate' })]);
    const door = first(level, 'func_door');
    const first_ = standing(level, 0, 0, 0);
    const second = standing(level, 1, 50, 0);
    level.time = 1000;
    blockedDoor(level, door, first_);
    blockedDoor(level, door, second);
    expect([first_, second].map((p) => p.client!.ps.stats[STAT.HEALTH])).toEqual([98, 98]);
  });

  it('pops an item in its way and frees it, and goes on', () => {
    const { level, door } = closingOn(DOOR_START_OPEN, false);
    const item = level.spawnEntity();
    item.s.eType = ET.ITEM;
    item.r.mins = vec3(-15, -15, -15);
    item.r.maxs = vec3(15, 15, 15);
    item.r.contents = CONTENTS.TRIGGER;
    setEntityOrigin(item, vec3(0, 0, 16));
    item.s.groundEntityNum = ENTITYNUM_NONE;
    level.linkEntity(item);

    runUntil(level, 600);
    expect(item.inuse).toBe(false);
    const pop = level.gentities.find((e) => e.inuse && e.s.eType === ET.EVENTS + EV.ITEM_POP)!;
    expect(pop.s.pos.trBase).toEqual(vec3(0, 0, 16));
    expect(door.moverState).toBe(MOVER.POS2);
  });

  it('takes a dropped flag home rather than popping it', () => {
    const { level } = closingOn(DOOR_START_OPEN, false);
    const flag = level.spawnEntity();
    flag.classname = 'team_CTF_redflag';
    flag.item = findItem('team_CTF_redflag');
    flag.flags |= FL.DROPPED_ITEM;
    flag.s.eType = ET.ITEM;
    flag.r.mins = vec3(-15, -15, -15);
    flag.r.maxs = vec3(15, 15, 15);
    flag.r.contents = CONTENTS.TRIGGER;
    setEntityOrigin(flag, vec3(0, 0, 16));
    level.linkEntity(flag);

    runUntil(level, 600);
    expect(flag.inuse).toBe(false);
    expect(level.gentities.some((e) => e.inuse && e.s.eType === ET.EVENTS + EV.ITEM_POP)).toBe(
      false
    );
  });
});

describe("a door's trigger and a spectator", () => {
  /** A thin door, 8 across and 128 long, whose trigger spans x −122 to 130. */
  const THIN: readonly [Vec3f, Vec3f] = [
    [0, -64, 0],
    [8, 64, 96]
  ];

  function watcher(x: number) {
    const level = moverLevel([THIN], [{ classname: 'func_door', model: '*1', angle: '90' }]);
    runUntil(level, 104);
    const spectator = standing(level, 0, x, 0);
    spectator.client!.sess.sessionTeam = TEAM.SPECTATOR;
    spectator.client!.ps.velocity = vec3(100, 0, 0);
    spectator.client!.ps.viewangles = vec3(0, 30, 0);
    return { level, door: first(level, 'func_door'), spectator };
  }

  it('puts a spectator within 100 of its middle through the door, way and speed kept', () => {
    const { level, door, spectator } = watcher(-20);
    touchTriggers(level, spectator);
    const { ps } = spectator.client!;
    // Ten past the trigger's box less 100, which its link pads a unit: 33 past the brush.
    expect(ps.origin).toEqual(vec3(41, 0, 25.125));
    expect(ps.velocity).toEqual(vec3(100, 0, 0));
    expect(ps.viewangles).toEqual(vec3(0, 30, 0));
    expect(door.moverState).toBe(MOVER.POS1);
  });

  it('leaves one further out, and one at a door that is open or opening', () => {
    const far = watcher(-50);
    touchTriggers(far.level, far.spectator);
    expect(far.spectator.client!.ps.origin.x).toBe(-50);

    const open = watcher(-20);
    open.door.use!(open.door, open.door, open.door);
    touchTriggers(open.level, open.spectator);
    expect(open.spectator.client!.ps.origin.x).toBe(-20);
    runUntil(open.level, 464);
    expect(open.door.moverState).toBe(MOVER.POS2);
    touchTriggers(open.level, open.spectator);
    expect(open.spectator.client!.ps.origin.x).toBe(-20);
  });
});

describe('func_plat', () => {
  /** A plat 128 square and 16 thick, drawn with its top at 144, resting on the floor 128 down. */
  const PLAT: readonly [Vec3f, Vec3f] = [
    [-64, -64, 128],
    [64, 64, 144]
  ];

  function platLevel(keys: Record<string, string> = {}, record = newMoverRecord()) {
    const plat = { classname: 'func_plat', model: '*1', height: '128', ...keys };
    const level = moverLevel([PLAT], [plat], record);
    return { level, plat: first(level, 'func_plat') };
  }

  it('rests its height down, at 200, its trigger in the next slot, inset at the bottom', () => {
    const record = newMoverRecord();
    const { level, plat } = platLevel({}, record);
    expect(plat.pos1).toEqual(vec3(0, 0, -128));
    expect(plat.pos2).toEqual(vec3(0, 0, 0));
    expect(plat.r.currentOrigin).toEqual(vec3(0, 0, -128));
    expect([plat.speed, plat.wait, plat.damage]).toEqual([200, 1000, 2]);
    expect(plat.s.pos.trDuration).toBe(640);
    expect(record.sounds).toEqual([PLAT_START_SOUND, PLAT_END_SOUND]);
    expect(plat.parent).toBe(plat);

    const trigger = first(level, 'plat_trigger');
    expect(trigger.s.number).toBe(plat.s.number + 1);
    expect([trigger.r.mins, trigger.r.maxs]).toEqual([vec3(-32, -32, -1), vec3(32, 32, 25)]);
    expect(trigger.r.contents).toBe(CONTENTS.TRIGGER);
    expect(trigger.parent).toBe(plat);
  });

  it('waits a second at the top whatever its wait, and has no trigger when fired by name', () => {
    expect(platLevel({ wait: '5' }).plat.wait).toBe(1000);
    const { level } = platLevel({ targetname: 'lift' });
    expect(level.find(null, 'classname', 'plat_trigger')).toBeNull();
  });

  it('goes up 50 ms after a player steps in at the bottom, pushing them up with it', () => {
    const { level, plat } = platLevel();
    const player = clientAt(level, 0, vec3(0, 0, 40.125));
    player.s.eType = ET.PLAYER;
    touchTriggers(level, player);
    expect(plat.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(plat.s.pos.trTime).toBe(50);

    runUntil(level, 696);
    expect(plat.moverState).toBe(MOVER.POS2);
    expect(player.client!.ps.origin.z).toBeCloseTo(168.125, 3);
    expect(player.s.groundEntityNum).toBe(ENTITYNUM_NONE);
  });

  it('sets off only for a client, and only at the bottom', () => {
    const { level, plat } = platLevel();
    const trigger = first(level, 'plat_trigger');
    const thing = level.spawnEntity();
    trigger.touch!(trigger, thing, clearTrace(vec3()));
    expect(plat.moverState).toBe(MOVER.POS1);

    const player = clientAt(level, 0, vec3(0, 0, 40.125));
    plat.use!(plat, plat, player);
    runUntil(level, 40);
    trigger.touch!(trigger, player, clearTrace(vec3()));
    expect(plat.s.pos.trTime).toBe(50);
  });

  it('holds a second at the top for a living player standing on it, and for nobody else', () => {
    const { level, plat } = platLevel({ targetname: 'lift' });
    const player = clientAt(level, 0, vec3(0, 0, 40.125));
    plat.touch!(plat, player, clearTrace(vec3()));
    expect(plat.nextthink).toBe(0);
    plat.use!(plat, plat, player);
    runUntil(level, 696);
    expect(plat.nextthink).toBe(1696);

    level.time = 1200;
    plat.touch!(plat, player, clearTrace(vec3()));
    expect(plat.nextthink).toBe(2200);
    player.client!.ps.stats[STAT.HEALTH] = 0;
    level.time = 1500;
    plat.touch!(plat, player, clearTrace(vec3()));
    expect(plat.nextthink).toBe(2200);
  });
});

describe('func_button', () => {
  /** A button 8 deep on the floor's edge, pressed east its depth less its lip of 4. */
  const BUTTON: readonly [Vec3f, Vec3f] = [
    [0, -16, 32],
    [8, 16, 64]
  ];

  function buttonLevel(keys: Record<string, string> = {}, record = newMoverRecord()) {
    const button = { classname: 'func_button', model: '*1', ...keys };
    const level = moverLevel([BUTTON], [button], record);
    return { level, button: first(level, 'func_button') };
  }

  it('is pressed 6 at 40 and back after a second, with one sound', () => {
    const record = newMoverRecord();
    const { button } = buttonLevel({}, record);
    expect(button.pos2).toEqual(vec3(6, 0, 0));
    expect([button.speed, button.wait]).toEqual([40, 1000]);
    expect(button.s.pos.trDuration).toBe(150);
    expect(record.sounds).toEqual([BUTTON_SOUND]);
    expect([button.sound1to2, button.sound2to1, button.soundPos1, button.soundPos2]).toEqual([
      1, 0, 0, 0
    ]);
    expect(button.takedamage).toBe(false);
    expect(button.touch).not.toBeNull();
  });

  it('is pressed by a client walking into it at rest, and fires its targets as them', () => {
    const { level, button } = buttonLevel({ target: 'gate' });
    const fired = useRecorder(level, 'gate');
    const player = clientAt(level, 0, vec3(-20, 0, 48));
    const thing = level.spawnEntity();

    button.touch!(button, thing, clearTrace(vec3()));
    expect(button.moverState).toBe(MOVER.POS1);
    button.touch!(button, player, clearTrace(vec3()));
    expect(button.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(button.activator).toBe(player);

    runUntil(level, 200);
    expect(button.moverState).toBe(MOVER.POS2);
    expect(fired).toEqual([{ other: button.s.number, activator: player.s.number }]);
    runUntil(level, 600);
    button.touch!(button, player, clearTrace(vec3()));
    expect(button.nextthink).toBe(1200);
  });

  it('with a health is shot rather than touched', () => {
    const { level, button } = buttonLevel({ health: '1' });
    expect(button.takedamage).toBe(true);
    expect(button.touch).toBeNull();
    damage(level, button, null, null, null, 1, 0, MOD.MACHINEGUN);
    expect(button.moverState).toBe(MOVER.ONE_TO_TWO);
  });
});

describe('func_static', () => {
  it('stands where the map put it, linked where InitMover left it, about the origin', () => {
    const keys = { classname: 'func_static', model: '*1', origin: '100 0 0' };
    const level = moverLevel([BLOCK], [keys]);
    const wall = first(level, 'func_static');
    expect(wall.s.eType).toBe(ET.MOVER);
    expect(wall.s.pos.trBase).toEqual(vec3(100, 0, 0));
    expect(wall.r.currentOrigin).toEqual(vec3(100, 0, 0));
    expect([wall.r.absmin, wall.r.absmax]).toEqual([vec3(-34, -34, -2), vec3(34, 34, 98)]);
    expect([wall.pos1, wall.pos2]).toEqual([vec3(), vec3()]);
    expect(wall.s.pos.trDuration).toBe(1);
    expect(wall.use).not.toBeNull();
  });
});

describe('a freed mover', () => {
  it('leaves nothing of itself in its slot', () => {
    const flags = String(DOOR_START_OPEN | DOOR_CRUSHER);
    const level = moverLevel([BLOCK], [riser({ spawnflags: flags })]);
    const door = first(level, 'func_door');
    door.moverState = MOVER.POS2;
    door.crushDebounceTime = 500;
    expect(door.pos1.z).toBe(90);
    level.freeEntity(door);
    const fields = [
      'moverState',
      'pos1',
      'pos2',
      'sound1to2',
      'sound2to1',
      'soundPos1',
      'soundPos2',
      'soundLoop',
      'crushDebounceTime',
      'reached',
      'blocked'
    ] as const;
    const fresh = createGameEntity();
    const of = (entity: GameEntity) =>
      Object.fromEntries(fields.map((field) => [field, entity[field]]));
    expect(of(door)).toEqual(of(fresh));
  });
});

describe('InitMover', () => {
  /** A mover's `constantLight` from these keys. */
  function lightOf(keys: Record<string, string>): number {
    return first(moverLevel([BLOCK], [riser(keys)]), 'func_door').s.constantLight;
  }

  it('lights a mover by its light and color, a quarter of the light in the top byte', () => {
    expect(lightOf({})).toBe(0);
    expect(lightOf({ light: '300' })).toBe(0xffffff | (75 << 24));
    // The light is 100 once a color is set.
    expect(lightOf({ color: '1 0.5 0' })).toBe(255 | (127 << 8) | (25 << 24));
    // Each part caps at 255.
    expect(lightOf({ light: '2000', color: '2 2 2' })).toBe(0xffffff | (255 << 24));
  });

  it('takes at least a millisecond to go nowhere', () => {
    const door = first(moverLevel([BLOCK], [riser({ lip: '98' })]), 'func_door');
    expect(door.pos2).toEqual(door.pos1);
    expect(door.s.pos.trDuration).toBe(1);
  });
});

describe("G_Damage's mover branch", () => {
  it('uses a shootable door at rest as whoever shot it, and hurts nothing', () => {
    const level = moverLevel([BLOCK], [riser({ health: '5' })]);
    const door = first(level, 'func_door');
    const shooter = standing(level, 0, -200, 0);
    const rocket = level.spawnEntity();
    damage(level, door, rocket, shooter, vec3(1, 0, 0), 10, 0, MOD.ROCKET);
    expect(door.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(door.activator).toBe(shooter);
    expect(door.health).toBe(5);
  });

  it("does nothing to one on its way, and opens one during a round's countdown", () => {
    const level = moverLevel([BLOCK], [riser({ health: '5' })]);
    const door = first(level, 'func_door');
    const shooter = standing(level, 0, -200, 0);
    level.roundTime = 5000;
    damage(level, door, shooter, shooter, null, 10, 0, MOD.MACHINEGUN);
    expect(door.moverState).toBe(MOVER.ONE_TO_TWO);
    const { trTime } = door.s.pos;
    damage(level, door, null, null, null, 10, 0, MOD.MACHINEGUN);
    expect(door.s.pos.trTime).toBe(trTime);
  });
});
