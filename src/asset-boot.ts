import {
  loadAssets,
  manifestVersion,
  type AssetLibrary,
  type AssetSource,
  type PakRoutes
} from './formats/asset-library';
import { opfsCacheStore, type CacheStore } from './pak/asset-cache';
import { askForPaks, mountDevPaks, mountFolder, type PakBootStatus } from './pak/boot';
import {
  GameData,
  indexedDbKeptStore,
  webLock,
  type CacheLock,
  type GameDataContext,
  type GameDataSource,
  type KeptStore,
  type ShellInstall
} from './pak/game-data';
import { folderPicker, type FolderPicker, type InstallFolder } from './pak/install-folder';
import type { PakFileSystem } from './pak/vfs';
import { shellInstall } from './shell';

/**
 * The whole asset boot in one call: the install read in place, else what the browser kept (the
 * install folder the player picked, or the cache), else the drop screen.
 *
 * Composes the parts so none has to know about the others: `pak/boot.ts` knows about pk3s,
 * folders and the drop screen, `pak/game-data.ts` about what the browser keeps, and
 * `formats/asset-library.ts` about the manifest. This is the only place that wires them to the
 * DOM and the HUD.
 */

/** How many of a set of files are done, how many there are, and the one just done. */
export interface FileCount {
  done: number;
  total: number;
  path: string;
}

/**
 * Where the boot has got to, for the HUD and the load screen. While finding, each file read to
 * work out the manifest is named, uncounted. While extracting, each of the manifest's files is
 * counted as it is read, and `keeps` says whether the cache is written afterwards. While keeping,
 * each file is counted as it is copied into the cache.
 */
export type AssetBootStatus =
  | { phase: 'kept' }
  | { phase: 'paks'; pak: PakBootStatus }
  | { phase: 'finding'; path: string }
  | { phase: 'extracting'; read: FileCount; keeps: boolean }
  | { phase: 'keeping'; copied?: FileCount }
  | { phase: 'ready'; library: AssetLibrary; source: AssetSource }
  | { phase: 'error'; message: string };

/** What a boot brings: the game's assets, and where they came from. */
export interface BootedAssets {
  library: AssetLibrary;
  gameData: GameDataContext;
}

/** How a boot runs. */
export interface AssetBootOptions {
  /** The chosen player model: sarge by default, and until the settings choose. */
  model?: string;
  /** In the desktop shell, which reads its install and keeps nothing: no cache, no drop screen. */
  shell?: boolean;
  /**
   * Under the dev server, which reads its install in place as the shell does. A web build has no
   * install to ask for, so it asks nobody.
   */
  dev?: boolean;
  /** Where the browser keeps its cache: OPFS, or nowhere in a browser without it. */
  store?: CacheStore;
  /**
   * Where the browser keeps the install folder's handle and the cache's mark: IndexedDB, or
   * nowhere without it.
   */
  kept?: KeptStore;
  /** The browser's folder picker, or none in a browser without one. */
  picker?: FolderPicker;
  /** The lock over the cache, which the browser's other tabs share: its Web Lock. */
  lock?: CacheLock;
  /** The shell's install, which can be changed for the next launch. */
  install?: ShellInstall;
  /**
   * Told the player's paks as soon as they are mounted, before the assets are extracted from them:
   * the install's, the install folder's, the dropped ones, or the cache's one pak. The search path
   * puts them over the port's own map pk3s, and the map is read through it.
   */
  onMounted?: (paks: PakFileSystem) => void;
}

/**
 * Load the assets, showing the drop screen only if it is genuinely needed.
 *
 * With an install to read, the paks are read where they sit and nothing kept is consulted.
 * Otherwise a later visit reads the install folder the player picked, while its permission
 * holds, or boots from the cache, and the drop screen appears only when neither will do. There
 * the player picks the folder or drops paks, and the browser keeps one or the other, never both.
 * A cache marked to be cleared is never opened: it is cleared once no other tab reads from it,
 * which may be after this boot has finished, or at a later one.
 * The desktop shell has no drop screen and keeps nothing: it finds its install before the page
 * loads, so a boot there without one fails.
 *
 * @param host element the drop screen attaches to
 * @param onStatus progress callback
 */
