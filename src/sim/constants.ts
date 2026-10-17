/**
 * ioquake3 movement constants.
 *
 * Every value here is quoted from the ioq3 source with its file.
 *
 * The simulation runs in **native Q3 units, Z-up** and converts only at the render boundary.
 * Do not rescale these — the integer velocity snap is defined in these units,
 * so rescaling changes the feel in ways retuning cannot recover.
 */

// --- bg_pmove.c:34-46 -------------------------------------------------------

/** Friction floor: below this speed, friction is computed against 100 rather than the true speed. */
export const PM_STOPSPEED = 100.0;

/** Crouched wishspeed multiplier: 320 -> 80 ups. */
export const PM_DUCK_SCALE = 0.25;

/**
 * The swim's wishspeed multiplier (`pm_swimScale`): 320 -> 160 ups. The walk blends toward it by
 * the water level, a third of the way at each.
 */
export const PM_SWIMSCALE = 0.5;

/** Ground acceleration. 0 -> 320 ups in roughly 0.1 s. */
export const PM_ACCELERATE = 10.0;

/** Air acceleration. Small enough that air steering only works through the dot-product loophole. */
export const PM_AIRACCELERATE = 1.0;

/** The water move's acceleration (`pm_wateraccelerate`). */
export const PM_WATERACCELERATE = 4.0;

/** The fly move's acceleration, between the ground's and the air's (`pm_flyaccelerate`). */
export const PM_FLYACCELERATE = 8.0;

/** Ground friction coefficient. */
export const PM_FRICTION = 6.0;

/**
 * Water friction coefficient (`pm_waterfriction`), times the water level: a player waist deep is
 * slowed twice as hard as one wading.
 */
export const PM_WATERFRICTION = 1.0;

/**
 * Flight friction coefficient (`pm_flightfriction`). Applies *in addition* to whatever else does:
 * on the ground a flying player is slowed by 9, in the air by 3.
 */
export const PM_FLIGHTFRICTION = 3.0;

/**
 * Spectator friction coefficient (`pm_spectatorfriction`, `bg_pmove.c:46`). A term of its own
 * beside flight's, added by `PM_Friction` on the pmType alone (`:215–217`), so a spectator flying
 * free is slowed by 5 where the flight powerup slows by 3.
 */
export const PM_SPECTATORFRICTION = 5.0;

// --- bg_local.h -------------------------------------------------------------

/** Vertical speed applied on jump. Assigned, never added (bg_local.h:29). */
export const JUMP_VELOCITY = 270;

/** Minimum ground-normal Z to count as walkable — about a 45.6 degree slope (bg_local.h:25). */
export const MIN_WALK_NORMAL = 0.7;

/** Maximum step-up height (bg_local.h:27). */
export const STEPSIZE = 18;

/**
 * Clip overbounce factor (bg_local.h:34). Pushes the clipped velocity ~0.1% away from the
 * plane so the mover cannot re-collide with the plane it just slid along.
 */
export const OVERCLIP = 1.001;

/** Slide plane buffer size (bg_slidemove.c:44). */
export const MAX_CLIP_PLANES = 5;

/** `PS_PMOVEFRAMECOUNTBITS` (q_shared.h): the player state's move counter is six bits. */
export const PS_PMOVEFRAMECOUNTBITS = 6;

// --- g_main.c ---------------------------------------------------------------

/** Base maximum ground speed in units per second (g_speed, g_main.c:141). */
export const DEFAULT_SPEED = 320;

/** Downward acceleration in units per second squared (g_gravity, g_main.c:142). */
export const DEFAULT_GRAVITY = 800;

// --- bg_public.h:49-57 ------------------------------------------------------

/** Player box half-width on X and Y. */
export const PLAYER_WIDTH = 15;

/** Player box bottom, relative to the origin. The origin sits 24 units above the feet. */
export const MINS_Z = -24;

/** Player box top when standing. */
export const DEFAULT_HEIGHT = 32;

/** Eye height above the origin when standing. */
export const DEFAULT_VIEWHEIGHT = 26;

/** Player box top when crouched. */
export const CROUCH_HEIGHT = 16;

/** Eye height above the origin when crouched. */
export const CROUCH_VIEWHEIGHT = 12;

