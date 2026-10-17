import type { Vec3 as ViewVector } from '../sim/vec3';
import type { RunIndexes } from './world-indexes';

/**
 * A map's sky as opengl1 makes it (`tr_sky.c`): a box about the eye, each side cut into 8 by 8
 * blocks, and the clouds' texture coordinates at the blocks' corners.
 *
 * A sky draws none of its own triangles. Each time Q3 draws a sky batch it takes the triangles from
 * the eye onto the box, and draws the box and the clouds over the blocks they cover alone
 * (`RB_StageIteratorSky`, `tr_sky.c:779-826`). Here the blocks are found again only when the eye
 * moves or a batch is cut again, and the sky's indexes written again only where they change.
 *
 * The arithmetic is C's `float`'s, each operation rounded to single precision in Q3's order.
 *
 * Engine-free, like the rest of `src/view/`.
 */

/** `SKY_SUBDIVISIONS` (`tr_sky.c:25`): the blocks along each side of the box. */
export const SKY_SUBDIVISIONS = 8;

/** `HALF_SKY_SUBDIVISIONS` (`tr_sky.c:26`). */
export const HALF_SKY_SUBDIVISIONS = SKY_SUBDIVISIONS / 2;

/** The corners along each side of the box: one more than its blocks. */
export const SKY_POINTS = SKY_SUBDIVISIONS + 1;

/** The suffixes of the outer box's faces, side by side (`ParseSkyParms`, `tr_shader.c:1257`). */
export const SKY_SUFFIXES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'] as const;

/** The radius of the clouds' sphere, `radiusWorld` (`tr_sky.c:673`). */
const RADIUS_WORLD = 4096;

/** The far plane the clouds' table is made at, set as no world bounds one (`tr_sky.c:679-681`). */
const TABLE_Z_FAR = 1024;

/**
 * `st_to_vec` (`tr_sky.c:307-317`): where each side's x, y and z come from: 1 its s, 2 its t and 3
 * the box's half-size, negative for their opposite.
 */
const ST_TO_VEC = [
  [3, -1, 2],
  [-3, 1, 2],
  [1, 3, 2],
  [-1, -3, 2],
  [-2, -1, 3],
  [2, -1, -3]
] as const;

type Vec3 = [number, number, number];

const f = Math.fround;

/**
 * `MakeSkyVec`'s point (`tr_sky.c:304-370`): where `s` and `t`, each −1 to 1, fall on a side of
 * the box about the eye, whose half-size is the far plane over 1.75.
 *
 * @param zFar - The view's far plane.
 */
export function skyVec(s: number, t: number, side: number, zFar: number): Vec3 {
  const boxSize = f(zFar / 1.75);
  const b = [f(s * boxSize), f(t * boxSize), boxSize];
  const [x, y, z] = ST_TO_VEC[side].map((k) => (k < 0 ? -b[-k - 1] : b[k - 1]));
  return [x, y, z];
}

/** `VectorNormalize` (`q_math.c:790-807`): `v` made unit length in place. */
function normalize(v: Vec3): void {
  const length = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  if (!length) return;
  const ilength = f(1 / f(Math.sqrt(length)));
  for (let k = 0; k < 3; k++) v[k] = f(v[k] * ilength);
}

/**
 * `R_InitSkyTexCoords` (`tr_sky.c:670-724`): the clouds' texture coordinates at each side's
 * corners. The ray from the eye to a corner meets a sphere of radius 4096 whose top stands
 * `heightCloud` above the eye, and the coordinates are the angles off the x and y axes, in
 * radians, from the sphere's centre to there.
 *
 * @returns s and t at each corner: `((side * SKY_POINTS + t) * SKY_POINTS + s) * 2`, t and s 0 to 8
 */
