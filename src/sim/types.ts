import {
  createPlayerState,
  ENTITYNUM_NONE,
  type PlayerState
} from '../net/protocol';
import { ANIM } from './animations';
import {
  CROUCH_HEIGHT,
  CROUCH_VIEWHEIGHT,
  DEAD_HEIGHT,
  DEAD_VIEWHEIGHT,
  DEFAULT_GRAVITY,
  DEFAULT_HEIGHT,
  DEFAULT_SPEED,
  DEFAULT_VIEWHEIGHT,
  MINS_Z,
  PLAYER_WIDTH,
  PM_NORMAL,
  STAT
} from './constants';
import { vec3, type Vec3 } from './vec3';
import { ALL_WEAPONS, AMMO_INFINITE, WEAPON_READY, WP } from './weapons/constants';

/** Result of a swept-AABB query. Mirrors Q3's `trace_t` (q_shared.h:1010). */
export interface TraceResult {
  /** The entire sweep was inside solid; `normal` is meaningless. */
  allsolid: boolean;
  /** The sweep began inside solid. */
  startsolid: boolean;
  /** Portion of the sweep completed, 0..1. A clean move returns 1. */
  fraction: number;
  /** Final position, already backed off so it is never penetrating. */
  endpos: Vec3;
  /** Unit surface normal at the impact, facing the mover. */
  normal: Vec3;
  /** `CONTENTS_*` of what stopped the sweep, or 0 if nothing did. */
  contents: number;
  /**
   * `SURF_*` of the side or patch that stopped the sweep. A splat map's surfaces and an entity's
   * box have none.
   */
  surfaceFlags: number;
  /**
   * What stopped the sweep: `ENTITYNUM_WORLD` for the map, an entity's number for an entity, and
   * `ENTITYNUM_NONE` for nothing.
   */
  entityNum: number;
}

/**
 * A trace that hit nothing, which is what a world with no collision answers.
 *
 * `SV_Trace` against an empty map gives this, and so does a host that has been given no world:
 * the sweep completes, nothing is solid, and the normal points up because there is no surface to
 * take one from.
 *
 * @param end - Where the sweep was going, which is where it got to.
 */
export function clearTrace(end: Vec3): TraceResult {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end.x, end.y, end.z),
    normal: vec3(0, 0, 1),
    contents: 0,
    surfaceFlags: 0,
    entityNum: ENTITYNUM_NONE
  };
}

/**
 * Swept-AABB trace — `trap_Trace`, `pm->trace` and `CG_Trace`, which all take these arguments.
 *
 * The host's is `SV_Trace`: the map, then every entity in the way. `voxel-trace.ts` is the map's
 * own collision and tests use `box-world.ts`. Neither of those has entities, so they ignore the
 * pass entity; they name the world as what they hit, as `SV_Trace` does (`sv_world.c:611`).
 * Implementations must honour this contract:
 * reliable `startsolid`/`allsolid`, unit normals facing the mover, an epsilon backoff so
 * `endpos` never penetrates, and support for zero-length "does the box fit here" queries.
 *
 * One documented latitude: on a sweep that *starts* solid, `voxel-trace.ts` reports
 * `allsolid` from the start and end alone, so a sweep that begins solid, clears mid-way and
 * ends solid may read `allsolid: true`. It is exact for the zero-length queries the callers
 * that depend on the flag actually use (the stand-up headroom check and stuck-recovery probes),
 * and `slideMove` treats any `allsolid` as "trapped", the safe direction.
 *
 * @param start - Sweep start position.
 * @param mins - Box minimum corner, relative to the position.
 * @param maxs - Box maximum corner, relative to the position.
 * @param end - Sweep end position.
 * @param passEntityNum - An entity the sweep goes through, with whatever it owns and whatever its
 *   owner owns. `ENTITYNUM_NONE` for none, or −1 on a client, as `CG_Trace` takes it.
 * @param contentmask - `CONTENTS_*` the sweep stops at; anything else it goes through.
 */
export type TraceFn = (
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  passEntityNum: number,
  contentmask: number
) => TraceResult;