/** Player box top when dead: the body lies at the floor, 16 units high (`PM_CheckDuck`). */
export const DEAD_HEIGHT = -8;

/** Eye height above the origin when dead, 8 units below the box's own top. */
export const DEAD_VIEWHEIGHT = -16;

// --- timing -----------------------------------------------------------------

/**
 * Fixed simulation tick in milliseconds — the `pmove_msec` default, and the reason "125 fps
 * physics" is the reference feel.
 */
export const PMOVE_MSEC = 8;

/** The range `pmove_msec` is held to wherever it is read (`g_active.c:790–797`). */
export const PMOVE_MSEC_MIN = 8;
export const PMOVE_MSEC_MAX = 33;

/** Depth of the ground probe below the origin (bg_pmove.c:1112). */
export const GROUND_TRACE_DEPTH = 0.25;

/**
 * Distance a trace stops short of the surface it hits, so `endpos` is never penetrating.
 * Part of the trace contract every collider must honour: without it, OVERCLIP alone will not
 * keep the mover out of geometry.
 */
export const SURFACE_CLIP_EPSILON = 0.125;

/** Milliseconds of post-landing velocity lock applied after a hard landing (bg_pmove.c:923). */
export const TIME_LAND_MSEC = 250;

/** Downward speed past which a landing counts as hard enough to set the land timer. */
export const CRASH_LAND_SPEED = -200;

// --- PM_CrashLand, bg_pmove.c:923 -------------------------------------------

/**
 * Impact speed is converted to a landing severity by `delta = v * v * 0.0001`, which is the
 * same figure Q3 charges as falling damage. Only the severity bands matter here.
 */
export const FALL_DELTA_SCALE = 0.0001;

/**
 * Severity below which a landing raises nothing and leaves the walk cycle running
 * (`PM_CrashLand`, bg_pmove.c:975–977).
 */
export const FALL_DELTA_MIN = 1;

/** Severity above which a landing is a short fall rather than a footstep (bg_pmove.c:991). */
export const FALL_DELTA_SHORT = 7;

/** Severity above which a landing hurts. */
export const FALL_DELTA_MEDIUM = 40;

/** Severity above which a landing hurts a lot. */
export const FALL_DELTA_FAR = 60;

/** Landing ducked counts double — the same rule that doubles crouched fall damage. */
export const DUCKED_FALL_MULTIPLIER = 2;

// --- PM_Footsteps, bg_pmove.c:1321 ------------------------------------------

// --- the water, bg_pmove.c:399-534 ------------------------------------------

/** How fast a swimmer with no keys held wishes to sink (`PM_WaterMove`, bg_pmove.c:505). */
export const SWIM_SINK_SPEED = 60;

/**
 * The water jump's probes (`PM_CheckWaterJump`, bg_pmove.c:418–428): a point this far ahead of the
 * origin, level with the view's heading, must be solid {@link WATERJUMP_LEDGE_Z} up, and clear of
 * anything solid to a player {@link WATERJUMP_CLEAR_Z} above that.
 */
export const WATERJUMP_REACH = 30;
export const WATERJUMP_LEDGE_Z = 4;
export const WATERJUMP_CLEAR_Z = 16;

/** The water jump's push: forward along the view, and up (bg_pmove.c:432–433). */
export const WATERJUMP_FORWARD_SPEED = 200;
export const WATERJUMP_UP_SPEED = 350;

/** How long the water jump holds the player's control, at most (bg_pmove.c:436). */
export const WATERJUMP_MSEC = 2000;

/** Bob cycle advance per millisecond while running. */
export const BOB_MOVE_RUN = 0.4;

/** Bob cycle advance per millisecond while crouched — a shorter, faster stride. */
export const BOB_MOVE_DUCKED = 0.5;

/** The bob cycle is a byte counter; the top bit selects which foot is forward. */
export const BOB_CYCLE_MASK = 255;

/** Speed below which a player with no input is treated as stopped, resetting the cycle. */
export const BOB_IDLE_SPEED = 5;

// --- PM_StepSlideMove, bg_slidemove.c:244 -----------------------------------

/** Vertical gain below which a step move is not worth telling the view about (Q3's `delta > 2`). */
export const STEP_EVENT_MIN_DELTA = 2;

