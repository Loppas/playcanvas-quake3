import { ENTITYNUM_MAX_NORMAL, type PlayerState } from '../../net/protocol';
import { awardSprite } from '../client';
import { damage, logAccuracyHit } from '../combat';
import { CONTENTS, EF_AWARD_IMPRESSIVE, GT, MOD, PERS, SURF } from '../constants';
import { NO_IMPACT_DIR, dirToByte } from '../dir-byte';
import { EV } from '../events';
import { ET, addEvent, type GameEntity } from '../game-entity';
import { PW } from '../items';
import type { Level } from '../level';
import { ID_RULES, type Rules } from '../rules';
import { tempEntity } from '../temp-entity';
import type { TraceFn } from '../types';
import { shotSeed, timeShiftFor, undoTimeShiftFor } from '../unlagged';
import { madd, normalize, sub, vec3, type Vec3 } from '../vec3';
import { MAX_RAIL_HITS, MISSILES, WP, type WeaponId } from './constants';
import {
  beamEndpoint,
  bulletEndpoint,
  firingSolution,
  isFixedPattern,
  Q3Random,
  shotgunPattern,
  shotgunPatternOnView,
  shotgunWire,
  snapVectorTowards,
  traceShot,
  truncVector,
  type FiringSolution,
  type HitscanResult,
  type RandomFn
} from './hitscan';
import { explodeMissile, fireMissile } from './missile';

/**
 * The server side of firing: what happens when `PM_Weapon` says a shot went off.
 *
 * This is Q3's `ClientEvents` → `FireWeapon` path (`g_active.c:970`, `g_weapon.c:802`),
 * which runs **after** `Pmove` and before the next one — the reason knockback can be added
 * straight onto `ps.velocity` without disturbing the move that just completed.
 *
 * A shot hurts whatever it reaches that can be hurt, through `G_Damage`, with the shooter as both
 * inflictor and attacker; a missile hurts on its owner's account when it lands. id's gauntlet is
 * the exception in time: it hits before the move, in {@link WeaponSystem.checkGauntletAttack}, and
 * the move fires it only if it did.
 *
 * Headless and engine-free, like the rest of `sim/`. Nothing is returned to a presentation layer:
 * what a shot leaves behind is an entity in the world, either a missile that flies or a temp
 * entity that is nothing but the event saying where the shot landed. A client learns what
 * happened by reading the entities it is sent, which is the only channel there is.
 */

/** Injectable randomness, so tests can pin every pattern. */
export interface WeaponRandomness {
  /**
   * Uniform [0, 1) for the machinegun's cone. Without it, each round draws from `Q_rand` started
   * at the shot's seed.
   */
  random?: RandomFn;
  /** The seed a machinegun round and a shotgun blast are drawn from, 0–255. */
  seed: () => number;
}

/** What a weapon system fires into, and on whose behalf. */
export interface WeaponSystemOptions {
  /** The world the missiles and the impacts are entities in, and what they hurt. */
  level: Level;
  /** The client firing them: a shot's attacker, and a missile's owner. */
  owner: GameEntity;
  /** `trap_Trace`, which every shot and every missile runs through. */
  trace: TraceFn;
  /** Injected RNG; defaults to the real one. */
  randomness?: Partial<WeaponRandomness>;
  /** The rules of play, read as each shot goes off. id's defaults without them. */
  rules?: Readonly<Rules>;
  /** `xp_unlagged`, read at each shot: which weapons rewind the others. None without it. */
  unlagged?: () => number;
}

/**
 * Turns `PM_Weapon`'s events into shots, and the gauntlet's reach into a punch.
 *
 * One instance per player. Deterministic given the same randomness source, which is what
 * makes the shotgun pattern and rocket-jump goldens testable.
 *
 * It owns nothing it fires. A missile is an entity in the level's pool like anything else, and
 * the level's frame runs it through `G_RunMissile` whoever fired it; an impact is an entity too,
 * alive for as long as it takes every client to see it.
 */
