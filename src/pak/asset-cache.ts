import { opfsAvailable, opfsRoot } from '../browser-storage';
import { blobSource } from './byte-source';
import { rawEntry, writePk3, type RawZipEntry } from './pk3-writer';
import { PakFileSystem } from './vfs';
import { ZipArchive, normalizePakPath } from './zip';

/**
 * The browser's cache of the game data: a pak of its own, in the origin-private file system.
 *
 * The paks a player drops are read for that visit, and the manifest's subset of them is kept, so
 * a later visit starts without them. The cache is written as a pk3, each entry copied as its pak
 * stores it, and it is read by range like any pak: a later visit reads what the game needs, and a
 * model chosen afterwards is read then, as from the install. From the retail paks it holds about
 * 50 MB.
 *
 * Its entries come in the order the paks list them. It holds every shader script, so the scripts
 * come out of it in the order ioq3 reads them from the paks. A file beside it keeps the manifest
 * version it was made for, and what only the paks know: the model page's list, whose order
 * follows the first file of each model's folder, which the subset may leave out. It also names
 * the paks the cache was made from.
 */

/** The cache's pak. */
const CACHE_PAK = 'assets.pk3';
/** What is kept beside it. */
const CACHE_INFO = 'assets.json';
/** Where earlier builds kept the cache, removed once a new one is written. */
const LEGACY_FILES = ['assets.bin', 'weapon-assets.bin'];

/** Entries read at once while copying: enough to overlap the reads, few enough to keep memory flat. */
const COPY_BATCH = 32;

/** Bytes gathered per OPFS write: each write is a trip to the browser's file system. */
const WRITE_BLOCK = 1 << 20;

/** A model and one of its skins, as the model page lists them. */
interface ModelSkin {
  model: string;
  skin: string;
}

/** Where the cache's files live: the origin-private file system, or memory in tests. */
export interface CacheStore {
  /** A file's contents, or `undefined` when it isn't there. */
  read(name: string): Promise<Blob | undefined>;
  /** Replace a file with `chunks`, in order. The old file stands until the new one is whole. */
  write(name: string, chunks: AsyncIterable<Uint8Array<ArrayBuffer>>): Promise<void>;
  /** Remove a file. One that isn't there is no error. */
  remove(name: string): Promise<void>;
}

/**
 * Called as each file is copied into the cache: how many are in, how many there are, and the one
 * just copied.
 */
export type CopyProgress = (done: number, total: number, path: string) => void;

/** The subset a cache keeps: its files, and the model page's list as the paks made it. */
export interface CacheSubset {
  files: readonly string[];
  playerModels: readonly ModelSkin[];
}

/** What is kept beside the cache's pak. */
export interface CacheInfo {
  /** The manifest version the cache was made for. */
  version: string;
  /** The model page's list, as the paks made it. */
  playerModels: ModelSkin[];
  /** The paks the cache was made from, by name and size. */
  paks: { name: string; size: number }[];
  /** The pak's length, checked against the file before it is mounted. */
  size: number;
}

/**
 * The cache's store in the build's folder of the origin-private file system, or `undefined` in a
 * browser without one, where every visit asks for the paks.
 */
export function opfsCacheStore(): CacheStore | undefined {
  if (!opfsAvailable()) return undefined;
  return {
    async read(name) {
      try {
        return await (await (await opfsRoot()).getFileHandle(name)).getFile();
      } catch {
        return undefined;
      }
    },
    async write(name, chunks) {
      // A writable stream writes to a copy, which replaces the file only when it closes.
      const file = await (await opfsRoot()).getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      try {
        let block: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        for await (const chunk of chunks) {
          block.push(chunk);
          size += chunk.byteLength;
          if (size >= WRITE_BLOCK) {
            await writable.write(new Blob(block));
            block = [];
            size = 0;
          }
        }
        await writable.write(new Blob(block));
        await writable.close();
      } catch (err) {
        await writable.abort().catch(() => {});
        throw err;
      }
    },
    async remove(name) {
      try {
        await (await opfsRoot()).removeEntry(name);
      } catch {
        // Not there, so nothing to remove.
      }
    }
  };
}

