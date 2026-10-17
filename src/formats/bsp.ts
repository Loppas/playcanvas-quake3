import { textOfBytes } from './com-parse';

/**
 * A Quake 3 BSP (`qfiles.h:297-481`): a 144-byte header, then 17 lumps.
 *
 * Read as the file holds it, in Q3 units, Z-up: the small lumps as records with Q3's field names,
 * the bulk ones copied into typed arrays of their own, since a stored pak entry can start at an
 * offset no typed array can be laid over. What the renderer works out at load, the lightmaps'
 * colour shift (`tr_bsp.c:100-126`) and the curves' subdivision among it, is left to whatever
 * draws the map.
 *
 * Engine-free, like the other readers.
 */

/** `BSP_VERSION` (`qfiles.h:309`). */
export const BSP_VERSION = 46;

/** The lumps, in the header's order (`qfiles.h:360-377`). */
export const LUMP_ENTITIES = 0;
export const LUMP_SHADERS = 1;
export const LUMP_PLANES = 2;
export const LUMP_NODES = 3;
export const LUMP_LEAFS = 4;
export const LUMP_LEAFSURFACES = 5;
export const LUMP_LEAFBRUSHES = 6;
export const LUMP_MODELS = 7;
export const LUMP_BRUSHES = 8;
export const LUMP_BRUSHSIDES = 9;
export const LUMP_DRAWVERTS = 10;
export const LUMP_DRAWINDEXES = 11;
export const LUMP_FOGS = 12;
export const LUMP_SURFACES = 13;
export const LUMP_LIGHTMAPS = 14;
export const LUMP_LIGHTGRID = 15;
export const LUMP_VISIBILITY = 16;
export const HEADER_LUMPS = 17;

/** Each lump's name in the port's messages, by `LUMP_*` number. */
const LUMP_NAMES = [
  'entities',
  'shaders',
  'planes',
  'nodes',
  'leafs',
  'leafsurfaces',
  'leafbrushes',
  'models',
  'brushes',
  'brushsides',
  'drawverts',
  'drawindexes',
  'fogs',
  'surfaces',
  'lightmaps',
  'lightgrid',
  'visibility'
];

/** `mapSurfaceType_t` (`qfiles.h:453-459`). */
export const MST_BAD = 0;
export const MST_PLANAR = 1;
export const MST_PATCH = 2;
export const MST_TRIANGLE_SOUP = 3;
export const MST_FLARE = 4;

/** `MAX_QPATH` (`q_shared.h:246`): the width of a shader's or a fog's name. */
const MAX_QPATH = 64;

/** `MAX_SUBMODELS` (`cm_local.h:27`). */
const MAX_SUBMODELS = 256;

/** `MAX_PATCH_VERTS` (`cm_load.c:483`): the most control points collision takes in a patch. */
const MAX_PATCH_VERTS = 1024;

/** Collision's `MAX_GRID_SIZE` (`cm_patch.h:88`): the most points along a side of its grids. */
const CM_MAX_GRID_SIZE = 129;

/** `LIGHTMAP_WIDTH` and `LIGHTMAP_HEIGHT` (`qfiles.h:346-347`). */
export const LIGHTMAP_SIZE = 128;

/** One lightmap page: its texels, three bytes each (`tr_bsp.c:152`). */
const LIGHTMAP_BYTES = LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3;

/** `VIS_HEADER` (`cm_load.c:454`): `numClusters` and `clusterBytes`, before the bitsets. */
const VIS_HEADER = 8;

/** `sizeof(dheader_t)`: the ident, the version and the lump table (`qfiles.h:379-384`). */
const HEADER_SIZE = 8 + HEADER_LUMPS * 8;

/** Each record's size, `sizeof` its struct in `qfiles.h`. */
const SHADER_SIZE = 72;
const PLANE_SIZE = 16;
const NODE_SIZE = 36;
const LEAF_SIZE = 48;
const LEAF_BRUSH_SIZE = 4;
const LEAF_SURFACE_SIZE = 4;
const MODEL_SIZE = 40;
const BRUSH_SIZE = 12;
const BRUSH_SIDE_SIZE = 8;
const DRAW_VERT_SIZE = 44;
const DRAW_INDEX_SIZE = 4;
const FOG_SIZE = 72;
const SURFACE_SIZE = 104;

