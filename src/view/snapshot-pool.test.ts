import { describe, expect, it } from 'vitest';

import { createEntityState, createPlayerState, type EntityState } from '../net/protocol';
import { vec3 } from '../sim/vec3';
import type { SourceSnapshot } from './player-view';
import { SnapshotPool } from './snapshot-pool';

/** An entity `number`, standing at x = `x`. */
function entity(number: number, x: number): EntityState {
  const state = createEntityState();
  state.number = number;
  state.pos.trBase = vec3(x, 0, 24);
  return state;
}

/**
 * A snapshot from the client's ring, taken at `serverTime`, the player standing at x = `x`, its
 * areamask beginning with `bytes`.
 */
function source(
  serverTime: number,
  x: number,
  entities: EntityState[],
  ...bytes: number[]
): SourceSnapshot {
  const ps = createPlayerState();
  ps.origin = vec3(x, 0, 24);
  const areamask = new Uint8Array(32);
  areamask.set(bytes);
  const serverCommandNum = serverTime / 50;
  return { snapFlags: 4, ping: 0, serverTime, serverCommandNum, areamask, ps, entities };
}

describe('SnapshotPool', () => {
  it("copies a snapshot whole, its entities by number too, sharing nothing with the ring's", () => {
    const from = source(1000, 64, [entity(3, 100), entity(7, 200)]);
    const copy = new SnapshotPool().copy(from);

    from.ps.origin.x = -1;
    from.entities[1].pos.trBase.x = -1;
    from.entities[1].eFlags = 1;

    expect(copy).toMatchObject({ snapFlags: 4, serverTime: 1000, serverCommandNum: 20 });
    expect(copy.ps.origin.x).toBe(64);
    expect(copy.entities.map((state) => [state.number, state.pos.trBase.x])).toEqual([
      [3, 100],
      [7, 200]
    ]);
    expect(copy.entities[1].eFlags).toBe(0);
    expect(copy.byNumber.get(7)).toBe(copy.entities[1]);
    expect(copy.byNumber.get(5)).toBeUndefined();
  });

  it('copies the areamask, its every byte, into a mask of its own', () => {
    const pool = new SnapshotPool();
    const from = source(1000, 64, [], 0xfb, 0xff);
    const copy = pool.copy(from);
    from.areamask.fill(0);

    expect(copy.areamask).not.toBe(from.areamask);
    expect(Array.from(copy.areamask.subarray(0, 3))).toEqual([0xfb, 0xff, 0]);

    // Copied again over one let go of, a mask of fewer bytes leaves none of the last behind.
    pool.release([]);
    const next = pool.copy(source(1050, 64, [], 0xeb));
    expect(next).toBe(copy);
    expect(Array.from(next.areamask.subarray(0, 3))).toEqual([0xeb, 0, 0]);
  });

  it('keeps each copy its own until it is released', () => {
    const pool = new SnapshotPool();
    const first = pool.copy(source(1000, 64, [entity(3, 100)]));
    const second = pool.copy(source(1050, 80, [entity(3, 116)]));

    expect(second).not.toBe(first);
    expect(first.ps.origin.x).toBe(64);
    expect(first.entities[0]).not.toBe(second.entities[0]);
    expect(first.byNumber.get(3)?.pos.trBase.x).toBe(100);
  });

  it('never writes over a copy still held', () => {
    const pool = new SnapshotPool();
    const held = pool.copy(source(1000, 64, [entity(3, 100)]));
    pool.copy(source(1050, 80, [entity(3, 116)]));
    pool.release([null, held, undefined]);

    const later = [1100, 1150].map((time) => pool.copy(source(time, 96, [entity(3, 132)])));

    expect(later).not.toContain(held);
    expect(held).toMatchObject({ serverTime: 1000 });
    expect(held.ps.origin.x).toBe(64);
    expect(held.byNumber.get(3)?.pos.trBase.x).toBe(100);
  });

  it('writes over one let go of, which forgets the entities it had', () => {
    const pool = new SnapshotPool();
    const first = pool.copy(source(1000, 64, [entity(3, 100), entity(7, 200)]));
    pool.release([]);

    const next = pool.copy(source(1050, 80, [entity(5, 150)]));

    expect(next).toBe(first);
    expect(next).toMatchObject({ serverTime: 1050 });
    expect(next.entities.map((state) => state.number)).toEqual([5]);
    expect(next.byNumber.get(5)?.pos.trBase.x).toBe(150);
    expect(next.byNumber.get(3)).toBeUndefined();
    expect(next.byNumber.get(7)).toBeUndefined();
  });

  it('copies more entities into one that held fewer', () => {
    const pool = new SnapshotPool();
    pool.copy(source(1000, 64, [entity(3, 100)]));
    pool.release([]);

    const next = pool.copy(source(1050, 80, [entity(3, 116), entity(4, 216), entity(9, 316)]));

    expect(next.entities.map((state) => [state.number, state.pos.trBase.x])).toEqual([
      [3, 116],
      [4, 216],
      [9, 316]
    ]);
    expect(new Set(next.entities).size).toBe(3);
    expect(next.byNumber.get(9)).toBe(next.entities[2]);
  });
});
