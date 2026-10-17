/**
 * The pure parts of the dev server's `baseq3` route (`vite.config.ts`): path containment, the
 * pak listing, and `Range` answers.
 *
 * Split out of the config so they can be tested from any machine. On Windows `resolve` answers
 * with backslashes, so containment can't compare against a hard-coded `/`. `rangeResponse`
 * takes and returns plain values, with no server types, so the desktop shell's `app:` scheme
 * answers with it too.
 */

import { readdir, stat } from 'node:fs/promises';
import nodePath from 'node:path';

/** The game directory under `fs_basepath`: ioq3's `BASEGAME` (`q_shared.h:44`). */
export const BASEGAME = 'baseq3';

/**
 * Resolve a request path below `root`, or `null` if it would land anywhere else.
 *
 * Resolved first and then required to sit strictly inside the root, so `..` in either slash
 * style cannot reach the rest of the filesystem, and a sibling that merely starts with the
 * root's name (`baseq3-other`) does not count as inside it.
 *
 * @param root - Directory being served.
 * @param relative - Decoded request path below the route.
 * @param path - Path flavour: `node:path` for the host, `path.win32` or `path.posix` in tests.
 * @returns The file's absolute path, or `null` to refuse the request.
 */
export function resolveInside(root, relative, path = nodePath) {
  const base = path.resolve(root);
  const file = path.resolve(path.join(base, relative));
  return file.startsWith(base + path.sep) ? file : null;
}

/**
 * Whether a name is a pk3 directly in the served folder: no separator, no drive or stream
 * colon, and the `.pk3` extension in any case, as ioq3 matches it.
 *
 * @param name - Decoded request path, or a directory entry's name.
 * @returns Whether the route may serve it.
 */
export function isPakName(name) {
  return /^[^/\\:]+\.pk3$/i.test(name);
}

/**
 * Every pk3 file directly in `dir`, with its size: what the client mounts from. A directory
 * named like a pk3 is left out, and so is anything in a subfolder. Rejects if `dir` cannot be
 * read.
 *
 * @param dir - The `baseq3` folder, or the port's own `public/maps`.
 * @returns `{ name, size }` for each pak, sorted by name.
 */
export async function listPaks(dir) {
  const names = (await readdir(dir)).filter(isPakName);
  const paks = await Promise.all(
    names.map(async (name) => {
      // `stat` follows links, as ioq3's listing does.
      const info = await stat(nodePath.join(dir, name)).catch(() => undefined);
      return info?.isFile() ? { name, size: info.size } : undefined;
    })
  );
  return paks.filter((pak) => pak !== undefined).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * The status and headers answering a request for a file of `size` bytes.
 *
 * The three single-range forms — `bytes=a-b`, `bytes=a-` and the suffix `bytes=-n` — get a 206,
 * clipped to the file; a start at or past the end gets a 416. No header, or one this does not
 * handle (several ranges, a malformed one), gets a 200 and the whole file, which RFC 9110 §14.2
 * allows a server to answer to a `Range` it will not honour.
 *
 * @param rangeHeader - The request's `Range` header, if it has one.
 * @param size - The file's length.
 * @returns `status` and `headers` to send. For a 206, `start` and `end` are the inclusive byte
 *   range to send; without them, send the whole file for a 200 and no body for a 416.
 */
export function rangeResponse(rangeHeader, size) {
  const whole = {
    status: 200,
    headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(size) }
  };
  const unsatisfiable = {
    status: 416,
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }
  };

  const match = /^bytes=(\d*)-(\d*)$/i.exec((rangeHeader ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return whole;

  let start;
  let end;
  if (match[1] === '') {
    // A suffix: the last n bytes, and a zero-length suffix can never be satisfied.
    const suffix = Number(match[2]);
    if (suffix === 0) return unsatisfiable;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (match[2] !== '' && Number(match[2]) < start) return whole;
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size) return unsatisfiable;

  return {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1)
    },
    start,
    end
  };
}
