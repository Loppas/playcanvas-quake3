import { describe, expect, it } from 'vitest';

import { K } from '../formats/q3-keys';
import { cursorShown, EditField, MAX_FIELD_LENGTH, typedColors } from './edit-field';
import { fieldCorpus, runField, type FieldRun } from './edit-field-test-fixtures';

/**
 * The corpus over three seeds, 6000 steps each, as ioquake3's own `Field_KeyDownEvent`,
 * `Field_CharEvent`, `Field_Paste` (through `Sys_GetClipboardData`), `Field_Clear` and
 * `Field_VariableSizeDraw`, compiled from its C, ran it: the steps by kind, how far they reached,
 * and the digest of the state after every step.
 */
const TWIN: Record<number, FieldRun> = {
  1: {
    keys: 2933,
    chars: 2204,
    pastes: 140,
    draws: 685,
    widths: 29,
    clears: 9,
    drawsBeforeLine: 0,
    longest: 254,
    lowestScroll: -203,
    digest: '7efcefa6'
  },
  2: {
    keys: 2889,
    chars: 2226,
    pastes: 129,
    draws: 718,
    widths: 32,
    clears: 6,
    drawsBeforeLine: 2,
    longest: 254,
    lowestScroll: -178,
    digest: '58c16f26'
  },
  3: {
    keys: 2895,
    chars: 2167,
    pastes: 131,
    draws: 767,
    widths: 23,
    clears: 17,
    drawsBeforeLine: 16,
    longest: 254,
    lowestScroll: -85,
    digest: '57fe0198'
  }
};

const CTRL_A = '\x01';
const CTRL_C = '\x03';
const CTRL_E = '\x05';
const CTRL_H = '\b';

/** A field `width` characters wide, in insert, and the mode it shares. */
function edit(width = 78) {
  const mode = { overstrike: false };
  return { mode, field: new EditField(mode, width) };
}

/** `text` typed as a browser types it: each character after its key. */
function type(field: EditField, text: string): void {
  for (const ch of text) {
    field.keyDown(ch.toLowerCase().charCodeAt(0));
    field.char(ch);
  }
}

/** `key` pressed `times` times. */
function press(field: EditField, key: number, times = 1): void {
  for (let i = 0; i < times; i++) field.keyDown(key);
}

/** The line, the cursor and the scroll. */
const state = (field: EditField) => [field.text, field.cursor, field.scroll];

/** What a draw shows, and the cursor's place in it, from a window that starts on the line. */
function drawn(field: EditField): [string, number] {
  const { start, length } = field.window();
  return [field.text.slice(start, start + length), field.cursor - start];
}

