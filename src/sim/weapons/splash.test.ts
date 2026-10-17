import { describe, expect, it } from 'vitest';
import { box, createFlatWorldTrace } from '../box-world';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, type PlayerState } from '../../net/protocol';
import { CONTENTS, MASK, MOD, PERS, PMF_DUCKED, STAT } from '../constants';
import type { GameEntity } from '../game-entity';
import { Level } from '../level';
import { distinctAsks, recordingTrace } from '../trace-test-fixtures';
import { clearTrace, createArmedPlayerState, playerBounds, type TraceFn } from '../types';
import { add, length, vec3, type Vec3 } from '../vec3';
import { MISSILES, WP } from './constants';
import { canDamage, distanceToBox, radiusDamage } from './splash';
import { brushAhead, linkPlayer } from './weapon-test-fixtures';

const flat = createFlatWorldTrace();
const ROCKET = MISSILES[WP.ROCKET_LAUNCHER]!;

/** Health enough that no blast here kills, so what one takes is what it cost. */
const HEALTH = 1000;

/** A player standing on the floor: origin sits 24 units above the feet. */
const standing = (x = 0, y = 0, z = 24) => createArmedPlayerState({ origin: vec3(x, y, z) });

/** A standing player's box in the world, as `canDamage` takes it: its lower and upper corners. */
function standingBox(): [Vec3, Vec3] {
  const { origin } = standing();
  const { mins, maxs } = playerBounds(false);
  return [add(origin, mins), add(origin, maxs)];
}

/**
 * A player in a world of their own, in `slot`, linked where they stand as a move leaves them, and
 * with health to spare.
 */
function player(
  level: Level,
  slot: number,
  origin: Vec3,
  options: { ducked?: boolean } = {}
): { entity: GameEntity; state: PlayerState } {
  const entity = level.gentities[slot];
  entity.client = level.clients[slot];
  entity.inuse = true;
  entity.takedamage = true;
  entity.r.contents = CONTENTS.BODY;
  const state = entity.client.ps;
  Object.assign(state, createArmedPlayerState({ origin }));
  state.clientNum = slot;
  state.stats[STAT.HEALTH] = HEALTH;
  if (options.ducked) state.pmFlags |= PMF_DUCKED;
  linkPlayer(level, entity);
  return { entity, state };
}

/** A world that links what it is told to, as a level with no server does. */
const world = () => new Level();

/**
 * One blast of the world's at a standing player: how many points reached them, which is what their
 * health lost, and how hard it pushed them.
 */
function blast(
  origin: Vec3,
  points: number,
  radius: number,
  options: { at?: Vec3; trace?: TraceFn; ducked?: boolean } = {}
): { taken: number; velocity: Vec3 } {
  const level = world();
  const { state } = player(level, 0, options.at ?? vec3(0, 0, 24), options);
  radiusDamage(level, options.trace ?? flat, origin, null, points, radius, null, MOD.ROCKET_SPLASH);
  return { taken: HEALTH - state.stats[STAT.HEALTH], velocity: state.velocity };
}

describe('distanceToBox', () => {
  const mins = vec3(-15, -15, -24);
  const maxs = vec3(15, 15, 32);

  it('is zero inside the box', () => {
    expect(distanceToBox(vec3(0, 0, 0), mins, maxs)).toBe(0);
    expect(distanceToBox(vec3(14, -14, 31), mins, maxs)).toBe(0);
  });

  it('measures to the nearest face, not the centre', () => {
    // This is why a rocket at your feet does full damage: the blast is on the box surface,
    // 0 units away, even though your origin is 24 units up.
    expect(distanceToBox(vec3(0, 0, -24), mins, maxs)).toBe(0);
    expect(distanceToBox(vec3(0, 0, -30), mins, maxs)).toBe(6);
  });

  it('measures diagonally past a corner', () => {
    expect(distanceToBox(vec3(18, 19, 0), mins, maxs)).toBeCloseTo(5, 6);
  });
});

