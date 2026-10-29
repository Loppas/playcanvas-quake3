/**
 * The pure parts of the route to the files the game keeps in `fs_homepath`, which the dev server
 * (`vite.config.ts`) and the shell's `app:` scheme both answer: `q3config.cfg`, the favourite
 * servers' `favorites.txt` and the console's `q3history`, where they can be opened in an editor,
 * and which dev reads first.
 *
 * `GET` answers a file, or 204 and nothing before there is one, and `PUT` replaces it. It touches no
 * other file, and the dev server answers only the page's own origin: it listens on every interface,
 * and without the check any page open in the browser could read the files or write them.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';

/** `Q3CONFIG_CFG` (`q_shared.h`). */
export const Q3CONFIG_CFG = 'q3config.cfg';

/** The favourite servers, which the game keeps beside the config. */
export const FAVORITES_TXT = 'favorites.txt';

/** `CONSOLE_HISTORY_FILE` (`cl_keys.c:1462`): the lines entered at the console. */
export const Q3HISTORY = 'q3history';

/** The files the game keeps in `fs_homepath`, each at `/homepath/<name>`. */
export const KEPT_FILES = [Q3CONFIG_CFG, FAVORITES_TXT, Q3HISTORY];

/**
 * The kept file a URL's path names.
 *
 * @param pathname - The URL's path, as the request has it.
 * @returns The file's name, or `undefined` for any other path.
 */
export function keptFile(pathname) {
  return KEPT_FILES.find((name) => pathname === `/homepath/${name}`);
}

/** The largest file the route takes. ioq3's own config comes to about 12 KB. */
export const MAX_CONFIG_BYTES = 1 << 20;

/** Counts the writes, so two at once never share a temporary file. */
let writes = 0;

/**
 * Whether a request comes from the page's own origin. A browser marks every request with
 * `Sec-Fetch-Site`, which no page can set, so a page on any other origin is refused, and so is
 * anything that isn't a browser.
 *
 * @param headers - The request's headers, with lower-case names as Node gives them.
 */
export function isSameOrigin(headers) {
  return headers['sec-fetch-site'] === 'same-origin';
}

/**
 * Answer a request for a kept file.
 *
 * @param method - The request's method.
 * @param body - A `PUT`'s body, as text.
 * @param file - The file's path.
 * @returns `status` and `headers` to send, and `body` when there is one.
 */
export async function configResponse(method, body, file) {
  const headers = { 'Cache-Control': 'no-store' };
  if (method === 'GET' || method === 'HEAD') {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // No file yet is a first run, not a fault, so it gets no error status, which a browser
      // would log as a failed load. The game starts from its defaults.
      return { status: 204, headers };
    }
    return {
      status: 200,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      body: method === 'GET' ? text : undefined
    };
  }
  if (method === 'PUT') {
    await replaceFile(file, body ?? '');
    return { status: 204, headers };
  }
  return { status: 405, headers: { ...headers, Allow: 'GET, HEAD, PUT' } };
}

/**
 * Replace a file in the home folder, making its folder if there is none. It is written beside the
 * file and moved into place, so an editor never sees half a file.
 *
 * @param file - The file's path.
 * @param text - What it is to hold.
 */
export async function replaceFile(file, text) {
  await mkdir(nodePath.dirname(file), { recursive: true });
  const temp = `${file}.${++writes}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

/**
 * A request's body as text, if it is no longer than `limit` bytes.
 *
 * @param request - A readable stream: the request.
 * @param limit - The most bytes to take.
 * @returns The text, or `null` for a body past the limit.
 */
export function readBody(request, limit = MAX_CONFIG_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
