import { describe, expect, it } from 'vitest';

import { box, createFlatWorldTrace } from '../box-world';
import {
  CONTENTS,
  EF_AWARDS,
  EF_AWARD_IMPRESSIVE,
  GT,
  MOD,
  PERS,
  REWARD_SPRITE_TIME,
  STAT,
  SURF,
  TEAM
} from '../constants';
import { NO_IMPACT_DIR, byteToDir } from '../dir-byte';
import { EV, eventNumber } from '../events';
import { ET, type GameEntity } from '../game-entity';
import { PW } from '../items';
import { defaultRules, type Rules } from '../rules';
import { presetRules } from '../rules-test-fixtures';
import { createArmedPlayerState, type TraceFn } from '../types';
import { storeHistory } from '../unlagged';
import { copy, vec3, type Vec3 } from '../vec3';
import { SHOTGUN_COUNT, WP, type WeaponId } from './constants';
import {
  firingSolution,
  shotgunPattern,
  shotgunPatternOnView,
  shotgunWire,
  traceShot
} from './hitscan';
import { brushAhead, weaponWorld, type WeaponWorld } from './weapon-test-fixtures';

/**
 * What a shot leaves behind in the world.
 *
 * An instant-hit weapon hits something and is over, so there is nothing left to send — except
 * that the client has to draw the mark and play the sound. Quake 3 spawns an entity whose whole
 * content is the event saying where the shot landed, sends it once and takes the slot back. This
 * covers which entity each weapon leaves, and what it carries.
 */

/** A wall across the view, its near face 256 units ahead. */
const WALL = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);

/** Fire one shot from the origin, looking down +X. */
function fire(weapon: WeaponId, trace = WALL, seed = 231): WeaponWorld {
  const built = weaponWorld({ trace, randomness: { random: () => 0.5, seed: () => seed } });
  const state = built.owner.client!.ps;
  Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
  built.weapons.fire(state);
  return built;
}

/**
 * Every entity the shot put in the world, in slot order.
 *
 * The eight the body queue holds are stepped over: they are taken at the start of every map and
 * are nothing until a corpse is copied into one.
 */
function spawned(built: WeaponWorld): GameEntity[] {
  const entities: GameEntity[] = [];
  for (let i = 0; i < built.level.numEntities; i++) {
    const entity = built.level.gentities[i];
    if (entity.inuse && entity !== built.owner && entity.classname !== 'bodyque') {
      entities.push(entity);
    }
  }
  return entities;
}

/** The event number an event-only entity carries in its type. */
function eventOf(entity: GameEntity): number {
  return entity.s.eType - ET.EVENTS;
}

/**
 * The world's own trace, with whatever it stops at named as the player in slot 1 instead — a
 * player standing in the way, as far as a shot can tell.
 */
function playerAt(trace: TraceFn): TraceFn {
  return (...args) => {
    const result = trace(...args);
    return result.fraction < 1 ? { ...result, entityNum: 1, contents: CONTENTS.BODY } : result;
  };
}

/** A trace that strikes the player in slot 1 once and the wall after, for one rail hit. */
function oneHit(trace: TraceFn): TraceFn {
  let hit = false;
  return (...args) => {
    const result = trace(...args);
    if (!hit && result.fraction < 1) {
      hit = true;
      return { ...result, entityNum: 1, contents: CONTENTS.BODY };
    }
    return result;
  };
}

/** The player in `slot`, with health to spare, whom {@link playerAt} makes every shot strike. */
function victim(built: WeaponWorld, slot = 1): GameEntity {
  const entity = built.level.gentities[slot];
  entity.client = built.level.clients[slot];
  entity.inuse = true;
  entity.takedamage = true;
  Object.assign(entity.client.ps, createArmedPlayerState({ origin: vec3(300, 0, 24) }));
  entity.client.ps.stats[STAT.HEALTH] = 300;
  return entity;
}

describe('the machinegun', () => {
  it('leaves one impact where the round landed, facing the surface it struck', () => {
    const built = fire(WP.MACHINEGUN);
    const [impact] = spawned(built);

    expect(eventOf(impact)).toBe(EV.BULLET_HIT_WALL);
    // 255 rather than 256: the trace stops a hair short of the wall and `SnapVectorTowards`
    // rounds back along the shot, so the mark can only end up outside the surface it belongs on.
    expect(impact.r.currentOrigin.x).toBe(255);
    expect(byteToDir(impact.s.eventParm).x).toBeLessThan(-0.98);
  });

  it('says whose round it was, for the tracer, and for a shooter who drew it early', () => {
    // From a slot that is not 0, which is what an unwritten field would read as.
    const built = weaponWorld({ trace: WALL });
    built.owner.s.number = 3;
    Object.assign(
      built.owner.client!.ps,
      createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.MACHINEGUN })
    );
    built.weapons.fire(built.owner.client!.ps);
    const [impact] = spawned(built);

    expect(impact.s.otherEntityNum).toBe(3);
    expect(impact.s.clientNum).toBe(3);
  });

  it('leaves nothing where a round reached the end of its range', () => {
    // Quake 3 cannot get here inside a sealed map; a splat map has open sky.
    expect(spawned(fire(WP.MACHINEGUN, createFlatWorldTrace()))).toEqual([]);
  });

  it('hits for five in team deathmatch and seven everywhere else', () => {
    // `MACHINEGUN_TEAM_DAMAGE`, "wimpier MG in teamplay" (`g_weapon.c:159–162`): the only
    // per-mode weapon number in the game, and team deathmatch's alone rather than every team
    // game's.
    const dealt = (gametype: number): number => {
      const built = weaponWorld({ trace: playerAt(WALL), randomness: { random: () => 0.5 } });
      built.level.itemMatch = { ...built.level.itemMatch, gametype: () => gametype };
      const target = victim(built);
      // Opposite sides, or the round is friendly fire and lands nothing at all.
      built.level.clients[0].sess.sessionTeam = TEAM.RED;
      built.level.clients[1].sess.sessionTeam = TEAM.BLUE;
      const state = built.owner.client!.ps;
      Object.assign(
        state,
        createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.MACHINEGUN })
      );
      built.weapons.fire(state);
      return 300 - target.client!.ps.stats[STAT.HEALTH];
    };

    expect(dealt(GT.TEAM)).toBe(5);
    expect(dealt(GT.FFA)).toBe(7);
    expect(dealt(GT.CTF)).toBe(7);
    expect(dealt(GT.CA)).toBe(7);
  });
});

