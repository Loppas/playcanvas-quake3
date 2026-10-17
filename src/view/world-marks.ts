import { MST_PATCH, MST_PLANAR, MST_TRIANGLE_SOUP, type Bsp } from '../formats/bsp';
import {
  addPointToBounds,
  boxOnPlaneSide,
  clearBounds,
  crossProduct,
  dotProduct,
  f,
  planeTypeForNormal,
  signbitsForNormal,
  vectorNormalize2,
  type SidedPlane
} from '../sim/cm/q-math';
import { qRsqrt } from './view-terms';
import type { PatchGrid } from './world-curves';
import type { WorldShaders } from './world-shaders';

/**
 * Where a projected polygon lands on a map's world, as `R_MarkFragments` finds it (`tr_marks.c`):
 * the world's surfaces in the leafs the polygon's box reaches, each cut by the planes of the
 * polygon's sides swept along the projection, and by planes 32 units behind its first point and 20
 * before it. Only the world's tree is searched, so no mark lands on a mover.
 *
 * The first 64 surfaces the walk lists are cut: a face whose plane crosses the box and faces the
 * projection, every curve and every soup listed, though a soup is cut only under
 * `r_marksOnTriangleMeshes` ({@link WorldMarks.onTriangleMeshes}). A surface whose shader's script
 * gives it `noimpact`, `nomarks` or `fog` is never listed. A curve is cut as its whole grid's
 * triangles, whatever its level of detail.
 *
 * The arithmetic is the x86-64 build's floats, in Q3's order.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `MAX_VERTS_ON_POLY` (`tr_marks.c:27`): the points a polygon or a cut may have. */
const MAX_VERTS_ON_POLY = 64;

/** The surfaces a walk lists (`tr_marks.c:259, 316`). */
const MAX_LISTED = 64;

/** `MARKER_OFFSET` (`tr_marks.c:29`): how far a surface's points are moved along their normals. */
const MARKER_OFFSET = 0;

/** How far past a cutting plane a point is still on it (`tr_marks.c:212`). */
const CHOP_EPSILON = 0.5;

/** `SIDE_FRONT`, `SIDE_BACK` and `SIDE_ON` (`tr_marks.c:38-40`). */
const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_ON = 2;

/** How the walk takes a surface, by its `surfaceType_t`. */
const SKIPPED = 0;
const FACE = 1;
const GRID = 2;
const SOUP = 3;

/** A grid as the marks read it: its points' places and normals, a row at a time. */
export type MarkedGrid = Pick<PatchGrid, 'width' | 'height'> & {
  verts: Pick<PatchGrid['verts'], 'xyz' | 'normal'>;
};

/** A map's world as `R_MarkFragments` cuts polygons on it. */
export class WorldMarks {
  /** `r_marksOnTriangleMeshes`: whether a soup is cut, read at each call. */
  onTriangleMeshes = false;
  /** How many surfaces the last call's walk listed, at most 64. */
  listed = 0;

  private readonly bsp: Bsp;
  private readonly grids: readonly (MarkedGrid | null)[];
  /** Each plane as `R_LoadPlanes` makes it (`tr_bsp.c:1489-1520`). */
  private readonly planes: readonly SidedPlane[];
  /** Each surface's kind, and its face's plane as `ParseFace` makes it (`tr_bsp.c:358-363`). */
  private readonly kinds: Uint8Array;
  private readonly facePlanes: (SidedPlane | null)[];
  /** Whether a surface's shader is `noimpact`, `nomarks` or `fog` by its script. */
  private readonly unmarked: Uint8Array;
  /** Each surface's `viewCount`: listed, or passed over, while it equals {@link viewCount}. */
  private readonly surfaceViews: Int32Array;
  private viewCount = 0;

