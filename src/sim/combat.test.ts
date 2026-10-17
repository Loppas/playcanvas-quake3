import { describe, expect, it } from 'vitest';

import { ENTITYNUM_WORLD, MAX_STATS, type PlayerState } from '../net/protocol';
import {
  DAMAGE_NO_ARMOR,
  DAMAGE_NO_KNOCKBACK,
  DAMAGE_NO_PROTECTION,
  DAMAGE_RADIUS,
  GIB_HEALTH,
  applyKnockback,
  bodyDie,
  checkArmor,
  damage,
  gibEntity,
  logAccuracyHit
} from './combat';
import {
  ARMOR_PROTECTION,
  CONTENTS,
  FL,
  GT,
  MOD,
  PERS,
  PMF_TIME_KNOCKBACK,
  STAT,
  TEAM
} from './constants';
import { EV, eventNumber } from './events';
import { ET, type GameEntity } from './game-entity';
import { ARMOR_TIER, PW } from './items';
import { Level } from './level';
import { ID_RULES, defaultRules, type Rules } from './rules';
import { presetRules } from './rules-test-fixtures';
import { onSameTeam } from './team';
import { clearTrace, createArmedPlayerState, createIdlePlayerState, type TraceFn } from './types';
import { vec3, type Vec3 } from './vec3';
import { radiusDamage } from './weapons/splash';
import { linkPlayer } from './weapons/weapon-test-fixtures';

/** Stats with the given armor and nothing else of note. */
function stats(armor: number): number[] {
  const values = new Array<number>(MAX_STATS).fill(0);
  values[STAT.HEALTH] = 100;
  values[STAT.ARMOR] = armor;
  values[STAT.MAX_HEALTH] = 100;
  return values;
}

/** A world that links what it is told to. */
const world = () => new Level();

/** A client in `slot` that can be hurt: health 100, the max 100, standing still. */
function player(level: Level, slot: number): { entity: GameEntity; state: PlayerState } {
  const entity = level.gentities[slot];
  entity.client = level.clients[slot];
  entity.inuse = true;
  entity.takedamage = true;
  entity.s.eType = ET.PLAYER;
  entity.r.contents = CONTENTS.BODY;
  const state = entity.client.ps;
  Object.assign(state, createArmedPlayerState({ origin: vec3(0, 0, 24) }));
  state.clientNum = slot;
  entity.health = state.stats[STAT.HEALTH];
  return { entity, state };
}

/** Something in the world that can be hurt and is not a client: a corpse in the queue. */
function thing(level: Level, health: number): GameEntity {
  const entity = level.spawnEntity();
  entity.takedamage = true;
  entity.health = health;
  return entity;
}

/** Record every call to an entity's `die`. */
function recordDeaths(entity: GameEntity): unknown[][] {
  const calls: unknown[][] = [];
  entity.die = (...args) => calls.push(args);
  return calls;
}

describe('checkArmor', () => {
  it('soaks 66% of a hit, rounded up, off the armor', () => {
    const armored = stats(100);
    expect(checkArmor(armored, 50, 0)).toBe(33);
    expect(armored[STAT.ARMOR]).toBe(67);

    // 6.6 and 0.66 both round up: armor always takes something while it lasts.
    expect(checkArmor(stats(100), 10, 0)).toBe(7);
    expect(checkArmor(stats(100), 1, 0)).toBe(1);
  });

  it('soaks no more than the armor there is', () => {
    const thin = stats(5);
    expect(checkArmor(thin, 50, 0)).toBe(5);
    expect(thin[STAT.ARMOR]).toBe(0);
  });

  it('soaks nothing without armor, or from a hit armor does not cover', () => {
    expect(checkArmor(stats(0), 50, 0)).toBe(0);

    const armored = stats(100);
    expect(checkArmor(armored, 50, DAMAGE_NO_ARMOR)).toBe(0);
    expect(armored[STAT.ARMOR]).toBe(100);
  });

  it("rounds as the game VM's single-precision floats do, a quad gauntlet's 150 included", () => {
    // Retail Q3 runs the game as a QVM, whose floats are 32-bit. Hits are only ever near a whole
    // number of saved points at multiples of 50, and single and double precision part at 150,
    // 300, 350 and on. The quad takes the gauntlet's 50 to 150.
    expect(checkArmor(stats(200), 150, 0)).toBe(100);
    expect(checkArmor(stats(300), 300, 0)).toBe(199);
    expect(Math.ceil(150 * ARMOR_PROTECTION)).toBe(99);
    const f = Math.fround;
    for (let damage = 1; damage <= 2000; damage++) {
      const vm = Math.ceil(f(f(damage) * f(ARMOR_PROTECTION)));
      expect(checkArmor(stats(2000), damage, 0), String(damage)).toBe(vm);
    }
  });

  it("pins Q3's numbers", () => {
    expect(ARMOR_PROTECTION).toBe(0.66);
    expect(GIB_HEALTH).toBe(-40);
  });
});

