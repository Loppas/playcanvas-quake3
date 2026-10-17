import { infoValueForKey } from '../net/info';
import type { CacheSubset } from '../pak/asset-cache';
import { mapConcurrent } from '../pak/concurrency';
import { resolveImageIn } from '../pak/vfs';
import type { PakFileSystem } from '../pak/vfs';
import { normalizePakPath } from '../pak/zip';
import { BOT_LIST, BOTS_FILE, botModels, loadBots } from '../sim/bots';
import { ARENAS_FILE, MENU_ARENA_LIST, loadArenas, readInfoFiles } from './arena';
import { shownMapName } from './arena-list';
import { parseMd3, type Md3Model } from './md3';
import {
  diffuseReference,
  findShader,
  parseShaderScripts,
  type ShaderScript
} from './shader-script';
import {
  ANNOUNCER_SOUNDS,
  CUSTOM_SOUNDS,
  DEFAULT_MODEL,
  GIB_ASSETS,
  HUD_ASSETS,
  MENU_FILES,
  MENU_SOUNDS,
  PLAYER_PARTS,
  PLAYER_SOUNDS,
  SHARED_ASSETS,
  WEAPON_ASSETS,
  listPlayerModels,
  playerModelDir,
  playerModelFolders,
  resolveManifest,
  resolvePlayerModels,
  type ManifestFiles,
  type ManifestResolution,
  type PlayerModelSkin
} from './asset-manifest';

/**
 * Turning mounted paks into the game's assets.
 *
 * Every boot route ends at the same {@link extractAssets}, over the install read in place, the
 * paks the player dropped, or the browser's cache, which is one more pak holding the manifest's
 * subset of them. The library itself never knows which it came from.
 */

/**
 * Entries read at once while extracting. Over the dev server each read is a round trip, so a
 * few in flight hide the latency; many more would only queue behind the browser's connections.
 */
const EXTRACT_CONCURRENCY = 8;

/**
 * Cache key derived from the manifest's own content.
 *
 * Deriving rather than hand-versioning means editing the manifest invalidates every user's
 * cache automatically — the failure mode of a hand-maintained number is a stale subset that
 * silently lacks whatever was just added. The prefix counts the cache's own format instead.
 */
export function manifestVersion(): string {
  const source = JSON.stringify({
    weapons: WEAPON_ASSETS,
    shared: SHARED_ASSETS,
    hud: HUD_ASSETS,
    gibs: GIB_ASSETS,
    player: PLAYER_SOUNDS,
    menu: MENU_SOUNDS,
    announcer: ANNOUNCER_SOUNDS,
    models: { parts: PLAYER_PARTS, sounds: CUSTOM_SOUNDS, fallback: DEFAULT_MODEL },
    skirmish: MENU_FILES
  });
  // FNV-1a, 32-bit. Not cryptographic; it only has to change when the manifest does.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v4-${hash.toString(16)}`;
}

/**
 * The shader scripts in the order ioq3 parses them. `ScanAndLoadShaderFiles` lists them
 * in search order ({@link PakFileSystem.listInSearchOrder}) and joins them into one text in
 * reverse (`tr_shader.c:3034–3041`), and a name's first definition in that text wins
 * (`tr_shader.c:2409–2415`). So of two different files, the lower-priority pak's definition
 * wins, and within one pak the later entry's.
 */
export function shaderTextOrder(fs: Pick<PakFileSystem, 'listInSearchOrder'>): string[] {
  return fs.listInSearchOrder('scripts/', 'shader').reverse();
}

/**
 * Called as each of a set of files comes in: how many are in, how many there are, and the one
 * just read.
 */
export type ReadProgress = (done: number, total: number, path: string) => void;

/** A model's files read from the paks, for a library that loads models as they are chosen. */
export type FetchPlayerModel = (
  model: string
) => Promise<{ files: Map<string, Uint8Array>; missing: string[] }>;

/** What a library knows besides its files. A library built by hand needs none of it. */
export interface AssetLibraryOptions {
  /** Manifest entries the install could not supply. */
  missing?: readonly string[];
  /** The shader scripts in ioq3's order; without one they are read by file name. */
  shaderOrder?: readonly string[];
  /** Scripts already parsed, in place of any among the files: a map's, which shares the boot's. */
  shaders?: Map<string, ShaderScript>;
  /** The models and skins the model page offers. */
  playerModels?: readonly PlayerModelSkin[];
  /** Reads a model the library lacks from the paks, where there are some. */
  fetchPlayerModel?: FetchPlayerModel;
  /** Reads one file the library lacks from the paks: a model's icon, for the model page. */
  fetchFile?: (path: string) => Promise<Uint8Array | undefined>;
}

