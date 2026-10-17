/**
 * Quake 3's colour codes: `^` and a letter or digit colours the text after it, in names, chat and
 * the console. The rules are ioq3's (`Q_IsColorString`, `q_shared.c:27–46`; `ColorIndex`,
 * `q_shared.h:412–413`), where id's 1.32 took any character after `^` but a second `^`
 * (`q_shared.h:533`). DOM- and engine-free.
 */

/** `Q_COLOR_ESCAPE` (`q_shared.h:401`). */
export const COLOR_ESCAPE = '^';

/**
 * `g_color_table` (`q_math.c:55–65`): the eight colours a code picks, red, green and blue from 0
 * to 1. `^0` is black, `^1` red, `^2` green, `^3` yellow, `^4` blue, `^5` cyan, `^6` magenta and
 * `^7` white.
 */
export const COLOR_TABLE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 1]
];

/** A stretch of text in one colour: by its place in {@link COLOR_TABLE}, or none before the first code. */
export interface ColorRun {
  text: string;
  color?: number;
}

/**
 * `Q_IsColorString`: whether a code starts at `at`, a `^` and an ASCII letter or digit. A `^` before
 * anything else, or last, is text.
 */
export function isColorCode(text: string, at: number): boolean {
  return text[at] === COLOR_ESCAPE && /^[0-9A-Za-z]$/.test(text[at + 1] ?? '');
}

/**
 * `ColorIndex`: the colour a code's letter or digit picks, by its distance from `0` in the low three
 * bits. `^8` and `^9` so wrap round to black and red, and a letter picks by its code too.
 */
export function colorIndex(ch: string): number {
  return (ch.charCodeAt(0) - '0'.charCodeAt(0)) & 7;
}

/**
 * Text read into runs of colour, the codes taken out, as Q3 draws it: each code colours what
 * follows, up to the next (`SCR_DrawStringExt`, `cl_scrn.c:222–241`). Text before the first code
 * has no colour of its own, and a run with no text is left out.
 */
export function colorRuns(text: string): ColorRun[] {
  const runs: ColorRun[] = [];
  let start = 0;
  let color: number | undefined;
  const close = (end: number) => {
    if (end <= start) return;
    const run = text.slice(start, end);
    runs.push(color === undefined ? { text: run } : { text: run, color });
  };
  for (let at = 0; at < text.length; at++) {
    if (!isColorCode(text, at)) continue;
    close(at);
    color = colorIndex(text[at + 1]);
    start = at + 2;
    at++;
  }
  close(text.length);
  return runs;
}

/**
 * `Q_CleanStr`: text with its colour codes taken out, and anything outside printable ASCII with
 * them.
 */
export function cleanStr(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at++) {
    if (isColorCode(text, at)) {
      at++;
      continue;
    }
    const code = text.charCodeAt(at);
    if (code >= 0x20 && code <= 0x7e) out += text[at];
  }
  return out;
}