/**
 * What a point is inside — `trap_PointContents`, `pm->pointcontents` and `CG_PointContents`: the
 * `CONTENTS_*` of the world there, OR'd with those of whoever else is there.
 *
 * The host's is `SV_PointContents`: the map, then every entity holding the point, a brush model by
 * its own brushes and anything else as its box, `CONTENTS_BODY` whatever it is made of. A client's
 * is `CG_PointContents`: the map, then the brush models it was sent, and never a box.
 *
 * @param point - Where to look.
 * @param passEntityNum - An entity left out, as the move leaves out its own player.
 */
export type PointContentsFn = (point: Vec3, passEntityNum: number) => number;

/** Point contents with nothing anywhere, which is what a world with no map holds. */
export const NO_CONTENTS: PointContentsFn = () => 0;

/**
 * The map's inline models, `*N` in the entities' `model` keys, as cgame reaches them: through
 * `trap_CM_InlineModel`, a box trace on one (`cg_predict.c:360-370`), and the transformed trace
 * and contents of one where an entity stands (`:125-126, 189`).
 */
export interface InlineModels {
  /**
   * `CM_InlineModel`: the clip handle of inline model `index`, which is 0 for the world.
   *
   * @throws in Q3's words for a model the map has not got
   */
  inlineModel(index: number): number;
  /**
   * `CM_BoxTrace` of a box from a point to itself through a clip handle, unmoved, every content
   * counting: whether the box is in the model there, which is the trace's `startsolid`.
   *
   * @param model - A clip handle, as {@link inlineModel} gives one.
   * @param mins - The box's lower corner, about `origin`.
   * @param maxs - Its upper corner.
   */
  contact(model: number, origin: Vec3, mins: Vec3, maxs: Vec3): boolean;
  /**
   * `CM_TransformedBoxTrace`: a swept box through a clip handle placed at `origin` and turned by
   * `angles`. The result names no entity: which one it was is the caller's to say.
   *
   * @param model - A clip handle, as {@link inlineModel} gives one.
   * @param contentmask - `CONTENTS_*` the sweep stops at.
   */
  transformedBoxTrace(
    model: number,
    start: Vec3,
    mins: Vec3,
    maxs: Vec3,
    end: Vec3,
    contentmask: number,
    origin: Vec3,
    angles: Vec3
  ): TraceResult;
  /**
   * `CM_TransformedPointContents`: the contents of a clip handle's brushes at a point, the model
   * placed at `origin` and turned by `angles`.
   *
   * @param model - A clip handle, as {@link inlineModel} gives one.
   */
  transformedPointContents(point: Vec3, model: number, origin: Vec3, angles: Vec3): number;
  /**
   * `CM_ModelBounds`: a clip handle's box, about its own origin.
   *
   * @param model - A clip handle, as {@link inlineModel} gives one.
   * @param mins - Its lower corner, written in place.
   * @param maxs - Its upper corner, written in place.
   */
  modelBounds(model: number, mins: Vec3, maxs: Vec3): void;
}

/**
 * A map with no inline models, a splat map: any `*N` is one it has not got, and so no handle is
 * one of its models.
 */
export const NO_INLINE_MODELS: InlineModels = {
  inlineModel: () => {
    throw new Error('CM_InlineModel: bad number');
  },
  contact: () => false,
  transformedBoxTrace: (model) => {
    throw new Error(`CM_ClipHandleToModel: bad handle ${model}`);
  },
  transformedPointContents: (_point, model) => {
    throw new Error(`CM_ClipHandleToModel: bad handle ${model}`);
  },
  modelBounds: (model) => {
    throw new Error(`CM_ClipHandleToModel: bad handle ${model}`);
  }
};

/**
 * One frame of player input. Mirrors Q3's `usercmd_t`.
 *
 * The move axes are signed-char ranges because {@link cmdScale} divides by 127 to normalise
 * them; feeding larger values makes the player faster than `speed` allows.
 */