describe('canDamage', () => {
  it('sees a player in the open', () => {
    expect(canDamage(flat, vec3(0, 0, 40), ...standingBox(), 0)).toBe(true);
  });

  it('is blocked by a wall between the blast and the player', () => {
    // The wall has to be wider than the probe spread: `canDamage` also fires four rays at
    // +-15 units in X and Y, and a narrow pillar lets those slip past on either side, which
    // is exactly how splash reaches round thin cover in Quake.
    const trace = createFlatWorldTrace([box(-200, -100, 0, -190, 100, 200)]);
    expect(canDamage(trace, vec3(-400, 0, 40), ...standingBox(), 0)).toBe(false);
  });

  it("is blocked by a brush between them, through a BSP's collision", () => {
    // The cube from x 256 to 384, and the blast past it.
    expect(canDamage(brushAhead(), vec3(500, 0, 40), ...standingBox(), 0)).toBe(false);
    expect(canDamage(brushAhead(), vec3(200, 0, 40), ...standingBox(), 0)).toBe(true);
  });

  it('reaches what its first probe stops at, as a blast reaches a door, and no other probe', () => {
    const stoppedBy = (entityNum: () => number): TraceFn => (_start, _mins, _maxs, end) => ({
      ...clearTrace(end),
      fraction: 0.5,
      entityNum: entityNum()
    });
    expect(canDamage(stoppedBy(() => 80), vec3(0, 0, 40), ...standingBox(), 80)).toBe(true);
    expect(canDamage(stoppedBy(() => 81), vec3(0, 0, 40), ...standingBox(), 80)).toBe(false);
    let probes = 0;
    const laterAt80 = stoppedBy(() => (probes++ === 0 ? 81 : 80));
    expect(canDamage(laterAt80, vec3(0, 0, 40), ...standingBox(), 80)).toBe(false);
  });

  it('reaches past cover too narrow to stop all five probes', () => {
    const trace = createFlatWorldTrace([box(-200, -5, 0, -190, 5, 200)]);
    expect(canDamage(trace, vec3(-400, 0, 40), ...standingBox(), 0)).toBe(true);
  });
});

