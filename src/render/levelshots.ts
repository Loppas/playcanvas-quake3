import type { Texture } from 'playcanvas';

import { UNKNOWN_MAP } from '../formats/asset-manifest';
import type { PakFileSystem } from '../pak/vfs';
import type { TextureCache } from './texture-cache';

/** One picture, as far as it has got. */
interface Shot {
  /** The cache's key for its texture, once it holds a count. */
  key: string | null;
  texture: Texture | null;
  /** None to be had, or none that decodes: the unknown map's picture stands in. */
  missing: boolean;
  /** Asked for since the last sweep. */
  asked: boolean;
  /** Given back, so a load still under way keeps nothing. */
  gone: boolean;
}

/**
 * The menus' levelshots, by shader name: `levelshots/<NAME>`, in whichever image format the search
 * path holds it. They are read from the whole search path, so the port's own maps show theirs as
 * the player's paks show theirs. A map with none shows {@link UNKNOWN_MAP}, as q3_ui's `errorpic`
 * does, and with neither, nothing.
 *
 * A shot is kept while the screen asks for it. {@link sweep}, once a frame, gives back each one
 * not asked for since the last, so a page turned or closed gives back what it showed. The unknown
 * map's picture is kept until the menu goes.
 */
export class Levelshots {
  private readonly fs: Pick<PakFileSystem, 'resolveImage' | 'read'>;
  private readonly cache: TextureCache;
  private readonly shots = new Map<string, Shot>();
  private unknown: Shot | null = null;

  /** @param cache - Where the textures are counted. */
  constructor(fs: Pick<PakFileSystem, 'resolveImage' | 'read'>, cache: TextureCache) {
    this.fs = fs;
    this.cache = cache;
  }

  /** A picture by its shader's name; `null` until it has loaded, or where there is none. */
  get(name: string): Texture | null {
    let shot = this.shots.get(name);
    if (!shot) {
      shot = this.load(name);
      this.shots.set(name, shot);
    }
    shot.asked = true;
    if (!shot.missing) return shot.texture;
    this.unknown ??= this.load(UNKNOWN_MAP);
    return this.unknown.texture;
  }

  /** Give back every shot not asked for since the last sweep. */
  sweep(): void {
    for (const [name, shot] of this.shots) {
      if (shot.asked) shot.asked = false;
      else {
        this.shots.delete(name);
        this.giveBack(shot);
      }
    }
  }

  /** Give back every picture, the unknown map's too. */
  destroy(): void {
    for (const shot of this.shots.values()) this.giveBack(shot);
    this.shots.clear();
    if (this.unknown) this.giveBack(this.unknown);
    this.unknown = null;
  }

  /** Start reading a picture, and hand back what will hold it. */
  private load(name: string): Shot {
    const shot: Shot = { key: null, texture: null, missing: false, asked: false, gone: false };
    this.read(name, shot).catch((err: unknown) => {
      console.warn(`Levelshot unavailable: ${name}`, err);
      // A texture that fails to decode is forgotten by the cache, count and all.
      shot.key = null;
      shot.missing = true;
    });
    return shot;
  }

  private async read(name: string, shot: Shot): Promise<void> {
    const path = this.fs.resolveImage(name);
    const bytes = path === undefined ? undefined : await this.fs.read(path);
    if (shot.gone) return;
    if (path === undefined || bytes === undefined) {
      shot.missing = true;
      return;
    }
    // Drawn unmipped, as 2D pictures are.
    const { key, texture } = this.cache.acquire(path, bytes, true, false);
    shot.key = key;
    const loaded = await texture;
    if (!shot.gone) shot.texture = loaded;
  }

  private giveBack(shot: Shot): void {
    shot.gone = true;
    if (shot.key !== null) this.cache.release(shot.key);
    shot.key = null;
    shot.texture = null;
  }
}