export async function bootAssets(
  host: HTMLElement,
  onStatus: (status: AssetBootStatus) => void = () => {},
  options: AssetBootOptions = {}
): Promise<BootedAssets> {
  const {
    model,
    shell = false,
    dev = import.meta.env.DEV,
    store = shell ? undefined : opfsCacheStore(),
    kept = shell ? undefined : indexedDbKeptStore(),
    picker = shell ? undefined : folderPicker(),
    lock = webLock(),
    install = shell ? shellInstall() : undefined,
    onMounted
  } = options;
  const data = new GameData(kept, store, lock);
  const pak = (status: PakBootStatus) => onStatus({ phase: 'paks', pak: status });
  const version = manifestVersion();
  // A kept folder that couldn't be read at once, which the drop screen offers again.
  let offered: InstallFolder | undefined;
  // Whether the files read are kept as the cache afterwards: dropped paks, where there is one.
  let keeps = false;
  let source: GameDataSource | undefined;
  // A marked cache goes once nothing reads it; this boot goes on meanwhile.
  const clearMarked = () => void data.clearMarked().catch(() => {});
  const inPlace = async () => {
    if (!shell && !dev) return undefined;
    const fs = await mountDevPaks(pak);
    if (fs) source = { kind: shell ? 'shell' : 'dev', paks: fs.mounted.length };
    return fs;
  };

  const routes: PakRoutes = shell
    ? {
        dev: inPlace,
        kept: async () => undefined,
        ask: () => Promise.reject(new Error('no pk3 files in the Quake 3 install'))
      }
    : {
        dev: inPlace,
        kept: async () => {
          onStatus({ phase: 'kept' });
          const found = await data.kept(version);
          if (found.kind === 'cache') {
            const { fs, info } = found;
            source = { kind: 'cache', paks: info.paks.length, cache: info };
            return { fs, source: 'cache', playerModels: info.playerModels };
          }
          if (found.kind === 'none') clearMarked();
          if (found.kind === 'folder') {
            const fs = await readKeptFolder(found.folder, pak);
            if (fs) {
              clearMarked();
              source = { kind: 'folder', paks: fs.mounted.length, folder: found.folder };
              return { fs, source: 'folder' };
            }
            offered = found.folder;
          }
          return undefined;
        },
        ask: async () => {
          const given = await askForPaks(host, pak, { picker, kept: offered });
          if (!given.folder) {
            keeps = store !== undefined;
            source = { kind: 'paks', paks: given.fs.mounted.length };
            return { fs: given.fs, source: 'paks' };
          }
          await data.keepFolder(given.folder).catch(() => {});
          clearMarked();
          source = { kind: 'folder', paks: given.fs.mounted.length, folder: given.folder };
          return { fs: given.fs, source: 'folder' };
        },
        keep: async (fs, subset) => {
          const { waits, done } = await data.keepCache(version, fs, subset, (count, total, path) =>
            onStatus({ phase: 'keeping', copied: { done: count, total, path } })
          );
          const dropped = source;
          void done.then((info) => {
            if (dropped?.kind === 'paks') dropped.cache = info;
          });
          // Where another tab reads the cache, the write waits for it and the game goes on.
          if (!(await waits)) await done;
        }
      };
  try {
    const { library, source: from } = await loadAssets(routes, {
      model,
      onMounted,
      onLookup: (path) => onStatus({ phase: 'finding', path }),
      onRead: (done, total, path) => {
        onStatus({ phase: 'extracting', read: { done, total, path }, keeps });
        // Writing the cache starts with working out its subset, which names no file.
        if (keeps && done === total) onStatus({ phase: 'keeping' });
      }
    });
    onStatus({ phase: 'ready', library, source: from });
    // Each route names its source as it gives its paks.
    const found = source!;
    const record = found.kind !== 'dev' && found.kind !== 'shell' && kept ? data : undefined;
    return { library, gameData: { source: found, record, picker, install } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onStatus({ phase: 'error', message });
    throw err;
  }
}

/** Read a kept folder at once, where its permission still holds and it is still an install. */
async function readKeptFolder(
  folder: InstallFolder,
  onStatus: (status: PakBootStatus) => void
): Promise<PakFileSystem | undefined> {
  try {
    if ((await folder.queryPermission({ mode: 'read' })) !== 'granted') return undefined;
    return await mountFolder(folder, onStatus);
  } catch {
    // Gone, or no longer readable: the drop screen offers it again.
    return undefined;
  }
}

/** How the HUD names each {@link AssetSource}. */
const SOURCE_NAMES: Record<AssetSource, string> = {
  install: 'the install',
  folder: 'the install folder',
  cache: 'cache',
  paks: 'paks'
};

/** One-line HUD summary of an {@link AssetBootStatus}. */
export function describeAssetStatus(status: AssetBootStatus): string {
  return `assets: ${assetActivity(status)}`;
}

/** A file, and how far through its set it is. */
const counted = ({ done, total, path }: FileCount) => `${path} (${done}/${total})`;

/** What the boot is doing: the HUD's words after `assets:`, and the load screen's under its line. */
export function assetActivity(status: AssetBootStatus): string {
  switch (status.phase) {
    case 'kept':
      return 'checking what the browser kept';
    case 'paks':
      switch (status.pak.phase) {
        case 'discovering':
          return 'looking for a local install';
        case 'waiting-for-drop':
          return 'waiting for pak0.pk3';
        case 'loading': {
          const { label, index, total } = status.pak.progress;
          return `reading ${label} (${index}/${total})`;
        }
        case 'ready':
          return 'extracting';
        case 'error':
          return status.pak.message;
      }
      break;
    case 'finding':
      return `reading ${status.path}`;
    case 'extracting':
      return `reading ${counted(status.read)}`;
    case 'keeping':
      return status.copied ? `caching ${counted(status.copied)}` : 'writing the cache';
    case 'ready': {
      const megabytes = (status.library.byteLength / 1024 / 1024).toFixed(1);
      return `${status.library.files.size} files, ${megabytes} MB from ${SOURCE_NAMES[status.source]}`;
    }
    case 'error':
      return status.message;
  }
  return 'ready';
}

/**
 * Where the load screen's bar stands for the boot once the paks are mounted, and once the
 * manifest's files are read where the cache is written after.
 */
const MOUNTED = 0.2;
const KEEPING = 0.8;

/** How far through its set a file is. */
const through = ({ done, total }: FileCount) => (total > 0 ? done / total : 0);

/**
 * How far the boot has got, from 0 to 1, for the load screen's bar. Mounting the paks, each its
 * share, takes it to {@link MOUNTED}. The manifest's files, each as it is read, take it on to 1,
 * or to {@link KEEPING} where the cache is written after, whose files take it the rest of the way.
 * Working out the manifest before its files are read, and the cache's subset before it is
 * written, hold it where it is, though the first names each file it reads. A failed boot is done
 * too, since the game goes on without it.
 * Waiting for the player's paks is no progress, and nor is a pak that won't mount, which the drop
 * screen asks again for.
 */
export function assetProgress(status: AssetBootStatus): number {
  switch (status.phase) {
    case 'paks':
      if (status.pak.phase === 'loading') {
        const { index, total } = status.pak.progress;
        return total > 0 ? MOUNTED * (index / total) : 0;
      }
      return status.pak.phase === 'ready' ? MOUNTED : 0;
    case 'finding':
      return MOUNTED;
    case 'extracting':
      return MOUNTED + ((status.keeps ? KEEPING : 1) - MOUNTED) * through(status.read);
    case 'keeping':
      return KEEPING + (1 - KEEPING) * (status.copied ? through(status.copied) : 0);
    case 'ready':
    case 'error':
      return 1;
    default:
      return 0;
  }
}
