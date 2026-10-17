import type { Texture } from 'playcanvas';

import type { AssetLibrary } from '../formats/asset-library';
import type { ResourceScope, TextureCache } from './texture-cache';

/**
 * The menu's player icons, by their shader names: each model and skin's `icon_<skin>`, loaded when
 * a grid first shows it, as `PlayerModel_UpdateGrid` registers its pictures, and kept until the
 * menu goes. Where the library lacks one, it is read from the install as it is asked for.
 */
export class MenuIcons {
  private readonly library: AssetLibrary;
  private readonly scope: ResourceScope;
  /** Each icon asked for: its texture, or `null` while it loads or where the install lacks it. */
  private readonly icons = new Map<string, Texture | null>();
  /** Each icon's load, done once it is in or found lacking. */
  private readonly loads = new Map<string, Promise<void>>();
  /** The icons asked for that the install turned out to lack. */
  private readonly lacking = new Set<string>();
  private destroyed = false;

  /** @param cache - Where the textures are counted. */
  constructor(library: AssetLibrary, cache: TextureCache) {
    this.library = library;
    this.scope = cache.scope();
  }

  /** An icon by its shader's name, as a cell names it; `null` until it has loaded. */
  get(name: string): Texture | null {
    const known = this.icons.get(name);
    if (known !== undefined) return known;
    this.icons.set(name, null);
    const load = this.load(name).catch((err: unknown) => {
      this.lacking.add(name);
      console.warn(`Menu icon unavailable: ${name}`, err);
    });
    this.loads.set(name, load);
    return null;
  }

  /**
   * Load an icon before anything draws it, as `CG_LoadClientInfo` registers a client's
   * (`cg_players.c:602–607`).
   *
   * @returns once it is in, or found lacking
   */
  async prepare(name: string): Promise<void> {
    this.get(name);
    await this.loads.get(name);
  }

  /**
   * Whether an icon asked for is known to be missing, as `trap_R_RegisterShaderNoMip` fails for
   * it; `false` while it loads, and for one not yet asked for.
   */
  missing(name: string): boolean {
    return this.lacking.has(name);
  }

  /** Give back every icon's texture. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.icons.clear();
    this.loads.clear();
    this.lacking.clear();
    this.scope.dispose();
  }

  private async load(name: string): Promise<void> {
    // q3_ui lists the icons by their .tga files (`PlayerModel_BuildList`, `ui_playermodel.c:388–449`),
    // and draws them unmipped, as 2D pictures.
    const path = `${name}.tga`;
    const bytes = await this.library.loadFile(path);
    if (this.destroyed) return;
    if (!bytes) {
      this.lacking.add(name);
      return;
    }
    const texture = await this.scope.texture(path, bytes, true, false);
    if (!this.destroyed) this.icons.set(name, texture);
  }
}
