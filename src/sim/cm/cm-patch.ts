import { SURFACE_CLIP_EPSILON } from '../constants';
import {
  MAX_FACET_BORDERS,
  MAX_FACETS,
  MAX_PATCH_PLANES,
  type ClipMap,
  type CmPrint,
  type Facet,
  type PatchCollide,
  type PatchPlane,
  type TraceWork
} from './cm-local';
import {
  MAX_MAP_BOUNDS,
  SIDE_BACK,
  SIDE_FRONT,
  SIDE_ON,
  baseWindingForPlane,
  chopWindingInPlace,
  copyWinding,
  windingBounds,
  type Winding
} from './cm-polylib';
import {
  addPointToBounds,
  clearBounds,
  crossProduct,
  dotProduct,
  f,
  signbitsForNormal,
  vec3f,
  vector4Copy,
  vectorClear,
  vectorCopy,
  vectorLength,
  vectorMA,
  vectorNegate,
  vectorNormalize,
  vectorSubtract,
  type Vec3f,
  type Vec4f
} from './q-math';
import { boundsIntersect } from './cm-test';

/**
 * A patch's collision, `cm_patch.c`: the curve's control points subdivided into a grid of points
 * on the curve, each cell's one or two triangles made facets, and each facet bounded by planes
 * and bevelled, so a box swept against it stops as against a brush.
 *
 * Not ported: the debug drawing (`CM_DrawDebugSurface`, `cm_patch.c:1588-1763`) and what only it
 * reads, which are the last facet a trace hit and the first cell `CM_SetBorderInward` found
 * mixed; the developer's messages (`Com_DPrintf`); and the count of grid cells nothing reads
 * (`c_totalPatchBlocks`).
 */

/** `MAX_GRID_SIZE` (`cm_patch.h:88`): a grid's room on each side. */
export const MAX_GRID_SIZE = 129;

/** `SUBDIVIDE_DISTANCE` (`cm_patch.h:98`): "never more than this units away from curve". */
const SUBDIVIDE_DISTANCE = 16;

/** `PLANE_TRI_EPSILON` and `WRAP_POINT_EPSILON` (`cm_patch.h:99-100`), doubles. */
const PLANE_TRI_EPSILON = 0.1;
const WRAP_POINT_EPSILON = 0.1;

/** `POINT_EPSILON` (`cm_patch.c:315`), a double. */
const POINT_EPSILON = 0.1;

/** `NORMAL_EPSILON` and `DIST_EPSILON` (`cm_patch.c:382-383`), doubles. */
const NORMAL_EPSILON = 0.0001;
const DIST_EPSILON = 0.02;

/** The chopping epsilon, `0.1f`: a float. */
const CHOP_EPSILON = f(0.1);

/**
 * `cGrid_t` (`cm_patch.h:90-96`). Its points are one array laid out as C's
 * `vec3_t points[MAX_GRID_SIZE][MAX_GRID_SIZE]`, `[width][height]`, so a grid that outgrows a
 * column runs into the next as C's does (`CM_SubdivideGridColumns` never checks).
 */
interface Grid {
  width: number;
  height: number;
  wrapWidth: boolean;
  wrapHeight: boolean;
  points: Float32Array;
}

/** Where point `[i][j]` starts in a grid's array; refused past the array's end, where C's is. */
function at(i: number, j: number): number {
  const index = (i * MAX_GRID_SIZE + j) * 3;
  if (index < 0 || index >= MAX_GRID_SIZE * MAX_GRID_SIZE * 3) {
    throw new Error(`CM_GeneratePatchCollide: the grid outgrew its ${MAX_GRID_SIZE}² points`);
  }
  return index;
}

/** A copy of grid point `[i][j]`. */
function point(grid: Grid, i: number, j: number): Vec3f {
  const k = at(i, j);
  return [grid.points[k], grid.points[k + 1], grid.points[k + 2]];
}

/** `VectorCopy( v, grid->points[i][j] )`. */
function setPoint(grid: Grid, i: number, j: number, v: ArrayLike<number>): void {
  grid.points.set([v[0], v[1], v[2]], at(i, j));
}

/** `VectorCopy( grid->points[fi][fj], grid->points[ti][tj] )`. */
function copyPoint(grid: Grid, fi: number, fj: number, ti: number, tj: number): void {
  const from = at(fi, fj);
  grid.points.copyWithin(at(ti, tj), from, from + 3);
}

/**
 * `CM_PlaneFromPoints` (`cm_patch.c:86-98`): "the normal will point out of the clock for
 * clockwise ordered points".
 *
 * @returns false for a degenerate triangle, whose normal is exactly zero
 */
function planeFromPoints(plane: Vec4f, a: Vec3f, b: Vec3f, c: Vec3f): boolean {
  const d1 = vec3f();
  const d2 = vec3f();
  vectorSubtract(b, a, d1);
  vectorSubtract(c, a, d2);
  crossProduct(d2, d1, plane);
  if (vectorNormalize(plane) === 0) return false;
  plane[3] = dotProduct(a, plane);
  return true;
}

/**
 * `CM_NeedsSubdivision` (`cm_patch.c:117-139`): whether the quadratic curve through `a`, `b` and
 * `c` bends `SUBDIVIDE_DISTANCE` or more from its chord at the middle.
 */
function needsSubdivision(a: Vec3f, b: Vec3f, c: Vec3f): boolean {
  const lmid = vec3f();
  const cmid = vec3f();
  for (let i = 0; i < 3; i++) {
    // The linear midpoint; each `0.5*` is a double's, each sum of two points a float's.
    lmid[i] = f(0.5 * f(a[i] + c[i]));
    // "The exact curve midpoint".
    cmid[i] = f(0.5 * (0.5 * f(a[i] + b[i]) + 0.5 * f(b[i] + c[i])));
  }
  const delta = vec3f();
  vectorSubtract(cmid, lmid, delta);
  return vectorLength(delta) >= SUBDIVIDE_DISTANCE;
}