/**
 * Keep a subset of mounted paks as the cache. Failure isn't fatal: a browser in private mode or
 * over its quota asks for the paks again at the next visit.
 *
 * The file beside the pak is removed first and written last, so a write cut short leaves no
 * cache rather than a pak that disagrees with it.
 *
 * @param version the manifest version the subset was resolved for
 * @param fs the paks the subset comes from
 * @param onCopy called as each file is copied in
 * @returns what is kept beside the cache, or `undefined` where it wasn't written
 */
export async function writeAssetCache(
  store: CacheStore,
  version: string,
  fs: PakFileSystem,
  subset: CacheSubset,
  onCopy?: CopyProgress
): Promise<CacheInfo | undefined> {
  try {
    await store.remove(CACHE_INFO);
    let size = 0;
    const counted = async function* () {
      for await (const chunk of writePk3(rawEntries(fs, subset.files, onCopy))) {
        size += chunk.byteLength;
        yield chunk;
      }
    };
    await store.write(CACHE_PAK, counted());

    const info: CacheInfo = {
      version,
      playerModels: subset.playerModels.map(({ model, skin }) => ({ model, skin })),
      paks: fs.mounted.map((archive) => ({ name: archive.label, size: archive.byteLength })),
      size
    };
    await store.write(CACHE_INFO, once(new TextEncoder().encode(JSON.stringify(info))));
    for (const name of LEGACY_FILES) await store.remove(name);
    return info;
  } catch {
    return undefined;
  }
}

/**
 * Mount the cache. There is none to mount when nothing was kept, when it was made for another
 * manifest version, or when it doesn't hold together: each sends the boot to the drop screen.
 */
export async function openAssetCache(
  store: CacheStore,
  version: string
): Promise<{ fs: PakFileSystem; info: CacheInfo } | undefined> {
  try {
    const kept = await store.read(CACHE_INFO);
    const info =
      kept && (JSON.parse(new TextDecoder().decode(await kept.arrayBuffer())) as Partial<CacheInfo>);
    if (
      !info ||
      info.version !== version ||
      !Array.isArray(info.playerModels) ||
      !Array.isArray(info.paks)
    ) {
      return undefined;
    }
    const pak = await store.read(CACHE_PAK);
    if (!pak || pak.size !== info.size) return undefined;

    const fs = new PakFileSystem();
    fs.mount(await ZipArchive.open(blobSource(pak, CACHE_PAK)));
    return { fs, info: info as CacheInfo };
  } catch {
    return undefined;
  }
}

/** The cache's files, and those an earlier build kept it in. */
const CACHE_FILES = [CACHE_INFO, CACHE_PAK, ...LEGACY_FILES];

/** Remove the cache, and any an earlier build left. */
export async function clearAssetCache(store: CacheStore): Promise<void> {
  for (const name of CACHE_FILES) await store.remove(name);
}

/** Whether any of the cache is kept, whole or not, and whatever version it was made for. */
export async function hasAssetCache(store: CacheStore): Promise<boolean> {
  for (const name of CACHE_FILES) if ((await store.read(name)) !== undefined) return true;
  return false;
}

/**
 * The subset's entries as their paks store them, each from the pak that answers for it, in the
 * order `FS_ListFilteredFiles` lists the paks (`files.c:2189–2322`). A batch is read at once and
 * given in order, each counted once the writer has taken it.
 */
async function* rawEntries(
  fs: PakFileSystem,
  files: readonly string[],
  onCopy: CopyProgress = () => {}
): AsyncGenerator<RawZipEntry> {
  const wanted = new Set(files.map(normalizePakPath));
  const names = fs.listInSearchOrder().filter((name) => wanted.has(name));
  for (let i = 0; i < names.length; i += COPY_BATCH) {
    const batch = names.slice(i, i + COPY_BATCH);
    const entries = await Promise.all(
      batch.map((name) => {
        const archive = fs.sourceOf(name)!;
        return rawEntry(archive, archive.entry(name)!);
      })
    );
    for (const [j, entry] of entries.entries()) {
      yield entry;
      onCopy(i + j + 1, names.length, batch[j]);
    }
  }
}

async function* once(bytes: Uint8Array<ArrayBuffer>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  yield bytes;
}
