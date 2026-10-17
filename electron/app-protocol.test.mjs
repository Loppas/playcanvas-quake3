import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAppRequest, proxyPage, servePage } from './app-protocol.mjs';
import { SHELL_FILE, keepInstall } from './basepath.mjs';

const PAK = Uint8Array.from({ length: 16 }, (_, i) => i);

describe('handleAppRequest', () => {
  let root;
  let routes;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pcq-app-'));
    const baseq3 = join(root, 'baseq3');
    mkdirSync(baseq3);
    writeFileSync(join(baseq3, 'pak0.pk3'), PAK);
    writeFileSync(join(baseq3, 'readme.txt'), 'not a pak');
    writeFileSync(join(root, 'secret.pk3'), 'outside');
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    writeFileSync(join(root, 'dist', 'assets', 'index.js'), 'export {};');
    routes = {
      baseq3,
      homepath: join(root, 'home'),
      page: servePage(join(root, 'dist'))
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const get = (path, init) => handleAppRequest(new Request(`app://game${path}`, init), routes);

  it('lists the paks, as the dev server does', async () => {
    const response = await get('/baseq3/');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ paks: [{ name: 'pak0.pk3', size: 16 }] });
  });

  it('answers a Range with 206 and its Content-Range', async () => {
    const response = await get('/baseq3/pak0.pk3', { headers: { Range: 'bytes=4-7' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 4-7/16');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PAK.subarray(4, 8));
  });

  it('answers 416 past the end', async () => {
    const response = await get('/baseq3/pak0.pk3', { headers: { Range: 'bytes=16-20' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */16');
    expect(await response.text()).toBe('');
  });

  it('serves nothing but the pk3s in baseq3', async () => {
    for (const path of [
      '/baseq3/readme.txt',
      '/baseq3/..%2Fsecret.pk3',
      '/baseq3/..%5Csecret.pk3',
      '/baseq3/nope.pk3',
      '/baseq3/%E0.pk3'
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('keeps q3config.cfg in fs_homepath: written, then read back', async () => {
    // A first run has no file.
    expect((await get('/homepath/q3config.cfg')).status).toBe(204);

    const text = 'unbindall\nseta cg_fov "100"\n';
    const put = await get('/homepath/q3config.cfg', { method: 'PUT', body: text });
    expect(put.status).toBe(204);
    expect(readFileSync(join(routes.homepath, 'q3config.cfg'), 'utf8')).toBe(text);

    const read = await get('/homepath/q3config.cfg');
    expect(read.status).toBe(200);
    expect(await read.text()).toBe(text);
  });

  it('keeps favorites.txt beside it, and no other file', async () => {
    const text = '10.0.0.5:27960 "Office"\n';
    expect((await get('/homepath/favorites.txt', { method: 'PUT', body: text })).status).toBe(204);
    expect(readFileSync(join(routes.homepath, 'favorites.txt'), 'utf8')).toBe(text);
    expect(await (await get('/homepath/favorites.txt')).text()).toBe(text);
    expect((await get('/homepath/other.txt', { method: 'PUT', body: text })).status).toBe(405);
  });

  it("reads fs_homepath's other cfgs, and lists a folder of them, as the dev server does", async () => {
    mkdirSync(join(root, 'home', 'presets'), { recursive: true });
    writeFileSync(join(root, 'home', 'presets', 'cpm.cfg'), 'seta g_gamepreset "CPM"\n');
    writeFileSync(join(root, 'secret.cfg'), 'outside');

    const read = await get('/homepath/presets/cpm.cfg');
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('seta g_gamepreset "CPM"\n');
    expect(await (await get('/homepath/presets/')).json()).toEqual(['cpm.cfg']);
    expect(await (await get('/homepath/missing/')).json()).toEqual([]);
    for (const path of ['/homepath/presets/pmc.cfg', '/homepath/..%2Fsecret.cfg', '/homepath/..%5Csecret.cfg']) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await get('/homepath/presets/cpm.cfg', { method: 'PUT', body: 'x' })).status).toBe(405);
  });

  it('reads the install this launch runs on, and the one kept for the next', async () => {
    routes.install = { running: root, pick: vi.fn() };
    // Nothing kept yet, so the next launch asks.
    expect(await (await get('/install')).json()).toEqual({ running: root, next: null });
    await keepInstall(routes.homepath, root);
    const read = await get('/install');
    expect(read.headers.get('Cache-Control')).toBe('no-store');
    expect(await read.json()).toEqual({ running: root, next: root });
    expect(routes.install.pick).not.toHaveBeenCalled();
  });

  it('keeps a pick that holds paks for the next launch, names one that holds none, and a cancel changes nothing', async () => {
    const other = join(root, 'other');
    mkdirSync(join(other, 'baseq3'), { recursive: true });
    writeFileSync(join(other, 'baseq3', 'pak0.pk3'), PAK);
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const pick = vi
      .fn()
      .mockResolvedValueOnce(join(other, 'baseq3'))
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(undefined);
    routes.install = { running: root, pick };
    const post = async () => (await get('/install', { method: 'POST' })).json();

    expect(await post()).toEqual({ running: root, next: other });
    expect(JSON.parse(readFileSync(join(routes.homepath, SHELL_FILE), 'utf8'))).toEqual({ fs_basepath: other });
    expect(await post()).toEqual({ running: root, next: other, refused: empty });
    expect(await post()).toEqual({ running: root, next: other });
    expect(pick).toHaveBeenCalledTimes(3);
    expect((await get('/install', { method: 'PUT' })).status).toBe(405);
  });

  it('leaves /install to the page where the shell gives it no install', async () => {
    expect((await get('/install')).status).toBe(404);
  });

  it('reads the vertical sync this launch started Chromium with', async () => {
    routes.launch = { vsync: false };
    const read = await get('/launch');
    expect(read.headers.get('Cache-Control')).toBe('no-store');
    expect(await read.json()).toEqual({ vsync: false });
    expect((await get('/launch', { method: 'POST' })).status).toBe(405);
    delete routes.launch;
    expect((await get('/launch')).status).toBe(404);
  });

  it('refuses a config past the size limit', async () => {
    const body = 'x'.repeat((1 << 20) + 1);
    expect((await get('/homepath/q3config.cfg', { method: 'PUT', body })).status).toBe(413);
  });

  it('serves the page from the build', async () => {
    const index = await get('/');
    expect(index.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await index.text()).toBe('<!doctype html>');
    const script = await get('/assets/index.js');
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe('export {};');
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/..%2Fsecret.pk3')).status).toBe(404);
  });

  it("serves the build's map pk3s by range, and the listing the build wrote for them", async () => {
    mkdirSync(join(root, 'dist', 'maps'));
    writeFileSync(join(root, 'dist', 'maps', 'map-garage_rats.pk3'), PAK);
    const listing = { paks: [{ name: 'map-garage_rats.pk3', size: 16 }] };
    writeFileSync(join(root, 'dist', 'maps', 'paks.json'), JSON.stringify(listing));

    const listed = await get('/maps/paks.json');
    expect(listed.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await listed.json()).toEqual(listing);
    const tail = await get('/maps/map-garage_rats.pk3', { headers: { Range: 'bytes=12-15' } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(PAK.subarray(12, 16));
  });
});

describe('proxyPage', () => {
  it('takes the page from the dev server, path and query kept', async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    const page = proxyPage('http://localhost:5174', fetcher);
    const response = await page(new Request('app://game/src/main.ts?t=1'));
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:5174/src/main.ts?t=1',
      expect.objectContaining({ method: 'GET' })
    );
    expect(await response.text()).toBe('ok');
  });

  it("forwards only the headers the dev server goes by, not the page's own", async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    const request = new Request('app://game/src/style.css', {
      headers: {
        Accept: 'text/css',
        Range: 'bytes=0-1',
        Origin: 'app://game',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'script'
      }
    });
    await proxyPage('http://localhost:5174', fetcher)(request);
    const headers = fetcher.mock.calls[0][1].headers;
    expect([...headers.keys()].sort()).toEqual(['accept', 'range']);
    expect(headers.get('accept')).toBe('text/css');
  });
});
