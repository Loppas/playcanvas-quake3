import { describe, expect, it } from 'vitest';

import type { SpawnVar } from '../formats/entity-text';
import { TR, type Trajectory } from '../net/protocol';
import { Digest, Seeded } from './cm/collision-test-fixtures';
import { f, type Vec3f } from './cm/q-math';
import {
  spawnFuncBobbing,
  spawnFuncPendulum,
  BOBBING_X_AXIS,
  BOBBING_Y_AXIS,
  ROTATING_X_AXIS,
  ROTATING_Y_AXIS
} from './cyclic-movers';
import { ET, MOVER, SVF, type GameEntity } from './game-entity';
import { DEFAULT_ITEM_MATCH } from './item-touch';
import { Level } from './level';
import { moverLevel, newMoverRecord } from './mover-test-fixtures';
import { qvmEvaluateTrajectory } from './trajectory';
import { clientAt, runUntil } from './trigger-test-fixtures';
import { copy, vec3, type Vec3 } from './vec3';

/**
 * A level with no collision whose brush models are whatever box `bounds` holds, as
 * `SV_SetBrushModel` gives an inline model's bounds, linked into the level's own world.
 */
function boxLevel(gravity = 800) {
  const bounds = { mins: vec3(), maxs: vec3() };
  const level: Level = new Level({
    handlers: {
      setBrushModel: (entity) => {
        entity.r.mins = copy(bounds.mins);
        entity.r.maxs = copy(bounds.maxs);
        entity.r.bmodel = true;
        entity.r.contents = -1;
        level.linkEntity(entity);
      }
    }
  });
  level.itemMatch = { ...DEFAULT_ITEM_MATCH, gravity: () => gravity };
  return { level, bounds };
}

/** Where a trajectory puts its mover at a time. */
function at(tr: Trajectory, time: number): Vec3 {
  const result = vec3();
  qvmEvaluateTrajectory(tr, time, result);
  return result;
}

/**
 * The twin's `corpus2` bobbers and pendulums, each kind from the seed afresh: seeded keys, made in
 * floats as the twin's C makes them, spawned, read at a time anywhere in the first four and a half
 * hours, and digested as the twin digests them.
 */
function corpus(seed: number, count: number): { bobbers: string; pendulums: string } {
  let random = new Seeded(seed);
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

  let gravity = 800;
  const { level, bounds } = boxLevel();
  level.itemMatch = { ...DEFAULT_ITEM_MATCH, gravity: () => gravity };
  const vecInto = (digest: Digest, v: Vec3) => digest.float(v.x).float(v.y).float(v.z);

  const bobbers = new Digest();
  for (let n = 0; n < count; n++) {
    const ent = level.spawnEntity();
    ent.model = '*1';
    ent.s.origin = randomVec(-4096, 4096);
    const speed = pick(4) === 0 ? 0 : uniformIn(0, 20);
    const height = uniformIn(-1024, 1024);
    const phase = pick(4) === 0 ? 0 : uniformIn(0, 1);
    ent.spawnflags = pick(4);
    const vars: SpawnVar[] = [
      ['speed', String(speed)],
      ['height', String(height)],
      ['phase', String(phase)]
    ];
    spawnFuncBobbing(level, ent, vars);
    const { pos } = ent.s;
    bobbers.float(ent.speed).int(pos.trDuration).int(pos.trTime);
    vecInto(bobbers, pos.trDelta);
    vecInto(bobbers, at(pos, pick(1 << 24)));
    level.freeEntity(ent);
  }

  random = new Seeded(seed);
  const pendulums = new Digest();
  for (let n = 0; n < count; n++) {
    const minsZ = uniformIn(-1024, 64);
    gravity = pick(4) === 0 ? 800 : uniformIn(1, 2000);
    const speed = uniformIn(-90, 90);
    const phase = pick(2) ? 0 : uniformIn(0, 1);
    const ent = level.spawnEntity();
    ent.model = '*1';
    ent.s.angles = randomVec(-180, 180);
    bounds.mins.z = minsZ;
    spawnFuncPendulum(level, ent, [
      ['speed', String(speed)],
      ['phase', String(phase)]
    ]);
    const { apos } = ent.s;
    pendulums.int(apos.trDuration).int(apos.trTime);
    vecInto(pendulums, at(apos, pick(1 << 24)));
    level.freeEntity(ent);
  }

  return { bobbers: bobbers.hex(), pendulums: pendulums.hex() };
}