  /** The walk's box, the projection's direction, and the polygon's planes. */
  private readonly mins = [0, 0, 0];
  private readonly maxs = [0, 0, 0];
  private readonly projectionDir = [0, 0, 0];
  private readonly normals = new Float32Array((MAX_VERTS_ON_POLY + 2) * 3);
  private readonly dists = new Float32Array(MAX_VERTS_ON_POLY + 2);
  private numPlanes = 0;
  private readonly surfaces = new Int32Array(MAX_LISTED);
  /** The cuts, ping and pong, and the chop's own. */
  private readonly clipPoints = [
    new Float32Array(MAX_VERTS_ON_POLY * 3),
    new Float32Array(MAX_VERTS_ON_POLY * 3)
  ];
  private readonly sides = new Int8Array(MAX_VERTS_ON_POLY + 4);
  private readonly chopDists = new Float32Array(MAX_VERTS_ON_POLY + 4);
  /** `numClipPoints` as the last chop left it. */
  private numClipPoints = 0;
  /** What the call has returned so far, and where. */
  private returnedPoints = 0;
  private returnedFragments = 0;
  private maxPoints = 0;
  private pointBuffer: Float32Array = new Float32Array(0);
  private fragmentBuffer: Int32Array = new Int32Array(0);
  /** Scratch. */
  private readonly temp = [0, 0, 0];
  private readonly v1 = [0, 0, 0];
  private readonly v2 = [0, 0, 0];
  private readonly normal = [0, 0, 0];
  private readonly point = [0, 0, 0];

  /**
   * @param grids - Each surface's curve, or null for none or for one Q3 skips (`SF_SKIP`).
   */
  constructor(
    bsp: Bsp,
    shaders: Pick<WorldShaders, 'shaders' | 'surfaceShaders'>,
    grids: readonly (MarkedGrid | null)[]
  ) {
    this.bsp = bsp;
    this.grids = grids;
    this.planes = bsp.planes.map(({ normal, dist }) => ({
      normal,
      dist,
      type: planeTypeForNormal(normal),
      signbits: signbitsForNormal(normal)
    }));
    const n = bsp.surfaces.length;
    this.kinds = new Uint8Array(n);
    this.facePlanes = new Array<SidedPlane | null>(n).fill(null);
    this.unmarked = new Uint8Array(n);
    this.surfaceViews = new Int32Array(n);
    const xyz = bsp.drawVerts.xyz;
    bsp.surfaces.forEach((surface, s) => {
      const parms = shaders.shaders[shaders.surfaceShaders[s]]?.script?.surfaceParms ?? [];
      const unmarked = parms.includes('noimpact') || parms.includes('nomarks');
      this.unmarked[s] = unmarked || parms.includes('fog') ? 1 : 0;
      switch (surface.surfaceType) {
        case MST_PLANAR: {
          this.kinds[s] = FACE;
          const normal = surface.lightmapVecs[2];
          const v = surface.firstVert * 3;
          this.facePlanes[s] = {
            normal,
            dist: dotProduct(xyz.subarray(v, v + 3), normal),
            type: planeTypeForNormal(normal),
            signbits: signbitsForNormal(normal)
          };
          break;
        }
        case MST_PATCH:
          this.kinds[s] = grids[s] ? GRID : SKIPPED;
          break;
        case MST_TRIANGLE_SOUP:
          this.kinds[s] = SOUP;
          break;
        default:
          this.kinds[s] = SKIPPED;
      }
    });
  }

