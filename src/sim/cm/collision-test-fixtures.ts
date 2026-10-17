import { MST_PATCH, MST_PLANAR, type Bsp, type BspSurface } from '../../formats/bsp';
import { CONTENTS, SURF } from '../constants';
import type { ClipMap, PatchCollide } from './cm-local';
import type { Vec3f } from './q-math';

/** A surface of a type, its other fields 0 or none. */
function surfaceOf(surfaceType: number, fields: Partial<BspSurface> = {}): BspSurface {
  return {
    shaderNum: 0,
    fogNum: -1,
    surfaceType,
    firstVert: 0,
    numVerts: 0,
    firstIndex: 0,
    numIndexes: 0,
    lightmapNum: -1,
    lightmapX: 0,
    lightmapY: 0,
    lightmapWidth: 0,
    lightmapHeight: 0,
    lightmapOrigin: [0, 0, 0],
    lightmapVecs: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ],
    patchWidth: 0,
    patchHeight: 0,
    ...fields
  };
}

/**
 * A small map, as `parseBsp` reads one, for collision's loader:
 * - shaders: solid; slick and no-impact; water;
 * - planes: a 128-unit cube's six faces about the origin in q3map's order, −x, +x, −y, +y, −z,
 *   +z, then a slanted plane;
 * - brushes: the cube, solid, its sides slick; and the same sides again as water, inline model
 *   1's;
 * - leafs: leaf 0 holds the cube (cluster 0, area 0), leaf 1 is solid (−1, −1), and leaf 2 is
 *   cluster 1 of area 2;
 * - one node on the +z plane, leaf 0 in front and leaf 1 behind;
 * - models: the world, and model 1 with the water brush and the patch;
 * - surfaces: a planar face, then a flat 3×3 patch of slick and no-impact.
 *
 * @param parts - Lumps to replace.
 */
export function clipBsp(parts: Partial<Bsp> = {}): Bsp {
  const xyz: number[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) xyz.push(32 * i, 32 * j, 0);
  return {
    entityString: '{ "classname" "worldspawn" }\0',
    shaders: [
      { shader: 'textures/test/solid', surfaceFlags: 0, contentFlags: CONTENTS.SOLID },
      {
        shader: 'textures/test/slick',
        surfaceFlags: SURF.SLICK | SURF.NOIMPACT,
        contentFlags: CONTENTS.SOLID
      },
      { shader: 'textures/test/water', surfaceFlags: 0, contentFlags: CONTENTS.WATER }
    ],
    planes: [
      { normal: [-1, 0, 0], dist: 64 },
      { normal: [1, 0, 0], dist: 64 },
      { normal: [0, -1, 0], dist: 64 },
      { normal: [0, 1, 0], dist: 64 },
      { normal: [0, 0, -1], dist: 64 },
      { normal: [0, 0, 1], dist: 64 },
      { normal: [Math.fround(0.6), Math.fround(-0.8), 0], dist: 10 }
    ],
    nodes: [{ planeNum: 5, children: [-1, -2], mins: [0, 0, 0], maxs: [0, 0, 0] }],
    leafs: [
      {
        cluster: 0,
        area: 0,
        mins: [0, 0, 0],
        maxs: [0, 0, 0],
        firstLeafSurface: 0,
        numLeafSurfaces: 1,
        firstLeafBrush: 0,
        numLeafBrushes: 1
      },
      {
        cluster: -1,
        area: -1,
        mins: [0, 0, 0],
        maxs: [0, 0, 0],
        firstLeafSurface: 0,
        numLeafSurfaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: 0
      },
      {
        cluster: 1,
        area: 2,
        mins: [0, 0, 0],
        maxs: [0, 0, 0],
        firstLeafSurface: 0,
        numLeafSurfaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: 0
      }
    ],
    leafBrushes: Int32Array.of(0),
    leafSurfaces: Int32Array.of(0),
    models: [
      {
        mins: [-64, -64, -64],
        maxs: [64, 64, 64],
        firstSurface: 0,
        numSurfaces: 1,
        firstBrush: 0,
        numBrushes: 1
      },
      {
        mins: [Math.fround(0.1), 0, -64],
        maxs: [64, 64, 64],
        firstSurface: 1,
        numSurfaces: 1,
        firstBrush: 1,
        numBrushes: 1
      }
    ],
    brushes: [
      { firstSide: 0, numSides: 6, shaderNum: 0 },
      { firstSide: 0, numSides: 6, shaderNum: 2 }
    ],
    brushSides: [0, 1, 2, 3, 4, 5].map((planeNum) => ({ planeNum, shaderNum: 1 })),
    drawVerts: {
      xyz: Float32Array.from(xyz),
      st: new Float32Array(18),
      lightmap: new Float32Array(18),
      normal: new Float32Array(27),
      color: new Uint8Array(36)
    },
    drawIndexes: new Int32Array(0),
    fogs: [],
    surfaces: [
      surfaceOf(MST_PLANAR),
      surfaceOf(MST_PATCH, { shaderNum: 1, numVerts: 9, patchWidth: 3, patchHeight: 3 })
    ],
    lightmaps: [],
    lightGrid: new Uint8Array(0),
    visibility: null,
    ...parts
  };
}