describe("the armour's tiers", () => {
  /**
   * What 200 armour of `tier` saves of a 100-point hit: a rail from another, or your own rocket's
   * blast, halved to 50 first.
   */
  function saved(rules: Rules, tier: number, own = false): number {
    const level = new Level({ rules });
    const { entity, state } = player(level, 0);
    const shooter = own ? entity : player(level, 1).entity;
    state.stats[STAT.ARMOR] = 200;
    state.stats[STAT.ARMOR_TIER] = tier;
    const mod = own ? MOD.ROCKET_SPLASH : MOD.RAILGUN;
    damage(level, entity, shooter, shooter, vec3(1, 0, 0), 100, 0, mod);
    return 200 - state.stats[STAT.ARMOR];
  }

  it("protects by the tier's share, and your own hits by a preset's self share", () => {
    const { GA, YA, RA } = ARMOR_TIER;
    const fingerprint = (rules: Rules) => [
      [saved(rules, GA), saved(rules, YA), saved(rules, RA)],
      [saved(rules, GA, true), saved(rules, YA, true), saved(rules, RA, true)]
    ];
    const tiers = [50, 66, 75];
    expect(fingerprint(presetRules('vq3'))).toEqual([tiers, [25, 33, 38]]);
    expect(fingerprint(presetRules('pmc'))).toEqual([tiers, [25, 33, 38]]);
    for (const name of ['cpm', 'cq3', 'dev']) {
      expect(fingerprint(presetRules(name)), name).toEqual([tiers, [25, 25, 25]]);
    }
  });

  it("protects id's way with the tier at its default, the yellow", () => {
    expect(saved(ID_RULES, ARMOR_TIER.YA)).toBe(66);
    expect(ARMOR_TIER.YA).toBe(0);
  });
});

describe('applyKnockback', () => {
  const standing = () => createIdlePlayerState({ origin: vec3(0, 0, 24) });

  it('adds 5 units of speed per damage point', () => {
    // kvel = dir * g_knockback * knockback / 200 = 1000 * damage / 200 = 5 * damage.
    const state = standing();
    applyKnockback(state, vec3(0, 0, 1), 100);
    expect(state.velocity).toEqual(vec3(0, 0, 500));
  });

  it('caps knockback at 200 damage, so 1000 ups is the ceiling', () => {
    const state = standing();
    applyKnockback(state, vec3(0, 0, 1), 5000);
    expect(state.velocity.z).toBe(1000);
  });

  it('normalizes the direction', () => {
    const state = standing();
    applyKnockback(state, vec3(0, 0, 17), 100);
    expect(state.velocity.z).toBeCloseTo(500, 6);
  });

  it('adds to existing velocity rather than replacing it', () => {
    // A rocket jump taken mid-strafe keeps every bit of the horizontal speed already built
    // up — the whole basis of rocket-jump movement.
    const state = standing();
    state.velocity = vec3(320, 0, 0);
    applyKnockback(state, vec3(0, 0, 1), 100);
    expect(state.velocity).toEqual(vec3(320, 0, 500));
  });

  it('starts the friction-free window', () => {
    const state = standing();
    applyKnockback(state, vec3(0, 0, 1), 100);
    // clamp(knockback * 2, 50, 200) — 100 damage gives the full 200 ms.
    expect(state.pmTime).toBe(200);
    expect(state.pmFlags & PMF_TIME_KNOCKBACK).toBeTruthy();
  });

  it('clamps the window to between 50 and 200 ms', () => {
    const light = standing();
    applyKnockback(light, vec3(0, 0, 1), 5);
    expect(light.pmTime).toBe(50);

    const heavy = standing();
    applyKnockback(heavy, vec3(0, 0, 1), 200);
    expect(heavy.pmTime).toBe(200);
  });

  it('will not extend a window already running', () => {
    // A second blast cannot refresh the timer, so friction returns on schedule.
    const state = standing();
    applyKnockback(state, vec3(0, 0, 1), 100);
    state.pmTime = 40;
    applyKnockback(state, vec3(0, 0, 1), 100);
    expect(state.pmTime).toBe(40);
    // The velocity still stacks, though.
    expect(state.velocity.z).toBe(1000);
  });

  it('does nothing for zero damage', () => {
    const state = standing();
    expect(applyKnockback(state, vec3(0, 0, 1), 0)).toEqual(vec3());
    expect(state.velocity).toEqual(vec3());
    expect(state.pmTime).toBe(0);
  });
});

describe('the battle suit', () => {
  /** The player wearing it: `ps.powerups` carries the powerup's end time, and any value is on. */
  function suited(level: Level, slot: number) {
    const who = player(level, slot);
    who.state.powerups[PW.BATTLESUIT] = 1;
    return who;
  }

  it('halves a hit that is not a blast, and says so', () => {
    const level = world();
    const { entity, state } = suited(level, 0);

    damage(level, entity, null, null, null, 60, 0, MOD.MACHINEGUN);

    expect(state.stats[STAT.HEALTH]).toBe(100 - 30);
    // The event is what plays the suit's sound and pulses its icon (`cg_event.c:1203`).
    expect(eventNumber(state.externalEvent)).toBe(EV.POWERUP_BATTLESUIT);
  });

  it('refuses a blast and a fall outright, and the blast still pushes', () => {
    const level = world();
    const { entity, state } = suited(level, 0);

    damage(level, entity, null, null, vec3(0, 0, 3), 100, DAMAGE_RADIUS, MOD.ROCKET_SPLASH);
    expect(state.stats[STAT.HEALTH]).toBe(100);
    // "Battlesuit protects from all radius damage (but takes knockback)" (`g_combat.c:946`).
    expect(state.velocity).toEqual(vec3(0, 0, 500));

    damage(level, entity, null, null, null, 10, 0, MOD.FALLING);
    expect(state.stats[STAT.HEALTH]).toBe(100);
    expect(eventNumber(state.externalEvent)).toBe(EV.POWERUP_BATTLESUIT);
  });

  it('lets a hit through that says protection does not count', () => {
    // The god check is guarded by `DAMAGE_NO_PROTECTION` and the suit's is not (`g_combat.c:928–954`).
    const level = world();
    const { entity, state } = suited(level, 0);
    entity.flags |= FL.GODMODE;
    damage(level, entity, null, null, null, 30, DAMAGE_NO_PROTECTION, MOD.TELEFRAG);
    expect(state.stats[STAT.HEALTH]).toBe(100 - 15);
  });

  it('leaves a player without one taking the hit whole', () => {
    const level = world();
    const { entity, state } = player(level, 0);

    damage(level, entity, null, null, null, 60, 0, MOD.MACHINEGUN);

    expect(state.stats[STAT.HEALTH]).toBe(100 - 60);
    expect(state.externalEvent).toBe(0);
  });
});