describe('G_RadiusDamage — rocket jumping', () => {
  it('launches the player at +500 z from a rocket at their feet', () => {
    // The canonical figure: a rocket landing at your feet gives full 100 splash damage, so
    // kvel is 5 * 100 = 500 ups straight up — against a jump's 270. Measured and pinned.
    const { taken, velocity } = blast(vec3(0, 0, 0), ROCKET.splashDamage, ROCKET.splashRadius);
    expect(taken).toBe(100);
    expect(velocity.x).toBeCloseTo(0, 6);
    expect(velocity.y).toBeCloseTo(0, 6);
    expect(velocity.z).toBeCloseTo(500, 6);
  });

  it('needs the +24 z bias to launch upward at all', () => {
    // Without it, dir would be (0,0,24) from the feet blast — still up, but a blast slightly
    // to one side would push almost horizontally. With the bias, a rocket one unit to the
    // side still throws you mostly upward, which is what makes rocket jumps controllable.
    const { velocity } = blast(vec3(20, 0, 0), ROCKET.splashDamage, ROCKET.splashRadius);
    expect(velocity.z).toBeGreaterThan(Math.abs(velocity.x));
  });

  it('falls off linearly to nothing at the splash radius', () => {
    // points = damage * (1 - dist/radius), measured from the box surface and truncated.
    // 75 units from the origin is 59 from the linked box's face at x = 16: 50.83 points.
    expect(blast(vec3(75, 0, 24), 100, 120).taken).toBe(50);

    const far = blast(vec3(200, 0, 24), 100, 120);
    expect(far.taken).toBe(0);
    expect(far.velocity).toEqual(vec3());
  });

  it('reaches nothing exactly its radius away from the linked box', () => {
    expect(blast(vec3(16 + 120, 0, 24), 100, 120).taken).toBe(0);
  });

  it('reaches a unit past the bounds, to the box the world links, for no push and a point', () => {
    // 120.5 from the bounds' face at x = 15 is out of a rocket's reach; from the linked box's,
    // it is 119.5, in reach for no points — which `G_Damage` still makes cost one.
    const { taken, velocity } = blast(vec3(15 + 120.5, 0, 24), 100, 120);
    expect(taken).toBe(1);
    expect(velocity).toEqual(vec3());
  });

  it('measures to the box round the snapped origin, and pushes from the exact one', () => {
    // At x = 0.9 the player is linked at x = 0, so the box's face is at 16, not 16.9: 60.5 units
    // off gives 49 points, where 59.6 would give 50. The push is from where they really are,
    // x = 0.9, which `ClientThink_real` puts back after linking (`g_active.c:979`).
    const { taken, velocity } = blast(vec3(16 + 60.5, 0, 24), 100, 120, { at: vec3(0.9, 0, 24) });
    expect(taken).toBe(49);
    expect(velocity.z / -velocity.x).toBeCloseTo(24 / 75.6, 6);
  });

  it('gives full damage when the blast is inside the player box', () => {
    expect(blast(vec3(0, 0, 24), 100, 120).taken).toBe(100);
  });

  it('does nothing through a wall', () => {
    const trace = createFlatWorldTrace([box(-200, -100, 0, -190, 100, 200)]);
    const { taken, velocity } = blast(vec3(-260, 0, 40), 100, 400, { trace });
    expect(taken).toBe(0);
    expect(velocity).toEqual(vec3());
  });

  it('throws the player sideways from a wall blast', () => {
    // A rocket on the wall beside you: mostly lateral, but the +24 bias still lifts it.
    const { velocity } = blast(vec3(-60, 0, 24), ROCKET.splashDamage, ROCKET.splashRadius);
    expect(velocity.x).toBeGreaterThan(100);
    expect(velocity.z).toBeGreaterThan(0);
  });

  it('measures against the crouched box when ducked', () => {
    // Crouching shrinks the box top from +32 to +16, so a blast overhead is further away.
    const overhead = vec3(0, 0, 24 + 40);
    const upright = blast(overhead, 100, 120);
    const crouched = blast(overhead, 100, 120, { ducked: true });
    expect(crouched.taken).toBeLessThan(upright.taken);
  });

  it('is stronger from a grenade, which has a bigger radius than a rocket', () => {
    // Same 100 damage, but 150 units of radius against the rocket's 120, so at any given
    // distance the grenade retains more of it.
    const grenade = MISSILES[WP.GRENADE_LAUNCHER]!;
    const at = vec3(90, 0, 24);
    const rocket = blast(at, ROCKET.splashDamage, ROCKET.splashRadius);
    const lobbed = blast(at, grenade.splashDamage, grenade.splashRadius);
    expect(length(lobbed.velocity)).toBeGreaterThan(length(rocket.velocity));
  });
});