/** `dshader_t` (`qfiles.h:392-396`): a name, and the flags collision reads. */
export interface BspShader {
  shader: string;
  surfaceFlags: number;
  contentFlags: number;
}

/** `dplane_t` (`qfiles.h:400-403`). Plane `x ^ 1` is plane `x` turned round. */
export interface BspPlane {
  normal: [number, number, number];
  dist: number;
}

/** `dnode_t` (`qfiles.h:405-410`). */
export interface BspNode {
  planeNum: number;
  /** A node's number, or a leaf's as `-(leaf + 1)`. */
  children: [number, number];
  mins: [number, number, number];
  maxs: [number, number, number];
}

/** `dleaf_t` (`qfiles.h:412-424`). */
export interface BspLeaf {
  /** −1 for a leaf inside the world's solid. */
  cluster: number;
  area: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  firstLeafSurface: number;
  numLeafSurfaces: number;
  firstLeafBrush: number;
  numLeafBrushes: number;
}

/** `dmodel_t` (`qfiles.h:386-390`): model 0 is the world, the rest its brush models, `*1` on. */
export interface BspModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  firstSurface: number;
  numSurfaces: number;
  firstBrush: number;
  numBrushes: number;
}

/** `dbrush_t` (`qfiles.h:431-435`). */
export interface BspBrush {
  firstSide: number;
  numSides: number;
  shaderNum: number;
}

/** `dbrushside_t` (`qfiles.h:426-429`). */
export interface BspBrushSide {
  planeNum: number;
  shaderNum: number;
}

/** `dfog_t` (`qfiles.h:437-441`). */
export interface BspFog {
  shader: string;
  brushNum: number;
  /** The brush side a fog's surface is drawn on, or −1 for none. */
  visibleSide: number;
}

/** The draw vertices, `drawVert_t` (`qfiles.h:443-449`), as one array for each field. */
export interface BspDrawVerts {
  /** Three a vertex. */
  xyz: Float32Array;
  /** The texture coordinates, two a vertex. */
  st: Float32Array;
  /** The lightmap coordinates, two a vertex. */
  lightmap: Float32Array;
  /** Three a vertex. */
  normal: Float32Array;
  /** RGBA, four bytes a vertex. */
  color: Uint8Array;
}

/** `dsurface_t` (`qfiles.h:461-481`). */
export interface BspSurface {
  shaderNum: number;
  /** A fog's number, or −1 for none. */
  fogNum: number;
  /** One of `MST_*`. */
  surfaceType: number;
  firstVert: number;
  numVerts: number;
  firstIndex: number;
  numIndexes: number;
  lightmapNum: number;
  lightmapX: number;
  lightmapY: number;
  lightmapWidth: number;
  lightmapHeight: number;
  lightmapOrigin: [number, number, number];
  /** A patch's first two are its level-of-detail bounds. */
  lightmapVecs: [[number, number, number], [number, number, number], [number, number, number]];
  patchWidth: number;
  patchHeight: number;
}

/** The visibility lump (`cm_load.c:454-473`). */
export interface BspVisibility {
  numClusters: number;
  clusterBytes: number;
  /** A bitset of `clusterBytes` for each cluster: the clusters it can see. */
  data: Uint8Array;
}

/** A BSP's lumps, read. */
export interface Bsp {
  /** The entity text, its closing NUL included. */
  entityString: string;
  shaders: BspShader[];
  planes: BspPlane[];
  nodes: BspNode[];
  leafs: BspLeaf[];
  /** Each leaf's brushes, by `firstLeafBrush` and `numLeafBrushes`, as brush numbers. */
  leafBrushes: Int32Array;
  leafSurfaces: Int32Array;
  models: BspModel[];
  brushes: BspBrush[];
  brushSides: BspBrushSide[];
  drawVerts: BspDrawVerts;
  drawIndexes: Int32Array;
  fogs: BspFog[];
  surfaces: BspSurface[];
  /** The 128×128 RGB pages, as stored. */
  lightmaps: Uint8Array[];
  /** The light grid's points, eight bytes each, as stored; the lump's whole length. */
  lightGrid: Uint8Array;
  /** `null` when the map has none, and every cluster sees every other. */
  visibility: BspVisibility | null;
}

