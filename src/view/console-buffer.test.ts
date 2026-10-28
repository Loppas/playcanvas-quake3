import { describe, expect, it } from 'vitest';

import { ConsoleBuffer } from './console-buffer';
import {
  consoleCorpus,
  describeLines,
  runConsole,
  type ConsoleRun
} from './console-buffer-test-fixtures';

/**
 * The corpus over three seeds, 4000 steps each, as ioquake3's own `CL_ConsolePrint`,
 * `Con_Linefeed`, `Con_CheckResize`, `Con_ClearNotify`, `Con_PageUp`, `Con_PageDown`, `Con_Top` and
 * `Con_Bottom`, compiled from its C, ran it: the steps by kind, the lines the prints fed, and the
 * digest of the state after every step.
 */
const TWIN: Record<number, ConsoleRun> = {
  1: { prints: 3290, resizes: 110, scrolls: 558, clears: 42, linesFed: 54556, digest: 'c9522893' },
  2: { prints: 3297, resizes: 148, scrolls: 519, clears: 36, linesFed: 74759, digest: '2772ce54' },
  3: { prints: 3280, resizes: 120, scrolls: 563, clears: 37, linesFed: 86511, digest: '120b732f' }
};

/** A buffer `width` characters wide. */
function sized(width: number): ConsoleBuffer {
  const buffer = new ConsoleBuffer();
  buffer.resize(width);
  return buffer;
}

/** The last `count` lines' text, each character's colour, and time, the one being written last. */
function last(buffer: ConsoleBuffer, count: number) {
  return describeLines(buffer, count).lines.map(({ text, colors, time }) => ({ text, colors, time }));
}

/** Where the line being written and the view are. */
function lines(buffer: ConsoleBuffer) {
  return { current: buffer.current, display: buffer.display };
}

