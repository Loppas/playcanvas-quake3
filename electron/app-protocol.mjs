/**
 * The shell's `app:` scheme. It answers the routes the dev server answers in the browser, so the
 * page runs unchanged:
 * - `/baseq3/` lists the install's paks, and `/baseq3/<name>.pk3` answers `Range` over one;
 * - `/homepath/q3config.cfg` and `/homepath/favorites.txt` read and replace those files in
 *   `fs_homepath`;
 * - `/homepath/<path>.cfg` reads another cfg there, and `/homepath/<dir>/` lists a folder's; a
 *   `.cfg` or `.txt` there is written;
 * - `/install`, the shell's own: the install this launch reads and the one kept for the next, and
 *   the dialog that picks another;
 * - `/launch`, the shell's own too: the vertical sync Chromium was started with
 *   (`launch-switches.mjs`);
 * - any other path is the page: the web build's files, or the Vite dev server's under
 *   `npm run shell`.
 *
 * The routes' rules are the dev server's own (`scripts/`). Each answer is a plain `Response`, so
 * all of it runs under Vitest without Electron.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { Readable } from 'node:stream';

import { isPakName, listPaks, rangeResponse, resolveInside } from '../scripts/baseq3-route.mjs';
import { HOME_ROUTE, homeCfgResponse } from '../scripts/home-cfg-route.mjs';
import { MAX_CONFIG_BYTES, configResponse, keptFile } from '../scripts/q3config-route.mjs';
import { installOf, keepInstall, keptInstall } from './basepath.mjs';

/** The pak route, as the dev server's (`vite.config.ts`). */
const BASEQ3_ROUTE = '/baseq3/';

/** The install's route (`src/shell.ts`). */
const INSTALL_ROUTE = '/install';

/** The launch's route (`src/shell.ts`). */
const LAUNCH_ROUTE = '/launch';

/**
 * The request headers the dev server goes by. The page's others, such as `Origin` and the
 * `Sec-Fetch-*` set, describe its request to the scheme, and Electron's fetch fails a request to
 * the dev server that carries them.
 */
const PROXIED_HEADERS = ['accept', 'range'];

/** The page's content types, by extension; anything else is sent as bytes. */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.glb', 'model/gltf-binary']
]);

/**
 * @typedef {object} AppRoutes
 * @property {string} baseq3 - The install's `baseq3` folder.
 * @property {string} homepath - `fs_homepath`: the game's kept files are read and replaced there,
 *   its other cfgs read, and the console's `.cfg` and `.txt` files written.
 * @property {(request: Request) => Promise<Response>} page - The page's files.
 * @property {InstallRoute} [install] - The install, read and changed for the next launch.
 * @property {LaunchRoute} [launch] - What this launch started Chromium with.
 */

/**
 * @typedef {object} InstallRoute
 * @property {string} running - `fs_basepath`, as this launch reads it.
 * @property {() => Promise<string | undefined>} pick - The native folder dialog: the folder
 *   picked, or `undefined` for none.
 */

/**
 * @typedef {object} LaunchRoute
 * @property {boolean} vsync - Vertical sync, as `q3config.cfg` had it as the shell started.
 */

/**
 * Answer a request on the scheme.
 *
 * @param {Request} request
 * @param {AppRoutes} routes
 * @returns {Promise<Response>}
 */
export async function handleAppRequest(request, routes) {
  try {
    const { pathname } = new URL(request.url);
    const kept = keptFile(pathname);
    if (kept !== undefined) return await keptFileAnswer(request, nodePath.join(routes.homepath, kept));
    if (pathname.startsWith(HOME_ROUTE)) {
      return await homeCfgs(request, pathname.slice(HOME_ROUTE.length), routes.homepath);
    }
    if (pathname.startsWith(BASEQ3_ROUTE)) {
      return await paks(request, pathname.slice(BASEQ3_ROUTE.length), routes.baseq3);
    }
    if (pathname === INSTALL_ROUTE && routes.install) {
      return await install(request, routes.homepath, routes.install);
    }
    if (pathname === LAUNCH_ROUTE && routes.launch) return launch(request, routes.launch);
    return await routes.page(request);
  } catch (error) {
    console.error(`app: ${request.method} ${request.url} failed:`, error);
    return new Response(null, { status: 500 });
  }
}

/**
 * The web build's files, as a static server serves them, `/` being `index.html`.
 *
 * @param {string} root - The build's folder.
 * @returns {(request: Request) => Promise<Response>}
 */
export function servePage(root) {
  return async (request) => {
    const path = decode(new URL(request.url).pathname.slice(1));
    const file = path === undefined ? null : resolveInside(root, path === '' ? 'index.html' : path);
    if (!file) return notFound();
    const type = CONTENT_TYPES.get(nodePath.extname(file).toLowerCase()) ?? 'application/octet-stream';
    return fileResponse(request, file, { 'Content-Type': type });
  };
}

