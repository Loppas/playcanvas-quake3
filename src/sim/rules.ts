import { atof, atoi } from '../formats/c-scan';
import type { CvarStore } from '../net/cvar';
import { infoPairs } from '../net/info';
import { SV_FPS } from '../net/snapshot-rate';
import {
  ARMOR_PROTECTION,
  DUCKED_FALL_MULTIPLIER,
  FALL_DELTA_MEDIUM,
  JUMP_VELOCITY,
  PM_ACCELERATE,
  PM_AIRACCELERATE,
  PM_FRICTION,
  PM_SWIMSCALE,
  PM_WATERACCELERATE,
  PM_WATERFRICTION
} from './constants';
import { BATTLESUIT_FACTOR, HASTE_RATE } from './powerups';
import {
  BULLET_RANGE,
  GAUNTLET_DAMAGE,
  GAUNTLET_RANGE,
  LIGHTNING_DAMAGE,
  LIGHTNING_RANGE,
  MACHINEGUN_DAMAGE,
  MACHINEGUN_SPREAD,
  MACHINEGUN_TEAM_DAMAGE,
  MISSILES,
  MUZZLE_FORWARD,
  NO_AMMO_TIME,
  QUAD_FACTOR,
  RAILGUN_DAMAGE,
  RAILGUN_RANGE,
  SHOTGUN_COUNT,
  SHOTGUN_DAMAGE,
  SHOTGUN_SPREAD,
  SPLASH_UP_BIAS,
  WEAPON_DROP_TIME,
  WEAPON_FIRE_TIME,
  WEAPON_RAISE_TIME,
  WP,
  type MissileSpec,
  type WeaponId
} from './weapons/constants';

/**
 * The settings the rules of play are made of. Each is a cvar whose default is id's value, so a
 * fresh install plays Quake 3, and a preset cfg sets a whole ruleset's worth of them at once.
 *
 * They are read as the game module reads a `vmCvar_t`: parsed into a number when registered, and
 * parsed again only once the cvar has changed, which `G_UpdateCvars` looks for at the top of every
 * frame (`g_main.c:373–400`). What reads them reads the record, so a change reaches everything in
 * the same frame, and nothing parses a string in the middle of a move.
 */

/** A weapon's reload as id has it, as a rule's default. */
const reload = (weapon: WeaponId) => String(WEAPON_FIRE_TIME[weapon]);

/** A missile's numbers as id has them, as rules' defaults. */
const idMissile = (weapon: WeaponId) => (field: Exclude<keyof MissileSpec, 'motion'>) =>
  String(MISSILES[weapon]![field]);
const grenade = idMissile(WP.GRENADE_LAUNCHER);
const rocket = idMissile(WP.ROCKET_LAUNCHER);
const plasma = idMissile(WP.PLASMAGUN);
const bfg = idMissile(WP.BFG);

/** A rule's cvar: its name, its default, and how Quake 3's code reads it. */
export interface RuleCvar {
  readonly name: string;
  readonly default: string;
  /** Quake 3's `trackChange`: whether a change is announced to everyone. */
  readonly track: boolean;
  /** Which of `vmCvar_t`'s numbers the code reads: `integer` (`atoi`) or `value` (`atof`). */
  readonly read: 'integer' | 'value';
}

