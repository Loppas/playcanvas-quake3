import { describe, expect, it, vi } from 'vitest';

import { COMMAND_HISTORY, ConsoleHistory, MAX_CONSOLE_SAVE_BUFFER } from './console-history';
import { IOQ3_HISTORY } from './console-key-test-fixtures';
import type { FieldLine } from './edit-field';

/** A history read from `saved`, and what it printed. */
function history(saved?: string) {
  const print = vi.fn();
  const lines = new ConsoleHistory(print);
  lines.load(saved);
  return { lines, print };
}

/** A line as typed and entered: its cursor at its end, unscrolled. */
const typed = (text: string): FieldLine => ({ text, cursor: text.length, scroll: 0 });

/** The text of each line Up brings back, `times` times. */
const upTexts = (lines: ConsoleHistory, times: number) =>
  Array.from({ length: times }, () => lines.older().text);

describe('ConsoleHistory', () => {
  it('brings back the lines entered, newest first, and past the newest an empty one', () => {
    const { lines } = history('');
    lines.add(typed('map q3dm1'));
    lines.add(typed('say hi'));
    expect(upTexts(lines, 3)).toEqual(['say hi', 'map q3dm1', 'map q3dm1']);
    expect(lines.newer().text).toBe('say hi');
    expect(lines.newer()).toEqual({ text: '', cursor: 0, scroll: 0 });
    expect(lines.newer().text).toBe('');
    expect(lines.older().text).toBe('say hi');
  });

  it('goes back to its end once a line is entered', () => {
    const { lines } = history('');
    for (const text of ['a', 'b', 'c']) lines.add(typed(text));
    upTexts(lines, 3);
    lines.add(typed('d'));
    expect(lines.older().text).toBe('d');
  });

  it('brings back an empty line on Up before any is entered', () => {
    const { lines } = history('');
    expect(lines.older()).toEqual({ text: '', cursor: 0, scroll: 0 });
    expect(lines.newer()).toEqual({ text: '', cursor: 0, scroll: 0 });
  });

  it('keeps each line with its cursor and scroll', () => {
    const { lines } = history('');
    lines.add({ text: 'say hello there', cursor: 3, scroll: -60 });
    expect(lines.older()).toEqual({ text: 'say hello there', cursor: 3, scroll: -60 });
  });

  it(`holds the last ${COMMAND_HISTORY} lines, and goes back no further`, () => {
    const { lines } = history('');
    for (let n = 0; n < 40; n++) lines.add(typed(`echo ${n}`));
    const back = upTexts(lines, COMMAND_HISTORY + 2);
    expect(back[0]).toBe('echo 39');
    expect(back[COMMAND_HISTORY - 1]).toBe('echo 8');
    expect(back.slice(COMMAND_HISTORY)).toEqual(['echo 8', 'echo 8']);
  });

  it('brings back an empty line past the newest of a full history, not its oldest', () => {
    const { lines } = history('');
    for (let n = 0; n <= COMMAND_HISTORY; n++) lines.add(typed(`echo ${n}`));
    expect(lines.older().text).toBe(`echo ${COMMAND_HISTORY}`);
    expect(lines.newer()).toEqual({ text: '', cursor: 0, scroll: 0 });
  });

  it('hears of each line entered, and of nothing read', () => {
    const lines = new ConsoleHistory(() => {});
    const heard = vi.fn();
    const stop = lines.onSave(heard);
    lines.load('1 0 1 a ');
    expect(heard).not.toHaveBeenCalled();
    lines.add(typed('b'));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    lines.add(typed('c'));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("ConsoleHistory's file", () => {
  it('reads a file ioquake3 wrote, and writes it back the same', () => {
    const { lines, print } = history(IOQ3_HISTORY);
    expect(print).not.toHaveBeenCalled();
    expect(lines.text()).toBe(IOQ3_HISTORY);
    expect(lines.older()).toEqual({ text: '\\quit', cursor: 5, scroll: 0 });
    const scrolled = `\\echo ${'x'.repeat(90)}`;
    expect(upTexts(lines, 3)).toEqual([scrolled, '\\echo shorte', scrolled]);
    expect(lines.older()).toEqual({ text: '\\say hi', cursor: 7, scroll: 0 });
  });

  it('writes each line newest first: its cursor, scroll, length and text', () => {
    const { lines } = history('');
    lines.add(typed('map q3dm1'));
    lines.add({ text: 'say a  b', cursor: 2, scroll: -3 });
    expect(lines.text()).toBe('2 -3 8 say a  b 9 0 9 map q3dm1 ');
    expect(history('').lines.text()).toBe('');
  });

  it(`writes a history of more than ${COMMAND_HISTORY} lines from its newest`, () => {
    const { lines } = history('');
    for (let n = 0; n < 40; n++) lines.add(typed(`${n}`));
    let newestFirst = '';
    for (let n = 39; n >= 40 - COMMAND_HISTORY; n--) {
      const { length } = `${n}`;
      newestFirst += `${length} 0 ${length} ${n} `;
    }
    expect(lines.text()).toBe(newestFirst);
  });

  it('reads it back oldest to newest, the history at its end', () => {
    const { lines, print } = history('2 -3 8 say a  b 9 0 9 map q3dm1 ');
    expect(print).not.toHaveBeenCalled();
    expect(lines.older()).toEqual({ text: 'say a  b', cursor: 2, scroll: -3 });
    expect(lines.older()).toEqual({ text: 'map q3dm1', cursor: 9, scroll: 0 });
    expect(lines.older().text).toBe('map q3dm1');
    expect(lines.text()).toBe('2 -3 8 say a  b 9 0 9 map q3dm1 ');
  });

  it('keeps the lines read on, newer ones entered after them', () => {
    const { lines } = history('1 0 1 a ');
    lines.add(typed('b'));
    expect(lines.text()).toBe('1 0 1 b 1 0 1 a ');
    expect(upTexts(lines, 3)).toEqual(['b', 'a', 'a']);
  });

  it(`says it couldn't read a file there is none of, or one of ${MAX_CONSOLE_SAVE_BUFFER}`, () => {
    expect(history(undefined).print).toHaveBeenCalledWith("Couldn't read q3history.\n");
    const full = `1 0 1 a ${' '.repeat(MAX_CONSOLE_SAVE_BUFFER - 8)}`;
    const { lines, print } = history(full);
    expect(print).toHaveBeenCalledWith("Couldn't read q3history.\n");
    expect(lines.older().text).toBe('');
    expect(history(full.slice(0, -1)).lines.older().text).toBe('a');
  });

  it('reads a file as COM_Parse reads its numbers: quoted, after comments, or as atoi', () => {
    const { lines } = history('"3" 0x5 3 abc // a note\n 2 0 /* x */ "2" de ');
    expect(lines.older()).toEqual({ text: 'abc', cursor: 3, scroll: 0 });
    expect(lines.older()).toEqual({ text: 'de', cursor: 2, scroll: 0 });
  });

  it('takes the one character after the length, whatever it is, and the text as it stands', () => {
    const { lines } = history('1 0 3\n a\n0 0 0  2 0 2 x  ');
    expect(upTexts(lines, 3)).toEqual([' a\n', '', 'x ']);
  });

  it('keeps the lines read before one that runs past the end, or has a length below 0', () => {
    expect(upTexts(history('1 0 1 a 1 0 9 bc ').lines, 2)).toEqual(['a', 'a']);
    expect(upTexts(history('1 0 1 a 1 0 -1 bc ').lines, 2)).toEqual(['a', 'a']);
    expect(upTexts(history('1 0 1 a 1 0 1').lines, 2)).toEqual(['a', 'a']);
    expect(upTexts(history('1 0 1 a 1 0').lines, 2)).toEqual(['a', 'a']);
    expect(history('9 0 1 a ').lines.older().text).toBe('a');
  });

  it('reads no further than a NUL, as a C string ends there', () => {
    expect(upTexts(history('1 0 1 a \u00001 0 1 b ').lines, 2)).toEqual(['a', 'a']);
  });

  it(`reads the newest ${COMMAND_HISTORY} lines of a file with more`, () => {
    let saved = '';
    for (let n = 40; n > 0; n--) saved += `1 0 ${String(n).length} ${n} `;
    const back = upTexts(history(saved).lines, COMMAND_HISTORY + 1);
    expect(back[0]).toBe('40');
    expect(back[COMMAND_HISTORY - 1]).toBe('9');
    expect(back[COMMAND_HISTORY]).toBe('9');
  });

  it('writes no empty line it read', () => {
    const { lines } = history('0 0 0  1 0 1 a ');
    expect(lines.older().text).toBe('');
    expect(lines.text()).toBe('1 0 1 a ');
  });

  it('writes the newest lines that fit, leaving 13 characters for each one’s numbers', () => {
    const { lines } = history('');
    const line = 'x'.repeat(240);
    for (let n = 0; n < 5; n++) lines.add(typed(line));
    // Four fit at 251 characters each, and a fifth would need 1257.
    expect(lines.text()).toBe(`240 0 240 ${line} `.repeat(4));
    expect(lines.text().length).toBe(1004);
  });

  it('writes a line its 13 leave short of the room, and none they bring to it', () => {
    /** The file of a line `oldest` long, entered before four that take 1004. */
    const saved = (oldest: number) => {
      const { lines } = history('');
      lines.add(typed('y'.repeat(oldest)));
      for (let n = 0; n < 4; n++) lines.add(typed('x'.repeat(240)));
      return lines.text();
    };
    // 1004, 6 and 13 come to 1023; with 7 they come to the room, 1024.
    expect(saved(6)).toBe(`${saved(7)}6 0 6 yyyyyy `);
    expect(saved(7).length).toBe(1004);
  });

  it('cuts the file a character short of its room where the numbers outgrow it', () => {
    const { lines } = history('');
    // Entered after Ctrl+E on a console 238 wide: its numbers and spaces take 14 characters.
    lines.add({ text: 'y'.repeat(120), cursor: 120, scroll: -118 });
    for (const length of [211, 211, 212, 212]) lines.add(typed('x'.repeat(length)));
    // The four newer take 890, so it fits by the 13 it is allowed and runs one past the room.
    const saved = lines.text();
    expect(saved.length).toBe(MAX_CONSOLE_SAVE_BUFFER - 1);
    expect(saved.endsWith(` 120 -118 120 ${'y'.repeat(120)}`)).toBe(true);
    const back = upTexts(history(saved).lines, 5).map((text) => text.length);
    expect(back).toEqual([212, 212, 211, 211, 120]);
  });
});
