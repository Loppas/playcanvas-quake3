import { describe, expect, it } from 'vitest';

import { TR, createTrajectory, type Trajectory } from '../net/protocol';
import { DEFAULT_GRAVITY } from './constants';
import { evaluateTrajectory, evaluateTrajectoryDelta } from './trajectory';
import { vec3 } from './vec3';
import { MISSILE_GRAVITY } from './weapons/constants';

/**
 * The one formula everything in the world moves by, on both sides of the wire.
 */

/** A trajectory of the given kind, starting at the origin and moving along +X. */
function moving(trType: number, overrides: Partial<Trajectory> = {}): Trajectory {
  return { ...createTrajectory(), trType, trDelta: vec3(100, 0, 0), ...overrides };
}

describe('evaluateTrajectory', () => {
  it('leaves a stationary thing where it was, however long it is asked about', () => {
    const at = moving(TR.STATIONARY, { trBase: vec3(1, 2, 3) });
    expect(evaluateTrajectory(at, 0)).toEqual(vec3(1, 2, 3));
    expect(evaluateTrajectory(at, 100_000)).toEqual(vec3(1, 2, 3));
  });

  it('leaves an interpolated thing where it was too, because it is the client that moves it', () => {
    // `TR_INTERPOLATE` is a player or a corpse: the server sends where it is each snapshot and
    // the client slides between two of them, so the formula has nothing to work out.
    const at = moving(TR.INTERPOLATE, { trBase: vec3(1, 2, 3) });
    expect(evaluateTrajectory(at, 5000)).toEqual(vec3(1, 2, 3));
  });

  it('carries a linear thing at its rate, in units per second', () => {
    expect(evaluateTrajectory(moving(TR.LINEAR), 1000)).toEqual(vec3(100, 0, 0));
    expect(evaluateTrajectory(moving(TR.LINEAR), 250)).toEqual(vec3(25, 0, 0));
  });

  it('measures from trTime, which a bounce moves', () => {
    const bounced = moving(TR.LINEAR, { trTime: 500, trBase: vec3(10, 0, 0) });
    expect(evaluateTrajectory(bounced, 500)).toEqual(vec3(10, 0, 0));
    expect(evaluateTrajectory(bounced, 1500)).toEqual(vec3(110, 0, 0));
  });

  it('reads a time before trTime as going backwards, which the prestep relies on', () => {
    // `fire_rocket` dates a missile 50 ms in the past so that its first frame is a long one.
    const prestepped = moving(TR.LINEAR, { trTime: -50 });
    expect(evaluateTrajectory(prestepped, 0)).toEqual(vec3(5, 0, 0));
  });

  it('drops a falling thing by half g t squared', () => {
    const grenade = moving(TR.GRAVITY, { trDelta: vec3(0, 0, 100) });
    // One second up at 100 ups, less 400 of fall.
    expect(evaluateTrajectory(grenade, 1000)).toEqual(vec3(0, 0, 100 - 0.5 * 800));
  });

  it("falls at 800 whatever the world's gravity is", () => {
    // Quake 3 writes the constant into the evaluator and ignores `g_gravity`, so a grenade arcs
    // the same way on a map that has changed it. The two constants agree here only by default.
    expect(MISSILE_GRAVITY).toBe(800);
    expect(MISSILE_GRAVITY).toBe(DEFAULT_GRAVITY);
  });

  it('stops a linear-stop thing at its duration, and never before its start', () => {
    const door = moving(TR.LINEAR_STOP, { trTime: 100, trDuration: 1000 });
    expect(evaluateTrajectory(door, 0)).toEqual(vec3(0, 0, 0));
    expect(evaluateTrajectory(door, 600)).toEqual(vec3(50, 0, 0));
    expect(evaluateTrajectory(door, 1100)).toEqual(vec3(100, 0, 0));
    expect(evaluateTrajectory(door, 99_999)).toEqual(vec3(100, 0, 0));
  });

  it('swings a sine thing through its duration', () => {
    const bob = moving(TR.SINE, { trDuration: 1000 });
    expect(evaluateTrajectory(bob, 0).x).toBeCloseTo(0, 6);
    expect(evaluateTrajectory(bob, 250).x).toBeCloseTo(100, 6);
    expect(evaluateTrajectory(bob, 750).x).toBeCloseTo(-100, 6);
  });

  it('refuses a trajectory type it does not know, rather than leaving it where it was', () => {
    expect(() => evaluateTrajectory(moving(99), 0)).toThrow(/unknown trType/);
  });
});

describe('evaluateTrajectoryDelta', () => {
  it('gives nothing for something that is not moving', () => {
    expect(evaluateTrajectoryDelta(moving(TR.STATIONARY), 500)).toEqual(vec3());
    expect(evaluateTrajectoryDelta(moving(TR.INTERPOLATE), 500)).toEqual(vec3());
  });

  it('gives the stored rate for a linear thing, whenever it is asked', () => {
    expect(evaluateTrajectoryDelta(moving(TR.LINEAR), 0)).toEqual(vec3(100, 0, 0));
    expect(evaluateTrajectoryDelta(moving(TR.LINEAR), 9999)).toEqual(vec3(100, 0, 0));
  });

  it('gives a falling thing the speed gravity has given it, not the one it was thrown at', () => {
    // This is the whole reason the derivative exists. Reflecting the stored rate off a surface
    // instead would make a grenade bounce back up to its throwing speed however far it fell.
    const grenade = moving(TR.GRAVITY, { trDelta: vec3(0, 0, 100) });
    expect(evaluateTrajectoryDelta(grenade, 0)).toEqual(vec3(0, 0, 100));
    expect(evaluateTrajectoryDelta(grenade, 1000)).toEqual(vec3(0, 0, 100 - 800));
  });

  it('gives nothing once a linear-stop thing has arrived', () => {
    const door = moving(TR.LINEAR_STOP, { trDuration: 1000 });
    expect(evaluateTrajectoryDelta(door, 500)).toEqual(vec3(100, 0, 0));
    expect(evaluateTrajectoryDelta(door, 1001)).toEqual(vec3());
  });
});
