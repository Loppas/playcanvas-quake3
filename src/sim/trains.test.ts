import { describe, expect, it } from 'vitest';

import { ENTITYNUM_WORLD, TR } from '../net/protocol';
import { Digest, Seeded } from './cm/collision-test-fixtures';
import { f, type Vec3f } from './cm/q-math';
import { ET, MOVER, SVF, type GameEntity } from './game-entity';
import { Level } from './level';
import type { TestEntity } from './map-test-fixtures';
import { moverLevel, newMoverRecord } from './mover-test-fixtures';
import { reachedTrain } from './trains';
import { clientAt, runUntil, useRecorder } from './trigger-test-fixtures';
import { copy, vec3, type Vec3 } from './vec3';

/** A train's leg from `from` to `to`, worked out at `time` as `Reached_Train` works it out. */
function leg(
  level: Level,
  { speed, from, to, cornerSpeed = 0, cornerWait = 0, time }: LegKeys
): GameEntity {
  const train = level.spawnEntity();
  train.speed = speed;
  const start = level.spawnEntity();
  const end = level.spawnEntity();
  start.s.origin = from;
  start.speed = cornerSpeed;
  start.wait = cornerWait;
  end.s.origin = to;
  start.nextTrain = end;
  end.nextTrain = start;
  train.nextTrain = start;
  level.time = time;
  reachedTrain(level, train);
  return train;
}

interface LegKeys {
  speed: number;
  from: Vec3;
  to: Vec3;
  cornerSpeed?: number;
  cornerWait?: number;
  time: number;
}

/**
 * The twin's `corpus2` trains: seeded legs, a train's speed or its default, two corners or one
 * twice, a corner's speed and wait or none, at any time, each made in floats as the twin's C makes
 * it, and digested as the twin digests it.
 */
function corpus(seed: number, count: number): string {
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

  const level = new Level();
  const digest = new Digest();
  const vecInto = (v: Vec3) => digest.float(v.x).float(v.y).float(v.z);
  for (let n = 0; n < count; n++) {
    const speed = pick(4) === 0 ? 100 : uniformIn(0, 1000);
    const from = randomVec(-4096, 4096);
    const to = pick(8) === 0 ? copy(from) : randomVec(-4096, 4096);
    const cornerSpeed = pick(2) ? 0 : uniformIn(0, 1000);
    const cornerWait = pick(2) ? 0 : uniformIn(-2, 60);
    const time = pick(1 << 22);

    const train = leg(level, { speed, from, to, cornerSpeed, cornerWait, time });
    digest.int(train.s.pos.trDuration).int(train.s.pos.trType);
    vecInto(train.s.pos.trDelta);
    vecInto(train.r.currentOrigin);
    digest.int(train.nextthink).int(train.r.svFlags & SVF.NOCLIENT ? 1 : 0);

    // Freed at the level's start, so the slots are taken again at once.
    level.time = 0;
    for (const entity of [train, train.nextTrain!, train.nextTrain!.nextTrain!]) {
      level.freeEntity(entity);
    }
  }
  return digest.hex();
}

