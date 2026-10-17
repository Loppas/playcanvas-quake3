import { isPk3 } from './mount';

/**
 * Reading the Quake 3 install where it sits, from a folder the player picks: Chromium's File
 * System Access, where the browser has it.
 *
 * The player picks `fs_basepath`, the folder that holds `baseq3`, or `baseq3` itself, as the
 * desktop shell takes a pick. Its paks are read by range where they sit, and nothing is copied.
 * The folder's handle can be kept between visits. The browser asks again before a later visit
 * reads through it, unless the player let the site keep the permission.
 *
 * Chromium won't open some folders, however they are chosen: `Program Files`, `%APPDATA%`,
 * `%LOCALAPPDATA%`, `ProgramData`, `~/Library`, `/Applications` and `~/.config` among them. An
 * install in one of those takes the drop screen.
 */

/** The game folder ioq3 reads, `BASEGAME`. */
const BASEGAME = 'baseq3';

/** A file in a picked folder: the part of a `FileSystemFileHandle` read here. */
export interface FolderFile {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

/**
 * A picked folder: the part of a `FileSystemDirectoryHandle` read here, which a real handle fits
 * as it is and a test can stand in for.
 */
export interface Folder {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<Folder | FolderFile>;
}

/** Read access to a folder, as Chromium grants it. */
export interface FolderPermission {
  mode: 'read';
}

/**
 * The folder the player picked for the install, with the calls Chromium asks permission through,
 * which TypeScript's DOM types don't carry yet.
 */
export interface InstallFolder extends Folder {
  queryPermission(descriptor: FolderPermission): Promise<PermissionState>;
  requestPermission(descriptor: FolderPermission): Promise<PermissionState>;
  /** Whether another handle is to the same folder: a handle read back from IndexedDB is a copy. */
  isSameEntry?(other: InstallFolder): Promise<boolean>;
}

/** Whether two handles are to the same folder. */
export async function sameFolder(a: InstallFolder, b: InstallFolder): Promise<boolean> {
  if (a === b) return true;
  return (await a.isSameEntry?.(b).catch(() => false)) ?? false;
}

/** The browser's folder picker. It rejects with an `AbortError` when the player cancels. */
export type FolderPicker = () => Promise<InstallFolder>;

/**
 * The browser's folder picker, or `undefined` in a browser without one. It opens where it last
 * opened for the install, and asks only to read.
 */
export function folderPicker(scope: object = globalThis): FolderPicker | undefined {
  const show = (scope as { showDirectoryPicker?: (options: object) => Promise<InstallFolder> })
    .showDirectoryPicker;
  if (typeof show !== 'function') return undefined;
  return () => show.call(scope, { id: 'quake3-install', mode: 'read' });
}

/**
 * The pk3s of the install a picked folder names: those in its own `baseq3`, or its own when the
 * pick is `baseq3` itself, as the shell reads a pick (`electron/basepath.mjs`).
 *
 * @returns the paks, or none for a folder that isn't an install
 */
export async function installPaks(folder: Folder): Promise<File[]> {
  for await (const entry of folder.values()) {
    if (entry.kind !== 'directory' || entry.name.toLowerCase() !== BASEGAME) continue;
    const paks = await paksIn(entry);
    if (paks.length > 0) return paks;
  }
  return folder.name.toLowerCase() === BASEGAME ? paksIn(folder) : [];
}

/** The pk3s directly inside a folder, whatever case their names are in. */
async function paksIn(folder: Folder): Promise<File[]> {
  const paks: File[] = [];
  for await (const entry of folder.values()) {
    if (entry.kind === 'file' && isPk3(entry.name)) paks.push(await entry.getFile());
  }
  return paks;
}