  /**
   * `R_MarkFragments` (`tr_marks.c:255-457`): the fragments of a polygon projected onto the world,
   * each a run of points in `pointBuffer` as `fragmentBuffer` gives it, its first point and its
   * count. A fragment that would overflow `maxPoints` is dropped, and the search stops as the
   * fragments reach `maxFragments`.
   *
   * @param points - The polygon's `numPoints` points, three floats each; past 64 the first 64.
   * @param projection - Where the polygon is thrown, and how far.
   * @param fragmentBuffer - Written: each fragment's first point and its count.
   * @returns how many fragments it found
   */
  markFragments(
    numPoints: number,
    points: ArrayLike<number>,
    projection: ArrayLike<number>,
    maxPoints: number,
    pointBuffer: Float32Array,
    maxFragments: number,
    fragmentBuffer: Int32Array
  ): number {
    this.listed = 0;
    if (numPoints <= 0) return 0;
    this.viewCount++;
    const { mins, maxs, projectionDir, normals, dists, temp, v1, v2, point } = this;
    vectorNormalize2(projection, projectionDir);
    clearBounds(mins, maxs);
    for (let i = 0; i < numPoints; i++) {
      this.pointAt(points, i, point);
      addPointToBounds(point, mins, maxs);
      for (let j = 0; j < 3; j++) temp[j] = f(point[j] + projection[j]);
      addPointToBounds(temp, mins, maxs);
      // "make sure we get all the leafs (also the one(s) in front of the hit surface)"
      for (let j = 0; j < 3; j++) temp[j] = f(point[j] + f(projectionDir[j] * -20));
      addPointToBounds(temp, mins, maxs);
    }

    const sides = Math.min(numPoints, MAX_VERTS_ON_POLY);
    // The planes of the polygon's sides, swept along the projection.
    for (let i = 0; i < sides; i++) {
      this.pointAt(points, (i + 1) % sides, temp);
      this.pointAt(points, i, point);
      for (let j = 0; j < 3; j++) v1[j] = f(temp[j] - point[j]);
      for (let j = 0; j < 3; j++) v2[j] = f(point[j] + projection[j]);
      for (let j = 0; j < 3; j++) v2[j] = f(point[j] - v2[j]);
      crossProduct(v1, v2, this.normal);
      normalizeFast(this.normal);
      normals.set(this.normal, i * 3);
      dists[i] = dotProduct(this.normal, point);
    }
    // The near and far planes.
    this.pointAt(points, 0, point);
    normals.set(projectionDir, sides * 3);
    dists[sides] = f(dotProduct(projectionDir, point) - 32);
    for (let j = 0; j < 3; j++) this.normal[j] = -projectionDir[j];
    normals.set(this.normal, (sides + 1) * 3);
    dists[sides + 1] = f(dotProduct(this.normal, point) - 20);
    this.numPlanes = sides + 2;

    const root = this.bsp.nodes.length > 0 ? 0 : -1;
    this.boxSurfaces(root);

    this.returnedPoints = 0;
    this.returnedFragments = 0;
    this.maxPoints = maxPoints;
    this.pointBuffer = pointBuffer;
    this.fragmentBuffer = fragmentBuffer;
    for (let i = 0; i < this.listed; i++) {
      const s = this.surfaces[i];
      const kind = this.kinds[s];
      if (kind === GRID) {
        if (this.markGrid(this.grids[s]!, maxFragments)) break;
      } else if (kind === FACE) {
        if (this.markFace(s, maxFragments)) break;
      } else if (kind === SOUP && this.onTriangleMeshes) {
        if (this.markSoup(s, maxFragments)) break;
      }
    }
    return this.returnedFragments;
  }

  /** The `i`th of the polygon's points. */
  private pointAt(points: ArrayLike<number>, i: number, out: number[]): void {
    out[0] = points[i * 3];
    out[1] = points[i * 3 + 1];
    out[2] = points[i * 3 + 2];
  }

  /**
   * `R_BoxSurfaces_r` (`tr_marks.c:134-188`): the surfaces of every leaf the box reaches, the
   * nearer child first, until 64 are listed. A surface is passed over once a call, as it may be in
   * many leafs.
   *
   * @param n - A node's number, or a leaf's as `-(leaf + 1)`.
   */
  private boxSurfaces(n: number): void {
    const { bsp, mins, maxs, planes } = this;
    while (n >= 0) {
      const node = bsp.nodes[n];
      const s = boxOnPlaneSide(mins, maxs, planes[node.planeNum]);
      if (s === 1) {
        n = node.children[0];
      } else if (s === 2) {
        n = node.children[1];
      } else {
        this.boxSurfaces(node.children[0]);
        n = node.children[1];
      }
    }
    const leaf = bsp.leafs[-1 - n];
    const { viewCount, surfaceViews, projectionDir } = this;
    for (let c = 0; c < leaf.numLeafSurfaces; c++) {
      if (this.listed >= MAX_LISTED) break;
      const s = bsp.leafSurfaces[leaf.firstLeafSurface + c];
      const kind = this.kinds[s];
      if (this.unmarked[s]) {
        surfaceViews[s] = viewCount;
      } else if (kind === FACE) {
        // "the face plane should go through the box", and face the projection.
        const plane = this.facePlanes[s]!;
        const side = boxOnPlaneSide(mins, maxs, plane);
        if (side === 1 || side === 2 || dotProduct(plane.normal, projectionDir) > -0.5) {
          surfaceViews[s] = viewCount;
        }
      } else if (kind !== GRID && kind !== SOUP) {
        surfaceViews[s] = viewCount;
      }
      if (surfaceViews[s] !== viewCount) {
        surfaceViews[s] = viewCount;
        this.surfaces[this.listed++] = s;
      }
    }
  }

