import { MOD } from '../constants';

/**
 * Every weapon constant, quoted from its ioquake3 source with a file:line reference — the
 * same rule `sim/constants.ts` follows for movement. A value that diverges
 * from source needs both a pinning test and a logged decision.
 *
 * Sources: `game/bg_public.h`, `game/bg_pmove.c`, `game/g_weapon.c`, `game/g_missile.c`,
 * `game/g_combat.c`.
 */

/**
 * `weapon_t` — `bg_public.h:309-329`. Numbering is Q3's own, because it is also the bit
 * position in `STAT_WEAPONS` and the index into `ps.ammo[]`.
 *
 * A plain const object rather than an `enum`: `erasableSyntaxOnly` bans enums.
 * MISSIONPACK's nailgun/prox/chaingun are excluded — baseq3 only.
 */
export const WP = {
  NONE: 0,
  GAUNTLET: 1,
  MACHINEGUN: 2,
  SHOTGUN: 3,
  GRENADE_LAUNCHER: 4,
  ROCKET_LAUNCHER: 5,
  LIGHTNING: 6,
  RAILGUN: 7,
  PLASMAGUN: 8,
  BFG: 9,
  GRAPPLING_HOOK: 10
} as const;

/** One of the {@link WP} values. */
export type WeaponId = (typeof WP)[keyof typeof WP];

/** Every weapon the player carries, in selection order. */
export const ALL_WEAPONS: WeaponId[] = [
  WP.GAUNTLET,
  WP.MACHINEGUN,
  WP.SHOTGUN,
  WP.GRENADE_LAUNCHER,
  WP.ROCKET_LAUNCHER,
  WP.LIGHTNING,
  WP.RAILGUN,
  WP.PLASMAGUN,
  WP.BFG,
  WP.GRAPPLING_HOOK
];

/** `MAX_WEAPONS` — `qcommon/q_shared.h`. Sizes `STAT_WEAPONS` and `ps->ammo[]`. */
export const MAX_WEAPONS = 16;

/**
 * Q3's infinite-ammo sentinel. `PM_Weapon` decrements ammo only when it is not -1
 * (`bg_pmove.c:1690`), so this value passes every check untouched, with no special-casing
 * anywhere.
 */
export const AMMO_INFINITE = -1;

/** `weaponstate_t` — `bg_public.h:140-145`. */
export const WEAPON_READY = 0;
export const WEAPON_RAISING = 1;
export const WEAPON_DROPPING = 2;
export const WEAPON_FIRING = 3;

/** One of the `WEAPON_*` states. */
export type WeaponState = 0 | 1 | 2 | 3;

/**
 * Fire interval per weapon, in milliseconds — the `addTime` switch at `bg_pmove.c:1645-1688`.
 *
 * **Added** to `weaponTime` rather than assigned. An interval that is not a multiple of the
 * 8 ms tick cannot be hit exactly, so individual gaps jitter — the machinegun's 100 ms
 * alternates 104 and 96 — but the average comes out exact, because `weaponTime` is left
 * negative when it expires and the overshoot is carried into the next interval. Assigning,
 * or clamping the timer at zero, would make every weapon measurably slower than Q3's.
 */
export const WEAPON_FIRE_TIME: Record<WeaponId, number> = {
  [WP.NONE]: 400,
  [WP.GAUNTLET]: 400,
  [WP.MACHINEGUN]: 100,
  [WP.SHOTGUN]: 1000,
  [WP.GRENADE_LAUNCHER]: 800,
  [WP.ROCKET_LAUNCHER]: 800,
  [WP.LIGHTNING]: 50,
  [WP.RAILGUN]: 1500,
  [WP.PLASMAGUN]: 100,
  [WP.BFG]: 200,
  [WP.GRAPPLING_HOOK]: 400
};

/** Penalty when firing with an empty clip — `bg_pmove.c:1686`. Moot with infinite ammo. */
export const NO_AMMO_TIME = 500;

