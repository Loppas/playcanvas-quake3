import type { KeptStore } from './game-data';
import type { Folder, FolderFile, InstallFolder } from './install-folder';

/**
 * Stand-ins for Chromium's File System Access and Web Locks in tests, which jsdom and Node lack: a
 * picked folder, its permission, the store its handle is kept in, and the lock over the cache.
 */

/** A folder standing in for a `FileSystemDirectoryHandle`, holding files and folders. */
export function fakeFolder(name: string, entries: readonly (File | Folder)[] = []): Folder {
  return {
    kind: 'directory',
    name,
    async *values(): AsyncGenerator<Folder | FolderFile> {
      for (const entry of entries) {
        yield entry instanceof File
          ? { kind: 'file', name: entry.name, getFile: async () => entry }
          : entry;
      }
    }
  };
}

/** How a fake install folder answers for its permission: now, and once the player is asked. */
export interface FakePermission {
  now: PermissionState;
  asked?: PermissionState;
}

/** An install folder whose permission reads `now` until a request answers `asked`. */
export function fakeInstallFolder(
  name: string,
  entries: readonly (File | Folder)[] = [],
  permission: FakePermission = { now: 'granted' }
): InstallFolder & { requests: number } {
  let state = permission.now;
  const folder = {
    ...fakeFolder(name, entries),
    requests: 0,
    async queryPermission() {
      return state;
    },
    async requestPermission() {
      folder.requests++;
      state = permission.asked ?? state;
      return state;
    }
  };
  return folder;
}

/** The kept folder's store in memory, standing in for IndexedDB, with the cache's mark. */
export function memoryKeptStore(
  folder?: InstallFolder,
  clearing = false
): KeptStore & { folder: InstallFolder | undefined; marked: boolean } {
  const store = {
    folder,
    marked: clearing,
    async get() {
      return store.folder;
    },
    async set(next: InstallFolder) {
      store.folder = next;
    },
    async delete() {
      store.folder = undefined;
    },
    async clearing() {
      return store.marked;
    },
    async setClearing(on: boolean) {
      store.marked = on;
    }
  };
  return store;
}

/**
 * A `LockManager` for one origin, as the Web Locks spec grants its requests: in the order they
 * come, a shared one while no one holds the lock alone, and one alone while no one holds it at all.
 * `ifAvailable` is answered at once, with `null` where the lock can't be granted then.
 */
export function fakeLocks(): LockManager & { held(): LockMode[] } {
  const held: LockMode[] = [];
  const waiting: { mode: LockMode; grant: () => void }[] = [];
  const free = (mode: LockMode) => (mode === 'shared' ? !held.includes('exclusive') : held.length === 0);
  const next = () => {
    while (waiting.length > 0 && free(waiting[0].mode)) waiting.shift()!.grant();
  };
  const request = (
    name: string,
    given: LockOptions | LockGrantedCallback<unknown>,
    last?: LockGrantedCallback<unknown>
  ): Promise<unknown> => {
    const options = typeof given === 'function' ? {} : given;
    const callback = typeof given === 'function' ? given : last!;
    const mode = options.mode ?? 'exclusive';
    return new Promise((resolve, reject) => {
      const grant = () => {
        held.push(mode);
        const release = () => {
          held.splice(held.indexOf(mode), 1);
          next();
        };
        Promise.resolve()
          .then(() => callback({ name, mode }))
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (error: unknown) => {
              release();
              reject(error);
            }
          );
      };
      if (waiting.length === 0 && free(mode)) grant();
      else if (options.ifAvailable) Promise.resolve().then(() => callback(null)).then(resolve, reject);
      else waiting.push({ mode, grant });
    });
  };
  return {
    request: request as LockManager['request'],
    query: async () => ({}),
    held: () => [...held]
  };
}
