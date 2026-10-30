import { KEYCATCH } from '../settings/client-input';
import type { Settings } from '../settings/registry';
import type { ChatLine } from './chat-line';
import type { ConsoleText } from './console-print';
import { cursorShown, fieldCells } from './edit-field';
import { SCREEN_HEIGHT } from './hud-layout';
import { BIGCHAR_WIDTH, smallCharHeight, smallCharWidth, type Glyph } from './hud-text';

/**
 * Q3's notify lines: the console's last few lines, drawn over the top of the game for a few
 * seconds each, as ioquake3's `Con_DrawNotify` draws them (`cl_console.c:577–653`). Each character
 * is the console's, 8 by 16 of the screen's own pixels under `con_scale`, as `SCR_DrawSmallChar`
 * draws it (`cl_scrn.c:160–186`), with no shadow. The chat line is drawn under them, in big
 * characters on Q3's grid. Engine-free.
 */

/** `COLOR_WHITE`, which the chat line's prompt and cursor are drawn in. */
const COLOR_WHITE = 7;

/** Where the chat line's prompt starts across Q3's grid, and how far its top is below the lines. */
const CHAT_LEFT = 8;
const CHAT_TOP = 8;

/** The cells the field starts at, after `say:` or `say_team:` (`skip`, `cl_console.c:636–647`). */
const SAY_SKIP = 5;
const TEAM_SKIP = 10;

/** The cursor's glyphs in `bigchars`: an underline inserting, a block overstriking. */
const CURSOR_INSERT = 10;
const CURSOR_OVERSTRIKE = 11;

/** A character on a notify line, in the screen's own pixels, and its colour in `g_color_table`. */
export interface NotifyGlyph extends Glyph {
  color: number;
}

/**
 * One line `Con_DrawNotify` draws: its top and its characters' size, in the screen's own pixels,
 * and its characters.
 */
export interface NotifyRow {
  y: number;
  charWidth: number;
  charHeight: number;
  glyphs: NotifyGlyph[];
}

/** The settings the notify lines read: `con_notifylines`, `con_notifytime`, `cl_conXOffset` and `con_scale`. */
export type NotifySettings = Pick<Settings, 'notifyLines' | 'notifyTime' | 'conXOffset' | 'conScale'>;

/**
 * The lines still showing, top down from the top of the screen.
 *
 * The line being written and the `con_notifylines` before it are looked at. One written in the last
 * `con_notifytime` seconds and not since cleared takes a row; one with nothing on it takes none.
 * A space is not drawn.
 *
 * @param realTime - `cls.realtime`, in milliseconds, the clock the lines were printed on.
 * @param hidden - Any of the console shows, or a menu is up and the match is not at its
 *   intermission, which hides them all.
 */
export function notifyRows(
  text: ConsoleText,
  settings: NotifySettings,
  realTime: number,
  hidden: boolean
): NotifyRow[] {
  const rows: NotifyRow[] = [];
  if (hidden) return rows;
  const charWidth = smallCharWidth(settings.conScale);
  const charHeight = smallCharHeight(settings.conScale);
  let y = 0;
  for (let i = text.current - settings.notifyLines; i <= text.current; i++) {
    if (i < 0) continue;
    const time = text.lineTime(i);
    if (time === 0 || realTime - time > settings.notifyTime * 1000) continue;

    const glyphs: NotifyGlyph[] = [];
    text.line(i).forEach((cell, x) => {
      const ch = cell & 255;
      if (ch === 32) return;
      const left = settings.conXOffset + (x + 1) * charWidth;
      glyphs.push({ x: left, row: ch >> 4, col: ch & 15, color: cell >> 8 });
    });
    if (glyphs.length === 0) continue;
    rows.push({ y, charWidth, charHeight, glyphs });
    y += charHeight;
  }
  return rows;
}

/**
 * The chat line under the notify lines, on Q3's grid, in its three parts, which are drawn in turn,
 * each with its shadow under it first.
 */
export interface ChatRow {
  /** The top of its characters. */
  y: number;
  /** `say:`, or `say_team:` for a line said to the team. */
  prompt: NotifyGlyph[];
  /** The field's window, its colour codes shown. */
  field: NotifyGlyph[];
  /** The cursor, or `null` while it blinks off. */
  cursor: NotifyGlyph | null;
}

/**
 * The chat line `Con_DrawNotify` draws (`cl_console.c:625–651`), or `null` where it draws none: the
 * MESSAGE catcher not up, a menu up, or any of the console showing, which draws in its place
 * (`Con_DrawConsole`, `:786–792`). The intermission keeps a menu's hiding, as the lines' does not.
 *
 * It stands 8 below the notify lines' height brought onto the grid, which the C cuts to whole
 * units. The prompt is at 8 across, the field's window from 5 cells in, or 10 after `say_team:`,
 * and the cursor at its place in the window, all as `SCR_DrawBigString` draws them.
 *
 * @param rows - The notify lines drawn this frame.
 * @param catchers - `Key_GetCatcher`.
 * @param consoleShown - Whether any of the console shows.
 * @param realTime - `cls.realtime`, in milliseconds, which the cursor blinks on.
 * @param height - The screen's height, in its own pixels.
 */
export function chatRow(
  rows: readonly NotifyRow[],
  line: Pick<ChatLine, 'field' | 'team'>,
  catchers: number,
  consoleShown: boolean,
  realTime: number,
  height: number
): ChatRow | null {
  if (!(catchers & KEYCATCH.MESSAGE) || catchers & KEYCATCH.UI || consoleShown) return null;
  const notified = rows.reduce((sum, row) => sum + row.charHeight, 0);
  const y = Math.trunc(notified * (SCREEN_HEIGHT / height)) + CHAT_TOP;

  const prompt = [...(line.team ? 'say_team:' : 'say:')].map((ch, at) =>
    chatGlyph(ch.charCodeAt(0), CHAT_LEFT + at * BIGCHAR_WIDTH, COLOR_WHITE)
  );
  const { field } = line;
  const left = (line.team ? TEAM_SKIP : SAY_SKIP) * BIGCHAR_WIDTH;
  const window = field.window();
  const cells = fieldCells(field.text, window).map(({ column, ch, color }) =>
    chatGlyph(ch.charCodeAt(0), left + column * BIGCHAR_WIDTH, color)
  );
  const cursor = cursorShown(realTime)
    ? chatGlyph(
        field.overstrike ? CURSOR_OVERSTRIKE : CURSOR_INSERT,
        left + (field.cursor - window.start) * BIGCHAR_WIDTH,
        COLOR_WHITE
      )
    : null;
  return { y, prompt, field: cells, cursor };
}

/** A character of `bigchars` at `x`, in `g_color_table`'s `color`. */
function chatGlyph(ch: number, x: number, color: number): NotifyGlyph {
  return { x, row: ch >> 4, col: ch & 15, color };
}
