import { zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memorySource, type ByteSource } from './byte-source';
import {
  devPakSources,
  discoverDevPaks,
  discoverMapPaks,
  filePakSources,
  fsPathCmp,
  mapPakSources,
  mountArchives,
  pakOrder
} from './mount';
import { fakeDevServer, fakeMapServer } from './pak-test-fixtures';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

const pk3 = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, encode(body)])));

const source = (label: string, files: Record<string, string>) => memorySource(label, pk3(files));

/** Bytes that open as no zip at all. */
const broken = (label: string) => memorySource(label, new Uint8Array(64));

/** A source whose reads wait `ms` first, so its archive finishes opening late. */
function slow(inner: ByteSource, ms: number): ByteSource {
  return {
    label: inner.label,
    size: inner.size,
    async read(offset, length) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return inner.read(offset, length);
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fsPathCmp', () => {
  it('ignores case and reads a backslash or colon as a slash, as FS_PathCmp does', () => {
    expect(fsPathCmp('PAK0.PK3', 'pak0.pk3')).toBe(0);
    expect(fsPathCmp('a\\b.pk3', 'a/b.pk3')).toBe(0);
    expect(fsPathCmp('a:b.pk3', 'A/B.PK3')).toBe(0);
  });

  it('sorts a prefix before the longer name', () => {
    expect(fsPathCmp('pak', 'pak0')).toBe(-1);
    expect(fsPathCmp('pak0', 'pak')).toBe(1);
  });
});

describe('pakOrder', () => {
  it("keeps only pk3s, matching the extension in any case, as ioq3's listing does", () => {
    expect(pakOrder(['pak0.pk3', 'readme.txt', 'PAK1.PK3', 'padshop.pk3.tmp'])).toEqual([
      'pak0.pk3',
      'PAK1.PK3'
    ]);
  });

  it('lets case decide nothing, because it compares upper case', () => {
    expect(pakOrder(['pak1.pk3', 'Pak2.pk3', 'PAK0.PK3'])).toEqual([
      'PAK0.PK3',
      'pak1.pk3',
      'Pak2.pk3'
    ]);
  });

  it('sorts pak10 between pak1 and pak2, as ioq3 does', () => {
    // A character comparison: '.' (0x2E) sorts before '0', and '1' before '2'.
    expect(pakOrder(['pak2.pk3', 'pak10.pk3', 'pak1.pk3'])).toEqual([
      'pak1.pk3',
      'pak10.pk3',
      'pak2.pk3'
    ]);
  });

  it('puts an underscore after every letter, which a lower-case sort would not', () => {
    // '_' is 0x5F: above 'Z' (0x5A) but below 'a' (0x61). Upper-casing makes it sort last.
    expect(pakOrder(['map_b.pk3', 'mapa.pk3', 'mapz.pk3'])).toEqual([
      'mapa.pk3',
      'mapz.pk3',
      'map_b.pk3'
    ]);
  });

  it('mounts third-party paks around the id set by name, so the last one wins', () => {
    // xccc_dm3.pk3 mounts after pak9hqq35.pk3, so its icons win.
    expect(
      pakOrder(['xccc_dm3.pk3', 'pakQ3Q.pk3', 'pak9hqq35.pk3', 'pak8.pk3', 'PAK0.PK3', 'md3-bender.pk3'])
    ).toEqual(['md3-bender.pk3', 'PAK0.PK3', 'pak8.pk3', 'pak9hqq35.pk3', 'pakQ3Q.pk3', 'xccc_dm3.pk3']);
  });
});

