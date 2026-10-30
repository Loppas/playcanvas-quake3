import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hasExtension, type HomeFolder } from './home-folder';

/**
 * `fs_homepath` on a disk, for the runs that are not a page: `exec`'s cfgs and the presets, read
 * where they sit, and the files the console writes there. Nothing writes a server's `q3config.cfg`:
 * the dedicated server's own changes are kept in memory for as long as it runs.
 */

/**
 * The home folder under `root`, read and written with `node:fs`. No call throws, as
 * {@link HomeFolder} asks: a file that is not there is `undefined`, a folder that is not there
 * lists nothing, and a file that can't be written is `false`.
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
    async list(dir, extension) {
      try {
        const entries = await readdir(dir === '' ? root : at(...dir.split('/')), {
          withFileTypes: true
        });
        return entries
          .filter((entry) => entry.isFile() && hasExtension(entry.name, extension))
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    },
    async write(path, text) {
      const file = at(...path.split('/'));
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text, 'utf8');
        return true;
      } catch {
        return false;
      }
    }
  };
}
