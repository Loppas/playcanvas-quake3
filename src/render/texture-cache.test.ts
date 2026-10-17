// @vitest-environment jsdom
import { StandardMaterial, type AppBase } from 'playcanvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from './engine-test-fixtures';
import { TextureCache } from './texture-cache';

/**
 * The null device registers no textures of its own, so a texture's `device`, which `destroy`
 * clears, says whether it is still alive.
 */

/** A 2×2 white TGA, top-left origin. */
function tga(): Uint8Array {
  const header = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 0x28];
  return new Uint8Array([...header, ...new Array(2 * 2 * 4).fill(255)]);
}

describe('TextureCache', () => {
  let app: AppBase;
  let cache: TextureCache;

  beforeEach(() => {
    app = createTestApp().app;
    cache = new TextureCache(app.graphicsDevice);
  });

  afterEach(() => app.destroy());

  it('shares one texture between models, and destroys it when the last lets go', async () => {
    const sarge = cache.scope();
    const xaero = cache.scope();
    const first = await sarge.texture('models/band.tga', tga());
    const second = await xaero.texture('models/band.tga', tga());
    expect(second).toBe(first);
    expect(cache.size).toBe(1);

    sarge.dispose();
    await Promise.resolve();
    expect(first.device).not.toBeNull();
    xaero.dispose();
    await Promise.resolve();
    expect(cache.size).toBe(0);
    expect(first.device).toBeNull();
  });

  it('keeps apart the same image sampled two ways', async () => {
    const scope = cache.scope();
    const repeat = await scope.texture('models/band.tga', tga());
    const clamped = await scope.texture('models/band.tga', tga(), true);
    const sharp = await scope.texture('models/band.tga', tga(), false, false);
    expect(new Set([repeat, clamped, sharp]).size).toBe(3);
    expect(cache.size).toBe(3);
    scope.dispose();
    await Promise.resolve();
    expect([repeat, clamped, sharp].map((texture) => texture.device)).toEqual([null, null, null]);
  });

  it('destroys a texture given back before its decode had finished', async () => {
    const scope = cache.scope();
    const pending = scope.texture('models/band.tga', tga());
    scope.dispose();
    const texture = await pending;
    await Promise.resolve();
    expect(texture.device).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('destroys the materials a scope owns', () => {
    const scope = cache.scope();
    const material = scope.own(new StandardMaterial());
    const destroy = vi.spyOn(material, 'destroy');
    expect(scope.materialCount).toBe(1);
    scope.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(scope.materialCount).toBe(0);
  });

  it('forgets a texture that failed to decode, so the next model can try again', async () => {
    const scope = cache.scope();
    await expect(scope.texture('models/broken.tga', new Uint8Array(4))).rejects.toThrow();
    expect(cache.size).toBe(0);
  });
});
