/**
 * Minimal 3-component vector maths for the movement simulation.
 *
 * Deliberately not PlayCanvas' `Vec3`: the simulation must stay engine-free and headless.
 * Operations return new vectors rather than mutating in place, which keeps the ported pmove
 * code readable at the cost of some allocation.
 */

/** A vector in Q3's Z-up coordinate space. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * @param x - X component.
 * @param y - Y component.
 * @param z - Z component.
 */
export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** @param v - Vector to duplicate. */
export function copy(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * @param a - Left operand.
 * @param b - Right operand.
 */
export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * @param a - Vector to subtract from.
 * @param b - Vector to subtract.
 */
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * @param v - Vector to scale.
 * @param s - Scalar multiplier.
 */
export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/**
 * Multiply-add: `a + b * s`. Q3's `VectorMA`.
 *
 * @param a - Base vector.
 * @param s - Scalar applied to `b`.
 * @param b - Vector to add after scaling.
 */
export function madd(a: Vec3, s: number, b: Vec3): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

/**
 * @param a - Left operand.
 * @param b - Right operand.
 */
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * @param a - Left operand.
 * @param b - Right operand.
 */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

/** @param v - Vector to measure. */
export function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** @param v - Vector to measure. */
export function lengthSquared(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

/**
 * Linear interpolation. `t` is not clamped, so this extrapolates outside 0..1.
 *
 * @param a - Value at `t = 0`.
 * @param b - Value at `t = 1`.
 * @param t - Interpolation factor.
 */
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  };
}

/**
 * `vtos` (`g_utils.c:303–315`): a vector as a print shows it, `(x y z)`, each truncated to a whole
 * number.
 *
 * @param v - Vector to print.
 */
export function vtos(v: Vec3): string {
  return `(${Math.trunc(v.x)} ${Math.trunc(v.y)} ${Math.trunc(v.z)})`;
}

/**
 * Scale to unit length. A zero vector normalises to zero, matching Q3's `VectorNormalize`.
 *
 * @param v - Vector to normalise.
 */
export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  return len === 0 ? vec3() : scale(v, 1 / len);
}
