import { ENTITYNUM_WORLD, type PlayerState } from '../net/protocol';
import { CA_MAX_DAMAGE } from './clan-arena';
import { ARMOR_PROTECTION, FL, GT, MOD, PERS, PMF_TIME_KNOCKBACK, STAT } from './constants';
import { EV } from './events';
import { ET, MOVER, addEvent, type GameEntity } from './game-entity';
import { PW, tierRule } from './items';
import { onSameTeam, teamCheckHurtCarrier } from './team';
import type { Level } from './level';
import type { Rules } from './rules';
import { add, copy, length, normalize, scale, sub, vec3, type Vec3 } from './vec3';
import {
  KNOCKBACK_DAMAGE_CAP,
  KNOCKBACK_MASS,
  KNOCKBACK_SCALE,
  KNOCKBACK_TIME_MAX,
  KNOCKBACK_TIME_MIN,
  KNOCKBACK_TIME_SCALE
} from './weapons/constants';

/**
 * Damage (`g_combat.c`): `G_Damage` for anything that can be hurt, its flags and limits,
 * `CheckArmor`, and the gibbing every body shares.
 *
 * `G_Damage` is one function for every target, which is the point of it. A rocket, a rail and a
 * fall hurt a player, a corpse or anything else the same way, and what a target does about dying
 * is its own {@link GameEntity.die}: `player_die` for a player, on its `PlayerLife`, and
 * {@link bodyDie} for a corpse.
 *
 * Whose hit it is matters twice. The attacker's handicap scales what they deal to others, and a
 * player hurting themselves takes half, after the full push, "so rocket jumping works".
 */

/**
 * Health at or below which a death gibs the body rather than playing a death animation
 * (`bg_public.h:31`, `player_die`). A corpse that keeps taking damage gibs at the same line
 * (`body_die`).
 */
export const GIB_HEALTH = -40;

/** Health never goes below this, however hard the last hit (`G_Damage`, `g_combat.c:1036`). */
export const MIN_HEALTH = -999;

/** `DAMAGE_RADIUS` (`g_local.h:503`): the hit came from an explosion. */
export const DAMAGE_RADIUS = 0x1;

/** `DAMAGE_NO_ARMOR` (`g_local.h:504`): armor does not soak the hit. */
export const DAMAGE_NO_ARMOR = 0x2;

/** `DAMAGE_NO_KNOCKBACK` (`g_local.h:505`): no push. `G_Damage` sets it on any hit with no direction. */
export const DAMAGE_NO_KNOCKBACK = 0x4;

/**
 * `DAMAGE_NO_PROTECTION` (`g_local.h:506`): god does not help. Its comment in Q3 also names
 * armor, but `CheckArmor` reads only {@link DAMAGE_NO_ARMOR}.
 */
export const DAMAGE_NO_PROTECTION = 0x8;

/** The weapon whose rules scale a `MOD_*`'s push. A blast's is its missile's. */
const KNOCKBACK_WEAPON: Partial<
  Record<number, 'g' | 'mg' | 'sg' | 'gl' | 'rl' | 'lg' | 'rg' | 'pg' | 'bfg'>
> = {
  [MOD.GAUNTLET]: 'g',
  [MOD.MACHINEGUN]: 'mg',
  [MOD.SHOTGUN]: 'sg',
  [MOD.GRENADE]: 'gl',
  [MOD.GRENADE_SPLASH]: 'gl',
  [MOD.ROCKET]: 'rl',
  [MOD.ROCKET_SPLASH]: 'rl',
  [MOD.LIGHTNING]: 'lg',
  [MOD.RAILGUN]: 'rg',
  [MOD.PLASMA]: 'pg',
  [MOD.PLASMA_SPLASH]: 'pg',
  [MOD.BFG]: 'bfg',
  [MOD.BFG_SPLASH]: 'bfg'
};

