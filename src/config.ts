/**
 * `DEBUG_MODE`: the port's `sv_cheats`. With it on, the menu's Debug section shows
 * and god can be set; with it off, both are hidden and god is forced off. The default binds follow
 * it: C and P are bound only under it.
 *
 * On under the dev server, and off in every build: the web build, the desktop shell's and the
 * dedicated server's.
 */
export const DEBUG_MODE = import.meta.env.DEV;

/** The game's name, as the main menu's banner and the boot's load screen show it. */
export const GAME_NAME = 'playcanvas-quake3';
