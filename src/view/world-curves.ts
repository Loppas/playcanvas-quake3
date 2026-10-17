import { MST_PATCH, type Bsp, type BspDrawVerts } from '../formats/bsp';
import type { Vec3 as ViewVector } from '../sim/vec3';
import { colorShiftLightingBytes } from './world-light';

/**
 * A map's curves as opengl1 makes them while it loads the world: each patch's control points
 * subdivided into a grid of points on the curve (`ParseMesh`, `tr_bsp.c:374-434`;
 * `R_SubdividePatchToGrid`, `tr_curve.c:356-514`), the cracks between a group's grids stitched and
 * their errors made to agree (`tr_bsp.c:526-1187`); and as it draws them, the columns and rows a
 * view keeps and their triangles, as `RB_SurfaceGrid` lists them (`tr_surface.c:825-1004`).
 *
 * The arithmetic is C's `float`'s, each operation rounded to single precision in Q3's order. How
 * many points a grid has, and how far each of its rows stands off the curve, follow from it.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `MAX_GRID_SIZE` (`tr_local.h:507`): the most points a grid has along a side. */
export const MAX_GRID_SIZE = 65;

/** `SURF_NODRAW` (`surfaceflags.h:69`): a surface kept for collision alone. */
export const SURF_NODRAW = 0x80;

type Vec3 = [number, number, number];

/** A patch subdivided, as `srfGridMesh_t` holds it (`tr_local.h:527-551`). */
export interface PatchGrid {
  width: number;
  height: number;
  /** Its points, a row at a time: column `i` of row `j` at `j * width + i`. */
  verts: BspDrawVerts;
  /**
   * Each column's error: one over how far the curve stood off the chord where it was made, or 0
   * for the first and last. A level of detail keeps the columns whose error is within its
   * allowance, and the first and last always.
   */
  widthLodError: Float32Array;
  /** Each row's error, as {@link PatchGrid.widthLodError}. */
  heightLodError: Float32Array;
  /** The bounds of its points. */
  meshBounds: [Vec3, Vec3];
  /** The centre of its bounds, and the distance from there to their corner. */
  localOrigin: Vec3;
  meshRadius: number;
  /**
   * The centre and radius of its level-of-detail group: the bounds the compiler stored alike for
   * every patch that must subdivide alike, so that their edges meet.
   */
  lodOrigin: Vec3;
  lodRadius: number;
}

/**
 * The columns and rows of a grid drawn at a level of detail, as `RB_SurfaceGrid` lists them
 * (`tr_surface.c:885-908`): the first `lodWidth` of `widthTable` and the first `lodHeight` of
 * `heightTable`, each in order, the first and the last among them.
 */
export interface GridTables {
  widthTable: Int32Array;
  lodWidth: number;
  heightTable: Int32Array;
  lodHeight: number;
}

/** An entity's place, as `orientationr_t` holds it: its origin and its three axes. */
export interface Orientation {
  origin: Vec3;
  axis: [Vec3, Vec3, Vec3];
}

const f = Math.fround;

/** `0.001f`: an edge or a normal shorter than this is degenerate (`tr_curve.c:183, 199`). */
const DEGENERATE = f(0.001);

/** `0.1f`: a column standing less than this off its chord is colinear (`tr_curve.c:421`). */
const COLINEAR = f(0.1);

/** What an error table holds for a colinear column or row, which is dropped (`tr_curve.c:422`). */
const COLINEAR_ERROR = 999;

/** `.1`: points this near on every axis are one to stitching and the error fix (`tr_bsp.c:538`). */
const NEAR = 0.1;

/**
 * `.01`: two neighbouring points of a side this near on every axis have no crack between them
 * (`tr_bsp.c:758-760`).
 */
const SAME = 0.01;

/**
 * What Q3 reads one past the end of an error table, as a search back along a side does: the zone's
 * trailer, `ZONEID` (`common.c:769, 1035`), taken as a float. It is a positive denormal, so a row
 * given it is kept at any allowance but 0. On a 64-bit build a table of even length ends in padding
 * instead, which holds whatever was there before; the port reads the trailer there too.
 */
const PAST_THE_END = new Float32Array(new Uint32Array([0x1d4a11]).buffer)[0];

/** `neighbors` (`tr_curve.c:124-126`): the eight directions round a point, in turn. */
const NEIGHBORS = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1]
];

/** Room for `count` draw vertices, every field 0. */
function drawVerts(count: number): BspDrawVerts {
  return {
    xyz: new Float32Array(count * 3),
    st: new Float32Array(count * 2),
    lightmap: new Float32Array(count * 2),
    normal: new Float32Array(count * 3),
    color: new Uint8Array(count * 4)
  };
}

