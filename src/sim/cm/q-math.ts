/**
 * The vector arithmetic collision takes from `q_shared.h` and `q_math.c`, as ioquake3's x86-64
 * build runs it.
 *
 * `vec_t` is a `float`, and SSE rounds each float operation to 32 bits, so every product, sum and
 * difference here goes through `f` (`Math.fround`), in C's order: `DotProduct` rounds its first
 * product, its second, their sum, its third, and the last sum. Where C promotes to a double (a
 * double literal, `sqrt`, `sin`), the arithmetic is a double's and only the store is rounded. One
 * operation in doubles rounded once to a float is the float operation's answer, so this matches
 * the C to the bit; collision's twin of the C holds it there.
 *
 * The game module's and cgame's QVMs do the same float arithmetic, and borrow it from here, except
 * where a constant folds differently in a QVM build, as `AngleVectors`' does
 * ({@link qvmAngleVectors}).
 */

/** Rounds to the nearest float, as C's store to a `float` does. */
export const f = Math.fround;

/** `vec3_t`: three floats. */
export type Vec3f = [number, number, number];

/** `vec4_t`, as a plane: a normal and a distance, four floats. */
export type Vec4f = [number, number, number, number];

/** A `vec3_t` of zeros, or of the given floats. */
export function vec3f(x = 0, y = 0, z = 0): Vec3f {
  return [x, y, z];
}

/** `PLANE_X`, `PLANE_Y`, `PLANE_Z` and `PLANE_NON_AXIAL` (`q_shared.h:984-987`). */
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;
export const PLANE_NON_AXIAL = 3;

/** `DotProduct` (`q_shared.h:535`). */
export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
}

/** `VectorSubtract` (`q_shared.h:536`): `c = a − b`. */
export function vectorSubtract(a: ArrayLike<number>, b: ArrayLike<number>, c: number[]): void {
  c[0] = f(a[0] - b[0]);
  c[1] = f(a[1] - b[1]);
  c[2] = f(a[2] - b[2]);
}

/** `VectorAdd` (`q_shared.h:537`): `c = a + b`. */
export function vectorAdd(a: ArrayLike<number>, b: ArrayLike<number>, c: number[]): void {
  c[0] = f(a[0] + b[0]);
  c[1] = f(a[1] + b[1]);
  c[2] = f(a[2] + b[2]);
}

/** `VectorCopy` (`q_shared.h:538`). */
export function vectorCopy(a: ArrayLike<number>, b: number[]): void {
  b[0] = a[0];
  b[1] = a[1];
  b[2] = a[2];
}

/** `VectorScale` (`q_shared.h:539`): `o = v × s`, `s` a float. */
export function vectorScale(v: ArrayLike<number>, s: number, o: number[]): void {
  o[0] = f(v[0] * s);
  o[1] = f(v[1] * s);
  o[2] = f(v[2] * s);
}

/** `VectorMA` (`q_shared.h:540`): `o = v + b × s`, `s` a float. */
export function vectorMA(
  v: ArrayLike<number>,
  s: number,
  b: ArrayLike<number>,
  o: number[]
): void {
  o[0] = f(v[0] + f(b[0] * s));
  o[1] = f(v[1] + f(b[1] * s));
  o[2] = f(v[2] + f(b[2] * s));
}

/** `VectorClear` (`q_shared.h:564`). */
export function vectorClear(a: number[]): void {
  a[0] = a[1] = a[2] = 0;
}

/** `VectorNegate` (`q_shared.h:565`), which makes −0 of a 0, where `0 − a` makes +0. */
export function vectorNegate(a: ArrayLike<number>, b: number[]): void {
  b[0] = -a[0];
  b[1] = -a[1];
  b[2] = -a[2];
}

/** `Vector4Copy` (`q_shared.h:567`). */
export function vector4Copy(a: ArrayLike<number>, b: number[]): void {
  b[0] = a[0];
  b[1] = a[1];
  b[2] = a[2];
  b[3] = a[3];
}

/** `VectorLength` (`q_shared.h:599-601`): the sum in floats, its root in a double. */
export function vectorLength(v: ArrayLike<number>): number {
  return f(Math.sqrt(f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]))));
}