describe('G_RadiusDamage — what a blast reaches', () => {
  it('reaches everyone in its box that can be hurt, each by their own distance', () => {
    const level = world();
    const near = player(level, 0, vec3(0, 0, 24));
    const far = player(level, 1, vec3(60, 0, 24));
    const gone = player(level, 2, vec3(300, 0, 24));

    radiusDamage(level, flat, vec3(0, 0, 0), null, 100, 120, null, MOD.ROCKET_SPLASH);

    expect(HEALTH - near.state.stats[STAT.HEALTH]).toBe(100);
    // Standing at x = 60, their linked box's near face is at 60 − 16 = 44.
    expect(HEALTH - far.state.stats[STAT.HEALTH]).toBe(Math.trunc(100 * (1 - 44 / 120)));
    expect(gone.state.stats[STAT.HEALTH]).toBe(HEALTH);
  });

  it('passes over what it ignores, what cannot be hurt, and what is not in the world', () => {
    const level = world();
    const ignored = player(level, 0, vec3(0, 0, 24));
    const immune = player(level, 1, vec3(0, 20, 24));
    immune.entity.takedamage = false;
    const unlinked = player(level, 2, vec3(0, -20, 24));
    level.unlinkEntity(unlinked.entity);

    radiusDamage(level, flat, vec3(0, 0, 0), null, 100, 120, ignored.entity, MOD.ROCKET_SPLASH);

    expect(ignored.state.stats[STAT.HEALTH]).toBe(HEALTH);
    expect(immune.state.stats[STAT.HEALTH]).toBe(HEALTH);
    expect(unlinked.state.stats[STAT.HEALTH]).toBe(HEALTH);
  });

  it("hurts on the attacker's account, with the blast's means of death", () => {
    const level = world();
    const shooter = player(level, 3, vec3(500, 0, 24));
    const victim = player(level, 1, vec3(0, 0, 24));

    radiusDamage(level, flat, vec3(0, 0, 0), shooter.entity, 100, 120, null, MOD.GRENADE_SPLASH);

    const client = victim.entity.client!;
    expect(victim.state.persistant[PERS.ATTACKER]).toBe(3);
    expect(client.lasthurtClient).toBe(3);
    expect(client.lasthurtMod).toBe(MOD.GRENADE_SPLASH);
    expect(shooter.state.stats[STAT.HEALTH]).toBe(HEALTH);
  });

  it("is the world's when nobody set it off", () => {
    const level = world();
    const { entity, state } = player(level, 0, vec3(0, 0, 24));
    radiusDamage(level, flat, vec3(0, 0, 0), null, 100, 120, null, MOD.ROCKET_SPLASH);
    expect(state.persistant[PERS.ATTACKER]).toBe(ENTITYNUM_WORLD);
    expect(entity.client!.lasthurtClient).toBe(ENTITYNUM_WORLD);
  });

  it('reaches at least a unit, however small the radius', () => {
    const level = world();
    const { state } = player(level, 0, vec3(0, 0, 24));
    // Inside the box: distance 0, which a radius of 0 would divide by.
    radiusDamage(level, flat, vec3(0, 0, 24), null, 10, 0, null, MOD.PLASMA_SPLASH);
    expect(HEALTH - state.stats[STAT.HEALTH]).toBe(10);
  });
});

describe("a blast's line of sight", () => {
  it('passes nobody and is blocked by the world alone, so a player shields nobody', () => {
    const { trace, asked } = recordingTrace(createFlatWorldTrace());

    canDamage(trace, vec3(0, 0, 40), vec3(100, -15, 0), vec3(130, 15, 56), 0);

    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: ENTITYNUM_NONE, contentmask: MASK.SOLID }
    ]);
  });
});

describe('G_RadiusDamage — the accuracy it reports', () => {
  it('reports a client the blast reached, which is what a missile counts as a hit', () => {
    const level = world();
    const attacker = player(level, 1, vec3(0, 0, 24)).entity;
    player(level, 0, vec3(50, 0, 24));

    expect(
      radiusDamage(level, flat, vec3(0, 0, 0), attacker, 100, 120, null, MOD.ROCKET_SPLASH)
    ).toBe(true);
  });

  it('reports nothing when the blast had no client to reach', () => {
    const level = world();
    const attacker = player(level, 1, vec3(0, 0, 24)).entity;

    expect(
      radiusDamage(level, flat, vec3(0, 0, 0), attacker, 100, 120, null, MOD.ROCKET_SPLASH)
    ).toBe(false);
  });

  it('reports nothing when the blast has no client behind it', () => {
    // `LogAccuracyHit` needs a client attacker (`g_weapon.c:749`), so the world's own blasts
    // count no accuracy.
    const level = world();
    player(level, 0, vec3(50, 0, 24));

    expect(
      radiusDamage(level, flat, vec3(0, 0, 0), null, 100, 120, null, MOD.ROCKET_SPLASH)
    ).toBe(false);
  });

  it('reports nothing for a client already dead', () => {
    const level = world();
    const attacker = player(level, 1, vec3(0, 0, 24)).entity;
    const { state } = player(level, 0, vec3(50, 0, 24));
    state.stats[STAT.HEALTH] = 0;

    expect(
      radiusDamage(level, flat, vec3(0, 0, 0), attacker, 100, 120, null, MOD.ROCKET_SPLASH)
    ).toBe(false);
  });
});
