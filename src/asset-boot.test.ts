// @vitest-environment jsdom
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assetActivity,
  assetProgress,
  bootAssets,
  describeAssetStatus,
  type AssetBootOptions,
  type AssetBootStatus
} from './asset-boot';
import { AssetLibrary } from './formats/asset-library';
import {
  fakeFolder,
  fakeInstallFolder,
  fakeLocks,
  memoryKeptStore,
  type FakePermission
} from './pak/folder-test-fixtures';
import { webLock } from './pak/game-data';
import { fakeDevServer, memoryCacheStore } from './pak/pak-test-fixtures';
import type { PakFileSystem } from './pak/vfs';

/** A status as one comparable word: the phase, and the pak phase under it. */
const phase = (status: AssetBootStatus) =>
  status.phase === 'paks' ? `paks:${status.pak.phase}` : status.phase;

/** A pak holding one file the manifest names. */
const pak0 = () => zipSync({ 'sound/weapons/change.wav': new TextEncoder().encode('RIFF') });
/** That file, counted as the only one of its set. */
const ONE_FILE = { done: 1, total: 1, path: 'sound/weapons/change.wav' };
/** That pak as a file, in a folder or on the drop screen. */
const pak0File = () => new File([new Uint8Array(pak0())], 'pak0.pk3');
/** An install folder holding it, whose permission answers as given. */
const install = (permission?: FakePermission) =>
  fakeInstallFolder('ioquake', [fakeFolder('baseq3', [pak0File()])], permission);

