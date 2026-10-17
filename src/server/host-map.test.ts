import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { LUMP_BRUSHES, LUMP_FOGS, parseBsp } from '../formats/bsp';
import { bspFile, buildBsp, int32s } from '../formats/bsp-test-fixtures';
import { testCvars } from '../net/net-test-fixtures';
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from '../net/protocol';
import { memorySource } from '../pak/byte-source';
import { PakFileSystem } from '../pak/vfs';
import { ZipArchive } from '../pak/zip';
import { clipBsp, cubeBsp, patchBsp } from '../sim/cm/collision-test-fixtures';
import { CONTENTS, MASK } from '../sim/constants';
import { mapOf, spawnSpot } from '../sim/map-test-fixtures';
import { packBin } from '../sim/octree-test-fixtures';
import { vec3 } from '../sim/vec3';
import type { VoxelOctreeHeader } from '../sim/voxel-svo';
import {
  hostMapFromData,
  hostMapTransfer,
  readHostMapData,
  type BspHostMapData,
  type SplatHostMapData
} from './host-map';

/**
 * A map as it crosses to a program elsewhere: the page reads a map's files, and the program
 * builds the same map the in-process load does.
 */

/** A one-block octree with an empty root: 4 voxels a side, none of them solid. */
const HEADER: VoxelOctreeHeader = {
  version: '1.1',
  gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  voxelResolution: 1,
  leafSize: 4,
  treeDepth: 0,
  numInteriorNodes: 0,
  numMixedLeaves: 1,
  nodeCount: 1,
  leafDataCount: 2
};

/**
 * The map's entity text, with one spawn spot inside the grid. The octree's cell 0 is sim 0, run
 * the other way (`SvoVoxelGrid`'s frame flip), so the 0..4 m grid is the sims' −4..0.
 */
const ENTITIES = mapOf(spawnSpot(vec3(-64, -64, -32)));

/** A search path of one pak holding the given files. */
async function searchPathOf(files: Record<string, Uint8Array>): Promise<PakFileSystem> {
  const fs = new PakFileSystem();
  fs.mount(await ZipArchive.open(memorySource('map-test.pk3', zipSync(files))));
  return fs;
}

const text = (value: string) => new TextEncoder().encode(value);

/** A search path holding a whole map. */
function mapFiles(): Promise<PakFileSystem> {
  return searchPathOf({
    'maps/room.voxel.json': text(JSON.stringify(HEADER)),
    'maps/room.voxel.bin': new Uint8Array(packBin([0], [0, 0])),
    'maps/room.ent': text(ENTITIES)
  });
}

/** The collision tests' small map as its file: a 128-unit cube about the origin. */
function cubeFile(): Uint8Array {
  return bspFile(cubeBsp({ entityString: `${ENTITIES}\0` }));
}

describe('readHostMapData', () => {
  it("reads the map's octree and its entity text, whole for a transfer", async () => {
    const data = (await readHostMapData(await mapFiles(), 'room')) as SplatHostMapData;

    expect(data.kind).toBe('splat');
    expect(data.name).toBe('room');
    expect(data.entities).toBe(ENTITIES);
    expect(data.header).toEqual(HEADER);
    // The words are a buffer of their own, which a transfer can move rather than copy.
    expect(data.nodes).toBeInstanceOf(ArrayBuffer);
    expect(hostMapTransfer(data)).toEqual([data.nodes]);
  });

  it("stops the read with Q3's words when either half is missing", async () => {
    const fs = await searchPathOf({ 'maps/room.ent': text(ENTITIES) });
    await expect(readHostMapData(fs, 'room')).rejects.toThrow("Couldn't load maps/room.voxel.json");
  });

  it('reads a map that ships a BSP and no splat as its BSP, whole for a transfer', async () => {
    const file = cubeFile();
    const data = (await readHostMapData(
      await searchPathOf({ 'maps/cube.bsp': file }),
      'cube'
    )) as BspHostMapData;

    expect([data.kind, data.name]).toEqual(['bsp', 'cube']);
    expect(data.bsp).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(data.bsp)).toEqual(file);
    expect(hostMapTransfer(data)).toEqual([data.bsp]);
  });

  it("says a BSP it could not read in CM_LoadMap's words", async () => {
    // The search path had the file when it was asked, and has it no longer.
    const fs = { has: (path: string) => path.endsWith('.bsp'), read: async () => undefined };
    await expect(readHostMapData(fs, 'gone')).rejects.toThrow("Couldn't load maps/gone.bsp");
  });

  it('reads a map that ships both as its splat', async () => {
    const fs = await searchPathOf({
      'maps/room.sog': new Uint8Array(4),
      'maps/room.bsp': cubeFile(),
      'maps/room.voxel.json': text(JSON.stringify(HEADER)),
      'maps/room.voxel.bin': new Uint8Array(packBin([0], [0, 0])),
      'maps/room.ent': text(ENTITIES)
    });
    expect((await readHostMapData(fs, 'room')).kind).toBe('splat');
  });
});

