import { SURFACE_CLIP_EPSILON } from '../constants';
import { BOX_MODEL_HANDLE, type CLeaf, type ClipMap, type LeafList } from './cm-local';
import { clipHandleToModel } from './cm-load';
import { angleVectors, boxOnPlaneSide, dotProduct, f, vectorCopy } from './q-math';

/**
 * `cm_test.c`: the leaf a point is in and the leaves a box touches, the contents at a point, the
 * clusters a cluster sees, and the area portals.
 *
 * Each point and box a caller passes is taken as the floats C's `vec3_t` would hold.
 *
 * Not ported: `CM_StoreBrushes` and `CM_BoxBrushes`, which nothing calls, and the count of point
 * lookups `com_showtrace` prints.
 */

/**
 * `CM_PointLeafnum_r` (`cm_test.c:31-54`): down the tree from node `num` to the leaf holding `p`,
 * a point on a plane going to its front.
 */
function pointLeafnumR(cm: ClipMap, p: ArrayLike<number>, num: number): number {
  while (num >= 0) {
    const node = cm.nodes[num];
    const plane = node.plane;

    const d =
      plane.type < 3
        ? f(p[plane.type] - plane.dist)
        : f(dotProduct(plane.normal, p) - plane.dist);
    num = d < 0 ? node.children[1] : node.children[0];
  }

  return -1 - num;
}

/** `CM_PointLeafnum` (`cm_test.c:56-61`): the leaf holding `p`. */
export function pointLeafnum(cm: ClipMap, p: ArrayLike<number>): number {
  if (!cm.numNodes) return 0; // map not loaded
  const point = cm.traceWork.point;
  for (let i = 0; i < 3; i++) point[i] = f(p[i]);
  return pointLeafnumR(cm, point, 0);
}

/**
 * `CM_StoreLeafs` (`cm_test.c:73-88`): a leaf the search reached, added while the list has room.
 * A leaf with a cluster is the last leaf "even if the list is overflowed".
 */
function storeLeafs(cm: ClipMap, ll: LeafList, nodenum: number): void {
  const leafNum = -1 - nodenum;

  if (cm.leafs[leafNum].cluster !== -1) ll.lastLeaf = leafNum;

  if (ll.count >= ll.maxcount) {
    ll.overflowed = true;
    return;
  }
  ll.list[ll.count++] = leafNum;
}

/**
 * `CM_BoxLeafnums_r` (`cm_test.c:140-165`): every leaf under node `nodenum` that the list's box
 * touches, by `BoxOnPlaneSide`, front first where it goes down both sides.
 */
export function boxLeafnumsR(cm: ClipMap, ll: LeafList, nodenum: number): void {
  for (;;) {
    if (nodenum < 0) {
      storeLeafs(cm, ll, nodenum);
      return;
    }

    const node = cm.nodes[nodenum];
    const s = boxOnPlaneSide(ll.bounds[0], ll.bounds[1], node.plane);
    if (s === 1) {
      nodenum = node.children[0];
    } else if (s === 2) {
      nodenum = node.children[1];
    } else {
      // Go down both.
      boxLeafnumsR(cm, ll, node.children[0]);
      nodenum = node.children[1];
    }
  }
}

/**
 * `CM_BoxLeafnums` (`cm_test.c:172-190`): the leaves a box touches, the first `listsize` of them
 * in `list`.
 *
 * @param lastLeaf - Given the last leaf with a cluster that the box touches, stored or not, or 0.
 * @returns How many leaves were stored
 * @throws in the port's words for a list shorter than `listsize`, which C would write past
 */
export function boxLeafnums(
  cm: ClipMap,
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
  list: Int32Array,
  listsize: number,
  lastLeaf: { value: number }
): number {
  if (listsize > list.length) {
    throw new Error(`CM_BoxLeafnums: a list of ${list.length} given room for ${listsize}`);
  }
  const ll = cm.leafList;

  cm.checkcount++;

  for (let i = 0; i < 3; i++) {
    ll.bounds[0][i] = f(mins[i]);
    ll.bounds[1][i] = f(maxs[i]);
  }
  ll.count = 0;
  ll.maxcount = listsize;
  ll.list = list;
  ll.lastLeaf = 0;
  ll.overflowed = false;

  boxLeafnumsR(cm, ll, 0);

  lastLeaf.value = ll.lastLeaf;
  return ll.count;
}

/**
 * `CM_PointContents` (`cm_test.c:226-273`): the contents of every brush that holds `p`, OR'd, in
 * the world's leaf there or in a model's. A point on a brush's side is inside it, and patches have
 * no contents here.
 *
 * @param model - A clip handle, or 0 for the world.
 */