/** Copy point `a` of `from` over point `b` of `to`, every field, as C copies a `drawVert_t`. */
function copyVert(from: BspDrawVerts, a: number, to: BspDrawVerts, b: number): void {
  for (let k = 0; k < 3; k++) {
    to.xyz[b * 3 + k] = from.xyz[a * 3 + k];
    to.normal[b * 3 + k] = from.normal[a * 3 + k];
  }
  for (let k = 0; k < 2; k++) {
    to.st[b * 2 + k] = from.st[a * 2 + k];
    to.lightmap[b * 2 + k] = from.lightmap[a * 2 + k];
  }
  for (let k = 0; k < 4; k++) to.color[b * 4 + k] = from.color[a * 4 + k];
}

/**
 * `LerpDrawVert` (`tr_curve.c:46-61`): point `io` of `out` made the midpoint of two points, its
 * colour halved in integers. Its normal is left as it was.
 */
function lerpDrawVert(
  a: BspDrawVerts,
  ia: number,
  b: BspDrawVerts,
  ib: number,
  out: BspDrawVerts,
  io: number
): void {
  const half = (x: Float32Array, y: Float32Array, z: Float32Array, n: number) => {
    for (let k = 0; k < n; k++) z[io * n + k] = f(0.5 * f(x[ia * n + k] + y[ib * n + k]));
  };
  half(a.xyz, b.xyz, out.xyz, 3);
  half(a.st, b.st, out.st, 2);
  half(a.lightmap, b.lightmap, out.lightmap, 2);
  for (let k = 0; k < 4; k++) {
    out.color[io * 4 + k] = (a.color[ia * 4 + k] + b.color[ib * 4 + k]) >> 1;
  }
}

const xyzOf = (points: BspDrawVerts, n: number): Vec3 => [
  points.xyz[n * 3],
  points.xyz[n * 3 + 1],
  points.xyz[n * 3 + 2]
];
const add = (a: Vec3, b: Vec3): Vec3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const subtract = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const scale = (v: Vec3, s: number): Vec3 => [f(v[0] * s), f(v[1] * s), f(v[2] * s)];
const dot = (a: Vec3, b: Vec3) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  f(f(a[1] * b[2]) - f(a[2] * b[1])),
  f(f(a[2] * b[0]) - f(a[0] * b[2])),
  f(f(a[0] * b[1]) - f(a[1] * b[0]))
];
/** `VectorLength`: the square root taken in doubles, then rounded. */
const length = (v: Vec3) => f(Math.sqrt(dot(v, v)));

/** `VectorNormalize` (`q_math.c:790-807`): `v` made unit length in place; its length. */
function normalize(v: Vec3): number {
  let length = dot(v, v);
  if (length) {
    const ilength = f(1 / f(Math.sqrt(length)));
    length = f(length * ilength);
    for (let k = 0; k < 3; k++) v[k] = f(v[k] * ilength);
  }
  return length;
}

/** `VectorNormalize2` (`q_math.c:809-829`): `v` at unit length, or 0 where it has none. */
function normalized(v: Vec3): Vec3 {
  const lengthSquared = dot(v, v);
  if (!lengthSquared) return [0, 0, 0];
  const ilength = f(1 / f(Math.sqrt(lengthSquared)));
  return scale(v, ilength);
}

/** Where row `row`, column `column` is in a working grid, `drawVert_t ctrl[65][65]`. */
const ctrlAt = (row: number, column: number) => row * MAX_GRID_SIZE + column;

/** Swap two points of `points`, through `temp`'s first. */
function swap(points: BspDrawVerts, a: number, b: number, temp: BspDrawVerts): void {
  copyVert(points, a, temp, 0);
  copyVert(points, b, points, a);
  copyVert(temp, 0, points, b);
}

/** `Transpose` (`tr_curve.c:68-102`): rows made columns, in place. */
function transpose(width: number, height: number, ctrl: BspDrawVerts, temp: BspDrawVerts): void {
  if (width > height) {
    for (let i = 0; i < height; i++) {
      for (let j = i + 1; j < width; j++) {
        if (j < height) swap(ctrl, ctrlAt(j, i), ctrlAt(i, j), temp);
        else copyVert(ctrl, ctrlAt(i, j), ctrl, ctrlAt(j, i));
      }
    }
  } else {
    for (let i = 0; i < width; i++) {
      for (let j = i + 1; j < height; j++) {
        if (j < width) swap(ctrl, ctrlAt(i, j), ctrlAt(j, i), temp);
        else copyVert(ctrl, ctrlAt(j, i), ctrl, ctrlAt(i, j));
      }
    }
  }
}

/**
 * `MakeMeshNormals` (`tr_curve.c:112-210`): each point's normal, the sum of the faces between the
 * eight directions round it. In each direction it takes the first of up to three points out that
 * is not on top of it; where a grid's opposite edges meet, it wraps round to the other side.
 */
