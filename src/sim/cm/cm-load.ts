import { MST_PATCH, type BspCollision } from '../../formats/bsp';
import { CONTENTS } from '../constants';
import {
  BOX_MODEL_HANDLE,
  MAX_SUBMODELS,
  newLeafList,
  newTraceWork,
  type CBrush,
  type CBrushSide,
  type ClipMap,
  type CLeaf,
  type CmCvars,
  type CModel,
  type CmPrint,
  type CPatch,
  type CPlane
} from './cm-local';
import { generatePatchCollide } from './cm-patch';
import { floodAreaConnections } from './cm-test';
import { f, planeTypeForNormal, signbitsForNormal, vec3f, vectorCopy } from './q-math';

/**
 * `cm_load.c`: a map's collision loaded from its BSP, and the clip handles that name what a trace
 * runs against, the map's inline models and a box.
 *
 * Not ported: the checksum of the file, which only the pure check the port has not got reads;
 * `CM_LoadMap`'s return of the server's copy to a client loading the same map, as the port's
 * server and client each load their own; the per-lump checksums nothing calls; and
 * `CM_TempBoxModel`'s capsule, which baseq3 never asks for.
 */

/** The box hull's spare room past each array's own (`cm_load.c:46-49`). */
const BOX_BRUSHES = 1;
const BOX_SIDES = 6;
const BOX_LEAFS = 2;
const BOX_PLANES = 12;

/** `MAX_PATCH_VERTS` (`cm_load.c:483`): the most control points collision takes in a patch. */
const MAX_PATCH_VERTS = 1024;

/** What the loader is told besides the map. */
export interface LoadMapOptions {
  /** Where its warnings go, as `Com_Printf`; the console by default. */
  print?: CmPrint;
  /** The cvars collision reads, by default as Q3 registers them. */
  cvars?: Partial<CmCvars>;
}

/** A plane of zeros, as the hunk leaves the box hull's until `initBoxHull` fills them. */
function zeroPlane(): CPlane {
  return { normal: vec3f(), dist: 0, type: 0, signbits: 0 };
}

/** A leaf of zeros. */
function zeroLeaf(): CLeaf {
  return {
    cluster: 0,
    area: 0,
    firstLeafBrush: 0,
    numLeafBrushes: 0,
    firstLeafSurface: 0,
    numLeafSurfaces: 0
  };
}

/** A brush of zeros, its sides from `firstSide`. */
function zeroBrush(firstSide = 0): CBrush {
  return {
    shaderNum: 0,
    contents: 0,
    bounds: [vec3f(), vec3f()],
    numsides: 0,
    firstSide,
    checkcount: 0
  };
}

/**
 * Whether `count` records from `first` lie within `length`: the check of an index Q3 never makes,
 * which it reads past.
 */
function within(first: number, count: number, length: number): boolean {
  return first >= 0 && count >= 0 && first + count <= length;
}

/**
 * A clip map of nothing, as `CM_LoadMap`'s `memset` leaves one before its loaders fill it.
 *
 * @param name - Its path, for messages.
 * @param cvars - The cvars collision reads, by default as Q3 registers them.
 */
function clearMap(name: string, cvars: Partial<CmCvars> = {}): ClipMap {
  return {
    name,
    shaders: [],
    numShaders: 0,
    brushsides: [],
    numBrushSides: 0,
    planes: [],
    numPlanes: 0,
    nodes: [],
    numNodes: 0,
    leafs: [],
    numLeafs: 0,
    leafbrushes: new Int32Array(0),
    numLeafBrushes: 0,
    leafsurfaces: new Int32Array(0),
    numLeafSurfaces: 0,
    cmodels: [],
    numSubModels: 0,
    brushes: [],
    numBrushes: 0,
    numClusters: 0,
    clusterBytes: 0,
    visibility: new Uint8Array(0),
    vised: false,
    entityString: '',
    numAreas: 0,
    areas: [],
    areaPortals: new Int32Array(0),
    numSurfaces: 0,
    surfaces: [],
    floodvalid: 0,
    checkcount: 0,
    boxModel: { mins: vec3f(), maxs: vec3f(), leaf: zeroLeaf() },
    boxPlanes: 0,
    boxBrush: zeroBrush(),
    cvars: { noAreas: 0, noCurves: 0, playerCurveClip: 1, ...cvars },
    traceWork: newTraceWork(),
    leafList: newLeafList()
  };
}

