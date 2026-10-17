import { SURFACE_CLIP_EPSILON } from '../constants';
import {
  BOX_MODEL_HANDLE,
  MAX_POSITION_LEAFS,
  type CBrush,
  type CBrushSide,
  type CLeaf,
  type ClipMap,
  type CPatch,
  type CPlane,
  type Trace
} from './cm-local';
import { clipHandleToModel } from './cm-load';
import { positionTestInPatchCollide, traceThroughPatchCollide } from './cm-patch';
import { boundsIntersect, boxLeafnumsR } from './cm-test';
import { angleVectors, dotProduct, f, vec3f, vectorAdd, vectorClear, type Vec3f } from './q-math';

/**
 * `cm_trace.c`: a box or a point swept from a start to an end through the world or one model, and
 * the position test of a box that does not move. A trace stops `SURFACE_CLIP_EPSILON` short of
 * what it hits, at the first fraction of the way, and says what it hit.
 *
 * Each point, box and angle a caller passes is taken as the floats C's `vec3_t` would hold.
 *
 * Not ported: the capsule, which baseq3 never asks for (`cm_trace.c:297-402, 728-1021`, each
 * function's `sphere.use` branch, and the vector helpers only it calls); the counters
 * `com_showtrace` prints; and the check of the plane's normal, an `assert` a release build leaves
 * out.
 */

/** `RotatePoint` (`cm_trace.c:44-51`): `point` turned by `matrix`, each row a dot product. */
function rotatePoint(point: Vec3f, matrix: Vec3f[]): void {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  for (let i = 0; i < 3; i++) {
    const m = matrix[i];
    point[i] = f(f(f(m[0] * x) + f(m[1] * y)) + f(m[2] * z));
  }
}

/** `TransposeMatrix` (`cm_trace.c:58-65`). */
function transposeMatrix(matrix: Vec3f[], transpose: Vec3f[]): void {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) transpose[i][j] = matrix[j][i];
  }
}

/** `CreateRotationMatrix` (`cm_trace.c:72-75`): the angles' axes, `right` made `left`. */
function createRotationMatrix(angles: Vec3f, matrix: Vec3f[]): void {
  angleVectors(angles, matrix[0], matrix[1], matrix[2]);
  // VectorInverse.
  matrix[1][0] = -matrix[1][0];
  matrix[1][1] = -matrix[1][1];
  matrix[1][2] = -matrix[1][2];
}

/** `*to = *from` of a plane, its own normal kept. */
function copyPlane(from: CPlane, to: CPlane): void {
  to.normal[0] = from.normal[0];
  to.normal[1] = from.normal[1];
  to.normal[2] = from.normal[2];
  to.dist = from.dist;
  to.type = from.type;
  to.signbits = from.signbits;
}

/** `*to = *from` of a trace, its own arrays kept. */
function copyTrace(from: Trace, to: Trace): void {
  to.allsolid = from.allsolid;
  to.startsolid = from.startsolid;
  to.fraction = from.fraction;
  to.endpos[0] = from.endpos[0];
  to.endpos[1] = from.endpos[1];
  to.endpos[2] = from.endpos[2];
  copyPlane(from.plane, to.plane);
  to.surfaceFlags = from.surfaceFlags;
  to.contents = from.contents;
  to.entityNum = from.entityNum;
}

/** A trace's `Com_Memset` to zero. */
function clearTrace(trace: Trace): void {
  trace.allsolid = false;
  trace.startsolid = false;
  trace.fraction = 0;
  vectorClear(trace.endpos);
  vectorClear(trace.plane.normal);
  trace.plane.dist = 0;
  trace.plane.type = 0;
  trace.plane.signbits = 0;
  trace.surfaceFlags = 0;
  trace.contents = 0;
  trace.entityNum = 0;
}

/** A plane's distance pushed out by the box's corner it meets first. */
function boxPlaneDist(cm: ClipMap, plane: CPlane): number {
  return f(plane.dist - dotProduct(cm.traceWork.offsets[plane.signbits], plane.normal));
}

/*
 * Position testing.
 */

/**
 * `CM_TestBoxInBrush` (`cm_trace.c:161-233`): whether the box at the start is inside a brush,
 * which makes the trace all solid. Its bounds stand for its first six sides, which q3map makes
 * the axial ones.
 */