describe('G_Damage', () => {
  it('hurts anything that can be hurt, and nothing that cannot', () => {
    const level = world();
    const corpse = thing(level, 0);
    damage(level, corpse, null, null, null, 30, 0, MOD.ROCKET);
    expect(corpse.health).toBe(-30);

    const wall = thing(level, 50);
    wall.takedamage = false;
    damage(level, wall, null, null, null, 30, 0, MOD.ROCKET);
    expect(wall.health).toBe(50);
  });

  it("keeps a client's health on the player state and the entity both", () => {
    const level = world();
    const { entity, state } = player(level, 0);
    damage(level, entity, null, null, null, 30, 0, MOD.FALLING);
    expect(state.stats[STAT.HEALTH]).toBe(70);
    expect(entity.health).toBe(70);
  });

  it('hurts nobody once the intermission has been qualified for', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    level.intermissionQueued = 1000;
    damage(level, entity, null, null, vec3(0, 0, 1), 30, 0, MOD.ROCKET);
    expect(state.stats[STAT.HEALTH]).toBe(100);
    expect(state.velocity).toEqual(vec3());
  });

  it('hurts nobody who is flying through walls', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    entity.client!.noclip = true;
    damage(level, entity, null, null, vec3(0, 0, 1), 30, 0, MOD.ROCKET);
    expect(state.stats[STAT.HEALTH]).toBe(100);
    expect(state.velocity).toEqual(vec3());
  });

  it("scales what an attacker deals to others by their handicap, in ints, not their own", () => {
    const level = world();
    const shooter = player(level, 1);
    shooter.state.stats[STAT.MAX_HEALTH] = 55;
    const victim = player(level, 2);

    // 33 * 55 / 100 = 18.15, so 18.
    damage(level, victim.entity, shooter.entity, shooter.entity, null, 33, 0, MOD.RAILGUN);
    expect(victim.state.stats[STAT.HEALTH]).toBe(100 - 18);

    // Their own hit is halved instead: 33 / 2, truncated.
    damage(level, shooter.entity, shooter.entity, shooter.entity, null, 33, 0, MOD.ROCKET_SPLASH);
    expect(shooter.state.stats[STAT.HEALTH]).toBe(100 - 16);
  });

  it('pushes a client along the hit, before anything can stop the damage', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    entity.flags |= FL.GODMODE;
    damage(level, entity, null, null, vec3(0, 0, 3), 100, DAMAGE_RADIUS, MOD.ROCKET_SPLASH);
    expect(state.velocity).toEqual(vec3(0, 0, 500));
    expect(state.stats[STAT.HEALTH]).toBe(100);
  });

  it('pushes nothing without a direction, or flagged not to, or once dead', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    damage(level, entity, null, null, null, 10, 0, MOD.FALLING);
    damage(level, entity, null, null, vec3(0, 0, 1), 10, DAMAGE_NO_KNOCKBACK, MOD.ROCKET);
    entity.flags |= FL.NO_KNOCKBACK;
    damage(level, entity, null, null, vec3(0, 0, 1), 10, 0, MOD.ROCKET);
    expect(state.velocity).toEqual(vec3());
    expect(state.stats[STAT.HEALTH]).toBe(70);
  });

  it('lets a hit through god that says god does not help', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    entity.flags |= FL.GODMODE;
    damage(level, entity, null, null, null, 30, DAMAGE_NO_PROTECTION, MOD.TELEFRAG);
    expect(state.stats[STAT.HEALTH]).toBe(70);
  });

  it('costs at least a point, and soaks armor from a client alone', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    state.stats[STAT.ARMOR] = 100;
    damage(level, entity, null, null, null, 0, 0, MOD.ROCKET_SPLASH);
    // The one point is the armor's, rounded up.
    expect(state.stats[STAT.ARMOR]).toBe(99);
    expect(state.stats[STAT.HEALTH]).toBe(100);

    const corpse = thing(level, 0);
    damage(level, corpse, null, null, null, 0, 0, MOD.ROCKET_SPLASH);
    expect(corpse.health).toBe(-1);
  });

  it('tells the client who hurt it, how, and from where', () => {
    const level = world();
    const shooter = player(level, 3);
    const { entity, state } = player(level, 1);
    const client = entity.client!;

    damage(level, entity, shooter.entity, shooter.entity, vec3(0, 2, 0), 10, 0, MOD.MACHINEGUN);
    expect(state.persistant[PERS.ATTACKER]).toBe(3);
    expect(client.lasthurtClient).toBe(3);
    expect(client.lasthurtMod).toBe(MOD.MACHINEGUN);
    expect(client.damageBlood).toBe(10);
    expect(client.damageKnockback).toBe(10);
    expect(client.damageFrom).toEqual(vec3(0, 1, 0));
    expect(client.damageFromWorld).toBe(false);

    // A hit with no attacker is the world's, and with no direction is from where they stand.
    entity.r.currentOrigin = vec3(7, 8, 9);
    damage(level, entity, null, null, null, 5, 0, MOD.FALLING);
    expect(state.persistant[PERS.ATTACKER]).toBe(ENTITYNUM_WORLD);
    expect(client.lasthurtClient).toBe(ENTITYNUM_WORLD);
    expect(client.damageFromWorld).toBe(true);
    expect(client.damageFrom).toEqual(vec3(7, 8, 9));
    expect(client.damageBlood).toBe(15);
    // A hit that pushes nothing adds nothing to the frame's knockback.
    expect(client.damageKnockback).toBe(10);
  });

  it('calls die once the health is gone, with the world standing in for nobody', () => {
    const level = world();
    const shooter = player(level, 2);
    const rocket = level.spawnEntity();
    const { entity, state } = player(level, 1);
    const deaths = recordDeaths(entity);

    damage(level, entity, rocket, shooter.entity, null, 60, 0, MOD.ROCKET);
    expect(deaths).toEqual([]);
    // Armor soaks ten of the killing hit, and `die` is told what got through.
    state.stats[STAT.ARMOR] = 10;
    damage(level, entity, rocket, shooter.entity, null, 60, 0, MOD.ROCKET);
    expect(deaths).toEqual([[entity, rocket, shooter.entity, 50, MOD.ROCKET]]);
    expect(entity.enemy).toBe(shooter.entity);
    expect(state.stats[STAT.HEALTH]).toBe(-10);
    // A killed client is not pushed about any more.
    expect(entity.flags & FL.NO_KNOCKBACK).toBeTruthy();

    const corpse = thing(level, 0);
    const fell = recordDeaths(corpse);
    damage(level, corpse, null, null, null, 5, 0, MOD.FALLING);
    const worldEntity = level.gentities[ENTITYNUM_WORLD];
    expect(fell).toEqual([[corpse, worldEntity, worldEntity, 5, MOD.FALLING]]);
    expect(corpse.flags & FL.NO_KNOCKBACK).toBe(0);
  });

  it('never lets health fall below −999', () => {
    const level = world();
    const { entity, state } = player(level, 0);
    damage(level, entity, null, null, null, 100_000, DAMAGE_NO_PROTECTION, MOD.TELEFRAG);
    expect(state.stats[STAT.HEALTH]).toBe(-999);
    expect(entity.health).toBe(-999);
  });

  it('counts a hit for the attacker, and remembers the target’s health and armor', () => {
    const level = world();
    const shooter = player(level, 2);
    const { entity, state } = player(level, 1);
    state.stats[STAT.ARMOR] = 40;

    damage(level, entity, null, shooter.entity, null, 10, 0, MOD.MACHINEGUN);

    expect(shooter.state.persistant[PERS.HITS]).toBe(1);
    // `(targ->health<<8)|client->ps.stats[STAT_ARMOR]` (`g_combat.c:966`), read before the hit is
    // taken off, which is why this is 100 and not 90.
    expect(shooter.state.persistant[PERS.ATTACKEE_ARMOR]).toBe((100 << 8) | 40);
  });

  it('counts nothing for a hit on the attacker’s own self, or on something that is not a player', () => {
    const level = world();
    const shooter = player(level, 2);

    damage(level, shooter.entity, null, shooter.entity, null, 10, DAMAGE_NO_PROTECTION, MOD.ROCKET);
    expect(shooter.state.persistant[PERS.HITS]).toBe(0);

    const barrel = thing(level, 100);
    damage(level, barrel, null, shooter.entity, null, 10, 0, MOD.ROCKET);
    expect(shooter.state.persistant[PERS.HITS]).toBe(0);
  });

});

