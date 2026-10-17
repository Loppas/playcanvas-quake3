import { MAX_WEAPONS } from '../sim/weapons/constants';
import { vec3, type Vec3 } from '../sim/vec3';

/**
 * The types and limits the protocol is written in — Quake 3's `q_shared.h`, for the parts a
 * message carries.
 *
 * `entityState_t` and `playerState_t` are what a snapshot is made of, and every width in
 * {@link ./delta} is a width of a field declared here. They are also what the simulation runs
 * over: the move writes a `playerState_t` and the wire carries that same one, so there is no
 * conversion between a simulated player and a sent one and nothing to lose in it.
 *
 * `entityState_t` is still only ever *sent*. A server holds the last 32 snapshots to delta
 * against, and each must hold what was sent rather than what the game module holds now, which is
 * the larger `gentity_t` (`sim/game-entity.ts`) with the entity state inside it.
 *
 * The field names are the port's camel case; the wire names in the delta tables are Quake 3's, so
 * a trace of a message reads the same as Quake 3's own.
 */

/** `MAX_CLIENTS` (q_shared.h:1082): the absolute limit on client slots. */
export const MAX_CLIENTS = 64;

/** `GENTITYNUM_BITS` (q_shared.h:1085): every entity number on the wire is this wide. */
export const GENTITYNUM_BITS = 10;

/** `MAX_GENTITIES` (q_shared.h:1086): what ten bits of entity number buys. */
export const MAX_GENTITIES = 1 << GENTITYNUM_BITS;

/** `ENTITYNUM_NONE` (q_shared.h:1091): no entity — what `groundEntityNum` holds in the air. */
export const ENTITYNUM_NONE = MAX_GENTITIES - 1;

/** `ENTITYNUM_WORLD` (q_shared.h:1092): the map itself, which is what a player stands on. */
export const ENTITYNUM_WORLD = MAX_GENTITIES - 2;

/** `ENTITYNUM_MAX_NORMAL` (q_shared.h:1093): one past the last number a real entity may take. */
export const ENTITYNUM_MAX_NORMAL = MAX_GENTITIES - 2;

/** `MAX_STATS` (q_shared.h:1119). */
export const MAX_STATS = 16;

/** `MAX_PERSISTANT` (q_shared.h:1120). */
export const MAX_PERSISTANT = 16;

/** `MAX_POWERUPS` (q_shared.h:1121). */
export const MAX_POWERUPS = 16;

/** `MAX_PS_EVENTS` (q_shared.h:1124): a player state carries at most two events per snapshot. */
export const MAX_PS_EVENTS = 2;

export { MAX_WEAPONS };

/**
 * `trType_t` (q_shared.h): how a position is worked out from its base, its delta and the time.
 *
 * Only `STATIONARY` and `INTERPOLATE` matter to a player; the rest belong to movers and missiles,
 * and they are here because the trajectory is one field of the wire whatever fills it.
 */
export const TR = {
  STATIONARY: 0,
  /** Not parametric: the client interpolates between the snapshots it has. */
  INTERPOLATE: 1,
  LINEAR: 2,
  LINEAR_STOP: 3,
  SINE: 4,
  GRAVITY: 5
} as const;

/** `trajectory_t` (q_shared.h): a position or an angle as a function of time. */
export interface Trajectory {
  /** One of {@link TR}. */
  trType: number;
  /** When the trajectory started. */
  trTime: number;
  /** If non-zero, `trTime + trDuration` is when it stops. */
  trDuration: number;
  /** The value at `trTime`. */
  trBase: Vec3;
  /** The rate, which for a position is a velocity. */
  trDelta: Vec3;
}

/** A trajectory at rest at the origin. */
export function createTrajectory(): Trajectory {
  return { trType: TR.STATIONARY, trTime: 0, trDuration: 0, trBase: vec3(), trDelta: vec3() };
}

/**
 * `entityState_t` (q_shared.h): everything the client is told about one entity.
 *
 * Quake 3 asserts that every field is 32 bits wide and that there are exactly as many of them as
 * the delta table has, plus `number` — which the table leaves out because it is written ahead of
 * the delta rather than inside it.
 */
export interface EntityState {
  /** The entity's index, written before the delta rather than in it. */
  number: number;
  /** `entityType_t`: which kind of thing this is, and so how the client draws it. */
  eType: number;
  /** `EF_*` flags. Nineteen bits here, but only sixteen in a player state. */
  eFlags: number;

  /** Where it is. */
  pos: Trajectory;
  /** Which way it faces. */
  apos: Trajectory;