/**
 * `CM_Subdivide` (`cm_patch.c:149-157`): the curve through control points `a`, `b` and `c`,
 * split into `a, out1, out2, out3, c`.
 */
function subdivide(a: Vec3f, b: Vec3f, c: Vec3f, out1: Vec3f, out2: Vec3f, out3: Vec3f): void {
  for (let i = 0; i < 3; i++) {
    out1[i] = f(0.5 * f(a[i] + b[i]));
    out3[i] = f(0.5 * f(b[i] + c[i]));
    out2[i] = f(0.5 * f(out1[i] + out3[i]));
  }
}

/** `CM_TransposeGrid` (`cm_patch.c:166-208`): rows and columns swapped in place. */
function transposeGrid(grid: Grid): void {
  if (grid.width > grid.height) {
    for (let i = 0; i < grid.height; i++) {
      for (let j = i + 1; j < grid.width; j++) {
        if (j < grid.height) {
          // Swap the value.
          const temp = point(grid, i, j);
          copyPoint(grid, j, i, i, j);
          setPoint(grid, j, i, temp);
        } else {
          // Just copy.
          copyPoint(grid, j, i, i, j);
        }
      }
    }
  } else {
    for (let i = 0; i < grid.width; i++) {
      for (let j = i + 1; j < grid.height; j++) {
        if (j < grid.width) {
          const temp = point(grid, j, i);
          copyPoint(grid, i, j, j, i);
          setPoint(grid, i, j, temp);
        } else {
          copyPoint(grid, i, j, j, i);
        }
      }
    }
  }

  const l = grid.width;
  grid.width = grid.height;
  grid.height = l;

  const tempWrap = grid.wrapWidth;
  grid.wrapWidth = grid.wrapHeight;
  grid.wrapHeight = tempWrap;
}

/**
 * `CM_SetGridWrapWidth` (`cm_patch.c:217-237`): the grid wraps across its width when its first
 * and last columns match within `WRAP_POINT_EPSILON`.
 */
function setGridWrapWidth(grid: Grid): void {
  let i: number;
  for (i = 0; i < grid.height; i++) {
    const first = point(grid, 0, i);
    const last = point(grid, grid.width - 1, i);
    let j: number;
    for (j = 0; j < 3; j++) {
      const d = f(first[j] - last[j]);
      if (d < -WRAP_POINT_EPSILON || d > WRAP_POINT_EPSILON) break;
    }
    if (j !== 3) break;
  }
  grid.wrapWidth = i === grid.height;
}

/**
 * `CM_SubdivideGridColumns` (`cm_patch.c:248-308`): columns added until every approximating
 * point is within `SUBDIVIDE_DISTANCE` of the true curve, and removed where the curve is flat
 * enough without them.
 */
function subdivideGridColumns(grid: Grid): void {
  for (let i = 0; i < grid.width - 2; ) {
    // Column i interpolates, i + 1 approximates, and i + 2 interpolates.

    // "First see if we can collapse the aproximating collumn away."
    let j: number;
    for (j = 0; j < grid.height; j++) {
      if (needsSubdivision(point(grid, i, j), point(grid, i + 1, j), point(grid, i + 2, j))) break;
    }
    if (j === grid.height) {
      for (j = 0; j < grid.height; j++) {
        for (let k = i + 2; k < grid.width; k++) copyPoint(grid, k, j, k - 1, j);
      }
      grid.width--;
      // Go to the next curve segment.
      i++;
      continue;
    }

    // "We need to subdivide the curve."
    for (j = 0; j < grid.height; j++) {
      const prev = point(grid, i, j);
      const mid = point(grid, i + 1, j);
      const next = point(grid, i + 2, j);

      // Make room for two more columns: i + 1 is replaced, and i + 2 becomes i + 4.
      for (let k = grid.width - 1; k > i + 1; k--) copyPoint(grid, k, j, k + 2, j);

      const out1 = vec3f();
      const out2 = vec3f();
      const out3 = vec3f();
      subdivide(prev, mid, next, out1, out2, out3);
      setPoint(grid, i + 1, j, out1);
      setPoint(grid, i + 2, j, out2);
      setPoint(grid, i + 3, j, out3);
    }

    grid.width += 2;

    // "The new aproximating point at i+1 may need to be removed or subdivided farther, so don't
    // advance i."
  }
}

/** `CM_ComparePoints` (`cm_patch.c:316-332`): equal within `POINT_EPSILON` on each axis. */
function comparePoints(a: Vec3f, b: Vec3f): boolean {
  for (let k = 0; k < 3; k++) {
    const d = f(a[k] - b[k]);
    if (d < -POINT_EPSILON || d > POINT_EPSILON) return false;
  }
  return true;
}

/**
 * `CM_RemoveDegenerateColumns` (`cm_patch.c:341-366`): "if there are any identical columns,
 * remove them".
 */
function removeDegenerateColumns(grid: Grid): void {
  for (let i = 0; i < grid.width - 1; i++) {
    let j: number;
    for (j = 0; j < grid.height; j++) {
      if (!comparePoints(point(grid, i, j), point(grid, i + 1, j))) break;
    }

    if (j !== grid.height) continue; // not degenerate

    for (j = 0; j < grid.height; j++) {
      for (let k = i + 2; k < grid.width; k++) copyPoint(grid, k, j, k - 1, j);
    }
    grid.width--;

    // Check against the next column.
    i--;
  }
}

/** A patch's planes and facets as they are made, `cm_patch.c`'s statics (`:376-380`). */
interface Builder {
  planes: PatchPlane[];
  facets: Facet[];
  print: CmPrint;
}

/** `flipped`, which `CM_PlaneEqual` and `CM_FindPlane2` write through a pointer. */
interface Flipped {
  value: number;
}

/**
 * `CM_PlaneEqual` (`cm_patch.c:390-417`): whether `plane` is `p`'s, its normal within
 * `NORMAL_EPSILON` and its distance within `DIST_EPSILON`, either way round.
 */
