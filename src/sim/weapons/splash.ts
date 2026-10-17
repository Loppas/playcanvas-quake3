import { ENTITYNUM_NONE } from '../../net/protocol';
import { DAMAGE_RADIUS, damage, logAccuracyHit } from '../combat';
import { MASK } from '../constants';
import type { GameEntity } from '../game-entity';
import type { Level } from '../level';
import type { TraceFn } from '../types';
import { add, length, scale, sub, vec3, type Vec3 } from '../vec3';

/**
 * Splash: `G_RadiusDamage` and `CanDamage` (`g_combat.c:1058–1221`).
 *
 * **This module is rocket jumping.** The damage *number* is what sets the knockback's
 * magnitude, and the order the original computes things in is what makes the jump work:
 *
 * 1. Distance is measured to the **surface of the box the world links**, not to the origin, so
 *    standing on top of an explosion counts as distance zero and takes full force. A player's box
 *    is linked round their origin snapped to whole units, and a unit bigger each way than their
 *    bounds.
 * 2. The direction gets `+24` on Z **before** it is normalized, which tilts a shot at your
 *    feet into a mostly-vertical launch.
 * 3. `G_Damage` pushes **before** any damage handling — god, and the halving Q3 does for
 *    self-damage — so a rocket jump is at full strength even though the damage is not.
 * 4. `PMF_TIME_KNOCKBACK` suppresses ground friction for up to 200 ms, so the speed
 *    survives contact with the floor instead of being scrubbed off immediately.
 *
 * A blast reaches everything that can be hurt the same way — the player who fired it, anyone
 * else, and the corpses — which is how one rocket both launches its shooter and kills the player
 * beside them.
 *
 * Knockback lands on `ps.velocity` **between** ticks, which is exactly where the original applies
 * it — after one `Pmove`, before the next.
 */

/**
 * Distance from a point to the surface of an axis-aligned box; zero when inside.
 *
 * `G_RadiusDamage` measures this way rather than centre-to-centre, which is why a rocket at
 * your feet does full damage even though your origin is 24 units up.
 */
export function distanceToBox(point: Vec3, mins: Vec3, maxs: Vec3): number {
  const axis = (p: number, min: number, max: number) => (p < min ? min - p : p > max ? p - max : 0);
  return length(
    vec3(
      axis(point.x, mins.x, maxs.x),
      axis(point.y, mins.y, maxs.y),
      axis(point.z, mins.z, maxs.z)
    )
  );
}

/**
 * `CanDamage` (`g_combat.c:1059–1150`) — is there line of sight from the blast to a box?
 *
 * Five point traces: the box midpoint, then four probes offset 15 units in X and Y. Only X
 * and Y are offset, with a comment in the original conceding it should probably include Z —
 * kept as-is, because those five rays are what decides whether a rocket around a corner
 * still launches you. They are `MASK_SOLID` traces that pass nobody, so the world blocks a blast
 * and a player standing in the way does not. The first also passes if what it hits is the
 * target, which is how a blast reaches a door: a solid mover stops it.
 *
 * @param absmin - The box's lower corner, in the world.
 * @param absmax - Its upper corner.
 * @param target - The entity the box is, by number.
 */
export function canDamage(
  trace: TraceFn,
  explosionOrigin: Vec3,
  absmin: Vec3,
  absmax: Vec3,
  target: number
): boolean {
  const midpoint = scale(add(absmin, absmax), 0.5);

  const probes: Vec3[] = [
    midpoint,
    vec3(midpoint.x + 15, midpoint.y + 15, midpoint.z),
    vec3(midpoint.x + 15, midpoint.y - 15, midpoint.z),
    vec3(midpoint.x - 15, midpoint.y + 15, midpoint.z),
    vec3(midpoint.x - 15, midpoint.y - 15, midpoint.z)
  ];

  for (const [i, probe] of probes.entries()) {
    const tr = trace(explosionOrigin, vec3(), vec3(), probe, ENTITYNUM_NONE, MASK.SOLID);
    if (tr.fraction === 1 || (i === 0 && tr.entityNum === target)) return true;
  }
  return false;
}

/**
 * `G_RadiusDamage` (`g_combat.c:1159–1221`): hurt everything a blast reaches.
 *
 * What it reaches is anything that can be hurt whose linked box is within the radius and in sight
 * of the blast ({@link canDamage}). Each takes the damage less a straight falloff to nothing at
 * the edge, measured to its box, truncated to a whole point; and is pushed from the blast towards
 * a point above its origin, by the rules' lift: 24 at id's, and one each for the blast's owner and
 * everyone else. What it ignores is what the blast came from: the missile itself, or whoever the
 * missile hit, who has already taken its direct damage.
 *
 * It returns whether it reached a client, which is what the accuracy the board shows counts
 * (`g_combat.c:1208–1211`).
 *
 * @param level - Where the blast went off, and so what is there to reach.
 * @param trace - Swept-AABB trace, for the line of sight.
 * @param origin - Where it went off.
 * @param attacker - Whose blast it is: the missile's owner.
 * @param points - Its damage at the centre.
 * @param radius - How far it reaches; the falloff is linear to zero at the edge.
 * @param ignore - What it passes over, or null.
 * @param mod - The `MOD_*` it carries.
 * @returns Whether it reached a client: the accuracy a missile counts.
 */
export function radiusDamage(
  level: Level,
  trace: TraceFn,
  origin: Vec3,
  attacker: GameEntity | null,
  points: number,
  radius: number,
  ignore: GameEntity | null,
  mod: number
): boolean {
  if (radius < 1) radius = 1;

  let hitClient = false;
  const reach = vec3(radius, radius, radius);
  for (const number of level.entitiesInBox(sub(origin, reach), add(origin, reach))) {
    const entity = level.gentities[number];
    if (entity === ignore) continue;
    if (!entity.takedamage) continue;

    // "Find the distance from the edge of the bounding box."
    const dist = distanceToBox(origin, entity.r.absmin, entity.r.absmax);
    if (dist >= radius) continue;
    const share = points * (1 - dist / radius);

    if (!canDamage(trace, origin, entity.r.absmin, entity.r.absmax, number)) continue;

    if (logAccuracyHit(level, entity, attacker)) hitClient = true;

    // "Push the center of mass higher than the origin so players get knocked into the air more."
    // The lift goes on before `G_Damage` normalizes: this is the whole trick behind rocket jumping.
    const dir = sub(entity.r.currentOrigin, origin);
    dir.z += entity === attacker ? level.rules.g_knockback_z_self : level.rules.g_knockback_z;
    damage(level, entity, null, attacker, dir, Math.trunc(share), DAMAGE_RADIUS, mod);
  }

  return hitClient;
}