export function cloudTexCoords(heightCloud: number): Float32Array {
  const coords = new Float32Array(6 * SKY_POINTS * SKY_POINTS * 2);
  const radius = RADIUS_WORLD;
  const height = f(heightCloud);
  const square = (a: number) => f(a * a);
  for (let side = 0; side < 6; side++) {
    for (let t = 0; t < SKY_POINTS; t++) {
      for (let s = 0; s < SKY_POINTS; s++) {
        const [x, y, z] = skyVec(
          f((s - HALF_SKY_SUBDIVISIONS) / HALF_SKY_SUBDIVISIONS),
          f((t - HALF_SKY_SUBDIVISIONS) / HALF_SKY_SUBDIVISIONS),
          side,
          TABLE_Z_FAR
        );
        // How far along the ray the sphere is met, its root taken in doubles.
        const dot = f(f(square(x) + square(y)) + square(z));
        let root = f(square(z) * square(radius));
        root = f(root + f(f(f(2 * square(x)) * radius) * height));
        root = f(root + f(square(x) * square(height)));
        root = f(root + f(f(f(2 * square(y)) * radius) * height));
        root = f(root + f(square(y) * square(height)));
        root = f(root + f(f(f(2 * square(z)) * radius) * height));
        root = f(root + f(square(z) * square(height)));
        const p = f(f(1 / f(2 * dot)) * (f(f(-2 * z) * radius) + 2 * Math.sqrt(root)));

        const v: Vec3 = [f(x * p), f(y * p), f(f(z * p) + radius)];
        normalize(v);
        const at = ((side * SKY_POINTS + t) * SKY_POINTS + s) * 2;
        // `Q_acos` (`q_math.c:1034-1046`): `acos` in doubles, rounded; its hold at π does nothing.
        coords[at] = f(Math.acos(v[0]));
        coords[at + 1] = f(Math.acos(v[1]));
      }
    }
  }
  return coords;
}

/** The sky's points, each side's 9 by 9 in turn. */
export const SKY_VERTICES = 6 * SKY_POINTS * SKY_POINTS;

/** A point's number among the sky's: on `side`, at row `t` and column `s`, each 0 to 8. */
const pointOf = (side: number, t: number, s: number) => (side * SKY_POINTS + t) * SKY_POINTS + s;

/**
 * Every corner of every block, each side's in turn, where `MakeSkyVec` puts it about the eye
 * (`tr_sky.c:464-480, 614-627`).
 *
 * @param zFar - The far plane the box is made at.
 * @returns x, y and z at each point, numbered as {@link cloudTexCoords} numbers them
 */
export function skyPoints(zFar: number): Float32Array {
  const points = new Float32Array(SKY_VERTICES * 3);
  for (let side = 0; side < 6; side++) {
    for (let t = 0; t < SKY_POINTS; t++) {
      for (let s = 0; s < SKY_POINTS; s++) {
        const corner = skyVec(
          f((s - HALF_SKY_SUBDIVISIONS) / HALF_SKY_SUBDIVISIONS),
          f((t - HALF_SKY_SUBDIVISIONS) / HALF_SKY_SUBDIVISIONS),
          side,
          zFar
        );
        points.set(corner, pointOf(side, t, s) * 3);
      }
    }
  }
  return points;
}

/**
 * The box's texture coordinates at each point: `MakeSkyVec`'s, 0 to 1 across a side with t turned
 * over. opengl1 clamps the faces to their edges, so it takes no half-texel in from them
 * (`tr_sky.c:452-459`).
 *
 * @returns s and t at each point, numbered as {@link cloudTexCoords} numbers them
 */
export function boxTexCoords(): Float32Array {
  const coords = new Float32Array(SKY_VERTICES * 2);
  for (let side = 0; side < 6; side++) {
    for (let t = 0; t < SKY_POINTS; t++) {
      for (let s = 0; s < SKY_POINTS; s++) {
        const at = pointOf(side, t, s) * 2;
        coords[at] = s / SKY_SUBDIVISIONS;
        coords[at + 1] = 1 - t / SKY_SUBDIVISIONS;
      }
    }
  }
  return coords;
}

/** `sky_clip` (`tr_sky.c:39-47`): the planes between the box's sides, through the eye. */
const SKY_CLIP = [
  [1, 1, 0],
  [1, -1, 0],
  [0, -1, 1],
  [0, 1, 1],
  [1, 0, 1],
  [-1, 0, 1]
] as const;

