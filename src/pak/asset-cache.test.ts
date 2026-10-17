import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  clearAssetCache,
  hasAssetCache,
  opfsCacheStore,
  openAssetCache,
  writeAssetCache,
  type CacheStore
} from './asset-cache';
import { memorySource } from './byte-source';
import { memoryCacheStore } from './pak-test-fixtures';
import { PakFileSystem } from './vfs';
import { ZipArchive } from './zip';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

/**
 * Two paks, the later overriding the earlier, with deflated and stored entries and a map the
 * subset leaves out.
 */
async function paks(): Promise<PakFileSystem> {
  const pak = async (label: string, files: Zippable) =>
    ZipArchive.open(memorySource(label, zipSync(files)));
  const fs = new PakFileSystem();
  fs.mount(
    await pak('pak0.pk3', {
      'scripts/a.shader': encode('pak0 shader\n'.repeat(32)),
      'models/x.md3': [encode('IDP3 pak0'), { level: 0 }],
      'maps/big.bsp': [new Uint8Array(64 * 1024), { level: 0 }]
    })
  );
  fs.mount(
    await pak('pak1.pk3', {
      'scripts/b.shader': encode('pak1 shader'),
      'models/x.md3': encode('IDP3 pak1 '.repeat(16))
    })
  );
  return fs;
}

const SUBSET = {
  files: ['scripts/a.shader', 'scripts/b.shader', 'models/x.md3'],
  playerModels: [{ model: 'sarge', skin: 'default' }]
};

describe('the asset cache', () => {
  it('keeps the subset as a pak, each entry as its pak stores it, in the order the paks list them', async () => {
    const fs = await paks();
    const store = memoryCacheStore();
    expect(await writeAssetCache(store, 'v1', fs, SUBSET)).toBeDefined();
    const cache = (await openAssetCache(store, 'v1'))!;

    expect(cache.fs.mounted.map((archive) => archive.label)).toEqual(['assets.pk3']);
    expect(cache.fs.listInSearchOrder()).toEqual(
      fs.listInSearchOrder().filter((name) => SUBSET.files.includes(name))
    );
    expect(cache.fs.has('maps/big.bsp')).toBe(false);
    // pak1's model answers, as it did over the paks.
    expect(decode(await cache.fs.read('models/x.md3'))).toBe('IDP3 pak1 '.repeat(16));
    for (const name of SUBSET.files) {
      const was = fs.sourceOf(name)!.entry(name)!;
      const is = cache.fs.sourceOf(name)!.entry(name)!;
      expect([is.compressionMethod, is.compressedSize, is.crc32], name).toEqual([
        was.compressionMethod,
        was.compressedSize,
        was.crc32
      ]);
      expect(await cache.fs.read(name), name).toEqual(await fs.read(name));
    }
  });

  it('counts each file as the writer takes it, in the order the paks list them', async () => {
    const fs = await paks();
    const onCopy = vi.fn();
    await writeAssetCache(memoryCacheStore(), 'v1', fs, SUBSET, onCopy);
    const names = fs.listInSearchOrder().filter((name) => SUBSET.files.includes(name));
    expect(onCopy.mock.calls).toEqual(names.map((name, i) => [i + 1, names.length, name]));
  });

  it('keeps the version, the model list and the paks beside it', async () => {
    const fs = await paks();
    const store = memoryCacheStore();
    await writeAssetCache(store, 'v1', fs, SUBSET);
    expect((await openAssetCache(store, 'v1'))!.info).toEqual({
      version: 'v1',
      playerModels: SUBSET.playerModels,
      paks: fs.mounted.map((archive) => ({ name: archive.label, size: archive.byteLength })),
      size: store.files.get('assets.pk3')!.size
    });
  });

  it('is a miss for another manifest version', async () => {
    const store = memoryCacheStore();
    await writeAssetCache(store, 'v1', await paks(), SUBSET);
    expect(await openAssetCache(store, 'v2')).toBeUndefined();
  });

  it('is a miss with nothing kept, or nothing sensible', async () => {
    const store = memoryCacheStore();
    expect(await openAssetCache(store, 'v1')).toBeUndefined();
    store.files.set('assets.json', new Blob(['{ not json']));
    expect(await openAssetCache(store, 'v1')).toBeUndefined();
  });

  it('is a miss when the pak disagrees with what is kept beside it', async () => {
    const store = memoryCacheStore();
    await writeAssetCache(store, 'v1', await paks(), SUBSET);
    const pak = store.files.get('assets.pk3')!;
    store.files.set('assets.pk3', pak.slice(0, pak.size - 1));
    expect(await openAssetCache(store, 'v1')).toBeUndefined();
  });

  it('leaves no cache when a new one cannot be written', async () => {
    const fs = await paks();
    const store = memoryCacheStore();
    await writeAssetCache(store, 'v1', fs, SUBSET);
    const full: CacheStore = {
      ...store,
      async write(name, chunks) {
        if (name === 'assets.pk3') throw new Error('over quota');
        return store.write(name, chunks);
      }
    };
    expect(await writeAssetCache(full, 'v2', fs, SUBSET)).toBeUndefined();
    expect(await openAssetCache(store, 'v1')).toBeUndefined();
  });

  it('removes the files earlier builds kept the cache in', async () => {
    const store = memoryCacheStore();
    store.files.set('assets.bin', new Blob(['old']));
    store.files.set('weapon-assets.bin', new Blob(['older']));
    await writeAssetCache(store, 'v1', await paks(), SUBSET);
    expect([...store.files.keys()].sort()).toEqual(['assets.json', 'assets.pk3']);
  });

  it("finds any of the cache: a pak whose info never came, or an earlier build's", async () => {
    const store = memoryCacheStore();
    expect(await hasAssetCache(store)).toBe(false);
    store.files.set('assets.pk3', new Blob(['PK']));
    expect(await hasAssetCache(store)).toBe(true);
    store.files.clear();
    store.files.set('weapon-assets.bin', new Blob(['old']));
    expect(await hasAssetCache(store)).toBe(true);
  });

  it('clears all it keeps', async () => {
    const store = memoryCacheStore();
    store.files.set('assets.bin', new Blob(['old']));
    await writeAssetCache(store, 'v1', await paks(), SUBSET);
    await clearAssetCache(store);
    expect(store.files.size).toBe(0);
  });
});

