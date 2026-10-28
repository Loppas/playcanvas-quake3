import { describe, expect, it } from 'vitest';

import { ConsoleBuffer } from './console-buffer';
import { notifyRows, type NotifyRow, type NotifySettings } from './notify-lines';

/** `con_notifylines`, `con_notifytime`, `cl_conXOffset` and `con_scale` at ioquake3's defaults. */
const DEFAULTS: NotifySettings = { notifyLines: 3, notifyTime: 3, conXOffset: 0, conScale: 1 };

/** The text of a row, the spaces it does not draw put back from where its characters are. */
function text(row: NotifyRow): string {
  let out = '';
  for (const glyph of row.glyphs) {
    out = out.padEnd(glyph.x / 8 - 1) + String.fromCharCode(glyph.row * 16 + glyph.col);
  }
  return out;
}

/** A buffer `width` characters wide, with each of `prints` printed at its time. */
function printed(width: number, ...prints: [string, number][]): ConsoleBuffer {
  const buffer = new ConsoleBuffer();
  buffer.resize(width);
  for (const [line, time] of prints) buffer.print(line, time);
  return buffer;
}

/** The rows' text at `realTime`. */
function shown(buffer: ConsoleBuffer, realTime: number, settings: Partial<NotifySettings> = {}) {
  return notifyRows(buffer, { ...DEFAULTS, ...settings }, realTime, false).map(text);
}