/**
 * `CM_LoadMap` (`cm_load.c:569-661`): collision's loaders, in Q3's order, over a BSP
 * `parseBspCollision` has read and checked. Then the box hull is set up and the areas are flooded.
 *
 * @param bsp - The map, read.
 * @param name - Its path, as `maps/<name>.bsp`, for messages.
 * @param options - Where warnings go, and the cvars.
 * @throws in Q3's words for an empty name, a patch of more than 1024 control points, and the
 *   patches' own limits; in the port's own for an index into one of the map's arrays that lies
 *   outside it, which Q3 reads past
 */
export function loadMap(bsp: BspCollision, name: string, options: LoadMapOptions = {}): ClipMap {
  if (!name) throw new Error('CM_LoadMap: NULL name');
  const print = options.print ?? ((text: string) => console.warn(text.trimEnd()));
  const refuse = (what: string): never => {
    throw new Error(`CM_LoadMap: ${name}'s ${what}, which the map has not got`);
  };

  const cm = clearMap(name, options.cvars);

  // Each inline model's brushes and surfaces are listed after the map's own, and the box's.
  const sum = (field: 'numBrushes' | 'numSurfaces') =>
    bsp.models.slice(1).reduce((total, model) => total + Math.max(model[field], 0), 0);

  // CMod_LoadShaders (`cm_load.c:90-113`).
  cm.shaders = bsp.shaders;
  cm.numShaders = bsp.shaders.length;

  // CMod_LoadLeafs (`cm_load.c:269-305`): the clusters and areas are counted from the leafs.
  cm.numLeafs = bsp.leafs.length;
  for (const [i, leaf] of bsp.leafs.entries()) {
    if (!within(leaf.firstLeafBrush, leaf.numLeafBrushes, bsp.leafBrushes.length)) {
      refuse(`leaf ${i}'s leaf brushes ${leaf.firstLeafBrush} on`);
    }
    if (!within(leaf.firstLeafSurface, leaf.numLeafSurfaces, bsp.leafSurfaces.length)) {
      refuse(`leaf ${i}'s leaf surfaces ${leaf.firstLeafSurface} on`);
    }
    cm.leafs.push({
      cluster: leaf.cluster,
      area: leaf.area,
      firstLeafBrush: leaf.firstLeafBrush,
      numLeafBrushes: leaf.numLeafBrushes,
      firstLeafSurface: leaf.firstLeafSurface,
      numLeafSurfaces: leaf.numLeafSurfaces
    });
    if (leaf.cluster >= cm.numClusters) cm.numClusters = leaf.cluster + 1;
    if (leaf.area >= cm.numAreas) cm.numAreas = leaf.area + 1;
  }
  for (let i = 0; i < BOX_LEAFS; i++) cm.leafs.push(zeroLeaf());
  cm.areas = Array.from({ length: cm.numAreas }, () => ({ floodnum: 0, floodvalid: 0 }));
  cm.areaPortals = new Int32Array(cm.numAreas * cm.numAreas);

  // CMod_LoadLeafBrushes (`cm_load.c:353-373`), with room for the box's and the models'.
  cm.numLeafBrushes = bsp.leafBrushes.length;
  cm.leafbrushes = new Int32Array(cm.numLeafBrushes + BOX_BRUSHES + sum('numBrushes'));
  for (const [i, brush] of bsp.leafBrushes.entries()) {
    if (!within(brush, 1, bsp.brushes.length)) refuse(`leaf brush ${i}'s brush ${brush}`);
    cm.leafbrushes[i] = brush;
  }

  // CMod_LoadLeafSurfaces (`cm_load.c:380-400`), with room for the models'.
  cm.numLeafSurfaces = bsp.leafSurfaces.length;
  cm.leafsurfaces = new Int32Array(cm.numLeafSurfaces + sum('numSurfaces'));
  for (const [i, surface] of bsp.leafSurfaces.entries()) {
    if (!within(surface, 1, bsp.surfaces.length)) {
      refuse(`leaf surface ${i}'s surface ${surface}`);
    }
    cm.leafsurfaces[i] = surface;
  }

  // CMod_LoadPlanes (`cm_load.c:312-346`).
  cm.numPlanes = bsp.planes.length;
  for (const plane of bsp.planes) {
    const normal = vec3f(...plane.normal);
    cm.planes.push({
      normal,
      dist: plane.dist,
      type: planeTypeForNormal(normal),
      signbits: signbitsForNormal(normal)
    });
  }
  for (let i = 0; i < BOX_PLANES; i++) cm.planes.push(zeroPlane());

  // CMod_LoadBrushSides (`cm_load.c:407-435`): each side's surface flags from its shader.
  cm.numBrushSides = bsp.brushSides.length;
  for (const [i, side] of bsp.brushSides.entries()) {
    if (!within(side.planeNum, 1, cm.numPlanes)) {
      refuse(`brush side ${i}'s plane ${side.planeNum}`);
    }
    cm.brushsides.push({
      plane: cm.planes[side.planeNum],
      shaderNum: side.shaderNum,
      surfaceFlags: cm.shaders[side.shaderNum].surfaceFlags
    });
  }
  for (let i = 0; i < BOX_SIDES; i++) {
    cm.brushsides.push({ plane: cm.planes[0], shaderNum: 0, surfaceFlags: 0 });
  }

  // CMod_LoadBrushes (`cm_load.c:233-262`): each brush's contents from its shader.
  cm.numBrushes = bsp.brushes.length;
  for (const [i, brush] of bsp.brushes.entries()) {
    // CM_BoundBrush reads the first six sides, however many the brush has.
    if (!within(brush.firstSide, Math.max(brush.numSides, 6), cm.numBrushSides)) {
      refuse(`brush ${i}'s sides ${brush.firstSide} on`);
    }
    const out = zeroBrush(brush.firstSide);
    out.numsides = brush.numSides;
    out.shaderNum = brush.shaderNum;
    out.contents = cm.shaders[brush.shaderNum].contentFlags;
    boundBrush(cm, out);
    cm.brushes.push(out);
  }
  cm.brushes.push(zeroBrush());

  // CMod_LoadSubmodels (`cm_load.c:121-170`): each model's bounds spread by a unit, and each
  // inline model's brushes and surfaces made a leaf of its own.
  cm.numSubModels = bsp.models.length;
  if (cm.numSubModels > MAX_SUBMODELS) throw new Error('MAX_SUBMODELS exceeded');
  let nextLeafBrush = cm.numLeafBrushes + BOX_BRUSHES;
  let nextLeafSurface = cm.numLeafSurfaces;
  for (const [i, model] of bsp.models.entries()) {
    const out: CModel = { mins: vec3f(), maxs: vec3f(), leaf: zeroLeaf() };
    for (let j = 0; j < 3; j++) {
      // "Spread the mins / maxs by a pixel."
      out.mins[j] = f(model.mins[j] - 1);
      out.maxs[j] = f(model.maxs[j] + 1);
    }
    cm.cmodels.push(out);
    if (i === 0) continue; // "world model doesn't need other info"

    if (!within(model.firstBrush, model.numBrushes, cm.numBrushes)) {
      refuse(`model ${i}'s brushes ${model.firstBrush} on`);
    }
    out.leaf.numLeafBrushes = model.numBrushes;
    out.leaf.firstLeafBrush = nextLeafBrush;
    for (let j = 0; j < model.numBrushes; j++) {
      cm.leafbrushes[nextLeafBrush++] = model.firstBrush + j;
    }

    if (!within(model.firstSurface, model.numSurfaces, bsp.surfaces.length)) {
      refuse(`model ${i}'s surfaces ${model.firstSurface} on`);
    }

    out.leaf.numLeafSurfaces = model.numSurfaces;
    out.leaf.firstLeafSurface = nextLeafSurface;
    for (let j = 0; j < model.numSurfaces; j++) {
      cm.leafsurfaces[nextLeafSurface++] = model.firstSurface + j;
    }
  }

  // CMod_LoadNodes (`cm_load.c:179-207`).
  cm.numNodes = bsp.nodes.length;
  for (const [i, node] of bsp.nodes.entries()) {
    if (!within(node.planeNum, 1, cm.numPlanes)) refuse(`node ${i}'s plane ${node.planeNum}`);
    for (const child of node.children) {
      const inside = child >= 0 ? child < cm.numNodes : -1 - child < cm.numLeafs;
      if (!inside) refuse(`node ${i}'s child ${child}`);
    }
    cm.nodes.push({ plane: cm.planes[node.planeNum], children: [...node.children] });
  }

  // CMod_LoadEntityString (`cm_load.c:443-447`).
  cm.entityString = bsp.entityString;

  // CMod_LoadVisibility (`cm_load.c:455-473`): a map without it sees every cluster from each.
  if (!bsp.visibility) {
    cm.clusterBytes = (cm.numClusters + 31) & ~31;
    cm.visibility = new Uint8Array(cm.clusterBytes).fill(255);
  } else {
    cm.vised = true;
    cm.visibility = bsp.visibility.data;
    cm.numClusters = bsp.visibility.numClusters;
    cm.clusterBytes = bsp.visibility.clusterBytes;
  }

  // CMod_LoadPatches (`cm_load.c:484-537`): "only load patches, not planar faces".
  cm.numSurfaces = bsp.surfaces.length;
  cm.surfaces = new Array<CPatch | null>(cm.numSurfaces).fill(null);
  const numDrawVerts = bsp.drawVerts.xyz.length / 3;
  for (const [i, surface] of bsp.surfaces.entries()) {
    if (surface.surfaceType !== MST_PATCH) continue; // ignore other surfaces

    const width = surface.patchWidth;
    const height = surface.patchHeight;
    const c = width * height;
    if (c > MAX_PATCH_VERTS) throw new Error('ParseMesh: MAX_PATCH_VERTS');
    if (!within(surface.firstVert, c, numDrawVerts)) refuse(`surface ${i}'s vertices`);
    const points = bsp.drawVerts.xyz.subarray(surface.firstVert * 3, (surface.firstVert + c) * 3);

    if (!within(surface.shaderNum, 1, cm.numShaders)) refuse(`surface ${i}'s shader`);
    const shader = cm.shaders[surface.shaderNum];
    cm.surfaces[i] = {
      checkcount: 0,
      contents: shader.contentFlags,
      surfaceFlags: shader.surfaceFlags,
      // "Create the internal facet structure."
      pc: generatePatchCollide(width, height, points, print)
    };
  }

  initBoxHull(cm);
  floodAreaConnections(cm);
  return cm;
}