describe('the shotgun', () => {
  it('sends one event for all eleven pellets rather than eleven rays', () => {
    const built = fire(WP.SHOTGUN);
    const entities = spawned(built);

    expect(entities).toHaveLength(1);
    expect(eventOf(entities[0])).toBe(EV.SHOTGUN);
    expect(SHOTGUN_COUNT).toBe(11);
  });

  it('sends the seed it rolled, which is the whole of what makes one blast differ', () => {
    // Both sides generate from it, so a client handed the wrong one draws eleven marks the
    // server never traced.
    expect(spawned(fire(WP.SHOTGUN, WALL, 12))[0].s.eventParm).toBe(12);
    expect(spawned(fire(WP.SHOTGUN, WALL, 200))[0].s.eventParm).toBe(200);
  });

  it('carries the seed and the aim the client needs to work out the same pattern', () => {
    const built = fire(WP.SHOTGUN);
    const [blast] = spawned(built);
    const { muzzle, forward } = firingSolution(
      built.owner.client!.ps.origin,
      built.owner.client!.ps.viewangles,
      built.owner.client!.ps.viewheight
    );

    expect(blast.s.eventParm).toBe(231);
    expect(blast.s.origin2).toEqual(shotgunWire(forward));
    expect(blast.r.currentOrigin).toEqual(muzzle);
    expect(blast.s.otherEntityNum).toBe(built.owner.s.number);
  });

  it('hurts with the pellets a client draws from the event, each pushing along the aim', () => {
    const trace = playerAt(WALL);
    const built = weaponWorld({ trace, randomness: { seed: () => 231 } });
    const target = victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.SHOTGUN }));
    built.weapons.fire(state);

    // `CG_ShotgunPattern`, from what the event carries: every pellet it finds strikes the player.
    const [blast] = spawned(built).filter((entity) => entity !== target);
    const pellets = shotgunPattern(blast.s.pos.trBase, blast.s.origin2, blast.s.eventParm);
    const hits = pellets.filter((end) => traceShot(trace, blast.s.pos.trBase, end, 0).hit);
    expect(hits).toHaveLength(SHOTGUN_COUNT);

    const { ps } = target.client!;
    expect(ps.stats[STAT.HEALTH]).toBe(300 - 10 * hits.length);
    // Ten points a pellet is 50 ups each, along +X however the pellet itself strayed.
    expect(ps.velocity.x).toBeCloseTo(50 * hits.length, 6);
    expect(ps.velocity.y).toBeCloseTo(0, 6);
    expect(target.client!.lasthurtMod).toBe(MOD.SHOTGUN);
  });
});

describe('a shot into the sky', () => {
  /** A sky's flags, as its shader's `surfaceparm sky` and `noimpact` set them. */
  const SKY = SURF.SKY | SURF.NOIMPACT;

  /** The shot, fired at a player standing where the sky is, as no trace could put one. */
  function intoPlayerAt(weapon: WeaponId, trace: TraceFn): number {
    const built = weaponWorld({ trace: playerAt(trace), randomness: { seed: () => 231 } });
    const target = victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    if (weapon === WP.GAUNTLET) built.weapons.checkGauntletAttack(state);
    else built.weapons.fire(state);
    return target.client!.ps.stats[STAT.HEALTH];
  }

  it("leaves a round's impact on a brush, facing it, as on the wall", () => {
    const [impact] = spawned(fire(WP.MACHINEGUN, brushAhead()));

    expect(eventOf(impact)).toBe(EV.BULLET_HIT_WALL);
    expect(impact.r.currentOrigin.x).toBe(255);
    expect(byteToDir(impact.s.eventParm).x).toBeLessThan(-0.98);
  });

  it('leaves nothing of a round or a bolt that meets it', () => {
    expect(spawned(fire(WP.MACHINEGUN, brushAhead(SKY)))).toEqual([]);
    expect(spawned(fire(WP.LIGHTNING, brushAhead(SKY)))).toEqual([]);
    expect(spawned(fire(WP.LIGHTNING, brushAhead())).map(eventOf)).toEqual([EV.MISSILE_MISS]);
  });

  it("ends a rail's trail on it with no impact, as on nothing at all", () => {
    const [beam] = spawned(fire(WP.RAILGUN, brushAhead(SKY)));
    expect(eventOf(beam)).toBe(EV.RAILTRAIL);
    expect(beam.r.currentOrigin.x).toBe(255);
    expect(beam.s.eventParm).toBe(NO_IMPACT_DIR);

    const [struck] = spawned(fire(WP.RAILGUN, brushAhead()));
    expect(byteToDir(struck.s.eventParm).x).toBeLessThan(-0.98);
  });

  it('is struck as a wall where its shader leaves noimpact out', () => {
    const [impact] = spawned(fire(WP.MACHINEGUN, brushAhead(SURF.SKY)));

    expect(eventOf(impact)).toBe(EV.BULLET_HIT_WALL);
  });

  it('stops a round, a pellet and a punch before they ask what they struck', () => {
    // The flags are asked first, so even a player there would be passed over.
    expect(intoPlayerAt(WP.MACHINEGUN, brushAhead(SKY))).toBe(300);
    expect(intoPlayerAt(WP.SHOTGUN, brushAhead(SKY))).toBe(300);
    expect(intoPlayerAt(WP.GAUNTLET, brushAhead(SKY, 40))).toBe(300);
    expect(intoPlayerAt(WP.MACHINEGUN, brushAhead())).toBeLessThan(300);
    expect(intoPlayerAt(WP.SHOTGUN, brushAhead())).toBeLessThan(300);
    expect(intoPlayerAt(WP.GAUNTLET, brushAhead(0, 40))).toBe(300 - 50);
  });

  it('lets a bolt hurt first, and asks the flags only of a miss', () => {
    expect(intoPlayerAt(WP.LIGHTNING, brushAhead(SKY))).toBeLessThan(300);
  });
});