describe('GibEntity and body_die', () => {
  it('leaves nothing to hurt, hit or draw, and says so on the entity', () => {
    const level = world();
    const corpse = thing(level, -50);
    corpse.r.contents = CONTENTS.CORPSE;
    gibEntity(level, corpse, 4);
    expect(eventNumber(corpse.s.event)).toBe(EV.GIB_PLAYER);
    expect(corpse.s.eventParm).toBe(4);
    expect(corpse.takedamage).toBe(false);
    expect(corpse.s.eType).toBe(ET.INVISIBLE);
    expect(corpse.r.contents).toBe(0);
  });

  it('gibs a corpse at −40 or below, crediting nobody, and leaves one above it', () => {
    const level = world();
    const whole = thing(level, -39);
    bodyDie(level, whole);
    expect(whole.takedamage).toBe(true);

    const torn = thing(level, -40);
    torn.s.eventParm = 9;
    bodyDie(level, torn);
    expect(eventNumber(torn.s.event)).toBe(EV.GIB_PLAYER);
    expect(torn.s.eventParm).toBe(0);
  });
});

describe('OnSameTeam', () => {
  it('puts nobody on anybody’s side below GT_TEAM', () => {
    const level = world();
    const one = player(level, 0).entity;
    const two = player(level, 1).entity;
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.RED;

    expect(onSameTeam(GT.FFA, one, two)).toBe(false);
    expect(onSameTeam(GT.TEAM, one, two)).toBe(true);
  });

  it('is no for two on opposite sides, and no for anything that is not a client', () => {
    const level = world();
    const one = player(level, 0).entity;
    const two = player(level, 1).entity;
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.BLUE;

    expect(onSameTeam(GT.TEAM, one, two)).toBe(false);
    expect(onSameTeam(GT.TEAM, one, thing(level, 100))).toBe(false);
  });
});