/**
 * `G_Damage` (`g_combat.c:802–1047`): hurt an entity.
 *
 * The order is the point. The attacker's handicap comes first, unless the hit is their own. The
 * knockback lands next, whatever follows; then god is checked, so a player in god mode is pushed
 * and never hurt; then a player hurting themselves takes half, which comes after the push "so
 * rocket jumping works"; then armor takes its share. Any hit that gets that far costs at least
 * `g_minDamage`, a point at id's, and one that takes the health to nothing calls the target's
 * {@link GameEntity.die}.
 *
 * The level's rules also scale the push, say whether it starts the knockback timer, and set what
 * the battle suit lets through. At their defaults each is id's.
 *
 * A hit with no inflictor or attacker is the world's, whose entity stands in for both: a fall is
 * `G_Damage( ent, NULL, NULL, … )`. A mover has no health: a hit that can hurt one uses it, if it
 * is at rest, and does nothing else. A client's totals are what `P_DamageFeedback` turns into the
 * kick and the blood at the end of the frame.
 *
 * Quake 3's `point` comes last here, and only a hitscan gives one: the push's falloff with distance
 * is all that reads it.
 *
 * @param level - The match: its intermission, and the world's entity.
 * @param targ - What is hurt.
 * @param inflictor - What did it, such as a rocket, or null for the world.
 * @param attacker - Who answers for it, or null for the world.
 * @param dir - Which way the hit pushes, not yet normalized, or null for a hit that pushes nothing.
 * @param points - The hit's damage, before the handicap, the halving and the armor.
 * @param dflags - `DAMAGE_*` flags.
 * @param mod - The `MOD_*` the hit carries, which an obituary names.
 * @param point - Where the hit landed, or null for a hit that gives none.
 */
