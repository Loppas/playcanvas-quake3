import { TR } from '../../net/protocol';
import { damage, logAccuracyHit } from '../combat';
import { EF_BOUNCE_HALF, MASK, SURF } from '../constants';
import { dirToByte } from '../dir-byte';
import { EV } from '../events';
import { ET, addEvent, setEntityOrigin, type GameEntity } from '../game-entity';
import type { Level } from '../level';
import { ID_RULES, type Rules } from '../rules';
import { evaluateTrajectory, evaluateTrajectoryDelta } from '../trajectory';
import type { TraceFn, TraceResult } from '../types';
import { add, copy, dot, length, madd, normalize, scale, sub, vec3, type Vec3 } from '../vec3';
import {
  BOUNCE_REST_NORMAL_Z,
  BOUNCE_REST_SPEED,
  MISSILES,
  MISSILE_PRESTEP_TIME,
  WP,
  type WeaponId
} from './constants';
import { hookImpact, NO_HOOK } from './grapple';
import { snapVectorTowards, truncVector } from './hitscan';
import { radiusDamage } from './splash';

/**
 * Projectiles (`g_missile.c`): the entity a shot leaves behind, and the frame that runs it.
 *
 * A missile is an ordinary entity in the level's pool with `ET_MISSILE` on it and a trajectory on
 * `s.pos`. Nothing integrates it forward — `fire_*` writes down where it started, how fast and
 * when, and every frame asks {@link evaluateTrajectory} where the formula puts it now. The trace
 * is only there to find what it ran into on the way.
 *
 * That is the whole reason a missile can be sent over the wire at all: the server sends the
 * trajectory once and every client places the rocket on every frame in between for itself,
 * without being told again.
 *
 * The grapple's hook is one of these too (`fire_grapple`, `g_missile.c:680`) — same entity type,
 * same runner, and the impact is what attaches it.
 */

/** Whether an entity is a missile the frame should run. */
export function isMissile(entity: GameEntity): boolean {
  return entity.s.eType === ET.MISSILE;
}

/** The suffix each missile's rules are named by. */
const RULE_SUFFIX: Partial<Record<WeaponId, 'gl' | 'rl' | 'pg' | 'bfg'>> = {
  [WP.GRENADE_LAUNCHER]: 'gl',
  [WP.ROCKET_LAUNCHER]: 'rl',
  [WP.PLASMAGUN]: 'pg',
  [WP.BFG]: 'bfg'
};

/**
 * The shared body of `fire_rocket` and its four siblings (`g_missile.c:522–710`).
 *
 * Two details carry real weight. `trDelta` is integer-truncated, so a missile's speed is very
 * slightly direction-dependent; `trBase` is the start as given. And `trTime` is set 50 ms in the
 * **past**
 * ({@link MISSILE_PRESTEP_TIME}) so the missile is already moving on the frame it is created —
 * "move a bit on the very first frame", as the original's comment puts it.
 *
 * Note what the prestep does *not* do: `fire_rocket` leaves `r.currentOrigin` at the muzzle, so
 * the first trace runs from the muzzle to the prestepped point rather than starting there.
 * Teleporting the missile forward instead looks equivalent until you fire straight down at your
 * feet, where 45 units of head start puts the rocket underneath the floor — it then detonates
 * inside solid geometry with no line of sight back to the player, and the rocket jump silently
 * does nothing.
 *
 * Projectiles deliberately do **not** inherit the player's velocity; the line that would do so is
 * commented out in the original.
 *
 * @param level - The level to spawn the entity in.
 * @param owner - Who fired it: the trace passes through them, and a blast is theirs.
 * @param weapon - The firing weapon, which picks the missile out of {@link MISSILES}.
 * @param muzzle - Where it starts.
 * @param direction - The aim, which need not be a unit vector.
 * @param onFuse - `G_ExplodeMissile`: what to do when the fuse runs out with nothing hit. It is
 *   asked for rather than defaulted, because a missile with a fuse and no think is one the frame
 *   will refuse to run.
 * @param rules - The rules of play, which give the missile's numbers.
 * @returns The missile's entity, already in the world.
 */
