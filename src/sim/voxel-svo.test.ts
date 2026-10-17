import { describe, expect, it } from 'vitest';
import { haveRealBake, loadRealBake, packBin } from './octree-test-fixtures';
import { SparseVoxelOctree, type VoxelOctreeHeader } from './voxel-svo';

function header(overrides: Partial<VoxelOctreeHeader>): VoxelOctreeHeader {
  return {
    version: '1.1',
    gridBounds: { min: [0, 0, 0], max: [8, 8, 8] },
    sceneBounds: { min: [0, 0, 0], max: [8, 8, 8] },
    voxelResolution: 1,
    leafSize: 4,
    treeDepth: 1,
    numInteriorNodes: 0,
    numMixedLeaves: 0,
    nodeCount: 0,
    leafDataCount: 0,
    ...overrides
  };
}

// A depth-1 tree over a 2x2x2 block grid (8 voxels/axis). The root's octant 0 (block 0,0,0) is
// a mixed leaf; its octant 7 (block 1,1,1) is a solid leaf; the other six octants are absent.
const SOLID_LEAF = 0xff000000;
const MIXED_TREE = {
  head: header({
    treeDepth: 1,
    numInteriorNodes: 1,
    numMixedLeaves: 1,
    nodeCount: 3,
    leafDataCount: 2
  }),
  // node0: interior, childMask 0x81 (octants 0 and 7), children start at 1.
  // node1: mixed leaf, leafData pair 0.  node2: solid leaf.
  nodes: [(0x81 << 24) | 1, 0, SOLID_LEAF],
  // Mixed block: only local voxel (1,2,3) solid → bit 1 + 2*4 + 3*16 = 57 → hi word bit 25.
  leafData: [0, 1 << 25]
};

describe('SparseVoxelOctree.fromBuffers', () => {
  it('rejects a binary whose size disagrees with the header', () => {
    expect(() =>
      SparseVoxelOctree.fromBuffers(MIXED_TREE.head, packBin([1, 2], [0, 0]))
    ).toThrow(/size/);
  });

  it('rejects a header whose leafDataCount is not twice numMixedLeaves', () => {
    const bad = header({ numMixedLeaves: 1, nodeCount: 1, leafDataCount: 3 });
    expect(() => SparseVoxelOctree.fromBuffers(bad, packBin([0], [0, 0, 0]))).toThrow(/leafDataCount/);
  });

  it('derives block and voxel counts from gridBounds', () => {
    const octree = SparseVoxelOctree.fromBuffers(MIXED_TREE.head, packBin(MIXED_TREE.nodes, MIXED_TREE.leafData));
    expect(octree.blocks).toEqual({ x: 2, y: 2, z: 2 });
    expect(octree.voxels).toEqual({ x: 8, y: 8, z: 8 });
  });
});

describe('SparseVoxelOctree.isSolidCell', () => {
  const octree = SparseVoxelOctree.fromBuffers(MIXED_TREE.head, packBin(MIXED_TREE.nodes, MIXED_TREE.leafData));

  it('reads the one set bit of a mixed leaf at the right local voxel', () => {
    expect(octree.isSolidCell(1, 2, 3)).toBe(true); // the bit that was set
    expect(octree.isSolidCell(0, 0, 0)).toBe(false); // same block, a clear bit
    expect(octree.isSolidCell(3, 3, 3)).toBe(false); // same block, another clear bit
  });

  it('treats a solid-leaf octant as wholly solid', () => {
    expect(octree.isSolidCell(4, 4, 4)).toBe(true); // block (1,1,1), octant 7
    expect(octree.isSolidCell(7, 7, 7)).toBe(true);
  });

  it('treats an absent octant as open', () => {
    expect(octree.isSolidCell(4, 0, 0)).toBe(false); // block (1,0,0), octant 1 — not in mask
    expect(octree.isSolidCell(0, 4, 0)).toBe(false); // block (0,1,0), octant 2 — not in mask
  });

  it('reports solid everywhere outside the grid (a closed world)', () => {
    expect(octree.isSolidCell(-1, 0, 0)).toBe(true);
    expect(octree.isSolidCell(8, 0, 0)).toBe(true);
    expect(octree.isSolidCell(0, 0, 8)).toBe(true);
  });

  it('descends multiple interior levels, selecting the child by octant rank', () => {
    // Depth-2 tree over a 4x4x4 block grid. Root octant 0 → an interior node whose octant 7
    // is a solid leaf at block (1,1,1). Exercises the octant bit at two levels and the
    // popcount-rank child lookup.
    const head = header({
      gridBounds: { min: [0, 0, 0], max: [16, 16, 16] },
      treeDepth: 2,
      numInteriorNodes: 2,
      nodeCount: 3
    });
    const nodes = [(0x01 << 24) | 1, (0x80 << 24) | 2, SOLID_LEAF];
    const tree = SparseVoxelOctree.fromBuffers(head, packBin(nodes, []));

    expect(tree.isSolidCell(4, 4, 4)).toBe(true); // block (1,1,1)
    expect(tree.isSolidCell(0, 0, 0)).toBe(false); // block (0,0,0) — octant 7 absent at level 1
    expect(tree.isSolidCell(12, 12, 12)).toBe(false); // block (3,3,3) — octant 7 absent at root
  });
});