export class WeaponSystem {
  private readonly level: Level;
  private readonly owner: GameEntity;
  private readonly trace: TraceFn;
  private readonly randomness: WeaponRandomness;
  private readonly rules: Readonly<Rules>;
  private readonly unlagged: () => number;
  /**
   * `s_quadFactor` (`g_weapon.c:96`): what this shot's damage is multiplied by, latched as the
   * shot goes off and 1 without the quad. A missile carries its own share multiplied in, which is
   * why a rocket fired under quad keeps its triple after the powerup runs out.
   */
  private quad = 1;
  /**
   * What the reach check found under `g_gauntletOnFire`, for the fire event after the move to
   * hurt.
   */
  private gauntletTarget: GameEntity | null = null;

  /** @param options - The world to fire into, and on whose behalf. */
  constructor(options: WeaponSystemOptions) {
    this.level = options.level;
    this.owner = options.owner;
    this.trace = options.trace;
    this.randomness = {
      // "int seed = ent->client->attackTime % 256" (unlagged's): a shot is drawn from the time the
      // shooter's frame was drawn at, so the shooter's own client can draw the same one.
      seed: () => (this.owner.client ? shotSeed(this.owner.client.pers.cmd) : 0),
      ...options.randomness
    };
    this.rules = options.rules ?? ID_RULES;
    this.unlagged = options.unlagged ?? (() => 0);
  }

  /**
   * The missiles in flight, for the client to draw.
   *
   * Read off the level rather than kept, because the level is where they are. This is what
   * `CG_AddPacketEntities` does with the entities in a snapshot, and once a snapshot is what the
   * app reads it is the same walk over the same states.
   */
  get missiles(): GameEntity[] {
    const missiles: GameEntity[] = [];
    for (let i = 0; i < this.level.numEntities; i++) {
      const entity = this.level.gentities[i];
      if (entity.inuse && entity.s.eType === ET.MISSILE) missiles.push(entity);
    }
    return missiles;
  }

  /** Take every projectile out of the world, as a restart does (`map_restart`). */
  clear(): void {
    for (const missile of this.missiles) this.level.freeEntity(missile);
  }

  /**
   * `CheckGauntletAttack` (`g_weapon.c:69–123`): punch whatever is within 32 units, before the
   * move.
   *
   * `ClientThink_real` asks this ahead of `Pmove` whenever the gauntlet is held, attack is down
   * and the weapon is ready, and the move fires the gauntlet only if it says yes — "don't let the
   * action go through as an attack unless it actually hits something" (`g_active.c:866–871`). So
   * the hurt lands before the move that raises the fire event, and a gauntlet swung at the air
   * does nothing at all.
   *
   * A player it reaches bleeds, by an `EV_MISSILE_HIT` naming them, whether or not the hit lands.
   *
   * Under `g_gauntletOnFire` it only finds the target, as CPMA's does, and the fire event after
   * the move bleeds and hurts it. A move that does not fire, such as one that begins a change,
   * hurts nothing.
   *
   * @param state - The puncher's state, as it stands before the move.
   * @returns Whether it hit something that can be hurt.
   */
  checkGauntletAttack(state: PlayerState): boolean {
    const { muzzle, forward } = this.firingSolution(state);
    const end = madd(muzzle, this.rules.g_range_g, forward);
    const shot = traceShot(this.trace, muzzle, end, this.owner.s.number);
    this.gauntletTarget = null;
    if (shot.surfaceFlags & SURF.NOIMPACT) return false;
    if (this.owner.client?.noclip) return false;

    const other = this.level.gentities[shot.entityNum];
    if (this.rules.g_gauntletOnFire) {
      if (!other.takedamage) return false;
      this.gauntletTarget = other;
      return true;
    }

    // "Send blood impact."
    if (other.takedamage && other.client) {
      const impact = tempEntity(this.level, shot.endpos, EV.MISSILE_HIT);
      impact.s.otherEntityNum = other.s.number;
      impact.s.eventParm = dirToByte(shot.normal);
      impact.s.weapon = state.weapon;
    }
    if (!other.takedamage) return false;

    // "Only a gauntlet punch that lands raises `EV_POWERUP_QUAD`" (`g_weapon.c:106–107`): it is
    // the one shot the server itself says the quad was behind, and the client pulses the icon and
    // plays the sound from it.
    if (this.owner.client?.ps.powerups[PW.QUAD]) {
      addEvent(this.owner, EV.POWERUP_QUAD, 0, this.level.time);
    }
    this.latchQuadFactor();

    this.hurt(other, forward, this.rules.g_damage_g, MOD.GAUNTLET);
    return true;
  }