function planeEqual(p: PatchPlane, plane: ArrayLike<number>, flipped: Flipped): boolean {
  const q = p.plane;
  if (
    Math.abs(f(q[0] - plane[0])) < NORMAL_EPSILON &&
    Math.abs(f(q[1] - plane[1])) < NORMAL_EPSILON &&
    Math.abs(f(q[2] - plane[2])) < NORMAL_EPSILON &&
    Math.abs(f(q[3] - plane[3])) < DIST_EPSILON
  ) {
    flipped.value = 0;
    return true;
  }

  const inv = [-plane[0], -plane[1], -plane[2], -plane[3]];
  if (
    Math.abs(f(q[0] - inv[0])) < NORMAL_EPSILON &&
    Math.abs(f(q[1] - inv[1])) < NORMAL_EPSILON &&
    Math.abs(f(q[2] - inv[2])) < NORMAL_EPSILON &&
    Math.abs(f(q[3] - inv[3])) < DIST_EPSILON
  ) {
    flipped.value = 1;
    return true;
  }

  return false;
}

/** `CM_SnapVector` (`cm_patch.c:424-442`): a normal within `NORMAL_EPSILON` of an axis made it. */
function snapVector(normal: Vec4f | Vec3f): void {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(f(normal[i] - 1)) < NORMAL_EPSILON) {
      vectorClear(normal);
      normal[i] = 1;
      break;
    }
    if (Math.abs(f(normal[i] + 1)) < NORMAL_EPSILON) {
      vectorClear(normal);
      normal[i] = -1;
      break;
    }
  }
}

/** Adds a plane to the patch's, refused in Q3's words past `MAX_PATCH_PLANES`. */
function addPlane(b: Builder, plane: ArrayLike<number>): number {
  if (b.planes.length === MAX_PATCH_PLANES) throw new Error('MAX_PATCH_PLANES');
  b.planes.push({
    plane: [plane[0], plane[1], plane[2], plane[3]],
    signbits: signbitsForNormal(plane)
  });
  return b.planes.length - 1;
}

/** `CM_FindPlane2` (`cm_patch.c:449-470`): a bevel's plane, the patch's own if it has it. */
function findPlane2(b: Builder, plane: ArrayLike<number>, flipped: Flipped): number {
  // "See if the points are close enough to an existing plane."
  for (let i = 0; i < b.planes.length; i++) {
    if (planeEqual(b.planes[i], plane, flipped)) return i;
  }
  const added = addPlane(b, plane);
  flipped.value = 0;
  return added;
}

/**
 * `CM_FindPlane` (`cm_patch.c:477-522`): the plane through three points, a plane of the patch's
 * if all three lie within `PLANE_TRI_EPSILON` of one that does not face away.
 *
 * @returns The plane's number, or −1 for a degenerate triangle
 */
function findPlane(b: Builder, p1: Vec3f, p2: Vec3f, p3: Vec3f): number {
  const plane: Vec4f = [0, 0, 0, 0];
  if (!planeFromPoints(plane, p1, p2, p3)) return -1;

  for (let i = 0; i < b.planes.length; i++) {
    const q = b.planes[i].plane;
    if (dotProduct(plane, q) < 0) continue; // "allow backwards planes?"
    let d = f(dotProduct(p1, q) - q[3]);
    if (d < -PLANE_TRI_EPSILON || d > PLANE_TRI_EPSILON) continue;
    d = f(dotProduct(p2, q) - q[3]);
    if (d < -PLANE_TRI_EPSILON || d > PLANE_TRI_EPSILON) continue;
    d = f(dotProduct(p3, q) - q[3]);
    if (d < -PLANE_TRI_EPSILON || d > PLANE_TRI_EPSILON) continue;
    // Found it.
    return i;
  }

  return addPlane(b, plane);
}

/** `CM_PointOnPlaneSide` (`cm_patch.c:529-549`), within `PLANE_TRI_EPSILON`; no plane is on. */
function pointOnPlaneSide(b: Builder, p: Vec3f, planeNum: number): number {
  if (planeNum === -1) return SIDE_ON;
  const plane = b.planes[planeNum].plane;
  const d = f(dotProduct(p, plane) - plane[3]);
  if (d > PLANE_TRI_EPSILON) return SIDE_FRONT;
  if (d < -PLANE_TRI_EPSILON) return SIDE_BACK;
  return SIDE_ON;
}

/** `gridPlanes[MAX_GRID_SIZE][MAX_GRID_SIZE][2]`: each cell's two triangles' planes. */
type GridPlanes = Int32Array;

/** Where cell `[i][j]`'s triangle `tri` is in the grid's planes. */
function gridPlaneAt(i: number, j: number, tri: number): number {
  return (i * MAX_GRID_SIZE + j) * 2 + tri;
}

/**
 * `CM_GridPlane` (`cm_patch.c:556-571`): a cell's triangle's plane, or its other triangle's when
 * it has none, which Q3 warns "should never happen".
 */
function gridPlane(b: Builder, gridPlanes: GridPlanes, i: number, j: number, tri: number): number {
  let p = gridPlanes[gridPlaneAt(i, j, tri)];
  if (p !== -1) return p;
  p = gridPlanes[gridPlaneAt(i, j, tri ? 0 : 1)];
  if (p !== -1) return p;
  b.print('WARNING: CM_GridPlane unresolvable\n');
  return -1;
}

/**
 * `CM_EdgePlaneNum` (`cm_patch.c:578-648`): the plane through one of a cell's edges and a point
 * 4 units off it along its triangle's normal, standing up from the surface.
 *
 * @param k - The edge: 0 top, 1 right, 2 bottom, 3 left, 4 and 5 the diagonal out of each
 *   triangle.
 */