describe('the gauntlet', () => {
  /** A wall 40 units ahead, inside the gauntlet's reach from a muzzle 14 out. */
  const CLOSE = createFlatWorldTrace([box(40, -512, 0, 72, 512, 512)]);

  /** Swing the gauntlet from the origin at whatever `trace` puts in reach. */
  function swing(trace: TraceFn): { built: WeaponWorld; hit: boolean } {
    const built = weaponWorld({ trace });
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
    return { built, hit: built.weapons.checkGauntletAttack(state) };
  }

  it('punches a player within reach for 50, and bleeds them', () => {
    const trace = playerAt(CLOSE);
    const built = weaponWorld({ trace });
    const target = victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));

    expect(built.weapons.checkGauntletAttack(state)).toBe(true);
    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300 - 50);
    expect(target.client!.lasthurtMod).toBe(MOD.GAUNTLET);
    const [blood] = spawned(built).filter((entity) => entity !== target);
    expect(eventOf(blood)).toBe(EV.MISSILE_HIT);
    expect(blood.s.otherEntityNum).toBe(1);
    expect(blood.s.weapon).toBe(WP.GAUNTLET);
  });

  it('says no to a wall, and to nothing in reach', () => {
    expect(swing(CLOSE).hit).toBe(false);
    expect(swing(WALL).hit).toBe(false);
  });

  it('punches nobody while its owner flies through walls', () => {
    const built = weaponWorld({ trace: playerAt(CLOSE) });
    const target = victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
    built.owner.client!.noclip = true;

    expect(built.weapons.checkGauntletAttack(state)).toBe(false);
    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300);
  });

  it('raises EV_POWERUP_QUAD on the punch that lands, and only while quad is held', () => {
    // The one event a quad raises on the server: `Weapon_Gauntlet` is otherwise silent about it
    // (`g_weapon.c:106–107`; every other weapon's quad sound is cgame's, in `CG_FireWeapon`).
    const built = weaponWorld({ trace: playerAt(CLOSE) });
    victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));

    // The punch lands both times; only the second has the quad behind it.
    expect(built.weapons.checkGauntletAttack(state)).toBe(true);
    expect(state.externalEvent).toBe(0);

    state.powerups[PW.QUAD] = 1;
    expect(built.weapons.checkGauntletAttack(state)).toBe(true);
    expect(eventNumber(state.externalEvent)).toBe(EV.POWERUP_QUAD);
  });

  it('triples the punch while quad is held', () => {
    const trace = playerAt(CLOSE);
    const built = weaponWorld({ trace });
    const target = victim(built);
    target.client!.ps.stats[STAT.HEALTH] = 1000;
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
    state.powerups[PW.QUAD] = 1;

    expect(built.weapons.checkGauntletAttack(state)).toBe(true);
    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(1000 - 150);
  });
});

describe('quad damage', () => {
  /** The shooter with `weapon` in hand and the quad running. */
  function armWithQuad(built: WeaponWorld, weapon: WeaponId) {
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    state.powerups[PW.QUAD] = 1;
    return state;
  }

  it('triples a machinegun round, and the push it carries', () => {
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { random: () => 0.5 } });
    const target = victim(built);

    built.weapons.fire(armWithQuad(built, WP.MACHINEGUN));

    // Seven a round, three times over, and the push is the damage's own (`g_combat.c:877`).
    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300 - 21);
    expect(target.client!.ps.velocity.x).toBeCloseTo(105, 6);
    // The shot itself says nothing; only the gauntlet raises the event (`g_weapon.c:106`).
    expect(eventNumber(built.owner.client!.ps.externalEvent)).toBe(0);
  });

  it('triples a rail beam and a lightning bolt', () => {
    const rail = weaponWorld({ trace: oneHit(WALL) });
    const railed = victim(rail);
    railed.client!.ps.stats[STAT.HEALTH] = 1000;
    rail.weapons.fire(armWithQuad(rail, WP.RAILGUN));
    expect(railed.client!.ps.stats[STAT.HEALTH]).toBe(1000 - 300);

    const bolt = weaponWorld({ trace: playerAt(WALL) });
    const bolted = victim(bolt);
    bolted.client!.ps.stats[STAT.HEALTH] = 1000;
    bolt.weapons.fire(armWithQuad(bolt, WP.LIGHTNING));
    expect(bolted.client!.ps.stats[STAT.HEALTH]).toBe(1000 - 24);
  });

  it('triples every shotgun pellet', () => {
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { seed: () => 231 } });
    const target = victim(built);
    target.client!.ps.stats[STAT.HEALTH] = 1000;

    built.weapons.fire(armWithQuad(built, WP.SHOTGUN));

    // Eleven pellets, ten points each, three times over (`g_weapon.c:288–289`).
    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(1000 - 11 * 30);
  });

  it('scales a missile’s own damage and its splash as it is fired', () => {
    // The factor is multiplied into what the missile carries, not looked up when it lands
    // (`g_weapon.c:397–398`), so a rocket fired under quad keeps its triple after it runs out.
    const built = weaponWorld();
    built.weapons.fire(armWithQuad(built, WP.ROCKET_LAUNCHER));
    const [rocket] = spawned(built);

    expect(rocket.damage).toBe(300);
    expect(rocket.splashDamage).toBe(300);
  });

  it('leaves a shot at its plain damage with no quad held', () => {
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { random: () => 0.5 } });
    const target = victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.MACHINEGUN }));

    built.weapons.fire(state);

    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300 - 7);
    expect(target.client!.ps.velocity.x).toBeCloseTo(35, 6);
  });

  it("reads the rules' factor at the shot, so a change lands on the next one", () => {
    const rules = defaultRules();
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { random: () => 0.5 }, rules });
    const target = victim(built);
    target.client!.ps.stats[STAT.HEALTH] = 1000;
    const state = armWithQuad(built, WP.MACHINEGUN);

    built.weapons.fire(state);
    rules.g_quadfactor = 2;
    built.weapons.fire(state);

    expect(target.client!.ps.stats[STAT.HEALTH]).toBe(1000 - 21 - 14);
  });
});