  /**
   * `FireWeapon` (`g_weapon.c:802`) — one shot from the weapon in hand.
   *
   * Called from `ClientEvents` for every `EV_FIRE_WEAPON` the move raised, which is what puts it
   * after `Pmove` and before the next one: shots are fired from the **post-move** origin and
   * angles, and an explosion's knockback lands on `ps.velocity` between ticks.
   *
   * The machinegun, the shotgun, the lightning gun and the railgun trace, and hurt, with everyone
   * else moved back to where this player drew them, and put back before the shot is done
   * (Excessive Plus's brackets). The gauntlet never moves anyone.
   *
   * @param state - The firing player's state; velocity and flags are mutated by knockback.
   */
  fire(state: PlayerState): void {
    // The event says a shot went off and nothing more. Which weapon fired it is the one in hand,
    // which is where `FireWeapon` reads it from (`ent->s.weapon`).
    const weapon = state.weapon as WeaponId;
    // `FireWeapon` reads the quad before it picks the weapon (`g_weapon.c:802–807`), so every
    // case below is worth whatever this says.
    this.latchQuadFactor();
    // "track shots taken for accuracy tracking. Grapple is not a weapon and gauntlet is just not
    // tracked" (`g_weapon.c:814–815`).
    if (weapon !== WP.GAUNTLET && weapon !== WP.GRAPPLING_HOOK) {
      const client = this.owner.client;
      if (client) client.accuracyShots++;
    }
    const solution = this.firingSolution(state);
    const { muzzle, forward } = solution;
    const rules = this.rules;

    switch (weapon) {
      case WP.MACHINEGUN: {
        // "Wimpier MG in teamplay" (`g_weapon.c:159–162`), and the only per-mode weapon number in
        // the game: id's is team deathmatch's alone, not CTF's. `g_damage_mg_teamAll` makes it
        // every team mode's.
        const gametype = this.level.itemMatch.gametype();
        const team = rules.g_damage_mg_teamAll ? gametype >= GT.TEAM : gametype === GT.TEAM;
        timeShiftFor(this.level, this.owner, weapon, this.unlagged());
        this.bulletFire(
          solution,
          team ? rules.g_damage_mg_team : rules.g_damage_mg,
          MOD.MACHINEGUN
        );
        undoTimeShiftFor(this.level, this.owner);
        break;
      }

      case WP.SHOTGUN: {
        // One event for all eleven pellets: the seed and the aim, from which the client works out
        // the same pattern the server traces. Sending eleven rays would cost forty times as much
        // and tell the client nothing it cannot derive.
        const blast = tempEntity(this.level, muzzle, EV.SHOTGUN);
        blast.s.origin2 = shotgunWire(forward);
        blast.s.eventParm = this.randomness.seed();
        blast.s.otherEntityNum = this.owner.s.number;
        const shotgun = {
          pattern: rules.g_pattern_sg,
          pellets: rules.g_pellets_sg,
          spread: rules.g_spread_sg
        };
        // `ShotgunPattern`: id's is traced from what the event carries, so that it is the pattern
        // every client draws. CPMA's fixed ones are traced from the muzzle on the view's axes.
        const onView = isFixedPattern(shotgun.pattern);
        const start = onView ? muzzle : blast.s.pos.trBase;
        const ends = onView
          ? shotgunPatternOnView(solution, shotgun)
          : shotgunPattern(start, blast.s.origin2, blast.s.eventParm, shotgun);
        let hitClient = false;
        timeShiftFor(this.level, this.owner, weapon, this.unlagged());
        for (const end of ends) {
          if (this.shotgunPellet(start, end, forward) && !hitClient) {
            hitClient = true;
            this.accuracyHit();
          }
        }
        undoTimeShiftFor(this.level, this.owner);
        break;
      }

      case WP.RAILGUN:
        timeShiftFor(this.level, this.owner, weapon, this.unlagged());
        this.railgunFire(solution);
        undoTimeShiftFor(this.level, this.owner);
        break;

      case WP.LIGHTNING:
        timeShiftFor(this.level, this.owner, weapon, this.unlagged());
        this.lightningFire(solution, weapon);
        undoTimeShiftFor(this.level, this.owner);
        break;

      case WP.GAUNTLET:
        // id's `Weapon_Gauntlet` is empty: the punch landed before the move, in
        // `checkGauntletAttack`, and this is only the move saying that it did. Under
        // `g_gauntletOnFire` it lands now, on what the check found.
        if (this.gauntletTarget) {
          this.gauntletPunch(this.gauntletTarget, forward, weapon);
          this.gauntletTarget = null;
        }
        break;

      default: {
        if (!MISSILES[weapon]) break;
        // `weapon_grenadelauncher_fire` lifts the aim, so a grenade lobs a little above the
        // crosshair (`g_weapon.c:371–375`).
        const aim =
          weapon === WP.GRENADE_LAUNCHER
            ? normalize(vec3(forward.x, forward.y, forward.z + 0.2))
            : forward;
        // In whole units, as CPMA's missiles start; id's muzzle already is.
        const start = truncVector(muzzle);
        const missile = fireMissile(
          this.level,
          this.owner,
          weapon,
          start,
          aim,
          (self) => explodeMissile(this.level, self, this.trace),
          rules
        );
        // `m->damage *= s_quadFactor` and the same for the splash (`g_weapon.c:397–398`): the
        // missile carries the factor with it, which is what makes a quad rocket so dangerous to
        // the player who fired it.
        missile.damage = Math.trunc(missile.damage * this.quad);
        missile.splashDamage = Math.trunc(missile.splashDamage * this.quad);
        break;
      }
    }
  }