/**
 * The extracted asset subset, with parsers memoized over it.
 *
 * This is what the whole presentation layer reads from; it holds only the manifest's files,
 * so nothing downstream can accidentally depend on a 457 MB pak still being in memory.
 */
export class AssetLibrary {
  readonly files: Map<string, Uint8Array>;
  readonly shaders: Map<string, ShaderScript>;
  /**
   * What reading the shader scripts warned of: each file left out for its braces, as
   * `ScanAndLoadShaderFiles` warns. None for scripts parsed elsewhere.
   */
  readonly shaderWarnings: readonly string[];
  /**
   * The shader scripts in the order ioq3 parses them, a name's first definition winning
   * ({@link shaderTextOrder}).
   */
  readonly shaderOrder: readonly string[];
  /**
   * Every model and skin the model page can offer, as q3_ui lists them from the paks,
   * whether or not the model's files are here yet.
   */
  readonly playerModels: readonly PlayerModelSkin[];
  private readonly missingEntries: string[];
  private readonly fetchPlayerModel: FetchPlayerModel | undefined;
  private readonly fetchFile: ((path: string) => Promise<Uint8Array | undefined>) | undefined;
  private readonly loading = new Map<string, Promise<boolean>>();
  private readonly models = new Map<string, Md3Model>();

  /**
   * @param files the extracted subset, by normalized path
   * @param options what the library knows besides its files
   */
  constructor(files: Map<string, Uint8Array>, options: AssetLibraryOptions = {}) {
    this.files = files;
    this.missingEntries = [...(options.missing ?? [])];
    this.playerModels = options.playerModels ?? [];
    this.fetchPlayerModel = options.fetchPlayerModel;
    this.fetchFile = options.fetchFile;
    this.shaderOrder =
      options.shaderOrder ?? [...files.keys()].filter((name) => name.endsWith('.shader')).sort();
    const warnings: string[] = [];
    this.shaders =
      options.shaders ??
      parseShaderScripts(
        this.shaderOrder.flatMap((name) => {
          const bytes = files.get(name);
          return bytes ? [{ name, text: new TextDecoder().decode(bytes) }] : [];
        }),
        (text) => warnings.push(text)
      );
    this.shaderWarnings = warnings;
  }

  /** Manifest entries the install could not supply; empty for a complete pak set. */
  get missing(): readonly string[] {
    return this.missingEntries;
  }

  /** Raw bytes for a path, case-insensitively. */
  read(path: string): Uint8Array | undefined {
    return this.files.get(normalizePakPath(path));
  }

  /** Resolve a texture reference through the same extension fallback the paks use. */
  resolveImage(reference: string): string | undefined {
    return resolveImageIn((path) => this.files.has(path), reference);
  }

  /** Parse a model, memoized — the viewmodel rig asks for the same handful repeatedly. */
  model(path: string): Md3Model {
    const key = normalizePakPath(path);
    const cached = this.models.get(key);
    if (cached) return cached;

    const bytes = this.read(key);
    if (!bytes) throw new Error(`assets: ${key} was not extracted`);
    const parsed = parseMd3(bytes, key);
    this.models.set(key, parsed);
    return parsed;
  }

  /** A parsed effect shader by name, or `undefined` if the scripts do not define it. */
  shader(name: string): ShaderScript | undefined {
    return this.shaders.get(name.toLowerCase());
  }

  /**
   * The image an MD3 surface should sample: its embedded shader name resolved through the
   * shader scripts, then through the extension fallback.
   *
   * @returns the resolved path and its bytes; the caller decodes by extension (TGA through
   *   `decodeTga`, JPEG through the browser)
   */
  surfaceTexture(surfaceShaderName: string): { path: string; bytes: Uint8Array } | undefined {
    const reference = diffuseReference(this.shaders, surfaceShaderName);
    if (!reference) return undefined;
    const path = this.resolveImage(reference);
    if (!path) return undefined;
    return { path, bytes: this.files.get(path)! };
  }

  /** Whether a model's parts and `animation.cfg` are here, so it can be built. */
  hasPlayerModel(model: string): boolean {
    const dir = playerModelDir(model);
    return (
      PLAYER_PARTS.every((part) => this.files.has(`${dir}${part}.md3`)) &&
      this.files.has(`${dir}animation.cfg`)
    );
  }