describe('the railgun', () => {
  it('sends the beam and the surface at its far end as one event', () => {
    const built = fire(WP.RAILGUN);
    const [beam] = spawned(built);

    expect(eventOf(beam)).toBe(EV.RAILTRAIL);
    // Snapped back along the beam, like the bullet's, so the ring sits on the wall and not in it.
    expect(beam.r.currentOrigin.x).toBe(255);
    expect(byteToDir(beam.s.eventParm).x).toBeLessThan(-0.98);
  });

  it('starts the beam under the drawn gun rather than on the view axis', () => {
    // A beam through the eye is edge-on to it, so the player who fired it would see nothing.
    const state = createArmedPlayerState({ origin: vec3(0, 0, 24), weapon: WP.RAILGUN });
    const { muzzle } = firingSolution(state.origin, state.viewangles, state.viewheight);
    const [beam] = spawned(fire(WP.RAILGUN));

    expect(beam.s.origin2).not.toEqual(muzzle);
    expect(beam.s.origin2.y).toBeCloseTo(muzzle.y - 4, 6);
    expect(beam.s.origin2.z).toBeCloseTo(muzzle.z - 1, 6);
  });

  it('says whose beam it is, so a client can draw it in that player\'s colour', () => {
    const built = fire(WP.RAILGUN);
    const [beam] = spawned(built);

    expect(beam.s.clientNum).toBe(built.owner.client!.ps.clientNum);
  });

  it('still draws the beam when it struck nothing, with no impact at its end', () => {
    const [beam] = spawned(fire(WP.RAILGUN, createFlatWorldTrace()));

    expect(eventOf(beam)).toBe(EV.RAILTRAIL);
    expect(beam.s.eventParm).toBe(NO_IMPACT_DIR);
  });
});

describe('the lightning gun', () => {
  it('sends only where its bolt ends, because the bolt itself is drawn client-side', () => {
    const built = fire(WP.LIGHTNING);
    const [impact] = spawned(built);

    expect(eventOf(impact)).toBe(EV.MISSILE_MISS);
    // Truncated by `G_TempEntity` itself, which is all `Weapon_LightningFire` asks for.
    expect(impact.r.currentOrigin.x).toBe(255);
    // No weapon on it, which is what makes the client draw `CG_MissileHitWall`'s default — the
    // lightning gun's own case, with a mark and a crackle and no explosion.
    expect(impact.s.weapon).toBe(WP.NONE);
  });

  it('leaves nothing where the bolt reached the end of its range', () => {
    expect(spawned(fire(WP.LIGHTNING, createFlatWorldTrace()))).toEqual([]);
  });
});

describe('the rest', () => {
  it('leaves a missile for a projectile weapon, which is a thing rather than an event', () => {
    const built = fire(WP.ROCKET_LAUNCHER);
    const [rocket] = spawned(built);

    expect(rocket.s.eType).toBe(ET.MISSILE);
    expect(built.weapons.missiles).toEqual([rocket]);
  });

  it('leaves nothing at all for the gauntlet', () => {
    // `CheckGauntletAttack` runs before the move and has nothing to hit here, so `PM_Weapon`
    // never raises a fire event for it in the first place.
    expect(spawned(fire(WP.GAUNTLET))).toEqual([]);
  });
});