/**
 * View pitch limit in degrees. Q3 stores angles as 16-bit shorts and clamps to +/-16000 of
 * them, which is 16000 * 360 / 65536 — just shy of vertical, so the view basis never
 * degenerates (PM_UpdateViewAngles, bg_pmove.c:1811-1819).
 */
export const PITCH_LIMIT_DEGREES = 87.890625;

/** {@link PITCH_LIMIT_DEGREES} as the sixteen-bit number a user command carries an angle in. */
export const PITCH_LIMIT_SHORT = 16000;

// --- pm_flags ---------------------------------------------------------------

/**
 * Player-movement flags.
 *
 * Only the flags this port actually uses are defined. The numeric values are local: Q3's are
 * part of its network layout, which is irrelevant here, so they are not reproduced.
 */
export const PMF_DUCKED = 1;

/** Set while the jump key is held; must be released before another jump. */
export const PMF_JUMP_HELD = 2;

/** Set for {@link TIME_LAND_MSEC} after a hard landing; freezes velocity through collisions. */
export const PMF_TIME_LAND = 4;

/**
 * Set by splash knockback. While `pmTime` runs, `PM_Friction` skips **ground friction**
 * entirely (`bg_pmove.c`), which is what lets a rocket jump carry you across a floor
 * instead of being scrubbed off the moment you land on it.
 */
export const PMF_TIME_KNOCKBACK = 8;

/** Set while a grapple is attached; dispatches `PM_GrappleMove` ahead of the normal move. */
export const PMF_GRAPPLE_PULL = 16;

/** Set by a jump taken backwards, so its landing plays `LEGS_LANDB` (`PM_CheckJump`). */
export const PMF_BACKWARDS_JUMP = 32;

/** Set while moving backwards, so the legs play the backpedal rows (`PmoveSingle`). */
export const PMF_BACKWARDS_RUN = 64;

/**
 * Set at spawn and cleared once attack is released (`ClientSpawn`, `PmoveSingle`). Until then
 * the weapon cannot fire and the player cannot jump, so the click that respawns a dead player
 * does not also fire the gun.
 */
export const PMF_RESPAWNED = 128;

/**
 * Set while the holdable key is down, so one press uses one item (`PM_Weapon`, `bg_pmove.c:1558`).
 * It clears when the key comes back up, and it is what lets the frames after the press fall
 * through to the weapon's own code.
 */
export const PMF_USE_ITEM_HELD = 256;

/** CPMA's: set while a crouch slide runs. It ends with {@link STAT.SLIDE_TIME}, or sooner. */
export const PMF_CROUCH_SLIDE = 512;

/**
 * Set by a water jump for {@link WATERJUMP_MSEC}, and cleared once the player falls or lands. While
 * it runs the move is the water jump's, with no control (`PM_WaterJumpMove`).
 */
export const PMF_TIME_WATERJUMP = 1024;

/** Set while this spectator is riding another client's view rather than flying its own. */
export const PMF_FOLLOW = 4096;

/** Set while this spectator is watching the scoreboard rather than the match. */
export const PMF_SCOREBOARD = 8192;

/** Mask of every flag whose lifetime is governed by `pmTime`. */
export const PMF_ALL_TIMES = PMF_TIME_LAND | PMF_TIME_KNOCKBACK | PMF_TIME_WATERJUMP;

// --- usercmd buttons --------------------------------------------------------

/** `BUTTON_ATTACK` (`q_shared.h`) — the only button bit the weapon layer reads. */
export const BUTTON_ATTACK = 1;

/** `BUTTON_TALK` (`q_shared.h:1216`): "displays talk balloon and disables actions". */
export const BUTTON_TALK = 2;

/**
 * `BUTTON_USE_HOLDABLE` (`q_shared.h`) — the holdable item key, which at the intermission is
 * the other way of saying ready.
 */
export const BUTTON_USE_HOLDABLE = 4;

/** `BUTTON_GESTURE` (`q_shared.h:1218`) — plays `TORSO_GESTURE` (`PM_Animate`). */
export const BUTTON_GESTURE = 8;

/**
 * `BUTTON_AFFIRMATIVE` (`q_shared.h:1224`) — bit 5, which is what `+button5` sets
 * (`CL_CmdButtons`, `cl_input.c:533–538`), and the key CorkScrew throws the off-hand hook with.
 */
