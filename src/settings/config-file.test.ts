// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIG_ROUTE,
  exportConfigFile,
  FAVORITES_TXT,
  homeStores,
  keepFile,
  opfsFile,
  pickConfigFile,
  Q3CONFIG_CFG,
  readKeptFile,
  routeFile,
  type FileStore
} from './config-file';
import { GameConfig } from './game-config';

/** A store that keeps what it is given, and can be made to hold a write open. */
function memoryStore(text?: string) {
  const writes: string[] = [];
  let hold: Promise<void> | null = null;
  const store: FileStore & { writes: string[]; holdWrites(): () => void } = {
    writes,
    read: async () => text,
    async write(next) {
      writes.push(next);
      text = next;
      await hold;
      return true;
    },
    holdWrites() {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    }
  };
  return store;
}

/**
 * OPFS in memory, as much of it as the store uses: the root's files by name, and the files of each
 * folder in it by the folder's name.
 */
function fakeOpfs() {
  const folders = new Map<string, Map<string, string>>();
  const folder = (files: Map<string, string>) => ({
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      if (!folders.has(name) && !options?.create) throw new DOMException(name, 'NotFoundError');
      if (!folders.has(name)) folders.set(name, new Map());
      return folder(folders.get(name)!);
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) throw new DOMException(name, 'NotFoundError');
      return {
        getFile: async () => new Blob([files.get(name) ?? '']),
        async createWritable() {
          let text = '';
          return {
            write: async (data: string) => void (text += data),
            close: async () => void files.set(name, text)
          };
        }
      };
    }
  });
  const files = new Map<string, string>();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => folder(files) } });
  return Object.assign(files, { folders });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the stores', () => {
  it('reads the first store that has the file, as dev reads its app-data copy first', async () => {
    expect(await readKeptFile([memoryStore(), memoryStore('a'), memoryStore('b')])).toBe('a');
    expect(await readKeptFile([memoryStore()])).toBeUndefined();
  });

  it('keeps the file in fs_homepath alone in the shell, and OPFS behind it in dev', async () => {
    const files = fakeOpfs();
    files.set(Q3CONFIG_CFG, 'opfs');
    const fetcher = vi.fn(async () => new Response('route'));
    vi.stubGlobal('fetch', fetcher);
    const read = (stores: FileStore[]) => Promise.all(stores.map((store) => store.read()));
    expect(await read(homeStores(Q3CONFIG_CFG, false, true))).toEqual(['route']);
    // `npm run shell` is dev and the shell at once, and keeps the one file.
    expect(await read(homeStores(Q3CONFIG_CFG, true, true))).toEqual(['route']);
    expect(await read(homeStores(Q3CONFIG_CFG, true))).toEqual(['route', 'opfs']);
    expect(await read(homeStores(Q3CONFIG_CFG, false))).toEqual(['opfs']);
    expect(fetcher).toHaveBeenCalledWith(CONFIG_ROUTE, expect.anything());
  });

  it("keeps the file in the build's folder in OPFS, below its base", async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    const files = fakeOpfs();
    files.set(Q3CONFIG_CFG, 'another build');
    expect(await opfsFile(Q3CONFIG_CFG).read()).toBeUndefined();
    expect(await opfsFile(Q3CONFIG_CFG).write('this build')).toBe(true);
    expect(await opfsFile(Q3CONFIG_CFG).read()).toBe('this build');
    expect(files.get(Q3CONFIG_CFG)).toBe('another build');
    expect(files.folders.get('playcanvas-quake3')?.get(Q3CONFIG_CFG)).toBe('this build');
  });

  it('keeps the favourites beside it, by their own name', async () => {
    const files = fakeOpfs();
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await opfsFile(FAVORITES_TXT).write('10.0.0.5:27960 "Office"\n')).toBe(true);
    expect([...files.keys()]).toEqual(['favorites.txt']);
    await routeFile(FAVORITES_TXT, fetcher).write('x');
    expect(fetcher).toHaveBeenCalledWith(
      '/homepath/favorites.txt',
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('reads the favourites from the same stores as the config, each by its own name', async () => {
    const files = fakeOpfs();
    files.set(Q3CONFIG_CFG, 'opfs config');
    files.set(FAVORITES_TXT, 'opfs favourites');
    vi.stubGlobal('fetch', async (url: string) => new Response(`route ${url}`));
    const read = (stores: FileStore[]) => Promise.all(stores.map((store) => store.read()));
    const route = 'route /homepath/favorites.txt';
    expect(await read(homeStores(FAVORITES_TXT, false, true))).toEqual([route]);
    expect(await read(homeStores(FAVORITES_TXT, true))).toEqual([route, 'opfs favourites']);
    expect(await read(homeStores(FAVORITES_TXT, false))).toEqual(['opfs favourites']);
  });

  it('keeps the file in OPFS', async () => {
    const files = fakeOpfs();
    const opfsConfig = opfsFile(Q3CONFIG_CFG);
    expect(await opfsConfig.read()).toBeUndefined();
    expect(await opfsConfig.write('unbindall\n')).toBe(true);
    expect(files.get('q3config.cfg')).toBe('unbindall\n');
    expect(await opfsConfig.read()).toBe('unbindall\n');
  });

  it('passes over OPFS where the browser has none', async () => {
    vi.stubGlobal('navigator', {});
    expect(await opfsFile(Q3CONFIG_CFG).read()).toBeUndefined();
    expect(await opfsFile(Q3CONFIG_CFG).write('x')).toBe(false);
  });

  it("reads and writes the dev server's copy over its route", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT' ? new Response(null, { status: 204 }) : new Response('seta a "1"\n')
    );
    const store = routeFile(Q3CONFIG_CFG, fetcher);
    expect(await store.read()).toBe('seta a "1"\n');
    expect(await store.write('unbindall\n')).toBe(true);
    expect(fetcher).toHaveBeenLastCalledWith(CONFIG_ROUTE, expect.objectContaining({ method: 'PUT', body: 'unbindall\n' }));
  });

  it('reads nothing from a route with no file, or no route', async () => {
    const answering = (response: Response) => routeFile(Q3CONFIG_CFG, async () => response);
    expect(await answering(new Response(null, { status: 204 })).read()).toBeUndefined();
    expect(await answering(new Response('Not found', { status: 404 })).read()).toBeUndefined();
    const offline = routeFile(Q3CONFIG_CFG, async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await offline.read()).toBeUndefined();
    expect(await offline.write('x')).toBe(false);
  });
});