describe("the bobbers' and pendulums' arithmetic, held to a twin of the QVM's", () => {
  // From `twin.exe corpus2 1 2000` and `corpus2 7 2000` (scratchpad `m4c/twin.c`): ioquake3's
  // SP_func_bobbing, SP_func_pendulum and BG_EvaluateTrajectory with every literal a float, as
  // q3lcc's are, and the root a trap's.
  it.each([
    [1, { bobbers: '6cb2473b', pendulums: '60ea1fa5' }],
    [7, { bobbers: '3173f584', pendulums: 'cf8f48af' }]
  ])('matches the twin on seed %i', (seed, digests) => {
    expect(corpus(seed, 2000)).toEqual(digests);
  });

  /** A bobber spawned from these keys, as the twin's hand cases spawn it. */
  function bobber(keys: SpawnVar[], spawnflags = 0): GameEntity {
    const { level } = boxLevel();
    const ent = level.spawnEntity();
    ent.model = '*1';
    ent.spawnflags = spawnflags;
    spawnFuncBobbing(level, ent, keys);
    return ent;
  }

  it("bobs the maps' bobbers on the twin's times, where doubles put some a unit short", () => {
    const times = (ent: GameEntity) => [ent.s.pos.trDuration, ent.s.pos.trTime];
    // q3dm19's *9 and *1.
    expect(times(bobber([['speed', '6'], ['phase', '0.33']]))).toEqual([6000, 1980]);
    expect(times(bobber([['speed', '8'], ['phase', '0.5']]))).toEqual([8000, 4000]);
    // q3tourney6's *6, sideways, and its *18.
    const slide = bobber([['speed', '12'], ['height', '1224']], BOBBING_Y_AXIS);
    expect([...times(slide), slide.s.pos.trDelta]).toEqual([12000, 0, vec3(0, 1224, 0)]);
    expect(times(bobber([['speed', '.5']]))).toEqual([500, 0]);
    // q3ctf4's *13, along x.
    const ctf = bobber([['speed', '15'], ['phase', '0.3'], ['height', '664']], BOBBING_X_AXIS);
    expect([...times(ctf), ctf.s.pos.trDelta]).toEqual([15000, 4500, vec3(664, 0, 0)]);
    // lffd's *59, where doubles give 2799; and a bob every 0.7 s, 699 ms in doubles.
    expect(times(bobber([['phase', '.7']]))).toEqual([4000, 2800]);
    expect(times(bobber([['speed', '0.7']]))).toEqual([700, 0]);
    // A speed of 0 is `InitMover`'s 100.
    const still = bobber([['speed', '0'], ['phase', '0.25']]);
    expect([still.speed, ...times(still)]).toEqual([100, 100000, 25000]);
    // With no keys: every 4 s, 32 up and down, from the start, its damage 2.
    const plain = bobber([]);
    expect([...times(plain), plain.s.pos.trDelta, plain.damage]).toEqual([
      4000,
      0,
      vec3(0, 0, 32),
      2
    ]);
  });

  it("swings q3dm15's pendulums on the twin's period, by the gravity it was given", () => {
    const pendulum = (gravity: number, minsZ: number, phase: string) => {
      const { level, bounds } = boxLevel(gravity);
      bounds.mins.z = minsZ;
      const ent = level.spawnEntity();
      ent.model = '*1';
      spawnFuncPendulum(level, ent, [
        ['speed', '60'],
        ['phase', phase]
      ]);
      return ent.s.apos;
    };
    // Their feet at −296, spread a unit by the clip map's load.
    const swing = pendulum(800, -297, '.20');
    expect([swing.trDuration, swing.trTime]).toEqual([6630, 1326]);
    const third = pendulum(800, -297, '.60');
    expect([third.trDuration, third.trTime]).toEqual([6630, 3978]);
    const light = pendulum(400, -297, '.60');
    expect([light.trDuration, light.trTime]).toEqual([9377, 5626]);
    // From 0.7 of the way, where doubles start it at 4640.
    expect(pendulum(800, -297, '.7').trTime).toBe(4641);
    // An arm shorter than 8 is taken as 8.
    expect(pendulum(800, -3, '0').trDuration).toBe(1088);

    // With no keys: 30 degrees either way, from the start, its damage 2.
    const { level, bounds } = boxLevel();
    bounds.mins.z = -297;
    const plain = level.spawnEntity();
    plain.model = '*1';
    spawnFuncPendulum(level, plain, []);
    expect([plain.s.apos.trDelta, plain.s.apos.trTime, plain.damage]).toEqual([
      vec3(0, 0, 30),
      0,
      2
    ]);

    const rolls = [1326, 2983, 4000, 60000, 600000].map((time) => at(swing, time).z);
    expect(rolls).toEqual([0, 59.9999924, 34.2474785, -48.5911598, 57.3211136].map(f));
  });

  it("turns q3dm11's xraybig at 25 a second, in floats however long the level has run", () => {
    const turn: Trajectory = {
      trType: TR.LINEAR,
      trTime: 0,
      trDuration: 0,
      trBase: vec3(),
      trDelta: vec3(0, 25, 0)
    };
    expect([at(turn, 10008).y, at(turn, 600008).y]).toEqual([f(250.200012), f(15000.2012)]);
  });
});

