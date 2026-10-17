import { describe, expect, it } from 'vitest';
import { PW } from '../sim/items';
import { WP, type WeaponId } from '../sim/weapons/constants';
import { SceneLights } from './dynamic-lights';
import { EXPLOSION_STYLES } from './effects';
import type { Explosion } from './explosions';
import {
  POWERUP_LIGHT_RADIUS,
  explosionLightRadius,
  gatherLights,
  moverGlows,
  type LitPlayer
} from './light-sources';

/** A player at `x` holding `powerups`. */
function player(number: number, x: number, ...powerups: number[]): LitPlayer {
  return {
    number,
    origin: { x, y: 0, z: 24 },
    powerups: powerups.reduce((mask, powerup) => mask | (1 << powerup), 0)
  };
}

/** A frame with no missile in flight and no explosion playing. */
const QUIET = { missiles: [], explosions: [], time: 0 };

/** An impact's explosion, begun at `startTime` against a wall facing -x. */
function explosion(weapon: WeaponId, startTime: number, x = 100): Explosion {
  const style = EXPLOSION_STYLES[weapon]!;
  return {
    weapon,
    origin: { x, y: 0, z: 30 },
    normal: { x: -1, y: 0, z: 0 },
    startTime,
    durationMs: style.durationMs,
    sprite: style.sprite,
    shaderOf: weapon,
    scale: 1,
    serial: 0
  };
}

