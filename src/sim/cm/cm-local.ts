import type { BspShader } from '../../formats/bsp';
import { vec3f, type Vec3f, type Vec4f } from './q-math';

/**
 * Collision's structures, as `cm_local.h` (`:27-129`) and `cm_patch.h` (`:63-96`) lay them out.
 *
 * Where C keeps a pointer into one of the clip map's arrays, the port keeps the index, so a
 * brush's `sides` pointer is `firstSide` into `brushsides`. A plane is shared by reference, as
 * the pointers share it, so the box hull's planes move with `tempBoxModel`.
 */

/** `MAX_SUBMODELS` (`cm_local.h:27`). */
export const MAX_SUBMODELS = 256;

/** `BOX_MODEL_HANDLE` (`cm_local.h:28`): the clip handle of `tempBoxModel`'s box. */
export const BOX_MODEL_HANDLE = 255;

/**
 * `CAPSULE_MODEL_HANDLE` (`cm_local.h:29`). The capsule is not ported, since baseq3 never asks
 * for one, but its handle stays one `clipHandleToModel` refuses, as Q3's does.
 */
export const CAPSULE_MODEL_HANDLE = 254;

/** `cplane_t` (`q_shared.h:1000-1006`). */
export interface CPlane {
  normal: Vec3f;
  dist: number;
  /** `PLANE_X`, `PLANE_Y` or `PLANE_Z` for a normal of +1 on that axis, else 3 or more. */
  type: number;
  /** A bit for each negative component of the normal. */
  signbits: number;
}

/** `cNode_t` (`cm_local.h:32-35`). */
export interface CNode {
  plane: CPlane;
  /** A node's number, or a leaf's as `-(leaf + 1)`. */
  children: [number, number];
}

/** `cLeaf_t` (`cm_local.h:37-46`). */
export interface CLeaf {
  cluster: number;
  area: number;
  /** Into the clip map's `leafbrushes`. */
  firstLeafBrush: number;
  numLeafBrushes: number;
  /** Into the clip map's `leafsurfaces`. */
  firstLeafSurface: number;
  numLeafSurfaces: number;
}

/** `cmodel_t` (`cm_local.h:48-51`). */
export interface CModel {
  mins: Vec3f;
  maxs: Vec3f;
  /** "Submodels don't reference the main tree": a model's brushes and surfaces, as a leaf. */
  leaf: CLeaf;
}

/** `cbrushside_t` (`cm_local.h:53-57`). */
export interface CBrushSide {
  plane: CPlane;
  surfaceFlags: number;
  shaderNum: number;
}

/** `cbrush_t` (`cm_local.h:59-66`). */
export interface CBrush {
  /** The shader that determined the contents. */
  shaderNum: number;
  contents: number;
  bounds: [Vec3f, Vec3f];
  numsides: number;
  /** Into the clip map's `brushsides`: C's `sides` pointer. */
  firstSide: number;
  /** The trace that last tested it, so a brush in several leaves is tested once. */
  checkcount: number;
}

/** `patchPlane_t` (`cm_patch.h:66-69`). */
export interface PatchPlane {
  /** A normal and a distance. */
  plane: [number, number, number, number];
  /** `signx + (signy<<1) + (signz<<2)`. */
  signbits: number;
}

/** `MAX_FACETS` and `MAX_PATCH_PLANES` (`cm_patch.h:63-64`), each a patch. */
export const MAX_FACETS = 1024;
export const MAX_PATCH_PLANES = 4096;

/** Borders a facet has room for: its 3 or 4 edges, 6 axial bevels and 16 edge bevels. */
export const MAX_FACET_BORDERS = 4 + 6 + 16;

/** `facet_t` (`cm_patch.h:71-77`). */
export interface Facet {
  /** Into the patch's planes. */
  surfacePlane: number;
  numBorders: number;
  /** Into the patch's planes, or −1. */
  borderPlanes: Int32Array;
  /** Whether each border faces in, which flips its plane. */
  borderInward: Int32Array;
  /** Whether each border was a neighbour's coplanar plane. Written, and read by nothing. */
  borderNoAdjust: Int32Array;
}

/** `patchCollide_t` (`cm_patch.h:79-85`). */
export interface PatchCollide {
  bounds: [Vec3f, Vec3f];
  /** Surface planes plus edge planes. */
  numPlanes: number;
  planes: PatchPlane[];
  numFacets: number;
  facets: Facet[];
}

/** `cPatch_t` (`cm_local.h:69-74`). */
export interface CPatch {
  checkcount: number;
  surfaceFlags: number;
  contents: number;
  pc: PatchCollide;
}

