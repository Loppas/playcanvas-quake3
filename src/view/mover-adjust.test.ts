import { describe, expect, it } from 'vitest';

import {
  createEntityState,
  ENTITYNUM_MAX_NORMAL,
  ENTITYNUM_NONE,
  TR,
  type EntityState,
  type Trajectory
} from '../net/protocol';
import { Digest, Seeded } from '../sim/cm/collision-test-fixtures';
import { f } from '../sim/cm/q-math';
import { ET } from '../sim/game-entity';
import { vec3, type Vec3 } from '../sim/vec3';
import { adjustPositionForMover } from './mover-adjust';

/** The mover numbered 5, as the current snapshot has it. */
function moverWith(pos: Partial<Trajectory>, apos: Partial<Trajectory> = {}): EntityState {
  const mover = createEntityState(5);
  mover.eType = ET.MOVER;
  Object.assign(mover.pos, pos);
  Object.assign(mover.apos, apos);
  return mover;
}

/** The adjust of `input` and `angles` on mover 5 from one time to another, as new vectors. */
function carried(
  mover: EntityState | undefined,
  input: Vec3,
  fromTime: number,
  toTime: number,
  angles = vec3(),
  moverNum = 5
): { origin: Vec3; angles: Vec3 } {
  const origin = vec3();
  const anglesOut = vec3();
  const states = (number: number) => (number === mover?.number ? mover : undefined);
  adjustPositionForMover(input, moverNum, fromTime, toTime, states, origin, angles, anglesOut);
  return { origin, angles: anglesOut };
}

/**
 * The twin's `corpus3`: seeded movers, riders and times, made in floats as the twin's C makes
 * them, each rider carried, and the answers digested as the twin digests them.
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
  const randomTrajectory = (spread: number, rate: number): Trajectory => {
    let trType = pick(5);
    if (trType === TR.INTERPOLATE) trType = TR.SINE;
    const trTime = pick(1 << 22);
    const trDuration = 1 + pick(20000);
    const trBase = randomVec(-spread, spread);
    const trDelta = randomVec(-rate, rate);
    return { trType, trTime, trDuration, trBase, trDelta };
  };

  const digest = new Digest();
  const axes = ['x', 'y', 'z'] as const;
  for (let n = 0; n < count; n++) {
    const pos = randomTrajectory(4096, 1024);
    const apos = randomTrajectory(360, 180);
    // A turn about one axis alone, as `func_rotating`'s, a third of the time.
    if (pick(3) === 0) {
      const axis = pick(3);
      for (const other of [axes[(axis + 1) % 3], axes[(axis + 2) % 3]]) {
        apos.trBase[other] = 0;
        apos.trDelta[other] = 0;
      }
    }
    const input = randomVec(-4096, 4096);
    const angles = randomVec(-180, 180);
    const fromTime = pick(1 << 22);
    const toTime = fromTime + pick(400) - 100;
    const out = carried(moverWith(pos, apos), input, fromTime, toTime, angles);
    for (const v of [out.origin, out.angles]) digest.float(v.x).float(v.y).float(v.z);
  }
  return digest.hex();
}

describe("CG_AdjustPositionForMover, held to a twin of cgame's QVM", () => {
  // From `twin.exe corpus3 1 2000` and `corpus3 7 2000` (scratchpad `m4d/twin.c`): ioquake3's
  // CG_AdjustPositionForMover and its matrix with BG_EvaluateTrajectory, every literal a float.
  it.each([
    [1, 'c211fc6d'],
    [7, '85db262b']
  ])('matches the twin on seed %i', (seed, digest) => {
    expect(corpus(seed, 2000)).toBe(digest);
  });

  it("turns a rider round a disc's centre with it, and turns their angles", () => {
    const disc = moverWith({}, { trType: TR.LINEAR, trDelta: vec3(0, 36, 0) });
    const rider = vec3(64, 0, 32);
    expect(carried(disc, rider, 1000, 1008)).toEqual({
      origin: vec3(f(63.9991913), f(0.321700007), 32),
      angles: vec3(0, f(0.288002014), 0)
    });
    // Two and a half seconds on, a quarter turn.
    expect(carried(disc, rider, 1000, 3500)).toEqual({
      origin: vec3(f(-7.62939453e-6), 64, 32),
      angles: vec3(0, f(90.0000076), 0)
    });
  });

  it("carries a rider up q3dm19's bobber, and a door's across its stop", () => {
    const bobber = moverWith({
      trType: TR.SINE,
      trTime: 1980,
      trDuration: 6000,
      trDelta: vec3(0, 0, 405)
    });
    const ride = carried(bobber, vec3(-40, 536, 525), 2720, 2736);
    expect(ride.origin).toEqual(vec3(-40, 536, f(529.808289)));
    const door = moverWith({
      trType: TR.LINEAR_STOP,
      trTime: 400,
      trDuration: 1000,
      trBase: vec3(0, 0, 8),
      trDelta: vec3(0, 0, 100)
    });
    expect(carried(door, vec3(0, 0, f(0.1)), 1392, 1416).origin).toEqual(
      vec3(0, 0, f(0.899995446))
    );
  });

  it("turns all three of a rider's angles, as ioquake3's does, by a pendulum's roll", () => {
    const pendulum = moverWith(
      { trBase: vec3(100, 200, 300) },
      { trType: TR.SINE, trTime: 1326, trDuration: 3313, trDelta: vec3(0, 0, 60) }
    );
    expect(carried(pendulum, vec3(100, 260, 0), 2000, 2050, vec3(10, 95, 0))).toEqual({
      origin: vec3(100, f(267.208679), f(1.53225708)),
      angles: vec3(10, 95, f(1.38021851))
    });
  });
});

describe("what CG_AdjustPositionForMover won't carry", () => {
  const sliding = moverWith({ trType: TR.LINEAR, trDelta: vec3(100, 0, 0) });
  // Doubles, which a carry would round to floats.
  const input = vec3(0.1, 0.2, 0.3);
  const angles = vec3(1.1, 2.2, 3.3);

  it.each([
    ['nothing', 0],
    ['what is below it', -1],
    ['the world', ENTITYNUM_MAX_NORMAL],
    ['no entity', ENTITYNUM_NONE]
  ])('leaves what stands on %s, number %i, where it is', (_what, moverNum) => {
    const mover = { ...sliding, number: moverNum };
    expect(carried(mover, input, 0, 1000, angles, moverNum)).toEqual({ origin: input, angles });
  });

  it("leaves what stands on an entity the current snapshot hasn't got, or one not a mover", () => {
    expect(carried(undefined, input, 0, 1000, angles)).toEqual({ origin: input, angles });
    const player = { ...sliding, eType: ET.PLAYER };
    expect(carried(player, input, 0, 1000, angles)).toEqual({ origin: input, angles });
  });

  it('carries in place, the point and the angles written over', () => {
    const point = vec3(1, 2, 3);
    const turned = vec3(4, 5, 6);
    const states = () => sliding;
    adjustPositionForMover(point, 5, 0, 500, states, point, turned, turned);
    expect([point, turned]).toEqual([vec3(51, 2, 3), vec3(4, 5, 6)]);
  });
});
