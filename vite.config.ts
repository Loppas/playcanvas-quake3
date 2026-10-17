import { createReadStream } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { defineConfig, type Plugin } from 'vite';

import { isPakName, listPaks, rangeResponse, resolveInside } from './scripts/baseq3-route.mjs';
import { engineBuild } from './scripts/engine-build.mjs';
import { baseq3Dir } from './scripts/fs-basepath.mjs';
import { fsHomepath } from './scripts/fs-homepath.mjs';
import { HOME_ROUTE, homeCfgResponse } from './scripts/home-cfg-route.mjs';
import {
  banner,
  NOTICE_FILES,
  PUBLISHED_NOTICES,
  publishedName,
  THIRD_PARTY_NOTICES
} from './scripts/notices.mjs';
import { productDate, productSource, productVersion } from './scripts/product-version.mjs';
import { configResponse, isSameOrigin, keptFile, readBody } from './scripts/q3config-route.mjs';

/** URL prefix the dev server answers on; the browser treats it like any other fetch. */
const BASEQ3_ROUTE = '/baseq3/';

/**
 * Dev-only server for the Quake 3 install's `baseq3` folder.
 *
 * The folder is `fs_basepath`'s `baseq3`: `PCQ_FS_BASEPATH` from `.env.local`, else the repo
 * root (`scripts/fs-basepath.mjs`). Its paks are read where they sit and never copied.
 * Deliberately **not** under `public/`: vite copies that directory verbatim into `dist/`, so a
 * pak there would ship gigabytes of id assets in every production build, and no Q3 asset may
 * ever ship.
 *
 * `apply: 'serve'` is the guarantee that matters: the plugin has no build hook at all, so a
 * production bundle can never reach these files and the drop screen is the only way in.
 *
 * `GET /baseq3/` lists the pk3s with their sizes as JSON. `GET /baseq3/<name>.pk3` answers
 * `Range` with just the bytes asked for, which is how the client reads a pak's directory and
 * entries without fetching the pak.
 *
 * @param dir the `baseq3` folder to serve
 */
function serveBaseq3(dir: string): Plugin {
  return {
    name: 'quake-baseq3-dev-server',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        listPaks(dir).then(
          (paks) => server.config.logger.info(`  baseq3: ${paks.length} pk3s in ${dir}`),
          () => server.config.logger.info(`  baseq3: no ${dir}; the game will ask for pak0.pk3`)
        );
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url || !url.startsWith(BASEQ3_ROUTE)) return next();

        const notFound = () => {
          res.statusCode = 404;
          res.end('not found');
        };
        // Dev keeps no cache: a pak replaced on disk is read afresh on the next boot.
        res.setHeader('Cache-Control', 'no-store');

        let relative: string;
        try {
          relative = decodeURIComponent(url.slice(BASEQ3_ROUTE.length));
        } catch {
          return notFound();
        }

        if (relative === '') {
          listPaks(dir)
            // No local install is a normal state — the app falls back to the drop screen.
            .catch(() => [])
            .then((paks) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ paks }));
            });
          return;
        }

        // Only pk3s directly in the folder, and the containment check behind that, so `..`
        // segments cannot escape into the rest of the filesystem.
        const file = isPakName(relative) ? resolveInside(dir, relative) : null;
        if (!file) return notFound();

        stat(file)
          .then((info) => {
            if (!info.isFile()) throw new Error('not a file');
            const answer = rangeResponse(req.headers.range, info.size);
            res.statusCode = answer.status;
            res.setHeader('Content-Type', 'application/octet-stream');
            for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
            if (answer.status === 416 || req.method === 'HEAD') {
              res.end();
              return;
            }
            createReadStream(file, { start: answer.start, end: answer.end })
              .on('error', () => res.destroy())
              .pipe(res);
          })
          .catch(notFound);
      });
    }
  };
}

/** Where the port's own map pk3s are listed, below `public/`'s `maps` folder. */
const MAPS_LISTING = 'maps/paks.json';

/**
 * Whether a map pk3 is a check's override, `zz-*.pk3`, which mounts above the map
 * (`.claude/testing.md`). Dev mounts it; a build leaves it out, so a player gets the maps as their
 * pipeline builds them.
 *
 * @param name - A pk3's file name.
 */
const isOverridePak = (name: string): boolean => /^zz-/i.test(name);

/**
 * The listing of the port's own map pk3s, `public/maps/*.pk3`, which the client mounts at the
 * bottom of its search path. The pk3s themselves are `public/` files, which
 * Vite's server and any static server answer `Range` for.
 *
 * A static server lists no folder, so the listing is a file: answered as it is asked in dev, so a
 * pk3 delivered while the server runs is found on the next boot, and written once into a build.
 * The shell serves the build's file, or under `npm run shell` takes it from the dev server. A build
 * without `public/` lists none.
 */