describe('the accuracy counters', () => {
  /**
   * The world's trace as the railgun sees it: the players in `slots` are struck in turn, one per
   * stop, and the wall ends the beam. The original unlinks each as it goes, which is what a fixed
   * trace cannot show.
   */
  function railRange(
    trace: TraceFn,
    slots: number[] = [1]
  ): { trace: TraceFn; rearm: () => void } {
    let remaining: number[] = [];
    const rearm = () => {
      remaining = [...slots];
    };
    rearm();

    return {
      rearm,
      trace: (...args) => {
        const result = trace(...args);
        const entityNum = remaining[0];
        if (entityNum !== undefined && result.fraction < 1) {
          remaining.shift();
          return { ...result, entityNum, contents: CONTENTS.BODY };
        }
        return result;
      }
    };
  }

  /** Arm the shooter with `weapon` at the origin, looking down +X. */
  function arm(built: WeaponWorld, weapon: WeaponId) {
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    return state;
  }

  it('counts one shot per fire, and leaves the gauntlet and the hook out', () => {
    const tracked: WeaponId[] = [
      WP.MACHINEGUN,
      WP.SHOTGUN,
      WP.RAILGUN,
      WP.LIGHTNING,
      WP.GRENADE_LAUNCHER,
      WP.ROCKET_LAUNCHER,
      WP.PLASMAGUN,
      WP.BFG
    ];
    for (const weapon of tracked) {
      expect(fire(weapon).owner.client!.accuracyShots).toBe(1);
    }
    // "Grapple is not a weapon and gauntlet is just not tracked" (`g_weapon.c:814`).
    expect(fire(WP.GAUNTLET).owner.client!.accuracyShots).toBe(0);
    expect(fire(WP.GRAPPLING_HOOK).owner.client!.accuracyShots).toBe(0);
  });

  it('counts a machinegun round that reached a player', () => {
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { random: () => 0.5 } });
    victim(built);

    built.weapons.fire(arm(built, WP.MACHINEGUN));

    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('leaves a round that struck the wall out of the hits', () => {
    expect(fire(WP.MACHINEGUN).owner.client!.accuracyHits).toBe(0);
  });

  it('leaves a round into a player with no health left out of the hits', () => {
    // `LogAccuracyHit` refuses a target already dead (`g_weapon.c:753`).
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { random: () => 0.5 } });
    victim(built).client!.ps.stats[STAT.HEALTH] = 0;

    built.weapons.fire(arm(built, WP.MACHINEGUN));

    expect(built.owner.client!.accuracyHits).toBe(0);
  });

  it('counts one hit for a shotgun blast however many pellets reached the player', () => {
    const built = weaponWorld({ trace: playerAt(WALL), randomness: { seed: () => 231 } });
    victim(built);

    built.weapons.fire(arm(built, WP.SHOTGUN));

    // Eleven pellets, one `accuracy_hits++` (`g_weapon.c:341–344`).
    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('counts a rail shot that reached a player, and a miss as no hit', () => {
    const range = railRange(WALL);
    const built = weaponWorld({ trace: range.trace });
    victim(built);
    const state = arm(built, WP.RAILGUN);
    const client = built.owner.client!;

    built.weapons.fire(state);
    expect(client.accuracyHits).toBe(1);
    expect(client.accurateCount).toBe(1);

    // Not re-armed, so the next shot stops at the wall.
    built.weapons.fire(state);
    expect(client.accuracyHits).toBe(1);
    expect(client.accurateCount).toBe(0);
  });

  it('awards the impressive for two rail hits in a row, and spends the pair', () => {
    const range = railRange(WALL);
    const built = weaponWorld({ trace: range.trace });
    victim(built);
    const state = arm(built, WP.RAILGUN);
    const client = built.owner.client!;

    built.weapons.fire(state);
    expect(client.ps.persistant[PERS.IMPRESSIVE_COUNT]).toBe(0);

    range.rearm();
    built.weapons.fire(state);
    expect(client.ps.persistant[PERS.IMPRESSIVE_COUNT]).toBe(1);
    expect(client.accurateCount).toBe(0);
    // And its sprite over the shooter's head, for two seconds (`g_weapon.c:550–552`).
    expect(client.ps.eFlags & EF_AWARDS).toBe(EF_AWARD_IMPRESSIVE);
    expect(client.rewardTime).toBe(built.level.time + REWARD_SPRITE_TIME);
  });

  it('breaks the rail streak when a shot misses', () => {
    const range = railRange(WALL);
    const built = weaponWorld({ trace: range.trace });
    victim(built);
    const state = arm(built, WP.RAILGUN);
    const client = built.owner.client!;

    built.weapons.fire(state); // hit: the streak is one
    built.weapons.fire(state); // miss: the streak resets
    range.rearm();
    built.weapons.fire(state); // hit: one again, not a pair

    expect(client.ps.persistant[PERS.IMPRESSIVE_COUNT]).toBe(0);
    expect(client.accurateCount).toBe(1);
  });

  it('counts one hit for a rail shot that reached two players, and the pair as impressive', () => {
    const range = railRange(WALL, [1, 2]);
    const built = weaponWorld({ trace: range.trace });
    victim(built, 1);
    victim(built, 2);

    built.weapons.fire(arm(built, WP.RAILGUN));
    const client = built.owner.client!;

    // One hit for the shot, however many it went through (`g_weapon.c:554`), and the two are a
    // pair on their own (`:545–548`).
    expect(client.accuracyHits).toBe(1);
    expect(client.ps.persistant[PERS.IMPRESSIVE_COUNT]).toBe(1);
    expect(client.accurateCount).toBe(0);
  });

  it('counts a lightning bolt that reached a player', () => {
    const built = weaponWorld({ trace: playerAt(WALL) });
    victim(built);

    built.weapons.fire(arm(built, WP.LIGHTNING));

    expect(built.owner.client!.accuracyHits).toBe(1);
  });
});