describe('mountArchives', () => {
  it('mounts in the order given, so the last source wins', async () => {
    const fs = await mountArchives([
      source('pak0.pk3', { 'a.txt': 'first' }),
      source('pak1.pk3', { 'a.txt': 'second' })
    ]);
    expect(decode(await fs.read('a.txt'))).toBe('second');
    expect(fs.mounted.map((a) => a.label)).toEqual(['pak0.pk3', 'pak1.pk3']);
  });

  it('keeps that order however the opens finish', async () => {
    // The first source opens last; it must still mount first.
    const fs = await mountArchives([
      slow(source('pak0.pk3', { 'a.txt': 'first' }), 20),
      source('pak1.pk3', { 'a.txt': 'second' })
    ]);
    expect(fs.mounted.map((a) => a.label)).toEqual(['pak0.pk3', 'pak1.pk3']);
    expect(decode(await fs.read('a.txt'))).toBe('second');
  });

  it('reports progress as each archive opens', async () => {
    const seen: string[] = [];
    await mountArchives(
      [source('pak0.pk3', { 'a.txt': 'x' }), source('pak1.pk3', { 'b.txt': 'y' })],
      { onProgress: (p) => seen.push(`${p.label} ${p.index}/${p.total}`), concurrency: 1 }
    );
    expect(seen).toEqual(['pak0.pk3 1/2', 'pak1.pk3 2/2']);
  });

  it("skips a pak that will not open and mounts the rest in ioq3's order", async () => {
    const paks: Record<string, ByteSource> = {
      'pak0.pk3': source('pak0.pk3', { 'a.txt': 'pak0' }),
      'broken.pk3': broken('broken.pk3'),
      'pak8.pk3': source('pak8.pk3', { 'a.txt': 'pak8' }),
      'zz-mod.pk3': source('zz-mod.pk3', { 'b.txt': 'mod' })
    };
    const skipped: string[] = [];
    const fs = await mountArchives(
      pakOrder(Object.keys(paks)).map((name) => paks[name]),
      { onSkip: (label, error) => skipped.push(`${label}: ${(error as Error).message}`) }
    );

    expect(fs.mounted.map((a) => a.label)).toEqual(['pak0.pk3', 'pak8.pk3', 'zz-mod.pk3']);
    expect(decode(await fs.read('a.txt'))).toBe('pak8');
    expect(skipped).toEqual([expect.stringMatching(/^broken\.pk3: broken\.pk3: not a zip archive/)]);
  });

  it('warns on the console about a skipped pak by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountArchives([source('pak0.pk3', { 'a.txt': 'x' }), broken('broken.pk3')]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped broken\.pk3: .*not a zip/));
  });

  it('rejects when no pak opens, naming how many were tried', async () => {
    const quiet = { onSkip: () => {} };
    await expect(mountArchives([broken('a.pk3'), broken('b.pk3')], quiet)).rejects.toThrow(
      /could not open any of the 2 pk3 files \(a\.pk3: not a zip archive/
    );
    await expect(mountArchives([broken('a.pk3')], quiet)).rejects.toThrow(
      /could not open the pk3 file \(a\.pk3: not a zip archive/
    );
    await expect(mountArchives([])).rejects.toThrow(/no pk3 files to mount/);
  });
});

describe('discoverDevPaks', () => {
  it("lists the server's paks in ioq3's order, with their sizes", async () => {
    const paks = { 'pak1.pk3': pk3({ a: '1' }), 'PAK0.PK3': pk3({ a: '0' }), 'zz.pk3': pk3({}) };
    vi.stubGlobal('fetch', fakeDevServer(paks));
    expect(await discoverDevPaks()).toEqual([
      { name: 'PAK0.PK3', size: paks['PAK0.PK3'].byteLength },
      { name: 'pak1.pk3', size: paks['pak1.pk3'].byteLength },
      { name: 'zz.pk3', size: paks['zz.pk3'].byteLength }
    ]);
  });

  it('drops listing entries that are not pk3s or are malformed', async () => {
    const listing = {
      paks: [
        { name: 'pak0.pk3', size: 10 },
        { name: 'readme.txt', size: 1 },
        { name: 'pak1.pk3' },
        'pak2.pk3',
        { name: 'pak3.pk3', size: -1 }
      ]
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(listing)));
    expect(await discoverDevPaks()).toEqual([{ name: 'pak0.pk3', size: 10 }]);
  });

  it('finds nothing without a route, with a page where JSON should be, or offline', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    expect(await discoverDevPaks()).toEqual([]);
    // A static host may answer any path with the app's index page.
    vi.stubGlobal('fetch', async () => new Response('<!doctype html>'));
    expect(await discoverDevPaks()).toEqual([]);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await discoverDevPaks()).toEqual([]);
  });
});