/** `CrossProduct` (`q_shared.h:640-644`). `cross` must not be `v1` or `v2`. */
export function crossProduct(v1: ArrayLike<number>, v2: ArrayLike<number>, cross: number[]): void {
  cross[0] = f(f(v1[1] * v2[2]) - f(v1[2] * v2[1]));
  cross[1] = f(f(v1[2] * v2[0]) - f(v1[0] * v2[2]));
  cross[2] = f(f(v1[0] * v2[1]) - f(v1[1] * v2[0]));
}

/**
 * `VectorNormalize` (`q_math.c:790-807`), as ioquake3 writes it: the inverse length first, as
 * `1/(float)sqrt(length)`, then the length as the squared length times it. id's own build took
 * the root and divided, which can round differently.
 *
 * @returns The length, or 0 for a zero vector, which is left as it is.
 */
export function vectorNormalize(v: number[]): number {
  let length = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  if (length) {
    const ilength = f(1 / f(Math.sqrt(length)));
    length = f(length * ilength);
    v[0] = f(v[0] * ilength);
    v[1] = f(v[1] * ilength);
    v[2] = f(v[2] * ilength);
  }
  return length;
}

/**
 * `VectorNormalize2` (`q_math.c:809-829`): `vectorNormalize` into `out`, which a zero vector
 * clears.
 */
export function vectorNormalize2(v: ArrayLike<number>, out: number[]): number {
  let length = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  if (length) {
    const ilength = f(1 / f(Math.sqrt(length)));
    length = f(length * ilength);
    out[0] = f(v[0] * ilength);
    out[1] = f(v[1] * ilength);
    out[2] = f(v[2] * ilength);
  } else {
    vectorClear(out);
  }
  return length;
}

/**
 * `ProjectPointOnPlane` (`q_math.c:447-469`): `p` less its part along `normal`, a unit vector. C
 * divides by the normal's squared length twice, so a normal of any other length takes off the
 * wrong amount.
 */
export function projectPointOnPlane(
  dst: number[],
  p: ArrayLike<number>,
  normal: ArrayLike<number>
): void {
  const invDenom = f(1 / dotProduct(normal, normal));
  const d = f(dotProduct(normal, p) * invDenom);
  dst[0] = f(p[0] - f(d * f(normal[0] * invDenom)));
  dst[1] = f(p[1] - f(d * f(normal[1] * invDenom)));
  dst[2] = f(p[2] - f(d * f(normal[2] * invDenom)));
}

/**
 * `PerpendicularVector` (`q_math.c:970-1000`): a unit vector square to `src`, a unit vector, from
 * the axis it leans along least, the first of any tie, projected onto its plane.
 */
export function perpendicularVector(dst: number[], src: ArrayLike<number>): void {
  let pos = 0;
  let minelem = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(src[i]) < minelem) {
      pos = i;
      minelem = Math.abs(src[i]);
    }
  }
  const tempvec = [0, 0, 0];
  tempvec[pos] = 1;
  projectPointOnPlane(dst, tempvec, src);
  vectorNormalize(dst);
}

/** A 3×3 matrix of floats, by rows. */
export type Matrix3f = [Vec3f, Vec3f, Vec3f];

/** `MatrixMultiply` (`q_math.c:910-929`): `out = in1 × in2`. `out` must be neither. */
export function matrixMultiply(in1: Matrix3f, in2: Matrix3f, out: Matrix3f): void {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = f(
        f(f(in1[i][0] * in2[0][j]) + f(in1[i][1] * in2[1][j])) + f(in1[i][2] * in2[2][j])
      );
    }
  }
}

/** Scratch for {@link qvmRotatePointAroundVector}'s matrices. */
const rotation = {
  vr: vec3f(),
  vup: vec3f(),
  m: [vec3f(), vec3f(), vec3f()] as Matrix3f,
  im: [vec3f(), vec3f(), vec3f()] as Matrix3f,
  zrot: [vec3f(), vec3f(), vec3f()] as Matrix3f,
  tmpmat: [vec3f(), vec3f(), vec3f()] as Matrix3f,
  rot: [vec3f(), vec3f(), vec3f()] as Matrix3f
};