function makeMeshNormals(width: number, height: number, ctrl: BspDrawVerts): void {
  let i: number;
  for (i = 0; i < height; i++) {
    const delta = subtract(xyzOf(ctrl, ctrlAt(i, 0)), xyzOf(ctrl, ctrlAt(i, width - 1)));
    if (dot(delta, delta) > 1) break;
  }
  const wrapWidth = i === height;
  for (i = 0; i < width; i++) {
    const delta = subtract(xyzOf(ctrl, ctrlAt(0, i)), xyzOf(ctrl, ctrlAt(height - 1, i)));
    if (dot(delta, delta) > 1) break;
  }
  const wrapHeight = i === width;

  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      const base = xyzOf(ctrl, ctrlAt(j, i));
      const around: Vec3[] = [];
      const good: boolean[] = [];
      for (let k = 0; k < 8; k++) {
        around[k] = [0, 0, 0];
        good[k] = false;
        for (let dist = 1; dist <= 3; dist++) {
          let x = i + NEIGHBORS[k][0] * dist;
          let y = j + NEIGHBORS[k][1] * dist;
          if (wrapWidth) {
            if (x < 0) x = width - 1 + x;
            else if (x >= width) x = 1 + x - width;
          }
          if (wrapHeight) {
            if (y < 0) y = height - 1 + y;
            else if (y >= height) y = 1 + y - height;
          }
          if (x < 0 || x >= width || y < 0 || y >= height) break;
          const edge = subtract(xyzOf(ctrl, ctrlAt(y, x)), base);
          if (normalize(edge) < DEGENERATE) continue;
          good[k] = true;
          around[k] = edge;
          break;
        }
      }

      let sum: Vec3 = [0, 0, 0];
      for (let k = 0; k < 8; k++) {
        if (!good[k] || !good[(k + 1) & 7]) continue;
        const normal = cross(around[(k + 1) & 7], around[k]);
        if (normalize(normal) < DEGENERATE) continue;
        sum = add(normal, sum);
      }
      ctrl.normal.set(normalized(sum), ctrlAt(j, i) * 3);
    }
  }
}

/** `R_CreateSurfaceGridMesh` (`tr_curve.c:286-338`): the working grid copied out, and bounded. */
function createSurfaceGridMesh(
  width: number,
  height: number,
  ctrl: BspDrawVerts,
  errorTable: [Float32Array, Float32Array]
): PatchGrid {
  const verts = drawVerts(width * height);
  // `ClearBounds`, then `AddPointToBounds` (`q_math.c:714-738`).
  const mins: Vec3 = [99999, 99999, 99999];
  const maxs: Vec3 = [-99999, -99999, -99999];
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      copyVert(ctrl, ctrlAt(j, i), verts, j * width + i);
      const point = xyzOf(verts, j * width + i);
      for (let k = 0; k < 3; k++) {
        if (point[k] < mins[k]) mins[k] = point[k];
        if (point[k] > maxs[k]) maxs[k] = point[k];
      }
    }
  }
  const localOrigin = scale(add(mins, maxs), 0.5);
  const meshRadius = length(subtract(mins, localOrigin));
  return {
    width,
    height,
    verts,
    widthLodError: errorTable[0].slice(0, width),
    heightLodError: errorTable[1].slice(0, height),
    meshBounds: [mins, maxs],
    localOrigin,
    meshRadius,
    lodOrigin: [...localOrigin],
    lodRadius: meshRadius
  };
}

/**
 * `R_SubdividePatchToGrid` (`tr_curve.c:356-514`): a patch's control points made a grid of points
 * on its curve.
 *
 * Each way in turn, each column between two others is measured by how far the curve's midpoint
 * there stands off the chord between them. Within 0.1 the column is colinear and is dropped.
 * Farther than `subdivisions`, two columns are put in either side of it and the three are measured
 * again; otherwise the column keeps one over the distance as its error. The points are then put on
 * the curve, the colinear columns and rows dropped, and a grid taller than it is wide turned on
 * its side.
 *
 * @param points - The control points, a row at a time, `width` by `height`.
 * @param subdivisions - `r_subdivisions`, the farthest a curve may stand off a chord.
 */