/** Choose files on the drop screen, as its file picker does. */
function pick(host: HTMLElement, files: File[]): void {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

/** Start a boot, with a host for its drop screen and a list of its statuses. */
function boot(options: AssetBootOptions) {
  const host = document.createElement('div');
  const statuses: AssetBootStatus[] = [];
  const done = bootAssets(host, (status) => statuses.push(status), options);
  return { host, statuses, done };
}

afterEach(() => vi.unstubAllGlobals());

describe('bootAssets', () => {
  it('reads the dev install in place and never consults what the browser kept', async () => {
    vi.stubGlobal('fetch', fakeDevServer({ 'pak0.pk3': pak0() }));
    const store = memoryCacheStore();
    const mounted: { paks: PakFileSystem; after: number }[] = [];
    const { host, statuses, done } = boot({
      store,
      kept: memoryKeptStore(install()),
      onMounted: (paks) => mounted.push({ paks, after: statuses.length })
    });

    const { library } = await done;
    expect(library.read('sound/weapons/change.wav')).toBeDefined();
    // The paks it reads, for the search path to put over the map's, told once they are mounted
    // and before anything is extracted from them.
    expect(mounted).toHaveLength(1);
    expect(mounted[0].paks.mounted.map((pak) => pak.label)).toEqual(['pak0.pk3']);
    expect(statuses.slice(0, mounted[0].after).map(phase)).toEqual([
      'paks:discovering',
      'paks:loading',
      'paks:ready'
    ]);
    expect(statuses.map(phase)).toEqual([
      'paks:discovering',
      'paks:loading',
      'paks:ready',
      'extracting',
      'ready'
    ]);
    // The file read, with nothing to keep after it.
    expect(statuses[3]).toEqual({ phase: 'extracting', read: ONE_FILE, keeps: false });
    expect(statuses.at(-1)).toMatchObject({ source: 'install' });
    expect(host.querySelector('.pak-drop')).toBeNull();
    expect(store.files.size).toBe(0);
  });

  it('checks what was kept and then asks for a pak when there is no install', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const { host, statuses } = boot({ store: memoryCacheStore() });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop')).not.toBeNull());
    expect(statuses.map(phase)).toEqual(['paks:discovering', 'kept', 'paks:waiting-for-drop']);
  });

  it('keeps what a drop brought, and a later visit boots from it without asking', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = memoryCacheStore();

    const first = boot({ store });
    await vi.waitFor(() => expect(first.host.querySelector('.pak-drop')).not.toBeNull());
    pick(first.host, [pak0File()]);
    expect((await first.done).library.read('sound/weapons/change.wav')).toBeDefined();
    expect(first.statuses.map(phase).slice(-5)).toEqual([
      'paks:ready',
      'extracting',
      'keeping',
      'keeping',
      'ready'
    ]);
    // The file read, then copied into the cache.
    expect(first.statuses.slice(-4, -1)).toEqual([
      { phase: 'extracting', read: ONE_FILE, keeps: true },
      { phase: 'keeping' },
      { phase: 'keeping', copied: ONE_FILE }
    ]);
    expect(first.statuses.at(-1)).toMatchObject({ source: 'paks' });

    const told: PakFileSystem[] = [];
    const later = boot({ store, onMounted: (paks) => told.push(paks) });
    expect((await later.done).library.read('sound/weapons/change.wav')).toBeDefined();
    // From the cache, the player's paks are its one pak.
    expect(told.map((paks) => paks.mounted.length)).toEqual([1]);
    expect(later.statuses.map(phase)).toEqual(['paks:discovering', 'kept', 'extracting', 'ready']);
    expect(later.statuses.at(-1)).toMatchObject({ source: 'cache' });
    expect(later.host.querySelector('.pak-drop')).toBeNull();
  });

  it('reads a kept install folder where it sits, with nothing cached and no drop screen', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = memoryCacheStore();
    const { host, statuses, done } = boot({ store, kept: memoryKeptStore(install()) });

    expect((await done).library.read('sound/weapons/change.wav')).toBeDefined();
    expect(statuses.at(-1)).toMatchObject({ source: 'folder' });
    expect(host.querySelector('.pak-drop')).toBeNull();
    expect(store.files.size).toBe(0);
  });

  it('offers a kept folder on the drop screen when its permission wants a click', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const folder = install({ now: 'prompt', asked: 'granted' });
    const { host, statuses, done } = boot({
      store: memoryCacheStore(),
      kept: memoryKeptStore(folder)
    });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop-kept')).not.toBeNull());
    host.querySelector<HTMLElement>('.pak-drop-kept')!.click();

    expect((await done).library.read('sound/weapons/change.wav')).toBeDefined();
    expect(folder.requests).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ source: 'folder' });
  });

  it('keeps a folder picked on the drop screen, and removes the cache', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    // A cache from another build: no use to this one, but still in storage.
    const store = memoryCacheStore();
    store.files.set('assets.pk3', new Blob(['old']));
    store.files.set('assets.json', new Blob(['{"version":"v0"}']));
    const kept = memoryKeptStore();
    const folder = install();
    const { host, statuses, done } = boot({ store, kept, picker: async () => folder });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop-folder')).not.toBeNull());
    host.querySelector<HTMLElement>('.pak-drop-folder')!.click();
    await done;

    expect(statuses.at(-1)).toMatchObject({ source: 'folder' });
    expect(kept.folder).toBe(folder);
    await vi.waitFor(() => expect(store.files.size).toBe(0));
    expect(kept.marked).toBe(false);
  });

  it('forgets a kept folder when paks are dropped instead', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = memoryCacheStore();
    const kept = memoryKeptStore(install({ now: 'prompt' }));
    const { host, done } = boot({ store, kept });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop')).not.toBeNull());
    pick(host, [pak0File()]);
    await done;

    expect(kept.folder).toBeUndefined();
    expect(store.files.has('assets.pk3')).toBe(true);
  });

  it('shows no drop screen in the shell, keeps nothing, and fails without an install', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const { host, statuses, done } = boot({ shell: true });

    await expect(done).rejects.toThrow('no pk3 files in the Quake 3 install');
    expect(host.querySelector('.pak-drop')).toBeNull();
    expect(statuses.map(phase)).toEqual(['paks:discovering', 'error']);
  });

  it('asks no server for an install in a web build, and goes to what was kept', async () => {
    const fetcher = vi.fn(fakeDevServer({ 'pak0.pk3': pak0() }));
    vi.stubGlobal('fetch', fetcher);
    const { host, statuses } = boot({ dev: false, store: memoryCacheStore() });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop')).not.toBeNull());
    expect(fetcher).not.toHaveBeenCalled();
    expect(statuses.map(phase)).toEqual(['kept', 'paks:waiting-for-drop']);
  });

  it("reads the shell's install in place in the shell's build", async () => {
    vi.stubGlobal('fetch', fakeDevServer({ 'pak0.pk3': pak0() }));
    const { statuses, done } = boot({ shell: true, dev: false });

    expect((await done).library.read('sound/weapons/change.wav')).toBeDefined();
    expect(statuses.at(-1)).toMatchObject({ source: 'install' });
  });
});

