import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dumpFolder,
  homeFolders,
  homePath,
  opfsHome,
  routeHome,
  searchFolders,
  type HomeFolder
} from './home-folder';

/** A folder of files in memory, by path, which takes a write unless `writable` is false. */
function memoryHome(files: Record<string, string>, writable = true): HomeFolder {
  return {
    read: async (path) => files[path],
    list: async (dir, extension) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => name.endsWith(extension))
        .sort(),
    write: async (path, text) => {
      if (writable) files[path] = text;
      return writable;
    }
  };
}

/** A folder in fake OPFS: its files by name, and its folders. */
interface FakeFolder {
  files?: Record<string, string>;
  folders?: Record<string, FakeFolder>;
}

/**
 * OPFS in memory, as much of it as the folder uses, with `root` at its root. A write lands in
 * `root` as the writable closes.
 */
function fakeOpfs(root: FakeFolder) {
  const handle = (folder: FakeFolder, name: string): object => ({
    kind: 'directory',
    name,
    async getDirectoryHandle(child: string, options?: { create: boolean }) {
      if (!folder.folders?.[child] && options?.create) (folder.folders ??= {})[child] = {};
      const found = folder.folders?.[child];
      if (!found) throw new DOMException(child, 'NotFoundError');
      return handle(found, child);
    },
    async getFileHandle(child: string, options?: { create: boolean }) {
      if (folder.files?.[child] === undefined && options?.create) (folder.files ??= {})[child] = '';
      const text = folder.files?.[child];
      if (text === undefined) throw new DOMException(child, 'NotFoundError');
      return {
        getFile: async () => new Blob([text]),
        async createWritable() {
          let written = '';
          return {
            write: async (part: string) => void (written += part),
            close: async () => void (folder.files![child] = written)
          };
        }
      };
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

  it('lists the files with an extension directly in a folder, none in a missing one', async () => {
    fakeOpfs({
      files: { 'q3config.cfg': '' },
      folders: {
        presets: {
          files: { 'pmc.cfg': '', 'Mine.CFG': '', 'notes.txt': '', 'Dump.TXT': '' },
          folders: { old: { files: { 'vq3.cfg': '' } }, 'folder.cfg': {} }
        }
      }
    });
    expect(await opfsHome.list('presets', '.cfg')).toEqual(['Mine.CFG', 'pmc.cfg']);
    expect(await opfsHome.list('presets', '.txt')).toEqual(['Dump.TXT', 'notes.txt']);
    expect(await opfsHome.list('', '.cfg')).toEqual(['q3config.cfg']);
    expect(await opfsHome.list('presets/old', '.cfg')).toEqual(['vq3.cfg']);
    expect(await opfsHome.list('missing', '.cfg')).toEqual([]);
  });

  it('writes a file, making the folders it is in, and replaces one that is there', async () => {
    const root: FakeFolder = { files: { 'q3config.cfg': 'unbindall\n' } };
    fakeOpfs(root);
    expect(await opfsHome.write('mine.cfg', 'seta a "1"\n')).toBe(true);
    expect(await opfsHome.write('sub/deeper/dump.txt', 'text\r\n')).toBe(true);
    expect(await opfsHome.write('q3config.cfg', 'bind x "+attack"\n')).toBe(true);
    expect(root).toEqual({
      files: { 'q3config.cfg': 'bind x "+attack"\n', 'mine.cfg': 'seta a "1"\n' },
      folders: { sub: { folders: { deeper: { files: { 'dump.txt': 'text\r\n' } } } } }
    });
    expect(await opfsHome.read('sub/deeper/dump.txt')).toBe('text\r\n');
  });

  it("writes nothing where a write can't be made", async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => {
            throw new TypeError('Name is not allowed.');
          }
        })
      }
    });
    expect(await opfsHome.write('./mine.cfg', '')).toBe(false);
  });

  it('passes over OPFS where the browser has none', async () => {
    vi.stubGlobal('navigator', {});
    expect(await opfsHome.read('presets/cpm.cfg')).toBeUndefined();
    expect(await opfsHome.list('presets', '.cfg')).toEqual([]);
    expect(await opfsHome.write('mine.cfg', '')).toBe(false);
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
      expect(await opfsHome.list('', '.cfg')).toEqual(['q3config.cfg']);
      expect(await opfsHome.list('presets', '.cfg')).toEqual(['cpm.cfg']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the home folder over its route', () => {
  it('asks for a file and a listing by their paths, each name encoded', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/')
        ? Response.json(['Dump.TXT', 'cpm.cfg', 'my rules.cfg'])
        : new Response('seta a "1"\n')
    );
    const home = routeHome(fetcher);
    expect(await home.read('presets/my rules.cfg')).toBe('seta a "1"\n');
    expect(fetcher).toHaveBeenLastCalledWith('/homepath/presets/my%20rules.cfg', { cache: 'no-store' });
    expect(await home.list('presets', '.cfg')).toEqual(['cpm.cfg', 'my rules.cfg']);
    expect(fetcher).toHaveBeenLastCalledWith('/homepath/presets/', { cache: 'no-store' });
    // The route lists both kinds of file, and the one asked for is kept.
    expect(await home.list('presets', '.txt')).toEqual(['Dump.TXT']);
    await home.list('', '.cfg');
    expect(fetcher).toHaveBeenLastCalledWith('/homepath/', { cache: 'no-store' });
  });

  it('reads nothing from a route with no file, or no route', async () => {
    const missing = routeHome(async () => new Response('not found', { status: 404 }));
    expect(await missing.read('presets/cpm.cfg')).toBeUndefined();
    expect(await missing.list('presets', '.cfg')).toEqual([]);
    // `q3config.cfg`'s own route answers 204 before there is one.
    expect(await routeHome(async () => new Response(null, { status: 204 })).read('q3config.cfg')).toBeUndefined();
    const offline = routeHome(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await offline.read('presets/cpm.cfg')).toBeUndefined();
    expect(await offline.list('presets', '.cfg')).toEqual([]);
    const notAList = routeHome(async () => Response.json({ paks: [] }));
    expect(await notAList.list('presets', '.cfg')).toEqual([]);
  });

  it('writes a file with a PUT of its text, by its path, each name encoded', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await routeHome(fetcher).write('sub/my dump.txt', 'line\r\n')).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/homepath/sub/my%20dump.txt', {
      method: 'PUT',
      body: 'line\r\n',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  });

  it('writes nothing where the route refuses, or there is no route', async () => {
    expect(await routeHome(async () => new Response('not found', { status: 404 })).write('a.cfg', '')).toBe(false);
    const offline = routeHome(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await offline.write('a.cfg', '')).toBe(false);
  });
});