function edgePlaneNum(
  b: Builder,
  grid: Grid,
  gridPlanes: GridPlanes,
  i: number,
  j: number,
  k: number
): number {
  // Each edge's two points, the triangle whose normal stands it up, and the points' order.
  let p1: Vec3f;
  let p2: Vec3f;
  let tri: number;
  let reversed = false;
  switch (k) {
    case 0: // top border
      p1 = point(grid, i, j);
      p2 = point(grid, i + 1, j);
      tri = 0;
      break;
    case 2: // bottom border
      p1 = point(grid, i, j + 1);
      p2 = point(grid, i + 1, j + 1);
      tri = 1;
      reversed = true;
      break;
    case 3: // left border
      p1 = point(grid, i, j);
      p2 = point(grid, i, j + 1);
      tri = 1;
      reversed = true;
      break;
    case 1: // right border
      p1 = point(grid, i + 1, j);
      p2 = point(grid, i + 1, j + 1);
      tri = 0;
      break;
    case 4: // diagonal out of triangle 0
      p1 = point(grid, i + 1, j + 1);
      p2 = point(grid, i, j);
      tri = 0;
      break;
    case 5: // diagonal out of triangle 1
      p1 = point(grid, i, j);
      p2 = point(grid, i + 1, j + 1);
      tri = 1;
      break;
    default:
      throw new Error('CM_EdgePlaneNum: bad k');
  }

  const p = gridPlane(b, gridPlanes, i, j, tri);
  if (p === -1) return -1;
  const up = vec3f();
  vectorMA(p1, 4, b.planes[p].plane, up);
  return reversed ? findPlane(b, p2, p1, up) : findPlane(b, p1, p2, up);
}

/**
 * `CM_SetBorderInward` (`cm_patch.c:655-724`): each border faces in if the facet's corners lie
 * in front of it, out if behind. A border they all lie on is dropped (−1), which fails the facet;
 * one they lie both sides of is taken as facing out.
 *
 * @param which - −1 for a cell's quad, 0 or 1 for one of its triangles.
 */
function setBorderInward(
  b: Builder,
  facet: Facet,
  grid: Grid,
  i: number,
  j: number,
  which: number
): void {
  let points: Vec3f[];
  switch (which) {
    case -1:
      points = [
        point(grid, i, j),
        point(grid, i + 1, j),
        point(grid, i + 1, j + 1),
        point(grid, i, j + 1)
      ];
      break;
    case 0:
      points = [point(grid, i, j), point(grid, i + 1, j), point(grid, i + 1, j + 1)];
      break;
    case 1:
      points = [point(grid, i + 1, j + 1), point(grid, i, j + 1), point(grid, i, j)];
      break;
    default:
      throw new Error('CM_SetBorderInward: bad parameter');
  }

  for (let k = 0; k < facet.numBorders; k++) {
    let front = 0;
    let back = 0;

    for (const p of points) {
      const side = pointOnPlaneSide(b, p, facet.borderPlanes[k]);
      if (side === SIDE_FRONT) front++;
      if (side === SIDE_BACK) back++;
    }

    if (front && !back) {
      facet.borderInward[k] = 1;
    } else if (back && !front) {
      facet.borderInward[k] = 0;
    } else if (!front && !back) {
      // A flat side border.
      facet.borderPlanes[k] = -1;
    } else {
      // A bisecting side border.
      facet.borderInward[k] = 0;
    }
  }
}

/** A border's plane, turned to face the facet as `borderInward` says, by `0 − n`. */
function borderPlaneInward(b: Builder, facet: Facet, k: number): Vec4f {
  const plane = [...b.planes[facet.borderPlanes[k]].plane] as Vec4f;
  if (!facet.borderInward[k]) {
    // `VectorSubtract( vec3_origin, plane, plane )`, which keeps a 0 positive.
    vectorSubtract([0, 0, 0], plane, plane);
    plane[3] = -plane[3];
  }
  return plane;
}

/**
 * `CM_ValidateFacet` (`cm_patch.c:733-778`): "if the facet isn't bounded by its borders, we
 * screwed up". A facet is refused when a border is missing, its borders chop its plane's whole
 * winding away, or what is left is wider than `MAX_MAP_BOUNDS`.
 */
function validateFacet(b: Builder, facet: Facet): boolean {
  if (facet.surfacePlane === -1) return false;

  const surface = b.planes[facet.surfacePlane].plane;
  let w: Winding | null = baseWindingForPlane(surface, surface[3]);
  for (let j = 0; j < facet.numBorders && w; j++) {
    if (facet.borderPlanes[j] === -1) return false;
    const plane = borderPlaneInward(b, facet, j);
    w = chopWindingInPlace(w, plane, plane[3], CHOP_EPSILON);
  }

  if (!w) return false; // "winding was completely chopped away"

  // "See if the facet is unreasonably large."
  const mins = vec3f();
  const maxs = vec3f();
  windingBounds(w, mins, maxs);
  for (let j = 0; j < 3; j++) {
    if (f(maxs[j] - mins[j]) > MAX_MAP_BOUNDS) return false; // "we must be missing a plane"
    if (mins[j] >= MAX_MAP_BOUNDS) return false;
    if (maxs[j] <= -MAX_MAP_BOUNDS) return false;
  }
  return true;
}

/** Whether a facet has room for another border, warning in Q3's words when it has not. */
function hasRoomForBorder(b: Builder, facet: Facet): boolean {
  if (facet.numBorders >= MAX_FACET_BORDERS) {
    b.print('ERROR: too many bevels\n');
    return false;
  }
  return true;
}

/**
 * `CM_AddFacetBevels` (`cm_patch.c:785-953`): the planes that keep a box from catching on a
 * facet's edges. Its winding, chopped by its borders, gets an axial plane on each side it does not
 * already have, and each of its slanted edges up to six planes through the edge that leave the
 * whole winding behind them. Last comes its own plane turned round, so the facet has a back.
 */
