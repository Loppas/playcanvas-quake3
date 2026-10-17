/**
 * Where a build keeps things in the browser: the cache, the config and the home folder in OPFS,
 * the install folder's handle in IndexedDB, and the Web Lock over the cache.
 *
 * Each is the origin's, and an origin can serve more than one build: a `github.io` origin is all of
 * its owner's project sites. So a build keeps its own below the base it is served at (Vite's
 * `base`), and one at the origin's root keeps them at the root. Its next visit, its other tabs and
 * its next release find them there, and no build at another base reads them.
 */

/** Whether this browser gives us OPFS at all; without it, nothing is kept there. */
export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/** The base's folders, outermost first: none at the origin's root. */
function baseFolders(): string[] {
  return import.meta.env.BASE_URL.split('/').filter((name) => name !== '');
}

/** The build's folder in OPFS, made as it is first asked for. */
export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  let folder = await navigator.storage.getDirectory();
  for (const name of baseFolders()) {
    folder = await folder.getDirectoryHandle(name, { create: true });
  }
  return folder;
}

/** The build's name for an IndexedDB database or a Web Lock: the name, after its base. */
export function storageName(name: string): string {
  const folders = baseFolders();
  return folders.length === 0 ? name : `/${folders.join('/')}/${name}`;
}