/**
 * `vec_to_st` (`tr_sky.c:73-86`): where a point's s, t and depth on each side come from: 1 its x,
 * 2 its y and 3 its z, negative for their opposite.
 */
const VEC_TO_ST = [
  [-2, 3, 1],
  [2, 3, -1],
  [1, 3, 2],
  [-1, 3, -2],
  [-2, -1, 3],
  [-2, 1, -3]
] as const;

/** `ON_EPSILON` (`tr_sky.c:151`): how near a plane a point is taken to lie on it. */
const ON_EPSILON = f(0.1);

/** `MAX_CLIP_VERTS` (`tr_sky.c:152`): the points a piece has room for. */
const MAX_CLIP_VERTS = 64;

/** Which side of a plane a point is on (`tr_local.h:665-667`). */
const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_ON = 2;

/**
 * `sky_mins` and `sky_maxs` (`tr_sky.c:49`): how far each side's pieces reach, s and t from −1 to
 * 1 across it. Each side's least s in turn, then each side's least t; the greatest likewise.
 */
const skyMins = new Float32Array(12);
const skyMaxs = new Float32Array(12);

/** The triangle a clip begins from, and the two pieces each plane cuts a polygon into. */
const triangle = new Float32Array(MAX_CLIP_VERTS * 3);
const pieces = Array.from({ length: 6 }, () => [
  new Float32Array(MAX_CLIP_VERTS * 3),
  new Float32Array(MAX_CLIP_VERTS * 3)
]);

/** Each point's side of the plane being cut by, and its distance from it. */
const sides = new Uint8Array(MAX_CLIP_VERTS);
const dists = new Float32Array(MAX_CLIP_VERTS);

/** A point's coordinate, as `vec_to_st` names it. */
const along = (vecs: Float32Array, at: number, k: number) =>
  k < 0 ? -vecs[at - k - 1] : vecs[at + k - 1];

/**
 * `AddSkyPolygon` (`tr_sky.c:65-149`): a piece within one side's planes widens that side's reach.
 * The side is the one its points' sum points at most nearly; a point less than 0.001 in front of it
 * is too near the eye to project.
 */
function addSkyPolygon(nump: number, vecs: Float32Array): void {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let at = 0; at < nump * 3; at += 3) {
    x = f(vecs[at] + x);
    y = f(vecs[at + 1] + y);
    z = f(vecs[at + 2] + z);
  }
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let axis: number;
  if (ax > ay && ax > az) axis = x < 0 ? 1 : 0;
  else if (ay > az && ay > ax) axis = y < 0 ? 3 : 2;
  else axis = z < 0 ? 5 : 4;

  const toS = VEC_TO_ST[axis][0];
  const toT = VEC_TO_ST[axis][1];
  const toDepth = VEC_TO_ST[axis][2];
  for (let at = 0; at < nump * 3; at += 3) {
    const dv = along(vecs, at, toDepth);
    if (dv < 0.001) continue;
    const s = f(along(vecs, at, toS) / dv);
    const t = f(along(vecs, at, toT) / dv);
    if (s < skyMins[axis]) skyMins[axis] = s;
    if (t < skyMins[6 + axis]) skyMins[6 + axis] = t;
    if (s > skyMaxs[axis]) skyMaxs[axis] = s;
    if (t > skyMaxs[6 + axis]) skyMaxs[6 + axis] = t;
  }
}

/** A point's x, y and z copied from one polygon to another. */
function copyPoint(from: Float32Array, at: number, to: Float32Array, into: number): void {
  to[into] = from[at];
  to[into + 1] = from[at + 1];
  to[into + 2] = from[at + 2];
}

/**
 * `ClipSkyPolygon` (`tr_sky.c:158-247`): a polygon cut by each plane from `stage` on, and each
 * piece within all six added to its side. A plane with none of the polygon's points on one side of
 * it leaves the polygon whole.
 */