describe("a train's legs, held to a twin of the QVM's", () => {
  // From `twin.exe corpus2 1 2000` and `corpus2 7 2000` (scratchpad `m4c/twin.c`): ioquake3's
  // Reached_Train with every literal a float, as q3lcc's are.
  it.each([
    [1, 'f6c49183'],
    [7, 'e9f0bac0']
  ])('matches the twin on seed %i', (seed, trains) => {
    expect(corpus(seed, 2000)).toBe(trains);
  });

  it("runs tig_gng's raft 208 units at 80 in 2600 ms, at 80 exactly, out and back", () => {
    const level = new Level();
    const out = leg(level, {
      speed: 80,
      from: vec3(3328, -104, -8),
      to: vec3(3536, -104, -8),
      time: 100
    });
    expect(out.s.pos).toMatchObject({
      trType: TR.LINEAR_STOP,
      trTime: 100,
      trDuration: 2600,
      trBase: vec3(3328, -104, -8),
      trDelta: vec3(80, 0, 0)
    });
    expect(out.moverState).toBe(MOVER.ONE_TO_TWO);
    expect(out.r.currentOrigin).toEqual(vec3(3328, -104, -8));

    const back = leg(level, {
      speed: 80,
      from: vec3(3536, -104, -8),
      to: vec3(3328, -104, -8),
      time: 2704
    });
    expect([back.s.pos.trDuration, back.s.pos.trDelta]).toEqual([2600, vec3(-80, 0, 0)]);
  });

  it('makes a leg of no length a millisecond long, unsent for it, as ioquake3 does', () => {
    const train = leg(new Level(), { speed: 100, from: vec3(), to: vec3(), time: 1000 });
    expect([train.s.pos.trDuration, train.s.pos.trDelta]).toEqual([1, vec3()]);
    expect(train.r.svFlags & SVF.NOCLIENT).toBe(SVF.NOCLIENT);
  });

  it("holds at a corner its wait in floats, and takes a corner's speed of at least 1", () => {
    const level = new Level();
    const held = leg(level, {
      speed: 250,
      from: vec3(),
      to: vec3(100, 0, 0),
      cornerWait: f(0.7),
      time: 400
    });
    // 0.7 s is 700 ms in floats, where doubles make it 699.
    expect([held.nextthink, held.s.pos.trType]).toEqual([1100, TR.STATIONARY]);

    const slow = leg(level, {
      speed: 250,
      from: vec3(),
      to: vec3(100, 0, 0),
      cornerSpeed: 0.5,
      cornerWait: 45,
      time: 400
    });
    expect([slow.nextthink, slow.s.pos.trDuration]).toEqual([45400, 100000]);
  });
});

/** A raft 64 square and 8 deep, its top at its origin, as an origin brush puts a train's model. */
const RAFT: readonly [Vec3f, Vec3f] = [
  [-32, -32, -8],
  [32, 32, 0]
];

/** A train on {@link RAFT} round these corners, the first two at 64 up, 200 apart along x. */
function shuttle(
  train: Record<string, string> = {},
  first: Record<string, string> = {},
  more: TestEntity[] = []
): TestEntity[] {
  return [
    { classname: 'func_train', model: '*1', target: 't1', speed: '100', ...train },
    { classname: 'path_corner', targetname: 't1', target: 't2', origin: '0 0 64', ...first },
    { classname: 'path_corner', targetname: 't2', target: 't1', origin: '200 0 64' },
    ...more
  ];
}

/** The first entity of a class, which a test's map spawned. */
function first(level: Level, classname: string): GameEntity {
  return level.find(null, 'classname', classname)!;
}