/**
 * The Vite dev server's page, taken from it request by request, so the shell runs the sources as
 * the browser does.
 *
 * @param {string} origin - The dev server's origin.
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetcher - Electron's `net.fetch`.
 * @returns {(request: Request) => Promise<Response>}
 */
export function proxyPage(origin, fetcher) {
  return (request) => {
    const { pathname, search } = new URL(request.url);
    const headers = new Headers();
    for (const name of PROXIED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return fetcher(origin + pathname + search, { method: request.method, headers });
  };
}

/**
 * The pak listing, or one pak's bytes.
 *
 * @param {Request} request
 * @param {string} encoded - The path below the route, as the URL has it.
 * @param {string} dir - The `baseq3` folder.
 * @returns {Promise<Response>}
 */
async function paks(request, encoded, dir) {
  // Nothing is cached, so a pak replaced on disk is read afresh on the next start.
  const headers = { 'Cache-Control': 'no-store' };
  if (encoded === '') {
    return Response.json({ paks: await listPaks(dir).catch(() => []) }, { headers });
  }
  const name = decode(encoded);
  // Only pk3s directly in the folder, and the containment check behind that.
  const file = name !== undefined && isPakName(name) ? resolveInside(dir, name) : null;
  if (!file) return notFound();
  return fileResponse(request, file, { ...headers, 'Content-Type': 'application/octet-stream' });
}

/**
 * The install this launch reads, and the one kept for the next, which a launch reads only as it
 * starts. GET reads them; POST opens the dialog first and keeps its pick, where it holds paks, as
 * the first launch's pick is kept (`main.mjs`). A pick with none is named as refused.
 *
 * @param {Request} request
 * @param {string} homepath - `fs_homepath`, where the pick is kept.
 * @param {InstallRoute} route
 * @returns {Promise<Response>}
 */
async function install(request, homepath, route) {
  /** @type {{ refused?: string }} */
  const answer = {};
  if (request.method === 'POST') {
    const folder = await route.pick();
    const basepath = folder === undefined ? undefined : await installOf(folder);
    if (basepath !== undefined) await keepInstall(homepath, basepath);
    else if (folder !== undefined) answer.refused = folder;
  } else if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  }
  const next = (await keptInstall(homepath)) ?? null;
  return Response.json({ running: route.running, next, ...answer }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * What this launch started Chromium with, which holds until the next: GET alone.
 *
 * @param {Request} request
 * @param {LaunchRoute} route
 * @returns {Response}
 */
function launch(request, route) {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  }
  return Response.json({ vsync: route.vsync }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * A kept file, `q3config.cfg` or `favorites.txt`, read or replaced. Only the shell's own page can
 * reach the scheme, so the dev server's origin check has nothing to refuse here.
 *
 * @param {Request} request
 * @param {string} file
 * @returns {Promise<Response>}
 */
async function keptFileAnswer(request, file) {
  /** @type {string | undefined} */
  let body;
  if (request.method === 'PUT') {
    body = await request.text();
    if (Buffer.byteLength(body) > MAX_CONFIG_BYTES) return new Response(null, { status: 413 });
  }
  const answer = await configResponse(request.method, body, file);
  return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers });
}

/**
 * Another cfg in `fs_homepath` or a folder's listing of them, or a `.cfg` or `.txt` written there.
 * Like the kept files, it needs no origin check, and takes no body past their limit.
 *
 * @param {Request} request
 * @param {string} encoded - The path below the route, as the URL has it.
 * @param {string} home - `fs_homepath`.
 * @returns {Promise<Response>}
 */
async function homeCfgs(request, encoded, home) {
  /** @type {string | undefined} */
  let body;
  if (request.method === 'PUT') {
    body = await request.text();
    if (Buffer.byteLength(body) > MAX_CONFIG_BYTES) return new Response(null, { status: 413 });
  }
  const answer = await homeCfgResponse(request.method, encoded, home, body);
  return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers });
}

/**
 * A file, or the one range of it the request asks for (`rangeResponse`).
 *
 * @param {Request} request
 * @param {string} file
 * @param {Record<string, string>} headers
 * @returns {Promise<Response>}
 */
async function fileResponse(request, file, headers) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return notFound();
  const answer = rangeResponse(request.headers.get('range'), info.size);
  const init = { status: answer.status, headers: { ...headers, ...answer.headers } };
  if (answer.status === 416 || request.method === 'HEAD') return new Response(null, init);
  const stream = createReadStream(file, { start: answer.start, end: answer.end });
  return new Response(/** @type {ReadableStream} */ (Readable.toWeb(stream)), init);
}

/**
 * A URL's path, decoded.
 *
 * @param {string} text
 * @returns {string | undefined} `undefined` for one that won't decode.
 */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** @returns {Response} */
function notFound() {
  return new Response('not found', { status: 404 });
}