/** `cArea_t` (`cm_local.h:77-80`). */
export interface CArea {
  floodnum: number;
  floodvalid: number;
}

/**
 * The cvars collision reads, by the value of each one's `integer`. All three are cheats, which
 * `CM_LoadMap` registers (`cm_load.c:584-586`).
 */
export interface CmCvars {
  /** `cm_noAreas`, "0": every area is connected to every other. */
  noAreas: number;
  /** `cm_noCurves`, "0": traces pass through patches. */
  noCurves: number;
  /** `cm_playerCurveClip`, "1": point traces meet patches. */
  playerCurveClip: number;
}

/** Where collision prints, as `Com_Printf`; each message ends with its newline. */
export type CmPrint = (text: string) => void;

/** `trace_t` (`q_shared.h:1010-1019`), what a box swept through the world returns. */
export interface Trace {
  /** "If true, plane is not valid." */
  allsolid: boolean;
  /** "If true, the initial point was in a solid area." */
  startsolid: boolean;
  /** "Time completed, 1.0 = didn't hit anything." */
  fraction: number;
  endpos: Vec3f;
  /**
   * A copy of the plane hit. A patch's sets only the normal and distance, leaving the type and sign
   * bits of whatever was copied before; a turned model's normal is turned back to the world's, and
   * its distance is not.
   */
  plane: CPlane;
  surfaceFlags: number;
  /** "Contents on other side of surface hit." */
  contents: number;
  /** 0 from collision, which the server's own trace replaces with what was hit. */
  entityNum: number;
}

/** A trace of zeros, for a caller's result. */
export function newTrace(): Trace {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 0,
    endpos: vec3f(),
    plane: { normal: vec3f(), dist: 0, type: 0, signbits: 0 },
    surfaceFlags: 0,
    contents: 0,
    entityNum: 0
  };
}

/**
 * `leafList_t` (`cm_local.h:169-177`). Its `storeLeafs` is always `CM_StoreLeafs`:
 * `CM_StoreBrushes` serves only `CM_BoxBrushes`, which nothing calls.
 */
export interface LeafList {
  count: number;
  maxcount: number;
  overflowed: boolean;
  list: Int32Array;
  bounds: [Vec3f, Vec3f];
  /** "For overflows where each leaf can't be stored individually": the last with a cluster. */
  lastLeaf: number;
}

/** `MAX_POSITION_LEAFS` (`cm_trace.c:409`): the most leaves a position test in the world tests. */
export const MAX_POSITION_LEAFS = 1024;

/**
 * `traceWork_t` (`cm_local.h:154-167`), without what only the capsule reads (its sphere and the
 * model's origin) and the corner length nothing reads. C makes one on the stack for each trace;
 * the clip map keeps one, with the arrays the trace's functions make on the stack, so a trace
 * makes nothing.
 */
export interface TraceWork {
  start: Vec3f;
  end: Vec3f;
  /** "Size of the box being swept through the model", made even about its centre. */
  size: [Vec3f, Vec3f];
  /** "`[signbits][x]` = either `size[0][x]` or `size[1][x]`": the corner a plane meets first. */
  offsets: Vec3f[];
  /** "Greatest of abs(size[0]) and abs(size[1])." */
  extents: Vec3f;
  /** "Enclosing box of start and end surrounding by size." */
  bounds: [Vec3f, Vec3f];
  /** The contents the trace stops at: its mask. */
  contents: number;
  /** "Optimized case": a point, not a box. A position test never sets it. */
  isPoint: boolean;
  /** "Returned from trace call": copied out to the caller's at the end. */
  trace: Trace;

  /** `CM_TraceThroughTree`'s `mid`, one for each depth it recurses to. */
  mids: Vec3f[];
  /** `CM_PositionTest`'s `leafs`. */
  leafs: Int32Array;
  /** `CM_TracePointThroughPatchCollide`'s `frontFacing` and `intersection`, a patch plane each. */
  frontFacing: Uint8Array;
  intersection: Float32Array;
  /** The patch traces' `plane`, and `CM_TraceThroughPatchCollide`'s `bestplane`. */
  plane: Vec4f;
  bestplane: Vec4f;
  /** `CM_CheckFacetPlane`'s `enterFrac`, `leaveFrac` and `hit`, which C passes by pointer. */
  enterFrac: number;
  leaveFrac: number;
  hit: boolean;
  /** `CM_TransformedBoxTrace`'s `start_l`, `end_l`, `symetricSize`, `matrix` and `transpose`. */
  startL: Vec3f;
  endL: Vec3f;
  symetricSize: [Vec3f, Vec3f];
  matrix: [Vec3f, Vec3f, Vec3f];
  transpose: [Vec3f, Vec3f, Vec3f];
  /** `CM_TransformedPointContents`' `p_l`, `temp`, `forward`, `right` and `up`. */
  pointL: Vec3f;
  temp: Vec3f;
  forward: Vec3f;
  right: Vec3f;
  up: Vec3f;
  /** A caller's point and angles, as the floats C's `vec3_t` would hold. */
  point: Vec3f;
  angles: Vec3f;
}

