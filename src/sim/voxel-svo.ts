/**
 * Reader for the sparse voxel octree `splat-transform` bakes as a collision layer
 * (`--collision-mesh` / `.voxel.json` + `.voxel.bin`).
 *
 * The `.voxel.json` is a header only — bounds, resolution and array sizes. The octree itself
 * is the `.voxel.bin` sidecar: a Laine-Karras SVO of `uint32` nodes followed by `leafData`,
 * little-endian, `nodes` first. Every field of the layout below was read from the writer in the
 * installed `@playcanvas/splat-transform` (v3.1.6) `dist/cli.mjs`, not inferred:
 *
 * - **Interior node** — `(childMask << 24) | firstChildIndex`. `childMask` is the 8 octants
 *   present (bit `oct`), `firstChildIndex` is where this node's children begin in `nodes`.
 *   Children are stored contiguously in ascending octant order, present octants only, so the
 *   child for octant `oct` sits at `firstChildIndex + popcount(childMask & ((1 << oct) - 1))`.
 * - **Solid leaf** — the whole subtree is solid, marked `0xFF000000`. `firstChildIndex 0` is
 *   never valid for an interior node (the root is node 0 under the BFS layout), so this never
 *   collides with a real `(childMask << 24)` word.
 * - **Mixed leaf** — a partly-filled 4x4x4 block. The word is a plain index (high byte zero)
 *   into `leafData`, read in pairs: `leafData[2i]` is the low 32 bits and `leafData[2i+1]` the
 *   high 32 bits of a 64-bit occupancy mask over the block. The bit for local voxel
 *   `(lx, ly, lz)` is `lx + (ly << 2) + (lz << 4)`.
 *
 * The tree addresses **blocks** of `leafSize` (= 4) voxels per side; `treeDepth` octant bits
 * index a virtual `2^treeDepth` cube of blocks, of which only `nbx x nby x nbz` exist.
 *
 * This reader is engine-free and frame-agnostic: it answers solidity in the octree's own
 * integer grid space (indices from `gridBounds.min`, in splat-transform's coordinate frame).
 * Mapping the movement sim's Q3-unit Z-up coordinates — including splat-transform's
 * `ST_FRAME = diag(-1, -1, 1)` flip — into that space is the caller's job at the render/sim
 * boundary, the same seam `player-view.ts` leaves to its caller.
 */

/** Node word marking a fully-solid subtree (splat-transform `SOLID_LEAF_MARKER`). */
const SOLID_LEAF_MARKER = 0xff000000;

/** Voxels per block edge (`leafSize`); a leaf block is `LEAF_SIZE^3` = 64 voxels. */
const LEAF_SIZE = 4;

/** Shape of a `.voxel.json`, as written by `writeOctreeFiles`. */
export interface VoxelOctreeHeader {
  version: string;
  gridBounds: { min: [number, number, number]; max: [number, number, number] };
  sceneBounds: { min: [number, number, number]; max: [number, number, number] };
  /** Voxel edge length, in the octree's world units. */
  voxelResolution: number;
  /** Voxels per block edge — always 4 in the v1.1 format. */
  leafSize: number;
  treeDepth: number;
  numInteriorNodes: number;
  numMixedLeaves: number;
  /** Length of the `nodes` array, in `uint32`s. */
  nodeCount: number;
  /** Length of the `leafData` array, in `uint32`s (`2 * numMixedLeaves`). */
  leafDataCount: number;
}

/** Structural tallies from a full tree walk, for checking a decode against its header. */
export interface OctreeStats {
  interiorNodes: number;
  mixedLeaves: number;
  solidLeaves: number;
  /** Distinct node slots reached from the root. */
  nodesVisited: number;
  /** Node slots reached more than once — must be 0 for a well-formed tree. */
  duplicateVisits: number;
  /** Distinct `leafData` pairs referenced by mixed leaves. */
  leafPairsReferenced: number;
}

/** Population count of the low 8 bits — the octants present below `oct`. */
function popcount8(mask: number): number {
  let m = mask & 0xff;
  m = m - ((m >> 1) & 0x55);
  m = (m & 0x33) + ((m >> 2) & 0x33);
  return (m + (m >> 4)) & 0x0f;
}