describe('hostMapFromData', () => {
  it('builds the map back, trace and all, as the in-process load does', async () => {
    const map = hostMapFromData(await readHostMapData(await mapFiles(), 'room'));

    expect(map.name).toBe('room');
    expect(map.entities).toBe(ENTITIES);
    const trace = map.trace!(
      vec3(-64, -64, -32),
      vec3(-15, -15, -15),
      vec3(15, 15, 15),
      vec3(-64, -64, -48),
      ENTITYNUM_NONE,
      CONTENTS.SOLID
    );
    // The root is empty: the sweep crosses nothing, as the octree's own tests pin.
    expect(trace.fraction).toBe(1);
    expect(trace.startsolid).toBe(false);
    // Nothing is inside the grid, and everything outside it is solid.
    expect(map.pointContents!(vec3(-64, -64, -32), ENTITYNUM_NONE)).toBe(0);
    expect(map.pointContents!(vec3(64, 64, 64), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
  });

  it("loads a BSP's collision, and traces through it as SV_Trace does", async () => {
    const fs = await searchPathOf({ 'maps/cube.bsp': cubeFile() });
    const map = hostMapFromData(await readHostMapData(fs, 'cube'));

    expect(map.name).toBe('cube');
    // `CM_EntityString`: lump 0, its closing NUL kept, at which the game's reader stops.
    expect(map.entities).toBe(`${ENTITIES}\0`);
    expect(map.clipMap?.name).toBe('maps/cube.bsp');
    const fall = map.trace!(
      vec3(0, 0, 200),
      vec3(-15, -15, -24),
      vec3(15, 15, 32),
      vec3(0, 0, 0),
      ENTITYNUM_NONE,
      MASK.PLAYERSOLID
    );
    // The box's feet stop SURFACE_CLIP_EPSILON above the cube's top.
    expect(fall.endpos.z - 24).toBeCloseTo(64.125, 4);
    expect([fall.normal, fall.entityNum]).toEqual([vec3(0, 0, 1), ENTITYNUM_WORLD]);
    // `SV_PointContents`' world: the cube is solid, and above it is nothing.
    expect(map.pointContents!(vec3(0, 0, 0), ENTITYNUM_NONE)).toBe(CONTENTS.SOLID);
    expect(map.pointContents!(vec3(0, 0, 100), ENTITYNUM_NONE)).toBe(0);
  });

  it('stops a player and a corpse at player clip, and lets a shot through', () => {
    const shaders = clipBsp().shaders.map((shader, i) =>
      i === 0 ? { ...shader, contentFlags: CONTENTS.PLAYERCLIP } : shader
    );
    const map = hostMapFromData({
      kind: 'bsp',
      name: 'clip',
      bsp: bspFile(cubeBsp({ shaders })).slice().buffer
    });
    const fall = (mask: number) =>
      map.trace!(
        vec3(0, 0, 200),
        vec3(-15, -15, -24),
        vec3(15, 15, 32),
        vec3(0, 0, 0),
        ENTITYNUM_NONE,
        mask
      );

    expect(fall(MASK.PLAYERSOLID).endpos.z - 24).toBeCloseTo(64.125, 4);
    expect(fall(MASK.DEADSOLID).endpos.z - 24).toBeCloseTo(64.125, 4);
    expect(fall(MASK.SHOT).fraction).toBe(1);
    expect(map.pointContents!(vec3(0, 0, 0), ENTITYNUM_NONE)).toBe(CONTENTS.PLAYERCLIP);
  });

  it("reads collision's cvars from the server's store, as each trace runs", () => {
    const cvars = testCvars();
    const map = hostMapFromData(
      { kind: 'bsp', name: 'patch', bsp: bspFile(patchBsp()).slice().buffer },
      { cvars }
    );
    const point = () =>
      map.trace!(vec3(16, 16, 50), vec3(), vec3(), vec3(16, 16, -50), ENTITYNUM_NONE, MASK.SOLID);
    expect(point().fraction).toBeLessThan(1);
    cvars.set('cm_playerCurveClip', '0');
    expect(point().fraction).toBe(1);
  });

  it("makes collision's checks alone, as Q3's server never runs the renderer", () => {
    const file = buildBsp({ [LUMP_FOGS]: new Uint8Array(73) });
    expect(() => parseBsp(file, 'maps/fog.bsp')).toThrow('LoadMap: funny lump size in maps/fog.bsp');
    const map = hostMapFromData({ kind: 'bsp', name: 'fog', bsp: file.slice().buffer });
    expect(map.entities).toBe('');
  });

  it("refuses a map collision refuses, in Q3's words", () => {
    const file = buildBsp({ [LUMP_BRUSHES]: int32s(0, 0, 3) });
    expect(() => hostMapFromData({ kind: 'bsp', name: 'bad', bsp: file.slice().buffer })).toThrow(
      'CMod_LoadBrushes: bad shaderNum: 3'
    );
  });

  it("prints collision's warnings where it is told to", () => {
    // The patch's points as a bowtie, whose cells' triangles have no plane (`cm-load.test.ts`).
    const bowtie = [0, 0, 0, 32, 0, 0, 64, 0, 0, 0, 32, 0, 16, 16, 0, 32, 0, 0, 0, 64, 0, 0, 32, 0];
    const bsp = clipBsp();
    bsp.drawVerts.xyz = Float32Array.from([...bowtie, 0, 0, 0]);
    const lines: string[] = [];
    hostMapFromData(
      { kind: 'bsp', name: 'bowtie', bsp: bspFile(bsp).slice().buffer },
      { print: (line) => lines.push(line) }
    );
    expect(lines).toEqual(new Array(4).fill('WARNING: CM_GridPlane unresolvable\n'));
  });
});