/** `PM_BeginWeaponChange` — `bg_pmove.c:1468`. */
export const WEAPON_DROP_TIME = 200;
/** `PM_FinishWeaponChange` — `bg_pmove.c:1493`. Total switch is 450 ms. */
export const WEAPON_RAISE_TIME = 250;

/** Muzzle offset along `forward` from the eye — `CalcMuzzlePointOrigin`, `g_weapon.c:787`. */
export const MUZZLE_FORWARD = 14;

/** `DEFAULT_SHOTGUN_SPREAD` / `DEFAULT_SHOTGUN_COUNT` — `bg_public.h`. */
export const SHOTGUN_SPREAD = 700;
export const SHOTGUN_COUNT = 11;

/** Machinegun spread — `Bullet_Fire`, `g_weapon.c:164`. */
export const MACHINEGUN_SPREAD = 200;

/** `LIGHTNING_RANGE` — `bg_public.h`. */
export const LIGHTNING_RANGE = 768;

/** Railgun trace length — `weapon_railgun_fire`, `g_weapon.c:437`. */
export const RAILGUN_RANGE = 8192;

/** `MAX_RAIL_HITS` (`g_weapon.c:436`): how many a rail passes through before it stops anyway. */
export const MAX_RAIL_HITS = 4;

/** Gauntlet reach — `CheckGauntletAttack`, `g_weapon.c:69`. */
export const GAUNTLET_RANGE = 32;

/**
 * Hitscan trace length for bullets — `g_weapon.c:178-183` builds the endpoint as
 * `muzzle + 8192 * 16 * forward`. The 16x is not a typo: id wanted a ray that leaves any
 * map, and the spread offsets are scaled by the same 16 so the cone angle stays right.
 */
export const BULLET_RANGE = 8192 * 16;

/** `CheckGauntletAttack`'s punch (`g_weapon.c:118`), before the quad factor. */
export const GAUNTLET_DAMAGE = 50;

/** `MACHINEGUN_DAMAGE` (`g_weapon.c:161`): a round outside team play. */
export const MACHINEGUN_DAMAGE = 7;

/** `MACHINEGUN_TEAM_DAMAGE` (`g_weapon.c:162`), whose comment reads "wimpier MG in teamplay". */
export const MACHINEGUN_TEAM_DAMAGE = 5;

/** `DEFAULT_SHOTGUN_DAMAGE` (`g_weapon.c:268`): each of the eleven pellets. */
export const SHOTGUN_DAMAGE = 10;

/** `weapon_railgun_fire`'s beam (`g_weapon.c:452`), to each it passes through. */
export const RAILGUN_DAMAGE = 100;

/** `Weapon_LightningFire`'s bolt (`g_weapon.c:617`), every 50 ms it is held on. */
export const LIGHTNING_DAMAGE = 8;

/** How a missile's position advances — `trType_t`, `bg_public.h`. */
export type MissileMotion = 'linear' | 'gravity';

/** A projectile's launch and impact parameters — `g_missile.c` constructors. */
export interface MissileSpec {
  motion: MissileMotion;
  /** Launch speed in units per second. */
  speed: number;
  /** What a direct hit costs whoever it hits, before the splash reaches everyone else. */
  damage: number;
  splashDamage: number;
  splashRadius: number;
  /** The `MOD_*` a direct hit carries, and the one its blast does. */
  mod: number;
  splashMod: number;
  /** Lifetime in milliseconds; for the grenade this is its fuse. */
  lifetime: number;
  /** Grenades bounce at 0.65; everything else detonates on contact. */
  bounce: number;
}

/**
 * Projectile table — `g_missile.c:522-682`.
 *
 * BFG is the vanilla baseq3 form: a fast 2000-ups projectile with 120 splash, not
 * Team Arena's ray weapon.
 *
 * The grappling hook is not in it. It is a missile like the rest, but `fire_grapple` is its
 * own constructor and carries none of these numbers: its speed is the grapple style's, its
 * lifetime is `GRAPPLE_LIFETIME`, and it hurts nothing. Being absent here is also what keeps
 * the weapon in hand from throwing one — the hook is off-hand and has its own key.
 */
