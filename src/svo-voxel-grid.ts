import { UNITS_PER_METRE } from './coords';
import type { VoxelGrid } from './sim/voxel-grid';
import type { SparseVoxelOctree } from './sim/voxel-svo';

/** How far `gridMin / voxelResolution` may sit from an integer before the lattices are judged misaligned. */
const ALIGN_EPSILON = 1e-9;

/**
 * The collision seam for the real map: presents a baked {@link SparseVoxelOctree} as the
 * {@link VoxelGrid} the swept-AABB trace runs on.
 *
 * The trace queries in sim units (Q3, Z-up); the octree is in metres under splat-transform's
 * flipped frame. Two facts make one sim voxel land on exactly one octree cell:
 *
 * 1. The sim voxel edge equals the octree cell edge — `voxelSize = voxelResolution * 32` — so
 *    the lattices share a pitch.
 * 2. `gridBounds.min` is an integer number of cells from the world origin, so the two lattices
 *    share a phase. This is asserted in the constructor; splat-transform aligns `gridBounds` to
 *    a *block* boundary relative to the scene, not provably to the world origin, so a future
 *    bake (different `--voxel-size`, shifted scene) could break it — and the failure mode is a
 *    silent half-voxel skew that reads as "collision feels slightly off", not a crash. The
 *    assert turns that into a loud error naming the bake.
 *
 * With both holding, the sim-voxel -> octree-cell map is exact **integer** arithmetic (no float
 * round-trip, no per-query allocation). The sim->octree transform is `simToOctree`
 * (`[x, y, z] -> [-x, -y, -z] / 32`, i.e. {@link import('./coords').simToOctree}) composed with
 * the metres->cells scale; carried through the voxel indices it is a signed axis permutation
 * plus a constant offset:
 *
 * - octree X index <- sim X (negated),  octree Y <- sim Z (negated),  octree Z <- sim Y (negated)
 * - the `-1` folds the centre-sampling half-cell and the floor of the sign flip together
 *   (`floor(-(v + 0.5) - g) = -v - g - 1` for integer `v`, `g`).
 */
export class SvoVoxelGrid implements VoxelGrid {
  readonly voxelSize: number;

  private readonly octree: SparseVoxelOctree;

  /** `gridMin` expressed in whole cells (`gridMin / voxelResolution`), per axis. */
  private readonly gx: number;
  private readonly gy: number;
  private readonly gz: number;

  /**
   * @param octree - The decoded collision octree.
   */
  constructor(octree: SparseVoxelOctree) {
    this.octree = octree;
    const vr = octree.voxelResolution;
    // One sim voxel per octree cell: 0.25 m * 32 = 8 units for the standard bake.
    this.voxelSize = vr * UNITS_PER_METRE;

    const cells = (min: number, axis: string): number => {
      const c = min / vr;
      if (Math.abs(c - Math.round(c)) > ALIGN_EPSILON) {
        throw new Error(
          `collision bake misaligned: gridBounds.min ${axis}=${min} is not a whole ` +
            `multiple of voxelResolution ${vr} (=${c} cells). One sim voxel no longer maps to ` +
            `one octree cell; re-bake with bounds on a cell boundary.`
        );
      }
      return Math.round(c);
    };
    this.gx = cells(octree.gridMin[0], 'x');
    this.gy = cells(octree.gridMin[1], 'y');
    this.gz = cells(octree.gridMin[2], 'z');
  }

  /**
   * @param vx - Voxel X index in sim space.
   * @param vy - Voxel Y index in sim space.
   * @param vz - Voxel Z index in sim space.
   */
  isSolid(vx: number, vy: number, vz: number): boolean {
    // Exact integer map from the sim voxel to its octree cell (see the class doc). No float
    // round-trip and no allocation, on the innermost call of every trace.
    return this.octree.isSolidCell(-vx - this.gx - 1, -vz - this.gy - 1, -vy - this.gz - 1);
  }
}