describe('a hit on your own side', () => {
  /** Two players on red in a team game, with friendly fire as asked. */
  function sides(friendlyFire: number) {
    const level = world();
    level.itemMatch = {
      ...level.itemMatch,
      gametype: () => GT.TEAM,
      friendlyFire: () => friendlyFire
    };
    const shooter = player(level, 0);
    const mate = player(level, 1);
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.RED;
    return { level, shooter, mate };
  }

  /** A rocket from the shooter into the mate. */
  function fire(built: ReturnType<typeof sides>): void {
    const { level, shooter, mate } = built;
    damage(level, mate.entity, shooter.entity, shooter.entity, vec3(1, 0, 0), 50, 0, MOD.ROCKET);
  }

  it('costs them nothing while g_friendlyFire is off', () => {
    const built = sides(0);

    fire(built);

    expect(built.mate.state.stats[STAT.HEALTH]).toBe(100);
  });

  it('pushes them all the same, since the momentum goes on before the refusal', () => {
    const built = sides(0);

    fire(built);

    expect(built.mate.state.velocity.x).toBeGreaterThan(0);
  });

  it('lands once g_friendlyFire is on', () => {
    const built = sides(1);

    fire(built);

    expect(built.mate.state.stats[STAT.HEALTH]).toBe(50);
  });

  it('takes the attacker’s hit count back rather than adding to it', () => {
    const built = sides(1);

    fire(built);

    expect(built.shooter.state.persistant[PERS.HITS]).toBe(-1);
  });

  it('is not what hurting yourself is, whatever side you are on', () => {
    const { level, shooter } = sides(0);

    // A rocket jump in a team game: the halving applies where the refusal does not.
    damage(level, shooter.entity, shooter.entity, shooter.entity, vec3(0, 0, 1), 50, 0, MOD.ROCKET);

    expect(shooter.state.stats[STAT.HEALTH]).toBe(75);
  });

  it('is no shelter from a hit that carries DAMAGE_NO_PROTECTION', () => {
    // The flag skips the side and god alike, both being inside the one guard
    // (`g_combat.c:916–941`) — so a telefrag kills a team mate whatever `g_friendlyFire` says.
    const { level, shooter, mate } = sides(0);

    damage(
      level,
      mate.entity,
      shooter.entity,
      shooter.entity,
      null,
      50,
      DAMAGE_NO_PROTECTION,
      MOD.TELEFRAG
    );

    expect(mate.state.stats[STAT.HEALTH]).toBe(50);
  });
});

describe('a hit in Clan Arena', () => {
  /** A red shooter, a red mate and a blue enemy, each with the armour asked for. */
  function arena(armor: number) {
    const level = world();
    level.itemMatch = { ...level.itemMatch, gametype: () => GT.CA, friendlyFire: () => 0 };
    const shooter = player(level, 0);
    const mate = player(level, 1);
    const enemy = player(level, 2);
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.RED;
    level.clients[2].sess.sessionTeam = TEAM.BLUE;
    for (const { state } of [shooter, mate, enemy]) state.stats[STAT.ARMOR] = armor;
    return { level, shooter, mate, enemy };
  }

  /** A rocket's worth of damage from the shooter into `target`. */
  function hit(level: Level, shooter: GameEntity, target: GameEntity, points: number): void {
    damage(level, target, shooter, shooter, vec3(1, 0, 0), points, 0, MOD.ROCKET);
  }

  it("takes a mate's hit off the armour alone, up to 25, with friendly fire off", () => {
    const { level, shooter, mate } = arena(150);

    hit(level, shooter.entity, mate.entity, 100);

    expect(mate.state.stats[STAT.HEALTH]).toBe(100);
    expect(mate.state.stats[STAT.ARMOR]).toBe(125);
  });

  it('takes your own off the armour alone, after the halving', () => {
    const { level, shooter } = arena(150);

    hit(level, shooter.entity, shooter.entity, 30);

    expect(shooter.state.stats[STAT.HEALTH]).toBe(100);
    expect(shooter.state.stats[STAT.ARMOR]).toBe(135);
  });

  it('takes nothing of your own once the armour is gone', () => {
    const { level, shooter } = arena(0);

    hit(level, shooter.entity, shooter.entity, 100);

    expect(shooter.state.stats[STAT.HEALTH]).toBe(100);
    expect(shooter.state.stats[STAT.ARMOR]).toBe(0);
  });

  it("hurts an enemy as Quake 3's hit does", () => {
    const { level, shooter, enemy } = arena(150);

    hit(level, shooter.entity, enemy.entity, 50);

    // The armour's two thirds, rounded up, and the rest off the health.
    expect(enemy.state.stats[STAT.ARMOR]).toBe(117);
    expect(enemy.state.stats[STAT.HEALTH]).toBe(83);
  });

  it('lets a hit that carries DAMAGE_NO_PROTECTION through to a mate whole', () => {
    const { level, shooter, mate } = arena(0);

    damage(
      level,
      mate.entity,
      shooter.entity,
      shooter.entity,
      null,
      50,
      DAMAGE_NO_PROTECTION,
      MOD.TELEFRAG
    );

    expect(mate.state.stats[STAT.HEALTH]).toBe(50);
  });
});

describe("a round's countdown", () => {
  /** Two players and a round in the state asked for. */
  function round(roundTime: number) {
    const level = world();
    level.itemMatch = { ...level.itemMatch, gametype: () => GT.CA };
    const shooter = player(level, 0);
    const target = player(level, 1);
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.BLUE;
    level.roundTime = roundTime;
    return { level, shooter, target };
  }

  it('refuses a hit, and its push, while a round is counted down', () => {
    const { level, shooter, target } = round(5000);

    damage(level, target.entity, shooter.entity, shooter.entity, vec3(1, 0, 0), 50, 0, MOD.ROCKET);

    expect(target.state.stats[STAT.HEALTH]).toBe(100);
    expect(target.state.velocity).toEqual(vec3(0, 0, 0));
  });

  it('lets a hit that nothing protects against through', () => {
    const { level, shooter, target } = round(5000);

    damage(
      level,
      target.entity,
      shooter.entity,
      shooter.entity,
      null,
      50,
      DAMAGE_NO_PROTECTION,
      MOD.TELEFRAG
    );

    expect(target.state.stats[STAT.HEALTH]).toBe(50);
  });

  it('lets hits land between rounds and in one', () => {
    for (const roundTime of [-1, 0]) {
      const { level, shooter, target } = round(roundTime);

      damage(level, target.entity, shooter.entity, shooter.entity, null, 50, 0, MOD.ROCKET);

      expect(target.state.stats[STAT.HEALTH]).toBe(50);
    }
  });
});