  /**
   * `Bullet_Fire` (`g_weapon.c:164–236`): one round, and the impact it leaves.
   *
   * A round that strikes a player leaves `EV_BULLET_HIT_FLESH`, naming them, where the client
   * bleeds them; the sky leaves nothing, and anything else `EV_BULLET_HIT_WALL`, with the surface
   * to mark. Either way the impact is the client's whole account of the shot. What it struck is
   * then hurt, if it can be.
   *
   * @param solution - The firing basis.
   * @param points - What a round costs.
   * @param mod - The `MOD_*` it carries.
   */
  private bulletFire(solution: FiringSolution, points: number, mod: number): void {
    const { muzzle, forward } = solution;
    const { g_spread_mg: spread, g_range_mg: range } = this.rules;
    const seeded = new Q3Random(this.randomness.seed());
    const random = this.randomness.random ?? (() => seeded.random());
    const end = bulletEndpoint(solution, random, spread, range);
    const shot = traceShot(this.trace, muzzle, end, this.owner.s.number);
    // The sky leaves no mark.
    if (shot.surfaceFlags & SURF.NOIMPACT) return;
    // Nor does the end of the round's range. Quake 3 cannot get there inside a sealed map; a splat
    // map has open sky.
    if (!shot.hit) return;

    const other = this.level.gentities[shot.entityNum];
    // Without `g_bulletImpactSnap` the impact is where the round stopped, and the temp entity's
    // own truncation may leave it a fraction inside the surface.
    const at = this.rules.g_bulletImpactSnap ? snapVectorTowards(shot.endpos, muzzle) : shot.endpos;
    let impact: GameEntity;
    if (other.takedamage && other.client) {
      impact = tempEntity(this.level, at, EV.BULLET_HIT_FLESH);
      impact.s.eventParm = other.s.number;
    } else {
      impact = tempEntity(this.level, at, EV.BULLET_HIT_WALL);
      impact.s.eventParm = dirToByte(shot.normal);
    }
    impact.s.otherEntityNum = this.owner.s.number;
    // Whose round it was, as unlagged marks it, so a client that drew its own round already can
    // leave this one out.
    impact.s.clientNum = this.owner.s.number;

    if (other.takedamage) {
      if (logAccuracyHit(this.level, other, this.owner)) this.accuracyHit();
      this.hurt(other, forward, points, mod);
    }
  }