function testBoxInBrush(cm: ClipMap, brush: CBrush): void {
  const tw = cm.traceWork;

  if (!brush.numsides) return;

  // "Special test for axial."
  if (
    tw.bounds[0][0] > brush.bounds[1][0] ||
    tw.bounds[0][1] > brush.bounds[1][1] ||
    tw.bounds[0][2] > brush.bounds[1][2] ||
    tw.bounds[1][0] < brush.bounds[0][0] ||
    tw.bounds[1][1] < brush.bounds[0][1] ||
    tw.bounds[1][2] < brush.bounds[0][2]
  ) {
    return;
  }

  // "The first six planes are the axial planes, so we only need to test the remainder."
  for (let i = 6; i < brush.numsides; i++) {
    const plane = cm.brushsides[brush.firstSide + i].plane;

    // "Adjust the plane distance appropriately for mins/maxs."
    const dist = boxPlaneDist(cm, plane);

    const d1 = f(dotProduct(tw.start, plane.normal) - dist);

    // "If completely in front of face, no intersection."
    if (d1 > 0) return;
  }

  // "Inside this brush."
  tw.trace.startsolid = tw.trace.allsolid = true;
  tw.trace.fraction = 0;
  tw.trace.contents = brush.contents;
}

/**
 * `CM_TestInLeaf` (`cm_trace.c:242-295`): the box at the start against a leaf's brushes, then its
 * patches unless `cm_noCurves`, until one holds it. Each is tested once a trace, though several
 * leaves list it.
 */
function testInLeaf(cm: ClipMap, leaf: CLeaf): void {
  const tw = cm.traceWork;

  // "Test box position against all brushes in the leaf."
  for (let k = 0; k < leaf.numLeafBrushes; k++) {
    const b = cm.brushes[cm.leafbrushes[leaf.firstLeafBrush + k]];
    if (b.checkcount === cm.checkcount) continue; // already checked this brush in another leaf
    b.checkcount = cm.checkcount;

    if (!(b.contents & tw.contents)) continue;

    testBoxInBrush(cm, b);
    if (tw.trace.allsolid) return;
  }

  // "Test against all patches."
  if (!cm.cvars.noCurves) {
    for (let k = 0; k < leaf.numLeafSurfaces; k++) {
      const patch = cm.surfaces[cm.leafsurfaces[leaf.firstLeafSurface + k]];
      if (!patch) continue;
      if (patch.checkcount === cm.checkcount) continue; // already checked in another leaf
      patch.checkcount = cm.checkcount;

      if (!(patch.contents & tw.contents)) continue;

      if (positionTestInPatchCollide(cm, patch.pc)) {
        tw.trace.startsolid = tw.trace.allsolid = true;
        tw.trace.fraction = 0;
        tw.trace.contents = patch.contents;
        return;
      }
    }
  }
}

/**
 * `CM_PositionTest` (`cm_trace.c:410-445`): the box at the start against every leaf it touches,
 * widened by a unit, until one holds it. A leaf past the first `MAX_POSITION_LEAFS` is not
 * tested.
 */
function positionTest(cm: ClipMap): void {
  const tw = cm.traceWork;
  const ll = cm.leafList;

  // "Identify the leafs we are touching."
  vectorAdd(tw.start, tw.size[0], ll.bounds[0]);
  vectorAdd(tw.start, tw.size[1], ll.bounds[1]);

  for (let i = 0; i < 3; i++) {
    ll.bounds[0][i] = f(ll.bounds[0][i] - 1);
    ll.bounds[1][i] = f(ll.bounds[1][i] + 1);
  }

  ll.count = 0;
  ll.maxcount = MAX_POSITION_LEAFS;
  ll.list = tw.leafs;
  ll.lastLeaf = 0;
  ll.overflowed = false;

  cm.checkcount++;

  boxLeafnumsR(cm, ll, 0);

  cm.checkcount++;

  // "Test the contents of the leafs."
  for (let i = 0; i < ll.count; i++) {
    testInLeaf(cm, cm.leafs[tw.leafs[i]]);
    if (tw.trace.allsolid) break;
  }
}

/*
 * Tracing.
 */

/**
 * `CM_TraceThroughPatch` (`cm_trace.c:462-475`): the sweep against a patch, which gives its
 * surface flags and contents to a nearer hit.
 */