/** A disc 256 across and 16 deep, its top at its origin, as an origin brush puts a model. */
const DISC: readonly [Vec3f, Vec3f] = [
  [-128, -128, -16],
  [128, 128, 0]
];

/** The first entity of a class, which a test's map spawned. */
function first(level: Level, classname: string): GameEntity {
  return level.find(null, 'classname', classname)!;
}

describe('func_rotating', () => {
  it('turns about z from the level start at its speed, linked about its origin', () => {
    const level = moverLevel(
      [DISC],
      [{ classname: 'func_rotating', model: '*1', origin: '0 0 64', speed: '25' }]
    );
    const disc = first(level, 'func_rotating');
    expect(disc.s.eType).toBe(ET.MOVER);
    expect(disc.r.svFlags).toBe(SVF.USE_CURRENT_ORIGIN);
    expect(disc.s.apos).toMatchObject({ trType: TR.LINEAR, trTime: 0, trDelta: vec3(0, 25, 0) });
    expect(disc.s.pos).toMatchObject({ trType: TR.STATIONARY, trBase: vec3(0, 0, 64) });
    expect(disc.r.currentOrigin).toEqual(vec3(0, 0, 64));
    expect(disc.r.linked).toBe(true);
    expect(disc.r.absmin).toEqual(vec3(-130, -130, 46));

    runUntil(level, 1000);
    expect(disc.r.currentAngles).toEqual(vec3(0, 25, 0));
    // Turned, it is linked as a cube of its radius.
    expect(disc.r.absmax.x).toBeGreaterThan(181);
  });

  it('turns about x for flag 4 and y for flag 8, at 100 unless told, from no turn', () => {
    const turned = (keys: Record<string, string>) => {
      const disc = { classname: 'func_rotating', model: '*1', angles: '0 45 0', ...keys };
      return first(moverLevel([DISC], [disc]), 'func_rotating');
    };
    expect(turned({}).s.apos.trDelta).toEqual(vec3(0, 100, 0));
    expect(turned({ spawnflags: String(ROTATING_X_AXIS) }).s.apos.trDelta).toEqual(vec3(0, 0, 100));
    expect(turned({ spawnflags: String(ROTATING_Y_AXIS) }).s.apos.trDelta).toEqual(vec3(100, 0, 0));
    // Its angles are never read, and its start-on flag is no different from none.
    expect(turned({ spawnflags: '1' }).s.apos.trBase).toEqual(vec3());
    expect([turned({}).damage, turned({ dmg: '7' }).damage]).toEqual([2, 7]);
  });

  it("carries a rider round, turning its view by each frame's turn cut short", () => {
    const level = moverLevel(
      [DISC],
      [{ classname: 'func_rotating', model: '*1', origin: '0 0 64', speed: '25' }]
    );
    const disc = first(level, 'func_rotating');
    const rider = clientAt(level, 0, vec3(100, 0, 88.125));
    rider.s.eType = ET.PLAYER;
    rider.s.groundEntityNum = disc.s.number;

    runUntil(level, 1000);
    const { origin, deltaAngles } = rider.client!.ps;
    // A quarter turn's 25 degrees about the disc's axis, at the radius it started at.
    expect(Math.hypot(origin.x, origin.y)).toBeCloseTo(100, 3);
    expect((Math.atan2(origin.y, origin.x) * 180) / Math.PI).toBeCloseTo(25, 3);
    expect(origin.z).toBe(88.125);
    // 0.2 degrees a frame is 36.4 of a turn's 65536ths, cut to 36: 24.7 degrees of view.
    expect(deltaAngles.y).toBe(36 * 125);
  });
});