function addFacetBevels(b: Builder, facet: Facet): void {
  const flipped: Flipped = { value: 0 };
  const surface = b.planes[facet.surfacePlane];

  let w: Winding | null = baseWindingForPlane(surface.plane, surface.plane[3]);
  for (let j = 0; j < facet.numBorders && w; j++) {
    if (facet.borderPlanes[j] === facet.surfacePlane) continue;
    const plane = borderPlaneInward(b, facet, j);
    w = chopWindingInPlace(w, plane, plane[3], CHOP_EPSILON);
  }
  if (!w) return;

  const mins = vec3f();
  const maxs = vec3f();
  windingBounds(w, mins, maxs);

  // Add the axial planes.
  for (let axis = 0; axis < 3; axis++) {
    for (let dir = -1; dir <= 1; dir += 2) {
      const plane: Vec4f = [0, 0, 0, 0];
      plane[axis] = dir;
      plane[3] = dir === 1 ? maxs[axis] : -mins[axis];
      // If it's the surface plane.
      if (planeEqual(surface, plane, flipped)) continue;
      // See if the plane is already present.
      let i: number;
      for (i = 0; i < facet.numBorders; i++) {
        if (planeEqual(b.planes[facet.borderPlanes[i]], plane, flipped)) break;
      }

      if (i === facet.numBorders) {
        if (!hasRoomForBorder(b, facet)) continue;
        facet.borderPlanes[facet.numBorders] = findPlane2(b, plane, flipped);
        facet.borderNoAdjust[facet.numBorders] = 0;
        facet.borderInward[facet.numBorders] = flipped.value;
        facet.numBorders++;
      }
    }
  }

  // Add the edge bevels: test the non-axial plane edges.
  const vec = vec3f();
  const vec2 = vec3f();
  for (let j = 0; j < w.numpoints; j++) {
    const next = (j + 1) % w.numpoints;
    vectorSubtract(w.p[j], w.p[next], vec);
    // If it's a degenerate edge.
    if (vectorNormalize(vec) < 0.5) continue;
    snapVector(vec);
    let k: number;
    for (k = 0; k < 3; k++) {
      if (vec[k] === -1 || vec[k] === 1) break; // axial
    }
    if (k < 3) continue; // only test non-axial edges

    // Try the six possible slanted axials from this edge.
    for (let axis = 0; axis < 3; axis++) {
      for (let dir = -1; dir <= 1; dir += 2) {
        // Construct a plane.
        vectorClear(vec2);
        vec2[axis] = dir;
        const plane: Vec4f = [0, 0, 0, 0];
        crossProduct(vec, vec2, plane);
        if (vectorNormalize(plane) < 0.5) continue;
        plane[3] = dotProduct(w.p[j], plane);

        // "If all the points of the facet winding are behind this plane, it is a proper edge
        // bevel."
        let l: number;
        for (l = 0; l < w.numpoints; l++) {
          const d = f(dotProduct(w.p[l], plane) - plane[3]);
          if (d > 0.1) break; // point in front
        }
        if (l < w.numpoints) continue;

        // If it's the surface plane.
        if (planeEqual(surface, plane, flipped)) continue;
        // See if the plane is already present.
        let i: number;
        for (i = 0; i < facet.numBorders; i++) {
          if (planeEqual(b.planes[facet.borderPlanes[i]], plane, flipped)) break;
        }

        if (i === facet.numBorders) {
          if (!hasRoomForBorder(b, facet)) continue;
          const n = facet.numBorders;
          facet.borderPlanes[n] = findPlane2(b, plane, flipped);

          for (k = 0; k < n; k++) {
            if (facet.borderPlanes[n] === facet.borderPlanes[k]) {
              b.print('WARNING: bevel plane already used\n');
            }
          }

          facet.borderNoAdjust[n] = 0;
          facet.borderInward[n] = flipped.value;

          const newplane = [...b.planes[facet.borderPlanes[n]].plane] as Vec4f;
          if (!facet.borderInward[n]) {
            newplane[0] = -newplane[0];
            newplane[1] = -newplane[1];
            newplane[2] = -newplane[2];
            newplane[3] = -newplane[3];
          }
          // A bevel that chops the whole winding away is invalid, and is not kept.
          if (!chopWindingInPlace(copyWinding(w), newplane, newplane[3], CHOP_EPSILON)) continue;

          facet.numBorders++;
        }
      }
    }
  }

  // Add the opposite plane.
  if (!hasRoomForBorder(b, facet)) return;
  facet.borderPlanes[facet.numBorders] = facet.surfacePlane;
  facet.borderNoAdjust[facet.numBorders] = 0;
  facet.borderInward[facet.numBorders] = 1;
  facet.numBorders++;
}

/** A facet with no plane and no borders, as `Com_Memset` leaves one. */
function emptyFacet(): Facet {
  return {
    surfacePlane: 0,
    numBorders: 0,
    borderPlanes: new Int32Array(MAX_FACET_BORDERS),
    borderInward: new Int32Array(MAX_FACET_BORDERS),
    borderNoAdjust: new Int32Array(MAX_FACET_BORDERS)
  };
}

/** The next facet's slot, refused in Q3's words past `MAX_FACETS`. */
function nextFacet(b: Builder): Facet {
  if (b.facets.length === MAX_FACETS) throw new Error('MAX_FACETS');
  return emptyFacet();
}

/** A facet's borders, by edge: `edgeName_t` (`cm_patch.c:955-960`). */
const EN_TOP = 0;
const EN_RIGHT = 1;
const EN_BOTTOM = 2;
const EN_LEFT = 3;

/**
 * `CM_PatchCollideFromGrid` (`cm_patch.c:967-1122`): each cell of the grid one quad facet when
 * its two triangles share a plane, else a facet each, bounded by their neighbours' planes or by
 * planes standing up from their edges, validated and bevelled.
 */
