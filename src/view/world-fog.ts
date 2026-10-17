import type { Bsp } from '../formats/bsp';
import type { WorldFogParms, WorldShader } from './world-shaders';

/**
 * A map's fogs as opengl1 loads them (`R_LoadFogs`, `tr_bsp.c:1531-1637`), the image every fog
 * is drawn with (`R_CreateFogImage`, `tr_image.c:1163-1183`), and the coordinates a fogged
 * surface reads it at (`RB_CalcFogTexCoords`, `tr_shade_calc.c:805-881`).
 *
 * The image's arithmetic is C's `float`'s, each operation rounded to single precision in Q3's
 * order. The coordinates are worked out in doubles, for a shader to repeat in floats.
 *
 * Engine-free, like the rest of `src/view/`.
 */

type Vec3 = [number, number, number];

const f = Math.fround;

/** `FOG_TABLE_SIZE` (`tr_local.h:834`). */
export const FOG_TABLE_SIZE = 256;

/**
 * The fog image's width, along the view, and its height, down from a fog's face
 * (`tr_image.c:1161-1162`).
 */
export const FOG_S = 256;
export const FOG_T = 32;

/** A shader's `fogParms` where its parse reached none: cleared, as `R_FindShader` clears them. */
const NO_FOG_PARMS: WorldFogParms = { color: [0, 0, 0], depthForOpaque: 0 };

/** A fog volume (`fog_t`, `tr_local.h:441-452`). */
export interface WorldFog {
  /** The brush it fills (`originalBrushNumber`). */
  brushNum: number;
  /** Its least corner and its greatest, from its brush's first six sides. */
  bounds: [Vec3, Vec3];
  /** Its shader's `fogParms`; its colour is drawn as {@link fogColor} makes it. */
  parms: WorldFogParms;
  /** How fast it thickens with distance: `1 / (depthForOpaque · 8)`, the depth 1 at least. */
  tcScale: number;
  /**
   * The plane its face lies on, turned to face into it: a point's depth under the face is
   * `surface · p − surface[3]`. None where it shows no face, and then an eye anywhere is in it.
   */
  surface?: [number, number, number, number];
}

/**
 * `R_LoadFogs`: each fog's bounds, its shader found in turn, and the plane its face lies on.
 *
 * @param findShader - `R_FindShader` at `LIGHTMAP_NONE`.
 * @throws `fog brushNumber out of range` and `fog brush sideNumber out of range`, compared unsigned
 *   as Q3 compares them; and in the port's own words for a side or a plane outside its lump, which
 *   Q3 reads past
 */
export function loadFogs(
  bsp: Bsp,
  findShader: (name: string) => Pick<WorldShader, 'fogParms'>
): WorldFog[] {
  const { brushes, brushSides, planes } = bsp;
  return bsp.fogs.map((fog, i) => {
    if (fog.brushNum >>> 0 >= brushes.length) throw new Error('fog brushNumber out of range');
    const { firstSide } = brushes[fog.brushNum];
    if (firstSide >>> 0 > (brushSides.length - 6) >>> 0) {
      throw new Error('fog brush sideNumber out of range');
    }
    const plane = (side: number) => {
      const planeNum = brushSides[side]?.planeNum;
      if (planeNum === undefined) {
        throw new Error(`R_LoadFogs: fog ${i}'s side ${side} lies outside the brush sides`);
      }
      const found = planes[planeNum];
      if (!found) {
        throw new Error(
          `R_LoadFogs: brush side ${side}'s plane ${planeNum} lies outside the planes`
        );
      }
      return found;
    };

    // A brush's axial sides come first: −x, +x, −y, +y, −z, +z.
    const dists = [0, 1, 2, 3, 4, 5].map((k) => plane(firstSide + k).dist);
    const bounds: [Vec3, Vec3] = [
      [-dists[0], -dists[2], -dists[4]],
      [dists[1], dists[3], dists[5]]
    ];
    const { color, depthForOpaque } = findShader(fog.shader).fogParms ?? NO_FOG_PARMS;
    const depth = depthForOpaque < 1 ? 1 : depthForOpaque;
    const made: WorldFog = {
      brushNum: fog.brushNum,
      bounds,
      parms: { color: [...color], depthForOpaque },
      tcScale: f(1 / f(depth * 8))
    };
    if (fog.visibleSide !== -1) {
      const { normal, dist } = plane(firstSide + fog.visibleSide);
      made.surface = [0 - normal[0], 0 - normal[1], 0 - normal[2], -dist];
    }
    return made;
  });
}

