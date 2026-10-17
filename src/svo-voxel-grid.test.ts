import { describe, expect, it } from 'vitest';
import { simToOctree } from './coords';
import { SvoVoxelGrid } from './svo-voxel-grid';
import { haveRealBake, loadRealBake, packBin } from './sim/octree-test-fixtures';
import { SparseVoxelOctree, type VoxelOctreeHeader } from './sim/voxel-svo';
import { vec3 } from './sim/vec3';

function header(overrides: Partial<VoxelOctreeHeader>): VoxelOctreeHeader {
  return {
    version: '1.1',
    gridBounds: { min: [0, 0, 0], max: [8, 8, 8] },
    sceneBounds: { min: [0, 0, 0], max: [8, 8, 8] },
    voxelResolution: 0.25,
    leafSize: 4,
    treeDepth: 3,
    numInteriorNodes: 0,
    numMixedLeaves: 0,
    nodeCount: 0,
    leafDataCount: 0,
    ...overrides
  };
}

describe('SvoVoxelGrid', () => {
  it('sizes its voxel to match the octree (0.25 m = 8 units)', () => {
    const octree = SparseVoxelOctree.fromBuffers(header({}), packBin([], []));
    expect(new SvoVoxelGrid(octree).voxelSize).toBe(8);
  });

  it('maps a sim voxel into the octree and reports open space as open', () => {
    // Empty octree over octree-space [0,8]^3. Sim voxel (-1,-1,-1) has centre (-4,-4,-4) units,
    // which maps to octree (0.125, 0.125, 0.125) — inside the grid, and open.
    const grid = new SvoVoxelGrid(SparseVoxelOctree.fromBuffers(header({}), packBin([], [])));
    expect(grid.isSolid(-1, -1, -1)).toBe(false);
  });

  it('reports solid outside the octree bounds (a closed world)', () => {
    // Sim voxel (0,0,0) centre (4,4,4) maps to octree (-0.125,...), outside [0,8]^3.
    const grid = new SvoVoxelGrid(SparseVoxelOctree.fromBuffers(header({}), packBin([], [])));
    expect(grid.isSolid(0, 0, 0)).toBe(true);
  });

  it('throws when the bake grid is not cell-aligned to the world origin', () => {
    // gridBounds.min x = 0.1 is not a whole multiple of voxelResolution 0.25, so a sim voxel
    // would no longer land on one octree cell — the constructor must refuse it, loudly.
    const octree = SparseVoxelOctree.fromBuffers(
      header({ gridBounds: { min: [0.1, 0, 0], max: [8, 8, 8] } }),
      packBin([], [])
    );
    expect(() => new SvoVoxelGrid(octree)).toThrow(/misaligned/);
  });
});

// Guarded integration against the real bake — the adapter over splat-transform's own octree.
describe('SvoVoxelGrid against the garage_rats bake', () => {
  it.skipIf(!haveRealBake)('exposes a walkable column: solid floor, clear above', async () => {
    const grid = new SvoVoxelGrid((await loadRealBake()).octree);
    // The standing box is ~56 units (7 voxels) tall; require a floor voxel with at least that
    // much open space directly above it somewhere in the map.
    const clearanceVoxels = 7;

    let found = false;
    // Sweep sim voxel columns across a wide band (sim units span roughly +/-1300 on the floor
    // axes; step in whole voxels but coarsely for speed).
    outer: for (let vx = -160; vx <= 160 && !found; vx += 4) {
      for (let vy = -160; vy <= 160 && !found; vy += 4) {
        for (let vz = -160; vz <= 160; vz++) {
          if (!grid.isSolid(vx, vy, vz)) continue;
          // vz is solid; check the column above is open for the player's height.
          let clear = true;
          for (let k = 1; k <= clearanceVoxels; k++) {
            if (grid.isSolid(vx, vy, vz + k)) {
              clear = false;
              break;
            }
          }
          if (clear) {
            found = true;
            break outer;
          }
        }
      }
    }
    expect(found).toBe(true);
  });

  it.skipIf(!haveRealBake)('integer cell map matches float centre-sampling', async () => {
    const { octree } = await loadRealBake();
    const grid = new SvoVoxelGrid(octree);
    const vs = grid.voxelSize;

    // The float centre-sampling: sample the sim voxel's centre, map to the octree frame with the
    // shared coords transform, and ask the octree by point. The integer map must agree everywhere.
    const floatSolid = (vx: number, vy: number, vz: number): boolean => {
      const h = vs / 2;
      const [ox, oy, oz] = simToOctree(vec3(vx * vs + h, vy * vs + h, vz * vs + h));
      return octree.isSolidPoint(ox, oy, oz);
    };

    for (let vx = -40; vx <= 40; vx += 7) {
      for (let vy = -40; vy <= 40; vy += 7) {
        for (let vz = -40; vz <= 40; vz += 7) {
          expect(grid.isSolid(vx, vy, vz)).toBe(floatSolid(vx, vy, vz));
        }
      }
    }
  });
});