describe('bootAssets: where the game data came from', () => {
  /** A cache kept from a drop, as a later visit finds it. */
  async function cached() {
    const store = memoryCacheStore();
    const first = boot({ store });
    await vi.waitFor(() => expect(first.host.querySelector('.pak-drop')).not.toBeNull());
    pick(first.host, [pak0File()]);
    await first.done;
    return store;
  }

  it('names the dev server, or the shell, with nothing the browser keeps', async () => {
    vi.stubGlobal('fetch', fakeDevServer({ 'pak0.pk3': pak0() }));
    const dev = (await boot({ kept: memoryKeptStore() }).done).gameData;
    expect(dev.source).toEqual({ kind: 'dev', paks: 1 });
    expect(dev.record).toBeUndefined();
    expect(dev.install).toBeUndefined();

    const shell = (await boot({ shell: true }).done).gameData;
    expect(shell.source).toEqual({ kind: 'shell', paks: 1 });
    expect(shell.record).toBeUndefined();
    expect(shell.install).toBeDefined();
  });

  it('names a kept folder, with its handle', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const folder = install();
    const { gameData } = await boot({ store: memoryCacheStore(), kept: memoryKeptStore(folder) }).done;
    expect(gameData.source).toEqual({ kind: 'folder', paks: 1, folder });
    expect(gameData.record).toBeDefined();
  });

  it('names dropped paks with the cache they wrote, and the cache a later visit reads', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = memoryCacheStore();
    const first = boot({ store, kept: memoryKeptStore() });
    await vi.waitFor(() => expect(first.host.querySelector('.pak-drop')).not.toBeNull());
    pick(first.host, [pak0File()]);
    const dropped = (await first.done).gameData.source;
    expect(dropped).toMatchObject({ kind: 'paks', paks: 1, cache: { paks: [{ name: 'pak0.pk3' }] } });

    const later = (await boot({ store, kept: memoryKeptStore() }).done).gameData.source;
    expect(later).toMatchObject({ kind: 'cache', paks: 1, cache: { paks: [{ name: 'pak0.pk3' }] } });
  });

  it('never opens a cache marked to be cleared: it asks, and the cache goes', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = await cached();
    const kept = memoryKeptStore(undefined, true);
    const { host } = boot({ store, kept });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop')).not.toBeNull());
    await vi.waitFor(() => expect(store.files.size).toBe(0));
    expect(kept.marked).toBe(false);
  });

  it('clears a marked cache once a kept folder has mounted', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = await cached();
    const kept = memoryKeptStore(install(), true);
    const { gameData } = await boot({ store, kept }).done;

    expect(gameData.source.kind).toBe('folder');
    await vi.waitFor(() => expect(store.files.size).toBe(0));
  });

  it('keeps a marked cache while a kept folder waits for its permission', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = await cached();
    const { host } = boot({ store, kept: memoryKeptStore(install({ now: 'prompt' }), true) });

    await vi.waitFor(() => expect(host.querySelector('.pak-drop-kept')).not.toBeNull());
    expect(store.files.size).toBe(2);
  });

  it('holds the lock shared while it reads from the cache, and lets go of one it could not open', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = await cached();
    const locks = fakeLocks();
    await boot({ store, lock: webLock(locks) }).done;
    expect(locks.held()).toEqual(['shared']);

    const stale = memoryCacheStore();
    stale.files.set('assets.json', new Blob(['{"version":"v0"}']));
    const others = fakeLocks();
    const { host } = boot({ store: stale, lock: webLock(others) });
    await vi.waitFor(() => expect(host.querySelector('.pak-drop')).not.toBeNull());
    expect(others.held()).toEqual([]);
  });

  it('goes on while another tab reads the cache, and writes the drop once it lets go', async () => {
    vi.stubGlobal('fetch', fakeDevServer({}));
    const store = memoryCacheStore();
    const lock = webLock(fakeLocks());
    // The other tab, reading a cache from another build.
    const release = await lock.share();
    store.files.set('assets.json', new Blob(['{"version":"v0"}']));
    const kept = memoryKeptStore(undefined, true);

    const { host, done } = boot({ store, kept, lock });
    await vi.waitFor(() => expect(host.querySelector('.pak-drop')).not.toBeNull());
    pick(host, [pak0File()]);
    const { gameData } = await done;
    expect(gameData.source).toEqual({ kind: 'paks', paks: 1 });
    expect(store.files.has('assets.pk3')).toBe(false);
    expect(kept.marked).toBe(true);

    release();
    await vi.waitFor(() => expect(store.files.has('assets.pk3')).toBe(true));
    await vi.waitFor(() => expect(kept.marked).toBe(false));
    expect(gameData.source).toMatchObject({ kind: 'paks', cache: { paks: [{ name: 'pak0.pk3' }] } });
  });
});

