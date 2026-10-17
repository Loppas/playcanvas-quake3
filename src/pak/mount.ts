import { blobSource, httpSource, type ByteSource } from './byte-source';
import { mapConcurrent } from './concurrency';
import { PakFileSystem } from './vfs';
import { ZipArchive } from './zip';

/**
 * Turning pak *sources* into a mounted {@link PakFileSystem}.
 *
 * A source is a label, a size and ranged reads ({@link ByteSource}), so the ingestion routes —
 * the dev server's `fs_basepath`, files the user drops, and the port's own map pk3s — share one
 * mount path, and the core is testable without `fetch` or `File`.
 */

/** The dev server's pak route (`vite.config.ts`). */
const DEV_ROUTE = '/baseq3/';

/**
 * Where the port's own map pk3s are served: the folder a build is given as `VITE_MAPS_URL`, or
 * else `public/maps/` below the page's base, as the dev server, the web build and the shell serve
 * it. A folder on another origin answers CORS for the page's, and `Range` with a 206.
 */
function mapsFolder(): string {
  const folder = import.meta.env.VITE_MAPS_URL || `${import.meta.env.BASE_URL}maps/`;
  return folder.endsWith('/') ? folder : `${folder}/`;
}

/**
 * The map pk3s' listing, beside them, which the dev server writes as it is asked and the build
 * writes once (`vite.config.ts`). A file rather than the folder, since a static server lists no
 * folder.
 */
const MAPS_LISTING = 'paks.json';

/**
 * Archives opened at once. Each open is a round trip or two — the tail, then perhaps the
 * directory — so a few in flight hide the latency without queueing hundreds of requests.
 */
const MOUNT_CONCURRENCY = 8;

/** Progress while mounting, for a boot screen or HUD line; reported as each archive opens. */
export interface MountProgress {
  /** The archive that just opened. */
  label: string;
  /** How many archives have opened so far, this one included. */
  index: number;
  /** How many sources the mount was given. */
  total: number;
}

/** Callbacks and tuning for {@link mountArchives}. */
export interface MountOptions {
  onProgress?: (progress: MountProgress) => void;
  /** Called, in mount order, for each source that would not open. Defaults to a console warning. */
  onSkip?: (label: string, error: unknown) => void;
  /** Archives opened at once. */
  concurrency?: number;
}

/** A pak on the dev server, as its listing describes it. */
export interface DevPak {
  name: string;
  size: number;
}

/** A path character as `FS_PathCmp` compares it: a–z upper-cased, `\` and `:` read as `/`. */
function pathChar(code: number): number {
  if (code >= 0x61 && code <= 0x7a) return code - 0x20;
  if (code === 0x5c || code === 0x3a) return 0x2f;
  return code;
}

/**
 * ioq3's path comparison, `FS_PathCmp` (`files.c:2656–2685`): case-insensitive by upper-casing,
 * separator-insensitive, then by character code, a shorter prefix first. ioq3 compares C
 * `char`s, whose sign is the platform's, so only ASCII orders the same everywhere; names here
 * are compared by UTF-16 code unit.
 */
export function fsPathCmp(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const c1 = pathChar(a.charCodeAt(i));
    const c2 = pathChar(b.charCodeAt(i));
    if (c1 !== c2) return c1 < c2 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Whether a file name is a pk3. `Sys_ListFiles` matches the extension case-insensitively
 * (`sys_win32.c:623–625`, `sys_unix.c:859–861`), which is how an install's `PAK0.PK3` loads.
 */
export function isPk3(name: string): boolean {
  return /\.pk3$/i.test(name);
}

/** The pk3s among `items`, in {@link pakOrder}. */
function inPakOrder<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  return items.filter((item) => isPk3(nameOf(item))).sort((a, b) => fsPathCmp(nameOf(a), nameOf(b)));
}

/**
 * Put pak file names in ioq3's mount order: `.pk3` names only, sorted by {@link fsPathCmp}, as
 * `FS_AddGameDirectory` sorts them with `paksort` (`files.c:2865–2872`, `files.c:2915`).
 *
 * Each pak goes on the head of the search path as it loads (`files.c:2965–2968`), so the last
 * in this order wins: `pak8` over `pak0`, and `zz-mod.pk3` over both. The comparison is by
 * character, so `pak10` sorts between `pak1` and `pak2`, as it does in ioq3.
 */