/**
 * `RotatePointAroundVector` (`q_math.c:296-353`) as cgame's QVM runs it: `point` turned `degrees`
 * about `dir`, a unit vector, through a frame of {@link perpendicularVector}'s and its inverse.
 * `DEG2RAD` is `q_shared.h`'s `(a * M_PI) / 180.0F` with the QVM's float `M_PI`, so the angle is
 * two float operations, and its sine and cosine are traps' doubles stored as floats.
 *
 * @param dst - Written; must be neither `dir` nor `point`.
 */
export function qvmRotatePointAroundVector(
  dst: number[],
  dir: ArrayLike<number>,
  point: ArrayLike<number>,
  degrees: number
): void {
  const { vr, vup, m, im, zrot, tmpmat, rot } = rotation;
  perpendicularVector(vr, dir);
  crossProduct(vr, dir, vup);
  for (let i = 0; i < 3; i++) {
    m[i][0] = vr[i];
    m[i][1] = vup[i];
    m[i][2] = dir[i];
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) im[i][j] = m[j][i];
  }
  for (let i = 0; i < 3; i++) zrot[i].fill(0);
  zrot[2][2] = 1;
  const rad = f(f(degrees * QVM_PI) / 180);
  const cos = f(Math.cos(rad));
  const sin = f(Math.sin(rad));
  zrot[0][0] = cos;
  zrot[0][1] = sin;
  zrot[1][0] = -sin;
  zrot[1][1] = cos;
  matrixMultiply(m, zrot, tmpmat);
  matrixMultiply(tmpmat, im, rot);
  for (let i = 0; i < 3; i++) {
    dst[i] = f(f(f(rot[i][0] * point[0]) + f(rot[i][1] * point[1])) + f(rot[i][2] * point[2]));
  }
}

/** `PlaneTypeForNormal` (`q_shared.h:996`): axial only for a normal of exactly +1. */
export function planeTypeForNormal(normal: ArrayLike<number>): number {
  if (normal[0] === 1) return PLANE_X;
  if (normal[1] === 1) return PLANE_Y;
  if (normal[2] === 1) return PLANE_Z;
  return PLANE_NON_AXIAL;
}

/** A bit for each negative component of a normal, `SetPlaneSignbits`' (`q_math.c:636-647`). */
export function signbitsForNormal(normal: ArrayLike<number>): number {
  let bits = 0;
  for (let j = 0; j < 3; j++) {
    if (normal[j] < 0) bits |= 1 << j;
  }
  return bits;
}

/** The plane `BoxOnPlaneSide` reads. */
export interface SidedPlane {
  normal: ArrayLike<number>;
  dist: number;
  type: number;
  signbits: number;
}

/**
 * `BoxOnPlaneSide` (`q_math.c:657-691`): 1 for a box in front of the plane, 2 behind it, 3 across
 * it. An axial plane compares the box's own sides, so a box touching it counts as in front or
 * behind; the general case takes the corners the sign bits pick.
 */
export function boxOnPlaneSide(
  emins: ArrayLike<number>,
  emaxs: ArrayLike<number>,
  p: SidedPlane
): number {
  if (p.type < 3) {
    if (p.dist <= emins[p.type]) return 1;
    if (p.dist >= emaxs[p.type]) return 2;
    return 3;
  }

  let dist0 = 0;
  let dist1 = 0;
  // ">= 8: default case is original code (dist[0]=dist[1]=0)".
  if (p.signbits < 8) {
    for (let i = 0; i < 3; i++) {
      const toMaxs = f(p.normal[i] * emaxs[i]);
      const toMins = f(p.normal[i] * emins[i]);
      if ((p.signbits >> i) & 1) {
        dist1 = f(dist1 + toMaxs);
        dist0 = f(dist0 + toMins);
      } else {
        dist0 = f(dist0 + toMaxs);
        dist1 = f(dist1 + toMins);
      }
    }
  }

  let sides = 0;
  if (dist0 >= p.dist) sides = 1;
  if (dist1 < p.dist) sides |= 2;
  return sides;
}

/** `ClearBounds` (`q_math.c:714-717`). */
export function clearBounds(mins: number[], maxs: number[]): void {
  mins[0] = mins[1] = mins[2] = 99999;
  maxs[0] = maxs[1] = maxs[2] = -99999;
}