describe('homePath', () => {
  it('takes a backslash as a slash, a run of them as one, and none leading, as FS_BuildOSPath', () => {
    expect(homePath('mine.cfg')).toBe('mine.cfg');
    expect(homePath('sub\\mine.cfg')).toBe('sub/mine.cfg');
    expect(homePath('/sub//\\deeper/mine.cfg')).toBe('sub/deeper/mine.cfg');
    expect(homePath('\\\\mine.cfg')).toBe('mine.cfg');
    // Left as they are, for the writes' own check.
    expect(homePath('../mine.cfg')).toBe('../mine.cfg');
    expect(homePath('a..b.cfg')).toBe('a..b.cfg');
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
      memoryHome({ 'presets/cpm.cfg': 'first', 'presets/mine.cfg': '', 'presets/a.txt': '' }),
      memoryHome({ 'presets/cpm.cfg': 'second', 'presets/pmc.cfg': 'only', 'presets/b.txt': '' })
    ]);
    expect(await home.read('presets/cpm.cfg')).toBe('first');
    expect(await home.read('presets/pmc.cfg')).toBe('only');
    expect(await home.read('presets/vq3.cfg')).toBeUndefined();
    expect(await home.list('presets', '.cfg')).toEqual(['cpm.cfg', 'mine.cfg', 'pmc.cfg']);
    expect(await home.list('presets', '.txt')).toEqual(['a.txt', 'b.txt']);
  });

  it('writes a file to every place, and has written it once every one has it', async () => {
    const first: Record<string, string> = {};
    const second: Record<string, string> = {};
    expect(await searchFolders([memoryHome(first), memoryHome(second)]).write('a.cfg', 'x')).toBe(true);
    expect([first, second]).toEqual([{ 'a.cfg': 'x' }, { 'a.cfg': 'x' }]);

    const kept: Record<string, string> = {};
    expect(await searchFolders([memoryHome({}, false), memoryHome(kept)]).write('b.cfg', 'y')).toBe(false);
    // The place that could take it still has it.
    expect(kept).toEqual({ 'b.cfg': 'y' });
  });
});

describe('where the console is dumped', () => {
  it('is the folder over its route in the shell and in dev', async () => {
    const download = vi.fn();
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    for (const [dev, shell] of [
      [true, false],
      [false, true],
      [true, true]
    ]) {
      expect(await dumpFolder(dev, shell, download).write('sub/dump.txt', 'text')).toBe(true);
      expect(fetcher).toHaveBeenLastCalledWith('/homepath/sub/dump.txt', expect.objectContaining({ method: 'PUT' }));
    }
    expect(download).not.toHaveBeenCalled();
  });

  it("is a download in a build, named by the path's last name", async () => {
    const download = vi.fn();
    expect(await dumpFolder(false, false, download).write('sub/dump.txt', 'text\r\n')).toBe(true);
    expect(download).toHaveBeenCalledWith('dump.txt', 'text\r\n');
    await dumpFolder(false, false, download).write('top.txt', '');
    expect(download).toHaveBeenLastCalledWith('top.txt', '');
  });
});
