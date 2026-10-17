import { describe, expect, it } from 'vitest';

import { readDeltaEntity, writeDeltaEntity } from '../../net/delta';
import { Message } from '../../net/msg';
import {
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  GENTITYNUM_BITS,
  MAX_CLIENTS,
  TR,
  createEntityState
} from '../../net/protocol';
import { box, createFlatWorldTrace } from '../box-world';
import { CONTENTS, EF_BOUNCE_HALF, MASK, MOD, PERS, STAT, SURF } from '../constants';
import { byteToDir, dirToByte } from '../dir-byte';
import { EV, eventNumber } from '../events';
import { ET, type GameEntity } from '../game-entity';
import { EVENT_VALID_MSEC } from '../level';
import { ID_RULES, defaultRules, type Rules } from '../rules';
import { presetRules } from '../rules-test-fixtures';
import { distinctAsks, recordingTrace } from '../trace-test-fixtures';
import { evaluateTrajectory } from '../trajectory';
import { clearTrace, createArmedPlayerState, type TraceResult } from '../types';
import { vec3, type Vec3 } from '../vec3';
import { MISSILES, MISSILE_PRESTEP_TIME, WP } from './constants';
import { fireGrapple, NO_HOOK, Q3_GRAPPLE_SPEED, type GrappleStyle } from './grapple';
import { bounceMissile, explodeMissile, fireMissile, missileImpact } from './missile';
import { brushAhead, linkPlayer, weaponWorld, type WeaponWorld } from './weapon-test-fixtures';

/**
 * A missile is an entity in the world, run by the frame, and everything a client needs to draw
 * one is on the entity state the wire already carries.
 */

const GROUND = createFlatWorldTrace();

/** A world with a floor, and the player standing in slot 0. */
function world(trace = GROUND): WeaponWorld {
  const built = weaponWorld({ trace });
  built.owner.s.number = 0;
  return built;
}

/** The level time a grenade thrown flat first bounces at, for the fuse that lands on it. */
function firstBounce(): number {
  const built = world();
  const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
  for (let time = 8; time <= 2000; time += 8) {
    built.level.runFrame(time);
    if (eventNumber(grenade.s.event) === EV.GRENADE_BOUNCE) return time;
  }
  return 0;
}

/** Run frames until the missile stops being one, which is what going off looks like. */
function runUntilImpact(built: WeaponWorld, missile: GameEntity, limit = 4000): void {
  for (let time = built.level.time + 8; time <= limit; time += 8) {
    built.level.runFrame(time);
    if (missile.s.eType !== ET.MISSILE) return;
  }
  throw new Error('the missile never went off');
}

/** Every missile in the level's pool. */
function missiles(built: WeaponWorld) {
  return built.weapons.missiles;
}

describe('fireMissile', () => {
  it('puts a missile in the level, above the client slots, as an entity like any other', () => {
    const built = world();
    const rocket = fireRocket(built);

    expect(rocket.inuse).toBe(true);
    expect(rocket.s.number).toBeGreaterThanOrEqual(MAX_CLIENTS);
    expect(rocket.s.eType).toBe(ET.MISSILE);
    expect(rocket.s.weapon).toBe(WP.ROCKET_LAUNCHER);
    expect(missiles(built)).toEqual([rocket]);
  });

  it('is owned by whoever fired it, twice over', () => {
    // `r.ownerNum` is the number a trace passes through, and `parent` is who a blast belongs to.
    // Quake 3 keeps both because one is the server's and one is the game's.
    const built = world();
    const rocket = fireRocket(built);

    expect(rocket.r.ownerNum).toBe(built.owner.s.number);
    expect(rocket.parent).toBe(built.owner);
  });

  it('tells a client whose it is, which draws its own further on than anyone else', () => {
    // From a slot that is not 0, which is what an unwritten field would read as.
    const built = world();
    built.owner.s.number = 3;
    const rocket = fireRocket(built);

    expect(rocket.s.otherEntityNum).toBe(3);
  });

  it('carries what its blast is worth, so a missile in flight owes nothing to a table', () => {
    const built = world();
    const rocket = fireRocket(built);
    const spec = MISSILES[WP.ROCKET_LAUNCHER]!;

    expect(rocket.splashDamage).toBe(spec.splashDamage);
    expect(rocket.splashRadius).toBe(spec.splashRadius);
    expect(rocket.damage).toBe(spec.damage);
  });

  it('is dated 50 ms in the past, and left standing at the muzzle', () => {
    // The prestep makes the first frame a long one. What it does *not* do is move the missile:
    // `r.currentOrigin` stays at the muzzle, so the first trace sweeps from there. Teleporting it
    // forward instead puts a rocket fired at your feet under the floor, where it detonates with
    // no line of sight back and the rocket jump silently does nothing.
    const built = world();
    built.level.runFrame(1000);
    const rocket = fireRocket(built);

    expect(rocket.s.pos.trTime).toBe(1000 - MISSILE_PRESTEP_TIME);
    expect(rocket.r.currentOrigin).toEqual(rocket.s.pos.trBase);
  });

  it('truncates its velocity to whole units, so speed is slightly direction-dependent', () => {
    const built = world();
    const rocket = fireMissileAlong(built, WP.ROCKET_LAUNCHER, vec3(1, 1, 0));
    const { trDelta } = rocket.s.pos;

    expect(trDelta.x).toBe(Math.trunc(trDelta.x));
    expect(trDelta.y).toBe(Math.trunc(trDelta.y));
    expect(Math.hypot(trDelta.x, trDelta.y)).toBeLessThan(900);
  });

  it('flies a rocket flat and lets a grenade fall', () => {
    const built = world();
    const rocket = fireRocket(built);
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));

    expect(rocket.s.pos.trType).toBe(TR.LINEAR);
    expect(grenade.s.pos.trType).toBe(TR.GRAVITY);
    // Only the grenade bounces, which is what `EF_BOUNCE_HALF` says.
    expect(rocket.s.eFlags & EF_BOUNCE_HALF).toBe(0);
    expect(grenade.s.eFlags & EF_BOUNCE_HALF).toBeTruthy();
  });

  it('lobs a grenade above the crosshair', () => {
    // `weapon_grenadelauncher_fire` tilts the aim up by 0.2 before normalising it.
    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    expect(grenade.s.pos.trDelta.z).toBeGreaterThan(0);
  });

  it('starts where it is told and flies the aim it is given, as `fire_*` does', () => {
    // The lift is the launcher's, and the whole units the player's muzzle; a shooter has neither.
    const built = world();
    const grenade = fireMissile(
      built.level,
      built.owner,
      WP.GRENADE_LAUNCHER,
      vec3(10.5, -20.25, 30.75),
      vec3(1, 0, 0),
      () => {}
    );
    expect(grenade.s.pos.trBase).toEqual(vec3(10.5, -20.25, 30.75));
    expect(grenade.r.currentOrigin).toEqual(vec3(10.5, -20.25, 30.75));
    expect(grenade.s.pos.trDelta).toEqual(vec3(700, 0, 0));
  });
});

