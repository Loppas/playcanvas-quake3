import {
  crossProduct,
  dotProduct,
  f,
  vec3f,
  vectorAdd,
  vectorMA,
  vectorNormalize2,
  vectorScale,
  vectorSubtract,
  type Vec3f
} from './q-math';

/**
 * The part of `cm_polylib.c` collision uses: the six functions with which a patch's facets are
 * checked and bevelled (`cm_patch.c:733-953`). id's header calls the file "only used for
 * visualization tools", but a patch's collision rests on it. The other eleven functions are dead
 * in the engine, and are not ported. `FreeWinding` frees nothing the collector does not, and its
 * check for a winding freed twice guards C's memory, so it is not ported either.
 */

/** `MAX_POINTS_ON_WINDING` (`cm_polylib.h:31`). */
export const MAX_POINTS_ON_WINDING = 64;

/** `MAX_MAP_BOUNDS` (`cm_polylib.h:40`): half the side of a base winding. */
export const MAX_MAP_BOUNDS = 65535;

/** `SIDE_FRONT`, `SIDE_BACK` and `SIDE_ON` (`cm_polylib.h:33-35`). */
export const SIDE_FRONT = 0;
export const SIDE_BACK = 1;
export const SIDE_ON = 2;

/** `winding_t` (`cm_polylib.h:25-29`): a convex polygon's points, in order. */
export interface Winding {
  numpoints: number;
  p: Vec3f[];
}

/** `AllocWinding` (`cm_polylib.c:49-64`): room for `points`, none of them used. */
function allocWinding(points: number): Winding {
  return { numpoints: 0, p: Array.from({ length: points }, () => vec3f()) };
}

/** `WindingBounds` (`cm_polylib.c:158-177`), from ±`MAX_MAP_BOUNDS`. */
export function windingBounds(w: Winding, mins: number[], maxs: number[]): void {
  mins[0] = mins[1] = mins[2] = MAX_MAP_BOUNDS;
  maxs[0] = maxs[1] = maxs[2] = -MAX_MAP_BOUNDS;
  for (let i = 0; i < w.numpoints; i++) {
    for (let j = 0; j < 3; j++) {
      const v = w.p[i][j];
      if (v < mins[j]) mins[j] = v;
      if (v > maxs[j]) maxs[j] = v;
    }
  }
}

/**
 * `BaseWindingForPlane` (`cm_polylib.c:202-266`): a square on the plane, `MAX_MAP_BOUNDS` from
 * its middle to each side, in float arithmetic. Its corners are ~65535 out, where a float's step
 * is 1/128, so what chopping it leaves depends on that rounding.
 *
 * @throws in Q3's words for a normal with no component larger than −`MAX_MAP_BOUNDS`
 */
export function baseWindingForPlane(normal: ArrayLike<number>, dist: number): Winding {
  // Find the major axis.
  let max = -MAX_MAP_BOUNDS;
  let x = -1;
  for (let i = 0; i < 3; i++) {
    const v = f(Math.abs(normal[i]));
    if (v > max) {
      x = i;
      max = v;
    }
  }
  if (x === -1) throw new Error('BaseWindingForPlane: no axis found');

  const vup = vec3f();
  if (x === 2) vup[0] = 1;
  else vup[2] = 1;

  const v = dotProduct(vup, normal);
  vectorMA(vup, -v, normal, vup);
  vectorNormalize2(vup, vup);

  const org = vec3f();
  vectorScale(normal, dist, org);

  const vright = vec3f();
  crossProduct(vup, normal, vright);

  vectorScale(vup, MAX_MAP_BOUNDS, vup);
  vectorScale(vright, MAX_MAP_BOUNDS, vright);

  // "Project a really big axis aligned box onto the plane."
  const w = allocWinding(4);
  vectorSubtract(org, vright, w.p[0]);
  vectorAdd(w.p[0], vup, w.p[0]);

  vectorAdd(org, vright, w.p[1]);
  vectorAdd(w.p[1], vup, w.p[1]);

  vectorAdd(org, vright, w.p[2]);
  vectorSubtract(w.p[2], vup, w.p[2]);

  vectorSubtract(org, vright, w.p[3]);
  vectorSubtract(w.p[3], vup, w.p[3]);

  w.numpoints = 4;
  return w;
}