export function listMapPaks(): Plugin {
  let dir = '';
  const listing = async (build: boolean) => {
    const paks = dir === '' ? [] : await listPaks(dir).catch(() => []);
    return JSON.stringify({ paks: build ? paks.filter(({ name }) => !isOverridePak(name)) : paks });
  };
  return {
    name: 'quake-maps-listing',
    configResolved(config) {
      // Vite resolves `publicDir: false` to ''.
      dir = config.publicDir === '' ? '' : nodePath.join(config.publicDir, 'maps');
    },
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        listPaks(dir).then(
          (paks) => server.config.logger.info(`  maps: ${paks.length} pk3s in ${dir}`),
          () => server.config.logger.info(`  maps: no ${dir}`)
        );
      });

      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${MAPS_LISTING}`) return next();
        listing(false).then((body) => {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'application/json');
          res.end(body);
        });
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: MAPS_LISTING, source: await listing(true) });
    },
    // Vite copies `public/` whole before it writes, so the overrides come back out of the copy.
    async writeBundle({ dir: outDir }) {
      if (!outDir) return;
      const maps = nodePath.join(outDir, 'maps');
      const names = await readdir(maps).catch(() => []);
      await Promise.all(
        names
          .filter((name) => isPakName(name) && isOverridePak(name))
          .map((name) => rm(nodePath.join(maps, name), { force: true }))
      );
    }
  };
}

/**
 * The repo's notices, written into a build beside the bundled packages' licences, each by the name
 * the page links it by (`scripts/notices.mjs`).
 *
 * @param root - The repo root, where the notices are.
 */
export function publishNotices(root: string): Plugin {
  return {
    name: 'quake-notices',
    apply: 'build',
    async generateBundle() {
      for (const file of NOTICE_FILES) {
        const source = await readFile(nodePath.join(root, file));
        this.emitFile({ type: 'asset', fileName: publishedName(file), source });
      }
    }
  };
}

/** A route's answer: a status, headers, and a body when there is one. */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Dev-only route for the copies of `q3config.cfg` and `favorites.txt` kept in `fs_homepath`,
 * which the game reads first in dev and writes on every change.
 *
 * `apply: 'serve'`, like the pak route: a production build has no route, and keeps its files in
 * OPFS alone. Only the page's own origin is answered (`scripts/q3config-route.mjs`), since the
 * server can be opened to the network.
 *
 * @param home the home folder
 */
function serveHomeFiles(home: string): Plugin {
  return {
    name: 'quake-q3config-dev-route',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.info(`  fs_homepath: ${home}`);
      });

      server.middlewares.use((req, res, next) => {
        const kept = keptFile(req.url?.split('?')[0] ?? '');
        if (kept === undefined) return next();
        const file = nodePath.join(home, kept);

        const send = (answer: Answer) => {
          res.statusCode = answer.status;
          for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
          res.end(answer.body);
        };
        if (!isSameOrigin(req.headers)) return send({ status: 403, headers: {} });

        (req.method === 'PUT' ? readBody(req) : Promise.resolve(undefined))
          .then((body): Promise<Answer> | Answer =>
            body === null ? { status: 413, headers: {} } : configResponse(req.method ?? 'GET', body, file)
          )
          .then(send, () => send({ status: 500, headers: {} }));
      });
    }
  };
}

/**
 * Dev-only route for the other cfgs in `fs_homepath`, which `exec` reads there before the port's
 * own copies: a cfg's text, or a folder's listing (`scripts/home-cfg-route.mjs`). It only reads.
 *
 * `apply: 'serve'` and the same-origin check, as the config's route has them.
 *
 * @param home the home folder
 */
function serveHomeCfgs(home: string): Plugin {
  return {
    name: 'quake-home-cfg-dev-route',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith(HOME_ROUTE) || keptFile(url) !== undefined) return next();

        const send = (answer: Answer) => {
          res.statusCode = answer.status;
          for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
          res.end(answer.body);
        };
        if (!isSameOrigin(req.headers)) return send({ status: 403, headers: {} });

        homeCfgResponse(req.method ?? 'GET', url.slice(HOME_ROUTE.length), home).then(send, () =>
          send({ status: 500, headers: {} })
        );
      });
    }
  };
}

export default defineConfig(({ mode }) => ({
  // PlayCanvas's build: the debug build by default, the release build under `--mode release`.
  ...engineBuild(mode),
  // The GitHub Pages build (`npm run build:pages`), served at the repository's path, as a project
  // site is. `public/` holds the maps, which a host of their own serves (`VITE_MAPS_URL`), so it
  // stays out. The base is this mode's alone: the shell serves the web build at its root.
  ...(mode === 'pages' ? { base: '/playcanvas-quake3/', publicDir: false as const } : {}),
  // The build, which the `version` cvar reports (`src/version.ts`), and its source and notices,
  // which the drop screen links.
  define: {
    __PRODUCT_VERSION__: JSON.stringify(productVersion(import.meta.dirname)),
    __PRODUCT_DATE__: JSON.stringify(productDate()),
    __PRODUCT_SOURCE__: JSON.stringify(productSource(import.meta.dirname)),
    __PRODUCT_NOTICES__: JSON.stringify(PUBLISHED_NOTICES)
  },
  plugins: [
    serveBaseq3(baseq3Dir(import.meta.dirname, mode)),
    listMapPaks(),
    publishNotices(import.meta.dirname),
    serveHomeFiles(fsHomepath(import.meta.dirname, mode)),
    serveHomeCfgs(fsHomepath(import.meta.dirname, mode))
  ],
  // The minifier drops the bundled packages' licence comments, so the build writes their licences
  // to a file of its own, and each script points to it.
  build: {
    license: { fileName: THIRD_PARTY_NOTICES },
    rolldownOptions: { output: { postBanner: banner(import.meta.dirname) } }
  },
  worker: { rolldownOptions: { output: { postBanner: banner(import.meta.dirname) } } }
  // The dev server keeps Vite's defaults: `localhost` alone, unless `--host` opens it to the
  // network, and Vite's check of the `Host` header, which stops a DNS-rebinding page reaching the
  // routes above.
}));
