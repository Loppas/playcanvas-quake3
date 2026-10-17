import { Asset, Entity, Vec3, type AppBase, type CameraComponent } from 'playcanvas';

import type { CollisionOverlay } from './collision-overlay';
import { parseBspCollision, parseBspWorld } from './formats/bsp';
import { bspPath } from './formats/map-kind';
import { splatMapFiles, wholeBuffer } from './formats/splat-map';
import type { CvarStore } from './net/cvar';
import type { ByteProgress } from './pak/byte-source';
import type { PakFileSystem } from './pak/vfs';
import { BspWorld, type BspWorldOptions } from './render/bsp-world';
import type { Warmed } from './render/warm-up';
import { hostMapFromData, readHostMapData } from './server/host-map';
import type { HostMap } from './server/host';
import { createClipInlineModels, createClipPointContents, createClipTrace } from './sim/clip-trace';
import { entityString, loadMap } from './sim/cm/cm-load';
import type { ClipMap } from './sim/cm/cm-local';
import {
  NO_INLINE_MODELS,
  type InlineModels,
  type PointContentsFn,
  type TraceFn
} from './sim/types';
import { createVoxelPointContents, createVoxelTrace } from './sim/voxel-trace';
import type { SparseVoxelOctree } from './sim/voxel-svo';
import { SvoVoxelGrid } from './svo-voxel-grid';

/**
 * How many frames {@link GameMap.destroy} waits for the splat's sorter to let it go before it
 * stops waiting. The sorter lets go on the next frame it runs, so this is only a bound.
 */
const RELEASE_FRAMES = 60;

/**
 * A map as it is loaded, whichever its kind: a splat or a BSP a match is played on, or a BSP's
 * world for a preview. Each is in the scene from its load to its unload, and frees what it alone
 * holds.
 */
export interface LoadedMap {
  /** The map's name, as `map <n>` takes it. */
  readonly name: string;
  /** The map's entity text. */
  readonly entities: string;
  /** Everything the map draws hangs from this. */
  readonly root: Entity;
  /** Its draws, for the warm-up (`render/warm-up.ts`), seen through `eye`. */
  warm(eye: Entity): Warmed;
  /** Take the map out of the scene and free it, resolving once it is gone. */
  destroy(): Promise<void>;
}

/** What a map is once its files are loaded. */
export interface GameMapParts {
  /** The map's name, as `map <n>` takes it. */
  name: string;
  /** The splat, loaded. */
  splat: Asset;
  /** The collision octree, which the world is traced against. */
  octree: SparseVoxelOctree;
  /** The entity text, which the host hands the game module a token at a time. */
  entities: string;
  /** The debug overlay of the collision mesh, or null where it is missing or failed. */
  collision: CollisionOverlay | null;
}

/**
 * A map, from its load to its unload: everything that belongs to one map and to no other, and the
 * one place that frees it.
 *
 * Q3 frees a map with the hunk (`SV_SpawnServer`, `sv_init.c:415–422`), and the port has no
 * hunk. The player's art, the HUD's and the effects' are the session's and stay; what is
 * here is what a second map would otherwise leave behind: the splat, still drawn beside the new
 * one, its collision overlay, and its octree.
 */
export class GameMap implements LoadedMap {
  readonly name: string;
  /** The splat's entity, in the scene while the map is loaded. */
  readonly root: Entity;
  /** The world, traced: swept boxes against the map's octree. */
  readonly trace: TraceFn;
  /** What a point is inside of the world: solid in the octree's solid voxels, and nothing else. */
  readonly pointContents: PointContentsFn;
  /** A splat has no inline models, so its triggers are boxes. */
  readonly inlineModels: InlineModels = NO_INLINE_MODELS;
  /** The map's entity text. */
  readonly entities: string;
  readonly collision: CollisionOverlay | null;
  /** How many splats the map draws. */
  readonly splatCount: number;

  private readonly app: AppBase;
  private readonly splat: Asset;