describe("CPMA's rules for the hitscans and the gauntlet", () => {
  const CPM = presetRules('cpm');
  const CQ3 = presetRules('cq3');
  /** A wall 40 units ahead, inside CPMA's reach of 45 from the eye. */
  const CLOSE = createFlatWorldTrace([box(40, -512, 0, 72, 512, 512)]);
  /** A wall whose face is at x = -256, for a shot from further down -X. */
  const BEHIND = createFlatWorldTrace([box(-256, -512, 0, -224, 512, 512)]);

  /** A trace that keeps where each one started and was sent to. */
  function recording(trace: TraceFn = WALL): { trace: TraceFn; asked: [Vec3, Vec3][] } {
    const asked: [Vec3, Vec3][] = [];
    return {
      asked,
      trace: (start, mins, maxs, end, pass, mask) => {
        asked.push([copy(start), copy(end)]);
        return trace(start, mins, maxs, end, pass, mask);
      }
    };
  }

  /** One shot as {@link fire} fires it, under `rules`. */
  function fireBy(
    rules: Readonly<Rules>,
    weapon: WeaponId,
    options: { trace?: TraceFn; origin?: Vec3; random?: number } = {}
  ): WeaponWorld {
    const random = options.random ?? 0.5;
    const randomness = { random: () => random, seed: () => 231 };
    const built = weaponWorld({ trace: options.trace ?? WALL, randomness, rules });
    const state = built.owner.client!.ps;
    const origin = options.origin ?? vec3(0, 0, 24);
    Object.assign(state, createArmedPlayerState({ origin, weapon }));
    built.weapons.fire(state);
    return built;
  }

  /** What one shot takes off the player in slot 1, on the other side, under `rules`. */
  function dealt(
    rules: Readonly<Rules>,
    weapon: WeaponId,
    options: { gametype?: number; trace?: TraceFn; quad?: boolean } = {}
  ): number {
    const randomness = { random: () => 0.5, seed: () => 231 };
    const built = weaponWorld({ trace: options.trace ?? playerAt(WALL), randomness, rules });
    const gametype = options.gametype ?? GT.FFA;
    built.level.itemMatch = { ...built.level.itemMatch, gametype: () => gametype };
    const target = victim(built);
    built.level.clients[0].sess.sessionTeam = TEAM.RED;
    built.level.clients[1].sess.sessionTeam = TEAM.BLUE;
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    if (options.quad) state.powerups[PW.QUAD] = 1;
    built.weapons.fire(state);
    return 300 - target.client!.ps.stats[STAT.HEALTH];
  }

  /** A puncher at the origin and a player 40 out, under `rules`. */
  function squareUp(rules: Readonly<Rules>, trace = playerAt(CLOSE)) {
    const built = weaponWorld({ trace, rules });
    const target = victim(built);
    target.s.pos.trBase = vec3(40, 0, 24);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
    built.owner.s.pos.trBase = vec3(0, 0, 24);
    const others = () => spawned(built).filter((entity) => entity !== target);
    return { built, target, state, others };
  }

  /** What a punch takes off a player 40 out: the check, and then the fire event. */
  function punched(rules: Readonly<Rules>): number {
    const { built, target, state } = squareUp(rules);
    built.weapons.checkGauntletAttack(state);
    built.weapons.fire(state);
    return 300 - target.client!.ps.stats[STAT.HEALTH];
  }

  /** Whether a punch reaches a player whose face is `face` from the eye. */
  function reaches(rules: Readonly<Rules>, face: number): boolean {
    const at = createFlatWorldTrace([box(face, -512, 0, 72, 512, 512)]);
    const { built, state } = squareUp(rules, playerAt(at));
    return built.weapons.checkGauntletAttack(state);
  }

  /** What a preset's hitscans do, in the numbers where the presets differ. */
  function played(name: string) {
    const rules = presetRules(name);
    const off = vec3(0.25, 0.5, 24);
    const sg = recording();
    fireBy(rules, WP.SHOTGUN, { trace: sg.trace });
    const [pelletStart, pelletEnd] = sg.asked[0];
    const mg = recording();
    fireBy(rules, WP.MACHINEGUN, { trace: mg.trace, random: 0.75 });
    const round = recording();
    fireBy(rules, WP.MACHINEGUN, { trace: round.trace, origin: off });
    const inCheck = squareUp(rules);
    inCheck.built.weapons.checkGauntletAttack(inCheck.state);
    return {
      mg: dealt(rules, WP.MACHINEGUN),
      mgInCtf: dealt(rules, WP.MACHINEGUN, { gametype: GT.CTF }),
      mgUnderQuad: dealt(rules, WP.MACHINEGUN, { quad: true }),
      sg: dealt(rules, WP.SHOTGUN),
      lg: dealt(rules, WP.LIGHTNING),
      rg: dealt(rules, WP.RAILGUN, { trace: oneHit(WALL) }),
      // The round's drop at the end of its range, from a draw straight down the cone.
      mgEnd: [Math.round(mg.asked[0][1].x), Math.round(mg.asked[0][1].z)],
      pellets: sg.asked.length,
      // The first pellet's right and up offsets at 8192 units.
      firstPellet: [
        Math.round(((pelletStart.y - pelletEnd.y) * 8192) / (pelletEnd.x - pelletStart.x)),
        Math.round(((pelletEnd.z - pelletStart.z) * 8192) / (pelletEnd.x - pelletStart.x))
      ],
      // Where a round starts from (0.25, 0.5, 24).
      muzzle: round.asked[0][0],
      // Whether a punch reaches 44.5 and 45.5 from the eye: id's reaches 46, and CPMA's 45.
      reach: [reaches(rules, 44.5), reaches(rules, 45.5)],
      punchInCheck: 300 - inCheck.target.client!.ps.stats[STAT.HEALTH],
      impact: spawned(fireBy(rules, WP.MACHINEGUN, { trace: BEHIND, origin: vec3(-400, 0, 24) }))[0]
        .r.currentOrigin.x,
      trail: spawned(fireBy(rules, WP.RAILGUN, { origin: off }))[0].s.origin2
    };
  }

  /** CPMA's, where the four presets agree. */
  const CPMA = {
    pellets: 16,
    muzzle: vec3(1.25, 0.5, 50),
    reach: [true, false],
    punchInCheck: 0,
    impact: -256,
    trail: vec3(2, 0, 50)
  };

  it.each([
    [
      'vq3',
      {
        mg: 7, mgInCtf: 7, mgUnderQuad: 21, sg: 110, lg: 8, rg: 100, mgEnd: [131086, -1550],
        pellets: 11, firstPellet: [66, 245], muzzle: vec3(14, 0, 50),
        reach: [true, true],
        punchInCheck: 50, impact: -257, trail: vec3(14, -4, 49)
      }
    ],
    [
      'pmc',
      {
        ...CPMA, mg: 5, mgInCtf: 5, mgUnderQuad: 20, sg: 96, lg: 8, rg: 100, mgEnd: [8193, -50],
        firstPellet: [250, 100]
      }
    ],
    [
      'cpm',
      {
        ...CPMA, mg: 5, mgInCtf: 5, mgUnderQuad: 20, sg: 96, lg: 10, rg: 80, mgEnd: [8193, -50],
        firstPellet: [250, 100]
      }
    ],
    [
      'cq3',
      {
        ...CPMA, mg: 7, mgInCtf: 5, mgUnderQuad: 21, sg: 96, lg: 10, rg: 80, mgEnd: [8193, -125],
        firstPellet: [300, 150]
      }
    ],
    [
      'dev',
      {
        ...CPMA, mg: 5, mgInCtf: 5, mgUnderQuad: 20, sg: 96, lg: 10, rg: 80, mgEnd: [8193, -50],
        firstPellet: [250, 100]
      }
    ]
  ])("plays %s's hitscans and gauntlet", (name, expected) => {
    expect(played(name)).toEqual(expected);
  });

  /** The push one shot gives the player in slot 1, from a shooter based at the muzzle's height. */
  function pushedBy(rules: Readonly<Rules>, weapon: WeaponId, trace: TraceFn): number {
    const built = weaponWorld({ trace, rules });
    const target = victim(built);
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    // Level with the shot, so the distance to where it lands is along X alone.
    built.owner.s.pos.trBase = vec3(0, 0, 50);
    built.weapons.fire(state);
    return target.client!.ps.velocity.x;
  }

  it("falls CQ3's bolt off to its end snapped toward the muzzle, and its rail to its end", () => {
    // Both end just short of the wall's face at 256, and the bolt's end is snapped back to 255.
    const falloff = (distance: number) => (0.5 * distance) / 768;
    const bolt = pushedBy(CQ3, WP.LIGHTNING, playerAt(WALL));
    expect(bolt).toBeCloseTo(50 * (1.25 - falloff(255)), 9);
    const rail = pushedBy(CQ3, WP.RAILGUN, oneHit(WALL));
    expect(rail).toBeGreaterThan(400 * (1 - falloff(256)));
    expect(rail).toBeLessThan(400 * (1 - falloff(255)));
  });

  it("keeps id's numbers where every preset does", () => {
    const ids = defaultRules();
    const same = [
      'g_damage_g',
      'g_damage_mg_team',
      'g_range_lg',
      'g_range_rg',
      'g_spread_sg'
    ] as const;
    for (const name of ['pmc', 'cpm', 'cq3', 'dev']) {
      const rules = presetRules(name);
      for (const rule of same) expect(rules[rule], `${name}: ${rule}`).toBe(ids[rule]);
    }
  });

  it('reads every damage from the rules', () => {
    const odd = {
      ...defaultRules(),
      g_damage_g: 61,
      g_damage_mg: 6,
      g_damage_mg_team: 4,
      g_damage_sg: 3,
      g_damage_lg: 9,
      g_damage_rg: 70
    };
    expect(dealt(odd, WP.MACHINEGUN)).toBe(6);
    expect(dealt(odd, WP.MACHINEGUN, { gametype: GT.TEAM })).toBe(4);
    expect(dealt(odd, WP.SHOTGUN)).toBe(33);
    expect(dealt(odd, WP.LIGHTNING)).toBe(9);
    expect(dealt(odd, WP.RAILGUN, { trace: oneHit(WALL) })).toBe(70);
    // The gauntlet's, in the check and on the fire event.
    expect(punched(odd)).toBe(61);
    expect(punched({ ...odd, g_gauntletOnFire: 1 })).toBe(61);
  });

  it("hits for the machinegun's team damage in every team mode under g_damage_mg_teamAll", () => {
    expect(dealt(CQ3, WP.MACHINEGUN, { gametype: GT.FFA })).toBe(7);
    expect(dealt(CQ3, WP.MACHINEGUN, { gametype: GT.TOURNAMENT })).toBe(7);
    expect(dealt(CQ3, WP.MACHINEGUN, { gametype: GT.TEAM })).toBe(5);
    expect(dealt(CQ3, WP.MACHINEGUN, { gametype: GT.CTF })).toBe(5);
    expect(dealt(CQ3, WP.MACHINEGUN, { gametype: GT.CA })).toBe(5);
  });

  it("reaches as far as the rules' ranges", () => {
    const short = { ...defaultRules(), g_range_mg: 200, g_range_lg: 200, g_range_rg: 200 };
    expect(spawned(fireBy(short, WP.MACHINEGUN))).toEqual([]);
    expect(spawned(fireBy(short, WP.LIGHTNING))).toEqual([]);
    const [beam] = spawned(fireBy(short, WP.RAILGUN));
    expect(beam.r.currentOrigin.x).toBe(214);
    expect(beam.s.eventParm).toBe(NO_IMPACT_DIR);
  });

  it("spreads a round by g_spread_mg, given at 8192 units whatever the range", () => {
    const { trace, asked } = recording();
    fireBy({ ...defaultRules(), g_spread_mg: 350, g_range_mg: 16384 }, WP.MACHINEGUN, {
      trace,
      random: 0.75
    });
    // Straight down the cone, half its spread: 175 at 8192, and 350 at twice the range.
    expect(asked[0][1].x).toBeCloseTo(14 + 16384, 6);
    expect(asked[0][1].z).toBeCloseTo(50 - 350, 6);
  });

  it("traces CPMA's fixed pattern from the muzzle, on the view's axes", () => {
    const { trace, asked } = recording();
    const origin = vec3(0.25, 0.5, 24);
    const built = fireBy(CPM, WP.SHOTGUN, { trace, origin });

    const solution = firingSolution(origin, vec3(0, 0, 0), 26, 1, false);
    const pattern = { pattern: 1, pellets: 16, spread: 700 };
    expect(asked.map(([start]) => start)).toEqual(Array(16).fill(vec3(1.25, 0.5, 50)));
    expect(asked.map(([, end]) => end)).toEqual(shotgunPatternOnView(solution, pattern));
    // The event still carries id's seed and aim, which the client draws by.
    const [blast] = spawned(built);
    expect(blast.s.eventParm).toBe(231);
    expect(blast.s.origin2).toEqual(shotgunWire(solution.forward));
  });

  it("traces id's pattern from the event's origin, by the rules' pellets and spread", () => {
    const { trace, asked } = recording();
    const shotgun = { pattern: 0, pellets: 5, spread: 350 };
    const rules = { ...defaultRules(), g_pellets_sg: 5, g_spread_sg: 350 };
    const [blast] = spawned(fireBy(rules, WP.SHOTGUN, { trace }));

    expect(asked.map(([, end]) => end)).toEqual(
      shotgunPattern(blast.s.pos.trBase, blast.s.origin2, 231, shotgun)
    );
  });

  describe('the gauntlet under g_gauntletOnFire', () => {
    it('finds the target in the check, and hurts it on the fire event after the move', () => {
      const { built, target, state, others } = squareUp(CPM);

      expect(built.weapons.checkGauntletAttack(state)).toBe(true);
      expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300);
      expect(others()).toEqual([]);

      built.weapons.fire(state);
      expect(target.client!.ps.stats[STAT.HEALTH]).toBe(250);
      expect(target.client!.lasthurtMod).toBe(MOD.GAUNTLET);
      // The blood is where the target stands, turned back toward the puncher.
      const [blood] = others();
      expect(eventOf(blood)).toBe(EV.MISSILE_HIT);
      expect(blood.r.currentOrigin).toEqual(vec3(40, 0, 24));
      expect(byteToDir(blood.s.eventParm).x).toBeLessThan(-0.98);
      expect(blood.s.otherEntityNum).toBe(1);
      expect(blood.s.weapon).toBe(WP.GAUNTLET);
    });

    it('hurts nothing when the move does not fire after a hit', () => {
      const { built, target, state } = squareUp(CPM);
      expect(built.weapons.checkGauntletAttack(state)).toBe(true);
      expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300);
    });

    it('raises no EV_POWERUP_QUAD, and punches for the quad factor', () => {
      const { built, target, state } = squareUp(CPM);
      state.powerups[PW.QUAD] = 1;

      built.weapons.checkGauntletAttack(state);
      built.weapons.fire(state);

      expect(state.externalEvent).toBe(0);
      expect(target.client!.ps.stats[STAT.HEALTH]).toBe(300 - 200);
    });
  });
});

