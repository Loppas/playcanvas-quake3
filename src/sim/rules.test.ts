import { describe, expect, it, vi } from 'vitest';

import type { CvarStore } from '../net/cvar';
import { GAME_CVARS } from './game';
import {
  RULE_CVARS,
  RuleCvars,
  SYSTEMINFO_CVARS,
  SYSTEMINFO_RULES,
  defaultRules
} from './rules';

/** A store over `values`, counting a modification whenever `set` changes one. */
function store(values: Record<string, string>): CvarStore {
  const counts = new Map<string, number>();
  let total = 0;
  const set = (name: string, value: string) => {
    if (values[name] === value) return;
    values[name] = value;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    total++;
  };
  return {
    get: (name) => values[name] ?? '',
    set,
    setServer: (name, value) => {
      set(name, value);
      return true;
    },
    modificationCount: (name) => counts.get(name) ?? 0,
    totalModifications: () => total
  };
}

describe('the rules', () => {
  it("default to their cvars' defaults, which are id's", () => {
    expect(defaultRules()).toMatchObject({
      dmflags: 0,
      pmove_JumpVelocity: 270,
      pmove_WalkAccel: 10,
      pmove_WalkFriction: 6,
      pmove_FallDeltaMedium: 40,
      pmove_FallDeltaDuckScale: 2,
      pmove_SnapVelocity: 1,
      pmove_KeepSlopeSpeed: 1,
      // The water's are id's, the wade's the swim's own scale.
      pmove_WaterSwimScale: 0.5,
      pmove_WaterWadeScale: 0.5,
      pmove_WaterAccel: 4,
      pmove_WaterFriction: 1,
      // Every one of CPMA's switches is off.
      pmove_AirControl: 0,
      pmove_ChainJump: 0,
      pmove_RampJump: 0,
      pmove_StepJump: 0,
      pmove_WholeSteps: 0,
      pmove_StepRise: 0,
      pmove_CrouchSlide: 0,
      pmove_FlagCarrierSpeedMax: 0,
      pmove_FiringFlag: 0,
      pmove_WaterWaistAtOrigin: 0,
      pmove_WaterHeadEventsAlive: 0,
      // The weapon step's are id's times, and its switches off.
      pmove_WeaponDropTime: 200,
      pmove_WeaponRaiseTime: 250,
      pmove_WeaponNoAmmoTime: 500,
      weapon_reload_rg: 1500,
      weapon_hasteFactor: 1.3,
      pmove_WeaponLockTime: 0,
      pmove_WeaponUpgradeLockTime: 0,
      pmove_TalkHoldsWeapon: 0,
      g_countdownHold: 0,
      weapon_timer_rg: 0,
      weapon_switchTime_rg: 0,
      weapon_hasteSparesReload: 0,
      weapon_hasteSkipsSwitch: 0,
      // The shots' are id's numbers, and their switches id's ways.
      g_quadfactor: 3,
      g_muzzleForward: 14,
      g_muzzleSnap: 1,
      g_damage_g: 50,
      g_damage_mg: 7,
      g_damage_mg_team: 5,
      g_damage_mg_teamAll: 0,
      g_range_g: 32,
      g_range_mg: 131072,
      g_spread_mg: 200,
      g_pellets_sg: 11,
      g_spread_sg: 700,
      g_pattern_sg: 0,
      g_gauntletOnFire: 0,
      g_bulletImpactSnap: 1,
      g_railTrailOffset: 1,
      // The missiles' are id's numbers, and their switches off.
      g_damage_gl: 100,
      g_damage_rl: 100,
      g_damage_pg: 20,
      g_damage_bfg: 100,
      g_splashdamage_gl: 100,
      g_splashdamage_rl: 100,
      g_splashdamage_pg: 15,
      g_splashdamage_bfg: 100,
      g_splashradius_gl: 150,
      g_splashradius_rl: 120,
      g_splashradius_pg: 20,
      g_splashradius_bfg: 120,
      g_velocity_gl: 700,
      g_velocity_rl: 900,
      g_velocity_pg: 2000,
      g_velocity_bfg: 2000,
      g_fuse_gl: 2500,
      g_bounce_gl: 0.65,
      g_bounceTruncate_gl: 0,
      g_size_bfg: 0,
      g_knockback_directAway: 0,
      g_plasmaSize: 16,
      g_plasmaMarkSize: 16,
      // A hit's are id's: every scale 1, the lift 24, the suit's half, and a point at least.
      g_knockback_g: 1,
      g_knockback_mg: 1,
      g_knockback_sg: 1,
      g_knockback_gl: 1,
      g_knockback_rl: 1,
      g_knockback_lg: 1,
      g_knockback_rg: 1,
      g_knockback_pg: 1,
      g_knockback_bfg: 1,
      g_knockback_self: 1,
      g_knockback_lg_falloff: 0,
      g_knockback_rg_falloff: 0,
      g_knockback_falloffRange: 768,
      g_knockback_z: 24,
      g_knockback_z_self: 24,
      g_knockbackTimer_mg: 1,
      g_knockbackTimer_lg: 1,
      g_knockbackTimer_pg: 1,
      g_knockback_handicap: 1,
      g_minDamage: 1,
      g_battleSuitFactor: 0.5,
      // Health's are id's: the max health is the limit, a spawn is 25 over it, and haste is 1.3.
      g_fixedHealthLimits: 0,
      g_startingHealthBonus: 25,
      g_hasteFactor: 1.3,
      // Armour's are id's one: untiered, every armour protects as the yellow's 0.66, an item adds
      // its quantity up to twice the limit, and armour over the limit drains a point a second.
      armor_tiered: 0,
      armor_rescale: 0,
      armor_protection_ga: 0.5,
      armor_protection_ya: 0.66,
      armor_protection_ra: 0.75,
      armor_pickup_ga: 25,
      armor_pickup_ya: 50,
      armor_pickup_ra: 100,
      armor_max_ga: 0,
      armor_max_ya: 0,
      armor_max_ra: 0,
      armor_decayTime_ga: 1000,
      armor_decayTime_ya: 1000,
      armor_decayTime_ra: 1000,
      armor_protection_self: 0
    });
  });

  it("read a value's fraction, and a switch's whole number", () => {
    const reader = new RuleCvars(store({ pmove_WalkAccel: '10.5', pmove_AirControl: '1.9' }));
    reader.update();
    expect(reader.rules.pmove_WalkAccel).toBe(10.5);
    expect(reader.rules.pmove_AirControl).toBe(1);
  });

  it('are registered by the game module with the rest of its cvars', () => {
    for (const rule of RULE_CVARS) expect(GAME_CVARS).toContain(rule);
  });

  it('read each cvar as a vmCvar_t reads it, at the first update', () => {
    const reader = new RuleCvars(store({ dmflags: '40 and more' }));
    expect(reader.rules.dmflags).toBe(0);
    reader.update();
    expect(reader.rules.dmflags).toBe(40);
  });

  it('read a cvar again only once it has been modified, into the same record', () => {
    const values = { dmflags: '8' };
    const cvars = store(values);
    const reader = new RuleCvars(cvars);
    const { rules } = reader;
    reader.update();

    // Changed with no modification counted, which `trap_Cvar_Update` would not see either.
    values.dmflags = '16';
    reader.update();
    expect(rules.dmflags).toBe(8);

    cvars.set('dmflags', '32');
    reader.update();
    expect(reader.rules).toBe(rules);
    expect(rules.dmflags).toBe(32);
  });

  it('ask after no cvar while nothing in the store has changed', () => {
    const cvars = store({ dmflags: '8' });
    const reader = new RuleCvars(cvars);
    reader.update();
    const asked = vi.spyOn(cvars, 'modificationCount');
    reader.update();
    expect(asked).not.toHaveBeenCalled();

    // Another cvar's change is a change: each rule is asked after, and none has moved.
    cvars.set('sv_hostname', 'elsewhere');
    reader.update();
    expect(asked).toHaveBeenCalledTimes(RULE_CVARS.length);
    expect(reader.rules.dmflags).toBe(8);
  });
});

describe('the systeminfo', () => {
  it('carries the game cvars a client reads beside the rules it predicts by', () => {
    expect(SYSTEMINFO_CVARS.slice(0, SYSTEMINFO_RULES.length)).toEqual(SYSTEMINFO_RULES);
    expect(SYSTEMINFO_CVARS.slice(SYSTEMINFO_RULES.length)).toEqual([
      'pmove_msec',
      'g_allowGrapple',
      'sv_cheats',
      'xp_unlagged',
      'sv_fps'
    ]);
  });
});
