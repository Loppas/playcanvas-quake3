import { describe, expect, it } from 'vitest';

import { ConsoleBuffer } from './console-buffer';
import {
  colorLayers,
  CONSOLE_COLORS,
  CONSOLE_OPEN_FRAC,
  drawnLines,
  inputLayers,
  runConsole,
  scrollMarks,
  textRows
} from './console-rows';

/** A buffer `width` characters wide, with each of `prints` printed. */
function printed(width: number, ...prints: string[]): ConsoleBuffer {
  const buffer = new ConsoleBuffer();
  buffer.resize(width);
  for (const text of prints) buffer.print(text, 1000);
  return buffer;
}

/** What each drawn line says, its trailing spaces left off; null for a row that draws nothing. */
function said(buffer: ConsoleBuffer, lines: readonly number[]): (string | null)[] {
  return lines.map((line) =>
    line < 0 ? null : String.fromCharCode(...buffer.line(line).map((cell) => cell & 255)).trimEnd()
  );
}

describe('runConsole', () => {
  it('drops to half the screen at scr_conspeed screens a second, and stays there', () => {
    let frac = 0;
    frac = runConsole(frac, true, 3, 100);
    expect(frac).toBeCloseTo(0.3, 10);
    frac = runConsole(frac, true, 3, 50);
    expect(frac).toBeCloseTo(0.45, 10);
    // Past half, it stops at half: a sixth of a second at the default 3.
    frac = runConsole(frac, true, 3, 50);
    expect(frac).toBe(CONSOLE_OPEN_FRAC);
    expect(runConsole(frac, true, 3, 16)).toBe(CONSOLE_OPEN_FRAC);
  });

  it('lifts to nothing once it is closed, at the same speed', () => {
    let frac = runConsole(CONSOLE_OPEN_FRAC, false, 3, 100);
    expect(frac).toBeCloseTo(0.2, 10);
    frac = runConsole(frac, false, 3, 100);
    expect(frac).toBe(0);
    expect(runConsole(frac, false, 3, 100)).toBe(0);
  });

  it('runs on the frame’s real time, and stands still at a speed of 0', () => {
    expect(runConsole(0, true, 1.5, 200)).toBeCloseTo(0.3, 10);
    expect(runConsole(0.25, true, 0, 1000)).toBe(0.25);
    // Turned back halfway, it goes back from where it stood.
    expect(runConsole(0.25, false, 3, 50)).toBeCloseTo(0.1, 10);
  });
});

describe('textRows', () => {
  it('gives every row but the bottom one to text, and one fewer scrolled back', () => {
    // Half of 1080: 540 high, 16 to a row.
    expect(textRows(540, 16, false)).toBe(32);
    expect(textRows(540, 16, true)).toBe(31);
    expect(textRows(240, 16, false)).toBe(14);
    expect(textRows(240, 32, false)).toBe(6);
  });
});

describe('drawnLines', () => {
  it('draws from the line before the one being written while that one is empty', () => {
    const buffer = printed(20, 'one\ntwo\n');
    expect(said(buffer, drawnLines(buffer, 3))).toEqual(['two', 'one', '']);
  });

  it('draws the line being written once something is on it', () => {
    const buffer = printed(20, 'one\ntwo\nthr');
    expect(said(buffer, drawnLines(buffer, 3))).toEqual(['thr', 'two', 'one']);
  });

  it('draws nothing past the oldest line the ring holds, nor before the first', () => {
    // 4096 wide, the ring holds 8 lines, the first numbered 7.
    const fresh = printed(4096, 'a\n');
    expect(drawnLines(fresh, 10)).toEqual([7, 6, 5, 4, 3, 2, 1, -1, -1, -1]);

    const full = printed(4096, ...Array.from({ length: 20 }, (_, i) => `l${i}\n`));
    expect(full.totalLines).toBe(8);
    // The seven newest written lines over the empty one being written, and then nothing.
    expect(said(full, drawnLines(full, 9))).toEqual(['l19', 'l18', 'l17', 'l16', 'l15', 'l14', 'l13', null, null]);
  });

  it('draws from the view scrolled back, still a line lower while the last one is empty', () => {
    const buffer = printed(20, 'one\ntwo\nthree\nfour\n');
    buffer.pageUp();
    // The view is two lines up, on `three`; Q3 still steps one back for the empty line.
    expect(said(buffer, drawnLines(buffer, 2))).toEqual(['two', 'one']);
  });
});