  time: number;
  time2: number;

  origin: Vec3;
  origin2: Vec3;

  angles: Vec3;
  angles2: Vec3;

  /** Whose shot this was, and the like. */
  otherEntityNum: number;
  otherEntityNum2: number;

  /** What it stands on, or {@link ENTITYNUM_NONE} in the air. */
  groundEntityNum: number;

  /** `r + (g << 8) + (b << 16) + (intensity << 24)`. */
  constantLight: number;
  /**
   * The `CS_SOUNDS` slot of a sound the entity loops, added each frame it is in the snapshot. A
   * speaker's plays on where it was last added until the loops are all cleared.
   */
  loopSound: number;

  modelindex: number;
  modelindex2: number;
  /** 0 to `MAX_CLIENTS - 1`, for players and their corpses. */
  clientNum: number;
  frame: number;

  /** The bounds, packed for the client's own prediction. */
  solid: number;

  /** An impulse event — a muzzle flash, a footstep. */
  event: number;
  eventParm: number;

  // --- players ---------------------------------------------------------------------------

  /** Bit flags, one per powerup. */
  powerups: number;
  /** Which weapon, and so which flash model. */
  weapon: number;
  /** An animation row with `ANIM_TOGGLEBIT` on top. */
  legsAnim: number;
  torsoAnim: number;

  generic1: number;
}

/** An entity state with every field zeroed, as `Com_Memset` leaves one. */
export function createEntityState(number = 0): EntityState {
  return {
    number,
    eType: 0,
    eFlags: 0,
    pos: createTrajectory(),
    apos: createTrajectory(),
    time: 0,
    time2: 0,
    origin: vec3(),
    origin2: vec3(),
    angles: vec3(),
    angles2: vec3(),
    otherEntityNum: 0,
    otherEntityNum2: 0,
    groundEntityNum: 0,
    constantLight: 0,
    loopSound: 0,
    modelindex: 0,
    modelindex2: 0,
    clientNum: 0,
    frame: 0,
    solid: 0,
    event: 0,
    eventParm: 0,
    powerups: 0,
    weapon: 0,
    legsAnim: 0,
    torsoAnim: 0,
    generic1: 0
  };
}

/**
 * `playerState_t` (q_shared.h): the whole of one client's own state, which only that client is
 * sent.
 *
 * Quake 3's client runs `pmove` over this to predict; the port's does not, so here it is
 * what the view draws from rather than what the view simulates with.
 */
export interface PlayerState {
  /** `cmd->serverTime` of the last command run. */
  commandTime: number;
  /** `pm_type`. */
  pmType: number;
  /** For the view bob and the footsteps. */
  bobCycle: number;
  /** `pm_flags`: ducked, jump held, and the timed flags. */
  pmFlags: number;
  /** `pm_time`: what is left of the timed flags. */
  pmTime: number;

  origin: Vec3;
  velocity: Vec3;
  weaponTime: number;
  gravity: number;
  speed: number;
  /** `delta_angles`: added to the command's angles to get the view direction. */
  deltaAngles: Vec3;

  /** What the player stands on, or {@link ENTITYNUM_NONE} in the air. */
  groundEntityNum: number;

  legsTimer: number;
  legsAnim: number;
  torsoTimer: number;
  torsoAnim: number;

  /** 0 to 7: which way the player moves relative to the view, for twisting the legs. */
  movementDir: number;

  /** Where the grapple is pulling towards, when `PMF_GRAPPLE_PULL` is set. */
  grapplePoint: Vec3;

  /** Copied to the entity state's, but only sixteen bits of it survive the trip. */
  eFlags: number;

  /** Bumped by every event `pmove` raises; the client notices the change. */
  eventSequence: number;
  /** `MAX_PS_EVENTS` of them, a ring the sequence indexes. */
  events: number[];
  eventParms: number[];

  /** An event put on the player from outside `pmove`. */
  externalEvent: number;
  externalEventParm: number;
  /** Not on the wire, despite sitting between two fields that are. */
  externalEventTime: number;

  clientNum: number;
  weapon: number;
  weaponstate: number;

  viewangles: Vec3;
  viewheight: number;

  // --- damage feedback -------------------------------------------------------------------

  /** When it changes, the client latches the three below it. */
  damageEvent: number;
  damageYaw: number;
  damagePitch: number;
  damageCount: number;