export function pointContents(cm: ClipMap, p: ArrayLike<number>, model: number): number {
  if (!cm.numNodes) return 0; // map not loaded

  const point = cm.traceWork.point;
  for (let i = 0; i < 3; i++) point[i] = f(p[i]);

  let leaf: CLeaf;
  if (model) {
    leaf = clipHandleToModel(cm, model).leaf;
  } else {
    leaf = cm.leafs[pointLeafnumR(cm, point, 0)];
  }

  let contents = 0;
  for (let k = 0; k < leaf.numLeafBrushes; k++) {
    const b = cm.brushes[cm.leafbrushes[leaf.firstLeafBrush + k]];

    if (!boundsIntersectPoint(b.bounds[0], b.bounds[1], point)) continue;

    // "See if the point is in the brush."
    let i = 0;
    for (; i < b.numsides; i++) {
      const plane = cm.brushsides[b.firstSide + i].plane;
      if (dotProduct(point, plane.normal) > plane.dist) break;
    }

    if (i === b.numsides) contents |= b.contents;
  }

  return contents;
}

/**
 * `CM_TransformedPointContents` (`cm_test.c:283-304`): `pointContents` of a model moved to
 * `origin` and turned by `angles`, the point taken into the model's frame. The box is never
 * turned.
 */
export function transformedPointContents(
  cm: ClipMap,
  p: ArrayLike<number>,
  model: number,
  origin: ArrayLike<number>,
  angles: ArrayLike<number>
): number {
  const tw = cm.traceWork;
  const pL = tw.pointL;

  // "Subtract origin offset."
  for (let i = 0; i < 3; i++) pL[i] = f(f(p[i]) - f(origin[i]));

  // "Rotate start and end into the models frame of reference."
  const a = tw.angles;
  for (let i = 0; i < 3; i++) a[i] = f(angles[i]);
  // C's test of a float, so NaN is turned and −0 is not.
  if (model !== BOX_MODEL_HANDLE && (a[0] !== 0 || a[1] !== 0 || a[2] !== 0)) {
    angleVectors(a, tw.forward, tw.right, tw.up);

    vectorCopy(pL, tw.temp);
    pL[0] = dotProduct(tw.temp, tw.forward);
    pL[1] = -dotProduct(tw.temp, tw.right);
    pL[2] = dotProduct(tw.temp, tw.up);
  }

  return pointContents(cm, pL, model);
}

/**
 * `CM_ClusterPVS` (`cm_test.c:316-322`): where in `cm.visibility` a cluster's row of
 * `clusterBytes` starts, a bit for each cluster it can see. A cluster outside the map's, or any
 * on a map without visibility, gets the first row.
 */
export function clusterPVS(cm: ClipMap, cluster: number): number {
  if (cluster < 0 || cluster >= cm.numClusters || !cm.vised) return 0;
  return cluster * cm.clusterBytes;
}

/**
 * `CM_BoundsIntersect` (`cm_test.c:488-501`): whether two boxes overlap, or come within
 * `SURFACE_CLIP_EPSILON` of it.
 */
export function boundsIntersect(
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
  mins2: ArrayLike<number>,
  maxs2: ArrayLike<number>
): boolean {
  return !(
    maxs[0] < mins2[0] - SURFACE_CLIP_EPSILON ||
    maxs[1] < mins2[1] - SURFACE_CLIP_EPSILON ||
    maxs[2] < mins2[2] - SURFACE_CLIP_EPSILON ||
    mins[0] > maxs2[0] + SURFACE_CLIP_EPSILON ||
    mins[1] > maxs2[1] + SURFACE_CLIP_EPSILON ||
    mins[2] > maxs2[2] + SURFACE_CLIP_EPSILON
  );
}

/**
 * `CM_BoundsIntersectPoint` (`cm_test.c:508-521`): whether a point is in a box, or within
 * `SURFACE_CLIP_EPSILON` of it.
 */
export function boundsIntersectPoint(
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
  point: ArrayLike<number>
): boolean {
  return !(
    maxs[0] < point[0] - SURFACE_CLIP_EPSILON ||
    maxs[1] < point[1] - SURFACE_CLIP_EPSILON ||
    maxs[2] < point[2] - SURFACE_CLIP_EPSILON ||
    mins[0] > point[0] + SURFACE_CLIP_EPSILON ||
    mins[1] > point[1] + SURFACE_CLIP_EPSILON ||
    mins[2] > point[2] + SURFACE_CLIP_EPSILON
  );
}

