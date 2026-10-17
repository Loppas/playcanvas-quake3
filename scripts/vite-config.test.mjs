import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import viteConfig, { listMapPaks } from '../vite.config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Start a dev server on a free port, and the origin it answers on.
 *
 * @param {import('vite').InlineConfig} config
 */
async function listen(config) {
  const server = await createServer({
    logLevel: 'silent',
    ...config,
    optimizeDeps: { noDiscovery: true },
    server: { ...config.server, port: 0 }
  });
  await server.listen();
  const { address, port } = /** @type {import('node:net').AddressInfo} */ (
    server.httpServer?.address()
  );
  const host = address.includes(':') ? `[${address}]` : address;
  return { server, address, origin: `http://${host}:${port}` };
}

describe('the dev server', () => {
  it('listens on localhost alone, and checks the Host header', async () => {
    const { server, address, origin } = await listen({
      root,
      configFile: nodePath.join(root, 'vite.config.ts')
    });
    try {
      expect(['127.0.0.1', '::1']).toContain(address);
      // A page that rebinds its own name to this machine is refused. `fetch` sets its own Host.
      const status = (host) =>
        new Promise((resolve, reject) =>
          get(`${origin}/`, { headers: { Host: host } }, (res) => {
            res.resume();
            resolve(res.statusCode);
          }).on('error', reject)
        );
      expect(await status('localhost')).toBe(200);
      expect(await status('attacker.example')).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe('the map pk3s', () => {
  /** @type {string} */
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'pcq-map-paks-'));
    mkdirSync(nodePath.join(dir, 'public', 'maps'), { recursive: true });
    for (const name of ['map-a.pk3', 'zz-items.pk3', 'a.sog']) {
      writeFileSync(nodePath.join(dir, 'public', 'maps', name), name);
    }
    writeFileSync(nodePath.join(dir, 'entry.js'), 'export {};\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("are listed whole in dev, a check's override pak too", async () => {
    const { server, origin } = await listen({
      root: dir,
      configFile: false,
      plugins: [listMapPaks()]
    });
    try {
      const listing = await (await fetch(`${origin}/maps/paks.json`)).json();
      expect(listing.paks.map(({ name }) => name)).toEqual(['map-a.pk3', 'zz-items.pk3']);
    } finally {
      await server.close();
    }
  });

  it("leave a check's override pak out of a build, and out of its listing", async () => {
    const outDir = nodePath.join(dir, 'dist');
    await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      plugins: [listMapPaks()],
      build: { outDir, rolldownOptions: { input: nodePath.join(dir, 'entry.js') } }
    });
    const maps = nodePath.join(outDir, 'maps');
    expect(readdirSync(maps).sort()).toEqual(['a.sog', 'map-a.pk3', 'paks.json']);
    expect(JSON.parse(readFileSync(nodePath.join(maps, 'paks.json'), 'utf8'))).toEqual({
      paks: [{ name: 'map-a.pk3', size: 9 }]
    });
  });

  it('stay out of a build without public/, which lists none, wherever it runs', async () => {
    const outDir = nodePath.join(dir, 'dist');
    // Run from beside a `maps` folder, which a build without `public/` must not take for its own.
    const cwd = process.cwd();
    process.chdir(nodePath.join(dir, 'public'));
    try {
      await build({
        root: dir,
        configFile: false,
        logLevel: 'silent',
        publicDir: false,
        plugins: [listMapPaks()],
        build: { outDir, rolldownOptions: { input: nodePath.join(dir, 'entry.js') } }
      });
    } finally {
      process.chdir(cwd);
    }
    const maps = nodePath.join(outDir, 'maps');
    expect(readdirSync(maps)).toEqual(['paks.json']);
    const listing = JSON.parse(readFileSync(nodePath.join(maps, 'paks.json'), 'utf8'));
    expect(listing).toEqual({ paks: [] });
  });
});

describe('the Pages build', () => {
  /** The config Vite resolves from `vite.config.ts` for a build in `mode`. */
  const configFor = (mode) => viteConfig({ mode, command: 'build' });

  it("is served at the repository's path, without public/ and its maps", () => {
    expect(configFor('pages')).toMatchObject({ base: '/playcanvas-quake3/', publicDir: false });
  });

  it('leaves the other builds at the root, with public/, as the shell serves them there', () => {
    for (const mode of ['production', 'release']) {
      expect(configFor(mode).base, mode).toBeUndefined();
      expect(configFor(mode).publicDir, mode).toBeUndefined();
    }
  });
});
