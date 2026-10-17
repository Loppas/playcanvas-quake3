import type { Vec3 } from './vec3';

/**
 * Tolerance, in voxels, for deciding whether an authored boundary lands on a voxel edge.
 * Absorbs the floating-point error in coordinates built by repeated addition.
 */
const BOUNDARY_EPSILON = 1e-6;

/**
 * Occupancy of the world as a uniform voxel grid.
 *
 * This is the seam between the movement simulation and whatever produced the collision
 * data. For the real map, `splat-transform` bakes a sparse voxel octree at 0.25 m (8 Q3 units
 * at our 32 units = 1 m scale — sized in Quake units, not the 5 cm default);
 * `sim/voxel-svo.ts` decodes it and `svo-voxel-grid.ts` adapts it
 * to this interface. The synthetic rooms the tests use implement the interface directly.
 *
 * Voxel `(vx, vy, vz)` covers the half-open world region
 * `[vx * voxelSize, (vx + 1) * voxelSize)` on each axis.
 *
 * **Grids must be closed.** Any coordinate outside the authored region must report solid, so
 * the mover can never escape the world. This matches splat-transform's format, where space
 * outside `gridBounds` is solid by definition.
 */
export interface VoxelGrid {
  /** Edge length of one voxel in world units. */
  readonly voxelSize: number;

  /**
   * @param vx - Voxel X index.
   * @param vy - Voxel Y index.
   * @param vz - Voxel Z index.
   */
  isSolid(vx: number, vy: number, vz: number): boolean;
}

/**
 * A voxel grid over a bounded region, backed by a dense occupancy array.
 *
 * It starts **fully solid** and is opened up with {@link carve}, mirroring how the real
 * pipeline works: `splat-transform --voxel-carve` flood-fills the navigable space out of a
 * solid world rather than assembling geometry out of nothing.
 */
export class DenseVoxelGrid implements VoxelGrid {
  readonly voxelSize: number;

  private readonly minVoxel: { x: number; y: number; z: number };
  private readonly size: { x: number; y: number; z: number };
  private readonly occupancy: Uint8Array;

  /**
   * @param voxelSize - Edge length of one voxel in world units.
   * @param worldMin - Minimum corner of the authored region.
   * @param worldMax - Maximum corner of the authored region.
   */
  constructor(voxelSize: number, worldMin: Vec3, worldMax: Vec3) {
    this.voxelSize = voxelSize;
    this.minVoxel = {
      x: Math.floor(worldMin.x / voxelSize),
      y: Math.floor(worldMin.y / voxelSize),
      z: Math.floor(worldMin.z / voxelSize)
    };
    const maxVoxel = {
      x: Math.floor(worldMax.x / voxelSize),
      y: Math.floor(worldMax.y / voxelSize),
      z: Math.floor(worldMax.z / voxelSize)
    };
    this.size = {
      x: maxVoxel.x - this.minVoxel.x + 1,
      y: maxVoxel.y - this.minVoxel.y + 1,
      z: maxVoxel.z - this.minVoxel.z + 1
    };
    this.occupancy = new Uint8Array(this.size.x * this.size.y * this.size.z).fill(1);
  }

  /**
   * @param vx - Voxel X index.
   * @param vy - Voxel Y index.
   * @param vz - Voxel Z index.
   */
  isSolid(vx: number, vy: number, vz: number): boolean {
    const index = this.indexOf(vx, vy, vz);
    return index < 0 || this.occupancy[index] === 1;
  }

  /**
   * Open up every voxel overlapping a world-space box.
   *
   * @param min - Minimum corner.
   * @param max - Maximum corner.
   */
  carve(min: Vec3, max: Vec3) {
    this.setRegion(min, max, 0);
  }

  /**
   * Make solid every voxel overlapping a world-space box.
   *
   * @param min - Minimum corner.
   * @param max - Maximum corner.
   */
  fill(min: Vec3, max: Vec3) {
    this.setRegion(min, max, 1);
  }

  /**
   * @param min - Minimum corner.
   * @param max - Maximum corner.
   * @param value - 1 for solid, 0 for open.
   */
  private setRegion(min: Vec3, max: Vec3, value: number) {
    const vs = this.voxelSize;
    const lo = {
      x: Math.floor(min.x / vs + BOUNDARY_EPSILON),
      y: Math.floor(min.y / vs + BOUNDARY_EPSILON),
      z: Math.floor(min.z / vs + BOUNDARY_EPSILON)
    };
    // The region is half-open, so a box ending exactly on a boundary does not claim the
    // voxel beyond it. The epsilon matters: a height like 6 * 12.8 lands at 76.80000000000001
    // in binary floating point, which without it claims an extra voxel and silently makes
    // the geometry a voxel taller than it was authored to be.
    const hi = {
      x: Math.ceil(max.x / vs - BOUNDARY_EPSILON) - 1,
      y: Math.ceil(max.y / vs - BOUNDARY_EPSILON) - 1,
      z: Math.ceil(max.z / vs - BOUNDARY_EPSILON) - 1
    };

    for (let vz = lo.z; vz <= hi.z; vz++) {
      for (let vy = lo.y; vy <= hi.y; vy++) {
        for (let vx = lo.x; vx <= hi.x; vx++) {
          const index = this.indexOf(vx, vy, vz);
          if (index >= 0) {
            this.occupancy[index] = value;
          }
        }
      }
    }
  }

  /**
   * Flat index of a voxel, or -1 when it lies outside the authored region.
   *
   * @param vx - Voxel X index.
   * @param vy - Voxel Y index.
   * @param vz - Voxel Z index.
   */
  private indexOf(vx: number, vy: number, vz: number): number {
    const ix = vx - this.minVoxel.x;
    const iy = vy - this.minVoxel.y;
    const iz = vz - this.minVoxel.z;

    if (
      ix < 0 ||
      iy < 0 ||
      iz < 0 ||
      ix >= this.size.x ||
      iy >= this.size.y ||
      iz >= this.size.z
    ) {
      return -1;
    }

    return (iz * this.size.y + iy) * this.size.x + ix;
  }
}
