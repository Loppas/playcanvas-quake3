import { describe, expect, it } from 'vitest';

import { CON_LINE_WIDTH, CON_NOTIFY_TIME, NotifyLines, type NotifyRow } from './notify-lines';

/** The text of a row, the spaces it does not draw put back from where its characters are. */
function text(row: NotifyRow): string {
  let out = '';
  for (const glyph of row.glyphs) {
    out = out.padEnd(glyph.x / 8 - 1) + String.fromCharCode(glyph.row * 16 + glyph.col);
  }
  return out;
}

/** A console that echoes nowhere. */
function quiet(): NotifyLines {
  return new NotifyLines(() => {});
}

describe('NotifyLines', () => {
  it('shows a line at the top left, a character to every 8 pixels from the 8th', () => {
    const lines = quiet();
    lines.print('Hi there\n', 1000);
    const rows = lines.rows(1000, false);
    // The line, and under it the one being written, which is empty but has its row.
    expect(rows.map(text)).toEqual(['Hi there', '']);
    expect(rows.map((row) => row.y)).toEqual([0, 16]);
    // 'H' is 72: row 4, column 8. The space between the words is not drawn.
    expect(rows[0].glyphs[0]).toEqual({ x: 8, row: 4, col: 8, color: 7 });
    expect(rows[0].glyphs.map((glyph) => glyph.x)).toEqual([8, 16, 32, 40, 48, 56, 64]);
  });

  it('colours what follows each code, and starts each print in white', () => {
    const lines = quiet();
    lines.print('^1Sarge^7 was railed by ^4Visor\n', 1000);
    lines.print('next\n', 1000);
    const [railed, next] = lines.rows(1000, false);
    expect(text(railed)).toBe('Sarge was railed by Visor');
    expect(railed.glyphs.map((glyph) => glyph.color).join('')).toBe(
      `${'1'.repeat(5)}${'7'.repeat(11)}${'4'.repeat(5)}`
    );
    expect(next.glyphs.every((glyph) => glyph.color === 7)).toBe(true);
  });

  it('keeps three whole lines over the one being written, and lets the oldest go', () => {
    const lines = quiet();
    for (const line of ['one', 'two', 'three', 'four']) lines.print(`${line}\n`, 1000);
    expect(lines.rows(1000, false).map(text)).toEqual(['two', 'three', 'four', '']);
  });

  it('shows a line for three seconds of real time, and then gives its row up', () => {
    expect(CON_NOTIFY_TIME).toBe(3000);
    const lines = quiet();
    lines.print('one\n', 1000);
    lines.print('two\n', 2000);
    expect(lines.rows(4000, false).map(text)).toEqual(['one', 'two', '']);
    const later = lines.rows(4001, false);
    expect(later.map(text)).toEqual(['two', '']);
    expect(later[0].y).toBe(0);
    expect(lines.rows(5001, false)).toEqual([]);
  });

  it('gives a blank line a row of its own', () => {
    const lines = quiet();
    lines.print('a\n\nb\n', 1000);
    const rows = lines.rows(1000, false);
    expect(rows.map(text)).toEqual(['a', '', 'b', '']);
    expect(rows.map((row) => row.y)).toEqual([0, 16, 32, 48]);
  });

  it('starts a word that would run past the edge on a new line', () => {
    expect(CON_LINE_WIDTH).toBe(78);
    const lines = quiet();
    lines.print(`${'a'.repeat(70)} ${'b'.repeat(10)}\n`, 1000);
    expect(lines.rows(1000, false).map(text)).toEqual(['a'.repeat(70), 'b'.repeat(10), '']);
  });

  it('breaks a word longer than a line where the rest of it fits on the next', () => {
    // The word is counted again at every character, and only once what is left is shorter than a
    // line does it go over: 23 in, 77 are left.
    const lines = quiet();
    lines.print(`${'c'.repeat(100)}\n`, 1000);
    expect(lines.rows(1000, false).map(text)).toEqual(['c'.repeat(23), 'c'.repeat(77), '']);
  });

  it('starts a new line as soon as one is full, with nothing more to print', () => {
    // A space is a word of none, so nothing wraps before one, and 77 of them take the line to
    // its edge. The line is done there, before the next print, which starts on a line of its own.
    const lines = quiet();
    lines.print(`a${' '.repeat(77)}`, 1000);
    expect(lines.rows(1000, false).map(text)).toEqual(['a', '']);
    lines.print('b\n', 1000);
    expect(lines.rows(1000, false).map(text)).toEqual(['a', 'b', '']);
  });

  it('ends a word at a byte over 127, as C reads a signed character', () => {
    const lines = quiet();
    // "bbbbé" fits after the a's, and only "bbbbb" goes over; read whole, all ten would.
    lines.print(`${'a'.repeat(70)} bbbbébbbbb\n`, 1000);
    const rows = lines.rows(1000, false).map(text);
    expect(rows).toEqual([`${'a'.repeat(70)} bbbbé`, 'bbbbb', '']);
  });

  it('goes back to the start of the line for a carriage return', () => {
    const lines = quiet();
    lines.print('abc\rX\n', 1000);
    expect(lines.rows(1000, false).map(text)).toEqual(['Xbc', '']);
  });

  it('hides every line under a menu', () => {
    const lines = quiet();
    lines.print('one\n', 1000);
    expect(lines.rows(1000, true)).toEqual([]);
    expect(lines.rows(1000, false)).toHaveLength(2);
  });

  it('shows nothing printed before a clear, but the unfinished line once it is written to', () => {
    const lines = quiet();
    lines.print('old\n', 1000);
    lines.print('part', 1000);
    lines.clear();
    expect(lines.rows(1000, false)).toEqual([]);

    lines.print('ial\n', 1500);
    expect(lines.rows(1500, false).map(text)).toEqual(['partial', '']);
  });

  it("echoes each print to the browser's console, without its colours or its last newline", () => {
    const echoed: string[] = [];
    const lines = new NotifyLines((line) => echoed.push(line));
    lines.print('^1Sarge^7 connected\n', 1000);
    lines.print('two\nlines\n', 1000);
    expect(echoed).toEqual(['Sarge connected', 'two\nlines']);
  });
});
