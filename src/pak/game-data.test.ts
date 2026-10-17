import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memorySource } from './byte-source';
import { fakeInstallFolder, fakeLocks, memoryKeptStore } from './folder-test-fixtures';
import { GameData, indexedDbKeptStore, webLock, type KeptStore } from './game-data';
import { memoryCacheStore } from './pak-test-fixtures';
import { PakFileSystem } from './vfs';
import { ZipArchive } from './zip';

const VERSION = 'v1';
const SUBSET = { files: ['a.txt'], playerModels: [] };

async function paks(): Promise<PakFileSystem> {
  const fs = new PakFileSystem();
  const pak0 = zipSync({ 'a.txt': new TextEncoder().encode('a') });
  fs.mount(await ZipArchive.open(memorySource('pak0.pk3', pak0)));
  return fs;
}

/** Keep the paks as the cache, waiting for the write. */
async function keep(data: GameData) {
  return (await data.keepCache(VERSION, await paks(), SUBSET)).done;
}

describe('GameData', () => {
  it('keeps nothing at first', async () => {
    const data = new GameData(memoryKeptStore(), memoryCacheStore());
    expect(await data.kept(VERSION)).toEqual({ kind: 'none' });
    expect(await data.recorded()).toEqual({ folder: undefined, clearing: false });
  });

  it('keeps dropped paks as the cache, and forgets the folder', async () => {
    const store = memoryKeptStore(fakeInstallFolder('ioquake'));
    const data = new GameData(store, memoryCacheStore());
    expect(await keep(data)).toMatchObject({ version: VERSION, paks: [{ name: 'pak0.pk3' }] });
    expect(store.folder).toBeUndefined();
    const kept = await data.kept(VERSION);
    expect(kept.kind === 'cache' && kept.fs.has('a.txt')).toBe(true);
  });

  it('keeps a picked folder, and marks the cache to be cleared rather than clearing it', async () => {
    const cache = memoryCacheStore();
    const store = memoryKeptStore();
    const data = new GameData(store, cache);
    await keep(data);
    const folder = fakeInstallFolder('ioquake');
    await data.keepFolder(folder);
    expect(await data.kept(VERSION)).toEqual({ kind: 'folder', folder });
    expect(await data.recorded()).toEqual({ folder, clearing: true });
    expect(cache.files.size).toBe(2);
  });

  it('marks nothing for a folder picked where there is no cache', async () => {
    const store = memoryKeptStore();
    await new GameData(store, memoryCacheStore()).keepFolder(fakeInstallFolder('ioquake'));
    expect(store.marked).toBe(false);
  });

  it('reads a cache marked to be cleared as nothing kept, and a mark taken off as the cache', async () => {
    const store = memoryKeptStore();
    const data = new GameData(store, memoryCacheStore());
    await keep(data);
    await data.markClear(true);
    expect(await data.kept(VERSION)).toEqual({ kind: 'none' });
    await data.markClear(false);
    expect((await data.kept(VERSION)).kind).toBe('cache');
  });

  it('clears a marked cache, and takes the mark off', async () => {
    const cache = memoryCacheStore();
    const store = memoryKeptStore();
    const data = new GameData(store, cache);
    await keep(data);
    await data.markClear(true);
    await data.clearMarked();
    expect(cache.files.size).toBe(0);
    expect(store.marked).toBe(false);
  });

  it('clears nothing that is not marked', async () => {
    const cache = memoryCacheStore();
    const data = new GameData(memoryKeptStore(), cache);
    await keep(data);
    await data.clearMarked();
    expect(cache.files.size).toBe(2);
  });

  it('takes the mark off with a new cache, which replaces the old', async () => {
    const store = memoryKeptStore(undefined, true);
    const data = new GameData(store, memoryCacheStore());
    await keep(data);
    expect(store.marked).toBe(false);
  });

  it('forgets a folder, leaving nothing kept', async () => {
    const data = new GameData(memoryKeptStore(fakeInstallFolder('ioquake')), memoryCacheStore());
    await data.forgetFolder();
    expect(await data.kept(VERSION)).toEqual({ kind: 'none' });
  });

  it('reads storage the browser refuses as nothing kept, and still keeps a drop', async () => {
    const refuse = () => Promise.reject(new Error('refused'));
    const refused: KeptStore = {
      get: refuse,
      set: refuse,
      delete: refuse,
      clearing: refuse,
      setClearing: refuse
    };
    const data = new GameData(refused, memoryCacheStore());
    expect(await data.kept(VERSION)).toEqual({ kind: 'none' });
    expect(await keep(data)).toBeDefined();
  });

  it('keeps nothing where the browser has nowhere to keep it', async () => {
    const data = new GameData(undefined, undefined);
    expect(await keep(data)).toBeUndefined();
    await data.keepFolder(fakeInstallFolder('ioquake'));
    expect(await data.kept(VERSION)).toEqual({ kind: 'none' });
  });
});

