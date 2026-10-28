import type { ConsoleText } from './console-print';

/**
 * Q3's console as ioquake3 slides it down (`Con_RunConsole`, `cl_console.c:805–827`) and draws its
 * text (`Con_DrawSolidConsole`, `:662–765`): the buffer's lines from the bottom up, each character
 * in the colour it was printed in. The lines cited here are `cl_console.c`'s. Engine-free.
 */

/** `con.finalFrac` while the console has the keys: half the screen (`:807–808`). */
export const CONSOLE_OPEN_FRAC = 0.5;

/** The colours a character can be printed in: `g_color_table`'s. */
export const CONSOLE_COLORS = 8;

/**
 * `Con_RunConsole`: how far down the screen the console stands after a frame, as a fraction of its
 * height. It moves toward half the screen while it has the keys, and toward none once it hasn't,
 * by `scr_conspeed` screens a second.
 *
 * @param displayFrac - `con.displayFrac`, where it stood.
 * @param open - Whether `KEYCATCH_CONSOLE` is up.
 * @param speed - `scr_conspeed`.
 * @param frameMs - `cls.realFrametime`: the frame's real time, in milliseconds.
 */
export function runConsole(displayFrac: number, open: boolean, speed: number, frameMs: number): number {
  const finalFrac = open ? CONSOLE_OPEN_FRAC : 0;
  const step = speed * frameMs * 0.001;
  if (finalFrac < displayFrac) return Math.max(finalFrac, displayFrac - step);
  if (finalFrac > displayFrac) return Math.min(finalFrac, displayFrac + step);
  return displayFrac;
}

/**
 * The rows of text a console `lines` pixels tall draws (`:713, 725`): all but the bottom one, which
 * the version takes, and one fewer while the view is scrolled back, for the row of marks.
 */
export function textRows(lines: number, charHeight: number, scrolledBack: boolean): number {
  return Math.trunc((lines - charHeight) / charHeight) - (scrolledBack ? 1 : 0);
}

/**
 * The buffer's line each text row draws, bottom up (`:728–746`): the view's line, or the one before
 * it while nothing is written on the line being written (`con.x` 0), then each row up an older one.
 * A row past the oldest line the ring holds is -1 and draws nothing. The first line is numbered one
 * less than the lines the ring holds, so that takes in every row before it too.
 */
export function drawnLines(text: ConsoleText, rows: number): number[] {
  const lines: number[] = [];
  let line = text.display;
  if (text.x === 0) line--;
  for (let row = 0; row < rows; row++, line--) {
    lines.push(text.current - line >= text.totalLines ? -1 : line);
  }
  return lines;
}

/**
 * The drawn lines' characters as one text per colour (`:748–758`), so each can be drawn in its
 * colour: the rows top down, a line apiece, each holding that colour's characters in their columns
 * and spaces between. A row with none of the colour is a space, and trailing spaces are left off.
 * A colour nothing is printed in is the empty string.
 *
 * A space draws nothing, and neither does a byte outside printable ASCII, which the console's face
 * has no glyph for.
 *
 * @param lines - {@link drawnLines}'s, bottom up.
 */
export function colorLayers(text: ConsoleText, lines: readonly number[]): string[] {
  const rows = Array.from({ length: CONSOLE_COLORS }, () => new Array<string>(lines.length).fill(' '));
  const used = new Array<boolean>(CONSOLE_COLORS).fill(false);
  lines.forEach((line, fromBottom) => {
    if (line < 0) return;
    const row = lines.length - 1 - fromBottom;
    const chars = new Array<string>(CONSOLE_COLORS).fill('');
    text.line(line).forEach((cell, column) => {
      const ch = cell & 255;
      if (ch <= 32 || ch >= 127) return;
      const color = cell >> 8;
      chars[color] += ' '.repeat(column - chars[color].length) + String.fromCharCode(ch);
      used[color] = true;
    });
    chars.forEach((drawn, color) => {
      if (drawn !== '') rows[color][row] = drawn;
    });
  });
  return rows.map((layer, color) => (used[color] ? layer.join('\n') : ''));
}

/** The row of marks a view scrolled back draws: a `^` in every fourth column from the first (`:718–726`). */
export function scrollMarks(lineWidth: number): string {
  return '^   '.repeat(Math.ceil(lineWidth / 4)).trimEnd();
}