/**
 * `CM_LoadMap`'s map of no name (`cm_load.c:599-606`): one leaf, one cluster and one area, and
 * a world model of nothing. Q3 never reaches it, as the check of the name above it refuses an
 * empty one, and it would leave out the box hull and every node, from which `CM_Trace` returns at
 * once (`cm_trace.c:1166`). The port's has a node, both its sides the one leaf, and the hull set
 * up as a map's load sets it, so the temp box is swept through it as through any map's.
 */
export function emptyClipMap(): ClipMap {
  const cm = clearMap('');
  cm.numLeafs = 1;
  cm.numClusters = 1;
  cm.numAreas = 1;
  cm.cmodels = [{ mins: vec3f(), maxs: vec3f(), leaf: zeroLeaf() }];
  cm.areas = [{ floodnum: 0, floodvalid: 0 }];
  cm.areaPortals = new Int32Array(1);
  cm.numPlanes = 1;
  cm.numNodes = 1;
  // The hull's room, past the node's plane and arrays of none.
  cm.leafs = Array.from({ length: cm.numLeafs + BOX_LEAFS }, () => zeroLeaf());
  cm.leafbrushes = new Int32Array(BOX_BRUSHES);
  cm.planes = Array.from({ length: cm.numPlanes + BOX_PLANES }, () => zeroPlane());
  cm.nodes = [{ plane: cm.planes[0], children: [-1, -1] }];
  cm.brushsides = Array.from({ length: BOX_SIDES }, () => ({
    plane: cm.planes[0],
    shaderNum: 0,
    surfaceFlags: 0
  }));
  cm.brushes = [zeroBrush()];
  initBoxHull(cm);
  return cm;
}