function patchCollideFromGrid(grid: Grid, pf: PatchCollide, print: CmPrint): void {
  const b: Builder = { planes: [], facets: [], print };
  const gridPlanes: GridPlanes = new Int32Array(MAX_GRID_SIZE * MAX_GRID_SIZE * 2);
  const plane = (i: number, j: number, tri: number) => gridPlanes[gridPlaneAt(i, j, tri)];

  // Find the planes for each triangle of the grid.
  for (let i = 0; i < grid.width - 1; i++) {
    for (let j = 0; j < grid.height - 1; j++) {
      gridPlanes[gridPlaneAt(i, j, 0)] = findPlane(
        b,
        point(grid, i, j),
        point(grid, i + 1, j),
        point(grid, i + 1, j + 1)
      );
      gridPlanes[gridPlaneAt(i, j, 1)] = findPlane(
        b,
        point(grid, i + 1, j + 1),
        point(grid, i, j + 1),
        point(grid, i, j)
      );
    }
  }

  // Create the borders for each facet.
  const borders = [0, 0, 0, 0];
  const noAdjust = [0, 0, 0, 0];
  for (let i = 0; i < grid.width - 1; i++) {
    for (let j = 0; j < grid.height - 1; j++) {
      borders[EN_TOP] = -1;
      if (j > 0) borders[EN_TOP] = plane(i, j - 1, 1);
      else if (grid.wrapHeight) borders[EN_TOP] = plane(i, grid.height - 2, 1);
      noAdjust[EN_TOP] = borders[EN_TOP] === plane(i, j, 0) ? 1 : 0;
      if (borders[EN_TOP] === -1 || noAdjust[EN_TOP]) {
        borders[EN_TOP] = edgePlaneNum(b, grid, gridPlanes, i, j, 0);
      }

      borders[EN_BOTTOM] = -1;
      if (j < grid.height - 2) borders[EN_BOTTOM] = plane(i, j + 1, 0);
      else if (grid.wrapHeight) borders[EN_BOTTOM] = plane(i, 0, 0);
      noAdjust[EN_BOTTOM] = borders[EN_BOTTOM] === plane(i, j, 1) ? 1 : 0;
      if (borders[EN_BOTTOM] === -1 || noAdjust[EN_BOTTOM]) {
        borders[EN_BOTTOM] = edgePlaneNum(b, grid, gridPlanes, i, j, 2);
      }

      borders[EN_LEFT] = -1;
      if (i > 0) borders[EN_LEFT] = plane(i - 1, j, 0);
      else if (grid.wrapWidth) borders[EN_LEFT] = plane(grid.width - 2, j, 0);
      noAdjust[EN_LEFT] = borders[EN_LEFT] === plane(i, j, 1) ? 1 : 0;
      if (borders[EN_LEFT] === -1 || noAdjust[EN_LEFT]) {
        borders[EN_LEFT] = edgePlaneNum(b, grid, gridPlanes, i, j, 3);
      }

      borders[EN_RIGHT] = -1;
      if (i < grid.width - 2) borders[EN_RIGHT] = plane(i + 1, j, 1);
      else if (grid.wrapWidth) borders[EN_RIGHT] = plane(0, j, 1);
      noAdjust[EN_RIGHT] = borders[EN_RIGHT] === plane(i, j, 0) ? 1 : 0;
      if (borders[EN_RIGHT] === -1 || noAdjust[EN_RIGHT]) {
        borders[EN_RIGHT] = edgePlaneNum(b, grid, gridPlanes, i, j, 1);
      }

      let facet = nextFacet(b);

      if (plane(i, j, 0) === plane(i, j, 1)) {
        if (plane(i, j, 0) === -1) continue; // degenerate
        facet.surfacePlane = plane(i, j, 0);
        facet.numBorders = 4;
        facet.borderPlanes[0] = borders[EN_TOP];
        facet.borderNoAdjust[0] = noAdjust[EN_TOP];
        facet.borderPlanes[1] = borders[EN_RIGHT];
        facet.borderNoAdjust[1] = noAdjust[EN_RIGHT];
        facet.borderPlanes[2] = borders[EN_BOTTOM];
        facet.borderNoAdjust[2] = noAdjust[EN_BOTTOM];
        facet.borderPlanes[3] = borders[EN_LEFT];
        facet.borderNoAdjust[3] = noAdjust[EN_LEFT];
        setBorderInward(b, facet, grid, i, j, -1);
        if (validateFacet(b, facet)) {
          addFacetBevels(b, facet);
          b.facets.push(facet);
        }
      } else {
        // Two separate triangles.
        facet.surfacePlane = plane(i, j, 0);
        facet.numBorders = 3;
        facet.borderPlanes[0] = borders[EN_TOP];
        facet.borderNoAdjust[0] = noAdjust[EN_TOP];
        facet.borderPlanes[1] = borders[EN_RIGHT];
        facet.borderNoAdjust[1] = noAdjust[EN_RIGHT];
        facet.borderPlanes[2] = plane(i, j, 1);
        if (facet.borderPlanes[2] === -1) {
          facet.borderPlanes[2] = borders[EN_BOTTOM];
          if (facet.borderPlanes[2] === -1) {
            facet.borderPlanes[2] = edgePlaneNum(b, grid, gridPlanes, i, j, 4);
          }
        }
        setBorderInward(b, facet, grid, i, j, 0);
        if (validateFacet(b, facet)) {
          addFacetBevels(b, facet);
          b.facets.push(facet);
        }

        facet = nextFacet(b);

        facet.surfacePlane = plane(i, j, 1);
        facet.numBorders = 3;
        facet.borderPlanes[0] = borders[EN_BOTTOM];
        facet.borderNoAdjust[0] = noAdjust[EN_BOTTOM];
        facet.borderPlanes[1] = borders[EN_LEFT];
        facet.borderNoAdjust[1] = noAdjust[EN_LEFT];
        facet.borderPlanes[2] = plane(i, j, 0);
        if (facet.borderPlanes[2] === -1) {
          facet.borderPlanes[2] = borders[EN_TOP];
          if (facet.borderPlanes[2] === -1) {
            facet.borderPlanes[2] = edgePlaneNum(b, grid, gridPlanes, i, j, 5);
          }
        }
        setBorderInward(b, facet, grid, i, j, 1);
        if (validateFacet(b, facet)) {
          addFacetBevels(b, facet);
          b.facets.push(facet);
        }
      }
    }
  }

  // Copy the results out.
  pf.numPlanes = b.planes.length;
  pf.planes = b.planes;
  pf.numFacets = b.facets.length;
  pf.facets = b.facets;
}

