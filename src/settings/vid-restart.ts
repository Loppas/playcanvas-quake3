import type { FileKeeper } from './config-file';
import type { Cvars } from './cvars';
import type { GameConfig } from './game-config';
import { settingForCvar } from './registry';

/**
 * `vid_restart`: every write of `q3config.cfg` asked for lands, then the page reloads and takes up
 * the latched settings, where Q3 restarts its renderer and keeps the game (`cl_main.c:1917–1927`).
 */

/**
 * The address to reload at: this one, with each setting it set given the tab's string now. The
 * tab never saves such a setting, so only the address can carry a change to it.
 */
export function restartAddress(href: string, cvars: Cvars): string {
  const url = new URL(href);
  for (const name of new Set(url.searchParams.keys())) {
    const key = settingForCvar(name);
    const value = cvars.string(name);
    if (key && cvars.fromUrl(key) && value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Save, then reload at {@link restartAddress}. */
export async function vidRestart(
  config: GameConfig,
  keeper: FileKeeper,
  location: Location = window.location,
  history: History = window.history
): Promise<void> {
  await keeper.settled();
  history.replaceState(history.state, '', restartAddress(location.href, config.cvars));
  location.reload();
}