/**
 * `CM_BoundBrush` (`cm_load.c:215-224`): a brush's bounds from its first six sides, which q3map
 * writes as −x, +x, −y, +y, −z and +z.
 */
function boundBrush(cm: ClipMap, b: CBrush): void {
  const side = (n: number) => cm.brushsides[b.firstSide + n].plane.dist;
  b.bounds[0][0] = -side(0);
  b.bounds[1][0] = side(1);
  b.bounds[0][1] = -side(2);
  b.bounds[1][1] = side(3);
  b.bounds[0][2] = -side(4);
  b.bounds[1][2] = side(5);
}

/**
 * `CM_InitBoxHull` (`cm_load.c:747-790`): "set up the planes and nodes so that the six floats of
 * a bounding box can just be stored out and get a proper clipping hull structure". The box is a
 * brush of `CONTENTS_BODY` past the map's own, its sides +x, −x, +y, −y, +z and −z on twelve
 * planes, two an axis each way. Its negative planes are typed 3 and on, so the trace takes them
 * as it takes a slanted plane.
 */
function initBoxHull(cm: ClipMap): void {
  cm.boxPlanes = cm.numPlanes;

  const brush = cm.brushes[cm.numBrushes];
  brush.numsides = 6;
  brush.firstSide = cm.numBrushSides;
  brush.contents = CONTENTS.BODY;
  cm.boxBrush = brush;

  cm.boxModel.leaf.numLeafBrushes = 1;
  cm.boxModel.leaf.firstLeafBrush = cm.numLeafBrushes;
  cm.leafbrushes[cm.numLeafBrushes] = cm.numBrushes;

  for (let i = 0; i < 6; i++) {
    const side = i & 1;

    // Brush sides.
    const s: CBrushSide = cm.brushsides[cm.numBrushSides + i];
    s.plane = cm.planes[cm.numPlanes + i * 2 + side];
    s.surfaceFlags = 0;

    // Planes.
    let p = cm.planes[cm.boxPlanes + i * 2];
    p.type = i >> 1;
    p.signbits = 0;
    p.normal = vec3f();
    p.normal[i >> 1] = 1;

    p = cm.planes[cm.boxPlanes + i * 2 + 1];
    p.type = 3 + (i >> 1);
    p.normal = vec3f();
    p.normal[i >> 1] = -1;
    p.signbits = signbitsForNormal(p.normal);
  }
}