/**
 * {@link clipBsp} with its one node's two sides both leaf 0, so the world is the cube's leaf: a
 * 128-unit cube about the origin, its top at z 64.
 *
 * @param parts - Lumps to replace.
 */
export function cubeBsp(parts: Partial<Bsp> = {}): Bsp {
  const node = { ...clipBsp().nodes[0], children: [-1, -1] as [number, number] };
  return clipBsp({ nodes: [node], ...parts });
}

/** `M_SQRT1_2` as a float: the components of a plane at 45° to two axes. */
const DIAGONAL = Math.fround(Math.SQRT1_2);

/**
 * A map whose world is empty, and whose inline model 1 is one trigger brush as q3map makes one:
 * `CONTENTS_SOLID`, since `common/trigger` is only `nodraw`. It spans x and y from 0 to 64 and z
 * from 0 to 16, with its corner at (64, 64) cut off by the plane x + y = 96, as a jump pad's sides
 * are cut. The model's bounds take in the cut corner, and the brush does not.
 *
 * @param parts - Lumps to replace.
 */
export function triggerBsp(parts: Partial<Bsp> = {}): Bsp {
  const bsp = clipBsp();
  const leaf = { ...bsp.leafs[0], numLeafSurfaces: 0, numLeafBrushes: 0 };
  return clipBsp({
    planes: [
      { normal: [-1, 0, 0], dist: 0 },
      { normal: [1, 0, 0], dist: 64 },
      { normal: [0, -1, 0], dist: 0 },
      { normal: [0, 1, 0], dist: 64 },
      { normal: [0, 0, -1], dist: 0 },
      { normal: [0, 0, 1], dist: 16 },
      { normal: [DIAGONAL, DIAGONAL, 0], dist: Math.fround(96 * DIAGONAL) },
      { normal: [-DIAGONAL, -DIAGONAL, 0], dist: -Math.fround(96 * DIAGONAL) }
    ],
    nodes: [{ ...bsp.nodes[0], children: [-1, -1] }],
    leafs: [leaf, ...bsp.leafs.slice(1)],
    leafBrushes: new Int32Array(0),
    leafSurfaces: new Int32Array(0),
    models: [
      { ...bsp.models[0], mins: [0, 0, 0], maxs: [0, 0, 0], numSurfaces: 0, numBrushes: 0 },
      { ...bsp.models[0], mins: [0, 0, 0], maxs: [64, 64, 16], numSurfaces: 0, numBrushes: 1 }
    ],
    brushes: [{ firstSide: 0, numSides: 7, shaderNum: 0 }],
    brushSides: [0, 1, 2, 3, 4, 5, 6].map((planeNum) => ({ planeNum, shaderNum: 0 })),
    surfaces: [],
    ...parts
  });
}

/** The floor of {@link boxesBsp}: x and y from −1024 to 1024, its top at z 0. */
const FLOOR: readonly [Vec3f, Vec3f] = [
  [-1024, -1024, -64],
  [1024, 1024, 0]
];

/**
 * A map whose world is a solid floor, x and y from −1024 to 1024 with its top at z 0, and whose
 * inline models are solid boxes, model `i + 1` the brush `boxes[i]`, as q3map makes a mover's.
 *
 * @param boxes - Each model's brush, by its mins and maxs.
 */
export function boxesBsp(boxes: readonly (readonly [Vec3f, Vec3f])[]): Bsp {
  const bsp = clipBsp();
  const brushes = [FLOOR, ...boxes];
  const planes = brushes.flatMap(([mins, maxs]) => [
    { normal: [-1, 0, 0] as Vec3f, dist: -mins[0] },
    { normal: [1, 0, 0] as Vec3f, dist: maxs[0] },
    { normal: [0, -1, 0] as Vec3f, dist: -mins[1] },
    { normal: [0, 1, 0] as Vec3f, dist: maxs[1] },
    { normal: [0, 0, -1] as Vec3f, dist: -mins[2] },
    { normal: [0, 0, 1] as Vec3f, dist: maxs[2] }
  ]);
  const model = (firstBrush: number, mins: Vec3f, maxs: Vec3f) => ({
    mins,
    maxs,
    firstSurface: 0,
    numSurfaces: 0,
    firstBrush,
    numBrushes: 1
  });
  return clipBsp({
    planes,
    nodes: [{ ...bsp.nodes[0], children: [-1, -1] }],
    leafs: [{ ...bsp.leafs[0], numLeafSurfaces: 0 }, ...bsp.leafs.slice(1)],
    leafBrushes: Int32Array.of(0),
    leafSurfaces: new Int32Array(0),
    models: [
      model(0, FLOOR[0], [1024, 1024, 1024]),
      ...boxes.map(([mins, maxs], i) => model(i + 1, mins, maxs))
    ],
    brushes: brushes.map((_, i) => ({ firstSide: 6 * i, numSides: 6, shaderNum: 0 })),
    brushSides: planes.map((_, planeNum) => ({ planeNum, shaderNum: 0 })),
    surfaces: []
  });
}

