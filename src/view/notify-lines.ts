import type { Settings } from '../settings/registry';
import type { ConsoleText } from './console-print';
import { SMALLCHAR_HEIGHT, SMALLCHAR_WIDTH, type Glyph } from './hud-text';

/**
 * Q3's notify lines: the console's last few lines, drawn over the top of the game for a few
 * seconds each, as ioquake3's `Con_DrawNotify` draws them (`cl_console.c:577–653`). Each character
 * is 8 by 16 of the screen's own pixels, as `SCR_DrawSmallChar` draws it (`cl_scrn.c:160–186`),
 * with no shadow. Engine-free.
 */

/** A character on a notify line, in the screen's own pixels, and its colour in `g_color_table`. */
export interface NotifyGlyph extends Glyph {
  color: number;
}

/** One line `Con_DrawNotify` draws: its top, in the screen's own pixels, and its characters. */
export interface NotifyRow {
  y: number;
  glyphs: NotifyGlyph[];
}

/** The settings the notify lines read: `con_notifylines`, `con_notifytime` and `cl_conXOffset`. */
export type NotifySettings = Pick<Settings, 'notifyLines' | 'notifyTime' | 'conXOffset'>;

/**
 * The lines still showing, top down from the top of the screen.
 *
 * The line being written and the `con_notifylines` before it are looked at. One written in the last
 * `con_notifytime` seconds and not since cleared takes a row; one with nothing on it takes none.
 * A space is not drawn.
 *
 * @param realTime - `cls.realtime`, in milliseconds, the clock the lines were printed on.
 * @param hidden - A menu is up and the match is not at its intermission, which hides them all.
 */
export function notifyRows(
  text: ConsoleText,
  settings: NotifySettings,
  realTime: number,
  hidden: boolean
): NotifyRow[] {
  const rows: NotifyRow[] = [];
  if (hidden) return rows;
  let y = 0;
  for (let i = text.current - settings.notifyLines; i <= text.current; i++) {
    if (i < 0) continue;
    const time = text.lineTime(i);
    if (time === 0 || realTime - time > settings.notifyTime * 1000) continue;

    const glyphs: NotifyGlyph[] = [];
    text.line(i).forEach((cell, x) => {
      const ch = cell & 255;
      if (ch === 32) return;
      const left = settings.conXOffset + (x + 1) * SMALLCHAR_WIDTH;
      glyphs.push({ x: left, row: ch >> 4, col: ch & 15, color: cell >> 8 });
    });
    if (glyphs.length === 0) continue;
    rows.push({ y, glyphs });
    y += SMALLCHAR_HEIGHT;
  }
  return rows;
}