/**
 * `CM_GeneratePatchCollide` (`cm_patch.c:1135-1201`): "an internal structure that will be used
 * to perform collision detection with a patch mesh". The grid is subdivided across, then turned
 * and subdivided again, so its points lie on the curve; its facets are made from it, and its
 * bounds are widened by a unit "for epsilon purposes".
 *
 * @param width - Control points across.
 * @param height - Control points down.
 * @param points - The control points, row after row, three floats each.
 * @param print - Where its warnings go, as `Com_Printf`.
 * @throws in Q3's words for a size it refuses, and for more planes or facets than a patch holds;
 *   in the port's own for a grid that outgrows the room C gives it
 */
export function generatePatchCollide(
  width: number,
  height: number,
  points: ArrayLike<number>,
  print: CmPrint
): PatchCollide {
  if (width <= 2 || height <= 2) {
    throw new Error(`CM_GeneratePatchFacets: bad parameters: (${width}, ${height})`);
  }
  if (!(width & 1) || !(height & 1)) {
    throw new Error('CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes');
  }
  if (width > MAX_GRID_SIZE || height > MAX_GRID_SIZE) {
    throw new Error('CM_GeneratePatchFacets: source is > MAX_GRID_SIZE');
  }

  // Build a grid.
  const grid: Grid = {
    width,
    height,
    wrapWidth: false,
    wrapHeight: false,
    points: new Float32Array(MAX_GRID_SIZE * MAX_GRID_SIZE * 3)
  };
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      const k = (j * width + i) * 3;
      setPoint(grid, i, j, [points[k], points[k + 1], points[k + 2]]);
    }
  }

  // Subdivide the grid.
  setGridWrapWidth(grid);
  subdivideGridColumns(grid);
  removeDegenerateColumns(grid);

  transposeGrid(grid);

  setGridWrapWidth(grid);
  subdivideGridColumns(grid);
  removeDegenerateColumns(grid);

  // "We now have a grid of points exactly on the curve; the approximate surface defined by these
  // points will be collided against."
  const pf: PatchCollide = {
    bounds: [vec3f(), vec3f()],
    numPlanes: 0,
    planes: [],
    numFacets: 0,
    facets: []
  };
  clearBounds(pf.bounds[0], pf.bounds[1]);
  for (let i = 0; i < grid.width; i++) {
    for (let j = 0; j < grid.height; j++) {
      addPointToBounds(point(grid, i, j), pf.bounds[0], pf.bounds[1]);
    }
  }

  // "Generate a bsp tree for the surface."
  patchCollideFromGrid(grid, pf, print);

  // "Expand by one unit for epsilon purposes."
  for (let k = 0; k < 3; k++) {
    pf.bounds[0][k] = f(pf.bounds[0][k] - 1);
    pf.bounds[1][k] = f(pf.bounds[1][k] + 1);
  }

  return pf;
}

/** How far `p` is in front of a patch plane, less the plane's `offset` to the box's corner. */
function boxDistance(plane: PatchPlane, p: Vec3f, offset: number): number {
  return f(f(dotProduct(p, plane.plane) - plane.plane[3]) + offset);
}

/**
 * `CM_TracePointThroughPatchCollide` (`cm_patch.c:1218-1311`), the "special case for point traces
 * because the patch collide 'brushes' have no volume", taken only under `cm_playerCurveClip`. A
 * facet is hit where the trace crosses its surface plane from the front within its borders, and
 * the trace stops `SURFACE_CLIP_EPSILON` short of it.
 */
function tracePointThroughPatchCollide(cm: ClipMap, pc: PatchCollide): void {
  const tw = cm.traceWork;
  if (!cm.cvars.playerCurveClip || !tw.isPoint) return;

  // "Determine the trace's relationship to all planes."
  const frontFacing = tw.frontFacing;
  const intersection = tw.intersection;
  for (let i = 0; i < pc.numPlanes; i++) {
    const plane = pc.planes[i];
    const offset = dotProduct(tw.offsets[plane.signbits], plane.plane);
    const d1 = boxDistance(plane, tw.start, offset);
    const d2 = boxDistance(plane, tw.end, offset);
    frontFacing[i] = d1 <= 0 ? 0 : 1;
    if (d1 === d2) {
      intersection[i] = 99999;
    } else {
      intersection[i] = f(d1 / f(d1 - d2));
      if (intersection[i] <= 0) intersection[i] = 99999;
    }
  }

  // "See if any of the surface planes are intersected."
  for (let i = 0; i < pc.numFacets; i++) {
    const facet = pc.facets[i];
    if (!frontFacing[facet.surfacePlane]) continue;
    const intersect = intersection[facet.surfacePlane];
    if (intersect < 0) continue; // surface is behind the starting point
    if (intersect > tw.trace.fraction) continue; // already hit something closer

    let j = 0;
    for (; j < facet.numBorders; j++) {
      const k = facet.borderPlanes[j];
      if (frontFacing[k] ^ facet.borderInward[j]) {
        if (intersection[k] > intersect) break;
      } else if (intersection[k] < intersect) {
        break;
      }
    }

    if (j === facet.numBorders) {
      // "We hit this facet."
      const plane = pc.planes[facet.surfacePlane];

      // "Calculate intersection with a slight pushoff."
      const offset = dotProduct(tw.offsets[plane.signbits], plane.plane);
      const d1 = boxDistance(plane, tw.start, offset);
      const d2 = boxDistance(plane, tw.end, offset);
      tw.trace.fraction = f((d1 - SURFACE_CLIP_EPSILON) / f(d1 - d2));

      if (tw.trace.fraction < 0) tw.trace.fraction = 0;

      vectorCopy(plane.plane, tw.trace.plane.normal);
      tw.trace.plane.dist = plane.plane[3];
    }
  }
}

