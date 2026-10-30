import { opfsAvailable, opfsRoot } from '../browser-storage';
import { downloadFile } from './config-file';

/**
 * The home folder, `fs_homepath`: the cfgs kept beside `q3config.cfg`, which `exec` reads, and the
 * files the console writes there.
 *
 * It is kept where the config is (`config-file.ts`): the folder itself in the desktop shell, OPFS
 * in a browser build, and both in dev, the folder first.
 */

/** The route to the folder (`scripts/home-cfg-route.mjs`). */
export const HOME_ROUTE = '/homepath/';

/** The files the folder lists: the cfgs `exec` reads, and the text `condump` writes. */
export type HomeExtension = '.cfg' | '.txt';

/** Whether a name ends in the extension, in any case. */
export const hasExtension = (name: string, extension: HomeExtension) =>
  name.toLowerCase().endsWith(extension);

/** The home folder. No call throws. */
export interface HomeFolder {
  /** A file's text by its path below the folder, or `undefined` if there is none or it can't be read. */
  read(path: string): Promise<string | undefined>;
  /**
   * The names of the files with the extension, in any case, directly in a folder below it, `''`
   * being the folder itself, or none for a folder there is none of.
   */
  list(dir: string, extension: HomeExtension): Promise<string[]>;
  /**
   * Replace a file by its path below the folder, making the folders it is in.
   *
   * @returns Whether it was written.
   */
  write(path: string, text: string): Promise<boolean>;
}

/**
 * A file's name as a path below the home folder, as `FS_BuildOSPath` makes one
 * (`files.c:501–516`): `\` is a separator as `/` is, a run of them is one, and none leads.
 */
export function homePath(name: string): string {
  return name.replace(/[/\\]+/g, '/').replace(/^\//, '');
}

/** The part of a `FileSystemDirectoryHandle` used here, whose listing TypeScript's DOM types don't carry. */
interface OpfsFolder {
  getDirectoryHandle(name: string, options?: { create: boolean }): Promise<OpfsFolder>;
  getFileHandle(name: string, options?: { create: boolean }): Promise<FileSystemFileHandle>;
  values(): AsyncIterable<{ readonly kind: 'file' | 'directory'; readonly name: string }>;
}

/**
 * The folder below the build's folder in OPFS that `names` lead to, a name at a time. Rejects
 * where there is none, unless `create` makes it.
 */
async function opfsFolder(names: readonly string[], create = false): Promise<OpfsFolder> {
  let folder = (await opfsRoot()) as unknown as OpfsFolder;
  for (const name of names) folder = await folder.getDirectoryHandle(name, { create });
  return folder;
}

/** The folder in OPFS: the build's folder, which holds `q3config.cfg`. */
export const opfsHome: HomeFolder = {
  async read(path) {
    if (!opfsAvailable()) return undefined;
    try {
      const names = path.split('/');
      const folder = await opfsFolder(names.slice(0, -1));
      return await (await (await folder.getFileHandle(names[names.length - 1])).getFile()).text();
    } catch {
      return undefined;
    }
  },
  async list(dir, extension) {
    if (!opfsAvailable()) return [];
    try {
      const folder = await opfsFolder(dir === '' ? [] : dir.split('/'));
      const names: string[] = [];
      for await (const entry of folder.values()) {
        if (entry.kind === 'file' && hasExtension(entry.name, extension)) names.push(entry.name);
      }
      return names.sort();
    } catch {
      return [];
    }
  },
  async write(path, text) {
    if (!opfsAvailable()) return false;
    try {
      const names = path.split('/');
      const folder = await opfsFolder(names.slice(0, -1), true);
      const file = await folder.getFileHandle(names[names.length - 1], { create: true });
      const writable = await file.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch {
      return false;
    }
  }
};

/** A path as the route takes it: each name encoded. */
function routePath(path: string): string {
  return HOME_ROUTE + path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The folder in `fs_homepath`, over its route.
 *
 * @param fetcher - `fetch`, or a stand-in for a test.
 */
export function routeHome(fetcher: typeof fetch = (...args) => fetch(...args)): HomeFolder {
  return {
    async read(path) {
      try {
        const response = await fetcher(routePath(path), { cache: 'no-store' });
        return response.status === 200 ? await response.text() : undefined;
      } catch {
        return undefined;
      }
    },
    async list(dir, extension) {
      try {
        const url = dir === '' ? HOME_ROUTE : `${routePath(dir)}/`;
        const response = await fetcher(url, { cache: 'no-store' });
        if (response.status !== 200) return [];
        const names: unknown = await response.json();
        if (!Array.isArray(names)) return [];
        // The route lists both kinds of file.
        return names.filter(
          (name): name is string => typeof name === 'string' && hasExtension(name, extension)
        );
      } catch {
        return [];
      }
    },
    async write(path, text) {
      try {
        const response = await fetcher(routePath(path), {
          method: 'PUT',
          body: text,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
        return response.ok;
      } catch {
        return false;
      }
    }
  };
}

/**
 * The places the folder is kept, in the order they are read, as `homeStores` has them: in the
 * desktop shell, `fs_homepath` alone; in dev, that folder, then OPFS; in a browser build, OPFS
 * alone.
 *
 * @param shell - In the desktop shell, which dev can be too.
 */
export function homeFolders(dev: boolean = import.meta.env.DEV, shell = false): HomeFolder[] {
  if (shell) return [routeHome()];
  return dev ? [routeHome(), opfsHome] : [opfsHome];
}

/**
 * Where the console's text is dumped: the folder over its route in the desktop shell and in dev,
 * where the player can open it, and otherwise a download, as a browser build's OPFS is out of
 * their reach.
 *
 * @param shell - In the desktop shell, which dev can be too.
 * @param download - Hands a file over by its name: {@link downloadFile}, or a stand-in for a test.
 */
export function dumpFolder(
  dev: boolean = import.meta.env.DEV,
  shell = false,
  download: (name: string, text: string) => void = downloadFile
): Pick<HomeFolder, 'write'> {
  if (shell || dev) return routeHome();
  return {
    async write(path, text) {
      download(path.slice(path.lastIndexOf('/') + 1), text);
      return true;
    }
  };
}

/**
 * Several folders read as one, as Q3 reads its search path: a file from the first that has it,
 * and a listing of every name any of them has. A file is written to each, as every store of a
 * kept file is (`keepFile`), and is written once every one of them has it.
 */
export function searchFolders(folders: readonly HomeFolder[]): HomeFolder {
  return {
    async read(path) {
      for (const folder of folders) {
        const text = await folder.read(path);
        if (text !== undefined) return text;
      }
      return undefined;
    },
    async list(dir, extension) {
      const names = new Set<string>();
      for (const folder of folders) {
        for (const name of await folder.list(dir, extension)) names.add(name);
      }
      return [...names].sort();
    },
    async write(path, text) {
      const written = await Promise.all(folders.map((folder) => folder.write(path, text)));
      return written.every(Boolean);
    }
  };
}