/** `lump_t` (`qfiles.h:356-358`). */
interface Lump {
  fileofs: number;
  filelen: number;
}

/**
 * The lump table, once the file is long enough to hold it and its version is 46. Neither of Q3's
 * loaders checks the ident.
 */
function readHeader(bytes: Uint8Array, view: DataView, name: string): Lump[] {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(`CM_LoadMap: ${name} is too short for a header`);
  }
  const version = view.getInt32(4, true);
  if (version !== BSP_VERSION) {
    throw new Error(
      `CM_LoadMap: ${name} has wrong version number (${version} should be ${BSP_VERSION})`
    );
  }
  return Array.from({ length: HEADER_LUMPS }, (_, n) => ({
    fileofs: view.getInt32(8 + 8 * n, true),
    filelen: view.getInt32(12 + 8 * n, true)
  }));
}

/** Where lump `n` starts, once it is known to lie inside the file, which Q3 never checks. */
function lumpStart(lumps: Lump[], n: number, bytes: Uint8Array, name: string): number {
  const { fileofs, filelen } = lumps[n];
  if (fileofs < 0 || filelen < 0 || fileofs + filelen > bytes.byteLength) {
    throw new Error(`CM_LoadMap: ${name}'s ${LUMP_NAMES[n]} lump lies outside the file`);
  }
  return fileofs;
}

/**
 * How many records a lump holds, refused in Q3's words when it is not a whole number of them or,
 * where Q3 needs one, holds none.
 */
function recordCount(lump: Lump, size: number, funny: string, empty?: string): number {
  if (lump.filelen % size) throw new Error(funny);
  const count = lump.filelen / size;
  if (empty !== undefined && count < 1) throw new Error(empty);
  return count;
}

/**
 * Collision's checks of a patch's size, in Q3's words (`cm_load.c:516-521`,
 * `cm_patch.c:1140-1151`). Q3's second message ends with the address of the points on its stack,
 * which the port has not got.
 */
function checkPatch(width: number, height: number): void {
  if (width * height > MAX_PATCH_VERTS) throw new Error('ParseMesh: MAX_PATCH_VERTS');
  if (width <= 2 || height <= 2) {
    throw new Error(`CM_GeneratePatchFacets: bad parameters: (${width}, ${height})`);
  }
  if (!(width & 1) || !(height & 1)) {
    throw new Error('CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes');
  }
  if (width > CM_MAX_GRID_SIZE || height > CM_MAX_GRID_SIZE) {
    throw new Error('CM_GeneratePatchFacets: source is > MAX_GRID_SIZE');
  }
}

/**
 * Collision's check of each brush's or brush side's shader (`cm_load.c:254-256, 430-432`): a
 * shader the map has not got is refused in Q3's words, the first first.
 *
 * @param view - The file.
 * @param at - The first record's `shaderNum`.
 * @param count - How many records.
 * @param size - Each record's size.
 * @param numShaders - How many shaders the map has.
 * @param loader - The loader whose words refuse it.
 */
function checkShaderNums(
  view: DataView,
  at: number,
  count: number,
  size: number,
  numShaders: number,
  loader: string
): void {
  for (let i = 0; i < count; i++) {
    const shaderNum = view.getInt32(at + i * size, true);
    if (shaderNum < 0 || shaderNum >= numShaders) {
      throw new Error(`${loader}: bad shaderNum: ${shaderNum}`);
    }
  }
}

/** A fixed-width name, which ends at its first NUL, a byte to a character. */
function readName(bytes: Uint8Array, at: number): string {
  const field = bytes.subarray(at, at + MAX_QPATH);
  const end = field.indexOf(0);
  return textOfBytes(end === -1 ? field : field.subarray(0, end));
}

/** The entity lump's text, a byte to a character, its closing NUL kept. */
function entityString(bytes: Uint8Array, lumps: Lump[], name: string): string {
  const fileofs = lumpStart(lumps, LUMP_ENTITIES, bytes, name);
  return textOfBytes(bytes.subarray(fileofs, fileofs + lumps[LUMP_ENTITIES].filelen));
}

/**
 * The entity text of a BSP, as `CMod_LoadEntityString` copies it (`cm_load.c:443–447`): the
 * lump's bytes, a byte to a character, its closing NUL included.
 *
 * @param bytes - The BSP file.
 * @param name - Its path, for messages.
 * @throws with `CM_LoadMap`'s message for a version other than 46, which is the only check Q3
 *   makes of the header (`cm_load.c:629–632`), and for a file too short for its header or an
 *   entity lump that is not inside it
 */