describe('gatherLights', () => {
  it("lights a quad holder blue at its origin, 200 + (rand() & 31) out", () => {
    const scene = new SceneLights();
    gatherLights(scene, { ...QUIET, own: player(0, 10, PW.QUAD), players: [] }, () => 0.5);
    expect(scene.lights).toEqual([
      { origin: { x: 10, y: 0, z: 24 }, radius: 216, color: [0.2, 0.2, 1], additive: false }
    ]);
  });

  it('draws its reach again each frame, from 200 to 231', () => {
    const scene = new SceneLights();
    const frame = { ...QUIET, own: player(0, 0, PW.QUAD), players: [] };
    gatherLights(scene, frame, () => 0);
    expect(scene.lights[0].radius).toBe(POWERUP_LIGHT_RADIUS);
    gatherLights(scene, frame, () => 0.999);
    expect(scene.lights[0].radius).toBe(POWERUP_LIGHT_RADIUS + 31);
  });

  it('lights a flag carrier in the flag\'s colour, after the quad', () => {
    const scene = new SceneLights();
    gatherLights(scene, { ...QUIET, own: player(0, 0, PW.REDFLAG, PW.QUAD), players: [] }, () => 0);
    expect(scene.lights.map((light) => light.color)).toEqual([
      [0.2, 0.2, 1],
      [1, 0.2, 0.2]
    ]);
    gatherLights(scene, { ...QUIET, own: player(0, 0, PW.BLUEFLAG), players: [] }, () => 0);
    expect(scene.lights[0].color).toEqual([0.2, 0.2, 1]);
  });

  it('gives nothing for a powerup that does not glow', () => {
    const scene = new SceneLights();
    const glowless = player(0, 0, PW.BATTLESUIT, PW.HASTE, PW.INVIS, PW.REGEN, PW.FLIGHT);
    gatherLights(scene, { ...QUIET, own: glowless, players: [] }, () => 0);
    expect(scene.lights).toEqual([]);
  });

  it("adds the player's own first, then everyone else in entity number order", () => {
    const scene = new SceneLights();
    gatherLights(
      scene,
      { ...QUIET, own: player(5, 50, PW.QUAD), players: [player(7, 70, PW.QUAD), player(2, 20, PW.QUAD)] },
      () => 0
    );
    expect(scene.lights.map((light) => light.origin.x)).toEqual([50, 20, 70]);
  });

  it('lights a rocket in flight orange where it is, 200 out, and no other missile', () => {
    const scene = new SceneLights();
    const missiles = [
      { number: 70, weapon: WP.ROCKET_LAUNCHER, origin: { x: 1, y: 2, z: 3 } },
      { number: 71, weapon: WP.GRENADE_LAUNCHER, origin: { x: 4, y: 5, z: 6 } },
      { number: 72, weapon: WP.PLASMAGUN, origin: { x: 7, y: 8, z: 9 } },
      { number: 73, weapon: WP.BFG, origin: { x: 7, y: 8, z: 9 } }
    ];
    gatherLights(scene, { ...QUIET, own: null, players: [], missiles }, () => 0);
    expect(scene.lights).toEqual([
      { origin: { x: 1, y: 2, z: 3 }, radius: 200, color: [1, 0.75, 0], additive: false }
    ]);
  });

  it("adds the snapshot's players and missiles together, in entity number order", () => {
    const scene = new SceneLights();
    gatherLights(
      scene,
      {
        ...QUIET,
        own: null,
        players: [player(9, 90, PW.QUAD), player(3, 30, PW.QUAD)],
        missiles: [
          { number: 80, weapon: WP.ROCKET_LAUNCHER, origin: { x: 800, y: 0, z: 0 } },
          { number: 65, weapon: WP.ROCKET_LAUNCHER, origin: { x: 650, y: 0, z: 0 } }
        ]
      },
      () => 0
    );
    expect(scene.lights.map((light) => light.origin.x)).toEqual([30, 90, 650, 800]);
  });

  it("lights a rocket's explosion off the wall, fading over its second half", () => {
    const scene = new SceneLights();
    const rocket = explosion(WP.ROCKET_LAUNCHER, 1000);
    const at = (time: number) => {
      gatherLights(scene, { ...QUIET, own: null, players: [], explosions: [rocket], time }, () => 0);
      return scene.lights;
    };
    // A sprite's, 16 units out of the surface, as its fireball is drawn.
    expect(at(1000)).toEqual([
      { origin: { x: 84, y: 0, z: 30 }, radius: 300, color: [1, 0.75, 0], additive: false }
    ]);
    expect(at(1500)[0].radius).toBe(300);
    expect(at(1750)[0].radius).toBe(150);
    // Nothing is left of it at its end, and a light with no reach is dropped.
    expect(at(2000)).toEqual([]);
  });

  it("lights a grenade's explosion yellow, and no other impact's", () => {
    const scene = new SceneLights();
    const explosions = [
      explosion(WP.MACHINEGUN, 0),
      explosion(WP.GRENADE_LAUNCHER, 0),
      explosion(WP.RAILGUN, 0),
      explosion(WP.PLASMAGUN, 0),
      explosion(WP.BFG, 0)
    ];
    gatherLights(scene, { ...QUIET, own: null, players: [], explosions, time: 100 }, () => 0);
    expect(scene.lights.map((light) => [light.radius, light.color])).toEqual([[300, [1, 1, 0]]]);
    // Over its own 600 ms: three quarters through, half its reach is left.
    gatherLights(scene, { ...QUIET, own: null, players: [], explosions, time: 450 }, () => 0);
    expect(scene.lights[0].radius).toBeCloseTo(150, 9);
  });

  it('adds the explosions after every entity, oldest first', () => {
    const scene = new SceneLights();
    gatherLights(
      scene,
      {
        own: player(0, 1, PW.QUAD),
        players: [],
        missiles: [{ number: 64, weapon: WP.ROCKET_LAUNCHER, origin: { x: 2, y: 0, z: 0 } }],
        explosions: [explosion(WP.ROCKET_LAUNCHER, 900, 300), explosion(WP.ROCKET_LAUNCHER, 950, 400)],
        time: 1000
      },
      () => 0
    );
    expect(scene.lights.map((light) => light.origin.x)).toEqual([1, 2, 284, 384]);
  });

  it("starts from nothing each frame: last frame's lights go", () => {
    const scene = new SceneLights();
    gatherLights(scene, { ...QUIET, own: player(0, 0, PW.QUAD), players: [] }, () => 0);
    gatherLights(scene, { ...QUIET, own: player(0, 0), players: [] }, () => 0);
    expect(scene.lights).toEqual([]);
  });

  it('lights a grapple in flight as baseq3 registers it, as a rocket', () => {
    const scene = new SceneLights();
    const missiles = [{ number: 70, weapon: WP.GRAPPLING_HOOK, origin: { x: 1, y: 2, z: 3 } }];
    gatherLights(scene, { ...QUIET, own: null, players: [], missiles }, () => 0);
    expect(scene.lights).toEqual([
      { origin: { x: 1, y: 2, z: 3 }, radius: 200, color: [1, 0.75, 0], additive: false }
    ]);
  });

  it("lights an entity's constantLight first of its own, in entity number order", () => {
    const scene = new SceneLights();
    // Red 255, green 128, blue 64, and 32 × 4 out; and one of no reach, which is dropped.
    const glows = [
      { number: 40, origin: { x: 400, y: 0, z: 0 }, constantLight: 0x204080ff },
      { number: 3, origin: { x: 31, y: 0, z: 0 }, constantLight: 0x10ffffff },
      { number: 50, origin: { x: 500, y: 0, z: 0 }, constantLight: 0x00ffffff }
    ];
    gatherLights(
      scene,
      {
        ...QUIET,
        own: null,
        players: [player(3, 30, PW.QUAD)],
        missiles: [{ number: 41, weapon: WP.ROCKET_LAUNCHER, origin: { x: 410, y: 0, z: 0 } }],
        glows
      },
      () => 0
    );
    expect(scene.lights.map((light) => light.origin.x)).toEqual([31, 30, 400, 410]);
    expect(scene.lights[2]).toEqual({
      origin: { x: 400, y: 0, z: 0 },
      radius: 128,
      color: [1, 128 / 255, 64 / 255],
      additive: false
    });
  });

  it("lights a gun's flash before its holder's powerups, 300 + (rand() & 31) out", () => {
    const scene = new SceneLights();
    const flashing = (number: number, x: number, weapon: WeaponId): LitPlayer => ({
      ...player(number, x, PW.QUAD),
      flash: { origin: { x: x + 1, y: 0, z: 40 }, weapon }
    });
    gatherLights(
      scene,
      { ...QUIET, own: flashing(0, 10, WP.MACHINEGUN), players: [flashing(4, 40, WP.RAILGUN)] },
      () => 0.5
    );
    expect(scene.lights.map(({ origin, radius, color }) => [origin.x, radius, color])).toEqual([
      [11, 316, [1, 1, 0]],
      [10, 216, [0.2, 0.2, 1]],
      [41, 316, [1, 0.5, 0]],
      [40, 216, [0.2, 0.2, 1]]
    ]);
  });

  it("fades an explosion's light by how far through its life it is, in cgame's floats", () => {
    const scene = new SceneLights();
    const rocket = explosion(WP.ROCKET_LAUNCHER, 1000);
    gatherLights(
      scene,
      { ...QUIET, own: null, players: [], explosions: [rocket], time: 1777 },
      () => 0
    );
    // 777 ms of 1,000: the float 0.777 is a hair over, which leaves a hair less.
    expect(scene.lights[0].radius).toBe(133.79998779296875);
  });

  it("adds the view weapon's flash last of all, after the explosions", () => {
    const scene = new SceneLights();
    gatherLights(
      scene,
      {
        own: player(0, 1, PW.QUAD),
        players: [],
        missiles: [],
        explosions: [explosion(WP.ROCKET_LAUNCHER, 900, 300)],
        viewWeapon: { origin: { x: 5, y: 0, z: 0 }, weapon: WP.LIGHTNING },
        time: 1000
      },
      () => 0
    );
    expect(scene.lights.map(({ origin, color }) => [origin.x, color])).toEqual([
      [1, [0.2, 0.2, 1]],
      [284, [1, 0.75, 0]],
      [5, [0.6, 0.6, 1]]
    ]);
  });
});