describe('func_train', () => {
  it('waits at the world origin, and a frame in jumps to its first corner and sets off', () => {
    const level = moverLevel([RAFT], shuttle());
    const train = first(level, 'func_train');
    expect(train.s.eType).toBe(ET.MOVER);
    expect(train.r.linked).toBe(true);
    expect(train.r.currentOrigin).toEqual(vec3());
    expect(train.s.pos.trType).toBe(TR.STATIONARY);
    expect(train.nextthink).toBe(100);

    runUntil(level, 104);
    const t2 = level.find(null, 'targetname', 't2')!;
    expect(train.s.pos).toMatchObject({
      trType: TR.LINEAR_STOP,
      trTime: 104,
      trDuration: 2000,
      trBase: vec3(0, 0, 64),
      trDelta: vec3(100, 0, 0)
    });
    expect(train.r.currentOrigin).toEqual(vec3(0, 0, 64));
    expect(train.nextTrain).toBe(t2);
  });

  it('turns at each corner on the frame that finds it there, round its loop for ever', () => {
    const level = moverLevel([RAFT], shuttle());
    const train = first(level, 'func_train');

    // 1.992 s at 100, in floats.
    runUntil(level, 2096);
    expect(train.r.currentOrigin).toEqual(vec3(f(199.200012), 0, 64));
    runUntil(level, 2104);
    expect(train.s.pos).toMatchObject({
      trTime: 2104,
      trBase: vec3(200, 0, 64),
      trDelta: vec3(-100, 0, 0)
    });
    runUntil(level, 4104);
    expect(train.s.pos).toMatchObject({
      trTime: 4104,
      trBase: vec3(0, 0, 64),
      trDelta: vec3(100, 0, 0)
    });
  });

  it("takes the leg from a corner at the corner's speed, which is at least 1", () => {
    const fast = moverLevel([RAFT], shuttle({}, { speed: '400' }));
    runUntil(fast, 104);
    expect(first(fast, 'func_train').s.pos.trDuration).toBe(500);

    const crawl = moverLevel([RAFT], shuttle({}, { speed: '0.5' }));
    runUntil(crawl, 104);
    expect(first(crawl, 'func_train').s.pos.trDuration).toBe(200000);
  });

  it("holds at a corner with a wait, and sets off when the wait's think runs", () => {
    const level = moverLevel([RAFT], shuttle({}, { wait: '1.5' }));
    const train = first(level, 'func_train');

    runUntil(level, 104);
    expect(train.s.pos).toMatchObject({ trType: TR.STATIONARY, trBase: vec3(0, 0, 64) });
    expect(train.nextthink).toBe(1604);

    runUntil(level, 1600);
    expect(train.s.pos.trType).toBe(TR.STATIONARY);
    runUntil(level, 1608);
    expect(train.s.pos).toMatchObject({ trType: TR.LINEAR_STOP, trTime: 1608 });
    expect(train.r.currentOrigin).toEqual(vec3(0, 0, 64));
    runUntil(level, 3608);
    expect(train.s.pos).toMatchObject({ trTime: 3608, trBase: vec3(200, 0, 64) });
  });

  it("fires a corner's other targets as no one when it reaches the corner", () => {
    const level = moverLevel([RAFT], shuttle());
    const fired = useRecorder(level, 't2');
    const t1 = level.find(null, 'targetname', 't1')!;

    runUntil(level, 104);
    expect(fired).toEqual([{ other: t1.s.number, activator: null }]);
    runUntil(level, 2104);
    expect(fired).toHaveLength(1);
    runUntil(level, 4104);
    expect(fired).toEqual([
      { other: t1.s.number, activator: null },
      { other: t1.s.number, activator: null }
    ]);
  });

  it('runs to the first path_corner among the names, past anything else so named', () => {
    const level = moverLevel(
      [RAFT],
      [
        { classname: 'func_train', model: '*1', target: 't1' },
        { classname: 'path_corner', targetname: 't1', target: 't2', origin: '0 0 64' },
        { classname: 'target_relay', targetname: 't2' },
        { classname: 'path_corner', targetname: 't2', target: 't1', origin: '200 0 64' }
      ]
    );
    runUntil(level, 104);
    const train = first(level, 'func_train');
    expect(train.nextTrain!.classname).toBe('path_corner');
    expect(train.s.pos.trDelta).toEqual(vec3(100, 0, 0));
  });

  it('makes a leg of no length a millisecond, unsent, and sends the train again after it', () => {
    const level = moverLevel(
      [RAFT],
      [
        { classname: 'func_train', model: '*1', target: 't1' },
        { classname: 'path_corner', targetname: 't1', target: 't2', origin: '0 0 64' },
        { classname: 'path_corner', targetname: 't2', target: 't3', origin: '0 0 64' },
        { classname: 'path_corner', targetname: 't3', target: 't1', origin: '200 0 64' }
      ]
    );
    const train = first(level, 'func_train');

    runUntil(level, 104);
    expect(train.s.pos.trDuration).toBe(1);
    expect(train.r.svFlags & SVF.NOCLIENT).toBe(SVF.NOCLIENT);
    runUntil(level, 112);
    expect(train.s.pos).toMatchObject({ trTime: 112, trDuration: 2000 });
    expect(train.r.svFlags).toBe(SVF.USE_CURRENT_ORIGIN);
  });

  it('loses its loop sound at its first corner, as a corner has none to give it', () => {
    const record = newMoverRecord();
    const level = moverLevel([RAFT], shuttle({ noise: 'sound/test/hum.wav' }), record);
    const train = first(level, 'func_train');
    expect(record.sounds).toEqual(['sound/test/hum.wav']);
    expect(train.s.loopSound).toBe(1);
    runUntil(level, 104);
    expect(train.s.loopSound).toBe(0);
  });

  it('clears its angles, and runs at 100 and damages 2 unless the map says otherwise', () => {
    const unkeyed = moverLevel([RAFT], shuttle({ speed: '0', angles: '10 90 0' }));
    const plain = first(unkeyed, 'func_train');
    expect([plain.s.angles, plain.speed, plain.damage]).toEqual([vec3(), 100, 2]);

    const keyed = first(moverLevel([RAFT], shuttle({ speed: '60', dmg: '5' })), 'func_train');
    expect([keyed.speed, keyed.damage]).toEqual([60, 5]);

    // "BLOCK_STOPS" takes the damage away, which no train reads.
    const stops = first(moverLevel([RAFT], shuttle({ spawnflags: '4', dmg: '5' })), 'func_train');
    expect(stops.damage).toBe(0);
  });

  it("says where a train's path breaks off, and leaves the train where it is", () => {
    const cases: [TestEntity[], string][] = [
      [
        [{ classname: 'func_train', model: '*1', target: 'nowhere' }],
        'func_train at (-34 -34 -10) with an unfound target'
      ],
      [
        [
          { classname: 'func_train', model: '*1', target: 't1' },
          { classname: 'path_corner', targetname: 't1', origin: '0 0 64' }
        ],
        'Train corner at (0 0 64) without a target'
      ],
      [
        [
          { classname: 'func_train', model: '*1', target: 't1' },
          { classname: 'path_corner', targetname: 't1', target: 'x', origin: '0 0 64' },
          { classname: 'info_notnull', targetname: 'x' }
        ],
        'Train corner at (0 0 64) without a target path_corner'
      ]
    ];
    for (const [entities, said] of cases) {
      const record = newMoverRecord();
      const level = moverLevel([RAFT], entities, record);
      runUntil(level, 2000);
      const train = first(level, 'func_train');
      expect(record.prints).toContain(said);
      expect(train.r.currentOrigin, said).toEqual(vec3());
      expect(train.s.pos.trType, said).toBe(TR.STATIONARY);
    }
  });

  it('frees a train with no target, said to be at the origin, as it has no bounds yet', () => {
    const record = newMoverRecord();
    const train = { classname: 'func_train', model: '*1', origin: '5 6 7' };
    const level = moverLevel([RAFT], [train], record);
    expect(level.find(null, 'classname', 'func_train')).toBeNull();
    expect(record.prints).toEqual([
      'func_train without a target at (0 0 0)',
      '0 teams with 0 entities'
    ]);
  });

  it('stops for what it cannot push, and waits there, hurting no one', () => {
    // A train the raft's width, 64 tall, along the floor towards a wall a player stands against.
    const level = moverLevel(
      [
        [
          [-32, -32, 0],
          [32, 32, 64]
        ],
        [
          [96, -64, 0],
          [128, 64, 128]
        ]
      ],
      [
        { classname: 'func_train', model: '*1', target: 't1' },
        { classname: 'path_corner', targetname: 't1', target: 't2', origin: '0 0 0' },
        { classname: 'path_corner', targetname: 't2', target: 't1', origin: '400 0 0' },
        { classname: 'func_static', model: '*2' }
      ]
    );
    const train = first(level, 'func_train');
    const player = clientAt(level, 0, vec3(80, 0, 24.125));
    player.s.eType = ET.PLAYER;
    player.s.groundEntityNum = ENTITYNUM_WORLD;

    runUntil(level, 800);
    const stopped = copy(train.r.currentOrigin);
    expect(stopped.x).toBeGreaterThan(32);
    expect(stopped.x).toBeLessThan(34);
    runUntil(level, 1200);
    expect(train.r.currentOrigin).toEqual(stopped);
    expect(train.s.pos.trTime).toBeGreaterThan(104);
    expect(player.client!.ps.origin.x).toBeLessThan(81);
    expect(player.health).toBe(100);
  });
});

describe('path_corner', () => {
  it('stands unlinked where the map put it, and is freed with a word if it has no name', () => {
    const record = newMoverRecord();
    const level = moverLevel(
      [RAFT],
      [
        { classname: 'path_corner', targetname: 'kept', origin: '1 2 3' },
        { classname: 'path_corner', origin: '5 6 7' }
      ],
      record
    );
    const kept = first(level, 'path_corner');
    expect(kept.targetname).toBe('kept');
    expect(kept.r.linked).toBe(false);
    expect(kept.s.origin).toEqual(vec3(1, 2, 3));
    expect(level.find(kept, 'classname', 'path_corner')).toBeNull();
    expect(record.prints[0]).toBe('path_corner with no targetname at (5 6 7)');
  });
});