function clipSkyPolygon(nump: number, vecs: Float32Array, stage: number): void {
  if (stage === 6) {
    addSkyPolygon(nump, vecs);
    return;
  }
  const nx = SKY_CLIP[stage][0];
  const ny = SKY_CLIP[stage][1];
  const nz = SKY_CLIP[stage][2];
  let front = false;
  let back = false;
  for (let i = 0; i < nump; i++) {
    const at = i * 3;
    const d = f(f(f(vecs[at] * nx) + f(vecs[at + 1] * ny)) + f(vecs[at + 2] * nz));
    if (d > ON_EPSILON) {
      front = true;
      sides[i] = SIDE_FRONT;
    } else if (d < -ON_EPSILON) {
      back = true;
      sides[i] = SIDE_BACK;
    } else {
      sides[i] = SIDE_ON;
    }
    dists[i] = d;
  }
  if (!front || !back) {
    clipSkyPolygon(nump, vecs, stage + 1);
    return;
  }

  // The first point again after the last, for the last edge.
  sides[nump] = sides[0];
  dists[nump] = dists[0];
  vecs.copyWithin(nump * 3, 0, 3);
  const ahead = pieces[stage][0];
  const behind = pieces[stage][1];
  let inAhead = 0;
  let inBehind = 0;
  for (let i = 0; i < nump; i++) {
    const at = i * 3;
    if (sides[i] !== SIDE_BACK) copyPoint(vecs, at, ahead, inAhead++ * 3);
    if (sides[i] !== SIDE_FRONT) copyPoint(vecs, at, behind, inBehind++ * 3);
    if (sides[i] === SIDE_ON || sides[i + 1] === SIDE_ON || sides[i + 1] === sides[i]) continue;
    // Where the edge to the next point crosses the plane, in both pieces.
    const d = f(dists[i] / f(dists[i] - dists[i + 1]));
    for (let j = 0; j < 3; j++) {
      const e = f(vecs[at + j] + f(d * f(vecs[at + 3 + j] - vecs[at + j])));
      ahead[inAhead * 3 + j] = e;
      behind[inBehind * 3 + j] = e;
    }
    inAhead++;
    inBehind++;
  }
  clipSkyPolygon(inAhead, ahead, stage + 1);
  clipSkyPolygon(inBehind, behind, stage + 1);
}

/**
 * The blocks of each side a batch's triangles cover from the eye. `RB_ClipSkyPolygons`
 * (`tr_sky.c:272-289`) takes each triangle from the eye and clips it to the sides. Each side's
 * reach is then rounded out to whole blocks and clamped to the side, as `DrawSkyBox` and
 * `FillCloudBox` round it (`:418-450, 577-609`).
 *
 * @param triangles - Three indexes a triangle, into `positions`; the batch's are `count` from
 *   `base`.
 * @param positions - Each vertex's x, y and z.
 * @param eye - The view's origin, in floats.
 * @param blocks - Written: each side's least s and t and its greatest, in blocks from −4 to 4, side
 *   by side; 0s for a side with no blocks.
 */
export function skyBlocks(
  triangles: Uint32Array,
  base: number,
  count: number,
  positions: Float32Array,
  eye: Float32Array,
  blocks: Int8Array
): void {
  // `ClearSkyBox`.
  skyMins.fill(9999);
  skyMaxs.fill(-9999);
  for (let i = base; i < base + count; i += 3) {
    for (let j = 0; j < 3; j++) {
      const vertex = triangles[i + j] * 3;
      // Stored as floats, so rounded as C's subtraction is.
      for (let k = 0; k < 3; k++) triangle[j * 3 + k] = positions[vertex + k] - eye[k];
    }
    clipSkyPolygon(3, triangle, 0);
  }

  const half = HALF_SKY_SUBDIVISIONS;
  for (let side = 0; side < 6; side++) {
    const at = side * 4;
    const minS = Math.floor(skyMins[side] * half);
    const minT = Math.floor(skyMins[6 + side] * half);
    const maxS = Math.ceil(skyMaxs[side] * half);
    const maxT = Math.ceil(skyMaxs[6 + side] * half);
    blocks.fill(0, at, at + 4);
    if (minS >= maxS || minT >= maxT) continue;
    const s0 = clampToSide(minS);
    const t0 = clampToSide(minT);
    const s1 = clampToSide(maxS);
    const t1 = clampToSide(maxT);
    // Clamped to an edge, a side draws nothing.
    if (s0 === s1 || t0 === t1) continue;
    blocks[at] = s0;
    blocks[at + 1] = t0;
    blocks[at + 2] = s1;
    blocks[at + 3] = t1;
  }
}

