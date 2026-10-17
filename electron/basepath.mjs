/**
 * The Quake 3 install the shell reads: `fs_basepath`, the folder that holds `baseq3`.
 *
 * ioq3 takes it from its command line, or else from the folder it runs in (`files.c:3380`). The
 * shell has the player pick it once, and keeps the pick in `fs_homepath`, beside `q3config.cfg`.
 * A kept folder that no longer holds a pak is as good as none, so the player picks again.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { BASEGAME, listPaks } from '../scripts/baseq3-route.mjs';

/** The file the pick is kept in. */
export const SHELL_FILE = 'shell.json';

/**
 * Whether a folder holds a pk3.
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function holdsPaks(dir) {
  const paks = await listPaks(dir).catch(() => []);
  return paks.length > 0;
}

/**
 * The install a picked folder names: the folder itself when its `baseq3` holds a pak, or the
 * folder above when the pick is `baseq3` itself.
 *
 * @param {string} folder - The folder the player picked.
 * @returns {Promise<string | undefined>} `fs_basepath`, or `undefined` for a folder with no paks.
 */
export async function installOf(folder) {
  if (await holdsPaks(nodePath.join(folder, BASEGAME))) return folder;
  const isBaseq3 = nodePath.basename(folder).toLowerCase() === BASEGAME;
  return isBaseq3 && (await holdsPaks(folder)) ? nodePath.dirname(folder) : undefined;
}

/**
 * The kept install, if its `baseq3` still holds a pak.
 *
 * @param {string} homepath - `fs_homepath`.
 * @returns {Promise<string | undefined>} `fs_basepath`, or `undefined` for the player to pick one.
 */
export async function keptInstall(homepath) {
  /** @type {unknown} */
  let kept;
  try {
    kept = JSON.parse(await readFile(nodePath.join(homepath, SHELL_FILE), 'utf8'))?.fs_basepath;
  } catch {
    return undefined;
  }
  if (typeof kept !== 'string') return undefined;
  return (await holdsPaks(nodePath.join(kept, BASEGAME))) ? kept : undefined;
}

/**
 * Keep the install for the next start.
 *
 * @param {string} homepath - `fs_homepath`.
 * @param {string} basepath - `fs_basepath`.
 * @returns {Promise<void>}
 */
export async function keepInstall(homepath, basepath) {
  await mkdir(homepath, { recursive: true });
  const file = nodePath.join(homepath, SHELL_FILE);
  // Written beside it and moved into place, so a crash never leaves half a file.
  await writeFile(`${file}.tmp`, `${JSON.stringify({ fs_basepath: basepath }, null, 2)}\n`, 'utf8');
  await rename(`${file}.tmp`, file);
}