describe('the frame runs it', () => {
  it('moves it along its trajectory, and not on the frame it was fired on', () => {
    // `G_RunFrame` is what moves a missile, and it has already run by the time `ClientThink`
    // fires one. The first flight is the long one the prestep paid for.
    const built = world();
    built.level.runFrame(1000);
    const rocket = fireRocket(built);
    expect(rocket.r.currentOrigin.x).toBe(rocket.s.pos.trBase.x);

    built.level.runFrame(1008);
    expect(rocket.r.currentOrigin).toEqual(evaluateTrajectory(rocket.s.pos, 1008));
    expect(rocket.r.currentOrigin.x - rocket.s.pos.trBase.x).toBeCloseTo(
      0.9 * (8 + MISSILE_PRESTEP_TIME),
      6
    );
  });

  it('takes it out of the world when it hits something', () => {
    const built = world(createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]));
    fireRocket(built);
    expect(missiles(built)).toHaveLength(1);

    // 900 ups reaches a wall 256 units away well inside one 8 ms frame, because of the prestep.
    for (let time = 8; time <= 400 && missiles(built).length > 0; time += 8) {
      built.level.runFrame(time);
    }
    expect(missiles(built)).toHaveLength(0);
  });

  it('keeps the slot until its impact has been seen, then gives it back', () => {
    // A spent missile is not freed on the frame it goes off: it stays as the event saying so,
    // for as long as it takes every client to have been sent it. Freeing it at once would take
    // the only record of the explosion with it.
    const built = world(createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]));
    const rocket = fireRocket(built);
    const slot = rocket.s.number;

    for (let time = 8; time <= 400 && rocket.s.eType === ET.MISSILE; time += 8) {
      built.level.runFrame(time);
    }
    const wentOff = built.level.time;
    expect(rocket.inuse).toBe(true);
    expect(rocket.freeAfterEvent).toBe(true);

    for (let time = wentOff + 8; time <= wentOff + EVENT_VALID_MSEC && rocket.inuse; time += 8) {
      built.level.runFrame(time);
    }
    expect(rocket.inuse).toBe(true);

    built.level.runFrame(wentOff + EVENT_VALID_MSEC + 8);
    expect(rocket.inuse).toBe(false);
    // The slot keeps its number, because that is the slot's identity rather than the missile's.
    expect(rocket.s.number).toBe(slot);
  });

  it('bounces a grenade and restarts its arc from where it landed', () => {
    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));

    for (let time = 8; time <= 2000; time += 8) {
      built.level.runFrame(time);
      if (grenade.s.pos.trTime > 0) break;
    }
    // A bounce dates the trajectory to the moment of contact, so the grenade arcs as though
    // freshly thrown from there rather than continuing the fall it was in.
    expect(grenade.s.pos.trTime).toBeGreaterThan(0);
    expect(grenade.inuse).toBe(true);
  });

  it('rests a grenade on the floor once it is slow enough, with its fuse still running', () => {
    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));

    for (let time = 8; time <= 2400; time += 8) built.level.runFrame(time);

    expect(grenade.s.pos.trType).toBe(TR.STATIONARY);
    expect(grenade.inuse).toBe(true);
    expect(grenade.nextthink).toBeGreaterThan(0);
  });

  it('goes off when the fuse runs out, which is a think like any other', () => {
    // A grenade's 2.5 second fuse is `nextthink`, so it is the same mechanism that runs every
    // other timed thing in the world rather than a check inside the missile runner.
    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    const fuse = grenade.nextthink;
    expect(fuse).toBe(MISSILES[WP.GRENADE_LAUNCHER]!.lifetime);

    // Past the fuse rather than up to it: at an 8 ms tick no frame lands on 2500 exactly.
    for (let time = 8; time <= fuse + 8; time += 8) built.level.runFrame(time);

    expect(missiles(built)).toHaveLength(0);
    expect(grenade.s.eType).toBe(ET.GENERAL);
    // Nothing was struck, so the direction sent is straight up.
    expect(eventNumber(grenade.s.event)).toBe(EV.MISSILE_MISS);
    expect(byteToDir(grenade.s.eventParm)).toEqual(vec3(0, 0, 1));
  });

  it('detonates a rocket launched inside geometry rather than letting it through', () => {
    // A trace that starts inside a brush reports `startsolid` with a **full** fraction: it never
    // found a surface to stop at, so nothing else in the runner would notice.
    const built = world((start) => ({
      allsolid: true,
      startsolid: true,
      fraction: 1,
      endpos: vec3(start.x, start.y, start.z),
      normal: vec3(0, 0, 1),
      contents: CONTENTS.SOLID,
      surfaceFlags: 0,
      entityNum: ENTITYNUM_WORLD
    }));
    const rocket = fireRocket(built);
    const muzzle = vec3(
      rocket.r.currentOrigin.x,
      rocket.r.currentOrigin.y,
      rocket.r.currentOrigin.z
    );

    built.level.runFrame(8);
    expect(missiles(built)).toHaveLength(0);

    // It went off where it was, not where the trajectory would have carried it.
    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_MISS);
    expect(rocket.r.currentOrigin).toEqual(muzzle);
  });
});