describe('the cache in OPFS', () => {
  /** OPFS in memory, as much of it as the store uses: each folder's files by name. */
  function fakeOpfs() {
    const folders = new Map<string, Map<string, Blob>>();
    const folder = (path: string) => {
      const files = folders.get(path) ?? new Map<string, Blob>();
      folders.set(path, files);
      return {
        getDirectoryHandle: async (name: string) => folder(`${path}${name}/`),
        async getFileHandle(name: string, options?: { create?: boolean }) {
          if (!files.has(name) && !options?.create) throw new DOMException(name, 'NotFoundError');
          return {
            getFile: async () => files.get(name) ?? new Blob([]),
            async createWritable() {
              const parts: Blob[] = [];
              return {
                write: async (part: Blob) => void parts.push(part),
                close: async () => void files.set(name, new Blob(parts)),
                abort: async () => {}
              };
            }
          };
        },
        async removeEntry(name: string) {
          if (!files.delete(name)) throw new DOMException(name, 'NotFoundError');
        }
      };
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => folder('/') } });
    return folders;
  }

  it("is kept in the build's folder, below its base", async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    const folders = fakeOpfs();
    try {
      const store = opfsCacheStore()!;
      const text = async function* () {
        yield encode('{}');
      };
      await store.write('assets.json', text());
      expect(await (await store.read('assets.json'))?.text()).toBe('{}');
      expect([...(folders.get('/playcanvas-quake3/')?.keys() ?? [])]).toEqual(['assets.json']);
      expect(folders.get('/')?.size).toBe(0);
      await store.remove('assets.json');
      expect(folders.get('/playcanvas-quake3/')?.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