export function subdividePatchToGrid(
  width: number,
  height: number,
  points: BspDrawVerts,
  subdivisions: number
): PatchGrid {
  const ctrl = drawVerts(MAX_GRID_SIZE * MAX_GRID_SIZE);
  const temp = drawVerts(3);
  const [PREV, NEXT, MID] = [0, 1, 2];
  const errorTable: [Float32Array, Float32Array] = [
    new Float32Array(MAX_GRID_SIZE),
    new Float32Array(MAX_GRID_SIZE)
  ];
  const limit = f(subdivisions);
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) copyVert(points, j * width + i, ctrl, ctrlAt(j, i));
  }

  for (let dir = 0; dir < 2; dir++) {
    for (let j = 0; j + 2 < width; j += 2) {
      let maxLen = 0;
      for (let i = 0; i < height; i++) {
        const a = xyzOf(ctrl, ctrlAt(i, j));
        const b = xyzOf(ctrl, ctrlAt(i, j + 1));
        const c = xyzOf(ctrl, ctrlAt(i, j + 2));
        const onCurve: Vec3 = [0, 0, 0];
        for (let l = 0; l < 3; l++) onCurve[l] = f(f(f(a[l] + f(b[l] * 2)) + c[l]) * 0.25);
        const mid = subtract(onCurve, a);
        const chord = subtract(c, a);
        normalize(chord);
        const off = subtract(mid, scale(chord, dot(mid, chord)));
        const len = dot(off, off);
        if (len > maxLen) maxLen = len;
      }
      maxLen = f(Math.sqrt(maxLen));

      if (maxLen < COLINEAR) {
        errorTable[dir][j + 1] = COLINEAR_ERROR;
        continue;
      }
      // A grid too wide to grow, or a curve near enough its chord.
      if (width + 2 > MAX_GRID_SIZE || maxLen <= limit) {
        errorTable[dir][j + 1] = f(1 / maxLen);
        continue;
      }

      errorTable[dir][j + 2] = f(1 / maxLen);
      width += 2;
      for (let i = 0; i < height; i++) {
        lerpDrawVert(ctrl, ctrlAt(i, j), ctrl, ctrlAt(i, j + 1), temp, PREV);
        lerpDrawVert(ctrl, ctrlAt(i, j + 1), ctrl, ctrlAt(i, j + 2), temp, NEXT);
        lerpDrawVert(temp, PREV, temp, NEXT, temp, MID);
        for (let k = width - 1; k > j + 3; k--) {
          copyVert(ctrl, ctrlAt(i, k - 2), ctrl, ctrlAt(i, k));
        }
        copyVert(temp, PREV, ctrl, ctrlAt(i, j + 1));
        copyVert(temp, MID, ctrl, ctrlAt(i, j + 2));
        copyVert(temp, NEXT, ctrl, ctrlAt(i, j + 3));
      }
      // Measure this column again: it may need more.
      j -= 2;
    }
    transpose(width, height, ctrl, temp);
    [width, height] = [height, width];
  }

  // `PutPointsOnCurve` (`tr_curve.c:258-279`).
  for (let i = 0; i < width; i++) {
    for (let j = 1; j < height; j += 2) {
      lerpDrawVert(ctrl, ctrlAt(j, i), ctrl, ctrlAt(j + 1, i), temp, PREV);
      lerpDrawVert(ctrl, ctrlAt(j, i), ctrl, ctrlAt(j - 1, i), temp, NEXT);
      lerpDrawVert(temp, PREV, temp, NEXT, ctrl, ctrlAt(j, i));
    }
  }
  for (let j = 0; j < height; j++) {
    for (let i = 1; i < width; i += 2) {
      lerpDrawVert(ctrl, ctrlAt(j, i), ctrl, ctrlAt(j, i + 1), temp, PREV);
      lerpDrawVert(ctrl, ctrlAt(j, i), ctrl, ctrlAt(j, i - 1), temp, NEXT);
      lerpDrawVert(temp, PREV, temp, NEXT, ctrl, ctrlAt(j, i));
    }
  }

  // The colinear columns and rows dropped.
  for (let i = 1; i < width - 1; i++) {
    if (errorTable[0][i] !== COLINEAR_ERROR) continue;
    for (let j = i + 1; j < width; j++) {
      for (let k = 0; k < height; k++) copyVert(ctrl, ctrlAt(k, j), ctrl, ctrlAt(k, j - 1));
      errorTable[0][j - 1] = errorTable[0][j];
    }
    width--;
  }
  for (let i = 1; i < height - 1; i++) {
    if (errorTable[1][i] !== COLINEAR_ERROR) continue;
    for (let j = i + 1; j < height; j++) {
      for (let k = 0; k < width; k++) copyVert(ctrl, ctrlAt(j, k), ctrl, ctrlAt(j - 1, k));
      errorTable[1][j - 1] = errorTable[1][j];
    }
    height--;
  }

  // Turned for the longest strips, which Q3 says draw the same.
  if (height > width) {
    transpose(width, height, ctrl, temp);
    // `InvertErrorTable` (`tr_curve.c:237-251`).
    const [widths, heights] = errorTable.map((table) => table.slice());
    for (let i = 0; i < width; i++) errorTable[1][i] = widths[i];
    for (let i = 0; i < height; i++) errorTable[0][i] = heights[height - 1 - i];
    [width, height] = [height, width];
    // `InvertCtrl` (`tr_curve.c:218-229`).
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < Math.trunc(width / 2); j++) {
        swap(ctrl, ctrlAt(i, j), ctrlAt(i, width - 1 - j), temp);
      }
    }
  }

  makeMeshNormals(width, height, ctrl);
  return createSurfaceGridMesh(width, height, ctrl, errorTable);
}