/** A block's place held within a side, from −4 to 4. */
const clampToSide = (n: number) =>
  Math.min(Math.max(n, -HALF_SKY_SUBDIVISIONS), HALF_SKY_SUBDIVISIONS);

/**
 * A side's rows as `DrawSkySide` draws them (`tr_sky.c:376-397`): a strip a row, taken as the
 * triangles GL makes of it, every second one turned to keep the strip's winding.
 *
 * @returns where the next index goes
 */
function boxStrips(side: number, blocks: Int8Array, out: Uint32Array, at: number): number {
  const from = side * 4;
  const half = HALF_SKY_SUBDIVISIONS;
  for (let t = blocks[from + 1] + half; t < blocks[from + 3] + half; t++) {
    for (let s = blocks[from] + half; s < blocks[from + 2] + half; s++) {
      const near = pointOf(side, t, s);
      const below = pointOf(side, t + 1, s);
      out[at++] = near;
      out[at++] = below;
      out[at++] = near + 1;
      out[at++] = near + 1;
      out[at++] = below;
      out[at++] = below + 1;
    }
  }
  return at;
}

/**
 * A side's quads as `FillCloudySkySide` adds them (`tr_sky.c:516-535`), row by row.
 *
 * @returns where the next index goes
 */
function cloudQuads(side: number, blocks: Int8Array, out: Uint32Array, at: number): number {
  const from = side * 4;
  const half = HALF_SKY_SUBDIVISIONS;
  for (let t = blocks[from + 1] + half; t < blocks[from + 3] + half; t++) {
    for (let s = blocks[from] + half; s < blocks[from + 2] + half; s++) {
      const near = pointOf(side, t, s);
      const below = pointOf(side, t + 1, s);
      out[at++] = near;
      out[at++] = below;
      out[at++] = near + 1;
      out[at++] = below;
      out[at++] = below + 1;
      out[at++] = near + 1;
    }
  }
  return at;
}

/** The indexes a side has room for: its every block, as two triangles. */
const SIDE_ROOM = SKY_SUBDIVISIONS * SKY_SUBDIVISIONS * 6;

/** The sides the clouds are drawn on: every one but the bottom (`tr_sky.c:554`). */
const CLOUD_SIDES = 5;

/** A range of the sky's indexes. */
export interface SkyRange {
  readonly base: number;
  /** How many: 0 where no block is drawn. */
  count: number;
}

/** What a sky batch draws, among the sky's indexes. */
export interface SkyBatch {
  /** Each side of the box, in side order: its blocks' rows, as strips. */
  readonly box: readonly SkyRange[];
  /** The clouds: each side's blocks but the bottom's, in side order, as quads. */
  readonly clouds: SkyRange;
  /** Each side's blocks, as {@link skyBlocks} writes them. */
  readonly blocks: Int8Array;
}

/** Every block of every side. */
const WHOLE_BOX = Int8Array.from({ length: 24 }, (_, i) => (i % 4 < 2 ? -4 : 4));

/**
 * The sky's indexes: each sky batch's box and clouds, over the blocks its triangles cover from the
 * eye. Each batch has room for the whole box and the clouds over it, each side's at its place.
 */
export class SkyIndexes {
  /** Every sky batch's, each at its place: what the sky's index buffer holds. */
  readonly indexes: Uint32Array<ArrayBuffer>;
  /** Each sky run's batches, as many as it has with its curves whole. */
  readonly runs: readonly (readonly SkyBatch[])[];

