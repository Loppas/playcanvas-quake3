import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { CONTENTS, SURFACE_CLIP_EPSILON } from './constants';
import type { PointContentsFn, TraceFn, TraceResult } from './types';
import type { VoxelGrid } from './voxel-grid';
import { copy, madd, vec3, type Vec3 } from './vec3';

/**
 * Swept-AABB trace against a voxel grid.
 *
 * The supersplat voxel collider this project builds on exposes a *discrete* API — sphere and
 * capsule push-out, single rays — which is not what an ioq3 `pmove` port can be driven by.
 * This supplies the continuous trace pmove actually needs, over the same voxel
 * data: no tunnelling, exact contact fractions, and exact surface normals.
 *
 * The sweep is an event-driven DDA over the box's *footprint* rather than a single ray. The
 * box already knows which voxels it overlaps; as it moves, the only voxels that can newly
 * touch it are the slabs its leading faces sweep into. So the algorithm advances to the next
 * moment a leading face crosses a voxel boundary, tests just the slab entering there, and
 * repeats. Cost scales with distance travelled in voxels, not with world size.
 *
 * Voxel faces are axis-aligned, so the normal is exact — no estimation from sampled patches.
 */

const AXES = ['x', 'y', 'z'] as const;

type Axis = (typeof AXES)[number];

/** Below this, a sweep is treated as a stationary "does the box fit here" query. */
const ZERO_LENGTH = 1e-9;

/**
 * Nudge used to keep voxel spans half-open, so a box face resting exactly on a voxel
 * boundary does not claim the voxel beyond it — which would make every flat surface report
 * a collision with the wall of air above it.
 */
const HALF_OPEN_EPSILON = 1e-9;

/**
 * Iteration cap. A pmove tick sweeps at most a few voxels and the longest trace in the
 * simulation is the 18-unit step probe, so this is orders of magnitude above any real trace;
 * it exists only to bound a pathological call.
 */
const MAX_EVENTS = 4096;

/**
 * The point contents of a voxel grid: `CONTENTS_SOLID` in a solid voxel, and nothing elsewhere,
 * since a splat map has no water, no clip and no sky. A point on a voxel's lower face is in it.
 *
 * @param grid - Voxel occupancy to look in.
 */
export function createVoxelPointContents(grid: VoxelGrid): PointContentsFn {
  const vs = grid.voxelSize;
  return (point) =>
    grid.isSolid(Math.floor(point.x / vs), Math.floor(point.y / vs), Math.floor(point.z / vs))
      ? CONTENTS.SOLID
      : 0;
}

/**
 * Build a {@link TraceFn} over a voxel grid.
 *
 * @param grid - Voxel occupancy to trace against.
 */
