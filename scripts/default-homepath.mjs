/**
 * `fs_homepath`'s place on each OS: the player's own writable folder, found as ioq3 finds its
 * home folder.
 * - **Windows:** `%LOCALAPPDATA%\playcanvas-quake3`. ioq3 takes the roaming `CSIDL_APPDATA`
 *   (`sys_win32.c:91–115`); the port takes the local folder.
 * - **macOS:** `~/Library/Application Support/playcanvas-quake3` (`sys_unix.c:123–143`).
 * - **Linux and the rest:** `$XDG_CONFIG_HOME/playcanvas-quake3`, or `~/.config/playcanvas-quake3`
 *   without it (`sys_unix.c:156–178`).
 *
 * Kept apart from `fs-homepath.mjs`, which reads the `.env` files through Vite, so the desktop
 * shell can use it where there is no Vite.
 */

import os from 'node:os';
import nodePath from 'node:path';

/** The folder's name, as ioq3's is `HOMEPATH_NAME`. */
export const HOMEPATH_NAME = 'playcanvas-quake3';

/**
 * The OS's own place for the folder.
 *
 * @param system - The platform, environment and home folder to go by; this machine's by default.
 * @returns An absolute path in the platform's own style.
 */
export function defaultHomepath({
  platform = process.platform,
  env = process.env,
  home = os.homedir()
} = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || nodePath.win32.join(home, 'AppData', 'Local');
    return nodePath.win32.join(local, HOMEPATH_NAME);
  }
  const { posix } = nodePath;
  const user = env.HOME || home;
  if (platform === 'darwin') return posix.join(user, 'Library', 'Application Support', HOMEPATH_NAME);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(user, '.config'), HOMEPATH_NAME);
}
