import { afterEach, describe, expect, it, vi } from 'vitest';

import { homeFolders, opfsHome, routeHome, searchFolders, type HomeFolder } from './home-folder';

/** A folder of files in memory, by path. */
function memoryHome(files: Record<string, string>): HomeFolder {
  return {
    read: async (path) => files[path],
    list: async (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
        .map((path) => path.slice(dir.length + 1))
        .sort()
  };
}

/** A folder in fake OPFS: its files by name, and its folders. */
interface FakeFolder {
  files?: Record<string, string>;
  folders?: Record<string, FakeFolder>;
}

/** OPFS in memory, as much of it as the folder uses, with `root` at its root. */
function fakeOpfs(root: FakeFolder) {
  const handle = (folder: FakeFolder, name: string): object => ({
    kind: 'directory',
    name,
    async getDirectoryHandle(child: string) {
      const found = folder.folders?.[child];
      if (!found) throw new DOMException(child, 'NotFoundError');
      return handle(found, child);
    },
    async getFileHandle(child: string) {
      const text = folder.files?.[child];
      if (text === undefined) throw new DOMException(child, 'NotFoundError');
      return { getFile: async () => new Blob([text]) };
    },
    async *values() {
      for (const child of Object.keys(folder.files ?? {})) yield { kind: 'file', name: child };
      for (const [child, found] of Object.entries(folder.folders ?? {})) yield handle(found, child);
    }
  });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => handle(root, '') } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the home folder in OPFS', () => {
  it('reads a file below the root, walking its folders, and nothing where there is none', async () => {
    fakeOpfs({
      files: { 'q3config.cfg': 'unbindall\n' },
      folders: { presets: { files: { 'cpm.cfg': 'seta g_gamepreset "CPM"\n' } } }
    });
    expect(await opfsHome.read('presets/cpm.cfg')).toBe('seta g_gamepreset "CPM"\n');
    expect(await opfsHome.read('q3config.cfg')).toBe('unbindall\n');
    expect(await opfsHome.read('presets/pmc.cfg')).toBeUndefined();
    expect(await opfsHome.read('missing/cpm.cfg')).toBeUndefined();
  });

  it('lists the cfgs directly in a folder, and none for a folder there is none of', async () => {
    fakeOpfs({
      files: { 'q3config.cfg': '' },
      folders: {
        presets: {
          files: { 'pmc.cfg': '', 'Mine.CFG': '', 'notes.txt': '' },
          folders: { old: { files: { 'vq3.cfg': '' } }, 'folder.cfg': {} }
        }
      }
    });
    expect(await opfsHome.list('presets')).toEqual(['Mine.CFG', 'pmc.cfg']);
    expect(await opfsHome.list('')).toEqual(['q3config.cfg']);
    expect(await opfsHome.list('presets/old')).toEqual(['vq3.cfg']);
    expect(await opfsHome.list('missing')).toEqual([]);
  });

  it('passes over OPFS where the browser has none', async () => {
    vi.stubGlobal('navigator', {});
    expect(await opfsHome.read('presets/cpm.cfg')).toBeUndefined();
    expect(await opfsHome.list('presets')).toEqual([]);
  });

  it("is the build's folder, below its base, and not the origin's root", async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    fakeOpfs({
      files: { 'q3config.cfg': 'another build\n', 'other.cfg': '' },
      folders: {
        'playcanvas-quake3': {
          files: { 'q3config.cfg': 'this build\n' },
          folders: { presets: { files: { 'cpm.cfg': '' } } }
        }
      }
    });
    try {
      expect(await opfsHome.read('q3config.cfg')).toBe('this build\n');
      expect(await opfsHome.list('')).toEqual(['q3config.cfg']);
      expect(await opfsHome.list('presets')).toEqual(['cpm.cfg']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the home folder over its route', () => {
  it('asks for a file and a listing by their paths, each name encoded', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/') ? Response.json(['cpm.cfg', 'my rules.cfg']) : new Response('seta a "1"\n')
    );
    const home = routeHome(fetcher);
    expect(await home.read('presets/my rules.cfg')).toBe('seta a "1"\n');
    expect(fetcher).toHaveBeenLastCalledWith('/homepath/presets/my%20rules.cfg', { cache: 'no-store' });
    expect(await home.list('presets')).toEqual(['cpm.cfg', 'my rules.cfg']);
    expect(fetcher).toHaveBeenLastCalledWith('/homepath/presets/', { cache: 'no-store' });
    await home.list('');
    expect(fetcher).toHaveBeenLastCalledWith('/homepath/', { cache: 'no-store' });
  });

  it('reads nothing from a route with no file, or no route', async () => {
    const missing = routeHome(async () => new Response('not found', { status: 404 }));
    expect(await missing.read('presets/cpm.cfg')).toBeUndefined();
    expect(await missing.list('presets')).toEqual([]);
    // `q3config.cfg`'s own route answers 204 before there is one.
    expect(await routeHome(async () => new Response(null, { status: 204 })).read('q3config.cfg')).toBeUndefined();
    const offline = routeHome(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await offline.read('presets/cpm.cfg')).toBeUndefined();
    expect(await offline.list('presets')).toEqual([]);
    expect(await routeHome(async () => Response.json({ paks: [] })).list('presets')).toEqual([]);
  });
});

describe('the places the folder is kept', () => {
  it('reads fs_homepath alone in the shell, OPFS behind it in dev, and OPFS alone in a build', () => {
    const shell = homeFolders(false, true);
    expect(shell).toHaveLength(1);
    expect(shell).not.toContain(opfsHome);
    expect(homeFolders(true, true)).toHaveLength(1);
    expect(homeFolders(true)).toHaveLength(2);
    expect(homeFolders(true)[1]).toBe(opfsHome);
    expect(homeFolders(false)).toEqual([opfsHome]);
  });

  it('reads a file from the first place that has it, and lists what any of them has', async () => {
    const home = searchFolders([
      memoryHome({ 'presets/cpm.cfg': 'first', 'presets/mine.cfg': '' }),
      memoryHome({ 'presets/cpm.cfg': 'second', 'presets/pmc.cfg': 'only' })
    ]);
    expect(await home.read('presets/cpm.cfg')).toBe('first');
    expect(await home.read('presets/pmc.cfg')).toBe('only');
    expect(await home.read('presets/vq3.cfg')).toBeUndefined();
    expect(await home.list('presets')).toEqual(['cpm.cfg', 'mine.cfg', 'pmc.cfg']);
  });
});