describe('a hit on a flag carrier', () => {
  /** A carrier on red and a shooter on blue, in the gametype given. */
  function carrying(gametype: number) {
    const level = world();
    level.itemMatch = { ...level.itemMatch, gametype: () => gametype, friendlyFire: () => 1 };
    level.time = 9_000;
    const carrier = player(level, 0);
    const shooter = player(level, 1);
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.BLUE;
    carrier.state.powerups[PW.BLUEFLAG] = 2_147_483_647;
    return { level, carrier, shooter };
  }

  it('is remembered against the shooter, so their team can be paid for the kill', () => {
    const { level, carrier, shooter } = carrying(GT.CTF);

    damage(level, carrier.entity, shooter.entity, shooter.entity, vec3(1, 0, 0), 10, 0, MOD.ROCKET);

    expect(level.clients[1].pers.teamState.lasthurtcarrier).toBe(9_000);
  });

  it('is not remembered outside Capture the Flag, where there is no flag to have hurt', () => {
    const { level, carrier, shooter } = carrying(GT.TEAM);

    damage(level, carrier.entity, shooter.entity, shooter.entity, vec3(1, 0, 0), 10, 0, MOD.ROCKET);

    expect(level.clients[1].pers.teamState.lasthurtcarrier).toBe(0);
  });
});

describe('the damage given', () => {
  /** Two players in a free-for-all, the target with the armour asked for. */
  function pair(armor = 0) {
    const level = world();
    const shooter = player(level, 0);
    const target = player(level, 1);
    target.state.stats[STAT.ARMOR] = armor;
    return { level, shooter: shooter.entity, target: target.entity };
  }

  /** A hit from `from` into `to`, pushing nothing. */
  function hit(
    level: Level,
    from: GameEntity,
    to: GameEntity,
    points: number,
    mod: number = MOD.ROCKET
  ): void {
    damage(level, to, from, from, null, points, 0, mod);
  }

  it("counts the whole of a hit, the armour's share and the health's alike", () => {
    const { level, shooter, target } = pair(100);

    hit(level, shooter, target, 60);
    expect(target.client!.ps.stats[STAT.ARMOR]).toBeLessThan(100);
    expect(level.clients[0].damageGiven).toBe(60);

    hit(level, shooter, target, 30);
    expect(level.clients[0].damageGiven).toBe(90);
  });

  it('counts a hit of over a thousand, as a telefrag is, as a hundred', () => {
    const { level, shooter, target } = pair();
    damage(level, target, shooter, shooter, null, 100_000, DAMAGE_NO_PROTECTION, MOD.TELEFRAG);
    expect(level.clients[0].damageGiven).toBe(100);

    const other = pair();
    hit(other.level, other.shooter, other.target, 1000);
    expect(other.level.clients[0].damageGiven).toBe(1000);
  });

  it('counts nothing on the shooter, on the dead, or on what is not a client', () => {
    const { level, shooter, target } = pair();
    hit(level, shooter, shooter, 50);
    target.health = 0;
    target.client!.ps.stats[STAT.HEALTH] = 0;
    hit(level, shooter, target, 50);
    hit(level, shooter, thing(level, 50), 50);

    expect(level.clients[0].damageGiven).toBe(0);
  });

  it('counts nothing by suicide, nor in the warmup', () => {
    const { level, shooter, target } = pair();
    hit(level, shooter, target, 50, MOD.SUICIDE);
    level.warmupTime = 5000;
    hit(level, shooter, target, 20);

    expect(level.clients[0].damageGiven).toBe(0);
  });

  it("counts nothing on the shooter's own side", () => {
    const level = world();
    level.itemMatch = { ...level.itemMatch, gametype: () => GT.CA, friendlyFire: () => 0 };
    const shooter = player(level, 0).entity;
    const mate = player(level, 1).entity;
    const enemy = player(level, 2).entity;
    level.clients[0].sess.sessionTeam = TEAM.RED;
    level.clients[1].sess.sessionTeam = TEAM.RED;
    level.clients[2].sess.sessionTeam = TEAM.BLUE;
    level.clients[1].ps.stats[STAT.ARMOR] = 100;

    // The mate's armour takes it, as Clan Arena's does, and it still counts for nothing.
    hit(level, shooter, mate, 50);
    expect(level.clients[1].ps.stats[STAT.ARMOR]).toBeLessThan(100);
    expect(level.clients[0].damageGiven).toBe(0);
    hit(level, shooter, enemy, 50);
    expect(level.clients[0].damageGiven).toBe(50);
  });
});