export const BUTTON_AFFIRMATIVE = 32;

// --- pm_type ------------------------------------------------------------------

/**
 * `pmtype_t` (`bg_public.h:130–138`), reduced to the states this port reaches. Q3's own
 * numbers are kept because it tests `pm_type >= PM_DEAD` to mean "dead or frozen".
 */
export const PM_NORMAL = 0;

/** Flying free, and drawn to nobody. */
export const PM_SPECTATOR = 2;

/** No input, no turning, but still falling: a corpse (`PM_DeadMove`). */
export const PM_DEAD = 3;

/** Stuck in place with no control: a spectator riding another client's view, or the scoreboard. */
export const PM_FREEZE = 4;

/** Held at the intermission camera, and drawn to nobody. */
export const PM_INTERMISSION = 5;

// --- dmflags (bg_public.h:657–659) ---------------------------------------------

/** `DF_NO_FALLING` — a landing hurts nobody. */
export const DF_NO_FALLING = 8;

/** `DF_NO_FOOTSTEPS` — a run makes no footsteps. */
export const DF_NO_FOOTSTEPS = 32;

// --- entity flags -------------------------------------------------------------

/**
 * `EF_FIRING` (`bg_public.h`) — attack is held, with ammo. `PmoveSingle` sets it at the start
 * of every move, and the client draws everything continuous from it: the lightning bolt, the
 * continuous muzzle flash, the spinning barrel and the firing loop.
 */
export const EF_FIRING = 0x00000100;

/** `EF_TALK` — this player is typing, and a balloon is drawn over them. */
export const EF_TALK = 0x00001000;

/** `EF_CONNECTION` — no command from this player for over a second, and a sprite says so. */
export const EF_CONNECTION = 0x00002000;

/** `EF_DEAD` — this player is down, which is what stops a foe marker being drawn over them. */
export const EF_DEAD = 0x00000001;

/**
 * `EF_PLAYER_EVENT` (`bg_public.h:253`) — this event-only entity is a player's own event, sent on
 * its own because the player's entity already carried one: the client hears it from
 * `s.otherEntityNum`, the player, rather than from the entity's own slot. The missiles' `EF_BOUNCE`
 * is the same bit, on another kind of entity.
 */
export const EF_PLAYER_EVENT = 0x00000010;

/**
 * `EF_BOUNCE_HALF` (`bg_public.h:255`) — a missile bounces off what it hits rather than going
 * off on it, keeping 65% of its speed each time. The grenade is the only thing in baseq3 with it.
 */
export const EF_BOUNCE_HALF = 0x00000020;

/** `EF_TELEPORT_BIT` — flipped whenever the origin jumps, so the client stops interpolating. */
export const EF_TELEPORT_BIT = 0x00000004;

/**
 * `EF_NODRAW` (`bg_public.h:257`) — the entity has no model to draw: an item that has been taken
 * and is waiting to come back, or one that a map's `targetname` keeps off the map until it is
 * fired.
 */
export const EF_NODRAW = 0x00000080;

/** `EF_VOTED` — this client has already voted, and a respawn must not lose that. */
export const EF_VOTED = 0x00004000;

/**
 * The award sprites (`bg_public.h:252–267`): which medal floats over a player who has just earned
 * one, for {@link REWARD_SPRITE_TIME}. At most one is set at a time.
 */
export const EF_AWARD_EXCELLENT = 0x00000008;
export const EF_AWARD_GAUNTLET = 0x00000040;
export const EF_AWARD_CAP = 0x00000800;
export const EF_AWARD_IMPRESSIVE = 0x00008000;
export const EF_AWARD_DEFEND = 0x00010000;
export const EF_AWARD_ASSIST = 0x00020000;

/** All six, which an award clears before it sets its own. */
export const EF_AWARDS =
  EF_AWARD_IMPRESSIVE |
  EF_AWARD_EXCELLENT |
  EF_AWARD_GAUNTLET |
  EF_AWARD_ASSIST |
  EF_AWARD_DEFEND |
  EF_AWARD_CAP;

/** `REWARD_SPRITE_TIME` (`g_local.h:40`): how long an award's sprite stays over the head. */
export const REWARD_SPRITE_TIME = 2000;

