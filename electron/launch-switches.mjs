/**
 * What the shell starts Chromium with, from `q3config.cfg` as it stands at launch. Vertical sync,
 * `r_swapInterval`, off lifts Chromium's own pace, the display's, so that `com_maxfps` may pace
 * the frames past it. Chromium takes its switches only as it starts, so a change waits for the
 * next launch, as Q3's latched `r_swapInterval` waits for `vid_restart`; the page asks this
 * launch's at `/launch` (`app-protocol.mjs`).
 */

import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { configCommands } from '../scripts/q3-commands.mjs';
import { Q3CONFIG_CFG } from '../scripts/q3config-route.mjs';

/** The cvar, matched without regard to case. */
const SWAP_INTERVAL = 'r_swapinterval';

/** The commands that set a cvar by name (`Cvar_Set_f`). */
const SET_COMMANDS = new Set(['set', 'seta', 'sets', 'setu']);

/** The page's default for it: on. */
const DEFAULT_VSYNC = true;

/** Chromium's frames, no longer held to the display's rate nor to its refresh. */
export const UNPACED_SWITCHES = ['disable-frame-rate-limit', 'disable-gpu-vsync'];

/**
 * Whether a config leaves vertical sync on, as the page reads it: the last value set, by `set`
 * and its kin or the cvar's name, read as a switch is, a whole number and any but 0 on. A value
 * that isn't a whole number is refused, as the page refuses it, and changes nothing.
 *
 * @param {string} text - The config.
 * @returns {boolean}
 */
export function configVsync(text) {
  let vsync = DEFAULT_VSYNC;
  for (const [command, ...args] of configCommands(text)) {
    // `set` and its kin take the name and then the value; `Cvar_Command` the value alone. A name
    // alone only prints the value, and its empty one is refused below.
    const set = SET_COMMANDS.has(command.toLowerCase());
    const cvar = set ? args[0] : command;
    if (cvar?.toLowerCase() !== SWAP_INTERVAL) continue;
    const value = (set ? args.slice(1) : args).join(' ');
    const number = Number(value);
    if (value.trim() !== '' && Number.isInteger(number)) vsync = number !== 0;
  }
  return vsync;
}

/**
 * Vertical sync as this launch takes it up: the config in `fs_homepath`, or on where there is
 * none yet.
 *
 * @param {string} homepath - `fs_homepath`.
 * @returns {boolean}
 */
export function launchVsync(homepath) {
  let text;
  try {
    text = readFileSync(nodePath.join(homepath, Q3CONFIG_CFG), 'utf8');
  } catch {
    return DEFAULT_VSYNC;
  }
  return configVsync(text);
}

/**
 * The switches for a launch with vertical sync on or off.
 *
 * @param {boolean} vsync
 * @returns {readonly string[]}
 */
export function launchSwitches(vsync) {
  return vsync ? [] : UNPACED_SWITCHES;
}