/**
 * A decoded `splat-transform` collision octree, answering per-voxel solidity.
 *
 * Construct with {@link fromBuffers}. Queries are in the octree's own grid space: cell
 * `(ix, iy, iz)` is the voxel `ix` steps along +X from `gridBounds.min`, and covers the
 * world region `[min + ix * voxelResolution, min + (ix + 1) * voxelResolution)`.
 */
export class SparseVoxelOctree {
  readonly voxelResolution: number;
  readonly treeDepth: number;
  readonly gridMin: readonly [number, number, number];
  readonly gridMax: readonly [number, number, number];

  /** Block counts per axis (level 0 of the tree). */
  readonly blocks: { readonly x: number; readonly y: number; readonly z: number };
  /** Voxel counts per axis (`blocks * leafSize`). */
  readonly voxels: { readonly x: number; readonly y: number; readonly z: number };

  private readonly nodes: Uint32Array;
  private readonly leafData: Uint32Array;

  private constructor(header: VoxelOctreeHeader, nodes: Uint32Array, leafData: Uint32Array) {
    this.voxelResolution = header.voxelResolution;
    this.treeDepth = header.treeDepth;
    this.gridMin = header.gridBounds.min;
    this.gridMax = header.gridBounds.max;
    this.nodes = nodes;
    this.leafData = leafData;

    // Blocks tile gridBounds exactly (a Math.round mirrors buildBlockGridParams, which the
    // bake aligns bounds to a block boundary before writing).
    const blockSize = LEAF_SIZE * header.voxelResolution;
    const nbx = Math.round((this.gridMax[0] - this.gridMin[0]) / blockSize);
    const nby = Math.round((this.gridMax[1] - this.gridMin[1]) / blockSize);
    const nbz = Math.round((this.gridMax[2] - this.gridMin[2]) / blockSize);
    this.blocks = { x: nbx, y: nby, z: nbz };
    this.voxels = { x: nbx * LEAF_SIZE, y: nby * LEAF_SIZE, z: nbz * LEAF_SIZE };
  }

  /**
   * Decode a `.voxel.json` header and its `.voxel.bin` payload.
   *
   * @param header - Parsed `.voxel.json`.
   * @param binary - Raw `.voxel.bin` bytes: `nodeCount` node words then `leafDataCount` leaf
   *   words, `uint32` little-endian. Its length must match the header's counts.
   */
  static fromBuffers(header: VoxelOctreeHeader, binary: ArrayBuffer): SparseVoxelOctree {
    const expected = (header.nodeCount + header.leafDataCount) * 4;
    if (binary.byteLength !== expected) {
      throw new Error(
        `voxel.bin size ${binary.byteLength} != header (nodeCount + leafDataCount) * 4 = ${expected}`
      );
    }
    if (header.leafDataCount !== header.numMixedLeaves * 2) {
      throw new Error(
        `header leafDataCount ${header.leafDataCount} != 2 * numMixedLeaves ${header.numMixedLeaves * 2}`
      );
    }
    // Uint32Array over the buffer reads native (little-endian) words — the format's byte order
    // on every platform this runs on.
    const words = new Uint32Array(binary);
    const nodes = words.subarray(0, header.nodeCount);
    const leafData = words.subarray(header.nodeCount, header.nodeCount + header.leafDataCount);
    return new SparseVoxelOctree(header, nodes, leafData);
  }