describe('the rewind around a shot', () => {
  /**
   * A shot from the origin down +x, with a target in slot 1 that the shooter drew 100 units nearer
   * than it now stands, and a trace that notes where the target was each time it ran.
   *
   * @param unlagged - `xp_unlagged` as the game reads it, or null for a system built without one.
   */
  function rewound(weapon: WeaponId, unlagged: (() => number) | null = () => 1) {
    const traced: number[] = [];
    let target: GameEntity | null = null;
    const trace: TraceFn = (...args) => {
      traced.push(target!.r.currentOrigin.x);
      return WALL(...args);
    };
    const built = weaponWorld({
      trace,
      randomness: { random: () => 0.5, seed: () => 231 },
      unlagged: unlagged ?? undefined
    });
    target = victim(built);
    const { level } = built;

    // Recorded at 200 as one frame ended and at 300 as the next did, and drawn at the first.
    for (const [time, x] of [
      [1000, 200],
      [1008, 300]
    ]) {
      level.previousTime = level.time;
      level.time = time;
      target.s.pos.trBase = vec3(x, 0, 24);
      storeHistory(level, target);
    }
    target.r.currentOrigin = vec3(300, 0, 24);
    Object.assign(built.owner.client!.pers.cmd, {
      drawnTime: 1000,
      drawnSnapTime: 1000,
      drawnNextSnapTime: 1000
    });

    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    return { built, state, traced, target };
  }

  it.each([WP.MACHINEGUN, WP.SHOTGUN, WP.LIGHTNING, WP.RAILGUN])(
    'traces weapon %i with the others where the shooter drew them, and puts them back',
    (weapon) => {
      const { built, state, traced, target } = rewound(weapon);

      built.weapons.fire(state);

      expect(traced.length).toBeGreaterThan(0);
      expect(new Set(traced)).toEqual(new Set([200]));
      expect(target.r.currentOrigin).toEqual(vec3(300, 0, 24));
    }
  );

  it('takes a weapon xp_unlagged leaves out back a snapshot gap from when its command ran', () => {
    const { built, state, traced } = rewound(WP.RAILGUN, () => 4);
    // A snapshot every frame, and the command run as the frame at 1008 ended.
    built.owner.client!.pers.snapshotMsec = 8;

    built.weapons.fire(state);

    expect(traced).toEqual([200]);
  });

  /**
   * A snapshot every frame, and the command run 4 ms after the frame at 1008 ended: a shot that
   * falls back finds the target a frame before that, halfway between its two records.
   */
  function runLate(built: WeaponWorld): void {
    built.owner.client!.pers.snapshotMsec = 8;
    built.owner.client!.frameOffset = 4;
  }

  it.each([
    [WP.RAILGUN, 200],
    [WP.MACHINEGUN, 250]
  ])('at xp_unlagged 128, the railgun bit alone, traces weapon %i at x %i', (weapon, x) => {
    const { built, state, traced } = rewound(weapon, () => 128);
    runLate(built);

    built.weapons.fire(state);

    expect(traced.length).toBeGreaterThan(0);
    expect(new Set(traced)).toEqual(new Set([x]));
  });

  it('takes every weapon back a snapshot gap when built without xp_unlagged', () => {
    const { built, state, traced } = rewound(WP.RAILGUN, null);
    runLate(built);

    built.weapons.fire(state);

    expect(traced).toEqual([250]);
  });

  it('reads xp_unlagged at each shot, so a change lands on the next', () => {
    let unlagged = 1;
    const { built, state, traced } = rewound(WP.RAILGUN, () => unlagged);
    runLate(built);

    built.weapons.fire(state);
    unlagged = 0;
    built.weapons.fire(state);

    expect(traced).toEqual([200, 250]);
  });

  it("never moves anyone for the gauntlet's reach", () => {
    const { built, state, traced } = rewound(WP.GAUNTLET);

    built.weapons.checkGauntletAttack(state);

    expect(traced).toEqual([300]);
  });
});

