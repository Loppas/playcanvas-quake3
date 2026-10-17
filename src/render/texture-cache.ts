import type { GraphicsDevice, Material, Texture } from 'playcanvas';

import { upload32Image } from '../formats/image-scale';
import { createTexture, decodeImage } from './md3-mesh';

/**
 * Textures shared by count, and the resources one model owns.
 *
 * Q3 loads an image once, whoever names it (`R_FindImageFile`), and frees everything between
 * maps. The port frees as it goes instead: a model swap has to give back the old model's
 * textures and materials. So a texture is
 * counted: each model that draws it holds a count, and the last to let go destroys it. A
 * material is not shared; it belongs to the model that made it, and goes with that model.
 */

interface Entry {
  texture: Promise<Texture>;
  count: number;
}

/** Every counted texture, keyed by its image and how it is sampled. */
export class TextureCache {
  private readonly device: GraphicsDevice;
  private readonly entries = new Map<string, Entry>();

  constructor(device: GraphicsDevice) {
    this.device = device;
  }

  /** Textures alive, each once however many models hold it. */
  get size(): number {
    return this.entries.size;
  }

  /** A scope for one model's resources, disposed of with the model. */
  scope(): ResourceScope {
    return new ResourceScope(this);
  }

  /**
   * Take a count on a texture, decoding and uploading it on the first. Kept as a promise, so two
   * models asking at once share one decode.
   *
   * @param picmip - Sized as opengl1's `Upload32` sizes it, halved this many times
   *   ({@link upload32Image}); absent, uploaded at the file's own size.
   * @returns the key to release it by, and the texture
   */
  acquire(
    path: string,
    bytes: Uint8Array,
    clamp: boolean,
    mipmaps: boolean,
    picmip?: number
  ): { key: string; texture: Promise<Texture> } {
    const sized = picmip === undefined ? '' : `|picmip ${picmip}`;
    const key = `${path}|${clamp ? 'clamp' : 'repeat'}|${mipmaps ? 'mip' : 'nomip'}${sized}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const texture = decodeImage(path, bytes).then((image) =>
        createTexture(
          this.device,
          path,
          picmip === undefined ? image : upload32Image(image, picmip),
          clamp,
          mipmaps
        )
      );
      const created: Entry = { texture, count: 0 };
      // A texture that fails to decode is forgotten, so the next model to ask tries again.
      texture.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
      entry = created;
      this.entries.set(key, entry);
    }
    entry.count++;
    return { key, texture: entry.texture };
  }

  /** Give back a count; the last destroys the texture, once it exists. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (--entry.count > 0) return;
    this.entries.delete(key);
    entry.texture.then(
      (texture) => texture.destroy(),
      () => {}
    );
  }
}

/** The textures and materials one model holds, given back together. */
export class ResourceScope {
  private readonly cache: TextureCache;
  private readonly keys: string[] = [];
  private readonly materials: Material[] = [];

  constructor(cache: TextureCache) {
    this.cache = cache;
  }

  /** How many materials this scope owns. */
  get materialCount(): number {
    return this.materials.length;
  }

  /**
   * A counted texture, held until {@link dispose}.
   *
   * @param picmip - See {@link TextureCache.acquire}.
   */
  texture(
    path: string,
    bytes: Uint8Array,
    clamp = false,
    mipmaps = true,
    picmip?: number
  ): Promise<Texture> {
    const { key, texture } = this.cache.acquire(path, bytes, clamp, mipmaps, picmip);
    this.keys.push(key);
    return texture;
  }

  /** Make a material this scope's, destroyed on {@link dispose}. */
  own<T extends Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  /**
   * Destroy the materials and give back the textures. Call it once whatever drew with them is
   * gone: a material still on a mesh instance hands that instance the default material.
   */
  dispose(): void {
    for (const material of this.materials) material.destroy();
    for (const key of this.keys) this.cache.release(key);
    this.materials.length = 0;
    this.keys.length = 0;
  }
}
