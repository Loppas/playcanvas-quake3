/**
 * `UI_DrawPlayer`'s view of the player (`ui_players.c:714–772`), engine-free.
 *
 * The box is on Q3's 640×480 grid. Its horizontal fov is 90° for the whole grid's width, in whole
 * degrees, and its vertical fov follows from the box's shape. The body stands where it nearly fills
 * the box: a standing player's box, 56 units tall, seen from 0.7 of its height away, along its
 * middle. It turns three quarters toward the viewer, and plays on q3_ui's clock of half the real
 * time.
 */

/** `UI_DrawPlayer`'s `mins` and `maxs`: a standing player's box (`ui_players.c:724–725`). */
const MINS = [-16, -16, -24] as const;
const MAXS = [16, 16, 32] as const;

/** `180 - 30`: three quarters, toward the viewer (`ui_playersettings.c:243`, `ui_playermodel.c:179`). */
export const PREVIEW_YAW = 150;

/** The view `UI_DrawPlayer` sets up for a box. */
export interface PreviewFraming {
  /** The fovs, in degrees. */
  fovX: number;
  fovY: number;
  /** Where the body's origin goes, in Quake units from the eye, which looks along +X. */
  origin: readonly [number, number, number];
}

/**
 * The fovs and the body's place for a box on the grid (`ui_players.c:763–772`).
 *
 * @param width - The box's width on the grid.
 * @param height - Its height.
 */
export function previewFraming(width: number, height: number): PreviewFraming {
  const fovX = Math.trunc((width / 640) * 90);
  const half = Math.tan((fovX / 360) * Math.PI);
  const len = 0.7 * (MAXS[2] - MINS[2]);
  return {
    fovX,
    fovY: (Math.atan2(height, width / half) * 360) / Math.PI,
    origin: [len / half, 0.5 * (MINS[1] + MAXS[1]), -0.5 * (MINS[2] + MAXS[2])]
  };
}

/** q3_ui's clock for the preview: `uis.realtime / 2`, half the real time in whole milliseconds. */
export function previewTime(realTime: number): number {
  return Math.floor(realTime / 2);
}
