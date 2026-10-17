import type { EntityState, Trajectory } from '../net/protocol';
import { traceTempBox } from '../sim/clip-trace';
import { SOLID_BMODEL, solidBox } from '../sim/entity-solid';
import { ET } from '../sim/game-entity';
import { radiusFromBounds } from '../sim/server-world';
import { qvmEvaluateTrajectory } from '../sim/trajectory';
import type { InlineModels, PointContentsFn, TraceFn, TraceResult } from '../sim/types';
import { vec3, type Vec3 } from '../sim/vec3';
import type { ViewSnapshot } from './snapshot-pool';

/**
 * `CG_Trace` and `CG_PointContents` (`cg_predict.c:39–193`): a client's world, the map and
 * everyone it was sent.
 *
 * A client traces for itself — its own move, a lightning bolt every frame, a shotgun's eleven
 * pellets, a gib's fall — and it has the map, but not the server's entities. What it has is the
 * snapshot, where linking packed each entity's box into `s.solid`, or marked it a brush model. So
 * the solid entities of each snapshot are listed, and a trace goes through the map and then
 * through each of them, as the server's does through its own: a box where it is drawn, and a
 * brush model by its own brushes, turned.
 *
 * It is not the server's trace. It passes one entity by number and nothing else: no owner, and no
 * owner's owner. It asks every solid entity rather than the ones near the sweep. It keeps an
 * earlier start inside only while nothing nearer stops it. And it never has the player's own
 * entity, which is not in a snapshot sent to them, so another player's bolt goes through them.
 */

/**
 * An entity a client's trace can hit, and where it is: `centity_t` as `CG_ClipMoveToEntities`
 * and `CG_PointContents` read one.
 */
export interface SolidEntity {
  /** `currentState.number`. */
  number: number;
  /** `currentState.solid`: its box, as linking packed it, or `SOLID_BMODEL`. */
  solid: number;
  /** `currentState.modelindex`: a brush model's inline model. */
  modelindex: number;
  /** `currentState.pos`, where a brush model is traced from. */
  pos: Trajectory;
  /** `lerpOrigin`: where it is drawn, which is where its box is. */
  origin: Vec3;
  /** `lerpAngles`: how it is drawn turned, which turns a brush model's brushes. */
  angles: Vec3;
}

/** What a client's world is made of besides its solid entities. */
export interface ClientWorld {
  /** The map's collision, which names the world as what it hit. */
  trace: TraceFn;
  /** What a point is inside of the map. */
  pointContents: PointContentsFn;
  /** The map's inline models, the brush models' shapes. */
  inlineModels: InlineModels;
  /**
   * `cg.physicsTime`: the time of the snapshot prediction last took its base from, where every
   * trace stands a brush model.
   */
  readonly physicsTime: number;
}

/** A snapshot's entities by number, which is all a list reads of one. */
type Slots = Pick<ViewSnapshot, 'byNumber'>;

/**
 * `CG_BuildSolidList` (`cg_predict.c:46–77`): which entities a trace can hit, and which a
 * predicted move touches instead, by number.
 *
 * The entities are those of the snapshot the list is built from. An item, a jump pad or a
 * teleporter is a trigger, by its `currentState`; anything else is solid by its `nextState`,
 * which is the next snapshot's where it is in one. A slot the current snapshot has not got is
 * judged by the state it is listed with, where Quake 3 reads what the slot held last.
 *
 * @param entities - The entities of the snapshot the list is built from.
 * @param current - `cg.snap`.
 * @param next - `cg.nextSnap`, or null for none.
 * @param triggers - The trigger list's numbers, written over.
 * @param solids - The solid list's numbers, written over.
 */
export function buildSolidList(
  entities: readonly EntityState[],
  current: Slots,
  next: Slots | null,
  triggers: number[],
  solids: number[]
): void {
  triggers.length = 0;
  solids.length = 0;
  for (const state of entities) {
    const { number } = state;
    const type = (current.byNumber.get(number) ?? state).eType;
    if (type === ET.ITEM || type === ET.PUSH_TRIGGER || type === ET.TELEPORT_TRIGGER) {
      triggers.push(number);
    } else if ((next?.byNumber.get(number) ?? state).solid !== 0) {
      solids.push(number);
    }
  }
}

/**
 * `CG_Trace` (`cg_predict.c:145–155`): the map's trace, then every solid entity.
 *
 * @param world - The map, its inline models, and where brush models stand.
 * @param solids - Every entity the trace can hit.
 */
export function clientTrace(world: ClientWorld, solids: readonly SolidEntity[]): TraceFn {
  return (start, mins, maxs, end, skipNumber, mask) => {
    const result = world.trace(start, mins, maxs, end, skipNumber, mask);
    return clipMoveToEntities(world, result, solids, start, mins, maxs, end, skipNumber, mask);
  };
}

/** Where a brush model is traced, written at each trace. */
const brushOrigin = vec3();

/** A brush model's box about its origin, written at each test of its reach. */
const modelMins = vec3();
const modelMaxs = vec3();

/** No box at all: a point's. */
const POINT_BOX = vec3();

const AXES = ['x', 'y', 'z'] as const;

