import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleBuffer } from './console-buffer';
import { describeLines } from './console-buffer-test-fixtures';
import { consolePrint } from './console-print';

/** The last `count` lines' text, the one being written last. */
function last(buffer: ConsoleBuffer, count: number): string[] {
  return describeLines(buffer, count).lines.map((line) => line.text);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consolePrint', () => {
  it('puts each print into the buffer, stamped on the real clock', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1234);
    const buffer = new ConsoleBuffer();
    const print = consolePrint(buffer, () => false, () => {});
    print('^1Sarge^7 connected\n');
    expect(describeLines(buffer, 2).lines[0]).toMatchObject({
      text: 'Sarge connected',
      time: 1234
    });
  });

  it("echoes each print to the devtools, without its colours or its last newline", () => {
    const echoed: string[] = [];
    const print = consolePrint(new ConsoleBuffer(), () => false, (line) => echoed.push(line));
    print('^1Sarge^7 connected\n');
    print('two\nlines\n');
    expect(echoed).toEqual(['Sarge connected', 'two\nlines']);
  });

  it('keeps everything out of the buffer under cl_noprint, and echoes it all the same', () => {
    const echoed: string[] = [];
    let noPrint = true;
    const buffer = new ConsoleBuffer();
    const print = consolePrint(buffer, () => noPrint, (line) => echoed.push(line));
    print('hidden\n');
    expect(buffer.current).toBe(buffer.totalLines - 1);
    expect(last(buffer, 2)).toEqual(['', '']);

    noPrint = false;
    print('shown\n');
    expect(last(buffer, 2)).toEqual(['shown', '']);
    expect(echoed).toEqual(['hidden', 'shown']);
  });

  it("echoes to the devtools' log by default", () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    consolePrint(new ConsoleBuffer(), () => false)('hello\n');
    expect(log).toHaveBeenCalledWith('hello');
  });
});