function traceThroughPatch(cm: ClipMap, patch: CPatch): void {
  const tw = cm.traceWork;

  const oldFrac = tw.trace.fraction;

  traceThroughPatchCollide(cm, patch.pc);

  if (tw.trace.fraction < oldFrac) {
    tw.trace.surfaceFlags = patch.surfaceFlags;
    tw.trace.contents = patch.contents;
  }
}

/**
 * `CM_TraceThroughBrush` (`cm_trace.c:482-662`): the sweep against a brush, each side pushed out
 * by the box's corner. A hit is where it last enters a side before it first leaves one, pulled
 * back by `SURFACE_CLIP_EPSILON`; it replaces the trace's only at a smaller fraction. A start
 * inside the brush makes the trace start solid, and all solid if the end is inside too.
 */
function traceThroughBrush(cm: ClipMap, brush: CBrush): void {
  const tw = cm.traceWork;
  let enterFrac = -1;
  let leaveFrac = 1;
  let clipplane: CPlane | null = null;

  if (!brush.numsides) return;

  let getout = false;
  let startout = false;

  let leadside: CBrushSide | null = null;

  // "Compare the trace against all planes of the brush; find the latest time the trace crosses a
  // plane towards the interior and the earliest time the trace crosses a plane towards the
  // exterior."
  for (let i = 0; i < brush.numsides; i++) {
    const side = cm.brushsides[brush.firstSide + i];
    const plane = side.plane;

    // "Adjust the plane distance appropriately for mins/maxs."
    const dist = boxPlaneDist(cm, plane);

    const d1 = f(dotProduct(tw.start, plane.normal) - dist);
    const d2 = f(dotProduct(tw.end, plane.normal) - dist);

    if (d2 > 0) getout = true; // endpoint is not in solid
    if (d1 > 0) startout = true;

    // "If completely in front of face, no intersection with the entire brush."
    if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) return;

    // "If it doesn't cross the plane, the plane isn't relevant."
    if (d1 <= 0 && d2 <= 0) continue;

    // "Crosses face."
    if (d1 > d2) {
      // Enter.
      let frac = f((d1 - SURFACE_CLIP_EPSILON) / f(d1 - d2));
      if (frac < 0) frac = 0;
      if (frac > enterFrac) {
        enterFrac = frac;
        clipplane = plane;
        leadside = side;
      }
    } else {
      // Leave.
      let frac = f((d1 + SURFACE_CLIP_EPSILON) / f(d1 - d2));
      if (frac > 1) frac = 1;
      if (frac < leaveFrac) leaveFrac = frac;
    }
  }

  // "All planes have been checked, and the trace was not completely outside the brush."
  if (!startout) {
    // "Original point was inside brush."
    tw.trace.startsolid = true;
    if (!getout) {
      tw.trace.allsolid = true;
      tw.trace.fraction = 0;
      tw.trace.contents = brush.contents;
    }
    return;
  }

  if (enterFrac < leaveFrac) {
    if (enterFrac > -1 && enterFrac < tw.trace.fraction) {
      if (enterFrac < 0) enterFrac = 0;
      tw.trace.fraction = enterFrac;
      if (clipplane !== null) copyPlane(clipplane, tw.trace.plane);
      if (leadside !== null) tw.trace.surfaceFlags = leadside.surfaceFlags;
      tw.trace.contents = brush.contents;
    }
  }
}

/**
 * `CM_TraceThroughLeaf` (`cm_trace.c:669-726`): the sweep against a leaf's brushes that its
 * bounds come near, then its patches unless `cm_noCurves`, until one stops it at its start. Each
 * is traced once a trace, though several leaves list it.
 */
function traceThroughLeaf(cm: ClipMap, leaf: CLeaf): void {
  const tw = cm.traceWork;

  // "Trace line against all brushes in the leaf."
  for (let k = 0; k < leaf.numLeafBrushes; k++) {
    const b = cm.brushes[cm.leafbrushes[leaf.firstLeafBrush + k]];
    if (b.checkcount === cm.checkcount) continue; // already checked this brush in another leaf
    b.checkcount = cm.checkcount;

    if (!(b.contents & tw.contents)) continue;

    if (!boundsIntersect(tw.bounds[0], tw.bounds[1], b.bounds[0], b.bounds[1])) continue;

    traceThroughBrush(cm, b);
    if (!tw.trace.fraction) return;
  }

  // "Trace line against all patches in the leaf."
  if (!cm.cvars.noCurves) {
    for (let k = 0; k < leaf.numLeafSurfaces; k++) {
      const patch = cm.surfaces[cm.leafsurfaces[leaf.firstLeafSurface + k]];
      if (!patch) continue;
      if (patch.checkcount === cm.checkcount) continue; // already checked in another leaf
      patch.checkcount = cm.checkcount;

      if (!(patch.contents & tw.contents)) continue;

      traceThroughPatch(cm, patch);
      if (!tw.trace.fraction) return;
    }
  }
}

