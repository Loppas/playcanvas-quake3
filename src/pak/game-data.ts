import { storageName } from '../browser-storage';
import {
  clearAssetCache,
  hasAssetCache,
  openAssetCache,
  writeAssetCache,
  type CacheInfo,
  type CacheStore,
  type CacheSubset,
  type CopyProgress
} from './asset-cache';
import type { FolderPicker, InstallFolder } from './install-folder';
import type { PakFileSystem } from './vfs';

/**
 * What the browser keeps of the game data between visits: the install folder the player picked,
 * or the cache made from paks the player dropped.
 *
 * One at a time: a folder picked has the cache cleared, and paks dropped forget the folder, so
 * nothing unused sits in the browser's storage. The boot reads what is kept and keeps what the
 * player gives it through these calls alone, and a page may drive the same calls while the game
 * runs.
 *
 * The folder is only a handle in IndexedDB, so it changes at once. The cache can't: a tab reading
 * from it fails its next read once its files are removed or rewritten. So a clear is marked in
 * IndexedDB and carried out by a later boot, which never opens a cache so marked, and every
 * change to the cache waits behind a Web Lock that each tab reading it holds shared.
 */

/** What the browser keeps in IndexedDB: the picked folder's handle, and the mark on the cache. */
export interface KeptStore {
  get(): Promise<InstallFolder | undefined>;
  set(folder: InstallFolder): Promise<void>;
  delete(): Promise<void>;
  /** Whether the cache is marked to be cleared. */
  clearing(): Promise<boolean>;
  setClearing(on: boolean): Promise<void>;
}

/** What the browser has kept: the cache comes mounted, while a folder waits for its permission. */
export type KeptGameData =
  | { kind: 'folder'; folder: InstallFolder }
  | { kind: 'cache'; fs: PakFileSystem; info: CacheInfo }
  | { kind: 'none' };

/**
 * Where a running game's data came from, and how many paks it read: the install on the dev server
 * or in the shell, the install folder the player picked, the browser's cache, or paks the player
 * dropped. Dropped paks name the cache once it has been written from them.
 */
export type GameDataSource =
  | { kind: 'dev'; paks: number }
  | { kind: 'shell'; paks: number }
  | { kind: 'folder'; paks: number; folder: InstallFolder }
  | { kind: 'cache'; paks: number; cache: CacheInfo }
  | { kind: 'paks'; paks: number; cache?: CacheInfo };

/** What the browser has recorded for the next start. */
export interface RecordedGameData {
  /** The folder kept, which the next start reads before any cache. */
  folder: InstallFolder | undefined;
  /** Whether the cache is marked to be cleared. */
  clearing: boolean;
}

/** What the browser keeps for the next start, read and changed while the game runs. */
export interface GameDataRecord {
  recorded(): Promise<RecordedGameData>;
  keepFolder(folder: InstallFolder): Promise<void>;
  forgetFolder(): Promise<void>;
  /** Mark the cache to be cleared by the next start, or take the mark off. */
  markClear(on: boolean): Promise<void>;
}

/** The shell's installs: the one this launch reads, and the one kept for the next. */
export interface ShellInstalls {
  running: string;
  /** `undefined` where none is kept that still holds a pak, so the next launch asks. */
  next: string | undefined;
}

/** The shell's install, which is read at launch and changed for the next. */
export interface ShellInstall {
  read(): Promise<ShellInstalls>;
  /**
   * The native folder dialog, whose pick is kept for the next launch.
   *
   * @returns the installs after it, and the folder picked where it held no paks
   */
  pick(): Promise<ShellInstalls & { refused?: string }>;
}

/** Where the running game's data came from, and what can change the next start's. */
export interface GameDataContext {
  source: GameDataSource;
  /** What the browser keeps, where it can keep one; neither the shell nor the dev server has it. */
  record?: GameDataRecord;
  /** The browser's folder picker, where it has one. */
  picker?: FolderPicker;
  /** The shell's install, in the shell alone. */
  install?: ShellInstall;
}

/**
 * The lock over the cache, which every tab of the build shares: held shared by each that reads
 * from the cache, and alone by a change to it.
 */
export interface CacheLock {
  /**
   * Hold the lock shared.
   *
   * @returns once it is held, the call that lets it go
   */
  share(): Promise<() => void>;
  /**
   * Run `act` holding the lock alone, once no other holds it.
   *
   * @returns whether it has to wait for another holder, known at once, and what `act` gives,
   *   once it has run
   */
  alone<T>(act: () => Promise<T>): { waits: Promise<boolean>; done: Promise<T> };
}

/** The Web Lock's name. */
const LOCK_NAME = 'game-data';

/** No lock, where the browser has no Web Locks: everything runs at once. */
const NO_LOCK: CacheLock = {
  share: async () => () => {},
  alone: (act) => ({ waits: Promise.resolve(false), done: act() })
};

/** The cache's lock over the browser's Web Locks, or none where it has none. */
export function webLock(locks: LockManager | undefined = globalThis.navigator?.locks): CacheLock {
  if (!locks) return NO_LOCK;
  const name = storageName(LOCK_NAME);
  return {
    share: () =>
      new Promise((held) => {
        // The lock is held until the callback's promise settles.
        void locks.request(name, { mode: 'shared' }, () =>
          new Promise<void>((release) => held(release))
        );
      }),
    alone<T>(act: () => Promise<T>) {
      let waits: (waiting: boolean) => void = () => {};
      const waiting = new Promise<boolean>((resolve) => (waits = resolve));
      const done = locks
        .request(name, { ifAvailable: true }, async (lock) => {
          waits(lock === null);
          return lock ? { value: await act() } : undefined;
        })
        .then((now) => (now ? now.value : locks.request(name, act)));
      return { waits: waiting, done: done as Promise<T> };
    }
  };
}