/**
 * `CM_CheckFacetPlane` (`cm_patch.c:1318-1357`): one plane of a facet against the sweep, as a
 * brush's side is. The latest entering fraction and the earliest leaving one are kept in the
 * work's `enterFrac` and `leaveFrac`, and `hit` says whether this plane moved the first.
 *
 * @returns Whether the facet may still be hit: false when the sweep stays in front of the plane
 */
function checkFacetPlane(tw: TraceWork, plane: Vec4f, start: Vec3f, end: Vec3f): boolean {
  tw.hit = false;

  const d1 = f(dotProduct(start, plane) - plane[3]);
  const d2 = f(dotProduct(end, plane) - plane[3]);

  // "If completely in front of face, no intersection with the entire facet."
  if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) return false;

  // "If it doesn't cross the plane, the plane isn't relevant."
  if (d1 <= 0 && d2 <= 0) return true;

  // "Crosses face."
  if (d1 > d2) {
    // Enter.
    let frac = f((d1 - SURFACE_CLIP_EPSILON) / f(d1 - d2));
    if (frac < 0) frac = 0;
    // "Always favor previous plane hits and thus also the surface plane hit."
    if (frac > tw.enterFrac) {
      tw.enterFrac = frac;
      tw.hit = true;
    }
  } else {
    // Leave.
    let frac = f((d1 + SURFACE_CLIP_EPSILON) / f(d1 - d2));
    if (frac > 1) frac = 1;
    if (frac < tw.leaveFrac) tw.leaveFrac = frac;
  }
  return true;
}

/**
 * A facet's border `j` into `plane`, flipped if it faces in, and pushed out by the box's corner.
 * "This works even though the plane might be flipped because the bbox is centered."
 */
function borderPlane(tw: TraceWork, pc: PatchCollide, facet: Facet, j: number): Vec4f {
  const plane = tw.plane;
  const border = pc.planes[facet.borderPlanes[j]];
  if (facet.borderInward[j]) {
    vectorNegate(border.plane, plane);
    plane[3] = -border.plane[3];
  } else {
    vectorCopy(border.plane, plane);
    plane[3] = border.plane[3];
  }
  const offset = dotProduct(tw.offsets[border.signbits], plane);
  plane[3] = f(plane[3] + Math.abs(offset));
  return plane;
}

/** A facet's surface plane into `plane`, pulled back by the box's corner. */
function surfacePlane(tw: TraceWork, pc: PatchCollide, facet: Facet): Vec4f {
  const plane = tw.plane;
  const surface = pc.planes[facet.surfacePlane];
  vectorCopy(surface.plane, plane);
  plane[3] = surface.plane[3];
  const offset = dotProduct(tw.offsets[surface.signbits], plane);
  plane[3] = f(plane[3] - offset);
  return plane;
}

/**
 * `CM_TraceThroughPatchCollide` (`cm_patch.c:1364-1489`): the sweep against each facet of a patch
 * as against a brush of its surface plane and borders, the box's corner pushing each out. The
 * facet's last border is its back, which a hit never counts on. A point's trace goes its own way.
 */
export function traceThroughPatchCollide(cm: ClipMap, pc: PatchCollide): void {
  const tw = cm.traceWork;
  const bestplane = tw.bestplane;
  tw.plane.fill(0);
  bestplane.fill(0);

  if (!boundsIntersect(tw.bounds[0], tw.bounds[1], pc.bounds[0], pc.bounds[1])) return;

  if (tw.isPoint) {
    tracePointThroughPatchCollide(cm, pc);
    return;
  }

  for (let i = 0; i < pc.numFacets; i++) {
    const facet = pc.facets[i];
    tw.enterFrac = -1;
    tw.leaveFrac = 1;
    let hitnum = -1;

    const plane = surfacePlane(tw, pc, facet);
    if (!checkFacetPlane(tw, plane, tw.start, tw.end)) continue;
    if (tw.hit) vector4Copy(plane, bestplane);

    let j = 0;
    for (; j < facet.numBorders; j++) {
      borderPlane(tw, pc, facet, j);
      if (!checkFacetPlane(tw, plane, tw.start, tw.end)) break;
      if (tw.hit) {
        hitnum = j;
        vector4Copy(plane, bestplane);
      }
    }
    if (j < facet.numBorders) continue;
    // "Never clip against the back side."
    if (hitnum === facet.numBorders - 1) continue;

    if (tw.enterFrac < tw.leaveFrac && tw.enterFrac >= 0) {
      if (tw.enterFrac < tw.trace.fraction) {
        if (tw.enterFrac < 0) tw.enterFrac = 0;

        tw.trace.fraction = tw.enterFrac;
        vectorCopy(bestplane, tw.trace.plane.normal);
        tw.trace.plane.dist = bestplane[3];
      }
    }
  }
}

/**
 * `CM_PositionTestInPatchCollide` (`cm_patch.c:1505-1586`): whether the box at the start is
 * behind a facet's surface plane and within all its borders. Its refusal of a point never fires:
 * only a sweep marks a trace a point, so a point's position test is tested as a box of no size.
 */
export function positionTestInPatchCollide(cm: ClipMap, pc: PatchCollide): boolean {
  const tw = cm.traceWork;
  if (tw.isPoint) return false;

  for (let i = 0; i < pc.numFacets; i++) {
    const facet = pc.facets[i];
    let plane = surfacePlane(tw, pc, facet);
    if (f(dotProduct(plane, tw.start) - plane[3]) > 0) continue;

    let j = 0;
    for (; j < facet.numBorders; j++) {
      plane = borderPlane(tw, pc, facet, j);
      if (f(dotProduct(plane, tw.start) - plane[3]) > 0) break;
    }
    if (j < facet.numBorders) continue;

    // "Inside this patch facet."
    return true;
  }
  return false;
}