/**
 * `CM_ClipHandleToModel` (`cm_load.c:678-696`): the model a clip handle names, an inline model's
 * number or the box's.
 *
 * @throws in Q3's words for any other handle, `CAPSULE_MODEL_HANDLE` among them
 */
export function clipHandleToModel(cm: ClipMap, handle: number): CModel {
  if (handle < 0) throw new Error(`CM_ClipHandleToModel: bad handle ${handle}`);
  if (handle < cm.numSubModels) return cm.cmodels[handle];
  if (handle === BOX_MODEL_HANDLE) return cm.boxModel;
  if (handle < MAX_SUBMODELS) {
    throw new Error(
      `CM_ClipHandleToModel: bad handle ${cm.numSubModels} < ${handle} < ${MAX_SUBMODELS}`
    );
  }
  throw new Error(`CM_ClipHandleToModel: bad handle ${handle + MAX_SUBMODELS}`);
}

/**
 * `CM_InlineModel` (`cm_load.c:703-708`): the clip handle of inline model `index`, `*index` in
 * the entities' `model` keys; 0 is the world.
 *
 * @throws in Q3's words for a model the map has not got
 */
export function inlineModel(cm: ClipMap, index: number): number {
  if (index < 0 || index >= cm.numSubModels) throw new Error('CM_InlineModel: bad number');
  return index;
}

