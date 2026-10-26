import { colorIndex, isColorCode } from '../formats/color-codes';

/**
 * Q3's console text: everything printed, kept in one ring of character cells cut into lines as
 * wide as the console, which the console draws and scrolls back through and whose last lines are
 * the notify lines. The rules are ioquake3's (`cl_console.c`), and the lines cited here are its.
 * Engine-free.
 */

/** `CON_TEXTSIZE` (`cl_console.c:34`): the cells in the ring, whatever the width. */
export const CON_TEXTSIZE = 32768;

/**
 * `NUM_CON_TIMES` (`cl_console.c:32`): how many of the last lines keep their times, the one being
 * written among them.
 */
export const NUM_CON_TIMES = 17;

/** `DEFAULT_CONSOLE_WIDTH` (`cl_console.c:27`): the width before there is a screen to fit. */
export const DEFAULT_CONSOLE_WIDTH = 78;

/** `COLOR_WHITE`, which every print starts in. */
const COLOR_WHITE = 7;

/** A space in white, which a new line is filled with. */
const BLANK = (COLOR_WHITE << 8) | 32;

/** The prefix that keeps a print's lines off the notify lines (`cl_console.c:456`). */
const SKIP_NOTIFY = '[skipnotify]';

/**
 * Whether a word ends at `at`. C counts the word through signed chars, so anything above 127 ends
 * it as a space does, and so does the end of the text.
 */
function endsWord(text: string, at: number): boolean {
  if (at >= text.length) return true;
  const byte = text.charCodeAt(at) & 255;
  return byte <= 32 || byte >= 128;
}

export class ConsoleBuffer {
  /** `con.text`: each cell a character, its colour in `g_color_table` in the high byte. */
  private readonly text = new Uint16Array(CON_TEXTSIZE);
  /** `con.times`: when each of the last lines was written, or 0 for none to show. */
  private readonly times = new Array<number>(NUM_CON_TIMES).fill(0);
  /** `con.x`: where on the line being written the next character goes. */
  private x = 0;
  private currentLine = 0;
  private displayLine = 0;
  /** -1 until the first resize, as `CL_ConsolePrint` sets it before its first (`:471`). */
  private width = -1;
  private lines = 0;

  /** The buffer as Q3 first makes it, before there is a screen: blank, 78 wide. */
  constructor() {
    this.resize(0);
  }

  /** `con.current`: the line being written, counted from the first. */
  get current(): number {
    return this.currentLine;
  }

  /** `con.display`: the line at the bottom of the view, `current` unless scrolled back. */
  get display(): number {
    return this.displayLine;
  }

  /** `con.linewidth`: the characters on a line. */
  get lineWidth(): number {
    return this.width;
  }

  /** `con.totallines`: the lines the ring holds at this width. */
  get totalLines(): number {
    return this.lines;
  }

  /**
   * `CL_ConsolePrint` (`:447–533`): the text wrapped onto the console's lines.
   *
   * Each print starts in white, and a colour code colours what follows it, across lines, to the
   * print's end. A word that would run past the edge starts a new line. The word is counted again
   * at every character, so one longer than a whole line runs on until what is left of it would
   * fit on the next, and breaks there. `\r` goes back to the line's start.
   *
   * A print that starts `[skipnotify]` stamps its lines 0, and takes the line before the one it
   * leaves off the notify lines too.
   *
   * @param realTime - `cls.realtime`, in milliseconds: when the lines it writes were written.
   */
  print(text: string, realTime: number): void {
    const skipNotify = text.startsWith(SKIP_NOTIFY);
    const from = skipNotify ? SKIP_NOTIFY.length : 0;

    let color = COLOR_WHITE;
    let i = from;
    while (i < text.length) {
      if (isColorCode(text, i)) {
        color = colorIndex(text[i + 1]);
        i += 2;
        continue;
      }

      let length = 0;
      while (length < this.width && !endsWord(text, i + length)) length++;
      if (length !== this.width && this.x + length >= this.width) {
        this.linefeed(skipNotify, realTime);
      }

      const c = text.charCodeAt(i) & 255;
      i++;
      if (c === 10) {
        this.linefeed(skipNotify, realTime);
      } else if (c === 13) {
        this.x = 0;
      } else {
        // A narrowed console leaves `x` where it was, so this can land past the line's end
        // (`Con_CheckResize` keeps it, `:284–346`).
        this.text[(this.currentLine % this.lines) * this.width + this.x] = (color << 8) | c;
        this.x++;
        if (this.x >= this.width) this.linefeed(skipNotify, realTime);
      }
    }

    if (skipNotify) {
      this.times[(this.currentLine + NUM_CON_TIMES - 1) % NUM_CON_TIMES] = 0;
    } else {
      this.times[this.currentLine % NUM_CON_TIMES] = realTime;
    }
  }