/**
 * A fog's colour, as `ColorBytes4` packs it (`tr_bsp.c:1615-1617`, `q_math.c:234-243`): each
 * channel at `identityLight`, times 255 and truncated to a byte, and an alpha of 255. A channel
 * past a byte keeps its low eight bits, as x86 converts it.
 *
 * @param identityLight - `tr.identityLight`.
 */
export function fogColor(
  parms: WorldFogParms,
  identityLight: number
): [number, number, number, number] {
  const byte = (x: number) => Math.trunc(f(x * 255)) & 0xff;
  const [r, g, b] = parms.color.map((channel) => byte(f(channel * identityLight)));
  return [r, g, b, byte(1)];
}

/** `R_InitFogTable` (`tr_image.c:1107-1119`): a fog's density by its thickness, 0 to 1. */
const FOG_TABLE = Float32Array.from({ length: FOG_TABLE_SIZE }, (_, i) =>
  Math.pow(f(i / (FOG_TABLE_SIZE - 1)), 0.5)
);

/**
 * `R_FogFactor` (`tr_image.c:1130-1154`): how dense a fog is, 0 to 1, at `s` along the view and
 * `t` down from its face, each as `RB_CalcFogTexCoords` works them out. Under a `t` of 1/32 there
 * is none, and it thins toward there from 31/32.
 */
export function fogFactor(s: number, t: number): number {
  const depth = f(t);
  let d = f(f(s) - 1 / 512);
  if (d < 0) return 0;
  if (depth < 1 / 32) return 0;
  if (depth < 31 / 32) d = f(d * f(f(depth - 1 / 32) / (30 / 32)));
  d = f(d * 8);
  if (d > 1) d = 1;
  return FOG_TABLE[Math.trunc(f(d * (FOG_TABLE_SIZE - 1)))];
}

/**
 * `R_CreateFogImage`: white, each texel's alpha the fog's density at its centre, times 255 and
 * truncated.
 *
 * @returns {@link FOG_S} by {@link FOG_T} RGBA texels, a row of s at each t from 0
 */
export function fogImage(): Uint8Array {
  const data = new Uint8Array(FOG_S * FOG_T * 4);
  for (let x = 0; x < FOG_S; x++) {
    for (let y = 0; y < FOG_T; y++) {
      const d = fogFactor(f((x + 0.5) / FOG_S), f((y + 0.5) / FOG_T));
      const at = (y * FOG_S + x) * 4;
      data.fill(255, at, at + 3);
      data[at + 3] = Math.trunc(f(255 * d));
    }
  }
  return data;
}

/** A frame a surface's vertices are placed in: its origin, and its forward, left and up axes. */
export interface FogFrame {
  origin: Readonly<Vec3>;
  axis: readonly [Readonly<Vec3>, Readonly<Vec3>, Readonly<Vec3>];
  /**
   * `nonNormalizedAxes`: its axes are scaled, as cgame scales an item's, and the eye in it is
   * measured as `R_RotateForEntity` measures it, by the first axis's length alone
   * (`tr_main.c:314-329`).
   */
  nonNormalizedAxes?: boolean;
}

/** The world's own frame. */
export const WORLD_FRAME: FogFrame = {
  origin: [0, 0, 0],
  axis: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ]
};

/**
 * What a fog's coordinates are worked out from, for one view, in one frame: two planes its vertices
 * are measured against, and where the eye is.
 */