export function createVoxelTrace(grid: VoxelGrid): TraceFn {
  const vs = grid.voxelSize;

  /**
   * Voxel index range the box covers on one axis at a point along the sweep.
   *
   * @param start - Sweep start.
   * @param delta - Full sweep extent.
   * @param mins - Box minimum corner.
   * @param maxs - Box maximum corner.
   * @param t - Position along the sweep, 0..1.
   * @param axis - Axis to measure.
   */
  const spanAt = (
    start: Vec3,
    delta: Vec3,
    mins: Vec3,
    maxs: Vec3,
    t: number,
    axis: Axis
  ): { lo: number; hi: number } => {
    const base = start[axis] + delta[axis] * t;
    return {
      lo: Math.floor((base + mins[axis]) / vs),
      hi: Math.floor((base + maxs[axis] - HALF_OPEN_EPSILON) / vs)
    };
  };

  /**
   * Whether any voxel in an index range is solid.
   *
   * @param lo - Inclusive lower index on each axis.
   * @param hi - Inclusive upper index on each axis.
   */
  const anySolid = (lo: Vec3, hi: Vec3): boolean => {
    for (let vz = lo.z; vz <= hi.z; vz++) {
      for (let vy = lo.y; vy <= hi.y; vy++) {
        for (let vx = lo.x; vx <= hi.x; vx++) {
          if (grid.isSolid(vx, vy, vz)) {
            return true;
          }
        }
      }
    }
    return false;
  };

  /**
   * Whether the box overlaps anything solid at a point along the sweep.
   *
   * @param start - Sweep start.
   * @param delta - Full sweep extent.
   * @param mins - Box minimum corner.
   * @param maxs - Box maximum corner.
   * @param t - Position along the sweep, 0..1.
   */
  const solidAt = (start: Vec3, delta: Vec3, mins: Vec3, maxs: Vec3, t: number): boolean => {
    const x = spanAt(start, delta, mins, maxs, t, 'x');
    const y = spanAt(start, delta, mins, maxs, t, 'y');
    const z = spanAt(start, delta, mins, maxs, t, 'z');
    return anySolid(vec3(x.lo, y.lo, z.lo), vec3(x.hi, y.hi, z.hi));
  };

  return (start, mins, maxs, end, _passEntityNum, contentmask) => {
    const delta = vec3(end.x - start.x, end.y - start.y, end.z - start.z);
    const distance = Math.hypot(delta.x, delta.y, delta.z);

    // Every voxel is `CONTENTS_SOLID`, so a mask without it goes through the whole map, as
    // `CM_BoxTrace` goes past every brush the mask does not name. The map has no entities, so
    // there is nobody to pass.
    if (!(contentmask & CONTENTS.SOLID)) {
      return clean(start, delta, 1);
    }

    if (solidAt(start, delta, mins, maxs, 0)) {
      return {
        // The whole sweep counts as solid only if it never gets clear. Testing the far end
        // is a cheap stand-in for that: the callers who care -- the stand-up headroom check
        // and stuck recovery -- both use zero-length traces, where it is exact.
        allsolid: distance < ZERO_LENGTH || solidAt(start, delta, mins, maxs, 1),
        startsolid: true,
        fraction: 0,
        endpos: copy(start),
        normal: vec3(0, 0, 1),
        contents: CONTENTS.SOLID,
        surfaceFlags: 0,
        entityNum: ENTITYNUM_WORLD
      };
    }

    if (distance < ZERO_LENGTH) {
      return clean(start, delta, 1);
    }

    // Per-axis leading face: the one that sweeps into new voxels.
    const dir: Record<Axis, number> = { x: 0, y: 0, z: 0 };
    const leadingIndex: Record<Axis, number> = { x: 0, y: 0, z: 0 };
    const tNext: Record<Axis, number> = { x: Infinity, y: Infinity, z: Infinity };
    const tStep: Record<Axis, number> = { x: Infinity, y: Infinity, z: Infinity };

    for (const axis of AXES) {
      const d = delta[axis];
      if (d === 0) {
        continue;
      }

      dir[axis] = d > 0 ? 1 : -1;
      const leading = start[axis] + (d > 0 ? maxs[axis] : mins[axis]);
      const index =
        d > 0
          ? Math.floor((leading - HALF_OPEN_EPSILON) / vs)
          : Math.floor(leading / vs);
      const boundary = (d > 0 ? index + 1 : index) * vs;

      leadingIndex[axis] = index;
      tNext[axis] = (boundary - leading) / d;
      tStep[axis] = vs / Math.abs(d);
    }

    for (let event = 0; event < MAX_EVENTS; event++) {
      const axis = AXES.reduce((soonest, candidate) =>
        tNext[candidate] < tNext[soonest] ? candidate : soonest
      );
      const t = tNext[axis];
      if (t > 1 || !Number.isFinite(t)) {
        break;
      }

      // The slab about to be entered on this axis, spanning the box's footprint on the
      // other two axes at the moment of contact.
      const entering = leadingIndex[axis] + dir[axis];
      const others = AXES.filter((other) => other !== axis);
      const spanA = spanAt(start, delta, mins, maxs, t, others[0]);
      const spanB = spanAt(start, delta, mins, maxs, t, others[1]);

      const lo = vec3();
      const hi = vec3();
      lo[axis] = entering;
      hi[axis] = entering;
      lo[others[0]] = spanA.lo;
      hi[others[0]] = spanA.hi;
      lo[others[1]] = spanB.lo;
      hi[others[1]] = spanB.hi;

      if (anySolid(lo, hi)) {
        const normal = vec3();
        normal[axis] = -dir[axis];
        return blocked(start, delta, t, distance, normal);
      }

      leadingIndex[axis] = entering;
      tNext[axis] += tStep[axis];
    }

    return clean(start, delta, 1);
  };
}

/**
 * A trace that completed without hitting anything.
 *
 * @param start - Sweep start.
 * @param delta - Full sweep extent.
 * @param fraction - Portion completed.
 */
function clean(start: Vec3, delta: Vec3, fraction: number): TraceResult {
  return {
    allsolid: false,
    startsolid: false,
    fraction,
    endpos: madd(start, fraction, delta),
    normal: vec3(0, 0, 1),
    contents: 0,
    surfaceFlags: 0,
    entityNum: ENTITYNUM_NONE
  };
}

/**
 * A trace stopped by a voxel face, backed off so the result never penetrates.
 *
 * @param start - Sweep start.
 * @param delta - Full sweep extent.
 * @param t - Contact point along the sweep.
 * @param distance - World-space length of the sweep.
 * @param normal - Face normal at the contact.
 */
function blocked(
  start: Vec3,
  delta: Vec3,
  t: number,
  distance: number,
  normal: Vec3
): TraceResult {
  const fraction = Math.max(0, t - SURFACE_CLIP_EPSILON / distance);
  return {
    allsolid: false,
    startsolid: false,
    fraction,
    endpos: madd(start, fraction, delta),
    normal,
    contents: CONTENTS.SOLID,
    surfaceFlags: 0,
    entityNum: ENTITYNUM_WORLD
  };
}