/** The rules' cvars, which the game module registers with the rest of its own. */
export const RULE_CVARS = [
  // Quake 3's switches for the whole server, as a bit field (`DF_*`). A preset writes all of it.
  { name: 'dmflags', default: '0', track: true, read: 'integer' },

  // The move. A switch is 0 or 1, and 1 is CPMA's; the values under a switch act only while it
  // is on. Times are in ms and speeds in units a second.
  { name: 'pmove_JumpVelocity', default: String(JUMP_VELOCITY), track: false, read: 'value' },
  { name: 'pmove_WalkAccel', default: String(PM_ACCELERATE), track: false, read: 'value' },
  { name: 'pmove_WalkFriction', default: String(PM_FRICTION), track: false, read: 'value' },
  { name: 'pmove_AirControl', default: '0', track: false, read: 'integer' },
  { name: 'pmove_AirControlStrength', default: '150', track: false, read: 'value' },
  { name: 'pmove_AirStopAccel', default: String(PM_AIRACCELERATE), track: false, read: 'value' },
  { name: 'pmove_StrafeAccel', default: String(PM_AIRACCELERATE), track: false, read: 'value' },
  { name: 'pmove_WishSpeed', default: '400', track: false, read: 'value' },
  { name: 'pmove_ChainJump', default: '0', track: false, read: 'integer' },
  { name: 'pmove_ChainJumpVelocity', default: '105', track: false, read: 'value' },
  { name: 'pmove_ChainJumpTime', default: '400', track: false, read: 'integer' },
  // With this much of the window left or less, a chained jump adds the late velocity instead.
  { name: 'pmove_ChainJumpLateTime', default: '0', track: false, read: 'integer' },
  { name: 'pmove_ChainJumpLateVelocity', default: '45', track: false, read: 'value' },
  { name: 'pmove_RampJump', default: '0', track: false, read: 'integer' },
  { name: 'pmove_StepJump', default: '0', track: false, read: 'integer' },
  { name: 'pmove_StepJumpVelocityMax', default: '380', track: false, read: 'value' },
  { name: 'pmove_WholeSteps', default: '0', track: false, read: 'integer' },
  { name: 'pmove_StepRise', default: '0', track: false, read: 'integer' },
  { name: 'pmove_FallDeltaMedium', default: String(FALL_DELTA_MEDIUM), track: false, read: 'value' },
  {
    name: 'pmove_FallDeltaDuckScale',
    default: String(DUCKED_FALL_MULTIPLIER),
    track: false,
    read: 'value'
  },
  // A crouch slide starts on a crouched landing over the start speed, and ends at the stop speed,
  // both counted in three dimensions. While it runs the ground takes a constant decel a second, and
  // a crouched wish is the duck scale × the player's speed.
  { name: 'pmove_CrouchSlide', default: '0', track: false, read: 'integer' },
  { name: 'pmove_CrouchSlideTime', default: '500', track: false, read: 'integer' },
  { name: 'pmove_CrouchSlideAccel', default: '4', track: false, read: 'value' },
  { name: 'pmove_CrouchSlideStartSpeed', default: '480', track: false, read: 'value' },
  { name: 'pmove_CrouchSlideStopSpeed', default: '321', track: false, read: 'value' },
  { name: 'pmove_CrouchSlideDecel', default: '500', track: false, read: 'value' },
  { name: 'pmove_CrouchSlideDuckScale', default: '1', track: false, read: 'value' },
  // A multiple of the player's speed, `g_speed`; 0 is no limit.
  { name: 'pmove_FlagCarrierSpeedMax', default: '0', track: false, read: 'value' },
  { name: 'pmove_SnapVelocity', default: '1', track: false, read: 'integer' },
  { name: 'pmove_KeepSlopeSpeed', default: '1', track: false, read: 'integer' },
  { name: 'pmove_FiringFlag', default: '0', track: false, read: 'integer' },
  // The water. A swim is held to the swim scale × the player's speed, and a walk in water toward
  // the scale a third of the way at each level, the wade scale's at the first.
  { name: 'pmove_WaterSwimScale', default: String(PM_SWIMSCALE), track: false, read: 'value' },
  { name: 'pmove_WaterWadeScale', default: String(PM_SWIMSCALE), track: false, read: 'value' },
  { name: 'pmove_WaterAccel', default: String(PM_WATERACCELERATE), track: false, read: 'value' },
  { name: 'pmove_WaterFriction', default: String(PM_WATERFRICTION), track: false, read: 'value' },
  { name: 'pmove_WaterWaistAtOrigin', default: '0', track: false, read: 'integer' },
  { name: 'pmove_WaterHeadEventsAlive', default: '0', track: false, read: 'integer' },

  // The weapon step, in ms. A lock holds a weapon change before the new weapon comes up, and 0 is
  // none. The upgrade lock is on a change from the gauntlet or the machinegun to a better weapon,
  // once one has been raised since the spawn.
  {
    name: 'pmove_WeaponDropTime',
    default: String(WEAPON_DROP_TIME),
    track: false,
    read: 'integer'
  },
  {
    name: 'pmove_WeaponRaiseTime',
    default: String(WEAPON_RAISE_TIME),
    track: false,
    read: 'integer'
  },
  { name: 'pmove_WeaponNoAmmoTime', default: String(NO_AMMO_TIME), track: false, read: 'integer' },
  { name: 'pmove_WeaponLockTime', default: '0', track: false, read: 'integer' },
  { name: 'pmove_WeaponUpgradeLockTime', default: '0', track: false, read: 'integer' },
  { name: 'pmove_TalkHoldsWeapon', default: '0', track: false, read: 'integer' },
  { name: 'g_countdownHold', default: '0', track: false, read: 'integer' },
  { name: 'weapon_reload_g', default: reload(WP.GAUNTLET), track: false, read: 'integer' },
  { name: 'weapon_reload_mg', default: reload(WP.MACHINEGUN), track: false, read: 'integer' },
  { name: 'weapon_reload_sg', default: reload(WP.SHOTGUN), track: false, read: 'integer' },
  { name: 'weapon_reload_gl', default: reload(WP.GRENADE_LAUNCHER), track: false, read: 'integer' },
  { name: 'weapon_reload_rl', default: reload(WP.ROCKET_LAUNCHER), track: false, read: 'integer' },
  { name: 'weapon_reload_lg', default: reload(WP.LIGHTNING), track: false, read: 'integer' },
  { name: 'weapon_reload_rg', default: reload(WP.RAILGUN), track: false, read: 'integer' },
  { name: 'weapon_reload_pg', default: reload(WP.PLASMAGUN), track: false, read: 'integer' },
  { name: 'weapon_reload_bfg', default: reload(WP.BFG), track: false, read: 'integer' },
  // The railgun's reload on a timer of its own, which runs while it is holstered and carries no
  // overshoot. With it on, the switch time is how soon a change away may begin, and 0 is the
  // reload.
  { name: 'weapon_timer_rg', default: '0', track: false, read: 'integer' },
  { name: 'weapon_switchTime_rg', default: '0', track: false, read: 'integer' },
  // Haste divides the weapon's times by the factor, and 1 is none.
  { name: 'weapon_hasteFactor', default: String(HASTE_RATE), track: false, read: 'value' },
  { name: 'weapon_hasteSparesReload', default: '0', track: false, read: 'integer' },
  { name: 'weapon_hasteSkipsSwitch', default: '0', track: false, read: 'integer' },

  // The shots. A damage is before the quad factor. The muzzle is how far ahead of the eye a shot
  // leaves, and whether it is snapped to whole units; missiles leave from it too.
  { name: 'g_quadfactor', default: String(QUAD_FACTOR), track: false, read: 'value' },
  { name: 'g_muzzleForward', default: String(MUZZLE_FORWARD), track: false, read: 'value' },
  { name: 'g_muzzleSnap', default: '1', track: false, read: 'integer' },
  { name: 'g_damage_g', default: String(GAUNTLET_DAMAGE), track: false, read: 'integer' },
  { name: 'g_damage_mg', default: String(MACHINEGUN_DAMAGE), track: false, read: 'integer' },
  { name: 'g_damage_sg', default: String(SHOTGUN_DAMAGE), track: false, read: 'integer' },
  { name: 'g_damage_lg', default: String(LIGHTNING_DAMAGE), track: false, read: 'integer' },
  { name: 'g_damage_rg', default: String(RAILGUN_DAMAGE), track: false, read: 'integer' },
  // The machinegun's damage in team play: team deathmatch's alone, or with the switch every team
  // mode's.
  {
    name: 'g_damage_mg_team',
    default: String(MACHINEGUN_TEAM_DAMAGE),
    track: false,
    read: 'integer'
  },
  { name: 'g_damage_mg_teamAll', default: '0', track: false, read: 'integer' },
  // How far a shot reaches: the gauntlet's past the muzzle, the others' from it. A spread is its
  // offset at 8192 units, so it scales with the range and the cone's angle does not.
  { name: 'g_range_g', default: String(GAUNTLET_RANGE), track: false, read: 'value' },
  { name: 'g_range_mg', default: String(BULLET_RANGE), track: false, read: 'value' },
  { name: 'g_range_lg', default: String(LIGHTNING_RANGE), track: false, read: 'value' },
  { name: 'g_range_rg', default: String(RAILGUN_RANGE), track: false, read: 'value' },
  { name: 'g_spread_mg', default: String(MACHINEGUN_SPREAD), track: false, read: 'value' },
  // The shotgun, which a client reads from the serverinfo to draw a blast. The pattern is 0 for
  // id's random one, and 1 and 2 for CPMA's two fixed ones. The spread is the random one's.
  { name: 'g_pellets_sg', default: String(SHOTGUN_COUNT), track: false, read: 'integer' },
  { name: 'g_spread_sg', default: String(SHOTGUN_SPREAD), track: false, read: 'value' },
  { name: 'g_pattern_sg', default: '0', track: false, read: 'integer' },
  // The gauntlet's reach check before the move picks the target, and the fire event after it hurts
  // that target, rather than the check hurting it.
  { name: 'g_gauntletOnFire', default: '0', track: false, read: 'integer' },
  // Where the impacts are drawn: a round's snapped toward the muzzle, and the rail's trail begun
  // under the drawn gun.
  { name: 'g_bulletImpactSnap', default: '1', track: false, read: 'integer' },
  { name: 'g_railTrailOffset', default: '1', track: false, read: 'integer' },

  // The missiles, read as each is fired. A splash radius of 0 is no splash at all.
  { name: 'g_damage_gl', default: grenade('damage'), track: false, read: 'integer' },
  { name: 'g_damage_rl', default: rocket('damage'), track: false, read: 'integer' },
  { name: 'g_damage_pg', default: plasma('damage'), track: false, read: 'integer' },
  { name: 'g_damage_bfg', default: bfg('damage'), track: false, read: 'integer' },
  { name: 'g_splashdamage_gl', default: grenade('splashDamage'), track: false, read: 'integer' },
  { name: 'g_splashdamage_rl', default: rocket('splashDamage'), track: false, read: 'integer' },
  { name: 'g_splashdamage_pg', default: plasma('splashDamage'), track: false, read: 'integer' },
  { name: 'g_splashdamage_bfg', default: bfg('splashDamage'), track: false, read: 'integer' },
  { name: 'g_splashradius_gl', default: grenade('splashRadius'), track: false, read: 'integer' },
  { name: 'g_splashradius_rl', default: rocket('splashRadius'), track: false, read: 'integer' },
  { name: 'g_splashradius_pg', default: plasma('splashRadius'), track: false, read: 'integer' },
  { name: 'g_splashradius_bfg', default: bfg('splashRadius'), track: false, read: 'integer' },
  { name: 'g_velocity_gl', default: grenade('speed'), track: false, read: 'integer' },
  { name: 'g_velocity_rl', default: rocket('speed'), track: false, read: 'integer' },
  { name: 'g_velocity_pg', default: plasma('speed'), track: false, read: 'integer' },
  { name: 'g_velocity_bfg', default: bfg('speed'), track: false, read: 'integer' },
  { name: 'g_fuse_gl', default: grenade('lifetime'), track: false, read: 'integer' },
  // A grenade's bounce, read as it bounces. Truncated, its speed and base stay whole, and it comes
  // to rest a unit above where it stopped.
  { name: 'g_bounce_gl', default: grenade('bounce'), track: false, read: 'value' },
  { name: 'g_bounceTruncate_gl', default: '0', track: false, read: 'integer' },
  // The BFG flies as a box of ± the size, and 0 is a point.
  { name: 'g_size_bfg', default: '0', track: false, read: 'value' },
  // A direct hit from a missile with a splash pushes away from the missile, not along its flight.
  { name: 'g_knockback_directAway', default: '0', track: false, read: 'integer' },
  // How a client draws the plasma: its ball's radius, and its mark's, over 16 the scale of the
  // impact's ring. A client reads them from the serverinfo.
  { name: 'g_plasmaSize', default: '16', track: false, read: 'value' },
  { name: 'g_plasmaMarkSize', default: '16', track: false, read: 'value' },

  // What a hit pushes. A weapon's scale multiplies another's hit with it, a blast's included, and a
  // hit on yourself takes the self scale instead. The lightning's and the rail's lose their falloff
  // in proportion to the distance, all of it at the range. The lift is added to a blast's push
  // before it is normalized.
  { name: 'g_knockback_g', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_mg', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_sg', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_gl', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_rl', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_lg', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_rg', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_pg', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_bfg', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_self', default: '1', track: false, read: 'value' },
  { name: 'g_knockback_lg_falloff', default: '0', track: false, read: 'value' },
  { name: 'g_knockback_rg_falloff', default: '0', track: false, read: 'value' },
  { name: 'g_knockback_falloffRange', default: '768', track: false, read: 'value' },
  { name: 'g_knockback_z', default: String(SPLASH_UP_BIAS), track: false, read: 'value' },
  { name: 'g_knockback_z_self', default: String(SPLASH_UP_BIAS), track: false, read: 'value' },
  // Whether another's hit with the weapon starts the knockback timer. Your own always do.
  { name: 'g_knockbackTimer_mg', default: '1', track: false, read: 'integer' },
  { name: 'g_knockbackTimer_lg', default: '1', track: false, read: 'integer' },
  { name: 'g_knockbackTimer_pg', default: '1', track: false, read: 'integer' },
  // Whether the push is worth the handicapped hit. At 0 it is worth the hit before the handicap,
  // and the handicap leaves a hit at least a point.
  { name: 'g_knockback_handicap', default: '1', track: false, read: 'integer' },
  // The least a hit costs once halved, and at 0 a hit of nothing does nothing. The battle suit
  // lets its factor of a hit through.
  { name: 'g_minDamage', default: '1', track: false, read: 'integer' },
  { name: 'g_battleSuitFactor', default: String(BATTLESUIT_FACTOR), track: false, read: 'value' },

  // The health limit the pickups, the medkit, regeneration and the decay measure from is the max
  // health, or under the fixed limits 100 whatever the handicap. A spawn starts the bonus over it.
  // Haste multiplies the player's speed.
  { name: 'g_fixedHealthLimits', default: '0', track: false, read: 'integer' },
  { name: 'g_startingHealthBonus', default: '25', track: false, read: 'integer' },
  { name: 'g_hasteFactor', default: String(HASTE_RATE), track: false, read: 'value' },

  // Armour. Tiered, the item sets the player's tier, and each tier protects by its share; untiered,
  // every armour protects as the yellow. With the rescale on too, a change of tier first rescales
  // the armour held by the two shares, and an armour is taken only if the armour held fits it. An
  // item adds its tier's amount up to its max, and 0 is twice the health limit. Armour over the
  // limit loses a point per its tier's decay time in ms, and 0 is none. A hit on yourself takes
  // the self share, and 0 is the tier's.
  { name: 'armor_tiered', default: '0', track: false, read: 'integer' },
  { name: 'armor_rescale', default: '0', track: false, read: 'integer' },
  { name: 'armor_protection_ga', default: '0.5', track: false, read: 'value' },
  { name: 'armor_protection_ya', default: String(ARMOR_PROTECTION), track: false, read: 'value' },
  { name: 'armor_protection_ra', default: '0.75', track: false, read: 'value' },
  { name: 'armor_pickup_ga', default: '25', track: false, read: 'integer' },
  { name: 'armor_pickup_ya', default: '50', track: false, read: 'integer' },
  { name: 'armor_pickup_ra', default: '100', track: false, read: 'integer' },
  { name: 'armor_max_ga', default: '0', track: false, read: 'integer' },
  { name: 'armor_max_ya', default: '0', track: false, read: 'integer' },
  { name: 'armor_max_ra', default: '0', track: false, read: 'integer' },
  { name: 'armor_decayTime_ga', default: '1000', track: false, read: 'integer' },
  { name: 'armor_decayTime_ya', default: '1000', track: false, read: 'integer' },
  { name: 'armor_decayTime_ra', default: '1000', track: false, read: 'integer' },
  { name: 'armor_protection_self', default: '0', track: false, read: 'value' },

  // Ammo, by weapon. A box gives its amount, or its team deathmatch amount there. A weapon gives
  // its amount in full dropped or in team deathmatch; with the top-up on and outside
  // free-for-all, in full when not held and up to it when held; otherwise up to its quantity, or
  // a round once there. Every add stops at the maximum. The defaults are id's items' quantities.
  { name: 'g_ammoPickup_mg', default: '50', track: false, read: 'integer' },
  { name: 'g_ammoPickup_sg', default: '10', track: false, read: 'integer' },
  { name: 'g_ammoPickup_gl', default: '5', track: false, read: 'integer' },
  { name: 'g_ammoPickup_rl', default: '5', track: false, read: 'integer' },
  { name: 'g_ammoPickup_lg', default: '60', track: false, read: 'integer' },
  { name: 'g_ammoPickup_rg', default: '10', track: false, read: 'integer' },
  { name: 'g_ammoPickup_pg', default: '30', track: false, read: 'integer' },
  { name: 'g_ammoPickup_bfg', default: '15', track: false, read: 'integer' },
  { name: 'g_ammoPickup_mg_tdm', default: '50', track: false, read: 'integer' },
  { name: 'g_ammoPickup_sg_tdm', default: '10', track: false, read: 'integer' },
  { name: 'g_ammoPickup_gl_tdm', default: '5', track: false, read: 'integer' },
  { name: 'g_ammoPickup_rl_tdm', default: '5', track: false, read: 'integer' },
  { name: 'g_ammoPickup_lg_tdm', default: '60', track: false, read: 'integer' },
  { name: 'g_ammoPickup_rg_tdm', default: '10', track: false, read: 'integer' },
  { name: 'g_ammoPickup_pg_tdm', default: '30', track: false, read: 'integer' },
  { name: 'g_ammoPickup_bfg_tdm', default: '15', track: false, read: 'integer' },
  { name: 'g_weaponPickup_mg', default: '40', track: false, read: 'integer' },
  { name: 'g_weaponPickup_sg', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_gl', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_rl', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_lg', default: '100', track: false, read: 'integer' },
  { name: 'g_weaponPickup_rg', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_pg', default: '50', track: false, read: 'integer' },
  { name: 'g_weaponPickup_bfg', default: '20', track: false, read: 'integer' },
  { name: 'g_weaponPickup_mg_tdm', default: '40', track: false, read: 'integer' },
  { name: 'g_weaponPickup_sg_tdm', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_gl_tdm', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_rl_tdm', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_lg_tdm', default: '100', track: false, read: 'integer' },
  { name: 'g_weaponPickup_rg_tdm', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponPickup_pg_tdm', default: '50', track: false, read: 'integer' },
  { name: 'g_weaponPickup_bfg_tdm', default: '20', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_mg', default: '40', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_sg', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_gl', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_rl', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_lg', default: '100', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_rg', default: '10', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_pg', default: '50', track: false, read: 'integer' },
  { name: 'g_weaponQuantity_bfg', default: '20', track: false, read: 'integer' },
  { name: 'g_weaponPickupTopUp', default: '0', track: false, read: 'integer' },
  { name: 'g_maxAmmo_mg', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_sg', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_gl', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_rl', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_lg', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_rg', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_pg', default: '200', track: false, read: 'integer' },
  { name: 'g_maxAmmo_bfg', default: '200', track: false, read: 'integer' },
  // The ammo a client warns under for the weapon in hand, and draws its count red under. With
  // every mark 0 it warns as id's does, by what all the weapons hold. A client reads them from the
  // serverinfo.
  { name: 'g_lowAmmo_mg', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_sg', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_gl', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_rl', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_lg', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_rg', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_pg', default: '0', track: false, read: 'integer' },
  { name: 'g_lowAmmo_bfg', default: '0', track: false, read: 'integer' },

  // How long a taken item is gone, in seconds. The megahealth is a health, unless it wears off.
  // The battlesuit's and the invisibility's times are the powerups' scaled.
  { name: 'g_healthRespawn', default: '35', track: false, read: 'integer' },
  { name: 'g_armorRespawn', default: '25', track: false, read: 'integer' },
  { name: 'g_ammoRespawn', default: '40', track: false, read: 'integer' },
  { name: 'g_powerupRespawn', default: '120', track: false, read: 'integer' },
  { name: 'g_respawnScale_enviro', default: '1', track: false, read: 'value' },
  { name: 'g_respawnScale_invis', default: '1', track: false, read: 'value' },
  // Outside free-for-all, a taken megahealth comes back this many seconds after its taker has
  // lost the bonus: died, left, gone to spectate or come down to 100. 0 keeps the health's time.
  { name: 'g_megaHealthWearOff', default: '0', track: false, read: 'integer' },
  // Whether a map's `wait` times a weapon, its `random` moves one, and both time a powerup.
  { name: 'g_mapWeaponWait', default: '1', track: false, read: 'integer' },
  { name: 'g_mapWeaponRandom', default: '1', track: false, read: 'integer' },
  { name: 'g_mapPowerupTimes', default: '1', track: false, read: 'integer' },
  // A powerup's first appearance, in seconds: the delay, give or take the random part, drawn for
  // each powerup or, together, once for them all.
  { name: 'g_spawnDelay_powerup', default: '45', track: false, read: 'value' },
  { name: 'g_spawnDelayRandom_powerup', default: '15', track: false, read: 'value' },
  { name: 'g_spawnDelayTogether_powerup', default: '0', track: false, read: 'integer' },

  // Outside free-for-all, a dropped weapon carries the dropper's ammo as a pack: each weapon's, up
  // to its box, or its weapon amount in team deathmatch. With no weapon to drop, the box of the
  // best weapon with ammo carries it. A pack is taken whatever the taker holds, and gives it all.
  { name: 'g_dropWeaponAmmo', default: '0', track: false, read: 'integer' },
  // Ammo, without the weapon, that a spawn in a live tourney or CTF match starts with.
  { name: 'g_startingAmmoBonus_sg', default: '0', track: false, read: 'integer' },
  { name: 'g_startingAmmoBonus_gl', default: '0', track: false, read: 'integer' },
  { name: 'g_startingAmmoBonus_rl', default: '0', track: false, read: 'integer' },
  { name: 'g_startingAmmoBonus_lg', default: '0', track: false, read: 'integer' },
  { name: 'g_startingAmmoBonus_rg', default: '0', track: false, read: 'integer' },
  // How far a player's origin may be from an item's and still take it: above it, and either way
  // along the world's x axis. Across y and below it, 36. The touch search about the player reaches
  // 40 across and 52 up, plus the item's own box, which bounds them.
  { name: 'g_itemReachZ', default: '36', track: false, read: 'value' },
  { name: 'g_itemReachPlusX', default: '44', track: false, read: 'value' },
  { name: 'g_itemReachMinusX', default: '50', track: false, read: 'value' }
] as const satisfies readonly RuleCvar[];

/** A rule's cvar name. */
export type RuleName = (typeof RULE_CVARS)[number]['name'];

/** The rules' values, by cvar name. */
export type Rules = Record<RuleName, number>;

/**
 * The rules a client's prediction replays — Quake 3's `CVAR_SYSTEMINFO`, carried in
 * `CS_SYSTEMINFO`.
 *
 * The move, the weapon step and the item touch read only these, so only these have to agree
 * between the server and a client. They are listed here rather than flagged on the table because
 * the host and the client both ask this one list, and because the move's own types are narrowed
 * to it ({@link SysteminfoRules}): a read of an unflagged rule is a compile error rather than a
 * silent misprediction.
 */
export const SYSTEMINFO_RULES = [
  // The move.
  'pmove_JumpVelocity',
  'pmove_WalkAccel',
  'pmove_WalkFriction',
  'pmove_AirControl',
  'pmove_AirControlStrength',
  'pmove_AirStopAccel',
  'pmove_StrafeAccel',
  'pmove_WishSpeed',
  'pmove_ChainJump',
  'pmove_ChainJumpVelocity',
  'pmove_ChainJumpTime',
  'pmove_ChainJumpLateTime',
  'pmove_ChainJumpLateVelocity',
  'pmove_RampJump',
  'pmove_StepJump',
  'pmove_StepJumpVelocityMax',
  'pmove_WholeSteps',
  'pmove_StepRise',
  'pmove_FallDeltaMedium',
  'pmove_FallDeltaDuckScale',
  'pmove_CrouchSlide',
  'pmove_CrouchSlideTime',
  'pmove_CrouchSlideAccel',
  'pmove_CrouchSlideStartSpeed',
  'pmove_CrouchSlideStopSpeed',
  'pmove_CrouchSlideDecel',
  'pmove_CrouchSlideDuckScale',
  'pmove_FlagCarrierSpeedMax',
  'pmove_SnapVelocity',
  'pmove_KeepSlopeSpeed',
  'pmove_FiringFlag',
  'pmove_WaterSwimScale',
  'pmove_WaterWadeScale',
  'pmove_WaterAccel',
  'pmove_WaterFriction',
  'pmove_WaterWaistAtOrigin',
  'pmove_WaterHeadEventsAlive',
  'g_countdownHold',
  'dmflags',

  // The weapon step.
  'pmove_WeaponDropTime',
  'pmove_WeaponRaiseTime',
  'pmove_WeaponNoAmmoTime',
  'pmove_WeaponLockTime',
  'pmove_WeaponUpgradeLockTime',
  'pmove_TalkHoldsWeapon',
  'weapon_reload_g',
  'weapon_reload_mg',
  'weapon_reload_sg',
  'weapon_reload_gl',
  'weapon_reload_rl',
  'weapon_reload_lg',
  'weapon_reload_rg',
  'weapon_reload_pg',
  'weapon_reload_bfg',
  'weapon_timer_rg',
  'weapon_switchTime_rg',
  'weapon_hasteFactor',
  'weapon_hasteSparesReload',
  'weapon_hasteSkipsSwitch',

  // The item touch and the health limit the holdable reads. The armour tiers ride whole: the one
  // helper reads protection, pickup, max and decayTime, and only the first two are a pickup's.
  'g_fixedHealthLimits',
  'armor_tiered',
  'armor_rescale',
  'armor_protection_ya',
  'armor_protection_ga',
  'armor_protection_ra',
  'armor_pickup_ya',
  'armor_pickup_ga',
  'armor_pickup_ra',
  'armor_max_ya',
  'armor_max_ga',
  'armor_max_ra',
  'armor_decayTime_ya',
  'armor_decayTime_ga',
  'armor_decayTime_ra',
  'g_maxAmmo_mg',
  'g_maxAmmo_sg',
  'g_maxAmmo_gl',
  'g_maxAmmo_rl',
  'g_maxAmmo_lg',
  'g_maxAmmo_rg',
  'g_maxAmmo_pg',
  'g_maxAmmo_bfg',
  'g_itemReachPlusX',
  'g_itemReachMinusX',
  'g_itemReachZ'
] as const satisfies readonly RuleName[];

/** A name in {@link SYSTEMINFO_RULES}. */
export type SysteminfoRule = (typeof SYSTEMINFO_RULES)[number];

/**
 * The cvars `CS_SYSTEMINFO` carries: the rules a client's prediction replays
 * ({@link SYSTEMINFO_RULES}) and the two game cvars the replay reads beside them — the tick it
 * chops commands into, and the grapple style. Everything the move, the weapon step and the item
 * touch read is here, so a client predicts on the server's numbers rather than on its own.
 *
 * `sv_cheats` rides with them: it is `CVAR_SYSTEMINFO` in Q3 (`sv_init.c:651`), and a client
 * holds its cheat-flagged cvars at their defaults while it is 0.
 *
 * Excessive Plus's `xp_unlagged` rides with them too, as its does, to tell a client which of its
 * shots the server rewinds the others for, and so does `sv_fps`, as unlagged's game module puts it
 * there, for a client to work out the gap between its snapshots.
 *
 * A client reads the rules, and the cvars beside them its view reads, into a record of its own
 * ({@link readSysteminfoRecord}). The rest are what a server may set in the client's store, and
 * nothing else may.
 */
export const SYSTEMINFO_CVARS = [
  ...SYSTEMINFO_RULES,
  'pmove_msec',
  'g_allowGrapple',
  'sv_cheats',
  'xp_unlagged',
  'sv_fps'
] as const;

/**
 * The rules a client's prediction reads, as a record. A full {@link Rules} fits it, so the
 * server passes the same object to the move as the client does.
 */
export type SysteminfoRules = Pick<Rules, SysteminfoRule>;

/**
 * The rules a client draws its own hitscan shots by, before the server's events for them arrive:
 * the muzzle, the machinegun's cone and reach, the railgun's reach, and where an impact and a
 * trail are drawn. The serverinfo carries them, as it carries the shotgun's pattern.
 */
export const HITSCAN_RULES = [
  'g_muzzleForward',
  'g_muzzleSnap',
  'g_spread_mg',
  'g_range_mg',
  'g_range_rg',
  'g_bulletImpactSnap',
  'g_railTrailOffset'
] as const satisfies readonly RuleName[];

/** The rules in {@link HITSCAN_RULES}, as a record. */
export type HitscanRules = Pick<Rules, (typeof HITSCAN_RULES)[number]>;

/**
 * The serverinfo cvars the port has, which `CS_SERVERINFO` carries and `getstatus` answers with
 * (`CVAR_SERVERINFO`: `common.c:2794–2797`, `sv_init.c:633–648`, `g_main.c:99–183`). A client
 * reads `mapname` from it to know what map it is on (`cl_cgame.c:723–725`).
 *
 * Q3's are in the order it makes them, the engine's and then the game module's, so the string
 * starts as Q3's does, and SERVER INFO's sixteen rows are Q3's. The port's own follow.
 */
export const SERVERINFO_CVARS = [
  // The build, and which game and wire it speaks, for a server browser.
  'version',
  'com_gamename',
  'com_protocol',
  'dmflags',
  'fraglimit',
  'timelimit',
  'g_gametype',
  'mapname',
  'sv_hostname',
  'sv_maxclients',
  'sv_minRate',
  'sv_maxRate',
  'sv_floodProtect',
  'capturelimit',
  'g_needpass',
  'roundlimit',
  'g_gamepreset',
  // The shotgun's pattern, which a client draws a blast by.
  'g_pellets_sg',
  'g_spread_sg',
  'g_pattern_sg',
  // The other hitscan numbers, which a client draws its own shots by before the server answers.
  ...HITSCAN_RULES,
  // How a client draws the plasma, and the BFG's impact.
  'g_plasmaSize',
  'g_plasmaMarkSize',
  'g_splashradius_bfg',
  // The ammo a client warns under, by weapon.
  'g_lowAmmo_mg',
  'g_lowAmmo_sg',
  'g_lowAmmo_gl',
  'g_lowAmmo_rl',
  'g_lowAmmo_lg',
  'g_lowAmmo_rg',
  'g_lowAmmo_pg',
  'g_lowAmmo_bfg'
] as const;

/** A rule's value from its cvar's string. */
function parse(cvar: Pick<RuleCvar, 'read'>, text: string): number {
  return cvar.read === 'integer' ? atoi(text) : atof(text);
}

/** A rule's value from its cvar's string, read as the cvar is. */
export function ruleValue(name: RuleName, text: string): number {
  const cvar = RULE_CVARS.find((each) => each.name === name);
  if (!cvar) throw new Error(`ruleValue: no rule ${name}`);
  return parse(cvar, text);
}

/** The rules at their defaults, which are id's Quake 3. */
export function defaultRules(): Rules {
  return Object.fromEntries(
    RULE_CVARS.map((cvar) => [cvar.name, parse(cvar, cvar.default)])
  ) as Rules;
}

/** The rules at id's values, for whatever is given none. */
export const ID_RULES: Readonly<Rules> = Object.freeze(defaultRules());

/**
 * The server's cvars past the rules that a client's view reads, each a whole number, at what a
 * server that sends none plays: no hook and no shot rewound, as in Quake 3, and the port's own
 * frame rate ({@link SV_FPS}).
 */
const SYSTEMINFO_SERVER_CVARS = { g_allowGrapple: 0, xp_unlagged: 0, sv_fps: SV_FPS } as const;

/**
 * What a client reads out of `CS_SYSTEMINFO` into a record of its own: the rules it predicts by,
 * and the server's cvars its view reads beside them.
 */
export type SysteminfoRecord = SysteminfoRules &
  Record<keyof typeof SYSTEMINFO_SERVER_CVARS, number>;

/** A key of {@link SysteminfoRecord}: how its value is read, and what it is where none is sent. */
interface RecordKey {
  readonly name: keyof SysteminfoRecord;
  readonly read: RuleCvar['read'];
  readonly id: number;
}

/** The record's keys, by the name lowercased, as `Cvar_FindVar` matches one. */
const RECORD_KEYS: ReadonlyMap<string, RecordKey> = new Map(
  [
    ...SYSTEMINFO_RULES.map((name): RecordKey => {
      const cvar = RULE_CVARS.find((each) => each.name === name) as RuleCvar;
      return { name, read: cvar.read, id: ID_RULES[name] };
    }),
    ...Object.entries(SYSTEMINFO_SERVER_CVARS).map(
      ([name, id]): RecordKey => ({ name: name as keyof SysteminfoRecord, read: 'integer', id })
    )
  ].map((key) => [key.name.toLowerCase(), key])
);

/** Whether a systeminfo key is one a client reads into its record, rather than into its cvars. */
export function isSysteminfoRecordKey(key: string): boolean {
  return RECORD_KEYS.has(key.toLowerCase());
}

/** The record at id's values, for {@link readSysteminfoRecord} to fill. */
export function idSysteminfoRecord(): SysteminfoRecord {
  return Object.fromEntries(
    [...RECORD_KEYS.values()].map((key) => [key.name, key.id])
  ) as SysteminfoRecord;
}

/**
 * The record, read out of `CS_SYSTEMINFO` in place, each rule as the server's game module reads
 * its cvar. A key the string leaves out is id's: what a game without it plays.
 */
export function readSysteminfoRecord(systemInfo: string, record: SysteminfoRecord): void {
  for (const key of RECORD_KEYS.values()) record[key.name] = key.id;
  for (const [name, value] of infoPairs(systemInfo)) {
    const key = RECORD_KEYS.get(name.toLowerCase());
    if (key) record[key.name] = parse(key, value);
  }
}

/**
 * The rules, kept in step with their cvars: `trap_Cvar_Update` over each, which reads a cvar again
 * only when its modification count has moved.
 */
export class RuleCvars {
  /** The values. They are updated in place, so whoever holds the record reads the current ones. */
  readonly rules: Rules = defaultRules();

  private readonly cvars: CvarStore;
  /** Each cvar's modification count as last read. */
  private readonly counts = new Map<string, number>();
  /** The store's count of every change as last read, so a frame that changed nothing reads none. */
  private readTotal = -1;

  /** @param cvars - Where the rules' cvars are read from. */
  constructor(cvars: CvarStore) {
    this.cvars = cvars;
  }

  /** Read each rule whose cvar has changed since the last update. The first reads them all. */
  update(): void {
    const total = this.cvars.totalModifications();
    if (total === this.readTotal) return;
    this.readTotal = total;
    for (const cvar of RULE_CVARS) {
      const count = this.cvars.modificationCount(cvar.name);
      if (this.counts.get(cvar.name) === count) continue;
      this.counts.set(cvar.name, count);
      this.rules[cvar.name] = parse(cvar, this.cvars.get(cvar.name));
    }
  }
}