/**
 * The bits of `PERS_PLAYEREVENTS` (`bg_public.h:332–335`), each flipped rather than set, so that a
 * client hears one whenever its bit is not what it was.
 */
export const PLAYEREVENT = {
  /** Somebody facing a powerup watched it be taken. */
  DENIEDREWARD: 0x0001,
  /** Killed by a gauntlet. */
  GAUNTLETREWARD: 0x0002,
  /** Killed carrying a flag within 200 units of home. */
  HOLYSHIT: 0x0004
} as const;

/** `EF_TEAMVOTED` — as {@link EF_VOTED}, for a team vote. */
export const EF_TEAMVOTED = 0x00080000;

// --- gametypes ----------------------------------------------------------------

/**
 * `gametype_t` (`bg_public.h:24–36`). The numbers are on the wire in `g_gametype`'s systeminfo,
 * so they are Quake 3's whatever the port ends up supporting.
 *
 * Everything from {@link GT.TEAM} up is a team game, which is what `g_gametype >= GT_TEAM`
 * means wherever it is tested.
 *
 * {@link GT.CA} is CPMA's Clan Arena, numbered after Quake 3's own because CPMA's numbers are not
 * Quake 3's. That puts it inside every `>= GT_CTF` test, which in Quake 3 means the modes with
 * bases, so each of those takes it out.
 */
export const GT = {
  FFA: 0,
  TOURNAMENT: 1,
  SINGLE_PLAYER: 2,
  TEAM: 3,
  CTF: 4,
  ONEFCTF: 5,
  OBELISK: 6,
  HARVESTER: 7,
  CA: 8,
  MAX_GAME_TYPE: 9
} as const;

// --- teams --------------------------------------------------------------------

/** `team_t` (`bg_public.h:549–556`). */
export const TEAM = {
  FREE: 0,
  RED: 1,
  BLUE: 2,
  SPECTATOR: 3,
  NUM_TEAMS: 4
} as const;

// --- player state arrays ------------------------------------------------------

/**
 * `statIndex_t` (`bg_public.h:208–219`): indexes into `ps.stats[]`, which a respawn clears.
 *
 * Everything that reads a stat reads it through one of these. The port kept four of them as named
 * fields while the simulation ran over a player state of its own; there is one player state now,
 * so there is one way to reach a stat.
 */
export const STAT = {
  HEALTH: 0,
  HOLDABLE_ITEM: 1,
  /** A bitfield: bit `n` set means weapon `n` is owned. */
  WEAPONS: 2,
  ARMOR: 3,
  /** The direction a dead player's camera looks along. */
  DEAD_YAW: 4,
  /** A bitmask of the clients wishing to leave the intermission. */
  CLIENTS_READY: 5,
  /** Health and armor's limit, which the handicap lowers. */
  MAX_HEALTH: 6,
  /**
   * CPMA's: the time left, in ms, in which a jump chains off the last one. Not held at zero, so
   * it runs below it.
   */
  JUMP_TIME: 7,
  /** CPMA's: set by a chained jump, and cleared once {@link STAT.JUMP_TIME} has run out. */
  CHAIN_JUMPED: 8,
  /**
   * CPMA's: the time left, in ms, of a crouch slide. The slide's last move takes it below zero, and
   * the next clears it.
   */
  SLIDE_TIME: 9,
  /** CPMA's: the time left, in ms, before the railgun fires again, whichever weapon is in hand. */
  RAIL_TIME: 10,
  /** CPMA's: the time left, in ms, of the switch lock, which holds a weapon change's finish. */
  WEAPON_LOCK: 11,
  /**
   * CPMA's: set once a weapon better than the machinegun has been raised since the spawn. Until
   * then a change up to one from the gauntlet or the machinegun takes no lock.
   */
  UPGRADE_RAISED: 12,
  /** CPMA's: the armour's tier, one of `ARMOR_TIER`, which decides what it protects. */
  ARMOR_TIER: 13
} as const;

/** Share of each hit armor soaks up instead of health, rounded up (`bg_public.h:32`). */
export const ARMOR_PROTECTION = 0.66;

/**
 * `persEnum_t` (`bg_public.h:224–242`): indexes into `ps.persistant[]`, the only part of a player
 * state a respawn does **not** clear.
 */