/*
 * The area portals: which areas a map's open doors join. An area is a part of the map that
 * areaportal brushes close off; a door over one opens it while it is not closed, and two areas
 * are connected when a chain of open portals joins them. Each area holds the number of the flood
 * that reached it, so connected areas share one.
 */

/**
 * `CM_FloodArea_r` (`cm_test.c:334-355`): `floodnum` given to an area and every area its open
 * portals reach.
 *
 * @throws in Q3's words for an area already flooded this time under another number
 */
function floodArea(cm: ClipMap, areaNum: number, floodnum: number): void {
  const area = cm.areas[areaNum];

  if (area.floodvalid === cm.floodvalid) {
    if (area.floodnum === floodnum) return;
    throw new Error('FloodArea_r: reflooded');
  }

  area.floodnum = floodnum;
  area.floodvalid = cm.floodvalid;
  const con = areaNum * cm.numAreas;
  for (let i = 0; i < cm.numAreas; i++) {
    if (cm.areaPortals[con + i] > 0) floodArea(cm, i, floodnum);
  }
}

/** `CM_FloodAreaConnections` (`cm_test.c:363-381`): every area flooded again, in order. */
export function floodAreaConnections(cm: ClipMap): void {
  // "All current floods are now invalid."
  cm.floodvalid++;
  let floodnum = 0;

  for (let i = 0; i < cm.numAreas; i++) {
    if (cm.areas[i].floodvalid === cm.floodvalid) continue; // already flooded into
    floodnum++;
    floodArea(cm, i, floodnum);
  }
}

/**
 * `CM_AdjustAreaPortalState` (`cm_test.c:389-410`): the portal between two areas opened or
 * closed once more, counted, so two doors over one portal keep it open until both close. An area
 * of −1, outside the world, changes nothing.
 *
 * @throws in Q3's words for an area the map has not got, or a portal closed more than opened
 */
export function adjustAreaPortalState(
  cm: ClipMap,
  area1: number,
  area2: number,
  open: boolean
): void {
  if (area1 < 0 || area2 < 0) return;

  if (area1 >= cm.numAreas || area2 >= cm.numAreas) {
    throw new Error('CM_ChangeAreaPortalState: bad area number');
  }

  const there = area1 * cm.numAreas + area2;
  const back = area2 * cm.numAreas + area1;
  if (open) {
    cm.areaPortals[there]++;
    cm.areaPortals[back]++;
  } else {
    cm.areaPortals[there]--;
    cm.areaPortals[back]--;
    if (cm.areaPortals[back] < 0) {
      throw new Error('CM_AdjustAreaPortalState: negative reference count');
    }
  }

  floodAreaConnections(cm);
}

/**
 * `CM_AreasConnected` (`cm_test.c:418-437`): whether a chain of open portals joins two areas.
 * Always, under `cm_noAreas`; never, for an area of −1.
 *
 * @throws in Q3's words for an area the map has not got
 */
export function areasConnected(cm: ClipMap, area1: number, area2: number): boolean {
  if (cm.cvars.noAreas) return true;

  if (area1 < 0 || area2 < 0) return false;

  if (area1 >= cm.numAreas || area2 >= cm.numAreas) throw new Error('area >= cm.numAreas');

  return cm.areas[area1].floodnum === cm.areas[area2].floodnum;
}

/**
 * `CM_WriteAreaBits` (`cm_test.c:454-481`): a bit OR'd into `buffer` for each area in `area`'s
 * flood, so several viewpoints' bits make their union. Every bit is set for an area of −1, or
 * under `cm_noAreas`, "for debugging, send everything".
 *
 * @returns The bytes the bits take, `(numAreas + 7) >> 3`
 * @throws in the port's words for an area the map has not got, which Q3 reads past its areas for
 */
export function writeAreaBits(cm: ClipMap, buffer: Uint8Array, area: number): number {
  const bytes = (cm.numAreas + 7) >> 3;

  if (cm.cvars.noAreas || area === -1) {
    buffer.fill(255, 0, bytes);
  } else {
    if (area < 0 || area >= cm.numAreas) {
      throw new Error(`CM_WriteAreaBits: area ${area} is not one of the map's ${cm.numAreas}`);
    }
    const floodnum = cm.areas[area].floodnum;
    for (let i = 0; i < cm.numAreas; i++) {
      if (cm.areas[i].floodnum === floodnum) buffer[i >> 3] |= 1 << (i & 7);
    }
  }

  return bytes;
}
