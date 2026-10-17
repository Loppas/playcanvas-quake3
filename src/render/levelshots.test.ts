// @vitest-environment jsdom
import { Texture } from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';

import { resolveImageIn } from '../pak/vfs';
import { createTestApp } from './engine-test-fixtures';
import { Levelshots } from './levelshots';
import { whiteTga } from './player-test-fixtures';
import { TextureCache } from './texture-cache';

/** The Start Server page's levelshots, read from the search path as its tiles ask for them. */

const Q3DM1 = 'levelshots/Q3DM1';
const GARAGE = 'levelshots/GARAGE_CATS';

/** Levelshots over a search path holding these files, each a white TGA. */
function setUp(paths: readonly string[]) {
  const { app } = createTestApp();
  const cache = new TextureCache(app.graphicsDevice);
  const files = new Set(paths);
  const read = vi.fn(async (path: string) => (files.has(path) ? whiteTga() : undefined));
  const fs = { resolveImage: (reference: string) => resolveImageIn((path) => files.has(path), reference), read };
  return { app, cache, read, shots: new Levelshots(fs, cache) };
}

describe('Levelshots', () => {
  it('reads a levelshot in whichever format the search path has, once loaded', async () => {
    const { app, cache, read, shots } = setUp(['levelshots/q3dm1.tga']);
    expect(shots.get(Q3DM1)).toBeNull();
    await vi.waitFor(() => expect(shots.get(Q3DM1)).toBeInstanceOf(Texture));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('levelshots/q3dm1.tga');
    expect(cache.size).toBe(1);
    shots.destroy();
    expect(cache.size).toBe(0);
    app.destroy();
  });

  it("shows the unknown map's picture for a map with none, and keeps it through sweeps", async () => {
    const { app, cache, shots } = setUp(['menu/art/unknownmap.tga']);
    shots.get(GARAGE);
    await vi.waitFor(() => expect(shots.get(GARAGE)).toBeInstanceOf(Texture));
    const unknown = shots.get(GARAGE);
    shots.sweep();
    shots.sweep();
    expect(cache.size).toBe(1);
    expect(shots.get(Q3DM1)).toBe(unknown);
    shots.destroy();
    expect(cache.size).toBe(0);
    app.destroy();
  });

  it('shows nothing where there is neither the levelshot nor the unknown map', async () => {
    const { app, read, shots } = setUp([]);
    shots.get(Q3DM1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shots.get(Q3DM1)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    app.destroy();
  });

  it('gives back each shot not asked for since the last sweep, and keeps the ones that were', async () => {
    const { app, cache, shots } = setUp(['levelshots/q3dm1.tga', 'levelshots/garage_cats.tga']);
    shots.get(Q3DM1);
    shots.get(GARAGE);
    await vi.waitFor(() => expect(cache.size).toBe(2));
    shots.sweep();
    shots.get(GARAGE);
    shots.sweep();
    expect(cache.size).toBe(1);
    expect(shots.get(GARAGE)).toBeInstanceOf(Texture);
    shots.sweep();
    shots.sweep();
    expect(cache.size).toBe(0);
    app.destroy();
  });

  it('keeps nothing of a shot given back while it loads', async () => {
    const { app, cache, shots } = setUp(['levelshots/q3dm1.tga']);
    shots.get(Q3DM1);
    shots.sweep();
    shots.sweep();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.size).toBe(0);
    app.destroy();
  });
});