// Every expectation below is what the twin printed for the same steps.
describe('EditField', () => {
  it('puts a character in at the cursor, or over the one there once Insert swaps the mode', () => {
    const { field, mode } = edit();
    type(field, 'abcd');
    press(field, K.LEFTARROW, 2);
    type(field, 'X');
    expect(state(field)).toEqual(['abXcd', 3, 0]);

    field.clear();
    type(field, 'abcd');
    press(field, K.HOME);
    expect(field.keyDown(K.INS)).toBe(true);
    expect(mode.overstrike).toBe(true);
    type(field, 'XY');
    expect(state(field)).toEqual(['XYcd', 2, 0]);
    // At the line's end, overstrike adds to it.
    press(field, K.END);
    type(field, 'Z');
    expect(state(field)).toEqual(['XYcdZ', 5, 0]);
    press(field, K.INS);
    type(field, 'W');
    expect(state(field)).toEqual(['XYcdZW', 6, 0]);
  });

  it('shares insert and overstrike with every field given the same mode', () => {
    const { field, mode } = edit();
    const other = new EditField(mode, 30);
    type(other, 'abc');
    press(other, K.HOME);
    press(field, K.INS);
    type(other, 'X');
    expect(other.text).toBe('Xbc');
  });

  it('takes the character before the cursor on Ctrl+H, and the one at it on Delete', () => {
    const { field } = edit();
    type(field, 'abcde');
    press(field, K.LEFTARROW, 2);
    expect(field.char(CTRL_H)).toBe(true);
    expect(state(field)).toEqual(['abde', 2, 0]);
    expect(field.keyDown(K.DEL)).toBe(true);
    expect(state(field)).toEqual(['abe', 2, 0]);
    // Neither past the line's ends.
    press(field, K.END);
    press(field, K.DEL);
    press(field, K.HOME);
    field.char(CTRL_H);
    expect(state(field)).toEqual(['abe', 0, 0]);
  });

  it("moves the cursor with the arrows, Home and End, and passes the keypad's by", () => {
    const { field } = edit();
    type(field, 'ab');
    press(field, K.RIGHTARROW);
    expect(field.cursor).toBe(2);
    press(field, K.HOME);
    press(field, K.LEFTARROW);
    expect(field.cursor).toBe(0);
    for (const key of [K.KP_RIGHTARROW, K.KP_END, K.KP_DEL]) expect(field.keyDown(key)).toBe(false);
    expect(state(field)).toEqual(['ab', 0, 0]);
  });

  it('clears the line on Ctrl+C, and passes other control characters by, Ctrl+V too', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklm');
    expect(field.char(CTRL_C)).toBe(true);
    expect(state(field)).toEqual(['', 0, 0]);
    expect(drawn(field)).toEqual(['', 0]);

    type(field, 'ab');
    for (const ch of '\t\r\n\x0c\x1b\x16') expect(field.char(ch)).toBe(false);
    expect(state(field)).toEqual(['ab', 2, 0]);
  });

  it('takes printable ASCII alone, where ioquake3 stores any byte but NUL', () => {
    const { field } = edit();
    for (const ch of ['\x7f', 'é', '\u{1f600}', '']) expect(field.char(ch)).toBe(false);
    expect(field.char('~')).toBe(true);
    expect(field.char(' ')).toBe(true);
    expect(state(field)).toEqual(['~ ', 2, 0]);
  });

  it('scrolls once the cursor reaches its width, and draws a character short of it', () => {
    const { field } = edit(10);
    type(field, 'abcdefghi');
    expect(drawn(field)).toEqual(['abcdefghi', 9]);
    type(field, 'j');
    expect(field.scroll).toBe(1);
    expect(drawn(field)).toEqual(['bcdefghij', 9]);
    type(field, 'klmno');
    expect(state(field)).toEqual(['abcdefghijklmno', 15, 6]);
    expect(drawn(field)).toEqual(['ghijklmno', 9]);
  });

  it('steps the scroll for a character typed in the middle too', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmnopqrst');
    press(field, K.LEFTARROW, 3);
    expect(state(field)).toEqual(['abcdefghijklmnopqrst', 17, 11]);
    type(field, 'X');
    expect(state(field)).toEqual(['abcdefghijklmnopqXrst', 18, 12]);
    expect(drawn(field)).toEqual(['mnopqXrst', 6]);
  });

  it('keeps the cursor in view on Home and End', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmno');
    press(field, K.HOME);
    expect(state(field)).toEqual(['abcdefghijklmno', 0, 0]);
    expect(drawn(field)).toEqual(['abcdefghi', 0]);
    press(field, K.END);
    expect(state(field)).toEqual(['abcdefghijklmno', 15, 6]);
    expect(drawn(field)).toEqual(['ghijklmno', 9]);
  });

  it("goes to the ends on Ctrl+A and Ctrl+E, Ctrl+E's scroll a character short", () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmno');
    expect(field.char(CTRL_A)).toBe(true);
    expect(state(field)).toEqual(['abcdefghijklmno', 0, 0]);
    expect(drawn(field)).toEqual(['abcdefghi', 0]);
    expect(field.char(CTRL_E)).toBe(true);
    expect(state(field)).toEqual(['abcdefghijklmno', 15, 5]);
    expect(drawn(field)).toEqual(['fghijklmn', 10]);
    // End puts it right.
    press(field, K.END);
    expect(drawn(field)).toEqual(['ghijklmno', 9]);
  });

  it('leaves the scroll below 0 after Ctrl+E on a short line, drawing from the start', () => {
    const { field } = edit(10);
    type(field, 'abc');
    field.char(CTRL_E);
    expect(state(field)).toEqual(['abc', 3, -7]);
    // As long as the line, being shorter than the room.
    expect(field.window()).toEqual({ start: 0, length: 3 });
    expect(drawn(field)).toEqual(['abc', 3]);
    // A key's fix-up keeps it the cursor's width back.
    type(field, 'd');
    expect(state(field)).toEqual(['abcd', 4, -6]);
  });

  it('starts the window before the line for a paste after Ctrl+E, until a key mends it', () => {
    const { field } = edit(10);
    type(field, 'ab');
    field.char(CTRL_E);
    expect(field.scroll).toBe(-8);
    // Ctrl+V's key, then the browser's paste.
    field.keyDown('v'.charCodeAt(0));
    field.paste('cdefghijklmn');
    expect(state(field)).toEqual(['abcdefghijklmn', 14, -2]);
    expect(field.window()).toEqual({ start: -2, length: 9 });
    press(field, K.END);
    expect(field.scroll).toBe(5);
    expect(drawn(field)).toEqual(['fghijklmn', 9]);
  });

  it('brings the scroll back with the cursor on Ctrl+H', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmno');
    press(field, K.LEFTARROW, 9);
    expect(state(field)).toEqual(['abcdefghijklmno', 6, 6]);
    field.char(CTRL_H);
    expect(state(field)).toEqual(['abcdeghijklmno', 5, 5]);
    expect(drawn(field)).toEqual(['ghijklmno', 0]);
  });

  it('pulls the scroll back to show the line’s end as it draws, and keeps it there', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmnopqrst');
    field.char(CTRL_H);
    field.char(CTRL_H);
    field.char(CTRL_H);
    expect(state(field)).toEqual(['abcdefghijklmnopq', 17, 11]);
    expect(drawn(field)).toEqual(['ijklmnopq', 9]);
    expect(field.scroll).toBe(8);
    press(field, K.LEFTARROW, 2);
    expect(state(field)).toEqual(['abcdefghijklmnopq', 15, 8]);
    expect(drawn(field)).toEqual(['ijklmnopq', 7]);
  });

  it('holds the line to 254 characters, inserting or overstriking', () => {
    const { field } = edit();
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (const ch of alphabet.repeat(10)) field.char(ch);
    const full = alphabet.repeat(10).slice(0, MAX_FIELD_LENGTH);
    expect(MAX_FIELD_LENGTH).toBe(254);
    // Each character past the width stepped the scroll, a full line's refusal not.
    expect(state(field)).toEqual([full, 254, 177]);
    expect(field.char('!')).toBe(true);
    expect(state(field)).toEqual([full, 254, 177]);
    // Overstrike refuses at the end, and writes over one before it.
    press(field, K.INS);
    field.char('?');
    expect(state(field)).toEqual([full, 254, 177]);
    press(field, K.HOME);
    field.char('?');
    expect(state(field)).toEqual([`?${full.slice(1)}`, 1, 0]);
  });

  it('pastes the first line, a character at a time', () => {
    const { field, mode } = edit();
    field.paste('hello\nworld');
    expect(state(field)).toEqual(['hello', 5, 0]);
    field.paste(' \r\nthere');
    expect(state(field)).toEqual(['hello ', 6, 0]);
    field.paste('');
    expect(state(field)).toEqual(['hello ', 6, 0]);

    // Over what is there, in overstrike.
    field.clear();
    type(field, 'abcdef');
    press(field, K.HOME);
    press(field, K.INS);
    field.paste('XY');
    expect([...state(field), mode.overstrike]).toEqual(['XYcdef', 2, 0, true]);
  });

  it('types the line breaks before a paste’s first line too, a backspace backspacing', () => {
    const { field } = edit();
    type(field, 'ab');
    field.paste('\n\r\nxy\rz');
    expect(state(field)).toEqual(['abxy', 4, 0]);

    field.clear();
    type(field, 'ab');
    field.paste('\b\bc');
    expect(state(field)).toEqual(['c', 1, 0]);

    field.clear();
    type(field, 'abc');
    field.paste('\b\n\b');
    expect(state(field)).toEqual(['a', 1, 0]);
  });

  it("acts on the control characters a paste holds, as on typed ones", () => {
    const { field } = edit();
    type(field, 'abc');
    field.paste(`x${CTRL_A}y${CTRL_E}z${CTRL_C}w`);
    expect(state(field)).toEqual(['w', 1, 0]);
  });

  it('pastes into a full line no more than fits, and scrolls as typing does', () => {
    const { field } = edit();
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (const ch of alphabet.repeat(9)) field.char(ch);
    field.paste(alphabet);
    expect(state(field)).toEqual([alphabet.repeat(10).slice(0, 254), 254, 177]);

    const narrow = edit(10).field;
    narrow.paste('abcdefghijklmnopqrst');
    expect(state(narrow)).toEqual(['abcdefghijklmnopqrst', 20, 11]);
    expect(drawn(narrow)).toEqual(['lmnopqrst', 9]);
  });

  it('draws in a new width as its next key leaves it, and nothing in a width of one', () => {
    const { field } = edit();
    type(field, 'abcdefghijkl');
    field.widthInChars = 5;
    expect(drawn(field)).toEqual(['abcd', 12]);
    press(field, K.LEFTARROW);
    expect(state(field)).toEqual(['abcdefghijkl', 11, 7]);
    expect(drawn(field)).toEqual(['hijk', 4]);
    field.widthInChars = 1;
    expect(drawn(field)).toEqual(['', 4]);
  });

  it('clears to an empty line with its cursor and scroll at the start', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmno');
    field.clear();
    expect(state(field)).toEqual(['', 0, 0]);
    expect(drawn(field)).toEqual(['', 0]);
  });

  it.each([1, 2, 3])('runs seed %i as ioquake3 does', (seed) => {
    expect(runField(fieldCorpus(seed, 6000))).toEqual(TWIN[seed]);
  });
});