/**
 * `CM_TraceThroughTree` (`cm_trace.c:1035-1137`): "traverse all the contacted leafs from the start
 * to the end position. If the trace is a point, they will be exactly in order, but for larger
 * trace volumes it is possible to hit something in a later leaf with a smaller intercept
 * fraction."
 *
 * A node's plane is widened by the box: by its extent on an axial plane, and on a slanted one by
 * 2048, "this is silly". The near side is traced first, to `SURFACE_CLIP_EPSILON` past the plane.
 *
 * @param p1f - The fraction of the whole trace at `p1`.
 * @param p2f - The fraction at `p2`.
 * @param depth - How deep the recursion is, which picks this call's `mid`.
 */
function traceThroughTree(
  cm: ClipMap,
  num: number,
  p1f: number,
  p2f: number,
  p1: Vec3f,
  p2: Vec3f,
  depth: number
): void {
  const tw = cm.traceWork;

  if (tw.trace.fraction <= p1f) return; // already hit something nearer

  // "If < 0, we are in a leaf node."
  if (num < 0) {
    traceThroughLeaf(cm, cm.leafs[-1 - num]);
    return;
  }

  // "Find the point distances to the separating plane and the offset for the size of the box."
  const node = cm.nodes[num];
  const plane = node.plane;

  // "Adjust the plane distance appropriately for mins/maxs."
  let t1: number;
  let t2: number;
  let offset: number;
  if (plane.type < 3) {
    t1 = f(p1[plane.type] - plane.dist);
    t2 = f(p2[plane.type] - plane.dist);
    offset = tw.extents[plane.type];
  } else {
    t1 = f(dotProduct(plane.normal, p1) - plane.dist);
    t2 = f(dotProduct(plane.normal, p2) - plane.dist);
    offset = tw.isPoint ? 0 : 2048;
  }

  // "See which sides we need to consider."
  if (t1 >= f(offset + 1) && t2 >= f(offset + 1)) {
    traceThroughTree(cm, node.children[0], p1f, p2f, p1, p2, depth + 1);
    return;
  }
  if (t1 < f(-offset - 1) && t2 < f(-offset - 1)) {
    traceThroughTree(cm, node.children[1], p1f, p2f, p1, p2, depth + 1);
    return;
  }

  // "Put the crosspoint SURFACE_CLIP_EPSILON pixels on the near side." `idist` is a float, and
  // each fraction a double rounded to one.
  let side: number;
  let frac: number;
  let frac2: number;
  if (t1 < t2) {
    const idist = f(1 / f(t1 - t2));
    side = 1;
    frac2 = f((f(t1 + offset) + SURFACE_CLIP_EPSILON) * idist);
    frac = f((f(t1 - offset) + SURFACE_CLIP_EPSILON) * idist);
  } else if (t1 > t2) {
    const idist = f(1 / f(t1 - t2));
    side = 0;
    frac2 = f((f(t1 - offset) - SURFACE_CLIP_EPSILON) * idist);
    frac = f((f(t1 + offset) + SURFACE_CLIP_EPSILON) * idist);
  } else {
    side = 0;
    frac = 1;
    frac2 = 0;
  }

  // "Move up to the node."
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  let midf = f(p1f + f(f(p2f - p1f) * frac));

  while (tw.mids.length <= depth) tw.mids.push(vec3f());
  const mid = tw.mids[depth];
  mid[0] = f(p1[0] + f(frac * f(p2[0] - p1[0])));
  mid[1] = f(p1[1] + f(frac * f(p2[1] - p1[1])));
  mid[2] = f(p1[2] + f(frac * f(p2[2] - p1[2])));

  traceThroughTree(cm, node.children[side], p1f, midf, p1, mid, depth + 1);

  // "Go past the node."
  if (frac2 < 0) frac2 = 0;
  if (frac2 > 1) frac2 = 1;

  midf = f(p1f + f(f(p2f - p1f) * frac2));

  mid[0] = f(p1[0] + f(frac2 * f(p2[0] - p1[0])));
  mid[1] = f(p1[1] + f(frac2 * f(p2[1] - p1[1])));
  mid[2] = f(p1[2] + f(frac2 * f(p2[2] - p1[2])));

  traceThroughTree(cm, node.children[side ^ 1], midf, p2f, mid, p2, depth + 1);
}