describe('keepFile', () => {
  it('writes a first run at once, to every store', async () => {
    const config = new GameConfig({ debugMode: true });
    const stores = [memoryStore(), memoryStore()];
    await keepFile(config, stores).settled();
    expect(stores.map((store) => store.writes)).toEqual([[config.text()], [config.text()]]);
  });

  it('leaves a file that already says what the config would', async () => {
    const config = new GameConfig({ debugMode: true });
    const store = memoryStore(config.text());
    await keepFile(config, [store], config.text()).settled();
    expect(store.writes).toEqual([]);
  });

  it('writes the changes made together once', async () => {
    const config = new GameConfig({ debugMode: true });
    const store = memoryStore();
    const keeper = keepFile(config, [store], config.text());
    config.command(['cg_fov', '100']);
    config.command(['bind', 'CTRL', '+attack']);
    await keeper.settled();
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toContain('seta cg_fov "100"');
    expect(store.writes[0]).toContain('bind CTRL "+attack"');
  });

  it('writes a change made during a write once that write is done', async () => {
    const config = new GameConfig({ debugMode: true });
    const store = memoryStore();
    const keeper = keepFile(config, [store], config.text());
    const release = store.holdWrites();
    config.command(['cg_fov', '100']);
    await Promise.resolve();
    config.command(['cg_fov', '110']);
    expect(store.writes).toHaveLength(1);
    release();
    await keeper.settled();
    expect(store.writes).toHaveLength(2);
    expect(store.writes[1]).toContain('seta cg_fov "110"');
  });

  it('writes nothing once stopped', async () => {
    const config = new GameConfig({ debugMode: true });
    const store = memoryStore();
    const keeper = keepFile(config, [store], config.text());
    keeper.stop();
    config.command(['cg_fov', '100']);
    await keeper.settled();
    expect(store.writes).toEqual([]);
  });
});

describe('export and import', () => {
  it('hands the file over as a q3config.cfg download', async () => {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => (blobs.push(blob), 'blob:q3config')
    });
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    let clicked: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
    });

    exportConfigFile('unbindall\n');
    expect(clicked?.download).toBe('q3config.cfg');
    expect(clicked?.href).toBe('blob:q3config');
    expect(await blobs[0].text()).toBe('unbindall\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoke).toHaveBeenCalledWith('blob:q3config');
  });

  it('reads the file the player picks, or nothing if they cancel', async () => {
    let input: HTMLInputElement | undefined;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      input = this;
    });

    const picked = pickConfigFile();
    expect(input?.type).toBe('file');
    Object.defineProperty(input!, 'files', { value: [new File(['seta cg_fov "100"\n'], 'q3config.cfg')] });
    input!.dispatchEvent(new Event('change'));
    expect(await picked).toBe('seta cg_fov "100"\n');

    const cancelled = pickConfigFile();
    input!.dispatchEvent(new Event('cancel'));
    expect(await cancelled).toBeUndefined();
  });
});