export function pakOrder(names: readonly string[]): string[] {
  return inPakOrder(names, (name) => name);
}

function warnSkipped(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // The zip reader's errors already open with the pak's name.
  console.warn(`pak: skipped ${message.startsWith(label) ? message : `${label}: ${message}`}`);
}

/**
 * Open sources and mount them in order into one file system, later sources overriding
 * earlier ones.
 *
 * Archives open concurrently and mount in the order given once all have settled. A source that
 * will not open is skipped, as `FS_AddGameDirectory` skips a file that is not a zip
 * (`files.c:2953–2956`), rather than failing the whole mount.
 *
 * @param sources ascending precedence — {@link pakOrder}'s order
 * @returns the mounted file system; rejects only when no source opens
 */
export async function mountArchives(
  sources: readonly ByteSource[],
  options: MountOptions = {}
): Promise<PakFileSystem> {
  const { onProgress, onSkip = warnSkipped, concurrency = MOUNT_CONCURRENCY } = options;

  let opened = 0;
  const results = await mapConcurrent(sources, concurrency, async (source) => {
    try {
      const archive = await ZipArchive.open(source);
      onProgress?.({ label: source.label, index: ++opened, total: sources.length });
      return { archive };
    } catch (error) {
      return { error };
    }
  });

  const fs = new PakFileSystem();
  let firstError: unknown;
  results.forEach((result, i) => {
    if (result.archive) {
      fs.mount(result.archive);
    } else {
      onSkip(sources[i].label, result.error);
      firstError ??= result.error;
    }
  });

  if (fs.mounted.length === 0) {
    if (sources.length === 0) throw new Error('pak: no pk3 files to mount');
    const reason = firstError instanceof Error ? firstError.message : String(firstError);
    const which = sources.length === 1 ? 'the pk3 file' : `any of the ${sources.length} pk3 files`;
    throw new Error(`pak: could not open ${which} (${reason})`);
  }
  return fs;
}

function isDevPak(value: unknown): value is DevPak {
  const pak = value as Partial<DevPak> | null;
  return (
    typeof pak === 'object' &&
    pak !== null &&
    typeof pak.name === 'string' &&
    Number.isSafeInteger(pak.size) &&
    pak.size! >= 0
  );
}

/** The paks a listing names, in {@link pakOrder}, or none for a listing that can't be read. */
async function listedPaks(listing: string): Promise<DevPak[]> {
  try {
    const response = await fetch(listing);
    if (!response.ok) return [];
    const body = (await response.json()) as { paks?: unknown };
    if (!Array.isArray(body.paks)) return [];
    return inPakOrder(body.paks.filter(isDevPak), (pak) => pak.name);
  } catch {
    return [];
  }
}

/**
 * Ask the dev server which paks `fs_basepath` holds, in {@link pakOrder}.
 *
 * Returns an empty list on any failure — a production build, where the route does not exist,
 * or a dev server with no install — so the caller moves on to the cache and the drop screen.
 */
export function discoverDevPaks(route = DEV_ROUTE): Promise<DevPak[]> {
  return listedPaks(route);
}

/**
 * Which of the port's own map pk3s are served, in {@link pakOrder}. An empty list for a server
 * with none, or none listed.
 */
export function discoverMapPaks(listing = mapsFolder() + MAPS_LISTING): Promise<DevPak[]> {
  return listedPaks(listing);
}

/** Ranged sources for the port's own map pk3s, in the order given. */
export function mapPakSources(paks: readonly DevPak[]): ByteSource[] {
  return devPakSources(paks, mapsFolder());
}

/** Ranged sources for paks served by the dev server, in the order given. */
export function devPakSources(paks: readonly DevPak[], route = DEV_ROUTE): ByteSource[] {
  return paks.map((pak) => httpSource(route + encodeURIComponent(pak.name), pak.name, pak.size));
}

/**
 * Sources for user-dropped files: the pk3s among them, in {@link pakOrder}, so the
 * override rule holds whatever order they were dropped in. Each is read by slicing, never
 * whole.
 */
export function filePakSources(files: readonly File[]): ByteSource[] {
  return inPakOrder(files, (file) => file.name).map((file) => blobSource(file));
}