describe('describeAssetStatus', () => {
  const library = new AssetLibrary(new Map([['a.wav', new Uint8Array(1024 * 1024)]]));

  it.each([
    ['install', 'assets: 1 files, 1.0 MB from the install'],
    ['folder', 'assets: 1 files, 1.0 MB from the install folder'],
    ['cache', 'assets: 1 files, 1.0 MB from cache'],
    ['paks', 'assets: 1 files, 1.0 MB from paks']
  ] as const)('names a boot from %s', (source, line) => {
    expect(describeAssetStatus({ phase: 'ready', library, source })).toBe(line);
  });

  it('says what it is doing between the routes', () => {
    expect(describeAssetStatus({ phase: 'kept' })).toBe('assets: checking what the browser kept');
    expect(describeAssetStatus({ phase: 'keeping' })).toBe('assets: writing the cache');
  });

  it('names each file as it is read, and as it is copied into the cache', () => {
    const file = { done: 3, total: 758, path: 'models/weapons2/rocketl/rocketl.md3' };
    // Uncounted, while the manifest is worked out.
    expect(describeAssetStatus({ phase: 'finding', path: 'scripts/models.shader' })).toBe(
      'assets: reading scripts/models.shader'
    );
    expect(describeAssetStatus({ phase: 'extracting', read: file, keeps: false })).toBe(
      'assets: reading models/weapons2/rocketl/rocketl.md3 (3/758)'
    );
    // The load screen says it without the HUD's prefix.
    expect(assetActivity({ phase: 'keeping', copied: file })).toBe(
      'caching models/weapons2/rocketl/rocketl.md3 (3/758)'
    );
  });
});

describe('assetProgress', () => {
  const mounting = (index: number, total: number): AssetBootStatus => ({
    phase: 'paks',
    pak: { phase: 'loading', progress: { label: `pak${index - 1}.pk3`, index, total } }
  });

  it('moves on as the paks mount, the files are read and the cache is written', () => {
    const library = new AssetLibrary(new Map());
    const statuses: AssetBootStatus[] = [
      { phase: 'kept' },
      { phase: 'paks', pak: { phase: 'waiting-for-drop' } },
      mounting(1, 2),
      mounting(2, 2),
      { phase: 'paks', pak: { phase: 'ready', fs: {} as PakFileSystem } },
      { phase: 'keeping' },
      { phase: 'ready', library, source: 'paks' }
    ];
    expect(statuses.map(assetProgress)).toEqual([0, 0, 0.1, 0.2, 0.2, 0.8, 1]);
  });

  it('moves on file by file, to the end, or to where the cache takes over and on to the end', () => {
    const reading = (done: number, keeps: boolean): AssetBootStatus => ({
      phase: 'extracting',
      read: { done, total: 4, path: 'a.wav' },
      keeps
    });
    const copying = (done: number): AssetBootStatus => ({
      phase: 'keeping',
      copied: { done, total: 2, path: 'a.wav' }
    });
    // Working out the manifest holds it at the mount.
    expect(assetProgress({ phase: 'finding', path: 'scripts/models.shader' })).toBe(0.2);
    expect(assetProgress(reading(1, false))).toBeCloseTo(0.4);
    expect(assetProgress(reading(4, false))).toBeCloseTo(1);
    expect(assetProgress(reading(2, true))).toBeCloseTo(0.5);
    expect(assetProgress(reading(4, true))).toBeCloseTo(0.8);
    expect(assetProgress(copying(1))).toBeCloseTo(0.9);
    expect(assetProgress(copying(2))).toBeCloseTo(1);
  });

  it('is done when the boot fails, which the game goes on without, but not for a pak asked for again', () => {
    expect(assetProgress({ phase: 'error', message: 'no pk3 files in the Quake 3 install' })).toBe(1);
    expect(assetProgress({ phase: 'paks', pak: { phase: 'error', message: 'not a zip' } })).toBe(0);
  });
});