export function bspEntityText(bytes: Uint8Array, name: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return entityString(bytes, readHeader(bytes, view, name), name);
}

/** A BSP's lumps as collision reads them: every one but the renderer's own four. */
export type BspCollision = Omit<Bsp, 'fogs' | 'drawIndexes' | 'lightmaps' | 'lightGrid'>;

/**
 * A file's lump table, and readers of the little-endian fields its records hold.
 *
 * @param bytes - The BSP file, which may sit at any offset in its buffer.
 * @param name - Its path, for messages.
 */
function lumpReader(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lumps = readHeader(bytes, view, name);
  const int = (at: number) => view.getInt32(at, true);
  const float = (at: number) => view.getFloat32(at, true);
  return {
    view,
    lumps,
    int,
    float,
    ints: (at: number): [number, number, number] => [int(at), int(at + 4), int(at + 8)],
    floats: (at: number): [number, number, number] => [float(at), float(at + 4), float(at + 8)],
    /** Where lump `n` starts. */
    start: (n: number) => lumpStart(lumps, n, bytes, name),
    /** Lump `n`'s `count` records of `size` bytes each, each read by `read` from its offset. */
    records<T>(n: number, count: number, size: number, read: (at: number) => T): T[] {
      const start = lumpStart(lumps, n, bytes, name);
      return Array.from({ length: count }, (_, i) => read(start + i * size));
    },
    /** Lump `n`'s `count` 32-bit integers. */
    intArray(n: number, count: number): Int32Array {
      const start = lumpStart(lumps, n, bytes, name);
      const out = new Int32Array(count);
      for (let i = 0; i < count; i++) out[i] = int(start + i * 4);
      return out;
    }
  };
}

/**
 * Read a BSP's lumps as collision's `CM_LoadMap` reads them (`cm_load.c:569-661`), with its
 * checks in its order, so a map with several faults stops on the one Quake 3 reports. A server
 * reads no more than this, as Q3's never runs the renderer.
 *
 * @param bytes - The BSP file, which may sit at any offset in its buffer.
 * @param name - Its path, for messages.
 * @throws in Q3's words for a version other than 46, a lump that is not a whole number of
 *   records, a map with no shaders, leafs, planes, models or nodes, one with more than 256
 *   models, a brush or brush side with a shader the map has not got, and a patch of a size
 *   collision refuses; in the port's own for a file too short for its header, or a lump not
 *   inside it
 */