describe('what it leaves behind', () => {
  it('stops being a missile and becomes the event saying where it burst', () => {
    // "Change over to a normal entity right at the point of impact": one entity does both jobs,
    // so the explosion costs a delta on something the client is already tracking rather than a
    // new entity beside it.
    const built = world(createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]));
    const rocket = fireRocket(built);

    runUntilImpact(built, rocket);

    expect(rocket.s.eType).toBe(ET.GENERAL);
    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_MISS);
    expect(rocket.freeAfterEvent).toBe(true);
    expect(rocket.eventTime).toBe(built.level.time);
  });

  it('packs the surface it struck into the one byte the event has', () => {
    // A normal costs three floats and an event has a byte, so Quake 3 sends the nearest of 162
    // fixed directions. The wall faces -X, and what comes back points within a few degrees.
    const built = world(createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]));
    const rocket = fireRocket(built);

    runUntilImpact(built, rocket);

    const sent = byteToDir(rocket.s.eventParm);
    expect(sent.x).toBeLessThan(-0.98);
    expect(dirToByte(sent)).toBe(rocket.s.eventParm);
  });

  it('places the impact back along the flight path rather than at the nearest unit', () => {
    // `SnapVectorTowards` rounds each component towards where the shot came from, which can only
    // move the mark out of the surface it belongs on and never into it.
    const built = world(createFlatWorldTrace([box(256.5, -512, 0, 288, 512, 512)]));
    const rocket = fireRocket(built);
    const from = rocket.s.pos.trBase.x;

    runUntilImpact(built, rocket);

    expect(rocket.r.currentOrigin.x).toBe(Math.floor(rocket.r.currentOrigin.x));
    expect(rocket.r.currentOrigin.x).toBeGreaterThan(from);
    expect(rocket.s.pos.trBase).toEqual(rocket.r.currentOrigin);
  });

  it('says a grenade bounced, on the grenade, and leaves it in the world', () => {
    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));

    for (let time = 8; time <= 2000; time += 8) {
      built.level.runFrame(time);
      if (eventNumber(grenade.s.event) === EV.GRENADE_BOUNCE) break;
    }

    expect(eventNumber(grenade.s.event)).toBe(EV.GRENADE_BOUNCE);
    expect(grenade.s.eType).toBe(ET.MISSILE);
    expect(grenade.freeAfterEvent).toBe(false);
  });

  it('counts a second bounce even though it is the same event as the first', () => {
    // The counter in the event's top two bits is the whole of how a client tells two of the same
    // event apart; without it a grenade rattling down a stair would sound once.
    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));

    const fields: number[] = [];
    for (let time = 8; time <= 2400; time += 8) {
      built.level.runFrame(time);
      const field = grenade.s.event;
      if (eventNumber(field) === EV.GRENADE_BOUNCE && fields.at(-1) !== field) fields.push(field);
    }

    expect(fields.length).toBeGreaterThan(1);
    // The same event, sent twice, as two different fields. The counter is two bits and wraps
    // every fourth, which is as far as a client that keeps only the last one can see.
    expect(eventNumber(fields[0])).toBe(eventNumber(fields[1]));
    expect(fields[0]).not.toBe(fields[1]);
  });

  it('runs a grenade\'s fuse on the frame it bounces on', () => {
    // "Check think function after bouncing": the fuse is checked after the move, so a grenade
    // whose fuse runs out on the same frame it hits the floor still goes off on that frame
    // rather than rattling on for another.
    const bounceTime = firstBounce();
    expect(bounceTime).toBeGreaterThan(0);

    const built = world();
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    grenade.nextthink = bounceTime;

    for (let time = 8; time <= bounceTime; time += 8) built.level.runFrame(time);

    expect(built.level.time).toBe(bounceTime);
    expect(grenade.s.eType).toBe(ET.GENERAL);
  });
});

describe('what a client is told', () => {
  it('is the trajectory, which is all it needs to place the rocket on any frame', () => {
    const built = world();
    built.level.runFrame(1000);
    const rocket = fireRocket(built);

    // The whole point of a trajectory on the wire: sent once, and the client places the missile
    // for itself on every frame in between without being told again.
    const out = Message.write(2048);
    writeDeltaEntity(out, createEntityState(), rocket.s, true);
    const back = Message.read(out.written.slice());
    const number = back.readBits(GENTITYNUM_BITS);
    const decoded = createEntityState();
    readDeltaEntity(back, createEntityState(), decoded, number);

    expect(decoded.eType).toBe(ET.MISSILE);
    expect(decoded.weapon).toBe(WP.ROCKET_LAUNCHER);
    expect(decoded.pos.trType).toBe(TR.LINEAR);
    expect(decoded.pos.trTime).toBe(rocket.s.pos.trTime);
    // Between two ticks, where a rendered frame falls, and it lands on the same point the
    // simulation would put it.
    const between = evaluateTrajectory(decoded.pos, 1004);
    expect(between).toEqual(evaluateTrajectory(rocket.s.pos, 1004));
    expect(between.x).toBeGreaterThan(rocket.s.pos.trBase.x);
  });
});