export const PERS = {
  SCORE: 0,
  /** Total damage dealt, so the hit beep can sound when it changes. */
  HITS: 1,
  RANK: 2,
  TEAM: 3,
  /** Bumped by every spawn, which is how a client notices it has respawned. */
  SPAWN_COUNT: 4,
  PLAYEREVENTS: 5,
  ATTACKER: 6,
  ATTACKEE_ARMOR: 7,
  KILLED: 8,
  IMPRESSIVE_COUNT: 9,
  EXCELLENT_COUNT: 10,
  DEFEND_COUNT: 11,
  ASSIST_COUNT: 12,
  GAUNTLET_FRAG_COUNT: 13,
  CAPTURES: 14
} as const;

/**
 * `meansOfDeath_t` (`bg_public.h:577–609`): what did the damage, which the obituary carries.
 *
 * Retail baseq3 was built without `MISSIONPACK`, so Team Arena's five sit out and the grapple
 * comes straight after the trigger's hurt, at 23.
 */
export const MOD = {
  UNKNOWN: 0,
  SHOTGUN: 1,
  GAUNTLET: 2,
  MACHINEGUN: 3,
  GRENADE: 4,
  GRENADE_SPLASH: 5,
  ROCKET: 6,
  ROCKET_SPLASH: 7,
  PLASMA: 8,
  PLASMA_SPLASH: 9,
  RAILGUN: 10,
  LIGHTNING: 11,
  BFG: 12,
  BFG_SPLASH: 13,
  WATER: 14,
  SLIME: 15,
  LAVA: 16,
  CRUSH: 17,
  TELEFRAG: 18,
  FALLING: 19,
  SUICIDE: 20,
  TARGET_LASER: 21,
  TRIGGER_HURT: 22,
  GRAPPLE: 23
} as const;

/** `RANK_TIED_FLAG` (`bg_public.h`): set on `PERS_RANK` when the rank is shared. */
export const RANK_TIED_FLAG = 0x4000;

/** `SCORE_NOT_PRESENT` (`bg_public.h`): the scoreboard's "nobody is in this place". */
export const SCORE_NOT_PRESENT = -9999;

// --- contents -----------------------------------------------------------------

/**
 * `FL_*` (`g_local.h:46–53`): flags on an entity, reduced to what a life, a spawn spot and a
 * dropped item read.
 *
 * Quake 3 keeps god and "this one is not to be pushed about" here rather than on the client,
 * because they are true of anything that can be hurt, and the world's own entities can be.
 */
export const FL = {
  /** `FL_GODMODE`: no damage is taken, though the knockback still lands. */
  GODMODE: 0x10,
  /** `FL_TEAMMEMBER` (`g_local.h:48`): not the first entity of its `team`. */
  TEAMMEMBER: 0x400,
  /** `FL_NO_KNOCKBACK`: set by the killing hit, so a corpse is not pushed about. */
  NO_KNOCKBACK: 0x800,
  /**
   * `FL_DROPPED_ITEM` (`g_local.h:50`): a weapon somebody dropped rather than one the map placed.
   * A pickup of one carries full ammo, and it does not respawn.
   */
  DROPPED_ITEM: 0x1000,
  /** `FL_NO_BOTS` (`g_local.h:51`): a spawn spot no bot may use. */
  NO_BOTS: 0x2000,
  /** `FL_NO_HUMANS` (`g_local.h:52`): a spawn spot for bots alone. */
  NO_HUMANS: 0x4000,
  /**
   * `FL_FORCE_GESTURE` (`g_local.h:53`): taunt on the next command, whatever the player pressed.
   *
   * Set on a whole side by `Team_ForceGesture` when it captures, and turned into a
   * {@link BUTTON_GESTURE} by `ClientThink_real` (`g_active.c:873–876`).
   */
  FORCE_GESTURE: 0x8000
} as const;

/**
 * `CONTENTS_*` (`surfaceflags.h:30–60`): what a brush is made of, from its shader, and what the
 * game module puts on an entity. A brush can be several at once.
 *
 * A splat map's collision is `CONTENTS_SOLID` throughout: it has no water, no clip brushes and no
 * sky.
 */