export function damage(
  level: Level,
  targ: GameEntity,
  inflictor: GameEntity | null,
  attacker: GameEntity | null,
  dir: Vec3 | null,
  points: number,
  dflags: number,
  mod: number,
  point: Vec3 | null = null
): void {
  if (!targ.takedamage) return;

  // "The intermission has already been qualified for, so don't allow any extra scoring."
  if (level.intermissionQueued) return;

  const world = level.gentities[ENTITYNUM_WORLD];
  const by = inflictor ?? world;
  const from = attacker ?? world;

  // "Shootable doors / buttons don't actually have any health": a hit uses one at rest, during a
  // round's countdown too, and nothing else.
  if (targ.s.eType === ET.MOVER) {
    if (targ.use && targ.moverState === MOVER.POS1) targ.use(targ, by, from);
    return;
  }

  // A round's countdown is safe, but for a telefrag; the countdown brings its victim straight back.
  if (level.roundTime > 0 && !(dflags & DAMAGE_NO_PROTECTION)) return;

  const rules = level.rules;
  if (!points && rules.g_minDamage <= 0) return;

  // "Reduce damage by the attacker's handicap value unless they are rocket jumping", in ints.
  const unhandicapped = points;
  if (from.client && from !== targ) {
    points = Math.trunc((points * from.client.ps.stats[STAT.MAX_HEALTH]) / 100);
    if (!rules.g_knockback_handicap) points = Math.max(points, 1);
  }

  const client = targ.client;
  if (client?.noclip) return;

  let direction: Vec3 | null = null;
  if (dir) direction = normalize(dir);
  else dflags |= DAMAGE_NO_KNOCKBACK;

  let knockback = Math.min(
    rules.g_knockback_handicap ? points : unhandicapped,
    KNOCKBACK_DAMAGE_CAP
  );
  if (targ.flags & FL.NO_KNOCKBACK) knockback = 0;
  if (dflags & DAMAGE_NO_KNOCKBACK) knockback = 0;

  // "Figure momentum add, even if the damage won't be taken."
  if (knockback && client && direction) {
    const own = targ === from;
    applyKnockback(
      client.ps,
      direction,
      knockback,
      own ? rules.g_knockback_self : knockbackScale(rules, mod, from, point),
      own || startsKnockbackTimer(rules, mod)
    );
  }

  // "Check for completely getting out of the damage." A hit on a team mate lands only where
  // `g_friendlyFire` says so, and a hit on yourself is never one (`g_combat.c:917–927`); god is
  // checked after it, so the two refusals are one block. Clan Arena's team hits always land, on
  // the armour alone.
  const arena = level.itemMatch.gametype() === GT.CA;
  let armorOnly = false;
  if (!(dflags & DAMAGE_NO_PROTECTION)) {
    const sameTeam = targ !== from && onSameTeam(level.itemMatch.gametype(), targ, from);
    if (sameTeam && !arena && !level.itemMatch.friendlyFire()) return;
    if (targ.flags & FL.GODMODE) return;
    armorOnly = arena && (sameTeam || targ === from);
  }

  // "Battlesuit protects from all radius damage (but takes knockback) and protects 50% against
  // all damage" (`g_combat.c:946–954`). The event comes first and whatever follows, so a blocked
  // blast is still heard and still pulses the suit's icon. Note the guard above does not cover
  // this: the suit stands even where god does not.
  if (client?.ps.powerups[PW.BATTLESUIT]) {
    addEvent(targ, EV.POWERUP_BATTLESUIT, 0, level.time);
    if (dflags & DAMAGE_RADIUS || mod === MOD.FALLING) return;
    points = Math.trunc(points * rules.g_battleSuitFactor);
  }

  // The attacker's hit counter (`g_combat.c:956–967`), which is what the hit beep sounds on and
  // what the damage indicator reads. It counts a hit on anyone but the attacker, living, and made
  // of something other than a general entity — and counts a team mate's *back*, so that hitting
  // your own side under friendly fire is worth nothing rather than worth a beep.
  if (
    from.client &&
    client &&
    targ !== from &&
    targ.health > 0 &&
    targ.s.eType !== ET.MISSILE &&
    targ.s.eType !== ET.GENERAL
  ) {
    const attackerState = from.client.ps;
    if (onSameTeam(level.itemMatch.gametype(), targ, from)) attackerState.persistant[PERS.HITS]--;
    else attackerState.persistant[PERS.HITS]++;
    attackerState.persistant[PERS.ATTACKEE_ARMOR] = (targ.health << 8) | client.ps.stats[STAT.ARMOR];
  }

  // "Always give half damage if hurting self, calculated after knockback, so rocket jumping
  // works." `damage` is an int in the C, so the half is truncated.
  if (targ === from) points = Math.trunc(points * 0.5);
  if (points < rules.g_minDamage) points = rules.g_minDamage;
  if (!points) return;

  let armor: number;
  let take: number;
  if (client && armorOnly) {
    // The whole hit comes off the armour, up to `maxdamage` of it, and none off the health.
    armor = Math.min(points, CA_MAX_DAMAGE, client.ps.stats[STAT.ARMOR]);
    client.ps.stats[STAT.ARMOR] -= armor;
    take = 0;
  } else {
    // The tier's armour protects by its share, and a hit on yourself by the self share where one
    // is set.
    let protection = 0;
    if (client) {
      const self = targ === from ? rules.armor_protection_self : 0;
      protection = self || tierRule(rules, 'protection', client.ps.stats[STAT.ARMOR_TIER]);
    }
    armor = client ? checkArmor(client.ps.stats, points, dflags, protection) : 0;
    take = points - armor;
  }

  // CPMA's damage given: the whole of a hit on another client still alive and not on the
  // attacker's side, a hit of over a thousand counting as a hundred. The warmup counts nothing.
  if (
    from.client &&
    client &&
    targ !== from &&
    targ.health > 0 &&
    mod !== MOD.SUICIDE &&
    !level.warmupTime &&
    !onSameTeam(level.itemMatch.gametype(), targ, from)
  ) {
    const whole = armor + take;
    from.client.damageGiven += whole > 1000 ? 100 : whole;
  }

  if (client) {
    // Totals the end of the frame turns into feedback (`P_DamageFeedback`).
    client.ps.persistant[PERS.ATTACKER] = from.s.number;
    client.damageArmor += armor;
    client.damageBlood += take;
    client.damageKnockback += knockback;
    if (direction) {
      client.damageFrom = direction;
      client.damageFromWorld = false;
    } else {
      client.damageFrom = copy(targ.r.currentOrigin);
      client.damageFromWorld = true;
    }
    // "See if it's the player hurting the enemy flag carrier" (`g_combat.c:1010–1017`), which is
    // what pays whoever kills them a moment later. Quake 3 has two `if ( targ->client )` blocks
    // with this between them; the port has one, and this stands where the C's call does.
    if (level.itemMatch.gametype() === GT.CTF) teamCheckHurtCarrier(level, targ, from);

    // "Set the last client who damaged the target."
    client.lasthurtClient = from.s.number;
    client.lasthurtMod = mod;
  }

  if (!take) return;

  // A client's health is its player state's, which the port keeps as the authority; the entity's
  // copy follows it here, as `player_die` and `body_die` read that one.
  let health = (client ? client.ps.stats[STAT.HEALTH] : targ.health) - take;
  if (health <= 0) {
    if (client) targ.flags |= FL.NO_KNOCKBACK;
    if (health < MIN_HEALTH) health = MIN_HEALTH;
  }
  targ.health = health;
  if (client) client.ps.stats[STAT.HEALTH] = health;

  if (health <= 0) {
    targ.enemy = from;
    targ.die?.(targ, by, from, take, mod);
  }
}

