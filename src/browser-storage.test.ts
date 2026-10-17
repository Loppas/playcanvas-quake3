import { afterEach, describe, expect, it, vi } from 'vitest';

import { opfsRoot, storageName } from './browser-storage';

/** OPFS in memory, as much of it as the root uses: each folder by its path, made as asked for. */
function fakeOpfs() {
  const made: string[] = [];
  const folder = (path: string): object => ({
    path,
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      if (!options?.create) throw new DOMException(name, 'NotFoundError');
      made.push(`${path}${name}/`);
      return folder(`${path}${name}/`);
    }
  });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => folder('/') } });
  return made;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('a build at the origin root', () => {
  it('keeps its files at the root of OPFS, and its names as they are', async () => {
    vi.stubEnv('BASE_URL', '/');
    const made = fakeOpfs();
    expect(await opfsRoot()).toMatchObject({ path: '/' });
    expect(made).toEqual([]);
    expect(storageName('game-data')).toBe('game-data');
  });
});

describe('a build below the origin root', () => {
  it('keeps its files in a folder per part of its base, made when first asked for', async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    fakeOpfs();
    expect(await opfsRoot()).toMatchObject({ path: '/playcanvas-quake3/' });

    vi.stubEnv('BASE_URL', '/builds/next/');
    const made = fakeOpfs();
    expect(await opfsRoot()).toMatchObject({ path: '/builds/next/' });
    expect(made).toEqual(['/builds/', '/builds/next/']);
  });

  it('names its databases and locks after its base', () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    expect(storageName('game-data')).toBe('/playcanvas-quake3/game-data');
    vi.stubEnv('BASE_URL', '/builds/next/');
    expect(storageName('game-data')).toBe('/builds/next/game-data');
  });
});
