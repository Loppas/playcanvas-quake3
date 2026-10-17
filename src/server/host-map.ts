import { parseBspCollision } from '../formats/bsp';
import { readEntityText } from '../formats/entity-text';
import { bspPath, mapKind, readBsp } from '../formats/map-kind';
import { readOctreeFiles, wholeBuffer } from '../formats/splat-map';
import type { CvarStore } from '../net/cvar';
import type { PakFileSystem } from '../pak/vfs';
import { createClipPointContents, createClipTrace } from '../sim/clip-trace';
import { entityString, loadMap } from '../sim/cm/cm-load';
import { createVoxelPointContents, createVoxelTrace } from '../sim/voxel-trace';
import { SparseVoxelOctree, type VoxelOctreeHeader } from '../sim/voxel-svo';
import { SvoVoxelGrid } from '../svo-voxel-grid';
import type { HostMap } from './host';

/**
 * A map as `CM_LoadMap` gives it to the server, in the shape that crosses a process boundary:
 * the page reads a map's files and hands a worker's program their bytes. A splat map's or
 * a BSP's, by what the map ships.
 *
 * Neither crosses built, as a structured clone would strip the octree of its methods and a clip
 * map is the larger to copy: the program builds the map with {@link hostMapFromData}, as the
 * in-process load does.
 */
export type HostMapData = SplatHostMapData | BspHostMapData;

/** A splat map's: its entity text and its collision octree. */
export interface SplatHostMapData {
  kind: 'splat';
  /** The map's name, as `map <n>` takes it. It becomes `mapname`, which clients read. */
  name: string;
  /** The map's entity text: `maps/<n>.ent`, as `CM_EntityString` gives it. */
  entities: string;
  /** The octree's header, as its JSON file holds it. */
  header: VoxelOctreeHeader;
  /** The octree's words, whole: a transfer can move this rather than copy it. */
  nodes: ArrayBuffer;
}

/** A BSP's: the file whole, which holds its entity text and its collision both. */
export interface BspHostMapData {
  kind: 'bsp';
  /** The map's name, as `map <n>` takes it. It becomes `mapname`, which clients read. */
  name: string;
  /** `maps/<n>.bsp`, whole: a transfer can move this rather than copy it. */
  bsp: ArrayBuffer;
}

/** What a {@link HostMapData}'s crossing can move rather than copy. */
export function hostMapTransfer(data: HostMapData): Transferable[] {
  return [data.kind === 'splat' ? data.nodes : data.bsp];
}

/**
 * Read a map for a server program that is elsewhere, which {@link hostMapFromData} builds a
 * {@link HostMap} of: the BSP where {@link mapKind} finds one, which `CM_LoadMap` reads
 * (`cm_load.c:612-619`), and otherwise a splat map's collision and entity text.
 *
 * @param fs - The search path.
 * @param name - The map's name.
 * @throws `Couldn't load` for a file the search path has not got, as `CM_LoadMap` throws
 */
export async function readHostMapData(
  fs: Pick<PakFileSystem, 'has' | 'read'>,
  name: string
): Promise<HostMapData> {
  if (mapKind(fs, name) === 'bsp') {
    return { kind: 'bsp', name, bsp: wholeBuffer(await readBsp(fs, name)) };
  }
  const [collision, entities] = await Promise.all([
    readOctreeFiles(fs, name),
    readEntityText(fs, name)
  ]);
  return { kind: 'splat', name, entities, header: collision.header, nodes: collision.nodes };
}

/** Where a server's collision prints, and the cvars it reads. */
export interface HostMapOptions {
  /** The server's cvars, whose `cm_*` collision reads (a BSP's alone). */
  cvars?: CvarStore;
  /** `Com_Printf`, for collision's warnings (a BSP's alone). */
  print?: (text: string) => void;
}

/**
 * The map a {@link HostMapData} carries, with the trace through it and the contents in it, which
 * `SV_Trace` and `SV_PointContents` ask first.
 * A splat map's octree is rebuilt. A BSP's collision is loaded as the server's `CM_LoadMap` loads
 * it (`sv_init.c:470`), with collision's checks alone: Q3's server never runs the renderer, so
 * the lumps only the renderer reads are not read.
 *
 * @throws as `CM_LoadMap` throws, in Q3's words, for a BSP collision refuses
 */
export function hostMapFromData(data: HostMapData, options: HostMapOptions = {}): HostMap {
  if (data.kind === 'splat') {
    const grid = new SvoVoxelGrid(SparseVoxelOctree.fromBuffers(data.header, data.nodes));
    return {
      name: data.name,
      entities: data.entities,
      trace: createVoxelTrace(grid),
      pointContents: createVoxelPointContents(grid)
    };
  }
  const path = bspPath(data.name);
  const cm = loadMap(parseBspCollision(new Uint8Array(data.bsp), path), path, {
    print: options.print
  });
  return {
    name: data.name,
    entities: entityString(cm),
    trace: createClipTrace(cm, options.cvars),
    pointContents: createClipPointContents(cm),
    clipMap: cm
  };
}