/** A leaf of {@link stripsBsp}: its cluster and its area, −1 each for solid. */
export interface Strip {
  cluster: number;
  area: number;
}

/** The width of each of {@link stripsBsp}'s leaves along x. */
export const STRIP_WIDTH = 64;

/**
 * A map whose world is a row of leaves along x, each {@link STRIP_WIDTH} wide from x 0, the first
 * running on to −x and the last to +x, with no brush in any; and whose inline models are solid
 * boxes, model `i + 1` the brush `boxes[i]`. A box reaches its leaves in the row's order, and a
 * point on a boundary is in the leaf before it.
 *
 * @param strips - Each leaf's cluster and area, two or more.
 * @param boxes - Each model's brush, by its mins and maxs.
 * @param visibility - The clusters' rows, or none for a map every cluster sees all of.
 */
export function stripsBsp(
  strips: readonly Strip[],
  boxes: readonly (readonly [Vec3f, Vec3f])[] = [],
  visibility: Bsp['visibility'] = null
): Bsp {
  const bsp = clipBsp();
  const splits = strips.slice(1).map((_, k) => ({
    normal: [-1, 0, 0] as Vec3f,
    dist: -STRIP_WIDTH * (k + 1)
  }));
  const planes = [
    ...splits,
    ...boxes.flatMap(([mins, maxs]) => [
      { normal: [-1, 0, 0] as Vec3f, dist: -mins[0] },
      { normal: [1, 0, 0] as Vec3f, dist: maxs[0] },
      { normal: [0, -1, 0] as Vec3f, dist: -mins[1] },
      { normal: [0, 1, 0] as Vec3f, dist: maxs[1] },
      { normal: [0, 0, -1] as Vec3f, dist: -mins[2] },
      { normal: [0, 0, 1] as Vec3f, dist: maxs[2] }
    ])
  ];
  // Node k's front, x up to its split, is leaf k; its back is the next node, or the last leaf.
  const last = strips.length - 1;
  const nodes = splits.map((_, k) => ({
    planeNum: k,
    children: [-1 - k, k + 1 < splits.length ? k + 1 : -1 - last] as [number, number],
    mins: [0, 0, 0] as Vec3f,
    maxs: [0, 0, 0] as Vec3f
  }));
  const model = (firstBrush: number, numBrushes: number, mins: Vec3f, maxs: Vec3f) => ({
    mins,
    maxs,
    firstSurface: 0,
    numSurfaces: 0,
    firstBrush,
    numBrushes
  });
  return clipBsp({
    planes,
    nodes,
    leafs: strips.map(({ cluster, area }) => ({
      ...bsp.leafs[0],
      cluster,
      area,
      numLeafSurfaces: 0,
      numLeafBrushes: 0
    })),
    leafBrushes: new Int32Array(0),
    leafSurfaces: new Int32Array(0),
    models: [
      model(0, 0, [-1024, -1024, -1024], [STRIP_WIDTH * strips.length + 1024, 1024, 1024]),
      ...boxes.map(([mins, maxs], i) => model(i, 1, mins, maxs))
    ],
    brushes: boxes.map((_, i) => ({ firstSide: splits.length + 6 * i, numSides: 6, shaderNum: 0 })),
    brushSides: planes.map((_, planeNum) => ({ planeNum, shaderNum: 0 })),
    surfaces: [],
    visibility
  });
}

/**
 * {@link clipBsp} with its world only the flat patch: z 0, over x and y from 0 to 64, solid,
 * slick and no-impact.
 *
 * @param parts - Lumps to replace.
 */
export function patchBsp(parts: Partial<Bsp> = {}): Bsp {
  const bsp = clipBsp();
  const node = { ...bsp.nodes[0], children: [-1, -1] as [number, number] };
  const leaf = { ...bsp.leafs[0], numLeafBrushes: 0 };
  return clipBsp({
    nodes: [node],
    leafs: [leaf, ...bsp.leafs.slice(1)],
    leafSurfaces: Int32Array.of(1),
    ...parts
  });
}

/**
 * What collision's tests share: a digest of values as C lays them out, which the twin of the C
 * (ioquake3's own `cm_*.c`, compiled and run over the same input) prints too, so a test can hold
 * thousands of floats to the bit in one number.
 */