  /** `STAT_*`, sent as shorts when any of them changes. */
  stats: number[];
  /** `PERS_*`, which a death does not clear. Sent as shorts. */
  persistant: number[];
  /** `level.time` each powerup runs out at. Sent as longs, since they are times. */
  powerups: number[];
  /** Rounds per weapon. Sent as shorts. */
  ammo: number[];

  generic1: number;
  loopSound: number;
  /** The jump pad hit this frame. */
  jumppadEnt: number;

  // --- not communicated over the net at all ----------------------------------------------

  /** Server-to-game information for the scoreboard. */
  ping: number;
  pmoveFramecount: number;
  jumppadFrame: number;
  entityEventSequence: number;
}

/** A player state with every field zeroed, as `Com_Memset` leaves one. */
export function createPlayerState(): PlayerState {
  return {
    commandTime: 0,
    pmType: 0,
    bobCycle: 0,
    pmFlags: 0,
    pmTime: 0,
    origin: vec3(),
    velocity: vec3(),
    weaponTime: 0,
    gravity: 0,
    speed: 0,
    deltaAngles: vec3(),
    groundEntityNum: 0,
    legsTimer: 0,
    legsAnim: 0,
    torsoTimer: 0,
    torsoAnim: 0,
    movementDir: 0,
    grapplePoint: vec3(),
    eFlags: 0,
    eventSequence: 0,
    events: new Array<number>(MAX_PS_EVENTS).fill(0),
    eventParms: new Array<number>(MAX_PS_EVENTS).fill(0),
    externalEvent: 0,
    externalEventParm: 0,
    externalEventTime: 0,
    clientNum: 0,
    weapon: 0,
    weaponstate: 0,
    viewangles: vec3(),
    viewheight: 0,
    damageEvent: 0,
    damageYaw: 0,
    damagePitch: 0,
    damageCount: 0,
    stats: new Array<number>(MAX_STATS).fill(0),
    persistant: new Array<number>(MAX_PERSISTANT).fill(0),
    powerups: new Array<number>(MAX_POWERUPS).fill(0),
    ammo: new Array<number>(MAX_WEAPONS).fill(0),
    generic1: 0,
    loopSound: 0,
    jumppadEnt: 0,
    ping: 0,
    pmoveFramecount: 0,
    jumppadFrame: 0,
    entityEventSequence: 0
  };
}

/**
 * `usercmd_t` (q_shared.h): one frame of a client's input, as the wire carries it.
 *
 * This is the same command as the simulation's {@link import('../sim/types').UserCmd} in
 * different units. Quake 3 keeps view angles here as `ANGLE2SHORT` values — sixteenths of a
 * degree, wrapping at a full turn — and `PM_UpdateViewAngles` turns them into degrees with the
 * player's `delta_angles` added. The port's simulation carries degrees directly, so a command
 * crossing the wire is converted at the seam rather than here.
 */
export interface NetUserCmd {
  serverTime: number;
  /** Pitch, yaw and roll as `ANGLE2SHORT` values, 0 to 65535. */
  angles: [number, number, number];
  buttons: number;
  weapon: number;
  /** −127 to 127. A delta that decodes to −128 is corrected to −127 on the way in. */
  forwardmove: number;
  rightmove: number;
  upmove: number;
  /**
   * The port's own, which the server rewinds a shot by. The time the last frame was drawn at,
   * which is what the player was looking at as this input was read: Quake 3's command is stamped
   * with it (`cl.serverTime` before `CL_SetCGameTime`), where the port's is stamped with its
   * step's end. The port's clock runs between whole milliseconds, so it is carried to a step of
   * {@link wireDrawnTime}'s.
   */
  drawnTime: number;
  /** The snapshot that frame drew other players from, by its time. */
  drawnSnapTime: number;
  /** And the one it drew them towards, or the same one again where it had no next. */
  drawnNextSnapTime: number;
}

/** A command with nothing held. */
export function createNetUserCmd(): NetUserCmd {
  return {
    serverTime: 0,
    angles: [0, 0, 0],
    buttons: 0,
    weapon: 0,
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    drawnTime: 0,
    drawnSnapTime: 0,
    drawnNextSnapTime: 0
  };
}

/** How many steps a millisecond of a command's drawn time is carried in. */
export const DRAWN_TIME_STEPS = 256;

/**
 * A drawn time as a command carries it, to the nearest 256th of a millisecond. The view draws
 * others at this time too, so the server rewinds a target to exactly where it was drawn.
 */
export function wireDrawnTime(time: number): number {
  return Math.round(time * DRAWN_TIME_STEPS) / DRAWN_TIME_STEPS;
}