  /**
   * Make sure a model's files are here. The boot brings the chosen model and sarge, and
   * another is read when it is chosen, by range from the same paks: the install, the paks
   * dropped on this visit, or the browser's cache.
   *
   * The model need not be on the model page: cgame loads any model by name, and the page's cap
   * is q3_ui's alone.
   *
   * @returns whether the model can be built; `false`, for a model with no skin to load or none
   *   of its files, sends the caller to sarge, as Q3 falls back
   */
  loadPlayerModel(model: string): Promise<boolean> {
    if (this.hasPlayerModel(model)) return Promise.resolve(true);
    const fetchModel = this.fetchPlayerModel;
    if (!fetchModel) return Promise.resolve(false);
    let pending = this.loading.get(model);
    if (!pending) {
      pending = fetchModel(model)
        .then(({ files, missing }) => {
          for (const [path, bytes] of files) this.files.set(path, bytes);
          this.missingEntries.push(...missing);
          return this.hasPlayerModel(model);
        })
        .finally(() => this.loading.delete(model));
      this.loading.set(model, pending);
    }
    return pending;
  }

  /**
   * Make sure one file is here: a model's icon, which the model page shows before the model is
   * chosen. It is read from the same paks a model is.
   *
   * @returns its bytes, or `undefined` for a file the paks lack
   */
  async loadFile(path: string): Promise<Uint8Array | undefined> {
    const key = normalizePakPath(path);
    const known = this.files.get(key);
    if (known || !this.fetchFile) return known;
    const bytes = await this.fetchFile(key);
    if (bytes) this.files.set(key, bytes);
    return bytes;
  }

  /** Total extracted size, for the boot readout. */
  get byteLength(): number {
    let total = 0;
    for (const bytes of this.files.values()) total += bytes.byteLength;
    return total;
  }
}

/** Which player models an extraction brings, the list it offers, and who hears of each file. */
export interface ExtractOptions {
  /** Called as each of the manifest's files is read. */
  onRead?: ReadProgress;
  /**
   * Called as each file is read while working out which of the manifest's files the paks hold,
   * before any is counted: the shader scripts, and the models and skins they lead to.
   */
  onLookup?: (path: string) => void;
  /** The models to bring, each with every listed skin, or `'all'`. Sarge alone by default. */
  players?: readonly string[] | 'all';
  /**
   * The model page's list, for paks that can't make it themselves. The browser's cache holds
   * only part of each model's folder, and q3_ui orders its list by each folder's first file, so
   * the cache keeps the list the dropped paks made. Made from the paks when not given.
   */
  playerModels?: readonly PlayerModelSkin[];
}

/**
 * Reading the manifest from mounted paks: every read through one memo, the shader scripts parsed
 * in ioq3's order, and the player models the paks hold.
 *
 * Each entry is read once. The shader scripts and models that resolving the manifest reads are
 * the same bytes the library keeps, so every phase reads through the memo, as does a model the
 * library loads later.
 *
 * @param playerModels the model page's list, where the paks can't make it
 * @param onLookup called as each file is read to work out the manifest
 */