  /**
   * `ShotgunPellet` (`g_weapon.c:270–318`): one of the eleven, which hurts what it reaches. The
   * push is along the shooter's aim rather than the pellet's own line.
   *
   * @param start - Where the blast event says the pellets leave from.
   * @param end - Where this one would end with nothing in the way.
   * @param forward - The shooter's aim.
   * @returns Whether it reached a client, which the blast counts once.
   */
  private shotgunPellet(start: Vec3, end: Vec3, forward: Vec3): boolean {
    const pellet = traceShot(this.trace, start, end, this.owner.s.number);
    if (pellet.surfaceFlags & SURF.NOIMPACT || !pellet.hit) return false;
    const other = this.level.gentities[pellet.entityNum];
    if (!other.takedamage) return false;

    const hitClient = logAccuracyHit(this.level, other, this.owner);
    this.hurt(other, forward, this.rules.g_damage_sg, MOD.SHOTGUN);
    return hitClient;
  }

  /**
   * `weapon_railgun_fire` (`g_weapon.c:437–557`): a beam "only against the solids, so the railgun
   * will go through people".
   *
   * Each entity the beam reaches is hurt, and taken out of the world so that the next trace goes
   * past it, up to {@link MAX_RAIL_HITS} of them; they are all put back once the beam has found
   * where it ends. The world, or anything else solid, ends it, and the trail is drawn to there.
   * Two hits in a row are the impressive award (`g_weapon.c:539–555`).
   *
   * @param solution - The firing basis.
   */
  private railgunFire(solution: FiringSolution): void {
    const { muzzle, forward, right, up } = solution;
    const end = beamEndpoint(solution, this.rules.g_range_rg);

    const unlinked: GameEntity[] = [];
    let hits = 0;
    let shot: HitscanResult;
    do {
      shot = traceShot(this.trace, muzzle, end, this.owner.s.number);
      if (shot.entityNum >= ENTITYNUM_MAX_NORMAL) break;
      const other = this.level.gentities[shot.entityNum];
      if (other.takedamage) {
        if (logAccuracyHit(this.level, other, this.owner)) hits++;
        this.hurt(other, forward, this.rules.g_damage_rg, MOD.RAILGUN, shot.endpos);
      }
      // "We hit something solid enough to stop the beam."
      if (shot.contents & CONTENTS.SOLID) break;
      this.level.unlinkEntity(other);
      unlinked.push(other);
    } while (unlinked.length < MAX_RAIL_HITS);

    for (const passed of unlinked) this.level.linkEntity(passed);

    // "give the shooter a reward sound if they have made two railgun hits in a row"
    // (`g_weapon.c:539`).
    const client = this.owner.client;
    if (client) {
      if (hits === 0) {
        client.accurateCount = 0;
      } else {
        client.accurateCount += hits;
        if (client.accurateCount >= 2) {
          client.accurateCount -= 2;
          client.ps.persistant[PERS.IMPRESSIVE_COUNT]++;
          awardSprite(client, EF_AWARD_IMPRESSIVE, this.level.time);
        }
        client.accuracyHits++;
      }
    }

    const at = snapVectorTowards(shot.endpos, muzzle);
    const beam = tempEntity(this.level, at, EV.RAILTRAIL);
    // Whose beam it is, so a client can colour it as that player's.
    beam.s.clientNum = this.owner.s.number;
    // The start, nudged right and down to sit under the drawn gun rather than on the view
    // axis — a beam through the eye is edge-on to it and invisible to the one who fired it.
    // Without `g_railTrailOffset` it is the muzzle, snapped toward the end.
    beam.s.origin2 = this.rules.g_railTrailOffset
      ? madd(madd(muzzle, 4, right), -1, up)
      : snapVectorTowards(muzzle, at);
    // "No explosion at end if SURF_NOIMPACT, but still make the trail", nor where it met nothing.
    const impact = shot.hit && !(shot.surfaceFlags & SURF.NOIMPACT);
    beam.s.eventParm = impact ? dirToByte(shot.normal) : NO_IMPACT_DIR;
  }