  /** Put a loaded map in the scene. */
  constructor(app: AppBase, parts: GameMapParts) {
    this.app = app;
    this.name = parts.name;
    this.splat = parts.splat;
    this.entities = parts.entities;
    this.collision = parts.collision;
    const grid = new SvoVoxelGrid(parts.octree);
    this.trace = createVoxelTrace(grid);
    this.pointContents = createVoxelPointContents(grid);
    // `Asset.resource` is typed as `object`; the gsplat resource carries the parsed splat data.
    const resource = parts.splat.resource as { gsplatData?: { numSplats?: number } } | null;
    this.splatCount = resource?.gsplatData?.numSplats ?? 0;

    this.root = new Entity('map');
    this.root.addComponent('gsplat', { asset: parts.splat });
    app.root.addChild(this.root);
  }

  /**
   * The splat's colour pass, for the warm-up (`render/warm-up.ts`). The engine works out a splat's
   * view-dependent colour for where the eye is, and works it out again in a pass of its own once
   * the eye has moved far enough, as it does the moment the player is put in the world. So the eye
   * is moved, to the splat's middle and then to a corner of its bounds, and put back after.
   *
   * @param eye - The camera the splat is drawn through.
   */
  warm(eye: Entity): Warmed {
    const bounds = this.root.gsplat?.resource?.aabb;
    let back: Vec3 | null = null;
    return {
      at: () => {
        if (!bounds) return;
        const point = back ? bounds.getMax() : bounds.center;
        back ??= eye.getPosition().clone();
        eye.setPosition(this.root.getWorldTransform().transformPoint(point, new Vec3()));
      },
      end: () => {
        if (back) eye.setPosition(back);
        back = null;
      }
    };
  }

  /**
   * Take the map out of the scene and free it.
   *
   * The splat's entity goes first, then the asset: `registry.remove()` and `asset.unload()`, in
   * the engine's own order. `remove` alone frees nothing, and `unload` is what frees the planes
   * and the textures the bundle parser registered. The octree goes with this object, once nothing
   * traces against it.
   *
   * The engine frees a splat only once its sorter has let go of it, on a frame of its own
   * (`gsplat-resource-cleanup.js`), so this resolves after that frame rather than assuming the
   * memory is back at once. The next map loads after it.
   */
  async destroy(): Promise<void> {
    const resource = this.splat.resource as { refCount?: number } | null;
    this.root.destroy();
    this.collision?.destroy();
    this.app.assets.remove(this.splat);
    this.splat.unload();

    for (let frame = 0; frame < RELEASE_FRAMES && (resource?.refCount ?? 0) > 0; frame++) {
      await nextFrame(this.app);
    }
    await nextFrame(this.app);
  }
}

/** What a BSP map is built from: its world's options, and what its collision reads. */
export interface BspGameMapOptions extends Omit<BspWorldOptions, 'bsp'> {
  /**
   * Where `cm_noAreas`, `cm_noCurves` and `cm_playerCurveClip` are read, at each trace; without
   * one, the clip map's own stand.
   */
  cvars?: CvarStore;
  /** Told the map's entity text once its collision is in, before the world's textures. */
  collided?(entities: string): void;
}

/**
 * A BSP map as a match is played on it, the client's own load of its file: the world drawn, and
 * the trace through its collision that the client predicts and bounces in.
 */
export class BspGameMap implements LoadedMap {
  readonly name: string;
  readonly entities: string;
  readonly root: Entity;
  /** The world, drawn from each view. */
  readonly world: BspWorld;
  /** The world, traced: swept boxes against the client's clip map. */
  readonly trace: TraceFn;
  /** What a point is inside of the world, model 0 of the client's clip map. */
  readonly pointContents: PointContentsFn;
  /** The client's clip map's inline models, which a trigger's predicted touch is tested on. */
  readonly inlineModels: InlineModels;

  private constructor(world: BspWorld, cm: ClipMap, cvars: CvarStore | undefined) {
    this.name = world.name;
    this.world = world;
    this.root = world.root;
    this.trace = createClipTrace(cm, cvars);
    this.pointContents = createClipPointContents(cm);
    this.inlineModels = createClipInlineModels(cm, cvars);
    this.entities = entityString(cm);
  }