/** `CopyWinding` (`cm_polylib.c:273-282`). */
export function copyWinding(w: Winding): Winding {
  const c = allocWinding(w.numpoints);
  c.numpoints = w.numpoints;
  for (let i = 0; i < w.numpoints; i++) {
    c.p[i][0] = w.p[i][0];
    c.p[i][1] = w.p[i][1];
    c.p[i][2] = w.p[i][2];
  }
  return c;
}

/**
 * `ChopWindingInPlace` (`cm_polylib.c:421-515`): what of `inout` lies in front of the plane,
 * within `epsilon`.
 *
 * @param inout - The winding, which is returned as it is when nothing lies behind the plane.
 * @param normal - The plane's normal.
 * @param dist - Its distance.
 * @param epsilon - How far behind the plane a point can lie and stay, a float.
 * @returns The chopped winding, or `null` when nothing lies in front of the plane
 * @throws in Q3's words for a winding of more points than it can hold
 */
export function chopWindingInPlace(
  inout: Winding,
  normal: ArrayLike<number>,
  dist: number,
  epsilon: number
): Winding | null {
  const n = inout.numpoints;
  const dists = new Array<number>(n + 1).fill(0);
  const sides = new Array<number>(n + 1).fill(0);
  const counts = [0, 0, 0];

  // Determine sides for each point.
  let i: number;
  for (i = 0; i < n; i++) {
    const dot = f(dotProduct(inout.p[i], normal) - dist);
    dists[i] = dot;
    if (dot > epsilon) sides[i] = SIDE_FRONT;
    else if (dot < -epsilon) sides[i] = SIDE_BACK;
    else sides[i] = SIDE_ON;
    counts[sides[i]]++;
  }
  sides[i] = sides[0];
  dists[i] = dists[0];

  if (!counts[SIDE_FRONT]) return null;
  if (!counts[SIDE_BACK]) return inout; // "inout stays the same"

  // "Can't use counts[0]+2 because of fp grouping errors."
  const maxpts = n + 4;
  const out = allocWinding(maxpts);
  const mid = vec3f();

  for (i = 0; i < n; i++) {
    const p1 = inout.p[i];

    if (sides[i] === SIDE_ON) {
      pushPoint(out, p1);
      continue;
    }

    if (sides[i] === SIDE_FRONT) pushPoint(out, p1);

    if (sides[i + 1] === SIDE_ON || sides[i + 1] === sides[i]) continue;

    // Generate a split point.
    const p2 = inout.p[(i + 1) % n];

    const dot = f(dists[i] / f(dists[i] - dists[i + 1]));
    for (let j = 0; j < 3; j++) {
      // "Avoid round off error when possible."
      if (normal[j] === 1) mid[j] = dist;
      else if (normal[j] === -1) mid[j] = -dist;
      else mid[j] = f(p1[j] + f(dot * f(p2[j] - p1[j])));
    }

    pushPoint(out, mid);
  }

  if (out.numpoints > maxpts) throw new Error('ClipWinding: points exceeded estimate');
  if (out.numpoints > MAX_POINTS_ON_WINDING) throw new Error('ClipWinding: MAX_POINTS_ON_WINDING');

  return out;
}

/** Copies `p` onto the end of `w`, as `VectorCopy (p1, f->p[f->numpoints]); f->numpoints++;`. */
function pushPoint(w: Winding, p: ArrayLike<number>): void {
  if (w.numpoints === w.p.length) w.p.push(vec3f());
  const to = w.p[w.numpoints++];
  to[0] = p[0];
  to[1] = p[1];
  to[2] = p[2];
}