/** Fire a rocket straight along +X from the player's muzzle. */
function fireRocket(built: WeaponWorld) {
  return fireMissileAlong(built, WP.ROCKET_LAUNCHER, vec3(1, 0, 0));
}

/** Fire one of the projectile weapons along a direction, through `FireWeapon` itself. */
function fireMissileAlong(
  built: WeaponWorld,
  weapon: number,
  direction: { x: number; y: number; z: number },
  origin = vec3(0, 0, 24)
) {
  const state = built.owner.client!.ps;
  state.origin = copyOf(origin);
  state.viewheight = 26;
  state.weapon = weapon;
  state.viewangles = vec3(
    -Math.atan2(direction.z, Math.hypot(direction.x, direction.y)) * (180 / Math.PI),
    Math.atan2(direction.y, direction.x) * (180 / Math.PI),
    0
  );
  state.groundEntityNum = ENTITYNUM_NONE;

  const before = new Set(built.weapons.missiles);
  built.weapons.fire(state);
  const fired = built.weapons.missiles.find((missile) => !before.has(missile));
  if (!fired) throw new Error('nothing was fired');
  return fired;
}

describe("a missile's flight", () => {
  it('passes whoever fired it and stops at MASK_SHOT', () => {
    const { trace, asked } = recordingTrace(GROUND);
    const built = world(trace);
    const rocket = fireRocket(built);
    expect(rocket.clipmask).toBe(MASK.SHOT);

    built.level.runFrame(8);

    expect(distinctAsks(asked)).toEqual([
      { passEntityNum: built.owner.s.number, contentmask: MASK.SHOT }
    ]);
  });

  it('bounces a grenade off what cannot be hurt, and sets it off on what can', () => {
    // Whatever the grenade meets first is entity 5, standing on the floor.
    const hitFive: typeof GROUND = (...args) => {
      const result = GROUND(...args);
      return result.fraction < 1 ? { ...result, entityNum: 5 } : result;
    };

    const bounced = world(hitFive);
    const grenade = fireMissileAlong(bounced, WP.GRENADE_LAUNCHER, vec3(1, 0, -1));
    runUntilBounceOrImpact(bounced, grenade);
    expect(grenade.s.eType).toBe(ET.MISSILE);
    expect(eventNumber(grenade.s.event)).toBe(EV.GRENADE_BOUNCE);

    const struck = world(hitFive);
    struck.level.gentities[5].takedamage = true;
    const other = fireMissileAlong(struck, WP.GRENADE_LAUNCHER, vec3(1, 0, -1));
    runUntilBounceOrImpact(struck, other);
    expect(other.s.eType).toBe(ET.GENERAL);
    expect(eventNumber(other.s.event)).toBe(EV.MISSILE_MISS);
  });
});

/** A fresh copy of a point, so a test's constant is never the state's own. */
function copyOf(point: Vec3): Vec3 {
  return vec3(point.x, point.y, point.z);
}

/** Run frames until the missile bounces or goes off, whichever is first. */
function runUntilBounceOrImpact(built: WeaponWorld, missile: GameEntity): void {
  for (let time = built.level.time + 8; time <= 4000; time += 8) {
    built.level.runFrame(time);
    if (missile.s.eType !== ET.MISSILE) return;
    if (eventNumber(missile.s.event) === EV.GRENADE_BOUNCE) return;
  }
  throw new Error('the missile met nothing');
}

describe('a missile launched inside something', () => {
  it('asks where it already is, to learn what it is stuck in', () => {
    // The sweep starts inside entity 5 and gets out, so it names nobody. Only a trace that does
    // not move finds who it is in.
    const stuckInFive: typeof GROUND = (start, mins, maxs, end, ...rest) => {
      const still = start.x === end.x && start.y === end.y && start.z === end.z;
      const result = GROUND(start, mins, maxs, end, ...rest);
      return still
        ? { ...result, startsolid: true, allsolid: true, fraction: 0, entityNum: 5 }
        : { ...result, startsolid: true, fraction: 1, entityNum: ENTITYNUM_NONE };
    };
    const built = world(stuckInFive);
    built.level.gentities[5].takedamage = true;

    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    built.level.runFrame(8);

    // It went off rather than bouncing, because what it is in can be hurt.
    expect(grenade.s.eType).toBe(ET.GENERAL);
    expect(eventNumber(grenade.s.event)).toBe(EV.MISSILE_MISS);
  });
});

describe('a missile at rest', () => {
  /** A grenade lying where it was fired from, its trajectory stopped there. */
  function resting(built: WeaponWorld): GameEntity {
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    grenade.s.pos.trType = TR.STATIONARY;
    grenade.s.pos.trBase = copyOf(grenade.r.currentOrigin);
    return grenade;
  }

  it('is traced where it lies, so what comes onto it, a player or a mover, sets it off', () => {
    // Entity 5 has come to stand where the grenade lies: only a trace that does not move finds it.
    const coveredByFive: typeof GROUND = (start, mins, maxs, end, ...rest) => {
      const still = start.x === end.x && start.y === end.y && start.z === end.z;
      const result = GROUND(start, mins, maxs, end, ...rest);
      if (!still) return result;
      return { ...result, startsolid: true, allsolid: true, fraction: 0, entityNum: 5 };
    };
    const built = world(coveredByFive);
    built.level.gentities[5].takedamage = true;
    const grenade = resting(built);

    built.level.runFrame(8);
    expect(grenade.s.eType).toBe(ET.GENERAL);
    expect(eventNumber(grenade.s.event)).toBe(EV.MISSILE_MISS);
  });

  it('lies still while nothing comes to it, its fuse burning', () => {
    const built = world();
    const grenade = resting(built);
    const at = copyOf(grenade.r.currentOrigin);

    built.level.runFrame(8);
    expect(grenade.s.eType).toBe(ET.MISSILE);
    expect(grenade.r.currentOrigin).toEqual(at);
    expect(grenade.nextthink).toBeGreaterThan(8);
  });
});