export function fireMissile(
  level: Level,
  owner: GameEntity,
  weapon: WeaponId,
  muzzle: Vec3,
  direction: Vec3,
  onFuse: (self: GameEntity) => void,
  rules: Readonly<Rules> = ID_RULES
): GameEntity {
  const spec = MISSILES[weapon];
  const suffix = RULE_SUFFIX[weapon];
  if (!spec || !suffix) throw new Error(`weapon ${weapon} fires no projectile`);

  const aim = normalize(direction);

  const missile = level.spawnEntity();
  missile.classname = 'missile';
  missile.s.eType = ET.MISSILE;
  missile.s.weapon = weapon;
  missile.r.ownerNum = owner.s.number;
  // Whose it is, as unlagged sends it, so a client can draw its own a snapshot gap further on than
  // anyone else's.
  missile.s.otherEntityNum = owner.s.number;
  missile.parent = owner;
  // What its flight stops at (`g_missile.c:664`): the world and every player, living or dead.
  missile.clipmask = MASK.SHOT;
  missile.damage = rules[`g_damage_${suffix}`];
  missile.splashRadius = rules[`g_splashradius_${suffix}`];
  // `fire_bfg`'s rule, for all four: with no radius there is no splash.
  missile.splashDamage = missile.splashRadius ? rules[`g_splashdamage_${suffix}`] : 0;
  missile.methodOfDeath = spec.mod;
  missile.splashMethodOfDeath = spec.splashMod;
  // The fuse is a think, as Quake 3's is: a grenade that never hits anything goes off by the
  // same mechanism that runs every other timed thing in the world.
  const lifetime = weapon === WP.GRENADE_LAUNCHER ? rules.g_fuse_gl : spec.lifetime;
  missile.nextthink = level.time + lifetime;
  missile.think = onFuse;
  if (spec.bounce > 0) {
    missile.s.eFlags |= EF_BOUNCE_HALF;
    // CPMA's grenade stamps its launch, and keeps the stamp when it rests.
    if (rules.g_bounceTruncate_gl) missile.s.time = level.time;
  }
  const size = weapon === WP.BFG ? rules.g_size_bfg : 0;
  if (size) {
    missile.r.mins = vec3(-size, -size, -size);
    missile.r.maxs = vec3(size, size, size);
  }

  missile.s.pos.trType = spec.motion === 'gravity' ? TR.GRAVITY : TR.LINEAR;
  missile.s.pos.trTime = level.time - MISSILE_PRESTEP_TIME;
  missile.s.pos.trBase = copy(muzzle);
  missile.s.pos.trDelta = truncVector(scale(aim, rules[`g_velocity_${suffix}`]));
  missile.r.currentOrigin = copy(missile.s.pos.trBase);

  return missile;
}

/**
 * `G_BounceMissile` (`g_missile.c:33–57`) — reflect off a surface and keep going.
 *
 * The velocity reflected is the one the missile actually had **at the moment of contact**,
 * interpolated to the trace fraction, not the launch velocity and not the velocity at the end of
 * the frame.
 *
 * The missile comes to rest when it is slow enough *and* on a surface flat enough to hold it, at
 * which point its fuse keeps ticking where it lies. Otherwise the trajectory is restarted from
 * the impact point, which resets the gravity clock — a bounced grenade arcs as though freshly
 * thrown from there.
 *
 * `EF_BOUNCE_HALF` keeps `g_bounce_gl` of the speed off each surface, id's 65%.
 *
 * @param level - The level, for the two ends of the frame the contact is interpolated between.
 * @param entity - The missile; its trajectory is rewritten.
 * @param endpos - Where the trace stopped.
 * @param normal - The surface it struck.
 * @param fraction - How far along the frame the contact happened.
 * @param rules - The rules of play, read as it bounces.
 */
export function bounceMissile(
  level: Level,
  entity: GameEntity,
  endpos: Vec3,
  normal: Vec3,
  fraction: number,
  rules: Readonly<Rules> = ID_RULES
): void {
  const hitTime = level.previousTime + (level.time - level.previousTime) * fraction;
  const velocity = evaluateTrajectoryDelta(entity.s.pos, hitTime);
  const reflected = madd(velocity, -2 * dot(velocity, normal), normal);
  const truncate = rules.g_bounceTruncate_gl !== 0;
  const kept = scale(reflected, rules.g_bounce_gl);
  entity.s.pos.trDelta = truncate ? truncVector(kept) : kept;

  if (
    normal.z > BOUNCE_REST_NORMAL_Z &&
    length(entity.s.pos.trDelta) < BOUNCE_REST_SPEED
  ) {
    if (truncate) {
      setEntityOrigin(entity, truncVector(add(endpos, vec3(0, 0, 1))));
      return;
    }
    setEntityOrigin(entity, endpos);
    // `s.time = level.time / 4`: when the grenade settled, which the client draws its wobble
    // from. A quarter of a millisecond is all the field can hold.
    entity.s.time = Math.trunc(level.time / 4);
    return;
  }

  // A unit off the surface, so the next frame's trace does not start inside it.
  const origin = add(entity.r.currentOrigin, normal);
  entity.r.currentOrigin = origin;
  entity.s.pos.trBase = truncate ? truncVector(origin) : copy(origin);
  entity.s.pos.trTime = level.time;
}