/**
 * `ParseMesh` (`tr_bsp.c:374-434`): a patch subdivided, its control points' colours shifted as the
 * light's are, with its level-of-detail group's centre and radius from the bounds the compiler
 * stored in its `lightmapVecs`. `null` for a nodraw patch, which Q3 never subdivides.
 *
 * @param surface - The patch, by its index in the BSP.
 * @param shift - What the colours are shifted by (`world-light.ts`).
 * @param subdivisions - `r_subdivisions`.
 * @throws in the port's words for a patch wider or taller than a grid holds, which opengl1 would
 *   write past
 */
export function parseMesh(
  bsp: Bsp,
  surface: number,
  shift: number,
  subdivisions: number
): PatchGrid | null {
  const { shaderNum, firstVert, patchWidth: width, patchHeight: height } = bsp.surfaces[surface];
  if (bsp.shaders[shaderNum].surfaceFlags & SURF_NODRAW) return null;
  if (width > MAX_GRID_SIZE || height > MAX_GRID_SIZE) {
    throw new Error(
      `ParseMesh: patch ${surface} is ${width} by ${height}, over MAX_GRID_SIZE (${MAX_GRID_SIZE})`
    );
  }
  const count = width * height;
  const points = drawVerts(count);
  for (let i = 0; i < count; i++) {
    copyVert(bsp.drawVerts, firstVert + i, points, i);
    colorShiftLightingBytes(bsp.drawVerts.color, (firstVert + i) * 4, points.color, i * 4, shift);
  }
  const grid = subdividePatchToGrid(width, height, points, subdivisions);
  const [mins, maxs] = bsp.surfaces[surface].lightmapVecs;
  grid.lodOrigin = scale(add(mins, maxs), 0.5);
  grid.lodRadius = length(subtract(mins, grid.lodOrigin));
  return grid;
}

/** Whether two grids are of one level-of-detail group: the same centre and radius, exactly. */
const sameGroup = (a: PatchGrid, b: PatchGrid) =>
  a.lodRadius === b.lodRadius && a.lodOrigin.every((x, k) => x === b.lodOrigin[k]);

/**
 * Whether point `a` of `from` and point `b` of `to` are one: within {@link NEAR} on every axis, the
 * difference taken in single precision, as C takes it.
 */
function near(from: BspDrawVerts, a: number, to: BspDrawVerts, b: number): boolean {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(f(from.xyz[a * 3 + k] - to.xyz[b * 3 + k])) > NEAR) return false;
  }
  return true;
}

/** Whether points `a` and `b` of `points` are within {@link SAME} on every axis. */
function same(points: BspDrawVerts, a: number, b: number): boolean {
  for (let k = 0; k < 3; k++) {
    if (!(Math.abs(f(points.xyz[a * 3 + k] - points.xyz[b * 3 + k])) < SAME)) return false;
  }
  return true;
}

/**
 * A side of a grid: along its width, its first or last row, or along its height, its first or last
 * column. Its `count` points are at `start + k * step` among the grid's.
 */
interface Side {
  alongWidth: boolean;
  /** Which row or column it is. */
  line: number;
  start: number;
  step: number;
  count: number;
}

function sideOf(grid: PatchGrid, alongWidth: boolean, last: boolean): Side {
  const { width, height } = grid;
  if (alongWidth) {
    const line = last ? height - 1 : 0;
    return { alongWidth, line, start: line * width, step: 1, count: width };
  }
  const line = last ? width - 1 : 0;
  return { alongWidth, line, start: line, step: width, count: height };
}

/** A grid's sides in Q3's order: its first and last rows, then its first and last columns. */
const sidesOf = (grid: PatchGrid) => [
  sideOf(grid, true, false),
  sideOf(grid, true, true),
  sideOf(grid, false, false),
  sideOf(grid, false, true)
];

const pointOf = (side: Side, k: number) => side.start + k * side.step;

/** The error table along a side: the columns' along a row, the rows' along a column. */
const errorsAlong = (grid: PatchGrid, side: Side) =>
  side.alongWidth ? grid.widthLodError : grid.heightLodError;

/**
 * `R_MergedWidthPoints` and `R_MergedHeightPoints` (`tr_bsp.c:533-566`): whether two of a side's
 * points between its ends are one.
 */
function mergedPoints(grid: PatchGrid, side: Side): boolean {
  for (let i = 1; i < side.count - 1; i++) {
    for (let j = i + 1; j < side.count - 1; j++) {
      if (near(grid.verts, pointOf(side, i), grid.verts, pointOf(side, j))) return true;
    }
  }
  return false;
}

/** A grid made from its working copy after a column or row is put in: its normals made again. */
function regrid(
  old: PatchGrid,
  width: number,
  height: number,
  ctrl: BspDrawVerts,
  errorTable: [Float32Array, Float32Array]
): PatchGrid {
  makeMeshNormals(width, height, ctrl);
  const grid = createSurfaceGridMesh(width, height, ctrl, errorTable);
  grid.lodOrigin = [...old.lodOrigin];
  grid.lodRadius = old.lodRadius;
  return grid;
}