describe('devPakSources', () => {
  it('reads each pak by range from its URL-encoded route', async () => {
    const bytes = pk3({ 'a.txt': 'hello' });
    const fetchSpy = vi.fn(fakeDevServer({ 'my pak#1.pk3': bytes }));
    vi.stubGlobal('fetch', fetchSpy);

    const [pak] = devPakSources([{ name: 'my pak#1.pk3', size: bytes.byteLength }]);
    expect(pak.label).toBe('my pak#1.pk3');
    expect(pak.size).toBe(bytes.byteLength);
    // A local header's signature, "PK\3\4".
    expect([...(await pak.read(0, 4))]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(fetchSpy).toHaveBeenCalledWith('/baseq3/my%20pak%231.pk3', expect.anything());
  });

  it('mounts through the real route answers', async () => {
    vi.stubGlobal('fetch', fakeDevServer({ 'pak0.pk3': pk3({ 'scripts/gfx.shader': 'served' }) }));
    const fs = await mountArchives(devPakSources(await discoverDevPaks()));
    expect(decode(await fs.read('scripts/gfx.shader'))).toBe('served');
  });
});

describe('discoverMapPaks and mapPakSources', () => {
  it("list the port's own map pk3s, and read them by range from /maps/", async () => {
    const paks = {
      'map-b.pk3': pk3({ 'maps/b.ent': 'b' }),
      'map-a.pk3': pk3({ 'maps/a.ent': 'a' })
    };
    const fetchSpy = vi.fn(fakeMapServer(paks));
    vi.stubGlobal('fetch', fetchSpy);

    const listed = await discoverMapPaks();
    expect(listed.map((pak) => pak.name)).toEqual(['map-a.pk3', 'map-b.pk3']);
    expect(fetchSpy).toHaveBeenCalledWith('/maps/paks.json');
    const fs = await mountArchives(mapPakSources(listed));
    expect(decode(await fs.read('maps/b.ent'))).toBe('b');
    expect(fetchSpy).toHaveBeenCalledWith('/maps/map-a.pk3', expect.anything());
  });

  it("are found below the page's base, as a build at a path serves them", async () => {
    vi.stubEnv('BASE_URL', '/playcanvas-quake3/');
    const paks = { 'map-a.pk3': pk3({ 'maps/a.ent': 'a' }) };
    const folder = '/playcanvas-quake3/maps/';
    vi.stubGlobal('fetch', fakeDevServer(paks, folder, `${folder}paks.json`));
    try {
      const fs = await mountArchives(mapPakSources(await discoverMapPaks()));
      expect(decode(await fs.read('maps/a.ent'))).toBe('a');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('are found in the folder a build is given, with or without its slash', async () => {
    const folder = 'https://maps.example/q3/';
    const paks = { 'map-a.pk3': pk3({ 'maps/a.ent': 'a' }) };
    vi.stubGlobal('fetch', fakeDevServer(paks, folder, `${folder}paks.json`));
    try {
      for (const given of [folder, folder.slice(0, -1)]) {
        vi.stubEnv('VITE_MAPS_URL', given);
        const fs = await mountArchives(mapPakSources(await discoverMapPaks()));
        expect(decode(await fs.read('maps/a.ent'))).toBe('a');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('find none where nothing is listed', async () => {
    // A web build served without its listing: the host's index page, where JSON should be.
    vi.stubGlobal('fetch', async () => new Response('<!doctype html>'));
    expect(await discoverMapPaks()).toEqual([]);
  });
});

describe('filePakSources', () => {
  it("keeps the dropped pk3s in ioq3's order, and reads them by slicing", async () => {
    const files = [
      new File([new Uint8Array(pk3({ 'a.txt': 'pak1' }))], 'pak1.pk3'),
      new File(['not a pak'], 'readme.txt'),
      new File([new Uint8Array(pk3({ 'a.txt': 'pak0', 'b.txt': 'only in pak0' }))], 'PAK0.PK3')
    ];
    const sources = filePakSources(files);
    expect(sources.map((s) => s.label)).toEqual(['PAK0.PK3', 'pak1.pk3']);

    const fs = await mountArchives(sources);
    expect(decode(await fs.read('a.txt'))).toBe('pak1');
    expect(decode(await fs.read('b.txt'))).toBe('only in pak0');
  });
});