describe('what a missile hits', () => {
  /** A player in `slot`, standing at `x` on the floor, with health to spare, linked there. */
  function standing(built: WeaponWorld, slot: number, x: number): GameEntity {
    const entity = built.level.gentities[slot];
    entity.client = built.level.clients[slot];
    entity.inuse = true;
    entity.takedamage = true;
    entity.r.contents = CONTENTS.BODY;
    Object.assign(entity.client.ps, createArmedPlayerState({ origin: vec3(x, 0, 24) }));
    entity.client.ps.clientNum = slot;
    entity.client.ps.stats[STAT.HEALTH] = 300;
    linkPlayer(built.level, entity);
    return entity;
  }

  /** A world whose shooter, in slot 0, is armed and standing at the origin. */
  function armed(): WeaponWorld {
    const built = world();
    Object.assign(built.owner.client!.ps, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
    return built;
  }

  /** What stopped a missile: `entityNum`, at `endpos`, facing back down −X. */
  function struck(entityNum: number, endpos = vec3(185, 0, 50)): TraceResult {
    return {
      ...clearTrace(endpos),
      fraction: 0.5,
      normal: vec3(-1, 0, 0),
      entityNum,
      contents: CONTENTS.BODY
    };
  }

  it("hurts a player it hits on its owner's account, pushing them the way it flew", () => {
    const built = armed();
    const target = standing(built, 1, 200);
    const rocket = fireRocket(built);

    missileImpact(built.level, rocket, struck(1), GROUND);

    const { ps } = target.client!;
    // The direct hit, and none of the blast, which passes over whoever the rocket hit.
    expect(ps.stats[STAT.HEALTH]).toBe(300 - 100);
    expect(ps.velocity.x).toBeCloseTo(500, 6);
    expect(ps.persistant[PERS.ATTACKER]).toBe(0);
    expect(target.client!.lasthurtMod).toBe(MOD.ROCKET);
  });

  it('names the player it hit in its event, where a wall gets a miss', () => {
    const built = armed();
    standing(built, 1, 200);
    const rocket = fireRocket(built);
    missileImpact(built.level, rocket, struck(1), GROUND);
    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_HIT);
    expect(rocket.s.otherEntityNum).toBe(1);
  });

  it('hurts anything else it hits that can be hurt, and says only that it missed', () => {
    const built = armed();
    const corpse = built.level.spawnEntity();
    corpse.takedamage = true;
    const rocket = fireRocket(built);

    missileImpact(built.level, rocket, struck(corpse.s.number), GROUND);

    expect(corpse.health).toBe(-100);
    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_MISS);
  });

  it("carries each weapon's own means of death, for the hit and for the blast", () => {
    const built = armed();
    const mods = [WP.GRENADE_LAUNCHER, WP.ROCKET_LAUNCHER, WP.PLASMAGUN, WP.BFG].map((weapon) => {
      const missile = fireMissileAlong(built, weapon, vec3(1, 0, 0));
      return [missile.methodOfDeath, missile.splashMethodOfDeath];
    });
    expect(mods).toEqual([
      [MOD.GRENADE, MOD.GRENADE_SPLASH],
      [MOD.ROCKET, MOD.ROCKET_SPLASH],
      [MOD.PLASMA, MOD.PLASMA_SPLASH],
      [MOD.BFG, MOD.BFG_SPLASH]
    ]);
  });

  it('throws a player who steps on a grenade at rest straight up', () => {
    // "Stepped on a grenade": a missile going nowhere pushes straight up, not along nothing.
    const built = armed();
    const target = standing(built, 1, 200);
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    grenade.s.pos.trType = TR.STATIONARY;

    missileImpact(built.level, grenade, struck(1), GROUND);

    const { velocity } = target.client!.ps;
    expect(velocity.x).toBeCloseTo(0, 6);
    expect(velocity.z).toBeCloseTo(500, 6);
    // Set off rather than bounced, since what it met can be hurt.
    expect(grenade.s.eType).toBe(ET.GENERAL);
  });

  it("counts a missile that hit a player as an accuracy hit for its owner", () => {
    const built = armed();
    standing(built, 1, 200);
    const rocket = fireRocket(built);

    missileImpact(built.level, rocket, struck(1), GROUND);

    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('counts a blast that reached a player where the missile itself struck the wall', () => {
    const built = armed();
    standing(built, 1, 200);
    const rocket = fireRocket(built);

    missileImpact(built.level, rocket, struck(ENTITYNUM_WORLD), GROUND);

    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('counts the blast once when the direct hit and the blast both reached players', () => {
    const built = armed();
    standing(built, 1, 200);
    standing(built, 2, 210);
    const rocket = fireRocket(built);

    missileImpact(built.level, rocket, struck(1), GROUND);

    // The blast reached the player beside them, and the shot is still one hit (`g_missile.c:434`).
    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('counts the blast for a corpse the missile hit directly, since a corpse is no hit', () => {
    const built = armed();
    const corpse = built.level.spawnEntity();
    corpse.takedamage = true;
    standing(built, 1, 200);
    const rocket = fireRocket(built);

    missileImpact(built.level, rocket, struck(corpse.s.number), GROUND);

    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('counts a blast that went off on its fuse when it reached a player', () => {
    const built = armed();
    standing(built, 1, 100);
    const rocket = fireRocket(built);

    explodeMissile(built.level, rocket, GROUND);

    expect(built.owner.client!.accuracyHits).toBe(1);
  });

  it('counts nothing for a blast that reached no client', () => {
    // The owner's own splash is not a hit: `LogAccuracyHit` refuses the attacker themselves.
    const built = armed();
    const rocket = fireRocket(built);

    explodeMissile(built.level, rocket, GROUND);

    expect(built.owner.client!.accuracyHits).toBe(0);
  });
});

describe("a missile on a BSP's brushes", () => {
  /** A sky's flags, as its shader's `surfaceparm sky` and `noimpact` set them. */
  const SKY = SURF.SKY | SURF.NOIMPACT;
  /** id's hook, as `fire_grapple` throws it. */
  const STYLE: GrappleStyle = {
    hookSpeed: Q3_GRAPPLE_SPEED,
    pullSpeed: Q3_GRAPPLE_SPEED,
    snap: true,
    launch: 'muzzle',
    refireWhileHeld: false
  };

  it('bursts on a brush, its miss facing the face it struck', () => {
    const built = world(brushAhead());
    const rocket = fireRocket(built);
    runUntilImpact(built, rocket);

    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_MISS);
    expect(byteToDir(rocket.s.eventParm).x).toBeLessThan(-0.98);
    expect(rocket.r.currentOrigin.x).toBeLessThan(256);
  });

  it('says a metal surface was struck, by EV_MISSILE_MISS_METAL', () => {
    const built = world(brushAhead(SURF.METALSTEPS));
    const rocket = fireRocket(built);
    runUntilImpact(built, rocket);

    expect(eventNumber(rocket.s.event)).toBe(EV.MISSILE_MISS_METAL);
    expect(byteToDir(rocket.s.eventParm).x).toBeLessThan(-0.98);
  });

  it('is gone in the sky, neither bursting nor bouncing there', () => {
    for (const weapon of [WP.ROCKET_LAUNCHER, WP.GRENADE_LAUNCHER, WP.PLASMAGUN]) {
      const built = world(brushAhead(SKY));
      const missile = fireMissileAlong(built, weapon, vec3(1, 0, 0));
      runUntilImpact(built, missile);

      expect(missile.inuse).toBe(false);
      const left = built.level.gentities.filter((e) => e.inuse && e.classname !== 'bodyque');
      expect(left).toEqual([built.owner]);
    }
  });

  it('frees a hook it takes, and tells its thrower it is gone', () => {
    const built = world(brushAhead(SKY));
    const at = vec3(0, 0, 50);
    const hook = fireGrapple(built.level, built.owner, at, vec3(1, 0, 0), STYLE, Q3_GRAPPLE_SPEED);
    expect(built.owner.client!.hook).toBe(hook.s.number);
    runUntilImpact(built, hook);

    expect(hook.inuse).toBe(false);
    expect(built.owner.client!.hook).toBe(NO_HOOK);
  });

  it("leaves its owner's hook alone when it is not the hook", () => {
    const built = world(brushAhead(SKY));
    // The hook away from the sky, into nothing, and a rocket into it.
    const at = vec3(0, 0, 50);
    const hook = fireGrapple(built.level, built.owner, at, vec3(-1, 0, 0), STYLE, Q3_GRAPPLE_SPEED);
    const rocket = fireRocket(built);
    runUntilImpact(built, rocket);

    expect([rocket.inuse, hook.inuse]).toEqual([false, true]);
    expect(built.owner.client!.hook).toBe(hook.s.number);
  });
});

describe("CPMA's rules for the missiles", () => {
  const CPM = presetRules('cpm');
  const MISSILE_WEAPONS = [WP.GRENADE_LAUNCHER, WP.ROCKET_LAUNCHER, WP.PLASMAGUN, WP.BFG];

  /** A world with a floor under `rules`, and the player in slot 0. */
  function ruled(rules: Readonly<Rules>, trace = GROUND): WeaponWorld {
    const built = weaponWorld({ trace, rules });
    built.owner.s.number = 0;
    return built;
  }

  /** Each missile weapon's shot along +X, under `rules`, from `origin`. */
  function volley(rules: Readonly<Rules>, origin = vec3(0, 0, 24)): GameEntity[] {
    return MISSILE_WEAPONS.map((weapon) =>
      fireMissileAlong(ruled(rules), weapon, vec3(1, 0, 0), origin)
    );
  }

  /** What a preset's missiles are, in the numbers where the presets differ. */
  function fired(name: string) {
    const rules = presetRules(name);
    const [gl, rl, pg, bfg] = volley(rules, vec3(0.25, 0.5, 24));
    const landed = landing(rules, vec3(301, 0, -401));
    landed.bounce();
    const pushed = struckFromTheSide(rules, WP.ROCKET_LAUNCHER);
    const worth = (missile: GameEntity) => [
      missile.damage,
      missile.splashDamage,
      missile.splashRadius
    ];
    return {
      gl: worth(gl),
      rl: worth(rl),
      pg: worth(pg),
      bfg: worth(bfg),
      speed: [gl, rl, pg, bfg].map((missile) => missile.s.pos.trDelta.x),
      fuse: gl.nextthink,
      bfgBox: [bfg.r.mins.x, bfg.r.maxs.x],
      start: rl.s.pos.trBase,
      // A grenade's speed off the floor, from (301, 0, -401).
      bounce: Math.round(landed.grenade.s.pos.trDelta.x * 100) / 100,
      // A rocket's push on a player 15 along and 15 aside.
      push: [Math.round(pushed.x), Math.round(pushed.y)],
      // The client's, which it reads from the serverinfo.
      plasma: [rules.g_plasmaSize, rules.g_plasmaMarkSize]
    };
  }

  /** CPMA's, where the four presets agree. */
  const CPMA = { gl: [100, 100, 150], start: vec3(1, 0, 50) };
  /** CPM's and those built on it: a truncated bounce at 0.5. Each pushes away by its own scale. */
  const CPM_WAY = { bounce: 150 };

  it.each([
    [
      'vq3',
      {
        gl: [100, 100, 150], rl: [100, 100, 120], pg: [20, 15, 20], bfg: [100, 100, 120],
        speed: [686, 900, 2000, 2000], fuse: 2500, bfgBox: [0, 0], start: vec3(14, 0, 50),
        bounce: 195.65, push: [500, 0], plasma: [16, 16]
      }
    ],
    [
      'pmc',
      {
        ...CPMA, rl: [100, 100, 120], pg: [15, 15, 20], bfg: [120, 120, 144],
        speed: [686, 1000, 2000, 1200], fuse: 2500, bfgBox: [0, 0],
        bounce: 195, push: [600, 0], plasma: [8, 8]
      }
    ],
    [
      'cpm',
      {
        ...CPMA, ...CPM_WAY, rl: [100, 100, 120], pg: [18, 15, 20], bfg: [100, 0, 0],
        speed: [784, 1000, 2000, 2000], fuse: 2000, bfgBox: [-2, 2], push: [398, -398],
        plasma: [8, 8]
      }
    ],
    [
      'cq3',
      {
        ...CPMA, ...CPM_WAY, rl: [100, 100, 110], pg: [20, 15, 20], bfg: [125, 0, 0],
        speed: [784, 950, 2000, 2000], fuse: 2000, bfgBox: [-2, 2], push: [389, -389],
        plasma: [12, 8]
      }
    ],
    [
      'dev',
      {
        ...CPMA, ...CPM_WAY, rl: [100, 100, 120], pg: [18, 15, 20], bfg: [100, 0, 0],
        speed: [784, 1000, 2000, 2000], fuse: 2000, bfgBox: [-2, 2], push: [398, -398],
        plasma: [8, 8]
      }
    ]
  ])("fires %s's missiles", (name, expected) => {
    expect(fired(name)).toEqual(expected);
  });

  it("keeps id's numbers where every preset does", () => {
    const ids = defaultRules();
    const same = [
      'g_damage_gl',
      'g_damage_rl',
      'g_splashdamage_gl',
      'g_splashdamage_rl',
      'g_splashdamage_pg',
      'g_splashradius_gl',
      'g_splashradius_pg',
      'g_velocity_pg'
    ] as const;
    for (const name of ['pmc', 'cpm', 'cq3', 'dev']) {
      const rules = presetRules(name);
      for (const rule of same) expect(rules[rule], `${name}: ${rule}`).toBe(ids[rule]);
    }
  });

  it("reads each missile's numbers from its own rules", () => {
    const odd = {
      ...ID_RULES,
      g_damage_gl: 101,
      g_damage_rl: 102,
      g_damage_pg: 103,
      g_damage_bfg: 104,
      g_splashdamage_gl: 111,
      g_splashdamage_rl: 112,
      g_splashdamage_pg: 113,
      g_splashdamage_bfg: 114,
      g_splashradius_gl: 121,
      g_splashradius_rl: 122,
      g_splashradius_pg: 123,
      g_splashradius_bfg: 124,
      g_velocity_gl: 1001,
      g_velocity_rl: 1002,
      g_velocity_pg: 1003,
      g_velocity_bfg: 1004,
      g_fuse_gl: 1234
    };
    const missiles = volley(odd);
    expect(missiles.map((missile) => missile.damage)).toEqual([101, 102, 103, 104]);
    expect(missiles.map((missile) => missile.splashDamage)).toEqual([111, 112, 113, 114]);
    expect(missiles.map((missile) => missile.splashRadius)).toEqual([121, 122, 123, 124]);
    // The grenade's aim is tilted up by 0.2 before it is scaled.
    expect(missiles.map((missile) => missile.s.pos.trDelta.x)).toEqual([981, 1002, 1003, 1004]);
    expect(missiles[0].nextthink).toBe(1234);
  });

  it('has no blast with no splash radius, whatever its splash damage', () => {
    const [, rocket] = volley({ ...ID_RULES, g_splashradius_rl: 0 });
    expect([rocket.splashDamage, rocket.splashRadius]).toEqual([0, 0]);
  });

  it("starts a missile at the muzzle in whole units, which id's muzzle already is", () => {
    const [, rocket] = volley(CPM, vec3(0.25, 0.5, 24));
    expect(rocket.s.pos.trBase).toEqual(vec3(1, 0, 50));
    expect(rocket.r.currentOrigin).toEqual(vec3(1, 0, 50));
  });

  it('flies the BFG as a box of ± g_size_bfg, which meets a wall that much sooner', () => {
    const wall = createFlatWorldTrace([box(256, -512, 0, 288, 512, 512)]);
    const burst = (rules: Readonly<Rules>) => {
      const built = ruled(rules, wall);
      const ball = fireMissileAlong(built, WP.BFG, vec3(1, 0, 0));
      runUntilImpact(built, ball);
      return ball.r.currentOrigin.x;
    };
    expect(burst(ID_RULES) - burst({ ...ID_RULES, g_size_bfg: 2 })).toBe(2);
  });

  /** A grenade at `endpos` moving at `velocity`, for a bounce off `normal` at 1000 ms. */
  function landing(rules: Readonly<Rules>, velocity: Vec3) {
    const built = ruled(rules);
    built.level.runFrame(1000);
    const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
    grenade.s.pos.trType = TR.LINEAR;
    grenade.s.pos.trDelta = velocity;
    const endpos = vec3(100.6, 0.3, 0.2);
    grenade.r.currentOrigin = copyOf(endpos);
    const bounce = () => bounceMissile(built.level, grenade, endpos, vec3(0, 0, 1), 0.5, rules);
    return { grenade, bounce };
  }

  it('truncates the bounce under g_bounceTruncate_gl: the speed kept, and the base', () => {
    const cpm = landing(CPM, vec3(301, 0, -401));
    cpm.bounce();
    expect(cpm.grenade.s.pos.trDelta).toEqual(vec3(150, 0, 200));
    expect(cpm.grenade.s.pos.trBase).toEqual(vec3(100, 0, 1));
    // The origin it is traced from keeps its fraction.
    expect(cpm.grenade.r.currentOrigin.x).toBeCloseTo(100.6, 9);

    const id = landing(ID_RULES, vec3(301, 0, -401));
    id.bounce();
    expect(id.grenade.s.pos.trDelta.x).toBeCloseTo(195.65, 9);
    expect(id.grenade.s.pos.trDelta.z).toBeCloseTo(260.65, 9);
    expect(id.grenade.s.pos.trBase.x).toBeCloseTo(100.6, 9);
    expect(id.grenade.s.pos.trBase.z).toBeCloseTo(1.2, 9);
  });

  it('rests a grenade whose kept speed is under 40 only once truncated', () => {
    // Kept at 0.5, (28.95, 28.95) is 40.9 fast; truncated, (28, 28) is 39.6.
    const truncated = landing(CPM, vec3(57.9, 0, -57.9));
    truncated.bounce();
    expect(truncated.grenade.s.pos.trType).toBe(TR.STATIONARY);

    const whole = landing({ ...CPM, g_bounceTruncate_gl: 0 }, vec3(57.9, 0, -57.9));
    whole.bounce();
    expect(whole.grenade.s.pos.trType).toBe(TR.LINEAR);
    expect(whole.grenade.s.pos.trDelta.x).toBeCloseTo(28.95, 9);
  });

  it('rests it a unit up in whole units, keeping the time it was thrown', () => {
    const cpm = landing(CPM, vec3(30, 0, -40));
    expect(cpm.grenade.s.time).toBe(1000);
    cpm.bounce();
    expect(cpm.grenade.s.pos.trBase).toEqual(vec3(100, 0, 1));
    expect(cpm.grenade.s.time).toBe(1000);

    // id's rests where it stopped, and stamps the rest.
    const id = landing(ID_RULES, vec3(30, 0, -40));
    expect(id.grenade.s.time).toBe(0);
    id.bounce();
    expect(id.grenade.s.pos.trBase).toEqual(vec3(100.6, 0.3, 0.2));
    expect(id.grenade.s.time).toBe(250);
  });

  it('bounces a grenade in flight by the rules of the moment it bounces', () => {
    const firstBounceDelta = (bounce: number) => {
      const rules = { ...ID_RULES };
      const built = ruled(rules);
      const grenade = fireMissileAlong(built, WP.GRENADE_LAUNCHER, vec3(1, 0, 0));
      rules.g_bounce_gl = bounce;
      runUntilBounceOrImpact(built, grenade);
      return grenade.s.pos.trDelta;
    };
    const kept = firstBounceDelta(0.5);
    const ids = firstBounceDelta(0.65);
    expect(kept.x / ids.x).toBeCloseTo(0.5 / 0.65, 9);
    expect(kept.z / ids.z).toBeCloseTo(0.5 / 0.65, 9);
  });

  /** A player standing at x = 200, struck by `weapon`'s missile from (185, 15, 24). */
  function struckFromTheSide(rules: Readonly<Rules>, weapon: number): Vec3 {
    const built = ruled(rules);
    Object.assign(built.owner.client!.ps, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
    const target = built.level.gentities[1];
    target.client = built.level.clients[1];
    target.inuse = true;
    target.takedamage = true;
    target.r.contents = CONTENTS.BODY;
    Object.assign(target.client.ps, createArmedPlayerState({ origin: vec3(200, 0, 24) }));
    target.client.ps.clientNum = 1;
    target.client.ps.stats[STAT.HEALTH] = 300;
    linkPlayer(built.level, target);
    const missile = fireMissileAlong(built, weapon, vec3(1, 0, 0));
    missile.r.currentOrigin = vec3(185, 15, 24);
    const hit: TraceResult = {
      ...clearTrace(vec3(185, 15, 24)),
      fraction: 0.5,
      normal: vec3(-1, 0, 0),
      entityNum: 1,
      contents: CONTENTS.BODY
    };
    missileImpact(built.level, missile, hit, GROUND, rules);
    return target.client.ps.velocity;
  }

  it('pushes a direct hit away from a missile with a blast under g_knockback_directAway', () => {
    const away = struckFromTheSide({ ...ID_RULES, g_knockback_directAway: 1 }, WP.ROCKET_LAUNCHER);
    expect(away.x).toBeCloseTo(353.553, 3);
    expect(away.y).toBeCloseTo(-353.553, 3);
    // id's pushes along the flight.
    const along = struckFromTheSide(ID_RULES, WP.ROCKET_LAUNCHER);
    expect([along.x, along.y]).toEqual([500, 0]);
  });

  it("keeps id's push for a missile without a blast, as CPM's BFG is", () => {
    const along = struckFromTheSide(CPM, WP.BFG);
    expect([along.x, along.y]).toEqual([500, 0]);
  });
});
