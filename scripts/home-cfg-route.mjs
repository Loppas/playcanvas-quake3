/**
 * The pure parts of the home folder's cfg route, which the dev server (`vite.config.ts`) and the
 * shell's `app:` scheme both answer: the `.cfg` files in `fs_homepath` that `exec` reads.
 *
 * `GET /homepath/<path>.cfg` answers a file's text, or 404. `GET /homepath/<dir>/` lists the
 * `.cfg` files directly in a folder as a JSON array of their names, `[]` for a folder there is
 * none of. The route only reads; the files the game keeps there have their own route
 * (`q3config-route.mjs`), which writes them. No path leaves the home folder.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import nodePath from 'node:path';

import { resolveInside } from './baseq3-route.mjs';

/** The URL prefix the home folder is read under. */
export const HOME_ROUTE = '/homepath/';

/**
 * Whether a name is a cfg: the `.cfg` extension, in any case.
 *
 * @param name - A path, or a directory entry's name.
 */
export function isCfgName(name) {
  return /\.cfg$/i.test(name);
}

/**
 * Whether a path below the home folder may be read: names joined by `/`, none of them empty, `.`
 * or `..`, and none holding a backslash or a colon, which Windows takes for a separator, a drive
 * or a stream. An absolute path starts with an empty name, so it is refused too.
 *
 * @param relative - Decoded request path below the route.
 */
export function isHomePath(relative) {
  return relative
    .split('/')
    .every((name) => name !== '' && name !== '.' && name !== '..' && !/[\\:]/.test(name));
}

/**
 * The names of the cfg files directly in `dir`, sorted. A directory named like a cfg is left out,
 * and so is anything in a subfolder. Rejects if `dir` cannot be read.
 *
 * @param dir - A folder in the home folder.
 */
export async function listCfgs(dir) {
  const names = (await readdir(dir)).filter(isCfgName);
  const files = await Promise.all(
    names.map(async (name) => {
      // `stat` follows links, as the pak listing does.
      const info = await stat(nodePath.join(dir, name)).catch(() => undefined);
      return info?.isFile() ? name : undefined;
    })
  );
  return files.filter((name) => name !== undefined).sort();
}

/**
 * Answer a request below the route.
 *
 * @param method - The request's method.
 * @param encoded - The path below the route, as the URL has it.
 * @param home - The home folder.
 * @returns `status` and `headers` to send, and `body` when there is one.
 */
export async function homeCfgResponse(method, encoded, home) {
  // Nothing is cached, so a cfg edited on disk is read afresh by the next `exec`.
  const headers = { 'Cache-Control': 'no-store' };
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } };
  }
  const notFound = { status: 404, headers };
  const relative = decode(encoded);
  if (relative === undefined) return notFound;

  if (relative === '' || relative.endsWith('/')) {
    const dir = relative.slice(0, -1);
    const folder =
      relative === '' ? nodePath.resolve(home) : isHomePath(dir) ? resolveInside(home, dir) : null;
    if (!folder) return notFound;
    const body = JSON.stringify(await listCfgs(folder).catch(() => []));
    return {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: method === 'GET' ? body : undefined
    };
  }

  const file = isHomePath(relative) && isCfgName(relative) ? resolveInside(home, relative) : null;
  if (!file) return notFound;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return notFound;
  }
  return {
    status: 200,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    body: method === 'GET' ? text : undefined
  };
}

/**
 * A URL's path, decoded.
 *
 * @param text - The path as the URL has it.
 * @returns `undefined` for one that won't decode.
 */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}