  /**
   * `Weapon_LightningFire` (`g_weapon.c:608–679`): the bolt itself is drawn client-side every
   * frame from `EF_FIRING`, so all the server sends is where it ends.
   *
   * What the bolt reaches is hurt first. It then leaves `EV_MISSILE_HIT` on a player it can still
   * hurt, naming them, and `EV_MISSILE_MISS` on anything else but the sky — a player the bolt just
   * gibbed among them.
   *
   * @param solution - The firing basis.
   * @param weapon - The weapon in hand, which a hit on a player carries.
   */
  private lightningFire(solution: FiringSolution, weapon: WeaponId): void {
    const { muzzle, forward } = solution;
    const shot = traceShot(
      this.trace,
      muzzle,
      beamEndpoint(solution, this.rules.g_range_lg),
      this.owner.s.number
    );
    // "tr.entityNum == ENTITYNUM_NONE": nothing within reach.
    if (!shot.hit) return;

    const other = this.level.gentities[shot.entityNum];
    if (other.takedamage) {
      if (logAccuracyHit(this.level, other, this.owner)) this.accuracyHit();
      // CPMA's bolt lands at its end snapped toward the muzzle; only the push's falloff reads it.
      const at = snapVectorTowards(shot.endpos, muzzle);
      this.hurt(other, forward, this.rules.g_damage_lg, MOD.LIGHTNING, at);
    }

    if (other.takedamage && other.client) {
      const impact = tempEntity(this.level, shot.endpos, EV.MISSILE_HIT);
      impact.s.otherEntityNum = other.s.number;
      impact.s.eventParm = dirToByte(shot.normal);
      impact.s.weapon = weapon;
    } else if (!(shot.surfaceFlags & SURF.NOIMPACT)) {
      const impact = tempEntity(this.level, shot.endpos, EV.MISSILE_MISS);
      impact.s.eventParm = dirToByte(shot.normal);
    }
  }

  /**
   * CPMA's gauntlet case in `FireWeapon`: what the reach check found bleeds where it stands, turned
   * toward the puncher, and is hurt along the aim the move ended on.
   *
   * @param target - What the check found.
   * @param forward - The puncher's aim.
   * @param weapon - The weapon in hand, which the blood carries.
   */
  private gauntletPunch(target: GameEntity, forward: Vec3, weapon: WeaponId): void {
    if (target.takedamage && target.client) {
      const impact = tempEntity(this.level, target.s.pos.trBase, EV.MISSILE_HIT);
      impact.s.otherEntityNum = target.s.number;
      impact.s.eventParm = dirToByte(sub(this.owner.s.pos.trBase, target.s.pos.trBase));
      impact.s.weapon = weapon;
    }
    this.hurt(target, forward, this.rules.g_damage_g, MOD.GAUNTLET);
  }

  /** Where this player's shot leaves from, and along which axes, by the rules' muzzle. */
  private firingSolution(state: PlayerState): FiringSolution {
    const { g_muzzleForward: distance, g_muzzleSnap: snap } = this.rules;
    return firingSolution(state.origin, state.viewangles, state.viewheight, distance, snap !== 0);
  }

  /**
   * `s_quadFactor` at the shot: `g_quadfactor` while the quad is held, and 1 without it.
   * `FireWeapon` and a landing gauntlet punch are the two places Q3 sets it
   * (`g_weapon.c:106, 802`).
   */
  private latchQuadFactor(): void {
    this.quad = this.owner.client?.ps.powerups[PW.QUAD] ? this.rules.g_quadfactor : 1;
  }

  /**
   * `G_Damage` for one of this player's own hits: they are both inflictor and attacker, the push
   * is along their aim, and what the hit costs is what the shot was worth. Q3 multiplies the quad
   * factor in at every weapon's `G_Damage` call (`g_weapon.c:118, 176, 289, 452, 620`), which is
   * the same number this holds.
   *
   * @param point - Where the hit landed, for a shot whose push falls off with distance.
   */
  private hurt(
    other: GameEntity,
    forward: Vec3,
    points: number,
    mod: number,
    point: Vec3 | null = null
  ): void {
    damage(
      this.level,
      other,
      this.owner,
      this.owner,
      forward,
      Math.trunc(points * this.quad),
      0,
      mod,
      point
    );
  }

  /** One hit on the accuracy the board shows, on the shooter's account (`accuracy_hits`). */
  private accuracyHit(): void {
    const client = this.owner.client;
    if (client) client.accuracyHits++;
  }
}