describe('moverGlows', () => {
  it("takes each mover with a constantLight, at its origin, by its entity's number", () => {
    const pose = (number: number | undefined, constantLight: number) => ({
      model: 1,
      number,
      origin: [number ?? 0, 0, 0] as [number, number, number],
      angles: [0, 0, 0] as [number, number, number],
      constantLight
    });
    expect(moverGlows([pose(40, 0x10ffffff), pose(41, 0), pose(undefined, 0x10ffffff)])).toEqual([
      { number: 40, origin: { x: 40, y: 0, z: 0 }, constantLight: 0x10ffffff }
    ]);
  });
});

describe('explosionLightRadius', () => {
  it('is whole for the first half of the life, then falls straight to nothing', () => {
    expect(explosionLightRadius(300, 0)).toBe(300);
    expect(explosionLightRadius(300, 0.49)).toBe(300);
    expect(explosionLightRadius(300, 0.5)).toBe(300);
    expect(explosionLightRadius(300, 0.75)).toBe(150);
    expect(explosionLightRadius(300, 1)).toBe(0);
  });

  it("falls in cgame's floats", () => {
    const f = Math.fround;
    const progress = f(f(1234) / 1700);
    expect(explosionLightRadius(300, progress)).toBe(f(300 * f(1 - (progress - 0.5) * 2)));
    expect(explosionLightRadius(300, progress)).not.toBe(300 * (1 - (1234 / 1700 - 0.5) * 2));
  });
});