/** A trace's work, made with a clip map. */
export function newTraceWork(): TraceWork {
  return {
    start: vec3f(),
    end: vec3f(),
    size: [vec3f(), vec3f()],
    offsets: Array.from({ length: 8 }, () => vec3f()),
    extents: vec3f(),
    bounds: [vec3f(), vec3f()],
    contents: 0,
    isPoint: false,
    trace: newTrace(),
    mids: [],
    leafs: new Int32Array(MAX_POSITION_LEAFS),
    frontFacing: new Uint8Array(MAX_PATCH_PLANES),
    intersection: new Float32Array(MAX_PATCH_PLANES),
    plane: [0, 0, 0, 0],
    bestplane: [0, 0, 0, 0],
    enterFrac: 0,
    leaveFrac: 0,
    hit: false,
    startL: vec3f(),
    endL: vec3f(),
    symetricSize: [vec3f(), vec3f()],
    matrix: [vec3f(), vec3f(), vec3f()],
    transpose: [vec3f(), vec3f(), vec3f()],
    pointL: vec3f(),
    temp: vec3f(),
    forward: vec3f(),
    right: vec3f(),
    up: vec3f(),
    point: vec3f(),
    angles: vec3f()
  };
}

/** A leaf list, made with a clip map; each search gives it its list. */
export function newLeafList(): LeafList {
  return {
    count: 0,
    maxcount: 0,
    overflowed: false,
    list: new Int32Array(0),
    bounds: [vec3f(), vec3f()],
    lastLeaf: 0
  };
}

/**
 * `clipMap_t` (`cm_local.h:82-129`), with what `cm_load.c` keeps beside it: the box hull and the
 * cvars. ioquake3 has one, shared by a process's client and server; the port has one a loader.
 *
 * The arrays have the box hull's spare room past their counts: two leafs, a leaf brush, twelve
 * planes, six sides and a brush. Each inline model's lists of brushes and surfaces follow the
 * map's own in `leafbrushes` and `leafsurfaces`, where C allocates them apart and reaches them by
 * the pointer's difference.
 */
export interface ClipMap {
  name: string;
  shaders: BspShader[];
  numShaders: number;
  brushsides: CBrushSide[];
  numBrushSides: number;
  planes: CPlane[];
  numPlanes: number;
  nodes: CNode[];
  numNodes: number;
  leafs: CLeaf[];
  numLeafs: number;
  leafbrushes: Int32Array;
  numLeafBrushes: number;
  leafsurfaces: Int32Array;
  numLeafSurfaces: number;
  cmodels: CModel[];
  numSubModels: number;
  brushes: CBrush[];
  numBrushes: number;
  numClusters: number;
  clusterBytes: number;
  /** A row of `clusterBytes` for each cluster: the clusters it can see. */
  visibility: Uint8Array;
  /** Whether the map has its visibility; without it, `visibility` is one row of `0xff`. */
  vised: boolean;
  /** The entity text, its closing NUL included. */
  entityString: string;
  numAreas: number;
  areas: CArea[];
  /** `numAreas × numAreas` reference counts of the open portals between two areas. */
  areaPortals: Int32Array;
  numSurfaces: number;
  /** A patch's collision for each patch surface, and `null` for every other. */
  surfaces: (CPatch | null)[];
  floodvalid: number;
  /** Bumped by each trace. */
  checkcount: number;
  /** `box_model` (`cm_load.c:67`). */
  boxModel: CModel;
  /** `box_planes` (`cm_load.c:68`): the first of the box's twelve planes. */
  boxPlanes: number;
  /** `box_brush` (`cm_load.c:69`). */
  boxBrush: CBrush;
  cvars: CmCvars;
  /** Each trace's work, and its scratch. */
  traceWork: TraceWork;
  /** Each search for the leaves a box touches. */
  leafList: LeafList;
}
