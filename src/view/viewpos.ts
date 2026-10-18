import type { FirstPersonView } from './camera-feel';

/**
 * `viewpos`: Quake 3's readout of where the view is (`CG_Viewpos_f`, `cg_consolecmds.c:80–84`).
 *
 * It is how a splat map's entities are placed. A reading goes to splat-maps'
 * `entities readings`, which turns it into an entity: a spawn spot stands 26 units below it, the
 * standing view height, and an intermission point is the reading itself.
 *
 * The view is the one last drawn, as Q3's `cg.refdef` is when a console command runs between
 * frames: the player's eye, the camera behind the body in third person, or the fly camera.
 * Engine-free.
 */

/** The command's name, which cgame matches without regard to case (`cg_consolecmds.c:521–522`). */
export const VIEWPOS_COMMAND = 'viewpos';

/** Whether a command is `viewpos`. */
export function isViewpos(argv: readonly string[]): boolean {
  return argv[0]?.toLowerCase() === VIEWPOS_COMMAND;
}

/**
 * The reading, as `CG_Printf ("(%i %i %i) : %i\n", ...)` prints it: the view origin and the yaw,
 * each cast to an int, which truncates towards zero.
 *
 * @param view - `cg.refdef.vieworg` and `cg.refdefViewAngles`, in Quake units and degrees.
 */
export function viewpos(view: FirstPersonView): string {
  const { origin, angles } = view;
  return `(${toInt(origin.x)} ${toInt(origin.y)} ${toInt(origin.z)}) : ${toInt(angles.y)}`;
}

/** C's `(int)` cast of a float. `Math.trunc` gives −0 for a small negative, which prints as 0. */
function toInt(value: number): number {
  return Math.trunc(value);
}