export const CONTENTS = {
  /** "An eye is never valid in a solid." */
  SOLID: 1,
  LAVA: 8,
  SLIME: 16,
  WATER: 32,
  FOG: 64,
  NOTTEAM1: 0x80,
  NOTTEAM2: 0x100,
  NOBOTCLIP: 0x200,
  AREAPORTAL: 0x8000,
  PLAYERCLIP: 0x10000,
  MONSTERCLIP: 0x20000,
  /** The bots' own, from here to `MOVER`. */
  TELEPORTER: 0x40000,
  JUMPPAD: 0x80000,
  CLUSTERPORTAL: 0x100000,
  DONOTENTER: 0x200000,
  /** Where only a bot may not go. A splat map has none, but a bot's move still asks for it. */
  BOTCLIP: 0x400000,
  MOVER: 0x800000,
  /** "Removed before bsping an entity." */
  ORIGIN: 0x1000000,
  /** A live player. Never on a brush — the game puts it on a client. */
  BODY: 0x2000000,
  CORPSE: 0x4000000,
  /** "Brushes not used for the bsp." */
  DETAIL: 0x8000000,
  /** "Brushes used for the bsp." */
  STRUCTURAL: 0x10000000,
  /** "Don't consume surface fragments inside." */
  TRANSLUCENT: 0x20000000,
  /**
   * `CONTENTS_TRIGGER` (`surfaceflags.h:59`): something walked into, not bumped into. An item is
   * made of it, which is what lets a player pass through the space it stands in.
   */
  TRIGGER: 0x40000000,
  /**
   * "Don't leave bodies or items (death fog, lava)." C's `int` holds it as its sign bit, so it is
   * negative here too, as the BSP's contents and every `|` and `&` of them are.
   */
  NODROP: 0x80000000 | 0
} as const;

/** `SURF_*` (`surfaceflags.h:62–80`): what a side's or a patch's shader says of its surface. */
export const SURF = {
  /** "Never give falling damage." */
  NODAMAGE: 0x1,
  /** "Effects game physics." */
  SLICK: 0x2,
  /** "Lighting from environment map." */
  SKY: 0x4,
  LADDER: 0x8,
  /** "Don't make missile explosions." */
  NOIMPACT: 0x10,
  /** "Don't leave missile marks." */
  NOMARKS: 0x20,
  /** "Make flesh sounds and effects." */
  FLESH: 0x40,
  /** "Don't generate a drawsurface at all." */
  NODRAW: 0x80,
  /** "Make a primary bsp splitter." */
  HINT: 0x100,
  /** "Completely ignore, allowing non-closed brushes." */
  SKIP: 0x200,
  /** "Surface doesn't need a lightmap." */
  NOLIGHTMAP: 0x400,
  /** "Generate lighting info at vertexes." */
  POINTLIGHT: 0x800,
  /** "Clanking footsteps." */
  METALSTEPS: 0x1000,
  /** "No footstep sounds." */
  NOSTEPS: 0x2000,
  /** "Don't collide against curves with this set." */
  NONSOLID: 0x4000,
  /** "Act as a light filter during q3map -light." */
  LIGHTFILTER: 0x8000,
  /** "Do per-pixel light shadow casting in q3map." */
  ALPHASHADOW: 0x10000,
  /** "Don't dlight even if solid (solid lava, skies)." */
  NODLIGHT: 0x20000,
  /** "Leave a dust trail when walking on this surface." */
  DUST: 0x40000
} as const;

/**
 * `MASK_*` (`bg_public.h:667–673`): the contents a trace stops at. A dead player's move is
 * `MASK_PLAYERSOLID & ~CONTENTS_BODY`, which is how Quake 3 writes it rather than as the
 * `MASK_DEADSOLID` it equals.
 */
export const MASK = {
  /** Everything. */
  ALL: -1,
  SOLID: CONTENTS.SOLID,
  /** A living player's move: the world, and every other living player. */
  PLAYERSOLID: CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.BODY,
  DEADSOLID: CONTENTS.SOLID | CONTENTS.PLAYERCLIP,
  WATER: CONTENTS.WATER | CONTENTS.LAVA | CONTENTS.SLIME,
  OPAQUE: CONTENTS.SOLID | CONTENTS.SLIME | CONTENTS.LAVA,
  /** A shot: the world, and every player, living or dead. */
  SHOT: CONTENTS.SOLID | CONTENTS.BODY | CONTENTS.CORPSE
} as const;