/**
 * `R_GridInsertColumn` (`tr_curve.c:521-568`): a grid with a column put in at `column`, each of its
 * points the midpoint of the two either side, but for the one in `row`, which is `point`. The
 * points are left where they are, not put on the curve, and the grid keeps its group.
 */
function gridInsertColumn(
  grid: PatchGrid,
  column: number,
  row: number,
  point: Vec3,
  lodError: number
): PatchGrid {
  const width = grid.width + 1;
  const { height } = grid;
  const ctrl = drawVerts(MAX_GRID_SIZE * MAX_GRID_SIZE);
  const errorTable: [Float32Array, Float32Array] = [
    new Float32Array(MAX_GRID_SIZE),
    new Float32Array(MAX_GRID_SIZE)
  ];
  let old = 0;
  for (let i = 0; i < width; i++) {
    if (i === column) {
      for (let j = 0; j < height; j++) {
        const at = j * grid.width + i;
        lerpDrawVert(grid.verts, at - 1, grid.verts, at, ctrl, ctrlAt(j, i));
        if (j === row) ctrl.xyz.set(point, ctrlAt(j, i) * 3);
      }
      errorTable[0][i] = lodError;
      continue;
    }
    errorTable[0][i] = grid.widthLodError[old];
    for (let j = 0; j < height; j++) copyVert(grid.verts, j * grid.width + old, ctrl, ctrlAt(j, i));
    old++;
  }
  errorTable[1].set(grid.heightLodError);
  return regrid(grid, width, height, ctrl, errorTable);
}

/** `R_GridInsertRow` (`tr_curve.c:575-622`): {@link gridInsertColumn}, a row at `row`. */
function gridInsertRow(
  grid: PatchGrid,
  row: number,
  column: number,
  point: Vec3,
  lodError: number
): PatchGrid {
  const { width } = grid;
  const height = grid.height + 1;
  const ctrl = drawVerts(MAX_GRID_SIZE * MAX_GRID_SIZE);
  const errorTable: [Float32Array, Float32Array] = [
    new Float32Array(MAX_GRID_SIZE),
    new Float32Array(MAX_GRID_SIZE)
  ];
  let old = 0;
  for (let i = 0; i < height; i++) {
    if (i === row) {
      for (let j = 0; j < width; j++) {
        const at = i * width + j;
        lerpDrawVert(grid.verts, at - width, grid.verts, at, ctrl, ctrlAt(i, j));
        if (j === column) ctrl.xyz.set(point, ctrlAt(i, j) * 3);
      }
      errorTable[1][i] = lodError;
      continue;
    }
    errorTable[1][i] = grid.heightLodError[old];
    for (let j = 0; j < width; j++) copyVert(grid.verts, old * width + j, ctrl, ctrlAt(i, j));
    old++;
  }
  errorTable[0].set(grid.widthLodError);
  return regrid(grid, width, height, ctrl, errorTable);
}

/**
 * Where along `side` of `grid` the points `a` and `b` of `points` meet two neighbours of its, not
 * one point: the first of the two, or -1.
 */
function crackAt(points: BspDrawVerts, a: number, b: number, grid: PatchGrid, side: Side): number {
  for (let l = 0; l < side.count - 1; l++) {
    const [p, q] = [pointOf(side, l), pointOf(side, l + 1)];
    if (!near(points, a, grid.verts, p) || !near(points, b, grid.verts, q)) continue;
    if (!same(grid.verts, p, q)) return l;
  }
  return -1;
}

/**
 * `R_StitchPatches` (`tr_bsp.c:715-1115`): the first crack mended where grid `n2` has, between two
 * neighbouring points, a side of grid `n1` that has a point between them. `n2`'s grid is replaced
 * by one with a column or row put in through that point.
 *
 * `n1`'s sides are searched forward, rows then columns, then back. Where `n2`'s side runs along its
 * width a column goes in, and along its height a row; a grid 65 wide takes no column, and one 65
 * high no row. A side of `n1` with two points merged is passed over.
 *
 * @returns whether a crack was mended
 */