/**
 * `LogAccuracyHit` (`g_weapon.c:736–762`): whether a hit counts towards the accuracy the board
 * shows — a hit on a living client, by a client, and not on the shooter themselves.
 *
 * A hit on a team mate is not one either, so a shot into your own side costs the accuracy a shot
 * and gains it nothing.
 *
 * @param level - The match, read for `g_gametype`.
 * @param target - What was hit.
 * @param attacker - Who is credited, or null for the world.
 */
export function logAccuracyHit(
  level: Level,
  target: GameEntity,
  attacker: GameEntity | null
): boolean {
  if (!target.takedamage) return false;
  if (target === attacker) return false;
  if (!target.client) return false;
  if (!attacker?.client) return false;
  if (target.client.ps.stats[STAT.HEALTH] <= 0) return false;
  if (onSameTeam(level.itemMatch.gametype(), target, attacker)) return false;
  return true;
}

/**
 * The momentum half of `G_Damage` (`g_combat.c:877–913`): push a player along a hit.
 *
 * `kvel = normalize(dir) * g_knockback * min(damage, 200) / 200`, which is 5 units of speed per
 * damage point at stock settings and caps at 1000, before the push's scale. The `pm_time` window is
 * only started when one is not already running, so a second explosion cannot extend the first's
 * friction-free period. Its length is the hit's, whatever the scale.
 *
 * @param state - Player state; velocity and flags are mutated.
 * @param direction - Push direction; normalized here as the original does.
 * @param points - The hit's damage, which is what the push is worth.
 * @param push - What the push is multiplied by.
 * @param timed - Whether the hit may start the window at all.
 * @returns The velocity it added.
 */
export function applyKnockback(
  state: PlayerState,
  direction: Vec3,
  points: number,
  push = 1,
  timed = true
): Vec3 {
  const knockback = Math.min(points, KNOCKBACK_DAMAGE_CAP);
  if (knockback <= 0) return vec3();

  const kvel = scale(normalize(direction), ((KNOCKBACK_SCALE * knockback) / KNOCKBACK_MASS) * push);
  state.velocity = add(state.velocity, kvel);

  if (timed && !state.pmTime) {
    state.pmTime = Math.min(
      Math.max(knockback * KNOCKBACK_TIME_SCALE, KNOCKBACK_TIME_MIN),
      KNOCKBACK_TIME_MAX
    );
    state.pmFlags |= PMF_TIME_KNOCKBACK;
  }

  return kvel;
}