/** `AddPointToBounds` (`q_math.c:719-740`). */
export function addPointToBounds(v: ArrayLike<number>, mins: number[], maxs: number[]): void {
  for (let i = 0; i < 3; i++) {
    if (v[i] < mins[i]) mins[i] = v[i];
    if (v[i] > maxs[i]) maxs[i] = v[i];
  }
}

/** `YAW`, `PITCH` and `ROLL` (`q_shared.h:233-235`): an angle triple's order. */
const PITCH = 0;
const YAW = 1;
const ROLL = 2;

/** `M_PI*2 / 360`, a double, as C folds it. */
const DEG2RAD = (Math.PI * 2) / 360;

/**
 * `M_PI*2 / 360` in the game module's QVM: a QVM build has no `math.h`, so `M_PI` is
 * `q_shared.h`'s float literal, and q3lcc's `double` is a float, so the constant is a float and
 * each angle is turned by a float product.
 */
const QVM_DEG2RAD = f(DEG2RAD);

/** `M_PI` in the game module's QVM: `q_shared.h`'s float literal. */
export const QVM_PI = f(Math.PI);

/**
 * `AngleVectors` (`q_math.c:932-965`), roll included: each angle a float, its sine and cosine
 * taken in doubles and stored as floats, and the axes in float arithmetic, in C's order.
 *
 * The sim's `angleVectors` (`pmove-math.ts`) is the view's, in doubles and without roll; this is
 * collision's, which turns an inline model by all three angles.
 *
 * @param angles - Pitch, yaw and roll, in degrees.
 * @param forward - Written, unless `null`.
 * @param right - Written, unless `null`.
 * @param up - Written, unless `null`.
 */
export function angleVectors(
  angles: ArrayLike<number>,
  forward: number[] | null,
  right: number[] | null,
  up: number[] | null
): void {
  turnAngles(angles, DEG2RAD, forward, right, up);
}

/**
 * `AngleVectors` as the game module's QVM runs it, by {@link QVM_DEG2RAD}: the same axes but for
 * the angle's product, which lands an ulp from the engine's at some angles, 33 of the 360 whole
 * degrees of yaw among them. The QVM's `sin` and `cos` are traps, a double's rounded to a float,
 * as the engine's are.
 *
 * @param angles - Pitch, yaw and roll, in degrees.
 * @param forward - Written, unless `null`.
 * @param right - Written, unless `null`.
 * @param up - Written, unless `null`.
 */
export function qvmAngleVectors(
  angles: ArrayLike<number>,
  forward: number[] | null,
  right: number[] | null,
  up: number[] | null
): void {
  turnAngles(angles, QVM_DEG2RAD, forward, right, up);
}

/** `AngleVectors`' body, by the build's `DEG2RAD`. */
function turnAngles(
  angles: ArrayLike<number>,
  deg2rad: number,
  forward: number[] | null,
  right: number[] | null,
  up: number[] | null
): void {
  let angle = f(angles[YAW] * deg2rad);
  const sy = f(Math.sin(angle));
  const cy = f(Math.cos(angle));
  angle = f(angles[PITCH] * deg2rad);
  const sp = f(Math.sin(angle));
  const cp = f(Math.cos(angle));
  angle = f(angles[ROLL] * deg2rad);
  const sr = f(Math.sin(angle));
  const cr = f(Math.cos(angle));

  if (forward) {
    forward[0] = f(cp * cy);
    forward[1] = f(cp * sy);
    forward[2] = -sp;
  }
  if (right) {
    // "(-1*sr*sp*cy+-1*cr*-sy)", and so on: −1 times a float is exact.
    right[0] = f(f(f(-sr * sp) * cy) + f(-cr * -sy));
    right[1] = f(f(f(-sr * sp) * sy) + f(-cr * cy));
    right[2] = f(-sr * cp);
  }
  if (up) {
    up[0] = f(f(f(cr * sp) * cy) + f(-sr * -sy));
    up[1] = f(f(f(cr * sp) * sy) + f(-sr * cy));
    up[2] = f(cr * cp);
  }
}