// Every expectation below is what ioquake3's own `Con_DrawNotify`, compiled from its C, drew for
// the same prints.
describe('notifyRows', () => {
  it('shows a line at the top left, a character to every 8 pixels from the 8th', () => {
    const rows = notifyRows(printed(20, ['Hi there\n', 1000]), DEFAULTS, 1000, false);
    // The line being written under it is empty, and takes no row.
    expect(rows.map(text)).toEqual(['Hi there']);
    expect(rows[0].y).toBe(0);
    // 'H' is 72: row 4, column 8. The space between the words is not drawn.
    expect(rows[0].glyphs[0]).toEqual({ x: 8, row: 4, col: 8, color: 7 });
    expect(rows[0].glyphs.map((glyph) => glyph.x)).toEqual([8, 16, 32, 40, 48, 56, 64]);
  });

  it('draws each character in its own colour', () => {
    const buffer = printed(40, ['^1Sarge^7 was railed by ^4Visor\n', 1000], ['next\n', 1000]);
    const [railed, next] = notifyRows(buffer, DEFAULTS, 1000, false);
    expect(text(railed)).toBe('Sarge was railed by Visor');
    expect(railed.glyphs.map((glyph) => glyph.color).join('')).toBe(
      `${'1'.repeat(5)}${'7'.repeat(11)}${'4'.repeat(5)}`
    );
    expect(next.y).toBe(16);
    expect(next.glyphs.every((glyph) => glyph.color === 7)).toBe(true);
  });

  it('looks at con_notifylines lines over the one being written', () => {
    const buffer = printed(20, ['one\n', 1000], ['two\n', 1000], ['three\n', 1000]);
    buffer.print('four\n', 1000);
    expect(shown(buffer, 1000)).toEqual(['two', 'three', 'four']);
    expect(shown(buffer, 1000, { notifyLines: 1 })).toEqual(['four']);
    expect(shown(buffer, 1000, { notifyLines: 16 })).toEqual(['one', 'two', 'three', 'four']);
  });

  it('shows a line for con_notifytime seconds of real time, and then gives its row up', () => {
    const buffer = printed(20, ['one\n', 1000], ['two\n', 2000]);
    expect(shown(buffer, 4000)).toEqual(['one', 'two']);
    const later = notifyRows(buffer, DEFAULTS, 4001, false);
    expect(later.map(text)).toEqual(['two']);
    expect(later[0].y).toBe(0);
    expect(shown(buffer, 5001)).toEqual([]);
    // A fraction of a second, as the cvar's `value` reads it.
    expect(shown(buffer, 1499, { notifyTime: 0.5 })).toEqual(['one', 'two']);
    expect(shown(buffer, 1501, { notifyTime: 0.5 })).toEqual(['two']);
  });

  it('gives a blank line no row', () => {
    const rows = notifyRows(printed(20, ['a\n\nb\n', 1000]), DEFAULTS, 1000, false);
    expect(rows.map(text)).toEqual(['a', 'b']);
    expect(rows.map((row) => row.y)).toEqual([0, 16]);
  });

  it('shows the line being written once it has something on it, and nothing after a clear', () => {
    const buffer = printed(20, ['old\n', 1000], ['part', 1000]);
    expect(shown(buffer, 1000)).toEqual(['old', 'part']);
    buffer.clearNotify();
    expect(shown(buffer, 1000)).toEqual([]);
    buffer.print('ial\n', 1500);
    expect(shown(buffer, 1500)).toEqual(['partial']);
  });

  it('leaves out what a [skipnotify] print wrote', () => {
    const buffer = printed(20, ['one\n', 1000], ['[skipnotify]two\n', 2000]);
    expect(shown(buffer, 2000)).toEqual(['one']);
    buffer.print('three\n', 3000);
    expect(shown(buffer, 3000)).toEqual(['one', 'three']);
  });

  it("draws the console's characters, which con_scale makes larger", () => {
    const buffer = printed(20, ['ab\n', 1000], ['cd\n', 1000]);
    const rows = notifyRows(buffer, { ...DEFAULTS, conScale: 2 }, 1000, false);
    expect(rows.map((row) => [row.y, row.charWidth, row.charHeight])).toEqual([
      [0, 16, 32],
      [32, 16, 32]
    ]);
    expect(rows[0].glyphs.map((glyph) => glyph.x)).toEqual([16, 32]);
    expect(notifyRows(buffer, DEFAULTS, 1000, false)[0]).toMatchObject({ charWidth: 8, charHeight: 16 });
  });

  it('starts cl_conXOffset pixels in, either way', () => {
    const buffer = printed(20, ['ab\n', 1000]);
    const x = (conXOffset: number) => {
      const [row] = notifyRows(buffer, { ...DEFAULTS, conXOffset }, 1000, false);
      return row.glyphs.map((glyph) => glyph.x);
    };
    expect(x(100)).toEqual([108, 116]);
    expect(x(-8)).toEqual([0, 8]);
  });

  it('hides every line while it is hidden', () => {
    const buffer = printed(20, ['one\n', 1000]);
    expect(notifyRows(buffer, DEFAULTS, 1000, true)).toEqual([]);
    expect(notifyRows(buffer, DEFAULTS, 1000, false).map(text)).toEqual(['one']);
  });

  it('shows a word wrapped onto the next line as a row of its own', () => {
    expect(shown(printed(10, ['aaaa bbbbbbb\n', 1000]), 1000)).toEqual(['aaaa', 'bbbbbbb']);
  });

  it('shows nothing printed before a resize, and what comes after', () => {
    const buffer = printed(20, ['x\n', 1000]);
    buffer.resize(30);
    expect(shown(buffer, 1000)).toEqual([]);
    buffer.print('y\n', 2000);
    expect(shown(buffer, 2000)).toEqual(['y']);
  });

  it('draws a byte past 127 as the character it is in the font', () => {
    const [row] = notifyRows(printed(20, ['caf\xe9 \xff\n', 1000]), DEFAULTS, 1000, false);
    expect(row.glyphs.slice(3)).toEqual([
      { x: 32, row: 14, col: 9, color: 7 },
      { x: 48, row: 15, col: 15, color: 7 }
    ]);
  });

  it('never shows a line written at time 0', () => {
    expect(shown(printed(20, ['zero\n', 0]), 0)).toEqual([]);
  });
});