export function parseBspCollision(bytes: Uint8Array, name: string): BspCollision {
  const { view, lumps, int, ints, float, floats, start, records, intArray } = lumpReader(
    bytes,
    name
  );

  // Collision's checks come first, in its order (`cm_load.c:637-648`).
  const funny = 'MOD_LoadBmodel: funny lump size';
  const numShaders = recordCount(
    lumps[LUMP_SHADERS],
    SHADER_SIZE,
    'CMod_LoadShaders: funny lump size',
    'Map with no shaders'
  );
  const numLeafs = recordCount(lumps[LUMP_LEAFS], LEAF_SIZE, funny, 'Map with no leafs');
  const numLeafBrushes = recordCount(lumps[LUMP_LEAFBRUSHES], LEAF_BRUSH_SIZE, funny);
  const numLeafSurfaces = recordCount(lumps[LUMP_LEAFSURFACES], LEAF_SURFACE_SIZE, funny);
  const numPlanes = recordCount(lumps[LUMP_PLANES], PLANE_SIZE, funny, 'Map with no planes');
  const numBrushSides = recordCount(lumps[LUMP_BRUSHSIDES], BRUSH_SIDE_SIZE, funny);
  checkShaderNums(
    view,
    start(LUMP_BRUSHSIDES) + 4,
    numBrushSides,
    BRUSH_SIDE_SIZE,
    numShaders,
    'CMod_LoadBrushSides'
  );
  const numBrushes = recordCount(lumps[LUMP_BRUSHES], BRUSH_SIZE, funny);
  checkShaderNums(
    view,
    start(LUMP_BRUSHES) + 8,
    numBrushes,
    BRUSH_SIZE,
    numShaders,
    'CMod_LoadBrushes'
  );
  const numModels = recordCount(
    lumps[LUMP_MODELS],
    MODEL_SIZE,
    'CMod_LoadSubmodels: funny lump size',
    'Map with no models'
  );
  if (numModels > MAX_SUBMODELS) throw new Error('MAX_SUBMODELS exceeded');
  const numNodes = recordCount(lumps[LUMP_NODES], NODE_SIZE, funny, 'Map has no nodes');
  const numSurfaces = recordCount(lumps[LUMP_SURFACES], SURFACE_SIZE, funny);
  const numDrawVerts = recordCount(lumps[LUMP_DRAWVERTS], DRAW_VERT_SIZE, funny);
  // Each patch's size, as collision loads it (`cm_load.c:507-536`).
  const surfacesStart = start(LUMP_SURFACES);
  for (let i = 0; i < numSurfaces; i++) {
    const at = surfacesStart + i * SURFACE_SIZE;
    if (view.getInt32(at + 8, true) !== MST_PATCH) continue;
    checkPatch(view.getInt32(at + 96, true), view.getInt32(at + 100, true));
  }

  const shaders = records(LUMP_SHADERS, numShaders, SHADER_SIZE, (at) => ({
    shader: readName(bytes, at),
    surfaceFlags: int(at + 64),
    contentFlags: int(at + 68)
  }));
  const leafs = records(LUMP_LEAFS, numLeafs, LEAF_SIZE, (at) => ({
    cluster: int(at),
    area: int(at + 4),
    mins: ints(at + 8),
    maxs: ints(at + 20),
    firstLeafSurface: int(at + 32),
    numLeafSurfaces: int(at + 36),
    firstLeafBrush: int(at + 40),
    numLeafBrushes: int(at + 44)
  }));
  const leafBrushes = intArray(LUMP_LEAFBRUSHES, numLeafBrushes);
  const leafSurfaces = intArray(LUMP_LEAFSURFACES, numLeafSurfaces);
  const planes = records(LUMP_PLANES, numPlanes, PLANE_SIZE, (at) => ({
    normal: floats(at),
    dist: float(at + 12)
  }));
  const brushSides = records(LUMP_BRUSHSIDES, numBrushSides, BRUSH_SIDE_SIZE, (at) => ({
    planeNum: int(at),
    shaderNum: int(at + 4)
  }));
  const brushes = records(LUMP_BRUSHES, numBrushes, BRUSH_SIZE, (at) => ({
    firstSide: int(at),
    numSides: int(at + 4),
    shaderNum: int(at + 8)
  }));
  const models = records(LUMP_MODELS, numModels, MODEL_SIZE, (at) => ({
    mins: floats(at),
    maxs: floats(at + 12),
    firstSurface: int(at + 24),
    numSurfaces: int(at + 28),
    firstBrush: int(at + 32),
    numBrushes: int(at + 36)
  }));
  const nodes = records<BspNode>(LUMP_NODES, numNodes, NODE_SIZE, (at) => ({
    planeNum: int(at),
    children: [int(at + 4), int(at + 8)],
    mins: ints(at + 12),
    maxs: ints(at + 24)
  }));
  const surfaces = records<BspSurface>(LUMP_SURFACES, numSurfaces, SURFACE_SIZE, (at) => ({
    shaderNum: int(at),
    fogNum: int(at + 4),
    surfaceType: int(at + 8),
    firstVert: int(at + 12),
    numVerts: int(at + 16),
    firstIndex: int(at + 20),
    numIndexes: int(at + 24),
    lightmapNum: int(at + 28),
    lightmapX: int(at + 32),
    lightmapY: int(at + 36),
    lightmapWidth: int(at + 40),
    lightmapHeight: int(at + 44),
    lightmapOrigin: floats(at + 48),
    lightmapVecs: [floats(at + 60), floats(at + 72), floats(at + 84)],
    patchWidth: int(at + 96),
    patchHeight: int(at + 100)
  }));

  const vertsStart = start(LUMP_DRAWVERTS);
  const drawVerts: BspDrawVerts = {
    xyz: new Float32Array(numDrawVerts * 3),
    st: new Float32Array(numDrawVerts * 2),
    lightmap: new Float32Array(numDrawVerts * 2),
    normal: new Float32Array(numDrawVerts * 3),
    color: new Uint8Array(numDrawVerts * 4)
  };
  for (let i = 0; i < numDrawVerts; i++) {
    const at = vertsStart + i * DRAW_VERT_SIZE;
    for (let j = 0; j < 3; j++) {
      drawVerts.xyz[i * 3 + j] = float(at + j * 4);
      drawVerts.normal[i * 3 + j] = float(at + 28 + j * 4);
    }
    for (let j = 0; j < 2; j++) {
      drawVerts.st[i * 2 + j] = float(at + 12 + j * 4);
      drawVerts.lightmap[i * 2 + j] = float(at + 20 + j * 4);
    }
    drawVerts.color.set(bytes.subarray(at + 40, at + 44), i * 4);
  }

  const visStart = start(LUMP_VISIBILITY);
  const visLen = lumps[LUMP_VISIBILITY].filelen;
  const visibility =
    visLen === 0
      ? null
      : {
          numClusters: int(visStart),
          clusterBytes: int(visStart + 4),
          data: bytes.slice(visStart + VIS_HEADER, visStart + visLen)
        };

  return {
    entityString: entityString(bytes, lumps, name),
    shaders,
    planes,
    nodes,
    leafs,
    leafBrushes,
    leafSurfaces,
    models,
    brushes,
    brushSides,
    drawVerts,
    surfaces,
    visibility
  };
}