/**
 * Whether a brush model is out of a sweep's reach, so that tracing it could stop the sweep at
 * nothing and find it in nothing: the server's own broad phase, `SV_LinkEntity`'s box against
 * `SV_Trace`'s, each spread by a unit past the clip's epsilon (`sv_world.c:258-279, 620-630`).
 * Turned, the model reaches as far as its furthest corner from its origin (`RadiusFromBounds`),
 * and the swept box as far as its furthest corner from its middle, as the model's frame turns it
 * too (`CM_TransformedBoxTrace`).
 *
 * cgame asks every brush model at every trace; the answers are the same with those out of reach
 * passed over, and online prediction asks thousands a frame.
 *
 * @param origin - Where the model stands.
 * @param angles - How it is turned.
 * @param start - The sweep's start, or the point asked about.
 * @param mins - The swept box's lower corner, about the sweep.
 * @param maxs - Its upper corner.
 * @param end - The sweep's end.
 */
function outOfReach(
  models: InlineModels,
  cmodel: number,
  origin: Vec3,
  angles: Vec3,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3
): boolean {
  models.modelBounds(cmodel, modelMins, modelMaxs);
  const turned = angles.x !== 0 || angles.y !== 0 || angles.z !== 0;
  const modelRadius = turned ? radiusFromBounds(modelMins, modelMaxs) : 0;
  const boxRadius = turned
    ? Math.hypot(maxs.x - mins.x, maxs.y - mins.y, maxs.z - mins.z) / 2
    : 0;
  for (const axis of AXES) {
    let sweepLo = Math.min(start[axis], end[axis]);
    let sweepHi = Math.max(start[axis], end[axis]);
    let modelLo = origin[axis];
    let modelHi = origin[axis];
    if (turned) {
      const middle = (mins[axis] + maxs[axis]) / 2;
      sweepLo += middle - boxRadius;
      sweepHi += middle + boxRadius;
      modelLo -= modelRadius;
      modelHi += modelRadius;
    } else {
      sweepLo += mins[axis];
      sweepHi += maxs[axis];
      modelLo += modelMins[axis];
      modelHi += modelMaxs[axis];
    }
    // Each box spread by a unit, as the server links and sweeps them.
    if (sweepLo - 1 > modelHi + 1 || sweepHi + 1 < modelLo - 1) return true;
  }
  return false;
}

/**
 * `CG_ClipMoveToEntities` (`cg_predict.c:85–138`): try the sweep against each solid entity but the
 * one it passes, and keep what stops it soonest.
 *
 * A box is swept through as cm's temp box, where the entity is drawn, and never turns. A brush
 * model is its inline model, turned as it is drawn, but placed where its trajectory has it at
 * `cg.physicsTime`, as the move predicted against it found it. One {@link outOfReach} is passed
 * over.
 *
 * @param clip - What the map answered.
 */
function clipMoveToEntities(
  world: ClientWorld,
  clip: TraceResult,
  solids: readonly SolidEntity[],
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  skipNumber: number,
  mask: number
): TraceResult {
  let result = clip;
  for (const solid of solids) {
    if (solid.number === skipNumber) continue;

    let trace: TraceResult;
    if (solid.solid === SOLID_BMODEL) {
      const { inlineModels } = world;
      const cmodel = inlineModels.inlineModel(solid.modelindex);
      qvmEvaluateTrajectory(solid.pos, world.physicsTime, brushOrigin);
      const { angles } = solid;
      if (outOfReach(inlineModels, cmodel, brushOrigin, angles, start, mins, maxs, end)) continue;
      trace = inlineModels.transformedBoxTrace(
        cmodel,
        start,
        mins,
        maxs,
        end,
        mask,
        brushOrigin,
        angles
      );
    } else {
      const box = solidBox(solid.solid);
      trace = traceTempBox(start, mins, maxs, end, box.mins, box.maxs, solid.origin, mask);
    }

    if (trace.allsolid || trace.fraction < result.fraction) {
      trace.entityNum = solid.number;
      result = trace;
    } else if (trace.startsolid) {
      result.startsolid = true;
    }
    if (result.allsolid) return result;
  }
  return result;
}

/**
 * `CG_PointContents` (`cg_predict.c:162–193`): the map's contents at a point, OR'd with those of
 * each solid brush model but the one passed, where it is drawn. A box entity holds nothing here.
 *
 * Where it is drawn is ioquake3's: id's read each brush model at its entity state's `origin` and
 * `angles`, which a mover never moves from its spawn.
 *
 * @param world - The map, and its inline models.
 * @param solids - Every entity a trace can hit.
 */
export function clientPointContents(
  world: ClientWorld,
  solids: readonly SolidEntity[]
): PointContentsFn {
  return (point, passEntityNum) => {
    const { inlineModels } = world;
    let contents = world.pointContents(point, passEntityNum);
    for (const solid of solids) {
      if (solid.number === passEntityNum) continue;
      if (solid.solid !== SOLID_BMODEL) continue;
      const cmodel = inlineModels.inlineModel(solid.modelindex);
      if (!cmodel) continue;
      const { origin, angles } = solid;
      if (outOfReach(inlineModels, cmodel, origin, angles, point, POINT_BOX, POINT_BOX, point)) {
        continue;
      }
      contents |= inlineModels.transformedPointContents(point, cmodel, origin, angles);
    }
    return contents;
  };
}