async function openManifest(
  fs: PakFileSystem,
  playerModels?: readonly PlayerModelSkin[],
  onLookup?: (path: string) => void
) {
  const reads = new Map<string, Promise<Uint8Array | undefined>>();
  const read = (path: string): Promise<Uint8Array | undefined> => {
    const key = normalizePakPath(path);
    let pending = reads.get(key);
    if (!pending) {
      pending = fs.read(key);
      reads.set(key, pending);
    }
    return pending;
  };
  const readAll = async (
    paths: readonly string[],
    onRead?: ReadProgress
  ): Promise<Map<string, Uint8Array>> => {
    let done = 0;
    const bytes = await mapConcurrent(paths, EXTRACT_CONCURRENCY, async (path) => {
      const found = await read(path);
      onRead?.(++done, paths.length, path);
      return found;
    });
    const out = new Map<string, Uint8Array>();
    paths.forEach((path, i) => {
      if (bytes[i]) out.set(path, bytes[i]);
    });
    return out;
  };
  const files: ManifestFiles = {
    has: (path) => fs.has(path),
    list: (prefix, extension) => fs.list(prefix, extension),
    resolveImage: (reference) => fs.resolveImage(reference),
    read
  };
  // Working out the manifest names each file it reads. A model read after the boot, through
  // `files`, names none.
  const lookUp = async (path: string): Promise<Uint8Array | undefined> => {
    const bytes = await read(path);
    onLookup?.(normalizePakPath(path));
    return bytes;
  };
  const lookingUp: ManifestFiles = { ...files, read: lookUp };

  // Shader scripts have to be parsed before the manifest walk, because the manifest needs
  // to know which textures each effect shader references in order to extract them. They are
  // parsed in ioq3's order, so a name defined twice resolves to the definition ioq3 draws.
  const shaderOrder = shaderTextOrder(fs);
  const scripts = await mapConcurrent(shaderOrder, EXTRACT_CONCURRENCY, lookUp);
  const shaders = parseShaderScripts(
    scripts.map((bytes, i) => ({ name: shaderOrder[i], text: new TextDecoder().decode(bytes!) }))
  );

  const surfaceShaderNames = (bytes: Uint8Array, label: string): string[] => {
    try {
      return parseMd3(bytes, label).surfaces.flatMap((surface) => surface.shaders);
    } catch {
      // A model we cannot parse still gets extracted; the failure surfaces at render time
      // with a better message than it would here.
      return [];
    }
  };

  const shaderMaps = (name: string): string[] => {
    const shader = findShader(shaders, name);
    if (!shader) return [name]; // bare texture reference
    return shader.stages.flatMap((stage) => stage.maps).filter((map) => !map.startsWith('$'));
  };

  // The model page's list stops where q3_ui's does, but a model loads by its folder, as
  // cgame loads any model by name: sarge comes whatever the list holds.
  const playerNames = fs.listInSearchOrder('models/players/');
  const listed = playerModels ?? listPlayerModels(playerNames);
  const folders = playerModelFolders(playerNames);
  const skinsOf = (model: string): PlayerModelSkin[] =>
    (folders.get(model) ?? []).map((skin) => ({ model, skin }));

  // A model chosen later is read from the same paks, through the same memo.
  const fetchPlayerModel: FetchPlayerModel = async (model) => {
    const found = await resolvePlayerModels(files, skinsOf(model), shaderMaps, EXTRACT_CONCURRENCY);
    return { files: await readAll(found.files), missing: found.missing };
  };

  return {
    read,
    readAll,
    shaderOrder,
    playerModels: listed,
    fetchPlayerModel,
    /** The models to bring, each with every skin its folder's icons name, or every listed one. */
    players(wanted: readonly string[] | 'all'): PlayerModelSkin[] {
      if (wanted !== 'all') return wanted.flatMap(skinsOf);
      const sarge = listed.some(({ model }) => model === DEFAULT_MODEL);
      return [...listed, ...(sarge ? [] : skinsOf(DEFAULT_MODEL))];
    },
    /** The manifest's files, with these players', found in the paks. */
    resolve(players: readonly PlayerModelSkin[]): Promise<ManifestResolution> {
      return resolveManifest(lookingUp, surfaceShaderNames, shaderMaps, players, EXTRACT_CONCURRENCY);
    }
  };
}

/**
 * Pull the manifest's subset out of mounted paks, reading only the entries it names, each once.
 * The library reads a model or an icon it lacks from the same paks later.
 */
export async function extractAssets(
  fs: PakFileSystem,
  options: ExtractOptions = {}
): Promise<AssetLibrary> {
  const manifest = await openManifest(fs, options.playerModels, options.onLookup);
  const resolution = await manifest.resolve(manifest.players(options.players ?? [DEFAULT_MODEL]));
  return new AssetLibrary(await manifest.readAll(resolution.files, options.onRead), {
    missing: resolution.missing,
    shaderOrder: manifest.shaderOrder,
    playerModels: manifest.playerModels,
    fetchPlayerModel: manifest.fetchPlayerModel,
    fetchFile: manifest.read
  });
}

/**
 * What the browser's cache keeps of dropped paks: the manifest's subset with every model the
 * page lists, so a later visit can offer and load each of them without the paks; what the
 * skirmish pages read, with every bot's models; and the list, which only the paks can make. Only
 * the scripts, models, skins, arenas and bots are read, for what they name.
 */
export async function cacheSubset(fs: PakFileSystem): Promise<CacheSubset> {
  const manifest = await openManifest(fs);
  const menu = await menuFiles(fs);
  const resolution = await manifest.resolve([
    ...manifest.players('all'),
    ...manifest.players(menu.botModels)
  ]);
  return {
    files: [...new Set([...resolution.files, ...menu.files])].sort(),
    playerModels: manifest.playerModels
  };
}

/**
 * What the skirmish pages read of the paks ({@link MENU_FILES}), and the models every bot wears:
 * - every arena and bot file, which the cache lists in the paks' order;
 * - each arena's levelshot, by the name Start Server asks for it by;
 * - the picture for a map with none;
 * - each bot's body and head models, which a match reads whole wherever the model page's list
 *   stops short of them.
 */