describe('LogAccuracyHit', () => {
  it('counts a living client hit by another client', () => {
    const level = world();
    const shooter = player(level, 0).entity;
    const target = player(level, 1).entity;

    expect(logAccuracyHit(level, target, shooter)).toBe(true);
  });

  it('refuses a hit on anything that cannot be hurt', () => {
    const level = world();
    const shooter = player(level, 0).entity;
    const target = player(level, 1).entity;
    target.takedamage = false;

    expect(logAccuracyHit(level, target, shooter)).toBe(false);
  });

  it('refuses a hit on the shooter themselves', () => {
    const level = world();
    const shooter = player(level, 0).entity;

    expect(logAccuracyHit(level, shooter, shooter)).toBe(false);
  });

  it('refuses a hit on anything that is not a client', () => {
    const level = world();
    const shooter = player(level, 0).entity;

    expect(logAccuracyHit(level, thing(level, 100), shooter)).toBe(false);
  });

  it('refuses a hit with no client behind it', () => {
    const level = world();
    const target = player(level, 1).entity;

    expect(logAccuracyHit(level, target, thing(level, 100))).toBe(false);
  });

  it('refuses a hit on a team mate, so shooting your own side only costs accuracy', () => {
    const level = world();
    level.itemMatch = { ...level.itemMatch, gametype: () => GT.TEAM };
    const shooter = player(level, 0).entity;
    const mate = player(level, 1).entity;
    level.clients[0].sess.sessionTeam = TEAM.BLUE;
    level.clients[1].sess.sessionTeam = TEAM.BLUE;

    expect(logAccuracyHit(level, mate, shooter)).toBe(false);

    level.clients[1].sess.sessionTeam = TEAM.RED;
    expect(logAccuracyHit(level, mate, shooter)).toBe(true);
  });

  it('refuses a hit on a client already dead', () => {
    const level = world();
    const shooter = player(level, 0).entity;
    const { entity, state } = player(level, 1);
    state.stats[STAT.HEALTH] = 0;

    expect(logAccuracyHit(level, entity, shooter)).toBe(false);
  });
});