  /**
   * A curve's grid cut as two triangles a cell, each that faces the projection
   * (`tr_marks.c:325-404`): the first by −0.1, the second by −0.05.
   *
   * @returns whether the fragments are full
   */
  private markGrid(grid: MarkedGrid, maxFragments: number): boolean {
    const { width, height } = grid;
    const { xyz, normal } = grid.verts;
    const clip = this.clipPoints[0];
    for (let m = 0; m < height - 1; m++) {
      for (let n = 0; n < width - 1; n++) {
        const dv = m * width + n;
        offsetPoint(xyz, normal, dv, clip, 0);
        offsetPoint(xyz, normal, dv + width, clip, 1);
        offsetPoint(xyz, normal, dv + 1, clip, 2);
        if (this.facing(clip) < -0.1) {
          this.addFragments(3);
          if (this.returnedFragments === maxFragments) return true;
        }
        offsetPoint(xyz, normal, dv + 1, clip, 0);
        offsetPoint(xyz, normal, dv + width, clip, 1);
        offsetPoint(xyz, normal, dv + width + 1, clip, 2);
        if (this.facing(clip) < -0.05) {
          this.addFragments(3);
          if (this.returnedFragments === maxFragments) return true;
        }
      }
    }
    return false;
  }

  /** How a triangle of a grid faces the projection: its normal, made unit fast, dotted with it. */
  private facing(clip: Float32Array): number {
    const { v1, v2, normal } = this;
    for (let j = 0; j < 3; j++) {
      v1[j] = f(clip[j] - clip[3 + j]);
      v2[j] = f(clip[6 + j] - clip[3 + j]);
    }
    crossProduct(v1, v2, normal);
    normalizeFast(normal);
    return dotProduct(normal, this.projectionDir);
  }

  /**
   * A face's triangles, if it faces the projection by more than half (`tr_marks.c:405-431`).
   *
   * @returns whether the fragments are full
   */
  private markFace(s: number, maxFragments: number): boolean {
    const plane = this.facePlanes[s]!;
    if (dotProduct(plane.normal, this.projectionDir) > -0.5) return false;
    const { firstVert, firstIndex, numIndexes } = this.bsp.surfaces[s];
    const { drawIndexes, drawVerts } = this.bsp;
    const clip = this.clipPoints[0];
    for (let k = 0; k < numIndexes; k += 3) {
      for (let j = 0; j < 3; j++) {
        const v = (firstVert + drawIndexes[firstIndex + k + j]) * 3;
        for (let a = 0; a < 3; a++) {
          clip[j * 3 + a] = f(drawVerts.xyz[v + a] + f(plane.normal[a] * MARKER_OFFSET));
        }
      }
      this.addFragments(3);
      if (this.returnedFragments === maxFragments) return true;
    }
    return false;
  }

  /**
   * A soup's triangles, each point moved along its own normal (`tr_marks.c:432-454`).
   *
   * @returns whether the fragments are full
   */
  private markSoup(s: number, maxFragments: number): boolean {
    const { firstVert, firstIndex, numIndexes } = this.bsp.surfaces[s];
    const { drawIndexes, drawVerts } = this.bsp;
    const clip = this.clipPoints[0];
    for (let k = 0; k < numIndexes; k += 3) {
      for (let j = 0; j < 3; j++) {
        const v = firstVert + drawIndexes[firstIndex + k + j];
        offsetPoint(drawVerts.xyz, drawVerts.normal, v, clip, j);
      }
      this.addFragments(3);
      if (this.returnedFragments === maxFragments) return true;
    }
    return false;
  }

  /**
   * `R_AddMarkFragments` (`tr_marks.c:196-247`): the triangle in the first cut, chopped by every
   * plane in turn, kept as a fragment if any of it is left and its points fit.
   */
  private addFragments(numClipPoints: number): void {
    const { normals, dists, clipPoints } = this;
    let pingPong = 0;
    this.numClipPoints = numClipPoints;
    for (let i = 0; i < this.numPlanes; i++) {
      const to = clipPoints[pingPong ^ 1];
      this.chopPolyBehindPlane(clipPoints[pingPong], to, normals, i, dists[i]);
      pingPong ^= 1;
      if (this.numClipPoints === 0) break;
    }
    const count = this.numClipPoints;
    if (count === 0) return;
    if (count + this.returnedPoints > this.maxPoints) return;
    const at = this.returnedFragments * 2;
    this.fragmentBuffer[at] = this.returnedPoints;
    this.fragmentBuffer[at + 1] = count;
    copyPoints(clipPoints[pingPong], 0, this.pointBuffer, this.returnedPoints, count);
    this.returnedPoints += count;
    this.returnedFragments++;
  }