/**
 * The renderer's own lumps, read after collision's, as `RE_LoadWorldMap` reads them
 * (`renderergl1/tr_bsp.c:1791-1866`) once cgame has loaded the collision map
 * (`cg_main.c:1900`, `827`): the fogs, the draw indexes, the lightmap pages and the light grid.
 *
 * @param bytes - The BSP file, which may sit at any offset in its buffer.
 * @param name - Its path, for messages.
 * @param collision - The same file, as {@link parseBspCollision} read it.
 * @throws in Q3's words for a fog or draw-index lump that is not a whole number of records; in
 *   the port's own for a lump not inside the file
 */
export function parseBspWorld(bytes: Uint8Array, name: string, collision: BspCollision): Bsp {
  const { lumps, int, start, records, intArray } = lumpReader(bytes, name);

  // The renderer's checks of the lumps collision does not read, which name the map
  // (`tr_bsp.c:1848-1858`).
  const renderFunny = `LoadMap: funny lump size in ${name}`;
  const numFogs = recordCount(lumps[LUMP_FOGS], FOG_SIZE, renderFunny);
  const numDrawIndexes = recordCount(lumps[LUMP_DRAWINDEXES], DRAW_INDEX_SIZE, renderFunny);

  const fogs = records(LUMP_FOGS, numFogs, FOG_SIZE, (at) => ({
    shader: readName(bytes, at),
    brushNum: int(at + 64),
    visibleSide: int(at + 68)
  }));
  const drawIndexes = intArray(LUMP_DRAWINDEXES, numDrawIndexes);

  // The renderer takes whole pages and leaves any remainder (`tr_bsp.c:152`).
  const lightmapsStart = start(LUMP_LIGHTMAPS);
  const lightmaps = Array.from(
    { length: Math.floor(lumps[LUMP_LIGHTMAPS].filelen / LIGHTMAP_BYTES) },
    (_, i) => {
      const at = lightmapsStart + i * LIGHTMAP_BYTES;
      return bytes.slice(at, at + LIGHTMAP_BYTES);
    }
  );
  const lightGridStart = start(LUMP_LIGHTGRID);
  const lightGrid = bytes.slice(lightGridStart, lightGridStart + lumps[LUMP_LIGHTGRID].filelen);

  return { ...collision, drawIndexes, fogs, lightmaps, lightGrid };
}

/**
 * Read a BSP whole, as Quake 3's two loaders read it: collision's, then the renderer's. A map
 * with faults in both stops on collision's, as Q3's does.
 *
 * @param bytes - The BSP file, which may sit at any offset in its buffer.
 * @param name - Its path, for messages.
 * @throws whatever {@link parseBspCollision} and {@link parseBspWorld} throw
 */
export function parseBsp(bytes: Uint8Array, name: string): Bsp {
  return parseBspWorld(bytes, name, parseBspCollision(bytes, name));
}