describe("CPMA's rules for damage and knockback", () => {
  const PMC = presetRules('pmc');
  const CQ3 = presetRules('cq3');
  const CPM = presetRules('cpm');

  /**
   * A hit on a player at full health with no armour, under `rules`: another's, from a shooter whose
   * base is at (0, 0, 24), or the player's own. It pushes along +X.
   */
  function hit(
    rules: Readonly<Rules>,
    mod: number,
    options: {
      points?: number;
      own?: boolean;
      point?: Vec3;
      handicap?: number;
      suited?: boolean;
    } = {}
  ): PlayerState {
    const level = new Level({ rules });
    const shooter = player(level, 0);
    shooter.entity.s.pos.trBase = vec3(0, 0, 24);
    shooter.state.stats[STAT.MAX_HEALTH] = options.handicap ?? 100;
    const { entity, state } = player(level, 1);
    state.stats[STAT.ARMOR] = 0;
    if (options.suited) state.powerups[PW.BATTLESUIT] = 1;
    const by = options.own ? entity : shooter.entity;
    const points = options.points ?? 20;
    damage(level, entity, by, by, vec3(1, 0, 0), points, 0, mod, options.point ?? null);
    return state;
  }

  /** A 20-point hit's push over the 100 id's gives it: the scale it was pushed by. */
  const scaleOf = (state: PlayerState) => Math.round(state.velocity.x * 100) / 10000;

  /** What a hit took off a player who stood at 100. */
  const takenBy = (state: PlayerState) => 100 - state.stats[STAT.HEALTH];

  /** The lift a blast 50 units off at a player's height gives them: another's, then their own. */
  function lifts(rules: Readonly<Rules>): number[] {
    const clear: TraceFn = (_start, _mins, _maxs, end) => clearTrace(end);
    return [false, true].map((own) => {
      const level = new Level({ rules });
      const { entity, state } = player(level, 1);
      linkPlayer(level, entity);
      const by = own ? entity : null;
      radiusDamage(level, clear, vec3(-50, 0, 24), by, 20, 120, null, MOD.ROCKET_SPLASH);
      return Math.round((state.velocity.z / state.velocity.x) * 50 * 1000) / 1000;
    });
  }

  /** What a preset's hits do, in the numbers where the presets differ. */
  function dealt(name: string) {
    const rules = presetRules(name);
    const weapons = [
      MOD.GAUNTLET,
      MOD.MACHINEGUN,
      MOD.SHOTGUN,
      MOD.GRENADE,
      MOD.ROCKET,
      MOD.LIGHTNING,
      MOD.RAILGUN,
      MOD.PLASMA,
      MOD.BFG
    ];
    const blasts = [MOD.GRENADE_SPLASH, MOD.ROCKET_SPLASH, MOD.PLASMA_SPLASH, MOD.BFG_SPLASH];
    const unhurried = [MOD.MACHINEGUN, MOD.LIGHTNING, MOD.PLASMA, MOD.PLASMA_SPLASH, MOD.ROCKET];
    const landing = (mod: number) =>
      [vec3(384, 0, 24), vec3(1000, 0, 24)].map((point) => scaleOf(hit(rules, mod, { point })));
    const handicapped = (handicap: number) => {
      const state = hit(rules, MOD.GRENADE, { handicap });
      return [takenBy(state), state.velocity.x / 5];
    };
    return {
      scale: weapons.map((mod) => scaleOf(hit(rules, mod))),
      blast: blasts.map((mod) => scaleOf(hit(rules, mod))),
      own: scaleOf(hit(rules, MOD.ROCKET, { own: true })),
      // The bolt's and the rail's, landing 384 and 1,000 units from the shooter.
      falloff: [landing(MOD.LIGHTNING), landing(MOD.RAILGUN)],
      // Whether another's machinegun, bolt, plasma and plasma blast start the timer, and a rocket.
      timer: unhurried.map((mod) => hit(rules, mod).pmTime > 0),
      lift: lifts(rules),
      // What a 20-point hit takes, and the knockback it pushes by, from a shooter on 50 and on 1.
      handicap: [handicapped(50), handicapped(1)],
      // What a hit of nothing takes, and a player's own hit of 1.
      least: [
        takenBy(hit(rules, MOD.MACHINEGUN, { points: 0 })),
        takenBy(hit(rules, MOD.MACHINEGUN, { points: 1, own: true }))
      ],
      suit: takenBy(hit(rules, MOD.MACHINEGUN, { suited: true }))
    };
  }

  /** CPMA's, where the four presets agree. */
  const CPMA = {
    timer: [false, false, false, false, true],
    handicap: [
      [10, 20],
      [1, 20]
    ],
    least: [0, 0]
  };
  /** CPM's, and DEV's, which is built on it. */
  const CPM_WAY = {
    ...CPMA,
    scale: [0.5, 1, 1.35, 1, 1.125, 1.5, 1, 1, 1],
    blast: [1, 1.125, 1, 1],
    own: 1,
    falloff: [
      [1.5, 1.5],
      [1, 1]
    ],
    lift: [0, 24],
    suit: 5
  };

  it.each([
    [
      'vq3',
      {
        scale: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        blast: [1, 1, 1, 1],
        own: 1,
        falloff: [
          [1, 1],
          [1, 1]
        ],
        timer: [true, true, true, true, true],
        lift: [24, 24],
        handicap: [
          [10, 10],
          [1, 0]
        ],
        least: [1, 1],
        suit: 10
      }
    ],
    [
      'pmc',
      {
        ...CPMA,
        scale: [0.5, 1, 1.35, 1, 1.2, 1.5, 1, 0.5, 1],
        blast: [1, 1.2, 0.5, 1],
        own: 1,
        falloff: [
          [1.5, 1.5],
          [1, 1]
        ],
        lift: [36, 24],
        suit: 5
      }
    ],
    ['cpm', CPM_WAY],
    [
      'cq3',
      {
        ...CPMA,
        scale: [0.5, 1, 1.35, 1, 1.1, 1.25, 1, 1, 1.5],
        blast: [1, 1.1, 1, 1.5],
        own: 1.05,
        falloff: [
          [1, 0.75],
          [0.75, 0.5]
        ],
        lift: [0, 24],
        suit: 10
      }
    ],
    ['dev', CPM_WAY]
  ])("deals %s's hits", (name, expected) => {
    expect(dealt(name)).toEqual(expected);
  });

  it("keeps id's numbers where every preset does", () => {
    const ids = defaultRules();
    const same = [
      'g_knockback_mg',
      'g_knockback_gl',
      'g_knockback_rg',
      'g_knockback_z_self',
      'g_knockback_falloffRange'
    ] as const;
    for (const name of ['pmc', 'cpm', 'cq3', 'dev']) {
      const rules = presetRules(name);
      for (const rule of same) expect(rules[rule], `${name}: ${rule}`).toBe(ids[rule]);
    }
  });

  it("reads each weapon's own falloff", () => {
    const rules = { ...ID_RULES, g_knockback_lg_falloff: 0.25 };
    const far = vec3(1000, 0, 24);
    expect(scaleOf(hit(rules, MOD.LIGHTNING, { point: far }))).toBe(0.75);
    expect(scaleOf(hit(rules, MOD.RAILGUN, { point: far }))).toBe(1);
  });

  it("keeps the knockback's number unscaled, for the timer and the feedback", () => {
    const state = hit(PMC, MOD.ROCKET, { points: 60 });
    expect(state.velocity.x).toBeCloseTo(360, 9);
    // clamp(2 × 60, 50, 200), not 2 × 72.
    expect(state.pmTime).toBe(120);
    expect(state.pmFlags & PMF_TIME_KNOCKBACK).toBeTruthy();
  });

  it("starts the knockback timer on a player's own hit, whatever the weapon", () => {
    for (const mod of [MOD.MACHINEGUN, MOD.LIGHTNING, MOD.PLASMA]) {
      expect(hit(PMC, mod, { own: true }).pmTime, String(mod)).toBe(50);
    }
  });

  it('takes no falloff for a hit that gives no point', () => {
    expect(scaleOf(hit(CQ3, MOD.LIGHTNING))).toBe(1.25);
    expect(scaleOf(hit(CQ3, MOD.RAILGUN))).toBe(1);
  });

  it('takes the whole falloff at any distance when the range is 0', () => {
    const rules = { ...CQ3, g_knockback_falloffRange: 0 };
    expect(scaleOf(hit(rules, MOD.LIGHTNING, { point: vec3(10, 0, 24) }))).toBe(0.75);
  });

  it('does nothing at all with a hit of nothing under g_minDamage 0', () => {
    const level = new Level({ rules: CPM });
    const shooter = player(level, 0);
    const { entity, state } = player(level, 1);
    state.powerups[PW.BATTLESUIT] = 1;

    damage(level, entity, shooter.entity, shooter.entity, vec3(1, 0, 0), 0, 0, MOD.MACHINEGUN);

    // No beep for the shooter, and no pulse of the suit.
    expect(shooter.state.persistant[PERS.HITS]).toBe(0);
    expect(state.externalEvent).toBe(0);
  });

  it('leaves no feedback from a hit halved to nothing under g_minDamage 0', () => {
    const level = new Level({ rules: CPM });
    const { entity, state } = player(level, 1);
    const client = level.clients[1];

    damage(level, entity, entity, entity, vec3(1, 0, 0), 1, 0, MOD.ROCKET);

    // The push lands, as it does before any damage is reckoned; nothing after it does.
    expect(state.velocity.x).toBe(5);
    expect(client.damageKnockback).toBe(0);
    expect(client.lasthurtMod).toBe(0);
  });
});
