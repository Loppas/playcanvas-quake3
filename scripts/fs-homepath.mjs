/**
 * Where the dev server keeps `q3config.cfg`: `fs_homepath`, in the OS's own place
 * (`default-homepath.mjs`), unless `PCQ_FS_HOMEPATH`, in the environment or in `.env.local`, puts
 * it anywhere else, as ioq3's `fs_homepath` cvar does.
 */

import nodePath from 'node:path';
import { loadEnv } from 'vite';

import { defaultHomepath } from './default-homepath.mjs';

/**
 * Resolve `fs_homepath`: `PCQ_FS_HOMEPATH` from the environment or from the `.env` files Vite
 * reads for `mode`, taken relative to `root`; unset, the OS's own place.
 *
 * @param root - The repo root, where the `.env` files live.
 * @param mode - Vite's mode.
 * @returns An absolute path.
 */
export function fsHomepath(root, mode) {
  const { PCQ_FS_HOMEPATH } = loadEnv(mode, root, 'PCQ_');
  return PCQ_FS_HOMEPATH ? nodePath.resolve(root, PCQ_FS_HOMEPATH) : defaultHomepath();
}