describe('colorLayers', () => {
  it('splits the rows by colour, each character in its column, top row first', () => {
    const buffer = printed(20, '^1red^7 white\n');
    const layers = colorLayers(buffer, drawnLines(buffer, 2));
    expect(layers).toHaveLength(CONSOLE_COLORS);
    // The row above it has nothing, and is a space so that each text keeps its rows.
    expect(layers[1]).toBe(' \nred');
    expect(layers[7]).toBe(' \n    white');
    expect(layers.filter((layer) => layer !== '')).toHaveLength(2);
  });

  it('keeps a colour’s characters where they stand across the rows', () => {
    const buffer = printed(20, 'a ^2b^7 c\n', '^2x^7 y ^2z\n');
    const layers = colorLayers(buffer, drawnLines(buffer, 2));
    expect(layers[2]).toBe('  b\nx   z');
    expect(layers[7]).toBe('a   c\n  y');
  });

  it('leaves out trailing spaces, and draws a byte outside printable ASCII as nothing', () => {
    const buffer = printed(20, `a\x7f\x01b${String.fromCharCode(200)}c    \n`);
    expect(colorLayers(buffer, drawnLines(buffer, 1))[7]).toBe('a  b c');
  });

  it('gives a row that draws nothing a space in every colour used', () => {
    const buffer = printed(4096, '^3a\n');
    const layers = colorLayers(buffer, drawnLines(buffer, 9));
    expect(layers[3].split('\n')).toEqual([...Array<string>(8).fill(' '), 'a']);
  });

  it('is empty in every colour for nothing printed', () => {
    const buffer = printed(20);
    expect(colorLayers(buffer, drawnLines(buffer, 4))).toEqual(Array<string>(CONSOLE_COLORS).fill(''));
  });
});

describe('inputLayers', () => {
  it('lays the window out a text per colour, each code drawn and colouring from it', () => {
    const layers = inputLayers('say ^1hi^7 there', { start: 0, length: 16 });
    expect(layers[7]).toBe('say     ^7 there');
    expect(layers[1]).toBe('    ^1hi');
    expect(layers.filter((layer) => layer !== '')).toHaveLength(2);
  });

  it('reads only what the window shows, so a code scrolled off colours nothing', () => {
    const layers = inputLayers('^3abcdef^2gh', { start: 3, length: 7 });
    expect(layers[7]).toBe('bcdef');
    expect(layers[2]).toBe('     ^2');
    expect(layers[3]).toBe('');
  });

  it('leaves out the spaces, as nothing is drawn for one, trailing ones too', () => {
    const layers = inputLayers('a b ^1 c  ', { start: 0, length: 10 });
    expect([layers[7], layers[1]]).toEqual(['a b', '    ^1 c']);
  });

  it('draws nothing where the window starts before the line', () => {
    expect(inputLayers('abcdef', { start: -2, length: 5 })[7]).toBe('  abc');
  });

  it('is empty in every colour for an empty line', () => {
    const none = Array<string>(CONSOLE_COLORS).fill('');
    expect(inputLayers('', { start: 0, length: 0 })).toEqual(none);
  });
});

describe('scrollMarks', () => {
  it('marks every fourth column from the first, as far as the line goes', () => {
    expect(scrollMarks(8)).toBe('^   ^');
    expect(scrollMarks(9)).toBe('^   ^   ^');
    expect(scrollMarks(1)).toBe('^');
    expect(scrollMarks(78).split('^')).toHaveLength(Math.ceil(78 / 4) + 1);
  });
});