/**
 * What another's hit pushes by: its weapon's scale, or 1 for a hit by none. The lightning's and the
 * rail's lose their falloff in proportion to the distance from the attacker to where the hit
 * landed, all of it at the range and beyond.
 *
 * @param rules - The rules of play.
 * @param mod - The hit's `MOD_*`.
 * @param attacker - Whose hit it is, measured from their entity's base.
 * @param point - Where it landed, or null for a hit with no falloff.
 */
function knockbackScale(
  rules: Readonly<Rules>,
  mod: number,
  attacker: GameEntity,
  point: Vec3 | null
): number {
  const weapon = KNOCKBACK_WEAPON[mod];
  if (!weapon) return 1;
  const push = rules[`g_knockback_${weapon}`];
  if ((weapon !== 'lg' && weapon !== 'rg') || !point) return push;

  const range = rules.g_knockback_falloffRange;
  const distance = length(sub(point, attacker.s.pos.trBase));
  const share = range > 0 ? Math.min(distance, range) / range : 1;
  return push - rules[`g_knockback_${weapon}_falloff`] * share;
}

/**
 * Whether another's hit may start the knockback timer: every hit may, but a machinegun's, a
 * lightning's or a plasma's with its weapon's switch off.
 */
function startsKnockbackTimer(rules: Readonly<Rules>, mod: number): boolean {
  const weapon = KNOCKBACK_WEAPON[mod];
  if (weapon !== 'mg' && weapon !== 'lg' && weapon !== 'pg') return true;
  return rules[`g_knockbackTimer_${weapon}`] !== 0;
}

/**
 * `CheckArmor` (`g_combat.c:672–701`): take the armor's share of a hit off the armor.
 *
 * Armor soaks its share of each hit, rounded up, until it runs out. Retail Q3 makes the product in
 * the game VM's single-precision floats, which put some hits a point higher than a double would:
 * at 0.66, a quad gauntlet's 150 saves 100.
 *
 * @param stats - The player's `ps.stats[]`; `STAT_ARMOR` is reduced.
 * @param points - The hit's damage, after the halving.
 * @param dflags - `DAMAGE_*` flags.
 * @param protection - The share the armor takes.
 * @returns The points the armor took, to come off the hit.
 */
export function checkArmor(
  stats: number[],
  points: number,
  dflags: number,
  protection = ARMOR_PROTECTION
): number {
  if (!points) return 0;
  if (dflags & DAMAGE_NO_ARMOR) return 0;

  let save = Math.ceil(Math.fround(points * Math.fround(protection)));
  if (save >= stats[STAT.ARMOR]) save = stats[STAT.ARMOR];
  if (!save) return 0;

  stats[STAT.ARMOR] -= save;
  return save;
}

/**
 * `GibEntity` (`g_combat.c:237–260`): the body goes to pieces, and leaves nothing to hurt, to hit
 * or to draw.
 *
 * @param level - The level, whose clock the event is raised at.
 * @param self - The player or the corpse.
 * @param killer - Whose kill it was, which the event carries.
 */
export function gibEntity(level: Level, self: GameEntity, killer: number): void {
  addEvent(self, EV.GIB_PLAYER, killer, level.time);
  self.takedamage = false;
  self.s.eType = ET.INVISIBLE;
  self.r.contents = 0;
}

/**
 * `body_die` (`g_combat.c:267–277`): a corpse hurt again goes to pieces once it is at −40 or
 * below. Quake 3 gives this gib no killer, whoever it was that blew the corpse apart.
 *
 * @param level - The level the corpse is in.
 * @param self - The corpse: a dead player, or a body in the queue.
 */
export function bodyDie(level: Level, self: GameEntity): void {
  if (self.health > GIB_HEALTH) return;
  gibEntity(level, self, 0);
}