  /**
   * Load a map from its BSP as `CG_Init` does: collision's `CM_LoadMap`, then the renderer's
   * `RE_LoadWorldMap` (`cg_main.c:1900`, `827`), so a map that both refuse stops on collision's
   * words. Nothing of `bytes` is kept, so they may be handed on whole once this resolves, as a
   * match's server in another thread takes them.
   *
   * @param bytes - The map's BSP, read whole.
   * @throws as `CM_LoadMap` and `RE_LoadWorldMap` throw, in Q3's words
   */
  static async load(
    app: AppBase,
    camera: CameraComponent,
    bytes: Uint8Array,
    options: BspGameMapOptions
  ): Promise<BspGameMap> {
    const { cvars, collided, ...worldOptions } = options;
    const path = bspPath(options.name);
    const collision = parseBspCollision(bytes, path);
    const cm = loadMap(collision, path, { print: options.warn });
    collided?.(entityString(cm));
    const bsp = parseBspWorld(bytes, path, collision);
    const world = await BspWorld.load(app, camera, { ...worldOptions, bsp });
    return new BspGameMap(world, cm, cvars);
  }

  /** The world's draws, for the warm-up (`render/warm-up.ts`). */
  warm(): Warmed {
    return this.world.warm();
  }

  /** Take the world out of the scene and free it. */
  destroy(): Promise<void> {
    return this.world.destroy();
  }
}

/** Resolves once the app has finished its next frame. */
function nextFrame(app: AppBase): Promise<void> {
  return new Promise((resolve) => app.once('frameend', () => resolve()));
}

/**
 * A map as the server loads it (`SV_SpawnServer` → `CM_LoadMap` and `CM_EntityString`): the
 * entity text and the collision, and no splat. The world the client draws and predicts in is the
 * client's own load, so the two read the same file on their own sides, as Q3's two
 * `CM_LoadMap`s do.
 *
 * @param fs - The search path.
 * @param name - The map's name.
 */
export async function loadHostMap(
  fs: Pick<PakFileSystem, 'has' | 'read'>,
  name: string
): Promise<HostMap> {
  return hostMapFromData(await readHostMapData(fs, name));
}

/**
 * A map's splat, read through the search path and loaded as a `gsplat` asset: what
 * `RE_LoadWorldMap` loads from the BSP in Q3 (`cg_main.c:827`; `map-format.md` §11).
 *
 * The `.sog` is stored in its pk3, not deflated, so it is one ranged read, and the engine's
 * bundle parser takes the bytes in place of fetching a URL (`sog-bundle.js:72–73`). It picks
 * itself by the name's extension, which is why the asset is named after the file.
 *
 * @param fs - The search path.
 * @param name - The map's name.
 * @param progress - Told as the splat's bytes come in. Its unpacking follows, untold.
 */
export async function loadSplat(
  app: AppBase,
  fs: Pick<PakFileSystem, 'read'>,
  name: string,
  progress?: ByteProgress
): Promise<Asset> {
  const path = splatMapFiles(name).splat;
  const bytes = await fs.read(path, progress);
  if (!bytes) throw new Error(`Can't find map ${path}`);
  return loadFromBytes(app, path, 'gsplat', bytes);
}

/**
 * Load an asset from bytes already read, rather than from a URL.
 *
 * The asset keeps its file for as long as it lives, and the bytes with it, so they are let go once
 * the parser has made its resource of them: a splat's are 185 MB.
 *
 * @param path - The file's path, which names the asset and picks its parser.
 */
export function loadFromBytes(
  app: AppBase,
  path: string,
  type: 'gsplat' | 'container',
  bytes: Uint8Array
): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const contents = wholeBuffer(bytes);
    const asset = new Asset(path, type, { url: path, filename: path, contents });
    asset.once('load', () => {
      (asset.file as { contents: ArrayBuffer | null }).contents = null;
      resolve(asset);
    });
    asset.once('error', (err: string) => reject(new Error(`Failed to load ${path}: ${err}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}