// Every expectation below is what the twin printed for the same steps.
describe('ConsoleBuffer', () => {
  it('starts blank and 78 wide, on the last of the 420 lines it holds', () => {
    const buffer = new ConsoleBuffer();
    expect([buffer.lineWidth, buffer.totalLines, buffer.current, buffer.display]).toEqual([
      78, 420, 419, 419
    ]);
    for (let n = 0; n < buffer.totalLines; n++) {
      expect(buffer.line(n).every((cell) => cell === (7 << 8) + 32)).toBe(true);
    }
  });

  it('starts a word that will not fit on a new line', () => {
    const buffer = sized(10);
    buffer.print('aaaa bbbbbbb\n', 1000);
    expect(last(buffer, 3)).toEqual([
      { text: 'aaaa', colors: '7777', time: 1000 },
      { text: 'bbbbbbb', colors: '7777777', time: 1000 },
      { text: '', colors: '', time: 1000 }
    ]);
  });

  it('runs a word longer than a line on until what is left of it would fit the next', () => {
    const buffer = sized(10);
    buffer.print('x abcdefghijklmnop\n', 1000);
    expect(last(buffer, 3).map((line) => line.text)).toEqual(['x abcdefg', 'hijklmnop', '']);

    const longer = sized(10);
    longer.print('abcdefghijklmnopqrstuvwxy\n', 1000);
    expect(last(longer, 4).map((line) => line.text)).toEqual([
      'abcdefghij',
      'klmnop',
      'qrstuvwxy',
      ''
    ]);
  });

  it('holds a colour to the end of the print, across lines, and starts the next in white', () => {
    const buffer = sized(20);
    buffer.print('^1red\nstill^2green\n', 1000);
    buffer.print('white\n', 2000);
    expect(last(buffer, 4)).toEqual([
      { text: 'red', colors: '111', time: 1000 },
      { text: 'stillgreen', colors: '1111122222', time: 1000 },
      { text: 'white', colors: '77777', time: 2000 },
      { text: '', colors: '', time: 2000 }
    ]);
  });

  it('prints a ^ before anything but a letter or digit', () => {
    const buffer = sized(20);
    buffer.print('^!x ^^y ^\n', 1000);
    // `^^y` is a `^`, and then `^y`, which is a code: `y` is 73 past `0`, red.
    expect(last(buffer, 2)[0]).toEqual({ text: '^!x ^ ^', colors: '7777711', time: 1000 });
  });

  it('goes back to the start of the line on \\r, and writes over it', () => {
    const buffer = sized(20);
    buffer.print('hello world\rHE\n', 1000);
    expect(last(buffer, 2)[0].text).toBe('HEllo world');
  });

  it('ends a word at a byte past 127 or a tab, and keeps each as a character', () => {
    const buffer = sized(10);
    buffer.print('abc\xe9defghij\n', 1000);
    expect(last(buffer, 3).map((line) => line.text)).toEqual(['abc\xe9', 'defghij', '']);

    const tab = sized(20);
    tab.print('a\tb\n', 0);
    // Written at 0, the line has the time of one not to show.
    expect(last(tab, 2)[0]).toEqual({ text: 'a\tb', colors: '777', time: 0 });
  });

  it('stamps [skipnotify] lines 0, and the line before the one it leaves off', () => {
    const buffer = sized(20);
    buffer.print('one\n', 1000);
    buffer.print('[skipnotify]two\n', 2000);
    buffer.print('three\n', 3000);
    buffer.print('[skipnotify]four', 4000);
    expect(last(buffer, 4)).toEqual([
      { text: 'one', colors: '777', time: 1000 },
      { text: 'two', colors: '777', time: 0 },
      // Printed plainly, but the line before where `four` left off.
      { text: 'three', colors: '77777', time: 0 },
      // Not stamped by its own print, so it keeps the time `three`'s print left on it.
      { text: 'four', colors: '7777', time: 3000 }
    ]);
  });

  it('keeps the newest lines on a resize, cut to the narrower width and not wrapped again', () => {
    const narrow = sized(20);
    narrow.print('abcdefghijklmnopqrs\n', 1000);
    narrow.print('short\n', 2000);
    narrow.resize(8);
    expect([narrow.lineWidth, narrow.totalLines, narrow.current, narrow.display]).toEqual([
      8, 4096, 4095, 4095
    ]);
    // Nothing printed before shows on the notify lines.
    expect(last(narrow, 3)).toEqual([
      { text: 'abcdefgh', colors: '77777777', time: 0 },
      { text: 'short', colors: '77777', time: 0 },
      { text: '', colors: '', time: 0 }
    ]);

    const wide = sized(8);
    wide.print('abcdefghij\n', 1000);
    wide.resize(20);
    wide.print('more\n', 2000);
    expect(last(wide, 4).map((line) => line.text)).toEqual(['abc', 'defghij', 'more', '']);
  });

  it('goes on from where it was on a line a resize left past the edge', () => {
    const newline = sized(20);
    newline.print('abcdefghijkl', 1000);
    newline.resize(8);
    // The `\n` is a word that will not fit, and then a line feed of its own.
    newline.print('\nx', 2000);
    expect(last(newline, 3).map((line) => line.text)).toEqual(['abcdefgh', '', 'x']);

    const word = sized(20);
    word.print('abcdefghijkl', 1000);
    word.resize(8);
    // A word as long as a line is written where `x` was, past the ring's end: `A` is lost.
    word.print('ABCDEFGHIJ\n', 2000);
    expect(last(word, 4).map((line) => line.text)).toEqual(['abcdefgh', 'BC', 'DEFGHIJ', '']);
  });

  it('blanks the ring at 78 wide for a width under 1, the notify times kept', () => {
    const buffer = sized(20);
    buffer.print('keep\n', 1000);
    buffer.resize(0);
    expect([buffer.lineWidth, buffer.totalLines, buffer.current, buffer.display]).toEqual([
      78, 420, 419, 419
    ]);
    // `keep` was written on line 1637 and left off on 1638, whose times lines 413 and 414 now
    // read, 17 lines apart a whole number of times.
    expect(last(buffer, 7).map((line) => line.time)).toEqual([1000, 1000, 0, 0, 0, 0, 0]);
    expect(last(buffer, 7).every((line) => line.text === '')).toBe(true);
  });

  it('keeps a view scrolled back where it is as lines come in, and moves one at the bottom on', () => {
    const buffer = sized(20);
    buffer.print('1\n2\n3\n4\n5\n', 1000);
    buffer.pageUp();
    buffer.print('new\n', 2000);
    expect(lines(buffer)).toEqual({ current: 1643, display: 1640 });
    buffer.bottom();
    buffer.print('newer\n', 3000);
    expect(lines(buffer)).toEqual({ current: 1644, display: 1644 });
  });

  it('scrolls back two lines at a time as far as the oldest held, and on as far as the bottom', () => {
    const buffer = sized(1000);
    buffer.print('a\n', 1000);
    for (let i = 0; i < 15; i++) buffer.pageUp();
    expect(lines(buffer)).toEqual({ current: 32, display: 2 });
    // 32 lines held, so 32 back from the bottom is one past the oldest.
    buffer.pageUp();
    expect(lines(buffer)).toEqual({ current: 32, display: 1 });
    for (let i = 0; i < 4; i++) buffer.pageUp();
    expect(lines(buffer)).toEqual({ current: 32, display: 1 });
    for (let i = 0; i < 30; i++) buffer.pageDown();
    expect(lines(buffer)).toEqual({ current: 32, display: 32 });
  });

  it('puts the view one past the bottom on top just after a resize, until a line feed', () => {
    const buffer = sized(20);
    buffer.top();
    expect(lines(buffer)).toEqual({ current: 1637, display: 1638 });
    buffer.print('a\n', 1000);
    expect(lines(buffer)).toEqual({ current: 1638, display: 1638 });
  });

  it('puts the view on top on the oldest line held, once the ring has wrapped', () => {
    const buffer = sized(1000);
    buffer.print('\n'.repeat(32), 1000);
    expect(buffer.current).toBe(63);
    buffer.top();
    expect(buffer.display).toBe(32);
    buffer.print('\n', 2000);
    buffer.top();
    expect(lines(buffer)).toEqual({ current: 64, display: 33 });
  });

  it.each([1, 2, 3])('runs seed %i as ioquake3 does', (seed) => {
    expect(runConsole(consoleCorpus(seed, 4000))).toEqual(TWIN[seed]);
  });
});