/**
 * `G_ExplodeMissile` (`g_missile.c:67–93`): the fuse ran out with nothing hit.
 *
 * The missile stops being a missile and becomes the event that says it went off, at the point the
 * trajectory had reached. Nothing else is left of it: `freeAfterEvent` hands the slot back as
 * soon as every client has had time to see the event, which is the frame's job rather than this
 * one's.
 *
 * There is no surface to report, so the direction sent is straight up — the same fallback Quake 3
 * uses, and the reason a rocket that times out in mid-air throws its scorch at the sky.
 *
 * Its blast reaches everything but the missile itself, on its owner's account.
 *
 * @param level - The level the missile is in.
 * @param entity - The missile whose fuse ran out.
 * @param trace - `trap_Trace`, for the blast's line of sight.
 */
export function explodeMissile(level: Level, entity: GameEntity, trace: TraceFn): void {
  const origin = truncVector(evaluateTrajectory(entity.s.pos, level.time));
  setEntityOrigin(entity, origin);

  entity.s.eType = ET.GENERAL;
  addEvent(entity, EV.MISSILE_MISS, dirToByte(vec3(0, 0, 1)), level.time);
  entity.freeAfterEvent = true;

  if (entity.splashDamage) {
    const hitClient = radiusDamage(
      level,
      trace,
      entity.r.currentOrigin,
      entity.parent,
      entity.splashDamage,
      entity.splashRadius,
      entity,
      entity.splashMethodOfDeath
    );
    // A blast that reached a client counts for its owner's accuracy (`g_missile.c:88`).
    const owner = entity.parent;
    if (hitClient && owner?.client) owner.client.accuracyHits++;
  }

  level.linkEntity(entity);
}

/**
 * `G_MissileImpact` (`g_missile.c:220–420`): the missile ran into something.
 *
 * A grenade bounces and stays a missile; anything else stops being one. The original's comment
 * wonders aloud whether it would be cheaper to free the missile and spawn an explosion beside it,
 * and then does the opposite — the missile *is* the explosion, carrying the event at exactly the
 * point of impact, which costs a delta on an entity the client is already tracking instead of a
 * new one.
 *
 * Whatever it struck takes its direct damage first, if it can be hurt, pushed the way the missile
 * was going — or straight up, "stepped on a grenade", if it had stopped. Under
 * `g_knockback_directAway` a missile with a blast pushes it away from the missile instead. The
 * missile's owner answers for it.
 *
 * What the impact says then depends on what was struck: `EV_MISSILE_HIT` for a player, naming
 * them, `EV_MISSILE_MISS_METAL` for a metal surface, and `EV_MISSILE_MISS` otherwise. The blast
 * reaches everything else, but not whoever was hit directly.
 *
 * The grapple's hook is the exception, and it is told apart by name as Quake 3 tells it apart:
 * it does not go off, it stays where it caught.
 *
 * @param level - The level the missile is in.
 * @param entity - The missile that hit something.
 * @param result - The trace that stopped it.
 * @param trace - `trap_Trace`, for the blast's line of sight.
 * @param rules - The rules of play, read as it hits.
 */