/**
 * `CM_Trace` (`cm_trace.c:1148-1359`), into the work's own trace: the box made even about its
 * centre, which moves the start and end with it; then a position test where the start is the
 * end, and a sweep otherwise, through the world's tree or a model's leaf.
 *
 * @param mins - The box, or `null` for a point.
 * @param maxs - The box, or `null` for a point.
 * @param model - A clip handle, or 0 for the world.
 * @param brushmask - The contents it stops at.
 */
function trace(
  cm: ClipMap,
  start: ArrayLike<number>,
  end: ArrayLike<number>,
  mins: ArrayLike<number> | null,
  maxs: ArrayLike<number> | null,
  model: number,
  brushmask: number
): void {
  const tw = cm.traceWork;

  const cmod = clipHandleToModel(cm, model);

  cm.checkcount++; // for multi-check avoidance

  // "Fill in a default trace": C clears the whole work, of which only these are read before
  // they are set.
  clearTrace(tw.trace);
  tw.isPoint = false;
  vectorClear(tw.extents);
  tw.trace.fraction = 1; // assume it goes the entire distance until shown otherwise

  if (!cm.numNodes) return; // map not loaded, shouldn't happen

  // "Set basic parms."
  tw.contents = brushmask;

  // "Adjust so that mins and maxs are always symetric, which avoids some complications with plane
  // expanding of rotated bmodels." A null box is "0,0,0".
  for (let i = 0; i < 3; i++) {
    const lo = mins ? f(mins[i]) : 0;
    const hi = maxs ? f(maxs[i]) : 0;
    const offset = f(f(lo + hi) * 0.5);
    tw.size[0][i] = f(lo - offset);
    tw.size[1][i] = f(hi - offset);
    tw.start[i] = f(f(start[i]) + offset);
    tw.end[i] = f(f(end[i]) + offset);
  }

  // "tw.offsets[signbits] = vector to appropriate corner from origin."
  for (let signbits = 0; signbits < 8; signbits++) {
    const corner = tw.offsets[signbits];
    corner[0] = tw.size[signbits & 1][0];
    corner[1] = tw.size[(signbits >> 1) & 1][1];
    corner[2] = tw.size[(signbits >> 2) & 1][2];
  }

  // "Calculate bounds."
  for (let i = 0; i < 3; i++) {
    if (tw.start[i] < tw.end[i]) {
      tw.bounds[0][i] = f(tw.start[i] + tw.size[0][i]);
      tw.bounds[1][i] = f(tw.end[i] + tw.size[1][i]);
    } else {
      tw.bounds[0][i] = f(tw.end[i] + tw.size[0][i]);
      tw.bounds[1][i] = f(tw.start[i] + tw.size[1][i]);
    }
  }

  // "Check for position test special case."
  if (f(start[0]) === f(end[0]) && f(start[1]) === f(end[1]) && f(start[2]) === f(end[2])) {
    // The capsule's handle never comes here: `clipHandleToModel` has refused it.
    if (model) {
      testInLeaf(cm, cmod.leaf);
    } else {
      positionTest(cm);
    }
  } else {
    // "Check for point special case."
    if (tw.size[0][0] === 0 && tw.size[0][1] === 0 && tw.size[0][2] === 0) {
      tw.isPoint = true;
      vectorClear(tw.extents);
    } else {
      tw.isPoint = false;
      tw.extents[0] = tw.size[1][0];
      tw.extents[1] = tw.size[1][1];
      tw.extents[2] = tw.size[1][2];
    }

    // "General sweeping through world."
    if (model) {
      traceThroughLeaf(cm, cmod.leaf);
    } else {
      traceThroughTree(cm, 0, 0, 1, tw.start, tw.end, 0);
    }
  }

  // "Generate endpos from the original, unmodified start/end."
  const endpos = tw.trace.endpos;
  for (let i = 0; i < 3; i++) {
    endpos[i] =
      tw.trace.fraction === 1
        ? f(end[i])
        : f(f(start[i]) + f(tw.trace.fraction * f(f(end[i]) - f(start[i]))));
  }
}