// `Con_Dump_f`'s loops (`cl_console.c:216–257`), read from its C.
describe('ConsoleBuffer.dump', () => {
  it('has nothing of a blank buffer', () => {
    expect(new ConsoleBuffer().dump('\r\n')).toBe('');
  });

  it('starts at the first line with anything on it and ends with the one being written', () => {
    const buffer = sized(20);
    buffer.print('   \n', 1000);
    buffer.print('^1one  \n\n  two\n', 1000);
    expect(buffer.dump('\r\n')).toBe('one\r\n\r\n  two\r\n\r\n');
    expect(buffer.dump('\n')).toBe('one\n\n  two\n\n');
    buffer.print('three', 2000);
    expect(buffer.dump('\n')).toBe('one\n\n  two\nthree\n');
  });

  it('writes a line as wide as the console whole, and a character past 127 as itself', () => {
    const buffer = sized(10);
    // A word longer than a line fills the first.
    buffer.print('abcdefghijklmnopqrstuvwxy\nx\xe9\n', 1000);
    expect(buffer.dump('\r\n')).toBe('abcdefghij\r\nklmnop\r\nqrstuvwxy\r\nx\xe9\r\n\r\n');
  });

  it('has only the lines the ring still holds', () => {
    const buffer = sized(1000);
    for (let n = 1; n <= 40; n++) buffer.print(`${n}\n`, 1000);
    const lines = Array.from({ length: 31 }, (_, i) => `${i + 10}\n`);
    expect(buffer.dump('\n')).toBe(`${lines.join('')}\n`);
  });

  it('has only what was printed since a clear, from where the last print left off on its line', () => {
    const buffer = sized(20);
    buffer.print('gone\nabc', 1000);
    buffer.clear();
    buffer.print('d\n', 2000);
    expect(buffer.dump('\n')).toBe('   d\n\n');
  });
});

// `Con_Clear_f` (`cl_console.c:165–173`) fills the cells and calls `Con_Bottom`, and nothing more.
describe('ConsoleBuffer.clear', () => {
  it('blanks every cell and puts the view at the bottom, the line, the place on it and the times kept', () => {
    const buffer = sized(10);
    buffer.print('one\ntwo\nabc', 1000);
    buffer.pageUp();
    const before = { current: buffer.current, time: buffer.lineTime(buffer.current - 1) };
    buffer.clear();
    expect(lines(buffer)).toEqual({ current: before.current, display: before.current });
    for (let n = 0; n < buffer.totalLines; n++) {
      expect(buffer.line(n).every((cell) => cell === (7 << 8) + 32)).toBe(true);
    }
    expect(buffer.lineTime(buffer.current - 1)).toBe(before.time);
    // The next print goes on from where the last left off on its line.
    buffer.print('d', 2000);
    expect(last(buffer, 1)).toEqual([{ text: '   d', colors: '7777', time: 2000 }]);
  });
});

describe('ConsoleBuffer.x', () => {
  it('is where on the line being written the next character goes', () => {
    const buffer = sized(10);
    expect(buffer.x).toBe(0);
    buffer.print('^1abc', 1000);
    expect(buffer.x).toBe(3);
    // A word that won't fit starts the next line.
    buffer.print(' defghij', 1000);
    expect(buffer.x).toBe(7);
    buffer.print('\n', 1000);
    expect(buffer.x).toBe(0);
    buffer.print('ab\rc', 1000);
    expect(buffer.x).toBe(1);
  });
});

describe('ConsoleBuffer.revision', () => {
  it('moves at a print, a resize, a clear and every scroll', () => {
    const buffer = sized(10);
    const moves = (step: () => void) => {
      const before = buffer.revision;
      step();
      return buffer.revision !== before;
    };
    expect(moves(() => buffer.print('one\ntwo\n', 1000))).toBe(true);
    expect(moves(() => buffer.print('', 1000))).toBe(true);
    expect(moves(() => buffer.pageUp())).toBe(true);
    expect(moves(() => buffer.pageDown())).toBe(true);
    expect(moves(() => buffer.top())).toBe(true);
    expect(moves(() => buffer.bottom())).toBe(true);
    expect(moves(() => buffer.clear())).toBe(true);
    expect(moves(() => buffer.resize(12))).toBe(true);
    expect(moves(() => buffer.resize(0))).toBe(true);
  });

  it('holds still at a resize to the same width, and at clearing the notify lines', () => {
    const buffer = sized(10);
    buffer.print('one\n', 1000);
    const before = buffer.revision;
    buffer.resize(10);
    buffer.clearNotify();
    expect(buffer.revision).toBe(before);
  });
});