async function menuFiles(fs: PakFileSystem): Promise<{ files: string[]; botModels: string[] }> {
  const files: string[] = [];
  for (const { file, extension } of MENU_FILES.infos) {
    if (fs.has(file)) files.push(normalizePakPath(file));
    files.push(...fs.list('scripts/', extension));
  }

  const arenas = loadArenas(await readInfoFiles(fs, ARENAS_FILE, '.arena', MENU_ARENA_LIST), () => {});
  const pictures = arenas.map(
    (arena) => `${MENU_FILES.levelshots}${shownMapName(infoValueForKey(arena, 'map'))}`
  );
  for (const picture of [...pictures, MENU_FILES.unknownMap]) {
    const found = fs.resolveImage(picture);
    if (found) files.push(found);
  }

  const bots = loadBots(await readInfoFiles(fs, BOTS_FILE, '.bot', BOT_LIST), () => {});
  // cgame's model name runs to the first slash, and its skin follows (`cg_players.c:981–991`).
  const worn = bots.flatMap((bot) =>
    Object.values(botModels(bot)).map((model) => model.split('/')[0].toLowerCase())
  );
  return { files, botModels: [...new Set(worn)] };
}

/**
 * How the assets were obtained, for the boot readout: read in place from the install the dev
 * server or the shell serves or from the install folder the player picked, from the browser's
 * cache, or from paks the player dropped.
 */
export type AssetSource = 'install' | 'folder' | 'cache' | 'paks';

/** Paks mounted for a boot, where they came from, and what they can't say themselves. */
export interface BootPaks {
  fs: PakFileSystem;
  source: AssetSource;
  /** The model page's list, where the paks that made it are gone and the cache kept it. */
  playerModels?: readonly PlayerModelSkin[];
}

/** The routes to the paks, each asked only once the one before has come up empty. */
export interface PakRoutes {
  /** The install the dev server or the shell reads in place, or `undefined` when there is none. */
  dev: () => Promise<PakFileSystem | undefined>;
  /**
   * What the browser kept from an earlier visit, mounted: the install folder or the cache. It is
   * `undefined` when nothing kept can be read.
   */
  kept: () => Promise<BootPaks | undefined>;
  /** The drop screen, which waits for the player to drop paks or pick the install folder. */
  ask: () => Promise<BootPaks>;
  /**
   * Keep the subset of dropped paks for the next visit. Absent where nothing can be kept; a
   * failure only means the next visit asks again.
   */
  keep?: (fs: PakFileSystem, subset: CacheSubset) => Promise<unknown>;
}

/**
 * Load the assets by the first route that has them:
 * 1. the install the dev server or the shell reads in place, with no cache at all, so a pak
 *    replaced on disk is simply read;
 * 2. what the browser kept: the install folder the player picked, read in place the same way,
 *    or its cache, a pak of the manifest's subset;
 * 3. the drop screen, where the player picks the folder or drops paks. Dropped paks are read for
 *    this visit, and their subset is kept for the next.
 *
 * Every route extracts the same way, reading only what the game needs: the manifest's files and
 * the chosen model with sarge. Another model is read from the same paks when it is chosen.
 *
 * @param options the chosen player model, sarge by default, who hears of each file read, and who
 *   hears of the paks once they are mounted, before anything is extracted from them
 * @returns the library, where it came from, and the paks it was read from, which the search path
 *   puts over the port's own map pk3s. From the cache, those are the cache's one pak.
 */
export async function loadAssets(
  routes: PakRoutes,
  options: {
    model?: string;
    onMounted?: (paks: PakFileSystem) => void;
  } & Pick<ExtractOptions, 'onRead' | 'onLookup'> = {}
): Promise<{ library: AssetLibrary; source: AssetSource; paks: PakFileSystem }> {
  const model = options.model ?? DEFAULT_MODEL;
  const players = model === DEFAULT_MODEL ? [model] : [model, DEFAULT_MODEL];
  const heard = { onRead: options.onRead, onLookup: options.onLookup };

  const install = await routes.dev();
  if (install) {
    options.onMounted?.(install);
    const library = await extractAssets(install, { players, ...heard });
    return { library, source: 'install', paks: install };
  }

  const paks = (await routes.kept()) ?? (await routes.ask());
  options.onMounted?.(paks.fs);
  const library = await extractAssets(paks.fs, {
    players,
    playerModels: paks.playerModels,
    ...heard
  });
  if (paks.source === 'paks' && routes.keep) {
    try {
      await routes.keep(paks.fs, await cacheSubset(paks.fs));
    } catch {
      // Only the next visit pays: it asks for the paks again.
    }
  }
  return { library, source: paks.source, paks: paks.fs };
}
