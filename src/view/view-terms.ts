import { MST_PLANAR, type Bsp } from '../formats/bsp';
import { SPECULAR_LIGHT_ORIGIN } from './entity-light';
import type { FogFrame } from './world-fog';

/**
 * The view's terms in a stage, as opengl1 works them out for each vertex of a batch, in its
 * floats: `tcGen environment` and `tcGen vector` (`ComputeTexCoords`, `tr_shade.c:856-867`),
 * `alphaGen lightingSpecular` and `alphaGen portal` (`ComputeColors`, `tr_shade.c:724-776`), each
 * alpha a byte as Q3 stores it. Each reads the vertex where the batch holds it, in its model's
 * frame, and the eye in that frame (`R_RotateForEntity`); the portal's alpha reads the eye in the
 * world's. The normals they read are the ones Q3 gives: a planar face's plane on each of its
 * vertexes (`tr_surface.c:803-808`).
 *
 * These are the arithmetic's definition, with their tests; the world's vertex code mirrors them
 * (`render/view-term-chunks.ts`).
 */

type Vec3 = ArrayLike<number>;

/** One float operation's result, as C rounds it. */
const f = Math.fround;

/** `DotProduct` in floats, in its order. */
function dot(a: Vec3, b: Vec3): number {
  return f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
}

/** A float's bits, for {@link qRsqrt}. */
const bits = new Float32Array(1);
const word = new Int32Array(bits.buffer);

/**
 * `Q_rsqrt` (`q_math.c:507-521`): the reciprocal square root, a first guess from the float's bits
 * and one step of Newton's method. Up to 0.175% under the true value, so a highlight's byte can
 * fall by a few levels from one taken with an exact root.
 */
export function qRsqrt(number: number): number {
  const x2 = f(number * 0.5);
  bits[0] = number;
  word[0] = 0x5f3759df - (word[0] >> 1);
  const y = bits[0];
  return f(y * f(1.5 - f(f(x2 * y) * y)));
}

/** `VectorSubtract`, then `VectorNormalizeFast` (`q_shared.h:623-632`), into `out`. */
function towards(to: Vec3, from: Vec3, out: number[]): number[] {
  for (let k = 0; k < 3; k++) out[k] = f(to[k] - from[k]);
  const ilength = qRsqrt(dot(out, out));
  for (let k = 0; k < 3; k++) out[k] = f(out[k] * ilength);
  return out;
}

/** `v` mirrored in `normal`: `normal · 2 · d − v`, each axis in floats. */
function mirrored(normal: Vec3, v: number[], out: number[]): number[] {
  const d = dot(normal, v);
  for (let k = 0; k < 3; k++) out[k] = f(f(f(normal[k] * 2) * d) - v[k]);
  return out;
}

/**
 * `RB_CalcEnvironmentTexCoords` (`tr_shade_calc.c:888-912`): the eye mirrored in the normal, its y
 * and z read as the coordinates. The sums are C's doubles, stored as floats.
 *
 * @param eye - In the vertex's frame.
 */
export function environmentCoordinates(xyz: Vec3, normal: Vec3, eye: Vec3): [number, number] {
  const viewer = towards(eye, xyz, [0, 0, 0]);
  const reflected = mirrored(normal, viewer, [0, 0, 0]);
  return [f(0.5 + reflected[1] * 0.5), f(0.5 - reflected[2] * 0.5)];
}

/** `TCGEN_VECTOR` (`tr_shade.c:856-861`): the vertex's dot with each of the stage's vectors. */
export function vectorCoordinates(xyz: Vec3, vectors: readonly [Vec3, Vec3]): [number, number] {
  return [dot(xyz, vectors[0]), dot(xyz, vectors[1])];
}

/**
 * `RB_CalcSpecularAlpha` (`tr_shade_calc.c:1023-1075`): the light Q3 fixes at
 * `SPECULAR_LIGHT_ORIGIN` mirrored in the normal, even from behind the face, against the way to
 * the eye, to the fourth power, as a byte.
 *
 * @param eye - In the vertex's frame, where the light is too.
 */
export function specularAlphaByte(xyz: Vec3, normal: Vec3, eye: Vec3): number {
  const lightDir = towards(SPECULAR_LIGHT_ORIGIN, xyz, [0, 0, 0]);
  const reflected = mirrored(normal, lightDir, [0, 0, 0]);
  const viewer = [f(eye[0] - xyz[0]), f(eye[1] - xyz[1]), f(eye[2] - xyz[2])];
  const ilength = qRsqrt(dot(viewer, viewer));
  let l = f(dot(reflected, viewer) * ilength);
  if (l < 0) return 0;
  l = f(l * l);
  l = f(l * l);
  // A C cast truncates.
  return Math.min(Math.trunc(f(l * 255)), 255);
}

/**
 * `AGEN_PORTAL` (`tr_shade.c:746-776`): the vertex's distance from the eye over the shader's
 * `portalRange`, as a byte, 255 beyond it. `VectorLength` takes a double's square root.
 *
 * @param eye - In the world's frame, as `backEnd.viewParms` holds it, whatever the vertex's frame.
 */
export function portalAlphaByte(xyz: Vec3, eye: Vec3, range: number): number {
  const v = [f(xyz[0] - eye[0]), f(xyz[1] - eye[1]), f(xyz[2] - eye[2])];
  const len = f(f(Math.sqrt(dot(v, v))) / range);
  if (len < 0) return 0;
  if (len > 1) return 255;
  return Math.trunc(f(len * 255));
}

/**
 * `R_RotateForEntity`'s `viewOrigin` (`tr_main.c:311-329`): the eye in a frame, its offset from the
 * frame's origin along each of its axes. A brush model's axes are never scaled. Written into `out`.
 *
 * @param eye - In the world's frame.
 */
export function eyeInFrame(eye: Vec3, frame: FogFrame, out: Float32Array | number[]): void {
  const { origin, axis } = frame;
  const dx = f(eye[0] - origin[0]);
  const dy = f(eye[1] - origin[1]);
  const dz = f(eye[2] - origin[2]);
  for (let k = 0; k < 3; k++) {
    const along = axis[k];
    out[k] = f(f(f(dx * along[0]) + f(dy * along[1])) + f(dz * along[2]));
  }
}

/**
 * Every vertex's normal as the batches give it (`RB_SurfaceFace`, `tr_surface.c:803-808`): a planar
 * face's plane on each of its vertexes, taken from its `lightmapVecs[2]` (`tr_bsp.c:357-360`), and
 * every other vertex's its own. A map whose compiler smoothed its faces' normals carries others.
 */
export function batchNormals(bsp: Pick<Bsp, 'surfaces' | 'drawVerts'>): Float32Array {
  const normals = Float32Array.from(bsp.drawVerts.normal);
  for (const surface of bsp.surfaces) {
    if (surface.surfaceType !== MST_PLANAR) continue;
    const plane = surface.lightmapVecs[2];
    for (let v = surface.firstVert; v < surface.firstVert + surface.numVerts; v++) normals.set(plane, v * 3);
  }
  return normals;
}
