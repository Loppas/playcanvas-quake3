import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { memorySource } from '../pak/byte-source';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import { packBin } from '../sim/octree-test-fixtures';
import type { VoxelOctreeHeader } from '../sim/voxel-svo';
import { readOctree, splatMapFiles, wholeBuffer } from './splat-map';

/** A one-block octree: an empty root, 4 voxels a side. */
const HEADER: VoxelOctreeHeader = {
  version: '1.1',
  gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  voxelResolution: 1,
  leafSize: 4,
  treeDepth: 0,
  numInteriorNodes: 0,
  numMixedLeaves: 0,
  nodeCount: 1,
  leafDataCount: 0
};

/** A search path of one pak holding the given files. */
async function searchPathOf(files: Record<string, Uint8Array>): Promise<PakFileSystem> {
  const fs = new PakFileSystem();
  fs.mount(await ZipArchive.open(memorySource('map-test.pk3', zipSync(files))));
  return fs;
}

const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('splatMapFiles', () => {
  it("names every file of a map under maps/, after the map, as a BSP's would be", () => {
    expect(splatMapFiles('garage_rats')).toEqual({
      splat: 'maps/garage_rats.sog',
      octreeHeader: 'maps/garage_rats.voxel.json',
      octreeNodes: 'maps/garage_rats.voxel.bin',
      collisionMesh: 'maps/garage_rats.collision.glb',
      entities: 'maps/garage_rats.ent'
    });
  });
});

describe('readOctree', () => {
  it('reads the header and its nodes through the search path', async () => {
    const fs = await searchPathOf({
      'maps/room.voxel.json': text(HEADER),
      'maps/room.voxel.bin': new Uint8Array(packBin([0], []))
    });
    const octree = await readOctree(fs, 'room');
    expect(octree.voxels).toEqual({ x: 4, y: 4, z: 4 });
  });

  it("stops the load with Q3's words when either half is missing", async () => {
    const noNodes = await searchPathOf({ 'maps/room.voxel.json': text(HEADER) });
    await expect(readOctree(noNodes, 'room')).rejects.toThrow("Couldn't load maps/room.voxel.bin");
    const nodes = new Uint8Array(packBin([0], []));
    const noHeader = await searchPathOf({ 'maps/room.voxel.bin': nodes });
    await expect(readOctree(noHeader, 'room')).rejects.toThrow(
      "Couldn't load maps/room.voxel.json"
    );
  });
});

describe('wholeBuffer', () => {
  it('hands back a buffer the bytes fill as it is', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(wholeBuffer(bytes)).toBe(bytes.buffer);
  });

  it('copies a view into a larger read, so the buffer holds the file alone', () => {
    const read = new Uint8Array([9, 1, 2, 3, 9]);
    const buffer = wholeBuffer(read.subarray(1, 4));
    expect(buffer).not.toBe(read.buffer);
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
  });
});