describe('GameData behind the lock', () => {
  /** A cache marked to be cleared, with a lock another tab shares. */
  async function marked() {
    const locks = fakeLocks();
    const lock = webLock(locks);
    const cache = memoryCacheStore();
    const store = memoryKeptStore();
    const data = new GameData(store, cache, lock);
    await keep(data);
    await data.markClear(true);
    return { locks, lock, cache, store, data };
  }

  it('holds the lock shared for a cache it opens', async () => {
    const { locks, data } = await marked();
    await data.markClear(false);
    expect((await data.kept(VERSION)).kind).toBe('cache');
    expect(locks.held()).toEqual(['shared']);
  });

  it('waits to clear while another tab reads the cache, and clears once it lets go', async () => {
    const { lock, cache, data } = await marked();
    const release = await lock.share();
    let cleared = false;
    const clearing = data.clearMarked().then(() => (cleared = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleared).toBe(false);
    expect(cache.files.size).toBe(2);

    release();
    await clearing;
    expect(cache.files.size).toBe(0);
  });

  it('clears nothing once the mark has come off while it waited', async () => {
    const { lock, cache, data } = await marked();
    const release = await lock.share();
    const clearing = data.clearMarked();
    await data.markClear(false);
    release();
    await clearing;
    expect(cache.files.size).toBe(2);
  });

  it('writes a drop at once where no tab reads the cache, and after the one that does', async () => {
    const { lock, cache, data } = await marked();
    const now = await data.keepCache(VERSION, await paks(), SUBSET);
    expect(await now.waits).toBe(false);
    await now.done;

    const release = await lock.share();
    cache.files.clear();
    const later = await data.keepCache(VERSION, await paks(), SUBSET);
    expect(await later.waits).toBe(true);
    expect(cache.files.size).toBe(0);
    release();
    expect(await later.done).toBeDefined();
    expect(cache.files.size).toBe(2);
  });

  it('goes without a lock where the browser has no Web Locks', async () => {
    const lock = webLock(undefined);
    await expect(lock.alone(async () => 1).waits).resolves.toBe(false);
    const release = await lock.share();
    release();
  });
});

describe("the build's names", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lock the cache under the build's base, so another build never waits on it", async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    const names: string[] = [];
    const locks = fakeLocks();
    const request = locks.request.bind(locks) as (...args: unknown[]) => Promise<unknown>;
    locks.request = ((name: string, ...rest: unknown[]) => {
      names.push(name);
      return request(name, ...rest);
    }) as LockManager['request'];
    const lock = webLock(locks);
    (await lock.share())();
    await lock.alone(async () => 1).done;
    expect(new Set(names)).toEqual(new Set(['/playcanvas-quake3/game-data']));
  });

  it("keep the folder and the mark in the build's own database", async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    const open = vi.fn(() => {
      const request = { error: new DOMException('refused', 'UnknownError') } as {
        error: DOMException;
        onerror?: () => void;
      };
      queueMicrotask(() => request.onerror?.());
      return request;
    });
    vi.stubGlobal('indexedDB', { open });
    await expect(indexedDbKeptStore()!.get()).rejects.toThrow('refused');
    expect(open).toHaveBeenCalledWith('/playcanvas-quake3/playcanvas-quake3', 1);
  });
});