describe('SparseVoxelOctree.isSolidPoint', () => {
  it('floors a world point into its grid cell', () => {
    const head = header({
      gridBounds: { min: [-2, -2, -2], max: [6, 6, 6] },
      treeDepth: 1,
      numInteriorNodes: 1,
      numMixedLeaves: 1,
      nodeCount: 3,
      leafDataCount: 2
    });
    const octree = SparseVoxelOctree.fromBuffers(head, packBin(MIXED_TREE.nodes, MIXED_TREE.leafData));
    // gridMin (-2,-2,-2); cell (1,2,3) spans world x∈[-1,0), y∈[0,1), z∈[1,2).
    expect(octree.isSolidPoint(-0.5, 0.5, 1.5)).toBe(true);
    expect(octree.isSolidPoint(-2, -2, -2)).toBe(false); // cell (0,0,0), a clear bit
  });
});

describe('SparseVoxelOctree.validate', () => {
  it('tallies node types and reachability for a hand-built tree', () => {
    const octree = SparseVoxelOctree.fromBuffers(MIXED_TREE.head, packBin(MIXED_TREE.nodes, MIXED_TREE.leafData));
    const stats = octree.validate();
    expect(stats).toEqual({
      interiorNodes: 1,
      mixedLeaves: 1,
      solidLeaves: 1,
      nodesVisited: 3,
      duplicateVisits: 0,
      leafPairsReferenced: 1
    });
  });
});

// Verification against the real bake. Gitignored, so skip when it is absent —
// the hand-built tests cover the decode logic; this proves it on splat-transform's own output.
describe('SparseVoxelOctree against the garage_rats bake', () => {
  it.skipIf(!haveRealBake)('reproduces the header and reaches every node once', async () => {
    const { header: head, octree } = await loadRealBake();

    const stats = octree.validate();
    expect(stats.interiorNodes).toBe(head.numInteriorNodes);
    expect(stats.mixedLeaves).toBe(head.numMixedLeaves);
    expect(stats.solidLeaves).toBeGreaterThan(0);
    expect(stats.nodesVisited).toBe(head.nodeCount);
    expect(stats.duplicateVisits).toBe(0);
    expect(stats.leafPairsReferenced).toBe(head.numMixedLeaves);

    // Blocks tile gridBounds exactly.
    const blockSize = head.leafSize * head.voxelResolution;
    expect(octree.blocks.x * blockSize).toBeCloseTo(head.gridBounds.max[0] - head.gridBounds.min[0]);
    expect(octree.blocks.y * blockSize).toBeCloseTo(head.gridBounds.max[1] - head.gridBounds.min[1]);
    expect(octree.blocks.z * blockSize).toBeCloseTo(head.gridBounds.max[2] - head.gridBounds.min[2]);
  });

  it.skipIf(!haveRealBake)('carves a room-shaped void resting on the floor', async () => {
    const { octree } = await loadRealBake();

    // The octree is stored in splat-transform's ST_FRAME = diag(-1,-1,1): x and y negate, z
    // unchanged. Un-flipping a cell back to PlayCanvas world:
    const vr = octree.voxelResolution;
    const worldOf = (ix: number, iy: number, iz: number): [number, number, number] => [
      -(octree.gridMin[0] + ix * vr),
      -(octree.gridMin[1] + iy * vr),
      octree.gridMin[2] + iz * vr
    ];

    // Bounding box of the carved (open) space, in PlayCanvas world units, plus how much of it
    // sits above vs below the floor plane (world y=0). Sample coarsely; the room is far larger
    // than the step, so the bounds are unaffected.
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let openCount = 0;
    let solidCount = 0;
    let openAboveFloor = 0;
    let openBelowFloor = 0;
    const step = 4;
    for (let iz = 0; iz < octree.voxels.z; iz += step) {
      for (let iy = 0; iy < octree.voxels.y; iy += step) {
        for (let ix = 0; ix < octree.voxels.x; ix += step) {
          if (octree.isSolidCell(ix, iy, iz)) {
            solidCount++;
            continue;
          }
          openCount++;
          const w = worldOf(ix, iy, iz);
          if (w[1] >= 0) openAboveFloor++;
          else openBelowFloor++;
          for (let a = 0; a < 3; a++) {
            if (w[a] < lo[a]) lo[a] = w[a];
            if (w[a] > hi[a]) hi[a] = w[a];
          }
        }
      }
    }

    // The carve neither filled nor emptied the world.
    expect(openCount).toBeGreaterThan(0);
    expect(solidCount).toBeGreaterThan(0);

    // The void spans the room in x and z (config: roughly +/-40 x, +/-72 z)...
    expect(lo[0]).toBeLessThan(-30);
    expect(hi[0]).toBeGreaterThan(30);
    expect(lo[2]).toBeLessThan(-60);
    expect(hi[2]).toBeGreaterThan(50);
    // ...and stands as a room on the floor: the void reaches most of the ~52 m clear height, and
    // is overwhelmingly above the floor plane (y=0) — only sub-floor pockets dip below, which the
    // carve leaks into through gaps in the ~0.25 m-resolution slab. The bake seals with the least
    // fill that holds, so its pockets reach 10 m down; they are still about one open cell in 700.
    // NB this is a self-consistency + shape check on the decoded octree, not a proof the *map* is
    // right way up: the octree carries no notion of gravity, so an inverted bake would satisfy it
    // too.
    // Physical orientation is verified against the splats visually.
    expect(hi[1]).toBeGreaterThan(45);
    expect(lo[1]).toBeGreaterThan(-11);
    expect(openAboveFloor).toBeGreaterThan(20 * openBelowFloor);
  });
});