  /**
   * `Con_CheckResize` (`:284–346`), given the width in characters.
   *
   * The newest lines are kept, each cut to the narrower of the two widths, and none is wrapped
   * again; nothing printed so far shows on the notify lines. A width under 1, which Q3 reads as
   * no screen yet, blanks the ring at 78 wide instead. Either way the view goes to the bottom.
   */
  resize(width: number): void {
    if (width === this.width) return;

    if (width < 1) {
      this.width = DEFAULT_CONSOLE_WIDTH;
      this.lines = Math.floor(CON_TEXTSIZE / this.width);
      this.text.fill(BLANK);
    } else {
      const old = this.text.slice();
      const oldWidth = this.width;
      const oldLines = this.lines;
      this.width = width;
      this.lines = Math.floor(CON_TEXTSIZE / width);
      const kept = Math.min(oldLines, this.lines);
      const chars = Math.min(oldWidth, width);

      this.text.fill(BLANK);
      for (let i = 0; i < kept; i++) {
        const from = ((this.currentLine - i + oldLines) % oldLines) * oldWidth;
        this.text.set(old.subarray(from, from + chars), (this.lines - 1 - i) * width);
      }
      this.clearNotify();
    }

    this.currentLine = this.lines - 1;
    this.displayLine = this.currentLine;
  }

  /** The cells of line `index`, a view onto the ring rather than a copy. */
  line(index: number): Uint16Array {
    const start = (index % this.lines) * this.width;
    return this.text.subarray(start, start + this.width);
  }

  /**
   * When line `index` was written, or 0 for not to show. Only the last {@link NUM_CON_TIMES}
   * lines have their own: an older line reads a newer one's.
   */
  lineTime(index: number): number {
    return this.times[index % NUM_CON_TIMES];
  }

  /**
   * `Con_ClearNotify` (`:267–273`): nothing printed so far shows on the notify lines. The lines
   * are still there, and a print onto the one being written shows it again.
   */
  clearNotify(): void {
    this.times.fill(0);
  }

  /** `Con_PageUp` (`:830–835`): the view back two lines, as far as the oldest the ring holds. */
  pageUp(): void {
    this.displayLine -= 2;
    if (this.currentLine - this.displayLine >= this.lines) {
      this.displayLine = this.currentLine - this.lines + 1;
    }
  }

  /** `Con_PageDown` (`:837–842`): the view on two lines, as far as the bottom. */
  pageDown(): void {
    this.displayLine += 2;
    if (this.displayLine > this.currentLine) this.displayLine = this.currentLine;
  }

  /**
   * `Con_Top` (`:844–849`): the view on the line numbered as many as the ring holds, or on the
   * oldest it holds once it has wrapped. Before it has wrapped that is near the first line
   * printed, and just after a resize it is one past the bottom.
   */
  top(): void {
    this.displayLine = this.lines;
    if (this.currentLine - this.displayLine >= this.lines) {
      this.displayLine = this.currentLine - this.lines + 1;
    }
  }

  /** `Con_Bottom` (`:851–853`): the view back on the line being written. */
  bottom(): void {
    this.displayLine = this.currentLine;
  }

  /**
   * `Con_Linefeed` (`:417–436`): the line is done and stamped, and a blank one begun. A view at
   * the bottom moves down with it; one scrolled back stays where it is.
   */
  private linefeed(skipNotify: boolean, realTime: number): void {
    this.times[this.currentLine % NUM_CON_TIMES] = skipNotify ? 0 : realTime;
    this.x = 0;
    if (this.displayLine === this.currentLine) this.displayLine++;
    this.currentLine++;
    const start = (this.currentLine % this.lines) * this.width;
    this.text.fill(BLANK, start, start + this.width);
  }
}