export interface FogVectors {
  /** s: a vertex's depth along the view's forward axis, times the fog's scale, plus 1/512. */
  distance: [number, number, number, number];
  /** t: a vertex's depth under the fog's face; nothing for a fog with none. */
  depth: [number, number, number, number];
  /** The eye's depth under the face: under 0 it is outside the fog. 1 for a fog with no face. */
  eyeT: number;
}

/** The dot product of the first three of each. */
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * `RB_CalcFogTexCoords`' vectors for a view, in a frame as `R_RotateForEntity` sets one up
 * (`tr_main.c:272-331`): the world's, or a brush model's where it is placed.
 *
 * @param eye - The view's origin, in the world's frame.
 * @param forward - The view's forward axis, in the world's frame.
 * @param into - Written in place, and returned; new vectors by default.
 */
export function fogVectors(
  fog: Pick<WorldFog, 'tcScale' | 'surface'>,
  eye: Readonly<Vec3>,
  forward: Readonly<Vec3>,
  frame: FogFrame = WORLD_FRAME,
  into: FogVectors = { distance: [0, 0, 0, 0], depth: [0, 0, 0, 0], eyeT: 0 }
): FogVectors {
  const { origin, axis } = frame;
  // From the eye to the frame's origin.
  const tx = origin[0] - eye[0];
  const ty = origin[1] - eye[1];
  const tz = origin[2] - eye[2];
  const scale = fog.tcScale;
  const { distance, depth } = into;
  for (let k = 0; k < 3; k++) distance[k] = dot(forward, axis[k]) * scale;
  distance[3] = (tx * forward[0] + ty * forward[1] + tz * forward[2]) * scale + 1 / 512;
  const { surface } = fog;
  if (!surface) {
    depth.fill(0);
    into.eyeT = 1;
    return into;
  }
  for (let k = 0; k < 3; k++) depth[k] = dot(surface, axis[k]);
  depth[3] = -surface[3] + dot(origin, surface);
  // The eye in the frame, over the first axis's length where the axes are scaled: off by that
  // length for a scaled frame, as Q3's is.
  let toEye = 1;
  if (frame.nonNormalizedAxes) {
    const length = Math.hypot(axis[0][0], axis[0][1], axis[0][2]);
    toEye = length === 0 ? 0 : 1 / length;
  }
  let eyeT = 0;
  for (let k = 0; k < 3; k++) {
    const along = axis[k];
    eyeT += -(tx * along[0] + ty * along[1] + tz * along[2]) * toEye * depth[k];
  }
  into.eyeT = eyeT + depth[3];
  return into;
}

/** A fog's box, which the tests below find a draw's fog by. */
type FogBox = Pick<WorldFog, 'bounds'>;

/**
 * The first fog a sphere's box overlaps, one only touching it not counted, in Q3's floats: the
 * test `R_ComputeFogNum` and `R_SpriteFogNum` share.
 *
 * @param center - Each axis's centre, given in turn; worked out in floats by the caller.
 * @returns 0 for none, else the fog's place among the map's plus one, as the sort key holds it
 */
function sphereFog(
  fogs: readonly FogBox[],
  center: (axis: number) => number,
  radius: number
): number {
  const r = f(radius);
  for (let i = 0; i < fogs.length; i++) {
    const [mins, maxs] = fogs[i].bounds;
    let j = 0;
    for (; j < 3; j++) {
      const at = center(j);
      if (f(at - r) >= maxs[j]) break;
      if (f(at + r) <= mins[j]) break;
    }
    if (j === 3) return i + 1;
  }
  return 0;
}

/**
 * `R_ComputeFogNum` (`tr_mesh.c:245-274`): the fog an MD3 is drawn in, by the sphere of the frame
 * it is drawn at, its `localOrigin` added to the entity's origin unturned.
 *
 * @param fogs - The scene's world's, none where the scene has no world (`RDF_NOWORLDMODEL`).
 * @param localOrigin - The frame's, and its `radius`: `refEntity.frame`'s, not the older one's.
 * @returns 0 for none, else the fog's place among the map's plus one
 */
