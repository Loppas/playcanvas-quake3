import type { PakFileSystem } from '../pak/vfs';
import { SparseVoxelOctree, type VoxelOctreeHeader } from '../sim/voxel-svo';

/**
 * A splat map's files, by the map's name: a Quake 3 map tree with the BSP swapped out
 * (`splat-maps/docs/map-format.md` §2). Everything a map is lives under `maps/`, named after it,
 * and is read through the search path, as Q3 reads `maps/<n>.bsp`.
 *
 * The splat stands where the BSP's drawn surfaces stood, the octree where its brushes stood, and
 * the entity text where its lump 0 stood. A splat map's frame is fixed by the format (§6), so a
 * map carries no orientation of its own.
 *
 * Engine-free, like the other readers.
 */

/**
 * The layouts of a splat map the port reads, as its worldspawn's `_pcq_format` numbers them. The
 * format's spec owns the numbers (`map-format.md` §7, §9).
 */
export const SPLAT_MAP_FORMATS: readonly string[] = ['1'];

/** Every file a splat map is, as paths on the search path. */
export interface SplatMapFiles {
  /**
   * `maps/<n>.sog`: the splat. It stands where the BSP stood, so it is what `map <n>` looks for
   * before it changes anything (`SV_Map_f`, `sv_ccmds.c:165–171`).
   */
  splat: string;
  /** `maps/<n>.voxel.json`: the collision octree's header, which `CM_LoadMap` stands for. */
  octreeHeader: string;
  /** `maps/<n>.voxel.bin`: the octree's nodes and leaves, beside its header. */
  octreeNodes: string;
  /**
   * `maps/<n>.collision.glb`: the collision mesh, drawn over the map by `pcq_drawCollision`. The
   * one optional file: nothing traces against it.
   */
  collisionMesh: string;
  /** `maps/<n>.ent`: the entity text, where a BSP's lump 0 stood. */
  entities: string;
}

/**
 * The files of the map `map <n>` names.
 *
 * @param name - The map's name, as `map <n>` takes it: `garage_rats`, not a path.
 */
export function splatMapFiles(name: string): SplatMapFiles {
  const stem = `maps/${name}`;
  return {
    splat: `${stem}.sog`,
    octreeHeader: `${stem}.voxel.json`,
    octreeNodes: `${stem}.voxel.bin`,
    collisionMesh: `${stem}.collision.glb`,
    entities: `${stem}.ent`
  };
}

/**
 * The map's collision octree, read through the search path where `CM_LoadMap` reads a BSP's
 * brushes. A map without one does not load: Q3's `Couldn't load` (`cm_load.c:618`), which the
 * format asks the port to reproduce (`map-format.md` §2.2).
 *
 * @param fs - The search path.
 * @param name - The map's name.
 */
export async function readOctree(
  fs: Pick<PakFileSystem, 'read'>,
  name: string
): Promise<SparseVoxelOctree> {
  const { header, nodes } = await readOctreeFiles(fs, name);
  return SparseVoxelOctree.fromBuffers(header, nodes);
}

/**
 * The octree's two files as they are, for a load on the other side of a boundary: the header, as
 * its JSON holds it, and its words, whole, which a transfer can move rather than copy.
 *
 * @param fs - The search path.
 * @param name - The map's name.
 */
export async function readOctreeFiles(
  fs: Pick<PakFileSystem, 'read'>,
  name: string
): Promise<{ header: VoxelOctreeHeader; nodes: ArrayBuffer }> {
  const { octreeHeader, octreeNodes } = splatMapFiles(name);
  const [header, nodes] = await Promise.all([fs.read(octreeHeader), fs.read(octreeNodes)]);
  if (!header) throw new Error(`Couldn't load ${octreeHeader}`);
  if (!nodes) throw new Error(`Couldn't load ${octreeNodes}`);
  const parsed = JSON.parse(new TextDecoder().decode(header)) as VoxelOctreeHeader;
  return { header: parsed, nodes: wholeBuffer(nodes) };
}

/**
 * The bytes as a buffer of their own, which the octree's words and the engine's parsers read
 * whole. A file read out of a pak can be a view into a larger read, and is copied only then.
 */
export function wholeBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  return buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength
    ? buffer
    : bytes.slice().buffer;
}