// ioquake3 copies a whole `field_t` in and out of its history, so these have no twin.
describe("EditField's line, as the console's history keeps it", () => {
  it('gives its line and takes one back, its own width kept', () => {
    const { field } = edit(10);
    type(field, 'abcdefghijklmno');
    press(field, K.LEFTARROW);
    const line = field.line();
    expect(line).toEqual({ text: 'abcdefghijklmno', cursor: 14, scroll: 6 });

    const other = edit(20).field;
    other.restore(line);
    expect([...state(other), other.widthInChars]).toEqual(['abcdefghijklmno', 14, 6, 20]);
    // A scroll below 0 comes back as it was, as the draw reads it.
    other.restore({ text: 'abc', cursor: 3, scroll: -17 });
    expect(state(other)).toEqual(['abc', 3, -17]);
  });

  it('brings a cursor outside the line it takes back to its nearer end', () => {
    const { field } = edit();
    field.restore({ text: 'abc', cursor: 9, scroll: 0 });
    expect(state(field)).toEqual(['abc', 3, 0]);
    field.restore({ text: 'abc', cursor: -4, scroll: 0 });
    expect(state(field)).toEqual(['abc', 0, 0]);
  });

  it('takes no more characters on a line taken back longer than it types', () => {
    const { field, mode } = edit();
    const long = `\\${'a'.repeat(MAX_FIELD_LENGTH)}`;
    field.restore({ text: long, cursor: long.length, scroll: 0 });
    expect(field.char('b')).toBe(true);
    expect(field.text).toBe(long);
    press(field, K.HOME);
    field.char('b');
    expect(field.text).toBe(long);
    // Overstrike writes over what is there short of the limit, and nothing at it or past it.
    mode.overstrike = true;
    field.char('/');
    expect(field.text).toBe(`/${long.slice(1)}`);
    field.restore({ text: long, cursor: MAX_FIELD_LENGTH, scroll: 0 });
    field.char('b');
    field.restore({ ...field.line(), cursor: long.length });
    field.char('b');
    expect(field.text).toBe(long);
  });
});

describe('typedColors', () => {
  it('colours from white, each code from its caret on, the code drawn', () => {
    expect(typedColors('a^1bc^7d')).toEqual([7, 1, 1, 1, 1, 7, 7, 7]);
    // A letter picks by its code, and `^8` wraps round to black.
    expect(typedColors('^a^8')).toEqual([1, 1, 0, 0]);
  });

  it('takes a caret before anything but a letter or digit, or last, as text', () => {
    expect(typedColors('^!^^2x^')).toEqual([7, 7, 7, 2, 2, 2, 2]);
    expect(typedColors('')).toEqual([]);
  });
});

describe('cursorShown', () => {
  it('shows the cursor 256 ms, then hides it 256 ms', () => {
    expect([0, 255, 255.9, 256, 511, 512, 1023, 1024].map(cursorShown)).toEqual([
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true
    ]);
  });
});
