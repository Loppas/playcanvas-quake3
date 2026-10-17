import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { CONTENTS, SURFACE_CLIP_EPSILON } from './constants';
import { clearTrace, type TraceFn } from './types';
import { copy, madd, vec3, type Vec3 } from './vec3';

/**
 * A world made of axis-aligned solid boxes, with a swept-AABB trace over it.
 *
 * This is a **reference collider**, not the game's sweep against the
 * voxel octree; this exists so the movement simulation can be tested against geometry whose
 * correct answers are obvious by inspection (a floor, a step, a wall), and it doubles as a
 * worked example of the {@link TraceFn} contract.
 *
 * The sweep uses the standard Minkowski trick: each solid is expanded by the player's box
 * half-extents and a *point* is swept through it, which is exactly how Q3 traces against BSP
 * brushes — and why a player can stand with only a box corner on a ledge.
 */

/** An axis-aligned solid region. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** Below this, a sweep is treated as a stationary "does the box fit here" query. */
const ZERO_LENGTH = 1e-9;

/**
 * Solids are shrunk by this before testing, so a box resting exactly on a surface counts as
 * touching rather than penetrating. Without it a player standing on the floor reports
 * `startsolid` against it and can never move — every surface becomes flypaper.
 */
const TOUCH_EPSILON = 1e-3;

/**
 * Build a solid box from opposite corners.
 *
 * @param minX - Minimum X.
 * @param minY - Minimum Y.
 * @param minZ - Minimum Z.
 * @param maxX - Maximum X.
 * @param maxY - Maximum Y.
 * @param maxZ - Maximum Z.
 */
export function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): Box {
  return { min: vec3(minX, minY, minZ), max: vec3(maxX, maxY, maxZ) };
}

/**
 * A large flat floor whose walkable surface is at z = 0.
 *
 * @param halfExtent - Half the floor's width and depth.
 */
export function floorBox(halfExtent = 8192): Box {
  return box(-halfExtent, -halfExtent, -1024, halfExtent, halfExtent, 0);
}

/**
 * Build a {@link TraceFn} over a set of solid boxes.
 *
 * @param solids - The solid geometry of the world.
 */
export function createBoxWorldTrace(solids: Box[]): TraceFn {
  return (start, mins, maxs, end, _passEntityNum, contentmask) => {
    // Every box is `CONTENTS_SOLID`, and there are no entities to pass.
    if (!(contentmask & CONTENTS.SOLID)) return clearTrace(end);

    const delta = vec3(end.x - start.x, end.y - start.y, end.z - start.z);
    const distance = Math.hypot(delta.x, delta.y, delta.z);

    let fraction = 1;
    let normal = vec3(0, 0, 1);
    let startsolid = false;
    let allsolid = false;

    for (const solid of solids) {
      // Minkowski expansion: grow the solid by the player's box, then sweep a point.
      const expanded = {
        min: vec3(
          solid.min.x - maxs.x + TOUCH_EPSILON,
          solid.min.y - maxs.y + TOUCH_EPSILON,
          solid.min.z - maxs.z + TOUCH_EPSILON
        ),
        max: vec3(
          solid.max.x - mins.x - TOUCH_EPSILON,
          solid.max.y - mins.y - TOUCH_EPSILON,
          solid.max.z - mins.z - TOUCH_EPSILON
        )
      };

      if (distance < ZERO_LENGTH) {
        if (contains(expanded, start)) {
          startsolid = true;
          allsolid = true;
          fraction = 0;
        }
        continue;
      }

      const hit = sweepPoint(start, delta, expanded);
      if (!hit) {
        continue;
      }

      if (hit.enter < 0) {
        startsolid = true;
        allsolid ||= hit.exit >= 1;
        fraction = 0;
        continue;
      }

      // Stop short of the surface so the result is never penetrating.
      const backedOff = Math.max(0, hit.enter - SURFACE_CLIP_EPSILON / distance);
      if (backedOff < fraction) {
        fraction = backedOff;
        normal = hit.normal;
      }
    }

    if (startsolid) {
      fraction = 0;
    }

    return {
      allsolid,
      startsolid,
      fraction,
      endpos: fraction === 0 ? copy(start) : madd(start, fraction, delta),
      normal,
      contents: fraction < 1 ? CONTENTS.SOLID : 0,
      surfaceFlags: 0,
      entityNum: fraction < 1 ? ENTITYNUM_WORLD : ENTITYNUM_NONE
    };
  };
}

/**
 * Sweep a point along `delta` against an axis-aligned box, via the slab method.
 *
 * @param start - Ray origin.
 * @param delta - Full ray extent; the returned fractions are relative to it.
 * @param target - Box to test against.
 * @returns Entry and exit fractions plus the surface normal at entry, or null if it misses.
 */
function sweepPoint(
  start: Vec3,
  delta: Vec3,
  target: Box
): { enter: number; exit: number; normal: Vec3 } | null {
  const axes = ['x', 'y', 'z'] as const;
  let enter = -Infinity;
  let exit = Infinity;
  let enterAxis: (typeof axes)[number] = 'z';
  let enterSign = 1;

  for (const axis of axes) {
    const d = delta[axis];
    const s = start[axis];

    if (Math.abs(d) < ZERO_LENGTH) {
      // Parallel to this pair of faces: either always between them, or never touching.
      if (s < target.min[axis] || s > target.max[axis]) {
        return null;
      }
      continue;
    }

    const t1 = (target.min[axis] - s) / d;
    const t2 = (target.max[axis] - s) / d;
    const near = Math.min(t1, t2);
    const far = Math.max(t1, t2);

    if (near > enter) {
      enter = near;
      enterAxis = axis;
      enterSign = d > 0 ? -1 : 1; // the face we hit points back against our motion
    }
    exit = Math.min(exit, far);
  }

  if (enter > exit || exit < 0 || enter > 1) {
    return null;
  }

  const normal = vec3();
  normal[enterAxis] = enterSign;
  return { enter, exit, normal };
}

/**
 * @param target - Box to test.
 * @param point - Point to test.
 */
function contains(target: Box, point: Vec3): boolean {
  return (
    point.x >= target.min.x &&
    point.x <= target.max.x &&
    point.y >= target.min.y &&
    point.y <= target.max.y &&
    point.z >= target.min.z &&
    point.z <= target.max.z
  );
}

/**
 * Convenience trace for a world that is nothing but flat ground at z = 0.
 *
 * @param extras - Additional solids to place in the world.
 */
export function createFlatWorldTrace(extras: Box[] = []): TraceFn {
  return createBoxWorldTrace([floorBox(), ...extras]);
}
