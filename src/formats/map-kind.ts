import type { ByteProgress } from '../pak/byte-source';
import type { PakFileSystem } from '../pak/vfs';
import { splatMapFiles } from './splat-map';

/**
 * The port's two kinds of map: a splat map, the port's own, and a BSP, Quake 3's. Every side that
 * loads a map tells them apart by the same rule, each by its own files: the page, the server's
 * worker, the dedicated server and a client elsewhere. Quake 3 sends a map's name and nothing
 * else, so the rule is what keeps them agreeing.
 *
 * Engine-free, like the other readers.
 */

/** What a map is loaded from. */
export type MapKind = 'splat' | 'bsp';

/** Where a map's BSP is (`SV_Map_f`, `sv_ccmds.c:167`). */
export function bspPath(name: string): string {
  return `maps/${name}.bsp`;
}

/**
 * What the port loads a map from: its splat where it ships one, and else its BSP; none where the
 * search path has neither. A splat wins where a map ships both.
 *
 * @param fs - The search path.
 * @param name - The map's name, as `map <n>` takes it.
 */
export function mapKind(fs: Pick<PakFileSystem, 'has'>, name: string): MapKind | null {
  if (fs.has(splatMapFiles(name).splat)) return 'splat';
  return fs.has(bspPath(name)) ? 'bsp' : null;
}

/**
 * A map's BSP, read whole as `CM_LoadMap` reads it (`cm_load.c:612-619`).
 *
 * @param fs - The search path.
 * @param name - The map's name.
 * @param progress - Told as the file's bytes come in.
 * @throws `Couldn't load maps/<n>.bsp` for a map the search path has not got, in Q3's words
 */
export async function readBsp(
  fs: Pick<PakFileSystem, 'read'>,
  name: string,
  progress?: ByteProgress
): Promise<Uint8Array> {
  const path = bspPath(name);
  const bytes = await fs.read(path, progress);
  if (!bytes) throw new Error(`Couldn't load ${path}`);
  return bytes;
}

/**
 * Every map the search path has, as `map <n>` takes them: each one {@link mapKind} finds, once,
 * in the search path's lower case.
 *
 * @param fs - The search path.
 */
export function mapNames(fs: Pick<PakFileSystem, 'list'>): string[] {
  const names = new Set<string>();
  for (const extension of ['sog', 'bsp']) {
    for (const path of fs.list('maps/', extension)) {
      names.add(path.slice('maps/'.length, -(extension.length + 1)));
    }
  }
  return [...names].sort();
}
