import { colorIndex, colorRuns, isColorCode } from '../formats/color-codes';
import { SCREEN_WIDTH } from './hud-layout';
import { SMALLCHAR_HEIGHT, SMALLCHAR_WIDTH, type Glyph } from './hud-text';

/**
 * Q3's console, as far as its notify lines read it: everything printed, and the last few lines of
 * it drawn over the top of the game for a few seconds each (`cl_console.c`). Engine-free.
 *
 * What cgame prints comes here: the obituaries, and every `print` the server sends. So does the
 * other half of `Com_Printf`, the text a dedicated server's terminal shows, which is the browser's
 * console here.
 *
 * The rules are id's release, where ioq3 has since changed them, and so the lines cited here are
 * id's. Four lines' times are kept, so three whole lines show above the one being written. Each
 * line takes its row whether it has anything on it or not. A line is 78 characters wide whatever
 * the screen, and each character is 8 by 16 of the screen's own pixels, as `SCR_DrawSmallChar`
 * draws it (`cl_scrn.c:156–186`), with no shadow.
 */

/**
 * `NUM_CON_TIMES` (`cl_console.c:30`): the lines whose times are kept, the one being written among
 * them.
 */
export const NUM_CON_TIMES = 4;

/** `con_notifytime`'s 3 (`cl_console.c:315`): how long a line shows, in milliseconds. */
export const CON_NOTIFY_TIME = 3000;

/** `Con_CheckResize` (`cl_console.c:253`): the width of a line in characters, 78. */
export const CON_LINE_WIDTH = SCREEN_WIDTH / SMALLCHAR_WIDTH - 2;

/** A character on a notify line, in the screen's own pixels, and its colour in `g_color_table`. */
export interface NotifyGlyph extends Glyph {
  color: number;
}

/** One line `Con_DrawNotify` draws: its top, in the screen's own pixels, and its characters. */
export interface NotifyRow {
  y: number;
  glyphs: NotifyGlyph[];
}

/** `COLOR_WHITE`, which every print starts in. */
const COLOR_WHITE = 7;

/** A space in white, which a new line is filled with (`Con_Linefeed`). */
const BLANK = (COLOR_WHITE << 8) | 32;

/**
 * Whether a word ends at `at`. C reads the text as signed bytes, so anything above 127 ends a word
 * as a space does, and so does the end of the text.
 */
function endsWord(text: string, at: number): boolean {
  if (at >= text.length) return true;
  const byte = text.charCodeAt(at) & 255;
  return byte <= 32 || byte >= 128;
}

export class NotifyLines {
  /** `con.current`: the line being written. */
  private current = 0;
  /** `con.x`: where in it the next character goes. */
  private x = 0;
  /**
   * `con.text`, as far as the notify lines read it: the last {@link NUM_CON_TIMES} lines, each
   * character's colour in its high byte.
   */
  private readonly text = Array.from({ length: NUM_CON_TIMES }, () =>
    new Uint16Array(CON_LINE_WIDTH).fill(BLANK)
  );
  /** `con.times`: when each line was last written, on the real clock, or 0 for none to show. */
  private readonly times = new Array<number>(NUM_CON_TIMES).fill(0);
  private readonly echo: (line: string) => void;

  /** @param echo - Where each print goes as well, its colours taken out: the browser's console. */
  constructor(echo: (line: string) => void = (line) => console.log(line)) {
    this.echo = echo;
  }

  /**
   * `Com_Printf`: `CL_ConsolePrint`'s wrapping onto the console's lines (`cl_console.c:370–458`),
   * and the same text without its colours to {@link echo}.
   *
   * Each print starts in white, and a colour code colours what follows it. A word that would run
   * past the edge starts a new line. The word is counted again at every character, so one longer
   * than a whole line runs on until what is left of it would fit on the next, and breaks there.
   *
   * @param realTime - `cls.realtime`, in milliseconds: when the lines it writes were written.
   */
  print(text: string, realTime: number): void {
    this.echo(
      colorRuns(text)
        .map((run) => run.text)
        .join('')
        .replace(/\n$/, '')
    );

    let color = COLOR_WHITE;
    let i = 0;
    while (i < text.length) {
      if (isColorCode(text, i)) {
        color = colorIndex(text[i + 1]);
        i += 2;
        continue;
      }

      let length = 0;
      while (length < CON_LINE_WIDTH && !endsWord(text, i + length)) length++;
      if (length !== CON_LINE_WIDTH && this.x + length >= CON_LINE_WIDTH) this.linefeed(realTime);

      const c = text.charCodeAt(i) & 255;
      i++;
      if (c === 10) {
        this.linefeed(realTime);
      } else if (c === 13) {
        this.x = 0;
      } else {
        this.line(this.current)[this.x] = (color << 8) | c;
        this.x++;
        if (this.x >= CON_LINE_WIDTH) this.linefeed(realTime);
      }
    }

    this.times[this.current % NUM_CON_TIMES] = realTime;
  }

  /**
   * `Con_DrawNotify` (`cl_console.c:502–571`): the lines still showing, top down from the top of
   * the screen.
   *
   * Each of the last {@link NUM_CON_TIMES} lines that was written in the last
   * {@link CON_NOTIFY_TIME} takes a row, and one that has timed out gives its row up to the next.
   * A space is not drawn.
   *
   * @param realTime - `cls.realtime`, in milliseconds.
   * @param hidden - A menu is up and the match is not at its intermission, which hides them all.
   */
  rows(realTime: number, hidden: boolean): NotifyRow[] {
    const rows: NotifyRow[] = [];
    if (hidden) return rows;
    let y = 0;
    for (let i = this.current - NUM_CON_TIMES + 1; i <= this.current; i++) {
      if (i < 0) continue;
      const time = this.times[i % NUM_CON_TIMES];
      if (time === 0 || realTime - time > CON_NOTIFY_TIME) continue;

      const glyphs: NotifyGlyph[] = [];
      this.line(i).forEach((cell, x) => {
        const ch = cell & 255;
        if (ch === 32) return;
        glyphs.push({ x: (x + 1) * SMALLCHAR_WIDTH, row: ch >> 4, col: ch & 15, color: cell >> 8 });
      });
      rows.push({ y, glyphs });
      y += SMALLCHAR_HEIGHT;
    }
    return rows;
  }

  /**
   * `Con_ClearNotify` (`cl_console.c:231–237`): nothing printed so far shows, as on a restart and
   * once a map is in (`cl_cgame.c:339, 768`). The lines are still there, and a print onto the one
   * being written shows it again.
   */
  clear(): void {
    this.times.fill(0);
  }

  /** `Con_Linefeed`: the line is done, stamped, and a blank one begun (`cl_console.c:340–359`). */
  private linefeed(realTime: number): void {
    this.times[this.current % NUM_CON_TIMES] = realTime;
    this.x = 0;
    this.current++;
    this.line(this.current).fill(BLANK);
  }

  private line(index: number): Uint16Array {
    return this.text[index % NUM_CON_TIMES];
  }
}