describe("a shot's seed", () => {
  /** A shot from the origin down +x, by a shooter whose command drew its frame at `drawn`. */
  function firedAt(weapon: WeaponId, drawn: number, snapTime = drawn): WeaponWorld {
    const built = weaponWorld({ trace: WALL });
    Object.assign(built.owner.client!.pers.cmd, {
      serverTime: drawn + 8,
      drawnTime: drawn,
      drawnSnapTime: snapTime,
      drawnNextSnapTime: snapTime
    });
    const state = built.owner.client!.ps;
    Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24), weapon }));
    built.weapons.fire(state);
    return built;
  }

  it("is the low byte of the time the shooter's frame was drawn at, which a blast carries", () => {
    const [blast] = spawned(firedAt(WP.SHOTGUN, 5099));

    expect(eventOf(blast)).toBe(EV.SHOTGUN);
    expect(blast.s.eventParm).toBe(5099 % 256);
  });

  it("is the command's own time's for one that names no drawn frame", () => {
    const [blast] = spawned(firedAt(WP.SHOTGUN, 5099, 0));

    expect(blast.s.eventParm).toBe((5099 + 8) % 256);
  });

  it('draws a machinegun round, so two shots on the same byte land together', () => {
    const landed = (drawn: number) => spawned(firedAt(WP.MACHINEGUN, drawn))[0].r.currentOrigin;

    expect(landed(5099)).toEqual(landed(5099 + 256));
    expect(landed(5099)).not.toEqual(landed(5100));
  });
});
