import type { ByteProgress } from './byte-source';
import { ZipArchive, normalizePakPath } from './zip';

/**
 * The Quake 3 virtual file system: several pk3s mounted into one flat, case-insensitive
 * namespace.
 *
 * Q3 sorts pk3s by name and puts each on the head of its search path as it loads, so **later
 * paks win** (`files.c:2915`, `files.c:2965–2968`) — that is how point releases patch the
 * retail data without rewriting pak0. We reproduce it with mount order: the last archive
 * holding a path answers for it, so `mount()` callers pass pak0 first.
 *
 * Names are known the moment an archive is mounted; bytes are read on request, by range,
 * which is why the lookups are synchronous and the reads are not.
 *
 * Engine-free, like {@link ZipArchive}: a mounted VFS is just bytes and names.
 */
export class PakFileSystem {
  /** Mounted archives in ascending precedence — later entries override earlier ones. */
  private readonly archives: ZipArchive[] = [];
  /** Normalized path to the archive that currently answers for it. */
  private readonly index = new Map<string, ZipArchive>();

  /**
   * Mount an archive at the top of the override stack. Every path it holds now resolves to
   * it, shadowing archives mounted earlier.
   */
  mount(archive: ZipArchive): void {
    this.archives.push(archive);
    for (const name of archive.names()) this.index.set(name, archive);
  }

  /** Archives in mount order, lowest precedence first. */
  get mounted(): readonly ZipArchive[] {
    return this.archives;
  }

  /** Number of distinct paths across all mounted archives. */
  get size(): number {
    return this.index.size;
  }

  /** Whether any mounted archive holds this path. */
  has(path: string): boolean {
    return this.index.has(normalizePakPath(path));
  }

  /** The archive answering for a path, i.e. the highest-precedence one holding it. */
  sourceOf(path: string): ZipArchive | undefined {
    return this.index.get(normalizePakPath(path));
  }

  /**
   * Read a file, or `undefined` if no mounted archive holds it.
   *
   * @param progress - Told as its bytes come in.
   */
  async read(path: string, progress?: ByteProgress): Promise<Uint8Array | undefined> {
    const normalized = normalizePakPath(path);
    return this.index.get(normalized)?.read(normalized, progress);
  }

  /** Read a file, rejecting with a diagnostic naming the mounted archives if it is missing. */
  async readRequired(path: string): Promise<Uint8Array> {
    const data = await this.read(path);
    if (!data) {
      const mounts = this.archives.map((a) => a.label).join(', ') || '(none)';
      throw new Error(`pak: ${normalizePakPath(path)} not found in mounted archives: ${mounts}`);
    }
    return data;
  }

  /** Read a file and decode it as UTF-8 text (shader scripts, configs). */
  async readText(path: string): Promise<string | undefined> {
    const data = await this.read(path);
    return data ? new TextDecoder().decode(data) : undefined;
  }

  /**
   * Every path under a directory prefix, sorted. Used to enumerate `scripts/*.shader`,
   * which Q3 loads as one concatenated pool.
   *
   * @param prefix directory-ish path prefix, matched case-insensitively
   * @param extension optional extension filter, with or without the leading dot
   */
  list(prefix = '', extension?: string): string[] {
    const normalizedPrefix = normalizePakPath(prefix);
    const suffix = extension
      ? `.${extension.replace(/^\./, '').toLowerCase()}`
      : undefined;
    const out: string[] = [];
    for (const name of this.index.keys()) {
      if (!name.startsWith(normalizedPrefix)) continue;
      if (suffix && !name.endsWith(suffix)) continue;
      out.push(name);
    }
    return out.sort();
  }

  /**
   * Every path under a prefix, in the order ioq3's `FS_ListFilteredFiles` finds them
   * (`files.c:2189–2322`): down the search path from the highest-precedence pak, each pak in its
   * own central-directory order, and each name once, where the pak that answers for it holds
   * it. Nothing is sorted. ioq3 reads the shader scripts in this order.
   *
   * ioq3 also skips names more than two folders below the prefix (`files.c:2268`); this keeps
   * them, as {@link list} does.
   *
   * @param prefix directory-ish path prefix, matched case-insensitively
   * @param extension optional extension filter, with or without the leading dot
   */
  listInSearchOrder(prefix = '', extension?: string): string[] {
    const normalizedPrefix = normalizePakPath(prefix);
    const suffix = extension
      ? `.${extension.replace(/^\./, '').toLowerCase()}`
      : undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = this.archives.length - 1; i >= 0; i--) {
      for (const name of this.archives[i].names()) {
        if (!name.startsWith(normalizedPrefix) || (suffix && !name.endsWith(suffix))) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }

  /**
   * `FS_GetFileList` (`files.c:2362–2390`): the names with an extension in a folder, as
   * {@link listInSearchOrder} finds them, with the folder taken off the front. The caller's buffer
   * holds each name with its NUL and one NUL more, and the names stop at the first that would not
   * fit.
   *
   * @param path the folder, with or without its closing slash
   * @param extension the extension, with its dot
   * @param bufsize the caller's buffer, in bytes
   */
  getFileList(path: string, extension: string, bufsize: number): string[] {
    const folder = normalizePakPath(path).replace(/\/?$/, '/');
    const names: string[] = [];
    let total = 0;
    for (const name of this.listInSearchOrder(folder, extension)) {
      const length = name.length - folder.length + 1;
      if (total + length + 1 >= bufsize) break;
      names.push(name.slice(folder.length));
      total += length;
    }
    return names;
  }

  /**
   * Resolve a texture reference the way `R_FindShader` does: try the name as given, then
   * the known image extensions in order.
   *
   * MD3 surfaces and shader scripts reference textures without a reliable extension, and
   * vanilla paks ship a mixture of `.tga` and `.jpg` — several shaders name a `.tga` that
   * only exists as `.jpg`. Returns the resolved path, not the bytes.
   */
  resolveImage(reference: string): string | undefined {
    return resolveImageIn((path) => this.index.has(path), reference);
  }
}

/**
 * One search path from several file systems' archives, lowest first, so a later layer's pak wins
 * where two hold the same path. The port's own map pk3s go under the player's paks.
 *
 * @param layers ascending precedence; an absent layer adds nothing
 */
export function searchPath(layers: readonly (PakFileSystem | undefined)[]): PakFileSystem {
  const fs = new PakFileSystem();
  for (const layer of layers) {
    for (const archive of layer?.mounted ?? []) fs.mount(archive);
  }
  return fs;
}

/** Extensions `R_FindShader` falls back through, in its own order. */
const IMAGE_EXTENSIONS = ['.tga', '.jpg', '.jpeg', '.png', '.pcx'];

/**
 * The extension-fallback rule, over any path predicate.
 *
 * Shared so the pak file system and the cached asset library resolve identically — they
 * must, or a texture found while extracting would go missing once served from cache.
 *
 * @param has whether a normalized path exists in the collection
 * @param reference the texture reference, with or without an extension
 */
export function resolveImageIn(
  has: (path: string) => boolean,
  reference: string
): string | undefined {
  const normalized = normalizePakPath(reference);
  if (has(normalized)) return normalized;

  const stem = normalized.replace(/\.[^./]*$/, '');
  for (const extension of IMAGE_EXTENSIONS) {
    if (has(stem + extension)) return stem + extension;
  }
  return undefined;
}
