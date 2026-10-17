/**
 * Where the dev server and the pak tests find Quake 3's data.
 *
 * `fs_basepath` has ioq3's meaning: the install folder that holds the game directory, `baseq3`.
 * ioq3 registers the cvar at `files.c:3380` and mounts `<fs_basepath>/baseq3` through
 * `FS_AddGameDirectory` (`files.c:3032`). Here it comes from `PCQ_FS_BASEPATH`, in the
 * environment or in `.env.local`; unset, it is the repo root, so a checkout holding its own
 * `baseq3/` works as it always has.
 *
 * Shared by `vite.config.ts` and `src/pak/pak-test-fixtures.ts`, so the game and its tests
 * always read the same folder.
 */

import { resolve } from 'node:path';
import { loadEnv } from 'vite';

import { BASEGAME } from './baseq3-route.mjs';

export { BASEGAME };

/**
 * Resolve `fs_basepath`: `PCQ_FS_BASEPATH` from the environment or from the `.env` files Vite
 * reads for `mode`, taken relative to `root`; unset, `root` itself.
 *
 * @param root - The repo root, where the `.env` files live.
 * @param mode - Vite's mode: `development` for the dev server, `test` under Vitest.
 * @returns An absolute path.
 */
export function fsBasepath(root, mode) {
  const { PCQ_FS_BASEPATH } = loadEnv(mode, root, 'PCQ_');
  return resolve(root, PCQ_FS_BASEPATH || '.');
}

/**
 * The folder the paks are read from: `baseq3` under {@link fsBasepath}.
 *
 * @param root - The repo root.
 * @param mode - Vite's mode.
 * @returns An absolute path.
 */
export function baseq3Dir(root, mode) {
  return resolve(fsBasepath(root, mode), BASEGAME);
}