function stitchPatches(grids: (PatchGrid | null)[], n1: number, n2: number): boolean {
  const grid1 = grids[n1]!;
  for (const back of [false, true]) {
    for (const alongWidth of [true, false]) {
      for (const last of [false, true]) {
        const side1 = sideOf(grid1, alongWidth, last);
        if (mergedPoints(grid1, side1)) continue;
        const toward = back ? -1 : 1;
        for (
          let k = back ? side1.count - 1 : 0;
          back ? k > 1 : k < side1.count - 2;
          k += 2 * toward
        ) {
          const [a, b] = [pointOf(side1, k), pointOf(side1, k + 2 * toward)];
          const grid2 = grids[n2]!;
          for (const alongWidth2 of [true, false]) {
            if ((alongWidth2 ? grid2.width : grid2.height) >= MAX_GRID_SIZE) continue;
            for (const last2 of [false, true]) {
              const side2 = sideOf(grid2, alongWidth2, last2);
              const l = crackAt(grid1.verts, a, b, grid2, side2);
              if (l < 0) continue;
              const point = xyzOf(grid1.verts, pointOf(side1, k + toward));
              // The error after `k`, as Q3 takes it, though searching back the point is before it.
              const errors = errorsAlong(grid1, side1);
              const lodError = k + 1 < errors.length ? errors[k + 1] : PAST_THE_END;
              const insert = alongWidth2 ? gridInsertColumn : gridInsertRow;
              grids[n2] = insert(grid2, l + 1, side2.line, point, lodError);
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * `R_StitchAllPatches` (`tr_bsp.c:1130-1187`): the cracks between grids of a group mended, where a
 * side of one has a point between two of another's, a grid's own sides among them. Each grid in
 * turn mends what it can in every grid of its group, and any grid that gained a column or row tries
 * again, until none does.
 *
 * @param grids - Every surface's, as {@link loadPatchGrids} has them; a stitched grid is replaced.
 * @returns how many cracks were mended, which Q3's console prints as `stitched <n> LoD cracks`
 */
export function stitchAllPatches(grids: (PatchGrid | null)[]): number {
  // `lodStitched`. A grid made by a stitch is a new one, and not in it.
  const tried = new Set<PatchGrid>();
  let stitches = 0;
  let any: boolean;
  do {
    any = false;
    for (let i = 0; i < grids.length; i++) {
      const grid1 = grids[i];
      if (!grid1 || tried.has(grid1)) continue;
      tried.add(grid1);
      any = true;
      // `R_TryStitchingPatch` (`tr_bsp.c:1130-1154`). Q3 holds `grid1` even once a stitch into
      // itself has freed it, and the freed block may not read as its group; the port keeps it.
      for (let j = 0; j < grids.length; j++) {
        const grid2 = grids[j];
        if (!grid2 || !sameGroup(grid1, grid2)) continue;
        while (stitchPatches(grids, i, j)) stitches++;
      }
    }
  } while (any);
  return stitches;
}

/**
 * `R_FixSharedVertexLodError` (`tr_bsp.c:577-707`): where grids of a group share a point between
 * the ends of their sides, the later takes the earlier's error for it, so that both keep or drop it
 * alike. From the first grid of a group, each grid that takes an error passes its own on in turn,
 * and each grid is fixed once. A side with two points merged neither gives nor takes.
 */
export function fixSharedVertexLodError(grids: (PatchGrid | null)[]): void {
  const fixed = new Set<PatchGrid>();
  const fixFrom = (start: number, grid1: PatchGrid): void => {
    const sides1 = sidesOf(grid1).filter((side) => !mergedPoints(grid1, side));
    for (let j = start; j < grids.length; j++) {
      const grid2 = grids[j];
      if (!grid2 || fixed.has(grid2) || !sameGroup(grid1, grid2)) continue;
      const sides2 = sidesOf(grid2).filter((side) => !mergedPoints(grid2, side));
      let touched = false;
      for (const side1 of sides1) {
        for (let k = 1; k < side1.count - 1; k++) {
          for (const side2 of sides2) {
            for (let l = 1; l < side2.count - 1; l++) {
              if (!near(grid1.verts, pointOf(side1, k), grid2.verts, pointOf(side2, l))) continue;
              errorsAlong(grid2, side2)[l] = errorsAlong(grid1, side1)[k];
              touched = true;
            }
          }
        }
      }
      if (touched) {
        fixed.add(grid2);
        fixFrom(start, grid2);
      }
    }
  };
  grids.forEach((grid, i) => {
    if (!grid || fixed.has(grid)) return;
    fixed.add(grid);
    fixFrom(i + 1, grid);
  });
}

/**
 * Every surface's grid, in lump order as `R_LoadSurfaces` makes them, stitched and their errors
 * fixed (`tr_bsp.c:1258-1285`): a patch's, or `null` for a nodraw patch and for every other
 * surface.
 *
 * @param shift - What the colours are shifted by (`world-light.ts`).
 * @param subdivisions - `r_subdivisions`.
 */
export function loadPatchGrids(
  bsp: Bsp,
  shift: number,
  subdivisions: number
): (PatchGrid | null)[] {
  const grids = bsp.surfaces.map((surface, i) =>
    surface.surfaceType === MST_PATCH ? parseMesh(bsp, i, shift, subdivisions) : null
  );
  stitchAllPatches(grids);
  fixSharedVertexLodError(grids);
  return grids;
}

/** Room for a grid's tables, at any level of detail. */
export function gridTables(): GridTables {
  return {
    widthTable: new Int32Array(MAX_GRID_SIZE),
    lodWidth: 0,
    heightTable: new Int32Array(MAX_GRID_SIZE),
    lodHeight: 0
  };
}

/**
 * A grid's every column and row: how it draws whole.
 *
 * @param into - Filled in place, and returned.
 */
export function wholeGrid(
  grid: Pick<PatchGrid, 'width' | 'height'>,
  into: GridTables = gridTables()
): GridTables {
  for (let i = 0; i < grid.width; i++) into.widthTable[i] = i;
  for (let j = 0; j < grid.height; j++) into.heightTable[j] = j;
  into.lodWidth = grid.width;
  into.lodHeight = grid.height;
  return into;
}

/**
 * `LodErrorForVolume` (`tr_surface.c:825-853`): the error a grid's columns and rows may have and
 * still be drawn, for a view. It is `r_lodCurveError` over the depth of the grid's group along
 * the view, in front or behind, less the group's radius and at least 1; or 0 when the cvar is
 * below 0. An error is one over how far its column stood off the chord, so at 250 a column a unit
 * off is dropped beyond 250 units.
 *
 * @param orientation - The entity the grid is drawn by, or `null` for the world.
 * @param eye - Where the view is.
 * @param forward - The way it looks, of unit length.
 */
export function lodErrorForVolume(
  grid: Pick<PatchGrid, 'lodOrigin' | 'lodRadius'>,
  orientation: Orientation | null,
  eye: Readonly<ViewVector>,
  forward: Readonly<ViewVector>,
  lodCurveError: number
): number {
  const value = f(lodCurveError);
  if (value < 0) return 0;
  const x = grid.lodOrigin[0];
  const y = grid.lodOrigin[1];
  const z = grid.lodOrigin[2];
  let wx = x;
  let wy = y;
  let wz = z;
  // The world's is the identity, which leaves the centre as it is.
  if (orientation) {
    const { origin, axis } = orientation;
    wx = f(f(f(f(x * axis[0][0]) + f(y * axis[1][0])) + f(z * axis[2][0])) + origin[0]);
    wy = f(f(f(f(x * axis[0][1]) + f(y * axis[1][1])) + f(z * axis[2][1])) + origin[1]);
    wz = f(f(f(f(x * axis[0][2]) + f(y * axis[1][2])) + f(z * axis[2][2])) + origin[2]);
  }
  const dx = f(wx - f(eye.x));
  const dy = f(wy - f(eye.y));
  const dz = f(wz - f(eye.z));
  let d = f(f(f(dx * f(forward.x)) + f(dy * f(forward.y))) + f(dz * f(forward.z)));
  if (d < 0) d = -d;
  d = f(d - grid.lodRadius);
  if (d < 1) d = 1;
  return f(value / d);
}

/** One side's table: the first entry, those whose error is within `lodError`, and the last. */
function keptAlong(errors: Float32Array, size: number, lodError: number, table: Int32Array) {
  table[0] = 0;
  let kept = 1;
  for (let i = 1; i < size - 1; i++) {
    if (errors[i] <= lodError) table[kept++] = i;
  }
  table[kept++] = size - 1;
  return kept;
}

/**
 * The columns and rows a level of detail keeps (`tr_surface.c:888-908`): those whose error is
 * within `lodError`, and the first and the last. A larger allowance keeps all a smaller one does,
 * so how many it keeps says which.
 *
 * @param into - Filled in place, and returned.
 */
export function lodTables(
  grid: Pick<PatchGrid, 'width' | 'height' | 'widthLodError' | 'heightLodError'>,
  lodError: number,
  into: GridTables = gridTables()
): GridTables {
  into.lodWidth = keptAlong(grid.widthLodError, grid.width, lodError, into.widthTable);
  into.lodHeight = keptAlong(grid.heightLodError, grid.height, lodError, into.heightTable);
  return into;
}

/**
 * A grid's triangles over `count` of its kept rows from `first` on, as `RB_SurfaceGrid` lists
 * them (`tr_surface.c:974-1004`): two a quad, in Q3's order and winding.
 *
 * @param base - Where the grid's points start among the world's vertices.
 * @param out - Written from `at`, each index a point's place among the world's vertices.
 * @returns Where the next index goes.
 */
export function gridIndexes(
  grid: Pick<PatchGrid, 'width'>,
  tables: GridTables,
  first: number,
  count: number,
  base: number,
  out: Uint32Array,
  at: number
): number {
  const { widthTable, heightTable, lodWidth } = tables;
  const { width } = grid;
  for (let i = 0; i < count - 1; i++) {
    const row = base + heightTable[first + i] * width;
    const next = base + heightTable[first + i + 1] * width;
    for (let j = 0; j < lodWidth - 1; j++) {
      const v1 = row + widthTable[j + 1];
      const v2 = row + widthTable[j];
      const v3 = next + widthTable[j];
      const v4 = next + widthTable[j + 1];
      out[at++] = v2;
      out[at++] = v3;
      out[at++] = v1;
      out[at++] = v1;
      out[at++] = v3;
      out[at++] = v4;
    }
  }
  return at;
}
