import type { Vec3 } from './sim/vec3';

/**
 * The one place the simulation's frame meets the renderer's.
 *
 * The sim runs in Quake units, Z-up; PlayCanvas renders in metres, Y-up. These pure functions
 * are the whole conversion, kept engine-free so they can be unit-tested and so nothing else has
 * to know the convention. `player-view.ts` and the sim deliberately leave this to the caller;
 * this is that caller's shared maths, used by both the camera bridge and the collision adapter
 * so the two cannot drift apart.
 *
 * Three frames are in play:
 * - **sim** — Quake units, Z-up, right-handed. X forward, Y left, Z up.
 * - **world** — PlayCanvas render space, metres, Y-up. Where the splats are drawn.
 * - **octree** — the collision bake's space: `world` under splat-transform's
 *   `ST_FRAME = diag(-1, -1, 1)` (a 180-degree rotation about Z).
 *
 * sim and world share an origin, so the maps are linear: a point and a direction transform
 * identically, and the scale cancels out of any direction.
 */

/** Quake units per metre. */
export const UNITS_PER_METRE = 32;

/**
 * sim (Q3, Z-up, units) → world (PlayCanvas, Y-up, metres).
 *
 * Quake up (Z) becomes world up (Y); Quake left (Y) becomes world -Z, which keeps the frame
 * right-handed. Valid for both points and direction vectors.
 *
 * @param v - A sim-space point or vector.
 * @param into - Where it is written; a new one by default.
 */
export function simToWorld(
  v: Vec3,
  into: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  into[0] = v.x / UNITS_PER_METRE;
  into[1] = v.z / UNITS_PER_METRE;
  into[2] = -v.y / UNITS_PER_METRE;
  return into;
}

/**
 * world (PlayCanvas, Y-up, metres) → sim (Q3, Z-up, units) — the inverse of
 * {@link simToWorld}.
 *
 * Needed where a fact only the renderer knows has to be expressed in the simulation's frame:
 * the effect layer asks where the camera is so it can turn beam quads to face it, and every
 * other number it handles is already in Quake units.
 *
 * @param x - World X, metres.
 * @param y - World Y (up), metres.
 * @param z - World Z, metres.
 */
export function worldToSim(x: number, y: number, z: number): Vec3 {
  return { x: x * UNITS_PER_METRE, y: -z * UNITS_PER_METRE, z: y * UNITS_PER_METRE };
}

/**
 * sim (Q3, Z-up, units) → octree (collision bake, metres).
 *
 * `simToWorld` composed with the bake's `ST_FRAME = diag(-1, -1, 1)` (negate world X and Y).
 * Feed the result to {@link import('./sim/voxel-svo').SparseVoxelOctree.isSolidPoint}.
 *
 * @param v - A sim-space point.
 */
export function simToOctree(v: Vec3): [number, number, number] {
  return [-v.x / UNITS_PER_METRE, -v.z / UNITS_PER_METRE, -v.y / UNITS_PER_METRE];
}