  /**
   * Whether the voxel cell at grid index `(ix, iy, iz)` is solid.
   *
   * Cells outside `gridBounds` report solid: the world is closed, so the mover can never leave
   * it (matches splat-transform's model, where space beyond the grid is solid by definition).
   */
  isSolidCell(ix: number, iy: number, iz: number): boolean {
    if (
      ix < 0 || iy < 0 || iz < 0 ||
      ix >= this.voxels.x || iy >= this.voxels.y || iz >= this.voxels.z
    ) {
      return true;
    }
    if (this.nodes.length === 0) {
      return false; // Empty tree: nothing solid within bounds.
    }

    const bx = ix >> 2;
    const by = iy >> 2;
    const bz = iz >> 2;

    let idx = 0;
    // Descend one octant per level, from the root (level treeDepth) to the leaf blocks
    // (level 0). At the step into level L-1 the octant is bit L-1 of the block coordinate.
    for (let level = this.treeDepth; level >= 1; level--) {
      const node = this.nodes[idx];
      if (node === SOLID_LEAF_MARKER) {
        return true; // A solid subtree collapsed above the leaves.
      }
      const childMask = node >>> 24; // Interior: leaves only occur at level 0, handled below.
      const bit = level - 1;
      const oct =
        ((bx >>> bit) & 1) |
        (((by >>> bit) & 1) << 1) |
        (((bz >>> bit) & 1) << 2);
      if ((childMask & (1 << oct)) === 0) {
        return false; // Octant absent — an empty (open) subtree.
      }
      const firstChild = node & 0x00ffffff;
      idx = firstChild + popcount8(childMask & ((1 << oct) - 1));
    }

    return this.isLeafSolid(this.nodes[idx], ix & 3, iy & 3, iz & 3);
  }

  /**
   * Whether the point `(px, py, pz)`, in the octree's world units and frame, lies in solid
   * space. Convenience over {@link isSolidCell} for spot checks; the trace uses cells.
   */
  isSolidPoint(px: number, py: number, pz: number): boolean {
    const vr = this.voxelResolution;
    return this.isSolidCell(
      Math.floor((px - this.gridMin[0]) / vr),
      Math.floor((py - this.gridMin[1]) / vr),
      Math.floor((pz - this.gridMin[2]) / vr)
    );
  }

  /**
   * Walk the whole tree from the root and tally node types and reachability. Used to check a
   * decode against the header: a correct reader reproduces `numInteriorNodes`
   * and `numMixedLeaves`, reaches every node in `nodeCount` exactly once, and references each
   * `leafData` pair. Mismatches mean the layout is being read wrong.
   */
  validate(): OctreeStats {
    const stats: OctreeStats = {
      interiorNodes: 0,
      mixedLeaves: 0,
      solidLeaves: 0,
      nodesVisited: 0,
      duplicateVisits: 0,
      leafPairsReferenced: 0
    };
    if (this.nodes.length === 0) {
      return stats;
    }
    const visited = new Uint8Array(this.nodes.length);
    const leafPairs = new Set<number>();

    const walk = (idx: number) => {
      if (visited[idx]) {
        stats.duplicateVisits++;
        return;
      }
      visited[idx] = 1;
      stats.nodesVisited++;

      const node = this.nodes[idx];
      if (node === SOLID_LEAF_MARKER) {
        stats.solidLeaves++;
        return;
      }
      if (node >>> 24) {
        stats.interiorNodes++;
        const childMask = node >>> 24;
        const firstChild = node & 0x00ffffff;
        let rank = 0;
        for (let oct = 0; oct < 8; oct++) {
          if (childMask & (1 << oct)) {
            walk(firstChild + rank);
            rank++;
          }
        }
        return;
      }
      // High byte zero: a mixed leaf indexing leafData.
      stats.mixedLeaves++;
      leafPairs.add(node);
    };

    walk(0);
    stats.leafPairsReferenced = leafPairs.size;
    return stats;
  }

  /**
   * Resolve a level-0 leaf: solid leaves fill the block; mixed leaves carry a 64-bit occupancy
   * mask whose bit `lx + (ly << 2) + (lz << 4)` is this voxel.
   */
  private isLeafSolid(leaf: number, lx: number, ly: number, lz: number): boolean {
    if (leaf === SOLID_LEAF_MARKER) {
      return true;
    }
    const bitIdx = lx + (ly << 2) + (lz << 4);
    const pair = leaf * 2;
    if (bitIdx < 32) {
      return ((this.leafData[pair] >>> bitIdx) & 1) === 1;
    }
    return ((this.leafData[pair + 1] >>> (bitIdx - 32)) & 1) === 1;
  }
}