export interface UserCmd {
  /** Absolute time this command applies at, in milliseconds. */
  serverTime: number;
  /** Forward/back input, -127..127. */
  forwardmove: number;
  /** Right/left input, -127..127. */
  rightmove: number;
  /** Up/down input, -127..127. Values >= 10 mean jump; negative means crouch. */
  upmove: number;
  /** View angles in degrees: pitch, yaw, roll. */
  angles: Vec3;
  /** Button bitfield: `BUTTON_ATTACK` (`PM_Weapon`) and `BUTTON_GESTURE` (`PM_Animate`). */
  buttons: number;
  /**
   * Weapon the client wants held. `PM_Weapon` is the only reader: it compares against
   * `ps.weapon` to start a change, and commits it when the drop finishes. Selecting a
   * weapon is therefore a *request*, and the 450 ms switch is authoritative.
   */
  weapon: number;
}

/**
 * A player state as a player stands in one: the port's movement defaults, and health.
 *
 * Quake 3 has no such function, because nothing there ever wants a player state that has not been
 * through `ClientSpawn`. The port does: every movement test starts from a player standing
 * somewhere, and so does the app before the game module has spawned anybody.
 *
 * @param overrides - Fields to override on the standing state.
 */
export function createIdlePlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  const ps = createPlayerState();
  ps.pmType = PM_NORMAL;
  ps.viewheight = DEFAULT_VIEWHEIGHT;
  // Zero is a real entity number, so a zeroed state would be standing on slot 0 (`ENTITYNUM_NONE`).
  ps.groundEntityNum = ENTITYNUM_NONE;
  ps.speed = DEFAULT_SPEED;
  ps.gravity = DEFAULT_GRAVITY;
  ps.weapon = WP.NONE;
  ps.weaponstate = WEAPON_READY;
  ps.stats[STAT.HEALTH] = 100;
  ps.stats[STAT.MAX_HEALTH] = 100;
  // `ClientSpawn`'s defaults (`g_client.c:1198–1199`), so a fresh state is standing idle.
  ps.legsAnim = ANIM.LEGS_IDLE;
  ps.torsoAnim = ANIM.TORSO_STAND;
  return Object.assign(ps, overrides);
}

/**
 * Player state with every weapon owned and infinite ammo, but the gauntlet in hand.
 *
 * A test's full rack, not a spawn's: Quake 3 hands out the gauntlet and the machinegun and leaves
 * the rest to the map's items, so nothing that goes through `ClientSpawn` ends up here.
 *
 * @param overrides - Fields to override on the armed state.
 */
export function createArmedPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  const ps = createIdlePlayerState();
  // `STAT_WEAPONS` bits 1..10, and Q3's own -1 infinite sentinel so no ammo check ever
  // needs special-casing.
  for (const id of ALL_WEAPONS) {
    ps.stats[STAT.WEAPONS] |= 1 << id;
    ps.ammo[id] = AMMO_INFINITE;
  }
  ps.weapon = WP.GAUNTLET;
  return Object.assign(ps, overrides);
}

/**
 * Create a command with no input held.
 *
 * @param overrides - Fields to override on the idle command.
 */
export function createUserCmd(overrides: Partial<UserCmd> = {}): UserCmd {
  return {
    serverTime: 0,
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
    angles: vec3(),
    buttons: 0,
    weapon: WP.NONE,
    ...overrides
  };
}

/**
 * Player bounding box for the given stance. The box never rotates — all collision is
 * swept-AABB.
 *
 * @param ducked - Whether the player is crouched.
 * @param dead - Whether the player is dead, which wins over crouching (`PM_CheckDuck`).
 */
export function playerBounds(ducked: boolean, dead = false): { mins: Vec3; maxs: Vec3 } {
  const top = dead ? DEAD_HEIGHT : ducked ? CROUCH_HEIGHT : DEFAULT_HEIGHT;
  return {
    mins: vec3(-PLAYER_WIDTH, -PLAYER_WIDTH, MINS_Z),
    maxs: vec3(PLAYER_WIDTH, PLAYER_WIDTH, top)
  };
}

/**
 * Eye height above the origin for the given stance.
 *
 * @param ducked - Whether the player is crouched.
 * @param dead - Whether the player is dead, which wins over crouching (`PM_CheckDuck`).
 */
export function viewheightFor(ducked: boolean, dead = false): number {
  if (dead) return DEAD_VIEWHEIGHT;
  return ducked ? CROUCH_VIEWHEIGHT : DEFAULT_VIEWHEIGHT;
}
