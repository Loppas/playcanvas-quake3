import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOctree } from '../formats/splat-map';
import { nodeFileSource } from '../pak/node-source';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import type { SparseVoxelOctree, VoxelOctreeHeader } from './voxel-svo';

/**
 * Shared collision-octree test fixtures: the format packer and the real-bake loader,
 * single-sourced so the `.voxel.bin` layout and the map path live in one place. The `header`
 * builders stay local to each test file — their defaults differ on purpose (hand-built trees
 * want `voxelResolution` 1 / `treeDepth` 1; the adapter wants 0.25 / 3), so they are not dupes.
 */

/**
 * Pack node and leaf words into a `.voxel.bin` buffer: nodes first, then leafData, uint32
 * little-endian — the exact layout splat-transform's `writeOctreeFiles` emits.
 */
export function packBin(nodes: number[], leafData: number[]): ArrayBuffer {
  return Uint32Array.from([...nodes, ...leafData]).buffer.slice(0);
}

// The real bake is in the garage's pk3, which is gitignored (185 MB); guarded tests skip when it is
// absent. Resolved from this file's own location, so every importer agrees on the path regardless
// of its own depth.
const MAPS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/maps');
const REAL_PK3 = resolve(MAPS_DIR, 'map-garage_rats.pk3');
export const haveRealBake = existsSync(REAL_PK3);

/**
 * Read and decode the real garage_rats bake out of its pk3, as the game reads it, returning both
 * the parsed header (for reproduction checks) and the decoded octree. Call only when
 * {@link haveRealBake}.
 */
export async function loadRealBake(): Promise<{
  header: VoxelOctreeHeader;
  octree: SparseVoxelOctree;
}> {
  const fs = new PakFileSystem();
  fs.mount(await ZipArchive.open(nodeFileSource(REAL_PK3)));
  const text = await fs.readText('maps/garage_rats.voxel.json');
  const header = JSON.parse(text!) as VoxelOctreeHeader;
  return { header, octree: await readOctree(fs, 'garage_rats') };
}