/** FNV-1a over little-endian bytes, as the twin's `fnv`. */
export class Digest {
  private h = 2166136261;
  private readonly scratch = new DataView(new ArrayBuffer(4));

  /** Adds a C `int`. */
  int(value: number): this {
    this.scratch.setInt32(0, value, true);
    return this.bytes();
  }

  /**
   * Adds a C `float`, by its bits, so −0 and +0 differ. Storing it would round a double, which
   * would hide a rounding the code under test left out, so a value that is not a float is refused.
   */
  float(value: number): this {
    if (!Object.is(value, Math.fround(value))) throw new Error(`${value} is not a float`);
    this.scratch.setFloat32(0, value, true);
    return this.bytes();
  }

  /** Adds `length` bytes of `data` from `offset`, as C's bytes. */
  uint8s(data: Uint8Array, offset: number, length: number): this {
    for (let i = 0; i < length; i++) {
      this.h ^= data[offset + i];
      this.h = Math.imul(this.h, 16777619) >>> 0;
    }
    return this;
  }

  /** The digest, as the twin prints it, eight hex digits. */
  hex(): string {
    return this.h.toString(16).padStart(8, '0');
  }

  private bytes(): this {
    for (let i = 0; i < 4; i++) {
      this.h ^= this.scratch.getUint8(i);
      this.h = Math.imul(this.h, 16777619) >>> 0;
    }
    return this;
  }
}

/**
 * The inputs the twin makes from a seed, made the same here: its LCG, and coordinates on a 1/256
 * grid, which a float holds exactly, so both sides start from the same bits.
 */
export class Seeded {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** The twin's `nextRandom`: `seed * 1664525 + 1013904223`, in 32 bits. */
  next(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed;
  }

  /** The twin's `coord`: an integer in [−range, range), over 256. */
  coord(range: number): number {
    return (((this.next() >>> 8) % (2 * range)) - range) / 256;
  }

  /** The twin's `randomVec`: three coordinates, x first. */
  vec(range: number): Vec3f {
    const x = this.coord(range);
    const y = this.coord(range);
    const z = this.coord(range);
    return [x, y, z];
  }
}

/**
 * Adds a patch's bounds, planes and facets to a digest, as the twin's `pcDigest`.
 *
 * @param index - The patch's surface number, which leads.
 * @returns How many borders its facets have
 */
export function digestPatch(digest: Digest, index: number, pc: PatchCollide): number {
  let borders = 0;
  digest.int(index);
  for (const bound of pc.bounds) for (const v of bound) digest.float(v);
  for (const plane of pc.planes) {
    for (const v of plane.plane) digest.float(v);
    digest.int(plane.signbits);
  }
  for (const facet of pc.facets) {
    borders += facet.numBorders;
    digest.int(facet.surfacePlane).int(facet.numBorders);
    for (let k = 0; k < facet.numBorders; k++) digest.int(facet.borderPlanes[k]);
    for (let k = 0; k < facet.numBorders; k++) digest.int(facet.borderInward[k]);
  }
  return borders;
}

/** A clip map's load, in the columns the twin prints (`twin.c`'s `patchDigest` and `main`). */
export interface LoadSurvey {
  brushes: number;
  sides: number;
  planes: number;
  leafs: number;
  leafbrushes: number;
  models: number;
  clusters: number;
  areas: number;
  vised: number;
  patches: number;
  facets: number;
  patchplanes: number;
  maxfacets: number;
  maxplanes: number;
  borders: number;
  /** Every patch's bounds, planes and facets, as bits. */
  digest: string;
}

/** A clip map's counts, and a digest of its patches as the twin makes it. */
export function surveyLoad(cm: ClipMap): LoadSurvey {
  const digest = new Digest();
  let patches = 0;
  let facets = 0;
  let planes = 0;
  let maxfacets = 0;
  let maxplanes = 0;
  let borders = 0;
  cm.surfaces.forEach((patch, i) => {
    if (!patch) return;
    const pc = patch.pc;
    patches++;
    facets += pc.numFacets;
    planes += pc.numPlanes;
    maxfacets = Math.max(maxfacets, pc.numFacets);
    maxplanes = Math.max(maxplanes, pc.numPlanes);
    borders += digestPatch(digest, i, pc);
  });
  return {
    brushes: cm.numBrushes,
    sides: cm.numBrushSides,
    planes: cm.numPlanes,
    leafs: cm.numLeafs,
    leafbrushes: cm.numLeafBrushes,
    models: cm.numSubModels,
    clusters: cm.numClusters,
    areas: cm.numAreas,
    vised: cm.vised ? 1 : 0,
    patches,
    facets,
    patchplanes: planes,
    maxfacets,
    maxplanes,
    borders,
    digest: digest.hex()
  };
}