/**
 * `CM_BoxTrace` (`cm_trace.c:1366-1370`): a box swept from `start` to `end` through the world, or
 * through one model where it stands in the world's frame, into `results`.
 *
 * @param mins - The box, or `null` for a point.
 * @param maxs - The box, or `null` for a point.
 * @param model - A clip handle: 0 for the world, an inline model's, or the temp box's.
 * @param brushmask - The contents it stops at.
 * @throws in Q3's words for a clip handle the map has not got
 */
export function boxTrace(
  cm: ClipMap,
  results: Trace,
  start: ArrayLike<number>,
  end: ArrayLike<number>,
  mins: ArrayLike<number> | null,
  maxs: ArrayLike<number> | null,
  model: number,
  brushmask: number
): void {
  trace(cm, start, end, mins, maxs, model, brushmask);
  copyTrace(cm.traceWork.trace, results);
}

/**
 * `CM_TransformedBoxTrace` (`cm_trace.c:1380-1470`): "handles offseting and rotation of the end
 * points for moving and rotating entities". The trace is taken into the model's frame, at
 * `origin` and turned by `angles`, and swept there; a hit's normal is turned back, its distance
 * not. The box is never turned, the temp box's not at all, and "this is still incorrect for
 * bounding boxes because the actual bounding box that is swept through the model is not
 * rotated".
 *
 * @param mins - The box, or `null` for a point.
 * @param maxs - The box, or `null` for a point.
 * @param model - A clip handle: an inline model's, or the temp box's.
 * @param brushmask - The contents it stops at.
 * @param origin - Where the model is.
 * @param angles - How the model is turned: pitch, yaw and roll, in degrees.
 * @throws in Q3's words for a clip handle the map has not got
 */
export function transformedBoxTrace(
  cm: ClipMap,
  results: Trace,
  start: ArrayLike<number>,
  end: ArrayLike<number>,
  mins: ArrayLike<number> | null,
  maxs: ArrayLike<number> | null,
  model: number,
  brushmask: number,
  origin: ArrayLike<number>,
  angles: ArrayLike<number>
): void {
  const tw = cm.traceWork;
  const startL = tw.startL;
  const endL = tw.endL;
  const symetricSize = tw.symetricSize;

  // "Adjust so that mins and maxs are always symetric, which avoids some complications with plane
  // expanding of rotated bmodels."
  for (let i = 0; i < 3; i++) {
    const lo = mins ? f(mins[i]) : 0;
    const hi = maxs ? f(maxs[i]) : 0;
    const offset = f(f(lo + hi) * 0.5);
    symetricSize[0][i] = f(lo - offset);
    symetricSize[1][i] = f(hi - offset);
    startL[i] = f(f(start[i]) + offset);
    endL[i] = f(f(end[i]) + offset);
  }

  // "Subtract origin offset."
  for (let i = 0; i < 3; i++) {
    startL[i] = f(startL[i] - f(origin[i]));
    endL[i] = f(endL[i] - f(origin[i]));
  }

  // "Rotate start and end into the models frame of reference": C's test of a float, so NaN is
  // turned and −0 is not.
  const a = tw.angles;
  for (let i = 0; i < 3; i++) a[i] = f(angles[i]);
  const rotated = model !== BOX_MODEL_HANDLE && (a[0] !== 0 || a[1] !== 0 || a[2] !== 0);

  if (rotated) {
    // "Rotation on trace line (start-end) instead of rotating the bmodel."
    createRotationMatrix(a, tw.matrix);
    rotatePoint(startL, tw.matrix);
    rotatePoint(endL, tw.matrix);
  }

  // "Sweep the box through the model."
  trace(cm, startL, endL, symetricSize[0], symetricSize[1], model, brushmask);

  // "If the bmodel was rotated and there was a collision."
  const result = tw.trace;
  if (rotated && result.fraction !== 1) {
    // "Rotation of bmodel collision plane."
    transposeMatrix(tw.matrix, tw.transpose);
    rotatePoint(result.plane.normal, tw.transpose);
  }

  // "Re-calculate the end position of the trace because the trace.endpos calculated by CM_Trace
  // could be rotated and have an offset."
  for (let i = 0; i < 3; i++) {
    result.endpos[i] = f(f(start[i]) + f(result.fraction * f(f(end[i]) - f(start[i]))));
  }

  copyTrace(result, results);
}
