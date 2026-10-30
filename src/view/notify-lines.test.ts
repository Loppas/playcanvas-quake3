import { describe, expect, it } from 'vitest';

import { K } from '../formats/q3-keys';
import { KEYCATCH } from '../settings/client-input';
import { ConsoleBuffer } from './console-buffer';
import { EditField } from './edit-field';
import {
  chatRow,
  notifyRows,
  type NotifyGlyph,
  type NotifyRow,
  type NotifySettings
} from './notify-lines';

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

describe('chatRow', () => {
  const MESSAGE = KEYCATCH.MESSAGE;

  /** `count` notify rows `charHeight` pixels tall. */
  const rows = (count: number, charHeight = 16): NotifyRow[] =>
    Array.from({ length: count }, (_, i) => ({
      y: i * charHeight,
      charWidth: 8,
      charHeight,
      glyphs: []
    }));

  /** A chat line with `typed` in it, said to everyone or to the team. */
  function chat(typed = '', team = false, overstrike = false) {
    const field = new EditField({ overstrike }, team ? 25 : 30);
    for (const ch of typed) field.char(ch);
    return { field, team };
  }

  /** The characters of a part, each with where it starts. */
  const chars = (glyphs: readonly NotifyGlyph[]) =>
    glyphs.map((glyph) => [String.fromCharCode(glyph.row * 16 + glyph.col), glyph.x]);

  /** The row's top at `height` pixels, under `count` notify rows. */
  const top = (count: number, height: number, charHeight = 16) =>
    chatRow(rows(count, charHeight), chat(), MESSAGE, false, 0, height)?.y;

  it('draws nothing unless the chat line is up, with no menu and no console showing', () => {
    expect(chatRow([], chat(), 0, false, 0, 960)).toBeNull();
    expect(chatRow([], chat(), KEYCATCH.CONSOLE, false, 0, 960)).toBeNull();
    expect(chatRow([], chat(), MESSAGE | KEYCATCH.UI, false, 0, 960)).toBeNull();
    expect(chatRow([], chat(), MESSAGE, true, 0, 960)).toBeNull();
    expect(chatRow([], chat(), MESSAGE, false, 0, 960)).not.toBeNull();
    // The console's catcher with it is the console dropped, which shows.
    expect(chatRow([], chat(), MESSAGE | KEYCATCH.CONSOLE, true, 0, 960)).toBeNull();
  });

  it('stands 8 below the notify lines, their height put on the grid and cut to whole units', () => {
    // At 960 pixels a 16-pixel row is 8 units.
    expect([0, 1, 2, 3].map((count) => top(count, 960))).toEqual([8, 16, 24, 32]);
    // At 1080 it is 7.1 units, which the C's int keeps the whole of.
    expect([0, 1, 2, 3].map((count) => top(count, 1080))).toEqual([8, 15, 22, 29]);
    // At 720 three rows are 32 units exactly.
    expect([1, 2, 3].map((count) => top(count, 720))).toEqual([18, 29, 40]);
    // con_scale 2's rows are 32 pixels.
    expect([1, 2].map((count) => top(count, 960, 32))).toEqual([24, 40]);
  });

  it("puts say: at 8 and the field 5 cells in, or say_team: and the field 10 cells in", () => {
    const say = chatRow([], chat('hi'), MESSAGE, false, 0, 960)!;
    expect(chars(say.prompt)).toEqual([['s', 8], ['a', 24], ['y', 40], [':', 56]]);
    expect(say.prompt.every((glyph) => glyph.color === 7)).toBe(true);
    expect(chars(say.field)).toEqual([['h', 80], ['i', 96]]);

    const team = chatRow([], chat('hi', true), MESSAGE, false, 0, 960)!;
    expect(chars(team.prompt).map(([ch]) => ch).join('')).toBe('say_team:');
    expect(team.prompt[8].x).toBe(8 + 8 * 16);
    expect(chars(team.field)).toEqual([['h', 160], ['i', 176]]);
  });

  it('shows the colour codes typed, colouring from the ^ on, a space drawing nothing', () => {
    const row = chatRow([], chat('ok ^1go'), MESSAGE, false, 0, 960)!;
    expect(chars(row.field)).toEqual([
      ['o', 80],
      ['k', 96],
      ['^', 128],
      ['1', 144],
      ['g', 160],
      ['o', 176]
    ]);
    expect(row.field.map((glyph) => glyph.color)).toEqual([7, 7, 1, 1, 1, 1]);
  });

  it('draws the cursor at its place in the window, an underline or an overstriking block', () => {
    const line = chat('abc');
    line.field.keyDown(K.LEFTARROW);
    const underline = chatRow([], line, MESSAGE, false, 0, 960)!.cursor;
    expect(underline).toEqual({ x: 80 + 2 * 16, row: 0, col: 10, color: 7 });
    const block = chatRow([], chat('abc', false, true), MESSAGE, false, 255, 960)!.cursor;
    expect(block).toEqual({ x: 80 + 3 * 16, row: 0, col: 11, color: 7 });
  });

  it('blinks the cursor 256 ms on and 256 off, on real time', () => {
    const cursor = (realTime: number) =>
      chatRow([], chat('a'), MESSAGE, false, realTime, 960)!.cursor;
    expect(cursor(0)).not.toBeNull();
    expect(cursor(255)).not.toBeNull();
    expect(cursor(256)).toBeNull();
    expect(cursor(511)).toBeNull();
    expect(cursor(512)).not.toBeNull();
  });

  it('shows the window a long line scrolls to, a character short of the width', () => {
    const typed = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const row = chatRow([], chat(typed), MESSAGE, false, 0, 960)!;
    // 40 typed into 30: the scroll is 11, and 29 show, the cursor in the cell after them.
    expect(row.field.map((glyph) => String.fromCharCode(glyph.row * 16 + glyph.col)).join('')).toBe(
      typed.slice(11)
    );
    expect(row.field[0].x).toBe(80);
    expect(row.field.at(-1)!.x).toBe(80 + 28 * 16);
    expect(row.cursor!.x).toBe(80 + 29 * 16);

    // The team's line shows 24.
    const team = chatRow([], chat(typed, true), MESSAGE, false, 0, 960)!;
    expect(team.field).toHaveLength(24);
    expect(team.cursor!.x).toBe(160 + 24 * 16);
  });
});
