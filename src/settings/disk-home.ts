import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HomeFolder } from './home-folder';

/**
 * `fs_homepath` on a disk, for the runs that are not a page: `exec`'s cfgs and the presets, read
 * where they sit. Read-only, as the shell's route is: the port never writes a server's
 * config — the dedicated server's own changes are kept in memory for as long as it runs.
 */

const isCfgName = (name: string) => /\.cfg$/i.test(name);

/**
 * The home folder under `root`, read with `node:fs`. Neither call throws, as {@link HomeFolder}
 * asks: a file that is not there is `undefined`, a folder that is not there lists nothing.
 *
 * @param root - The folder itself, as `fs_homepath` names it.
 */
export function diskHome(root: string): HomeFolder {
  const at = (...names: readonly string[]) => join(root, ...names);
  return {
    async read(path) {
      try {
        return await readFile(at(...path.split('/')), 'utf8');
      } catch {
        return undefined;
      }
    },
    async list(dir) {
      try {
        const entries = await readdir(dir === '' ? root : at(...dir.split('/')), {
          withFileTypes: true
        });
        return entries
          .filter((entry) => entry.isFile() && isCfgName(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    }
  };
}
