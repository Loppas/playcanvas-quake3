import { describe, expect, it } from 'vitest';
import { vec3 } from '../sim/vec3';
import { WP, type WeaponId } from '../sim/weapons/constants';
import type { WorldEffect } from './entity-events';
import { ID_MISSILE_LOOKS } from './effects';
import { EXPLOSION_SKEW_MS, Explosions, explosionOrigin } from './explosions';
import { LocalEntities, MAX_LOCAL_ENTITIES } from './local-entities';

/** A shot's impact on a wall facing -x. */
function impact(weapon: WeaponId): WorldEffect {
  return { type: 'impact', weapon, origin: vec3(100, 0, 30), normal: vec3(-1, 0, 0) };
}

describe('Explosions (CG_MakeExplosion and the local entities)', () => {
  it("starts an explosion for an impact that makes one, with its weapon's life and kind", () => {
    const explosions = new Explosions(() => 0);
    explosions.update([impact(WP.ROCKET_LAUNCHER), impact(WP.RAILGUN)], 1000);
    expect(explosions.live).toEqual([
      {
        weapon: WP.ROCKET_LAUNCHER,
        origin: vec3(100, 0, 30),
        normal: vec3(-1, 0, 0),
        startTime: 1000,
        durationMs: 1000,
        sprite: true,
        shaderOf: WP.ROCKET_LAUNCHER,
        scale: 1,
        serial: 0
      },
      {
        weapon: WP.RAILGUN,
        origin: vec3(100, 0, 30),
        normal: vec3(-1, 0, 0),
        startTime: 1000,
        durationMs: 600,
        sprite: false,
        shaderOf: WP.RAILGUN,
        scale: 1,
        serial: 1
      }
    ]);
  });

  it("draws the BFG's impact bare where the serverinfo's BFG has no blast, as CPMA's does", () => {
    const explosions = new Explosions(() => 0);
    explosions.update([impact(WP.BFG)], 0);
    explosions.update([impact(WP.BFG)], 0, { ...ID_MISSILE_LOOKS, bfgSplashRadius: 0 });
    const [id, bare] = explosions.live;
    expect([id.sprite, id.shaderOf, id.durationMs]).toEqual([true, WP.BFG, 600]);
    // Its own model, as a model, in the railgun's explosion shader.
    expect([bare.sprite, bare.shaderOf, bare.durationMs]).toEqual([false, WP.RAILGUN, 600]);
  });

  it("scales the plasma's ring by the serverinfo's mark over 16, and nothing else's", () => {
    const explosions = new Explosions(() => 0);
    const looks = { ...ID_MISSILE_LOOKS, plasmaMarkSize: 8 };
    explosions.update([impact(WP.PLASMAGUN), impact(WP.RAILGUN)], 0);
    explosions.update([impact(WP.PLASMAGUN), impact(WP.RAILGUN)], 0, looks);
    expect(explosions.live.map((explosion) => explosion.scale)).toEqual([1, 1, 0.5, 1]);
  });

  it('makes none for the lightning gun, whose impact is drawn with its beam, or for anything else', () => {
    const explosions = new Explosions(() => 0);
    // The rail's beam is its own effect: the ring is its impact's.
    const beam: WorldEffect = {
      type: 'beam',
      weapon: WP.RAILGUN,
      start: vec3(),
      end: vec3(100, 0, 30),
      hit: true,
      own: false,
      color: [1, 0, 0]
    };
    explosions.update([impact(WP.LIGHTNING), beam, { type: 'puff', origin: vec3() }], 0);
    expect(explosions.live).toEqual([]);
  });

  it('sets its start back by rand() & 63, "so they aren\'t all in sync"', () => {
    const explosions = new Explosions(() => 0.999);
    explosions.update([impact(WP.ROCKET_LAUNCHER)], 1000);
    expect(explosions.live[0].startTime).toBe(1000 - EXPLOSION_SKEW_MS);
  });

  it('lets one go once its time is up, and keeps the rest oldest first', () => {
    const explosions = new Explosions(() => 0);
    explosions.update([impact(WP.RAILGUN)], 0);
    explosions.update([impact(WP.ROCKET_LAUNCHER)], 100);
    explosions.update([], 599);
    expect(explosions.live.map((explosion) => explosion.weapon)).toEqual([
      WP.RAILGUN,
      WP.ROCKET_LAUNCHER
    ]);
    explosions.update([], 600);
    expect(explosions.live.map((explosion) => explosion.weapon)).toEqual([WP.ROCKET_LAUNCHER]);
    explosions.update([], 1100);
    expect(explosions.live).toEqual([]);
  });

  it('lets every one go on a restart, and any a clock set back would start in the future', () => {
    const explosions = new Explosions(() => 0);
    explosions.update([impact(WP.ROCKET_LAUNCHER)], 5000);
    explosions.update([], 100);
    expect(explosions.live).toEqual([]);
    explosions.update([impact(WP.ROCKET_LAUNCHER)], 200);
    explosions.clear();
    expect(explosions.live).toEqual([]);
  });

  it('holds a local entity for each one playing, and gives it back as it goes', () => {
    const pool = new LocalEntities();
    const explosions = new Explosions(() => 0, pool);
    explosions.update([impact(WP.RAILGUN), impact(WP.ROCKET_LAUNCHER)], 0);
    expect(pool.count).toBe(2);
    explosions.update([], 600);
    expect(pool.count).toBe(1);
    explosions.clear();
    expect(pool.count).toBe(0);
  });

  it('lets the oldest go when the pool frees its place for a newer local entity', () => {
    const pool = new LocalEntities();
    const explosions = new Explosions(() => 0, pool);
    explosions.update([impact(WP.RAILGUN)], 0);
    explosions.update([impact(WP.ROCKET_LAUNCHER)], 10);
    for (let i = 2; i <= MAX_LOCAL_ENTITIES; i++) pool.alloc();
    explosions.update([], 20);
    expect(explosions.live.map((explosion) => explosion.weapon)).toEqual([WP.ROCKET_LAUNCHER]);
    expect(pool.count).toBe(MAX_LOCAL_ENTITIES);
  });

  it("puts a sprite's 16 units out of the wall, and a model's where the shot struck", () => {
    const explosions = new Explosions(() => 0);
    explosions.update([impact(WP.ROCKET_LAUNCHER), impact(WP.RAILGUN)], 0);
    const [rocket, rail] = explosions.live;
    expect(explosionOrigin(rocket)).toEqual(vec3(84, 0, 30));
    expect(explosionOrigin(rail)).toEqual(vec3(100, 0, 30));
  });
});
