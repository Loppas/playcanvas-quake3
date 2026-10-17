// @vitest-environment jsdom
import { Texture } from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';

import { AssetLibrary } from '../formats/asset-library';
import { createTestApp } from './engine-test-fixtures';
import { MenuIcons } from './menu-icons';
import { whiteTga } from './player-test-fixtures';
import { TextureCache } from './texture-cache';

/** The Model page's icons, read from the install as the grid asks for them. */

const SARGE = 'models/players/sarge/icon_default';

/** Icons over an empty library, with an install behind it that has sarge's icon alone. */
function setUp() {
  const { app } = createTestApp();
  const cache = new TextureCache(app.graphicsDevice);
  const fetchFile = vi.fn(async (path: string) => (path === `${SARGE}.tga` ? whiteTga() : undefined));
  const icons = new MenuIcons(new AssetLibrary(new Map(), { fetchFile }), cache);
  return { app, cache, fetchFile, icons };
}

describe('MenuIcons', () => {
  it('reads an icon when the grid first asks for it, and hands it out once it has loaded', async () => {
    const { app, cache, fetchFile, icons } = setUp();
    expect(icons.get(SARGE)).toBeNull();
    await vi.waitFor(() => expect(icons.get(SARGE)).toBeInstanceOf(Texture));
    expect(fetchFile).toHaveBeenCalledOnce();
    expect(fetchFile).toHaveBeenCalledWith(`${SARGE}.tga`);
    expect(cache.size).toBe(1);
    icons.destroy();
    expect(cache.size).toBe(0);
    app.destroy();
  });

  it('draws nothing for an icon the install lacks, and asks for it once', async () => {
    const { app, fetchFile, icons } = setUp();
    const name = 'models/players/nobody/icon_default';
    expect(icons.get(name)).toBeNull();
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(icons.get(name)).toBeNull();
    expect(fetchFile).toHaveBeenCalledOnce();
    app.destroy();
  });

  it('tells an icon the install lacks from one still loading, or one it has', async () => {
    const { app, icons } = setUp();
    const name = 'models/players/sarge/icon_blue';
    expect(icons.missing(name)).toBe(false);
    icons.get(name);
    icons.get(SARGE);
    expect(icons.missing(name)).toBe(false);
    await vi.waitFor(() => expect(icons.missing(name)).toBe(true));
    await vi.waitFor(() => expect(icons.get(SARGE)).toBeInstanceOf(Texture));
    expect(icons.missing(SARGE)).toBe(false);
    icons.destroy();
    app.destroy();
  });

  it('loads an icon ahead of its first draw, once, whether the install has it or not', async () => {
    const { app, fetchFile, icons } = setUp();
    await icons.prepare(SARGE);
    expect(icons.get(SARGE)).toBeInstanceOf(Texture);
    await icons.prepare(SARGE);
    expect(fetchFile).toHaveBeenCalledOnce();

    const name = 'models/players/nobody/icon_default';
    await icons.prepare(name);
    expect(icons.missing(name)).toBe(true);
    icons.destroy();
    app.destroy();
  });
});