export const MISSILES: Partial<Record<WeaponId, MissileSpec>> = {
  [WP.GRENADE_LAUNCHER]: {
    motion: 'gravity',
    speed: 700,
    damage: 100,
    splashDamage: 100,
    splashRadius: 150,
    mod: MOD.GRENADE,
    splashMod: MOD.GRENADE_SPLASH,
    lifetime: 2500,
    bounce: 0.65
  },
  [WP.ROCKET_LAUNCHER]: {
    motion: 'linear',
    speed: 900,
    damage: 100,
    splashDamage: 100,
    splashRadius: 120,
    mod: MOD.ROCKET,
    splashMod: MOD.ROCKET_SPLASH,
    lifetime: 15000,
    bounce: 0
  },
  [WP.PLASMAGUN]: {
    motion: 'linear',
    speed: 2000,
    damage: 20,
    splashDamage: 15,
    splashRadius: 20,
    mod: MOD.PLASMA,
    splashMod: MOD.PLASMA_SPLASH,
    lifetime: 10000,
    bounce: 0
  },
  [WP.BFG]: {
    motion: 'linear',
    speed: 2000,
    damage: 100,
    splashDamage: 100,
    splashRadius: 120,
    mod: MOD.BFG,
    splashMod: MOD.BFG_SPLASH,
    lifetime: 10000,
    bounce: 0
  }
};

/**
 * `MISSILE_PRESTEP_TIME` — `g_missile.c`. Every constructor sets `trTime = level.time - 50`,
 * so a missile is already 50 ms along its path the instant it exists. At 900 ups that puts a
 * rocket 45 units ahead of the muzzle on its first frame, which is what stops it clipping
 * the shooter's own view.
 */
export const MISSILE_PRESTEP_TIME = 50;

/**
 * Gravity applied to `TR_GRAVITY` trajectories — `bg_misc.c:1197`, hardcoded 800.
 *
 * Deliberately **not** the sim's gravity constant: Q3 hardcodes this in the trajectory
 * evaluator and ignores `g_gravity`, so a grenade arcs the same way whatever the world does.
 */
export const MISSILE_GRAVITY = 800;

/** Bounce rest conditions — `G_BounceMissile`, `g_missile.c:33`. */
export const BOUNCE_REST_SPEED = 40;
export const BOUNCE_REST_NORMAL_Z = 0.2;

/** `g_knockback` default — `g_main.c`. */
export const KNOCKBACK_SCALE = 1000;

/** `g_quadfactor`'s default of 3 (`g_main.c:144`): what a shot under quad is multiplied by. */
export const QUAD_FACTOR = 3;

/**
 * The hardcoded mass `G_Damage` divides by (`g_combat.c:802`), giving
 * `kvel = dir * g_knockback * knockback / 200` — a factor of 5 per damage point at defaults,
 * capped at 1000 by {@link KNOCKBACK_DAMAGE_CAP}.
 */
export const KNOCKBACK_MASS = 200;

/** `knockback = min(damage, 200)` — the cap that keeps a rocket jump finite. */
export const KNOCKBACK_DAMAGE_CAP = 200;

/** `pm_time` window set alongside `PMF_TIME_KNOCKBACK` — `clamp(knockback * 2, 50, 200)`. */
export const KNOCKBACK_TIME_SCALE = 2;
export const KNOCKBACK_TIME_MIN = 50;
export const KNOCKBACK_TIME_MAX = 200;

/**
 * Vertical bias added to the splash direction **before** normalizing — `G_RadiusDamage`,
 * `g_combat.c:1159`.
 *
 * Measured from the target's feet, so a rocket landing at your feet still throws you upward
 * rather than sideways. Rocket jumping does not work without it.
 */
export const SPLASH_UP_BIAS = 24;