  private readonly triangles: Uint32Array;
  private readonly positions: Float32Array;
  private readonly cuts: readonly Pick<RunIndexes, 'batches'>[];
  /** The eye the blocks were last found from; NaN until a view finds them. */
  private readonly eye = new Float32Array(3).fill(NaN);
  /** The runs cut again since their blocks were found. */
  private readonly cutAgain: Uint8Array;
  private readonly found = new Int8Array(24);

  /**
   * Each sky batch with no blocks.
   *
   * @param triangles - The world's indexes, as its runs are cut (`world-indexes.ts`).
   * @param positions - Each of the world's vertices' x, y and z.
   * @param runs - The sky's runs among the world's, in the order they draw.
   */
  constructor(
    triangles: Uint32Array,
    positions: Float32Array,
    runs: readonly Pick<RunIndexes, 'batches'>[]
  ) {
    this.triangles = triangles;
    this.positions = positions;
    this.cuts = runs;
    this.cutAgain = new Uint8Array(runs.length);
    let base = 0;
    this.runs = runs.map((run) =>
      run.batches.map((): SkyBatch => {
        const box = Array.from({ length: 6 }, (_, side) => ({
          base: base + side * SIDE_ROOM,
          count: 0
        }));
        const clouds = { base: base + 6 * SIDE_ROOM, count: 0 };
        base += (6 + CLOUD_SIDES) * SIDE_ROOM;
        return { box, clouds, blocks: new Int8Array(24) };
      })
    );
    this.indexes = new Uint32Array(Math.max(1, base));
  }

  /**
   * Find the blocks again, every run's if the eye moved and each run cut again's if not, and write
   * again the indexes of each batch whose blocks changed.
   *
   * @param rewritten - Told each batch written again, by its run's place among the sky's and its
   *   own in the run, once its indexes and ranges are written.
   */
  view(eye: Readonly<ViewVector>, rewritten: (run: number, batch: number) => void): void {
    const x = f(eye.x);
    const y = f(eye.y);
    const z = f(eye.z);
    const moved = x !== this.eye[0] || y !== this.eye[1] || z !== this.eye[2];
    this.eye[0] = x;
    this.eye[1] = y;
    this.eye[2] = z;
    for (let r = 0; r < this.runs.length; r++) {
      if (!moved && !this.cutAgain[r]) continue;
      this.cutAgain[r] = 0;
      const { batches } = this.cuts[r];
      for (let k = 0; k < batches.length; k++) {
        const { base, count } = batches[k];
        skyBlocks(this.triangles, base, count, this.positions, this.eye, this.found);
        this.place(r, k, this.found, rewritten);
      }
    }
  }

  /** A run cut again, by its place among the sky's: the next view finds its blocks again. */
  cut(run: number): void {
    this.cutAgain[run] = 1;
  }

  /**
   * Every batch over the whole box, and its clouds over all of it but the bottom. The next view
   * finds the blocks again.
   *
   * @param rewritten - Told each batch written again, as {@link SkyIndexes.view} tells it.
   */
  whole(rewritten: (run: number, batch: number) => void): void {
    this.eye.fill(NaN);
    for (let r = 0; r < this.runs.length; r++) {
      for (let k = 0; k < this.runs[r].length; k++) this.place(r, k, WHOLE_BOX, rewritten);
    }
  }

  /** A batch's blocks, and its indexes written again if they changed. */
  private place(
    run: number,
    k: number,
    blocks: Int8Array,
    rewritten: (run: number, batch: number) => void
  ): void {
    const batch = this.runs[run][k];
    let same = true;
    for (let i = 0; i < 24 && same; i++) same = batch.blocks[i] === blocks[i];
    if (same) return;
    batch.blocks.set(blocks);
    for (let side = 0; side < 6; side++) {
      const range = batch.box[side];
      range.count = boxStrips(side, blocks, this.indexes, range.base) - range.base;
    }
    const { clouds } = batch;
    let at = clouds.base;
    for (let side = 0; side < CLOUD_SIDES; side++) at = cloudQuads(side, blocks, this.indexes, at);
    clouds.count = at - clouds.base;
    rewritten(run, k);
  }
}
