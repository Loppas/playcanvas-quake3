import { opfsAvailable, opfsRoot } from '../browser-storage';

/**
 * The home folder, `fs_homepath`, as `exec` reads it: the cfgs kept beside `q3config.cfg`, which
 * the game only reads.
 *
 * It is kept where the config is (`config-file.ts`): the folder itself in the desktop shell, OPFS
 * in a browser build, and both in dev, the folder first.
 */

/** The route to the folder (`scripts/home-cfg-route.mjs`). */
export const HOME_ROUTE = '/homepath/';

/** The home folder, read only. Neither call throws. */
export interface HomeFolder {
  /** A file's text by its path below the folder, or `undefined` if there is none or it can't be read. */
  read(path: string): Promise<string | undefined>;
  /**
   * The names of the `.cfg` files directly in a folder below it, `''` being the folder itself, or
   * none for a folder there is none of.
   */
  list(dir: string): Promise<string[]>;
}

/** The part of a `FileSystemDirectoryHandle` read here, whose listing TypeScript's DOM types don't carry. */
interface OpfsFolder {
  getDirectoryHandle(name: string): Promise<OpfsFolder>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
  values(): AsyncIterable<{ readonly kind: 'file' | 'directory'; readonly name: string }>;
}

const isCfgName = (name: string) => /\.cfg$/i.test(name);

/**
 * The folder below the build's folder in OPFS that `names` lead to, a name at a time. Rejects
 * where there is none.
 */
async function opfsFolder(names: readonly string[]): Promise<OpfsFolder> {
  let folder = (await opfsRoot()) as unknown as OpfsFolder;
  for (const name of names) folder = await folder.getDirectoryHandle(name);
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
  async list(dir) {
    if (!opfsAvailable()) return [];
    try {
      const folder = await opfsFolder(dir === '' ? [] : dir.split('/'));
      const names: string[] = [];
      for await (const entry of folder.values()) {
        if (entry.kind === 'file' && isCfgName(entry.name)) names.push(entry.name);
      }
      return names.sort();
    } catch {
      return [];
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
    async list(dir) {
      try {
        const url = dir === '' ? HOME_ROUTE : `${routePath(dir)}/`;
        const response = await fetcher(url, { cache: 'no-store' });
        if (response.status !== 200) return [];
        const names: unknown = await response.json();
        if (!Array.isArray(names)) return [];
        return names.filter((name): name is string => typeof name === 'string');
      } catch {
        return [];
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
 * Several folders read as one, as Q3 reads its search path: a file from the first that has it,
 * and a listing of every name any of them has.
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
    async list(dir) {
      const names = new Set<string>();
      for (const folder of folders) for (const name of await folder.list(dir)) names.add(name);
      return [...names].sort();
    }
  };
}