export function modelFogNum(
  fogs: readonly FogBox[],
  origin: Readonly<Vec3>,
  localOrigin: Readonly<Vec3>,
  radius: number
): number {
  return sphereFog(fogs, (j) => f(f(origin[j]) + f(localOrigin[j])), radius);
}

/**
 * `R_SpriteFogNum` (`tr_main.c:1004-1032`): the fog a sprite, a beam or the rail's core or rings is
 * drawn in, by the sphere of its `radius` about its `origin`, a beam's start.
 *
 * @returns 0 for none, else the fog's place among the map's plus one
 */
export function spriteFogNum(
  fogs: readonly FogBox[],
  origin: Readonly<Vec3>,
  radius: number
): number {
  return sphereFog(fogs, (j) => f(origin[j]), radius);
}

/**
 * A poly's fog, as `RE_AddPolyToScene` finds it (`tr_scene.c:156-185`): the first fog its points'
 * box overlaps, one only touching it counted.
 *
 * @returns 0 for none, else the fog's place among the map's plus one
 */
export function polyFogNum(fogs: readonly FogBox[], points: readonly Readonly<Vec3>[]): number {
  if (fogs.length === 0 || points.length === 0) return 0;
  const mins = [...points[0]];
  const maxs = [...points[0]];
  for (let i = 1; i < points.length; i++) {
    for (let j = 0; j < 3; j++) {
      const v = points[i][j];
      if (v < mins[j]) mins[j] = v;
      if (v > maxs[j]) maxs[j] = v;
    }
  }
  return boxFogNum(fogs, mins, maxs);
}

/** Scratch for {@link flatPolyFogNum}'s box. */
const polyMins = [0, 0, 0];
const polyMaxs = [0, 0, 0];

/**
 * {@link polyFogNum} for `count` points from the `first`th of `xyz`, three floats a point, making
 * nothing.
 */
export function flatPolyFogNum(
  fogs: readonly FogBox[],
  xyz: ArrayLike<number>,
  first: number,
  count: number
): number {
  if (fogs.length === 0 || count === 0) return 0;
  for (let j = 0; j < 3; j++) polyMins[j] = polyMaxs[j] = xyz[first * 3 + j];
  for (let i = first + 1; i < first + count; i++) {
    for (let j = 0; j < 3; j++) {
      const v = xyz[i * 3 + j];
      if (v < polyMins[j]) polyMins[j] = v;
      if (v > polyMaxs[j]) polyMaxs[j] = v;
    }
  }
  return boxFogNum(fogs, polyMins, polyMaxs);
}

/** The first fog a box overlaps, touching counted: 0 for none, else its place plus one. */
function boxFogNum(
  fogs: readonly FogBox[],
  mins: readonly number[],
  maxs: readonly number[]
): number {
  for (let i = 0; i < fogs.length; i++) {
    const low = fogs[i].bounds[0];
    const high = fogs[i].bounds[1];
    if (
      maxs[0] >= low[0] &&
      maxs[1] >= low[1] &&
      maxs[2] >= low[2] &&
      mins[0] <= high[0] &&
      mins[1] <= high[1] &&
      mins[2] <= high[2]
    ) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * A vertex's coordinates on the fog image, as `RB_CalcFogTexCoords` works them out: s along the
 * view, and t from 1/32 out of the fog to 31/32 in it. With the eye outside, a vertex under the
 * face is cut at it, and one less than a unit under counts as out.
 *
 * @param v - The vertex, in the frame its vectors are in.
 */
export function fogTexCoords(
  { distance, depth, eyeT }: FogVectors,
  v: Readonly<Vec3>
): [number, number] {
  const s = dot(v, distance) + distance[3];
  let t = dot(v, depth) + depth[3];
  if (eyeT < 0) {
    t = t < 1 ? 1 / 32 : 1 / 32 + ((30 / 32) * t) / (t - eyeT);
  } else {
    t = t < 0 ? 1 / 32 : 31 / 32;
  }
  return [s, t];
}
