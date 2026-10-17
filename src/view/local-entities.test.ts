import { describe, expect, it } from 'vitest';

import { LocalEntities, MAX_LOCAL_ENTITIES, type LocalEntity } from './local-entities';

/** A pool with `n` places taken, oldest first. */
function taken(n: number): { pool: LocalEntities; places: LocalEntity[] } {
  const pool = new LocalEntities();
  const places = Array.from({ length: n }, () => pool.alloc());
  return { pool, places };
}

describe('CG_AllocLocalEntity', () => {
  it('holds a place for each local entity, up to 512', () => {
    const { pool, places } = taken(MAX_LOCAL_ENTITIES);
    expect(pool.count).toBe(512);
    expect(places.some((place) => place.freed)).toBe(false);
  });

  it('frees the oldest for a new one once all 512 are held', () => {
    const { pool, places } = taken(MAX_LOCAL_ENTITIES);
    const newest = pool.alloc();
    expect(pool.count).toBe(512);
    expect([places[0].freed, places[1].freed, newest.freed]).toEqual([true, false, false]);
    pool.alloc();
    expect(places[1].freed).toBe(true);
  });

  it('numbers each place by how many were made before it, which orders it in a scene', () => {
    const { pool, places } = taken(3);
    expect(places.map((place) => place.serial)).toEqual([0, 1, 2]);
    pool.free(places[1]);
    expect(pool.alloc().serial).toBe(3);
  });

  it('frees the oldest still held, past any given back before it', () => {
    const { pool, places } = taken(MAX_LOCAL_ENTITIES);
    pool.free(places[0]);
    pool.free(places[2]);
    pool.alloc();
    pool.alloc();
    expect(places.slice(0, 4).map((place) => place.freed)).toEqual([true, false, true, false]);
    pool.alloc();
    expect(places.slice(0, 4).map((place) => place.freed)).toEqual([true, true, true, false]);
    expect(pool.count).toBe(512);
  });
});

describe('CG_FreeLocalEntity', () => {
  it('keeps the order of those still held when the newest or the oldest is given back', () => {
    const { pool, places } = taken(3);
    pool.free(places[2]);
    pool.free(places[0]);
    const newer = pool.alloc();
    pool.clear();
    expect([places[1].freed, newer.freed, pool.count]).toEqual([true, true, 0]);
  });

  it('gives a place back once, however often it is given', () => {
    const { pool, places } = taken(3);
    pool.free(places[1]);
    pool.free(places[1]);
    expect([pool.count, places[1].freed]).toEqual([2, true]);
  });
});

describe('CG_InitLocalEntities', () => {
  it('frees every place, and starts again from none', () => {
    const { pool, places } = taken(5);
    pool.clear();
    expect([pool.count, places.every((place) => place.freed)]).toEqual([0, true]);
    // A place freed before the clear stays freed, and the pool takes new ones as from empty.
    expect(pool.alloc().freed).toBe(false);
    expect(pool.count).toBe(1);
  });
});