export function missileImpact(
  level: Level,
  entity: GameEntity,
  result: TraceResult,
  trace: TraceFn,
  rules: Readonly<Rules> = ID_RULES
): void {
  // "Check for bounce": off anything that cannot be hurt, the world among them.
  const other = level.gentities[result.entityNum];
  if (!other.takedamage && entity.s.eFlags & EF_BOUNCE_HALF) {
    bounceMissile(level, entity, result.endpos, result.normal, result.fraction, rules);
    addEvent(entity, EV.GRENADE_BOUNCE, 0, level.time);
    return;
  }

  const owner = level.gentities[entity.r.ownerNum];
  let hitClient = false;

  // "Impact damage", which Quake 3 marks "FIXME: wrong damage direction?".
  if (other.takedamage && entity.damage) {
    let push = evaluateTrajectoryDelta(entity.s.pos, level.time);
    if (length(push) === 0) push.z = 1;
    if (rules.g_knockback_directAway && entity.splashDamage) {
      push = sub(other.r.currentOrigin, entity.r.currentOrigin);
    }
    if (logAccuracyHit(level, other, owner)) {
      if (owner.client) owner.client.accuracyHits++;
      hitClient = true;
    }
    damage(level, other, entity, owner, push, entity.damage, 0, entity.methodOfDeath);
  }

  if (entity.classname === 'hook') {
    hookImpact(level, entity, result);
    return;
  }

  if (other.takedamage && other.client) {
    addEvent(entity, EV.MISSILE_HIT, dirToByte(result.normal), level.time);
    entity.s.otherEntityNum = other.s.number;
  } else if (result.surfaceFlags & SURF.METALSTEPS) {
    addEvent(entity, EV.MISSILE_MISS_METAL, dirToByte(result.normal), level.time);
  } else {
    addEvent(entity, EV.MISSILE_MISS, dirToByte(result.normal), level.time);
  }
  entity.freeAfterEvent = true;
  // "Change over to a normal entity right at the point of impact": a missile is drawn by its
  // type, so this is what stops the rocket being drawn where it burst.
  entity.s.eType = ET.GENERAL;

  // Snapped back along the flight path rather than to the nearest unit, so the mark cannot end
  // up inside the surface it belongs on.
  const origin = snapVectorTowards(result.endpos, entity.s.pos.trBase);
  setEntityOrigin(entity, origin);

  // "Splash damage (doesn't apply to person directly hit)."
  if (entity.splashDamage) {
    const reached = radiusDamage(
      level,
      trace,
      origin,
      entity.parent,
      entity.splashDamage,
      entity.splashRadius,
      other,
      entity.splashMethodOfDeath
    );
    // One hit for the shot, even when the blast reached someone the missile did not
    // (`g_missile.c:430–437`).
    if (reached && !hitClient && owner.client) owner.client.accuracyHits++;
  }

  level.linkEntity(entity);
}

/**
 * `G_RunMissile` (`g_missile.c:448–511`): move one missile and see what it ran into.
 *
 * The trace runs from where the missile was to where the trajectory says it is now, which is a
 * chord across the true arc. The port runs it once per 8 ms tick rather than once per 50 ms
 * server frame, so the chord is shorter and hugs the arc more closely — a fidelity gain rather
 * than a difference in behaviour, though a grenade may contact a slope a fraction of a frame
 * earlier than stock Quake 3 would.
 *
 * One that runs into the sky is simply gone: it neither bursts nor bounces there, and a hook in
 * flight is no longer its thrower's.
 *
 * A grenade at rest is traced too, from where it lies to where it lies, so it meets whatever
 * comes to it: a player who steps on it sets it off, and a door that closes on it is hurt by it.
 *
 * @param level - The level the missile is in.
 * @param entity - The missile to run.
 * @param trace - `trap_Trace`.
 * @param rules - The rules of play, for what it runs into.
 */
export function runMissile(
  level: Level,
  entity: GameEntity,
  trace: TraceFn,
  rules: Readonly<Rules> = ID_RULES
): void {
  const target = evaluateTrajectory(entity.s.pos, level.time);

  // A point trace, since `fire_rocket` leaves a missile's mins and maxs zero, and one that
  // "ignore[s] interactions with the missile owner".
  const passent = entity.r.ownerNum;
  const { mins, maxs } = entity.r;
  const origin = entity.r.currentOrigin;
  let result = trace(origin, mins, maxs, target, passent, entity.clipmask);

  if (result.startsolid || result.allsolid) {
    // Launched inside something, so there is nowhere to move to. "Make sure the tr.entityNum is
    // set to the entity we're stuck in", by asking where it already is.
    result = { ...trace(origin, mins, maxs, origin, passent, entity.clipmask), fraction: 0 };
  } else {
    entity.r.currentOrigin = copy(result.endpos);
  }
  level.linkEntity(entity);

  if (result.fraction < 1) {
    // "Never explode or bounce on sky."
    if (result.surfaceFlags & SURF.NOIMPACT) {
      // "If grapple, reset owner."
      const client = entity.parent?.client;
      if (client?.hook === entity.s.number) client.hook = NO_HOOK;
      level.freeEntity(entity);
      return;
    }
    missileImpact(level, entity, result, trace, rules);
    // Still a missile means it bounced; anything else has gone off and has no think left.
    if (entity.s.eType !== ET.MISSILE) return;
  }

  // "Check think function after bouncing" (`g_missile.c:510`): the fuse is a think, so it is
  // checked after the move rather than before, and a grenade that bounces on the frame its fuse
  // runs out still goes off on that frame.
  level.runThink(entity);
}

/** Where a missile is now, which is what the client draws it at. */
export function missileOrigin(entity: GameEntity, time: number): Vec3 {
  return evaluateTrajectory(entity.s.pos, time);
}

/** How fast a missile is going, for the flight sound's pitch and for the tests. */
export function missileSpeed(entity: GameEntity, time: number): number {
  return length(evaluateTrajectoryDelta(entity.s.pos, time));
}