describe('func_bobbing', () => {
  it('bobs its height either way of its origin, once every speed seconds, from its phase', () => {
    const record = newMoverRecord();
    const level = moverLevel(
      [DISC],
      [
        {
          classname: 'func_bobbing',
          model: '*1',
          origin: '0 0 64',
          speed: '2',
          height: '100',
          phase: '0.25',
          noise: 'sound/test/hum.wav'
        }
      ],
      record
    );
    const platform = first(level, 'func_bobbing');
    expect(platform.s.pos).toMatchObject({
      trType: TR.SINE,
      trTime: 500,
      trDuration: 2000,
      trBase: vec3(0, 0, 64),
      trDelta: vec3(0, 0, 100)
    });
    expect(platform.r.currentOrigin).toEqual(vec3(0, 0, 64));
    expect(platform.damage).toBe(2);

    runUntil(level, 1000);
    expect(platform.r.currentOrigin).toEqual(at(platform.s.pos, 1000));
    expect(platform.r.currentOrigin.z).toBe(164);
    // Its loop sound plays on, as nothing reaches its end.
    expect(platform.s.loopSound).toBe(1);
  });

  it("is the same as any mover when used: a binary one, from the world's origin", () => {
    const level = moverLevel(
      [DISC],
      [{ classname: 'func_bobbing', model: '*1', origin: '0 0 64', targetname: 'stop' }]
    );
    const platform = first(level, 'func_bobbing');
    runUntil(level, 104);
    platform.use!(platform, platform, null);
    runUntil(level, 200);
    expect(platform.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(platform.s.pos).toMatchObject({ trType: TR.LINEAR_STOP, trBase: vec3() });
    expect(platform.r.currentOrigin).toEqual(vec3());
  });
});

describe('func_pendulum', () => {
  it('swings its speed in degrees either way of its angles about its roll', () => {
    const level = moverLevel(
      [
        [
          [-16, -96, -296],
          [16, 96, 0]
        ]
      ],
      [
        {
          classname: 'func_pendulum',
          model: '*1',
          origin: '0 0 512',
          angle: '90',
          speed: '60',
          phase: '.20',
          dmg: '10'
        }
      ]
    );
    const pendulum = first(level, 'func_pendulum');
    expect(pendulum.s.apos).toMatchObject({
      trType: TR.SINE,
      trTime: 1326,
      trDuration: 6630,
      trBase: vec3(0, 90, 0),
      trDelta: vec3(0, 0, 60)
    });
    expect(pendulum.s.pos).toMatchObject({ trBase: vec3(0, 0, 512), trDuration: 1 });
    expect(pendulum.damage).toBe(10);

    runUntil(level, 2984);
    expect(pendulum.r.currentAngles).toEqual(at(pendulum.s.apos, 2984));
    expect(pendulum.r.currentAngles.z).toBeCloseTo(60, 2);
  });
});