/** `CM_NumInlineModels` (`cm_load.c:714-716`), the world among them. */
export function numInlineModels(cm: ClipMap): number {
  return cm.numSubModels;
}

/** `CM_EntityString` (`cm_load.c:718-720`). */
export function entityString(cm: ClipMap): string {
  return cm.entityString;
}

/**
 * `CM_LeafCluster` (`cm_load.c:722-727`): −1 for a leaf in the world's solid.
 *
 * @throws in Q3's words for a leaf the map has not got
 */
export function leafCluster(cm: ClipMap, leafnum: number): number {
  if (leafnum < 0 || leafnum >= cm.numLeafs) throw new Error('CM_LeafCluster: bad number');
  return cm.leafs[leafnum].cluster;
}

/**
 * `CM_LeafArea` (`cm_load.c:729-734`): −1 for a leaf in the world's solid.
 *
 * @throws in Q3's words for a leaf the map has not got
 */
export function leafArea(cm: ClipMap, leafnum: number): number {
  if (leafnum < 0 || leafnum >= cm.numLeafs) throw new Error('CM_LeafArea: bad number');
  return cm.leafs[leafnum].area;
}

/**
 * `CM_TempBoxModel` (`cm_load.c:801-827`): the box hull set to these bounds, "to keep everything
 * totally uniform", so a trace meets a box as it meets any brush. There is one box, and each call
 * moves it. The bounds are taken as the floats C's `vec3_t` would hold.
 *
 * @returns `BOX_MODEL_HANDLE`
 */
export function tempBoxModel(
  cm: ClipMap,
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>
): number {
  const box = cm.boxModel;
  for (let i = 0; i < 3; i++) {
    box.mins[i] = f(mins[i]);
    box.maxs[i] = f(maxs[i]);
  }

  const planes = cm.planes;
  const p = cm.boxPlanes;
  planes[p].dist = box.maxs[0];
  planes[p + 1].dist = -box.maxs[0];
  planes[p + 2].dist = box.mins[0];
  planes[p + 3].dist = -box.mins[0];
  planes[p + 4].dist = box.maxs[1];
  planes[p + 5].dist = -box.maxs[1];
  planes[p + 6].dist = box.mins[1];
  planes[p + 7].dist = -box.mins[1];
  planes[p + 8].dist = box.maxs[2];
  planes[p + 9].dist = -box.maxs[2];
  planes[p + 10].dist = box.mins[2];
  planes[p + 11].dist = -box.mins[2];

  vectorCopy(box.mins, cm.boxBrush.bounds[0]);
  vectorCopy(box.maxs, cm.boxBrush.bounds[1]);

  return BOX_MODEL_HANDLE;
}

/** `CM_ModelBounds` (`cm_load.c:834-840`): a clip handle's bounds, copied out. */
export function modelBounds(cm: ClipMap, model: number, mins: number[], maxs: number[]): void {
  const cmod = clipHandleToModel(cm, model);
  vectorCopy(cmod.mins, mins);
  vectorCopy(cmod.maxs, maxs);
}