/** The browser's game data, over wherever it keeps a folder and a cache. */
export class GameData implements GameDataRecord {
  private readonly store: KeptStore | undefined;
  private readonly cache: CacheStore | undefined;
  private readonly lock: CacheLock;

  /**
   * @param store where a picked folder and the mark on the cache are kept, or `undefined` where
   *   they can't be
   * @param cache where the cache is kept, or `undefined` where none can be
   * @param lock the lock over the cache, which other tabs share
   */
  constructor(store: KeptStore | undefined, cache: CacheStore | undefined, lock: CacheLock = NO_LOCK) {
    this.store = store;
    this.cache = cache;
    this.lock = lock;
  }

  /**
   * What is kept, a folder before a cache, and a cache marked to be cleared as nothing. Storage the
   * browser won't open reads as nothing kept. A cache is opened with the lock held shared, which
   * this page holds for as long as it reads from the cache: for its life.
   *
   * @param version the manifest version a cache must have been made for
   */
  async kept(version: string): Promise<KeptGameData> {
    const folder = await this.store?.get().catch(() => undefined);
    if (folder) return { kind: 'folder', folder };
    if (!this.cache || (await this.marked())) return { kind: 'none' };
    const release = await this.lock.share();
    const cache = await openAssetCache(this.cache, version);
    if (cache) return { kind: 'cache', ...cache };
    release();
    return { kind: 'none' };
  }

  /** What is recorded for the next start. */
  async recorded(): Promise<RecordedGameData> {
    const folder = await this.store?.get().catch(() => undefined);
    return { folder, clearing: await this.marked() };
  }

  /** Keep a picked folder for later visits, and mark a cache kept to be cleared. */
  async keepFolder(folder: InstallFolder): Promise<void> {
    await this.store?.set(folder);
    if (this.cache && (await hasAssetCache(this.cache))) await this.markClear(true);
  }

  /** Forget the kept folder. */
  async forgetFolder(): Promise<void> {
    await this.store?.delete();
  }

  /** Mark the cache to be cleared by the next start, or take the mark off. */
  async markClear(on: boolean): Promise<void> {
    await this.store?.setClearing(on);
  }

  /**
   * Clear a cache marked to be cleared, once no other tab reads from it, unless the mark has come
   * off by then. It may wait as long as those tabs stay open.
   */
  async clearMarked(): Promise<void> {
    const cache = this.cache;
    if (!cache || !(await this.marked())) return;
    await this.lock.alone(async () => {
      if (!(await this.marked())) return;
      await clearAssetCache(cache);
      await this.markClear(false);
    }).done;
  }

  /**
   * Keep the subset of dropped paks as the cache, and forget the folder. The new cache replaces
   * any other, so the mark comes off once it is written.
   *
   * @param onCopy called as each file is copied in
   * @returns whether the write waits for another tab to let go of the cache, known at once, and
   *   what is kept beside the cache once it is written, or `undefined` where it wasn't
   */
  async keepCache(
    version: string,
    fs: PakFileSystem,
    subset: CacheSubset,
    onCopy?: CopyProgress
  ): Promise<{ waits: Promise<boolean>; done: Promise<CacheInfo | undefined> }> {
    await this.forgetFolder().catch(() => {});
    const cache = this.cache;
    if (!cache) return { waits: Promise.resolve(false), done: Promise.resolve(undefined) };
    return this.lock.alone(async () => {
      const info = await writeAssetCache(cache, version, fs, subset, onCopy);
      if (info) await this.markClear(false).catch(() => {});
      return info;
    });
  }

  /** Whether the cache is marked to be cleared; storage the browser won't open reads as not. */
  private async marked(): Promise<boolean> {
    return (await this.store?.clearing().catch(() => false)) ?? false;
  }
}

const DB_NAME = 'playcanvas-quake3';
const DB_STORE = 'game-data';
const FOLDER_KEY = 'install-folder';
const CLEAR_KEY = 'clear-cache';

/**
 * The folder's handle and the cache's mark in IndexedDB, the one store a
 * `FileSystemDirectoryHandle` can be kept in, or `undefined` in a browser without IndexedDB.
 */
export function indexedDbKeptStore(): KeptStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(storageName(DB_NAME), 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, mode);
        const request = act(transaction.objectStore(DB_STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => run('readonly', (store) => store.get(FOLDER_KEY)),
    set: async (folder) => {
      await run('readwrite', (store) => store.put(folder, FOLDER_KEY));
    },
    delete: async () => {
      await run('readwrite', (store) => store.delete(FOLDER_KEY));
    },
    clearing: async () => (await run('readonly', (store) => store.get(CLEAR_KEY))) === true,
    setClearing: async (on) => {
      if (on) await run('readwrite', (store) => store.put(true, CLEAR_KEY));
      else await run('readwrite', (store) => store.delete(CLEAR_KEY));
    }
  };
}