  /**
   * `R_ChopPolyBehindPlane` (`tr_marks.c:41-126`): what of a polygon is in front of a plane, a
   * point within the epsilon of it counted on it. A polygon of 62 points or more is dropped, as
   * its cut might overflow.
   *
   * @param p - The plane's place among `normals`.
   */
  private chopPolyBehindPlane(
    inPoints: Float32Array,
    outPoints: Float32Array,
    normals: Float32Array,
    p: number,
    dist: number
  ): void {
    const numInPoints = this.numClipPoints;
    this.numClipPoints = 0;
    if (numInPoints >= MAX_VERTS_ON_POLY - 2) return;
    const { sides, chopDists } = this;
    const nx = normals[p * 3];
    const ny = normals[p * 3 + 1];
    const nz = normals[p * 3 + 2];
    let front = 0;
    let back = 0;
    for (let i = 0; i < numInPoints; i++) {
      const at = i * 3;
      const x = f(inPoints[at] * nx);
      const dot = f(f(f(x + f(inPoints[at + 1] * ny)) + f(inPoints[at + 2] * nz)) - dist);
      chopDists[i] = dot;
      if (dot > CHOP_EPSILON) {
        sides[i] = SIDE_FRONT;
        front++;
      } else if (dot < -CHOP_EPSILON) {
        sides[i] = SIDE_BACK;
        back++;
      } else {
        sides[i] = SIDE_ON;
      }
    }
    sides[numInPoints] = sides[0];
    chopDists[numInPoints] = chopDists[0];

    if (front === 0) return;
    if (back === 0) {
      copyPoints(inPoints, 0, outPoints, 0, numInPoints);
      this.numClipPoints = numInPoints;
      return;
    }
    let numOut = 0;
    for (let i = 0; i < numInPoints; i++) {
      const p1 = i * 3;
      if (sides[i] === SIDE_ON) {
        copyPoints(inPoints, i, outPoints, numOut, 1);
        numOut++;
        continue;
      }
      if (sides[i] === SIDE_FRONT) {
        copyPoints(inPoints, i, outPoints, numOut, 1);
        numOut++;
      }
      if (sides[i + 1] === SIDE_ON || sides[i + 1] === sides[i]) continue;
      // A split point.
      const p2 = ((i + 1) % numInPoints) * 3;
      const d = f(chopDists[i] - chopDists[i + 1]);
      const dot = d === 0 ? 0 : f(chopDists[i] / d);
      for (let j = 0; j < 3; j++) {
        const from = inPoints[p1 + j];
        outPoints[numOut * 3 + j] = f(from + f(dot * f(inPoints[p2 + j] - from)));
      }
      numOut++;
    }
    this.numClipPoints = numOut;
  }
}

/** `count` points from the `from`th of one array to the `to`th of another. */
function copyPoints(
  source: Float32Array,
  from: number,
  target: Float32Array,
  to: number,
  count: number
): void {
  for (let i = 0; i < count * 3; i++) target[to * 3 + i] = source[from * 3 + i];
}

/** A vertex moved {@link MARKER_OFFSET} along its normal, into the cut as its `j`th point. */
function offsetPoint(
  xyz: Float32Array,
  normal: Float32Array,
  v: number,
  clip: Float32Array,
  j: number
): void {
  for (let a = 0; a < 3; a++) {
    clip[j * 3 + a] = f(xyz[v * 3 + a] + f(normal[v * 3 + a] * MARKER_OFFSET));
  }
}

/** `VectorNormalizeFast` (`q_shared.h:623-632`): by `Q_rsqrt`'s estimate, unchecked for zero. */
function normalizeFast(v: number[]): void {
  const ilength = qRsqrt(dotProduct(v, v));
  v[0] = f(v[0] * ilength);
  v[1] = f(v[1] * ilength);
  v[2] = f(v[2] * ilength);
}
